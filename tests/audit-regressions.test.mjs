import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyAuthority, authorityFromProposal, applyCommand, applyCommands, routeOccurrences, routeLabels, deriveLegs, samePlace } from '../public/core/authority.js'
import { resolveAuthority } from '../public/core/resolution.js'
import { buildMapModel, googleMapsUrls, mapQuestEligibility, mapQuestShareUrl, mapQuestShareEligibility, providerRouteMatchesModel } from '../public/core/mapModel.js'
import { loadOfflinePbf, decodeMvt } from '../public/core/mvt.js'
import { streamDocument } from '../public/core/ai.js'
import { validatePersistedState } from '../public/core/persistence.js'

function route(labels){
  let a=emptyAuthority({brief:'test'})
  a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:labels.map((label,i)=>({label,role:i===0?'start':i===labels.length-1?'end':'visit'}))}})
  return a
}
function boundResolutions(a){const out={};routeOccurrences(a).forEach((o,i)=>out[o.id]={occurrenceId:o.id,queryLabel:o.place.label,label:o.place.label,lat:10+i,lon:20+i,confidence:1});return out}

test('audit P0: revision batch is atomic on stale IDs/anchors and returns original authority',()=>{
  const a=route(['A','B','C']),snapshot=JSON.stringify(a)
  const r=applyCommands(a,[{type:'SET_DURATION',payload:{days:9}},{type:'REMOVE_OCCURRENCE',payload:{occurrenceId:'missing'}},{type:'INSERT_OCCURRENCE',payload:{label:'X',beforeOccurrenceId:'hallucinated'}}],{tripId:a.id,baseVersion:a.version})
  assert.equal(r.ok,false);assert.equal(JSON.stringify(r.authority),snapshot);assert.equal(r.authority.version,a.version)
})

test('audit P0: traveler exclusions and optional places survive adoption and govern routing',()=>{
  const a=authorityFromProposal({brief:'Italy, skip Naples, Florence optional',constraints:{start:'Rome',end:'Milan',excludedPlaces:['Naples'],optionalPlaces:['Florence']},proposal:{stops:['Rome','Florence','Naples','Bologna','Milan']}})
  assert.ok(a.placeConstraints.excluded.some(x=>x.label==='Naples'));assert.ok(a.placeConstraints.optional.some(x=>x.label==='Florence'));assert.equal(routeLabels(a).includes('Naples'),false)
  assert.equal(routeOccurrences(a).find(o=>o.place.label==='Florence').disposition,'optional');assert.equal(routeOccurrences(a).find(o=>o.place.label==='Bologna').disposition,'optional')
  assert.throws(()=>applyCommand(a,{type:'INSERT_OCCURRENCE',payload:{label:'Naples, Italy'}}),/excluded/i)
})

test('audit P1: malformed command payloads reject instead of destructive defaulting',()=>{
  let a=route(['A','B']);a=applyCommand(a,{type:'SET_DURATION',payload:{days:10}});assert.equal(a.duration.kind,'exact');assert.equal(a.duration.days,10)
  a=applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'train',confirmed:true}});assert.equal(a.transport.primaryMode,'Train');assert.equal(a.transport.confirmed,true)
  assert.throws(()=>applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'hovercraft'}}),/invalid transport/i)
  const before=routeLabels(a);assert.throws(()=>applyCommand(a,{type:'SET_START',payload:{place:'Galle'}}),/start label/i);assert.deepEqual(routeLabels(a),before)
})

test('audit P1: normalized place identity blocks qualified excluded place and avoids required duplication',()=>{
  const a=authorityFromProposal({constraints:{start:'Genoa',end:'Rome',requiredPlaces:['Bologna'],excludedPlaces:['Naples']},proposal:{stops:['Genoa','Bologna, Italy','Naples, Italy','Rome']}})
  assert.equal(routeLabels(a).filter(x=>x.toLowerCase().startsWith('bologna')).length,1);assert.equal(routeLabels(a).some(x=>x.toLowerCase().startsWith('naples')),false)
})

