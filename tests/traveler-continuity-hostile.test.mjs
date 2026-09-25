import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyAuthority, authorityFromProposal, applyCommand, routeOccurrences, routeLabels, deriveLegs, draftFromAuthority, previewTripDraft, commitTripDraft, validateAuthority } from '../public/core/authority.js'
import { validateTravelerContract } from '../public/core/ai.js'
import { validatePersistedState } from '../public/core/persistence.js'

function route(labels,{topology='flexible',duration=null}={}){
  let a=emptyAuthority({brief:'hostile traveler test'})
  a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:labels.map((label,i)=>({label,role:i===0?'start':i===labels.length-1?'end':'visit',disposition:'optional'}))}})
  if(topology!=='flexible')a=applyCommand(a,{type:'SET_TOPOLOGY',payload:{topology}})
  if(duration)a=applyCommand(a,{type:'SET_DURATION',payload:duration})
  return a
}

test('hostile: lossless Precision no-op draft does not create a new trip version or new occurrence identities',()=>{
  const a=route(['Tallinn','Tartu','Riga'])
  const ids=routeOccurrences(a).map(o=>o.id),d=draftFromAuthority(a),r=commitTripDraft(a,d)
  assert.equal(r.ok,true,r.error);assert.equal(r.changed,false);assert.strictEqual(r.authority,a)
  assert.deepEqual(routeOccurrences(r.authority).map(o=>o.id),ids)
})

test('hostile: Estonia loop can become Flexible with Riga as the final route row in one atomic draft',()=>{
  let a=authorityFromProposal({brief:'Estonia loop',constraints:{start:'Tallinn',end:'Tallinn',topology:'loop'},proposal:{stops:['Tallinn','Tartu','Pärnu','Tallinn'],topology:'loop'}})
  const d=draftFromAuthority(a);d.topology='flexible';d.occurrences=d.occurrences.filter((o,i)=>i<d.occurrences.length-1);d.occurrences.push({label:'Riga',role:'end',disposition:'optional',stay:{kind:'flexible'},provenance:'traveler'})
  const r=commitTripDraft(a,d);assert.equal(r.ok,true,r.error);a=r.authority
  assert.equal(a.topology,'flexible');assert.equal(routeLabels(a)[0],'Tallinn');assert.equal(routeLabels(a).at(-1),'Riga');assert.equal(routeLabels(a).filter(x=>x==='Tallinn').length,1)
})

test('hostile: duration range survives a Precision round trip exactly',()=>{
  let a=route(['A','B','C']);a=applyCommand(a,{type:'SET_DURATION',payload:{kind:'range',minDays:7,maxDays:10}})
  const r=commitTripDraft(a,draftFromAuthority(a));assert.equal(r.ok,true);assert.equal(r.changed,false);assert.deepEqual(r.authority.duration,a.duration)
})

test('hostile: route mutation prunes stale leg IDs and requires explicit reconfirmation of propagated transport',()=>{
  let a=route(['A','B','C']);const first=deriveLegs(a)[0];a=applyCommand(a,{type:'SET_LEG_TRANSPORT',payload:{legId:first.id,mode:'Train',confirmed:true}})
  const d=draftFromAuthority(a);d.occurrences.splice(1,0,{label:'X',role:'visit',disposition:'optional',stay:{kind:'flexible'},provenance:'traveler'})
  const preview=previewTripDraft(a,d),newLegs=deriveLegs(preview),oldIds=new Set(deriveLegs(a).map(x=>x.id))
  assert.ok(newLegs.every(l=>l.id!==first.id));assert.ok(Object.keys(preview.transport.legModes).every(id=>newLegs.some(l=>l.id===id)))
  assert.ok(newLegs.slice(0,2).some(l=>l.mode==='Train'&&!l.modeConfirmed))
  assert.ok(preview.transport.reconfirmationRequiredLegIds.length>0)
  const confirmDraft=draftFromAuthority(preview);confirmDraft.tripId=a.id;confirmDraft.baseVersion=a.version;confirmDraft.transport.reconfirmationRequiredLegIds=[]
  const saved=commitTripDraft(a,confirmDraft);assert.equal(saved.ok,true,saved.error);assert.equal(saved.authority.transport.reconfirmationRequiredLegIds.length,0);assert.equal(saved.authority.transport.pendingLegReviews.length,0)
  void oldIds
})

test('hostile: qualified place names remain one field and Missouri does not become Illinois',()=>{
  let a=route(['Springfield, Missouri','St. Louis, Missouri'])
  assert.equal(routeOccurrences(a)[0].place.label,'Springfield, Missouri')
  assert.equal(routeOccurrences(a)[0].place.qualifier,'Missouri')
  const d=draftFromAuthority(a),r=commitTripDraft(a,d);assert.equal(r.ok,true);assert.equal(routeOccurrences(r.authority)[0].place.label,'Springfield, Missouri')
})

test('hostile: removing or changing a required routed place reconciles its hard constraint instead of preserving contradictory meaning',()=>{
  let a=authorityFromProposal({constraints:{start:'A',end:'C',requiredPlaces:['B']},proposal:{stops:['A','B','C']}})
  assert.ok(a.placeConstraints.required.some(x=>x.label==='B'))
  const d=draftFromAuthority(a);d.occurrences=d.occurrences.filter(o=>o.place?.label!=='B'&&o.label!=='B')
  const r=commitTripDraft(a,d);assert.equal(r.ok,true,r.error);assert.equal(routeLabels(r.authority).includes('B'),false);assert.equal(r.authority.placeConstraints.required.some(x=>x.label==='B'),false)
})

test('hostile: Traveler Contract extraction failure and required/excluded contradiction are hard blockers',()=>{
  assert.ok(validateTravelerContract({extractorWarning:'extract failed'}).some(x=>x.severity==='blocker'))
  assert.ok(validateTravelerContract({requiredPlaces:['Bologna'],excludedPlaces:['Bologna']}).some(x=>x.code==='CONTRACT_REQUIRED_EXCLUDED'&&x.severity==='blocker'))
})

test('hostile: invalid timing and impossible minimum stays are rejected by authority validation and persistence',()=>{
  let a=route(['A','B','C'],{duration:{kind:'exact',days:5}}),d=draftFromAuthority(a);d.timing={startDate:'2027-06-10',endDate:'2027-06-01',season:'',provenance:'traveler'}
  let r=commitTripDraft(a,d);assert.equal(r.ok,false);assert.match(r.error,/end date/i)
  d=draftFromAuthority(a);d.occurrences[0].stay={kind:'minimum',days:3};d.occurrences[1].stay={kind:'minimum',days:3};r=commitTripDraft(a,d);assert.equal(r.ok,false);assert.match(r.error,/exceeds the trip duration/i)
  const corrupt=structuredClone(a);corrupt.timing={startDate:'2027-06-10',endDate:'2027-06-01',season:'',provenance:'traveler'};assert.throws(()=>validatePersistedState({authority:corrupt}),/canonical invariant|end date/i)
})

test('hostile: mapping/document consumers can safely use committed authority while a separate draft is changed',()=>{
  const a=route(['A','B','C']),d=draftFromAuthority(a);d.occurrences[1].label='X';const preview=previewTripDraft(a,d)
  assert.deepEqual(routeLabels(a),['A','B','C']);assert.deepEqual(routeLabels(preview),['A','X','C']);assert.equal(a.version,preview.version)
})
