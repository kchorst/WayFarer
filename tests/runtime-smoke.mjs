import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..')
const children=[]
const runtimeDir=fs.mkdtempSync(join(os.tmpdir(),'wf-runtime-smoke-'))
function child(args,env={}){const p=spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});children.push(p);return p}
async function wait(url){for(let i=0;i<80;i++){try{const r=await fetch(url);if(r.ok)return r}catch{}await new Promise(r=>setTimeout(r,50))}throw new Error(`timeout ${url}`)}
try{
  child(['tests/mock-stack.mjs'])
  child(['server.mjs'],{WAYFINDER_PORT:'18101',WAYFINDER_RUNTIME_DIR:runtimeDir,WAYFINDER_AI_ENDPOINT:'http://127.0.0.1:18080',WAYFINDER_AI_MODEL:'mock-wayfinder',WAYFINDER_GAZETTEER_ENDPOINT:'http://127.0.0.1:18080/geocode',WAYFINDER_ALLOW_WEB_GEOCODE:'0',WAYFINDER_MAPQUEST_KEY:'dummy',WAYFINDER_MAPQUEST_ROUTE_ENDPOINT:'http://127.0.0.1:18080/directions/v2/route',WAYFINDER_PBF_ROOT:resolve(here,'pbf'),WAYFINDER_REFERENCE_ENDPOINT:'http://127.0.0.1:18080'})
  const base='http://127.0.0.1:18101';const status=await (await wait(base+'/api/status')).json();assert.equal(status.ai.available,true);assert.equal(status.offlinePbf.available,true);assert.equal(status.mapquest.configured,true);assert.equal(status.references.available,true);assert.equal(status.references.wikivoyage,true)
  const geo=await (await fetch(base+'/api/geocode?q=Genoa')).json();assert.equal(geo.results[0].label.toLowerCase().includes('genoa'),true)
  const refs=await (await fetch(base+'/api/references/search?q=Genoa&category=wikivoyage&limit=1')).json();assert.equal(refs.results.length,1);assert.match(refs.results[0].excerpt,/local travel reference/i)
  const tile=await fetch(base+'/api/offline/tile/0/0/0.pbf');assert.equal(tile.ok,true);assert.ok((await tile.arrayBuffer()).byteLength>0)
  const occurrences=[{occurrenceId:'a',resolution:{lat:44.4,lon:8.9}},{occurrenceId:'b',resolution:{lat:41.9,lon:12.5}}],legs=[{id:'leg_a__b',index:0,fromOccurrenceId:'a',toOccurrenceId:'b',mode:'Car',modeConfirmed:true}]
  const mq=await fetch(base+'/api/mapquest/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tripId:'t',authorityVersion:7,snapshotKey:'snap',occurrences,legs,transport:{primaryMode:'Car',confirmed:true,scoped:[],pendingLegReviews:[],reconfirmationRequiredLegIds:[]}})});assert.equal(mq.ok,true);const m=await mq.json();assert.deepEqual(m.occurrenceIds,['a','b']);assert.equal(m.authorityVersion,7);assert.ok(m.geometry.length>=2)
  const unsupported=await fetch(base+'/api/mapquest/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tripId:'t',authorityVersion:7,snapshotKey:'snap',occurrences,legs,transport:{primaryMode:'Bus',confirmed:true,scoped:[],pendingLegReviews:[],reconfirmationRequiredLegIds:[]}})});assert.equal(unsupported.status,422)
  console.log(JSON.stringify({ok:true,ai:status.ai.model,geocode:geo.source,pbf:status.offlinePbf.zooms,mapquestPoints:m.geometry.length,references:refs.results.length}))
}finally{for(const p of children)p.kill('SIGTERM');fs.rmSync(runtimeDir,{recursive:true,force:true})}
