import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { MAP_RENDER_LIMITS } from './map-render-limits.mjs'
import { BoundedRoadGraph, capRouteGeometry, routeFocusLegs, transportModesForWay } from './offline-road-router.mjs'

const ROAD_CLASSES = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'road',
])

const CORE_RENDER_ROAD_CLASSES = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
])

const MAJOR_RENDER_ROAD_CLASSES = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link',
])

const ROAD_STYLE = {
  motorway: { weight: 2.0, tone: '#c98b67' }, motorway_link: { weight: 1.5, tone: '#c98b67' },
  trunk: { weight: 1.8, tone: '#d4a276' }, trunk_link: { weight: 1.4, tone: '#d4a276' },
  primary: { weight: 1.6, tone: '#d6b382' }, primary_link: { weight: 1.3, tone: '#d6b382' },
  secondary: { weight: 1.25, tone: '#aab08e' }, secondary_link: { weight: 1.05, tone: '#aab08e' },
  tertiary: { weight: 1.0, tone: '#89947e' }, tertiary_link: { weight: 0.9, tone: '#89947e' },
  unclassified: { weight: 0.72, tone: '#697565' }, residential: { weight: 0.62, tone: '#5f6d5c' },
  living_street: { weight: 0.58, tone: '#5f6d5c' }, road: { weight: 0.58, tone: '#5f6d5c' },
}

function readVarint(buffer, start) {
  let value = 0n
  let shift = 0n
  let pos = start
  while (pos < buffer.length) {
    const byte = BigInt(buffer[pos++])
    value |= (byte & 0x7fn) << shift
    if ((byte & 0x80n) === 0n) return { value, pos }
    shift += 7n
    if (shift > 70n) throw new Error('Invalid protobuf varint.')
  }
  throw new Error('Unexpected end of protobuf varint.')
}

function zigZag(value) {
  return Number((value >> 1n) ^ (-(value & 1n)))
}

function skipField(buffer, pos, wire) {
  if (wire === 0) return readVarint(buffer, pos).pos
  if (wire === 1) return pos + 8
  if (wire === 2) {
    const length = readVarint(buffer, pos)
    return length.pos + Number(length.value)
  }
  if (wire === 5) return pos + 4
  throw new Error(`Unsupported protobuf wire type ${wire}.`)
}

function eachField(buffer, callback) {
  let pos = 0
  while (pos < buffer.length) {
    const tag = readVarint(buffer, pos)
    pos = tag.pos
    const field = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (wire === 2) {
      const length = readVarint(buffer, pos)
      const start = length.pos
      const end = start + Number(length.value)
      if (end > buffer.length) throw new Error('Invalid protobuf length-delimited field.')
      callback(field, wire, buffer.subarray(start, end))
      pos = end
    } else if (wire === 0) {
      const value = readVarint(buffer, pos)
      callback(field, wire, value.value)
      pos = value.pos
    } else {
      const next = skipField(buffer, pos, wire)
      callback(field, wire, buffer.subarray(pos, next))
      pos = next
    }
  }
}

function packedVarints(buffer, signed = false) {
  const out = []
  let pos = 0
  while (pos < buffer.length) {
    const value = readVarint(buffer, pos)
    pos = value.pos
    out.push(signed ? zigZag(value.value) : Number(value.value))
  }
  return out
}

function parseBlobHeader(buffer) {
  let type = ''
  let dataSize = 0
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === 2) type = value.toString('utf8')
    else if (field === 3 && wire === 0) dataSize = Number(value)
  })
  return { type, dataSize }
}

function parseBlob(buffer) {
  let raw = null
  let rawSize = 0
  let zlibData = null
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === 2) raw = value
    else if (field === 2 && wire === 0) rawSize = Number(value)
    else if (field === 3 && wire === 2) zlibData = value
  })
  const maxOutput = MAP_RENDER_LIMITS.maxInflatedPbfBlockBytes
  if (raw) {
    if (raw.length > maxOutput) throw new Error(`OSM PBF block exceeds the ${Math.round(maxOutput / 1024 / 1024)} MB decompression safety limit.`)
    return raw
  }
  if (rawSize > maxOutput) throw new Error(`OSM PBF block declares ${Math.round(rawSize / 1024 / 1024)} MB, above the ${Math.round(maxOutput / 1024 / 1024)} MB decompression safety limit.`)
  if (zlibData) return zlib.inflateSync(zlibData, { maxOutputLength: maxOutput })
  throw new Error('Unsupported OSM PBF compression. WAYFINDER currently supports raw/zlib Geofabrik blobs.')
}

async function *readBlocks(filePath, onBytes) {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    let position = 0
    const sizeBuffer = Buffer.allocUnsafe(4)
    while (position + 4 <= stat.size) {
      const sizeRead = await handle.read(sizeBuffer, 0, 4, position)
      if (sizeRead.bytesRead !== 4) break
      position += 4
      const headerSize = sizeBuffer.readUInt32BE(0)
      if (headerSize <= 0 || headerSize > 64 * 1024) throw new Error('Invalid OSM PBF blob header size.')
      const headerBuffer = Buffer.allocUnsafe(headerSize)
      const headerRead = await handle.read(headerBuffer, 0, headerSize, position)
      if (headerRead.bytesRead !== headerSize) throw new Error('Unexpected end of OSM PBF header.')
      position += headerSize
      const header = parseBlobHeader(headerBuffer)
      if (header.dataSize <= 0 || header.dataSize > 64 * 1024 * 1024) throw new Error('Invalid OSM PBF blob size.')
      const blobBuffer = Buffer.allocUnsafe(header.dataSize)
      const blobRead = await handle.read(blobBuffer, 0, header.dataSize, position)
      if (blobRead.bytesRead !== header.dataSize) throw new Error('Unexpected end of OSM PBF blob.')
      position += header.dataSize
      onBytes?.(position, stat.size)
      yield { type: header.type, data: parseBlob(blobBuffer), position, size: stat.size }
    }
  } finally {
    await handle.close()
  }
}

function parseStringTable(buffer) {
  const strings = []
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === 2) strings.push(value.toString('utf8'))
  })
  return strings
}

