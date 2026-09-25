import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { normalizeMapPath } from './map-catalog.mjs'

export const DEFAULT_MAP_ROOT = process.platform === 'win32'
  ? 'C:\\OpenStreetMap\\Geofabrik'
  : path.join(os.homedir(), 'OpenStreetMap', 'Geofabrik')

let windowsKnownMapRootsCache = null

export function windowsKnownMapRoots() {
  if (process.platform !== 'win32') return []
  if (windowsKnownMapRootsCache) return windowsKnownMapRootsCache
  const roots = []
  const push = value => {
    const normalized = normalizeMapPath(value)
    if (normalized && !roots.some(item => item.toLowerCase() === normalized.toLowerCase())) roots.push(normalized)
  }
  for (const value of [process.env.USERPROFILE, process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]) {
    if (!value) continue
    push(path.join(value, 'Downloads'))
    push(path.join(value, 'Documents'))
    push(path.join(value, 'Desktop'))
    push(path.join(value, 'OpenStreetMap'))
  }
  try {
    const ps = `$p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'; $v=Get-ItemProperty -Path $p -ErrorAction Stop; @($v.'{374DE290-123F-4565-9164-39C4925E467B}',$v.Personal,$v.Desktop) | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) }`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
    if (result.status === 0) String(result.stdout || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).forEach(push)
  } catch {}
  windowsKnownMapRootsCache = roots
  return roots
}

export function mapFallbackRoots(settings = {}) {
  const roots = []
  const configuredRoot = normalizeMapPath(settings.root || DEFAULT_MAP_ROOT)
  const push = value => {
    const normalized = normalizeMapPath(value)
    if (!normalized || normalized === configuredRoot || roots.some(item => item.toLowerCase() === normalized.toLowerCase())) return
    roots.push(normalized)
  }
  const rootParent = configuredRoot ? path.dirname(configuredRoot) : ''
  const rootBase = path.basename(configuredRoot || '').toLowerCase()
  if (['geofabrik', 'openstreetmap', 'osm', 'maps'].includes(rootBase) && rootParent && rootParent !== configuredRoot) push(rootParent)
  push(DEFAULT_MAP_ROOT)
  push(path.dirname(DEFAULT_MAP_ROOT))
  push(path.join(os.homedir(), 'OpenStreetMap'))
  push(path.join(os.homedir(), 'OpenStreetMap', 'Geofabrik'))
  push(path.join(os.homedir(), 'Downloads'))
  push(path.join(os.homedir(), 'Documents', 'OpenStreetMap'))
  push(path.join(os.homedir(), 'Desktop', 'OpenStreetMap'))
  for (const known of windowsKnownMapRoots()) push(known)
  return roots
}
