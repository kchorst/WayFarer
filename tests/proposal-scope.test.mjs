import test from 'node:test'
import assert from 'node:assert/strict'
import { validateProposalScopeGeography } from '../public/core/proposalScope.js'

function response(results){return{ok:true,async json(){return{results}}}}
function fakeGeocoder(table){return async url=>{const q=new URL(url,'http://x').searchParams.get('q');return response(table[q]||[])}}

test('Spark geographic-scope validation rejects an off-island Corsica stop while allowing Corsican stops',async()=>{
  const fetchImpl=fakeGeocoder({
    'Corsica':[{label:'Corse, France',lat:42.1,lon:9.0,countryCode:'FR'}],
    'Ajaccio':[{label:'Ajaccio, Corse-du-Sud, Corse, France',lat:41.9,lon:8.7,countryCode:'FR'}],
    'Bastia':[{label:'Bastia, Haute-Corse, Corse, France',lat:42.7,lon:9.4,countryCode:'FR'}],
    'Saint-Tropez':[{label:'Saint-Tropez, Var, Provence-Alpes-Côte d’Azur, France',lat:43.2,lon:6.6,countryCode:'FR'}],
  })
  const contract={scopes:[{kind:'region',label:'Corsica'}]}
  assert.equal((await validateProposalScopeGeography({stops:['Ajaccio','Bastia']},contract,{fetchImpl})).ok,true)
  const bad=await validateProposalScopeGeography({stops:['Ajaccio','Saint-Tropez','Bastia']},contract,{fetchImpl})
  assert.equal(bad.ok,false);assert.match(bad.reason,/Saint-Tropez/)
})

test('scope evidence learns local-language region names instead of requiring the English scope token',async()=>{
  const fetchImpl=fakeGeocoder({
    'Sicily':[{label:'Sicilia, Italia',lat:37.5,lon:14.0,countryCode:'IT'}],
    'Palermo':[{label:'Palermo, Sicilia, Italia',lat:38.1,lon:13.3,countryCode:'IT'}],
    'Catania':[{label:'Catania, Sicilia, Italia',lat:37.5,lon:15.1,countryCode:'IT'}],
  })
  const result=await validateProposalScopeGeography({stops:['Palermo','Catania']},{scopes:[{kind:'region',label:'Sicily'}]},{fetchImpl})
  assert.equal(result.ok,true)
})

test('confirmed geographic scope remains visible but unverified/non-adoptable when local evidence is unavailable',async()=>{
  const result=await validateProposalScopeGeography({stops:['Unknown Town']},{scopes:[{kind:'region',label:'Some Region',requiredCoverage:true}]},{fetchImpl:async()=>response([])})
  assert.equal(result.ok,true);assert.equal(result.verified,false);assert.ok(result.advisories.some(x=>x.code==='SPARK_SCOPE_UNVERIFIED'))
})

test('multi-area Spark scope requires visible coverage of every confirmed destination area',async()=>{
  const fetchImpl=fakeGeocoder({
    'Sardinia':[{label:'Sardegna, Italia',lat:40.1,lon:9.0,countryCode:'IT'}],
    'Corsica':[{label:'Corse, France',lat:42.1,lon:9.0,countryCode:'FR'}],
    'Cagliari':[{label:'Cagliari, Sardegna, Italia',lat:39.2,lon:9.1,countryCode:'IT'}],
    'Ajaccio':[{label:'Ajaccio, Corse-du-Sud, Corse, France',lat:41.9,lon:8.7,countryCode:'FR'}],
  })
  const contract={scopes:[{kind:'region',label:'Sardinia',requiredCoverage:true},{kind:'region',label:'Corsica',requiredCoverage:true}]}
  assert.equal((await validateProposalScopeGeography({stops:['Cagliari','Ajaccio']},contract,{fetchImpl})).ok,true)
  const bad=await validateProposalScopeGeography({stops:['Cagliari']},contract,{fetchImpl})
  assert.equal(bad.ok,false);assert.match(bad.reason,/Corsica/)
})


test('scope aliases that resolve to the same broad entity are rejected as route stops',async()=>{
  const fetchImpl=fakeGeocoder({
    'Sardinia':[{label:'Sardegna, Italia',lat:40.120,lon:9.010,countryCode:'IT'}],
    'Sardegna':[{label:'Sardegna, Italia',lat:40.120,lon:9.010,countryCode:'IT'}],
    'Cagliari':[{label:'Cagliari, Sardegna, Italia',lat:39.223,lon:9.121,countryCode:'IT'}],
  })
  const result=await validateProposalScopeGeography({stops:['Cagliari','Sardegna']},{scopes:[{kind:'island',label:'Sardinia',requiredCoverage:true}]},{fetchImpl})
  assert.equal(result.ok,false);assert.match(result.reason,/broad destination area/)
})

test('explicit start/end anchors participate in hard geographic coverage verification',async()=>{
  const contract={start:'Cagliari',end:'Ajaccio',scopes:[{kind:'region',label:'Sardinia',requiredCoverage:true},{kind:'region',label:'Corsica',requiredCoverage:true}]}
  const unavailable=async()=>{throw new Error('offline')}
  const result=await validateProposalScopeGeography({stops:['Cagliari','Ajaccio']},contract,{fetchImpl:unavailable})
  assert.equal(result.ok,true);assert.equal(result.verified,false);assert.equal(result.status,'UNVERIFIED')
})

test('country scope identity does not accept a same-named state in another country',async()=>{
  const fetchImpl=fakeGeocoder({
    'Georgia':[{label:'Georgia',lat:42.3,lon:43.4,countryCode:'GE'}],
    'Tbilisi':[{label:'Tbilisi, Georgia',lat:41.72,lon:44.79,countryCode:'GE'}],
    'Atlanta':[{label:'Atlanta, Georgia, United States',lat:33.75,lon:-84.39,countryCode:'US'}],
  })
  const result=await validateProposalScopeGeography({stops:['Tbilisi','Atlanta']},{scopes:[{kind:'country',label:'Georgia',requiredCoverage:true}]},{fetchImpl})
  assert.equal(result.ok,false);assert.equal(result.status,'CONTRADICTED');assert.match(result.reason,/Atlanta/)
})
