import { samePlace, placeMatchKey } from './authority.js'
import { countryCodeForName } from './geography.js'

const clean=v=>String(v??'').trim()
const uniq=arr=>[...new Set(arr.filter(Boolean))]
const scopeLabel=s=>clean(typeof s==='string'?s:s?.label)
const scopeKind=s=>clean(typeof s==='string'?'region':s?.kind||'region').toLowerCase()
const firstAdminToken=label=>placeMatchKey(clean(label).split(',')[0])
export const SCOPE_VERIFICATION=Object.freeze({VERIFIED:'VERIFIED',UNVERIFIED:'UNVERIFIED',CONTRADICTED:'CONTRADICTED'})

async function geocode(query,{fetchImpl=fetch,signal,endpoint='/api/geocode'}={}){
  const r=await fetchImpl(`${endpoint}?q=${encodeURIComponent(query)}`,{signal})
  if(!r.ok)throw new Error(`geocoder ${r.status}`)
  const data=await r.json();return Array.isArray(data?.results)?data.results:[]
}

function contradiction(reason,advisories=[]){return{ok:false,verified:false,status:SCOPE_VERIFICATION.CONTRADICTED,reason,advisories}}
function unverified(advisories=[]){return{ok:true,verified:false,status:SCOPE_VERIFICATION.UNVERIFIED,advisories}}
function verified(advisories=[]){return{ok:true,verified:true,status:SCOPE_VERIFICATION.VERIFIED,advisories}}

export async function validateProposalScopeGeography(proposal,contract,{fetchImpl=fetch,signal,endpoint='/api/geocode'}={}){
  const scopes=(contract?.scopes||[]).filter(s=>scopeLabel(s))
  if(!scopes.length)return verified([])

  // Start/end anchors are part of geographic coverage evidence. Excluding them
  // allowed two-stop routes to bypass hard scope verification entirely.
  const route=uniq((proposal?.stops||[]).map(clean).filter(Boolean))
  if(!route.length)return contradiction('The route has no stops that can satisfy the confirmed geographic scope.')

  const queries=uniq([...scopes.map(scopeLabel),...route])
  const cache=new Map(await Promise.all(queries.map(async query=>{
    try{return[query,await geocode(query,{fetchImpl,signal,endpoint})]}
    catch{return[query,null]}
  })))

  const scopeEvidence=scopes.map(scope=>{
    const label=scopeLabel(scope),kind=scopeKind(scope),results=cache.get(label)
    const expectedCountryCode=kind==='country'?countryCodeForName(label):''
    const tokens=[placeMatchKey(label)]
    for(const r of (results||[]).slice(0,3))tokens.push(firstAdminToken(r.label))
    return{label,kind,requiredCoverage:Boolean(typeof scope==='object'&&scope?.requiredCoverage),tokens:uniq(tokens),expectedCountryCode,results}
  })

  const advisories=[]
  let uncertainty=false
  for(const scope of scopeEvidence){
    if(scope.results===null){uncertainty=true;advisories.push({code:'SPARK_SCOPE_UNVERIFIED',severity:'warning',message:`Could not verify confirmed destination area ${scope.label}. This idea cannot be adopted until local geographic evidence is available.`})}
    else if(!scope.results.length){uncertainty=true;advisories.push({code:'SPARK_SCOPE_UNVERIFIED',severity:'warning',message:`No geographic evidence was available for confirmed destination area ${scope.label}. This idea cannot be adopted until it is verified.`})}
  }

  const sameEntity=(a,b)=>{
    for(const x of a||[])for(const y of b||[]){
      if(placeMatchKey(x.label)&&placeMatchKey(x.label)===placeMatchKey(y.label))return true
      const dx=Math.abs(Number(x.lat)-Number(y.lat)),dy=Math.abs(Number(x.lon)-Number(y.lon))
      if(Number.isFinite(dx)&&Number.isFinite(dy)&&dx<0.02&&dy<0.02)return true
    }
    return false
  }
  const matchesScope=(results,scope)=>results.some(r=>{
    const cc=clean(r.countryCode).toUpperCase(),labelKey=placeMatchKey(r.label)
    // Country scope identity is authoritative when the ISO country is known.
    // This prevents the country Georgia from being satisfied by Atlanta, Georgia (US).
    if(scope.kind==='country'&&scope.expectedCountryCode)return cc===scope.expectedCountryCode
    if(scope.kind==='country'&&cc){
      const scopeCodes=uniq((scope.results||[]).map(x=>clean(x.countryCode).toUpperCase()).filter(Boolean))
      if(scopeCodes.length)return scopeCodes.includes(cc)
    }
    return scope.tokens.some(token=>token&&labelKey.includes(token))
  })

  const matchedRequired=new Set()
  for(const stop of route){
    const results=cache.get(stop)
    if(results===null){uncertainty=true;advisories.push({code:'SPARK_SCOPE_UNVERIFIED',severity:'warning',message:`Could not verify geographic scope for ${stop}. This idea can be read but not adopted until verified.`});continue}
    if(!results.length){uncertainty=true;advisories.push({code:'SPARK_SCOPE_UNVERIFIED',severity:'warning',message:`No geographic evidence was available to verify ${stop}. This idea can be read but not adopted until verified.`});continue}
    for(const scope of scopeEvidence){
      if(scope.results&&sameEntity(results,scope.results))return contradiction(`${stop} resolves to the broad destination area ${scope.label}, not to a route stop.`,advisories)
    }
    const matched=scopeEvidence.filter(scope=>scope.results?.length&&matchesScope(results,scope))
    if(!matched.length){
      // If all relevant scope evidence exists, this is a contradiction. If scope
      // evidence itself is unavailable, do not invent certainty: block adoption.
      const anyScopeUnavailable=scopeEvidence.some(scope=>!scope.results?.length)
      if(anyScopeUnavailable){uncertainty=true;advisories.push({code:'SPARK_SCOPE_UNVERIFIED',severity:'warning',message:`Could not prove that ${stop} belongs to the confirmed destination area.`});continue}
      return contradiction(`${stop} does not match the confirmed geographic scope ${scopeEvidence.map(x=>x.label).join(' / ')}.`,advisories)
    }
    for(const scope of matched)if(scope.requiredCoverage)matchedRequired.add(placeMatchKey(scope.label))
  }

  const missing=scopeEvidence.filter(scope=>scope.requiredCoverage&&!matchedRequired.has(placeMatchKey(scope.label)))
  if(missing.length){
    if(uncertainty||missing.some(scope=>!scope.results?.length)){
      advisories.push({code:'SPARK_SCOPE_COVERAGE_UNVERIFIED',severity:'warning',message:`Could not prove coverage of every confirmed destination area: ${missing.map(x=>x.label).join(', ')}.`})
      return unverified(advisories)
    }
    return contradiction(`The route does not yet cover every confirmed destination area: ${missing.map(x=>x.label).join(', ')}.`,advisories)
  }
  return uncertainty?unverified(advisories):verified(advisories)
}
