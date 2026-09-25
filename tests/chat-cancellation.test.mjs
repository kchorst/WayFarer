import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {spawn} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function listen(server){return await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port))})}
async function waitFor(url,ms=5000){const end=Date.now()+ms;while(Date.now()<end){try{const r=await fetch(url);if(r.ok)return}catch{}await delay(40)}throw new Error(`Timed out waiting for ${url}`)}
async function waitExit(child,ms=4000){return await Promise.race([new Promise(resolve=>child.once('exit',()=>resolve(true))),delay(ms).then(()=>false)])}

test('abandoning a fast-target Spark request cancels the upstream local-model job so a serial model is not blocked',async()=>{
  let firstClosed=false,chatCalls=0
  const queued=[]
  const answer=(res,body)=>{
    if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:'{"title":"A to B","stops":[{"label":"A","kind":"settlement","routeOccurrence":true},{"label":"B","kind":"settlement","routeOccurrence":true}],"days":2,"topology":"one_way"}\n'}}]})}\n\n`);res.end('data: [DONE]\n\n')}
    else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}))}
  }
  const ai=http.createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({data:[{id:'serial-model'}]}))}
    if(req.method==='POST'&&req.url==='/v1/chat/completions'){
      const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');chatCalls++
      if(chatCalls===1){
        // Simulate a single-worker local model stuck on the abandoned first attempt.
        // The worker is released only when WAYFINDER actually closes the upstream request.
        const release=()=>{if(firstClosed)return;firstClosed=true;for(const [r,b] of queued.splice(0))answer(r,b)}
        req.once('aborted',release);res.once('close',release)
        return
      }
      if(!firstClosed){queued.push([res,body]);return}
      return answer(res,body)
    }
    res.writeHead(404);res.end()
  })
  const aiPort=await listen(ai)
  const probe=http.createServer();const wfPort=await listen(probe);await new Promise(r=>probe.close(r))
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'wf-chat-cancel-'))
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,WAYFINDER_PORT:String(wfPort),WAYFINDER_RUNTIME_DIR:runtime,WAYFINDER_SETTINGS_PATH:path.join(runtime,'settings.json'),WAYFINDER_AI_ENDPOINT:`http://127.0.0.1:${aiPort}`,WAYFINDER_AI_MODEL:'serial-model',WAYFINDER_REFERENCE_ENDPOINT:`http://127.0.0.1:${aiPort}`,WAYFINDER_ALLOW_WEB_GEOCODE:'0'},stdio:['ignore','pipe','pipe']})
  let stderr='';child.stderr.on('data',d=>stderr+=d)
  try{
    await waitFor(`http://127.0.0.1:${wfPort}/`)
    const aborter=new AbortController()
    const first=fetch(`http://127.0.0.1:${wfPort}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'serial-model',messages:[{role:'user',content:'first'}],stream:true}),signal:aborter.signal}).catch(e=>e)
    await delay(120);aborter.abort(new DOMException('fast-target expired','AbortError'));await first
    const releasedBy=Date.now()+1200;while(!firstClosed&&Date.now()<releasedBy)await delay(20)
    assert.equal(firstClosed,true,'WAYFINDER did not cancel the abandoned upstream model request')
    const started=Date.now()
    const second=await fetch(`http://127.0.0.1:${wfPort}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'serial-model',messages:[{role:'user',content:'second'}],stream:false}),signal:AbortSignal.timeout(1500)})
    assert.equal(second.ok,true)
    const data=await second.json();assert.match(data.choices[0].message.content,/"ok":true/)
    assert.ok(Date.now()-started<1200,'second local-model request remained queued behind abandoned work')
  }finally{
    child.kill('SIGTERM');await waitExit(child);ai.close();fs.rmSync(runtime,{recursive:true,force:true})
  }
  assert.equal(stderr.trim(),'')
})