function parsePrimitiveBlock(buffer, visitGroup) {
  let strings = []
  const groups = []
  let granularity = 100
  let latOffset = 0
  let lonOffset = 0
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === 2) strings = parseStringTable(value)
    else if (field === 2 && wire === 2) groups.push(value)
    else if (field === 17 && wire === 0) granularity = Number(value)
    else if (field === 19 && wire === 0) latOffset = Number(BigInt.asIntN(64, value))
    else if (field === 20 && wire === 0) lonOffset = Number(BigInt.asIntN(64, value))
  })
  for (const group of groups) visitGroup(group, { strings, granularity, latOffset, lonOffset })
}

function tagValue(keys, vals, strings, wanted) {
  const limit = Math.min(keys.length, vals.length)
  for (let index = 0; index < limit; index += 1) {
    if (strings[keys[index]] === wanted) return strings[vals[index]] || ''
  }
  return ''
}

function latinReadableLabel(value = '') {
  const text = String(value || '').trim()
  if (!text) return ''
  for (const character of text) {
    if (/\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character)) return ''
  }
  return text
}

export function preferredMapLabel({ english = '', officialEnglish = '', altEnglish = '', shortEnglish = '', international = '', latin = '', local = '' } = {}) {
  // Offline maps are an English-language WAYFINDER surface. Prefer explicit
  // OSM English names, then other Latin-readable international/romanized names.
  // Never fall back to a non-Roman native-script label (Han, Kana, Hangul,
  // Cyrillic, Arabic, Thai, etc.); omitting that background label is preferable
  // to producing a mixed-script map. Canonical route-stop labels are rendered
  // separately by the UI and remain available even when a PBF place lacks an
  // English/romanized OSM name.
  return [english, officialEnglish, altEnglish, shortEnglish, international, latin, local]
    .map(latinReadableLabel)
    .find(Boolean) || ''
}

function parseWay(buffer, strings) {
  let id = 0
  let keys = []
  let vals = []
  let refsDelta = []
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === 0) id = Number(value)
    else if (field === 2 && wire === 2) keys = packedVarints(value)
    else if (field === 3 && wire === 2) vals = packedVarints(value)
    else if (field === 8 && wire === 2) refsDelta = packedVarints(value, true)
  })
  const highway = tagValue(keys, vals, strings, 'highway')
  const railway = tagValue(keys, vals, strings, 'railway')
  const route = tagValue(keys, vals, strings, 'route')
  const ferry = tagValue(keys, vals, strings, 'ferry')
  const candidate = { id, highway, railway, route, ferry }
  if (!transportModesForWay(candidate).length) return null
  let ref = 0
  const refs = refsDelta.map(delta => (ref += delta))
  return { ...candidate, refs }
}


class ChunkedNodeIndex {
  constructor(maxEntries = MAP_RENDER_LIMITS.maxIndexedNodes, chunkSize = 65536) {
    this.maxEntries = Math.max(1, Number(maxEntries) || MAP_RENDER_LIMITS.maxIndexedNodes)
    this.chunkSize = Math.max(1024, Number(chunkSize) || 65536)
    this.ids = []
    this.lons = []
    this.lats = []
    this.size = 0
    this.lastId = -Infinity
    this.monotonic = true
    this.capacityReached = false
  }

  _ensureChunk(index) {
    const chunkIndex = Math.floor(index / this.chunkSize)
    if (!this.ids[chunkIndex]) {
      this.ids[chunkIndex] = new Float64Array(this.chunkSize)
      this.lons[chunkIndex] = new Float64Array(this.chunkSize)
      this.lats[chunkIndex] = new Float64Array(this.chunkSize)
    }
    return chunkIndex
  }

  set(id, point) {
    if (this.size >= this.maxEntries) {
      this.capacityReached = true
      return false
    }
    const numericId = Number(id)
    if (!Number.isFinite(numericId)) return false
    if (numericId < this.lastId) this.monotonic = false
    this.lastId = numericId
    const index = this.size
    const chunkIndex = this._ensureChunk(index)
    const offset = index % this.chunkSize
    this.ids[chunkIndex][offset] = numericId
    this.lons[chunkIndex][offset] = Number(point?.[0])
    this.lats[chunkIndex][offset] = Number(point?.[1])
    this.size += 1
    return true
  }

  _idAt(index) {
    const chunkIndex = Math.floor(index / this.chunkSize)
    return this.ids[chunkIndex][index % this.chunkSize]
  }

  get(id) {
    if (!this.size || !this.monotonic) return undefined
    const target = Number(id)
    let low = 0
    let high = this.size - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const value = this._idAt(mid)
      if (value === target) {
        const chunkIndex = Math.floor(mid / this.chunkSize)
        const offset = mid % this.chunkSize
        return [this.lons[chunkIndex][offset], this.lats[chunkIndex][offset]]
      }
      if (value < target) low = mid + 1
      else high = mid - 1
    }
    return undefined
  }
}

function parseDenseNodes(buffer, context, acceptPoint, pointSink, labelSink, bounds) {
  let idsDelta = []
  let latsDelta = []
  let lonsDelta = []
  let keysVals = []
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === 2) idsDelta = packedVarints(value, true)
    else if (field === 8 && wire === 2) latsDelta = packedVarints(value, true)
    else if (field === 9 && wire === 2) lonsDelta = packedVarints(value, true)
    else if (field === 10 && wire === 2) keysVals = packedVarints(value)
  })
  let id = 0
  let latRaw = 0
  let lonRaw = 0
  let tagPos = 0
  const count = Math.min(idsDelta.length, latsDelta.length, lonsDelta.length)
  for (let index = 0; index < count; index += 1) {
    id += idsDelta[index]
    latRaw += latsDelta[index]
    lonRaw += lonsDelta[index]
    const lat = 1e-9 * (context.latOffset + context.granularity * latRaw)
    const lon = 1e-9 * (context.lonOffset + context.granularity * lonRaw)

    const accepted = acceptPoint(lon, lat)
    // DenseNodes carries tags for every point in the extract.  Only decode the
    // strings for nodes that are actually inside the route corridor; for all
    // other nodes advance over the packed key/value pairs without allocating
    // names.  This is the dominant CPU saving for country-sized extracts.
    if (!accepted) {
      while (tagPos < keysVals.length && keysVals[tagPos] !== 0) tagPos += 2
      if (tagPos < keysVals.length && keysVals[tagPos] === 0) tagPos += 1
      continue
    }

    let name = ''
    let nameEnglish = ''
    let officialEnglishName = ''
    let altEnglishName = ''
    let shortEnglishName = ''
    let internationalName = ''
    let latinName = ''
    let place = ''
    while (tagPos < keysVals.length && keysVals[tagPos] !== 0) {
      const key = context.strings[keysVals[tagPos++]] || ''
      const value = context.strings[keysVals[tagPos++]] || ''
      if (key === 'name') name = value
      else if (key === 'name:en') nameEnglish = value
      else if (key === 'official_name:en') officialEnglishName = value
      else if (key === 'alt_name:en') altEnglishName = value
      else if (key === 'short_name:en') shortEnglishName = value
      else if (key === 'int_name') internationalName = value
      else if (key === 'name:latin') latinName = value
      else if (key === 'place') place = value
    }
    if (tagPos < keysVals.length && keysVals[tagPos] === 0) tagPos += 1

    pointSink.set(id, [lon, lat])
    const label = preferredMapLabel({ english: nameEnglish, officialEnglish: officialEnglishName, altEnglish: altEnglishName, shortEnglish: shortEnglishName, international: internationalName, latin: latinName, local: name })
    if (label && ['city', 'town', 'village'].includes(place) && withinBounds(lon, lat, bounds, 0.03)) labelSink.push({ name: label, place, lon, lat })
  }
}

