import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function normalizeAreaName(value = '') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function normalizeMapPath(value = '') {
  let text = String(value || '').trim()
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim()
  if (!text) return ''
  if (text === '~') text = os.homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(os.homedir(), text.slice(2))
  if (process.platform === 'win32') {
    text = text.replace(/%([^%]+)%/g, (_m, name) => process.env[name] || process.env[String(name).toUpperCase()] || _m)
  }
  return path.resolve(text)
}

export function parsePbfFilename(fileName = '', modifiedAt = 0) {
  const name = path.basename(String(fileName || ''))
  if (!/\.pbf$/i.test(name)) return null
  const canonical = name.match(/^(.*?)(?:-(latest|\d{6}|\d{8}))?\.osm\.pbf$/i)
  const fallback = !canonical ? name.match(/^(.*?)\.pbf$/i) : null
  const rawArea = String(canonical?.[1] || fallback?.[1] || '').trim()
  const version = String(canonical?.[2] || '').toLowerCase()
  let extractDate = ''
  if (/^\d{6}$/.test(version)) {
    const yy = Number(version.slice(0, 2))
    const year = yy >= 80 ? 1900 + yy : 2000 + yy
    extractDate = `${year}-${version.slice(2, 4)}-${version.slice(4, 6)}`
  } else if (/^\d{8}$/.test(version)) {
    extractDate = `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}`
  }
  const parsedTime = extractDate ? Date.parse(`${extractDate}T00:00:00Z`) : 0
  return {
    fileName: name,
    areaSlug: rawArea.toLowerCase(),
    areaKey: normalizeAreaName(rawArea.replace(/-/g, ' ')),
    version: version || (canonical ? 'unversioned' : 'custom'),
    extractDate,
    versionTime: Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : Number(modifiedAt || 0),
    canonicalName: Boolean(canonical),
  }
}

function statSafe(filePath) {
  try { return fs.statSync(filePath) } catch { return null }
}

function addPbfFile(output, seen, full, base, diagnostics, source = 'folder') {
  const resolved = path.resolve(full)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  if (seen.has(key)) return
  const stat = statSafe(resolved)
  if (!stat?.isFile()) return
  diagnostics.filesSeen += 1
  if (!/\.pbf$/i.test(path.basename(resolved))) return
  diagnostics.pbfLikeSeen += 1
  const parsed = parsePbfFilename(path.basename(resolved), stat.mtimeMs)
  if (!parsed) return
  seen.add(key)
  const relativeDir = base && statSafe(base)?.isDirectory() ? path.relative(base, path.dirname(resolved)) : ''
  output.push({
    ...parsed,
    filePath: resolved,
    relativePath: base && statSafe(base)?.isDirectory() ? path.relative(base, resolved) : path.basename(resolved),
    relativeDir,
    pathKey: normalizeAreaName(relativeDir),
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    source,
  })
}

