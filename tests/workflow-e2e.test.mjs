import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { generateSpark, compileRevision, streamDocument } from '../public/core/ai.js'
import { authorityFromProposal, applyCommands, applyCommand, routeLabels } from '../public/core/authority.js'
import { resolveAuthority } from '../public/core/resolution.js'
import { buildMapModel, googleMapsUrls } from '../public/core/mapModel.js'
import { gatherTripReferences } from '../public/core/references.js'

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..')
function spawnNode(args,env={}){return spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:['ignore','ignore','ignore']})}
async function wait(url){for(let i=0;i<100;i++){try{const r=await fetch(url);if(r.ok)return r}catch{}await new Promise(r=>setTimeout(r,40))}throw new Error(`timeout ${url}`)}
async function waitRuntime(base){for(let i=0;i<80;i++){try{const r=await fetch(`${base}/api/status`),d=await r.json();if(r.ok&&d.ai?.available&&d.references?.available)return d}catch{}await new Promise(r=>setTimeout(r,75))}throw new Error('runtime services did not become ready')}

function varint(number){let value=BigInt(number),out=[];do{let byte=Number(value&0x7fn);value>>=7n;if(value)byte|=0x80;out.push(byte)}while(value);return Buffer.from(out)}
function zigzag(number){const value=BigInt(number);return(value<<1n)^(value>>63n)}
function tag(field,wire){return varint((field<<3)|wire)}
function fieldVarint(field,value){return Buffer.concat([tag(field,0),varint(value)])}
function fieldSint(field,value){return Buffer.concat([tag(field,0),varint(zigzag(value))])}
function fieldBytes(field,value){return Buffer.concat([tag(field,2),varint(value.length),value])}
function packed(values,signed=false){return Buffer.concat(values.map(value=>varint(signed?zigzag(value):value)))}
function stringTable(values){return Buffer.concat(values.map(value=>fieldBytes(1,Buffer.from(value))))}
function blob(raw){return fieldBytes(3,zlib.deflateSync(raw))}
function block(type,raw){const body=blob(raw),header=Buffer.concat([fieldBytes(1,Buffer.from(type)),fieldVarint(3,body.length)]),length=Buffer.alloc(4);length.writeUInt32BE(header.length);return Buffer.concat([length,header,body])}
function italyPbf(){
  const strings=['','highway','primary','place','city','name','Rome'],dense=Buffer.concat([fieldBytes(1,packed([1,1,1],true)),fieldBytes(8,packed([419028000,1000,1000],true)),fieldBytes(9,packed([124964000,1000,1000],true)),fieldBytes(10,packed([3,4,5,6,0,0,0]))]),way=Buffer.concat([fieldVarint(1,10),fieldBytes(2,packed([1])),fieldBytes(3,packed([2])),fieldBytes(8,packed([1,1,1],true))]),group=Buffer.concat([fieldBytes(2,dense),fieldBytes(3,way)]),primitive=Buffer.concat([fieldBytes(1,stringTable(strings)),fieldBytes(2,group)]),bbox=Buffer.concat([fieldSint(1,6000000000),fieldSint(2,19000000000),fieldSint(3,48000000000),fieldSint(4,35000000000)])
  return Buffer.concat([block('OSMHeader',fieldBytes(1,bbox)),block('OSMData',primitive)])
}
async function waitOfflineJob(base,id){for(let i=0;i<120;i++){const r=await fetch(`${base}/api/offline/job/${encodeURIComponent(id)}`),d=await r.json();if(['ready','failed','limited','cancelled'].includes(d.job?.state))return d.job;await new Promise(r=>setTimeout(r,50))}throw new Error('offline render job timeout')}

