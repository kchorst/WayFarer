import { TOPOLOGIES, samePlace } from './authority.js'
import { findRouteConvention } from './routeConventions.js'
import { isCountryName } from './geography.js'

const clean=v=>String(v??'').trim()
const clone=v=>structuredClone(v)
const lower=v=>clean(v).toLowerCase()

function sourceValue(value,{source='traveler',status='confirmed',note=''}={}){
  return{value:clean(value),source,status,note:clean(note)}
}
function openValue(note='Open — suggest for me'){
  return{value:'',source:'open',status:'open',note}
}
export function parseDurationText(text){
  const raw=clean(text).toLowerCase().replace(/[–—]/g,'-')
  if(!raw||/^(?:open|flexible|any|not specified)$/.test(raw))return null
  let m=raw.match(/\b(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)\b/)
  if(m){let a=Number(m[1]),b=Number(m[2]),unit=m[3];const mult=unit.startsWith('week')?7:unit.startsWith('month')?30:1;a=Math.round(a*mult);b=Math.round(b*mult);if(a>0&&b>=a)return{kind:'range',minDays:a,maxDays:b,provenance:'traveler'}}
  m=raw.match(/\b(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)\b/)
  if(m){const n=Number(m[1]),unit=m[2],mult=unit.startsWith('week')?7:unit.startsWith('month')?30:1,days=Math.round(n*mult);if(days>0)return{kind:'exact',days,provenance:'traveler'}}
  const words=new Map([['a',1],['an',1],['one',1],['two',2],['three',3],['four',4],['five',5],['six',6],['seven',7],['eight',8],['nine',9],['ten',10],['eleven',11],['twelve',12]])
  m=raw.match(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|days|week|weeks|month|months)\b/)
  if(m){const n=words.get(m[1]),mult=m[2].startsWith('week')?7:m[2].startsWith('month')?30:1;return{kind:'exact',days:n*mult,provenance:'traveler'}}
  return null
}
export function formatDuration(duration){
  if(!duration)return''
  if(duration.kind==='exact')return`${Number(duration.days)} days`
  if(duration.kind==='range')return`${Number(duration.minDays)}–${Number(duration.maxDays)} days`
  return''
}

