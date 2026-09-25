import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root=path.dirname(fileURLToPath(import.meta.url))
const skip=new Set(['node_modules','.git'])
const files=[]
function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(skip.has(entry.name))continue
    const full=path.join(dir,entry.name)
    if(entry.isDirectory())walk(full)
    else if(/\.(?:js|mjs)$/i.test(entry.name))files.push(full)
  }
}
walk(root)
for(const file of files.sort()){

  const source=fs.readFileSync(file,'utf8')
  for(let i=0;i<source.length;i++){
    const code=source.charCodeAt(i)
    if(code<32&&code!==9&&code!==10&&code!==13){
      process.stderr.write(`Source hygiene failed: ${path.relative(root,file)} contains control character U+${code.toString(16).padStart(4,'0').toUpperCase()} at offset ${i}.\n`)
      process.exit(1)
    }
  }
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'})
  if(result.status!==0){
    process.stderr.write(`Syntax check failed: ${path.relative(root,file)}\n${result.stderr||result.stdout||''}`)
    process.exit(1)
  }
}
console.log(`Syntax check PASS — ${files.length} JS/MJS files`)
