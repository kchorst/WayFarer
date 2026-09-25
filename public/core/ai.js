import { summarizeAuthority, TOPOLOGIES, TRANSPORT_MODES, samePlace, placeMatchKey, routeOccurrences, authorityFromProposal, validateAuthority } from './authority.js'
import { createSentenceAccumulator } from './stream.js'
import { createDocumentPlan, normalizeDocumentPreferences } from './documentPlan.js'
import { proposalInvariantViolations, rawProposalContractViolations, scopeKeys } from './proposalPolicy.js'
import { createDeadline } from './deadline.js'

async function chat(messages,{temperature=.2,max_tokens=1600,stream=false,signal}={}){
  const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({messages,temperature,max_tokens,stream})})
  if(!r.ok){const d=await r.json().catch(()=>({}));const detail=String(d.detail||'').replace(/\s+/g,' ').trim();throw new Error(`${d.error||`Local model returned ${r.status}`}${detail?` — ${detail.slice(0,240)}`:''}`)}
  return r
}
function cleanFence(s){return String(s||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim()}
function parseJsonLoose(text){const s=cleanFence(text);try{return JSON.parse(s)}catch{}const first=s.indexOf('{'),last=s.lastIndexOf('}');if(first>=0&&last>first){try{return JSON.parse(s.slice(first,last+1))}catch{}}throw new Error('The local model did not return valid structured JSON.')}
async function jsonChat(messages,opts={}){const r=await chat(messages,{...opts,stream:false});const d=await r.json();return parseJsonLoose(d?.choices?.[0]?.message?.content||'')}
async function jsonChatRetry(messages,opts={},repairMessage='Return only valid JSON matching the requested schema.'){
  try{return await jsonChat(messages,opts)}catch(first){
    try{return await jsonChat([...messages,{role:'user',content:repairMessage}],{...opts,temperature:0})}catch(second){throw new Error(`${first.message} Retry also failed: ${second.message}`)}
  }
}
function normalizeMode(value){const key=String(value||'').trim().toLowerCase();return TRANSPORT_MODES.find(x=>x.toLowerCase()===key)||'Any'}
function asArray(value){return Array.isArray(value)?value:[]}
function stringArray(value){return asArray(value).map(String).map(x=>x.trim()).filter(Boolean)}
function normalizeConstraints(raw={}){
  raw=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{}
  const duration=raw.duration&&typeof raw.duration==='object'&&!Array.isArray(raw.duration)?raw.duration:null,mode=normalizeMode(raw.transport?.primaryMode)
  return{
    duration,timing:raw.timing&&typeof raw.timing==='object'&&!Array.isArray(raw.timing)?{startDate:String(raw.timing.startDate||''),endDate:String(raw.timing.endDate||''),season:String(raw.timing.season||'')}:null,
    topology:TOPOLOGIES.includes(raw.topology)?raw.topology:null,start:String(raw.start||'').trim(),end:String(raw.end||'').trim(),
    requiredPlaces:stringArray(raw.requiredPlaces),optionalPlaces:stringArray(raw.optionalPlaces),excludedPlaces:stringArray(raw.excludedPlaces),
    scopes:asArray(raw.scopes).map(s=>typeof s==='string'?s:{kind:s&&typeof s==='object'?s.kind||'region':'region',label:String(s&&typeof s==='object'?s.label||'':'' ).trim(),countryCode:String(s&&typeof s==='object'?s.countryCode||'':''),requiredCoverage:Boolean(s&&typeof s==='object'&&s.requiredCoverage)}).filter(s=>typeof s==='string'?s.trim():s.label),
    transport:{primaryMode:mode,confirmed:Boolean(raw.transport?.confirmed===true&&mode!=='Any'),scoped:asArray(raw.transport?.scoped).filter(x=>x&&typeof x==='object').map(x=>({scope:String(x.scope||'').trim(),mode:normalizeMode(x.mode)})).filter(x=>x.scope&&x.mode!=='Any')},
    experiences:{required:stringArray(raw.experiences?.required),preferred:stringArray(raw.experiences?.preferred),excluded:stringArray(raw.experiences?.excluded)},
    commitments:stringArray(raw.commitments),exclusions:stringArray(raw.exclusions),travelers:asArray(raw.travelers).filter(x=>x&&typeof x==='object'),homeOrigin:String(raw.homeOrigin||'').trim(),
    conflicts:stringArray(raw.conflicts),clarificationQuestion:String(raw.clarificationQuestion||'').trim(),
  }
}
function emptyConstraints(){return normalizeConstraints({})}
export function validateTravelerContract(constraints){
  const c=constraints||{},findings=[]
  if(c.extractorWarning)findings.push({code:'CONTRACT_EXTRACTION_FAILED',severity:'blocker',message:c.extractorWarning})
  const required=c.requiredPlaces||[],excluded=c.excludedPlaces||[]
  for(const place of required)if(excluded.some(x=>samePlace(x,place)))findings.push({code:'CONTRACT_REQUIRED_EXCLUDED',severity:'blocker',message:`"${place}" cannot be both required and excluded.`})
  if(c.topology==='loop'&&c.start&&c.end&&!samePlace(c.start,c.end))findings.push({code:'CONTRACT_OPEN_LOOP',severity:'blocker',message:`Loop basics conflict: start "${c.start}" and finish "${c.end}" do not match.`})
  if(c.duration?.kind==='exact'&&(!Number.isFinite(Number(c.duration.days))||Number(c.duration.days)<=0))findings.push({code:'CONTRACT_DURATION',severity:'blocker',message:'Exact duration must be greater than zero.'})
  if(c.duration?.kind==='range'&&(!Number.isFinite(Number(c.duration.minDays))||!Number.isFinite(Number(c.duration.maxDays))||Number(c.duration.minDays)<=0||Number(c.duration.maxDays)<Number(c.duration.minDays)))findings.push({code:'CONTRACT_DURATION_RANGE',severity:'blocker',message:'Duration range is invalid.'})
  return findings
}
function explicitBoundaryConflict(rawText,kind){
  const verb=kind==='start'?'(?:start|begin)(?:ing)?':'(?:end|finish)(?:ing)?'
  const re=new RegExp(`\\b(?:must\\s+)?${verb}\\s+(?:in|at|from)\\s+([A-Za-zÀ-ž][A-Za-zÀ-ž \'-]{0,40})(?=[,.!?;]|$)`,'gi')
  const values=[...String(rawText||'').matchAll(re)].map(m=>m[1].trim().replace(/\s+(?:and|but|then)\b.*$/i,'')).map(placeMatchKey).filter(Boolean)
  return new Set(values).size>1
}
function conflictsCorroborated(rawText,constraints){return Boolean(constraints.conflicts?.length&&(explicitBoundaryConflict(rawText,'start')||explicitBoundaryConflict(rawText,'end')))}

export async function extractTravelerConstraints(rawText,{signal,onProgress}={}){
  const system=`You are the Traveler Contract extractor for WAYFINDER. Return ONLY JSON with traveler-owned facts that are EXPLICITLY stated or unambiguously entailed by the traveler. Do not make recommendations and do not promote guesses into constraints.
Allowed fields: duration {kind:"exact",days:N} or {kind:"range",minDays:N,maxDays:N}; timing {startDate,endDate,season}; topology (loop, one_way, open_jaw, flexible, circumnavigation); start; end; requiredPlaces; optionalPlaces; excludedPlaces; scopes [{kind,label,countryCode?}]; transport {primaryMode,confirmed,scoped}; experiences {required,preferred,excluded}; commitments; exclusions; travelers; homeOrigin.
Use transport mode only from Any, Car, Train, Bus, Ferry, Walk, Bike, Air, Mixed. Set confirmed true only when the traveler explicitly commits to that mode; preference words such as "prefer", "maybe", or "could" are not confirmation.
You may return conflicts and clarificationQuestion only when the traveler explicitly states mutually incompatible hard facts. Broad geography is not a conflict.
Countries, regions and islands are geographic scopes unless the traveler explicitly makes them literal route anchors. Markets, neighborhoods, attractions and activities are experiences unless explicitly made route stops. If a field was not stated, omit it.`
  try{
    onProgress?.('Reading your traveler constraints…')
    const out=normalizeConstraints(await jsonChatRetry([{role:'system',content:system},{role:'user',content:`Traveler request:\n${rawText}`}],{temperature:0,max_tokens:850,signal},'Your previous JSON was malformed. Return only one valid JSON object using the allowed Traveler Contract fields.'))
    // Spark may remember a stated preference, but routing confirmation is never inferred by the model.
    // Confirmation is traveler-owned and must happen through a direct Precision action or an
    // explicitly confirmed Revision command.
    out.transport.confirmed=false
    return out
  }catch(error){return{...emptyConstraints(),extractorWarning:`Traveler-contract extraction failed: ${error.message}`}}
}
function canonicalProposalTitle(stops,topology){
  const labels=(stops||[]).map(String).map(x=>x.trim()).filter(Boolean)
  if(!labels.length)return'Trip idea'
  const start=labels[0],end=labels.at(-1)
  if(topology==='loop')return`${start} loop`
  if((topology==='one_way'||topology==='open_jaw')&&end)return`${start} to ${end}`
  if(end&&start!==end)return`${start} to ${end}`
  return`${start} route`
}

function enforceProposalConstraints(raw,constraints){
  const rawStops=(raw.stops||[]).map(x=>typeof x==='string'?{label:x,kind:'unknown'}:{label:String(x?.label||''),kind:String(x?.kind||'unknown').toLowerCase()}).map(x=>({...x,label:x.label.trim()})).filter(x=>x.label)
  const nonRouteKinds=new Set(['experience','activity','attraction','neighborhood','market','scope','region','country','island','continent','state','province','territory','prefecture','district','county','archipelago','administrative','admin','poi','landmark'])
  const removedKinds=rawStops.filter(x=>nonRouteKinds.has(x.kind)).map(x=>x.label)
  let stops=rawStops.filter(x=>!nonRouteKinds.has(x.kind)).map(x=>x.label),advisories=[]
  if(removedKinds.length)advisories.push({code:'NON_ROUTE_ITEMS_REMOVED',severity:'warning',message:`Kept non-route items out of the route spine: ${removedKinds.join(', ')}`})
  const scopes=scopeKeys(constraints),excluded=(constraints.excludedPlaces||[]).filter(Boolean)
  const literalScope=stops.filter(s=>scopes.has(placeMatchKey(s)))
  if(literalScope.length){advisories.push({code:'SCOPE_REMOVED_FROM_ROUTE',severity:'warning',message:`Removed broad scope labels from literal route stops: ${literalScope.join(', ')}`});stops=stops.filter(s=>!scopes.has(placeMatchKey(s)))}
  stops=stops.filter(s=>!excluded.some(x=>samePlace(x,s)))
  const start=String(constraints.start||'').trim(),end=String(constraints.end||'').trim(),topology=constraints.topology||(TOPOLOGIES.includes(raw.topology)?raw.topology:'flexible')
  if(start){const idx=stops.findIndex(s=>samePlace(s,start));if(idx>=0)stops.splice(idx,1);stops.unshift(start)}
  let terminal=end
  if(topology==='loop'&&start&&!terminal)terminal=start
  if(terminal){let idx=-1;for(let i=stops.length-1;i>=0;i--)if(samePlace(stops[i],terminal)){idx=i;break}if(idx>=0)stops.splice(idx,1);stops.push(terminal)}
  const insertIndex=()=>terminal?Math.max(0,stops.length-1):stops.length
  for(const place of constraints.requiredPlaces||[]){const label=String(place||'').trim();if(!label||scopes.has(placeMatchKey(label))||stops.some(s=>samePlace(s,label)))continue;stops.splice(insertIndex(),0,label)}
  if(topology==='loop'&&stops.length&& !samePlace(stops[0],stops.at(-1)))stops.push(stops[0])
  const exactDays=constraints.duration?.kind==='exact'?Number(constraints.duration.days):null
  const modelDays=Number(raw.days)>0?Number(raw.days):null
  if(Number.isFinite(exactDays)&&modelDays&&modelDays!==exactDays)advisories.push({code:'SPARK_DURATION_CORRECTED',severity:'warning',message:`Proposal duration was corrected from ${modelDays} to traveler-required ${exactDays} days.`})
  if(constraints.topology&&raw.topology&&raw.topology!==constraints.topology)advisories.push({code:'SPARK_TOPOLOGY_CORRECTED',severity:'warning',message:`Proposal topology was corrected to traveler-required ${constraints.topology}.`})
  return{title:canonicalProposalTitle(stops,topology),summary:String(raw.summary||'').trim(),stops,days:Number.isFinite(exactDays)&&exactDays>0?exactDays:modelDays,topology,themes:(raw.themes||[]).map(String).map(x=>x.trim()).filter(Boolean),advisories}
}
async function streamSparkProposalLines(messages,{signal,onRawProposal=()=>{},maxTokens=900,temperature=.28}={}){
  const r=await chat(messages,{temperature,max_tokens:maxTokens,stream:true,signal})
  const contentType=String(r.headers.get('content-type')||'').toLowerCase()
  if(!contentType.includes('text/event-stream')){
    const payload=await r.json(),content=payload?.choices?.[0]?.message?.content||'';let parsed=null
    try{parsed=parseJsonLoose(content)}catch{}
    if(Array.isArray(parsed?.proposals)){for(const proposal of parsed.proposals)onRawProposal(proposal);return parsed.proposals.length}
    if(parsed&&typeof parsed==='object'){onRawProposal(parsed);return 1}
    throw new Error('Spark server did not return a usable streaming or structured response.')
  }
  if(!r.body)throw new Error('Spark streaming response had no body.')
  const reader=r.body.getReader(),decoder=new TextDecoder();let sseBuffer='',modelBuffer='',accepted=0
  const consumeModelLine=raw=>{
    let line=String(raw||'').trim().replace(/^```(?:json|jsonl|ndjson)?\s*/i,'').replace(/\s*```$/,'').trim()
    line=line.replace(/^(?:[-*]|\d+[.)])\s+/,'').trim();if(!line)return
    try{const parsed=JSON.parse(line),proposal=parsed?.proposal&&typeof parsed.proposal==='object'?parsed.proposal:parsed;if(proposal&&typeof proposal==='object'){onRawProposal(proposal);accepted++}}catch{/* incomplete/non-JSON line is ignored; bounded fallback handles missing concepts */}
  }
  const pushToken=token=>{modelBuffer+=token;const parts=modelBuffer.split(/\r?\n/);modelBuffer=parts.pop()||'';for(const line of parts)consumeModelLine(line)}
  const consumeFrame=raw=>{if(!raw||raw==='[DONE]')return;const j=JSON.parse(raw);if(j?.error)throw new Error(j.error.message||j.error);const choice=j?.choices?.[0],token=choice?.delta?.content||choice?.text||'';if(token)pushToken(token)}
  while(true){const{done,value}=await reader.read();if(done)break;sseBuffer+=decoder.decode(value,{stream:true});const lines=sseBuffer.split('\n');sseBuffer=lines.pop()||'';for(const line of lines){const t=line.trim();if(t.startsWith('data:'))consumeFrame(t.slice(5).trim())}}
  sseBuffer+=decoder.decode();for(const line of sseBuffer.split('\n')){const t=line.trim();if(t.startsWith('data:'))consumeFrame(t.slice(5).trim())}consumeModelLine(modelBuffer)
  return accepted
}