test('audit P1: loop topology closes canonically and start changes replace the boundary pair without duplicating the old start',()=>{
  let a=route(['Colombo','Kandy','Ella']);a=applyCommand(a,{type:'SET_TOPOLOGY',payload:{topology:'loop'}});assert.equal(routeLabels(a).at(-1),'Colombo')
  a=applyCommand(a,{type:'SET_START',payload:{label:'Galle'}});const labels=routeLabels(a);assert.equal(labels[0],'Galle');assert.equal(labels.at(-1),'Galle');assert.equal(labels.filter(x=>x==='Colombo').length,1)
})

test('audit P1: route edits do not silently erase explicit leg transport',()=>{
  let a=route(['Bari','Athens','Sofia']),leg=deriveLegs(a)[0];a=applyCommand(a,{type:'SET_LEG_TRANSPORT',payload:{legId:leg.id,mode:'Ferry',confirmed:true}})
  a=applyCommand(a,{type:'INSERT_OCCURRENCE',payload:{label:'Brindisi',afterOccurrenceId:routeOccurrences(a)[0].id}})
  const newLegs=deriveLegs(a).slice(0,2);assert.deepEqual(newLegs.map(x=>x.mode),['Ferry','Ferry']);assert.ok(newLegs.every(x=>x.modeConfirmed===false));assert.ok(a.transport.pendingLegReviews.length>=1)
})

test('audit P1: prior traveler-selected resolution survives a geocoder outage',async()=>{
  const a=route(['Palermo','Rome']),o=routeOccurrences(a)[0],prior={[o.id]:{occurrenceId:o.id,queryLabel:o.place.label,label:'Palermo, Italy',lat:38.1157,lon:13.3615,travelerSelected:true,confidence:1}}
  const r=await resolveAuthority(a,{previousResolutions:prior,fetchImpl:async()=>{throw new Error('offline')}});assert.equal(r.resolutions[o.id].label,'Palermo, Italy')
})

test('audit P1: null/string coordinates are not accepted as resolved facts',async()=>{
  const a=route(['Null Island','Rome']),o=routeOccurrences(a)[0]
  const fetchImpl=async url=>new Response(JSON.stringify({results:url.includes('Null')?[{label:'bad',lat:null,lon:null,confidence:1}]:[{label:'Rome',lat:41.9,lon:12.5,confidence:1}]}),{status:200,headers:{'Content-Type':'application/json'}})
  const r=await resolveAuthority(a,{fetchImpl});assert.equal(r.resolutions[o.id],undefined);assert.ok(r.findings.some(f=>f.occurrenceId===o.id&&f.code==='PLACE_UNRESOLVED'))
})

test('reaudit P0: persistence rejects canonical invariant violations as well as structural corruption',()=>{
  let one=emptyAuthority();one=applyCommand(one,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'Only stop',role:'start'}]}})
  assert.throws(()=>validatePersistedState({authority:one}),/canonical invariant/i)
  const openLoop=route(['A','B']);openLoop.topology='loop';assert.throws(()=>validatePersistedState({authority:openLoop}),/loop|canonical invariant/i)
  const excluded=route(['A','B']);excluded.placeConstraints.excluded=[{id:'pc_x',label:'B',disposition:'excluded',provenance:'traveler'}];assert.throws(()=>validatePersistedState({authority:excluded}),/excluded|canonical invariant/i)
  const corrupt=route(['A','B']);corrupt.occurrences[0].role='garbage';assert.throws(()=>validatePersistedState({authority:corrupt}),/integrity/i)
})

