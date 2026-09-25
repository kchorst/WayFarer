import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here=path.dirname(fileURLToPath(import.meta.url))
const source=fs.readFileSync(path.join(here,'..','server_maps','raw-pbf-runtime.mjs'),'utf8')

test('offline map catalog never falls back to a synchronous recursive scan on the app thread',()=>{
  assert.match(source,/new Worker\(new URL\('\.\/map-catalog-worker\.mjs'/)
  assert.doesNotMatch(source,/\.catch\(\(\)=>scanPbfCatalog/)
  assert.match(source,/Never fall back to a synchronous/)
})