export async function generateSparkFromContract(rawText,constraints,{signal,onProgress,onProposal,onProposalUpdate,validateProposal,firstIdeaTargetMs=14500,targetCount=3,enrich=true,seedProposals=[]}={}){
  const contract=normalizeConstraints(constraints||{}),contractFindings=validateTravelerContract(contract),contractBlocker=contractFindings.find(x=>x.severity==='blocker')
  if(contractBlocker)throw new Error(contractBlocker.message)
  const target=Math.max(1,Math.min(3,Math.trunc(Number(targetCount)||3)))
  onProgress?.(Array.isArray(seedProposals)&&seedProposals.length?'Building additional route skeletons…':'Building the first route skeleton now…')
  const contractText=JSON.stringify(contract,null,2),proposals=[],stamp=Date.now(),rejected=[]
  for(const seed of Array.isArray(seedProposals)?seedProposals:[]){
    if(proposals.length>=target)break
    const p=structuredClone(seed||{})
    if(!Array.isArray(p.stops)||p.stops.length<2||proposalInvariantViolations(p,contract).length)continue
    const key=`${String(p.title||'').toLowerCase()}|${p.stops.map(placeMatchKey).join('>')}`
    if(proposals.some(x=>x.__key===key))continue
    if(!p.id)p.id=`proposal_${stamp}_seed_${proposals.length}`
    if(!p.enrichmentStatus)p.enrichmentStatus='pending'
    Object.defineProperty(p,'__key',{value:key,enumerable:false});proposals.push(p)
  }
  let validationQueue=Promise.resolve()
  const acceptRaw=async raw=>{
    if(proposals.length>=target)return false
    const preflight=rawProposalContractViolations(raw,contract)
    if(preflight.length){rejected.push({title:String(raw?.title||'Trip idea'),violations:preflight});onProgress?.('Discarded one route skeleton that contradicted the confirmed trip contract · continuing…');return false}
    const p={id:`proposal_${stamp}_${proposals.length}`,...enforceProposalConstraints(raw,contract),enrichmentStatus:'pending'},violations=proposalInvariantViolations(p,contract)
    if(violations.length){rejected.push({title:p.title,violations});onProgress?.('Discarded one route skeleton that did not match the confirmed trip basics · continuing…');return false}
    if(p.stops.length<2)return false
    if(validateProposal){
      const verdict=await validateProposal(structuredClone(p),structuredClone(contract)),ok=verdict===true||verdict?.ok===true
      if(!ok){const reason=typeof verdict==='string'?verdict:verdict?.reason||'route-scope verification failed';rejected.push({title:p.title,violations:[`proposal-validation:${reason}`]});onProgress?.('Discarded one route skeleton that failed geographic-scope verification · continuing…');return false}
      if(Array.isArray(verdict?.advisories)&&verdict.advisories.length)p.advisories=[...(p.advisories||[]),...verdict.advisories]
      p.verificationStatus=verdict?.verified===false?'unverified':'verified'
    }
    if(!p.verificationStatus)p.verificationStatus='verified'
    const candidate=authorityFromProposal({brief:rawText,constraints:contract,proposal:p}),authorityBlockers=validateAuthority(candidate).filter(x=>x.severity==='blocker')
    if(authorityBlockers.length){rejected.push({title:p.title,violations:authorityBlockers.map(x=>x.code)});onProgress?.('Discarded one route skeleton that could not become a valid authoritative trip · continuing…');return false}
    const key=`${p.title.toLowerCase()}|${p.stops.map(placeMatchKey).join('>')}`;if(proposals.some(x=>x.__key===key))return false
    Object.defineProperty(p,'__key',{value:key,enumerable:false});proposals.push(p);onProposal?.(structuredClone(p),{index:proposals.length-1,totalTarget:target,phase:'skeleton'});onProgress?.(`Route skeleton ${proposals.length} ready${proposals.length<target?' · building another alternative…':enrich?' · enriching details…':''}`);return true
  }
  const enqueue=raw=>{validationQueue=validationQueue.then(()=>acceptRaw(raw));return validationQueue}
  const skeletonRules=`The Traveler Contract is authoritative. Preserve confirmed start/end, required places, exclusions, duration, topology, and every required geographic coverage area. Countries, regions and islands are coverage areas, not literal route stops. Use actual cities/ports/route anchors. For a loop, repeat the start as the final occurrence. Do not invent schedules, prices, visas, or traveler facts.`
  if(!proposals.length){
    const firstMessages=[{role:'system',content:`You are WAYFINDER Spark. Return ONE route skeleton as one NDJSON line and nothing else. Schema: {"title":"","stops":[{"label":"","kind":"settlement|poi|landmark","routeOccurrence":true}],"days":14,"topology":"loop|one_way|open_jaw|flexible"}. ${skeletonRules} Finish this one complete JSON line as quickly as possible; do not write a summary or themes yet.`},{role:'user',content:`Traveler request:\n${rawText}\n\nAUTHORITATIVE TRAVELER CONTRACT:\n${contractText}`}]
    const firstIdeaDeadline=createDeadline(signal,{ms:Math.max(10,Math.min(14500,Number(firstIdeaTargetMs)||14500)),label:'First Spark route skeleton'})
    try{
      await streamSparkProposalLines(firstMessages,{signal:firstIdeaDeadline.signal,onRawProposal:enqueue,maxTokens:360,temperature:.12});await validationQueue
    }catch(error){
      if(signal?.aborted)throw error
      if(firstIdeaDeadline.timedOut)onProgress?.('The first-route stream exceeded the fast target · switching immediately to the bounded alternatives pass…')
      else if(error?.name!=='AbortError'&&error?.name!=='TimeoutError')onProgress?.('The first skeleton stream ended early · trying the bounded alternatives pass…')
    }finally{firstIdeaDeadline.dispose()}
  }
  if(proposals.length<target){
    const missing=target-proposals.length
    onProgress?.(`${proposals.length?'First route skeleton is visible':'Still seeking a valid first skeleton'} · building ${missing} more alternative${missing===1?'':'s'}…`)
    const moreMessages=[{role:'system',content:`You are WAYFINDER Spark. Stream up to ${missing} additional route skeletons as NDJSON, one complete JSON object per line, no array or commentary. Schema: {"title":"","stops":[{"label":"","kind":"settlement|poi|landmark","routeOccurrence":true}],"days":14,"topology":"loop|one_way|open_jaw|flexible"}. ${skeletonRules} Do not duplicate already accepted routes. Complete each line before starting the next.`},{role:'user',content:`Traveler request:\n${rawText}\n\nTRAVELER CONTRACT:\n${contractText}\n\nALREADY ACCEPTED:\n${JSON.stringify(proposals.map(p=>({title:p.title,stops:p.stops})))}`}]
    try{await streamSparkProposalLines(moreMessages,{signal,onRawProposal:enqueue,maxTokens:Math.min(1050,420*missing),temperature:.28});await validationQueue}catch(error){if(error?.name==='AbortError')throw error;if(error?.name==='TimeoutError'&&!proposals.length)throw error;onProgress?.(`Spark alternatives stream ended after ${proposals.length} valid route skeleton${proposals.length===1?'':'s'} · using what is ready.`)}
  }
  if(proposals.length<target){
    const missing=target-proposals.length
    onProgress?.(`${proposals.length} route skeleton${proposals.length===1?' is':'s are'} ready · making one bounded fill pass for ${missing} missing alternative${missing===1?'':'s'}…`)
    try{
      const data=await jsonChat([{role:'system',content:`You are WAYFINDER Spark skeleton completion. Return ONLY valid JSON {"proposals":[...]} with exactly ${missing} additional route skeleton${missing===1?'':'s'}. Each proposal uses {"title":"","stops":[{"label":"","kind":"settlement|poi|landmark","routeOccurrence":true}],"days":14,"topology":"loop|one_way|open_jaw|flexible"}. Preserve the authoritative Traveler Contract and every required geographic coverage area. Do not duplicate accepted routes.`},{role:'user',content:`Traveler request:
${rawText}

TRAVELER CONTRACT:
${contractText}

ALREADY ACCEPTED:
${JSON.stringify(proposals.map(p=>({title:p.title,stops:p.stops})))}`}],{temperature:.2,max_tokens:Math.min(650,260*missing+130),signal})
      for(const raw of Array.isArray(data.proposals)?data.proposals:[])enqueue(raw)
      await validationQueue
    }catch{/* already-visible valid skeletons remain usable */}
  }
  if(!proposals.length)throw new Error('No Spark route skeleton satisfied the confirmed Traveler Contract within the bounded attempt. Change the basics or try again; WAYFINDER will not show a route that violates them.')

  // Enrichment is deliberately second-phase. A route skeleton is already visible before this call.
  if(enrich){
    onProgress?.('Route skeletons are ready · enriching summaries and themes in the background…')
    try{
      const data=await jsonChat([{role:'system',content:'You enrich already-validated WAYFINDER route skeletons. Return ONLY JSON {"enrichments":[{"index":0,"summary":"","themes":[""]}]}. Do not add, remove, reorder, rename, retitle, or reinterpret route stops; do not change duration/topology. Keep summaries concise and grounded in the traveler request and contract.'},{role:'user',content:`Traveler request:\n${rawText}\n\nTRAVELER CONTRACT:\n${contractText}\n\nVALIDATED ROUTE SKELETONS:\n${JSON.stringify(proposals.map((p,index)=>({index,title:p.title,stops:p.stops,days:p.days,topology:p.topology})))}`}],{temperature:.22,max_tokens:700,signal})
      for(const item of Array.isArray(data.enrichments)?data.enrichments:[]){const i=Number(item.index);if(!Number.isInteger(i)||i<0||i>=proposals.length)continue;const p=proposals[i];p.summary=String(item.summary||'').trim();p.themes=(item.themes||[]).map(String).map(x=>x.trim()).filter(Boolean);p.enrichmentStatus='complete';onProposalUpdate?.(structuredClone(p),{index:i,phase:'enriched'})}
    }catch(error){if(error?.name==='AbortError')throw error;onProgress?.('Route skeletons are complete; optional enrichment did not finish. Using complete fallback summaries.')}
    for(let i=0;i<proposals.length;i++){if(proposals[i].enrichmentStatus!=='complete'){proposals[i].enrichmentStatus='fallback';proposals[i].summary=proposals[i].summary||'Validated route skeleton ready. Additional descriptive enrichment was not required to use this idea.';onProposalUpdate?.(structuredClone(proposals[i]),{index:i,phase:'fallback'})}}
    onProgress?.(`${proposals.length} validated route concept${proposals.length===1?'':'s'} ready.`)
  }else onProgress?.(`${proposals.length} validated route skeleton${proposals.length===1?'':'s'} ready for traveler-contract checking.`)
  return{constraints:contract,proposals,warnings:[],rejected}
}

