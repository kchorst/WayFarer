import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=fileURLToPath(new URL('.',import.meta.url))
const parseJson=text=>JSON.parse(String(text).replace(/^\uFEFF/,''))
const readJson=async rel=>parseJson(await readFile(join(root,rel),'utf8'))
const sha256=data=>createHash('sha256').update(data).digest('hex')
const release=await readJson('RELEASE.json')
const acceptance=await readJson('ACCEPTANCE_JOURNEYS.json')
const guideAcceptance=await readJson('GUIDE_ACCEPTANCE.json')
const manifest=await readJson('RELEASE_CRITICAL_FILES.json')
let evidence
try{evidence=await readJson('RENDERED_ACCEPTANCE.json')}catch{throw new Error('RELEASE BLOCKED: RENDERED_ACCEPTANCE.json is missing. Rendered traveler walkthroughs have not been proven for this exact build.')}
let matrixEvidence
try{matrixEvidence=await readJson('RENDERED_VARIANT_EVIDENCE.json')}catch{throw new Error('RELEASE BLOCKED: RENDERED_VARIANT_EVIDENCE.json is missing. The canonical four-variant rendered matrix has not been proven for this exact build.')}

const hash=createHash('sha256')
for(const rel of manifest.files||[]){hash.update(rel+'\0');hash.update(await readFile(join(root,rel)));hash.update('\0')}
const criticalHash=hash.digest('hex')
if(evidence.releaseId!==release.releaseId)throw new Error(`RELEASE BLOCKED: rendered evidence belongs to ${evidence.releaseId||'unknown'}, not ${release.releaseId}.`)
if(evidence.criticalHash!==criticalHash)throw new Error('RELEASE BLOCKED: critical UI/core/docs/server files changed after the rendered walkthrough evidence was produced.')
if(evidence.verdict!=='PASS')throw new Error(`RELEASE BLOCKED: rendered walkthrough verdict is ${evidence.verdict||'missing'}.`)

const requiredFamilies=['vague-named-route','island-loop','one-way-city-anchors','multi-country-route','multi-area-island','revision','precision','mapping','documentation','return-to-spark','save-reload-import']
const requiredVariants=['normal','contradictory','degraded','navigation']
if(matrixEvidence.releaseId!==release.releaseId)throw new Error(`RELEASE BLOCKED: four-variant rendered evidence belongs to ${matrixEvidence.releaseId||'unknown'}, not ${release.releaseId}.`)
if(matrixEvidence.criticalHash!==criticalHash)throw new Error('RELEASE BLOCKED: critical UI/core/docs/server files changed after the four-variant rendered matrix evidence was produced.')
if(matrixEvidence.verdict!=='PASS')throw new Error(`RELEASE BLOCKED: four-variant rendered matrix verdict is ${matrixEvidence.verdict||'missing'}.`)
for(const family of requiredFamilies){
  for(const variant of requiredVariants){
    if(matrixEvidence.families?.[family]?.[variant]?.status!=='PASS')throw new Error(`RELEASE BLOCKED: rendered matrix missing/not passing: ${family}/${variant}`)
  }
}

const required=(acceptance.journeys||[]).filter(x=>x.required!==false)
const guide=await readFile(join(root,'USER_GUIDE.md'),'utf8')
for(const journey of required){
  if(!journey.id||!journey.guideMarker)throw new Error('RELEASE BLOCKED: malformed ACCEPTANCE_JOURNEYS.json entry.')
  if(!guide.includes(`<!-- ${journey.guideMarker} -->`))throw new Error(`RELEASE BLOCKED: USER_GUIDE.md is missing acceptance marker ${journey.guideMarker}.`)
}
const passed=new Set((evidence.scenarios||[]).filter(x=>x.status==='PASS').map(x=>x.id))
const missing=required.map(x=>x.id).filter(id=>!passed.has(id))
if(missing.length)throw new Error(`RELEASE BLOCKED: rendered scenarios missing/not passing: ${missing.join(', ')}`)

