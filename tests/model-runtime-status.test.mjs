import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..')
async function wait(url){for(let i=0;i<80;i++){try{const r=await fetch(url);if(r.ok)return r}catch{}await new Promise(r=>setTimeout(r,50))}throw new Error(`timeout ${url}`)}

test('runtime status auto-detects a running local OpenAI-compatible model and stays running after chat',async()=>{
  const children=[],runtimeDir=fs.mkdtempSync(join(os.tmpdir(),'wf-model-runtime-'))
  const env={...process.env};delete env.WAYFINDER_AI_ENDPOINT;delete env.WAYFINDER_AI_MODEL
  const mock=spawn(process.execPath,['tests/mock-stack.mjs'],{cwd:root,env:{...env,MOCK_PORT:'1234'},stdio:'ignore'});children.push(mock)
  const app=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...env,WAYFINDER_PORT:'18111',WAYFINDER_RUNTIME_DIR:runtimeDir,WAYFINDER_ALLOW_WEB_GEOCODE:'0'},stdio:'ignore'});children.push(app)
  try{
    const base='http://127.0.0.1:18111'
    const first=await (await wait(base+'/api/status')).json()
    assert.equal(first.ai.available,true)
    assert.equal(first.ai.reachable,true)
    assert.equal(first.ai.model,'mock-wayfinder')
    assert.match(first.ai.endpoint,/1234/)
    const chat=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'hello'}],stream:false})})
    assert.equal(chat.ok,true)
    const second=await (await fetch(base+'/api/status')).json()
    assert.equal(second.ai.available,true)
    assert.equal(second.ai.reachable,true)
    assert.ok(second.ai.model)
  }finally{for(const p of children)p.kill('SIGTERM');fs.rmSync(runtimeDir,{recursive:true,force:true})}
})
