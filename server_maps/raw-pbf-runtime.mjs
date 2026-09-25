import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { Worker } from 'node:worker_threads'
import { scanPbfCatalog, selectMapCoverage, normalizeMapPath } from './map-catalog.mjs'
import { readPbfHeaderBounds, boundsFromPoints } from './osm-pbf.mjs'
import { DEFAULT_MAP_ROOT } from './map-roots.mjs'

const catalogCache=new Map()
const boundsCache=new Map()
const jobs=new Map()
const catalogWorkers=new Set()
const CATALOG_TTL_MS=30_000
const JOB_TIMEOUT_MS=110_000
const JOB_TTL_MS=10*60_000

function finitePoint(p){return Number.isFinite(Number(p?.lat))&&Number.isFinite(Number(p?.lon))}
function normalizedPoints(points=[]){return (Array.isArray(points)?points:[]).filter(finitePoint).map(p=>({lat:Number(p.lat),lon:Number(p.lon)}))}
function padBounds(bounds,pad=.08){if(!bounds)return null;let{west,east,south,north}=bounds;const dx=Math.max(.05,(east-west)*pad),dy=Math.max(.05,(north-south)*pad);return{west:Math.max(-180,west-dx),east:Math.min(180,east+dx),south:Math.max(-90,south-dy),north:Math.min(90,north+dy)}}
function existsDirectory(value){try{return fs.statSync(value).isDirectory()}catch{return false}}
function mapCacheDirectory(){
  const base=process.platform==='win32'?(String(process.env.APPDATA||'').trim()||path.join(os.homedir(),'AppData','Roaming')):(String(process.env.XDG_CACHE_HOME||'').trim()||path.join(os.homedir(),'.cache'))
  return path.join(base,'WAYFINDER','map-cache')
}
function renderCacheKey(sourceFiles,routePoints,legModes){
  const payload={files:(sourceFiles||[]).map(x=>[x.filePath,Number(x.size||0),Math.round(Number(x.modifiedAt||0))]),points:(routePoints||[]).map(p=>[Number(p.lat).toFixed(6),Number(p.lon).toFixed(6)]),legModes:(legModes||[]).map(String)}
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0,32)
}
function readCachedRender(cacheSvg,cacheMeta,key){
  try{const meta=JSON.parse(fs.readFileSync(cacheMeta,'utf8'));if(meta?.key!==key||!fs.existsSync(cacheSvg))return null;return{svg:fs.readFileSync(cacheSvg,'utf8'),meta}}catch{return null}
}
function pruneCache(dir,maxFiles=16){try{const items=fs.readdirSync(dir).filter(x=>x.endsWith('.json')).map(name=>{const file=path.join(dir,name);return{name,file,mtime:fs.statSync(file).mtimeMs}}).sort((a,b)=>b.mtime-a.mtime);for(const item of items.slice(maxFiles)){const base=item.file.slice(0,-5);try{fs.unlinkSync(item.file)}catch{};try{fs.unlinkSync(`${base}.svg`)}catch{}}}catch{}}
function publicEntry(entry){return{fileName:entry.fileName,filePath:entry.filePath,relativePath:entry.relativePath,size:entry.size,modifiedAt:entry.modifiedAt,areaName:entry.areaKey||'',extractDate:entry.extractDate||'',source:entry.source||''}}

async function scanCatalogWorker(root){
  const normalized=normalizeMapPath(root)
  if(!normalized||!existsDirectory(normalized))return scanPbfCatalog(normalized)
  const cached=catalogCache.get(normalized)
  if(cached&&Date.now()-cached.at<CATALOG_TTL_MS)return cached.value
  let value
  try{
    value=await new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./map-catalog-worker.mjs',import.meta.url),{workerData:{root:normalized,options:{maxDepth:8,maxFiles:5000}}})
      catalogWorkers.add(worker)
      const done=()=>catalogWorkers.delete(worker)
      const timer=setTimeout(()=>{done();worker.terminate();reject(new Error('Offline map catalog scan exceeded 20 seconds.'))},20_000)
      worker.once('message',message=>{clearTimeout(timer);done();worker.terminate();if(message?.ok===false)reject(new Error(message.message||'Map catalog scan failed.'));else resolve(message?.result||message)})
      worker.once('error',error=>{clearTimeout(timer);done();reject(error)})
      worker.once('exit',done)
    })
  }catch(error){
    // Cataloging is background infrastructure. Never fall back to a synchronous
    // recursive scan on the app thread: a large map library must not freeze
    // Spark, Revision, Documentation, status polling, or cancellation. A stale
    // successful catalog is safer than blocking the interactive application.
    if(cached?.value)return{...cached.value,stale:true,staleReason:String(error?.message||error)}
    throw error
  }
  catalogCache.set(normalized,{at:Date.now(),value})
  return value
}

