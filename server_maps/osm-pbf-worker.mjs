import fs from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { renderPbfSvg } from './osm-pbf.mjs'
import { MAP_RENDER_LIMITS, renderLimitsForExtract, extractTimeBudgetMs, mapJobTimeBudgetMs } from './map-render-limits.mjs'
import { BoundedRoadGraph, routeFocusSegments, adaptiveRouteCorridorKm } from './offline-road-router.mjs'

function svgContentLayer(svg = '') {
  return String(svg || '').replace(/^.*?<svg[^>]*>/s, '').replace(/<\/svg>\s*$/s, '').replace(/<rect[^>]*\/>/i, '').replace(/<g opacity="0\.45">[\s\S]*?<\/g>/i, '').replace(/<text x="14" y="582"[\s\S]*?<\/text>/i, '')
}

function xmlEscape(value = '') {
  return String(value || '').replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]))
}

function combineRenderedSvgs(results = [], fileNames = []) {
  if (results.length === 1) return results[0].svg
  const layers = results.map(item => svgContentLayer(item.svg)).filter(Boolean).join('\n')
  const label = `${results.length} local PBF extracts · ${fileNames.filter(Boolean).join(' + ')}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600">
  <rect width="1200" height="600" fill="#1b241c"/>
  <g opacity="0.45"><path d="M0 120H1200M0 240H1200M0 360H1200M0 480H1200M240 0V600M480 0V600M720 0V600M960 0V600" stroke="#344035" stroke-width="0.6"/></g>
  ${layers}
  <text x="14" y="582" fill="#9fac9b" font-family="Segoe UI,Arial,sans-serif" font-size="11">OpenStreetMap / Geofabrik · ${xmlEscape(label)}</text>
</svg>`
}

let peakRssMb = 0
let peakHeapUsedMb = 0
let peakExternalMb = 0

function sampleMemory() {
  const usage = process.memoryUsage()
  peakRssMb = Math.max(peakRssMb, Number(usage.rss || 0) / 1024 / 1024)
  peakHeapUsedMb = Math.max(peakHeapUsedMb, Number(usage.heapUsed || 0) / 1024 / 1024)
  peakExternalMb = Math.max(peakExternalMb, Number(usage.external || 0) / 1024 / 1024)
}

function aggregateStats(results = [], svgBytes = 0, elapsedMs = 0) {
  sampleMemory()
  return {
    indexedNodeCount: results.reduce((sum, item) => sum + Number(item.indexedNodeCount || 0), 0),
    indexedNodeAttempts: results.reduce((sum, item) => sum + Number(item.indexedNodeAttempts || 0), 0),
    roadCandidates: results.reduce((sum, item) => sum + Number(item.roadCandidates || 0), 0),
    roadCount: results.reduce((sum, item) => sum + Number(item.roadCount || 0), 0),
    roadVertexCount: results.reduce((sum, item) => sum + Number(item.roadVertexCount || 0), 0),
    labelCount: results.reduce((sum, item) => sum + Number(item.labelCount || 0), 0),
    routeGraphNodes: Math.max(0, ...results.map(item => Number(item.routeGraphNodes || 0))),
    routeGraphEdges: Math.max(0, ...results.map(item => Number(item.routeGraphEdges || 0))),
    routeGraphCapacityReached: results.some(item => item.routeGraphCapacityReached === true),
    routeGraphStorage: results.find(item => item.routeGraphStorage)?.routeGraphStorage || '',
    routedLegCount: Math.max(0, ...results.map(item => Number(item.routedLegCount || 0))),
    terrestrialLegCount: Math.max(0, ...results.map(item => Number(item.terrestrialLegCount || 0))),
    plannedRoadWays: results.reduce((sum, item) => sum + Number(item.plannedRoadWays || 0), 0),
    requiredNodeRefs: results.reduce((sum, item) => sum + Number(item.requiredNodeRefs || 0), 0),
    focusSeedNodeCount: results.reduce((sum, item) => sum + Number(item.focusSeedNodeCount || 0), 0),
    bytesProcessed: results.reduce((sum, item) => sum + Number(item.bytesProcessed || 0), 0),
    sourceBytes: results.reduce((sum, item) => sum + Number(item.sourceBytes || item.sourceSize || 0), 0),
    passes: results.reduce((sum, item) => sum + Number(item.passes || 0), 0),
    scanComplete: results.every(item => item.scanComplete !== false),
    svgBytes,
    elapsedMs,
    peakRssMb: Number(peakRssMb.toFixed(1)),
    peakHeapUsedMb: Number(peakHeapUsedMb.toFixed(1)),
    peakExternalMb: Number(peakExternalMb.toFixed(1)),
  }
}

