import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))

async function freePort(){return await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})}
function waitExit(child,timeout=7000){if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve({code:child.exitCode,signal:child.signalCode});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Process ${child.pid} did not exit within ${timeout} ms`)),timeout);child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal})})})}
async function waitForFile(file,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){if(fs.existsSync(file))return;await sleep(50)}throw new Error(`Timed out waiting for ${file}`)}
async function waitPidGone(pid,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){try{process.kill(pid,0)}catch{return true}await sleep(75)}return false}
async function canBind(port){return await new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)))})}
async function post(port,pathName,body={}){return fetch(`http://127.0.0.1:${port}${pathName}`,{method:'POST',headers:{'Content-Type':'application/json','X-WAYFINDER-Client':'1'},body:JSON.stringify(body)})}
function makeApp(base){
  const app=path.join(base,'WAYFINDER-extracted');fs.mkdirSync(app,{recursive:true})
  for(const rel of ['server.mjs','server-lifecycle.mjs','wayfinder-control.mjs','runtime-settings.mjs','RELEASE.json'])fs.copyFileSync(path.join(ROOT,rel),path.join(app,rel))
  fs.cpSync(path.join(ROOT,'server_maps'),path.join(app,'server_maps'),{recursive:true});fs.cpSync(path.join(ROOT,'public'),path.join(app,'public'),{recursive:true});return app
}
async function runControl(app,args,env){
  const child=spawn(process.execPath,[path.join(app,'wayfinder-control.mjs'),...args],{cwd:app,env:{...process.env,...env},stdio:['ignore','pipe','pipe']})
  let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);const result=await waitExit(child,15000);return{...result,out,err}
}

async function managedStartFixture(){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'wayfinder-lifecycle-')),app=makeApp(base),runtime=path.join(base,'runtime'),settings=path.join(base,'settings.json'),port=await freePort()
  const env={WAYFINDER_PORT:String(port),WAYFINDER_RUNTIME_DIR:runtime,WAYFINDER_SETTINGS_PATH:settings,WAYFINDER_REFERENCE_ENDPOINT:'http://127.0.0.1:1',WAYFINDER_AI_ENDPOINT:'http://127.0.0.1:1',WAYFINDER_ALLOW_WEB_GEOCODE:'0',WAYFINDER_NO_BROWSER:'1',WAYFINDER_CLIENT_CLOSE_GRACE_MS:'800'}
  const launch=await runControl(app,['launch'],env);assert.equal(launch.code,0,`managed launcher failed: ${launch.err||launch.out}`)
  const controlFile=path.join(runtime,'server-control.json');await waitForFile(controlFile,5000);const control=JSON.parse(fs.readFileSync(controlFile,'utf8'))
  return{base,app,runtime,settings,port,env,controlFile,control}
}

function assertDeletable({base,app}){const renamed=path.join(base,'WAYFINDER-deletable');fs.renameSync(app,renamed);fs.rmSync(renamed,{recursive:true,force:false});assert.equal(fs.existsSync(renamed),false,'closed WAYFINDER extraction must be deletable')}

test('WAYFINDER normal lifecycle: one launcher, in-app Exit, no lingering server, extracted folder deletable',async t=>{
  const fx=await managedStartFixture();t.after(()=>{try{process.kill(fx.control.pid,'SIGKILL')}catch{};try{fs.rmSync(fx.base,{recursive:true,force:true})}catch{}})
  const registered=await post(fx.port,'/api/system/client/register');assert.equal(registered.status,200);const clientId=(await registered.json()).clientId;assert.ok(clientId)
  const exit=await post(fx.port,'/api/system/client/exit',{clientId});assert.equal(exit.status,202)
  assert.equal(await waitPidGone(fx.control.pid,7000),true,'in-app Exit must end the WAYFINDER Node process')
  assert.equal(fs.existsSync(fx.controlFile),false,'normal exit must remove the external runtime control record')
  assert.equal(await canBind(fx.port),true,'normal exit must release the HTTP port')
  assertDeletable(fx)
})

test('WAYFINDER browser-window lifecycle: closing the last registered app window auto-stops and releases the extraction',async t=>{
  const fx=await managedStartFixture();t.after(()=>{try{process.kill(fx.control.pid,'SIGKILL')}catch{};try{fs.rmSync(fx.base,{recursive:true,force:true})}catch{}})
  const registered=await post(fx.port,'/api/system/client/register');const clientId=(await registered.json()).clientId;assert.ok(clientId)
  const duplicate=await runControl(fx.app,['launch'],fx.env);assert.equal(duplicate.code,0,'reopening the same build should reuse the existing server, not leave a duplicate')
  const control2=JSON.parse(fs.readFileSync(fx.controlFile,'utf8'));assert.equal(control2.pid,fx.control.pid,'relaunch must reuse the same server process')
  const closed=await post(fx.port,'/api/system/client/close',{clientId});assert.equal(closed.status,202)
  assert.equal(await waitPidGone(fx.control.pid,7000),true,'closing the final app window must auto-stop WAYFINDER')
  assert.equal(await canBind(fx.port),true,'auto-stop must release the HTTP port')
  assertDeletable(fx)
})
