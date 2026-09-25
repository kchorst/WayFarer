import test from 'node:test'
import assert from 'node:assert/strict'
import { authorityFromProposal, emptyAuthority, applyCommand, applyCommands, routeLabels, routeOccurrences, deriveLegs, validateAuthority } from '../public/core/authority.js'
import { buildMapModel, googleMapsUrl, mapQuestApiPayload, modelInvariantFindings, unwrapLongitudeSequence } from '../public/core/mapModel.js'

function italy(){
  return authorityFromProposal({
    brief:'One month around Italy, start and end Genoa, include Sicily, prefer bus.',
    constraints:{duration:{kind:'exact',days:30},topology:'loop',start:'Genoa',end:'Genoa',requiredPlaces:['Sicily'],scopes:[{kind:'country',label:'Italy'}],transport:{primaryMode:'Bus',confirmed:true}},
    proposal:{title:'Italy',stops:['Genoa','Bologna','Florence','Rome','Naples','Palermo','Catania','Genoa'],days:28,topology:'loop',themes:['food']}
  })
}

test('explicit traveler constraints override Spark guesses at adoption',()=>{
  const a=italy()
  assert.equal(a.duration.days,30)
  assert.equal(a.transport.primaryMode,'Bus')
  assert.equal(a.transport.confirmed,true)
  assert.equal(a.topology,'loop')
  assert.equal(routeLabels(a)[0],'Genoa')
  assert.equal(routeLabels(a).at(-1),'Genoa')
  assert.ok(routeLabels(a).includes('Sicily'))
})

test('start and terminal closure are separate occurrences even with same label',()=>{
  const a=italy(); const genoa=routeOccurrences(a).filter(o=>o.place.label==='Genoa')
  assert.equal(genoa.length,2)
  assert.notEqual(genoa[0].id,genoa[1].id)
  assert.equal(genoa[0].role,'start');assert.equal(genoa[1].role,'end')
})

test('canonical leg count is occurrences minus one and endpoints participate',()=>{
  const a=italy(); assert.equal(deriveLegs(a).length,routeOccurrences(a).length-1)
  assert.equal(deriveLegs(a)[0].fromOccurrenceId,routeOccurrences(a)[0].id)
  assert.equal(deriveLegs(a).at(-1).toOccurrenceId,routeOccurrences(a).at(-1).id)
})

test('revision can insert exactly two occurrences between Sicily and final Genoa without regenerating route',()=>{
  let a=italy(); const before=routeOccurrences(a); const sicily=before.find(o=>o.place.label==='Sicily'); const end=before.at(-1)
  const preserved=before.map(o=>o.id)
  let result=applyCommands(a,[
    {type:'INSERT_OCCURRENCE',payload:{label:'Cagliari',afterOccurrenceId:sicily.id}},
    {type:'INSERT_OCCURRENCE',payload:{label:'Ajaccio',beforeOccurrenceId:end.id}},
  ],{baseVersion:a.version,tripId:a.id})
  assert.equal(result.ok,true);a=result.authority
  assert.equal(routeOccurrences(a).filter(o=>['Cagliari','Ajaccio'].includes(o.place.label)).length,2)
  for(const id of preserved) assert.ok(routeOccurrences(a).some(o=>o.id===id),`preserved occurrence ${id}`)
  assert.equal(routeLabels(a)[0],'Genoa');assert.equal(routeLabels(a).at(-1),'Genoa')
  assert.equal(a.duration.days,30);assert.equal(a.transport.primaryMode,'Bus')
})

test('duplicate physical place can be revisited and exact occurrence can be removed',()=>{
  let a=emptyAuthority();a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'Taipei',role:'start'},{label:'Tainan',role:'visit'},{label:'Taipei',role:'visit'},{label:'Taipei',role:'end'}]}})
  const taipei=routeOccurrences(a).filter(o=>o.place.label==='Taipei');assert.equal(taipei.length,3);assert.equal(new Set(taipei.map(o=>o.id)).size,3)
  a=applyCommand(a,{type:'REMOVE_OCCURRENCE',payload:{occurrenceId:taipei[1].id,confirmTravelerOwned:true}})
  assert.equal(routeOccurrences(a).filter(o=>o.place.label==='Taipei').length,2)
  assert.ok(routeOccurrences(a).some(o=>o.id===taipei[0].id));assert.ok(routeOccurrences(a).some(o=>o.id===taipei[2].id))
})