export function scanPbfCatalog(root, { maxDepth = 8, maxFiles = 5000, extraFiles = [], fallbackRoots = [], aggregateFallbacks = false } = {}) {
  const inputRoot = String(root || '').trim()
  const normalizedRoot = normalizeMapPath(inputRoot)
  const diagnostics = {
    rootInput: inputRoot,
    root: normalizedRoot,
    rootExists: false,
    rootType: 'missing',
    scannedDirectories: 0,
    entriesSeen: 0,
    filesSeen: 0,
    pbfLikeSeen: 0,
    errors: [],
    fallbackRootsUsed: [],
  }
  const output = []
  const seenFiles = new Set()
  const seenDirs = new Set()

  const scanSource = (sourcePath, source = 'folder') => {
    const base = normalizeMapPath(sourcePath)
    if (!base) return
    const stat = statSafe(base)
    if (!stat) return
    if (stat.isFile()) {
      addPbfFile(output, seenFiles, base, path.dirname(base), diagnostics, source === 'folder' ? 'selected-file' : source)
      return
    }
    if (!stat.isDirectory()) return
    const queue = [{ dir: base, depth: 0 }]
    while (queue.length && output.length < maxFiles) {
      const { dir, depth } = queue.shift()
      const dirKey = process.platform === 'win32' ? dir.toLowerCase() : dir
      if (seenDirs.has(dirKey)) continue
      seenDirs.add(dirKey)
      diagnostics.scannedDirectories += 1
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
      catch (error) {
        diagnostics.errors.push(`${dir}: ${String(error?.code || error?.message || error)}`)
        continue
      }
      diagnostics.entriesSeen += entries.length
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 })
          continue
        }
        if (entry.isFile()) addPbfFile(output, seenFiles, full, base, diagnostics, source)
        else if (entry.isSymbolicLink()) {
          const linked = statSafe(full)
          if (linked?.isDirectory() && depth < maxDepth) queue.push({ dir: full, depth: depth + 1 })
          else if (linked?.isFile()) addPbfFile(output, seenFiles, full, base, diagnostics, source)
        }
        if (output.length >= maxFiles) break
      }
    }
  }

  if (normalizedRoot) {
    const stat = statSafe(normalizedRoot)
    diagnostics.rootExists = Boolean(stat)
    diagnostics.rootType = stat?.isDirectory() ? 'directory' : stat?.isFile() ? 'file' : stat ? 'other' : 'missing'
    scanSource(normalizedRoot, 'folder')
  }

  for (const file of Array.isArray(extraFiles) ? extraFiles : []) scanSource(file, 'explicit-file')

  // Forgiving fallback: normally inspect adjacent roots only when the configured
  // folder yielded nothing. mapStatus can request aggregateFallbacks when the
  // installed set is only partial for a multi-country route. Seen-directory/file
  // guards prevent duplicates when a parent folder contains the configured root.
  if (aggregateFallbacks || !output.length) {
    for (const fallback of fallbackRoots || []) {
      const normalized = normalizeMapPath(fallback)
      if (!normalized || normalized === normalizedRoot || !statSafe(normalized)?.isDirectory()) continue
      diagnostics.fallbackRootsUsed.push(normalized)
      scanSource(normalized, 'fallback-folder')
      if (!aggregateFallbacks && output.length) break
      if (output.length >= maxFiles) break
    }
  }

  return { entries: output, diagnostics }
}

export function scanPbfFiles(root, options = {}) {
  return scanPbfCatalog(root, options).entries
}

function regionNameScore(entry, region = '') {
  const target = normalizeAreaName(region)
  if (!target) return 0
  const area = entry.areaKey || ''
  const pathKey = entry.pathKey || ''
  if (area === target) return 1000
  const relativeParts = String(entry.relativeDir || '').split(/[\\/]/).map(normalizeAreaName)
  if (relativeParts.some(part => part === target)) return 940
  if (pathKey === target) return 930
  if (area && (target.includes(area) || area.includes(target))) return 760
  const targetTokens = target.split(' ').filter(token => token.length > 2)
  const hay = `${area} ${pathKey}`
  if (targetTokens.length && targetTokens.every(token => hay.includes(token))) return 700
  return 0
}

export function boundsContainPoints(bounds, points = [], padRatio = 0.002) {
  if (!bounds || !Array.isArray(points) || !points.length) return false
  const west = Number(bounds.west); const east = Number(bounds.east)
  const south = Number(bounds.south); const north = Number(bounds.north)
  if (![west, east, south, north].every(Number.isFinite)) return false
  const spanLon = Math.max(0.01, east - west)
  const spanLat = Math.max(0.01, north - south)
  const dx = spanLon * Math.max(0, Number(padRatio) || 0)
  const dy = spanLat * Math.max(0, Number(padRatio) || 0)
  return points.every(point => {
    const lat = Number(point?.lat); const lon = Number(point?.lon)
    return Number.isFinite(lat) && Number.isFinite(lon) && lon >= west - dx && lon <= east + dx && lat >= south - dy && lat <= north + dy
  })
}

function boundsArea(bounds) {
  if (!bounds) return Number.POSITIVE_INFINITY
  const width = Math.max(0.0001, Number(bounds.east) - Number(bounds.west))
  const height = Math.max(0.0001, Number(bounds.north) - Number(bounds.south))
  return width * height
}

function newerFirst(a, b) {
  const time = Number(b.versionTime || b.modifiedAt || 0) - Number(a.versionTime || a.modifiedAt || 0)
  if (time) return time
  return Number(a.size || 0) - Number(b.size || 0)
}

