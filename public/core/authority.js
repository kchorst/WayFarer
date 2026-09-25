const clean = value => String(value ?? '').trim()
const clone = value => structuredClone(value)
const now = () => Date.now()
const id = prefix => `${prefix}_${now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`

export const TOPOLOGIES = Object.freeze(['loop','one_way','open_jaw','flexible','circumnavigation'])
export const DISPOSITIONS = Object.freeze(['required','optional','excluded','transit_only'])
export const STAY_KINDS = Object.freeze(['flexible','exact','minimum','maximum','none'])
export const TRANSPORT_MODES = Object.freeze(['Any','Car','Train','Bus','Ferry','Walk','Bike','Air','Mixed'])

function normalizePlacePart(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()}
export function parsePlaceLabel(value){
  const text=clean(typeof value==='object'?value?.label:value),parts=text.split(',').map(clean).filter(Boolean),base=parts.shift()||'',qualifier=parts.join(', ')
  return{label:text,base,qualifier,baseKey:normalizePlacePart(base),qualifierKey:normalizePlacePart(qualifier)}
}
export function placeMatchKey(value){const p=parsePlaceLabel(value);return p.baseKey?`${p.baseKey}${p.qualifierKey?`|${p.qualifierKey}`:''}`:''}
export function samePlace(a,b){
  const left=parsePlaceLabel(a),right=parsePlaceLabel(b);if(!left.baseKey||left.baseKey!==right.baseKey)return false
  if(left.qualifierKey&&right.qualifierKey)return left.qualifierKey===right.qualifierKey
  return true
}
function placeForLabel(label,existingPlace={},suppliedPlace={}){
  const parsed=parsePlaceLabel(label),explicitQualifier=Object.prototype.hasOwnProperty.call(suppliedPlace||{},'qualifier')?clean(suppliedPlace.qualifier):null,qualifier=explicitQualifier!==null?explicitQualifier:parsed.qualifier
  const out={...(existingPlace||{}),...(suppliedPlace||{}),label:parsed.label};if(qualifier)out.qualifier=qualifier;else delete out.qualifier;return out
}

function normalizeMode(value){
  const key=clean(value).toLowerCase()
  return TRANSPORT_MODES.find(x=>x.toLowerCase()===key) || null
}
function normalizeDisposition(value, fallback=null){
  const key=clean(value).toLowerCase()
  return DISPOSITIONS.find(x=>x.toLowerCase()===key) || fallback
}
function normalizedStay(stay={}, {strict=false}={}){
  const rawKind=clean(stay?.kind).toLowerCase()
  const kind=STAY_KINDS.find(x=>x===rawKind) || (!rawKind && (stay?.days!=null) ? 'exact' : (!rawKind ? 'flexible' : null))
  if(!kind){ if(strict) throw new Error(`Invalid stay kind "${stay?.kind}".`); return {kind:'flexible'} }
  if(kind==='flexible'||kind==='none')return{kind}
  const days=Number(stay?.days)
  if(!Number.isFinite(days)||days<0){ if(strict) throw new Error(`Stay kind ${kind} requires a non-negative day count.`); return {kind:'flexible'} }
  return{kind,days}
}
export function normalizeStay(stay={}){return normalizedStay(stay)}
function normalizedDuration(duration,{strict=false,provenance='traveler'}={}){
  if(duration==null)return null
  let kind=clean(duration?.kind).toLowerCase()
  if(!kind){
    if(duration?.days!=null)kind='exact'
    else if(duration?.minDays!=null||duration?.maxDays!=null)kind='range'
    else kind='flexible'
  }
  if(!['exact','range','flexible'].includes(kind)){ if(strict)throw new Error(`Invalid duration kind "${duration?.kind}".`); return null }
  if(kind==='exact'){
    const days=Number(duration.days)
    if(!Number.isFinite(days)||days<=0){if(strict)throw new Error('Exact duration requires days > 0.');return null}
    return{kind,days,provenance:duration.provenance||provenance}
  }
  if(kind==='range'){
    const minDays=Number(duration.minDays),maxDays=Number(duration.maxDays)
    if(!Number.isFinite(minDays)||!Number.isFinite(maxDays)||minDays<=0||maxDays<minDays){if(strict)throw new Error('Range duration requires valid minDays/maxDays.');return null}
    return{kind,minDays,maxDays,provenance:duration.provenance||provenance}
  }
  return{kind:'flexible',provenance:duration.provenance||provenance}
}
function normalizeTransport(transport={}){
  const mode=normalizeMode(transport.primaryMode)||'Any'
  return{
    primaryMode:mode,
    confirmed:Boolean(transport.confirmed===true&&mode!=='Any'),
    provenance:transport.provenance||null,
    scoped:Array.isArray(transport.scoped)?transport.scoped.map(x=>({...x})):[],
    legModes:transport.legModes&&typeof transport.legModes==='object'?{...transport.legModes}:{},
    reconfirmationRequiredLegIds:Array.isArray(transport.reconfirmationRequiredLegIds)?[...transport.reconfirmationRequiredLegIds]:[],
    pendingLegReviews:Array.isArray(transport.pendingLegReviews)?transport.pendingLegReviews.map(x=>({...x})):[],
  }
}
function constraintEntry(label,disposition='required',provenance='traveler'){
  const text=clean(label);return text?{id:id('pc'),label:text,disposition,provenance}:null
}
function normalizePlaceConstraints(value={}){
  const pack=(arr,disp)=>(Array.isArray(arr)?arr:[]).map(x=>typeof x==='string'?constraintEntry(x,disp):constraintEntry(x?.label,disp,x?.provenance||'traveler')).filter(Boolean)
  return{required:pack(value.required,'required'),optional:pack(value.optional,'optional'),excluded:pack(value.excluded,'excluded')}
}

export function makeOccurrence(label,{role='visit',disposition='required',stay={kind:'flexible'},provenance='traveler',place={},occurrenceId=null,revisitIntent=false}={}){
  const text=clean(label);if(!text)return null
  const normalizedDisposition=normalizeDisposition(disposition,'required')
  return{id:occurrenceId||id('occ'),role:['start','visit','end'].includes(role)?role:'visit',place:placeForLabel(text,{},place),disposition:normalizedDisposition,stay:normalizedStay(stay),provenance,revisitIntent:Boolean(revisitIntent)}
}

export function emptyAuthority({brief=''}={}){
  const ts=now();return{
    schemaVersion:2,id:id('trip'),version:1,createdAt:ts,updatedAt:ts,
    brief:{rawText:clean(brief),provenance:clean(brief)?'traveler':null},duration:null,timing:null,topology:'flexible',topologyProvenance:null,
    scopes:[],occurrences:[],placeConstraints:normalizePlaceConstraints(),experiences:[],transport:normalizeTransport(),travelers:[],homeOrigin:null,commitments:[],exclusions:[],
  }
}
function proposalStops(proposal={}){return(Array.isArray(proposal.stops)?proposal.stops:[]).map(x=>typeof x==='string'?x:x?.label).map(clean).filter(Boolean)}
function broadScopeLabels(constraints={}){return(constraints.scopes||[]).map(s=>clean(typeof s==='string'?s:s?.label)).filter(Boolean)}
function boundaryTrim(stops,start,end){const out=[...stops];if(start&&out.length&&samePlace(out[0],start))out.shift();if(end&&out.length&&samePlace(out.at(-1),end))out.pop();return out}
function hasPlace(entries,label){return(entries||[]).some(x=>samePlace(typeof x==='string'?x:x?.label,label))}

