import { samePlace, placeMatchKey } from './authority.js'

const clean=v=>String(v??'').trim()
const scopeLabel=s=>clean(typeof s==='string'?s:s?.label)
export const scopeKeys=constraints=>new Set((constraints?.scopes||[]).map(scopeLabel).map(placeMatchKey).filter(Boolean))

const LOOP_WORDS=/(?:^|[^\p{L}\p{N}])(?:loop|round[ -]?trip|circuit|circular|there\s+and\s+back|out\s+and\s+back|and\s+back|return(?:ing)?\s+to)(?=$|[^\p{L}\p{N}])/iu
const ONE_WAY_WORDS=/(?:^|[^\p{L}\p{N}])(?:one[ -]?way|point[ -]?to[ -]?point)(?=$|[^\p{L}\p{N}])/iu

export function titleTopologyClaims(title){
  const value=clean(title).toLowerCase()
  return{claimsLoop:LOOP_WORDS.test(value),claimsOneWay:ONE_WAY_WORDS.test(value)}
}

export function proposalInvariantViolations(proposal,constraints={}){
  const p=proposal||{},c=constraints||{},stops=(p.stops||[]).map(clean).filter(Boolean),v=[]
  if(stops.length<2)v.push('route-too-short')
  if(c.start&&!samePlace(stops[0],c.start))v.push('start')
  if(c.end&&!samePlace(stops.at(-1),c.end))v.push('end')

  // A confirmed topology is authority. A model may not silently substitute a different one.
  if(c.topology&&p.topology!==c.topology)v.push(`topology:${p.topology||'missing'}!=${c.topology}`)
  if(p.topology==='loop'&&stops.length>=2&&!samePlace(stops[0],stops.at(-1)))v.push('loop-open')
  if((p.topology==='one_way'||p.topology==='open_jaw')&&stops.length>=2&&samePlace(stops[0],stops.at(-1)))v.push(`${p.topology}-closed`)

  // Repeats are occurrence semantics, not a side effect of route generation. Spark may
  // only repeat the first place as the terminal closure of a loop unless the traveler
  // explicitly required the repeat elsewhere (handled later by TripAuthority/revision).
  const seen=[]
  for(let i=0;i<stops.length;i++){
    const prior=seen.find(x=>samePlace(x.label,stops[i]))
    const loopClosure=Boolean(prior&&p.topology==='loop'&&i===stops.length-1&&prior.index===0&&samePlace(stops[0],stops[i]))
    if(prior&&!loopClosure)v.push(`unconfirmed-repeat:${stops[i]}`)
    else if(!prior)seen.push({label:stops[i],index:i})
  }

  const claims=titleTopologyClaims(p.title)
  if(p.topology!=='loop'&&claims.claimsLoop)v.push('title-topology-loop-conflict')
  if(p.topology==='loop'&&claims.claimsOneWay)v.push('title-topology-one-way-conflict')

  const scopes=scopeKeys(c)
  for(const stop of stops)if(scopes.has(placeMatchKey(stop)))v.push(`scope-as-stop:${stop}`)
  for(const x of c.requiredPlaces||[])if(!scopes.has(placeMatchKey(x))&&!stops.some(s=>samePlace(s,x)))v.push(`required:${x}`)
  for(const x of c.excludedPlaces||[])if(stops.some(s=>samePlace(s,x)))v.push(`excluded:${x}`)
  if(c.duration?.kind==='exact'&&Number(p.days)!==Number(c.duration.days))v.push('duration')
  if(c.duration?.kind==='range'&&(Number(p.days)<Number(c.duration.minDays)||Number(p.days)>Number(c.duration.maxDays)))v.push('duration-range')
  return[...new Set(v)]
}

