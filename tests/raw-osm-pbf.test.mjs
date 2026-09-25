import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { rawPbfStatus, startRawPbfRender, getRawPbfJob, cancelRawPbfJob, clearRawPbfCaches, shutdownRawPbfRuntime } from '../server_maps/raw-pbf-runtime.mjs'

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
function tinyPbf(){
  const strings=['','highway','primary','place','city','name','Kingston']
  const dense=Buffer.concat([fieldBytes(1,packed([1,1,1],true)),fieldBytes(8,packed([180000000,5000,5000],true)),fieldBytes(9,packed([-768000000,5000,5000],true)),fieldBytes(10,packed([3,4,5,6,0,0,0]))])
  const way=Buffer.concat([fieldVarint(1,10),fieldBytes(2,packed([1])),fieldBytes(3,packed([2])),fieldBytes(8,packed([1,1,1],true))])
  const primitiveGroup=Buffer.concat([fieldBytes(2,dense),fieldBytes(3,way)]),primitiveBlock=Buffer.concat([fieldBytes(1,stringTable(strings)),fieldBytes(2,primitiveGroup)])
  const bbox=Buffer.concat([fieldSint(1,-77000000000),fieldSint(2,-76000000000),fieldSint(3,19000000000),fieldSint(4,17000000000)])
  return Buffer.concat([block('OSMHeader',fieldBytes(1,bbox)),block('OSMData',primitiveBlock)])
}

function namedPbf({bounds,lat,lon,name}){
  const strings=['','place','city','name',name],dense=Buffer.concat([fieldBytes(1,packed([1],true)),fieldBytes(8,packed([Math.round(lat*1e7)],true)),fieldBytes(9,packed([Math.round(lon*1e7)],true)),fieldBytes(10,packed([1,2,3,4,0]))]),group=fieldBytes(2,dense),primitive=Buffer.concat([fieldBytes(1,stringTable(strings)),fieldBytes(2,group)]),bbox=Buffer.concat([fieldSint(1,Math.round(bounds.west*1e9)),fieldSint(2,Math.round(bounds.east*1e9)),fieldSint(3,Math.round(bounds.north*1e9)),fieldSint(4,Math.round(bounds.south*1e9))])
  return Buffer.concat([block('OSMHeader',fieldBytes(1,bbox)),block('OSMData',primitive)])
}
async function waitJob(id,ms=8000){const start=Date.now();while(Date.now()-start<ms){const job=getRawPbfJob(id);if(['ready','failed','limited','cancelled'].includes(job?.state))return job;await new Promise(r=>setTimeout(r,50))}throw new Error('raw PBF test job timed out')}

test('existing Geofabrik-style .osm.pbf folder is cataloged and rendered without XYZ tiles',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wayfinder-raw-pbf-')),file=path.join(dir,'jamaica-latest.osm.pbf')
  fs.writeFileSync(file,tinyPbf());clearRawPbfCaches()
  try{
    const points=[{lat:18,lon:-76.8},{lat:18.001,lon:-76.799}]
    const status=await rawPbfStatus(dir,{points})
    assert.equal(status.kind,'raw-osm-pbf-library')
    assert.equal(status.available,true)
    assert.equal(status.renderReady,true)
    assert.equal(status.catalogCount,1)
    assert.equal(status.selectedFiles.length,1)
    assert.equal(status.selectedFiles[0].fileName,'jamaica-latest.osm.pbf')
    const started=await startRawPbfRender(dir,{points,legModes:['Car']})
    const job=await waitJob(started.id)
    assert.equal(job.state,'ready',job.error||job.message)
    assert.match(job.svg,/OpenStreetMap \/ Geofabrik/)
    assert.ok(Array.isArray(job.routeSegments))
    const cached=await startRawPbfRender(dir,{points,legModes:['Car']})
    assert.equal(cached.state,'ready');assert.equal(cached.phase,'cache');assert.match(cached.message,/cache/i)
  }finally{for(const name of fs.existsSync(dir)?fs.readdirSync(dir):[]){};fs.rmSync(dir,{recursive:true,force:true})}
})

test('missing raw PBF route coverage is explicit rather than silently falling back',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wayfinder-raw-pbf-gap-')),file=path.join(dir,'jamaica-latest.osm.pbf')
  fs.writeFileSync(file,tinyPbf());clearRawPbfCaches()
  try{const status=await rawPbfStatus(dir,{points:[{lat:59.437,lon:24.7536},{lat:56.9496,lon:24.1052}]});assert.equal(status.available,true);assert.equal(status.renderReady,false);assert.ok(status.uncoveredPointIndexes.length>0);assert.match(status.message,/does not include every resolved route stop/i)}finally{fs.rmSync(dir,{recursive:true,force:true})}
})


test('multi-country raw .osm.pbf library selects every extract needed by one canonical route',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wayfinder-baltic-pbf-'));clearRawPbfCaches()
  const defs=[['estonia-latest.osm.pbf',{west:23,east:28.3,south:57.3,north:60},59.437,24.7536,'Tallinn'],['latvia-latest.osm.pbf',{west:20.8,east:28.3,south:55.6,north:58.2},56.9496,24.1052,'Riga'],['lithuania-latest.osm.pbf',{west:20.8,east:26.9,south:53.8,north:56.5},54.6872,25.2797,'Vilnius']]
  for(const[name,bounds,lat,lon,city]of defs)fs.writeFileSync(path.join(dir,name),namedPbf({bounds,lat,lon,name:city}))
  try{const points=[{lat:59.437,lon:24.7536},{lat:56.9496,lon:24.1052},{lat:54.6872,lon:25.2797},{lat:56.9496,lon:24.1052}],status=await rawPbfStatus(dir,{points});assert.equal(status.renderReady,true);assert.deepEqual(status.selectedFiles.map(x=>x.fileName).sort(),defs.map(x=>x[0]).sort())}finally{fs.rmSync(dir,{recursive:true,force:true})}
})


test('runtime shutdown terminates active raw-PBF work and releases its source folder',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wayfinder-pbf-shutdown-')),file=path.join(dir,'jamaica-live.osm.pbf')
  fs.writeFileSync(file,tinyPbf());clearRawPbfCaches()
  const points=[{lat:18,lon:-76.8},{lat:18.0017,lon:-76.7984}]
  const started=await startRawPbfRender(dir,{points,legModes:['Car']})
  await shutdownRawPbfRuntime()
  assert.equal(getRawPbfJob(started.id),null)
  const renamed=`${dir}-renamed`
  fs.renameSync(dir,renamed)
  fs.rmSync(renamed,{recursive:true,force:false})
  assert.equal(fs.existsSync(renamed),false)
})