export function authorityFromProposal({brief='',constraints={},proposal={}}={}){
  const a=emptyAuthority({brief})
  let explicitStart=clean(constraints.start),explicitEnd=clean(constraints.end)
  const topology=TOPOLOGIES.includes(constraints.topology)?constraints.topology:(TOPOLOGIES.includes(proposal.topology)?proposal.topology:'flexible')
  if(topology==='loop'){
    if(explicitStart&&!explicitEnd)explicitEnd=explicitStart
    if(explicitEnd&&!explicitStart)explicitStart=explicitEnd
  }
  const scopeLabels=broadScopeLabels(constraints)
  const requiredRaw=(constraints.requiredPlaces||[]).map(clean).filter(Boolean)
  const optionalRaw=(constraints.optionalPlaces||[]).map(clean).filter(Boolean)
  const excludedRaw=(constraints.excludedPlaces||[]).map(clean).filter(Boolean)
  const required=requiredRaw.filter(x=>!scopeLabels.some(scope=>samePlace(scope,x)))
  const optional=optionalRaw.filter(x=>!scopeLabels.some(scope=>samePlace(scope,x)))
  const excluded=excludedRaw
  let middle=boundaryTrim(proposalStops(proposal),explicitStart,explicitEnd)
    .filter(label=>!scopeLabels.some(scope=>samePlace(scope,label)))
    .filter(label=>!excluded.some(x=>samePlace(x,label)))
  for(const place of required){if((explicitStart&&samePlace(place,explicitStart))||(explicitEnd&&samePlace(place,explicitEnd)))continue;if(!middle.some(x=>samePlace(x,place)))middle.push(place)}
  const occurrences=[]
  if(explicitStart)occurrences.push(makeOccurrence(explicitStart,{role:'start',provenance:'traveler',disposition:'required'}))
  for(const label of middle){
    const travelerRequired=required.some(x=>samePlace(x,label)),travelerOptional=optional.some(x=>samePlace(x,label))
    occurrences.push(makeOccurrence(label,{role:'visit',provenance:travelerRequired||travelerOptional?'traveler':'adopted_suggestion',disposition:travelerRequired?'required':travelerOptional?'optional':'optional'}))
  }
  if(explicitEnd)occurrences.push(makeOccurrence(explicitEnd,{role:'end',provenance:'traveler',disposition:'required',revisitIntent:Boolean(explicitStart&&samePlace(explicitStart,explicitEnd))}))
  if(!explicitStart&&occurrences.length)occurrences[0]={...occurrences[0],role:'start'}
  if(!explicitEnd&&occurrences.length>1)occurrences[occurrences.length-1]={...occurrences.at(-1),role:'end'}
  if(topology==='loop'&&occurrences.length>=1){
    const start=occurrences[0]
    if(!samePlace(start.place.label,occurrences.at(-1)?.place?.label))occurrences.push(makeOccurrence(start.place.label,{role:'end',provenance:start.provenance,revisitIntent:true,disposition:start.disposition}))
    occurrences[0]={...occurrences[0],role:'start'};occurrences[occurrences.length-1]={...occurrences.at(-1),role:'end',revisitIntent:true}
  }
  const duration=constraints.duration?normalizedDuration({...constraints.duration,provenance:'traveler'}):proposal.days?normalizedDuration({kind:'exact',days:Number(proposal.days),provenance:'adopted_suggestion'}):null
  const topologyProvenance=constraints.topology?'traveler':proposal.topology?'adopted_suggestion':null
  const transportMode=normalizeMode(constraints.transport?.primaryMode)||'Any'
  const transport=normalizeTransport({primaryMode:transportMode,confirmed:Boolean(constraints.transport?.confirmed===true&&transportMode!=='Any'),provenance:constraints.transport?.primaryMode?'traveler':null,scoped:constraints.transport?.scoped||[]})
  const experiences=[
    ...(constraints.experiences?.required||[]).map(label=>({id:id('exp'),label:clean(label),disposition:'required',provenance:'traveler'})),
    ...(constraints.experiences?.preferred||[]).map(label=>({id:id('exp'),label:clean(label),disposition:'preferred',provenance:'traveler'})),
    ...(proposal.themes||[]).filter(t=>!(constraints.experiences?.required||[]).some(x=>samePlace(x,t))).map(label=>({id:id('exp'),label:clean(label),disposition:'preferred',provenance:'adopted_suggestion'})),
    ...(constraints.experiences?.excluded||[]).map(label=>({id:id('exp'),label:clean(label),disposition:'excluded',provenance:'traveler'})),
  ].filter(x=>x.label)
  return{...a,duration,timing:constraints.timing?{...constraints.timing,provenance:'traveler'}:null,topology,topologyProvenance,
    scopes:(constraints.scopes||[]).map(s=>typeof s==='string'?{id:id('scope'),kind:'region',label:clean(s),provenance:'traveler'}:{id:id('scope'),kind:s.kind||'region',label:clean(s.label),countryCode:s.countryCode||'',provenance:'traveler'}).filter(x=>x.label),
    occurrences,placeConstraints:normalizePlaceConstraints({required,optional,excluded}),experiences,transport,
    travelers:Array.isArray(constraints.travelers)?constraints.travelers.map(t=>({...t,id:t.id||id('traveler'),provenance:'traveler'})):[],
    homeOrigin:constraints.homeOrigin?{label:clean(constraints.homeOrigin),provenance:'traveler'}:null,
    commitments:(constraints.commitments||[]).map(text=>({id:id('commit'),text:clean(text),provenance:'traveler'})).filter(x=>x.text),
    exclusions:(constraints.exclusions||[]).map(text=>({id:id('exclude'),text:clean(text),provenance:'traveler'})).filter(x=>x.text),
  }
}
function touch(a){return{...a,version:Number(a.version||0)+1,updatedAt:now()}}
function activeOccurrences(a){return(Array.isArray(a?.occurrences)?a.occurrences:[]).filter(o=>clean(o?.place?.label)&&o.disposition!=='excluded')}
export function routeOccurrences(authority){return activeOccurrences(authority)}
export function routeLabels(authority){return routeOccurrences(authority).map(o=>o.place.label)}
function excludedByConstraint(a,label){return(a.placeConstraints?.excluded||[]).some(x=>samePlace(x.label,label))}
function scopeLabel(a,label){return(a.scopes||[]).some(x=>samePlace(x.label,label))}
function occurrenceById(a,occurrenceId){return(a.occurrences||[]).find(o=>o.id===occurrenceId)||null}
function ensureNotExcluded(a,label){if(excludedByConstraint(a,label))throw new Error(`"${clean(label)}" is explicitly excluded by the traveler.`)}
function ensureNotScopeLiteral(a,label){if(scopeLabel(a,label))throw new Error(`"${clean(label)}" is a geographic scope, not a literal route stop.`)}
function targetIndexOrThrow(list,idValue,kind){const i=list.findIndex(o=>o.id===idValue);if(i<0)throw new Error(`${kind} occurrence ${idValue} does not exist in the current trip.`);return i}
function insertOccurrenceStrict(list,occurrence,{beforeOccurrenceId=null,afterOccurrenceId=null,index=null}={}){
  const out=[...list]
  if(beforeOccurrenceId&&afterOccurrenceId)throw new Error('Insertion cannot specify both beforeOccurrenceId and afterOccurrenceId.')
  if(beforeOccurrenceId){const i=targetIndexOrThrow(out,beforeOccurrenceId,'Before-anchor');out.splice(i,0,occurrence);return out}
  if(afterOccurrenceId){const i=targetIndexOrThrow(out,afterOccurrenceId,'After-anchor');out.splice(i+1,0,occurrence);return out}
  if(index!=null){if(!Number.isInteger(index)||index<0||index>out.length)throw new Error('Insertion index is outside the current route.');out.splice(index,0,occurrence);return out}
  const endIndex=out.findIndex(o=>o.role==='end');if(endIndex>=0)out.splice(endIndex,0,occurrence);else out.push(occurrence);return out
}
function preserveOccurrence(existing,label,role,{provenanceOnChange='traveler'}={}){
  const text=clean(label);if(!text)throw new Error(`${role==='start'?'Start':'End'} label is required.`)
  if(existing&&samePlace(existing.place?.label,text))return{...existing,role,place:placeForLabel(text,existing.place),provenance:clean(existing.place?.label)===text?existing.provenance:provenanceOnChange}
  return makeOccurrence(text,{role,provenance:provenanceOnChange})
}
function sameStay(a,b){return JSON.stringify(a||{})===JSON.stringify(b||{})}
function setPrecisionOccurrences(a,payload={}){
  const source=Array.isArray(payload.occurrences)?payload.occurrences:[]
  const oldById=new Map((a.occurrences||[]).map(o=>[o.id,o]))
  const next=[];const seenKeys=new Map()
  for(let index=0;index<source.length;index++){
    const item=source[index],label=clean(item?.label||item?.place?.label);if(!label){if(item?.id||clean(item?.place?.qualifier)||item?.disposition||item?.stay)throw new Error(`Precision row ${item?.id||index+1} is malformed: label is required.`);continue}
    ensureNotExcluded(a,label);ensureNotScopeLiteral(a,label)
    const existing=item.id?oldById.get(item.id):null
    if(item.id&&!existing)throw new Error(`Precision row references unknown occurrence ${item.id}.`)
    const role=['start','visit','end'].includes(item.role)?item.role:(index===0?'start':index===source.length-1?'end':'visit')
    const disposition=normalizeDisposition(item.disposition,existing?.disposition||'required')
    const stay=normalizedStay(item.stay||existing?.stay||{kind:'flexible'},{strict:true})
    const changed=!existing||clean(existing.place?.label)!==label||existing.role!==role||existing.disposition!==disposition||!sameStay(existing.stay,stay)
    const key=placeMatchKey(label),count=seenKeys.get(key)||0;seenKeys.set(key,count+1)
    next.push({...(existing||makeOccurrence(label,{role,provenance:'traveler'})),id:existing?.id||item.id||id('occ'),role,place:placeForLabel(label,existing?.place||{},item.place||{}),disposition,stay,provenance:changed?'traveler':existing.provenance,revisitIntent:Boolean(existing?.revisitIntent||count>0)})
  }
  a.occurrences=next;return a
}
function setPrecisionRoute(a,payload={}){
  const old=routeOccurrences(a),oldStart=old.find(o=>o.role==='start'),oldEnd=[...old].reverse().find(o=>o.role==='end'),oldVisits=old.filter(o=>o.role==='visit'),buckets=new Map()
  for(const o of oldVisits){const key=placeMatchKey(o.place?.label);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(o)}
  const start=payload.start?preserveOccurrence(oldStart,payload.start,'start'):oldStart
  const end=payload.end?preserveOccurrence(oldEnd,payload.end,'end'):oldEnd
  const visits=(payload.visits||[]).map((item,index)=>{const label=clean(typeof item==='string'?item:item?.label);if(!label){if(typeof item==='object'&&(item?.id||clean(item?.place?.qualifier)||item?.disposition||item?.stay))throw new Error(`Precision visit row ${item?.id||index+1} is malformed: label is required.`);return null}ensureNotExcluded(a,label);ensureNotScopeLiteral(a,label);const existing=buckets.get(placeMatchKey(label))?.shift();const desiredDisposition=normalizeDisposition(item?.disposition,existing?.disposition||'required');const desiredStay=item?.stay?normalizedStay(item.stay,{strict:true}):(existing?.stay||{kind:'flexible'});const changed=!existing||clean(existing.place?.label)!==label||desiredDisposition!==existing.disposition||!sameStay(desiredStay,existing.stay);return{...(existing||makeOccurrence(label,{role:'visit',provenance:'traveler'})),role:'visit',place:placeForLabel(label,existing?.place||{},item?.place||{}),disposition:desiredDisposition,stay:desiredStay,provenance:changed?'traveler':existing.provenance}}).filter(Boolean)
  a.occurrences=[...(start?[start]:[]),...visits,...(end?[end]:[])];return a
}
function enforceBoundaryRoles(a){
  const active=routeOccurrences(a);if(!active.length)return a
  const ids=new Set(active.map(o=>o.id));a.occurrences=(a.occurrences||[]).map(o=>ids.has(o.id)?{...o,role:o.id===active[0].id?'start':o.id===active.at(-1).id?'end':'visit'}:o);return a
}
function enforceLoopClosure(a){
  if(a.topology!=='loop')return enforceBoundaryRoles(a)
  let route=routeOccurrences(a);if(!route.length)return a
  enforceBoundaryRoles(a);route=routeOccurrences(a)
  const start=route[0],last=route.at(-1)
  if(!samePlace(start.place.label,last.place.label)){
    const existingIndex=(a.occurrences||[]).findIndex(o=>o.id===last.id);if(existingIndex>=0)a.occurrences[existingIndex]={...a.occurrences[existingIndex],role:'visit'}
    a.occurrences.push(makeOccurrence(start.place.label,{role:'end',disposition:start.disposition,provenance:start.provenance,revisitIntent:true}))
  }
  return enforceBoundaryRoles(a)
}
function reconcileLegModes(before,after){
  const oldTransport=normalizeTransport(before.transport),newTransport=normalizeTransport(after.transport),oldRoute=routeOccurrences(before),newRoute=routeOccurrences(after)
  const oldPairs=new Map();for(let i=0;i<oldRoute.length-1;i++){const key=`leg_${oldRoute[i].id}__${oldRoute[i+1].id}`;if(oldTransport.legModes[key])oldPairs.set(key,{from:oldRoute[i].id,to:oldRoute[i+1].id,mode:oldTransport.legModes[key]})}
  const validDirect=new Set();for(let i=0;i<newRoute.length-1;i++)validDirect.add(`leg_${newRoute[i].id}__${newRoute[i+1].id}`)
  const legModes={};const reconfirm=new Set();const pending=[]
  for(const [key,info] of oldPairs){
    if(validDirect.has(key)){legModes[key]=info.mode;continue}
    const fromIndex=newRoute.findIndex(o=>o.id===info.from),toIndex=newRoute.findIndex(o=>o.id===info.to)
    if(fromIndex>=0&&toIndex>fromIndex){for(let i=fromIndex;i<toIndex;i++){const idv=`leg_${newRoute[i].id}__${newRoute[i+1].id}`;legModes[idv]=info.mode;reconfirm.add(idv)};pending.push({...info,reason:'route_changed'})}
    else pending.push({...info,reason:'leg_no_longer_adjacent'})
  }
  after.transport={...newTransport,legModes,reconfirmationRequiredLegIds:[...reconfirm],pendingLegReviews:pending};return after
}
function addPlaceConstraint(a,kind,label){const text=clean(label);if(!text)throw new Error('Place constraint label is required.');const list=a.placeConstraints?.[kind]||[];if(!list.some(x=>samePlace(x.label,text)))list.push(constraintEntry(text,kind==='excluded'?'excluded':kind==='optional'?'optional':'required'));a.placeConstraints={...normalizePlaceConstraints(a.placeConstraints),[kind]:list};return a}
function removePlaceConstraint(a,kind,label){const text=clean(label);if(!text)throw new Error('Place constraint label is required.');a.placeConstraints={...normalizePlaceConstraints(a.placeConstraints),[kind]:(a.placeConstraints?.[kind]||[]).filter(x=>!samePlace(x.label,text))};return a}

