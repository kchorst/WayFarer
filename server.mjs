import http from 'node:http'
import { readFile, stat, readdir } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRuntimeSettings, saveRuntimeSettings, publicRuntimeSettings } from './runtime-settings.mjs'
import { rawPbfStatus, startRawPbfRender, getRawPbfJob, cancelRawPbfJob, clearRawPbfCaches, shutdownRawPbfRuntime } from './server_maps/raw-pbf-runtime.mjs'
import { acquireInstance, markInstanceReady, releaseInstance, shutdownTokenMatches } from './server-lifecycle.mjs'

const execFileAsync=promisify(execFile)
const ROOT=fileURLToPath(new URL('.',import.meta.url))
const PUBLIC=join(ROOT,'public')
const RELEASE=JSON.parse(await readFile(join(ROOT,'RELEASE.json'),'utf8'))
const PORT=Number(process.env.WAYFINDER_PORT||4198)
const MAPQUEST_ROUTE_ENDPOINT=String(process.env.WAYFINDER_MAPQUEST_ROUTE_ENDPOINT||'https://www.mapquestapi.com/directions/v2/route').trim()
const MAPQUEST_GEOCODE_ENDPOINT=String(process.env.WAYFINDER_MAPQUEST_GEOCODE_ENDPOINT||'https://www.mapquestapi.com/geocoding/v1/address').trim()
const MAX_BODY=2_000_000
const INTERACTIVE_AI_TIMEOUT_MS=110_000
const RUNTIME_ABORT=new AbortController()
function runtimeSignal(timeout){const timeoutSignal=AbortSignal.timeout(timeout);return typeof AbortSignal.any==='function'?AbortSignal.any([timeoutSignal,RUNTIME_ABORT.signal]):timeoutSignal}
function requestRuntimeSignal(req,res,timeout){
  const clientController=new AbortController(),timeoutSignal=AbortSignal.timeout(timeout)
  const abortClient=reason=>{if(!clientController.signal.aborted)clientController.abort(reason||new DOMException('Client disconnected.','AbortError'))}
  const onAborted=()=>abortClient(new DOMException('Client request aborted.','AbortError'))
  const onResponseClose=()=>{if(!res.writableEnded)abortClient(new DOMException('Client connection closed.','AbortError'))}
  req.once('aborted',onAborted);res.once('close',onResponseClose)
  const signal=typeof AbortSignal.any==='function'?AbortSignal.any([timeoutSignal,RUNTIME_ABORT.signal,clientController.signal]):timeoutSignal
  return{signal,clientSignal:clientController.signal,dispose(){req.off('aborted',onAborted);res.off('close',onResponseClose)}}
}
let SETTINGS=loadRuntimeSettings()
let AI_ENDPOINT_OVERRIDE='',AI_ROOT='',AI_MODEL='',ACTIVE_AI_ROOT='',AI_CANDIDATE_ROOTS=[],GAZETTEER='',REFERENCE_ROOT='',ALLOW_WEB_GEOCODE=true,MAPQUEST_KEY='',PBF_ROOT=''
let DETECTED_AI_MODEL=''
let AI_RUNTIME_CACHE=null
function applyRuntimeSettings(settings=SETTINGS){
  SETTINGS=settings
  AI_ENDPOINT_OVERRIDE=String(settings.aiEndpoint||'').trim()
  AI_ROOT=String(AI_ENDPOINT_OVERRIDE||'http://127.0.0.1:8080').replace(/\/$/,'')
  AI_MODEL=String(settings.aiModel||'').trim()
  ACTIVE_AI_ROOT=AI_ROOT
  AI_CANDIDATE_ROOTS=[...new Set([AI_ROOT,...(!AI_ENDPOINT_OVERRIDE?['http://127.0.0.1:1234','http://127.0.0.1:11434']:[])])].map(x=>x.replace(/\/$/,''))
  GAZETTEER=String(settings.gazetteerEndpoint||'').replace(/\/$/,'')
  REFERENCE_ROOT=String(settings.referenceEndpoint||'http://127.0.0.1:8091').replace(/\/$/,'')
  ALLOW_WEB_GEOCODE=settings.allowWebGeocode!==false
  MAPQUEST_KEY=String(settings.mapQuestKey||'').trim()
  PBF_ROOT=String(settings.pbfRoot||'').trim()
  DETECTED_AI_MODEL=''
  AI_RUNTIME_CACHE=null
}
applyRuntimeSettings(SETTINGS)
const referenceCache=new Map(),geocodeCache=new Map()
function cacheGet(cache,key,ttlMs){const hit=cache.get(key);if(!hit)return null;if(Date.now()-hit.at>ttlMs){cache.delete(key);return null}return hit.value}
function cacheSet(cache,key,value,max=256){cache.set(key,{at:Date.now(),value});while(cache.size>max)cache.delete(cache.keys().next().value);return value}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.pbf':'application/x-protobuf'}
function headers(extra={}){return {'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store',...extra}}
function json(res,status,body){res.writeHead(status,headers({'Content-Type':'application/json; charset=utf-8'}));res.end(JSON.stringify(body))}
async function readJson(req){let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>MAX_BODY)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(c)}if(!chunks.length)return{};try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Object.assign(new Error('Invalid JSON'),{status:400})}}
function chatUrlFor(root){return root.endsWith('/v1/chat/completions')?root:root.endsWith('/v1')?`${root}/chat/completions`:`${root}/v1/chat/completions`}
function aiChatUrl(){return chatUrlFor(ACTIVE_AI_ROOT||AI_ROOT)}
function aiServerRoot(root){return String(root||'').replace(/\/v1\/chat\/completions$/,'').replace(/\/v1$/,'')}
async function fetchJson(url,options={},timeout=12000){const signal=runtimeSignal(timeout);const r=await fetch(url,{...options,signal});const text=await r.text();let data=null;try{data=JSON.parse(text)}catch{};if(!r.ok)throw new Error(data?.error?.message||data?.message||`${r.status} ${r.statusText}`);return data}

