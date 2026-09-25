import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeMvt, choosePbfZoom, deriveOfflineRouteSegments } from '../public/core/mvt.js'

const enc=new TextEncoder()
function vi(n){const out=[];let x=n>>>0;do{let b=x&0x7f;x>>>=7;if(x)b|=0x80;out.push(b)}while(x);return Uint8Array.from(out)}
function fldVar(field,n){return Uint8Array.from([...vi((field<<3)|0),...vi(n)])}
function fldBytes(field,b){return Uint8Array.from([...vi((field<<3)|2),...vi(b.length),...b])}
function cat(...parts){const n=parts.reduce((s,p)=>s+p.length,0),o=new Uint8Array(n);let at=0;for(const p of parts){o.set(p,at);at+=p.length}return o}
function zz(n){return n<0?(-n*2-1):(n*2)}
function syntheticTile(){
  // Feature type LINESTRING, geometry MoveTo(1000,1000), LineTo(+1000,+500)
  const geom=cat(vi((1<<3)|1),vi(zz(1000)),vi(zz(1000)),vi((1<<3)|2),vi(zz(1000)),vi(zz(500)))
  const feature=cat(fldVar(3,2),fldBytes(4,geom))
  const layer=cat(fldBytes(1,enc.encode('road')),fldBytes(2,feature),fldVar(5,4096),fldVar(15,2))
  return fldBytes(3,layer).buffer
}

test('minimal MVT decoder produces local vector line geometry',()=>{
  const f=decodeMvt(syntheticTile(),0,0,0)
  assert.equal(f.length,1);assert.equal(f[0].layer,'road');assert.equal(f[0].type,'line');assert.equal(f[0].points.length,2)
  assert.ok(Number.isFinite(f[0].points[0].lat));assert.ok(Number.isFinite(f[0].points[0].lon))
})

test('offline PBF zoom selection caps tile coverage',()=>{
  const model={occurrences:[{resolution:{lat:45,lon:8}},{resolution:{lat:42,lon:13}}]}
  const z=choosePbfZoom(model,[3,4,5,6,7,8],24)
  assert.ok(z);assert.ok(z.count<=24);assert.ok([3,4,5,6,7,8].includes(z.z))
})


test('offline PBF selection treats dateline crossing as a short extent',()=>{
  const model={occurrences:[{resolution:{lat:35,lon:179}},{resolution:{lat:36,lon:-179}}]}
  const z=choosePbfZoom(model,[2,3,4,5,6],24)
  assert.ok(z);assert.ok(z.count<=24);assert.equal(z.bbox.crossesDateline,true);assert.ok(z.bbox.maxLon-z.bbox.minLon<10)
})


test('offline PBF routing follows decoded road network for confirmed road mode',()=>{
  const model={transport:{primaryMode:'Car',confirmed:true},occurrences:[
    {occurrenceId:'a',resolution:{lat:0,lon:0}},
    {occurrenceId:'b',resolution:{lat:0,lon:1}}
  ],legs:[{id:'a>b',index:0,fromOccurrenceId:'a',toOccurrenceId:'b',mode:'Car',modeConfirmed:true}]}
  const features=[{layer:'road',type:'line',points:[{lat:0,lon:0},{lat:0,lon:.5},{lat:0,lon:1}]}]
  const routed=deriveOfflineRouteSegments(model,features,{maxSnapKm:5})
  assert.equal(routed.supported,true);assert.equal(routed.complete,true);assert.equal(routed.routedLegs,1);assert.equal(routed.segments.length,1)
  assert.ok(routed.segments[0].points.length>=3)
})

test('offline PBF routing does not assert geometry before traveler confirms transport',()=>{
  const model={transport:{primaryMode:'Car',confirmed:false},occurrences:[
    {occurrenceId:'a',resolution:{lat:0,lon:0}},
    {occurrenceId:'b',resolution:{lat:0,lon:1}}
  ],legs:[{id:'a>b',index:0,fromOccurrenceId:'a',toOccurrenceId:'b',mode:'Car',modeConfirmed:false}]}
  const features=[{layer:'road',type:'line',points:[{lat:0,lon:0},{lat:0,lon:1}]}]
  const routed=deriveOfflineRouteSegments(model,features,{maxSnapKm:5})
  assert.equal(routed.supported,false);assert.equal(routed.segments.length,0);assert.equal(routed.complete,false)
})

test('offline PBF routing leaves disconnected canonical legs as explicit gaps',()=>{
  const model={transport:{primaryMode:'Car',confirmed:true},occurrences:[
    {occurrenceId:'a',resolution:{lat:0,lon:0}},
    {occurrenceId:'b',resolution:{lat:0,lon:2}}
  ],legs:[{id:'a>b',index:0,fromOccurrenceId:'a',toOccurrenceId:'b',mode:'Car',modeConfirmed:true}]}
  const features=[
    {layer:'road',type:'line',points:[{lat:0,lon:0},{lat:0,lon:.2}]},
    {layer:'road',type:'line',points:[{lat:0,lon:1.8},{lat:0,lon:2}]}
  ]
  const routed=deriveOfflineRouteSegments(model,features,{maxSnapKm:5})
  assert.equal(routed.supported,true);assert.equal(routed.complete,false);assert.equal(routed.segments.length,0);assert.equal(routed.routedLegs,0)
})


test('offline PBF routing withholds road geometry when scoped or per-leg transport conflicts exist',()=>{
  const features=[{layer:'road',type:'line',points:[{lat:0,lon:0},{lat:0,lon:.5},{lat:0,lon:1}]}]
  const base={occurrences:[{occurrenceId:'a',resolution:{lat:0,lon:0}},{occurrenceId:'b',resolution:{lat:0,lon:1}}]}
  let model={...base,transport:{primaryMode:'Car',confirmed:true,scoped:[{scope:'island',mode:'Ferry'}],pendingLegReviews:[],reconfirmationRequiredLegIds:[]},legs:[{id:'a>b',index:0,fromOccurrenceId:'a',toOccurrenceId:'b',mode:'Car',modeConfirmed:true}]}
  let routed=deriveOfflineRouteSegments(model,features,{maxSnapKm:5});assert.equal(routed.supported,false);assert.equal(routed.segments.length,0);assert.match(routed.reason,/scoped transport/i)
  model={...base,transport:{primaryMode:'Car',confirmed:true,scoped:[],pendingLegReviews:[],reconfirmationRequiredLegIds:[]},legs:[{id:'a>b',index:0,fromOccurrenceId:'a',toOccurrenceId:'b',mode:'Ferry',modeConfirmed:true}]}
  routed=deriveOfflineRouteSegments(model,features,{maxSnapKm:5});assert.equal(routed.supported,false);assert.equal(routed.segments.length,0);assert.match(routed.reason,/not confirmed as Car/i)
})