function stripTrailingTripWords(value){
  return clean(value)
    // Preserve qualified place commas (for example Springfield, Missouri), but stop
    // when a comma clearly starts another traveler instruction.
    .replace(/,\s*(?=(?:and\s+)?(?:include|including|exclude|excluding|avoid|prefer|want|need|with|without|but|then|also|while|where|which|plus)\b)[\s\S]*$/i,'')
    .replace(/\b(?:for|over|during)\s+(?:about\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:days?|weeks?|months?)\b.*$/i,'')
    .replace(/\b(?:loop\s+tour|tour|trip|journey|route|vacation|holiday)\b.*$/i,'')
    .replace(/[,.!?;:]+$/,'').trim()
}
function titleCaseLoose(value){return clean(value).replace(/\s+/g,' ')}
function explicitFromTo(text){
  const source=clean(text)
  const sameBoundaryPatterns=[
    /\b(?:start(?:ing)?|begin(?:ning)?)\s+and\s+(?:finish(?:ing)?|end(?:ing)?)\s+(?:in|at|from)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,80}?)(?=[.!?;]|$)/i,
    /\b(?:start|begin)\s+and\s+(?:finish|end)\s+(?:in|at|from)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,80}?)(?=[.!?;]|$)/i,
  ]
  for(const re of sameBoundaryPatterns){const m=source.match(re);if(m?.[1]){const label=stripTrailingTripWords(m[1]);return{start:label,end:label}}}
  // Natural first-person boundary clauses are common ("I will arrive Tallinn and
  // I will depart from Riga"). Parse each clause independently so intervening
  // duration/destination sentences cannot be swallowed as part of a place name.
  const clausePick=patterns=>{for(const re of patterns){const m=source.match(re);if(m?.[1])return stripTrailingTripWords(m[1])}return''}
  const clauseStop=String.raw`(?=\s+(?:and\s+(?:then\s+)?)?(?:(?:i|we)\s+(?:will\s+)?)?(?:depart|leave|finish|end|fly|have|spend|tour|explore|visit|want|need|give|suggest)\b|\s+then\b|[,!?;.]|$)`
  const clauseStart=clausePick([
    new RegExp(String.raw`\b(?:arriv(?:e|ing)|enter(?:ing)?)(?:\s+(?:in|at|through|via))?\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,80}?)${clauseStop}`,'i'),
    new RegExp(String.raw`\b(?:i|we)\s+(?:will\s+)?(?:arriv(?:e|ing)|enter(?:ing)?)(?:\s+(?:in|at|through|via))?\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,80}?)${clauseStop}`,'i'),
    new RegExp(String.raw`\b(?:(?:i|we)\s+(?:will\s+)?)?(?:start(?:ing)?|begin(?:ning)?)(?:\s+(?:in|at|from))?\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,80}?)${clauseStop}`,'i'),
  ])
  const clauseEnd=clausePick([
    /\b(?:(?:i|we)\s+(?:will\s+)?)?(?:depart|leave)(?:ing)?\s+(?:from\s+)?([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,80}?)(?=[.!?;]|\s+(?:and|then|for|with)\b|$)/i,
    /\b(?:(?:i|we)\s+(?:will\s+)?)?(?:finish|end)(?:ing)?(?:\s+(?:in|at))?\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,80}?)(?=[.!?;]|\s+(?:and|then|for|with)\b|$)/i,
    /\b(?:i|we)\s+(?:will\s+)?fly\s+home\s+from\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,80}?)(?=[.!?;]|$)/i,
  ])
  if(clauseStart||clauseEnd)return{start:clauseStart,end:clauseEnd}
  const patterns=[
    /\b(?:from|start(?:ing)?\s+(?:in|at|from)|begin(?:ning)?\s+(?:in|at|from)|enter(?:ing)?\s+(?:through|via|at|in)?|arriv(?:e|ing)\s+(?:in|at)?)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,80}?)\s+(?:and\s+)?(?:to|end(?:ing)?\s+(?:in|at)|finish(?:ing)?\s+(?:in|at)|depart(?:ing)?\s+(?:from)?|leave|fly\s+home\s+from)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,80}?)(?=[.!?;]|$)/i,
    /\bfrom\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,70}?)\s+to\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,70}?)(?=[,.!?;]|$)/i,
  ]
  for(const re of patterns){const m=source.match(re);if(m?.[1]&&m?.[2])return{start:stripTrailingTripWords(m[1]),end:stripTrailingTripWords(m[2])}}
  const startPatterns=[/\b(?:start|begin)(?:ing)?\s+(?:in|at|from)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,70}?)(?=[,.!?;]|\s+(?:and|with|for)\b|$)/i,/\b(?:enter(?:ing)?|arriv(?:e|ing))(?:\s+(?:in|at|through|via))?\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,70}?)(?=[,.!?;]|\s+(?:and|with|for)\b|$)/i]
  const endPatterns=[/\b(?:end|finish)(?:ing)?\s+(?:in|at)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,70}?)(?=[,.!?;]|\s+(?:and|with|for)\b|$)/i,/\b(?:depart|leave)(?:ing)?\s+(?:from\s+)?([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,70}?)(?=[,.!?;]|\s+(?:and|with|for)\b|$)/i,/\bfly\s+home\s+from\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{0,70}?)(?=[,.!?;]|$)/i]
  const pick=arr=>{for(const re of arr){const m=source.match(re);if(m?.[1])return stripTrailingTripWords(m[1])}return''}
  return{start:pick(startPatterns),end:pick(endPatterns)}
}
const COMPOUND_AND_NAMES=new Set(['bosnia and herzegovina','trinidad and tobago','antigua and barbuda','saint vincent and the grenadines','turks and caicos islands'])
export function splitDestinationAreas(value){
  const raw=clean(value).replace(/\s+/g,' ').replace(/^[,;+\s]+|[,;+\s]+$/g,'')
  if(!raw)return[]
  const plusParts=raw.split(/\s*(?:\+|;|\n)\s*/).map(clean).filter(Boolean)
  if(plusParts.length>1)return plusParts
  if(COMPOUND_AND_NAMES.has(lower(raw)))return[raw]
  // Oxford-comma lists are explicit multi-area lists. A no-Oxford-comma form
  // such as "Estonia, Latvia and Lithuania" is ambiguous with qualified places
  // such as "Springfield, Missouri and St. Louis". Split that ambiguous form
  // only when every element is a recognized country name.
  if(/,\s*(?:and|&)\s+/i.test(raw)){
    const parts=raw.replace(/,\s*(?:and|&)\s+/i,',').split(',').map(clean).filter(Boolean)
    if(parts.length>1&&parts.length<=6&&parts.every(x=>/^[A-ZÀ-Ž]/.test(x)))return parts
  }
  if(raw.includes(',')&&/\s+(?:and|&)\s+/i.test(raw)){
    const parts=raw.replace(/\s+(?:and|&)\s+/i,',').split(',').map(clean).filter(Boolean)
    if(parts.length>1&&parts.length<=6&&parts.every(isCountryName))return parts
    return[raw]
  }
  const andParts=raw.split(/\s+(?:and|&)\s+/i).map(clean).filter(Boolean)
  if(andParts.length>1&&andParts.length<=4&&andParts.every(x=>/^[A-ZÀ-Ž]/.test(x)))return andParts
  return[raw]
}
function destinationHint(text){
  const source=clean(text)
  const patterns=[
    /\b(?:tour|explor(?:e|ing)|visit(?:ing)?)\s+(?!of\b|around\b|through\b|in\b)([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{1,90}?)(?=[!?;.]|\s+(?:for|over|during|starting|start|ending|end|then|include|including|exclude|excluding|prefer|want|need)\b|$)/i,
    /\b(?:loop(?:\s+tour)?|tour|trip|journey|vacation|holiday)\s+(?:of|around|through|in)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{1,90}?)(?=[!?;]|\.(?=\s+(?:I|We|Then|For|Start|Begin|End|Finish|Include|Including|Exclude|Excluding|Prefer|Want|Need|Suggest|Show|Give|Plan|Tell|Explore)\b)|\s+(?:for|over|during|starting|start|ending|end|then|include|including|exclude|excluding|prefer|want|need)\b|$)/i,
    /\b(?:see|explore|visit|travel\s+(?:around|through|in))\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{1,90}?)(?=[!?;]|\.(?=\s+(?:I|We|Then|For|Start|Begin|End|Finish|Include|Including|Exclude|Excluding|Prefer|Want|Need|Suggest|Show|Give|Plan|Tell|Explore)\b)|\s+(?:for|over|during|starting|start|ending|end|then|include|including|exclude|excluding|prefer|want|need)\b|$)/i,
    /\b(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:days?|weeks?|months?)\s+(?:around|through|across|in)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .,'’'\-]{1,90}?)(?=[!?;]|\.(?=\s+(?:I|We|Then|For|Start|Begin|End|Finish|Include|Including|Exclude|Excluding|Prefer|Want|Need|Suggest|Show|Give|Plan|Tell|Explore)\b)|\s+(?:starting|start|ending|end|with|then|include|including|exclude|excluding|prefer|want|need)\b|$)/i,
  ]
  for(const re of patterns){const m=source.match(re);if(m?.[1])return stripTrailingTripWords(m[1])}
  return''
}
function destinationField(value,meta={}){
  const areas=splitDestinationAreas(value),display=areas.length>1?areas.join(' + '):(areas[0]||'')
  return{...sourceValue(display,meta),areas}
}
function recognizedConvention(text){return findRouteConvention(text)}
function durationFromPrompt(text){
  const m=clean(text).match(/\b(?:for|have|spend|with|about|roughly|around)?\s*((?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:to|-|–|—)?\s*(?:\d+(?:\.\d+)?\s*)?(?:days?|weeks?|months?))\b/i)
  return m?parseDurationText(m[1]):null
}
function topologyFromPrompt(text,start,end){
  const t=lower(text)
  if(/\b(?:loop|round[ -]?trip|circuit|return(?:ing)?\s+to\s+(?:the\s+)?start)\b/.test(t))return'loop'
  if(/\b(?:one[ -]?way|open[ -]?jaw)\b/.test(t))return/\bopen[ -]?jaw\b/.test(t)?'open_jaw':'one_way'
  if(start&&end&&!samePlace(start,end))return'one_way'
  if(start&&end&&samePlace(start,end))return'loop'
  return''
}

