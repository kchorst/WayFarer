export const INTERACTIVE_LIMIT_MS=120000

export function createDeadline(parentSignal,{ms=INTERACTIVE_LIMIT_MS,label='This action'}={}){
  const controller=new AbortController()
  let timedOut=false
  const onParent=()=>{if(!controller.signal.aborted)controller.abort(parentSignal?.reason||new DOMException('Aborted','AbortError'))}
  if(parentSignal){if(parentSignal.aborted)onParent();else parentSignal.addEventListener('abort',onParent,{once:true})}
  const timer=setTimeout(()=>{timedOut=true;if(!controller.signal.aborted)controller.abort(new DOMException(`${label} reached WAYFINDER's ${Math.round(ms/1000)}-second interactive limit.`,'TimeoutError'))},ms)
  return{signal:controller.signal,get timedOut(){return timedOut},dispose(){clearTimeout(timer);parentSignal?.removeEventListener?.('abort',onParent)}}
}

export function deadlineMessage(error,label='This action'){
  if(error?.name==='TimeoutError'||/interactive limit|timed out|timeout/i.test(String(error?.message||'')))return `${label} stopped at WAYFINDER's 2-minute limit. Useful completed work was preserved where possible.`
  return String(error?.message||error||'Unknown error')
}