export function rawProposalContractViolations(raw,constraints={}){
  const c=constraints||{},items=(raw?.stops||[]).map(x=>typeof x==='string'?{label:clean(x),kind:'unknown',routeOccurrence:false}:{label:clean(x?.label),kind:clean(x?.kind).toLowerCase(),routeOccurrence:x?.routeOccurrence===true}).filter(x=>x.label),v=[]
  const labels=items.map(x=>x.label),scopes=scopeKeys(c),alwaysNonRouteKinds=new Set(['experience','activity','attraction','neighborhood','market','scope','region','country','island','continent','state','province','territory','prefecture','district','county','archipelago','administrative','admin'])
  const explicitRoutePlaces=[c.start,c.end,...(c.requiredPlaces||[])].filter(Boolean)
  if(c.topology&&!raw?.topology)v.push('raw-topology-missing')
  else if(c.topology&&raw.topology!==c.topology)v.push(`raw-topology:${raw.topology}!=${c.topology}`)
  if(c.start&&labels.length&&!samePlace(labels[0],c.start))v.push('raw-start')
  if(c.end&&labels.length&&!samePlace(labels.at(-1),c.end))v.push('raw-end')
  if(c.duration?.kind==='exact'){if(!(Number(raw?.days)>0))v.push('raw-duration-missing');else if(Number(raw.days)!==Number(c.duration.days))v.push('raw-duration')}
  if(c.duration?.kind==='range'){if(!(Number(raw?.days)>0))v.push('raw-duration-missing');else if(Number(raw.days)<Number(c.duration.minDays)||Number(raw.days)>Number(c.duration.maxDays))v.push('raw-duration-range')}
  for(const item of items){
    const explicitOccurrence=item.routeOccurrence||explicitRoutePlaces.some(x=>samePlace(x,item.label))
    if(alwaysNonRouteKinds.has(item.kind)||(item.kind==='poi'||item.kind==='landmark')&&!explicitOccurrence)v.push(`non-route-kind:${item.label}`)
    if(scopes.has(placeMatchKey(item.label)))v.push(`scope-as-stop:${item.label}`)
  }
  for(const x of c.requiredPlaces||[])if(!scopes.has(placeMatchKey(x))&&!labels.some(s=>samePlace(s,x)))v.push(`raw-required:${x}`)
  for(const x of c.excludedPlaces||[])if(labels.some(s=>samePlace(s,x)))v.push(`raw-excluded:${x}`)
  return[...new Set(v)]
}

export function proposalInvariantMatrixCases(){
  // Deliberately geography-neutral shapes. Release tests use this matrix as an
  // independent rule set rather than treating named travel examples as proof.
  return[
    {name:'loop-valid',constraints:{topology:'loop',start:'A',end:'A'},proposal:{title:'Island circuit',topology:'loop',stops:['A','B','C','A']},ok:true},
    {name:'loop-open',constraints:{topology:'loop',start:'A',end:'A'},proposal:{title:'Island circuit',topology:'loop',stops:['A','B','C']},ok:false},
    {name:'one-way-valid',constraints:{topology:'one_way',start:'A',end:'D'},proposal:{title:'A to D',topology:'one_way',stops:['A','B','C','D']},ok:true},
    {name:'one-way-closed',constraints:{topology:'one_way',start:'A',end:'A'},proposal:{title:'A to A',topology:'one_way',stops:['A','B','A']},ok:false},
    {name:'one-way-loop-title',constraints:{topology:'one_way',start:'A',end:'D'},proposal:{title:'Grand Loop',topology:'one_way',stops:['A','B','D']},ok:false},
    {name:'loop-one-way-title',constraints:{topology:'loop',start:'A',end:'A'},proposal:{title:'One-way highlights',topology:'loop',stops:['A','B','A']},ok:false},
    {name:'unrequested-repeat',constraints:{topology:'flexible'},proposal:{title:'Highlights',topology:'flexible',stops:['A','B','A','C']},ok:false},
    {name:'scope-literal',constraints:{topology:'flexible',scopes:[{kind:'country',label:'Area X'}]},proposal:{title:'Area X highlights',topology:'flexible',stops:['Town A','Area X','Town B']},ok:false},
    {name:'required-missing',constraints:{topology:'flexible',requiredPlaces:['Town Q']},proposal:{title:'Highlights',topology:'flexible',stops:['Town A','Town B']},ok:false},
    {name:'excluded-present',constraints:{topology:'flexible',excludedPlaces:['Town X']},proposal:{title:'Highlights',topology:'flexible',stops:['Town A','Town X']},ok:false},
  ]
}
