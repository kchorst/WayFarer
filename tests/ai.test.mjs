import test from 'node:test'
import assert from 'node:assert/strict'
import { generateSpark, generateSparkFromContract, extractTravelerConstraints, compileRevision, streamDocument, buildDocumentBaseline } from '../public/core/ai.js'
import { authorityFromProposal, applyCommands, routeOccurrences, routeLabels } from '../public/core/authority.js'
import { buildMapModel } from '../public/core/mapModel.js'

function jsonResponse(content){return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{'Content-Type':'application/json'}})}


test('Traveler Contract extractor tolerates hostile model field shapes without crashing production',async()=>{
  const prior=globalThis.fetch
  globalThis.fetch=async()=>jsonResponse(JSON.stringify({start:'Temple 1 — Ryōzenji',end:'Temple 88 — Ōkuboji',duration:{kind:'exact',days:42},topology:'one_way',requiredPlaces:'Shikoku',optionalPlaces:{label:'Tokushima'},excludedPlaces:null,scopes:{kind:'island',label:'Shikoku'},experiences:{required:'pilgrimage'},commitments:'walk',conflicts:{message:'none'}}))
  try{const c=await extractTravelerConstraints('There is a pilgrimage in Japan called Shikoku. I have 6 weeks and want to walk this route.');assert.equal(c.extractorWarning,undefined);assert.deepEqual(c.requiredPlaces,[]);assert.deepEqual(c.scopes,[]);assert.equal(c.start,'Temple 1 — Ryōzenji');assert.equal(c.duration.days,42)}finally{globalThis.fetch=prior}
})
test('Spark keeps regional scope separate from literal route anchors and returns full proposals',async()=>{
  const prior=globalThis.fetch
  const constraints={duration:{kind:'exact',days:30},start:'Genoa',end:'Genoa',topology:'loop',scopes:[{kind:'country',label:'Italy'},{kind:'island',label:'Sicily'}],requiredPlaces:['Bologna'],transport:{primaryMode:'Bus',confirmed:true}}
  const proposals=[
    {title:'A',stops:['Genoa','Bologna','Florence','Rome','Naples','Palermo','Catania','Genoa'],days:30,topology:'loop',themes:['food']},
    {title:'B',stops:['Genoa','Bologna','Parma','Rome','Naples','Palermo','Catania','Genoa'],days:30,topology:'loop',themes:['markets']},
    {title:'C',stops:['Genoa','Bologna','Verona','Rome','Naples','Palermo','Catania','Genoa'],days:30,topology:'loop',themes:['history']}
  ]
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);const system=body.messages?.find(m=>m.role==='system')?.content||'';return system.includes('Traveler Contract extractor')?jsonResponse(JSON.stringify(constraints)):jsonResponse(JSON.stringify({proposals}))}
  try{const r=await generateSpark('one month Italy including Sicily');assert.equal(r.proposals.length,3);assert.equal(r.constraints.scopes[1].label,'Sicily');assert.deepEqual(r.constraints.requiredPlaces,['Bologna']);assert.equal(r.constraints.transport.confirmed,false);assert.ok(r.proposals.every(p=>p.stops.includes('Palermo')))}finally{globalThis.fetch=prior}
})

test('Revision compiler only admits delta command vocabulary and preserves base version',async()=>{
  const a=authorityFromProposal({brief:'Italy',constraints:{start:'Genoa',end:'Genoa'},proposal:{stops:['Genoa','Rome','Genoa']}})
  const end=a.occurrences.at(-1)
  const prior=globalThis.fetch
  globalThis.fetch=async()=>jsonResponse(JSON.stringify({summary:'Add Bologna before returning to Genoa.',commands:[{type:'INSERT_OCCURRENCE',payload:{label:'Bologna',beforeOccurrenceId:end.id}}]}))
  try{const r=await compileRevision(a,'add Bologna');assert.equal(r.baseVersion,a.version);assert.equal(r.tripId,a.id);assert.equal(r.commands.length,1);assert.equal(r.commands[0].type,'INSERT_OCCURRENCE')}finally{globalThis.fetch=prior}
})