export function deriveTripBasics(rawText){
  const prompt=clean(rawText),convention=recognizedConvention(prompt),bounds=explicitFromTo(prompt),duration=durationFromPrompt(prompt),destination=destinationHint(prompt)||convention?.destination||'',topology=topologyFromPrompt(prompt,bounds.start,bounds.end)||convention?.topology||''
  let start=bounds.start?sourceValue(bounds.start):convention?.start?sourceValue(convention.start,{source:'route_convention',status:'suggested',note:convention.startNote||'Route-convention start — suggested'}):openValue()
  let end=bounds.end?sourceValue(bounds.end):convention?.end?sourceValue(convention.end,{source:'route_convention',status:'suggested',note:convention.endNote||'Route-convention finish — suggested'}):openValue()
  const topologyField=topology?sourceValue(topology,{source:(/\b(?:loop|one[ -]?way|open[ -]?jaw|round[ -]?trip|circuit)\b/i.test(prompt)||bounds.start&&bounds.end)?'traveler':convention?'route_convention':'inferred',status:(convention&&!/\b(?:loop|one[ -]?way|open[ -]?jaw|round[ -]?trip|circuit)\b/i.test(prompt)&&!(bounds.start&&bounds.end))?'suggested':'confirmed'}):openValue('Open — show me possibilities')
  if(topology==='loop'){
    if(start.value&&!end.value)end=sourceValue(start.value,{source:start.source,status:start.status,note:'Same as start because this is a loop'})
    else if(!start.value&&!end.value)end={...openValue('Same as chosen start'),linkedTo:'start'}
  }
  return{
    version:2,prompt,
    recognizedTrip:convention?{name:convention.name,note:convention.note,source:'route_convention',contextOptions:clone(convention.contextOptions||[])}:null,
    destination:destination?destinationField(titleCaseLoose(destination),{source:convention&&!destinationHint(prompt)?'route_convention':'traveler',status:convention&&!destinationHint(prompt)?'suggested':'confirmed'}):{...openValue('Open — let WAYFINDER infer the area'),areas:[]},
    start,end,
    duration:duration?{value:formatDuration(duration),parsed:duration,source:'traveler',status:'confirmed',note:''}:{value:'',parsed:null,source:'open',status:'open',note:'Open — show me pacing options'},
    topology:topologyField,
    contextSelections:{},
  }
}