async function cachedBounds(filePath,entry={}){
  const key=`${filePath}|${entry.modifiedAt||0}|${entry.size||0}`
  if(boundsCache.has(key))return boundsCache.get(key)
  const value=await readPbfHeaderBounds(filePath)
  boundsCache.set(key,value)
  return value
}

export async function rawPbfStatus(root,{points=[]}={}){
  const configured=Boolean(String(root||'').trim())
  const effective=normalizeMapPath(root||DEFAULT_MAP_ROOT)
  if(!configured)return{configured:false,available:false,renderReady:false,root:'',suggestedRoot:DEFAULT_MAP_ROOT,kind:'raw-osm-pbf-library',message:'Choose your existing .osm.pbf map library folder in Settings.'}
  if(!existsDirectory(effective))return{configured:true,available:false,renderReady:false,root:effective,kind:'raw-osm-pbf-library',message:'Configured offline map library folder does not exist.'}
  const scan=await scanCatalogWorker(effective),entries=scan.entries||[],routePoints=normalizedPoints(points)
  if(!entries.length)return{configured:true,available:false,renderReady:false,root:effective,kind:'raw-osm-pbf-library',catalogCount:0,diagnostics:scan.diagnostics,message:'No .osm.pbf files were found in the selected map library.'}
  let selected=[],complete=false,uncoveredPointIndexes=[]
  if(routePoints.length){
    const coverage=await selectMapCoverage(entries,{points:routePoints,readBounds:cachedBounds})
    selected=coverage.selected||[];complete=Boolean(coverage.complete);uncoveredPointIndexes=coverage.uncoveredPointIndexes||[]
  }
  return{configured:true,available:true,renderReady:routePoints.length?complete:true,root:effective,kind:'raw-osm-pbf-library',catalogCount:entries.length,files:entries.slice(0,100).map(publicEntry),selectedFiles:selected.map(publicEntry),uncoveredPointIndexes,diagnostics:scan.diagnostics,message:routePoints.length?(complete?`${selected.length} installed .osm.pbf extract${selected.length===1?'':'s'} cover the canonical route.`:`${entries.length} .osm.pbf files found, but installed coverage does not include every resolved route stop.`):`${entries.length} .osm.pbf map file${entries.length===1?'':'s'} found.`}
}

function cleanupJobs(){const cutoff=Date.now()-JOB_TTL_MS;for(const[id,job]of jobs)if(job.updatedAt<cutoff){job.worker?.terminate?.();jobs.delete(id)}}
function publicJob(job,{includeSvg=true}={}){if(!job)return null;return{id:job.id,state:job.state,phase:job.phase,percent:job.percent,message:job.message,error:job.error||'',createdAt:job.createdAt,updatedAt:job.updatedAt,bounds:job.bounds||null,routeSegments:job.routeSegments||[],degraded:Boolean(job.degraded),limitationReasons:job.limitationReasons||[],resourceStats:job.resourceStats||null,sourceFiles:job.sourceFiles||[],svg:includeSvg&&job.state==='ready'?job.svg:''}}