function parseNode(buffer, context, acceptPoint, pointSink, labelSink, bounds) {
  let id = 0
  let latRaw = 0
  let lonRaw = 0
  let keys = []
  let vals = []
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === 0) id = zigZag(value)
    else if (field === 2 && wire === 2) keys = packedVarints(value)
    else if (field === 3 && wire === 2) vals = packedVarints(value)
    else if (field === 8 && wire === 0) latRaw = zigZag(value)
    else if (field === 9 && wire === 0) lonRaw = zigZag(value)
  })
  const lat = 1e-9 * (context.latOffset + context.granularity * latRaw)
  const lon = 1e-9 * (context.lonOffset + context.granularity * lonRaw)
  const accepted = acceptPoint(lon, lat)
  if (accepted) pointSink.set(id, [lon, lat])
  const place = tagValue(keys, vals, context.strings, 'place')
  const name = preferredMapLabel({
    english: tagValue(keys, vals, context.strings, 'name:en'),
    officialEnglish: tagValue(keys, vals, context.strings, 'official_name:en'),
    altEnglish: tagValue(keys, vals, context.strings, 'alt_name:en'),
    shortEnglish: tagValue(keys, vals, context.strings, 'short_name:en'),
    international: tagValue(keys, vals, context.strings, 'int_name'),
    latin: tagValue(keys, vals, context.strings, 'name:latin'),
    local: tagValue(keys, vals, context.strings, 'name'),
  })
  if (accepted && name && ['city', 'town', 'village'].includes(place) && withinBounds(lon, lat, bounds, 0.03)) labelSink.push({ name, place, lon, lat })
}

function parseGroupWays(group, context, onWay) {
  eachField(group, (field, wire, value) => {
    if (field === 3 && wire === 2) {
      const way = parseWay(value, context.strings)
      if (way) onWay(way)
    }
  })
}

function parseGroupNodes(group, context, acceptPoint, pointSink, labelSink, bounds) {
  eachField(group, (field, wire, value) => {
    if (field === 1 && wire === 2) parseNode(value, context, acceptPoint, pointSink, labelSink, bounds)
    else if (field === 2 && wire === 2) parseDenseNodes(value, context, acceptPoint, pointSink, labelSink, bounds)
  })
}

function primitiveGroupKinds(group) {
  let hasNodes = false
  let hasWays = false
  eachField(group, (field, wire) => {
    if (wire !== 2) return
    if (field === 1 || field === 2) hasNodes = true
    else if (field === 3) hasWays = true
  })
  return { hasNodes, hasWays }
}

function withinBounds(lon, lat, bounds, padRatio = 0) {
  if (!bounds) return true
  const dx = Math.max(0.02, (bounds.east - bounds.west) * padRatio)
  const dy = Math.max(0.02, (bounds.north - bounds.south) * padRatio)
  return lon >= bounds.west - dx && lon <= bounds.east + dx && lat >= bounds.south - dy && lat <= bounds.north + dy
}

function segmentIntersectsBounds(coords, bounds) {
  if (!coords.length) return false
  let minLon = Infinity; let maxLon = -Infinity; let minLat = Infinity; let maxLat = -Infinity
  for (const [lon, lat] of coords) {
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon); minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
  }
  return !(maxLon < bounds.west || minLon > bounds.east || maxLat < bounds.south || minLat > bounds.north)
}

function simplifyLine(coords, threshold) {
  if (coords.length <= 2 || threshold <= 0) return coords
  const output = [coords[0]]
  let last = coords[0]
  for (let index = 1; index < coords.length - 1; index += 1) {
    const point = coords[index]
    if (Math.abs(point[0] - last[0]) + Math.abs(point[1] - last[1]) >= threshold) {
      output.push(point)
      last = point
    }
  }
  output.push(coords.at(-1))
  return output
}


function finiteFocusPoints(points = []) {
  return (Array.isArray(points) ? points : []).map(point => ({
    lat: Number(point?.lat), lon: Number(point?.lon),
  })).filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon))
}

function sampledFocusPoints(points = [], max = 96) {
  const clean = finiteFocusPoints(points)
  if (clean.length <= max) return clean
  const out = []
  for (let index = 0; index < max; index += 1) {
    const sourceIndex = Math.round((index / Math.max(1, max - 1)) * (clean.length - 1))
    out.push(clean[sourceIndex])
  }
  return out
}

// Build a tiny spatial-cell corridor around the authoritative route shape. This
// is deliberately bounded: country-sized Geofabrik extracts may contain tens of
// millions of road-node references, and collecting all of them in a JS Set/Map
// can exceed V8's maximum collection size. The planning pass uses these cells
// to seed a compact route-membership Bloom filter before accepting road ways.
function wrappedLongitudeDelta(fromLon, toLon) {
  const delta = Number(toLon) - Number(fromLon)
  return ((delta + 180) % 360 + 360) % 360 - 180
}

