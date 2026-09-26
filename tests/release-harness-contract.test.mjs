import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read=rel=>fs.readFileSync(path.join(ROOT,rel),'utf8')
const exists=rel=>fs.existsSync(path.join(ROOT,rel))

test('rendered harness is platform-neutral and explicit about text encoding',()=>{
  for(const rel of ['tests/release-rendered.py','tests/release-rendered-matrix.py','tests/release-rendered-matrix-all.py']){
    const src=read(rel)
    assert.doesNotMatch(src,/executable_path\s*=\s*['"]\/usr\/bin\/chromium['"]/i,`${rel} must not hard-code Linux Chromium`)
    for(const line of src.split(/\r?\n/)){
      if(line.includes('.read_text(')) assert.match(line,/encoding=['"]utf-8['"]/,`${rel} read_text must declare UTF-8`)
      if(line.includes('.write_text(')) assert.match(line,/encoding=['"]utf-8['"]/,`${rel} write_text must declare UTF-8`)
    }
  }
})

test('documentation degraded oracle waits for action completion rather than baseline text',()=>{
  const src=read('tests/release-rendered-matrix.py')
  const start=src.indexOf('def document_degraded')
  const end=src.indexOf('def document_navigation',start)
  assert.ok(start>=0&&end>start)
  const block=src.slice(start,end)
  assert.match(block,/!document\.querySelector\('#documentBtn'\)\.disabled/)
  assert.match(block,/classList\.contains\('warn'\)/)
  assert.match(block,/degraded/)
  assert.match(block,/fallback/)
})

test('exact-package staging retains the cross-platform test runner',()=>{
  assert.equal(exists('scripts/run-tests.mjs'),true)
  if(exists('scripts/stage-release.mjs')){
    const stage=read('scripts/stage-release.mjs')
    assert.match(stage,/scripts['"],['"]run-tests\.mjs/)
  }
})

test('release staging ignores noncanonical root copies from browser uploads',()=>{
  const noncanonical=['development.yml','rendered.yml','release.yml','release-rendered.py','release-rendered-matrix.py','release-rendered-matrix-all.py','run-tests.mjs','stage-release.mjs']
  if(exists('scripts/stage-release.mjs')){
    const stage=read('scripts/stage-release.mjs')
    for(const rel of noncanonical){
      assert.match(stage,new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`stage must ignore noncanonical root copy: ${rel}`)
    }
  }else{
    for(const rel of noncanonical) assert.equal(exists(rel),false,`package must not contain noncanonical root copy: ${rel}`)
  }
})

test('supported Node runtime contract is consistent with the Windows launcher',()=>{
  const pkg=JSON.parse(read('package.json'))
  assert.equal(pkg.engines?.node,'>=20')
  assert.equal(pkg.version,JSON.parse(read('RELEASE.json')).version,'package.json and RELEASE.json versions must match')
  const release=JSON.parse(read('RELEASE.json'))
  assert.match(read('AUDIT_STATUS.md'),new RegExp(release.releaseId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'AUDIT_STATUS.md must name the current release')
  assert.match(read('WAYFINDER.cmd'),/requires Node\.js 20 or newer/i)
  assert.match(read('USER_GUIDE.md'),/Node\.js 20\+/i)
})

test('traveler verification is local package verification, not CI release certification',()=>{
  const cmd=read('VERIFY-WAYFINDER.cmd')
  assert.match(cmd,/npm run package:verify/i)
  assert.doesNotMatch(cmd,/release:check/i)
})

test('source workflows catch platform drift before frozen release qualification',()=>{
  if(!exists('.github/workflows/development.yml')) return
  const dev=read('.github/workflows/development.yml')
  const rendered=read('.github/workflows/rendered.yml')
  const release=read('.github/workflows/release.yml')
  for(const src of [dev,rendered,release]) assert.match(src,/actions\/checkout@v7/)
  assert.match(dev,/node:\s*\['20', '24'\]/)
  assert.match(rendered,/ubuntu-latest, windows-latest/)
  assert.match(rendered,/runner\.os == 'Windows'/)
  assert.match(rendered,/playwright==1\.57\.0/)
  assert.match(release,/playwright==1\.57\.0/)
  assert.match(release,/runs-on:\s*windows-latest/)
  assert.match(release,/Require main branch/)
  assert.match(release,/Hash exact candidate ZIP/)
  assert.match(release,/npm run package:verify/)
  assert.match(release,/QUALIFICATION\.json/)
  assert.match(release,/windows-evidence\.json/)
  assert.match(release,/packageManifestSha256/)
  assert.match(release,/criticalHash/)
  assert.match(dev,/cancel-in-progress: true/)
  assert.match(rendered,/cancel-in-progress: true/)
})

test('critical-source manifest covers the complete staged source contract except generated evidence',()=>{
  const manifest=JSON.parse(read('RELEASE_CRITICAL_FILES.json'))
  const listed=new Set(manifest.files||[])
  const excludedTop=new Set(['.git','.github','.gitignore','engineering','scripts','dist','node_modules','__pycache__'])
  const generated=new Set(['PACKAGE_INTEGRITY.sha256','RENDERED_ACCEPTANCE.json','RENDERED_VARIANT_EVIDENCE.json'])
  const noncanonicalRoot=new Set(['development.yml','rendered.yml','release.yml','release-rendered.py','release-rendered-matrix.py','release-rendered-matrix-all.py','run-tests.mjs','stage-release.mjs'])
  const walk=(dir,base=ROOT)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(ent=>{
    const full=path.join(dir,ent.name),rel=path.relative(base,full).replace(/\\/g,'/')
    if(dir===ROOT&&(excludedTop.has(ent.name)||noncanonicalRoot.has(ent.name))) return []
    if(ent.isDirectory()) return walk(full,base)
    if(!ent.isFile()||generated.has(ent.name)||ent.name.endsWith('.pyc')) return []
    return [rel]
  })
  const expected=new Set(walk(ROOT))
  expected.add('scripts/run-tests.mjs')
  assert.deepEqual([...listed].sort(),[...expected].sort())
})

test('Windows qualification is legacy-parser safe, writes BOM-free lifecycle evidence, and isolates per-run map cache',()=>{
  const ps=read('tests/windows-lifecycle-native.ps1')
  assert.match(ps,/UTF8Encoding\(\$false\)/)
  assert.match(ps,/\$env:APPDATA=\$appData/)
  assert.match(ps,/starting','working','ready/)
  assert.equal([...ps].some(ch=>ch.codePointAt(0)>127),false,'native Windows lifecycle script must remain ASCII-safe for Windows PowerShell 5.1 re-entry')
  assert.doesNotMatch(ps,/powershell\.exe/i,'native lifecycle must re-enter through the current PowerShell host, not force Windows PowerShell 5.1')
  assert.match(ps,/\(Get-Process -Id \$PID\)\.Path/)
  assert.doesNotMatch(ps,/^\s*\$launcher\s*=\s*Start-Process[^\r\n]*-Wait/im,'native lifecycle must not tree-wait on WAYFINDER.cmd because the launcher intentionally leaves the server running')
  assert.match(ps,/\$launcher\.WaitForExit\(20000\)/,'native lifecycle must wait only for the launcher process itself')
  if(exists('.github/workflows/release.yml')){
    const release=read('.github/workflows/release.yml')
    assert.doesNotMatch(release,/^\s*powershell(?:\.exe)?\s+-NoProfile.*windows-lifecycle-native\.ps1/im,'release workflow must not nest legacy Windows PowerShell for the lifecycle entrypoint')
    assert.match(release,/& \.\\tests\\windows-lifecycle-native\.ps1/)
  }
})
