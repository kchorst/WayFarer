import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveTripBasics, basicsToConstraintPatch, mergeContractWithBasics, contractFingerprint, validateBasics } from '../public/core/tripBasics.js'

test('Trip Basics recognizes the Shikoku pilgrimage without pretending suggestions came from the traveler',()=>{
  const b=deriveTripBasics('I heard about a walk or trek in Japan. something like a Shikoku route.')
  assert.equal(b.recognizedTrip.name,'Shikoku 88-Temple Pilgrimage')
  assert.equal(b.destination.value,'Shikoku, Japan');assert.equal(b.destination.status,'suggested')
  assert.equal(b.start.value,'Temple 1 — Ryōzenji');assert.equal(b.start.source,'route_convention');assert.equal(b.start.status,'suggested')
  assert.equal(b.end.value,'Temple 88 — Ōkuboji');assert.equal(b.end.source,'route_convention');assert.equal(b.end.status,'suggested')
  assert.equal(b.duration.status,'open');assert.equal(b.recognizedTrip.contextOptions[0].label,'Return to Temple 1 after Temple 88')
  const beforeConfirmation=basicsToConstraintPatch(b,{confirmed:false})
  assert.equal(beforeConfirmation.start,undefined);assert.equal(beforeConfirmation.end,undefined)
  const confirmed=basicsToConstraintPatch(b,{confirmed:true})
  assert.equal(confirmed.start,'Temple 1 — Ryōzenji');assert.equal(confirmed.end,'Temple 88 — Ōkuboji')
})


test('Trip Basics preserves multiple destination areas as separate required coverage scopes',()=>{
  const b=deriveTripBasics('Plan a trip for me for 3 weeks around Sardinia and Corsica.')
  assert.equal(b.destination.value,'Sardinia + Corsica');assert.deepEqual(b.destination.areas,['Sardinia','Corsica']);assert.equal(b.duration.parsed.days,21)
  const c=mergeContractWithBasics({scopes:[{kind:'country',label:'Italy'},{kind:'country',label:'France'}]},b,{confirmed:true})
  assert.deepEqual(c.scopes.map(x=>x.label),['Sardinia','Corsica']);assert.ok(c.scopes.every(x=>x.requiredCoverage===true))
})

test('Trip Basics extracts a Sicily loop, leaves its unknown gateway open, and preserves three weeks',()=>{
  const b=deriveTripBasics('I have three weeks to do a loop tour of Sicily.')
  assert.equal(b.destination.value,'Sicily');assert.equal(b.duration.parsed.days,21);assert.equal(b.topology.value,'loop')
  assert.equal(b.start.status,'open');assert.equal(b.end.status,'open');assert.equal(b.end.linkedTo,'start')
  const c=mergeContractWithBasics({},b,{confirmed:true})
  assert.equal(c.start,undefined);assert.equal(c.end,undefined);assert.equal(c.topology,'loop');assert.equal(c.duration.days,21)
})

test('Trip Basics understands explicit same loop boundary and one-way boundaries',()=>{
  const sicily=deriveTripBasics('I have three weeks to do a loop tour of Sicily. Start and finish in Palermo.')
  assert.equal(sicily.start.value,'Palermo');assert.equal(sicily.end.value,'Palermo');assert.equal(sicily.topology.value,'loop')
  const crete=deriveTripBasics('I want a loop of Crete.')
  assert.equal(crete.destination.value,'Crete');assert.equal(crete.topology.value,'loop');assert.equal(crete.start.status,'open')
  const oneWay=deriveTripBasics('I want a one way from Paris to London.')
  assert.equal(oneWay.start.value,'Paris');assert.equal(oneWay.end.value,'London');assert.equal(oneWay.topology.value,'one_way')
})

test('Open Trip Basics are a valid traveler choice rather than an extraction failure',()=>{
  const b=deriveTripBasics('I want to imagine a trip somewhere warm.')
  assert.equal(validateBasics(b).length,0)
  const patch=basicsToConstraintPatch(b,{confirmed:true})
  assert.equal(patch.start,undefined);assert.equal(patch.end,undefined);assert.equal(patch.duration,undefined)
})

test('changing a confirmed Trip Basic changes the contract fingerprint so stale speculative ideas cannot be reused',()=>{
  const b=deriveTripBasics('One way from Paris to London.')
  const first=mergeContractWithBasics({},b,{confirmed:true}),firstKey=contractFingerprint(first)
  const changed=structuredClone(b);changed.start={value:'Lyon',source:'traveler',status:'confirmed',note:''}
  const second=mergeContractWithBasics({},changed,{confirmed:true})
  assert.notEqual(contractFingerprint(second),firstKey)
  assert.equal(second.start,'Lyon');assert.equal(second.end,'London')
})

test('Trip Basics stops boundary parsing at a new traveler instruction while preserving qualified-place commas',()=>{
  const italy=deriveTripBasics('One month around Italy, start and end in Genoa, include Sicily and Bologna, and I prefer buses.')
  assert.equal(italy.destination.value,'Italy')
  assert.equal(italy.start.value,'Genoa');assert.equal(italy.end.value,'Genoa');assert.equal(italy.topology.value,'loop')
  const springfield=deriveTripBasics('Start and finish in Springfield, Missouri, include Branson.')
  assert.equal(springfield.start.value,'Springfield, Missouri');assert.equal(springfield.end.value,'Springfield, Missouri')
})

