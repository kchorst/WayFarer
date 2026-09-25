export const MAP_RENDER_LIMITS = Object.freeze({
  // RC53: the renderer keeps only nodes inside a narrow route corridor. Typed
  // arrays make ~1.2M retained coordinates practical without turning a country
  // extract into a giant JS Map.
  maxIndexedNodes: 1500000,
  maxPlannedRoadWays: 60000,
  largeExtractRoadDetailThresholdBytes: 180 * 1024 * 1024,
  veryLargeExtractRoadDetailThresholdBytes: 700 * 1024 * 1024,
  maxRoadSegments: 7000,
  maxRoadVertices: 42000,
  // RC75: the offline route graph is packed into typed adjacency arrays. It
  // remains bounded well below the 1.5M basemap coordinate index, but can now
  // retain a substantially larger connected network on dense country extracts
  // without RC74's nested-array memory overhead.
  maxRouteGraphNodes: 320000,
  maxRouteGraphEdges: 900000,
  maxRouteSearchVisited: 220000,
  maxRouteSnapKm: 45,
  maxRouteGeometryPoints: 1400,
  maxLabels: 20,
  maxSvgBytes: 2500 * 1024,
  // RC53's normal path is one PBF pass, not two. Keep a hard aggregate ceiling,
  // but give a normal country extract enough time to reach its way blocks.
  maxJobElapsedMs: 90000,
  maxPerExtractElapsedMs: 60000,
  // Large country extracts need enough wall-clock budget to reach their way
  // blocks. Memory/geometry limits remain bounded; time alone scales with file
  // size so a 2+ GB extract is not guaranteed to fail before any road ways are
  // encountered.
  maxLargeJobElapsedMs: 240000,
  maxLargePerExtractElapsedMs: 210000,
  minPerExtractElapsedMs: 14000,
  maxRoadPointsPerSegment: 56,
  maxInflatedPbfBlockBytes: 48 * 1024 * 1024,
  workerOldGenerationMb: 256,
  workerYoungGenerationMb: 48,
  workerStackMb: 4,
})


export function mapJobTimeBudgetMs(sourceFiles = [], total = MAP_RENDER_LIMITS) {
  const bytes = (Array.isArray(sourceFiles) ? sourceFiles : []).reduce((sum, item) => sum + Math.max(0, Number(item?.size || item || 0)), 0)
  const veryLarge = Number(total.veryLargeExtractRoadDetailThresholdBytes || MAP_RENDER_LIMITS.veryLargeExtractRoadDetailThresholdBytes)
  if (bytes < veryLarge) return Number(total.maxJobElapsedMs || MAP_RENDER_LIMITS.maxJobElapsedMs)
  const extraUnits = Math.max(1, Math.ceil(bytes / Math.max(1, veryLarge)))
  return Math.min(
    Number(total.maxLargeJobElapsedMs || 240000),
    Number(total.maxJobElapsedMs || 90000) + extraUnits * 45000,
  )
}

export function perExtractTimeCeilingMs(fileSize = 0, total = MAP_RENDER_LIMITS) {
  const size = Math.max(0, Number(fileSize) || 0)
  const veryLarge = Number(total.veryLargeExtractRoadDetailThresholdBytes || MAP_RENDER_LIMITS.veryLargeExtractRoadDetailThresholdBytes)
  if (size < veryLarge) return Number(total.maxPerExtractElapsedMs || MAP_RENDER_LIMITS.maxPerExtractElapsedMs)
  const units = Math.max(1, Math.ceil(size / Math.max(1, veryLarge)))
  return Math.min(
    Number(total.maxLargePerExtractElapsedMs || 210000),
    Number(total.maxPerExtractElapsedMs || 60000) + units * 45000,
  )
}

export function renderLimitsForExtract(total = MAP_RENDER_LIMITS, fileCount = 1) {
  const count = Math.max(1, Number(fileCount) || 1)
  return {
    ...total,
    // Geometry/browser budgets remain aggregate-bounded across several files.
    // Time is allocated separately in the worker from remaining job time and
    // actual file sizes; RC52's mechanical 57s/count split made ordinary
    // two-country and multi-state routes fail before useful geometry existed.
    maxRoadSegments: Math.max(1, Math.floor(total.maxRoadSegments / count)),
    maxRoadVertices: Math.max(2, Math.floor(total.maxRoadVertices / count)),
    maxSvgBytes: Math.max(1, Math.floor(total.maxSvgBytes / count)),
    maxPerExtractElapsedMs: total.maxPerExtractElapsedMs,
  }
}

export function extractTimeBudgetMs({ total = MAP_RENDER_LIMITS, fileSize = 0, remainingFileSizes = [], elapsedMs = 0 } = {}) {
  const remainingJob = Math.max(1000, Number(total.maxJobElapsedMs || 0) - Math.max(0, Number(elapsedMs) || 0) - 2500)
  const sizes = (Array.isArray(remainingFileSizes) ? remainingFileSizes : []).map(value => Math.max(0, Number(value) || 0))
  const current = Math.max(0, Number(fileSize) || sizes[0] || 0)
  const totalRemainingBytes = sizes.reduce((sum, value) => sum + value, 0)
  const share = totalRemainingBytes > 0 && current > 0 ? current / totalRemainingBytes : 1 / Math.max(1, sizes.length || 1)
  // Size-weighting prevents a 50 MB Rhode Island file from receiving the same
  // slice as a 473 MB New York file. A floor protects small cross-border files;
  // the aggregate worker timeout remains the final safety ceiling.
  const weighted = Math.round(remainingJob * Math.max(0.16, share))
  return Math.max(
    Math.min(Number(total.minPerExtractElapsedMs || 14000), remainingJob),
    Math.min(perExtractTimeCeilingMs(current, total), remainingJob, weighted),
  )
}

export function formatBytes(bytes = 0) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
