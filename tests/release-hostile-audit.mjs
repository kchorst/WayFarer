import assert from 'node:assert/strict'
import { proposalInvariantViolations, rawProposalContractViolations, titleTopologyClaims } from '../public/core/proposalPolicy.js'
import { samePlace, placeMatchKey } from '../public/core/authority.js'
import { validateProposalScopeGeography } from '../public/core/proposalScope.js'
import { deriveTripBasics, basicsToConstraintPatch, splitDestinationAreas } from '../public/core/tripBasics.js'

// RELEASE MANAGER HOSTILE AUDIT
// This file intentionally owns its own simple oracle. It does not reuse the product's
// acceptance helpers to decide the expected answer.
const failures=[]
const check=(cond,msg)=>{if(!cond)failures.push(msg)}
const eq=(a,b,msg)=>check(Object.is(a,b),`${msg}: expected ${b}, got ${a}`)

const boundary=(s='')=>String(s).trim().toLocaleLowerCase('en-US')
const titleClaims=t=>{
  const s=String(t||'').toLowerCase()
  return{loop:/(?:^|[^a-z0-9])(?:loop|round[ -]?trip|circuit|circular)(?=$|[^a-z0-9])/.test(s),oneWay:/(?:^|[^a-z0-9])(?:one[ -]?way|point[ -]?to[ -]?point)(?=$|[^a-z0-9])/.test(s)}
}
function oracleValid(p,c){
  const stops=(p.stops||[]).map(String),top=p.topology
  if(stops.length<2)return false
  if(c.start&&boundary(stops[0])!==boundary(c.start))return false
  if(c.end&&boundary(stops.at(-1))!==boundary(c.end))return false
  if(c.topology&&top!==c.topology)return false
  if(top==='loop'&&boundary(stops[0])!==boundary(stops.at(-1)))return false
  if((top==='one_way'||top==='open_jaw')&&boundary(stops[0])===boundary(stops.at(-1)))return false
  const seen=new Set()
  for(let i=0;i<stops.length;i++){
    const k=boundary(stops[i]),closure=top==='loop'&&i===stops.length-1&&k===boundary(stops[0])
    if(seen.has(k)&&!closure)return false
    seen.add(k)
  }
  const claims=titleClaims(p.title)
  if(top!=='loop'&&claims.loop)return false
  if(top==='loop'&&claims.oneWay)return false
  const scopes=new Set((c.scopes||[]).map(x=>boundary(typeof x==='string'?x:x.label)))
  if(stops.some(x=>scopes.has(boundary(x))))return false
  if((c.requiredPlaces||[]).some(x=>!stops.some(y=>boundary(x)===boundary(y))))return false
  if((c.excludedPlaces||[]).some(x=>stops.some(y=>boundary(x)===boundary(y))))return false
  if(c.duration?.kind==='exact'&&Number(p.days)!==Number(c.duration.days))return false
  if(c.duration?.kind==='range'&&(Number(p.days)<Number(c.duration.minDays)||Number(p.days)>Number(c.duration.maxDays)))return false
  return true
}

// Deterministic generated mutation matrix: unrelated labels/topologies/durations/scopes.
const nameSets=[
  ['Alpha','Beta','Gamma','Omega'],
  ['Port North','Lake Town','Hill City','Port South'],
  ['青森','弘前','盛岡','仙台'],
  ['Québec','Trois-Rivières','Montréal','Ottawa'],
]
let generated=0
for(const names of nameSets){
  for(const topology of ['loop','one_way','open_jaw','flexible']){
    const [a,b,c,d]=names,loop=topology==='loop',end=loop?a:d
    const contract={topology,start:a,end,duration:{kind:'exact',days:12},requiredPlaces:[b],excludedPlaces:['Forbidden'],scopes:[{kind:'region',label:'Scope Land'}]}
    const base={title:loop?'Regional circuit':'Regional journey',topology,stops:loop?[a,b,c,a]:[a,b,c,d],days:12}
    const mutations=[
      base,
      {...base,title:'Grand Loop'},
      {...base,topology:loop?'one_way':'loop'},
      {...base,stops:loop?[a,b,c]:[a,b,a,d]},
      {...base,stops:loop?[a,'Scope Land',c,a]:[a,'Scope Land',c,d]},
      {...base,stops:loop?[a,c,a]:[a,c,d]},
      {...base,days:9},
    ]
    for(const p of mutations){
      const expected=oracleValid(p,contract),actual=proposalInvariantViolations(p,contract).length===0
      check(actual===expected,`generated invariant mismatch ${JSON.stringify({names,topology,p,expected,violations:proposalInvariantViolations(p,contract)})}`)
      generated++
    }
  }
}