export async function selectMapCandidate(entries = [], { region = '', points = [], readBounds } = {}) {
  const catalog = Array.isArray(entries) ? entries : []
  if (!catalog.length) return { selected: null, catalog: [] }
  const withScore = catalog.map(entry => ({ ...entry, nameScore: regionNameScore(entry, region) }))
  const nameMatches = withScore.filter(entry => entry.nameScore >= 700).sort((a, b) => b.nameScore - a.nameScore || newerFirst(a, b))

  const headerReader = typeof readBounds === 'function' ? readBounds : null

  if (!points?.length) {
    // When the runtime supplies a PBF header reader, "Verify map downloaded"
    // means more than matching a filename: confirm that the file is a readable
    // OSM PBF with geographic bounds. If one matching file is corrupt/incomplete,
    // continue to the next candidate instead of letting it mask a valid extract.
    if (headerReader) {
      for (const candidate of nameMatches) {
        try {
          const bounds = await headerReader(candidate.filePath, candidate)
          if (bounds) return { selected: { ...candidate, bounds, matchReason: candidate.nameScore >= 900 ? 'region-name' : 'region-fuzzy' }, catalog: withScore }
        } catch {}
      }
      return { selected: null, catalog: withScore }
    }
    const selected = nameMatches[0] || null
    return { selected: selected ? { ...selected, matchReason: selected.nameScore >= 900 ? 'region-name' : 'region-fuzzy' } : null, catalog: withScore }
  }

  const boundsReader = headerReader || (async () => null)
  const evaluate = async candidates => {
    const bounded = []
    for (const entry of candidates) {
      let bounds = null
      try { bounds = await boundsReader(entry.filePath, entry) } catch {}
      if (!bounds || !boundsContainPoints(bounds, points)) continue
      bounded.push({ ...entry, bounds, boundsArea: boundsArea(bounds) })
    }
    return bounded
  }

  let bounded = await evaluate(nameMatches)
  if (!bounded.length) {
    const namedPaths = new Set(nameMatches.map(entry => entry.filePath))
    bounded = await evaluate(withScore.filter(entry => !namedPaths.has(entry.filePath)))
  }
  if (!bounded.length) return { selected: null, catalog: withScore }

  bounded.sort((a, b) => {
    const aNamed = a.nameScore >= 700 ? 1 : 0
    const bNamed = b.nameScore >= 700 ? 1 : 0
    if (aNamed !== bNamed) return bNamed - aNamed
    if (aNamed && a.nameScore !== b.nameScore) return b.nameScore - a.nameScore
    const areaDiff = a.boundsArea - b.boundsArea
    if (Math.abs(areaDiff) > 1e-9) return areaDiff
    return newerFirst(a, b)
  })
  const selected = bounded[0]
  return { selected: { ...selected, matchReason: selected.nameScore >= 700 ? 'region-and-bounds' : 'route-bounds' }, catalog: withScore }
}

function pointInsideBounds(bounds, point, padRatio = 0.002) {
  if (!bounds || !point) return false
  const west = Number(bounds.west); const east = Number(bounds.east)
  const south = Number(bounds.south); const north = Number(bounds.north)
  const lat = Number(point?.lat); const lon = Number(point?.lon)
  if (![west, east, south, north, lat, lon].every(Number.isFinite)) return false
  const spanLon = Math.max(0.01, east - west)
  const spanLat = Math.max(0.01, north - south)
  const dx = spanLon * Math.max(0, Number(padRatio) || 0)
  const dy = spanLat * Math.max(0, Number(padRatio) || 0)
  return lon >= west - dx && lon <= east + dx && lat >= south - dy && lat <= north + dy
}


function normalizeLongitude(lon) {
  const value = Number(lon)
  if (!Number.isFinite(value)) return value
  return ((value + 180) % 360 + 360) % 360 - 180
}

function shortestLongitudeDelta(fromLon, toLon) {
  return normalizeLongitude(Number(toLon) - Number(fromLon))
}

