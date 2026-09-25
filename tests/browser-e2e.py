import json,time,requests,websocket,sys,os,urllib.parse
from pathlib import Path

DEBUG=os.environ.get('CHROME_DEBUG','http://127.0.0.1:9222')
APP_URL=os.environ.get('WAYFINDER_BROWSER_URL','http://127.0.0.1:8099/')
if os.environ.get('WAYFINDER_DATA_HARNESS')=='1':
    root=Path(__file__).resolve().parents[1]
    html=(root/'public'/'index.html').read_text(encoding='utf-8')
    storage="""<script>
    (()=>{const read=()=>{try{return JSON.parse(window.name||'{}')}catch{return {}}};
    Object.defineProperty(window,'localStorage',{configurable:true,value:{
      getItem(k){const d=read();return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},
      setItem(k,v){const d=read();d[k]=String(v);window.name=JSON.stringify(d)},
      removeItem(k){const d=read();delete d[k];window.name=JSON.stringify(d)},
      clear(){window.name='{}'}
    }});})();
    </script>"""
    html=html.replace('<head>','<head><base href="http://127.0.0.1:8099/">'+storage,1)
    html=html.replace('href="/styles.css"','href="http://127.0.0.1:8099/styles.css"')
    html=html.replace('src="/app.js"','src="http://127.0.0.1:8099/app.js"')
    APP_URL='data:text/html;charset=utf-8,'+urllib.parse.quote(html)

for _ in range(60):
    try:
        pages=requests.get(DEBUG+'/json',timeout=.3).json()
        page=next((p for p in pages if p.get('type')=='page'),None)
        if page: break
    except Exception: pass
    time.sleep(.1)
else: raise SystemExit('chromium debug unavailable')
ws=websocket.create_connection(page['webSocketDebuggerUrl'],timeout=5)
seq=0

def call(method,params=None):
    global seq
    seq+=1; i=seq
    ws.send(json.dumps({'id':i,'method':method,'params':params or {}}))
    while True:
        msg=json.loads(ws.recv())
        if msg.get('id')==i:
            if 'error' in msg: raise RuntimeError(msg['error'])
            return msg.get('result',{})

def ev(expr,awaitp=False):
    r=call('Runtime.evaluate',{'expression':expr,'returnByValue':True,'awaitPromise':awaitp})
    if r.get('exceptionDetails'): raise RuntimeError(r['exceptionDetails'])
    return r.get('result',{}).get('value')

def wait(expr,timeout=10):
    end=time.time()+timeout
    last=None
    while time.time()<end:
        try:
            last=ev(expr)
            if last:return last
        except Exception as e:last=e
        time.sleep(.1)
    raise AssertionError(f'timeout: {expr}; last={last}')

def bootstrap_app():
    stamp=str(time.time_ns())
    expr=r"""(async()=>{
      const read=()=>{try{return JSON.parse(window.name||'{}')}catch{return {}}};
      Object.defineProperty(window,'localStorage',{configurable:true,value:{
        getItem(k){const d=read();return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},
        setItem(k,v){const d=read();d[k]=String(v);window.name=JSON.stringify(d)},
        removeItem(k){const d=read();delete d[k];window.name=JSON.stringify(d)},
        clear(){window.name='{}'}
      }});
      const t=await fetch('http://127.0.0.1:8099/').then(r=>r.text());
      const d=new DOMParser().parseFromString(t,'text/html');d.querySelectorAll('script').forEach(x=>x.remove());
      document.head.innerHTML=d.head.innerHTML;document.body.innerHTML=d.body.innerHTML;
      const b=document.createElement('base');b.href='http://127.0.0.1:8099/';document.head.prepend(b);
      for(const l of document.querySelectorAll('link[href]'))l.href=new URL(l.getAttribute('href'),b.href).href;
      await import('http://127.0.0.1:8099/app.js?cdp="""+stamp+r"""');
      return true;
    })()"""
    return ev(expr,True)

