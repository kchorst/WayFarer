import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root=path.dirname(fileURLToPath(import.meta.url))

function packageFiles(dir,base=dir){
  const out=[]
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='node_modules'||entry.name==='.git'||entry.name==='__pycache__')continue
    const full=path.join(dir,entry.name)
    if(entry.isDirectory())out.push(...packageFiles(full,base))
    else if(entry.isFile()&&entry.name!=='PACKAGE_INTEGRITY.sha256'&&!entry.name.endsWith('.pyc'))out.push(path.relative(base,full).replace(/\\/g,'/'))
  }
  return out.sort()
}
const manifest=path.join(root,'PACKAGE_INTEGRITY.sha256')
if(!fs.existsSync(manifest)){console.error('PACKAGE_INTEGRITY.sha256 is missing.');process.exit(1)}
const lines=fs.readFileSync(manifest,'utf8').split(/\r?\n/).map(x=>x.trim()).filter(Boolean)
const manifestFiles=[]
let checked=0
for(const line of lines){
  const m=line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
  if(!m){console.error(`Malformed checksum line: ${line}`);process.exit(1)}
  const expected=m[1].toLowerCase(),rel=m[2].replace(/\\/g,'/'),full=path.resolve(root,rel)
  manifestFiles.push(rel)
  if(!full.startsWith(root+path.sep)||!fs.existsSync(full)||!fs.statSync(full).isFile()){console.error(`Missing/invalid manifest file: ${rel}`);process.exit(1)}
  const actual=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
  if(actual!==expected){console.error(`Checksum mismatch: ${rel}`);process.exit(1)}
  checked++
}
const actualFiles=packageFiles(root)
const listed=[...manifestFiles].sort()
const missing=actualFiles.filter(x=>!listed.includes(x))
const stale=listed.filter(x=>!actualFiles.includes(x))
if(missing.length||stale.length){
  if(missing.length)console.error(`Unmanifested package files: ${missing.join(', ')}`)
  if(stale.length)console.error(`Manifest lists non-package files: ${stale.join(', ')}`)
  process.exit(1)
}
console.log(`Integrity PASS — ${checked} files; manifest covers the complete package tree`)