test('move command targets occurrence identity, not shared label',()=>{
  let a=emptyAuthority();a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'A',role:'start'},{label:'B',role:'visit'},{label:'A',role:'visit'},{label:'C',role:'end'}]}})
  const secondA=routeOccurrences(a).find((o,i)=>o.place.label==='A'&&i>0);const b=routeOccurrences(a).find(o=>o.place.label==='B')
  a=applyCommand(a,{type:'MOVE_OCCURRENCE',payload:{occurrenceId:secondA.id,beforeOccurrenceId:b.id}})
  assert.deepEqual(routeLabels(a),['A','A','B','C'])
  assert.equal(routeOccurrences(a)[1].id,secondA.id)
})

test('home origin and geographic scopes do not become route stops',()=>{
  let a=emptyAuthority();a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'Tallinn',role:'start'},{label:'Tartu',role:'visit'},{label:'Tallinn',role:'end'}]}});a=applyCommand(a,{type:'SET_HOME_ORIGIN',payload:{label:'Queens, NY'}});a=applyCommand(a,{type:'SET_SCOPES',payload:{scopes:[{kind:'country',label:'Estonia'}]}})
  assert.deepEqual(routeLabels(a),['Tallinn','Tartu','Tallinn'])
})

test('choose transport later remains unconfirmed and does not change route',()=>{
  let a=italy();const before=routeLabels(a);a=applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'Any',confirmed:false}})
  assert.deepEqual(routeLabels(a),before);assert.equal(a.transport.primaryMode,'Any');assert.equal(a.transport.confirmed,false)
})

test('stale resolution for renamed occurrence is rejected by MapModel',()=>{
  let a=emptyAuthority();a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'Granada',role:'start'},{label:'Malta',role:'end'}]}});const first=routeOccurrences(a)[0];const stale={[first.id]:{lat:1,lon:2,queryLabel:'Granada'}};a=applyCommand(a,{type:'RENAME_OCCURRENCE',payload:{occurrenceId:first.id,label:'Ceuta'}});const m=buildMapModel(a,stale);assert.equal(m.occurrences[0].resolution,null);assert.ok(m.unresolvedOccurrenceIds.includes(first.id))
})

test('MapModel and provider inputs preserve exact canonical occurrence order',()=>{
  let a=emptyAuthority();a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'Riga',role:'start'},{label:'Stockholm',role:'visit'},{label:'Pasco, Washington',role:'end'}]}})
  a=applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'Car',confirmed:true}})
  const r={};routeOccurrences(a).forEach((o,i)=>r[o.id]={lat:10+i,lon:20+i,occurrenceId:o.id,queryLabel:o.place.label});const m=buildMapModel(a,r)
  assert.deepEqual(m.occurrences.map(o=>o.label),['Riga','Stockholm','Pasco, Washington'])
  assert.deepEqual(m.legs.map(x=>[x.fromOccurrenceId,x.toOccurrenceId]),[[m.occurrences[0].occurrenceId,m.occurrences[1].occurrenceId],[m.occurrences[1].occurrenceId,m.occurrences[2].occurrenceId]])
  assert.equal(modelInvariantFindings(m).length,0)
  const payload=mapQuestApiPayload(m);assert.deepEqual(payload.locations.map(x=>x.latLng.lat),[10,11,12])
  const u=decodeURIComponent(googleMapsUrl(m));assert.match(u,/origin=10.000000%2C20.000000|origin=10.000000,20.000000/);assert.match(u,/waypoints=/);assert.match(u,/destination=/)
})

test('loop topology derives an explicit terminal closure instead of leaving an open loop',()=>{
  let a=emptyAuthority();a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'Cagliari',role:'start'},{label:'Olbia',role:'visit'},{label:'Alghero',role:'end'}]}});a=applyCommand(a,{type:'SET_TOPOLOGY',payload:{topology:'loop'}});const f=validateAuthority(a);assert.equal(f.some(x=>x.code==='OPEN_LOOP'),false);assert.equal(routeLabels(a)[0],'Cagliari');assert.equal(routeLabels(a).at(-1),'Cagliari')
})