test('audit P1: document requires the exact authority snapshot and missing DONE cannot truncate route coverage',async()=>{
  const a=route(['A','B']),model=buildMapModel(a,boundResolutions(a));const stale={...model,authorityVersion:model.authorityVersion-1};await assert.rejects(()=>streamDocument(a,stale),/does not match/i)
  const prior=globalThis.fetch,enc=new TextEncoder();globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(enc.encode(`data: ${JSON.stringify({choices:[{delta:{content:'## Overview\nOne complete sentence. unfinished'}}]})}\n\n`));c.close()}}),{status:200,headers:{'Content-Type':'text/event-stream'}})
  try{const r=await streamDocument(a,model);assert.equal(r.partial,false);assert.equal(r.enrichmentPartial,true);assert.match(r.text,/## Overview\nOne complete sentence\./);assert.doesNotMatch(r.text,/unfinished/);assert.match(r.text,/### 1\. A/);assert.match(r.text,/### 2\. B/)}finally{globalThis.fetch=prior}
})

test('mapping P1: unresolved middle occurrence creates disjoint resolved segments, not A-to-C topology',()=>{
  const a=route(['A','B','C']),rs=boundResolutions(a),mid=routeOccurrences(a)[1];delete rs[mid.id];const m=buildMapModel(a,rs);assert.deepEqual(m.resolvedSegments.map(s=>s.map(o=>o.label)),[['A'],['C']]);assert.equal(m.legs[0].coordinatesReady,false);assert.equal(m.legs[1].coordinatesReady,false)
})

test('mapping P1: stale resolution without identity binding is rejected after rename',()=>{
  let a=route(['Springfield','Rome']),o=routeOccurrences(a)[0],res={[o.id]:{label:'Springfield, IL',lat:39.8,lon:-89.6,confidence:1}};a=applyCommand(a,{type:'RENAME_OCCURRENCE',payload:{occurrenceId:o.id,label:'Springfield, MA'}});assert.equal(buildMapModel(a,res).occurrences[0].resolution,null)
})

test('mapping P1: scoped or incompatible leg transport blocks whole-trip MapQuest road routing',()=>{
  let a=route(['A','B','C']);a=applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'Car',confirmed:true}});a=applyCommand(a,{type:'SET_SCOPED_TRANSPORT',payload:{scoped:[{scope:'B',mode:'Ferry'}]}});let m=buildMapModel(a,boundResolutions(a));assert.equal(mapQuestEligibility(m).ok,false)
  a=applyCommand(a,{type:'SET_SCOPED_TRANSPORT',payload:{scoped:[]}});const leg=deriveLegs(a)[0];a=applyCommand(a,{type:'SET_LEG_TRANSPORT',payload:{legId:leg.id,mode:'Ferry',confirmed:true}});m=buildMapModel(a,boundResolutions(a));assert.equal(mapQuestEligibility(m).ok,false)
})

test('mapping P1: Google handoff segments long confirmed-road routes without dropping canonical occurrences',()=>{
  const labels=Array.from({length:12},(_,i)=>`Stop ${i+1}`);let a=route(labels);a=applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'Car',confirmed:true}});const m=buildMapModel(a,boundResolutions(a)),segments=googleMapsUrls(m);assert.ok(segments.length>1);assert.equal(segments[0].occurrenceIds[0],m.occurrences[0].occurrenceId);assert.equal(segments.at(-1).occurrenceIds.at(-1),m.occurrences.at(-1).occurrenceId);for(const s of segments){assert.ok(s.url.length<1900);assert.match(s.url,/travelmode=driving/)}
  for(let i=1;i<segments.length;i++)assert.equal(segments[i-1].occurrenceIds.at(-1),segments[i].occurrenceIds[0])
})



test('mapping P1: provider direction handoffs are withheld until a compatible transport is traveler-confirmed',()=>{
  let a=route(['A','B','C']),m=buildMapModel(a,boundResolutions(a));assert.deepEqual(googleMapsUrls(m),[])
  a=applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'Bus',confirmed:true}});m=buildMapModel(a,boundResolutions(a));assert.deepEqual(googleMapsUrls(m),[])
  a=applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'Car',confirmed:true}});a=applyCommand(a,{type:'ADD_SCOPED_TRANSPORT',payload:{scope:'B',mode:'Ferry'}});m=buildMapModel(a,boundResolutions(a));assert.deepEqual(googleMapsUrls(m),[])
})