function loopClosureOccurrence(authority){
  const route=routeOccurrences(authority),start=route[0],end=route.at(-1)
  if(authority?.topology!=='loop'||!start||!end||start.id===end.id||!samePlace(start.place?.label,end.place?.label)||!end.revisitIntent)return null
  return end
}
function setPrecisionShape(a,payload={}){
  const topology=clean(payload.topology||a.topology||'flexible')
  if(!TOPOLOGIES.includes(topology))throw new Error(`Invalid topology "${topology}".`)
  const start=clean(payload.start),end=clean(payload.end)
  if(!start)throw new Error('Start label is required.')
  if(!end)throw new Error('End label is required.')
  ensureNotExcluded(a,start);ensureNotScopeLiteral(a,start);ensureNotExcluded(a,end);ensureNotScopeLiteral(a,end)
  const previousStart=routeOccurrences(a)[0],priorClosure=loopClosureOccurrence(a),source=Array.isArray(payload.occurrences)?payload.occurrences:[]
  let working=clone(a);working.topology='flexible';working=setPrecisionOccurrences(working,{occurrences:source})
  // A loop-closing occurrence is structural. When Precision changes a loop into an
  // open shape with a different end, do not strand the former closure as a duplicate
  // visit unless the traveler explicitly edited that row into something else.
  if(topology!=='loop'&&priorClosure&&previousStart&&!samePlace(start,end)){
    const row=source.find(item=>item?.id===priorClosure.id),rowLabel=clean(row?.label||row?.place?.label)
    if(row&&samePlace(rowLabel,previousStart.place?.label))working.occurrences=(working.occurrences||[]).filter(o=>o.id!==priorClosure.id)
  }
  // Boundary fields and topology are one Precision transaction. Apply them against a
  // temporary flexible shape so the previous topology cannot reject the new final state.
  working=executeCommand(working,{type:'SET_START',payload:{label:start}})
  working=executeCommand(working,{type:'SET_END',payload:{label:end}})
  working=executeCommand(working,{type:'SET_TOPOLOGY',payload:{topology}})
  return working
}

