import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const APP='WAYFINDER'

function runtimeDirectory(){
  if(process.env.WAYFINDER_RUNTIME_DIR)return path.resolve(process.env.WAYFINDER_RUNTIME_DIR)
  if(process.platform==='win32'){
    const base=String(process.env.LOCALAPPDATA||'').trim()||path.join(os.homedir(),'AppData','Local')
    return path.join(base,APP,'runtime')
  }
  const base=String(process.env.XDG_RUNTIME_DIR||'').trim()||os.tmpdir()
  const uid=typeof process.getuid==='function'?String(process.getuid()):'user'
  return path.join(base,`wayfinder-${uid}`)
}

export function controlFilePath(){return process.env.WAYFINDER_CONTROL_FILE?path.resolve(process.env.WAYFINDER_CONTROL_FILE):path.join(runtimeDirectory(),'server-control.json')}
export function lockFilePath(){return process.env.WAYFINDER_LOCK_FILE?path.resolve(process.env.WAYFINDER_LOCK_FILE):path.join(runtimeDirectory(),'server.lock')}

function ensureRuntimeDir(){fs.mkdirSync(path.dirname(controlFilePath()),{recursive:true})}
export function pidAlive(pid){
  const n=Number(pid);if(!Number.isInteger(n)||n<=0)return false
  try{process.kill(n,0);return true}catch(error){return error?.code==='EPERM'}
}
export function readControlFile(){
  try{const x=JSON.parse(fs.readFileSync(controlFilePath(),'utf8'));return x?.app===APP?x:null}catch{return null}
}
function writeJsonAtomic(file,value){
  ensureRuntimeDir();const tmp=`${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600});fs.renameSync(tmp,file)
}
export async function probeWayfinder(port,timeoutMs=900){
  try{
    const r=await fetch(`http://127.0.0.1:${Number(port)}/api/status`,{signal:AbortSignal.timeout(timeoutMs),headers:{Accept:'application/json'}})
    if(!r.ok)return null
    const body=await r.json();if(!body?.ok||!body?.release?.releaseId||!body?.performance?.interactiveLimitMs)return null
    return body
  }catch{return null}
}
export async function acquireInstance({root,port,releaseId}){
  ensureRuntimeDir();const lock=lockFilePath(),control=readControlFile()
  if(control&&pidAlive(control.pid)){
    const live=await probeWayfinder(control.port||port)
    if(live)throw Object.assign(new Error(`WAYFINDER is already running at http://127.0.0.1:${control.port||port}/ (PID ${control.pid}). Close the running WAYFINDER app first, or use SUPPORT\RECOVER-WAYFINDER.cmd only if recovery is needed.`),{code:'WAYFINDER_ALREADY_RUNNING',existing:control})
  }
  if(control&&!pidAlive(control.pid)){try{fs.unlinkSync(controlFilePath())}catch{}}
  for(let attempt=0;attempt<2;attempt++){
    try{
      const token=crypto.randomBytes(32).toString('hex')
      const lockPayload={app:APP,pid:process.pid,token,root:path.resolve(root),port:Number(port),releaseId:String(releaseId||''),startedAt:new Date().toISOString()}
      const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(lockPayload)+'\n');fs.closeSync(fd)
      return lockPayload
    }catch(error){
      if(error?.code!=='EEXIST')throw error
      let stale=true
      try{const holder=JSON.parse(fs.readFileSync(lock,'utf8'));stale=!pidAlive(holder?.pid)}catch{}
      if(!stale)throw Object.assign(new Error('Another WAYFINDER process is starting or already running. Close the running WAYFINDER app first, or use SUPPORT\RECOVER-WAYFINDER.cmd only if recovery is needed.'),{code:'WAYFINDER_LOCKED'})
      try{fs.unlinkSync(lock)}catch{}
    }
  }
  throw new Error('Unable to acquire WAYFINDER runtime lock.')
}
export function markInstanceReady(instance){
  const record={...instance,ready:true,readyAt:new Date().toISOString(),controlVersion:1}
  writeJsonAtomic(controlFilePath(),record);return record
}
export function releaseInstance(instance){
  const token=instance?.token
  try{const control=readControlFile();if(!control||!token||control.token===token)fs.unlinkSync(controlFilePath())}catch{}
  try{
    const lock=JSON.parse(fs.readFileSync(lockFilePath(),'utf8'))
    if(!token||lock?.token===token)fs.unlinkSync(lockFilePath())
  }catch{}
}
export function shutdownTokenMatches(value,instance){const a=Buffer.from(String(value||'')),b=Buffer.from(String(instance?.token||''));return a.length>0&&a.length===b.length&&crypto.timingSafeEqual(a,b)}
export function cleanupStaleRuntime(){
  const control=readControlFile();if(control&&!pidAlive(control.pid)){try{fs.unlinkSync(controlFilePath())}catch{}}
  try{const lock=JSON.parse(fs.readFileSync(lockFilePath(),'utf8'));if(!pidAlive(lock?.pid))fs.unlinkSync(lockFilePath())}catch{}
}