// Route-length and duration-range variation is independent of the named regression cases.
for(const interiorCount of [0,1,3,6]){
  const interior=Array.from({length:interiorCount},(_,i)=>`Mid ${i+1}`)
  for(const topology of ['one_way','open_jaw','flexible','loop']){
    const end=topology==='loop'?'Origin':'Destination'
    const stops=['Origin',...interior,end]
    const contract={topology,start:'Origin',end,duration:{kind:'range',minDays:10,maxDays:14},scopes:[{kind:'region',label:'Scope Y'}]}
    const base={title:topology==='loop'?'Regional circuit':'Regional journey',topology,stops,days:12}
    const expected=oracleValid(base,contract),actual=proposalInvariantViolations(base,contract).length===0
    check(actual===expected,`route-length invariant mismatch ${interiorCount}/${topology}`)
    generated++
    const tooShort={...base,days:9};check(proposalInvariantViolations(tooShort,contract).some(x=>x==='duration-range'),`duration range lower bound missed ${interiorCount}/${topology}`);generated++
    const tooLong={...base,days:15};check(proposalInvariantViolations(tooLong,contract).some(x=>x==='duration-range'),`duration range upper bound missed ${interiorCount}/${topology}`);generated++
  }
}

// Seeded property fuzzing attacks combinations not named in the implementation.
let seed=0x5a17c0de
const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000}
const pick=xs=>xs[Math.floor(rnd()*xs.length)]
for(let caseNo=0;caseNo<256;caseNo++){
  const topology=pick(['loop','one_way','open_jaw','flexible']),count=2+Math.floor(rnd()*6)
  const mids=Array.from({length:Math.max(0,count-2)},(_,i)=>`F${caseNo}-M${i}`),start=`F${caseNo}-A`,finish=topology==='loop'?start:`F${caseNo}-Z`
  const stops=[start,...mids,finish],contract={topology,start,end:finish,duration:{kind:'range',minDays:5,maxDays:20},scopes:[{kind:'region',label:`F${caseNo}-Scope`}]}
  let p={title:topology==='loop'?'Scenic circuit':'Scenic route',topology,stops,days:5+Math.floor(rnd()*16)}
  const mutation=Math.floor(rnd()*7)
  if(mutation===1)p={...p,title:'Grand Loop'}
  if(mutation===2&&p.stops.length>2)p={...p,stops:[p.stops[0],p.stops[1],p.stops[0],...p.stops.slice(2)]}
  if(mutation===3)p={...p,stops:[p.stops[0],contract.scopes[0].label,...p.stops.slice(1)]}
  if(mutation===4)p={...p,topology:topology==='loop'?'one_way':'loop'}
  if(mutation===5)p={...p,days:21}
  if(mutation===6)p={...p,stops:[`Wrong-${caseNo}`,...p.stops.slice(1)]}
  const expected=oracleValid(p,contract),actual=proposalInvariantViolations(p,contract).length===0
  check(actual===expected,`seeded property mismatch case ${caseNo}: ${JSON.stringify({p,contract,expected,violations:proposalInvariantViolations(p,contract)})}`)
  generated++
}

