import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function spawnNode(args,env={}){return spawn(process.execPath,args,{cwd:new URL('..',import.meta.url),env:{...process.env,...env},stdio:['ignore','ignore','ignore']})}
async function wait(url){for(let i=0;i<100;i++){try{const r=await fetch(url);if(r.ok)return}catch{}await new Promise(r=>setTimeout(r,30))}throw new Error('server timeout')}

test('offline Kiwix references can provide corroborated coordinates before online geocoders',async()=>{
  const mockPort='18320',appPort='18321',dir=fs.mkdtempSync(path.join(os.tmpdir(),'wf-settings-')),settings=path.join(dir,'settings.json'),children=[]
  children.push(spawn(process.execPath,['tests/mock-stack.mjs'],{cwd:path.resolve('.'),env:{...process.env,MOCK_PORT:mockPort},stdio:['ignore','ignore','ignore']}))
  children.push(spawn(process.execPath,['server.mjs'],{cwd:path.resolve('.'),env:{...process.env,WAYFINDER_PORT:appPort,WAYFINDER_RUNTIME_DIR:path.join(dir,'runtime'),WAYFINDER_SETTINGS_PATH:settings,WAYFINDER_AI_ENDPOINT:`http://127.0.0.1:${mockPort}`,WAYFINDER_AI_MODEL:'mock-wayfinder',WAYFINDER_REFERENCE_ENDPOINT:`http://127.0.0.1:${mockPort}`,WAYFINDER_ALLOW_WEB_GEOCODE:'0',WAYFINDER_GAZETTEER_ENDPOINT:'',WAYFINDER_MAPQUEST_KEY:''},stdio:['ignore','ignore','ignore']}))
  try{
    await wait(`http://127.0.0.1:${appPort}/api/status`)
    const r=await fetch(`http://127.0.0.1:${appPort}/api/geocode?q=Genoa`),d=await r.json()
    assert.equal(r.ok,true);assert.equal(d.source,'local-references');assert.ok(d.results.length>=1);assert.equal(d.results[0].source,'local-reference-corroborated');assert.equal(d.results[0].confidence,.86);assert.ok(Math.abs(d.results[0].lat-44.4056)<.001)
  }finally{for(const child of children)child.kill('SIGTERM');fs.rmSync(dir,{recursive:true,force:true})}
})