export async function generateSpark(rawText,{signal,onProgress,onProposal,onContract}={}){
  onProgress?.('Reading your request…')
  const constraints=await extractTravelerConstraints(rawText,{signal,onProgress})
  onContract?.(structuredClone(constraints))
  const findings=validateTravelerContract(constraints),blocker=findings.find(x=>x.severity==='blocker')
  if(blocker)throw new Error(blocker.message)
  if(conflictsCorroborated(rawText,constraints))return{constraints,proposals:[],clarification:{question:constraints.clarificationQuestion||'Your request contains conflicting explicit route boundaries. Which one should WAYFINDER keep?',conflicts:constraints.conflicts}}
  constraints.conflicts=[];constraints.clarificationQuestion=''
  return generateSparkFromContract(rawText,constraints,{signal,onProgress,onProposal})
}

function revisionExplicitlyConfirmsTransport(text){
  const t=String(text||'').toLowerCase()
  if(!t.trim())return false
  const preference=/\b(prefer|preference|maybe|might|could|consider|possibly|if possible)\b/.test(t)
  const strong=/\b(must|definitely|confirm(?:ed)?|switch(?:ing)? to|change(?:ing)? to|use|take|travel by|go by|drive|driving|fly|flying|walk|walking|bike|biking|cycle|cycling)\b/.test(t)
  return strong&&!preference
}