// Raw-model candidates must be rejected before any normalizer can cosmetically repair them.
const rawBad={title:'Country Loop',topology:'loop',days:7,stops:[{label:'Start',kind:'settlement'},{label:'Country X',kind:'country'},{label:'Finish',kind:'settlement'}]}
const rawContract={topology:'one_way',start:'Start',end:'Finish',duration:{kind:'exact',days:14},scopes:[{kind:'country',label:'Country X'}]}
check(rawProposalContractViolations(rawBad,rawContract).length>=3,'raw preflight failed to reject multiple independent contract contradictions')
check(titleTopologyClaims('Grand Loop').claimsLoop===true,'loop title claim parser failed')
check(titleTopologyClaims('Loophole route').claimsLoop===false,'title parser used substring instead of word boundary')

// Confirmed structure may not be silently synthesized when the model omits it, and
// broad geography/POI roles may not enter the route spine under alternate kind names.
const missingSemantics={title:'Journey',stops:[{label:'Start',kind:'settlement'},{label:'Finish',kind:'settlement'}]}
const missingViolations=rawProposalContractViolations(missingSemantics,rawContract)
check(missingViolations.includes('raw-topology-missing'),'raw preflight allowed missing confirmed topology')
check(missingViolations.includes('raw-duration-missing'),'raw preflight allowed missing confirmed duration')
for(const kind of ['province','state','territory','prefecture','district','archipelago','poi','landmark']){
  const raw={title:'Journey',topology:'one_way',days:14,stops:[{label:'Start',kind:'settlement'},{label:'Broad Place',kind},{label:'Finish',kind:'settlement'}]}
  check(rawProposalContractViolations(raw,rawContract).some(x=>x.startsWith('non-route-kind:')),`raw preflight allowed non-route kind ${kind}`)
}

// Unicode identity must be a first-class invariant, not Latin-only behavior.
for(const label of ['青森','서울','Αθήνα','Київ','São Paulo']){
  check(Boolean(placeMatchKey(label)),`place identity empty for ${label}`)
  check(samePlace(label,label),`samePlace failed reflexivity for ${label}`)
}

const response=results=>({ok:true,async json(){return{results}}})
const fake=table=>async url=>{const q=new URL(url,'http://audit').searchParams.get('q');const v=table[q];if(v instanceof Error)throw v;return response(v||[])}
const scopeAudits=[
  {
    name:'island-local-language-alias',
    contract:{scopes:[{kind:'island',label:'Sardinia',requiredCoverage:true}]},proposal:{stops:['Cagliari','Sardegna']},
    table:{Sardinia:[{label:'Sardegna, Italia',lat:40.12,lon:9.01,countryCode:'IT'}],Cagliari:[{label:'Cagliari, Sardegna, Italia',lat:39.22,lon:9.12,countryCode:'IT'}],Sardegna:[{label:'Sardegna, Italia',lat:40.12,lon:9.01,countryCode:'IT'}]},expected:false,
  },
  {
    name:'multi-country-covered',
    contract:{scopes:[{kind:'country',label:'Portugal',requiredCoverage:true},{kind:'country',label:'Spain',requiredCoverage:true}]},proposal:{stops:['Lisbon','Madrid']},
    table:{Portugal:[{label:'Portugal',lat:39.5,lon:-8,countryCode:'PT'}],Spain:[{label:'Spain',lat:40.4,lon:-3.7,countryCode:'ES'}],Lisbon:[{label:'Lisbon, Portugal',lat:38.72,lon:-9.14,countryCode:'PT'}],Madrid:[{label:'Madrid, Spain',lat:40.42,lon:-3.7,countryCode:'ES'}]},expected:true,
  },
  {
    name:'confirmed-scope-unverifiable',
    contract:{scopes:[{kind:'region',label:'Madeira',requiredCoverage:true}]},proposal:{stops:['Funchal','Mystery']},
    table:{Madeira:[{label:'Madeira, Portugal',lat:32.76,lon:-16.96,countryCode:'PT'}],Funchal:[{label:'Funchal, Madeira, Portugal',lat:32.65,lon:-16.91,countryCode:'PT'}],Mystery:[]},expected:true,verified:false,
  },
]
for(const x of scopeAudits){const r=await validateProposalScopeGeography(x.proposal,x.contract,{fetchImpl:fake(x.table)});eq(r.ok,x.expected,`scope audit ${x.name}`);if(Object.prototype.hasOwnProperty.call(x,'verified'))eq(r.verified,x.verified,`scope verification state ${x.name}`)}