test('mapping P1/P2: offline tile loss is explicitly incomplete and malformed MVT throws',async()=>{
  const a=route(['A','B']),m=buildMapModel(a,boundResolutions(a)),prior=globalThis.fetch;globalThis.fetch=async()=>new Response('missing',{status:404})
  try{const r=await loadOfflinePbf(m,{available:true,zooms:[0]});assert.equal(r.complete,false);assert.equal(r.missingTiles,1);assert.match(r.message,/incomplete/i)}finally{globalThis.fetch=prior}
  assert.throws(()=>decodeMvt(Uint8Array.from([0x1a,0x05,0x0a]).buffer,0,0,0),/EOF|protobuf/i)
})


test('mapping P1: provider responses are rejected when the current authority snapshot changed',()=>{
  const a=route(['A','B','C']),m=buildMapModel(a,boundResolutions(a));const response={tripId:m.tripId,authorityVersion:m.authorityVersion,snapshotKey:m.snapshotKey,occurrenceIds:m.occurrences.map(o=>o.occurrenceId)}
  assert.equal(providerRouteMatchesModel(response,m),true)
  const newer={...m,authorityVersion:m.authorityVersion+1,snapshotKey:m.snapshotKey+'x'};assert.equal(providerRouteMatchesModel(response,newer),false)
})

test('persistence P1: supplied invalid transport mode is rejected instead of silently reset',()=>{
  const a=route(['A','B']),corrupt=structuredClone(a);corrupt.transport.primaryMode='hovercraft';assert.throws(()=>validatePersistedState({authority:corrupt}),/unsupported transport mode/i)
})

test('documentation P1: missing model stop headings cannot remove canonical stop coverage',async()=>{
  const a=route(['A','B','C']),model=buildMapModel(a,boundResolutions(a)),prior=globalThis.fetch,enc=new TextEncoder()
  globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(enc.encode(`data: ${JSON.stringify({choices:[{delta:{content:'## Overview\nOverview only.'}}]})}\n\n`));c.enqueue(enc.encode('data: [DONE]\n\n'));c.close()}}),{status:200,headers:{'Content-Type':'text/event-stream'}})
  try{const r=await streamDocument(a,model);assert.equal(r.partial,false);assert.equal(r.enrichmentPartial,true);assert.match(r.error,/0\/3 stop sections/i);assert.match(r.text,/### 1\. A/);assert.match(r.text,/### 2\. B/);assert.match(r.text,/### 3\. C/)}finally{globalThis.fetch=prior}
})


test('documentation P1: unsupported fares, schedules, and entry-rule claims are stripped and cannot be accepted as complete',async()=>{
  const a=route(['A','B']),model=buildMapModel(a,boundResolutions(a)),prior=globalThis.fetch,enc=new TextEncoder()
  const prose='## Overview\nSafe overview.\n\n## Stop-by-stop planning notes\n### 1. A\nThe ferry costs €25. Safe note for A.\n\n### 2. B\nTravelers need a visa for B. The bus departs at 08:30. Safe note for B.\n\n## Transport notes\nVerify current schedules with the operator.\n\n## Practical preparation\nVerify current visa requirements with official sources.'
  globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(enc.encode(`data: ${JSON.stringify({choices:[{delta:{content:prose}}]})}\n\n`));c.enqueue(enc.encode('data: [DONE]\n\n'));c.close()}}),{status:200,headers:{'Content-Type':'text/event-stream'}})
  try{const r=await streamDocument(a,model);assert.equal(r.partial,false);assert.equal(r.enrichmentPartial,true);assert.match(r.error,/time-sensitive claim/i);assert.doesNotMatch(r.text,/€25|need a visa|08:30/);assert.match(r.text,/Safe note for A/);assert.match(r.text,/Verify current visa requirements/);assert.match(r.text,/### 1\. A/);assert.match(r.text,/### 2\. B/)}finally{globalThis.fetch=prior}
})