function routeLegDistanceKm(a = {}, b = {}) {
  const lat1 = Number(a?.lat); const lat2 = Number(b?.lat)
  const lon1 = Number(a?.lon); const lon2 = Number(b?.lon)
  if (![lat1, lat2, lon1, lon2].every(Number.isFinite)) return 0
  const radians = value => value * Math.PI / 180
  const dLat = radians(lat2 - lat1)
  const dLon = radians(shortestLongitudeDelta(lon1, lon2))
  const p1 = radians(lat1); const p2 = radians(lat2)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
}

export function nonContinuousRouteLegIndexes(points = [], maxContinuousLegKm = 1400) {
  const clean = Array.isArray(points) ? points : []
  const threshold = Math.max(250, Number(maxContinuousLegKm) || 1400)
  const result = []
  for (let index = 0; index < clean.length - 1; index += 1) {
    if (routeLegDistanceKm(clean[index], clean[index + 1]) > threshold) result.push(index)
  }
  return result
}

export function routeCorridorSamples(points = [], { stepDegrees = 0.18, maxSamples = 192, corridorWidthDegrees = null, maxContinuousLegKm = 1400 } = {}) {
  const clean = (Array.isArray(points) ? points : []).map((point, index) => ({
    point: { ...point, lat: Number(point?.lat), lon: Number(point?.lon) },
    routePointIndex: index,
  })).filter(item => Number.isFinite(item.point.lat) && Number.isFinite(item.point.lon))
  if (!clean.length) return []
  const samples = []
  const seen = new Set()
  const push = sample => {
    const key = `${Number(sample.point.lat).toFixed(6)}:${Number(sample.point.lon).toFixed(6)}:${sample.kind}:${sample.legIndex}:${sample.side || 0}`
    if (seen.has(key)) return
    seen.add(key)
    samples.push(sample)
  }
  for (let index = 0; index < clean.length; index += 1) {
    const current = clean[index]
    push({ ...current, kind: 'stop', legIndex: Math.max(0, index - 1), order: index * 100000 })
    const next = clean[index + 1]
    if (!next) continue
    const legKm = routeLegDistanceKm(current.point, next.point)
    // Long intercity/intercontinental legs are normally flights or other
    // positioning moves. Requiring continuous terrestrial PBF coverage would
    // make an offline NYC→London trip demand irrelevant countries/ocean
    // rectangles. Keep detailed background geography endpoint-local for those
    // legs; the canonical route overlay still visualizes the complete leg.
    if (legKm > Math.max(250, Number(maxContinuousLegKm) || 1400)) continue
    const dLon = shortestLongitudeDelta(current.point.lon, next.point.lon)
    const dLat = next.point.lat - current.point.lat
    const distance = Math.max(Math.abs(dLon), Math.abs(dLat))
    const steps = Math.max(1, Math.ceil(distance / Math.max(0.04, Number(stepDegrees) || 0.18)))
    const vectorLength = Math.hypot(dLon, dLat) || 1
    // A header is only an extract bounding rectangle and we do not have an
    // online router while offline. Sample a narrow envelope around the direct
    // leg so plausible road corridors are not lost merely because the real
    // motorway/rail alignment bows away from the straight line. The width is
    // bounded so this cannot turn a city-to-city leg into a country-wide scan.
    // A straight line is only a discovery seed. Real road/rail corridors can bow
    // substantially around mountains, borders, coastlines and restricted crossings.
    // Keep a bounded but materially wider envelope so installed/downloadable
    // transit extracts are not missed merely because the route is not straight.
    const autoWidth = Math.min(0.85, Math.max(0.075, distance * 0.12))
    const explicitWidth = corridorWidthDegrees !== null && corridorWidthDegrees !== undefined && corridorWidthDegrees !== ''
    const width = explicitWidth && Number.isFinite(Number(corridorWidthDegrees)) ? Math.max(0, Math.min(0.9, Number(corridorWidthDegrees))) : autoWidth
    const perpLon = (-dLat / vectorLength) * width
    const perpLat = (dLon / vectorLength) * width
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps
      const center = {
        lat: current.point.lat + dLat * t,
        lon: normalizeLongitude(current.point.lon + dLon * t),
      }
      const order = index * 100000 + Math.round(t * 90000)
      push({ point: center, routePointIndex: -1, kind: 'corridor', legIndex: index, fraction: t, side: 0, order })
      // Avoid expanding the envelope immediately around endpoints; canonical
      // occurrence identity is authoritative there and this prevents a nearby
      // neighboring extract from being selected just because a border/city is
      // close to the start or finish.
      if (t >= 0.16 && t <= 0.92 && width > 0) {
        push({ point: { lat: center.lat + perpLat, lon: normalizeLongitude(center.lon + perpLon) }, routePointIndex: -1, kind: 'corridor-envelope', legIndex: index, fraction: t, side: 1, order: order + 0.1 })
        push({ point: { lat: center.lat - perpLat, lon: normalizeLongitude(center.lon - perpLon) }, routePointIndex: -1, kind: 'corridor-envelope', legIndex: index, fraction: t, side: -1, order: order + 0.2 })
      }
    }
  }
  const limit = Math.max(clean.length, Math.max(16, Number(maxSamples) || 192))
  if (samples.length <= limit) return samples.sort((a, b) => (a.order || 0) - (b.order || 0))
  const stopSamples = samples.filter(item => item.kind === 'stop')
  const corridor = samples.filter(item => item.kind !== 'stop')
  const keepCorridor = Math.max(0, limit - stopSamples.length)
  const sampledCorridor = []
  for (let index = 0; index < keepCorridor; index += 1) {
    const sourceIndex = Math.round((index / Math.max(1, keepCorridor - 1)) * Math.max(0, corridor.length - 1))
    if (corridor[sourceIndex]) sampledCorridor.push(corridor[sourceIndex])
  }
  return [...stopSamples, ...sampledCorridor].sort((a, b) => (a.order || 0) - (b.order || 0))
}