function executeCommand(authority,command){
  if(!authority||!command?.type)throw new Error('A valid trip command is required.')
  let a=clone(authority);a.placeConstraints=normalizePlaceConstraints(a.placeConstraints);a.transport=normalizeTransport(a.transport)
  const before=clone(a),p=command.payload??{}
  switch(command.type){
    case 'SET_DURATION':a.duration=normalizedDuration({...p,provenance:'traveler'},{strict:true});break
    case 'SET_TIMING':{const startDate=clean(p.startDate),endDate=clean(p.endDate),season=clean(p.season);a.timing=(startDate||endDate||season)?{startDate,endDate,season,provenance:'traveler'}:null;break}
    case 'SET_TOPOLOGY':{const t=clean(p?.topology||p);if(!TOPOLOGIES.includes(t))throw new Error(`Invalid topology "${t}".`);a.topology=t;a.topologyProvenance='traveler';if(t==='loop')a=enforceLoopClosure(a);else a=enforceBoundaryRoles(a);break}
    case 'SET_SCOPES':a.scopes=(Array.isArray(p)?p:p.scopes||[]).map(s=>typeof s==='string'?{id:id('scope'),kind:'region',label:clean(s),provenance:'traveler'}:{...s,id:s.id||id('scope'),label:clean(s.label),provenance:'traveler'}).filter(s=>s.label);break
    case 'SET_PRECISION_SHAPE':a=setPrecisionShape(a,p);break
    case 'ADD_SCOPE':{const label=clean(p.label);if(!label)throw new Error('Scope label is required.');if(!a.scopes.some(s=>samePlace(s.label,label)))a.scopes.push({id:id('scope'),kind:p.kind||'region',label,countryCode:p.countryCode||'',provenance:'traveler'});break}
    case 'REMOVE_SCOPE':{const label=clean(p.label);if(!label)throw new Error('Scope label is required.');const n=a.scopes.length;a.scopes=a.scopes.filter(s=>!samePlace(s.label,label));if(a.scopes.length===n)throw new Error(`Scope "${label}" is not present.`);break}
    case 'SET_PRECISION_ROUTE':a=setPrecisionRoute(a,p);a=enforceBoundaryRoles(a);if(a.topology==='loop')a=enforceLoopClosure(a);break
    case 'SET_PRECISION_OCCURRENCES':a=setPrecisionOccurrences(a,p);a=enforceBoundaryRoles(a);if(a.topology==='loop')a=enforceLoopClosure(a);break
    case 'INSERT_OCCURRENCE':{
      const label=clean(p.label);if(!label)throw new Error('Inserted stop label is required.');if(['experience','scope','region','country'].includes(clean(p.kind).toLowerCase()))throw new Error(`\"${label}\" is not a route-anchor kind; add it as an experience or geographic scope instead.`);ensureNotExcluded(a,label);ensureNotScopeLiteral(a,label)
      const active=routeOccurrences(a);const duplicates=active.filter(o=>samePlace(o.place.label,label));if(duplicates.length&&!p.allowRevisit)throw new Error(`"${label}" already exists in the route. Set allowRevisit only when the traveler explicitly requested a revisit.`)
      const occ=makeOccurrence(label,{role:'visit',disposition:normalizeDisposition(p.disposition,'required'),stay:normalizedStay(p.stay||{kind:'flexible'},{strict:true}),provenance:'traveler',revisitIntent:Boolean(duplicates.length)});a.occurrences=insertOccurrenceStrict(a.occurrences||[],occ,p);a=enforceBoundaryRoles(a);if(a.topology==='loop')a=enforceLoopClosure(a);break
    }
    case 'REMOVE_OCCURRENCE':{
      const target=occurrenceById(a,p.occurrenceId);if(!target)throw new Error(`Occurrence ${p.occurrenceId} does not exist.`);if(['start','end'].includes(target.role))throw new Error('Use SET_START or SET_END to change a route boundary.');if(target.provenance==='traveler'&&!p.confirmTravelerOwned)throw new Error(`Removing traveler-owned stop "${target.place.label}" requires explicit confirmation.`);a.occurrences=(a.occurrences||[]).filter(o=>o.id!==target.id);break
    }
    case 'MOVE_OCCURRENCE':{
      const route=a.occurrences||[],target=occurrenceById(a,p.occurrenceId);if(!target)throw new Error(`Occurrence ${p.occurrenceId} does not exist.`);if(['start','end'].includes(target.role))throw new Error('Boundary occurrences cannot be moved; change start/end explicitly.');const rest=route.filter(o=>o.id!==target.id);a.occurrences=insertOccurrenceStrict(rest,target,p);a=enforceBoundaryRoles(a);if(a.topology==='loop')a=enforceLoopClosure(a);break
    }
    case 'RENAME_OCCURRENCE':{
      const target=occurrenceById(a,p.occurrenceId);if(!target)throw new Error(`Occurrence ${p.occurrenceId} does not exist.`);const label=clean(p.label);if(!label)throw new Error('Renamed stop label is required.');ensureNotExcluded(a,label);ensureNotScopeLiteral(a,label);const duplicate=routeOccurrences(a).some(o=>o.id!==target.id&&samePlace(o.place.label,label));if(duplicate&&!p.allowRevisit)throw new Error(`Renaming to "${label}" would create a repeat; explicit revisit intent is required.`);a.occurrences=a.occurrences.map(o=>o.id===target.id?{...o,place:placeForLabel(label,o.place),provenance:'traveler',revisitIntent:Boolean(o.revisitIntent||duplicate)}:o);if(a.topology==='loop'&&target.role==='start')a=enforceLoopClosure(a);break
    }
    case 'SET_OCCURRENCE_STAY':{const target=occurrenceById(a,p.occurrenceId);if(!target)throw new Error(`Occurrence ${p.occurrenceId} does not exist.`);const stay=normalizedStay(p.stay||p,{strict:true});a.occurrences=a.occurrences.map(o=>o.id===target.id?{...o,stay,provenance:'traveler'}:o);break}
    case 'SET_OCCURRENCE_DISPOSITION':{const target=occurrenceById(a,p.occurrenceId);if(!target)throw new Error(`Occurrence ${p.occurrenceId} does not exist.`);const disposition=normalizeDisposition(p.disposition);if(!disposition)throw new Error(`Invalid disposition "${p.disposition}".`);if(disposition==='excluded'&&['start','end'].includes(target.role))throw new Error('Start/end cannot be excluded; change the boundary first.');if(disposition==='excluded')a=addPlaceConstraint(a,'excluded',target.place.label);else if(target.disposition==='excluded'&&excludedByConstraint(a,target.place.label))throw new Error(`Remove the explicit place exclusion for "${target.place.label}" before restoring it to the route.`);a.occurrences=a.occurrences.map(o=>o.id===target.id?{...o,disposition,provenance:'traveler'}:o);a=enforceBoundaryRoles(a);if(a.topology==='loop')a=enforceLoopClosure(a);break}
    case 'SET_START':{
      const label=clean(p.label);if(!label)throw new Error('Start label is required.');ensureNotExcluded(a,label);ensureNotScopeLiteral(a,label);let route=a.occurrences||[];const current=route.find(o=>o.role==='start')||routeOccurrences(a)[0]||null
      if(current&&samePlace(current.place.label,label)){a.occurrences=route.map(o=>o.id===current.id?{...o,role:'start',place:placeForLabel(label,o.place),provenance:clean(current.place.label)===label?current.provenance:'traveler'}:o)}else{
        // In a loop, start + terminal closure are one boundary concept. When the traveler
        // changes the start, keep the old place at most once as a visit instead of
        // demoting both boundary occurrences and creating a duplicate mid-route revisit.
        if(a.topology==='loop'&&current){const active=routeOccurrences(a),terminal=active.at(-1);if(terminal&&terminal.id!==current.id&&samePlace(terminal.place?.label,current.place?.label))a.occurrences=(a.occurrences||[]).filter(o=>o.id!==terminal.id)}
        route=a.occurrences||[];if(current&&route.some(o=>o.id===current.id))a.occurrences=route.map(o=>o.id===current.id?{...o,role:'visit'}:o);route=a.occurrences||[];const candidate=route.find(o=>o.role==='visit'&&samePlace(o.place.label,label));if(candidate){a.occurrences=route.filter(o=>o.id!==candidate.id);a.occurrences.unshift({...candidate,role:'start',provenance:'traveler'})}else a.occurrences.unshift(makeOccurrence(label,{role:'start',provenance:'traveler'}))
      }
      a=enforceBoundaryRoles(a);if(a.topology==='loop')a=enforceLoopClosure(a);break
    }
    case 'SET_END':{
      const label=clean(p.label);if(!label)throw new Error('End label is required.');ensureNotExcluded(a,label);ensureNotScopeLiteral(a,label);const start=routeOccurrences(a)[0];if(a.topology==='loop'&&start&&!samePlace(start.place.label,label))throw new Error(`Loop end must match the start (${start.place.label}). Change the start or topology instead.`)
      let route=a.occurrences||[];const current=[...route].reverse().find(o=>o.role==='end')||routeOccurrences(a).at(-1)||null
      if(current&&samePlace(current.place.label,label)){a.occurrences=route.map(o=>o.id===current.id?{...o,role:'end',place:placeForLabel(label,o.place),provenance:clean(current.place.label)===label?current.provenance:'traveler'}:o)}else{
        if(current)a.occurrences=route.map(o=>o.id===current.id?{...o,role:'visit'}:o);route=a.occurrences;let candidateIndex=-1;for(let i=route.length-1;i>=0;i--){if(route[i].role==='visit'&&samePlace(route[i].place.label,label)){candidateIndex=i;break}}
        if(candidateIndex>=0){const [candidate]=route.splice(candidateIndex,1);route.push({...candidate,role:'end',provenance:'traveler'});a.occurrences=route}else a.occurrences.push(makeOccurrence(label,{role:'end',provenance:'traveler'}))
      }
      a=enforceBoundaryRoles(a);break
    }
    case 'SET_TRANSPORT':{const mode=normalizeMode(p.mode??p.primaryMode??p);if(!mode)throw new Error(`Invalid transport mode "${p.mode??p.primaryMode??p}".`);const changedMode=mode!==a.transport.primaryMode;const confirmed=(p.confirmed===true)&&mode!=='Any';a.transport={...a.transport,primaryMode:mode,confirmed,provenance:'traveler'};if(changedMode&&!confirmed)a.transport.confirmed=false;break}
    case 'SET_LEG_TRANSPORT':{if(!p.legId)throw new Error('legId is required.');const validLeg=deriveLegs({...a,transport:{...a.transport,legModes:{},reconfirmationRequiredLegIds:[]}}).some(l=>l.id===p.legId);if(!validLeg)throw new Error(`Leg ${p.legId} does not exist.`);const mode=normalizeMode(p.mode);if(!mode)throw new Error(`Invalid transport mode "${p.mode}".`);const legModes={...a.transport.legModes};const reconfirm=new Set(a.transport.reconfirmationRequiredLegIds||[]);if(mode==='Any'){delete legModes[p.legId];reconfirm.delete(p.legId)}else{legModes[p.legId]=mode;if(p.confirmed===true)reconfirm.delete(p.legId);else reconfirm.add(p.legId)}a.transport={...a.transport,legModes,reconfirmationRequiredLegIds:[...reconfirm],provenance:'traveler'};break}
    case 'SET_SCOPED_TRANSPORT':{const src=Array.isArray(p.scoped)?p.scoped:(Array.isArray(p)?p:[]);a.transport={...a.transport,scoped:src.map(x=>{const mode=normalizeMode(x.mode);if(!clean(x.scope)||!mode||mode==='Any')throw new Error('Scoped transport requires a scope and a specific valid mode.');return{scope:clean(x.scope),mode,provenance:'traveler'}}),provenance:'traveler'};break}
    case 'ADD_SCOPED_TRANSPORT':{const mode=normalizeMode(p.mode),scope=clean(p.scope);if(!scope||!mode||mode==='Any')throw new Error('Scoped transport requires scope and mode.');a.transport={...a.transport,scoped:[...(a.transport.scoped||[]).filter(x=>!samePlace(x.scope,scope)),{scope,mode,provenance:'traveler'}],provenance:'traveler'};break}
    case 'REMOVE_SCOPED_TRANSPORT':{const scope=clean(p.scope);if(!scope)throw new Error('Scoped transport scope is required.');const n=(a.transport.scoped||[]).length;a.transport={...a.transport,scoped:(a.transport.scoped||[]).filter(x=>!samePlace(x.scope,scope)),provenance:'traveler'};if(a.transport.scoped.length===n)throw new Error(`No scoped transport rule exists for "${scope}".`);break}
    case 'ADD_PLACE_REQUIREMENT':{a=addPlaceConstraint(a,'required',p.label);a.occurrences=(a.occurrences||[]).map(o=>samePlace(o.place?.label,p.label)?{...o,disposition:'required',provenance:'traveler'}:o);break}
    case 'ADD_PLACE_OPTION':{a=addPlaceConstraint(a,'optional',p.label);a.occurrences=(a.occurrences||[]).map(o=>samePlace(o.place?.label,p.label)&&o.provenance!=='traveler'?{...o,disposition:'optional'}:o);break}
    case 'ADD_PLACE_EXCLUSION':{const target=routeOccurrences(a).find(o=>samePlace(o.place?.label,p.label));if(target&&['start','end'].includes(target.role))throw new Error(`Cannot exclude route boundary \"${target.place.label}\" without changing the boundary first.`);a=addPlaceConstraint(a,'excluded',p.label);a.occurrences=(a.occurrences||[]).map(o=>samePlace(o.place?.label,p.label)?{...o,disposition:'excluded',provenance:'traveler'}:o);a=enforceBoundaryRoles(a);if(a.topology==='loop')a=enforceLoopClosure(a);break}
    case 'REMOVE_PLACE_EXCLUSION':{const label=clean(p.label);if(!label)throw new Error('Place constraint label is required.');a=removePlaceConstraint(a,'excluded',label);a.occurrences=(a.occurrences||[]).map(o=>samePlace(o.place?.label,label)&&o.disposition==='excluded'?{...o,disposition:'optional',provenance:'traveler'}:o);a=enforceBoundaryRoles(a);if(a.topology==='loop')a=enforceLoopClosure(a);break}
    case 'ADD_EXPERIENCE':{const label=clean(p.label||p);if(!label)throw new Error('Experience label is required.');if(!a.experiences.some(e=>samePlace(e.label,label)))a.experiences.push({id:id('exp'),label,disposition:p.disposition||'preferred',provenance:'traveler'});break}
    case 'REMOVE_EXPERIENCE':{const n=a.experiences.length;a.experiences=a.experiences.filter(e=>e.id!==p.id&&!samePlace(e.label,p.label||p));if(a.experiences.length===n)throw new Error('Experience to remove was not found.');break}
    case 'SET_TRAVELERS':a.travelers=(p.travelers||p||[]).map(t=>({...t,id:t.id||id('traveler'),provenance:'traveler'}));break
    case 'SET_HOME_ORIGIN':a.homeOrigin=clean(p.label||p)?{label:clean(p.label||p),provenance:'traveler'}:null;break
    case 'SET_COMMITMENTS':a.commitments=(p.commitments||p||[]).map(text=>({id:id('commit'),text:clean(text),provenance:'traveler'})).filter(x=>x.text);break
    case 'ADD_COMMITMENT':{const text=clean(p.text||p);if(!text)throw new Error('Commitment text is required.');if(!a.commitments.some(c=>clean(c.text).toLowerCase()===text.toLowerCase()))a.commitments.push({id:id('commit'),text,provenance:'traveler'});break}
    case 'REMOVE_COMMITMENT':{const n=a.commitments.length;a.commitments=a.commitments.filter(c=>c.id!==p.id&&clean(c.text).toLowerCase()!==clean(p.text||p).toLowerCase());if(a.commitments.length===n)throw new Error('Commitment to remove was not found.');break}
    case 'SET_EXCLUSIONS':a.exclusions=(p.exclusions||p||[]).map(text=>({id:id('exclude'),text:clean(text),provenance:'traveler'})).filter(x=>x.text);break
    case 'ADD_EXCLUSION':{const text=clean(p.text||p);if(!text)throw new Error('Exclusion text is required.');if(!a.exclusions.some(c=>clean(c.text).toLowerCase()===text.toLowerCase()))a.exclusions.push({id:id('exclude'),text,provenance:'traveler'});break}
    case 'REMOVE_EXCLUSION':{const n=a.exclusions.length;a.exclusions=a.exclusions.filter(c=>c.id!==p.id&&clean(c.text).toLowerCase()!==clean(p.text||p).toLowerCase());if(a.exclusions.length===n)throw new Error('Exclusion to remove was not found.');break}
    default:throw new Error(`Unknown or disallowed trip command ${command.type}.`)
  }
  const structuralTypes=new Set(['SET_PRECISION_SHAPE','SET_PRECISION_ROUTE','SET_PRECISION_OCCURRENCES','INSERT_OCCURRENCE','REMOVE_OCCURRENCE','MOVE_OCCURRENCE','RENAME_OCCURRENCE','SET_START','SET_END','SET_TOPOLOGY','SET_OCCURRENCE_DISPOSITION','ADD_PLACE_EXCLUSION'])
  if(structuralTypes.has(command.type))a=reconcileLegModes(before,a)
  return a
}

