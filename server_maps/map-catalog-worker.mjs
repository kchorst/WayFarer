import { parentPort, workerData } from 'node:worker_threads'
import { scanPbfCatalog } from './map-catalog.mjs'

try {
  const result = scanPbfCatalog(workerData?.root || '', workerData?.options || {})
  parentPort?.postMessage({ ok: true, result })
} catch (error) {
  parentPort?.postMessage({ ok: false, error: String(error?.stack || error?.message || error) })
}
