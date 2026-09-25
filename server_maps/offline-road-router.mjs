// Bounded offline transport-network routing used only for geometry drawn over
// local Geofabrik/OpenStreetMap PBFs. Canonical coordinates and traveler-owned
// leg modes come in; mode-appropriate network geometry comes out. Dynamic map
// facts never become itinerary authority.
import { normalizeTransportMode } from './transport-mode.mjs'

function radians(value) { return Number(value) * Math.PI / 180 }

export function haversineKm(a = {}, b = {}) {
  const lat1 = Number(a?.lat ?? a?.[1]); const lon1 = Number(a?.lon ?? a?.[0])
  const lat2 = Number(b?.lat ?? b?.[1]); const lon2 = Number(b?.lon ?? b?.[0])
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity
  const dLat = radians(lat2 - lat1)
  const raw = lon2 - lon1
  const dLon = radians(((raw + 180) % 360 + 360) % 360 - 180)
  const p1 = radians(lat1); const p2 = radians(lat2)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
}

const DRIVE_ROADS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'road',
  'residential', 'living_street', 'service', 'track',
])
const WALK_WAYS = new Set([
  'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'unclassified', 'road', 'residential', 'living_street', 'service', 'track', 'path',
  'footway', 'pedestrian', 'steps', 'bridleway', 'cycleway',
])
const BIKE_WAYS = new Set([
  'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'unclassified', 'road', 'residential', 'living_street', 'service', 'track', 'path',
  'cycleway', 'bridleway',
])
const RAIL_WAYS = new Set(['rail', 'light_rail', 'narrow_gauge', 'tram', 'subway'])

const MODE_BITS = Object.freeze({ Walk: 1, Bike: 2, Train: 4, Bus: 8, Car: 16, Ferry: 32, Scooter: 64 })
const ALL_TERRESTRIAL_BITS = Object.values(MODE_BITS).reduce((sum, bit) => sum | bit, 0)

const CLASS_FACTOR = Object.freeze({
  motorway: 0.82, motorway_link: 0.92,
  trunk: 0.86, trunk_link: 0.94,
  primary: 0.90, primary_link: 0.96,
  secondary: 0.96, secondary_link: 1.00,
  tertiary: 1.02, tertiary_link: 1.04,
  unclassified: 1.08, road: 1.10, residential: 1.12, living_street: 1.15,
  service: 1.18, track: 1.22, path: 1.18, footway: 1.12, pedestrian: 1.08,
  cycleway: 1.05, bridleway: 1.18, steps: 1.35,
  rail: 0.82, light_rail: 0.92, narrow_gauge: 0.98, tram: 1.02, subway: 0.88,
  ferry: 1.15,
})

export function transportModesForWay(way = {}) {
  const highway = String(way?.highway || '').toLowerCase()
  const railway = String(way?.railway || '').toLowerCase()
  const route = String(way?.route || '').toLowerCase()
  const ferry = String(way?.ferry || '').toLowerCase()
  const modes = new Set()
  if (DRIVE_ROADS.has(highway)) { modes.add('Car'); modes.add('Bus'); modes.add('Scooter') }
  if (WALK_WAYS.has(highway)) modes.add('Walk')
  if (BIKE_WAYS.has(highway)) modes.add('Bike')
  if (RAIL_WAYS.has(railway)) modes.add('Train')
  if (route === 'ferry' || ['yes', 'designated'].includes(ferry)) modes.add('Ferry')
  return [...modes]
}

function modeMaskForWay(way = {}) {
  return transportModesForWay(way).reduce((mask, mode) => mask | (MODE_BITS[mode] || 0), 0)
}

function classForWay(way = {}) {
  if (String(way?.route || '').toLowerCase() === 'ferry' || /^(?:yes|designated)$/i.test(String(way?.ferry || ''))) return 'ferry'
  return String(way?.railway || way?.highway || 'road').toLowerCase()
}

function modeBit(mode = 'Car') { return MODE_BITS[normalizeTransportMode(mode)] || 0 }

class MinHeap {
  constructor() { this.items = [] }
  push(item) {
    const a = this.items; a.push(item)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p][0] <= item[0]) break
      a[i] = a[p]; i = p
    }
    a[i] = item
  }
  pop() {
    const a = this.items
    if (!a.length) return null
    const root = a[0]
    const last = a.pop()
    if (a.length) {
      let i = 0
      while (true) {
        let child = i * 2 + 1
        if (child >= a.length) break
        if (child + 1 < a.length && a[child + 1][0] < a[child][0]) child += 1
        if (a[child][0] >= last[0]) break
        a[i] = a[child]; i = child
      }
      a[i] = last
    }
    return root
  }
  get size() { return this.items.length }
}