async function fetchText(url,options={},timeout=12000){const signal=runtimeSignal(timeout);const r=await fetch(url,{...options,signal});const text=await r.text();if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);return text}
function decodeEntities(value=''){return String(value).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)))}
function stripTags(value=''){return decodeEntities(String(value).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim()}

function validLatLon(lat,lon){return Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=-90&&lat<=90&&lon>=-180&&lon<=180}
function dmsPartsToDecimal(parts=[],negative=false){const nums=parts.map(Number).filter(Number.isFinite);if(!nums.length)return NaN;const value=Math.abs(nums[0])+(nums[1]||0)/60+(nums[2]||0)/3600;return negative?-value:value}
function geoHackCoordinates(value=''){let decoded=String(value||'');try{decoded=decodeURIComponent(decoded)}catch{};const params=decoded.match(/(?:[?&]|\b)params=([^&#"'\s]+)/i)?.[1]||decoded,tokens=params.split('_').filter(Boolean),ns=tokens.findIndex(token=>/^[NS]$/i.test(token));if(ns<1)return null;const ewRelative=tokens.slice(ns+1).findIndex(token=>/^[EW]$/i.test(token));if(ewRelative<1)return null;const ew=ns+1+ewRelative,lat=dmsPartsToDecimal(tokens.slice(0,ns),/^S$/i.test(tokens[ns])),lon=dmsPartsToDecimal(tokens.slice(ns+1,ew),/^W$/i.test(tokens[ew]));return validLatLon(lat,lon)?{lat,lon}:null}
function parseReferenceCoordinates(html=''){
  const source=String(html||''),decimalPair=value=>{const m=String(value||'').match(/(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)/);if(!m)return null;const lat=Number(m[1]),lon=Number(m[2]);return validLatLon(lat,lon)?{lat,lon}:null}
  for(const m of source.matchAll(/<meta\b[^>]*(?:name|property)=["']geo\.position["'][^>]*content=["']([^"']+)["'][^>]*>/gi)){const p=decimalPair(m[1]);if(p)return p}
  for(const m of source.matchAll(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']geo\.position["'][^>]*>/gi)){const p=decimalPair(m[1]);if(p)return p}
  for(const m of source.matchAll(/<[^>]+\bdata-lat=["'](-?\d+(?:\.\d+)?)["'][^>]+\bdata-lon=["'](-?\d+(?:\.\d+)?)["'][^>]*>/gi)){const lat=Number(m[1]),lon=Number(m[2]);if(validLatLon(lat,lon))return{lat,lon}}
  for(const m of source.matchAll(/<[^>]+\bdata-lon=["'](-?\d+(?:\.\d+)?)["'][^>]+\bdata-lat=["'](-?\d+(?:\.\d+)?)["'][^>]*>/gi)){const lon=Number(m[1]),lat=Number(m[2]);if(validLatLon(lat,lon))return{lat,lon}}
  for(const m of source.matchAll(/<[^>]+class=["'][^"']*\bgeo(?:-dec)?\b[^"']*["'][^>]*>([\s\S]{0,180}?)<\/[^>]+>/gi)){const p=decimalPair(stripTags(m[1]));if(p)return p}
  for(const m of source.matchAll(/(?:href|src)=["']([^"']*(?:geohack|params=)[^"']*)["']/gi)){const p=geoHackCoordinates(m[1]);if(p)return p}
  return null
}
function element(block,tag){const m=String(block).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'));return m?stripTags(m[1]):''}
function referenceHref(block){return (String(block).match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)||[])[1]||(String(block).match(/<link(?:\s[^>]*)?>([^<]+)<\/link>/i)||[])[1]||(String(block).match(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)||[])[1]||''}
function sameReferenceOrigin(url){try{return new URL(url).origin===new URL(REFERENCE_ROOT).origin}catch{return false}}
function parseReferenceSearch(xml,category,limit=2){const blocks=[...String(xml||'').matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)].map(m=>m[0]);const out=[];for(const block of blocks){const title=element(block,'title'),href=referenceHref(block),snippet=element(block,'description')||element(block,'summary')||element(block,'content');if(!title||!href)continue;let url='';try{url=new URL(decodeEntities(href),`${REFERENCE_ROOT}/`).toString()}catch{};if(!url||!sameReferenceOrigin(url))continue;out.push({title,url,snippet,source:category==='wikivoyage'?'Wikivoyage':'Wikipedia'});if(out.length>=limit)break}return out}
async function referenceStatus(){try{const text=await fetchText(`${REFERENCE_ROOT}/catalog/v2/entries?count=-1`,{headers:{Accept:'application/atom+xml,application/xml,text/xml,*/*'}},1800);return{available:true,endpoint:REFERENCE_ROOT,wikivoyage:/wikivoyage/i.test(text),wikipedia:/wikipedia/i.test(text)}}catch(e){return{available:false,endpoint:REFERENCE_ROOT,wikivoyage:false,wikipedia:false,message:e.message}}}
async function searchReferences(q,category='wikivoyage',limit=2){const safeCategory=category==='wikipedia'?'wikipedia':'wikivoyage',cacheKey=`${REFERENCE_ROOT}|${safeCategory}|${limit}|${String(q).trim().toLowerCase()}`,cached=cacheGet(referenceCache,cacheKey,15*60_000);if(cached)return cached;const u=new URL(`${REFERENCE_ROOT}/search`);u.searchParams.set('pattern',q);u.searchParams.set('books.filter.lang','eng');u.searchParams.set('books.filter.category',safeCategory);u.searchParams.set('format','xml');u.searchParams.set('pageLength',String(Math.max(1,Math.min(4,limit))));let xml='';try{xml=await fetchText(u,{headers:{Accept:'application/xml,text/xml,text/html,*/*'}},5000)}catch{return[]}const hits=parseReferenceSearch(xml,safeCategory,limit),enriched=await Promise.all(hits.map(async hit=>{let excerpt=hit.snippet||'',coordinates=null;try{const html=await fetchText(hit.url,{headers:{Accept:'text/html,application/xhtml+xml,*/*'}},5000);coordinates=parseReferenceCoordinates(html);excerpt=stripTags(html).slice(0,1800)||excerpt}catch{}return{title:hit.title,url:hit.url,source:hit.source,excerpt:String(excerpt||'').slice(0,1800),...(coordinates||{})}}));return cacheSet(referenceCache,cacheKey,enriched)}

async function probeAiRoot(candidate){
  const root=aiServerRoot(candidate),started=Date.now();let reachable=false,model='',source='',lastError=''
  try{const d=await fetchJson(`${root}/v1/models`,{},1400);reachable=true;model=String(d?.data?.find?.(x=>String(x?.id||'').trim())?.id||d?.data?.[0]?.id||'').trim();source='models'}catch(e){lastError=e.message}
  if(!reachable){for(const path of ['/health','/']){try{const r=await fetch(`${root}${path}`,{signal:AbortSignal.timeout(900)});if(r.status<500){reachable=true;source=path==='/'?'root':'health';break}}catch(e){lastError=lastError||e.message}}}
  const configured=AI_MODEL||model||(root===aiServerRoot(ACTIVE_AI_ROOT)?DETECTED_AI_MODEL:'')
  return{root,reachable,available:Boolean(reachable&&configured),model:configured||'',source,latencyMs:Date.now()-started,message:reachable&&!configured?'Local model server is reachable, but no model name was reported.':(!reachable?(lastError||'Local model server did not respond.'):'')}
}
async function resolveAiRuntime({force=false}={}){
  if(!force&&AI_RUNTIME_CACHE&&Date.now()-AI_RUNTIME_CACHE.checkedAt<2500)return AI_RUNTIME_CACHE
  const probeSet=async()=>{const probes=await Promise.all(AI_CANDIDATE_ROOTS.map(probeAiRoot));return probes.find(p=>p.available)||probes.find(p=>p.reachable)||probes[0]||null}
  let best=await probeSet()
  // WAYFINDER and a local model are often launched together. A single very short
  // re-probe closes that startup race without turning status detection into a long retry loop.
  if(!best?.reachable){await new Promise(r=>setTimeout(r,200));best=await probeSet()}
  best=best||{root:AI_ROOT,reachable:false,available:false,model:'',source:'',latencyMs:0,message:'Local model server did not respond.'}
  if(best.reachable){ACTIVE_AI_ROOT=best.root;if(best.model)DETECTED_AI_MODEL=best.model}
  AI_RUNTIME_CACHE={...best,checkedAt:Date.now()};return AI_RUNTIME_CACHE
}
async function detectAiModel(){
  const runtime=await resolveAiRuntime({force:true})
  if(runtime.model)return runtime.model
  if(runtime.reachable)return 'local-model'
  throw new Error(runtime.message||'Local model unavailable.')
}
async function aiStatus(){
  const runtime=await resolveAiRuntime({force:true})
  return{available:runtime.available,reachable:runtime.reachable,model:runtime.model||'',endpoint:runtime.root,source:runtime.source,latencyMs:runtime.latencyMs,message:runtime.message||'',checkedAt:new Date().toISOString()}
}

async function geocodeLocal(q){
  if(!GAZETTEER)return[]
  try{
    const u=new URL(GAZETTEER);u.searchParams.set('q',q)
    const d=await fetchJson(u,{},3500);const source=Array.isArray(d)?d:(d.results||d.places||[])
    return source.map(x=>({label:x.label||x.display_name||x.name||q,lat:Number(x.lat??x.latitude),lon:Number(x.lon??x.lng??x.longitude),countryCode:x.countryCode||x.country_code||'',source:'local-gazetteer',confidence:Number(x.confidence??x.score??1)})).filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lon))
  }catch{return[]}
}
function refDistanceKm(a,b){const R=6371,toRad=x=>x*Math.PI/180,dLat=toRad(b.lat-a.lat),dLon=toRad(b.lon-a.lon),v=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(v)))}
async function geocodeReference(q){
  try{
    const [voyage,wiki]=await Promise.all([searchReferences(q,'wikivoyage',3),searchReferences(q,'wikipedia',3)]),all=[...voyage,...wiki].filter(x=>validLatLon(Number(x.lat),Number(x.lon))).map(x=>({label:x.title||q,lat:Number(x.lat),lon:Number(x.lon),countryCode:'',source:x.source==='Wikivoyage'?'local-wikivoyage':'local-wikipedia',confidence:.72,url:x.url}))
    const used=new Set(),out=[]
    for(let i=0;i<all.length;i++){if(used.has(i))continue;const group=[all[i]];used.add(i);for(let j=i+1;j<all.length;j++)if(!used.has(j)&&refDistanceKm(all[i],all[j])<=5){group.push(all[j]);used.add(j)}const sources=new Set(group.map(x=>x.source)),best=group[0];out.push({...best,confidence:sources.size>=2?.86:.72,source:sources.size>=2?'local-reference-corroborated':best.source})}
    return out.slice(0,5)
  }catch{return[]}
}
async function geocodeMapQuest(q){
  if(!MAPQUEST_KEY)return[]
  try{const u=new URL(MAPQUEST_GEOCODE_ENDPOINT);u.searchParams.set('key',MAPQUEST_KEY);u.searchParams.set('location',q);u.searchParams.set('maxResults','5');u.searchParams.set('thumbMaps','false');const d=await fetchJson(u,{},7000);const loc=d?.results?.[0]?.locations||[];return loc.map(x=>({label:[x.adminArea5,x.adminArea3,x.adminArea1].filter(Boolean).join(', ')||q,lat:Number(x.latLng?.lat),lon:Number(x.latLng?.lng),countryCode:x.adminArea1||'',source:'mapquest-geocode',confidence:0.8})).filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lon))}catch{return[]}
}
async function geocodeNominatim(q){
  if(!ALLOW_WEB_GEOCODE)return[]
  try{const u=new URL('https://nominatim.openstreetmap.org/search');u.searchParams.set('format','jsonv2');u.searchParams.set('limit','5');u.searchParams.set('addressdetails','1');u.searchParams.set('q',q);const d=await fetchJson(u,{headers:{'User-Agent':'WAYFINDER-rebuild/1.0 local travel planner'}},9000);return (d||[]).map(x=>({label:x.display_name,lat:Number(x.lat),lon:Number(x.lon),countryCode:String(x.address?.country_code||'').toUpperCase(),source:'nominatim',confidence:Number(x.importance||0.5)})).filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lon))}catch{return[]}
}
async function geocode(q){
  const key=`${GAZETTEER}|${Boolean(MAPQUEST_KEY)}|${ALLOW_WEB_GEOCODE}|${String(q).trim().toLowerCase()}`,cached=cacheGet(geocodeCache,key,30*60_000);if(cached)return cached
  const local=await geocodeLocal(q);if(local.length)return cacheSet(geocodeCache,key,{results:local,source:'local-gazetteer'})
  const references=await geocodeReference(q);if(references.length)return cacheSet(geocodeCache,key,{results:references,source:'local-references'})
  const mq=await geocodeMapQuest(q);if(mq.length)return cacheSet(geocodeCache,key,{results:mq,source:'mapquest-geocode'})
  const web=await geocodeNominatim(q);return cacheSet(geocodeCache,key,{results:web,source:web.length?'nominatim':'unresolved'})
}

function supportedMapQuestMode(mode){return ['Car','Walk','Bike'].includes(mode)}
function finitePoint(p){return typeof p?.lat==='number'&&typeof p?.lon==='number'&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&p.lat>=-90&&p.lat<=90&&p.lon>=-180&&p.lon<=180}
function haversineKm(a,b){const R=6371,toRad=x=>x*Math.PI/180,dLat=toRad(b.lat-a.lat),dLon=toRad(b.lon-a.lon),q=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(q)))}
function validateProviderGeometry(geometry,occurrences){
  if(!Array.isArray(geometry)||geometry.length<2||!geometry.every(finitePoint))throw Object.assign(new Error('MapQuest returned unusable route geometry.'),{status:502})
  let cursor=0
  for(const occurrence of occurrences){const target={lat:occurrence.resolution.lat,lon:occurrence.resolution.lon};let best=-1,bestDistance=Infinity;for(let i=cursor;i<geometry.length;i++){const d=haversineKm(target,geometry[i]);if(d<bestDistance){bestDistance=d;best=i}if(d<=1)break}if(best<0||bestDistance>50)throw Object.assign(new Error(`MapQuest geometry does not pass near canonical occurrence ${occurrence.occurrenceId} in route order.`),{status:502});cursor=best}
}
async function mapQuestRoute(input){
  if(!MAPQUEST_KEY)throw Object.assign(new Error('MapQuest key is not configured.'),{status:409})
  const mode=String(input?.transport?.primaryMode||'Any'),confirmed=Boolean(input?.transport?.confirmed)
  if(!confirmed)throw Object.assign(new Error('Transport is not traveler-confirmed.'),{status:422})
  if(!supportedMapQuestMode(mode))throw Object.assign(new Error(`MapQuest road routing is not used for confirmed ${mode} travel.`),{status:422})
  if((input?.transport?.scoped||[]).length)throw Object.assign(new Error('Scoped transport rules exist; whole-trip road routing would collapse them.'),{status:422})
  if((input?.transport?.pendingLegReviews||[]).length||(input?.transport?.reconfirmationRequiredLegIds||[]).length)throw Object.assign(new Error('Leg transport requires traveler reconfirmation before provider routing.'),{status:422})
  const occurrences=Array.isArray(input?.occurrences)?input.occurrences:[],legs=Array.isArray(input?.legs)?input.legs:[]
  if(occurrences.length<2)throw Object.assign(new Error('At least two resolved occurrences are required.'),{status:400})
  if(legs.length!==occurrences.length-1)throw Object.assign(new Error('Canonical leg count does not match occurrence count.'),{status:409})
  if(legs.some(l=>!l.modeConfirmed||l.mode!==mode))throw Object.assign(new Error('Per-leg transport does not match the confirmed whole-trip road mode.'),{status:422})
  if(!occurrences.every(o=>finitePoint(o?.resolution)))throw Object.assign(new Error('Every canonical occurrence must have valid resolved coordinates before MapQuest routing.'),{status:409})
  if(occurrences.length>50)throw Object.assign(new Error('MapQuest supports at most 50 route locations in this request.'),{status:422})
  const routeType=mode==='Walk'?'pedestrian':mode==='Bike'?'bicycle':'fastest',body={locations:occurrences.map(o=>({latLng:{lat:o.resolution.lat,lng:o.resolution.lon}})),options:{routeType,unit:'k',shapeFormat:'raw',generalize:0,enhancedNarrative:false,doReverseGeocode:false,locale:'en_US'}}
  const u=new URL(MAPQUEST_ROUTE_ENDPOINT);u.searchParams.set('key',MAPQUEST_KEY);u.searchParams.set('outFormat','json');u.searchParams.set('ambiguities','ignore')
  const d=await fetchJson(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},15000)
  if(Number(d?.info?.statuscode||0)!==0)throw Object.assign(new Error((d?.info?.messages||[]).join('; ')||'MapQuest route failed.'),{status:502})
  const shape=d?.route?.shape?.shapePoints||[],geometry=[];if(!Array.isArray(shape)||shape.length<4||shape.length%2!==0)throw Object.assign(new Error('MapQuest returned missing or malformed shapePoints.'),{status:502});for(let i=0;i<shape.length;i+=2)geometry.push({lat:Number(shape[i]),lon:Number(shape[i+1])})
  validateProviderGeometry(geometry,occurrences)
  return{provider:'mapquest',tripId:String(input.tripId||''),authorityVersion:Number(input.authorityVersion||0),snapshotKey:String(input.snapshotKey||''),occurrenceIds:occurrences.map(o=>o.occurrenceId),geometry,distanceKm:Number(d?.route?.distance||0),timeSeconds:Number(d?.route?.time||0),routeType}
}

function quickPbfStatus(){
  if(!PBF_ROOT)return{configured:false,available:false,renderReady:false,root:'',kind:'raw-osm-pbf-library',message:'Choose your existing .osm.pbf map library folder in Settings.'}
  const root=resolve(PBF_ROOT);if(!existsSync(root))return{configured:true,available:false,renderReady:false,root,kind:'raw-osm-pbf-library',message:'Configured offline map library folder does not exist.'}
  return{configured:true,available:true,renderReady:false,root,kind:'raw-osm-pbf-library',catalogPending:true,message:'Offline map library configured. Catalog loads separately so model status stays responsive.'}
}
async function pbfStatus(points=[]){
  if(!PBF_ROOT)return rawPbfStatus('',{points})
  const raw=await rawPbfStatus(PBF_ROOT,{points}).catch(e=>({configured:true,available:false,renderReady:false,root:PBF_ROOT,kind:'raw-osm-pbf-library',message:e.message}))
  if(raw.available)return raw
  const root=resolve(PBF_ROOT);if(!existsSync(root))return raw
  try{const entries=await readdir(root,{withFileTypes:true});const zooms=entries.filter(e=>e.isDirectory()&&/^\d+$/.test(e.name)).map(e=>Number(e.name)).sort((a,b)=>a-b);if(zooms.length)return{configured:true,available:true,renderReady:true,root,kind:'xyz-vector-tiles',zooms,message:'Legacy offline vector PBF tiles available.'};return raw}catch{return raw}
}
function safeTilePath(z,x,y){
  if(!PBF_ROOT||![z,x,y].every(v=>/^\d+$/.test(String(v))))return null
  const base=resolve(PBF_ROOT),target=resolve(base,String(z),String(x),`${y}.pbf`)
  if(target!==base&&!target.startsWith(base+sep))return null
  return target
}


async function pickWindowsFolder(initial=''){
  if(process.platform!=='win32')throw Object.assign(new Error('Folder browsing is available in the Windows WAYFINDER runtime. Enter a folder path manually in this environment.'),{status:409})
  const initialSafe=String(initial||'').replace(/'/g,"''")
  const script=`Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Choose your WAYFINDER offline .osm.pbf map library'; $d.ShowNewFolderButton=$false; if('${initialSafe}' -and (Test-Path -LiteralPath '${initialSafe}')){$d.SelectedPath='${initialSafe}'}; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}`
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-STA','-Command',script],{windowsHide:true,timeout:120000,maxBuffer:64*1024,signal:RUNTIME_ABORT.signal})
  return String(stdout||'').trim()
}

let INSTANCE=null
let SHUTTING_DOWN=false
let SHUTDOWN_PROMISE=null
const SOCKETS=new Set()
const CLIENTS=new Map()
const MANAGED_LAUNCH=process.env.WAYFINDER_MANAGED_LAUNCH==='1'
const CLIENT_STALE_MS=Math.max(120000,Number(process.env.WAYFINDER_CLIENT_STALE_MS||600000))
const CLIENT_CLOSE_GRACE_MS=Math.max(750,Number(process.env.WAYFINDER_CLIENT_CLOSE_GRACE_MS||2500))
let HAD_CLIENT=false
let CLIENT_SHUTDOWN_TIMER=null
let STARTUP_CLIENT_TIMER=null

function clientRequestAllowed(req){return String(req.headers['x-wayfinder-client']||'')==='1'}
function cancelClientShutdown(){if(CLIENT_SHUTDOWN_TIMER){clearTimeout(CLIENT_SHUTDOWN_TIMER);CLIENT_SHUTDOWN_TIMER=null}}
function scheduleClientShutdown(reason='last-window-closed',delay=CLIENT_CLOSE_GRACE_MS){
  if(SHUTTING_DOWN||!HAD_CLIENT||CLIENTS.size)return
  cancelClientShutdown()
  CLIENT_SHUTDOWN_TIMER=setTimeout(()=>{CLIENT_SHUTDOWN_TIMER=null;if(!CLIENTS.size&&!SHUTTING_DOWN)gracefulShutdown(reason,0).finally(()=>process.exit(0))},delay)
  CLIENT_SHUTDOWN_TIMER.unref?.()
}
function registerClient(){
  HAD_CLIENT=true;cancelClientShutdown();if(STARTUP_CLIENT_TIMER){clearTimeout(STARTUP_CLIENT_TIMER);STARTUP_CLIENT_TIMER=null}
  const id=crypto.randomUUID();CLIENTS.set(id,Date.now());return id
}
function touchClient(id){if(!CLIENTS.has(id))return false;CLIENTS.set(id,Date.now());cancelClientShutdown();return true}
function closeClient(id){if(id)CLIENTS.delete(id);if(!CLIENTS.size)scheduleClientShutdown();return true}
const CLIENT_SWEEPER=setInterval(()=>{const cutoff=Date.now()-CLIENT_STALE_MS;for(const [id,seen] of CLIENTS){if(seen<cutoff)CLIENTS.delete(id)}if(!CLIENTS.size&&HAD_CLIENT)scheduleClientShutdown('browser-session-timeout')},30000);CLIENT_SWEEPER.unref?.()

async function gracefulShutdown(reason='requested',exitCode=0){
  if(SHUTDOWN_PROMISE)return SHUTDOWN_PROMISE
  SHUTTING_DOWN=true
  SHUTDOWN_PROMISE=(async()=>{
    cancelClientShutdown();if(STARTUP_CLIENT_TIMER){clearTimeout(STARTUP_CLIENT_TIMER);STARTUP_CLIENT_TIMER=null};clearInterval(CLIENT_SWEEPER)
    try{RUNTIME_ABORT.abort(new Error(`WAYFINDER shutdown: ${reason}`))}catch{}
    try{await shutdownRawPbfRuntime()}catch(error){console.error('Offline runtime shutdown warning:',error?.message||error)}
    const closed=new Promise(resolve=>{try{server.close(()=>resolve(true))}catch{resolve(true)}})
    const force=setTimeout(()=>{try{server.closeAllConnections?.()}catch{};for(const socket of SOCKETS){try{socket.destroy()}catch{}}},1200);force.unref?.()
    await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,2500))])
    clearTimeout(force)
    try{server.closeIdleConnections?.();server.closeAllConnections?.()}catch{}
    for(const socket of SOCKETS){try{socket.destroy()}catch{}}
    if(INSTANCE)releaseInstance(INSTANCE)
    process.exitCode=exitCode
    return true
  })()
  return SHUTDOWN_PROMISE
}

async function handleApi(req,res,url){
  if(url.pathname==='/api/system/client/register'&&req.method==='POST'){
    if(!clientRequestAllowed(req))return json(res,403,{ok:false,error:'WAYFINDER client header required.'})
    const id=registerClient();return json(res,200,{ok:true,clientId:id,closeGraceMs:CLIENT_CLOSE_GRACE_MS})
  }
  if(url.pathname==='/api/system/client/heartbeat'&&req.method==='POST'){
    if(!clientRequestAllowed(req))return json(res,403,{ok:false,error:'WAYFINDER client header required.'})
    const input=await readJson(req);return touchClient(String(input?.clientId||''))?json(res,200,{ok:true}):json(res,409,{ok:false,error:'Client session expired.'})
  }
  if(url.pathname==='/api/system/client/close'&&req.method==='POST'){
    if(!clientRequestAllowed(req))return json(res,403,{ok:false,error:'WAYFINDER client header required.'})
    const input=await readJson(req);closeClient(String(input?.clientId||''));return json(res,202,{ok:true,message:'WAYFINDER will stop when the last app window closes.'})
  }
  if(url.pathname==='/api/system/client/exit'&&req.method==='POST'){
    if(!clientRequestAllowed(req))return json(res,403,{ok:false,error:'WAYFINDER client header required.'})
    const input=await readJson(req);if(input?.clientId)CLIENTS.delete(String(input.clientId));json(res,202,{ok:true,message:'WAYFINDER is closing.'});setTimeout(()=>gracefulShutdown('app-exit',0).finally(()=>process.exit(0)),25).unref?.();return
  }
  if(url.pathname==='/api/system/shutdown'&&req.method==='POST'){
    const token=String(req.headers['x-wayfinder-shutdown-token']||'');if(!shutdownTokenMatches(token,INSTANCE))return json(res,403,{ok:false,error:'Invalid shutdown token.'});json(res,202,{ok:true,message:'WAYFINDER is shutting down.'});setTimeout(()=>gracefulShutdown('recovery-control',0).finally(()=>process.exit(0)),25).unref?.();return
  }
  if(url.pathname==='/api/settings/pick-folder'&&req.method==='POST'){
    try{const input=await readJson(req),folder=await pickWindowsFolder(input?.initial||PBF_ROOT);if(!folder)return json(res,200,{ok:true,cancelled:true,folder:''});return json(res,200,{ok:true,cancelled:false,folder})}catch(e){return json(res,e.status||500,{ok:false,error:e.message})}
  }
  if(url.pathname==='/api/settings'&&req.method==='GET')return json(res,200,{ok:true,settings:publicRuntimeSettings(SETTINGS)})
  if(url.pathname==='/api/settings'&&req.method==='POST'){
    const input=await readJson(req);SETTINGS=saveRuntimeSettings(input,SETTINGS);applyRuntimeSettings(SETTINGS);referenceCache.clear();geocodeCache.clear();clearRawPbfCaches();const [ai,pbf,references]=await Promise.all([aiStatus(),pbfStatus(),referenceStatus()]);return json(res,200,{ok:true,settings:publicRuntimeSettings(SETTINGS),runtime:{ai,pbf,references,mapquest:{configured:Boolean(MAPQUEST_KEY)}}})
  }
  if(url.pathname==='/api/status'){
    const [ai,references]=await Promise.all([aiStatus(),referenceStatus()]);return json(res,200,{ok:true,release:RELEASE,ai,references,geocoding:{local:Boolean(GAZETTEER),localReferences:Boolean(references.available),mapquest:Boolean(MAPQUEST_KEY),webFallback:ALLOW_WEB_GEOCODE},mapquest:{configured:Boolean(MAPQUEST_KEY)},offlinePbf:quickPbfStatus(),settings:publicRuntimeSettings(SETTINGS),performance:{interactiveLimitMs:120000,serverAiLimitMs:INTERACTIVE_AI_TIMEOUT_MS},port:PORT})
  }
  if(url.pathname==='/api/chat'&&req.method==='POST'){
    const input=await readJson(req);let runtime=await resolveAiRuntime({force:!AI_RUNTIME_CACHE?.reachable}),model=String(input.model||'').trim()||AI_MODEL||runtime.model||''
    if(!runtime.reachable){return json(res,502,{error:'Local model server is not reachable.',detail:runtime.message||'',endpoint:runtime.root})}
    if(!model)model='local-model'
    const payload={model,messages:Array.isArray(input.messages)?input.messages:[],temperature:Number.isFinite(Number(input.temperature))?Number(input.temperature):0.25,max_tokens:Number.isFinite(Number(input.max_tokens))?Math.min(5000,Number(input.max_tokens)):1600,stream:Boolean(input.stream)}
    const requestLink=requestRuntimeSignal(req,res,INTERACTIVE_AI_TIMEOUT_MS)
    let upstream
    try{
      upstream=await fetch(aiChatUrl(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:requestLink.signal});ACTIVE_AI_ROOT=runtime.root
    }catch(e){
      const clientGone=requestLink.clientSignal.aborted||res.destroyed
      requestLink.dispose()
      if(clientGone)return
      if(e?.name==='TimeoutError'||e?.name==='AbortError')return json(res,504,{error:'Local model request timed out.',detail:e.message||'',endpoint:runtime.root})
      AI_RUNTIME_CACHE={...runtime,reachable:false,available:false,message:e.message,checkedAt:Date.now()}
      return json(res,502,{error:'Local model request failed.',detail:e.message,endpoint:runtime.root})
    }
    if(!upstream.ok){
      const text=await upstream.text().catch(()=> '')
      requestLink.dispose()
      AI_RUNTIME_CACHE={...runtime,reachable:true,available:Boolean(runtime.model||AI_MODEL),message:`Chat API returned ${upstream.status}.`,checkedAt:Date.now()}
      if(res.destroyed)return
      return json(res,upstream.status===400?400:502,{error:`Local model returned ${upstream.status}`,detail:text.slice(0,800),endpoint:runtime.root,model})
    }
    DETECTED_AI_MODEL=model;AI_RUNTIME_CACHE={...runtime,reachable:true,available:true,model,root:ACTIVE_AI_ROOT,message:'',checkedAt:Date.now()}
    if(payload.stream){
      if(res.destroyed){requestLink.dispose();try{await upstream.body?.cancel?.()}catch{};return}
      res.writeHead(200,headers({'Content-Type':upstream.headers.get('content-type')||'text/event-stream; charset=utf-8'}))
      try{for await(const chunk of upstream.body){if(res.destroyed)break;res.write(chunk)}}
      catch(e){if(!requestLink.clientSignal.aborted&&!res.destroyed)throw e}
      finally{requestLink.dispose();if((requestLink.clientSignal.aborted||res.destroyed)&&upstream.body){try{await upstream.body.cancel()}catch{}}}
      if(!res.destroyed&&!res.writableEnded)res.end()
      return
    }
    const data=await upstream.json().catch(()=>null);requestLink.dispose();if(res.destroyed)return;return data?json(res,200,data):json(res,502,{error:'Local model returned invalid JSON.'})
  }
  if(url.pathname==='/api/geocode'&&req.method==='GET'){
    const q=String(url.searchParams.get('q')||'').trim();if(!q)return json(res,400,{error:'q is required'});return json(res,200,await geocode(q))
  }
  if(url.pathname==='/api/references/search'&&req.method==='GET'){
    const q=String(url.searchParams.get('q')||'').trim();if(!q)return json(res,400,{error:'q is required'});const category=String(url.searchParams.get('category')||'wikivoyage');const limit=Math.max(1,Math.min(4,Number(url.searchParams.get('limit')||2)));let results=await searchReferences(q,category,limit);if(!results.length&&category!=='wikipedia')results=await searchReferences(q,'wikipedia',limit);return json(res,200,{query:q,results})
  }
  if(url.pathname==='/api/mapquest/route'&&req.method==='POST'){
    try{return json(res,200,await mapQuestRoute(await readJson(req)))}catch(e){return json(res,e.status||502,{error:e.message})}
  }
  if(url.pathname==='/api/offline/status'&&req.method==='GET')return json(res,200,await pbfStatus())
  if(url.pathname==='/api/offline/status'&&req.method==='POST'){const input=await readJson(req);return json(res,200,await pbfStatus(input?.points||[]))}
  if(url.pathname==='/api/offline/render'&&req.method==='POST'){
    try{const input=await readJson(req);const job=await startRawPbfRender(PBF_ROOT,{points:input?.points||[],legModes:input?.legModes||[]});return json(res,202,{ok:true,job})}catch(e){return json(res,e.status||400,{ok:false,error:e.message})}
  }
  const rawJob=url.pathname.match(/^\/api\/offline\/job\/([^/]+)$/)
  if(rawJob){const id=decodeURIComponent(rawJob[1]);if(req.method==='GET'){const job=getRawPbfJob(id);return job?json(res,200,{ok:true,job}):json(res,404,{ok:false,error:'Offline map render job not found.'})}if(req.method==='DELETE'){const job=await cancelRawPbfJob(id);return job?json(res,200,{ok:true,job}):json(res,404,{ok:false,error:'Offline map render job not found.'})}return json(res,405,{ok:false,error:'GET or DELETE required.'})}
  const tileMatch=url.pathname.match(/^\/api\/offline\/tile\/(\d+)\/(\d+)\/(\d+)\.pbf$/)
  if(tileMatch&&req.method==='GET'){
    const path=safeTilePath(tileMatch[1],tileMatch[2],tileMatch[3]);if(!path||!existsSync(path))return json(res,404,{error:'Offline tile not found.'});res.writeHead(200,headers({'Content-Type':'application/x-protobuf','Cache-Control':'public, max-age=3600'}));return createReadStream(path).pipe(res)
  }
  return json(res,404,{error:'Not found'})
}

async function serveStatic(res,url){
  let pathname=url.pathname==='/'?'/index.html':url.pathname;pathname=normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const target=resolve(PUBLIC,'.'+pathname);if(target!==PUBLIC&&!target.startsWith(PUBLIC+sep))return json(res,403,{error:'Forbidden'})
  try{const s=await stat(target);if(!s.isFile())throw new Error();const data=await readFile(target);res.writeHead(200,headers({'Content-Type':MIME[extname(target)]||'application/octet-stream','Cache-Control':'no-cache'}));res.end(data)}catch{return json(res,404,{error:'Not found'})}
}

const server=http.createServer(async(req,res)=>{
  if(SHUTTING_DOWN)return json(res,503,{error:'WAYFINDER is shutting down.'})
  const url=new URL(req.url,`http://${req.headers.host||'127.0.0.1'}`)
  try{if(url.pathname.startsWith('/api/'))return await handleApi(req,res,url);return await serveStatic(res,url)}catch(e){return json(res,e.status||500,{error:e.message||String(e)})}
})
server.on('connection',socket=>{SOCKETS.add(socket);socket.once('close',()=>SOCKETS.delete(socket))})
server.on('error',async error=>{
  if(INSTANCE)releaseInstance(INSTANCE)
  if(error?.code==='EADDRINUSE')console.error(`WAYFINDER cannot start because port ${PORT} is already in use. Close the running WAYFINDER app or use the recovery tool in SUPPORT.`)
  else console.error(error)
  process.exitCode=1
})

try{INSTANCE=await acquireInstance({root:ROOT,port:PORT,releaseId:RELEASE.releaseId})}
catch(error){console.error(error.message);process.exit(10)}
server.listen(PORT,'127.0.0.1',()=>{
  INSTANCE=markInstanceReady(INSTANCE);console.log(`WAYFINDER rebuild running at http://127.0.0.1:${PORT}`)
  if(MANAGED_LAUNCH){STARTUP_CLIENT_TIMER=setTimeout(()=>{if(!HAD_CLIENT&&!SHUTTING_DOWN)gracefulShutdown('no-browser-session',0).finally(()=>process.exit(0))},60000);STARTUP_CLIENT_TIMER.unref?.()}
})

for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{gracefulShutdown(signal,0).finally(()=>process.exit(0))})
process.on('uncaughtException',error=>{console.error(error);gracefulShutdown('uncaughtException',1).finally(()=>process.exit(1))})
process.on('unhandledRejection',error=>{console.error(error);gracefulShutdown('unhandledRejection',1).finally(()=>process.exit(1))})