function trimRevisionPlace(value){return String(value||'').trim().replace(/^\b(?:in|at|from)\s+/i,'').replace(/\s+(?:and|but|then|so)\b.*$/i,'').replace(/[,.!?;:]+$/,'').trim()}
function revisionPlaceHint(text,kind){
  const source=String(text||'')
  const patterns=kind==='start'?
    [/\b(?:enter|arrive(?:\s+in|\s+at)?|start(?:ing)?(?:\s+in|\s+at|\s+from)?|begin(?:ning)?(?:\s+in|\s+at|\s+from)?)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .'-]{0,70}?)(?=\s+(?:and|but|then|so)\b|[,!?;.]|$)/i]:
    [/\b(?:depart(?:\s+from)?|leave(?:\s+from)?|end(?:ing)?(?:\s+in|\s+at)?|finish(?:ing)?(?:\s+in|\s+at)?|fly\s+home\s+from)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .'-]{0,70}?)(?=\s+(?:and|but|then|so)\b|[,!?;.]|$)/i]
  for(const re of patterns){const m=source.match(re);if(m?.[1])return trimRevisionPlace(m[1])}
  return''
}
function revisionUniquePlaces(text){
  const source=String(text||''),out=[]
  const patterns=[/\bonly\s+(?:one|1)\s+(?:stop|visit|occurrence)\s+(?:in|at)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .'-]{0,70}?)(?=[,.!?;]|$)/gi,/\bonly\s+(?:one|1)\s+([A-ZÀ-Ž][A-Za-zÀ-ž0-9 .'-]{1,60}?)\s+(?:stop|visit|occurrence)(?=[,.!?;]|$)/gi]
  for(const re of patterns)for(const m of source.matchAll(re)){const label=trimRevisionPlace(m[1]);if(label&&!out.some(x=>samePlace(x,label)))out.push(label)}
  return out
}
function explicitRevisionTopology(text){
  const t=String(text||'').toLowerCase()
  if(/\bopen[- ]jaw\b/.test(t))return'open_jaw'
  if(/\bone[- ]way\b/.test(t))return'one_way'
  if(/\bcircumnavigation\b/.test(t))return'circumnavigation'
  if(/\bloop\b/.test(t))return'loop'
  if(/\bflexible\b/.test(t))return'flexible'
  return''
}
function normalizeRevisionPlan(authority,text,rawCommands=[]){
  let commands=rawCommands.map(c=>({type:c.type,payload:c.payload&&typeof c.payload==='object'?{...c.payload}:{}}))
  const startHint=revisionPlaceHint(text,'start'),endHint=revisionPlaceHint(text,'end'),topologyHint=explicitRevisionTopology(text),uniquePlaces=revisionUniquePlaces(text)
  const upsert=(type,payload)=>{const index=commands.findIndex(c=>c.type===type);if(index>=0)commands[index]={type,payload:{...commands[index].payload,...payload}};else commands.push({type,payload})}
  if(startHint)upsert('SET_START',{label:startHint})
  if(endHint)upsert('SET_END',{label:endHint})
  if(topologyHint)upsert('SET_TOPOLOGY',{topology:topologyHint})
  const current=routeOccurrences(authority),currentStart=current[0]?.place?.label||'',desiredStart=startHint||currentStart,desiredEnd=endHint||current.at(-1)?.place?.label||''
  if(authority?.topology==='loop'&&desiredStart&&desiredEnd&&!samePlace(desiredStart,desiredEnd)&&!topologyHint)upsert('SET_TOPOLOGY',{topology:'flexible'})
  const existingRemoveIds=new Set(commands.filter(c=>c.type==='REMOVE_OCCURRENCE').map(c=>c.payload?.occurrenceId).filter(Boolean))
  for(const label of uniquePlaces){
    const matches=current.filter(o=>samePlace(o.place?.label,label));if(matches.length<=1)continue
    let keep=matches[0]
    if(startHint&&samePlace(startHint,label))keep=matches.find(o=>o.role==='start')||keep
    else if(endHint&&samePlace(endHint,label))keep=[...matches].reverse().find(o=>o.role==='end')||matches.at(-1)||keep
    for(const o of matches)if(o.id!==keep.id&&!existingRemoveIds.has(o.id)){commands.push({type:'REMOVE_OCCURRENCE',payload:{occurrenceId:o.id,confirmTravelerOwned:true}});existingRemoveIds.add(o.id)}
  }
  // Interdependent route-boundary edits are a transaction: topology first, then boundaries,
  // then the model's remaining edits, with occurrence removals last so an old boundary can
  // become a normal visit before it is removed.
  const rank=c=>c.type==='SET_TOPOLOGY'?0:(c.type==='SET_START'||c.type==='SET_END')?1:c.type==='REMOVE_OCCURRENCE'?3:2
  commands=commands.map((c,i)=>({...c,__i:i})).sort((a,b)=>rank(a)-rank(b)||a.__i-b.__i).map(({__i,...c})=>c)
  return{commands,hints:{start:startHint,end:endHint,topology:topologyHint,uniquePlaces}}
}