function boundsLocalityScore(bounds, point) {
  if (!bounds || !point) return 0
  const west = Number(bounds.west); const east = Number(bounds.east)
  const south = Number(bounds.south); const north = Number(bounds.north)
  const lon = Number(point.lon); const lat = Number(point.lat)
  if (![west, east, south, north, lon, lat].every(Number.isFinite) || lon < west || lon > east || lat < south || lat > north) return 0
  const width = Math.max(0.0001, east - west)
  const height = Math.max(0.0001, north - south)
  const depthX = Math.min(lon - west, east - lon) / width
  const depthY = Math.min(lat - south, north - lat) / height
  const depth = Math.max(0, Math.min(depthX, depthY))
  return (0.02 + depth) / Math.sqrt(Math.max(0.01, boundsArea(bounds)))
}

function locallySpecificContainers(containers = [], point) {
  if (!containers.length) return []
  const areas = containers.map(entry => Math.max(0.0001, Number(entry.boundsArea || boundsArea(entry.bounds) || 0.0001)))
  const minArea = Math.min(...areas)
  // Bounding rectangles for parent extracts often overlap a child extract. A
  // broad parent must not win merely because the route sample is deeper inside
  // its rectangle. Compare locality only among reasonably similar-sized
  // candidates, keeping the tightest child family authoritative.
  const local = containers.filter(entry => Math.max(0.0001, Number(entry.boundsArea || boundsArea(entry.bounds) || 0.0001)) <= minArea * 3.25 + 1e-9)
  const scored = local.map(entry => ({ entry, score: boundsLocalityScore(entry.bounds, point) }))
  const best = Math.max(...scored.map(item => item.score))
  return scored.filter(item => item.score >= best * 0.68 - 1e-12).map(item => item.entry)
}

function coverageCost(entry = {}) {
  const bytes = Math.max(0, Number(entry.size || 0))
  const sizeMb = bytes / 1024 / 1024
  const geographicArea = Math.max(0.01, Number(entry.boundsArea || 0.01))
  // File bytes are the dominant runtime cost, but geographic area prevents a
  // continent-wide fallback from winning merely because catalog fixtures lack
  // realistic byte sizes (and remains a useful tiebreaker for real extracts).
  return Math.max(1, sizeMb) + geographicArea * 2
}

function coversAllSampleIndexes(selected = [], totalSamples = 0) {
  if (!totalSamples) return true
  const covered = new Set()
  for (const entry of selected) for (const index of entry.effectiveSampleCoverage || entry.sampleCoverage || []) covered.add(index)
  return covered.size >= totalSamples
}