export class BoundedRoadGraph {
  constructor({ maxNodes = 100000, maxEdges = 260000, cellDegrees = 0.08 } = {}) {
    this.maxNodes = Math.max(1000, Number(maxNodes) || 100000)
    this.maxEdges = Math.max(2000, Number(maxEdges) || 260000)
    this.cellDegrees = Math.max(0.02, Number(cellDegrees) || 0.08)

    // RC75 PACKED ROUTE GRAPH
    // RC74 stored every adjacency edge as a nested JavaScript array. On a
    // dense country extract the object overhead could exhaust the bounded
    // route graph long before the typed coordinate index used by the basemap,
    // producing the chronic "map loads, confirmed route geometry fails"
    // split. Keep OSM-id lookup/spatial buckets on the JS heap, but store the
    // graph itself in compact typed arrays. This raises connected-network
    // coverage without turning the worker into an unbounded country router.
    this.idToIndex = new Map()
    this.lons = new Float64Array(this.maxNodes)
    this.lats = new Float64Array(this.maxNodes)
    this.head = new Int32Array(this.maxNodes); this.head.fill(-1)
    this.edgeTo = new Int32Array(this.maxEdges)
    this.edgeNext = new Int32Array(this.maxEdges); this.edgeNext.fill(-1)
    this.edgeCost = new Float32Array(this.maxEdges)
    this.edgeMask = new Uint8Array(this.maxEdges)
    this.nodeCount = 0
    this.edgeCount = 0
    this.capacityReached = false
    this.nodeCapacityReached = false
    this.edgeCapacityReached = false
    this.spatial = new Map()
  }

  _cellKey(lon, lat) { return `${Math.floor((Number(lon) + 180) / this.cellDegrees)},${Math.floor((Number(lat) + 90) / this.cellDegrees)}` }

  _indexNode(id, coord) {
    const key = Number(id)
    if (!Number.isFinite(key) || !coord || !Number.isFinite(Number(coord[0])) || !Number.isFinite(Number(coord[1]))) return -1
    const found = this.idToIndex.get(key); if (found != null) return found
    if (this.nodeCount >= this.maxNodes) {
      this.capacityReached = true; this.nodeCapacityReached = true
      return -1
    }
    const index = this.nodeCount; this.nodeCount += 1
    this.idToIndex.set(key, index)
    this.lons[index] = Number(coord[0]); this.lats[index] = Number(coord[1])
    const cell = this._cellKey(coord[0], coord[1])
    if (!this.spatial.has(cell)) this.spatial.set(cell, [])
    this.spatial.get(cell).push(index)
    return index
  }

  _addDirectedEdge(from, to, cost, mask) {
    if (this.edgeCount >= this.maxEdges) {
      this.capacityReached = true; this.edgeCapacityReached = true
      return false
    }
    const edge = this.edgeCount; this.edgeCount += 1
    this.edgeTo[edge] = to
    this.edgeCost[edge] = cost
    this.edgeMask[edge] = mask
    this.edgeNext[edge] = this.head[from]
    this.head[from] = edge
    return true
  }

  _nodeSupportsMode(index, bit) {
    for (let edge = this.head[index]; edge >= 0; edge = this.edgeNext[edge]) {
      if (this.edgeMask[edge] & bit) return true
    }
    return false
  }

  addWay(way = {}, coordinateForRef = () => undefined) {
    const mask = modeMaskForWay(way)
    if (!mask || !Array.isArray(way?.refs) || way.refs.length < 2) return 0
    if (this.edgeCount >= this.maxEdges) { this.capacityReached = true; this.edgeCapacityReached = true; return 0 }
    const wayClass = classForWay(way)
    let previous = -1; let added = 0
    for (const ref of way.refs) {
      const coord = coordinateForRef(ref)
      if (!coord) { previous = -1; continue }
      const current = this._indexNode(ref, coord)
      if (current < 0) { previous = -1; continue }
      if (previous >= 0 && previous !== current) {
        if (this.edgeCount + 2 > this.maxEdges) { this.capacityReached = true; this.edgeCapacityReached = true; break }
        const a = { lat: this.lats[previous], lon: this.lons[previous] }; const b = { lat: this.lats[current], lon: this.lons[current] }
        const distance = haversineKm(a, b)
        if (Number.isFinite(distance) && distance > 0 && distance < 60) {
          const cost = distance * (CLASS_FACTOR[wayClass] || 1)
          const forward = this._addDirectedEdge(previous, current, cost, mask)
          const backward = this._addDirectedEdge(current, previous, cost, mask)
          if (!forward || !backward) break
          added += 1
        }
      }
      previous = current
    }
    return added
  }

