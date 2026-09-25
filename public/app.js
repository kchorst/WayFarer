import { emptyAuthority, authorityFromProposal, applyCommand, applyCommands, routeOccurrences, deriveLegs, validateAuthority, TRANSPORT_MODES, samePlace, draftFromAuthority, previewTripDraft, commitTripDraft } from './core/authority.js'
import { buildMapModel, googleMapsUrls, mapQuestShareUrl, mapQuestShareEligibility, mapQuestEligibility, modelInvariantFindings, unwrapLongitudeSequence, shiftLongitudeNear, providerRouteMatchesModel } from './core/mapModel.js'
import { extractTravelerConstraints, generateSparkFromContract, validateTravelerContract, compileRevision, streamDocument, buildDocumentBaseline } from './core/ai.js'
import { loadOfflinePbf } from './core/mvt.js'
import { resolveAuthority, selectCandidate } from './core/resolution.js'
import { gatherTripReferences } from './core/references.js'
import { saveState, loadState, clearState, exportState, importState } from './core/persistence.js'
import { createDeadline, deadlineMessage, INTERACTIVE_LIMIT_MS } from './core/deadline.js'
import { DOCUMENT_SECTIONS, defaultDocumentPreferences, normalizeDocumentPreferences } from './core/documentPlan.js'
import { deriveTripBasics, parseDurationText, formatDuration, mergeContractWithBasics, contractFingerprint, validateBasics, splitDestinationAreas } from './core/tripBasics.js'
import { validateProposalScopeGeography } from './core/proposalScope.js'

const $=s=>document.querySelector(s)
const $$=s=>[...document.querySelectorAll(s)]
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const lines=s=>String(s||'').split(/\n|,/).map(x=>x.trim()).filter(Boolean)
const textLines=s=>String(s||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean)
const state={briefText:'',exploration:null,activeSpark:null,selectedProposalId:null,authority:null,resolutions:{},resolutionCandidates:{},resolutionFindings:[],mapQuestRoute:null,offlineBackground:null,document:null,documentPreferences:defaultDocumentPreferences(),runtime:null,settings:null,revisionLog:[]}
let activeAbort=null
let aiQueryActive=false
let sparkGenerating=false,ideasExpanded=false,sparkPrep=null,precisionDraft=null,precisionDirty=false
let runtimeRefreshTimer=null,offlineStatusInFlight=false,offlineStatusCheckedAt=0,servicesChecking=false
let clientSessionId='',clientHeartbeatTimer=null,exitRequested=false

const CLIENT_HEADERS={'Content-Type':'application/json','X-WAYFINDER-Client':'1'}
async function registerClientSession(){
  try{
    const r=await fetch('/api/system/client/register',{method:'POST',headers:{'X-WAYFINDER-Client':'1'}}),d=await r.json()
    if(!r.ok||!d.clientId)throw new Error(d.error||'Client registration failed.')
    clientSessionId=d.clientId
    if(clientHeartbeatTimer)clearInterval(clientHeartbeatTimer)
    clientHeartbeatTimer=setInterval(async()=>{if(!clientSessionId||exitRequested)return;try{const hr=await fetch('/api/system/client/heartbeat',{method:'POST',headers:CLIENT_HEADERS,body:JSON.stringify({clientId:clientSessionId})});if(hr.status===409)clientSessionId=''}catch{}},20000)
  }catch{}
}
function closeClientSession(){
  if(!clientSessionId||exitRequested)return
  const id=clientSessionId;clientSessionId=''
  try{fetch('/api/system/client/close',{method:'POST',headers:CLIENT_HEADERS,body:JSON.stringify({clientId:id}),keepalive:true}).catch(()=>{})}catch{}
}
async function exitWayfinder(){
  if(exitRequested)return
  if(!confirm('Exit WAYFINDER and stop its local server?'))return
  exitRequested=true;activeAbort?.abort();if(clientHeartbeatTimer)clearInterval(clientHeartbeatTimer);if(runtimeRefreshTimer)clearInterval(runtimeRefreshTimer)
  const btn=$('#exitBtn');setBusy(btn,true,'Closing…')
  try{await fetch('/api/system/client/exit',{method:'POST',headers:CLIENT_HEADERS,body:JSON.stringify({clientId:clientSessionId}),keepalive:true})}catch{}
  clientSessionId=''
  document.body.innerHTML='<main class="shutdown-screen"><section class="card"><h1>WAYFINDER closed</h1><p>The local WAYFINDER process has been stopped. You can close this browser tab and move or delete the extracted folder.</p></section></main>'
  setTimeout(()=>{try{window.close()}catch{}},250)
}

function beginAction(label,ms=INTERACTIVE_LIMIT_MS){activeAbort?.abort();activeAbort=new AbortController();return createDeadline(activeAbort.signal,{ms,label})}
function actionError(error,label){return deadlineMessage(error,label)}
function sleep(ms,signal){return new Promise((resolve,reject)=>{const timer=setTimeout(resolve,ms);if(signal){const onAbort=()=>{clearTimeout(timer);reject(signal.reason||new DOMException('Aborted','AbortError'))};if(signal.aborted)return onAbort();signal.addEventListener('abort',onAbort,{once:true})}})}

function persist(){const exploration=state.exploration?{...state.exploration,speculativeProposals:state.exploration.speculativeProposals||[]}:null;const result=saveState({exploration,activeSpark:state.activeSpark,selectedProposalId:state.selectedProposalId,authority:state.authority,resolutions:state.resolutions,resolutionCandidates:state.resolutionCandidates,resolutionFindings:state.resolutionFindings,mapQuestRoute:state.mapQuestRoute,document:state.document,documentPreferences:state.documentPreferences,revisionLog:state.revisionLog});if(!result.ok){const el=$('#precisionStatus')||$('#sparkStatus');if(el)status(el,`Local save failed: ${result.error}`,'error')}return result.ok}
function status(el,text='',kind=''){el.textContent=text;el.className=`inline-status ${kind}`.trim();el.setAttribute('aria-live','polite');el.setAttribute('aria-busy',kind==='busy'?'true':'false')}
function setBusy(button,busy,label){if(!button)return;if(busy){button.dataset.old=button.textContent;button.textContent=label||'Working…';button.disabled=true}else{button.textContent=button.dataset.old||button.textContent;button.disabled=false}}
function invalidateDerived({keepResolutions=true}={}){if(!keepResolutions)state.resolutions={};state.resolutionCandidates={};state.resolutionFindings=[];state.mapQuestRoute=null;state.offlineBackground=null;state.document=null}
function invalidateForAuthorityChange(previous,next){const before=new Map(routeOccurrences(previous).map(o=>[o.id,String(o.place.label||'').trim().toLowerCase()]));const after=new Map(routeOccurrences(next).map(o=>[o.id,String(o.place.label||'').trim().toLowerCase()]));const valid=new Set([...after].filter(([id,label])=>before.get(id)===label).map(([id])=>id));state.resolutions=Object.fromEntries(Object.entries(state.resolutions||{}).filter(([id])=>valid.has(id)));state.resolutionCandidates=Object.fromEntries(Object.entries(state.resolutionCandidates||{}).filter(([id])=>valid.has(id)));state.resolutionFindings=(state.resolutionFindings||[]).filter(f=>!f.occurrenceId||valid.has(f.occurrenceId));state.mapQuestRoute=null;state.offlineBackground=null;state.document=null}

function renderRuntimeBadges(){
  const modelBadge=$('#runtimeBadge'),referenceBadge=$('#referenceBadge'),ai=state.runtime?.ai||{},refs=state.runtime?.references||{}
  if(servicesChecking&&!aiQueryActive){modelBadge.textContent='Checking local model…';modelBadge.className='badge busy'}
  else if(aiQueryActive){modelBadge.textContent=`Local model working${ai.model?` · ${ai.model}`:''}`;modelBadge.className='badge busy'}
  else if(ai.available){modelBadge.textContent=`Local model running · ${ai.model||'detected'}`;modelBadge.className='badge ok'}
  else if(ai.reachable){modelBadge.textContent='Local model reachable · setup needed';modelBadge.className='badge warn'}
  else{modelBadge.textContent='Local model offline';modelBadge.className='badge warn'}
  modelBadge.title=[ai.endpoint,ai.message].filter(Boolean).join(' — ')

  if(referenceBadge){
    if(servicesChecking){referenceBadge.textContent='Checking Kiwix…';referenceBadge.className='badge busy'}
    else if(refs.available){
      const libraries=[refs.wikivoyage&&'Wikivoyage',refs.wikipedia&&'Wikipedia'].filter(Boolean).join(' + ')
      referenceBadge.textContent=`Kiwix running${libraries?` · ${libraries}`:''}`;referenceBadge.className='badge ok'
    }else{referenceBadge.textContent='Kiwix / local references offline';referenceBadge.className='badge warn'}
    referenceBadge.title=[refs.endpoint,refs.message].filter(Boolean).join(' — ')
  }
}
async function refreshOfflineRuntime({force=false}={}){
  if(offlineStatusInFlight||(!force&&Date.now()-offlineStatusCheckedAt<30000))return
  offlineStatusInFlight=true
  try{const r=await fetch('/api/offline/status',{cache:'no-store'}),d=await r.json();if(r.ok){state.runtime={...(state.runtime||{}),offlinePbf:d};offlineStatusCheckedAt=Date.now();const pbf=$('#pbfFact');if(pbf&&!state.offlineBackground)pbf.textContent=d.message||'Not configured';renderSettingsRuntime();if(state.authority)renderMapping()}}catch{}finally{offlineStatusInFlight=false}
}
async function refreshRuntime({explicit=false}={}){
  servicesChecking=true;renderRuntimeBadges();const checkBtn=$('#checkServicesBtn');if(explicit)setBusy(checkBtn,true,'Checking…')
  try{const r=await fetch('/api/status',{cache:'no-store'});state.runtime=await r.json();state.settings=state.runtime.settings||state.settings;const build=$('#buildBadge');if(build)build.textContent=state.runtime.release?.version?`v${state.runtime.release.version}`:'v?' ;const pbf=$('#pbfFact');if(pbf)pbf.textContent=state.offlineBackground?.message||state.runtime.offlinePbf?.message||'Not configured';renderSettingsRuntime();refreshOfflineRuntime({force:explicit})}
  catch(e){state.runtime={...(state.runtime||{}),ai:{available:false,reachable:false,message:e.message||'Runtime unavailable'},references:{available:false,message:e.message||'Runtime unavailable'}};renderSettingsRuntime()}
  finally{servicesChecking=false;renderRuntimeBadges();if(explicit)setBusy(checkBtn,false)}
}