const guideSections=(guideAcceptance.sections||[]).filter(x=>x.required!==false)
if(guideSections.length!==13)throw new Error(`RELEASE BLOCKED: executable User Guide acceptance must own all 13 guide sections; found ${guideSections.length}.`)
for(const section of guideSections){
  for(const id of section.renderedScenarios||[]){
    if(!passed.has(id))throw new Error(`RELEASE BLOCKED: User Guide section ${section.id} requires rendered scenario ${id}.`)
  }
  for(const cell of section.matrixCells||[]){
    const [family,variant]=String(cell).split('/')
    if(matrixEvidence.families?.[family]?.[variant]?.status!=='PASS')throw new Error(`RELEASE BLOCKED: User Guide section ${section.id} requires rendered matrix cell ${cell}.`)
  }
  if(!(section.nativeWindows||section.renderedScenarios?.length||section.matrixCells?.length))throw new Error(`RELEASE BLOCKED: User Guide section ${section.id} has no executable acceptance owner.`)
}

// Native Windows evidence is deliberately external to the ZIP so it can be
// generated *after* the exact ZIP is frozen without creating a circular hash.
const windowsEvidencePath=String(process.env.WAYFINDER_WINDOWS_EVIDENCE||'').trim()
const exactZipHash=String(process.env.WAYFINDER_EXACT_ZIP_SHA256||'').trim().toLowerCase()
if(!windowsEvidencePath)throw new Error('RELEASE BLOCKED: native Windows lifecycle evidence is required for the exact frozen ZIP.')
if(!exactZipHash||!/^[a-f0-9]{64}$/.test(exactZipHash))throw new Error('RELEASE BLOCKED: WAYFINDER_EXACT_ZIP_SHA256 must identify the exact frozen ZIP.')
let windows
try{windows=parseJson(await readFile(resolve(windowsEvidencePath),'utf8'))}catch(e){throw new Error(`RELEASE BLOCKED: native Windows lifecycle evidence could not be read: ${e.message}`)}
if(windows.verdict!=='PASS'||windows.platform!=='win32')throw new Error('RELEASE BLOCKED: lifecycle evidence is not a native Windows PASS.')
if(windows.releaseId!==release.releaseId)throw new Error('RELEASE BLOCKED: Windows lifecycle evidence belongs to a different release.')
if(String(windows.exactZipSha256||'').toLowerCase()!==exactZipHash)throw new Error('RELEASE BLOCKED: Windows lifecycle evidence is not bound to the exact frozen ZIP hash.')
if(windows.criticalHash!==criticalHash)throw new Error('RELEASE BLOCKED: Windows lifecycle evidence is not bound to the same critical source set.')
const packageManifestSha256=sha256(await readFile(join(root,'PACKAGE_INTEGRITY.sha256')))
if(windows.packageManifestSha256!==packageManifestSha256)throw new Error('RELEASE BLOCKED: Windows lifecycle evidence is not bound to this package integrity manifest.')
const requiredChecks=['integrityVerified','launcherUsed','appReachable','backgroundWorkStarted','normalExitUsed','nodeGone','workersGone','portFree','runtimeStateGone','folderRenamed','folderDeleted']
const missingChecks=requiredChecks.filter(k=>windows.checks?.[k]!==true)
if(missingChecks.length)throw new Error(`RELEASE BLOCKED: Windows lifecycle evidence is incomplete: ${missingChecks.join(', ')}`)
if(release.status==='ready_for_user_acceptance')throw new Error('RELEASE BLOCKED: source metadata was pre-promoted before independent exact-package qualification. READY is an output of this gate, not an input.')
console.log(`Release Manager gate PASS — ${release.releaseId} — rendered and native-Windows evidence are hash-bound to the exact package; machine qualification may now publish the traveler artifact as READY FOR USER ACCEPTANCE.`)