  nearest(point = {}, maxSnapKm = 45, mode = 'Car') {
    const lon = Number(point?.lon); const lat = Number(point?.lat); const bit = modeBit(mode)
    if (![lon, lat].every(Number.isFinite) || !this.nodeCount || !bit) return null
    const cx = Math.floor((lon + 180) / this.cellDegrees); const cy = Math.floor((lat + 90) / this.cellDegrees)
    const degreesPerCellKm = Math.max(1, this.cellDegrees * 111); const radius = Math.min(24, Math.max(1, Math.ceil(Number(maxSnapKm || 45) / degreesPerCellKm)))
    let best = -1; let bestKm = Infinity
    for (let r = 0; r <= radius; r += 1) {
      for (let dx = -r; dx <= r; dx += 1) for (let dy = -r; dy <= r; dy += 1) {
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue
        const bucket = this.spatial.get(`${cx + dx},${cy + dy}`) || []
        for (const index of bucket) {
          if (!this._nodeSupportsMode(index, bit)) continue
          const km = haversineKm({ lon, lat }, { lon: this.lons[index], lat: this.lats[index] })
          if (km < bestKm) { bestKm = km; best = index }
        }
      }
      if (best >= 0 && bestKm <= Math.max(3, r * degreesPerCellKm * 0.8)) break
    }
    if (best < 0 || bestKm > Number(maxSnapKm || 45)) return null
    return { index: best, distanceKm: bestKm, point: { lon: this.lons[best], lat: this.lats[best] } }
  }