test('confirmed Open Trip Basics clear hidden extractor guesses instead of silently hardening them',()=>{
  const crete=deriveTripBasics('I want a loop of Crete.')
  const extracted={start:'Heraklion',end:'Heraklion',topology:'loop',duration:{kind:'exact',days:14},scopes:[{kind:'island',label:'Crete'}],requiredPlaces:[]}
  const c=mergeContractWithBasics(extracted,crete,{confirmed:true})
  assert.equal(c.start,undefined);assert.equal(c.end,undefined);assert.equal(c.duration,undefined)
  assert.equal(c.topology,'loop');assert.ok(c.scopes.some(x=>x.label==='Crete'))

  const vague=deriveTripBasics('I want to imagine a trip somewhere warm.')
  const hiddenGuess=mergeContractWithBasics({start:'Lisbon',end:'Lisbon',topology:'loop',duration:{kind:'exact',days:7},scopes:[{kind:'region',label:'Portugal'}]},vague,{confirmed:true})
  assert.equal(hiddenGuess.start,undefined);assert.equal(hiddenGuess.end,undefined);assert.equal(hiddenGuess.topology,undefined);assert.equal(hiddenGuess.duration,undefined);assert.deepEqual(hiddenGuess.scopes,[])
})

test('route-convention recognition is data driven rather than a geography-specific parser branch',async()=>{
  const { findRouteConvention }=await import('../public/core/routeConventions.js')
  const catalog=[{id:'sample-trail',aliases:['sample trail'],contextAny:['walk','trail'],name:'Sample Trail',destination:'Sampleland',start:'Gate A',end:'Gate B',topology:'one_way'}]
  const hit=findRouteConvention('I heard about a walk called the Sample Trail.',catalog)
  assert.equal(hit?.name,'Sample Trail');assert.equal(hit?.start,'Gate A');assert.equal(hit?.end,'Gate B')
  assert.equal(findRouteConvention('I am visiting Sampleland.',catalog),null)
})

test('hostile: Baltic open-jaw prompt keeps countries as coverage scopes and parses natural arrive/depart clauses',()=>{
  const prompt='i will arrive Tallinn and I will depart from Riga. I have 5 weeks to see Estonia, Latvia, and Lithuania. Suggest some itineraries.'
  const b=deriveTripBasics(prompt)
  assert.equal(b.start.value,'Tallinn');assert.equal(b.end.value,'Riga');assert.equal(b.topology.value,'one_way');assert.equal(b.duration.parsed.days,35)
  assert.deepEqual(b.destination.areas,['Estonia','Latvia','Lithuania'])
  const c=mergeContractWithBasics({start:'Tallinn',end:'Riga',topology:'one_way',duration:{kind:'exact',days:35},requiredPlaces:['Estonia','Latvia','Lithuania']},b,{confirmed:true})
  assert.deepEqual(c.scopes.map(x=>x.label),['Estonia','Latvia','Lithuania']);assert.ok(c.scopes.every(x=>x.requiredCoverage===true))
  assert.deepEqual(c.requiredPlaces,[])
})

test('hostile: natural arrive/depart clauses do not require a repeated pronoun',()=>{
  const b=deriveTripBasics('I will arrive Lisbon and depart Madrid. I have 12 days to see Portugal and Spain. Suggest itineraries.')
  assert.equal(b.start.value,'Lisbon');assert.equal(b.end.value,'Madrid');assert.equal(b.topology.value,'one_way');assert.equal(b.duration.parsed.days,12)
  assert.deepEqual(b.destination.areas,['Portugal','Spain'])
})

test('country-list parsing handles no Oxford comma without splitting qualified city names',()=>{
  const baltic=deriveTripBasics('I will arrive Tallinn and depart Riga. I have five weeks to see Estonia, Latvia and Lithuania.')
  assert.deepEqual(baltic.destination.areas,['Estonia','Latvia','Lithuania'])
  const c=mergeContractWithBasics({},baltic,{confirmed:true})
  assert.deepEqual(c.scopes.map(x=>[x.kind,x.label]),[['country','Estonia'],['country','Latvia'],['country','Lithuania']])
  const qualified=deriveTripBasics('I want to see Springfield, Missouri and St. Louis.')
  assert.deepEqual(qualified.destination.areas,['Springfield, Missouri and St. Louis'])
})

test('global holdouts: ordinary arrival, duration, and destination grammar stays geography-independent',()=>{
  const cases=[
    ['I arrive in Palma and have two weeks to tour Mallorca. Give me a sample itinerary.','Palma','Mallorca',14],
    ['Arriving in Funchal, I have 10 days to tour Madeira.','Funchal','Madeira',10],
    ['Beginning in Sapporo, spend two weeks exploring Hokkaido.','Sapporo','Hokkaido',14],
    ['I have a week to tour Puerto Rico.','','Puerto Rico',7],
    ['Arriving in Hobart, spend 12 days exploring Tasmania.','Hobart','Tasmania',12],
    ['I have three weeks to tour Rwanda.','','Rwanda',21],
  ]
  for(const [prompt,start,destination,days] of cases){
    const b=deriveTripBasics(prompt)
    assert.equal(b.start.value,start,prompt)
    assert.equal(b.destination.value,destination,prompt)
    assert.equal(b.duration.parsed?.days,days,prompt)
  }
})