test('Revision honors explicit enter/depart anchors and a single-occurrence request even if model command order is unsafe',async()=>{
  const a=authorityFromProposal({brief:'Tour Estonia and nearby Baltic cities',constraints:{start:'Tallinn',end:'Tallinn',topology:'loop'},proposal:{stops:['Tallinn','Tartu','Riga','Tallinn'],topology:'loop'}}),end=routeOccurrences(a).at(-1)
  const prior=globalThis.fetch
  globalThis.fetch=async()=>jsonResponse(JSON.stringify({summary:'Use Tallinn once and depart Riga.',commands:[{type:'REMOVE_OCCURRENCE',payload:{occurrenceId:end.id,confirmTravelerOwned:true}}]}))
  try{
    const plan=await compileRevision(a,'I enter Tallinn and I depart Riga, so only ONE stop in Tallinn.')
    assert.equal(plan.commands[0].type,'SET_TOPOLOGY');assert.equal(plan.commands[0].payload.topology,'flexible');assert.ok(plan.commands.some(c=>c.type==='SET_START'&&c.payload.label==='Tallinn'));assert.ok(plan.commands.some(c=>c.type==='SET_END'&&c.payload.label==='Riga'));assert.equal(plan.commands.at(-1).type,'REMOVE_OCCURRENCE')
    const result=applyCommands(a,plan.commands,{baseVersion:plan.baseVersion,tripId:plan.tripId});assert.equal(result.ok,true,result.error);assert.equal(routeLabels(result.authority)[0],'Tallinn');assert.equal(routeLabels(result.authority).at(-1),'Riga');assert.equal(routeLabels(result.authority).filter(x=>x==='Tallinn').length,1)
  }finally{globalThis.fetch=prior}
})
test('Spark rejects typed non-route items instead of silently repairing the model route',async()=>{
  const prior=globalThis.fetch
  const contract={start:'Athens',end:'Athens',topology:'loop',duration:{kind:'exact',days:10},scopes:[{kind:'country',label:'Greece'}]}
  let call=0
  const good=[
    {title:'Mainland circuit',stops:[{label:'Athens',kind:'settlement'},{label:'Thessaloniki',kind:'settlement'},{label:'Athens',kind:'settlement'}],days:10,topology:'loop'},
    {title:'Peloponnese circuit',stops:[{label:'Athens',kind:'settlement'},{label:'Patras',kind:'settlement'},{label:'Athens',kind:'settlement'}],days:10,topology:'loop'},
    {title:'Historic circuit',stops:[{label:'Athens',kind:'settlement'},{label:'Nafplio',kind:'settlement'},{label:'Athens',kind:'settlement'}],days:10,topology:'loop'},
  ]
  globalThis.fetch=async(_url,opts)=>{call++;const body=JSON.parse(opts.body),system=body.messages?.find(m=>m.role==='system')?.content||''
    if(system.includes('Return ONE route skeleton'))return jsonResponse(JSON.stringify({title:'Bad',stops:[{label:'Athens',kind:'settlement'},{label:'Greece',kind:'country'},{label:'Athens',kind:'settlement'}],days:10,topology:'loop'}))
    if(system.includes('Stream up to'))return jsonResponse(JSON.stringify({proposals:good.slice(0,2)}))
    if(system.includes('skeleton completion'))return jsonResponse(JSON.stringify({proposals:[good[2]]}))
    if(system.includes('You enrich already-validated'))return jsonResponse(JSON.stringify({enrichments:[]}))
    throw new Error('unexpected call '+call)
  }
  try{const r=await generateSparkFromContract('Tour Greece from Athens and back.',contract);assert.equal(r.proposals.length,3);assert.ok(r.rejected.some(x=>x.violations.some(v=>v.startsWith('non-route-kind:')||v.startsWith('scope-as-stop:'))));assert.ok(r.proposals.every(p=>!p.stops.includes('Greece')))}finally{globalThis.fetch=prior}
})

test('Revision cannot model-confirm a transport preference',async()=>{
  const a=authorityFromProposal({brief:'Italy',constraints:{start:'Genoa',end:'Rome'},proposal:{stops:['Genoa','Rome']}})
  const prior=globalThis.fetch
  globalThis.fetch=async()=>jsonResponse(JSON.stringify({summary:'Preference recorded.',commands:[{type:'SET_TRANSPORT',payload:{mode:'Train',confirmed:true}}]}))
  try{const r=await compileRevision(a,'I prefer trains if possible.');assert.equal(r.commands[0].payload.mode,'Train');assert.equal(r.commands[0].payload.confirmed,false)}finally{globalThis.fetch=prior}
})