test('version precondition rejects stale Revision plan',()=>{
  let a=italy();const stale=a.version;a=applyCommand(a,{type:'ADD_EXPERIENCE',payload:{label:'markets'}});const r=applyCommands(a,[{type:'SET_DURATION',payload:{kind:'exact',days:21}}],{baseVersion:stale,tripId:a.id});assert.equal(r.ok,false);assert.equal(r.authority.duration.days,30)
})

test('timing, scoped transport, and per-leg transport remain traveler-owned precision data',()=>{
  let a=emptyAuthority();a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'Athens',role:'start'},{label:'Crete',role:'visit'},{label:'Cyprus',role:'end'}]}})
  a=applyCommand(a,{type:'SET_TIMING',payload:{startDate:'2027-05-01',endDate:'2027-05-21',season:'late spring'}})
  a=applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'Mixed',confirmed:true}})
  a=applyCommand(a,{type:'SET_SCOPED_TRANSPORT',payload:{scoped:[{scope:'Crete',mode:'Ferry'}]}})
  const firstLeg=deriveLegs(a)[0];a=applyCommand(a,{type:'SET_LEG_TRANSPORT',payload:{legId:firstLeg.id,mode:'Air'}})
  assert.equal(a.timing.startDate,'2027-05-01');assert.equal(a.transport.scoped[0].mode,'Ferry');assert.equal(a.transport.legModes[firstLeg.id],'Air')
})

test('stale leg transport overrides are pruned when route topology changes',()=>{
  let a=emptyAuthority();a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'A',role:'start'},{label:'B',role:'visit'},{label:'C',role:'end'}]}})
  const oldLeg=deriveLegs(a)[0];a=applyCommand(a,{type:'SET_LEG_TRANSPORT',payload:{legId:oldLeg.id,mode:'Train'}});assert.equal(a.transport.legModes[oldLeg.id],'Train')
  const b=routeOccurrences(a).find(o=>o.place.label==='B');a=applyCommand(a,{type:'REMOVE_OCCURRENCE',payload:{occurrenceId:b.id,confirmTravelerOwned:true}})
  assert.equal(a.transport.legModes[oldLeg.id],undefined);assert.equal(deriveLegs(a).length,1)
})


test('unconfirmed transport cannot create mode-specific MapQuest API payload',()=>{
  let a=emptyAuthority();a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'A',role:'start'},{label:'B',role:'end'}]}})
  const r={};routeOccurrences(a).forEach((o,i)=>r[o.id]={lat:i,lon:i,occurrenceId:o.id,queryLabel:o.place.label});const m=buildMapModel(a,r)
  assert.equal(m.transport.confirmed,false);assert.equal(mapQuestApiPayload(m),null)
})

test('dateline route longitudes unwrap across the short path',()=>{
  const pts=unwrapLongitudeSequence([{lat:35,lon:179},{lat:36,lon:-179},{lat:37,lon:-170}])
  assert.deepEqual(pts.map(p=>p.displayLon),[179,181,190]);assert.ok(Math.max(...pts.map(p=>p.displayLon))-Math.min(...pts.map(p=>p.displayLon))<30)
})

test('Precision route shape commits topology and boundaries atomically instead of being trapped by the previous loop',()=>{
  let a=emptyAuthority({brief:'Estonia trip'});a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'Tallinn',role:'start'},{label:'Tartu',role:'visit'},{label:'Riga',role:'visit'},{label:'Tallinn',role:'end',revisitIntent:true}]}});a=applyCommand(a,{type:'SET_TOPOLOGY',payload:{topology:'loop'}})
  const rows=routeOccurrences(a).map(o=>({id:o.id,label:o.place.label,role:o.role,disposition:o.disposition,stay:o.stay}))
  const result=applyCommands(a,[{type:'SET_PRECISION_SHAPE',payload:{occurrences:rows,start:'Tallinn',end:'Riga',topology:'flexible'}}],{baseVersion:a.version,tripId:a.id})
  assert.equal(result.ok,true,result.error);assert.equal(result.authority.topology,'flexible');assert.equal(routeLabels(result.authority)[0],'Tallinn');assert.equal(routeLabels(result.authority).at(-1),'Riga');assert.equal(routeLabels(result.authority).filter(x=>x==='Tallinn').length,1)
})
