import { validateAuthority, routeOccurrences } from './authority.js'

export const OUTCOME=Object.freeze({SUCCESS:'success',DEGRADED:'degraded',FAILURE:'failure'})
const fail=(reason,details={})=>({outcome:OUTCOME.FAILURE,reason,...details})
const degraded=(reason,details={})=>({outcome:OUTCOME.DEGRADED,reason,...details})
const success=(details={})=>({outcome:OUTCOME.SUCCESS,...details})
const labels=a=>routeOccurrences(a||{}).map(o=>String(o?.place?.label||'').trim()).filter(Boolean)

export function sparkOutcome(result,{contract}={}){
  const proposals=Array.isArray(result?.proposals)?result.proposals:[]
  if(!proposals.length)return result?.planningFrame?degraded('planning-frame-only'):fail('no-adoptable-itinerary')
  const adoptable=proposals.filter(p=>p?.verificationStatus==='verified'&&Array.isArray(p.stops)&&p.stops.length>=2)
  if(!adoptable.length)return degraded('no-verified-adoptable-itinerary')
  if(contract?.start&&!adoptable.some(p=>String(p.stops[0]||'').toLowerCase()===String(contract.start).toLowerCase()))return fail('confirmed-start-not-preserved')
  return success({count:adoptable.length})
}

export function revisionOutcome(before,after){
  if(!before||!after)return fail('missing-authority')
  if(before.id!==after.id)return fail('trip-identity-changed')
  if(Number(after.version)<=Number(before.version))return fail('authority-version-not-advanced')
  const blockers=validateAuthority(after).filter(x=>x.severity==='blocker')
  if(blockers.length)return fail('invalid-authority',{blockers})
  return success()
}

export function precisionOutcome(authority,{dirty=false,committedVersion}={}){
  if(!authority)return fail('missing-authority')
  if(dirty)return fail('precision-draft-not-committed')
  if(committedVersion!=null&&Number(committedVersion)!==Number(authority.version))return fail('stale-precision-commit')
  const blockers=validateAuthority(authority).filter(x=>x.severity==='blocker')
  return blockers.length?fail('invalid-authority',{blockers}):success()
}

export function mappingOutcome(authority,mapModel){
  if(!authority||!mapModel)return fail('missing-map-result')
  if(mapModel.tripId&&mapModel.tripId!==authority.id)return fail('map-wrong-trip')
  if(mapModel.authorityVersion!=null&&Number(mapModel.authorityVersion)!==Number(authority.version))return fail('map-stale-authority')
  const expected=labels(authority),actual=(mapModel.occurrences||[]).map(x=>String(x?.label||x?.place?.label||'').trim()).filter(Boolean)
  if(expected.length&&actual.length&&JSON.stringify(expected)!==JSON.stringify(actual))return fail('map-route-sequence-mismatch')
  if(mapModel.ready===false||mapModel.blocked===true)return fail('map-not-ready')
  return success()
}

export function documentOutcome(authority,document){
  if(!authority||!document)return fail('missing-document')
  if(document.tripId!==authority.id||Number(document.authorityVersion)!==Number(authority.version))return fail('document-stale-authority')
  if(document.enrichmentPartial||document.fallback===true)return degraded('document-fallback')
  const text=String(document.text||'').toLowerCase()
  const missing=labels(authority).filter(label=>!text.includes(label.toLowerCase()))
  if(missing.length)return fail('document-route-omission',{missing})
  return success()
}