function renderSettingsRuntime(){
  const ai=state.runtime?.ai||{},refs=state.runtime?.references||{},mq=state.runtime?.mapquest||{},pbf=state.runtime?.offlinePbf||{}
  const put=(id,text)=>{const el=$(id);if(el)el.textContent=text}
  put('#settingsAiStatus',ai.available?`Running · ${ai.model||'model detected'}`:ai.reachable?'Server reachable · model not reported':'Offline')
  put('#settingsRefStatus',refs.available?`${refs.wikivoyage?'Wikivoyage':''}${refs.wikivoyage&&refs.wikipedia?' + ':''}${refs.wikipedia?'Wikipedia':''}`||'Kiwix reachable':'Unavailable')
  put('#settingsMapQuestStatus',mq.configured?'Configured':'Not configured')
  put('#settingsPbfStatus',pbf.message||'Not configured')
  const diag=$('#settingsPbfDiagnostics');if(diag){const info={root:pbf.root||state.settings?.pbfRoot||'',kind:pbf.kind||'',catalogCount:pbf.catalogCount??0,selectedFiles:(pbf.selectedFiles||[]).map(x=>x.fileName),files:(pbf.files||[]).slice(0,30).map(x=>x.fileName),diagnostics:pbf.diagnostics||{}};diag.textContent=JSON.stringify(info,null,2)}
}
async function openSettings(){
  try{const r=await fetch('/api/settings',{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not load settings.');state.settings=d.settings||{};$('#settingsAiEndpoint').value=state.settings.aiEndpoint||'';$('#settingsAiModel').value=state.settings.aiModel||'';$('#settingsReferenceEndpoint').value=state.settings.referenceEndpoint||'';$('#settingsGazetteerEndpoint').value=state.settings.gazetteerEndpoint||'';$('#settingsPbfRoot').value=state.settings.pbfRoot||'';$('#settingsMapQuestKey').value='';$('#settingsMapQuestKey').placeholder=state.settings.mapQuestConfigured?`Configured ${state.settings.mapQuestKeyHint||''} · leave blank to keep`:'Enter MapQuest API key';$('#settingsAllowWebGeocode').checked=state.settings.allowWebGeocode!==false;$('#settingsRemoveMapQuest').checked=false;renderSettingsRuntime();$('#settingsDialog').showModal()}catch(e){alert(actionError(e,'Settings'))}
}
async function saveSettingsFromUI(){
  const payload={aiEndpoint:$('#settingsAiEndpoint').value.trim(),aiModel:$('#settingsAiModel').value.trim(),referenceEndpoint:$('#settingsReferenceEndpoint').value.trim(),gazetteerEndpoint:$('#settingsGazetteerEndpoint').value.trim(),pbfRoot:$('#settingsPbfRoot').value.trim(),allowWebGeocode:$('#settingsAllowWebGeocode').checked,removeMapQuestKey:$('#settingsRemoveMapQuest').checked};const key=$('#settingsMapQuestKey').value.trim();if(key)payload.mapQuestKey=key;setBusy($('#saveSettingsBtn'),true,'Saving…');status($('#settingsStatus'),'Saving local settings and refreshing services…','busy')
  try{const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();if(!r.ok)throw new Error(d.error||'Settings could not be saved.');state.settings=d.settings;state.runtime={...(state.runtime||{}),...(d.runtime?{ai:d.runtime.ai,references:d.runtime.references,mapquest:d.runtime.mapquest,offlinePbf:d.runtime.pbf,settings:d.settings}:{settings:d.settings})};$('#settingsMapQuestKey').value='';$('#settingsRemoveMapQuest').checked=false;status($('#settingsStatus'),'Settings saved locally.','ok');offlineStatusCheckedAt=0;await refreshRuntime();await refreshOfflineRuntime({force:true});renderMapping()}catch(e){status($('#settingsStatus'),actionError(e,'Settings'),'error')}finally{setBusy($('#saveSettingsBtn'),false)}
}
$('#settingsBtn').onclick=openSettings
$('#checkServicesBtn').onclick=async()=>{await refreshRuntime({explicit:true})}
$('#exitBtn').onclick=exitWayfinder
$('#browsePbfRootBtn').onclick=async()=>{setBusy($('#browsePbfRootBtn'),true,'Browsing…');status($('#settingsStatus'),'Opening Windows map-library folder picker…','busy');try{const r=await fetch('/api/settings/pick-folder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initial:$('#settingsPbfRoot').value.trim()})}),d=await r.json();if(!r.ok)throw new Error(d.error||'Folder picker failed.');if(!d.cancelled&&d.folder){$('#settingsPbfRoot').value=d.folder;status($('#settingsStatus'),'Map library selected. Save settings to catalog the installed .osm.pbf files.','ok')}else status($('#settingsStatus'),'Folder selection cancelled.','')}catch(e){status($('#settingsStatus'),actionError(e,'Map folder selection'),'error')}finally{setBusy($('#browsePbfRootBtn'),false)}}
$('#saveSettingsBtn').onclick=saveSettingsFromUI
$('#refreshSettingsBtn').onclick=async()=>{status($('#settingsStatus'),'Refreshing local service and map-library status…','busy');await refreshRuntime();await refreshOfflineRuntime({force:true});status($('#settingsStatus'),'Status refreshed.','ok')}

function showWorkspace(){if(!state.authority)return;$('#workspace').hidden=false;renderPrecision();renderRevisionLog();renderMapping();renderDocument()}
function sparkFieldMeta(field){
  if(!field)return''
  if(field.status==='open'||field.source==='open')return field.note||'Open — WAYFINDER may vary this.'
  if(field.source==='traveler')return'You specified'
  if(field.source==='route_convention')return field.note||'Known route convention — suggested'
  if(field.source==='inferred')return'Inferred — confirm or change'
  return field.status==='suggested'?'Suggested':'Confirmed'
}
function basicsSignal(label,field,{format=v=>v}={}){
  const value=String(field?.value||'').trim(),open=field?.status==='open'||field?.source==='open'
  if(open)return `<span class="trip-signal open"><b>${esc(label)}:</b> ${esc(field?.note||'Open — suggest for me')}</span>`
  return `<span class="trip-signal"><b>${esc(label)}:</b> ${esc(format(value))}<small>${esc(sparkFieldMeta(field))}</small></span>`
}
function renderTripBasicsFeedback(e,b){
  const instant=$('#tripBasicsSignals'),background=$('#backgroundSignals'),live=$('#sparkLiveStatus');if(!instant||!background||!live)return
  instant.innerHTML=[basicsSignal('Destination(s)',b.destination),basicsSignal('Start',b.start),basicsSignal('Finish',b.end),basicsSignal('Duration',b.duration),basicsSignal('Shape',b.topology,{format:v=>v.replaceAll('_',' ')})].join('')
  const c=e?.extractedContract,chips=[]
  if(c){
    if(c.requiredPlaces?.length)chips.push(`Required: ${c.requiredPlaces.join(', ')}`)
    if(c.optionalPlaces?.length)chips.push(`Optional: ${c.optionalPlaces.join(', ')}`)
    if(c.excludedPlaces?.length)chips.push(`Excluded: ${c.excludedPlaces.join(', ')}`)
    const themes=[...(c.experiences?.required||[]),...(c.experiences?.preferred||[])];if(themes.length)chips.push(`Interests: ${themes.join(', ')}`)
    if(c.transport?.primaryMode&&c.transport.primaryMode!=='Any')chips.push(`Transport signal: ${c.transport.primaryMode}`)
    if(c.commitments?.length)chips.push(`Commitments: ${c.commitments.join('; ')}`)
  }
  background.innerHTML=chips.map(x=>`<span>${esc(x)}</span>`).join('');background.hidden=!chips.length
  const elapsed=e?.startedAt?Math.max(0,Math.floor((Date.now()-e.startedAt)/1000)):0
  live.textContent=`${e?.backgroundStatus||'Background preparation is starting…'}${elapsed?` · ${elapsed}s`:''}`
}
function renderTripBasics(){
  const panel=$('#tripBasicsPanel'),e=state.exploration;if(!panel)return
  if(!e||e.stage==='ideas'){panel.hidden=true;return}
  panel.hidden=false;$('#tripBasicsPrompt').textContent=e.prompt||''
  const b=e.basics||deriveTripBasics(e.prompt||''),put=(id,field)=>{const el=$(id);if(el)el.value=field?.value||''},meta=(id,field)=>{const el=$(id);if(el)el.textContent=sparkFieldMeta(field)}
  put('#basicsDestination',b.destination);put('#basicsStart',b.start);put('#basicsEnd',b.end);put('#basicsDuration',b.duration);$('#basicsTopology').value=b.topology?.value||''
  meta('#basicsDestinationMeta',b.destination);meta('#basicsStartMeta',b.start);meta('#basicsEndMeta',b.end);meta('#basicsDurationMeta',b.duration);meta('#basicsTopologyMeta',b.topology)
  const recog=$('#recognizedTripBox');if(b.recognizedTrip){
    const options=(b.recognizedTrip.contextOptions||[]).map(o=>`<label class="check contextual-route-option"><input type="checkbox" data-context-option="${esc(o.id)}" ${b.contextSelections?.[o.id]?'checked':''}> ${esc(o.label)}</label>`).join('')
    recog.hidden=false;recog.innerHTML=`<b>${esc(b.recognizedTrip.name)}</b><span>${esc(b.recognizedTrip.note||'')}</span>${options?`<div class="contextual-route-options">${options}</div>`:''}`
  }else{recog.hidden=true;recog.innerHTML=''}
  renderTripBasicsFeedback(e,b)
}
function confirmedField(original,value,{duration=false,topology=false}={}){
  const v=String(value||'').trim();if(!v)return{value:'',source:'open',status:'open',note:duration?'Open — show me pacing options':topology?'Open — show me possibilities':'Open — suggest for me'}
  const unchanged=String(original?.value||'').trim()===v
  return{...(original||{}),value:v,source:unchanged?(original?.source||'traveler'):'traveler',status:'confirmed',note:unchanged?(original?.note||''):''}
}
function readTripBasicsUI(){
  const original=state.exploration?.basics||deriveTripBasics(state.exploration?.prompt||''),b=structuredClone(original)
  b.destination=confirmedField(original.destination,$('#basicsDestination').value);b.destination.areas=b.destination.value?splitDestinationAreas(b.destination.value):[];if(b.destination.areas.length>1)b.destination.value=b.destination.areas.join(' + ')
  b.start=confirmedField(original.start,$('#basicsStart').value)
  b.end=confirmedField(original.end,$('#basicsEnd').value)
  b.duration=confirmedField(original.duration,$('#basicsDuration').value,{duration:true});b.duration.parsed=b.duration.value?parseDurationText(b.duration.value):null
  b.topology=confirmedField(original.topology,$('#basicsTopology').value,{topology:true})
  b.contextSelections={};$$('#recognizedTripBox [data-context-option]').forEach(el=>{b.contextSelections[el.dataset.contextOption]=Boolean(el.checked)})
  const returnToStart=Object.entries(b.contextSelections).some(([id,value])=>value&&b.recognizedTrip?.contextOptions?.some(o=>o.id===id&&o.effect==='return_to_start'))
  if(returnToStart&&b.start.value){b.topology={value:'loop',source:'traveler',status:'confirmed',note:''};b.end={value:b.start.value,source:'traveler',status:'confirmed',note:'Same as start'}}
  if(b.topology.value==='loop'&&b.start.value&&!b.end.value)b.end={value:b.start.value,source:b.start.source,status:'confirmed',note:'Same as start because this is a loop'}
  return b
}
function renderSparkSignals(){
  const box=$('#sparkSignals'),c=state.exploration?.confirmedContract;if(!box)return
  if(!c){box.hidden=true;box.innerHTML='';return}
  const chips=[],scopes=(c.scopes||[]).map(x=>typeof x==='string'?x:x?.label).filter(Boolean),required=c.requiredPlaces||[],optional=c.optionalPlaces||[],excluded=c.excludedPlaces||[],themes=[...(c.experiences?.required||[]),...(c.experiences?.preferred||[])]
  if(scopes.length)chips.push(`Scope: ${scopes.join(', ')}`);if(c.start)chips.push(`Start: ${c.start}`);if(c.end)chips.push(`Finish: ${c.end}`)
  if(c.duration?.kind==='exact'&&Number(c.duration.days)>0)chips.push(`Duration: ${c.duration.days} days`);else if(c.duration?.kind==='range')chips.push(`Duration: ${c.duration.minDays}–${c.duration.maxDays} days`)
  if(c.topology)chips.push(`Shape: ${String(c.topology).replaceAll('_',' ')}`);if(c.transport?.primaryMode&&c.transport.primaryMode!=='Any')chips.push(`Transport: ${c.transport.primaryMode}`)
  if(required.length)chips.push(`Required: ${required.join(', ')}`);if(optional.length)chips.push(`Optional: ${optional.join(', ')}`);if(excluded.length)chips.push(`Excluded: ${excluded.join(', ')}`);if(themes.length)chips.push(`Interests: ${themes.join(', ')}`)
  if(c.commitments?.length)chips.push(`Commitments: ${c.commitments.join('; ')}`);if(c.homeOrigin)chips.push(`Home/origin: ${c.homeOrigin}`);if(c.transport?.scoped?.length)chips.push(`Scoped transport: ${c.transport.scoped.map(x=>`${x.scope}=${x.mode}`).join('; ')}`);if(c.travelers?.length)chips.push(`Traveler context: ${c.travelers.length} traveler${c.travelers.length===1?'':'s'}`)
  box.hidden=!chips.length;box.innerHTML=chips.length?`<div class="spark-signal-title">Confirmed Spark contract</div><div class="spark-signal-chips">${chips.map(x=>`<span>${esc(x)}</span>`).join('')}</div>`:''
}
function renderRevisionContext(){
  const request=$('#originalRequestText'),route=$('#selectedTripContext');if(request)request.textContent=state.authority?.brief?.rawText||state.activeSpark?.prompt||'No original Spark request is attached to this trip.'
  if(route){const labels=state.authority?routeOccurrences(state.authority).map(o=>o.place.label):[];route.textContent=labels.length?labels.join(' → '):'No canonical route yet.'}
}
function restoreActiveSparkExploration(){
  if(!state.activeSpark)return false
  state.exploration=structuredClone(state.activeSpark.exploration);state.exploration.stage='ideas';state.exploration.confirmed=true;state.exploration.confirmedContract=structuredClone(state.activeSpark.exploration.confirmedContract);state.exploration.proposals=structuredClone(state.activeSpark.exploration.proposals||[]);state.briefText=state.activeSpark.prompt||state.authority?.brief?.rawText||'';$('#brief').value=state.briefText;return true
}
function returnToSpark({editOriginal=false}={}){
  cancelSparkPrep();restoreActiveSparkExploration();ideasExpanded=true;renderTripBasics();renderProposals();renderSparkSignals();document.querySelector('.hero')?.scrollIntoView({behavior:'smooth',block:'start'});if(editOriginal){$('#brief')?.focus();$('#brief')?.select()}
}
function switchTab(name){if(state.authority&&['revision','precision','mapping','document'].includes(name)&&ideasExpanded){ideasExpanded=false;renderProposals()}$$('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));$$('.tab-panel').forEach(p=>p.hidden=p.id!==`tab-${name}`);if(name==='revision')renderRevisionContext();if(name==='mapping')renderMapping();if(name==='document')renderDocument();if(precisionDirty&&name!=='precision'){const target=name==='revision'?$('#revisionStatus'):name==='mapping'?$('#mapStatus'):name==='document'?$('#documentStatus'):null;if(target)status(target,'Precision has unsaved changes. This stage is using the last saved TripAuthority. Save or discard Precision changes before running an action.','warn')}}
$$('.tabs button').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab))

function activeSelectedProposal(){return state.activeSpark?.exploration?.proposals?.find(x=>x.id===state.selectedProposalId)||null}
function syncActiveSparkGallery(e){if(state.activeSpark?.exploration?.id===e?.id){state.activeSpark.exploration.proposals=structuredClone(e.proposals||[]);state.activeSpark.exploration.confirmedContract=structuredClone(e.confirmedContract||state.activeSpark.exploration.confirmedContract);state.activeSpark.exploration.confirmed=Boolean(e.confirmed)}}
function renderProposals(){
  const box=$('#proposals'),hero=document.querySelector('.hero'),selected=activeSelectedProposal(),collapsed=Boolean(state.authority&&!ideasExpanded)
  renderSparkSignals();renderTripBasics();hero?.classList.toggle('spark-collapsed',collapsed);box.innerHTML=''
  if(collapsed){const labels=selected?.stops||routeOccurrences(state.authority).map(o=>o.place.label),title=selected?.title||'Current authoritative trip';const div=document.createElement('div');div.className='spark-summary';div.innerHTML=`<div class="spark-summary-main"><div class="proposal-kicker">${selected?'SELECTED TRIP CONCEPT':'CURRENT TRIP'}</div><h3>${esc(title)}</h3><div class="stops">${labels.map(esc).join(' → ')}</div></div><button class="ghost small show-ideas">Show ideas / Change concept</button>`;div.querySelector('.show-ideas').onclick=()=>{restoreActiveSparkExploration();ideasExpanded=true;renderProposals()};box.append(div);return}
  const e=state.exploration,proposals=e?.confirmed?e.proposals||[]:[];if(!proposals.length)return
  for(const p of proposals){const div=document.createElement('article');div.className=`proposal${sparkGenerating?' streaming':''}`;const isSelected=state.activeSpark?.exploration?.id===e.id&&p.id===state.selectedProposalId,contractVerified=e.contractStatus==='verified',proposalVerified=p.verificationStatus!=='unverified',verified=contractVerified&&proposalVerified;const enrichNote=p.enrichmentStatus==='pending'?'<div class="proposal-stream-note">Route skeleton ready · WAYFINDER is enriching the description in the background.</div>':sparkGenerating?'<div class="proposal-stream-note">This validated concept is ready while WAYFINDER continues building alternatives.</div>':'';const advisoryNote=(p.advisories||[]).map(a=>`<div class="proposal-contract-note">${esc(a.message||a.code||'Proposal needs review.')}</div>`).join('');div.innerHTML=`<div class="proposal-kicker">${isSelected?'SELECTED CONCEPT':verified?'ROUTE CONCEPT':'ROUTE SKELETON · CHECKING REQUEST'}</div><h3>${esc(p.title)}</h3><p>${esc(p.summary||'Validated route skeleton ready.')}</p><div class="stops"><b>${p.days?`${p.days} days · `:''}${esc(p.topology)}</b><br>${p.stops.map(esc).join(' → ')}</div><p>${(p.themes||[]).map(esc).join(' · ')}</p>${enrichNote}${advisoryNote}${!contractVerified?'<div class="proposal-contract-note">Checking the rest of your request before this idea can be adopted.</div>':''}${!proposalVerified?'<div class="proposal-contract-note">Geographic scope could not be verified locally. You can read or copy this idea, but it cannot be adopted until verified.</div>':''}<div class="proposal-actions"><button class="primary refine-proposal" ${verified?'':'disabled'}>${isSelected?'Refine selected idea':'Refine this idea'}</button><button class="ghost small save-proposal">Save copy</button><button class="ghost small route-proposal" ${verified?'':'disabled'}>Route visual</button><button class="ghost small document-proposal" ${verified?'':'disabled'}>Build document</button></div>`
    div.querySelector('.refine-proposal').onclick=()=>chooseProposal(p.id,'revision');div.querySelector('.route-proposal').onclick=()=>chooseProposal(p.id,'mapping');div.querySelector('.document-proposal').onclick=()=>chooseProposal(p.id,'document')
    div.querySelector('.save-proposal').onclick=async()=>{const text=[p.title,p.summary,p.stops.join(' → ')].filter(Boolean).join('\n\n');try{await navigator.clipboard.writeText(text);status($('#sparkStatus'),'Trip concept copied.','ok')}catch{status($('#sparkStatus'),'Could not copy this concept.','error')}};box.append(div)
  }
  if(state.authority&&state.activeSpark?.exploration?.id===e?.id&&ideasExpanded){const done=document.createElement('div');done.className='spark-summary';done.innerHTML='<div class="spark-summary-main"><div class="proposal-kicker">IDEA GALLERY OPEN</div><div class="subtle">Choose another concept above, or collapse the gallery to return space to the workspace.</div></div><button class="ghost small hide-ideas">Hide ideas</button>';done.querySelector('.hide-ideas').onclick=()=>{ideasExpanded=false;renderProposals()};box.prepend(done)}
}
function explorationId(){return`explore_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`}
function cancelSparkPrep(){if(sparkPrep?.controller&&!sparkPrep.controller.signal.aborted)sparkPrep.controller.abort(new DOMException('Spark exploration changed.','AbortError'));if(sparkPrep?.ticker)clearInterval(sparkPrep.ticker);sparkPrep?.deadline?.dispose?.();sparkPrep=null;sparkGenerating=false}
function prepStatus(e,text,kind='busy'){
  if(state.exploration?.id!==e.id)return
  e.backgroundStatus=text||'Background preparation is continuing…'
  renderTripBasicsFeedback(e,e.basics||deriveTripBasics(e.prompt||''))
  if(e.confirmed)status($('#sparkStatus'),text,kind)
}
function startSpeculativeSpark(e){
  cancelSparkPrep()
  const controller=new AbortController(),deadline=createDeadline(controller.signal,{ms:INTERACTIVE_LIMIT_MS,label:'Spark preparation'})
  const prep={id:e.id,controller,deadline,extractionPromise:null,generationPromise:null,settledPromise:null,ticker:null}
  sparkPrep=prep;aiQueryActive=true;renderRuntimeBadges()
  e.backgroundStatus='Preparing the first possible route before running deeper request analysis…'
  e.speculativeProposals=[]
  const provisional=mergeContractWithBasics({},e.basics,{confirmed:true})
  e.speculativeContract=provisional;e.speculativeFingerprint=contractFingerprint(provisional)
  renderTripBasicsFeedback(e,e.basics)
  prep.ticker=setInterval(()=>{if(state.exploration?.id===e.id&&!e.confirmed)renderTripBasicsFeedback(e,e.basics)},1000)

  // Local model servers are commonly single-worker. Do not send the contract extractor
  // and Spark generator concurrently: queued model work can make both appear hung and
  // can consume the entire 120-second interaction budget. The first route skeleton gets
  // priority; deeper extraction begins only after that bounded first-skeleton phase settles.
  prep.generationPromise=(async()=>{
    const provisionalBlockers=validateTravelerContract(provisional).filter(x=>x.severity==='blocker')
    if(provisionalBlockers.length)throw new Error(provisionalBlockers.map(x=>x.message).join(' '))
    prepStatus(e,'Preparing one possible route first — nothing is adopted yet…','busy')
    // The 15-second value is a responsiveness target, not a hard cancellation boundary.
    // generateSparkFromContract owns its bounded fast attempt and then continues with
    // fallback generation under the overall two-minute interaction deadline.
    let result
    result=await generateSparkFromContract(e.prompt,provisional,{signal:deadline.signal,firstIdeaTargetMs:8500,targetCount:1,enrich:false,onProgress:t=>prepStatus(e,t||'Preparing the first possible route…','busy'),validateProposal:proposal=>validateProposalScopeGeography(proposal,provisional,{signal:deadline.signal}),onProposal:p=>{
      if(state.exploration?.id!==e.id)return
      if(!e.speculativeProposals.some(x=>x.id===p.id))e.speculativeProposals.push(p)
      if(e.confirmed&&e.confirmedFingerprint===e.speculativeFingerprint&&!e.proposals.some(x=>x.id===p.id)){e.proposals.push(p);if(!e.firstIdeaAt)e.firstIdeaAt=Date.now();syncActiveSparkGallery(e);renderProposals()}
    },onProposalUpdate:p=>{
      const si=e.speculativeProposals.findIndex(x=>x.id===p.id);if(si>=0)e.speculativeProposals[si]=p
      const vi=e.proposals.findIndex(x=>x.id===p.id);if(vi>=0){e.proposals[vi]=p;syncActiveSparkGallery(e);renderProposals()}
    }})
    e.speculativeProposals=structuredClone(result.proposals)
    if(e.confirmed&&e.confirmedFingerprint===e.speculativeFingerprint){e.proposals=structuredClone(result.proposals);syncActiveSparkGallery(e);renderProposals()}
    return result
  })()

  prep.extractionPromise=(async()=>{
    // Wait for the first-skeleton phase to release the local model before starting
    // another model request. A failed speculative skeleton does not prevent the
    // contract extractor from checking the request afterward.
    try{await prep.generationPromise}catch(error){if(error?.name==='AbortError'&&deadline.signal.aborted)throw error}
    if(deadline.signal.aborted)throw deadline.signal.reason||new DOMException('Aborted','AbortError')
    prepStatus(e,'Checking the rest of your request now that the first route attempt is complete…','busy')
    const extracted=await extractTravelerConstraints(e.prompt,{signal:deadline.signal,onProgress:t=>prepStatus(e,t||'Checking traveler constraints…','busy')})
    if(deadline.signal.aborted||state.exploration?.id!==e.id)throw deadline.signal.reason||new DOMException('Spark exploration changed.','AbortError')
    const blockers=validateTravelerContract(extracted).filter(x=>x.severity==='blocker')
    if(blockers.length)throw new Error(blockers.map(x=>x.message).join(' '))
    if(extracted.conflicts?.length)throw new Error(extracted.clarificationQuestion||extracted.conflicts.join(' · '))
    if(deadline.signal.aborted||state.exploration?.id!==e.id)throw deadline.signal.reason||new DOMException('Spark exploration changed.','AbortError')
    e.extractedContract=extracted
    prepStatus(e,'Request details checked · confirmed alternatives can now be completed.','busy')
    return extracted
  })()

  prep.generationPromise.catch(error=>{if(error?.name!=='AbortError'&&state.exploration?.id===e.id){e.speculativeError=error.message;prepStatus(e,`First background route attempt paused: ${error.message}`,'warn')}})
  prep.extractionPromise.catch(error=>{if(error?.name!=='AbortError'&&state.exploration?.id===e.id){e.prepError=error.message;prepStatus(e,`Traveler-contract check needs attention: ${error.message}`,'error')}})
  prep.settledPromise=Promise.allSettled([prep.generationPromise,prep.extractionPromise]).finally(async()=>{
    if(prep.ticker)clearInterval(prep.ticker)
    if(sparkPrep===prep){deadline.dispose();sparkPrep=null;sparkGenerating=false;aiQueryActive=false;if(!e.confirmed){e.backgroundStatus='Background preparation finished. Confirm or change the trip basics when ready.';renderTripBasicsFeedback(e,e.basics)}renderProposals();await refreshRuntime()}
  })
  return prep
}

function startSparkExploration(){
  const brief=$('#brief').value.trim();if(!brief)return status($('#sparkStatus'),'Tell WAYFINDER what kind of trip you want.','error')
  const e={id:explorationId(),prompt:brief,basics:deriveTripBasics(brief),stage:'basics',confirmed:false,confirmedContract:null,proposals:[],speculativeProposals:[],warnings:[],startedAt:Date.now(),backgroundStatus:'Trip basics extracted immediately. Background preparation will begin now.'}
  state.exploration=e;state.briefText=brief;ideasExpanded=true;$('#proposals').innerHTML='';$('#sparkSignals').hidden=true
  status($('#sparkStatus'),'Confirm the trip basics below. WAYFINDER is preparing route ideas in the background while you review.','ok')
  renderTripBasics();renderProposals();persist()
  // Give the browser a paint boundary so the confirmation card is visible before any model/network work starts.
  requestAnimationFrame(()=>requestAnimationFrame(()=>{if(state.exploration?.id===e.id&&!sparkPrep)startSpeculativeSpark(e)}))
}
async function runConfirmedSpark(e,contract,{seedProposals=[]}={}){
  cancelSparkPrep();const controller=new AbortController(),deadline=createDeadline(controller.signal,{ms:INTERACTIVE_LIMIT_MS,label:'Spark'}),prep={id:e.id,controller,deadline};sparkPrep=prep;sparkGenerating=true;aiQueryActive=true;renderRuntimeBadges();setBusy($('#confirmBasicsBtn'),true,'Building ideas…');let started=performance.now(),progress='Building confirmed trip ideas…',ticker=setInterval(()=>{const sec=Math.floor((performance.now()-started)/1000);status($('#sparkStatus'),`${progress}${sec?` · ${sec}s`:''}`,'busy')},1000)
  if(Array.isArray(seedProposals)&&seedProposals.length)e.proposals=structuredClone(seedProposals)
  const hooks={
    onProgress:t=>{if(state.exploration?.id!==e.id||deadline.signal.aborted)return;if(t)progress=t;status($('#sparkStatus'),progress,'busy')},
    validateProposal:proposal=>validateProposalScopeGeography(proposal,contract,{signal:deadline.signal}),
    onProposal:p=>{if(state.exploration?.id!==e.id)return;if(!e.proposals.some(x=>x.id===p.id)){e.proposals.push(p);if(!e.firstIdeaAt)e.firstIdeaAt=Date.now()}syncActiveSparkGallery(e);renderProposals()},
    onProposalUpdate:p=>{const i=e.proposals.findIndex(x=>x.id===p.id);if(i>=0){e.proposals[i]=p;syncActiveSparkGallery(e);renderProposals()}},
  }
  try{
    let seeds=structuredClone(e.proposals||[])
    if(!seeds.length){
      // Enforce the first-useful-output contract over the whole first-skeleton phase,
      // not only over one abandoned stream. This prevents the alternatives fallback
      // from silently stretching a 15-second target into the 120-second hard ceiling.
      // A missed 15-second responsiveness target must not abort a healthy Spark request.
      // The generator performs its own fast attempt, then bounded fallback work under
      // the overall two-minute interaction deadline.
      const first=await generateSparkFromContract(e.prompt,contract,{...hooks,signal:deadline.signal,firstIdeaTargetMs:8500,targetCount:1,enrich:false})
      seeds=structuredClone(first.proposals||[]);e.proposals=structuredClone(seeds);syncActiveSparkGallery(e);renderProposals()
    }
    const result=await generateSparkFromContract(e.prompt,contract,{...hooks,signal:deadline.signal,seedProposals:seeds,targetCount:3,enrich:true})
    e.proposals=result.proposals;syncActiveSparkGallery(e);status($('#sparkStatus'),`${result.proposals.length} complete concept${result.proposals.length===1?'':'s'} match your confirmed trip basics.`,'ok');persist();return result
  }catch(error){if(error?.name!=='AbortError')status($('#sparkStatus'),actionError(error,'Spark'),'error');throw error}
  finally{clearInterval(ticker);deadline.dispose();if(sparkPrep===prep)sparkPrep=null;sparkGenerating=false;aiQueryActive=false;setBusy($('#confirmBasicsBtn'),false);renderProposals();await refreshRuntime()}
}

async function finalizeConfirmedSpark(e,basics,baseContract){
  try{
    let extracted=e.extractedContract,prep=sparkPrep?.id===e.id?sparkPrep:null
    if(!extracted){if(!prep)prep=startSpeculativeSpark(e);extracted=await prep.extractionPromise}
    if(state.exploration?.id!==e.id||!e.confirmed)return
    const contract=mergeContractWithBasics(extracted,basics,{confirmed:true}),blockers=validateTravelerContract(contract).filter(x=>x.severity==='blocker');if(blockers.length)throw new Error(blockers.map(x=>x.message).join(' '));if(contract.conflicts?.length)throw new Error(contract.clarificationQuestion||contract.conflicts.join(' · '))
    const finalFingerprint=contractFingerprint(contract),sameRouteWork=finalFingerprint===e.speculativeFingerprint
    e.confirmedContract=contract;e.confirmedFingerprint=finalFingerprint;e.contractStatus='verified';renderSparkSignals();renderProposals()
    if(sameRouteWork){
      let seed=structuredClone(e.proposals||[])
      if(prep?.generationPromise){
        try{const first=await prep.generationPromise;if(state.exploration?.id!==e.id)return;seed=structuredClone(first.proposals||seed)}
        catch(error){if(error?.name==='AbortError'&&state.exploration?.id!==e.id)return;seed=structuredClone(e.proposals||[])}
      }
      e.proposals=seed;syncActiveSparkGallery(e);persist();renderProposals()
      status($('#sparkStatus'),seed.length?'First route skeleton verified · completing alternatives and optional enrichment…':'Traveler contract verified · building route ideas now…','busy')
      await runConfirmedSpark(e,contract,{seedProposals:seed})
    }else{
      // The background extractor found route-affecting constraints that were not in the fast basics.
      // Stale speculative ideas cannot be adopted; rebuild against the verified contract.
      cancelSparkPrep();e.proposals=[];renderProposals();status($('#sparkStatus'),'Additional traveler constraints changed the route contract · rebuilding route skeletons against the verified request.','busy');await runConfirmedSpark(e,contract)
    }
  }catch(error){if(error?.name!=='AbortError'&&state.exploration?.id===e.id){e.contractStatus='error';e.proposals=[];renderProposals();status($('#sparkStatus'),error.message,'error')}}
}

async function confirmTripBasics(){
  const e=state.exploration;if(!e)return;const basics=readTripBasicsUI(),basicFindings=validateBasics(basics),basicBlocker=basicFindings.find(x=>x.severity==='blocker');if(basicBlocker)return status($('#tripBasicsStatus'),basicBlocker.message,'error')
  e.basics=basics;const baseContract=mergeContractWithBasics({},basics,{confirmed:true}),blockers=validateTravelerContract(baseContract).filter(x=>x.severity==='blocker');if(blockers.length)return status($('#tripBasicsStatus'),blockers.map(x=>x.message).join(' '),'error')
  e.confirmed=true;e.confirmedContract=baseContract;e.confirmedFingerprint=contractFingerprint(baseContract);e.contractStatus='checking';e.stage='ideas';e.confirmedAt=Date.now();ideasExpanded=true
  const reusable=e.speculativeFingerprint&&e.confirmedFingerprint===e.speculativeFingerprint
  e.proposals=reusable?structuredClone(e.speculativeProposals||[]):[];if(e.proposals.length&&!e.firstIdeaAt)e.firstIdeaAt=Date.now();renderTripBasics();renderSparkSignals();renderProposals();persist()
  status($('#sparkStatus'),e.proposals.length?'Trip basics confirmed · a route skeleton is ready while WAYFINDER checks the rest of your request.':'Trip basics confirmed · building the first route skeleton now while WAYFINDER checks the rest of your request.','busy')
  void finalizeConfirmedSpark(e,basics,baseContract)
}

$('#sparkBtn').onclick=startSparkExploration
$('#confirmBasicsBtn').onclick=confirmTripBasics
$('#editSparkPromptBtn').onclick=()=>{cancelSparkPrep();if(state.exploration)state.exploration.stage='editing';$('#tripBasicsPanel').hidden=true;$('#brief').focus();status($('#sparkStatus'),'Edit your request, then choose Explore trip ideas again. Your current authoritative trip remains unchanged until you adopt a new concept.','')}
$('#sparkReturnBtn').onclick=()=>returnToSpark();$('#refineBackToSparkBtn').onclick=()=>returnToSpark();$('#editOriginalRequestBtn').onclick=()=>returnToSpark({editOriginal:true})
$('#blankBtn').onclick=()=>{if(state.authority&&!confirm('Replace the current trip with a blank Precision trip?'))return;cancelSparkPrep();state.briefText=$('#brief').value.trim();state.exploration=null;state.activeSpark=null;state.selectedProposalId=null;state.authority=emptyAuthority({brief:state.briefText});state.resolutions={};state.resolutionCandidates={};state.resolutionFindings=[];state.mapQuestRoute=null;state.document=null;state.documentPreferences=defaultDocumentPreferences();state.revisionLog=[];ideasExpanded=false;precisionDirty=false;persist();renderProposals();showWorkspace();switchTab('precision');status($('#precisionStatus'),'Blank authoritative trip created.','ok')}
function chooseProposal(id,target='revision'){
  const e=state.exploration,p=e?.confirmed?e.proposals?.find(x=>x.id===id):null;if(!p||!e.confirmedContract)return status($('#sparkStatus'),'Confirm the Trip Basics before adopting an idea.','error');if(e.contractStatus!=='verified')return status($('#sparkStatus'),'WAYFINDER is still checking the rest of your request. The route skeleton is visible now, but adoption waits for the verified Traveler Contract.','warn');if(p.verificationStatus==='unverified')return status($('#sparkStatus'),'This route is visible for review, but its geographic scope has not been verified. It cannot be adopted yet.','warn')
  const candidate=authorityFromProposal({brief:e.prompt,constraints:e.confirmedContract,proposal:p}),blockers=validateAuthority(candidate).filter(f=>f.severity==='blocker');if(blockers.length)return status($('#sparkStatus'),`This concept was withheld because it cannot become a valid trip: ${blockers.map(x=>x.message).join(' ')}`,'error')
  state.selectedProposalId=id;state.authority=candidate;state.activeSpark={id:`active_${candidate.id}`,tripId:candidate.id,prompt:e.prompt,exploration:structuredClone({...e,stage:'ideas',confirmed:true,speculativeProposals:[]})};state.briefText=e.prompt;state.resolutions={};state.resolutionCandidates={};state.resolutionFindings=[];state.mapQuestRoute=null;state.document=null;state.documentPreferences=defaultDocumentPreferences();state.revisionLog=[];precisionDirty=false;precisionDraft=null;ideasExpanded=false;persist();renderProposals();showWorkspace();renderRevisionContext();switchTab(target);const message='Concept adopted. Confirmed Trip Basics and traveler constraints are now authoritative.';if(target==='revision')status($('#revisionStatus'),message,'ok');else if(target==='mapping')status($('#mapStatus'),'Route concept selected. Resolve the saved canonical route here when you are ready to map it.','ok');else if(target==='document')status($('#documentStatus'),'Route concept selected. Choose document sections, then build from the frozen saved route.','ok');else status($('#precisionStatus'),message,'ok')
}

function routeRowsFromUI(){
  const rows=$$('#routeEditor .route-row').filter(row=>row.querySelector('.stop-label').value.trim())
  return rows.map((row,index)=>({id:row.dataset.id||null,label:row.querySelector('.stop-label').value.trim(),role:index===0?'start':index===rows.length-1?'end':'visit',disposition:row.querySelector('.stop-disposition').value,stay:{kind:row.querySelector('.stop-stay-kind').value,days:Number(row.querySelector('.stop-stay-days').value)||undefined},revisitIntent:row.dataset.revisit==='true'}))
}
function markPrecisionDirty(message='Unsaved Precision changes'){precisionDirty=true;const meta=$('#tripMeta');if(meta&&state.authority)meta.textContent=`${state.authority.id} · v${state.authority.version} · ${message}`}
function updateBoundarySummary(rows=routeRowsFromUI()){
  const box=$('#precisionBoundarySummary');if(!box)return;const start=rows[0]?.label||'—',end=rows.at(-1)?.label||'—';box.innerHTML=`<div><b>Start</b><span>${esc(start)}</span></div><div><b>Finish</b><span>${esc(end)}</span></div><div class="subtle">Start and finish are derived from the first and last route rows. There is no second boundary editor.</div>`
}
function addRouteRow(item={},at=null){
  const node=$('#stopRowTemplate').content.firstElementChild.cloneNode(true);node.dataset.id=item.id||'';node.dataset.revisit=String(Boolean(item.revisitIntent));node.querySelector('.stop-label').value=item.place?.label||item.label||'';node.querySelector('.stop-role').value=item.role||'visit';node.querySelector('.stop-disposition').value=item.disposition||'optional';node.querySelector('.stop-stay-kind').value=item.stay?.kind||'flexible';node.querySelector('.stop-stay-days').value=item.stay?.days??'';node.querySelector('.stop-stay-days').disabled=['flexible','none'].includes(node.querySelector('.stop-stay-kind').value)
  const changed=()=>{markPrecisionDirty();renumberRows();refreshPrecisionPreview()};node.querySelector('.delete-stop').onclick=()=>{node.remove();changed()};node.querySelector('.move-up').onclick=()=>{const prev=node.previousElementSibling;if(prev)node.parentNode.insertBefore(node,prev);changed()};node.querySelector('.move-down').onclick=()=>{const next=node.nextElementSibling;if(next)node.parentNode.insertBefore(next,node);changed()};node.querySelector('.stop-stay-kind').onchange=e=>{node.querySelector('.stop-stay-days').disabled=['flexible','none'].includes(e.target.value);changed()};node.querySelector('.stop-label').onchange=changed;node.querySelector('.stop-disposition').onchange=changed;node.querySelector('.stop-stay-days').onchange=changed
  const box=$('#routeEditor');if(at&&at.parentNode===box)box.insertBefore(node,at);else box.append(node);renumberRows();return node
}
function renumberRows(){const rows=$$('#routeEditor .route-row');rows.forEach((row,i)=>{row.querySelector('.drag-index').textContent=String(i+1);const role=row.querySelector('.stop-role');if(role)role.value=i===0?'start':i===rows.length-1?'end':'visit'});updateBoundarySummary()}
$('#addStopBtn').onclick=()=>{const row=addRouteRow({role:'visit',disposition:'optional'});markPrecisionDirty();refreshPrecisionPreview();row.querySelector('.stop-label').focus()}
function renderDurationFields(){const kind=$('#durationKindInput').value;$('#durationExactWrap').hidden=kind!=='exact';$('#durationMinWrap').hidden=kind!=='range';$('#durationMaxWrap').hidden=kind!=='range'}
function durationFromPrecisionUI(){const kind=$('#durationKindInput').value;if(kind==='none')return null;if(kind==='exact')return{kind:'exact',days:Number($('#durationDaysInput').value),provenance:'traveler'};if(kind==='range')return{kind:'range',minDays:Number($('#durationMinInput').value),maxDays:Number($('#durationMaxInput').value),provenance:'traveler'};return{kind:'flexible',provenance:'traveler'}}
function parseScopedTransportUI(){
  const rows=textLines($('#scopedTransportInput').value);return rows.map((line,index)=>{const split=line.indexOf('|');if(split<0)throw new Error(`Scoped transport row ${index+1} must use “scope | mode”.`);const scope=line.slice(0,split).trim(),mode=line.slice(split+1).trim(),normalized=TRANSPORT_MODES.find(x=>x.toLowerCase()===mode.toLowerCase());if(!scope||!normalized||normalized==='Any')throw new Error(`Scoped transport row ${index+1} requires a scope and a specific valid mode.`);return{scope,mode:normalized,provenance:'traveler'}})
}
function readLegControls(){const legModes={},pending=[];$$('#legTransportEditor select[data-leg-id]').forEach(sel=>{if(sel.value!=='Any')legModes[sel.dataset.legId]=sel.value;const confirm=sel.closest('.leg-row')?.querySelector('.leg-confirm');if(sel.value!=='Any'&&confirm&&!confirm.checked)pending.push(sel.dataset.legId)});return{legModes,reconfirmationRequiredLegIds:pending}}
function preserveByLabel(previous,labels,make){return labels.map((label,i)=>previous.find(x=>String(x?.label||x?.text||'').trim().toLowerCase()===label.toLowerCase())||make(label,i))}
function precisionDraftFromUI(){
  const base=structuredClone(precisionDraft||draftFromAuthority(state.authority)),rows=routeRowsFromUI(),leg=readLegControls(),existingScopes=base.scopes||[],existingExperiences=base.experiences||[],existingCommitments=base.commitments||[],existingExclusions=base.exclusions||[],existingTravelers=base.travelers||[]
  base.tripId=state.authority.id;base.baseVersion=state.authority.version;base.occurrences=rows;base.topology=$('#topologyInput').value;base.topologyProvenance='traveler';base.duration=durationFromPrecisionUI();base.timing={startDate:$('#startDateInput').value,endDate:$('#endDateInput').value,season:$('#seasonInput').value.trim(),provenance:'traveler'}
  base.scopes=textLines($('#scopesInput').value).map(label=>existingScopes.find(x=>samePlace(x.label,label))||{kind:'region',label,provenance:'traveler'})
  const expLabels=textLines($('#experiencesInput').value);base.experiences=expLabels.map(label=>existingExperiences.find(x=>String(x.label).toLowerCase()===label.toLowerCase())||{label,disposition:'preferred',provenance:'traveler'})
  base.homeOrigin=$('#homeOriginInput').value.trim()?{label:$('#homeOriginInput').value.trim(),provenance:'traveler'}:null
  base.commitments=textLines($('#commitmentsInput').value).map(text=>existingCommitments.find(x=>String(x.text).toLowerCase()===text.toLowerCase())||{text,provenance:'traveler'})
  base.exclusions=textLines($('#exclusionsInput').value).map(text=>existingExclusions.find(x=>String(x.text).toLowerCase()===text.toLowerCase())||{text,provenance:'traveler'})
  const travelerLines=textLines($('#travelersInput').value);base.travelers=travelerLines.map((passportContext,i)=>existingTravelers[i]?{...existingTravelers[i],passportContext}:{name:`Traveler ${i+1}`,passportContext,provenance:'traveler'})
  base.placeConstraints={...(base.placeConstraints||{}),excluded:textLines($('#excludedPlacesInput').value).map(label=>({label,disposition:'excluded',provenance:'traveler'}))}
  base.transport={...(base.transport||{}),primaryMode:$('#transportInput').value,confirmed:$('#transportConfirmed').checked,scoped:parseScopedTransportUI(),legModes:leg.legModes,reconfirmationRequiredLegIds:leg.reconfirmationRequiredLegIds}
  return base
}
function renderLegTransportEditor(a){
  const box=$('#legTransportEditor'),route=new Map(routeOccurrences(a).map(o=>[o.id,o])),legs=deriveLegs(a),pending=new Set(a.transport?.reconfirmationRequiredLegIds||[]);box.innerHTML=legs.length?legs.map(leg=>{const from=route.get(leg.fromOccurrenceId)?.place.label||'',to=route.get(leg.toOccurrenceId)?.place.label||'',value=a.transport?.legModes?.[leg.id]||'Any',needs=pending.has(leg.id);return `<div class="leg-row"><span>${esc(from)} → ${esc(to)}</span><select data-leg-id="${esc(leg.id)}"><option>Any</option>${TRANSPORT_MODES.filter(x=>x!=='Any'&&x!=='Mixed').map(m=>`<option ${m===value?'selected':''}>${m}</option>`).join('')}</select><label class="leg-confirm-wrap ${value==='Any'?'hidden':''}"><input class="leg-confirm" type="checkbox" ${value!=='Any'&&!needs?'checked':''}> ${needs?'Needs confirmation':'Confirmed'}</label></div>`}).join(''):'<span class="subtle">Add at least two route occurrences to define legs.</span>'
  box.querySelectorAll('select[data-leg-id]').forEach(sel=>sel.onchange=()=>{const wrap=sel.closest('.leg-row').querySelector('.leg-confirm-wrap'),check=wrap.querySelector('.leg-confirm');wrap.classList.toggle('hidden',sel.value==='Any');if(sel.value!=='Any')check.checked=false;markPrecisionDirty('unsaved transport change')})
  box.querySelectorAll('.leg-confirm').forEach(check=>check.onchange=()=>markPrecisionDirty('unsaved transport confirmation'))
}
function refreshPrecisionPreview({syncRows=false}={}){
  if(!state.authority)return;try{const draft=precisionDraftFromUI(),preview=previewTripDraft(state.authority,draft);precisionDraft=draftFromAuthority(preview);precisionDraft.baseVersion=state.authority.version;precisionDraft.tripId=state.authority.id;if(syncRows){$('#routeEditor').innerHTML='';routeOccurrences(preview).forEach(o=>addRouteRow(o))}else{const rows=$$('#routeEditor .route-row'),occurrences=routeOccurrences(preview);if(rows.length===occurrences.length)rows.forEach((row,index)=>{row.dataset.id=occurrences[index].id;row.dataset.revisit=String(Boolean(occurrences[index].revisitIntent))})}renderLegTransportEditor(preview);updateBoundarySummary(syncRows?routeOccurrences(preview).map(o=>({label:o.place.label})):routeRowsFromUI());status($('#precisionStatus'),'Precision changes are still a draft. Save Precision to make them authoritative.','warn')}catch(error){status($('#precisionStatus'),error.message,'error')}
}
function renderPrecision(){
  const a=state.authority;if(!a)return;precisionDraft=draftFromAuthority(a);precisionDirty=false;$('#tripMeta').textContent=`${a.id} · v${a.version}`;$('#topologyInput').value=a.topology||'flexible';const kind=a.duration?.kind||'none';$('#durationKindInput').value=kind;$('#durationDaysInput').value=kind==='exact'?a.duration.days:'';$('#durationMinInput').value=kind==='range'?a.duration.minDays:'';$('#durationMaxInput').value=kind==='range'?a.duration.maxDays:'';renderDurationFields();$('#startDateInput').value=a.timing?.startDate||'';$('#endDateInput').value=a.timing?.endDate||'';$('#seasonInput').value=a.timing?.season||'';$('#transportInput').value=a.transport?.primaryMode||'Any';$('#transportConfirmed').checked=Boolean(a.transport?.confirmed);$('#scopesInput').value=(a.scopes||[]).map(s=>s.label).join('\n');$('#homeOriginInput').value=a.homeOrigin?.label||'';$('#experiencesInput').value=(a.experiences||[]).filter(e=>e.disposition!=='excluded').map(e=>e.label).join('\n');$('#commitmentsInput').value=(a.commitments||[]).map(c=>c.text).join('\n');$('#excludedPlacesInput').value=(a.placeConstraints?.excluded||[]).map(c=>c.label).join('\n');$('#exclusionsInput').value=(a.exclusions||[]).map(c=>c.text).join('\n');$('#travelersInput').value=(a.travelers||[]).map(t=>t.passportContext||t.notes||t.name||'').filter(Boolean).join('\n');$('#scopedTransportInput').value=(a.transport?.scoped||[]).map(x=>`${x.scope} | ${x.mode}`).join('\n');$('#routeEditor').innerHTML='';routeOccurrences(a).forEach(o=>addRouteRow(o));renderLegTransportEditor(a);updateBoundarySummary()
}
function savePrecision(){
  const original=state.authority;if(!original)return[]
  try{const draft=precisionDraftFromUI(),result=commitTripDraft(original,draft);if(!result.ok)throw new Error(result.error||'Precision save rejected.');const findings=result.findings||[];state.authority=result.authority;if(result.changed)invalidateForAuthorityChange(original,state.authority);precisionDirty=false;precisionDraft=draftFromAuthority(state.authority);persist();renderPrecision();renderRevisionContext();renderMapping();return findings}catch(error){return[{code:'PRECISION_REJECTED',severity:'blocker',message:error.message}]}
}
$('#savePrecisionBtn').onclick=()=>{const f=savePrecision(),b=f.find(x=>x.severity==='blocker');status($('#precisionStatus'),b?b.message:'Precision saved atomically as canonical TripAuthority.',b?'error':'ok')}
$('#discardPrecisionBtn').onclick=()=>{renderPrecision();status($('#precisionStatus'),'Unsaved Precision changes discarded. The last saved TripAuthority is unchanged.','ok')}
$('#durationKindInput').onchange=()=>{renderDurationFields();markPrecisionDirty();refreshPrecisionPreview()}
for(const id of ['#durationDaysInput','#durationMinInput','#durationMaxInput','#startDateInput','#endDateInput','#seasonInput','#transportInput','#transportConfirmed','#scopesInput','#homeOriginInput','#experiencesInput','#commitmentsInput','#excludedPlacesInput','#exclusionsInput','#scopedTransportInput','#travelersInput']){const el=$(id);if(el)el.addEventListener('change',()=>{markPrecisionDirty();refreshPrecisionPreview()})}
$('#topologyInput').onchange=()=>{markPrecisionDirty();refreshPrecisionPreview({syncRows:true})}

function guardCommittedAuthority(statusTarget,action='This action'){
  if(precisionDirty){status(statusTarget,`${action} uses the last saved trip. Save or discard the unsaved Precision draft first.`,'warn');return false}
  const blocker=validateAuthority(state.authority).find(f=>f.severity==='blocker');if(blocker){status(statusTarget,`${action} is blocked: ${blocker.message}`,'error');return false}return true
}
async function resolveRoute(statusTarget=$('#precisionStatus')){
  if(!guardCommittedAuthority(statusTarget,'Route resolution'))return
  const route=routeOccurrences(state.authority),deadline=beginAction('Route resolution'),buttons=[$('#resolveBtn'),$('#mapResolveBtn')];buttons.forEach(b=>setBusy(b,true,'Resolving…'));status(statusTarget,'Resolving every saved canonical occurrence without changing the trip…','busy')
  try{
    const result=await resolveAuthority(state.authority,{signal:deadline.signal,previousResolutions:state.resolutions,onProgress:p=>status(statusTarget,p?`Resolving ${p.index+1}/${p.total}: ${p.label}`:'','busy')})
    state.resolutions=result.resolutions;state.resolutionCandidates=result.candidates;state.resolutionFindings=result.findings;state.mapQuestRoute=null;state.offlineBackground=null;persist();renderMapping();const model=buildMapModel(state.authority,state.resolutions),message=`${model.resolvedCount}/${route.length} occurrences resolved${Object.keys(state.resolutionCandidates).length?' · traveler choice needed for ambiguous matches':''}.`,kind=model.resolvedCount===route.length?'ok':'warn';status(statusTarget,message,kind);switchTab('mapping');status($('#mapStatus'),message,kind)
  }catch(e){if(e.name!=='AbortError')status(statusTarget,actionError(e,'Route resolution'),'error')}
  finally{deadline.dispose();buttons.forEach(b=>setBusy(b,false))}
}
$('#resolveBtn').onclick=()=>resolveRoute($('#precisionStatus'))
$('#mapResolveBtn').onclick=()=>resolveRoute($('#mapStatus'))

async function applyRevision(){
  const text=$('#revisionText').value.trim();if(!text)return status($('#revisionStatus'),'Describe the change you want.','error');if(!guardCommittedAuthority($('#revisionStatus'),'Revision'))return;const deadline=beginAction('Revision'),started=performance.now();let progressText='Reading the requested change…',ticker=null
  const showProgress=text=>{if(text)progressText=text;const seconds=Math.max(0,Math.floor((performance.now()-started)/1000)),remaining=Math.max(0,120-seconds);status($('#revisionStatus'),`${progressText}${seconds?` · ${seconds}s`:''}${remaining<=30?` · ${remaining}s limit`:''}`,'busy')}
  aiQueryActive=true;renderRuntimeBadges();setBusy($('#revisionBtn'),true,'Working…');showProgress();ticker=setInterval(()=>showProgress(),1000)
  try{const plan=await compileRevision(state.authority,text,{signal:deadline.signal,onProgress:showProgress});if(!plan.commands.length)throw new Error('The model did not identify a concrete change to apply.');const result=applyCommands(state.authority,plan.commands,{baseVersion:plan.baseVersion,tripId:plan.tripId});if(!result.ok)throw new Error(result.error||result.findings?.find(f=>f.severity==='blocker')?.message||'Revision rejected.');const previous=state.authority;state.authority=result.authority;invalidateForAuthorityChange(previous,result.authority);state.revisionLog.unshift({tripId:state.authority.id,at:Date.now(),text,summary:plan.summary,commands:plan.commands});state.revisionLog=state.revisionLog.slice(0,20);persist();renderPrecision();renderRevisionContext();renderRevisionLog();renderMapping();status($('#revisionStatus'),`${plan.summary} · ${Math.max(1,Math.round((performance.now()-started)/1000))}s`,'ok');$('#revisionText').value=''}catch(e){if(e.name!=='AbortError')status($('#revisionStatus'),actionError(e,'Revision'),'error')}finally{deadline.dispose();if(ticker)clearInterval(ticker);aiQueryActive=false;setBusy($('#revisionBtn'),false);await refreshRuntime()}
}
$('#revisionBtn').onclick=applyRevision
function renderRevisionLog(){const box=$('#revisionLog');box.innerHTML=(state.revisionLog||[]).map(x=>`<div class="log-entry"><b>${esc(x.summary)}</b><br>${esc(x.text)}<br><span class="subtle">${x.commands.length} typed command${x.commands.length===1?'':'s'}</span></div>`).join('')}

function renderSimpleMapSvg(model,providerGeometry=null,offlineFeatures=[],offlineRouteSegments=[]){
  const box=$('#mapCanvas'),resolvedRaw=model.occurrences.filter(o=>o.resolution).map(o=>({occurrenceId:o.occurrenceId,lat:o.resolution.lat,lon:o.resolution.lon,label:o.label,index:o.index}))
  const unwrapped=unwrapLongitudeSequence(resolvedRaw).map(p=>({...p,lon:p.displayLon})),byId=new Map(unwrapped.map(p=>[p.occurrenceId,p]))
  const routeSegments=(model.resolvedSegments||[]).map(segment=>segment.map(o=>byId.get(o.occurrenceId)).filter(Boolean)).filter(x=>x.length)
  const rawGeometry=(providerGeometry||[]).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon));let geometry=[]
  if(rawGeometry.length){const anchor=unwrapped[0]?.lon??rawGeometry[0].lon,seeds=rawGeometry.map((p,i)=>({...p,lon:i===0?shiftLongitudeNear(p.lon,anchor):p.lon}));geometry=unwrapLongitudeSequence(seeds).map(p=>({...p,lon:p.displayLon}))}
  const focus=geometry.length?geometry:unwrapped;if(focus.length<1){box.innerHTML='<div class="map-empty">The canonical route is intact, but no route occurrence has a usable coordinate yet.</div>';return}
  const lons=focus.map(p=>p.lon),lats=focus.map(p=>p.lat);let minX=Math.min(...lons),maxX=Math.max(...lons),minY=Math.min(...lats),maxY=Math.max(...lats);if(minX===maxX){minX-=1;maxX+=1}if(minY===maxY){minY-=1;maxY+=1};const dx=maxX-minX,dy=maxY-minY;minX-=dx*.08;maxX+=dx*.08;minY-=dy*.1;maxY+=dy*.1
  const w=1000,h=520,pad=38,project=p=>({x:pad+(p.lon-minX)/(maxX-minX)*(w-pad*2),y:h-pad-(p.lat-minY)/(maxY-minY)*(h-pad*2)}),pins=unwrapped.map(p=>({...p,...project(p)})),gp=geometry.map(p=>project(p)),geomLine=gp.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),centerLon=(minX+maxX)/2
  const routeLines=routeSegments.filter(seg=>seg.length>=2).map(seg=>`<polyline class="route-overview" points="${seg.map(project).map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}"/>`).join('')
  const offlineRouteLines=(offlineRouteSegments||[]).map(seg=>{const raw=(seg?.points||[]).filter(p=>Number.isFinite(Number(p?.lat))&&Number.isFinite(Number(p?.lon)));if(raw.length<2)return'';const seeded=raw.map((p,i)=>({lat:Number(p.lat),lon:i===0?shiftLongitudeNear(Number(p.lon),centerLon):Number(p.lon)})),shifted=unwrapLongitudeSequence(seeded).map(p=>({...p,lon:p.displayLon})),pts=shifted.map(project).map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');return pts?`<polyline class="route-offline" points="${pts}"/>`:''}).join('')
  const bg=(offlineFeatures||[]).map(f=>{const raw=f.points||[];if(!raw.length)return'';const seeded=raw.map((p,i)=>({...p,lon:i===0?shiftLongitudeNear(p.lon,centerLon):p.lon})),shifted=unwrapLongitudeSequence(seeded).map(p=>({...p,lon:p.displayLon})),pts=shifted.map(project).map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');if(!pts)return'';const cls=/water|river|lake|coast/i.test(f.layer)?'pbf-water':/road|street|transport/i.test(f.layer)?'pbf-road':/boundary|admin/i.test(f.layer)?'pbf-boundary':f.type==='polygon'?'pbf-land':'pbf-line';return f.type==='polygon'?`<polygon class="${cls}" points="${pts}"/>`:`<polyline class="${cls}" points="${pts}"/>`}).join('')
  box.innerHTML=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Canonical trip map"><rect class="map-bg" width="${w}" height="${h}"/><g class="pbf-layer">${bg}</g>${routeLines}${offlineRouteLines}${geomLine?`<polyline class="route-provider" points="${geomLine}"/>`:''}${pins.map(p=>`<g><circle class="pin" cx="${p.x}" cy="${p.y}" r="13"/><text class="pin-num" x="${p.x}" y="${p.y+4}" text-anchor="middle">${p.index+1}</text><text class="pin-label" x="${p.x}" y="${p.y-20}" text-anchor="middle">${esc(p.label)}</text></g>`).join('')}</svg>`
}
function renderMapSvg(model,providerGeometry=null,offline=null){
  if(!offline?.svg)return renderSimpleMapSvg(model,providerGeometry,offline?.features||[],offline?.routeSegments||[])
  const box=$('#mapCanvas'),b=offline.bounds||{},west=Number(b.west),east=Number(b.east),south=Number(b.south),north=Number(b.north)
  if(![west,east,south,north].every(Number.isFinite)||east<=west||north<=south)return renderSimpleMapSvg(model,providerGeometry,[],offline?.routeSegments||[])
  const w=1200,h=600,project=p=>({x:(Number(p.lon)-west)/(east-west)*w,y:(north-Number(p.lat))/(north-south)*h})
  const resolved=model.occurrences.filter(o=>o.resolution).map(o=>({occurrenceId:o.occurrenceId,label:o.label,index:o.index,lat:Number(o.resolution.lat),lon:Number(o.resolution.lon)}))
  const byId=new Map(resolved.map(p=>[p.occurrenceId,p]))
  const overview=(model.resolvedSegments||[]).filter(seg=>seg.length>=2).map(seg=>{const pts=seg.map(o=>byId.get(o.occurrenceId)).filter(Boolean).map(project).map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');return pts?`<polyline class="route-overview" points="${pts}"/>`:''}).join('')
  const provider=(providerGeometry||[]).filter(p=>Number.isFinite(Number(p?.lat))&&Number.isFinite(Number(p?.lon))).map(project).map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const offlineRoutes=(offline.routeSegments||[]).map(seg=>{const geometry=(seg?.geometry||seg?.points||[]).filter(p=>Number.isFinite(Number(p?.lat))&&Number.isFinite(Number(p?.lon)));if(geometry.length<2)return'';const pts=geometry.map(project).map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');return `<polyline class="route-offline" points="${pts}"/>`}).join('')
  const pins=resolved.map(p=>({...p,...project(p)})).map(p=>`<g><circle class="pin" cx="${p.x}" cy="${p.y}" r="13"/><text class="pin-num" x="${p.x}" y="${p.y+4}" text-anchor="middle">${p.index+1}</text><text class="pin-label" x="${p.x}" y="${p.y-20}" text-anchor="middle">${esc(p.label)}</text></g>`).join('')
  box.classList.add('offline-ready');box.innerHTML=`<div class="map-offline-svg">${offline.svg}</div><svg class="map-overlay" viewBox="0 0 ${w} ${h}" role="img" aria-label="Canonical trip over installed offline map">${overview}${offlineRoutes}${provider?`<polyline class="route-provider" points="${provider}"/>`:''}${pins}</svg>`
}

function chooseResolutionCandidate(occurrenceId,index){
  const next=selectCandidate(state.authority,{resolutions:state.resolutions,candidates:state.resolutionCandidates,findings:state.resolutionFindings},occurrenceId,index);state.resolutions=next.resolutions;state.resolutionCandidates=next.candidates;state.resolutionFindings=next.findings;state.mapQuestRoute=null;state.offlineBackground=null;persist();renderMapping()
}
function renderMapping(){
  if(!state.authority)return
  const model=buildMapModel(state.authority,state.resolutions),findings=[...validateAuthority(state.authority),...modelInvariantFindings(model),...(state.resolutionFindings||[])],currentRoute=state.mapQuestRoute&&state.mapQuestRoute.tripId===model.tripId&&Number(state.mapQuestRoute.authorityVersion)===Number(model.authorityVersion)&&state.mapQuestRoute.snapshotKey===model.snapshotKey?state.mapQuestRoute:null
  if(state.mapQuestRoute&&!currentRoute)state.mapQuestRoute=null
  const resolutionCards=model.occurrences.filter(o=>!o.resolution).map(o=>{const options=state.resolutionCandidates?.[o.occurrenceId]||[];if(!options.length)return`<div class="finding"><b>${esc(o.label)}</b> is unresolved. The stop remains in the canonical route.</div>`;return`<div class="finding ambiguity"><b>${esc(o.label)}</b> has multiple map matches. Choose one; WAYFINDER will not guess.<div class="candidate-list">${options.map((c,i)=>`<button class="candidate ghost small" data-occ="${esc(o.occurrenceId)}" data-index="${i}">${esc(c.label||`${c.lat}, ${c.lon}`)}</button>`).join('')}</div></div>`}).join('')
  const googleSegments=googleMapsUrls(model),eligibility=mapQuestEligibility(model),shareEligibility=mapQuestShareEligibility(model),googleNotice=googleSegments.length>1?`<div class="finding"><b>Google Maps handoff is split into ${googleSegments.length} route segments</b> so no canonical stops are dropped. ${googleSegments.map(x=>`<a target="_blank" rel="noreferrer" href="${esc(x.url)}">Segment ${x.index}</a>`).join(' · ')}</div>`:'',providerNotice=!googleSegments.length&&model.allCoordinatesResolved&&!eligibility.ok?`<div class="finding"><b>Directions handoff withheld.</b> ${esc(eligibility.reason)} The canonical map remains visible without substituting another transport mode.</div>`:''
  $('#mapWarnings').innerHTML=findings.map(f=>`<div class="finding ${f.severity==='blocker'?'blocker':''}">${esc(f.message)}</div>`).join('')+resolutionCards+googleNotice+providerNotice;$('#mapWarnings').querySelectorAll('.candidate').forEach(btn=>btn.onclick=()=>chooseResolutionCandidate(btn.dataset.occ,Number(btn.dataset.index)))
  $('#mapEvidence').textContent=`Authority v${model.authorityVersion} · ${model.occurrences.length} occurrences · ${model.legs.length} legs`;$('#coordinateFact').textContent=`${model.resolvedCount}/${model.occurrences.length} resolved${model.unresolvedOccurrenceIds.length?` · ${model.unresolvedOccurrenceIds.length} unresolved`:''}`
  const pbfRuntime=state.runtime?.offlinePbf||{},pbfBase=pbfRuntime.kind==='raw-osm-pbf-library'?(pbfRuntime.available?`${pbfRuntime.catalogCount||0} installed .osm.pbf file${Number(pbfRuntime.catalogCount||0)===1?'':'s'} found`:(pbfRuntime.message||'Offline map library not configured')):(pbfRuntime.available?`Legacy vector-tile map data available`:'Offline map data not configured')
  $('#mapQuestFact').textContent=currentRoute?.geometry?.length?`${currentRoute.geometry.length} validated routed geometry points`:(state.runtime?.mapquest?.configured?(eligibility.ok?'Configured · ready for canonical road routing':eligibility.reason):'API key not configured');$('#pbfFact').textContent=state.offlineBackground?.message||pbfBase;renderMapSvg(model,currentRoute?.geometry||null,state.offlineBackground)
  const gu=googleSegments.length===1?googleSegments[0].url:'',mq=mapQuestShareUrl(model);$('#googleBtn').href=gu||'#';$('#googleBtn').classList.toggle('disabled',!gu);$('#googleBtn').title=googleSegments.length>1?'Use the segment links above so every canonical stop is preserved.':'';$('#mapQuestShareBtn').href=mq||'#';$('#mapQuestShareBtn').classList.toggle('disabled',!mq);$('#mapQuestShareBtn').title=shareEligibility.ok?'':shareEligibility.reason;$('#routeMapQuestBtn').disabled=!state.runtime?.mapquest?.configured||!eligibility.ok||findings.some(f=>f.severity==='blocker');const rawPbfNeedsAll=pbfRuntime.kind==='raw-osm-pbf-library';$('#offlinePbfBtn').disabled=!pbfRuntime.available||model.resolvedCount<2||(rawPbfNeedsAll&&!model.allCoordinatesResolved);$('#offlinePbfBtn').title=rawPbfNeedsAll&&!model.allCoordinatesResolved?'Detailed .osm.pbf routing waits until every canonical stop has a coordinate so unresolved stops are never bridged.':''
}
async function routeWithMapQuest(){
  if(!guardCommittedAuthority($('#mapStatus'),'MapQuest routing'))return
  const requested=buildMapModel(state.authority,state.resolutions),eligibility=mapQuestEligibility(requested);if(!eligibility.ok)return status($('#mapStatus'),eligibility.reason,'warn');setBusy($('#routeMapQuestBtn'),true,'Routing…')
  try{const r=await fetch('/api/mapquest/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(requested)}),d=await r.json();if(!r.ok)throw new Error(d.error||`MapQuest ${r.status}`);const current=buildMapModel(state.authority,state.resolutions);if(!providerRouteMatchesModel(d,current))throw new Error('Provider response became stale while the trip changed and was discarded.');state.mapQuestRoute=d;persist();renderMapping()}catch(e){$('#mapWarnings').innerHTML=`<div class="finding blocker">${esc(e.message)}</div>`}finally{setBusy($('#routeMapQuestBtn'),false)}
}
$('#routeMapQuestBtn').onclick=routeWithMapQuest
async function loadPbfMap(){
  if(!guardCommittedAuthority($('#mapStatus'),'Offline map'))return
  const model=buildMapModel(state.authority,state.resolutions);if(model.resolvedCount<2)return status($('#mapStatus'),'Resolve at least two saved route occurrences before loading the offline map.','warn')
  const runtimePbf=state.runtime?.offlinePbf||{},deadline=beginAction('Offline map'),started=performance.now();let jobId='',ticker=null
  const update=text=>{const elapsed=Math.max(0,Math.floor((performance.now()-started)/1000)),remaining=Math.max(0,120-elapsed);$('#pbfFact').textContent=`${text}${elapsed?` · ${elapsed}s`:''}${remaining<=30?` · ${remaining}s limit`:''}`}
  setBusy($('#offlinePbfBtn'),true,'Loading map…');update('Checking installed offline map coverage…');ticker=setInterval(()=>update($('#pbfFact').textContent.split(' · ')[0]||'Preparing offline map…'),1000)
  try{
    if(runtimePbf.kind==='raw-osm-pbf-library'){
      if(!model.allCoordinatesResolved)throw new Error('Detailed offline routing waits until every canonical stop is resolved. The partial canonical map remains available without inventing a route across unresolved stops.')
      const points=model.occurrences.map(o=>({lat:o.resolution.lat,lon:o.resolution.lon,occurrenceId:o.occurrenceId,label:o.label})),legModes=model.legs.map(l=>l.modeConfirmed?l.mode:'Any')
      const sr=await fetch('/api/offline/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({points}),signal:deadline.signal}),sd=await sr.json();if(!sr.ok||!sd.available)throw new Error(sd.error||sd.message||'Installed offline map coverage is unavailable.');state.runtime.offlinePbf=sd;renderSettingsRuntime();if(!sd.renderReady)throw new Error(sd.message||'Installed .osm.pbf files do not cover every resolved route stop.');update(sd.message||'Installed map coverage found.')
      const rr=await fetch('/api/offline/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({points,legModes}),signal:deadline.signal}),rd=await rr.json();if(!rr.ok)throw new Error(rd.error||'Offline map render could not start.');jobId=rd.job?.id||'';if(!jobId)throw new Error('Offline renderer did not return a job id.')
      while(true){await sleep(650,deadline.signal);const jr=await fetch(`/api/offline/job/${encodeURIComponent(jobId)}`,{signal:deadline.signal}),jd=await jr.json();if(!jr.ok)throw new Error(jd.error||'Offline map render status failed.');const job=jd.job||{};update(`${job.message||'Rendering installed .osm.pbf data…'}${Number.isFinite(Number(job.percent))?` · ${Math.round(Number(job.percent))}%`:''}`)
        if(job.state==='ready'){state.offlineBackground={svg:job.svg,bounds:job.bounds,routeSegments:job.routeSegments||[],message:job.message||'Offline map ready.',degraded:Boolean(job.degraded),limitationReasons:job.limitationReasons||[],sourceFiles:job.sourceFiles||[],resourceStats:job.resourceStats||null};break}
        if(['failed','limited','cancelled'].includes(job.state))throw new Error(job.message||job.error||'Offline map render did not complete.')
      }
    }else{
      const result=await loadOfflinePbf(model,runtimePbf,{signal:deadline.signal,onProgress:t=>update(t||'Loading local vector tiles…')});state.offlineBackground=result
    }
    persist();renderMapping();$('#pbfFact').textContent=state.offlineBackground?.message||'Offline map ready.'
  }catch(e){if(e.name!=='AbortError'){const message=actionError(e,'Offline map');$('#pbfFact').textContent=message;state.offlineBackground=null;renderMapping()}if(jobId&&e.name==='AbortError')fetch(`/api/offline/job/${encodeURIComponent(jobId)}`,{method:'DELETE'}).catch(()=>{})}
  finally{deadline.dispose();if(ticker)clearInterval(ticker);setBusy($('#offlinePbfBtn'),false)}
}
$('#offlinePbfBtn').onclick=loadPbfMap

function renderDocumentPreferences(){
  state.documentPreferences=normalizeDocumentPreferences(state.documentPreferences);const box=$('#documentSections');if(!box)return
  box.innerHTML=DOCUMENT_SECTIONS.map(def=>`<label class="document-section-option"><input type="checkbox" data-doc-section="${esc(def.key)}" ${state.documentPreferences.sections[def.key]?'checked':''}><span>${esc(def.label)}<small>${esc(def.description)}</small></span></label>`).join('')
  box.querySelectorAll('[data-doc-section]').forEach(input=>input.onchange=()=>{const next=structuredClone(state.documentPreferences);next.sections[input.dataset.docSection]=input.checked;if(!Object.values(next.sections).some(Boolean)){input.checked=true;status($('#documentStatus'),'Keep at least one document section selected.','warn');return}state.documentPreferences=normalizeDocumentPreferences(next);state.document=null;$('#documentOutput').textContent='';persist();status($('#documentStatus'),'Document section preferences saved. Build document to apply them.','ok')})
}

async function buildDocument(){
  if(!guardCommittedAuthority($('#documentStatus'),'Documentation'))return
  const snapshot=structuredClone(state.authority),model=buildMapModel(snapshot,state.resolutions),deadline=beginAction('Documentation'),started=performance.now();let phase=`Preparing authority v${snapshot.version}…`,ticker=null,firstTextAt=0
  const show=text=>{if(text)phase=text;const elapsed=Math.max(0,Math.floor((performance.now()-started)/1000)),remaining=Math.max(0,120-elapsed);status($('#documentStatus'),`${phase}${elapsed?` · ${elapsed}s`:''}${remaining<=30?` · ${remaining}s limit`:''}`,'busy')}
  const baseline=buildDocumentBaseline(snapshot,model,{preferences:state.documentPreferences});$('#documentOutput').textContent=baseline;firstTextAt=performance.now();setBusy($('#documentBtn'),true,'Writing…');phase='Complete outline ready · researching local references…';show();ticker=setInterval(()=>show(),1000);aiQueryActive=true;renderRuntimeBadges()
  try{
    let references=[];const docSections=state.documentPreferences?.sections||{},needsDestinationReferences=Boolean(docSections.stops)
    if(state.runtime?.references?.available&&needsDestinationReferences){
      const referenceDeadline=createDeadline(deadline.signal,{ms:25000,label:'Local reference research'})
      try{references=await gatherTripReferences(snapshot,{signal:referenceDeadline.signal,maxStops:8,onProgress:text=>text&&show(text)})}finally{referenceDeadline.dispose()}
    }
    phase=`Enriching the complete document from authority v${snapshot.version}${references.length?` with ${references.length} local reference${references.length===1?'':'s'}`:' using the authority-only fallback'}…`;show()
    const result=await streamDocument(snapshot,model,{references,preferences:state.documentPreferences,signal:deadline.signal,onText:text=>{$('#documentOutput').textContent=text;phase='Enriching complete itinerary…';show()}})
    state.document={...result,tripId:snapshot.id,authorityVersion:snapshot.version,referenceCount:references.length,createdAt:Date.now(),elapsedMs:Math.round(performance.now()-started),firstTextMs:Math.round(firstTextAt-started)};$('#documentOutput').textContent=result.text;persist()
    const elapsed=Math.max(1,Math.round((performance.now()-started)/1000)),first=Math.max(0,Math.round((firstTextAt-started)/1000))
    if(result.enrichmentPartial)status($('#documentStatus'),`Documentation degraded in ${elapsed}s · all selected sections preserved with concise fallback notes${result.error?` · ${result.error}`:''}.`,'warn')
    else status($('#documentStatus'),`Document complete · first useful text ${first}s · ${elapsed}s total.`,'ok')
  }catch(e){if(e.name!=='AbortError'){const fallback=buildDocumentBaseline(snapshot,model,{preferences:state.documentPreferences});$('#documentOutput').textContent=fallback;state.document={text:fallback,partial:false,enrichmentPartial:true,error:actionError(e,'Documentation'),tripId:snapshot.id,authorityVersion:snapshot.version,referenceCount:0,createdAt:Date.now(),elapsedMs:Math.round(performance.now()-started),firstTextMs:Math.round(firstTextAt-started)};persist();status($('#documentStatus'),`Documentation degraded · concise authority-only fallback · ${actionError(e,'Documentation')}`,'warn')}}
  finally{deadline.dispose();if(ticker)clearInterval(ticker);aiQueryActive=false;setBusy($('#documentBtn'),false);await refreshRuntime()}
}
$('#documentBtn').onclick=buildDocument;$('#copyDocBtn').onclick=async()=>{await navigator.clipboard.writeText($('#documentOutput').textContent||'');status($('#documentStatus'),'Copied.','ok')}
function renderDocument(){renderDocumentPreferences();if(state.document?.text){$('#documentOutput').textContent=state.document.text;status($('#documentStatus'),`Saved document from authority v${state.document.authorityVersion}${state.document.partial?' · partial':''}.`,state.document.partial?'warn':'ok')}else{$('#documentOutput').textContent=''}}

$('#exportBtn').onclick=()=>{if(state.authority)exportState(state)}
function legacyExploration(d){if(!d?.spark)return null;return{id:`legacy_${Date.now().toString(36)}`,prompt:d.briefText||d.authority?.brief?.rawText||'',basics:deriveTripBasics(d.briefText||d.authority?.brief?.rawText||''),stage:'ideas',confirmed:true,confirmedContract:d.spark.constraints||{},proposals:d.spark.proposals||[],speculativeProposals:[],warnings:d.spark.warnings||[]}}
function hydrateWorkingState(d){
  const exploration=d.exploration||legacyExploration(d),activeSpark=d.activeSpark||(d.authority&&exploration?{id:`active_${d.authority.id}`,tripId:d.authority.id,prompt:d.authority?.brief?.rawText||exploration.prompt,exploration:structuredClone(exploration)}:null)
  Object.assign(state,{briefText:exploration?.prompt||activeSpark?.prompt||d.authority?.brief?.rawText||'',exploration,activeSpark,selectedProposalId:d.selectedProposalId||null,authority:d.authority||null,resolutions:d.resolutions||{},resolutionCandidates:d.resolutionCandidates||{},resolutionFindings:d.resolutionFindings||[],mapQuestRoute:d.mapQuestRoute||null,document:d.document||null,documentPreferences:normalizeDocumentPreferences(d.documentPreferences),revisionLog:d.revisionLog||[]})
  precisionDirty=false;precisionDraft=null;ideasExpanded=false;$('#brief').value=state.briefText;renderTripBasics();renderProposals();if(state.authority){showWorkspace();renderRevisionContext()}
}
$('#importFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{const d=await importState(file);cancelSparkPrep();hydrateWorkingState(d);persist();status($('#precisionStatus'),'Trip imported. Active trip and Spark exploration ownership were restored separately.','ok')}catch(err){alert(`Could not import trip: ${err.message}`)}finally{e.target.value=''}}
$('#resetBtn').onclick=()=>{if(!confirm('Start a new trip? This clears the locally saved working trip.'))return;cancelSparkPrep();clearState();location.reload()}

function restore(){const d=loadState();if(!d)return;if(d.__loadError){status($('#sparkStatus'),`Saved trip could not be loaded safely and was quarantined: ${d.__loadError}`,'error');return}hydrateWorkingState(d)}
await registerClientSession();await refreshRuntime();restore();renderMapping();runtimeRefreshTimer=setInterval(()=>{if(!document.hidden&&!aiQueryActive)refreshRuntime()},5000);window.addEventListener('focus',()=>{if(!aiQueryActive)refreshRuntime()});window.addEventListener('pagehide',event=>{if(!event.persisted)closeClientSession()})