  route(startPoint = {}, endPoint = {}, { maxSnapKm = 45, startSnapKm = null, endSnapKm = null, maxVisited = 90000, mode = 'Car' } = {}) {
    const normalizedMode = normalizeTransportMode(mode)
    if (normalizedMode === 'Any') return { ok: false, reason: 'mode-unconfirmed', geometry: [] }
    if (normalizedMode === 'Flight') return { ok: false, reason: 'non-terrestrial', geometry: [] }
    const bit = modeBit(normalizedMode)
    if (!bit) return { ok: false, reason: 'mode-unsupported', geometry: [] }
    const startLimitKm = Number.isFinite(Number(startSnapKm)) ? Math.min(Number(maxSnapKm || 45), Number(startSnapKm)) : routingSnapLimitKm(startPoint, maxSnapKm)
    const endLimitKm = Number.isFinite(Number(endSnapKm)) ? Math.min(Number(maxSnapKm || 45), Number(endSnapKm)) : routingSnapLimitKm(endPoint, maxSnapKm)
    const start = this.nearest(startPoint, startLimitKm, normalizedMode); const end = this.nearest(endPoint, endLimitKm, normalizedMode)
    if (!start || !end) return { ok: false, reason: !start ? 'start-unsnapped' : 'end-unsnapped', startSnapKm: start?.distanceKm ?? null, endSnapKm: end?.distanceKm ?? null, startSnapLimitKm: startLimitKm, endSnapLimitKm: endLimitKm, geometry: [] }
    if (start.index === end.index) return { ok: true, geometry: [start.point, end.point], distanceKm: 0, startSnapKm: start.distanceKm, endSnapKm: end.distanceKm, startSnapLimitKm: startLimitKm, endSnapLimitKm: endLimitKm, visited: 1, mode: normalizedMode }

    // Bidirectional Dijkstra sharply reduces the number of nodes explored on
    // country-scale PBF graphs. RC75 traverses packed adjacency arrays instead
    // of allocating an object/array for every retained edge.
    const n = this.nodeCount
    const distF = new Float64Array(n); distF.fill(Infinity)
    const distB = new Float64Array(n); distB.fill(Infinity)
    const parentF = new Int32Array(n); parentF.fill(-1)
    const parentB = new Int32Array(n); parentB.fill(-1)
    const closedF = new Uint8Array(n); const closedB = new Uint8Array(n)
    const heapF = new MinHeap(); const heapB = new MinHeap()
    distF[start.index] = 0; distB[end.index] = 0
    heapF.push([0, start.index]); heapB.push([0, end.index])
    let visited = 0; let meeting = -1; let best = Infinity

    const expand = (heap, distHere, distOther, parentHere, closedHere, closedOther) => {
      while (heap.size) {
        const entry = heap.pop(); if (!entry) return
        const current = entry[1]
        if (closedHere[current]) continue
        closedHere[current] = 1; visited += 1
        if (closedOther[current] && distHere[current] + distOther[current] < best) {
          best = distHere[current] + distOther[current]; meeting = current
        }
        for (let edge = this.head[current]; edge >= 0; edge = this.edgeNext[edge]) {
          const edgeMask = this.edgeMask[edge] || ALL_TERRESTRIAL_BITS
          if (!(edgeMask & bit)) continue
          const next = this.edgeTo[edge]
          const candidate = distHere[current] + this.edgeCost[edge]
          if (candidate < distHere[next]) {
            distHere[next] = candidate; parentHere[next] = current; heap.push([candidate, next])
          }
          if (closedOther[next] && candidate + distOther[next] < best) {
            best = candidate + distOther[next]; meeting = next
          }
        }
        return
      }
    }

    const limit = Math.max(1000, Number(maxVisited) || 90000)
    while ((heapF.size || heapB.size) && visited < limit) {
      if (heapF.size) expand(heapF, distF, distB, parentF, closedF, closedB)
      if (meeting >= 0 && heapF.items?.[0]?.[0] + (heapB.items?.[0]?.[0] ?? Infinity) >= best) break
      if (heapB.size && visited < limit) expand(heapB, distB, distF, parentB, closedB, closedF)
      if (meeting >= 0 && (heapF.items?.[0]?.[0] ?? Infinity) + (heapB.items?.[0]?.[0] ?? Infinity) >= best) break
    }
    if (meeting < 0) return { ok: false, reason: visited >= limit ? 'search-limit' : 'disconnected', startSnapKm: start.distanceKm, endSnapKm: end.distanceKm, startSnapLimitKm: startLimitKm, endSnapLimitKm: endLimitKm, visited, geometry: [], mode: normalizedMode }

    const left = []
    for (let cursor = meeting; cursor >= 0; cursor = parentF[cursor]) { left.push(cursor); if (cursor === start.index) break }
    if (left.at(-1) !== start.index) return { ok: false, reason: 'disconnected', startSnapKm: start.distanceKm, endSnapKm: end.distanceKm, visited, geometry: [], mode: normalizedMode }
    left.reverse()
    const right = []
    for (let cursor = parentB[meeting]; cursor >= 0; cursor = parentB[cursor]) { right.push(cursor); if (cursor === end.index) break }
    if (meeting !== end.index && right.at(-1) !== end.index) return { ok: false, reason: 'disconnected', startSnapKm: start.distanceKm, endSnapKm: end.distanceKm, visited, geometry: [], mode: normalizedMode }
    const indices = [...left, ...right]
    const geometry = indices.map(index => ({ lon: this.lons[index], lat: this.lats[index] }))
    let distanceKm = 0
    for (let i = 1; i < geometry.length; i += 1) distanceKm += haversineKm(geometry[i - 1], geometry[i])
    return { ok: true, geometry, distanceKm, startSnapKm: start.distanceKm, endSnapKm: end.distanceKm, startSnapLimitKm: startLimitKm, endSnapLimitKm: endLimitKm, visited, mode: normalizedMode }
  }

  stats() {
    return {
      routeGraphNodes: this.nodeCount,
      routeGraphEdges: this.edgeCount,
      routeGraphCapacityReached: this.capacityReached,
      routeGraphNodeCapacityReached: this.nodeCapacityReached,
      routeGraphEdgeCapacityReached: this.edgeCapacityReached,
      routeGraphStorage: 'packed-typed-arrays',
    }
  }
}


export function routingSnapLimitKm(point = {}, fallbackMaxKm = 45) {
  const ceiling = Math.max(1, Number(fallbackMaxKm) || 45)
  const kind = String(point?.placeKind || point?.kind || '').trim().toLowerCase()
  // A PBF route is only credible when each canonical occurrence snaps close to
  // its verified identity. Large blanket radii can turn a park/lake centroid or
  // a wrong-city coordinate into a convincing but false road route.
  const kindLimit = kind === 'landmark' ? 8
    : kind === 'transport-node' ? 8
      : kind === 'natural-area' ? 30
        : 15
  return Math.min(ceiling, kindLimit)
}

