import { validateAuthorityIntegrity, validateAuthority, TRANSPORT_MODES } from './authority.js'
import { normalizeDocumentPreferences } from './documentPlan.js'

const KEY='wayfinder.rebuild.state.v3',LEGACY_KEYS=['wayfinder.rebuild.state.v2','wayfinder.rebuild.state.v1'],BACKUP_PREFIX='wayfinder.rebuild.quarantine.'
function asObject(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:null}
function arr(v){return Array.isArray(v)?v:[]}

function normalizeExploration(value){
  const e=asObject(value);if(!e)return null
  const out=structuredClone(e);out.id=String(out.id||'').trim()||`restored_${Date.now().toString(36)}`;out.prompt=String(out.prompt||'');out.proposals=arr(out.proposals);out.speculativeProposals=arr(out.speculativeProposals);out.warnings=arr(out.warnings);out.confirmed=Boolean(out.confirmed);return out
}
function normalizeActiveSpark(value){const a=asObject(value);if(!a)return null;const out=structuredClone(a);out.id=String(out.id||'').trim()||null;out.tripId=String(out.tripId||(out.id?.startsWith('active_')?out.id.slice(7):'')).trim()||null;out.prompt=String(out.prompt||'');out.exploration=normalizeExploration(out.exploration);return out.exploration?out:null}
function normalizeAuthority(a){
  const n=structuredClone(a);n.schemaVersion=2;n.scopes=arr(n.scopes);n.occurrences=arr(n.occurrences);n.experiences=arr(n.experiences);n.travelers=arr(n.travelers);n.commitments=arr(n.commitments);n.exclusions=arr(n.exclusions)
  n.placeConstraints=asObject(n.placeConstraints)||{required:[],optional:[],excluded:[]};n.placeConstraints.required=arr(n.placeConstraints.required);n.placeConstraints.optional=arr(n.placeConstraints.optional);n.placeConstraints.excluded=arr(n.placeConstraints.excluded)
  n.transport=asObject(n.transport)||{};n.transport.primaryMode=TRANSPORT_MODES.includes(n.transport.primaryMode)?n.transport.primaryMode:'Any';n.transport.confirmed=Boolean(n.transport.confirmed&&n.transport.primaryMode!=='Any');n.transport.scoped=arr(n.transport.scoped);n.transport.legModes=asObject(n.transport.legModes)||{};n.transport.reconfirmationRequiredLegIds=arr(n.transport.reconfirmationRequiredLegIds);n.transport.pendingLegReviews=arr(n.transport.pendingLegReviews)
  return n
}
export function validatePersistedState(input){
  const state=asObject(input);if(!state)throw new Error('Trip file is not a WAYFINDER state object.')
  const out=structuredClone(state)
  if(out.authority!=null){const a=asObject(out.authority);if(!a)throw new Error('Trip authority is invalid.');if(![1,2].includes(Number(a.schemaVersion)))throw new Error(`Unsupported trip schema version ${a.schemaVersion??'unknown'}.`);if(!String(a.id||'').trim())throw new Error('Trip authority is missing its identity.');if(!Array.isArray(a.occurrences))throw new Error('Trip authority route is malformed.');if(a.transport?.primaryMode!=null&&!TRANSPORT_MODES.includes(a.transport.primaryMode))throw new Error(`Trip authority contains unsupported transport mode ${a.transport.primaryMode}.`);out.authority=normalizeAuthority(a);const integrityBlockers=validateAuthorityIntegrity(out.authority).filter(f=>f.severity==='blocker');if(integrityBlockers.length)throw new Error(`Trip authority failed integrity checks: ${integrityBlockers.map(f=>f.message).join(' ')}`);const invariantBlockers=validateAuthority(out.authority).filter(f=>f.severity==='blocker');if(invariantBlockers.length)throw new Error(`Trip authority failed canonical invariant checks: ${invariantBlockers.map(f=>f.message).join(' ')}`)}
  out.exploration=normalizeExploration(out.exploration);out.activeSpark=normalizeActiveSpark(out.activeSpark);if(out.authority&&out.activeSpark?.tripId&&out.activeSpark.tripId!==out.authority.id)out.activeSpark=null
  // A free-floating composer draft is not durable trip state. Only restore text that
  // is owned by a valid exploration/active trip; orphaned legacy/test text is dropped.
  const ownedPrompts=[out.exploration?.prompt,out.activeSpark?.prompt,out.authority?.brief?.rawText].map(x=>String(x||'').trim()).filter(Boolean)
  const persistedBrief=String(out.briefText||'').trim();out.briefText=persistedBrief&&ownedPrompts.includes(persistedBrief)?persistedBrief:''
  out.resolutions=asObject(out.resolutions)||{};out.resolutionCandidates=asObject(out.resolutionCandidates)||{};out.resolutionFindings=arr(out.resolutionFindings);out.revisionLog=arr(out.revisionLog).filter(x=>!out.authority||!x?.tripId||x.tripId===out.authority.id);out.selectedProposalId=String(out.selectedProposalId||'').trim()||null;out.documentPreferences=normalizeDocumentPreferences(out.documentPreferences)
  if(out.mapQuestRoute&&out.authority&&(out.mapQuestRoute.tripId!==out.authority.id||Number(out.mapQuestRoute.authorityVersion)!==Number(out.authority.version)))out.mapQuestRoute=null
  if(out.document&&out.authority&&(out.document.tripId!==out.authority.id||Number(out.document.authorityVersion)!==Number(out.authority.version)))out.document=null
  if(out.document?.documentPlan&&JSON.stringify(normalizeDocumentPreferences(out.document.documentPlan.preferences))!==JSON.stringify(out.documentPreferences))out.document=null
  return out
}
export function saveState(state){try{localStorage.setItem(KEY,JSON.stringify(validatePersistedState(state)));return{ok:true}}catch(error){return{ok:false,error:error.message}}}
export function loadState(){
  let raw=null,key=KEY;try{raw=localStorage.getItem(KEY);if(!raw){for(const legacy of LEGACY_KEYS){raw=localStorage.getItem(legacy);if(raw){key=legacy;break}}}if(!raw)return null;const state=validatePersistedState(JSON.parse(raw));if(key!==KEY){const saved=saveState(state);if(saved.ok)localStorage.removeItem(key)}return state}
  catch(error){if(raw){try{localStorage.setItem(`${BACKUP_PREFIX}${Date.now()}`,raw)}catch{}}return{__loadError:error.message,__quarantined:Boolean(raw)}}
}
export function clearState(){localStorage.removeItem(KEY);for(const legacy of LEGACY_KEYS)localStorage.removeItem(legacy)}
export function exportState(state){const safe=validatePersistedState(state),blob=new Blob([JSON.stringify(safe,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`wayfinder-${safe?.authority?.id||'trip'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
export async function importState(file){return validatePersistedState(JSON.parse(await file.text()))}