test('interrupted document enrichment preserves a complete document and only merges complete sentences',async()=>{
  const a=authorityFromProposal({brief:'Italy',constraints:{start:'Genoa',end:'Rome'},proposal:{stops:['Genoa','Florence','Rome']}});const model=buildMapModel(a,{})
  const prior=globalThis.fetch
  const encoder=new TextEncoder();globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(encoder.encode(`data: ${JSON.stringify({choices:[{delta:{content:'## Overview\nFirst sentence. Second'}}]})}\n\n`));setTimeout(()=>controller.error(new Error('cut')),5)}}),{status:200,headers:{'Content-Type':'text/event-stream'}})
  try{const r=await streamDocument(a,model);assert.equal(r.partial,false);assert.equal(r.enrichmentPartial,true);assert.match(r.text,/## Overview\nFirst sentence\./);assert.doesNotMatch(r.text,/Second/);assert.match(r.text,/### 1\. Genoa/);assert.match(r.text,/### 2\. Florence/);assert.match(r.text,/### 3\. Rome/);assert.match(r.text,/## Transport notes/);assert.match(r.text,/## Practical preparation/)}finally{globalThis.fetch=prior}
})

test('document baseline is complete before model enrichment begins',async()=>{
  const a=authorityFromProposal({brief:'Italy',constraints:{start:'Genoa',end:'Rome'},proposal:{stops:['Genoa','Florence','Rome']}}),model=buildMapModel(a,{})
  const baseline=buildDocumentBaseline(a,model);assert.match(baseline,/### 1\. Genoa/);assert.match(baseline,/### 2\. Florence/);assert.match(baseline,/### 3\. Rome/);assert.match(baseline,/## Practical preparation/)
  const prior=globalThis.fetch,enc=new TextEncoder();let first=''
  globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(enc.encode('data: [DONE]\n\n'));c.close()}}),{status:200,headers:{'Content-Type':'text/event-stream'}})
  try{const pending=streamDocument(a,model,{onText:text=>{if(!first)first=text}});assert.match(first,/### 3\. Rome/);await pending}finally{globalThis.fetch=prior}
})

test('Spark asks clarification only for explicit hard conflicts before generating proposals',async()=>{
  const prior=globalThis.fetch
  let calls=0
  globalThis.fetch=async()=>{calls++;return jsonResponse(JSON.stringify({start:'Genoa',conflicts:['Traveler explicitly required two different starts: Genoa and Rome.'],clarificationQuestion:'Should the trip start in Genoa or Rome?'}))}
  try{const r=await generateSpark('Start in Genoa. The trip must start in Rome.');assert.equal(r.proposals.length,0);assert.match(r.clarification.question,/Genoa or Rome/);assert.equal(calls,1)}finally{globalThis.fetch=prior}
})

test('Spark makes only one bounded completeness retry and preserves usable partial concepts',async()=>{
  const prior=globalThis.fetch;let calls=0
  globalThis.fetch=async(_url,opts)=>{calls++;const body=JSON.parse(opts.body),system=body.messages?.find(m=>m.role==='system')?.content||''
    if(system.includes('Traveler Contract extractor'))return jsonResponse(JSON.stringify({start:'Athens',end:'Athens',topology:'loop'}))
    if(calls===2)return jsonResponse(JSON.stringify({proposals:[{title:'Only usable idea',summary:'One concept survived.',stops:['Athens','Patras','Athens'],days:7,topology:'loop',themes:['history']}] }))
    return jsonResponse('{malformed completeness retry')
  }
  try{const r=await generateSpark('One week loop from Athens.');assert.equal(calls,5);assert.equal(r.proposals.length,1);assert.equal(r.proposals[0].title,'Athens loop')}finally{globalThis.fetch=prior}
})