// Independent falsifications for defects that escaped the previous READY oracle.
const explicitOffline=await validateProposalScopeGeography({stops:['Cagliari','Ajaccio']},{start:'Cagliari',end:'Ajaccio',scopes:[{kind:'region',label:'Sardinia',requiredCoverage:true},{kind:'region',label:'Corsica',requiredCoverage:true}]},{fetchImpl:async()=>{throw new Error('offline')}})
check(explicitOffline.ok===true&&explicitOffline.verified===false&&explicitOffline.status==='UNVERIFIED','explicit-boundary route silently passed when geography was unavailable')
const georgia=await validateProposalScopeGeography({stops:['Tbilisi','Atlanta']},{scopes:[{kind:'country',label:'Georgia',requiredCoverage:true}]},{fetchImpl:fake({Georgia:[{label:'Georgia',lat:42.3,lon:43.4,countryCode:'GE'}],Tbilisi:[{label:'Tbilisi, Georgia',lat:41.72,lon:44.79,countryCode:'GE'}],Atlanta:[{label:'Atlanta, Georgia, United States',lat:33.75,lon:-84.39,countryCode:'US'}]})})
check(georgia.ok===false&&georgia.status==='CONTRADICTED','country Georgia was incorrectly satisfied by a US state result')
check(JSON.stringify(splitDestinationAreas('Estonia, Latvia and Lithuania'))===JSON.stringify(['Estonia','Latvia','Lithuania']),'no-Oxford country list was not split')
check(JSON.stringify(splitDestinationAreas('Springfield, Missouri and St. Louis'))===JSON.stringify(['Springfield, Missouri and St. Louis']),'qualified city list was over-split')
const poiContract={topology:'one_way',start:'Taipei',end:'Tainan',duration:{kind:'exact',days:5},requiredPlaces:['Taroko Gorge']}
const poiRaw={topology:'one_way',days:5,stops:[{label:'Taipei',kind:'settlement'},{label:'Taroko Gorge',kind:'landmark'},{label:'Tainan',kind:'settlement'}]}
check(!rawProposalContractViolations(poiRaw,poiContract).some(x=>x.startsWith('non-route-kind:')),'traveler-owned landmark route occurrence was incorrectly forbidden')
for(const title of ['Return to Paris','Paris there and back','Paris to London and back'])check(titleTopologyClaims(title).claimsLoop===true,`title contradiction phrase was missed: ${title}`)

// Natural-language boundary parsing is probed with unrelated syntax, not the known Baltic prompt.
const prompts=[
  ['I will arrive Lisbon and depart Madrid. I have 12 days to see Portugal and Spain.','Lisbon','Madrid'],
  ['We will arrive Kyoto and we will leave from Tokyo. Two weeks.','Kyoto','Tokyo'],
  ['I enter Québec City and then depart Montréal. 8 days.','Québec City','Montréal'],
]
for(const [prompt,start,end] of prompts){const b=deriveTripBasics(prompt),patch=basicsToConstraintPatch(b,{confirmed:true});eq(patch.start,start,`boundary start ${prompt}`);eq(patch.end,end,`boundary end ${prompt}`)}

if(failures.length){
  console.error(`HOSTILE RELEASE AUDIT FAIL — ${failures.length} finding(s)`)
  for(const f of failures)console.error(`- ${f}`)
  process.exit(1)
}
console.log(`HOSTILE RELEASE AUDIT PASS — ${generated} generated semantic mutations + independent geography/identity/parser/route-role falsifications + ${prompts.length} unrelated boundary prompts.`)