test('full traveler workflow preserves authority through revision, mapping, PBF, references, and document',{timeout:20000},async()=>{
  const mockPort='18280',appPort='18281',children=[],mapDir=fs.mkdtempSync(join(os.tmpdir(),'wayfinder-workflow-osm-pbf-'))
  fs.writeFileSync(join(mapDir,'italy-latest.osm.pbf'),italyPbf())
  children.push(spawnNode(['tests/mock-stack.mjs'],{MOCK_PORT:mockPort}))
  children.push(spawnNode(['server.mjs'],{
    WAYFINDER_PORT:appPort,WAYFINDER_RUNTIME_DIR:join(mapDir,'runtime'),WAYFINDER_AI_ENDPOINT:`http://127.0.0.1:${mockPort}`,WAYFINDER_AI_MODEL:'mock-wayfinder',
    WAYFINDER_GAZETTEER_ENDPOINT:`http://127.0.0.1:${mockPort}/geocode`,WAYFINDER_ALLOW_WEB_GEOCODE:'0',
    WAYFINDER_REFERENCE_ENDPOINT:`http://127.0.0.1:${mockPort}`,WAYFINDER_MAPQUEST_KEY:'dummy',
    WAYFINDER_MAPQUEST_ROUTE_ENDPOINT:`http://127.0.0.1:${mockPort}/directions/v2/route`,WAYFINDER_PBF_ROOT:mapDir
  }))
  const nativeFetch=globalThis.fetch,base=`http://127.0.0.1:${appPort}`
  try{
    const runtime=await waitRuntime(base);assert.equal(runtime.ai.available,true);assert.equal(runtime.references.available,true)
    globalThis.fetch=(input,init)=>nativeFetch(typeof input==='string'&&input.startsWith('/')?base+input:input,init)

    const spark=await generateSpark('I have one month around Italy starting and ending in Genoa. Include Bologna and Sicily. I prefer buses.')
    assert.equal(spark.proposals.length,3)
    assert.equal(spark.constraints.start,'Genoa');assert.equal(spark.constraints.end,'Genoa');assert.equal(spark.constraints.transport.primaryMode,'Bus')
    assert.ok(spark.constraints.scopes.some(s=>s.label==='Sicily'))
    assert.ok(spark.proposals.every(p=>p.stops[0]==='Genoa'&&p.stops.at(-1)==='Genoa'&&p.stops.includes('Bologna')))

    let authority=authorityFromProposal({brief:'I have one month around Italy starting and ending in Genoa. Include Bologna and Sicily. I prefer buses.',constraints:spark.constraints,proposal:spark.proposals[0]})
    const baseline=['Genoa','Bologna','Florence','Rome','Naples','Palermo','Catania','Genoa']
    assert.deepEqual(routeLabels(authority),baseline)

    const revision=await compileRevision(authority,'Add Turin before the final return to Genoa. Keep everything else.')
    const applied=applyCommands(authority,revision.commands,{baseVersion:revision.baseVersion,tripId:revision.tripId});assert.equal(applied.ok,true);authority=applied.authority
    const expected=['Genoa','Bologna','Florence','Rome','Naples','Palermo','Catania','Turin','Genoa']
    assert.deepEqual(routeLabels(authority),expected);assert.equal(authority.duration.days,30);assert.equal(authority.transport.primaryMode,'Bus');assert.equal(authority.transport.confirmed,false)

    const resolved=await resolveAuthority(authority);assert.equal(resolved.findings.filter(f=>f.severity==='blocker').length,0)
    const model=buildMapModel(authority,resolved.resolutions);assert.equal(model.allCoordinatesResolved,true);assert.deepEqual(model.occurrences.map(o=>o.label),expected);assert.equal(model.legs.length,expected.length-1)
    const google=googleMapsUrls(model);assert.deepEqual(google,[])

    const busRoute=await nativeFetch(`${base}/api/mapquest/route`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(model)});assert.equal(busRoute.status,422)

    assert.equal(runtime.offlinePbf.kind,'raw-osm-pbf-library');assert.equal(runtime.offlinePbf.available,true)
    const mapPoints=model.occurrences.map(o=>({lat:o.resolution.lat,lon:o.resolution.lon,occurrenceId:o.occurrenceId,label:o.label}))
    const pbfStatus=await nativeFetch(`${base}/api/offline/status`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({points:mapPoints})});assert.equal(pbfStatus.ok,true);const pbfCoverage=await pbfStatus.json();assert.equal(pbfCoverage.renderReady,true);assert.equal(pbfCoverage.selectedFiles.length,1)
    const renderStart=await nativeFetch(`${base}/api/offline/render`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({points:mapPoints,legModes:model.legs.map(x=>x.modeConfirmed?x.mode:'Any')})});assert.equal(renderStart.status,202);const renderBody=await renderStart.json(),pbf=await waitOfflineJob(base,renderBody.job.id);assert.equal(pbf.state,'ready',pbf.error||pbf.message);assert.match(pbf.svg,/OpenStreetMap \/ Geofabrik/)
    const refs=await gatherTripReferences(authority,{maxStops:4});assert.ok(refs.length>=1);assert.match(refs[0].excerpt,/local travel reference/i)
    const doc=await streamDocument(authority,model,{references:refs});assert.equal(doc.partial,false);assert.match(doc.text,/ROUTE AT A GLANCE/i)

    authority=applyCommand(authority,{type:'SET_TRANSPORT',payload:{mode:'Car',confirmed:true}})
    const carModel=buildMapModel(authority,resolved.resolutions)
    const googleCar=googleMapsUrls(carModel);assert.ok(googleCar.length>=2);assert.equal(googleCar[0].fromOccurrenceId,carModel.occurrences[0].occurrenceId);assert.equal(googleCar.at(-1).toOccurrenceId,carModel.occurrences.at(-1).occurrenceId)
    const carRoute=await nativeFetch(`${base}/api/mapquest/route`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(carModel)});assert.equal(carRoute.ok,true);const routed=await carRoute.json();assert.deepEqual(routed.occurrenceIds,carModel.occurrences.map(o=>o.occurrenceId));assert.equal(routed.authorityVersion,authority.version)
  } finally {
    globalThis.fetch=nativeFetch
    for(const p of children)p.kill('SIGTERM')
    fs.rmSync(mapDir,{recursive:true,force:true})
  }
})