test('Spark streams complete validated concepts progressively before the full result finishes',async()=>{
  const prior=globalThis.fetch,enc=new TextEncoder(),seen=[]
  let firstResolve;const firstSeen=new Promise(r=>firstResolve=r)
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body),system=body.messages?.find(m=>m.role==='system')?.content||''
    if(system.includes('Traveler Contract extractor'))return jsonResponse(JSON.stringify({start:'Athens',end:'Athens',topology:'loop'}))
    return new Response(new ReadableStream({start(c){
      const emit=obj=>c.enqueue(enc.encode(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(obj)+'\n'}}]})}\n\n`))
      emit({title:'First',summary:'First complete idea.',stops:['Athens','Patras','Athens'],days:7,topology:'loop',themes:['history']})
      setTimeout(()=>{emit({title:'Second',summary:'Second complete idea.',stops:['Athens','Nafplio','Athens'],days:7,topology:'loop',themes:['coast']});emit({title:'Third',summary:'Third complete idea.',stops:['Athens','Delphi','Athens'],days:7,topology:'loop',themes:['culture']});c.enqueue(enc.encode('data: [DONE]\n\n'));c.close()},25)
    }}),{status:200,headers:{'Content-Type':'text/event-stream'}})
  }
  try{
    const pending=generateSpark('One week loop from Athens.',{onProposal:p=>{seen.push(p.stops.join('>'));if(seen.length===1)firstResolve()}})
    await firstSeen;assert.deepEqual(seen,['Athens>Patras>Athens'])
    const result=await pending;assert.equal(result.proposals.length,3);assert.deepEqual(seen,['Athens>Patras>Athens','Athens>Nafplio>Athens','Athens>Delphi>Athens'])
  }finally{globalThis.fetch=prior}
})

test('document preferences drive deterministic sections and gathered evidence produces real source citations',()=>{
  const a=authorityFromProposal({brief:'Italy',constraints:{start:'Genoa',end:'Rome'},proposal:{stops:['Genoa','Florence','Rome']}}),model=buildMapModel(a,{})
  const preferences={version:1,sections:{route:false,overview:true,stops:true,transport:false,practical:false}},references=[{routeLabel:'Genoa',source:'Wikivoyage',title:'Genoa',url:'http://local/reference/genoa',excerpt:'Genoa has a historic center.'}]
  const text=buildDocumentBaseline(a,model,{preferences,references})
  assert.doesNotMatch(text,/ROUTE AT A GLANCE/);assert.match(text,/## Overview/);assert.match(text,/## Stop-by-stop planning notes/);assert.doesNotMatch(text,/## Transport notes/);assert.match(text,/\[S1\]/);assert.match(text,/## Sources \/ References/);assert.match(text,/Wikivoyage — Genoa/)
})

test('document enrichment cannot keep invented citation markers and stop evidence is tied to the gathered source',async()=>{
  const a=authorityFromProposal({brief:'Italy',constraints:{start:'Genoa',end:'Rome'},proposal:{stops:['Genoa','Rome']}}),model=buildMapModel(a,{})
  const refs=[{routeLabel:'Genoa',source:'Wikivoyage',title:'Genoa',url:'http://local/genoa',excerpt:'Historic port city.'}]
  const prior=globalThis.fetch,enc=new TextEncoder(),prose='## Overview\nAuthority overview.\n\n## Stop-by-stop planning notes\n### 1. Genoa\nHistoric port detail [S99].\n\n### 2. Rome\nAuthority-only planning note.\n\n## Transport notes\nKeep transport neutral.\n\n## Practical preparation\nVerify current details.'
  globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(enc.encode(`data: ${JSON.stringify({choices:[{delta:{content:prose}}]})}\n\n`));c.enqueue(enc.encode('data: [DONE]\n\n'));c.close()}}),{status:200,headers:{'Content-Type':'text/event-stream'}})
  try{const r=await streamDocument(a,model,{references:refs});assert.doesNotMatch(r.text,/\[S99\]/);assert.match(r.text,/Historic port detail.*\[S1\]/);assert.match(r.text,/\[S1\] Wikivoyage — Genoa/);assert.match(r.error,/citation marker/i)}finally{globalThis.fetch=prior}
})


test('hostile: one-way Spark rejects misleading loop titles and unrequested repeated stops',async()=>{
  const prior=globalThis.fetch,contract={start:'Tallinn',end:'Riga',topology:'one_way',duration:{kind:'exact',days:35},scopes:[{kind:'region',label:'Estonia',requiredCoverage:true},{kind:'region',label:'Latvia',requiredCoverage:true},{kind:'region',label:'Lithuania',requiredCoverage:true}],requiredPlaces:[]}
  let call=0
  const validA={title:'Baltic Capitals and Coast',stops:['Tallinn','Tartu','Vilnius','Kaunas','Liepāja','Riga'],days:35,topology:'one_way'}
  const validB={title:'Baltic Culture Route',stops:['Tallinn','Pärnu','Vilnius','Klaipėda','Cēsis','Riga'],days:35,topology:'one_way'}
  const validC={title:'Baltic Cities and Nature',stops:['Tallinn','Tartu','Kaunas','Klaipėda','Kuldīga','Riga'],days:35,topology:'one_way'}
  globalThis.fetch=async(_url,opts)=>{call++;const body=JSON.parse(opts.body),system=body.messages?.[0]?.content||''
    if(system.includes('Return ONE route skeleton'))return jsonResponse(JSON.stringify({title:'Estonia, Latvia, Lithuania Loop',stops:['Tallinn','Vilnius','Tallinn','Riga'],days:35,topology:'loop'}))
    if(system.includes('Stream up to'))return jsonResponse(JSON.stringify({proposals:[validA,validB]}))
    if(system.includes('skeleton completion'))return jsonResponse(JSON.stringify({proposals:[validC]}))
    if(system.includes('You enrich already-validated'))return jsonResponse(JSON.stringify({enrichments:[]}))
    throw new Error('unexpected call '+call)
  }
  try{
    const r=await generateSparkFromContract('Baltic trip',contract)
    assert.equal(r.proposals.length,3);assert.ok(r.rejected.some(x=>x.violations.includes('title-topology-loop-conflict')||x.violations.some(v=>v.startsWith('unconfirmed-repeat:')||v.startsWith('raw-topology:'))))
    assert.ok(r.proposals.every(p=>p.topology==='one_way'&&!/loop/i.test(p.title)))
    assert.ok(r.proposals.every(p=>new Set(p.stops.map(x=>x.toLowerCase())).size===p.stops.length))
  }finally{globalThis.fetch=prior}
})

test('Spark abandons a slow first-route stream at the fast target and continues with bounded alternatives',async()=>{
  const prior=globalThis.fetch,enc=new TextEncoder(),progress=[]
  let call=0
  globalThis.fetch=async(_url,opts)=>{call++;const body=JSON.parse(opts.body),system=body.messages?.find(m=>m.role==='system')?.content||''
    if(system.includes('Return ONE route skeleton'))return new Response(new ReadableStream({start(){/* deliberately never emits; abort signal ends fetch in real runtime */}}),{status:200,headers:{'Content-Type':'text/event-stream'}})
    if(system.includes('Stream up to'))return jsonResponse(JSON.stringify({proposals:[
      {title:'Fast alternative',stops:['Alpha','Beta','Omega'],days:8,topology:'one_way'},
      {title:'Second alternative',stops:['Alpha','Gamma','Omega'],days:8,topology:'one_way'},
      {title:'Third alternative',stops:['Alpha','Delta','Omega'],days:8,topology:'one_way'}
    ]}))
    if(system.includes('You enrich already-validated'))return jsonResponse(JSON.stringify({enrichments:[]}))
    if(system.includes('skeleton completion'))return jsonResponse(JSON.stringify({proposals:[]}))
    throw new Error('unexpected call '+call)
  }
  // The synthetic ReadableStream above does not observe AbortSignal itself, so emulate a
  // fetch implementation that rejects when the request signal aborts.
  globalThis.fetch=async(_url,opts)=>{call++;const body=JSON.parse(opts.body),system=body.messages?.find(m=>m.role==='system')?.content||''
    if(system.includes('Return ONE route skeleton'))return await new Promise((resolve,reject)=>{opts.signal?.addEventListener('abort',()=>reject(opts.signal.reason||new DOMException('Aborted','AbortError')),{once:true})})
    if(system.includes('Stream up to'))return jsonResponse(JSON.stringify({proposals:[
      {title:'Fast alternative',stops:['Alpha','Beta','Omega'],days:8,topology:'one_way'},
      {title:'Second alternative',stops:['Alpha','Gamma','Omega'],days:8,topology:'one_way'},
      {title:'Third alternative',stops:['Alpha','Delta','Omega'],days:8,topology:'one_way'}
    ]}))
    if(system.includes('You enrich already-validated'))return jsonResponse(JSON.stringify({enrichments:[]}))
    if(system.includes('skeleton completion'))return jsonResponse(JSON.stringify({proposals:[]}))
    throw new Error('unexpected call '+call)
  }
  try{
    const started=Date.now(),r=await generateSparkFromContract('Alpha to Omega',{start:'Alpha',end:'Omega',topology:'one_way',duration:{kind:'exact',days:8}},{firstIdeaTargetMs:35,onProgress:x=>progress.push(x)})
    assert.equal(r.proposals.length,3);assert.ok(Date.now()-started<1000);assert.ok(progress.some(x=>/fast target/i.test(x)))
  }finally{globalThis.fetch=prior}
})
