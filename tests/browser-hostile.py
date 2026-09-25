import json,time,requests,websocket,os
DEBUG=os.environ.get('CHROME_DEBUG','http://127.0.0.1:9222')
for _ in range(60):
    try:
        pages=requests.get(DEBUG+'/json',timeout=.3).json();page=next((p for p in pages if p.get('type')=='page'),None)
        if page:break
    except Exception:pass
    time.sleep(.1)
else:raise SystemExit('chromium debug unavailable')
ws=websocket.create_connection(page['webSocketDebuggerUrl'],timeout=5);seq=0

def call(method,params=None):
    global seq
    seq+=1;i=seq;ws.send(json.dumps({'id':i,'method':method,'params':params or {}}))
    while True:
        m=json.loads(ws.recv())
        if m.get('id')==i:
            if 'error' in m:raise RuntimeError(m['error'])
            return m.get('result',{})

def ev(expr,awaitp=False):
    r=call('Runtime.evaluate',{'expression':expr,'returnByValue':True,'awaitPromise':awaitp})
    if r.get('exceptionDetails'):raise RuntimeError(r['exceptionDetails'])
    return r.get('result',{}).get('value')

def wait(expr,timeout=10):
    end=time.time()+timeout;last=None
    while time.time()<end:
        try:
            last=ev(expr)
            if last:return last
        except Exception as e:last=e
        time.sleep(.08)
    raise AssertionError(f'timeout: {expr}; last={last}')

def bootstrap(clear=False):
    if clear:ev("window.name='{}';true")
    stamp=str(time.time_ns())
    expr=r'''(async()=>{const read=()=>{try{return JSON.parse(window.name||'{}')}catch{return {}}};Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem(k){const d=read();return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem(k,v){const d=read();d[k]=String(v);window.name=JSON.stringify(d)},removeItem(k){const d=read();delete d[k];window.name=JSON.stringify(d)},clear(){window.name='{}'}}});const t=await fetch('http://127.0.0.1:8099/').then(r=>r.text());const d=new DOMParser().parseFromString(t,'text/html');d.querySelectorAll('script').forEach(x=>x.remove());document.head.innerHTML=d.head.innerHTML;document.body.innerHTML=d.body.innerHTML;const b=document.createElement('base');b.href='http://127.0.0.1:8099/';document.head.prepend(b);for(const l of document.querySelectorAll('link[href]'))l.href=new URL(l.getAttribute('href'),b.href).href;await import('http://127.0.0.1:8099/app.js?hostile='''+stamp+r'''');return true})()'''
    ev(expr,True);wait("document.querySelector('#runtimeBadge')?.textContent.includes('mock-wayfinder')")

call('Runtime.enable');call('Page.enable');bootstrap(True)
# Build a small canonical route in Precision.
ev("document.querySelector('#blankBtn').click();true");wait("!document.querySelector('#workspace').hidden")
for _ in range(3):ev("document.querySelector('#addStopBtn').click();true")
ev("(()=>{const r=[...document.querySelectorAll('#routeEditor .route-row')];const labels=['Genoa','Bologna','Rome'];r.forEach((x,i)=>{x.querySelector('.stop-label').value=labels[i]});document.querySelector('#topologyInput').value='one_way';document.querySelector('#transportInput').value='Car';document.querySelector('#transportConfirmed').checked=true;document.querySelector('#savePrecisionBtn').click();return true})()")
wait("document.querySelector('#precisionStatus').classList.contains('ok')")
ev("document.querySelector('#resolveBtn').click();true");wait("document.querySelector('#coordinateFact').textContent.includes('3/3 resolved')",12)
# Rename a resolved occurrence without resolving again. Old Bologna coordinates must immediately become unusable.
ev("document.querySelector('[data-tab=precision]').click();(()=>{const r=[...document.querySelectorAll('#routeEditor .route-row')];r[1].querySelector('.stop-label').value='Mystery Stop';document.querySelector('#savePrecisionBtn').click();return true})()")
wait("document.querySelector('#precisionStatus').classList.contains('ok')")
ev("document.querySelector('[data-tab=mapping]').click();true")
wait("document.querySelector('#coordinateFact').textContent.includes('2/3 resolved')")
assert ev("document.querySelectorAll('#mapCanvas .pin').length")==2
assert ev("document.querySelectorAll('#mapCanvas .route-overview').length")==0
assert ev("document.querySelector('#googleBtn').classList.contains('disabled')") is True
# Put Bologna back, resolve, then start a delayed MapQuest request and mutate authority while it is in flight.
ev("document.querySelector('[data-tab=precision]').click();(()=>{const r=[...document.querySelectorAll('#routeEditor .route-row')];r[1].querySelector('.stop-label').value='Bologna';document.querySelector('#savePrecisionBtn').click();return true})()")
wait("document.querySelector('#precisionStatus').classList.contains('ok')")
ev("document.querySelector('#resolveBtn').click();true");wait("document.querySelector('#coordinateFact').textContent.includes('3/3 resolved')",12)
wait("document.querySelector('#routeMapQuestBtn').disabled===false")
ev("document.querySelector('#routeMapQuestBtn').click();true")
time.sleep(.08)
ev("document.querySelector('[data-tab=precision]').click();(()=>{const r=[...document.querySelectorAll('#routeEditor .route-row')];r[1].querySelector('.stop-label').value='Turin';document.querySelector('#savePrecisionBtn').click();document.querySelector('[data-tab=mapping]').click();return true})()")
wait("document.querySelector('#mapWarnings').textContent.includes('became stale')",10)
assert ev("document.querySelector('#mapCanvas .route-provider')===null") is True
# Hostile boundary/topology case: an old loop must be able to become a flexible Tallinn-to-Riga route atomically.
bootstrap(True)
ev("document.querySelector('#blankBtn').click();true");wait("!document.querySelector('#workspace').hidden")
for _ in range(3):ev("document.querySelector('#addStopBtn').click();true")
ev("(()=>{const r=[...document.querySelectorAll('#routeEditor .route-row')];['Tallinn','Tartu','Tallinn'].forEach((v,i)=>r[i].querySelector('.stop-label').value=v);document.querySelector('#topologyInput').value='loop';document.querySelector('#savePrecisionBtn').click();return true})()")
wait("document.querySelector('#precisionStatus').classList.contains('ok')")
ev("(()=>{const r=[...document.querySelectorAll('#routeEditor .route-row')];r[2].querySelector('.stop-label').value='Riga';document.querySelector('#topologyInput').value='flexible';document.querySelector('#savePrecisionBtn').click();return true})()")
wait("document.querySelector('#precisionStatus').classList.contains('ok')")
assert ev("[...document.querySelectorAll('#routeEditor .stop-label')].map(x=>x.value).join('>')")=="Tallinn>Tartu>Riga"
assert ev("document.querySelector('#topologyInput').value")=="flexible"
assert 'Tallinn' in ev("document.querySelector('#precisionBoundarySummary').textContent") and 'Riga' in ev("document.querySelector('#precisionBoundarySummary').textContent")
print(json.dumps({'ok':True,'renameInvalidated':True,'gapNotBridged':True,'staleProviderDiscarded':True,'loopToFlexibleAtomic':True}))
ws.close()