export function applyCommand(authority,command){
  const next=executeCommand(authority,command)
  if(JSON.stringify(next)===JSON.stringify(authority))return authority
  return touch(next)
}
export function applyCommands(authority,commands=[], {baseVersion=null,tripId=null}={}){
  if(baseVersion==null||!tripId)return{ok:false,authority,error:'Revision snapshot identity and base version are required.'}
  if(String(authority?.id)!==String(tripId))return{ok:false,authority,error:`Revision targeted trip ${tripId}, but current trip is ${authority?.id}.`}
  if(Number(authority?.version)!==Number(baseVersion))return{ok:false,authority,error:`Revision was based on trip version ${baseVersion}, but current version is ${authority?.version}.`}
  let working=clone(authority)
  try{for(const command of commands)working=executeCommand(working,command)}catch(error){return{ok:false,authority,error:error.message}}
  const findings=validateAuthority(working),blocker=findings.find(f=>f.severity==='blocker')
  if(blocker)return{ok:false,authority,findings,error:blocker.message}
  if(JSON.stringify(working)===JSON.stringify(authority))return{ok:true,authority,findings,changed:false}
  return{ok:true,authority:touch(working),findings,changed:true}
}

function stableConstraintList(previous=[],labels=[],disposition='required'){
  const out=[]
  for(const raw of labels){
    const label=clean(typeof raw==='string'?raw:raw?.label);if(!label)continue
    if(out.some(x=>samePlace(x.label,label)))continue
    const old=(previous||[]).find(x=>samePlace(x.label,label))
    out.push(old?{...old,label,disposition,provenance:old.provenance||'traveler'}:constraintEntry(label,disposition,'traveler'))
  }
  return out
}
function stableObjectList(previous=[],items=[],prefix='item',textKey='label'){
  return (Array.isArray(items)?items:[]).map((item,index)=>{
    const raw=typeof item==='string'?{[textKey]:item}:item||{},text=clean(raw[textKey]);if(!text)return null
    const old=raw.id?(previous||[]).find(x=>x.id===raw.id):(previous||[]).find(x=>clean(x?.[textKey]).toLowerCase()===text.toLowerCase())
    return{...(old||{}),...raw,id:raw.id||old?.id||id(prefix),[textKey]:text,provenance:raw.provenance||old?.provenance||'traveler'}
  }).filter(Boolean)
}
function semanticAuthority(value){
  const a=clone(value);delete a.version;delete a.updatedAt;return a
}
function sameSemanticAuthority(a,b){return JSON.stringify(semanticAuthority(a))===JSON.stringify(semanticAuthority(b))}

