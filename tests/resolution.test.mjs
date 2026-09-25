import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyAuthority, applyCommand, routeOccurrences } from '../public/core/authority.js'
import { resolveAuthority, selectCandidate } from '../public/core/resolution.js'

function trip(){let a=emptyAuthority();return applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'Springfield',role:'start'},{label:'Rome',role:'end'}]}})}
function response(data,status=200){return {ok:status>=200&&status<300,status,json:async()=>data}}

test('ambiguous geocode does not silently choose the first result',async()=>{
  const a=trip();const [spring,rome]=routeOccurrences(a)
  const fetchImpl=async url=>url.includes('Springfield')?response({results:[{label:'Springfield, IL',lat:39.8,lon:-89.6,confidence:.7},{label:'Springfield, MA',lat:42.1,lon:-72.6,confidence:.68}]}):response({results:[{label:'Rome, Italy',lat:41.9,lon:12.5,confidence:.8}]})
  const r=await resolveAuthority(a,{fetchImpl})
  assert.equal(r.resolutions[spring.id],undefined)
  assert.equal(r.candidates[spring.id].length,2)
  assert.equal(r.resolutions[rome.id].label,'Rome, Italy')
  assert.ok(r.findings.some(f=>f.code==='PLACE_AMBIGUOUS'&&f.occurrenceId===spring.id))
})

test('traveler candidate selection resolves exact occurrence without mutating authority',async()=>{
  const a=trip();const spring=routeOccurrences(a)[0]
  const r={resolutions:{},candidates:{[spring.id]:[{label:'Springfield, IL',lat:39.8,lon:-89.6},{label:'Springfield, MA',lat:42.1,lon:-72.6}]},findings:[{occurrenceId:spring.id,code:'PLACE_AMBIGUOUS'}]}
  const n=selectCandidate(a,r,spring.id,1)
  assert.equal(n.resolutions[spring.id].label,'Springfield, MA')
  assert.equal(n.resolutions[spring.id].queryLabel,'Springfield')
  assert.equal(n.candidates[spring.id],undefined)
  assert.equal(routeOccurrences(a)[0].place.label,'Springfield')
})

test('failed resolution keeps every route occurrence intact',async()=>{
  const a=trip();const before=routeOccurrences(a).map(o=>({id:o.id,label:o.place.label}))
  const r=await resolveAuthority(a,{fetchImpl:async()=>{throw new Error('offline')}})
  assert.deepEqual(routeOccurrences(a).map(o=>({id:o.id,label:o.place.label})),before)
  assert.equal(Object.keys(r.resolutions).length,0)
  assert.equal(r.findings.filter(f=>f.code==='GEOCODER_UNAVAILABLE').length,2)
})