export async function selectMapCoverage(entries = [], { region = '', points = [], readBounds, areaHints = [], pointAreaHints = [] } = {}) {
  const catalog = Array.isArray(entries) ? entries : []
  const rawPoints = Array.isArray(points) ? points : []
  const indexedRoutePoints = rawPoints
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon)))
  const routePoints = indexedRoutePoints.map(item => item.point)
  const invalidPointIndexes = rawPoints.map((_point, index) => index).filter(index => !indexedRoutePoints.some(item => item.index === index))
  const alignedAreaHints = rawPoints.map((_point, index) => String(pointAreaHints?.[index] || '').trim())
  if (!catalog.length) return { selected: [], complete: false, uncoveredPointIndexes: rawPoints.map((_point, index) => index), uncoveredCorridorSampleIndexes: [], corridorSampleCount: 0, catalog: [] }
  if (!routePoints.length) {
    const hints = [...new Set((Array.isArray(areaHints) ? areaHints : []).map(value => String(value || '').trim()).filter(Boolean))]
    if (hints.length > 1) {
      const chosen = []
      const missingHints = []
      for (const hint of hints) {
        const match = await selectMapCandidate(catalog, { region: hint, points: [], readBounds })
        if (!match.selected) {
          missingHints.push(hint)
          continue
        }
        if (!chosen.some(item => item.filePath === match.selected.filePath)) chosen.push(match.selected)
      }
      return { selected: chosen.map(item => ({ ...item, matchReason: 'multi-extract-area-hints' })), complete: missingHints.length === 0, missingHints, uncoveredCorridorSampleIndexes: [], corridorSampleCount: 0, catalog }
    }
    const single = await selectMapCandidate(catalog, { region: hints[0] || region, points: [], readBounds })
    return { selected: single.selected ? [single.selected] : [], complete: Boolean(single.selected), uncoveredCorridorSampleIndexes: [], corridorSampleCount: 0, catalog: single.catalog || catalog }
  }

  const headerReader = typeof readBounds === 'function' ? readBounds : null
  if (!headerReader) {
    const single = await selectMapCandidate(catalog, { region, points: routePoints, readBounds })
    return { selected: single.selected ? [single.selected] : [], complete: Boolean(single.selected), uncoveredCorridorSampleIndexes: [], corridorSampleCount: routePoints.length, catalog: single.catalog || catalog }
  }

  // RC53: coverage means the travel corridor between canonical occurrences, not
  // just dots at overnight/destination stops. This catches intervening extracts
  // such as Connecticut/Rhode Island on New York → Boston and preserves genuine
  // multi-country routes such as Tartu → Riga.
  const longDistanceLegIndexes = nonContinuousRouteLegIndexes(routePoints)
  const samples = routeCorridorSamples(routePoints)
  const evaluated = []
  for (const entry of catalog) {
    let bounds = null
    try { bounds = await headerReader(entry.filePath, entry) } catch {}
    if (!bounds) continue
    const stopCoverage = indexedRoutePoints.filter(({ point }) => pointInsideBounds(bounds, point)).map(({ index }) => index)
    const sampleCoverage = samples.map((sample, index) => pointInsideBounds(bounds, sample.point) ? index : -1).filter(index => index >= 0)
    if (!sampleCoverage.length) continue
    evaluated.push({ ...entry, bounds, boundsArea: boundsArea(bounds), nameScore: regionNameScore(entry, region), coverage: stopCoverage, sampleCoverage })
  }
  if (!evaluated.length) return { selected: [], complete: false, uncoveredPointIndexes: rawPoints.map((_point, index) => index), uncoveredCorridorSampleIndexes: samples.map((_item, index) => index), corridorSampleCount: samples.length, catalog }

  // PBF headers expose rectangular bounding boxes, not the extract polygon. A
  // New York header rectangle can geometrically overlap Connecticut even though
  // the file contains no Connecticut roads. For each route sample, prefer the
  // tightest installed child extract(s); a continent/country/neighbor bounding
  // rectangle cannot mask a more specific file that actually represents that
  // part of the corridor. Canonical stop area hints remain authoritative when
  // they are available.
  const distinctPointHints = [...new Set(alignedAreaHints.filter(Boolean).map(value => normalizeAreaName(value)))]
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex]
    const containers = evaluated.filter(entry => entry.sampleCoverage.includes(sampleIndex))
    if (!containers.length) continue
    let preferred = containers
    if (sample.kind === 'stop') {
      const hint = alignedAreaHints[sample.routePointIndex]
      const named = hint && distinctPointHints.length > 1 ? containers.filter(entry => regionNameScore(entry, hint) >= 700) : []
      if (named.length) preferred = named
      else preferred = locallySpecificContainers(containers, sample.point)
    } else {
      preferred = locallySpecificContainers(containers, sample.point)
    }
    for (const entry of preferred) {
      if (!entry.effectiveSampleCoverage) entry.effectiveSampleCoverage = []
      entry.effectiveSampleCoverage.push(sampleIndex)
    }
  }
  for (const entry of evaluated) if (!entry.effectiveSampleCoverage) entry.effectiveSampleCoverage = []

  const uncoveredPointIndexes = [...invalidPointIndexes]
  for (const { index: pointIndex } of indexedRoutePoints) {
    if (!evaluated.some(entry => entry.coverage.includes(pointIndex))) uncoveredPointIndexes.push(pointIndex)
  }

  // Greedy weighted set-cover. Prefer a file that covers more still-uncovered
  // route samples per MB, with a modest bonus when its name agrees with one of
  // the canonical occurrence hints. This generally picks the smallest useful
  // Geofabrik child extracts instead of a continent/country mega-file.
  const uncovered = new Set(samples.map((_sample, index) => index))
  const chosen = []
  while (uncovered.size) {
    let best = null
    let bestScore = -Infinity
    for (const entry of evaluated) {
      if (chosen.some(item => item.filePath === entry.filePath)) continue
      const newlyCovered = entry.effectiveSampleCoverage.filter(index => uncovered.has(index))
      if (!newlyCovered.length) continue
      let hintBonus = 1
      for (const pointIndex of entry.coverage) {
        const hint = alignedAreaHints[pointIndex]
        if (hint && regionNameScore(entry, hint) >= 700) hintBonus += 0.18
      }
      const score = (newlyCovered.length / coverageCost(entry)) * hintBonus
      if (score > bestScore + 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && (newlyCovered.length > (best?.newlyCovered?.length || 0) || (newlyCovered.length === (best?.newlyCovered?.length || 0) && entry.boundsArea < (best?.entry?.boundsArea ?? Infinity))))) {
        best = { entry, newlyCovered }
        bestScore = score
      }
    }
    if (!best) break
    chosen.push(best.entry)
    for (const index of best.newlyCovered) uncovered.delete(index)
  }

  // Remove redundant larger extracts. This matters when the only way to bridge
  // an uncovered corridor is a parent extract: if that parent alone covers the
  // entire route, do not also scan endpoint child extracts for no visual gain.
  let pruned = chosen.slice().sort((a, b) => coverageCost(b) - coverageCost(a))
  for (const candidate of [...pruned]) {
    const without = pruned.filter(item => item.filePath !== candidate.filePath)
    if (without.length && coversAllSampleIndexes(without, samples.length)) pruned = without
  }

  const selected = pruned.map(item => ({
    ...item,
    matchReason: pruned.length > 1 ? 'multi-extract-route-corridor-coverage' : item.nameScore >= 700 ? 'region-and-corridor-bounds' : 'route-corridor-bounds',
  }))
  const uncoveredCorridorSampleIndexes = [...uncovered]
  const uncoveredCorridorLegIndexes = [...new Set(uncoveredCorridorSampleIndexes.map(index => samples[index]).filter(sample => sample?.kind === 'corridor').map(sample => sample.legIndex))].sort((a, b) => a - b)
  const complete = uncoveredPointIndexes.length === 0 && uncoveredCorridorSampleIndexes.length === 0
  return {
    selected,
    complete,
    uncoveredPointIndexes: [...new Set(uncoveredPointIndexes)].sort((a, b) => a - b),
    uncoveredCorridorSampleIndexes,
    uncoveredCorridorLegIndexes,
    corridorSampleCount: samples.length,
    corridorCoverageComplete: uncoveredCorridorSampleIndexes.length === 0,
    longDistanceLegIndexes,
    catalog,
  }
}