export function draftFromAuthority(authority){
  if(!authority)return null
  return{
    tripId:authority.id,baseVersion:authority.version,brief:clone(authority.brief),
    duration:clone(authority.duration),timing:clone(authority.timing),topology:authority.topology,topologyProvenance:authority.topologyProvenance,
    occurrences:routeOccurrences(authority).map(o=>({id:o.id,label:o.place.label,place:clone(o.place),role:o.role,disposition:o.disposition,stay:clone(o.stay),provenance:o.provenance,revisitIntent:Boolean(o.revisitIntent)})),
    scopes:clone(authority.scopes||[]),placeConstraints:clone(authority.placeConstraints||{required:[],optional:[],excluded:[]}),experiences:clone(authority.experiences||[]),
    transport:clone(normalizeTransport(authority.transport)),travelers:clone(authority.travelers||[]),homeOrigin:clone(authority.homeOrigin),commitments:clone(authority.commitments||[]),exclusions:clone(authority.exclusions||[]),
  }
}

function setTripDraft(authority,draft={}){
  if(String(draft.tripId||authority.id)!==String(authority.id))throw new Error('Precision draft belongs to a different trip.')
  if(draft.baseVersion!=null&&Number(draft.baseVersion)!==Number(authority.version))throw new Error(`Precision draft is based on trip version ${draft.baseVersion}, but current version is ${authority.version}. Discard or refresh the draft before saving.`)
  const topology=clean(draft.topology||authority.topology||'flexible');if(!TOPOLOGIES.includes(topology))throw new Error(`Invalid topology "${topology}".`)
  const excludedLabels=(draft.placeConstraints?.excluded||[]).map(x=>clean(typeof x==='string'?x:x?.label)).filter(Boolean)
  const oldById=new Map((authority.occurrences||[]).map(o=>[o.id,o]));let source=Array.isArray(draft.occurrences)?[...draft.occurrences]:[]
  const oldRoute=routeOccurrences(authority),oldClosure=authority.topology==='loop'&&oldRoute.length>1&&oldRoute.at(-1)?.revisitIntent&&samePlace(oldRoute[0]?.place?.label,oldRoute.at(-1)?.place?.label)?oldRoute.at(-1):null
  if(topology!=='loop'&&oldClosure&&source.at(-1)?.id===oldClosure.id&&samePlace(source[0]?.label||source[0]?.place?.label,source.at(-1)?.label||source.at(-1)?.place?.label))source=source.slice(0,-1)
  const occurrences=[]
  for(let i=0;i<source.length;i++){
    const item=source[i]||{},label=clean(item.label||item.place?.label);if(!label)throw new Error(`Precision route row ${i+1} is missing a place.`)
    if(excludedLabels.some(x=>samePlace(x,label)))throw new Error(`Excluded place "${label}" cannot also be routed.`)
    const existing=item.id?oldById.get(item.id):null,role=i===0?'start':i===source.length-1?'end':'visit',disposition=normalizeDisposition(item.disposition,existing?.disposition||'optional')
    if(disposition==='excluded')throw new Error('Excluded places are managed outside the active route, not as routed rows.')
    const stay=normalizedStay(item.stay||existing?.stay||{kind:'flexible'},{strict:true}),duplicate=occurrences.some(o=>samePlace(o.place.label,label))
    const keep=existing&&samePlace(existing.place?.label,label)
    occurrences.push(keep?{...existing,role,place:placeForLabel(label,existing.place,item.place||{}),disposition,stay,provenance:item.provenance||existing.provenance,revisitIntent:Boolean(item.revisitIntent||existing.revisitIntent||duplicate)}:makeOccurrence(label,{role,disposition,stay,provenance:item.provenance||'traveler',place:item.place||{},occurrenceId:item.id||null,revisitIntent:Boolean(item.revisitIntent||duplicate)}))
  }
  if(occurrences.length<2)throw new Error('Precision requires at least two active route occurrences.')
  if(topology==='loop'){
    const first=occurrences[0],last=occurrences.at(-1)
    if(!samePlace(first.place.label,last.place.label)){occurrences.push(makeOccurrence(first.place.label,{role:'end',disposition:first.disposition,stay:{kind:'none'},provenance:first.provenance,revisitIntent:true,place:first.place}))}
    occurrences[0]={...occurrences[0],role:'start'};occurrences[occurrences.length-1]={...occurrences.at(-1),role:'end',revisitIntent:true}
  }else{occurrences.forEach((o,i)=>{o.role=i===0?'start':i===occurrences.length-1?'end':'visit'})}
  const candidate=clone(authority);candidate.brief=clone(draft.brief||authority.brief);candidate.topology=topology;candidate.topologyProvenance=topology===authority.topology?authority.topologyProvenance:(draft.topologyProvenance||'traveler')
  const desiredDuration=normalizedDuration(draft.duration,{strict:true,provenance:'traveler'}),durationCore=value=>value?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='provenance')):null
  candidate.duration=JSON.stringify(durationCore(desiredDuration))===JSON.stringify(durationCore(authority.duration))?clone(authority.duration):desiredDuration
  const timing=draft.timing&&typeof draft.timing==='object'?draft.timing:null,startDate=clean(timing?.startDate),endDate=clean(timing?.endDate),season=clean(timing?.season),desiredTiming=(startDate||endDate||season)?{startDate,endDate,season,provenance:timing?.provenance||'traveler'}:null
  const timingCore=value=>value?{startDate:clean(value.startDate),endDate:clean(value.endDate),season:clean(value.season)}:null;candidate.timing=JSON.stringify(timingCore(desiredTiming))===JSON.stringify(timingCore(authority.timing))?clone(authority.timing):desiredTiming
  candidate.occurrences=occurrences
  const oldRequired=authority.placeConstraints?.required||[],oldOptional=authority.placeConstraints?.optional||[],requiredLabels=[],optionalLabels=[]
  for(const occ of occurrences){
    const existing=occ.id?oldById.get(occ.id):null,unchanged=existing&&samePlace(existing.place?.label,occ.place.label)&&existing.disposition===occ.disposition,wasRequired=oldRequired.some(x=>samePlace(x.label,occ.place.label)),wasOptional=oldOptional.some(x=>samePlace(x.label,occ.place.label))
    if(unchanged){if(wasRequired)requiredLabels.push(occ.place.label);else if(wasOptional)optionalLabels.push(occ.place.label);continue}
    if(occ.disposition==='required')requiredLabels.push(occ.place.label);else if(occ.disposition==='optional')optionalLabels.push(occ.place.label)
  }
  for(const entry of oldOptional)if(!occurrences.some(o=>samePlace(o.place.label,entry.label)))optionalLabels.push(entry.label)
  candidate.placeConstraints={
    required:stableConstraintList(oldRequired,requiredLabels,'required'),
    optional:stableConstraintList(oldOptional,optionalLabels,'optional'),
    excluded:stableConstraintList(authority.placeConstraints?.excluded,excludedLabels,'excluded'),
  }
  candidate.scopes=stableObjectList(authority.scopes,draft.scopes||[],'scope','label').map(x=>({...x,kind:x.kind||'region'}))
  candidate.experiences=stableObjectList(authority.experiences,draft.experiences||[],'exp','label')
  candidate.travelers=stableObjectList(authority.travelers,draft.travelers||[],'traveler','name').map((x,i)=>({...x,name:clean(x.name)||`Traveler ${i+1}`}))
  const homeLabel=clean(draft.homeOrigin?.label||draft.homeOrigin);candidate.homeOrigin=homeLabel?(authority.homeOrigin&&samePlace(authority.homeOrigin.label,homeLabel)?{...authority.homeOrigin,label:homeLabel}:{...(typeof draft.homeOrigin==='object'?draft.homeOrigin:{}),label:homeLabel,provenance:'traveler'}):null
  candidate.commitments=stableObjectList(authority.commitments,draft.commitments||[],'commit','text')
  candidate.exclusions=stableObjectList(authority.exclusions,draft.exclusions||[],'exclude','text')
  const desiredTransport=draft.transport&&typeof draft.transport==='object'?draft.transport:{},mode=normalizeMode(desiredTransport.primaryMode)||'Any'
  const scoped=(desiredTransport.scoped||[]).map((x,index)=>{const scope=clean(x?.scope),m=normalizeMode(x?.mode);if(!scope||!m||m==='Any')throw new Error(`Scoped transport row ${index+1} requires a scope and a specific valid mode.`);return{scope,mode:m,provenance:x.provenance||'traveler'}})
  candidate.transport=normalizeTransport({...authority.transport,primaryMode:mode,confirmed:Boolean(desiredTransport.confirmed&&mode!=='Any'),provenance:desiredTransport.provenance||authority.transport?.provenance||null,scoped})
  reconcileLegModes(authority,candidate)
  const validLegIds=new Set();const currentRoute=routeOccurrences(candidate);for(let i=0;i<currentRoute.length-1;i++)validLegIds.add(`leg_${currentRoute[i].id}__${currentRoute[i+1].id}`)
  const requestedModes=desiredTransport.legModes&&typeof desiredTransport.legModes==='object'?desiredTransport.legModes:{},requestedPending=new Set(Array.isArray(desiredTransport.reconfirmationRequiredLegIds)?desiredTransport.reconfirmationRequiredLegIds:[])
  const legModes={...candidate.transport.legModes},pending=new Set(candidate.transport.reconfirmationRequiredLegIds||[])
  for(const [legId,rawMode] of Object.entries(requestedModes)){if(!validLegIds.has(legId))continue;const m=normalizeMode(rawMode);if(!m)throw new Error(`Invalid transport mode "${rawMode}" for ${legId}.`);if(m==='Any'){delete legModes[legId];pending.delete(legId)}else{legModes[legId]=m;if(requestedPending.has(legId))pending.add(legId);else pending.delete(legId)}}
  const reconfirmationRequiredLegIds=[...pending].filter(x=>validLegIds.has(x))
  candidate.transport={...candidate.transport,legModes,reconfirmationRequiredLegIds,pendingLegReviews:reconfirmationRequiredLegIds.length?(candidate.transport.pendingLegReviews||[]):[]}
  return candidate
}