const ALLOWED_REVISION_COMMANDS=new Set(['SET_DURATION','SET_TIMING','SET_TOPOLOGY','INSERT_OCCURRENCE','REMOVE_OCCURRENCE','MOVE_OCCURRENCE','RENAME_OCCURRENCE','SET_OCCURRENCE_STAY','SET_OCCURRENCE_DISPOSITION','SET_START','SET_END','SET_TRANSPORT','SET_LEG_TRANSPORT','ADD_SCOPED_TRANSPORT','REMOVE_SCOPED_TRANSPORT','ADD_SCOPE','REMOVE_SCOPE','ADD_PLACE_REQUIREMENT','ADD_PLACE_OPTION','ADD_PLACE_EXCLUSION','REMOVE_PLACE_EXCLUSION','ADD_EXPERIENCE','REMOVE_EXPERIENCE','SET_HOME_ORIGIN','ADD_COMMITMENT','REMOVE_COMMITMENT','ADD_EXCLUSION','REMOVE_EXCLUSION'])
export async function compileRevision(authority,text,{signal,onProgress}={}){
  const snapshot=summarizeAuthority(authority)
  onProgress?.('Reading the requested change…')
  const system=`You are the Revision compiler for WAYFINDER. The current trip is authoritative. The traveler requested a DELTA. Return ONLY JSON {"summary":"short description","commands":[{"type":"...","payload":{...}}]}.
Do not regenerate or replace the route, scopes, transport rules, or constraints. Preserve everything not explicitly requested.
Allowed commands: SET_DURATION; SET_TIMING; SET_TOPOLOGY; INSERT_OCCURRENCE {label,beforeOccurrenceId? or afterOccurrenceId?,stay?,disposition?,allowRevisit?}; REMOVE_OCCURRENCE {occurrenceId,confirmTravelerOwned?}; MOVE_OCCURRENCE; RENAME_OCCURRENCE {occurrenceId,label,allowRevisit?}; SET_OCCURRENCE_STAY; SET_OCCURRENCE_DISPOSITION; SET_START; SET_END; SET_TRANSPORT {mode,confirmed}; SET_LEG_TRANSPORT {legId,mode,confirmed}; ADD_SCOPED_TRANSPORT; REMOVE_SCOPED_TRANSPORT; ADD_SCOPE; REMOVE_SCOPE; ADD_PLACE_REQUIREMENT; ADD_PLACE_OPTION; ADD_PLACE_EXCLUSION; REMOVE_PLACE_EXCLUSION; ADD_EXPERIENCE; REMOVE_EXPERIENCE; SET_HOME_ORIGIN; ADD_COMMITMENT; REMOVE_COMMITMENT; ADD_EXCLUSION; REMOVE_EXCLUSION.
Occurrence IDs are mandatory for remove/move/rename/edit operations. Anchors are mandatory when the traveler specified where to insert. Set confirmTravelerOwned:true only when the traveler explicitly requested removal of that traveler-owned item. Set allowRevisit:true only when the traveler explicitly requested returning to a place already in the route. Transport confirmed=true only when the traveler explicitly confirms the mode. Broad scopes and attractions are not literal route stops.`
  const data=await jsonChatRetry([{role:'system',content:system},{role:'user',content:`CURRENT AUTHORITY:\n${JSON.stringify(snapshot,null,2)}\n\nTRAVELER REVISION:\n${text}`}],{temperature:.1,max_tokens:1250,signal},'Return only valid JSON using the allowed delta command vocabulary. Do not omit requested changes and do not include unknown commands.')
  onProgress?.('Checking the change against the current trip…')
  const raw=Array.isArray(data.commands)?data.commands:[]
  const unknown=raw.filter(c=>!ALLOWED_REVISION_COMMANDS.has(c?.type)).map(c=>c?.type||'[missing]')
  if(unknown.length)throw new Error(`Revision compiler returned disallowed command(s): ${unknown.join(', ')}.`)
  const explicitTransport=revisionExplicitlyConfirmsTransport(text)
  const guarded=raw.map(c=>{
    const payload=c.payload&&typeof c.payload==='object'?{...c.payload}:{}
    if((c.type==='SET_TRANSPORT'||c.type==='SET_LEG_TRANSPORT')&&payload.confirmed===true&&!explicitTransport)payload.confirmed=false
    return{type:c.type,payload}
  })
  const normalized=normalizeRevisionPlan(authority,text,guarded),hintBits=[normalized.hints.start&&`start ${normalized.hints.start}`,normalized.hints.end&&`end ${normalized.hints.end}`,normalized.hints.uniquePlaces.length&&`single occurrence: ${normalized.hints.uniquePlaces.join(', ')}`].filter(Boolean)
  if(hintBits.length)onProgress?.(`Keeping your explicit revision anchors: ${hintBits.join(' · ')}`)
  return{tripId:authority.id,baseVersion:authority.version,summary:String(data.summary||'Revision compiled.'),commands:normalized.commands}
}