export function basicsToConstraintPatch(basics,{confirmed=false}={}){
  const b=clone(basics||{}),patch={}
  const include=field=>field?.value&&((confirmed&&field.status!=='open')||field.source==='traveler'||field.status==='confirmed')
  if(include(b.start))patch.start=clean(b.start.value)
  if(include(b.end))patch.end=clean(b.end.value)
  if(include(b.topology)&&TOPOLOGIES.includes(b.topology.value))patch.topology=b.topology.value
  const duration=b.duration?.parsed||parseDurationText(b.duration?.value);if(duration&&(confirmed||b.duration?.source==='traveler'))patch.duration=duration
  if(include(b.destination)){
    const areas=Array.isArray(b.destination.areas)&&b.destination.areas.length?b.destination.areas:splitDestinationAreas(b.destination.value)
    patch.scopes=areas.map(label=>({kind:isCountryName(label)?'country':'region',label:clean(label),requiredCoverage:true})).filter(x=>x.label)
  }
  const returnToStart=Object.entries(b.contextSelections||{}).some(([id,value])=>Boolean(value)&&b.recognizedTrip?.contextOptions?.some(o=>o.id===id&&o.effect==='return_to_start'))
  if(returnToStart&&patch.start){patch.topology='loop';patch.end=patch.start}
  return patch
}

