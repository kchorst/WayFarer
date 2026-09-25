import { routeOccurrences } from './authority.js'

function clean(v){return String(v??'').trim()}

export async function gatherTripReferences(authority,{signal,maxStops=8,onProgress=()=>{}}={}){
  const labels=[]
  for(const o of routeOccurrences(authority)){
    const label=clean(o?.place?.label)
    if(label&&!labels.some(x=>x.toLowerCase()===label.toLowerCase()))labels.push(label)
  }
  const selected=labels.slice(0,Math.max(1,maxStops))
  const results=[]
  let cursor=0
  const workers=Array.from({length:Math.min(3,selected.length)},async()=>{
    while(cursor<selected.length){
      if(signal?.aborted)throw new DOMException('Aborted','AbortError')
      const index=cursor++,label=selected[index]
      onProgress(`Local references ${index+1}/${selected.length}: ${label}`)
      try{
        const r=await fetch(`/api/references/search?q=${encodeURIComponent(label)}&category=wikivoyage&limit=1`,{signal})
        if(!r.ok)continue
        const d=await r.json()
        const hit=d?.results?.[0]
        if(hit?.excerpt)results.push({routeLabel:label,title:clean(hit.title)||label,source:clean(hit.source)||'Local reference',url:clean(hit.url),excerpt:clean(hit.excerpt).slice(0,1800)})
      }catch(e){if(e?.name==='AbortError')throw e}
    }
  })
  try{await Promise.all(workers)}catch(error){
    const timedOut=signal?.reason?.name==='TimeoutError'||error?.name==='TimeoutError'
    if(!timedOut)throw error
  }
  onProgress('')
  return results.sort((a,b)=>labels.findIndex(x=>x.toLowerCase()===a.routeLabel.toLowerCase())-labels.findIndex(x=>x.toLowerCase()===b.routeLabel.toLowerCase()))
}