function safeCoord(value){return typeof value==='number'&&Number.isFinite(value)?value:null}
function durationDescription(duration){
  if(!duration||typeof duration!=='object')return''
  if(duration.kind==='exact'&&Number(duration.days)>0)return`${Number(duration.days)}-day`
  if(duration.kind==='range'&&Number(duration.minDays)>0&&Number(duration.maxDays)>=Number(duration.minDays))return`${Number(duration.minDays)}–${Number(duration.maxDays)} day`
  return''
}
function stayDescription(stay){
  if(!stay||stay.kind==='none'||stay.kind==='flexible')return''
  const days=Number(stay.days)
  if(!Number.isFinite(days)||days<=0)return''
  if(stay.kind==='exact')return`${days} day${days===1?'':'s'}`
  if(stay.kind==='minimum')return`at least ${days} day${days===1?'':'s'}`
  if(stay.kind==='maximum')return`up to ${days} day${days===1?'':'s'}`
  return''
}
function sourceCatalog(references=[]){
  const byKey=new Map(),entries=[],decorated=[]
  for(const raw of references||[]){
    const key=[String(raw?.source||'Local reference').trim().toLowerCase(),String(raw?.title||raw?.routeLabel||'').trim().toLowerCase(),String(raw?.url||'').trim()].join('|')
    let entry=byKey.get(key)
    if(!entry){entry={id:`S${entries.length+1}`,source:String(raw?.source||'Local reference').trim()||'Local reference',title:String(raw?.title||raw?.routeLabel||'Untitled local reference').trim(),url:String(raw?.url||'').trim()};byKey.set(key,entry);entries.push(entry)}
    decorated.push({...raw,citationId:entry.id})
  }
  return{entries,decorated}
}
function referenceForLabel(label,references=[]){return(references||[]).find(r=>samePlace(r?.routeLabel,label))||null}
function baselineStopNote(o,index,total,routeMeta,references){
  const ref=referenceForLabel(o.label,references),meta=routeMeta.get(o.occurrenceId)||{},stay=stayDescription(meta.stay)
  const role=o.role==='start'?'This is the canonical starting occurrence.':o.role==='end'?'This is the canonical final occurrence.':'This stop remains in the canonical route at this position.'
  const stayText=stay?` The authority currently plans ${stay} here.`:''
  const sequence=index===0?' Prepare arrival logistics before moving onward.':index===total-1?' Keep departure or onward-travel logistics attached to this final occurrence.':' Plan the transition from the previous stop and onward to the next canonical occurrence.'
  const evidence=ref?` Local ${ref.source||'reference'} evidence is available under “${ref.title||o.label}” [${ref.citationId}]. Use that evidence for destination details while verifying current schedules, prices, and opening hours before travel.`:' No local destination excerpt was available for this occurrence during this run; keep the stop unchanged and fill current practical details when evidence is available.'
  return`${role}${stayText}${sequence}${evidence}`
}
function baselineDocumentParts(authority,mapModel,references=[],preferences=null){
  const catalog=sourceCatalog(references),plan=createDocumentPlan(authority,mapModel,normalizeDocumentPreferences(preferences),{references:catalog.decorated}),snapshot=summarizeAuthority(authority),occurrences=mapModel?.occurrences||[],routeMeta=new Map((snapshot.route||[]).map(o=>[o.id,o]))
  const routeLabels=occurrences.map(o=>o.label),duration=durationDescription(snapshot.duration),scopeLabels=(snapshot.scopes||[]).map(s=>typeof s==='string'?s:s?.label).filter(Boolean)
  const topology=String(snapshot.topology||'flexible').replaceAll('_',' '),durationText=duration?`${duration} `:'',scopeText=scopeLabels.length?` through ${scopeLabels.join(', ')}`:''
  const overview=routeLabels.length?`This ${durationText}${topology} trip follows the traveler-approved canonical route${scopeText}: ${routeLabels.join(' → ')}. The route order, repeated occurrences, exclusions, timing constraints, and traveler-owned choices remain authoritative while the planning notes are enriched.`:'The authoritative trip is preserved, but no route occurrences are available to document.'
  const stops=occurrences.map((o,i)=>({heading:`### ${i+1}. ${o.label}`,content:baselineStopNote(o,i,occurrences.length,routeMeta,catalog.decorated),reference:referenceForLabel(o.label,catalog.decorated)}))
  let transport='Transport has not been traveler-confirmed. Compare practical options for each leg without silently assuming a mode.'
  if(snapshot.transport?.confirmed&&snapshot.transport?.primaryMode&&snapshot.transport.primaryMode!=='Any')transport=`Primary transport is traveler-confirmed as ${snapshot.transport.primaryMode}. Preserve any scoped or per-leg transport rules from the authority; if a changed leg needs reconfirmation, keep it unresolved rather than silently falling back to the primary mode.`
  if((snapshot.transport?.scoped||[]).length)transport+=` Scoped transport rules: ${(snapshot.transport.scoped||[]).map(x=>`${x.scope}: ${x.mode}`).join('; ')}.`
  const practical='Use the local references and offline map library as the primary planning resources. Verify time-sensitive schedules, prices, opening hours, entry requirements, and bookings against current official sources when connectivity is available. Keep unresolved places or transport questions visible instead of inventing certainty.'
  return{snapshot,occurrences,routeLabels,overview,stops,transport,practical,plan,sources:catalog.entries,references:catalog.decorated}
}
function assembleDocument(parts,overrides={}){
  const selected=new Set(parts.plan.selectedSections),sections=[]
  if(selected.has('route'))sections.push(`ROUTE AT A GLANCE\n${parts.routeLabels.map((label,i)=>`${i+1}. ${label}`).join('\n')}`)
  if(selected.has('overview'))sections.push(`## Overview\n${overrides.overview||parts.overview}`)
  if(selected.has('stops'))sections.push(`## Stop-by-stop planning notes\n${parts.stops.map((s,i)=>`${s.heading}\n${overrides.stops?.[i]||s.content}`).join('\n\n')}`)
  if(selected.has('transport'))sections.push(`## Transport notes\n${overrides.transport||parts.transport}`)
  if(selected.has('practical'))sections.push(`## Practical preparation\n${overrides.practical||parts.practical}`)
  if(parts.plan.includeSources&&parts.sources.length)sections.push(`## Sources / References\n${parts.sources.map(s=>`[${s.id}] ${s.source} — ${s.title}${s.url?` — ${s.url}`:' — local reference library'}`).join('\n')}`)
  return sections.join('\n\n').trim()
}
export function buildDocumentBaseline(authority,mapModel,{references=[],preferences=null}={}){
  if(!mapModel||mapModel.tripId!==authority?.id||Number(mapModel.authorityVersion)!==Number(authority?.version))throw new Error('Document map snapshot does not match the authoritative trip version.')
  return assembleDocument(baselineDocumentParts(authority,mapModel,references,preferences))
}
function completeSentencePrefix(text){
  const trimmed=String(text||'').trim();if(!trimmed)return''
  if(/[.!?]["'”’)]*(?:\s*\[S\d+\])?$/.test(trimmed))return trimmed
  const matches=[...trimmed.matchAll(/[.!?]["'”’)]*(?:\s*\[S\d+\])?(?=\s|$)/g)];if(!matches.length)return''
  const last=matches.at(-1);return trimmed.slice(0,last.index+last[0].length).trim()
}
function parseDocumentEnrichment(text,parts){
  const lines=String(text||'').split(/\r?\n/),out={overview:'',transport:'',practical:'',stops:Array(parts.stops.length).fill('')},stopIndexByHeading=new Map(parts.stops.map((s,i)=>[s.heading.trim(),i]));let current=null
  const append=line=>{if(!current)return;if(current.type==='stop')out.stops[current.index]+=(out.stops[current.index]?'\n':'')+line;else out[current.type]+=(out[current.type]?'\n':'')+line}
  for(const raw of lines){const line=raw.trimEnd(),trim=line.trim();if(/^##\s+Overview\s*$/i.test(trim)){current={type:'overview'};continue}if(/^##\s+Stop-by-stop planning notes\s*$/i.test(trim)){current=null;continue}if(/^##\s+Transport notes\s*$/i.test(trim)){current={type:'transport'};continue}if(/^##\s+Practical preparation\s*$/i.test(trim)){current={type:'practical'};continue}if(/^##\s+Sources\s*\/\s*References\s*$/i.test(trim)){current=null;continue}if(stopIndexByHeading.has(trim)){current={type:'stop',index:stopIndexByHeading.get(trim)};continue}if(/^#{1,6}\s+/.test(trim)){current=null;continue}append(line)}
  out.overview=completeSentencePrefix(out.overview);out.transport=completeSentencePrefix(out.transport);out.practical=completeSentencePrefix(out.practical);out.stops=out.stops.map(completeSentencePrefix)
  return out
}
function sanitizeCitationMarkers(text,sources=[]){
  const allowed=new Set((sources||[]).map(s=>s.id)),removed=new Set()
  const safe=String(text||'').replace(/\[S\d+\]/g,marker=>{const id=marker.slice(1,-1);if(allowed.has(id))return marker;removed.add(id);return''})
  return{text:safe,removed:[...removed]}
}
function withStopCitation(text,stop){
  const id=stop?.reference?.citationId,desired=id?`[${id}]`:'',clean=String(text||'').trim().replace(/\[S\d+\]/g,marker=>marker===desired?marker:'').replace(/\s{2,}/g,' ').trim()
  if(!clean||!id||clean.includes(desired))return clean
  return`${clean} ${desired}`
}
function mergeDocumentEnrichment(parts,modelText){
  const citations=sanitizeCitationMarkers(modelText,parts.sources),guarded=stripUnsupportedDocumentClaims(citations.text),parsed=parseDocumentEnrichment(guarded.text,parts),overrides={stops:[]},used={overview:false,transport:false,practical:false,stops:0},selected=new Set(parts.plan.selectedSections)
  if(selected.has('overview')&&parsed.overview){overrides.overview=parsed.overview;used.overview=true}
  if(selected.has('transport')&&parsed.transport){overrides.transport=parsed.transport;used.transport=true}
  if(selected.has('practical')&&parsed.practical){overrides.practical=parsed.practical;used.practical=true}
  overrides.stops=parts.stops.map((stop,i)=>{const text=selected.has('stops')?withStopCitation(parsed.stops[i],stop):'';if(text){used.stops++;return text}return stop.content})
  const completeEnrichment=(!selected.has('overview')||used.overview)&&(!selected.has('transport')||used.transport)&&(!selected.has('practical')||used.practical)&&(!selected.has('stops')||used.stops===parts.stops.length)
  return{text:assembleDocument(parts,overrides),guardedReasons:guarded.reasons,guardedCitationIds:citations.removed,used,completeEnrichment}
}
function compactDocumentSnapshot(snapshot){
  return{duration:snapshot.duration||null,timing:snapshot.timing||null,topology:snapshot.topology||null,scopes:snapshot.scopes||[],route:(snapshot.route||[]).map(o=>({id:o.id,role:o.role,label:o.label,disposition:o.disposition,stay:o.stay})),transport:snapshot.transport||{},experiences:snapshot.experiences||{},commitments:snapshot.commitments||[],exclusions:snapshot.exclusions||[]}
}
function compactEvidence(references=[]){return(references||[]).map(r=>`[${r.citationId}] ${r.routeLabel} — ${r.source}: ${r.title}\n${String(r.excerpt||'').replace(/\s+/g,' ').trim().slice(0,700)}`).join('\n\n')||'[No local reference evidence available]'}

function unsupportedDocumentClaim(sentence){
  const text=String(sentence||'').trim();if(!text)return null
  if(/(?:[$€£¥₹]|\b(?:USD|EUR|GBP|JPY|CAD|AUD)\s*)\s*\d/i.test(text)||/\b\d+(?:[.,]\d+)?\s*(?:USD|EUR|GBP|dollars?|euros?|pounds?|yen)\b/i.test(text))return'fare/price'
  if(/\b(?:visa(?:-free)?|e-?visa|eTA|electronic travel authori[sz]ation|passport valid(?:ity)?|entry requirement)\b/i.test(text)&&/\b(?:require[sd]?|need(?:ed|s)?|must|eligible|exempt|valid for|visa-free|can enter|may enter|not required)\b/i.test(text)&&!/\b(?:verify|check|confirm|official|current|up-to-date)\b/i.test(text))return'entry requirement'
  if(/\b(?:depart(?:s|ure)?|arriv(?:e|es|al)|opens?|closes?|last train|first train|ferry|flight|bus|train)\b/i.test(text)&&/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(text))return'schedule'
  return null
}
function stripUnsupportedDocumentClaims(text){
  const reasons=new Set(),lines=String(text||'').split('\n'),safe=[]
  for(const line of lines){if(/^\s*#{1,6}\s+/.test(line)){safe.push(line);continue}const parts=line.split(/(?<=[.!?])\s+/),kept=[];for(const part of parts){const reason=unsupportedDocumentClaim(part);if(reason)reasons.add(reason);else kept.push(part)}safe.push(kept.join(' '))}
  return{text:safe.join('\n').replace(/\n{3,}/g,'\n\n').trim(),reasons:[...reasons]}
}
function processSseFrame(raw,acc,state){
  if(!raw)return
  if(raw==='[DONE]'){state.sawDone=true;return}
  const j=JSON.parse(raw);if(j?.error)throw new Error(j.error.message||j.error)
  const choice=j?.choices?.[0];const token=choice?.delta?.content||choice?.text||'';if(token)acc.push(token)
  if(choice?.finish_reason!=null)state.finishReason=choice.finish_reason
}
export async function streamDocument(authority,mapModel,{references=[],preferences=null,onText=()=>{},signal}={}){
  if(!mapModel||mapModel.tripId!==authority?.id||Number(mapModel.authorityVersion)!==Number(authority?.version))throw new Error('Document map snapshot does not match the authoritative trip version.')
  const parts=baselineDocumentParts(authority,mapModel,references,preferences),snapshot=parts.snapshot,selected=new Set(parts.plan.selectedSections),requiredHeadings=selected.has('stops')?parts.stops.map(s=>s.heading):[],baseline=assembleDocument(parts)
  // A complete deterministic floor for every traveler-selected section is visible immediately.
  onText(baseline)
  const requested=[];if(selected.has('overview'))requested.push('## Overview');if(selected.has('stops'))requested.push('## Stop-by-stop planning notes plus every EXPECTED STOP HEADING');if(selected.has('transport'))requested.push('## Transport notes');if(selected.has('practical'))requested.push('## Practical preparation')
  const enrichable=requested.length>0
  if(!enrichable)return{text:baseline,partial:false,enrichmentPartial:false,error:null,finishReason:'not_needed',documentPlan:parts.plan}
  const routeForModel=parts.occurrences.map((o,i)=>`${i+1}. ${o.label} [${o.role}]`).join('\n')
  const system=`You are WAYFINDER Documentation. Enrich ONLY the traveler-selected sections of a COMPLETE deterministic travel document from the immutable AUTHORITATIVE trip snapshot. WAYFINDER owns the route and will merge your prose into a complete fallback document, so never create or repair route authority. Never add, remove, reorder, rename, or reinterpret route occurrences. Do not invent dates, schedules, fares, bookings, visa/eTA rules, or transport choices. If transport is not confirmed, discuss options neutrally. The Overview must summarize only authority-owned trip structure and traveler choices; do not add destination facts there. Destination-specific factual claims belong in stop notes, may use only supplied LOCAL REFERENCE EVIDENCE, and must carry the matching citation marker such as [S1]. Never invent a citation marker. Be concise so the complete enrichment finishes quickly: Overview 2-4 sentences; each stop 2-4 useful sentences; Transport notes 2-4 sentences; Practical preparation 2-4 sentences. Output ONLY the requested headings, in the requested order. Do not output a Sources section; WAYFINDER appends the deterministic source catalog itself.`
  const user=`AUTHORITATIVE TRIP:\n${JSON.stringify(compactDocumentSnapshot(snapshot))}\n\nSELECTED DOCUMENT SECTIONS:\n${requested.join('\n')}\n\nCANONICAL ROUTE:\n${routeForModel}\n\nEXPECTED STOP HEADINGS:\n${requiredHeadings.length?requiredHeadings.join('\n'):'[Stop-by-stop section not selected]'}\n\nLOCAL REFERENCE EVIDENCE:\n${compactEvidence(parts.references)}\n\nEnrich every selected section concisely. When a stop has local evidence, cite destination-specific factual details with its supplied [S#] marker.`
  const selectedStopCount=selected.has('stops')?parts.occurrences.length:0,maxTokens=Math.min(1100,Math.max(500,300+selectedStopCount*100))
  let r
  try{r=await chat([{role:'system',content:system},{role:'user',content:user}],{temperature:.35,max_tokens:maxTokens,stream:true,signal})}
  catch(error){
    const timedOut=error?.name==='TimeoutError'||signal?.reason?.name==='TimeoutError';if(error?.name==='AbortError'&&!timedOut)throw error
    return{text:baseline,partial:false,enrichmentPartial:true,error:timedOut?'The 2-minute interactive limit was reached before enrichment started; the complete selected document was preserved.':`Model enrichment unavailable: ${error.message}`,finishReason:null,documentPlan:parts.plan}
  }
  if(!r.body)return{text:baseline,partial:false,enrichmentPartial:true,error:'Document enrichment stream had no response body; the complete selected document was preserved.',finishReason:null,documentPlan:parts.plan}
  let latest=baseline
  const acc=createSentenceAccumulator(raw=>{const merged=mergeDocumentEnrichment(parts,raw);latest=merged.text;onText(latest)}),reader=r.body.getReader(),decoder=new TextDecoder(),state={sawDone:false,finishReason:null};let buffer=''
  try{
    while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop()||'';for(const line of lines){const t=line.trim();if(!t.startsWith('data:'))continue;processSseFrame(t.slice(5).trim(),acc,state)}}
    buffer+=decoder.decode();for(const line of buffer.split('\n')){const t=line.trim();if(t.startsWith('data:'))processSseFrame(t.slice(5).trim(),acc,state)}
    const streamPartial=!state.sawDone||(state.finishReason!=null&&state.finishReason!=='stop'),rawModelText=acc.finish({partial:streamPartial}),merged=mergeDocumentEnrichment(parts,rawModelText),enrichmentPartial=streamPartial||!merged.completeEnrichment||merged.guardedReasons.length>0||merged.guardedCitationIds.length>0,errors=[]
    if(!merged.completeEnrichment)errors.push(selected.has('stops')?`Model enrichment completed ${merged.used.stops}/${parts.stops.length} stop sections; concise fallback notes filled the rest.`:`Model enrichment did not complete every selected section; concise fallback notes filled the remainder.`)
    if(merged.guardedReasons.length)errors.push(`Unsupported time-sensitive claim(s) were removed: ${merged.guardedReasons.join(', ')}.`)
    if(merged.guardedCitationIds.length)errors.push(`Invented or unavailable citation marker(s) were removed: ${merged.guardedCitationIds.join(', ')}.`)
    onText(merged.text)
    return{text:merged.text,partial:false,enrichmentPartial,finishReason:state.finishReason||null,error:errors.length?errors.join(' '):null,documentPlan:parts.plan}
  }catch(error){
    const timedOut=error?.name==='TimeoutError'||signal?.reason?.name==='TimeoutError';if(error?.name==='AbortError'&&!timedOut)throw error
    const raw=acc.finish({partial:true}),merged=mergeDocumentEnrichment(parts,raw);latest=merged.text;onText(latest)
    return{text:latest,partial:false,enrichmentPartial:true,error:timedOut?'The 2-minute interactive limit ended model enrichment; every selected section remains complete using concise fallback content where needed.':`Model enrichment stopped: ${error.message}. The complete selected document was preserved.`,finishReason:state.finishReason||null,documentPlan:parts.plan}
  }
}