function focusLegDistanceKm(a = {}, b = {}) {
  const lat1 = Number(a?.lat); const lat2 = Number(b?.lat)
  const lon1 = Number(a?.lon); const lon2 = Number(b?.lon)
  if (![lat1, lat2, lon1, lon2].every(Number.isFinite)) return 0
  const radians = value => value * Math.PI / 180
  const dLat = radians(lat2 - lat1)
  const dLon = radians(wrappedLongitudeDelta(lon1, lon2))
  const p1 = radians(lat1); const p2 = radians(lat2)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
}

export function buildRouteFocusIndex(points = [], bounds = null, { radiusCells = 1, corridorKm = 0 } = {}) {
  const focus = sampledFocusPoints(points)
  if (!focus.length || !bounds) return null
  const localFocus = focus.filter(point => withinBounds(point.lon, point.lat, bounds, 0.12))
  const relevant = localFocus.length ? localFocus : focus
  const lons = relevant.map(point => point.lon)
  const lats = relevant.map(point => point.lat)
  const routeSpan = Math.max(0.05, Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats))
  // The corridor is based on the route geometry, not the aspect-ratio-expanded
  // display bounds. Country extracts can otherwise turn a north/south route
  // into a wide node vacuum that exhausts memory before ways appear.
  const baseCell = Math.max(0.018, Math.min(0.045, routeSpan / 90))
  // Recovery corridors used to claim 70–220 km while radiusCells was capped at
  // ten; on country extracts that silently collapsed the real retained corridor
  // to only a few dozen kilometres. Grow the spatial cell when a wider recovery
  // corridor is requested so the bounded ten-cell halo actually represents the
  // requested physical width without exploding the cell set.
  const requestedKm = Math.max(0, Number(corridorKm) || 0)
  const cell = requestedKm > 0 ? Math.max(baseCell, Math.min(0.35, requestedKm / (111 * 10))) : baseCell
  // RC58: keep the retained-node corridor tight. RC56 used a 5x5-cell halo
  // around every route sample; on dense Taiwan data that exhausted the node
  // budget before useful way geometry could be completed. A 3x3 halo still
  // captures nearby connecting roads while cutting corridor area substantially.
  const cellKm = cell * 111
  const requestedRadius = Number(corridorKm) > 0 ? Math.ceil(Number(corridorKm) / Math.max(1, cellKm)) : Number(radiusCells)
  const radius = Math.max(1, Math.min(10, Number.isFinite(requestedRadius) ? requestedRadius : 1))
  const cells = new Set()
  const keyFor = (lon, lat) => `${Math.floor((lon - bounds.west) / cell)},${Math.floor((lat - bounds.south) / cell)}`
  const addAround = (lon, lat) => {
    const x = Math.floor((lon - bounds.west) / cell)
    const y = Math.floor((lat - bounds.south) / cell)
    for (let dx = -radius; dx <= radius; dx += 1) for (let dy = -radius; dy <= radius; dy += 1) cells.add(`${x + dx},${y + dy}`)
  }
  // Every canonical occurrence gets local background context even when the next
  // leg is intercontinental. Long positioning/flight legs must NOT create a
  // thousands-of-kilometres terrestrial PBF corridor or demand ocean/intervening
  // extracts. The route overlay still visualizes the full canonical leg.
  for (const point of focus) if (withinBounds(point.lon, point.lat, bounds, 0.12)) addAround(point.lon, point.lat)
  for (let index = 0; index < focus.length - 1; index += 1) {
    const a = focus[index]
    const b = focus[index + 1]
    if (focusLegDistanceKm(a, b) > 1400) continue
    const dLon = wrappedLongitudeDelta(a.lon, b.lon)
    const dLat = b.lat - a.lat
    const distance = Math.max(Math.abs(dLon), Math.abs(dLat))
    const steps = Math.max(1, Math.ceil(distance / Math.max(0.01, cell * 0.55)))
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps
      const lon = ((a.lon + dLon * t + 180) % 360 + 360) % 360 - 180
      addAround(lon, a.lat + dLat * t)
    }
  }
  return { cell, cells, keyFor, pointCount: focus.length, radius, corridorKm: radius * cellKm }
}

function focusAcceptsPoint(lon, lat, bounds, focusIndex) {
  if (!withinBounds(lon, lat, bounds, 0.015)) return false
  if (!focusIndex) return true
  return focusIndex.cells.has(focusIndex.keyFor(lon, lat))
}

function paddedBounds(bounds) {
  const spanLon = Math.max(0.05, bounds.east - bounds.west)
  const spanLat = Math.max(0.05, bounds.north - bounds.south)
  let west = bounds.west - spanLon * 0.08
  let east = bounds.east + spanLon * 0.08
  let south = bounds.south - spanLat * 0.10
  let north = bounds.north + spanLat * 0.10
  const target = 2
  const current = (east - west) / Math.max(0.0001, north - south)
  if (current > target) {
    const desired = (east - west) / target
    const add = (desired - (north - south)) / 2
    south -= add; north += add
  } else {
    const desired = (north - south) * target
    const add = (desired - (east - west)) / 2
    west -= add; east += add
  }
  return { west, east, south, north }
}

export function boundsFromPoints(points = []) {
  const clean = (points || []).filter(point => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon)))
  if (!clean.length) return null
  return paddedBounds({
    west: Math.min(...clean.map(point => Number(point.lon))),
    east: Math.max(...clean.map(point => Number(point.lon))),
    south: Math.min(...clean.map(point => Number(point.lat))),
    north: Math.max(...clean.map(point => Number(point.lat))),
  })
}

export async function readPbfHeaderBounds(filePath) {
  for await (const block of readBlocks(filePath)) {
    if (block.type !== 'OSMHeader') continue
    let bbox = null
    eachField(block.data, (field, wire, value) => {
      if (field !== 1 || wire !== 2) return
      let left = 0; let right = 0; let top = 0; let bottom = 0
      eachField(value, (f, w, v) => {
        if (w !== 0) return
        if (f === 1) left = zigZag(v)
        else if (f === 2) right = zigZag(v)
        else if (f === 3) top = zigZag(v)
        else if (f === 4) bottom = zigZag(v)
      })
      bbox = { west: left * 1e-9, east: right * 1e-9, north: top * 1e-9, south: bottom * 1e-9 }
    })
    if (bbox && bbox.east > bbox.west && bbox.north > bbox.south) return paddedBounds(bbox)
    break
  }
  return null
}

