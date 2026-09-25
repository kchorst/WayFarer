import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function wait(url){for(let i=0;i<100;i++){try{const r=await fetch(url);if(r.ok)return}catch{}await new Promise(r=>setTimeout(r,30))}throw new Error('server timeout')}

test('in-app settings persist locally, hide the MapQuest secret, and expose offline-map configuration',async()=>{
  const port='18330',dir=fs.mkdtempSync(path.join(os.tmpdir(),'wf-settings-ui-')),settings=path.join(dir,'settings.json'),mapDir=path.join(dir,'maps');fs.mkdirSync(mapDir)
  const child=spawn(process.execPath,['server.mjs'],{cwd:path.resolve('.'),env:{...process.env,WAYFINDER_PORT:port,WAYFINDER_RUNTIME_DIR:path.join(dir,'runtime'),WAYFINDER_SETTINGS_PATH:settings,WAYFINDER_REFERENCE_ENDPOINT:'http://127.0.0.1:65530',WAYFINDER_AI_ENDPOINT:'http://127.0.0.1:65531'},stdio:['ignore','ignore','ignore']})
  try{
    await wait(`http://127.0.0.1:${port}/`)
    const save=await fetch(`http://127.0.0.1:${port}/api/settings`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({aiEndpoint:'http://127.0.0.1:8080',aiModel:'local-model',referenceEndpoint:'http://127.0.0.1:8091',mapQuestKey:'super-secret-key',pbfRoot:mapDir,allowWebGeocode:false})}),saved=await save.json();assert.equal(save.ok,true);assert.equal(saved.settings.mapQuestConfigured,true);assert.equal(saved.settings.mapQuestKey,undefined);assert.equal(saved.settings.mapQuestKeyHint,'••••-key');assert.equal(saved.settings.pbfRoot,mapDir)
    const get=await fetch(`http://127.0.0.1:${port}/api/settings`),loaded=await get.json();assert.equal(loaded.settings.mapQuestConfigured,true);assert.equal(loaded.settings.mapQuestKey,undefined);assert.equal(loaded.settings.allowWebGeocode,false);assert.ok(fs.existsSync(settings));assert.doesNotMatch(JSON.stringify(loaded),/super-secret-key/)
    const html=await (await fetch(`http://127.0.0.1:${port}/`)).text();assert.match(html,/id="settingsBtn"/);assert.match(html,/id="browsePbfRootBtn"/);assert.match(html,/Offline map library folder/)
  }finally{child.kill('SIGTERM');fs.rmSync(dir,{recursive:true,force:true})}
})