async function main() {
  const { sourceFiles = [], renderBounds = null, routeFocus = [], canonicalRoutePoints = [], legModes = [], cacheSvg = '', cacheMeta = '', key = '', modifiedAt = 0 } = workerData || {}
  const canonicalRoute = (Array.isArray(canonicalRoutePoints) && canonicalRoutePoints.length ? canonicalRoutePoints : routeFocus)
  const startedAt = Date.now()
  const results = []
  const limitationReasons = new Set()
  const effectiveTotalLimits = { ...MAP_RENDER_LIMITS, maxJobElapsedMs: mapJobTimeBudgetMs(sourceFiles, MAP_RENDER_LIMITS) }
  const geometryLimits = renderLimitsForExtract(effectiveTotalLimits, sourceFiles.length)
  // One bounded network spans all selected extracts so a land-border leg can
  // connect across adjacent country/state PBFs instead of being forced into a
  // straight line simply because the road graph was split by files.
  const sharedRouteGraph = new BoundedRoadGraph({
    maxNodes: MAP_RENDER_LIMITS.maxRouteGraphNodes,
    maxEdges: MAP_RENDER_LIMITS.maxRouteGraphEdges,
  })

  for (let index = 0; index < sourceFiles.length; index += 1) {
    if (Date.now() - startedAt > effectiveTotalLimits.maxJobElapsedMs) {
      const stats = aggregateStats(results, 0, Date.now() - startedAt)
      parentPort?.postMessage({ type: 'limited', message: 'Detailed offline rendering exceeded WAYFINDER’s safe time budget. A coarse fallback map should be shown instead.', reason: `job time safety limit (${Math.round(effectiveTotalLimits.maxJobElapsedMs / 1000)}s)`, stats })
      return
    }
    const item = sourceFiles[index]
    const elapsedBeforeExtract = Date.now() - startedAt
    const remainingFileSizes = sourceFiles.slice(index).map(entry => Number(entry.size || 0))
    const maxPerExtractElapsedMs = extractTimeBudgetMs({
      total: effectiveTotalLimits,
      fileSize: Number(item.size || 0),
      remainingFileSizes,
      elapsedMs: elapsedBeforeExtract,
    })
    const perExtractLimits = { ...geometryLimits, maxPerExtractElapsedMs }
    const result = await renderPbfSvg({
      filePath: item.filePath,
      bounds: renderBounds,
      focusPoints: routeFocus,
      routePoints: canonicalRoute,
      legModes,
      limits: perExtractLimits,
      routeGraph: sharedRouteGraph,
      onProgress: progress => {
        sampleMemory()
        const local = Math.max(0, Math.min(100, Number(progress.percent || 0)))
        const overall = Math.min(99, Math.round(((index + local / 100) / Math.max(1, sourceFiles.length)) * 100))
        parentPort?.postMessage({ type: 'progress', progress: { ...progress, percent: overall, extractIndex: index + 1, extractCount: sourceFiles.length, extractFile: item.fileName, extractTimeBudgetMs: maxPerExtractElapsedMs, message: sourceFiles.length > 1 ? `Extract ${index + 1}/${sourceFiles.length} (${item.fileName}): ${progress.message || 'rendering…'}` : progress.message } })
      },
    })
    if (result?.safeToDisplay === false) {
      const reason = (result.limitationReasons || []).join('; ') || 'resource safety limit'
      const stats = aggregateStats([...results, result], Number(result.svgBytes || 0), Date.now() - startedAt)
      parentPort?.postMessage({ type: 'limited', message: 'Detailed offline rendering hit WAYFINDER’s safe resource limits. A coarse fallback map should be shown instead.', reason, stats })
      return
    }
    for (const reason of result?.limitationReasons || []) limitationReasons.add(reason)
    results.push(result)
  }

  const svg = combineRenderedSvgs(results, sourceFiles.map(item => item.fileName))
  const svgBytes = Buffer.byteLength(svg, 'utf8')
  const elapsedMs = Date.now() - startedAt
  if (svgBytes > MAP_RENDER_LIMITS.maxSvgBytes) {
    const stats = aggregateStats(results, svgBytes, elapsedMs)
    parentPort?.postMessage({ type: 'limited', message: 'The combined offline map exceeded WAYFINDER’s safe browser display size. A coarse fallback map should be shown instead.', reason: `combined SVG safety limit (${(MAP_RENDER_LIMITS.maxSvgBytes / 1024 / 1024).toFixed(1)} MB)`, stats })
    return
  }

  const resultBounds = results[0]?.bounds || renderBounds
  const roadCount = results.reduce((sum, item) => sum + Number(item.roadCount || 0), 0)
  const labelCount = results.reduce((sum, item) => sum + Number(item.labelCount || 0), 0)
  const resourceStats = aggregateStats(results, svgBytes, elapsedMs)
  // Route AFTER all selected extracts have contributed to the shared graph.
  // Per-extract routing cannot prove a border leg: each individual file may
  // contain only one endpoint even though their union contains the road path.
  // RC61: route-corridor focus geometry and canonical itinerary geometry are
  // different authorities. The focus polyline may contain dozens of MapQuest
  // shape samples; only the canonical occurrence points define traveler legs.
  let routeSegments = routeFocusSegments(sharedRouteGraph, canonicalRoute, {
    maxTerrestrialKm: 6000,
    maxSnapKm: MAP_RENDER_LIMITS.maxRouteSnapKm,
    maxVisited: MAP_RENDER_LIMITS.maxRouteSearchVisited,
    maxGeometryPoints: MAP_RENDER_LIMITS.maxRouteGeometryPoints,
    legModes,
  })
  let routedLegCount = routeSegments.filter(item => item.status === 'routed').length
  let terrestrialLegCount = routeSegments.filter(item => !['non-terrestrial', 'mode-unconfirmed'].includes(item.status)).length

  // Recovery pass: the background-map corridor is intentionally tight for
  // memory safety, but real roads can bow far from a straight canonical leg.
  // If the first bounded graph cannot route every terrestrial leg, rescan the
  // already-selected extracts once in route-only mode with a wider corridor.
  // This is a generalized fallback, not a route/country exception, and remains
  // under the same aggregate worker time/memory ceilings.
  if (terrestrialLegCount > 0 && routedLegCount < terrestrialLegCount && Date.now() - startedAt < effectiveTotalLimits.maxJobElapsedMs - 12000) {
    const recoveryCorridorKm = adaptiveRouteCorridorKm(canonicalRoute, { legModes })
    const recoveryGraph = new BoundedRoadGraph({
      maxNodes: Math.max(MAP_RENDER_LIMITS.maxRouteGraphNodes, 420000),
      maxEdges: Math.max(MAP_RENDER_LIMITS.maxRouteGraphEdges, 1200000),
    })
    let recoveryAttempted = false
    for (let index = 0; index < sourceFiles.length; index += 1) {
      const remainingMs = effectiveTotalLimits.maxJobElapsedMs - (Date.now() - startedAt)
      if (remainingMs < 8000) break
      const item = sourceFiles[index]
      recoveryAttempted = true
      const perExtractLimits = {
        ...geometryLimits,
        maxPlannedRoadWays: Math.max(Number(geometryLimits.maxPlannedRoadWays || 0), 180000),
        maxPerExtractElapsedMs: Math.max(6000, Math.min(45000, remainingMs - 2500)),
      }
      try {
        await renderPbfSvg({
          filePath: item.filePath,
          bounds: renderBounds,
          focusPoints: routeFocus,
          routePoints: canonicalRoute,
          legModes,
          limits: perExtractLimits,
          routeGraph: recoveryGraph,
          routeOnly: true,
          routeCorridorKm: recoveryCorridorKm,
          onProgress: progress => parentPort?.postMessage({
            type: 'progress',
            progress: {
              ...progress,
              phase: 'route-recovery',
              percent: Math.min(99, 96 + Math.round(((index + Math.max(0, Math.min(100, Number(progress.percent || 0))) / 100) / Math.max(1, sourceFiles.length)) * 3)),
              message: `Offline mode-specific route not yet complete · widening the bounded route corridor to ≈${recoveryCorridorKm} km (${index + 1}/${sourceFiles.length})…`,
            },
          }),
        })
      } catch (error) {
        limitationReasons.add(`wide-corridor route recovery skipped for ${item.fileName || 'extract'}: ${String(error?.message || error).slice(0, 120)}`)
      }
    }
    if (recoveryAttempted) {
      const recovered = routeFocusSegments(recoveryGraph, canonicalRoute, {
        maxTerrestrialKm: 6000,
        maxSnapKm: MAP_RENDER_LIMITS.maxRouteSnapKm,
        maxVisited: Math.max(MAP_RENDER_LIMITS.maxRouteSearchVisited, 320000),
        maxGeometryPoints: MAP_RENDER_LIMITS.maxRouteGeometryPoints,
        legModes,
      })
      const recoveredCount = recovered.filter(item => item.status === 'routed').length
      if (recoveredCount > routedLegCount) {
        routeSegments = recovered
        routedLegCount = recoveredCount
        terrestrialLegCount = recovered.filter(item => !['non-terrestrial', 'mode-unconfirmed'].includes(item.status)).length
        limitationReasons.add(`offline mode-specific routing used a wider bounded recovery corridor (≈${recoveryCorridorKm} km)`)
        const recoveredStats = recoveryGraph.stats()
        resourceStats.routeGraphNodes = Math.max(resourceStats.routeGraphNodes || 0, recoveredStats.routeGraphNodes || 0)
        resourceStats.routeGraphEdges = Math.max(resourceStats.routeGraphEdges || 0, recoveredStats.routeGraphEdges || 0)
        resourceStats.routeGraphCapacityReached = Boolean(resourceStats.routeGraphCapacityReached || recoveredStats.routeGraphCapacityReached)
        resourceStats.routeGraphStorage = recoveredStats.routeGraphStorage || resourceStats.routeGraphStorage || ''
      }
    }
  }

  resourceStats.routedLegCount = routedLegCount
  resourceStats.terrestrialLegCount = terrestrialLegCount
  const degraded = results.some(item => item.degraded) || limitationReasons.size > 0 || (terrestrialLegCount > 0 && routedLegCount < terrestrialLegCount)
  const tmpSvg = `${cacheSvg}.tmp-${process.pid}`
  const tmpMeta = `${cacheMeta}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmpSvg, svg, 'utf8')
    fs.writeFileSync(tmpMeta, JSON.stringify({
      key,
      bounds: resultBounds,
      roadCount,
      labelCount,
      sourceFiles: sourceFiles.map(item => item.filePath),
      modifiedAt,
      degraded,
      limitationReasons: [...limitationReasons],
      routeSegments,
      routedLegCount,
      terrestrialLegCount,
      resourceStats,
    }, null, 2), 'utf8')
    fs.renameSync(tmpSvg, cacheSvg)
    fs.renameSync(tmpMeta, cacheMeta)
  } finally {
    try { if (fs.existsSync(tmpSvg)) fs.unlinkSync(tmpSvg) } catch {}
    try { if (fs.existsSync(tmpMeta)) fs.unlinkSync(tmpMeta) } catch {}
  }
  parentPort?.postMessage({ type: 'done', bounds: resultBounds, roadCount, labelCount, degraded, limitationReasons: [...limitationReasons], routeSegments, routedLegCount, terrestrialLegCount, resourceStats, svgBytes, elapsedMs })
}

main().catch(error => {
  parentPort?.postMessage({ type: 'error', message: String(error?.message || error), stack: String(error?.stack || '') })
})