export function previewTripDraft(authority,draft){return setTripDraft(authority,draft)}
export function commitTripDraft(authority,draft){
  if(!authority)return{ok:false,authority,error:'No authoritative trip exists.'}
  let candidate;try{candidate=setTripDraft(authority,draft)}catch(error){return{ok:false,authority,error:error.message}}
  const findings=validateAuthority(candidate),blocker=findings.find(f=>f.severity==='blocker');if(blocker)return{ok:false,authority,findings,error:blocker.message}
  if(sameSemanticAuthority(candidate,authority))return{ok:true,authority,findings,changed:false}
  return{ok:true,authority:touch(candidate),findings,changed:true}
}

export function deriveLegs(authority){
  const route=routeOccurrences(authority),legs=[],pending=new Set(authority?.transport?.reconfirmationRequiredLegIds||[])
  for(let i=0;i<route.length-1;i++){
    const from=route[i],to=route[i+1],legId=`leg_${from.id}__${to.id}`,override=authority?.transport?.legModes?.[legId],mode=override||authority?.transport?.primaryMode||'Any'
    legs.push({id:legId,index:i,fromOccurrenceId:from.id,toOccurrenceId:to.id,mode,modeConfirmed:Boolean(override?(!pending.has(legId)):authority?.transport?.confirmed),source:override?'leg':authority?.transport?.scoped?.length?'primary_with_scoped_rules_pending':'primary'})
  }
  return legs
}
export function validateAuthorityIntegrity(authority){
  const f=[];if(!authority||typeof authority!=='object')return[{code:'NO_AUTHORITY',severity:'blocker',message:'No trip exists.'}]
  if(!Array.isArray(authority.occurrences))f.push({code:'MALFORMED_OCCURRENCES',severity:'blocker',message:'Trip occurrences are malformed.'})
  const all=Array.isArray(authority.occurrences)?authority.occurrences:[],ids=all.map(o=>o?.id).filter(Boolean);if(new Set(ids).size!==ids.length)f.push({code:'DUPLICATE_OCCURRENCE_ID',severity:'blocker',message:'Two route occurrences share the same identity.'})
  for(const o of all){if(!clean(o?.id)||!clean(o?.place?.label))f.push({code:'MALFORMED_OCCURRENCE',severity:'blocker',message:'A route occurrence is missing identity or label.'});if(!['start','visit','end'].includes(o?.role))f.push({code:'INVALID_ROLE',severity:'blocker',message:`Occurrence ${o?.id||'?'} has an invalid role.`});if(!DISPOSITIONS.includes(o?.disposition))f.push({code:'INVALID_DISPOSITION',severity:'blocker',message:`Occurrence ${o?.id||'?'} has an invalid disposition.`})}
  if(!TOPOLOGIES.includes(authority.topology))f.push({code:'INVALID_TOPOLOGY',severity:'blocker',message:'Trip topology is invalid.'})
  if(!authority.transport||!normalizeMode(authority.transport.primaryMode))f.push({code:'INVALID_TRANSPORT_STATE',severity:'blocker',message:'Trip transport state is invalid.'})
  return f
}
export function validateAuthority(authority){
  const f=[...validateAuthorityIntegrity(authority)];if(f.some(x=>x.severity==='blocker'))return f
  const route=routeOccurrences(authority)
  if(route.length<2)f.push({code:'ROUTE_TOO_SHORT',severity:'blocker',message:'The trip needs at least two active route occurrences.'})
  const startCount=route.filter(o=>o.role==='start').length,endCount=route.filter(o=>o.role==='end').length
  if(startCount!==1)f.push({code:startCount?'MULTIPLE_STARTS':'MISSING_START_ROLE',severity:'blocker',message:'The active route must have exactly one start occurrence.'})
  if(endCount!==1)f.push({code:endCount?'MULTIPLE_ENDS':'MISSING_END_ROLE',severity:'blocker',message:'The active route must have exactly one end occurrence.'})
  if(route.length>=2&&route[0]?.role!=='start')f.push({code:'START_NOT_FIRST',severity:'blocker',message:'The start occurrence must be first in canonical order.'})
  if(route.length>=2&&route.at(-1)?.role!=='end')f.push({code:'END_NOT_LAST',severity:'blocker',message:'The end occurrence must be last in canonical order.'})
  if(authority.topology==='loop'&&route.length>=2&&!samePlace(route[0].place.label,route.at(-1).place.label))f.push({code:'OPEN_LOOP',severity:'blocker',message:'Loop topology requires the terminal occurrence to match the start.'})
  for(const o of route)if(excludedByConstraint(authority,o.place.label))f.push({code:'EXCLUDED_PLACE_ROUTED',severity:'blocker',occurrenceId:o.id,message:`Excluded place "${o.place.label}" is still active in the route.`})
  for(const o of authority.occurrences||[])if(o.disposition==='excluded'&&!excludedByConstraint(authority,o.place?.label))f.push({code:'EXCLUSION_STATE_DRIFT',severity:'blocker',occurrenceId:o.id,message:`Occurrence "${o.place?.label||o.id}" is marked excluded without a matching traveler exclusion constraint.`})
  const required=authority.placeConstraints?.required||[],excluded=authority.placeConstraints?.excluded||[]
  for(const req of required){if(excluded.some(x=>samePlace(x.label,req.label)))f.push({code:'REQUIRED_EXCLUDED_CONFLICT',severity:'blocker',message:`Place "${req.label}" cannot be both required and excluded.`});if(!route.some(o=>samePlace(o.place.label,req.label)))f.push({code:'REQUIRED_PLACE_MISSING',severity:'blocker',message:`Traveler-required place "${req.label}" is missing from the active route.`})}
  const parseDate=value=>{const text=clean(value);if(!text)return null;const d=new Date(`${text}T00:00:00Z`);return Number.isNaN(d.getTime())?null:d}
  const startDate=parseDate(authority.timing?.startDate),endDate=parseDate(authority.timing?.endDate)
  if(authority.timing?.startDate&&!startDate)f.push({code:'INVALID_START_DATE',severity:'blocker',message:'Trip start date is invalid.'})
  if(authority.timing?.endDate&&!endDate)f.push({code:'INVALID_END_DATE',severity:'blocker',message:'Trip end date is invalid.'})
  if(startDate&&endDate){const span=Math.floor((endDate-startDate)/86400000)+1;if(span<=0)f.push({code:'END_BEFORE_START',severity:'blocker',message:'Trip end date must be on or after the start date.'});else if(authority.duration?.kind==='exact'&&Number(authority.duration.days)!==span)f.push({code:'DURATION_DATE_CONFLICT',severity:'blocker',message:`Exact duration is ${authority.duration.days} days, but the selected dates span ${span} days.`});else if(authority.duration?.kind==='range'&&(span<Number(authority.duration.minDays)||span>Number(authority.duration.maxDays)))f.push({code:'DURATION_RANGE_DATE_CONFLICT',severity:'blocker',message:`Selected dates span ${span} days, outside the traveler duration range of ${authority.duration.minDays}–${authority.duration.maxDays} days.`})}
  const minimumStayDays=route.reduce((sum,o)=>sum+(['exact','minimum'].includes(o.stay?.kind)?Number(o.stay?.days||0):0),0),maxTripDays=authority.duration?.kind==='exact'?Number(authority.duration.days):authority.duration?.kind==='range'?Number(authority.duration.maxDays):null
  if(Number.isFinite(maxTripDays)&&minimumStayDays>maxTripDays)f.push({code:'STAYS_EXCEED_DURATION',severity:'blocker',message:`Minimum/exact stop stays total ${minimumStayDays} days, which exceeds the trip duration${authority.duration?.kind==='range'?` maximum of ${maxTripDays}`:` of ${maxTripDays}`} days.`})
  const byKey=new Map();for(const o of route){const key=placeMatchKey(o.place.label);if(!byKey.has(key))byKey.set(key,[]);byKey.get(key).push(o)}
  for(const group of byKey.values())if(group.length>1){const closureOnly=group.length===2&&authority.topology==='loop'&&group[0].id===route[0]?.id&&group[1].id===route.at(-1)?.id;if(!closureOnly&&group.some(o=>!o.revisitIntent&&o.id!==route[0]?.id&&o.id!==route.at(-1)?.id))f.push({code:'UNCONFIRMED_REPEAT',severity:'warning',message:`Repeated place "${group[0].place.label}" exists without explicit revisit intent.`})}
  if((authority.transport?.pendingLegReviews||[]).length)f.push({code:'TRANSPORT_LEG_REVIEW',severity:'warning',message:'A route edit changed a leg with an explicit transport override; affected legs need traveler reconfirmation.'})
  return f
}
export function summarizeAuthority(authority){return{id:authority.id,version:authority.version,duration:authority.duration,timing:authority.timing,topology:authority.topology,scopes:authority.scopes,placeConstraints:authority.placeConstraints,route:routeOccurrences(authority).map((o,index)=>({index,id:o.id,role:o.role,label:o.place.label,disposition:o.disposition,stay:o.stay,provenance:o.provenance,revisitIntent:o.revisitIntent})),transport:authority.transport,experiences:authority.experiences,travelers:authority.travelers,homeOrigin:authority.homeOrigin,commitments:authority.commitments,exclusions:authority.exclusions}}