export function capRouteGeometry(points = [], maxPoints = 1400) {
  const source = Array.isArray(points) ? points : []; const max = Math.max(2, Number(maxPoints) || 1400)
  if (source.length <= max) return source
  const out = []
  for (let i = 0; i < max; i += 1) {
    const index = Math.round((i / (max - 1)) * (source.length - 1)); const point = source[index]
    if (!out.length || point.lon !== out.at(-1)?.lon || point.lat !== out.at(-1)?.lat) out.push(point)
  }
  return out
}

export function routeFocusLegs(points = [], maxTerrestrialKm = 6000, legModes = null) {
  const source = (Array.isArray(points) ? points : []).filter(point => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon)))
  const explicitModes = Array.isArray(legModes)
  const legs = []
  for (let index = 0; index < source.length - 1; index += 1) {
    const distanceKm = haversineKm(source[index], source[index + 1])
    const mode = normalizeTransportMode(explicitModes ? legModes[index] : 'Car')
    const terrestrialCandidate = mode !== 'Flight' && mode !== 'Any' && Number.isFinite(distanceKm) && distanceKm <= Number(maxTerrestrialKm || 6000)
    legs.push({ index, from: source[index], to: source[index + 1], distanceKm, mode, terrestrialCandidate, modeUnconfirmed: mode === 'Any', nonTerrestrial: mode === 'Flight', beyondRoutingBound: Number.isFinite(distanceKm) && distanceKm > Number(maxTerrestrialKm || 6000) })
  }
  return legs
}

export function adaptiveRouteCorridorKm(points = [], { minKm = 70, maxKm = 220, baseKm = 50, distanceFactor = 0.15, maxTerrestrialKm = 6000, legModes = null } = {}) {
  const legs = routeFocusLegs(points, maxTerrestrialKm, legModes).filter(item => item.terrestrialCandidate && Number.isFinite(item.distanceKm))
  if (!legs.length) return Math.max(1, Number(minKm) || 70)
  const longest = Math.max(...legs.map(item => item.distanceKm)); const requested = Number(baseKm || 50) + longest * Number(distanceFactor || 0.15)
  return Math.max(Number(minKm || 70), Math.min(Number(maxKm || 220), Math.round(requested)))
}

export function routeFocusSegments(graph, points = [], {
  maxTerrestrialKm = 6000, maxSnapKm = 45, maxVisited = 90000, maxGeometryPoints = 1400, legModes = null,
} = {}) {
  if (!graph || typeof graph.route !== 'function') return []
  return routeFocusLegs(points, maxTerrestrialKm, legModes).map(leg => {
    if (leg.modeUnconfirmed) return { index: leg.index, status: 'mode-unconfirmed', mode: leg.mode, distanceKm: leg.distanceKm, geometry: [] }
    if (leg.nonTerrestrial) return { index: leg.index, status: 'non-terrestrial', mode: leg.mode, distanceKm: leg.distanceKm, geometry: [] }
    if (!leg.terrestrialCandidate) return { index: leg.index, status: 'distance-unrouted', mode: leg.mode, distanceKm: leg.distanceKm, geometry: [] }
    const startSnapLimitKm = routingSnapLimitKm(leg.from, maxSnapKm)
    const endSnapLimitKm = routingSnapLimitKm(leg.to, maxSnapKm)
    const routed = graph.route(leg.from, leg.to, { maxSnapKm, startSnapKm: startSnapLimitKm, endSnapKm: endSnapLimitKm, maxVisited, mode: leg.mode })
    if (!routed.ok || !Array.isArray(routed.geometry) || routed.geometry.length < 2) return { index: leg.index, status: routed.reason || 'unrouted', mode: leg.mode, distanceKm: leg.distanceKm, startSnapKm: routed.startSnapKm ?? null, endSnapKm: routed.endSnapKm ?? null, startSnapLimitKm, endSnapLimitKm, visited: routed.visited || 0, geometry: [] }
    return { index: leg.index, status: 'routed', mode: leg.mode, distanceKm: routed.distanceKm, startSnapKm: routed.startSnapKm, endSnapKm: routed.endSnapKm, startSnapLimitKm, endSnapLimitKm, visited: routed.visited, geometry: capRouteGeometry(routed.geometry, maxGeometryPoints) }
  })
}