export function mergeContractWithBasics(contract,basics,{confirmed=true}={}){
  const base=clone(contract||{}),b=basics||{},patch=basicsToConstraintPatch(b,{confirmed})
  // Once the traveler confirms Trip Basics, those five fields own the Spark
  // backbone. An explicitly open field is permission for Spark to vary it, not
  // permission for the background extractor to promote a hidden guess into a
  // hard constraint.
  if(confirmed){
    if(b.start?.status==='open')delete base.start
    if(b.end?.status==='open')delete base.end
    if(b.topology?.status==='open')delete base.topology
    if(b.duration?.status==='open')delete base.duration
    if(b.destination?.status==='open')base.scopes=[]
  }
  if(patch.start!==undefined)base.start=patch.start
  if(patch.end!==undefined)base.end=patch.end
  if(patch.topology!==undefined)base.topology=patch.topology
  if(patch.duration!==undefined)base.duration=patch.duration
  if(patch.scopes?.length)base.scopes=patch.scopes
  // Destination areas are geographic coverage, not literal route-stop
  // requirements. Extractors may phrase "see Estonia, Latvia and Lithuania"
  // as requiredPlaces; once the traveler confirms those same labels as the
  // destination areas, remove the duplicate place-role interpretation.
  const scopeLabels=(base.scopes||[]).map(x=>clean(typeof x==='string'?x:x?.label)).filter(Boolean)
  if(scopeLabels.length){
    const isScope=value=>scopeLabels.some(scope=>samePlace(scope,value))
    base.requiredPlaces=(base.requiredPlaces||[]).filter(x=>!isScope(x))
    base.optionalPlaces=(base.optionalPlaces||[]).filter(x=>!isScope(x))
  }
  if(base.topology==='loop'&&base.start&&!base.end)base.end=base.start
  return base
}

export function contractFingerprint(contract){
  const c=contract||{},norm=v=>clean(v).toLowerCase(),scopes=(c.scopes||[]).map(x=>norm(typeof x==='string'?x:x?.label)).filter(Boolean).sort(),scopeSet=new Set(scopes)
  return JSON.stringify({
    start:norm(c.start),end:norm(c.end),topology:norm(c.topology),duration:c.duration||null,
    scopes,
    required:(c.requiredPlaces||[]).map(norm).filter(x=>x&&!scopeSet.has(x)).sort(),optional:(c.optionalPlaces||[]).map(norm).filter(x=>x&&!scopeSet.has(x)).sort(),excluded:(c.excludedPlaces||[]).map(norm).sort(),
    commitments:c.commitments||[],exclusions:c.exclusions||[],
  })
}

export function validateBasics(basics){
  const f=[],b=basics||{},top=clean(b.topology?.value)
  if(top&& !TOPOLOGIES.includes(top))f.push({code:'BASICS_TOPOLOGY',severity:'blocker',message:'Trip shape is invalid.'})
  const duration=b.duration?.value?parseDurationText(b.duration.value):null
  if(b.duration?.value&&!duration)f.push({code:'BASICS_DURATION',severity:'blocker',message:'Duration should look like “3 weeks”, “21 days”, or “7–10 days”, or be left open.'})
  if(top==='loop'&&b.start?.value&&b.end?.value&&!samePlace(b.start.value,b.end.value))f.push({code:'BASICS_LOOP_BOUNDARY',severity:'blocker',message:'A loop must finish at the same place it starts. Change the trip shape or make the start and finish match.'})
  return f
}
