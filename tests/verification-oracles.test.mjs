import test from 'node:test'
import assert from 'node:assert/strict'
import {OUTCOME,sparkOutcome,revisionOutcome,precisionOutcome,mappingOutcome,documentOutcome} from '../public/core/verification.js'

const authority={id:'trip_x',version:4,topology:'one_way',duration:{kind:'exact',days:7},occurrences:[{id:'a',role:'start',place:{label:'Alpha'},disposition:'required',stay:{kind:'flexible'}},{id:'b',role:'end',place:{label:'Beta'},disposition:'required',stay:{kind:'flexible'}}],transport:{primaryMode:'Any',confirmed:false,scoped:[]},scopes:[],experiences:[],commitments:[],exclusions:[],placeConstraints:{required:[],optional:[],excluded:[]},travelers:[]}

test('normal Spark success cannot be satisfied by a planning frame or unverified proposal',()=>{
  assert.equal(sparkOutcome({planningFrame:{title:'Planning frame'},proposals:[]}).outcome,OUTCOME.DEGRADED)
  assert.equal(sparkOutcome({proposals:[{stops:['Alpha','Beta'],verificationStatus:'unverified'}]}).outcome,OUTCOME.DEGRADED)
  assert.equal(sparkOutcome({proposals:[{stops:['Alpha','Beta'],verificationStatus:'verified'}]},{contract:{start:'Alpha'}}).outcome,OUTCOME.SUCCESS)
})

test('revision success rejects wrong trip, stale version, and invalid authority',()=>{
  assert.equal(revisionOutcome(authority,{...authority,id:'other',version:5}).outcome,OUTCOME.FAILURE)
  assert.equal(revisionOutcome(authority,{...authority}).outcome,OUTCOME.FAILURE)
  assert.equal(revisionOutcome(authority,{...structuredClone(authority),version:5}).outcome,OUTCOME.SUCCESS)
})

test('precision success requires a committed current authority',()=>{
  assert.equal(precisionOutcome(authority,{dirty:true,committedVersion:4}).outcome,OUTCOME.FAILURE)
  assert.equal(precisionOutcome(authority,{dirty:false,committedVersion:3}).outcome,OUTCOME.FAILURE)
  assert.equal(precisionOutcome(authority,{dirty:false,committedVersion:4}).outcome,OUTCOME.SUCCESS)
})

test('mapping success is authority-bound and occurrence-order sensitive',()=>{
  const good={tripId:'trip_x',authorityVersion:4,ready:true,occurrences:[{label:'Alpha'},{label:'Beta'}]}
  assert.equal(mappingOutcome(authority,good).outcome,OUTCOME.SUCCESS)
  assert.equal(mappingOutcome(authority,{...good,authorityVersion:3}).outcome,OUTCOME.FAILURE)
  assert.equal(mappingOutcome(authority,{...good,occurrences:[{label:'Beta'},{label:'Alpha'}]}).outcome,OUTCOME.FAILURE)
})

test('documentation fallback is degraded and omission is failure',()=>{
  const good={tripId:'trip_x',authorityVersion:4,text:'Alpha then Beta',enrichmentPartial:false}
  assert.equal(documentOutcome(authority,good).outcome,OUTCOME.SUCCESS)
  assert.equal(documentOutcome(authority,{...good,enrichmentPartial:true}).outcome,OUTCOME.DEGRADED)
  assert.equal(documentOutcome(authority,{...good,text:'Alpha only'}).outcome,OUTCOME.FAILURE)
})
