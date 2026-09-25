export function createSentenceAccumulator(onText=()=>{}){
  let raw='',safe=''
  const boundary=/[.!?](?:[\"'”’)]*)\s+/g
  function push(token){
    raw+=token
    let last=-1,m
    boundary.lastIndex=0
    while((m=boundary.exec(raw))!==null)last=m.index+m[0].length
    if(last>0){safe=raw.slice(0,last).trimEnd();onText(raw)} else onText(raw)
  }
  function finish({partial=false}={}){
    const trimmed=raw.trim()
    if(!partial)return trimmed
    if(/[.!?][\"'”’)]*$/.test(trimmed))return trimmed
    return safe.trim()
  }
  return {push,finish,getRaw:()=>raw}
}