call('Runtime.enable');call('Page.enable')
if os.environ.get('WAYFINDER_CDP_BOOTSTRAP')=='1':
    ev("window.name='{}';true")
    bootstrap_app()
elif os.environ.get('WAYFINDER_SKIP_NAV')!='1': call('Page.navigate',{'url':APP_URL})
wait("document.readyState==='complete' && document.querySelector('#runtimeBadge')!==null")
wait("document.querySelector('#runtimeBadge').textContent.includes('mock-wayfinder')")

brief="One month around Italy, start and end in Genoa, include Sicily and Bologna, and I prefer buses."
t0=time.time()
ev(f"document.querySelector('#brief').value={json.dumps(brief)};document.querySelector('#sparkBtn').click();true")
wait("document.querySelector('#tripBasicsPanel').hidden===false",2)
basics_elapsed=time.time()-t0
assert basics_elapsed < 2.0, basics_elapsed
assert ev("document.querySelectorAll('.proposal').length")==0
assert ev("document.querySelector('#tripBasicsPrompt').textContent")==brief
assert ev("document.querySelector('#basicsDestination').value")=="Italy"
assert ev("document.querySelector('#basicsStart').value")=="Genoa"
assert ev("document.querySelector('#basicsEnd').value")=="Genoa"
assert ev("document.querySelector('#basicsDuration').value")=="30 days"
assert ev("document.querySelector('#basicsTopology').value")=="loop"
ev("document.querySelector('#confirmBasicsBtn').click();true")
wait("document.querySelectorAll('.proposal').length===3",12)
signals=ev("document.querySelector('#sparkSignals').textContent")
assert 'Start: Genoa' in signals and 'Finish: Genoa' in signals and 'Required: Bologna' in signals,signals
ev("document.querySelector('.proposal button').click();true")
wait("!document.querySelector('#workspace').hidden")
assert ev("document.querySelector('.hero').classList.contains('spark-collapsed')") is True
assert 'SELECTED TRIP CONCEPT' in ev("document.querySelector('#proposals').textContent")
assert 'Show ideas / Change concept' in ev("document.querySelector('#proposals').textContent")
route=ev("[...document.querySelectorAll('#routeEditor .stop-label')].map(x=>x.value)")
assert route[0]=='Genoa' and route[-1]=='Genoa',route
assert 'Bologna' in route and 'Palermo' in route and 'Catania' in route,route
assert 'Sicily' not in route,route
before=route[:]

# Refine keeps the original request and selected route visible, and provides a direct return path to Spark.
ev("document.querySelector('[data-tab=revision]').click();true")
assert ev("document.querySelector('#originalRequestText').textContent") == brief
assert 'Genoa' in ev("document.querySelector('#selectedTripContext').textContent")
assert 'Bologna' not in ev("document.querySelector('#revisionText').getAttribute('placeholder')")
ev("document.querySelector('#refineBackToSparkBtn').click();true")
wait("!document.querySelector('.hero').classList.contains('spark-collapsed')")
assert 'Show ideas / Change concept' not in ev("document.querySelector('#proposals').textContent") or ev("document.querySelectorAll('.proposal').length")>=1
ev("document.querySelector('[data-tab=revision]').click();true")
wait("document.querySelector('.hero').classList.contains('spark-collapsed')")

# Conversational delta revision.
ev("document.querySelector('[data-tab=revision]').click();document.querySelector('#revisionText').value='Add Turin before the final return to Genoa. Keep everything else.';document.querySelector('#revisionBtn').click();true")
wait("document.querySelector('#revisionStatus').classList.contains('ok')",12)
route2=ev("[...document.querySelectorAll('#routeEditor .stop-label')].map(x=>x.value)")
assert route2[-2:] == ['Turin','Genoa'],route2
for x in before: assert x in route2,(x,route2)
assert len(route2)==len(before)+1,(before,route2)

