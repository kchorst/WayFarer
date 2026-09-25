import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { cleanupStaleRuntime, pidAlive, probeWayfinder, readControlFile, releaseInstance } from './server-lifecycle.mjs'

const ROOT=fileURLToPath(new URL('.',import.meta.url))
let RELEASE={releaseId:''};try{RELEASE=JSON.parse(readFileSync(join(ROOT,'RELEASE.json'),'utf8'))}catch{}
const DEFAULT_PORT=Number(process.env.WAYFINDER_PORT||4198)
const sleep=ms=>new Promise(r=>setTimeout(r,ms))

async function waitStopped(pid,port,timeoutMs=7000){
  const end=Date.now()+timeoutMs
  while(Date.now()<end){if(!pidAlive(pid)&&!(await probeWayfinder(port,250)))return true;await sleep(150)}
  return !pidAlive(pid)&&!(await probeWayfinder(port,250))
}
async function waitStarted(port,timeoutMs=12000){
  const end=Date.now()+timeoutMs
  while(Date.now()<end){const live=await probeWayfinder(port,500);if(live)return live;await sleep(150)}
  return null
}
async function requestGracefulStop(record){
  const port=Number(record?.port||DEFAULT_PORT),token=String(record?.token||'')
  if(!token)return false
  try{
    const r=await fetch(`http://127.0.0.1:${port}/api/system/shutdown`,{method:'POST',headers:{'X-WAYFINDER-Shutdown-Token':token},signal:AbortSignal.timeout(1800)})
    return r.status===202||r.status===200
  }catch{return false}
}
function windowsListenerPid(port){
  if(process.platform!=='win32')return 0
  try{
    const script=`$c=Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if($c){[Console]::Out.Write($c)}`
    return Number(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000}).trim())||0
  }catch{return 0}
}
function openBrowser(port){
  if(process.env.WAYFINDER_NO_BROWSER==='1')return
  const url=`http://127.0.0.1:${Number(port)}/`
  if(process.platform==='win32'){
    execFileSync('powershell.exe',['-NoProfile','-Command',`Start-Process '${url}'`],{windowsHide:true,timeout:5000})
    return
  }
  const opener=process.platform==='darwin'?'open':'xdg-open'
  try{spawn(opener,[url],{detached:true,stdio:'ignore'}).unref()}catch{}
}
async function stop(){
  cleanupStaleRuntime();let record=readControlFile()
  if(record&&pidAlive(record.pid)){
    const graceful=await requestGracefulStop(record)
    if(graceful&&await waitStopped(record.pid,record.port||DEFAULT_PORT)){console.log('WAYFINDER stopped cleanly.');return 0}
    if(pidAlive(record.pid)){
      try{process.kill(Number(record.pid),'SIGTERM')}catch{}
      if(await waitStopped(record.pid,record.port||DEFAULT_PORT,3000)){releaseInstance(record);console.log('WAYFINDER stopped.');return 0}
    }
    console.error(`Could not stop WAYFINDER process ${record.pid}. Close it in Task Manager and retry.`);return 1
  }
  const live=await probeWayfinder(DEFAULT_PORT,700)
  if(live&&process.platform==='win32'){
    const pid=windowsListenerPid(DEFAULT_PORT)
    if(pid){
      try{process.kill(pid,'SIGTERM')}catch{}
      if(await waitStopped(pid,DEFAULT_PORT,3000)){console.log(`Stopped legacy WAYFINDER listener on port ${DEFAULT_PORT}.`);return 0}
    }
    console.error(`A WAYFINDER server is still listening on port ${DEFAULT_PORT}, but it could not be stopped automatically.`);return 1
  }
  console.log('WAYFINDER is not running.');return 0
}
async function preflight(){
  cleanupStaleRuntime();const record=readControlFile()
  if(record&&pidAlive(record.pid)&&await probeWayfinder(record.port||DEFAULT_PORT,600)){
    if(record.releaseId===RELEASE.releaseId&&resolve(record.root||'')===resolve(ROOT)){console.log(`This WAYFINDER build is already running at http://127.0.0.1:${record.port||DEFAULT_PORT}/`);return 10}
    console.error(`A different WAYFINDER build is already running (PID ${record.pid}). Close that WAYFINDER window first; use SUPPORT\\RECOVER-WAYFINDER.cmd only if recovery is needed.`);return 11
  }
  const live=await probeWayfinder(DEFAULT_PORT,500)
  if(live){console.error(`A WAYFINDER server is already running on port ${DEFAULT_PORT}. Close that WAYFINDER app first; use SUPPORT\\RECOVER-WAYFINDER.cmd only if recovery is needed.`);return 11}
  return 0
}
async function launch(){
  const check=await preflight()
  if(check===10){openBrowser(DEFAULT_PORT);return 0}
  if(check!==0)return check
  const child=spawn(process.execPath,[join(ROOT,'server.mjs')],{cwd:ROOT,env:{...process.env,WAYFINDER_MANAGED_LAUNCH:'1'},detached:true,windowsHide:true,stdio:'ignore'})
  child.unref()
  const live=await waitStarted(DEFAULT_PORT,12000)
  if(!live){try{process.kill(child.pid,'SIGTERM')}catch{};console.error('WAYFINDER did not start successfully.');return 1}
  openBrowser(DEFAULT_PORT)
  console.log(`WAYFINDER opened at http://127.0.0.1:${DEFAULT_PORT}/`)
  return 0
}
async function status(){
  cleanupStaleRuntime();const record=readControlFile(),port=Number(record?.port||DEFAULT_PORT),live=await probeWayfinder(port,600)
  if(live){console.log(`RUNNING ${live.release?.releaseId||RELEASE.releaseId||''} PID ${record?.pid||'?'} http://127.0.0.1:${port}/`);return 0}
  console.log('STOPPED');return 1
}
const cmd=String(process.argv[2]||'status').toLowerCase()
const code=cmd==='stop'?await stop():cmd==='preflight'?await preflight():cmd==='launch'?await launch():await status()
process.exitCode=code
