import test from 'node:test'
import assert from 'node:assert/strict'
import { proposalInvariantViolations, rawProposalContractViolations, proposalInvariantMatrixCases, titleTopologyClaims } from '../public/core/proposalPolicy.js'

const variants=[
  ['A','B','C','D'],
  ['Northport','Lakeview','Hilltown','Southport'],
  ['青森','弘前','盛岡','仙台'],
]
const relabel=(obj,names)=>JSON.parse(JSON.stringify(obj).replaceAll('"A"',JSON.stringify(names[0])).replaceAll('"B"',JSON.stringify(names[1])).replaceAll('"C"',JSON.stringify(names[2])).replaceAll('"D"',JSON.stringify(names[3])))

test('property gate: every structural invariant matrix case holds across at least three unrelated label sets',()=>{
  for(const base of proposalInvariantMatrixCases())for(const names of variants){
    const c=relabel(base.constraints,names),p=relabel(base.proposal,names),violations=proposalInvariantViolations(p,c)
    assert.equal(violations.length===0,base.ok,`${base.name} / ${names.join(',')} -> ${violations.join(',')}`)
  }
})

test('mutation gate: valid one-way, loop, duration, required/excluded and scope cases are independently falsified',()=>{
  const base={title:'Coastal journey',topology:'one_way',stops:['Alpha','Beta','Gamma','Omega'],days:12}
  const contract={topology:'one_way',start:'Alpha',end:'Omega',duration:{kind:'exact',days:12},requiredPlaces:['Beta'],excludedPlaces:['Xray'],scopes:[{kind:'region',label:'Region Z'}]}
  assert.deepEqual(proposalInvariantViolations(base,contract),[])
  const mutations=[
    {...base,title:'Grand Loop'},
    {...base,topology:'loop'},
    {...base,stops:['Alpha','Beta','Alpha','Omega']},
    {...base,stops:['Alpha','Region Z','Beta','Omega']},
    {...base,stops:['Alpha','Gamma','Omega']},
    {...base,stops:['Alpha','Beta','Xray','Omega']},
    {...base,days:13},
  ]
  for(const p of mutations)assert.ok(proposalInvariantViolations(p,contract).length>0,JSON.stringify(p))
})

test('title topology parser uses real word boundaries and rejects misleading presentation',()=>{
  assert.equal(titleTopologyClaims('Baltic Loop Adventure').claimsLoop,true)
  assert.equal(titleTopologyClaims('Point-to-point coast').claimsOneWay,true)
  assert.equal(titleTopologyClaims('Loophole museums').claimsLoop,false)
})

test('raw candidate preflight rejects model repair cases before normalization',()=>{
  const contract={topology:'one_way',start:'Tallinn',end:'Riga',duration:{kind:'exact',days:35},requiredPlaces:[],excludedPlaces:[],scopes:[{kind:'country',label:'Estonia'},{kind:'country',label:'Latvia'}]}
  const bad={title:'Baltic Loop',topology:'loop',days:21,stops:[{label:'Tallinn',kind:'settlement'},{label:'Estonia',kind:'country'},{label:'Riga',kind:'settlement'}]}
  const v=rawProposalContractViolations(bad,contract)
  assert.ok(v.some(x=>x.startsWith('raw-topology:')))
  assert.ok(v.some(x=>x.startsWith('raw-duration')))
  assert.ok(v.some(x=>x.startsWith('non-route-kind:')||x.startsWith('scope-as-stop:')))
})


test('raw preflight rejects missing confirmed semantics and broad administrative/POI route roles',()=>{
  const contract={topology:'one_way',start:'Alpha',end:'Omega',duration:{kind:'exact',days:12},scopes:[{kind:'country',label:'Country X'}]}
  const missing={title:'Journey',stops:[{label:'Alpha',kind:'settlement'},{label:'Beta',kind:'settlement'},{label:'Omega',kind:'settlement'}]}
  const mv=rawProposalContractViolations(missing,contract)
  assert.ok(mv.includes('raw-topology-missing'))
  assert.ok(mv.includes('raw-duration-missing'))
  for(const kind of ['province','state','territory','prefecture','district','archipelago','poi','landmark']){
    const raw={title:'Journey',topology:'one_way',days:12,stops:[{label:'Alpha',kind:'settlement'},{label:'Broad Place',kind},{label:'Omega',kind:'settlement'}]}
    assert.ok(rawProposalContractViolations(raw,contract).some(x=>x.startsWith('non-route-kind:')),kind)
  }
})

test('title contradiction parser catches return/back phrasings, not only the word loop',()=>{
  for(const title of ['Return to Paris','Paris there and back','Paris to London and back','Out and back highlights'])assert.equal(titleTopologyClaims(title).claimsLoop,true,title)
})

test('POI and landmark route roles require explicit occurrence intent instead of being globally forbidden',()=>{
  const base={title:'Journey',topology:'one_way',days:5,stops:[{label:'Taipei',kind:'settlement'},{label:'Taroko Gorge',kind:'landmark'},{label:'Tainan',kind:'settlement'}]}
  const c={topology:'one_way',start:'Taipei',end:'Tainan',duration:{kind:'exact',days:5},requiredPlaces:['Taroko Gorge']}
  assert.equal(rawProposalContractViolations(base,c).some(x=>x.startsWith('non-route-kind:')),false)
  const unowned={...base,stops:[{label:'Taipei',kind:'settlement'},{label:'Random Viewpoint',kind:'landmark'},{label:'Tainan',kind:'settlement'}]}
  assert.equal(rawProposalContractViolations(unowned,c).some(x=>x.startsWith('non-route-kind:')),true)
})
