import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const out=path.join(root,'dist','WAYFINDER')
fs.rmSync(path.join(root,'dist'),{recursive:true,force:true})
fs.mkdirSync(out,{recursive:true})

// Engineering/CI metadata is intentionally not shipped to travelers. Tests are retained
// because exact-package and native-Windows release qualification execute from the package.
const excludeTop=new Set(['.git','.github','.gitignore','engineering','scripts','dist','node_modules','__pycache__'])
const excludeRootFiles=new Set(['development.yml','rendered.yml','release.yml','release-rendered.py','release-rendered-matrix.py','release-rendered-matrix-all.py','run-tests.mjs','stage-release.mjs'])
function copyDir(src,dst,depth=0){
  fs.mkdirSync(dst,{recursive:true})
  for(const ent of fs.readdirSync(src,{withFileTypes:true})){
    if(depth===0&&(excludeTop.has(ent.name)||excludeRootFiles.has(ent.name)))continue
    if(ent.name==='PACKAGE_INTEGRITY.sha256'||ent.name.endsWith('.pyc')||ent.name==='__pycache__')continue
    const a=path.join(src,ent.name),b=path.join(dst,ent.name)
    if(ent.isDirectory())copyDir(a,b,depth+1)
    else if(ent.isFile())fs.copyFileSync(a,b)
  }
}
copyDir(root,out)

// The cross-platform test launcher is required by package.json during exact-package qualification.
// Keep engineering staging utilities out of the traveler package, but ship this one runtime-neutral test entry point.
fs.mkdirSync(path.join(out,'scripts'),{recursive:true})
fs.copyFileSync(path.join(root,'scripts','run-tests.mjs'),path.join(out,'scripts','run-tests.mjs'))

function files(dir,base=dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(ent=>{const full=path.join(dir,ent.name);return ent.isDirectory()?files(full,base):ent.isFile()?[path.relative(base,full).replace(/\\/g,'/')]:[]}).sort()}
const lines=files(out).filter(x=>x!=='PACKAGE_INTEGRITY.sha256').map(rel=>`${crypto.createHash('sha256').update(fs.readFileSync(path.join(out,rel))).digest('hex')}  ${rel}`)
fs.writeFileSync(path.join(out,'PACKAGE_INTEGRITY.sha256'),lines.join('\n')+'\n')
console.log(`Staged ${lines.length} files in ${out}`)