function xmlEscape(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function roadPriority(highway = '') {
  const order = {
    motorway: 0, motorway_link: 1, trunk: 2, trunk_link: 3,
    primary: 4, primary_link: 5, secondary: 6, secondary_link: 7,
    tertiary: 8, tertiary_link: 9, unclassified: 10, road: 11,
    residential: 12, living_street: 13,
  }
  return order[highway] ?? 99
}


function roadDetailMode(sourceSize = 0, budget = MAP_RENDER_LIMITS) {
  const size = Number(sourceSize || 0)
  if (size >= Number(budget.veryLargeExtractRoadDetailThresholdBytes || MAP_RENDER_LIMITS.veryLargeExtractRoadDetailThresholdBytes)) return 'major'
  if (size >= Number(budget.largeExtractRoadDetailThresholdBytes || MAP_RENDER_LIMITS.largeExtractRoadDetailThresholdBytes)) return 'core'
  return 'all'
}

function wayAllowedForRender(way, detail = 'all') {
  if (!way?.highway) return false
  if (detail === 'major') return MAJOR_RENDER_ROAD_CLASSES.has(way.highway)
  if (detail === true || detail === 'core') return CORE_RENDER_ROAD_CLASSES.has(way.highway)
  return ROAD_CLASSES.has(way.highway)
}

// RC53 removed the retired RC52 Bloom/two-pass planner entirely. The normal
// renderer below retains bounded corridor coordinates and consumes ways in one pass.

function segmentNearRoute(coords = [], focusIndex = null) {
  if (!focusIndex) return true
  for (const point of coords) if (focusIndex.cells.has(focusIndex.keyFor(point[0], point[1]))) return true
  for (let index = 0; index < coords.length - 1; index += 1) {
    const a = coords[index]
    const b = coords[index + 1]
    const midLon = (a[0] + b[0]) / 2
    const midLat = (a[1] + b[1]) / 2
    if (focusIndex.cells.has(focusIndex.keyFor(midLon, midLat))) return true
  }
  return false
}

function countRoadVertices(roads = []) {
  return roads.reduce((sum, road) => sum + (Array.isArray(road?.coords) ? road.coords.length : 0), 0)
}

function capLinePoints(coords = [], maxPoints = MAP_RENDER_LIMITS.maxRoadPointsPerSegment) {
  const clean = Array.isArray(coords) ? coords : []
  const max = Math.max(2, Number(maxPoints) || 2)
  if (clean.length <= max) return clean
  const out = []
  for (let index = 0; index < max; index += 1) {
    const sourceIndex = Math.round((index / Math.max(1, max - 1)) * (clean.length - 1))
    const point = clean[sourceIndex]
    if (!out.length || point[0] !== out.at(-1)[0] || point[1] !== out.at(-1)[1]) out.push(point)
  }
  return out.length >= 2 ? out : [clean[0], clean.at(-1)]
}

export function fitRoadsToDisplayBudget(roads = [], { maxRoadSegments = MAP_RENDER_LIMITS.maxRoadSegments, maxRoadVertices = MAP_RENDER_LIMITS.maxRoadVertices } = {}) {
  const maxSegments = Math.max(1, Number(maxRoadSegments) || MAP_RENDER_LIMITS.maxRoadSegments)
  const maxVertices = Math.max(2, Number(maxRoadVertices) || MAP_RENDER_LIMITS.maxRoadVertices)
  const source = (Array.isArray(roads) ? roads : []).map((road, index) => ({ ...road, _index: index }))
  if (source.length <= maxSegments && countRoadVertices(source) <= maxVertices) return source.map(({ _index, ...road }) => road)

  // Preserve higher-class roads first, while keeping deterministic geographic/source order
  // inside each class. This only reduces basemap detail; the canonical itinerary overlay is
  // rendered separately and is never simplified or dropped here.
  source.sort((a, b) => roadPriority(a.highway) - roadPriority(b.highway) || a._index - b._index)
  const kept = []
  let vertices = 0
  for (const road of source) {
    if (kept.length >= maxSegments) break
    const coords = capLinePoints(road.coords)
    if (coords.length < 2) continue
    if (vertices + coords.length > maxVertices) continue
    kept.push({ highway: road.highway, coords, _index: road._index })
    vertices += coords.length
  }
  kept.sort((a, b) => a._index - b._index)
  return kept.map(({ _index, ...road }) => road)
}

function makeSvg(roads, labels, bounds, meta) {
  const width = 1200
  const height = 600
  const x = lon => ((lon - bounds.west) / (bounds.east - bounds.west)) * width
  const y = lat => ((bounds.north - lat) / (bounds.north - bounds.south)) * height
  const maxLabels = Math.max(0, Number(meta.maxLabels || MAP_RENDER_LIMITS.maxLabels))
  const placedLabels = []
  for (const label of labels) {
    if (placedLabels.length >= maxLabels) break
    const px = x(label.lon); const py = y(label.lat)
    const font = label.place === 'city' ? 15 : label.place === 'town' ? 11 : 8
    const minDx = Math.max(72, String(label.name || '').length * font * 0.48)
    const collision = placedLabels.some(item => Math.abs(item.px - px) < Math.max(item.minDx, minDx) && Math.abs(item.py - py) < 22)
    if (!collision) placedLabels.push({ ...label, px, py, font, minDx })
  }
  const layers = new Map()
  for (const road of roads) {
    if (!layers.has(road.highway)) layers.set(road.highway, [])
    const points = road.coords.map(([lon, lat]) => `${x(lon).toFixed(1)},${y(lat).toFixed(1)}`).join(' ')
    layers.get(road.highway).push(`<polyline points="${points}"/>`)
  }
  const roadOrder = ['residential', 'living_street', 'unclassified', 'road', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'trunk', 'trunk_link', 'motorway', 'motorway_link']
  const roadMarkup = roadOrder.map(kind => {
    const items = layers.get(kind)
    if (!items?.length) return ''
    const style = ROAD_STYLE[kind] || ROAD_STYLE.road
    return `<g fill="none" stroke="${style.tone}" stroke-width="${style.weight}" stroke-linecap="round" stroke-linejoin="round" opacity="0.82">${items.join('')}</g>`
  }).join('')
  const labelMarkup = placedLabels.map(label => {
    return `<g transform="translate(${label.px.toFixed(1)} ${label.py.toFixed(1)})"><circle r="2.2" fill="#e9d8b6"/><text x="5" y="-4" fill="#e7eadf" font-family="Segoe UI,Arial,sans-serif" font-size="${label.font}" paint-order="stroke" stroke="#172019" stroke-width="2.4">${xmlEscape(label.name)}</text></g>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="1200" height="600" fill="#1b241c"/>
  <g opacity="0.45"><path d="M0 120H1200M0 240H1200M0 360H1200M0 480H1200M240 0V600M480 0V600M720 0V600M960 0V600" stroke="#344035" stroke-width="0.6"/></g>
  ${roadMarkup}
  ${labelMarkup}
  <text x="14" y="582" fill="#9fac9b" font-family="Segoe UI,Arial,sans-serif" font-size="11">OpenStreetMap / Geofabrik · ${xmlEscape(meta.fileName)} · ${roads.length.toLocaleString()} road ways</text>
</svg>`
}

function fitSvgToByteBudget(roads, labels, bounds, meta, limits) {
  let fitted = fitRoadsToDisplayBudget(roads, limits)
  let svg = makeSvg(fitted, labels, bounds, { ...meta, maxLabels: limits.maxLabels })
  let bytes = Buffer.byteLength(svg, 'utf8')
  let passes = 0
  while (bytes > limits.maxSvgBytes && fitted.length > 250 && passes < 8) {
    const targetSegments = Math.max(250, Math.floor(fitted.length * 0.72))
    const targetVertices = Math.max(2500, Math.floor(countRoadVertices(fitted) * 0.72))
    fitted = fitRoadsToDisplayBudget(fitted, { maxRoadSegments: targetSegments, maxRoadVertices: targetVertices })
    svg = makeSvg(fitted, labels, bounds, { ...meta, maxLabels: limits.maxLabels })
    bytes = Buffer.byteLength(svg, 'utf8')
    passes += 1
  }
  return { svg, roads: fitted, svgBytes: bytes, svgReductionPasses: passes }
}

export async function renderPbfSvg({ filePath, bounds = null, focusPoints = [], routePoints = focusPoints, legModes = [], onProgress = () => {}, limits = MAP_RENDER_LIMITS, routeGraph: externalRouteGraph = null, routeOnly = false, routeCorridorKm = 14 }) {
  const startedAt = Date.now()
  const budget = { ...MAP_RENDER_LIMITS, ...(limits || {}) }
  const stat = await fs.promises.stat(filePath)
  if (!bounds) bounds = await readPbfHeaderBounds(filePath)
  if (!bounds) throw new Error('Could not determine map bounds from this .osm.pbf file.')
  bounds = paddedBounds(bounds)

  // Basemap rendering stays visually tight, but the road-routing graph needs a
  // wider bounded corridor because real roads often bend well away from the
  // straight/canonical leg. Conflating these corridors caused a recurring
  // 'PBF found but no useful route' failure on country-scale extracts.
  const backgroundFocusIndex = buildRouteFocusIndex(focusPoints, bounds, { radiusCells: 1 })
  const routeFocusIndex = buildRouteFocusIndex(focusPoints, bounds, { corridorKm: routeCorridorKm })
  const labels = []
  const roads = []
  const limitationReasons = new Set()
  const routeGraph = externalRouteGraph || new BoundedRoadGraph({
    maxNodes: budget.maxRouteGraphNodes,
    maxEdges: budget.maxRouteGraphEdges,
  })
  const detailMode = roadDetailMode(stat.size, budget)
  if (detailMode === 'core') limitationReasons.add('large extract: local-street detail reduced to major/connecting roads')
  if (detailMode === 'major') limitationReasons.add('very large extract: background detail reduced to principal roads')

  // RC53 SINGLE-PASS ROUTE-CORRIDOR RENDERER.
  // Geofabrik data is node-before-way ordered. Retain only coordinates inside
  // the canonical route corridor, then render matching way segments when their
  // way blocks arrive later in the SAME file pass. RC52 scanned the entire PBF
  // to plan ways and then reread it for node coordinates, which made a normal
  // ~300 MB country extract likely to exhaust its time budget before rendering.
  // RC58: Taiwan proved that a useful route corridor can legitimately exceed
  // RC56's 1.2M-node ceiling. Keep the typed-array index bounded, but size the
  // bound for real country-scale corridors rather than forcing a coarse map.
  const coords = new ChunkedNodeIndex(budget.maxIndexedNodes)
  let indexedNodeAttempts = 0
  let roadCandidates = 0
  let roadVertices = 0
  let candidateWaysSeen = 0
  let matchedRoadNodeRefs = 0
  let blocks = 0
  let bytesProcessed = 0
  let sourceBytes = stat.size
  let timedOut = false
  let sawWays = false
  let nodesAfterWays = false
  const span = Math.max(bounds.east - bounds.west, bounds.north - bounds.south)
  const threshold = span / 4200
  const overTime = () => Date.now() - startedAt > budget.maxPerExtractElapsedMs

  const pointSink = {
    set(id, point) {
      indexedNodeAttempts += 1
      if (!coords.set(id, point) && coords.capacityReached) limitationReasons.add(`route-corridor node safety limit (${budget.maxIndexedNodes.toLocaleString()})`)
    },
  }
  const labelSink = {
    push(label) {
      if (routeOnly) return
      if (labels.length < budget.maxLabels * 4) labels.push(label)
      else limitationReasons.add('place-label safety limit')
    },
  }

  const appendWay = way => {
    const renderAllowed = wayAllowedForRender(way, detailMode)
    if (candidateWaysSeen >= budget.maxPlannedRoadWays) {
      limitationReasons.add(`focused road-candidate safety limit (${budget.maxPlannedRoadWays.toLocaleString()} ways)`)
      return
    }
    let touchesCorridor = false
    for (const ref of way.refs) {
      if (coords.get(ref)) { touchesCorridor = true; break }
    }
    if (!touchesCorridor) return
    candidateWaysSeen += 1
    matchedRoadNodeRefs += way.refs.reduce((count, ref) => count + (coords.get(ref) ? 1 : 0), 0)
    // Build a second, much smaller graph from the same corridor roads. The
    // background SVG and route network share one PBF pass, but their budgets
    // are independent so a dense basemap cannot starve route geometry.
    routeGraph.addWay(way, ref => coords.get(ref))
    if (routeOnly || !renderAllowed) return

    let segment = []
    const flushSegment = () => {
      if (segment.length < 2 || !segmentIntersectsBounds(segment, bounds) || !segmentNearRoute(segment, backgroundFocusIndex)) { segment = []; return }
      roadCandidates += 1
      const simplified = capLinePoints(simplifyLine(segment, threshold), budget.maxRoadPointsPerSegment)
      segment = []
      if (simplified.length < 2) return
      if (roads.length >= budget.maxRoadSegments) {
        limitationReasons.add(`road-segment safety limit (${budget.maxRoadSegments.toLocaleString()})`)
        return
      }
      if (roadVertices + simplified.length > budget.maxRoadVertices) {
        limitationReasons.add(`road-vertex safety limit (${budget.maxRoadVertices.toLocaleString()})`)
        return
      }
      roads.push({ highway: way.highway, coords: simplified })
      roadVertices += simplified.length
    }
    for (const ref of way.refs) {
      const point = coords.get(ref)
      if (point) segment.push(point)
      else flushSegment()
    }
    flushSegment()
  }

  onProgress({ phase: 'scan', percent: 1, message: 'Reading the downloaded map once around the canonical route…' })
  for await (const block of readBlocks(filePath, (position, size) => {
    bytesProcessed = position
    sourceBytes = size || stat.size
    if (++blocks % 5 === 0) {
      const percent = Math.min(96, 2 + (position / Math.max(1, size)) * 94)
      const phase = sawWays ? 'roads' : 'nodes'
      onProgress({
        phase,
        percent,
        message: routeOnly
          ? `Expanding the bounded offline route graph · ${routeGraph.stats().routeGraphNodes.toLocaleString()} road nodes…`
          : sawWays
            ? `Drawing route-corridor roads · ${roads.length.toLocaleString()} retained · ${coords.size.toLocaleString()} nearby nodes…`
            : `Indexing only the route corridor · ${coords.size.toLocaleString()} nearby nodes…`,
        stats: {
          indexedNodeCount: coords.size,
          indexedNodeAttempts,
          roadCandidates,
          roadCount: roads.length,
          roadVertexCount: roadVertices,
          plannedRoadWays: candidateWaysSeen,
          focusSeedNodeCount: coords.size,
          bytesProcessed: position,
          sourceBytes: size,
          elapsedMs: Date.now() - startedAt,
          passes: 1,
        },
      })
    }
  })) {
    if (overTime()) { timedOut = true; break }
    if (block.type !== 'OSMData') continue
    parsePrimitiveBlock(block.data, (group, context) => {
      const kinds = primitiveGroupKinds(group)
      if (kinds.hasNodes) {
        if (sawWays) nodesAfterWays = true
        parseGroupNodes(group, context, (lon, lat) => focusAcceptsPoint(lon, lat, bounds, routeFocusIndex), pointSink, labelSink, bounds)
      }
      if (kinds.hasWays) {
        sawWays = true
        parseGroupWays(group, context, appendWay)
      }
    })
  }

  if (nodesAfterWays) limitationReasons.add('nonstandard PBF node/way ordering reduced route geometry')
  if (coords.capacityReached) limitationReasons.add('route-corridor node index reached its bounded capacity')
  if (!coords.monotonic) {
    limitationReasons.add('PBF node order is not monotonic enough for the bounded route index')
    return {
      safeToDisplay: false, limited: true, limitationReasons: [...limitationReasons], bounds,
      roadCount: 0, labelCount: labels.length, sourceSize: stat.size,
      indexedNodeCount: coords.size, indexedNodeAttempts, roadCandidates,
      roadVertexCount: 0, plannedRoadWays: candidateWaysSeen, requiredNodeRefs: matchedRoadNodeRefs, focusSeedNodeCount: coords.size, focused: Boolean(routeFocusIndex),
      bytesProcessed, sourceBytes, elapsedMs: Date.now() - startedAt, passes: 1, scanComplete: !timedOut, detailMode,
    }
  }

  if (timedOut) {
    limitationReasons.add(`single-pass time safety limit (${Math.round(budget.maxPerExtractElapsedMs / 1000)}s)`)
    // A time limit reached after useful corridor roads exist is a REDUCED map,
    // not an automatic coarse fallback. This is deliberate degradation: the
    // canonical route overlay remains complete and the PBF still adds factual
    // geographic context. Only a scan that never reached usable road geometry
    // fails closed to the coarse map.
    if (!roads.length) {
      return {
        safeToDisplay: false, limited: true, limitationReasons: [...limitationReasons], bounds,
        roadCount: 0, labelCount: labels.length, sourceSize: stat.size,
        indexedNodeCount: coords.size, indexedNodeAttempts, roadCandidates,
        roadVertexCount: 0, plannedRoadWays: candidateWaysSeen, requiredNodeRefs: matchedRoadNodeRefs, focusSeedNodeCount: coords.size,
        bytesProcessed, sourceBytes, elapsedMs: Date.now() - startedAt, passes: 1, scanComplete: false, detailMode,
      }
    }
  }

  const focusLegs = routeFocusLegs(routePoints, 1400, legModes)
  const routeSegments = []
  let routedLegCount = 0
  let terrestrialLegCount = 0
  for (const leg of focusLegs) {
    if (leg.modeUnconfirmed) {
      routeSegments.push({ index: leg.index, status: 'mode-unconfirmed', mode: leg.mode, distanceKm: leg.distanceKm, geometry: [] })
      continue
    }
    if (leg.nonTerrestrial) {
      routeSegments.push({ index: leg.index, status: 'non-terrestrial', mode: leg.mode, distanceKm: leg.distanceKm, geometry: [] })
      continue
    }
    if (!leg.terrestrialCandidate) {
      routeSegments.push({ index: leg.index, status: 'distance-unrouted', mode: leg.mode, distanceKm: leg.distanceKm, geometry: [] })
      continue
    }
    // Route a leg in this extract only when both endpoints are reasonably
    // covered by it. In a multi-extract trip another worker result may route
    // the same canonical leg; the parent merges the best successful segment.
    const fromInside = withinBounds(Number(leg.from.lon), Number(leg.from.lat), bounds, 0.12)
    const toInside = withinBounds(Number(leg.to.lon), Number(leg.to.lat), bounds, 0.12)
    if (!fromInside || !toInside) {
      routeSegments.push({ index: leg.index, status: 'outside-extract', distanceKm: leg.distanceKm, geometry: [] })
      continue
    }
    terrestrialLegCount += 1
    const routed = routeGraph.route(leg.from, leg.to, {
      maxSnapKm: budget.maxRouteSnapKm,
      maxVisited: budget.maxRouteSearchVisited,
      mode: leg.mode,
    })
    if (routed.ok && routed.geometry.length >= 2) {
      routedLegCount += 1
      routeSegments.push({
        index: leg.index, status: 'routed', mode: leg.mode, distanceKm: routed.distanceKm,
        startSnapKm: routed.startSnapKm, endSnapKm: routed.endSnapKm, visited: routed.visited,
        geometry: capRouteGeometry(routed.geometry, budget.maxRouteGeometryPoints),
      })
    } else {
      routeSegments.push({
        index: leg.index, status: routed.reason || 'unrouted', mode: leg.mode, distanceKm: leg.distanceKm,
        startSnapKm: routed.startSnapKm, endSnapKm: routed.endSnapKm, visited: routed.visited || 0, geometry: [],
      })
    }
  }
  if (routeGraph.capacityReached) limitationReasons.add('offline route-network graph reached its bounded capacity')
  if (terrestrialLegCount > 0 && routedLegCount < terrestrialLegCount) limitationReasons.add(`offline mode-specific routing incomplete (${routedLegCount}/${terrestrialLegCount} in this extract)`)
  const routeGraphStats = routeGraph.stats()

  if (routeOnly) {
    return {
      safeToDisplay: true, limited: limitationReasons.size > 0, degraded: limitationReasons.size > 0,
      limitationReasons: [...limitationReasons], bounds, roadCount: 0, labelCount: 0, sourceSize: stat.size,
      indexedNodeCount: coords.size, indexedNodeAttempts, roadCandidates: 0, roadVertexCount: 0,
      plannedRoadWays: candidateWaysSeen, requiredNodeRefs: matchedRoadNodeRefs, focusSeedNodeCount: coords.size,
      focused: Boolean(routeFocusIndex), bytesProcessed, sourceBytes, elapsedMs: Date.now() - startedAt,
      passes: 1, scanComplete: !timedOut, detailMode, routeOnly: true,
      routeSegments, routedLegCount, terrestrialLegCount, ...routeGraphStats,
    }
  }

  if (!roads.length && !labels.length) {
    limitationReasons.add('downloaded extract contained no renderable road or place geometry for the focused view')
    return {
      safeToDisplay: false, limited: true, limitationReasons: [...limitationReasons], bounds,
      roadCount: 0, labelCount: 0, sourceSize: stat.size,
      indexedNodeCount: coords.size, indexedNodeAttempts, roadCandidates,
      roadVertexCount: 0, plannedRoadWays: candidateWaysSeen, requiredNodeRefs: matchedRoadNodeRefs, focusSeedNodeCount: coords.size, focused: Boolean(routeFocusIndex),
      bytesProcessed, sourceBytes, elapsedMs: Date.now() - startedAt, passes: 1, scanComplete: !timedOut, detailMode,
    }
  }
  if (!roads.length && labels.length) limitationReasons.add('place-label-only extract: no road ways present in focused view')

  onProgress({ phase: 'render', percent: 98, message: 'Drawing the route-focused offline map…' })
  const labelRank = { city: 0, town: 1, village: 2 }
  labels.sort((a, b) => (labelRank[a.place] ?? 9) - (labelRank[b.place] ?? 9) || a.name.localeCompare(b.name))
  const fitted = fitSvgToByteBudget(roads, labels, bounds, { fileName: path.basename(filePath), size: stat.size }, budget)
  if (fitted.svgBytes > budget.maxSvgBytes) {
    limitationReasons.add(`SVG display safety limit (${(budget.maxSvgBytes / 1024 / 1024).toFixed(1)} MB)`)
    return {
      safeToDisplay: false, limited: true, limitationReasons: [...limitationReasons], bounds,
      roadCount: fitted.roads.length, labelCount: Math.min(labels.length, budget.maxLabels), sourceSize: stat.size,
      indexedNodeCount: coords.size, indexedNodeAttempts, roadCandidates,
      roadVertexCount: countRoadVertices(fitted.roads), plannedRoadWays: candidateWaysSeen,
      requiredNodeRefs: matchedRoadNodeRefs, focusSeedNodeCount: coords.size, focused: Boolean(routeFocusIndex), svgBytes: fitted.svgBytes,
      bytesProcessed, sourceBytes, elapsedMs: Date.now() - startedAt, passes: 1, scanComplete: !timedOut, detailMode,
    }
  }
  if (fitted.svgReductionPasses > 0 || fitted.roads.length < roads.length) limitationReasons.add('SVG/geometry display budget')
  const degraded = limitationReasons.size > 0
  onProgress({ phase: 'done', percent: 100, message: degraded ? 'Downloaded OpenStreetMap rendered with reduced background detail for stability.' : 'Downloaded OpenStreetMap rendered.' })
  return {
    svg: fitted.svg, safeToDisplay: true, limited: degraded, degraded,
    limitationReasons: [...limitationReasons], bounds,
    roadCount: fitted.roads.length, labelCount: Math.min(labels.length, budget.maxLabels), sourceSize: stat.size,
    indexedNodeCount: coords.size, indexedNodeAttempts, roadCandidates,
    roadVertexCount: countRoadVertices(fitted.roads), plannedRoadWays: candidateWaysSeen,
    requiredNodeRefs: matchedRoadNodeRefs, focusSeedNodeCount: coords.size, focused: Boolean(routeFocusIndex), svgBytes: fitted.svgBytes,
    svgReductionPasses: fitted.svgReductionPasses,
    bytesProcessed, sourceBytes, elapsedMs: Date.now() - startedAt, passes: 1,
    scanComplete: !timedOut, detailMode,
    routeSegments, routedLegCount, terrestrialLegCount, ...routeGraphStats,
  }
}