# Resolve with an unconfirmed bus preference; map must remain available, while road routing stays blocked until the traveler confirms a compatible mode.
ev("document.querySelector('[data-tab=precision]').click();document.querySelector('#resolveBtn').click();true")
wait("document.querySelector('#coordinateFact').textContent.includes('/9 resolved')",15)
wait("document.querySelector('#mapCanvas svg')!==null")
assert ev("document.querySelector('#routeMapQuestBtn').disabled") is True
assert 'not traveler-confirmed' in ev("document.querySelector('#mapQuestFact').textContent")

# Load actual local PBF tile background.
ev("document.querySelector('#offlinePbfBtn').click();true")
wait("document.querySelector('#pbfFact').textContent.includes('Offline PBF complete')",8)
assert 'complete' in ev("document.querySelector('#pbfFact').textContent").lower()
assert ev("document.querySelectorAll('#mapCanvas .pbf-layer polyline, #mapCanvas .pbf-layer polygon').length")>0

# Choosing transport later must not make maps disappear.
ev("document.querySelector('[data-tab=precision]').click();document.querySelector('#transportInput').value='Any';document.querySelector('#transportConfirmed').checked=false;document.querySelector('#savePrecisionBtn').click();document.querySelector('[data-tab=mapping]').click();true")
wait("document.querySelector('#mapCanvas svg')!==null")
assert ev("document.querySelector('#googleBtn').classList.contains('disabled')") is True
segment_count=ev("document.querySelectorAll('#mapWarnings a[href*=\"google.com/maps/dir\"]').length")
assert segment_count==0,segment_count
assert ev("document.querySelector('#mapQuestShareBtn').classList.contains('disabled')") is True

# Confirm Car and get provider geometry from MapQuest using the exact same occurrence sequence.
ev("document.querySelector('[data-tab=precision]').click();document.querySelector('#transportInput').value='Car';document.querySelector('#transportConfirmed').checked=true;document.querySelector('#savePrecisionBtn').click();document.querySelector('[data-tab=mapping]').click();true")
wait("document.querySelector('#routeMapQuestBtn').disabled===false")
ev("document.querySelector('#routeMapQuestBtn').click();true")
wait("document.querySelector('#mapQuestFact').textContent.includes('routed geometry points')",8)
assert ev("document.querySelector('#mapCanvas .route-provider')!==null") is True

# Documentation from frozen current authority. Persisted section choices must drive the plan,
# and destination evidence must remain traceable to the deterministic source catalog.
ev("document.querySelector('[data-tab=document]').click();const p=document.querySelector('[data-doc-section=practical]');p.checked=false;p.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#documentBtn').click();true")
wait("document.querySelector('#documentStatus').classList.contains('ok') || document.querySelector('#documentStatus').classList.contains('warn')",10)
doc=ev("document.querySelector('#documentOutput').textContent")
assert 'ROUTE AT A GLANCE' in doc
assert '## Stop-by-stop planning notes' in doc
assert '## Practical preparation' not in doc
assert '## Sources / References' in doc
assert '[S1]' in doc
assert doc.index('Genoa') < doc.index('Bologna') < doc.rindex('Turin') < doc.rindex('Genoa')

# Save/reload preserves revised canonical route and document preferences.
final_route=ev("[...document.querySelectorAll('#routeEditor .stop-label')].map(x=>x.value)")
call('Page.reload',{'ignoreCache':True})
wait("document.readyState==='complete'")
if os.environ.get('WAYFINDER_CDP_BOOTSTRAP')=='1': bootstrap_app()
wait("!document.querySelector('#workspace').hidden")
reload_route=ev("[...document.querySelectorAll('#routeEditor .stop-label')].map(x=>x.value)")
assert reload_route==final_route,(final_route,reload_route)
assert ev("document.querySelector('[data-doc-section=practical]').checked") is False
print(json.dumps({'ok':True,'route':reload_route,'documentChars':len(doc),'pbf':True,'mapquest':True,'citations':True,'documentPreferences':True,'tripBasicsSeconds':round(basics_elapsed,3)}))
ws.close()
