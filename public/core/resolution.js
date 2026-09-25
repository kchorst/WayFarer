import { routeOccurrences, placeMatchKey } from './authority.js'

const clean=x=>String(x??'').trim()
const lc=x=>clean(x).toLowerCase()
const valid=x=>typeof x?.lat==='number'&&typeof x?.lon==='number'&&Number.isFinite(x.lat)&&Number.isFinite(x.lon)&&x.lat>=-90&&x.lat<=90&&x.lon>=-180&&x.lon<=180
export function resolutionMatchesOccurrence(resolution,occurrence){return Boolean(valid(resolution)&&resolution?.occurrenceId===occurrence?.id&&clean(resolution?.queryLabel)&&lc(resolution.queryLabel)===lc(occurrence?.place?.label))}
function scopeAgreement(candidate,authority,occurrence){
  const candidateLabel=placeMatchKey(candidate?.label),qualifier=placeMatchKey(occurrence?.place?.qualifier)
  if(qualifier&&candidateLabel.includes(qualifier))return true
  for(const scope of authority?.scopes||[]){
    if(scope.countryCode&&candidate?.countryCode&&lc(scope.countryCode)===lc(candidate.countryCode))return true
    const key=placeMatchKey(scope.label);if(key&&candidateLabel.includes(key))return true
  }
  return false
}
export function confidentCandidate(options=[],authority=null,occurrence=null){
  const best=options[0],second=options[1];if(!best)return false
  const bestScore=Number(best.confidence||0),secondScore=Number(second?.confidence||0),qualifier=clean(occurrence?.place?.qualifier)
  const strongScopes=(authority?.scopes||[]).filter(scope=>clean(scope?.countryCode))
  const hasIdentityContext=Boolean(qualifier||strongScopes.length),agrees=scopeAgreement(best,authority,occurrence)
  if(hasIdentityContext&&!agrees)return false
  if(agrees&&bestScore>=0.55)return true
  if(options.length===1)return bestScore>=0.75
  return bestScore>=0.9&&secondScore<0.6
}
export async function resolveAuthority(authority,{fetchImpl=fetch,signal=null,onProgress=()=>{},previousResolutions={},endpoint='/api/geocode'}={}){
  const route=routeOccurrences(authority),resolutions={},candidates={},findings=[]
  for(let i=0;i<route.length;i++){
    const occ=route[i],label=occ.place.label,prior=previousResolutions?.[occ.id]
    onProgress({index:i,total:route.length,occurrenceId:occ.id,label})
    if(resolutionMatchesOccurrence(prior,occ)){resolutions[occ.id]={...prior};continue}
    let data={results:[]}
    try{const r=await fetchImpl(`${endpoint}?q=${encodeURIComponent(label)}`,{signal});if(!r.ok)throw new Error(`geocoder ${r.status}`);data=await r.json()}
    catch(error){if(error?.name==='AbortError')throw error;findings.push({code:'GEOCODER_UNAVAILABLE',severity:'warning',occurrenceId:occ.id,message:`Coordinate lookup failed for "${label}". The stop remains in the trip.`});continue}
    const options=(data.results||[]).filter(valid).slice(0,5)
    if(confidentCandidate(options,authority,occ)){resolutions[occ.id]={...options[0],occurrenceId:occ.id,queryLabel:label,resolvedAgainstTripId:authority.id,resolvedAgainstAuthorityVersion:authority.version};continue}
    if(options.length){candidates[occ.id]=options;findings.push({code:'PLACE_AMBIGUOUS',severity:'warning',occurrenceId:occ.id,message:`"${label}" has multiple or low-confidence map matches and needs a traveler choice.`})}
    else findings.push({code:'PLACE_UNRESOLVED',severity:'warning',occurrenceId:occ.id,message:`No map coordinates were found for "${label}". The stop remains in the trip.`})
  }
  onProgress(null);return{tripId:authority?.id||'',authorityVersion:authority?.version||0,resolvedAt:Date.now(),resolutions,candidates,findings}
}
export function selectCandidate(authority,resolutionState,occurrenceId,index){
  const occ=routeOccurrences(authority).find(o=>o.id===occurrenceId),options=resolutionState?.candidates?.[occurrenceId]||[],choice=options[index]
  if(!occ||!valid(choice))return resolutionState
  const resolutions={...(resolutionState.resolutions||{}),[occurrenceId]:{...choice,occurrenceId,queryLabel:occ.place.label,resolvedAgainstTripId:authority.id,resolvedAgainstAuthorityVersion:authority.version,travelerSelected:true}}
  const candidates={...(resolutionState.candidates||{})};delete candidates[occurrenceId]
  const findings=(resolutionState.findings||[]).filter(f=>f.occurrenceId!==occurrenceId)
  return{...resolutionState,tripId:authority.id,authorityVersion:authority.version,resolutions,candidates,findings}
}