export async function startRawPbfRender(root,{points=[],legModes=[]}={}){
  cleanupJobs();const routePoints=normalizedPoints(points);if(routePoints.length<2)throw Object.assign(new Error('At least two resolved canonical occurrences are required for the offline map.'),{status:422})
  const status=await rawPbfStatus(root,{points:routePoints});if(!status.available)throw Object.assign(new Error(status.message),{status:409});if(!status.renderReady)throw Object.assign(new Error(status.message),{status:422})
  const sourceFiles=status.selectedFiles||[];if(!sourceFiles.length)throw Object.assign(new Error('No installed .osm.pbf extract was selected for this route.'),{status:422})
  const id=crypto.randomUUID(),cacheDir=mapCacheDirectory();fs.mkdirSync(cacheDir,{recursive:true});pruneCache(cacheDir);const key=renderCacheKey(sourceFiles,routePoints,legModes),cacheSvg=path.join(cacheDir,`${key}.svg`),cacheMeta=path.join(cacheDir,`${key}.json`),routeBounds=padBounds(boundsFromPoints(routePoints),.12),cached=readCachedRender(cacheSvg,cacheMeta,key)
  const job={id,state:cached?'ready':'starting',phase:cached?'cache':'catalog',percent:cached?100:1,message:cached?'Offline map loaded from WAYFINDER cache.':'Installed map coverage found. Starting bounded offline render…',createdAt:Date.now(),updatedAt:Date.now(),sourceFiles:sourceFiles.map(publicEntry),worker:null,svg:cached?.svg||'',bounds:cached?.meta?.bounds||routeBounds,routeSegments:cached?.meta?.routeSegments||[],degraded:Boolean(cached?.meta?.degraded),limitationReasons:cached?.meta?.limitationReasons||[],resourceStats:cached?.meta?.resourceStats||null};jobs.set(id,job)
  if(cached)return publicJob(job)
  const worker=new Worker(new URL('./osm-pbf-worker.mjs',import.meta.url),{workerData:{sourceFiles,renderBounds:routeBounds,routeFocus:routePoints,canonicalRoutePoints:routePoints,legModes:Array.isArray(legModes)?legModes:[],cacheSvg,cacheMeta,key,modifiedAt:Math.max(0,...sourceFiles.map(x=>Number(x.modifiedAt||0)))},resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:48,stackSizeMb:4}});job.worker=worker
  const timer=setTimeout(async()=>{if(!jobs.has(id)||['ready','failed','limited','cancelled'].includes(job.state))return;await worker.terminate();Object.assign(job,{state:'limited',phase:'timeout',percent:100,message:'Detailed offline rendering reached WAYFINDER’s 110-second interactive safety limit. The canonical route remains available.',updatedAt:Date.now(),error:'Offline render time limit reached.'})},JOB_TIMEOUT_MS)
  worker.on('message',message=>{job.updatedAt=Date.now();if(message?.type==='progress'){job.state='working';job.phase=message.progress?.phase||'render';job.percent=Math.max(1,Math.min(99,Number(message.progress?.percent||job.percent||1)));job.message=message.progress?.message||'Rendering offline map…'}else if(message?.type==='done'){clearTimeout(timer);job.state='ready';job.phase='done';job.percent=100;job.message=message.degraded?'Reduced-detail offline map ready.':'Offline map ready from installed .osm.pbf files.';job.bounds=message.bounds||routeBounds;job.routeSegments=message.routeSegments||[];job.degraded=Boolean(message.degraded);job.limitationReasons=message.limitationReasons||[];job.resourceStats=message.resourceStats||null;try{job.svg=fs.readFileSync(cacheSvg,'utf8')}catch{job.state='failed';job.error='Offline renderer completed without a readable SVG.'}}else if(message?.type==='limited'){clearTimeout(timer);job.state='limited';job.phase='limited';job.percent=100;job.message=message.message||'Reduced-detail offline map required.';job.error=message.reason||'';job.resourceStats=message.stats||null}else if(message?.type==='error'){clearTimeout(timer);job.state='failed';job.phase='error';job.percent=100;job.message='Offline map render failed.';job.error=message.message||'Unknown worker error'}})
  worker.on('error',error=>{clearTimeout(timer);Object.assign(job,{state:'failed',phase:'error',percent:100,message:'Offline map render failed.',error:error.message,updatedAt:Date.now()})})
  worker.on('exit',()=>{clearTimeout(timer);job.worker=null;if(!['ready','failed','limited','cancelled'].includes(job.state))Object.assign(job,{state:'failed',phase:'error',percent:100,message:'Offline map worker stopped unexpectedly.',error:'Worker exited before completion.',updatedAt:Date.now()})})
  return publicJob(job,{includeSvg:false})
}

export function getRawPbfJob(id){cleanupJobs();return publicJob(jobs.get(id))}
export async function cancelRawPbfJob(id){const job=jobs.get(id);if(!job)return null;if(job.worker)await job.worker.terminate();Object.assign(job,{worker:null,state:'cancelled',phase:'cancelled',percent:100,message:'Offline map render cancelled.',updatedAt:Date.now()});return publicJob(job,{includeSvg:false})}
export function clearRawPbfCaches(){catalogCache.clear();boundsCache.clear()}


export async function shutdownRawPbfRuntime(){
  const terminations=[]
  for(const worker of [...catalogWorkers]){catalogWorkers.delete(worker);try{terminations.push(worker.terminate())}catch{}}
  for(const job of jobs.values()){
    if(job.worker){try{terminations.push(job.worker.terminate())}catch{};job.worker=null}
    if(!['ready','failed','limited','cancelled'].includes(job.state))Object.assign(job,{state:'cancelled',phase:'shutdown',percent:100,message:'Offline map work stopped because WAYFINDER is shutting down.',updatedAt:Date.now()})
  }
  if(terminations.length)await Promise.allSettled(terminations)
  jobs.clear();catalogCache.clear();boundsCache.clear()
}
