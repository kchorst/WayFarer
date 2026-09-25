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
const excludeTop=new Set(['.git','.github','engineering','scripts','dist','node_modules','__pycache__'])
function copyDir(src,dst,depth=0){
  fs.mkdirSync(dst,{recursive:true})
  for(const ent of fs.readdirSync(src,{withFileTypes:true})){
    if(depth===0&&excludeTop.has(ent.name))continue
    if(ent.name==='PACKAGE_INTEGRITY.sha256'||ent.name.endsWith('.pyc')||ent.name==='__pycache__')continue
    const a=path.join(src,ent.name),b=path.join(dst,ent.name)
    if(ent.isDirectory())copyDir(a,b,depth+1)
    else if(ent.isFile())fs.copyFileSync(a,b)
  }
}
copyDir(root,out)

function files(dir,base=dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(ent=>{const full=path.join(dir,ent.name);return ent.isDirectory()?files(full,base):ent.isFile()?[path.relative(base,full).replace(/\\/g,'/')]:[]}).sort()}
const lines=files(out).filter(x=>x!=='PACKAGE_INTEGRITY.sha256').map(rel=>`${crypto.createHash('sha256').update(fs.readFileSync(path.join(out,rel))).digest('hex')}  ${rel}`)
fs.writeFileSync(path.join(out,'PACKAGE_INTEGRITY.sha256'),lines.join('\n')+'\n')
console.log(`Staged ${lines.length} files in ${out}`)