test('reaudit P1: qualified place identity distinguishes same-named places while preserving unqualified intent',()=>{
  assert.equal(samePlace('Springfield, Missouri','Springfield, Illinois'),false)
  assert.equal(samePlace('Springfield','Springfield, Illinois'),true)
  const a=authorityFromProposal({constraints:{start:'Chicago, Illinois',end:'St. Louis, Missouri',excludedPlaces:['Springfield, Missouri']},proposal:{stops:['Chicago, Illinois','Springfield, Illinois','Springfield, Missouri','St. Louis, Missouri']}})
  assert.ok(routeLabels(a).includes('Springfield, Illinois'));assert.equal(routeLabels(a).includes('Springfield, Missouri'),false)
  const springfield=routeOccurrences(a).find(o=>o.place.label==='Springfield, Illinois');assert.equal(springfield.place.qualifier,'Illinois')
})

test('reaudit P1: malformed populated Precision rows fail atomically instead of disappearing',()=>{
  const a=route(['A','B','C']),before=JSON.stringify(a),first=routeOccurrences(a)[0]
  const result=applyCommands(a,[{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{id:first.id,label:''},{label:'B'},{label:'C'}]}}],{tripId:a.id,baseVersion:a.version})
  assert.equal(result.ok,false);assert.equal(JSON.stringify(result.authority),before);assert.match(result.error,/label is required/i)
  const result2=applyCommands(a,[{type:'SET_PRECISION_ROUTE',payload:{start:'A',end:'C',visits:[{id:'known-ish',label:'',disposition:'required'}]}}],{tripId:a.id,baseVersion:a.version})
  assert.equal(result2.ok,false);assert.equal(JSON.stringify(result2.authority),before);assert.match(result2.error,/label is required/i)
})

test('reaudit mapping P1: MapQuest share never drops confirmed mode and rejects oversized handoffs',()=>{
  let a=route(['A','B','C']);a=applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'Walk',confirmed:true}});let m=buildMapModel(a,boundResolutions(a));assert.equal(mapQuestEligibility(m).ok,true);assert.equal(mapQuestShareUrl(m),'');assert.match(mapQuestShareEligibility(m).reason,/withheld.*Walk/i)
  a=applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'Bike',confirmed:true}});m=buildMapModel(a,boundResolutions(a));assert.equal(mapQuestShareUrl(m),'')
  a=applyCommand(a,{type:'SET_TRANSPORT',payload:{mode:'Car',confirmed:true}});m=buildMapModel(a,boundResolutions(a));assert.match(mapQuestShareUrl(m),/^https:\/\/www\.mapquest\.com\/directions\?/)
  const many=route(Array.from({length:51},(_,i)=>`Stop ${i+1}`));const car=applyCommand(many,{type:'SET_TRANSPORT',payload:{mode:'Car',confirmed:true}}),large=buildMapModel(car,boundResolutions(car));assert.equal(mapQuestEligibility(large).ok,false);assert.equal(mapQuestShareUrl(large),'')
  assert.equal(mapQuestShareUrl(m,{maxUrlLength:20}),'')
})


test('reaudit P1: qualified occurrence does not auto-resolve to a conflicting same-named place',async()=>{
  const a=authorityFromProposal({constraints:{start:'Springfield, Missouri',end:'St. Louis, Missouri'},proposal:{stops:['Springfield, Missouri','St. Louis, Missouri']}}),first=routeOccurrences(a)[0]
  assert.equal(first.place.qualifier,'Missouri')
  const fetchImpl=async url=>new Response(JSON.stringify({results:url.includes('Springfield')?[{label:'Springfield, Illinois',lat:39.78,lon:-89.65,countryCode:'US',confidence:.99}]:[{label:'St. Louis, Missouri',lat:38.63,lon:-90.2,countryCode:'US',confidence:.99}]}),{status:200,headers:{'Content-Type':'application/json'}})
  const r=await resolveAuthority(a,{fetchImpl});assert.equal(r.resolutions[first.id],undefined);assert.ok(r.candidates[first.id]?.length===1);assert.ok(r.findings.some(f=>f.occurrenceId===first.id&&f.code==='PLACE_AMBIGUOUS'))
})
