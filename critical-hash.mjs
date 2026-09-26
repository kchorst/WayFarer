import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function computeCriticalHash(rootDir){
  const root=resolve(rootDir||fileURLToPath(new URL('.',import.meta.url)))
  const manifest=JSON.parse(String(await readFile(join(root,'RELEASE_CRITICAL_FILES.json'),'utf8')).replace(/^\uFEFF/,''))
  const hash=createHash('sha256')
  for(const rel of manifest.files||[]){
    hash.update(rel+'\0')
    hash.update(await readFile(join(root,rel)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.stdout.write(await computeCriticalHash(process.argv[2]))
}
