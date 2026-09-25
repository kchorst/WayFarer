import { routeOccurrences, deriveLegs } from './authority.js'

const finiteCoord=r=>typeof r?.lat==='number'&&typeof r?.lon==='number'&&Number.isFinite(r.lat)&&Number.isFinite(r.lon)&&r.lat>=-90&&r.lat<=90&&r.lon>=-180&&r.lon<=180
const norm=x=>String(x??'').trim().toLowerCase()
function resolutionForOccurrence(candidate,o){return candidate&&finiteCoord(candidate)&&candidate.occurrenceId===o.id&&norm(candidate.queryLabel)===norm(o.place.label)?candidate:null}
function coordText(o){return o?.resolution?`${o.resolution.lat.toFixed(6)},${o.resolution.lon.toFixed(6)}`:o?.label||''}
export function buildMapModel(authority,resolutions={}){
  const occurrences=routeOccurrences(authority).map((o,index)=>{const candidate=resolutionForOccurrence(resolutions[o.id],o);return{occurrenceId:o.id,index,role:o.role,label:o.place.label,disposition:o.disposition,resolution:candidate?{lat:candidate.lat,lon:candidate.lon,label:candidate.label||o.place.label,countryCode:candidate.countryCode||'',source:candidate.source||'',confidence:Number(candidate.confidence||0),travelerSelected:Boolean(candidate.travelerSelected),queryLabel:candidate.queryLabel}:null}})
  const derived=deriveLegs(authority),legs=derived.map(leg=>{const from=occurrences.find(o=>o.occurrenceId===leg.fromOccurrenceId),to=occurrences.find(o=>o.occurrenceId===leg.toOccurrenceId);return{...leg,fromLabel:from?.label||'',toLabel:to?.label||'',coordinatesReady:Boolean(from?.resolution&&to?.resolution)}})
  const unresolvedOccurrenceIds=occurrences.filter(o=>!o.resolution).map(o=>o.occurrenceId),resolvedCount=occurrences.length-unresolvedOccurrenceIds.length,allCoordinatesResolved=occurrences.length>=2&&unresolvedOccurrenceIds.length===0
  const resolvedSegments=[];let current=[];for(const o of occurrences){if(o.resolution)current.push(o);else{if(current.length)resolvedSegments.push(current);current=[]}}if(current.length)resolvedSegments.push(current)
  const transport={primaryMode:authority?.transport?.primaryMode||'Any',confirmed:Boolean(authority?.transport?.confirmed),scoped:(authority?.transport?.scoped||[]).map(x=>({...x})),legModes:{...(authority?.transport?.legModes||{})},reconfirmationRequiredLegIds:[...(authority?.transport?.reconfirmationRequiredLegIds||[])],pendingLegReviews:[...(authority?.transport?.pendingLegReviews||[])]}
  const snapshotKey=JSON.stringify({tripId:authority?.id||'',version:authority?.version||0,occurrences:occurrences.map(o=>[o.occurrenceId,o.label,o.resolution?.lat??null,o.resolution?.lon??null]),transport:{primaryMode:transport.primaryMode,confirmed:transport.confirmed,scoped:transport.scoped,legModes:transport.legModes,reconfirmationRequiredLegIds:transport.reconfirmationRequiredLegIds}})
  return{tripId:authority?.id||'',authorityVersion:authority?.version||0,occurrences,legs,resolvedSegments,resolvedCount,unresolvedOccurrenceIds,allCoordinatesResolved,transport,snapshotKey,evidence:{routeOccurrenceCount:occurrences.length,legCount:legs.length,coordinateCount:resolvedCount}}
}
function providerRoadMode(model){
  const mode=model?.transport?.primaryMode||'Any'
  if(!model?.transport?.confirmed||!['Car','Walk','Bike'].includes(mode))return null
  if((model.transport?.scoped||[]).length||(model.transport?.pendingLegReviews||[]).length||(model.transport?.reconfirmationRequiredLegIds||[]).length)return null
  if((model.legs||[]).some(leg=>!leg.modeConfirmed||leg.mode!==mode))return null
  return mode
}
function googleSegmentUrl(segment,mode){
  if(segment.length<2||!mode)return''
  const params=new URLSearchParams({api:'1',origin:coordText(segment[0]),destination:coordText(segment.at(-1))})
  if(segment.length>2)params.set('waypoints',segment.slice(1,-1).map(coordText).join('|'))
  params.set('travelmode',({Car:'driving',Walk:'walking',Bike:'bicycling'})[mode])
  return`https://www.google.com/maps/dir/?${params.toString()}`
}
export function googleMapsUrls(model,{maxWaypoints=3,maxUrlLength=1900}={}){
  const route=model?.occurrences||[],mode=providerRoadMode(model);if(!mode||route.length<2||route.some(o=>!o.resolution))return[]
  const maxOccurrences=Math.max(2,Number(maxWaypoints)+2),segments=[];let start=0
  while(start<route.length-1){let end=Math.min(route.length,start+maxOccurrences),segment=route.slice(start,end),url=googleSegmentUrl(segment,mode)
    while(url.length>maxUrlLength&&segment.length>2){segment=segment.slice(0,-1);end--;url=googleSegmentUrl(segment,mode)}
    if(!url||url.length>maxUrlLength)return[]
    segments.push({index:segments.length+1,fromOccurrenceId:segment[0].occurrenceId,toOccurrenceId:segment.at(-1).occurrenceId,occurrenceIds:segment.map(o=>o.occurrenceId),mode,url})
    start=end-1
  }
  return segments
}
export function googleMapsUrl(model){const segments=googleMapsUrls(model);return segments.length===1?segments[0].url:''}
export function mapQuestShareEligibility(model,{maxLocations=50,maxUrlLength=1900}={}){
  const eligibility=mapQuestEligibility(model,{maxLocations});if(!eligibility.ok)return eligibility
  if(eligibility.mode!=='Car')return{ok:false,reason:`MapQuest share handoff is withheld for ${eligibility.mode} because the public link cannot be verified to preserve that confirmed mode.`}
  const route=model?.occurrences||[],params=new URLSearchParams();route.forEach((o,i)=>params.set(`q${i+1}`,coordText(o)))
  const url=`https://www.mapquest.com/directions?${params.toString()}`
  if(url.length>maxUrlLength)return{ok:false,reason:'MapQuest share handoff is withheld because the canonical route exceeds the safe share-URL size.'}
  return{ok:true,mode:eligibility.mode,url}
}
export function mapQuestShareUrl(model,options={}){const result=mapQuestShareEligibility(model,options);return result.ok?result.url:''}

export function mapQuestEligibility(model,{maxLocations=50}={}){
  if(!model?.allCoordinatesResolved||model.occurrences.length<2)return{ok:false,reason:'Every canonical occurrence must be resolved.'}
  if(model.occurrences.length>maxLocations)return{ok:false,reason:`MapQuest routing is withheld because the canonical route has ${model.occurrences.length} locations; the provider limit is ${maxLocations}.`}
  const mode=model.transport?.primaryMode||'Any';if(!model.transport?.confirmed)return{ok:false,reason:'Transport is not traveler-confirmed.'};if(!['Car','Walk','Bike'].includes(mode))return{ok:false,reason:`Confirmed ${mode} is not a MapQuest road-routing mode.`}
  if((model.transport?.scoped||[]).length)return{ok:false,reason:'Scoped transport rules exist; whole-trip road routing would collapse them.'}
  if((model.transport?.pendingLegReviews||[]).length||(model.transport?.reconfirmationRequiredLegIds||[]).length)return{ok:false,reason:'Edited leg transport needs traveler reconfirmation.'}
  const incompatible=model.legs.find(l=>!l.modeConfirmed||l.mode!==mode);if(incompatible)return{ok:false,reason:`Leg ${incompatible.index+1} is not confirmed as ${mode}.`}
  return{ok:true,mode}
}
export function providerRouteMatchesModel(response,model){
  if(!response||!model)return false
  const expected=(model.occurrences||[]).map(o=>o.occurrenceId)
  return response.tripId===model.tripId&&Number(response.authorityVersion)===Number(model.authorityVersion)&&response.snapshotKey===model.snapshotKey&&JSON.stringify(response.occurrenceIds||[])===JSON.stringify(expected)
}
export function mapQuestApiPayload(model){const eligibility=mapQuestEligibility(model);if(!eligibility.ok)return null;const routeType=({Walk:'pedestrian',Bike:'bicycle'})[eligibility.mode]||'fastest';return{authorityId:model.tripId,authorityVersion:model.authorityVersion,snapshotKey:model.snapshotKey,occurrenceIds:model.occurrences.map(o=>o.occurrenceId),transport:model.transport,locations:model.occurrences.map(o=>({latLng:{lat:o.resolution.lat,lng:o.resolution.lon}})),options:{routeType,unit:'k',shapeFormat:'raw',generalize:0,enhancedNarrative:false,doReverseGeocode:false,locale:'en_US'}}}
export function modelInvariantFindings(model){
  const f=[];if(!model)return[{code:'NO_MAP_MODEL',severity:'blocker',message:'No map model exists.'}]
  if(model.legs.length!==Math.max(0,model.occurrences.length-1))f.push({code:'LEG_COUNT_MISMATCH',severity:'blocker',message:'Map leg count does not match canonical route occurrence count.'})
  for(let i=0;i<model.legs.length;i++)if(model.legs[i].fromOccurrenceId!==model.occurrences[i].occurrenceId||model.legs[i].toOccurrenceId!==model.occurrences[i+1].occurrenceId)f.push({code:'LEG_ORDER_DRIFT',severity:'blocker',message:`Leg ${i+1} does not follow canonical occurrence order.`})
  for(const o of model.occurrences)if(o.resolution&&(!finiteCoord(o.resolution)||norm(o.resolution.queryLabel)!==norm(o.label)))f.push({code:'RESOLUTION_IDENTITY_DRIFT',severity:'blocker',occurrenceId:o.occurrenceId,message:`Resolution for ${o.label} is not bound to the current occurrence identity.`})
  return f
}
export function unwrapLongitudeSequence(points=[]){if(!points.length)return[];const out=[];let prev=null;for(const point of points){const raw=Number(point?.lon);if(!Number.isFinite(raw)){out.push({...point});continue}let lon=raw;if(prev!==null){while(lon-prev>180)lon-=360;while(lon-prev<-180)lon+=360}out.push({...point,displayLon:lon});prev=lon}return out}
export function shiftLongitudeNear(lon,anchor){let x=Number(lon),a=Number(anchor);if(!Number.isFinite(x)||!Number.isFinite(a))return x;while(x-a>180)x-=360;while(x-a<-180)x+=360;return x}
