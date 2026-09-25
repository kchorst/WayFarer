from playwright.sync_api import sync_playwright
from pathlib import Path
import re,posixpath,json,hashlib,time,sys,traceback,os

ROOT=Path(__file__).resolve().parents[1]

def launch_chromium(pw):
    override=os.environ.get('WAYFINDER_CHROMIUM_EXECUTABLE','').strip()
    options={'headless':True,'args':['--no-sandbox']}
    if override: options['executable_path']=override
    return pw.chromium.launch(**options)
PUB=ROOT/'public'
RELEASE=json.loads((ROOT/'RELEASE.json').read_text(encoding='utf-8'))
ACCEPTANCE=json.loads((ROOT/'ACCEPTANCE_JOURNEYS.json').read_text(encoding='utf-8'))
CRITICAL=json.loads((ROOT/'RELEASE_CRITICAL_FILES.json').read_text(encoding='utf-8'))['files']

def critical_hash():
    h=hashlib.sha256()
    for rel in CRITICAL:
        h.update(rel.encode());h.update(b'\0');h.update((ROOT/rel).read_bytes());h.update(b'\0')
    return h.hexdigest()

html=(PUB/'index.html').read_text(encoding='utf-8')
html=re.sub(r'<link[^>]+href="/styles\.css"[^>]*>',f'<style>{(PUB/"styles.css").read_text(encoding='utf-8')}</style>',html)
html=re.sub(r'<script type="module" src="/app\.js"></script>','',html)
mods={p.relative_to(PUB).as_posix():p.read_text(encoding='utf-8') for p in [PUB/'app.js',*list((PUB/'core').glob('*.js'))]}
imp_re=re.compile(r"(from\s+['\"])(\.?\.?/[^'\"]+)(['\"])")

def deps(rel):
    return [posixpath.normpath(posixpath.join(posixpath.dirname(rel),m.group(2))) for m in imp_re.finditer(mods[rel])]
order=[];seen=set()
def visit(rel):
    if rel in seen:return
    seen.add(rel)
    for d in deps(rel):visit(d)
    order.append(rel)
visit('app.js')

MOCK_FETCH=r'''()=>{
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const jsonResponse=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json'}});
  const sseResponse=(objects,step=90,initialDelay=0,signal=null)=>{const enc=new TextEncoder(),timers=[];let closed=false;const cleanup=()=>{while(timers.length)clearTimeout(timers.pop());signal?.removeEventListener?.('abort',onAbort)},onAbort=()=>{if(closed)return;closed=true;cleanup()};return new Response(new ReadableStream({start(c){if(signal?.aborted){closed=true;return c.error(signal.reason||new DOMException('Aborted','AbortError'))}signal?.addEventListener?.('abort',()=>{if(closed)return;closed=true;cleanup();try{c.error(signal.reason||new DOMException('Aborted','AbortError'))}catch{}},{once:true});objects.forEach((obj,i)=>timers.push(setTimeout(()=>{if(!closed)c.enqueue(enc.encode(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(obj)+'\n'}}]})}\n\n`))},initialDelay+i*step)));timers.push(setTimeout(()=>{if(closed)return;closed=true;cleanup();c.enqueue(enc.encode('data: [DONE]\n\n'));c.close()},initialDelay+objects.length*step+20))},cancel(){closed=true;cleanup()}}),{status:200,headers:{'Content-Type':'text/event-stream'}})};
  const doneStream=()=>{const enc=new TextEncoder();return new Response(new ReadableStream({start(c){c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));c.close()}}),{status:200,headers:{'Content-Type':'text/event-stream'}})};
  const proposal=(title,stops,topology='loop',days=14)=>({title,summary:`${title} complete route`,stops:stops.map(label=>({label,kind:'settlement'})),days,topology,themes:['local culture']});
  const extraction=prompt=>{
    const p=prompt.toLowerCase();
    if(p.includes('shikoku'))return {scopes:[{kind:'region',label:'Shikoku, Japan'}],experiences:{preferred:['walking','pilgrimage']}};
    if(p.includes('sicily')){const x={duration:{kind:'exact',days:21},topology:'loop',scopes:[{kind:'region',label:'Sicily'}]};if(p.includes('palermo')){x.start='Palermo';x.end='Palermo'}return x}
    if(p.includes('crete'))return {topology:'loop',scopes:[{kind:'region',label:'Crete'}]};
    if(p.includes('paris')&&p.includes('london'))return {start:'Paris',end:'London',topology:'one_way'};
    if(p.includes('lisbon')&&p.includes('madrid'))return {start:'Lisbon',end:'Madrid',duration:{kind:'exact',days:12},topology:'one_way',requiredPlaces:['Portugal','Spain'],scopes:[{kind:'country',label:'Portugal'},{kind:'country',label:'Spain'}]};
    if(p.includes('madeira'))return {scopes:[{kind:'island',label:'Madeira'}]};
    if(p.includes('estonia')&&p.includes('latvia')&&p.includes('lithuania'))return {start:'Tallinn',end:'Riga',duration:{kind:'exact',days:35},topology:'one_way',requiredPlaces:['Estonia','Latvia','Lithuania']};
    if(p.includes('sardinia')&&p.includes('corsica'))return {duration:{kind:'exact',days:21},scopes:[{kind:'region',label:'Sardinia'},{kind:'region',label:'Corsica'}],transport:{primaryMode:'Mixed'},experiences:{preferred:['coast','islands']}};
    if(p.includes('jamaica'))return {duration:{kind:'exact',days:14},scopes:[{kind:'country',label:'Jamaica',countryCode:'JM',requiredCoverage:true}]};
    if(p.includes('corsica'))return {scopes:[{kind:'region',label:'Corsica'}],experiences:{preferred:['coast','mountains']}};
    return {};
  };
  const sparkFor=text=>{
    const t=text.toLowerCase();
    if(t.includes('sardinia')&&t.includes('corsica'))return [proposal('Sardinia and Corsica',['Cagliari','Alghero','Bonifacio','Ajaccio'],'one_way',21),proposal('Two-Island Journey',['Olbia','Santa Teresa Gallura','Bonifacio','Corte','Bastia'],'one_way',21),proposal('Island Pair',['Cagliari','Olbia','Bonifacio','Ajaccio','Bastia'],'one_way',21)];
    if(t.includes('jamaica'))return [proposal('Jamaica Highlights',['Kingston','Ocho Rios','Montego Bay'],'flexible',14),proposal('Jamaica Coast and Culture',['Kingston','Port Antonio','Negril'],'flexible',14),proposal('Jamaica East to West',['Port Antonio','Ocho Rios','Montego Bay','Negril'],'flexible',14)];
    if(t.includes('corsica'))return [proposal('Corsica Coast',['Ajaccio','Saint-Tropez','Bastia'],'one_way',10),proposal('Corsica North & South',['Ajaccio','Bonifacio','Corte','Bastia'],'one_way',10),proposal('Corsica Loop',['Ajaccio','Calvi','Corte','Bonifacio','Ajaccio'],'loop',12)];
    if(t.includes('shikoku'))return [proposal('Traditional Shikoku Pilgrimage',['Temple 1 — Ryōzenji','Tokushima','Kochi','Matsuyama','Temple 88 — Ōkuboji'],'one_way',30),proposal('Shikoku Pilgrimage Focus',['Temple 1 — Ryōzenji','Tokushima','Kochi','Takamatsu','Temple 88 — Ōkuboji'],'one_way',35),proposal('Shikoku Walking Journey',['Temple 1 — Ryōzenji','Anan','Kochi','Matsuyama','Temple 88 — Ōkuboji'],'one_way',40)];
    if(t.includes('sicily'))return [proposal('Western Sicily Loop',['Palermo','Trapani','Agrigento','Palermo'],'loop',21),proposal('Classic Sicily Loop',['Palermo','Cefalù','Taormina','Syracuse','Ragusa','Agrigento','Palermo'],'loop',21),proposal('Eastern Sicily Loop',['Catania','Taormina','Syracuse','Noto','Ragusa','Catania'],'loop',21)];
    if(t.includes('crete'))return [proposal('Western Crete Loop',['Chania','Kissamos','Rethymno','Chania'],'loop',10),proposal('Central Crete Loop',['Heraklion','Matala','Rethymno','Heraklion'],'loop',9),proposal('Eastern Crete Loop',['Heraklion','Agios Nikolaos','Sitia','Heraklion'],'loop',11)];
    if(t.includes('paris')&&t.includes('london'))return [proposal('Paris to London',['Paris','Rouen','Lille','London'],'one_way',7),proposal('Paris to London via Coast',['Paris','Amiens','Calais','London'],'one_way',6),proposal('Paris to London Cities',['Paris','Reims','Lille','London'],'one_way',8)];
    if(t.includes('lisbon')&&t.includes('madrid'))return [
      proposal('Iberian Loop',['Lisbon','Portugal','Lisbon','Madrid'],'loop',12),
      proposal('Atlantic to Castile',['Lisbon','Coimbra','Porto','Salamanca','Madrid'],'one_way',12),
      proposal('Iberian Heritage Route',['Lisbon','Évora','Mérida','Toledo','Madrid'],'one_way',12),
      proposal('Portugal and Spain',['Lisbon','Coimbra','Cáceres','Madrid'],'one_way',12)
    ];
    if(t.includes('madeira'))return [
      proposal('Madeira Mystery',['Funchal','Unknown Village','Funchal'],'loop',7),
      proposal('Madeira North and South',['Funchal','Santana','Machico','Funchal'],'loop',7),
      proposal('Madeira Highlands',['Funchal','Curral das Freiras','Santana','Funchal'],'loop',8),
      proposal('Madeira Coast',['Funchal','Câmara de Lobos','Porto Moniz','Funchal'],'loop',7)
    ];
    if(t.includes('estonia')&&t.includes('latvia')&&t.includes('lithuania'))return [
      proposal('Estonia, Latvia, Lithuania Loop',['Tallinn','Vilnius','Tallinn','Estonia','Latvia','Lithuania','Riga'],'loop',35),
      proposal('Baltic Capitals and Coast',['Tallinn','Tartu','Vilnius','Kaunas','Klaipėda','Liepāja','Riga'],'one_way',35),
      proposal('Baltic Culture Route',['Tallinn','Pärnu','Vilnius','Kaunas','Šiauliai','Cēsis','Riga'],'one_way',35),
      proposal('Baltic Cities and Nature',['Tallinn','Tartu','Kaunas','Vilnius','Klaipėda','Kuldīga','Riga'],'one_way',35)
    ];
    return [proposal('Idea A',['Alpha','Beta'],'one_way',5),proposal('Idea B',['Alpha','Gamma'],'one_way',5),proposal('Idea C',['Alpha','Delta'],'one_way',5)];
  };
  const geo={
    'jamaica':[{label:'Jamaica',lat:18.11,lon:-77.30,countryCode:'JM'}],
    'kingston':[{label:'Kingston, Jamaica',lat:17.97,lon:-76.79,countryCode:'JM'}],
    'ocho rios':[{label:'Ocho Rios, Jamaica',lat:18.41,lon:-77.10,countryCode:'JM'}],
    'montego bay':[{label:'Montego Bay, Jamaica',lat:18.47,lon:-77.92,countryCode:'JM'}],
    'port antonio':[{label:'Port Antonio, Jamaica',lat:18.18,lon:-76.45,countryCode:'JM'}],
    'negril':[{label:'Negril, Jamaica',lat:18.27,lon:-78.35,countryCode:'JM'}],
    'sardinia':[{label:'Sardegna, Italia',lat:40.12,lon:9.01,countryCode:'IT'}],
    'cagliari':[{label:'Cagliari, Sardegna, Italia',lat:39.22,lon:9.12,countryCode:'IT'}],
    'alghero':[{label:'Alghero, Sardegna, Italia',lat:40.56,lon:8.32,countryCode:'IT'}],
    'olbia':[{label:'Olbia, Sardegna, Italia',lat:40.92,lon:9.50,countryCode:'IT'}],
    'santa teresa gallura':[{label:'Santa Teresa Gallura, Sardegna, Italia',lat:41.24,lon:9.19,countryCode:'IT'}],
    'corsica':[{label:'Corse, France',lat:42.1,lon:9,countryCode:'FR'}],
    'ajaccio':[{label:'Ajaccio, Corse-du-Sud, Corse, France',lat:41.92,lon:8.74,countryCode:'FR'}],
    'bastia':[{label:'Bastia, Haute-Corse, Corse, France',lat:42.70,lon:9.45,countryCode:'FR'}],
    'bonifacio':[{label:'Bonifacio, Corse-du-Sud, Corse, France',lat:41.39,lon:9.16,countryCode:'FR'}],
    'corte':[{label:'Corte, Haute-Corse, Corse, France',lat:42.30,lon:9.15,countryCode:'FR'}],
    'calvi':[{label:'Calvi, Haute-Corse, Corse, France',lat:42.57,lon:8.76,countryCode:'FR'}],
    'saint-tropez':[{label:'Saint-Tropez, Var, Provence-Alpes-Côte d’Azur, France',lat:43.27,lon:6.64,countryCode:'FR'}],
    'sicily':[{label:'Sicilia, Italia',lat:37.6,lon:14.0,countryCode:'IT'}],
    'palermo':[{label:'Palermo, Sicilia, Italia',lat:38.12,lon:13.36,countryCode:'IT'}],
    'trapani':[{label:'Trapani, Sicilia, Italia',lat:38.02,lon:12.51,countryCode:'IT'}],
    'agrigento':[{label:'Agrigento, Sicilia, Italia',lat:37.31,lon:13.58,countryCode:'IT'}],
    'cefalu':[{label:'Cefalù, Sicilia, Italia',lat:38.04,lon:14.02,countryCode:'IT'}],
    'cefalù':[{label:'Cefalù, Sicilia, Italia',lat:38.04,lon:14.02,countryCode:'IT'}],
    'taormina':[{label:'Taormina, Sicilia, Italia',lat:37.85,lon:15.29,countryCode:'IT'}],
    'syracuse':[{label:'Siracusa, Sicilia, Italia',lat:37.07,lon:15.29,countryCode:'IT'}],
    'ragusa':[{label:'Ragusa, Sicilia, Italia',lat:36.93,lon:14.73,countryCode:'IT'}],
    'catania':[{label:'Catania, Sicilia, Italia',lat:37.50,lon:15.09,countryCode:'IT'}],
    'noto':[{label:'Noto, Sicilia, Italia',lat:36.89,lon:15.07,countryCode:'IT'}],
    'crete':[{label:'Crete, Greece',lat:35.24,lon:24.81,countryCode:'GR'}],
    'chania':[{label:'Chania, Crete, Greece',lat:35.51,lon:24.02,countryCode:'GR'}],
    'kissamos':[{label:'Kissamos, Crete, Greece',lat:35.49,lon:23.65,countryCode:'GR'}],
    'rethymno':[{label:'Rethymno, Crete, Greece',lat:35.37,lon:24.48,countryCode:'GR'}],
    'heraklion':[{label:'Heraklion, Crete, Greece',lat:35.34,lon:25.13,countryCode:'GR'}],
    'matala':[{label:'Matala, Crete, Greece',lat:34.99,lon:24.75,countryCode:'GR'}],
    'agios nikolaos':[{label:'Agios Nikolaos, Crete, Greece',lat:35.19,lon:25.72,countryCode:'GR'}],
    'sitia':[{label:'Sitia, Crete, Greece',lat:35.21,lon:26.10,countryCode:'GR'}],
    'shikoku, japan':[{label:'Shikoku, Japan',lat:33.75,lon:133.5,countryCode:'JP'}],
    'tokushima':[{label:'Tokushima, Shikoku, Japan',lat:34.07,lon:134.55,countryCode:'JP'}],
    'kochi':[{label:'Kochi, Shikoku, Japan',lat:33.56,lon:133.53,countryCode:'JP'}],
    'matsuyama':[{label:'Matsuyama, Shikoku, Japan',lat:33.84,lon:132.77,countryCode:'JP'}],
    'takamatsu':[{label:'Takamatsu, Shikoku, Japan',lat:34.34,lon:134.05,countryCode:'JP'}],
    'anan':[{label:'Anan, Shikoku, Japan',lat:33.92,lon:134.66,countryCode:'JP'}],
    'paris':[{label:'Paris, France',lat:48.85,lon:2.35,countryCode:'FR'}],
    'rouen':[{label:'Rouen, France',lat:49.44,lon:1.10,countryCode:'FR'}],
    'lille':[{label:'Lille, France',lat:50.63,lon:3.06,countryCode:'FR'}],
    'london':[{label:'London, England, United Kingdom',lat:51.50,lon:-0.12,countryCode:'GB'}],
    'amiens':[{label:'Amiens, France',lat:49.89,lon:2.30,countryCode:'FR'}],
    'calais':[{label:'Calais, France',lat:50.95,lon:1.86,countryCode:'FR'}],
    'reims':[{label:'Reims, France',lat:49.26,lon:4.03,countryCode:'FR'}],
    'portugal':[{label:'Portugal',lat:39.5,lon:-8.0,countryCode:'PT'}],
    'spain':[{label:'Spain',lat:40.4,lon:-3.7,countryCode:'ES'}],
    'lisbon':[{label:'Lisbon, Portugal',lat:38.72,lon:-9.14,countryCode:'PT'}],
    'coimbra':[{label:'Coimbra, Portugal',lat:40.21,lon:-8.43,countryCode:'PT'}],
    'porto':[{label:'Porto, Portugal',lat:41.15,lon:-8.61,countryCode:'PT'}],
    'salamança':[{label:'Salamanca, Spain',lat:40.97,lon:-5.66,countryCode:'ES'}],
    'salamanca':[{label:'Salamanca, Spain',lat:40.97,lon:-5.66,countryCode:'ES'}],
    'madrid':[{label:'Madrid, Spain',lat:40.42,lon:-3.70,countryCode:'ES'}],
    'évora':[{label:'Évora, Portugal',lat:38.57,lon:-7.91,countryCode:'PT'}],
    'mérida':[{label:'Mérida, Spain',lat:38.92,lon:-6.34,countryCode:'ES'}],
    'toledo':[{label:'Toledo, Spain',lat:39.86,lon:-4.03,countryCode:'ES'}],
    'cáceres':[{label:'Cáceres, Spain',lat:39.47,lon:-6.37,countryCode:'ES'}],
    'madeira':[{label:'Madeira, Portugal',lat:32.76,lon:-16.96,countryCode:'PT'}],
    'funchal':[{label:'Funchal, Madeira, Portugal',lat:32.65,lon:-16.91,countryCode:'PT'}],
    'santana':[{label:'Santana, Madeira, Portugal',lat:32.80,lon:-16.88,countryCode:'PT'}],
    'machico':[{label:'Machico, Madeira, Portugal',lat:32.72,lon:-16.77,countryCode:'PT'}],
    'curral das freiras':[{label:'Curral das Freiras, Madeira, Portugal',lat:32.72,lon:-16.97,countryCode:'PT'}],
    'câmara de lobos':[{label:'Câmara de Lobos, Madeira, Portugal',lat:32.65,lon:-16.97,countryCode:'PT'}],
    'porto moniz':[{label:'Porto Moniz, Madeira, Portugal',lat:32.87,lon:-17.17,countryCode:'PT'}],
    'propriano':[{label:'Propriano, Corse-du-Sud, Corse, France',lat:41.68,lon:8.90,countryCode:'FR'}],
    'tallinn':[{label:'Tallinn, Estonia',lat:59.44,lon:24.75,countryCode:'EE'}],
    'tartu':[{label:'Tartu, Estonia',lat:58.38,lon:26.72,countryCode:'EE'}],
    'riga':[{label:'Riga, Latvia',lat:56.95,lon:24.11,countryCode:'LV'}],
    'estonia':[{label:'Estonia',lat:58.6,lon:25.0,countryCode:'EE'}],
    'latvia':[{label:'Latvia',lat:56.9,lon:24.6,countryCode:'LV'}],
    'lithuania':[{label:'Lithuania',lat:55.2,lon:23.9,countryCode:'LT'}],
    'pärnu':[{label:'Pärnu, Estonia',lat:58.39,lon:24.50,countryCode:'EE'}],
    'vilnius':[{label:'Vilnius, Lithuania',lat:54.69,lon:25.28,countryCode:'LT'}],
    'kaunas':[{label:'Kaunas, Lithuania',lat:54.90,lon:23.90,countryCode:'LT'}],
    'klaipėda':[{label:'Klaipėda, Lithuania',lat:55.70,lon:21.14,countryCode:'LT'}],
    'liepāja':[{label:'Liepāja, Latvia',lat:56.50,lon:21.01,countryCode:'LV'}],
    'šiauliai':[{label:'Šiauliai, Lithuania',lat:55.93,lon:23.32,countryCode:'LT'}],
    'cēsis':[{label:'Cēsis, Latvia',lat:57.31,lon:25.27,countryCode:'LV'}],
    'kuldīga':[{label:'Kuldīga, Latvia',lat:56.97,lon:21.97,countryCode:'LV'}]
  };
  window.fetch=async(input,init={})=>{
    const u=String(input),url=new URL(u,'https://mock.invalid'),path=url.pathname;
    if(path==='/api/status'){const refsOnline=window.__referencesOnline!==false;window.__mockSettings=window.__mockSettings||{aiEndpoint:'',aiModel:'',referenceEndpoint:'http://127.0.0.1:8091',gazetteerEndpoint:'',pbfRoot:'',mapQuestConfigured:false,mapQuestKeyHint:'',allowWebGeocode:true};const pbfOn=Boolean(window.__mockSettings.pbfRoot);return jsonResponse({ok:true,release:{releaseId:'WAYFINDER-RM-2026-09-24-E'},ai:{available:true,reachable:true,model:window.__mockSettings.aiModel||'mock-wayfinder'},references:{available:refsOnline,wikivoyage:refsOnline,wikipedia:refsOnline,message:refsOnline?'':'mock Kiwix offline'},geocoding:{local:true,localReferences:refsOnline,mapquest:window.__mockSettings.mapQuestConfigured,webFallback:window.__mockSettings.allowWebGeocode!==false},mapquest:{configured:window.__mockSettings.mapQuestConfigured},offlinePbf:pbfOn?{available:true,kind:'raw-osm-pbf-library',catalogCount:1,message:'1 installed .osm.pbf file found'}:{available:false,kind:'raw-osm-pbf-library',message:'Not configured'},settings:{allowWebGeocode:window.__mockSettings.allowWebGeocode!==false},performance:{interactiveLimitMs:120000}});}
    window.__lifecycleCalls=window.__lifecycleCalls||[];
    if(path==='/api/system/client/register'){window.__lifecycleCalls.push('register');return jsonResponse({ok:true,clientId:'mock-client',closeGraceMs:2500});}
    if(path==='/api/system/client/heartbeat'){window.__lifecycleCalls.push('heartbeat');return jsonResponse({ok:true});}
    if(path==='/api/system/client/close'){window.__lifecycleCalls.push('close');return jsonResponse({ok:true});}
    if(path==='/api/system/client/exit'){window.__lifecycleCalls.push('exit');return jsonResponse({ok:true});}
    window.__mockSettings=window.__mockSettings||{aiEndpoint:'',aiModel:'',referenceEndpoint:'http://127.0.0.1:8091',gazetteerEndpoint:'',pbfRoot:'',mapQuestConfigured:false,mapQuestKeyHint:'',allowWebGeocode:true};
    if(path==='/api/settings'&&(!init.method||init.method==='GET'))return jsonResponse({ok:true,settings:window.__mockSettings});
    if(path==='/api/settings'&&init.method==='POST'){const incoming=JSON.parse(init.body||'{}');window.__mockSettings={...window.__mockSettings,...incoming,mapQuestConfigured:Boolean(incoming.mapQuestKey)||window.__mockSettings.mapQuestConfigured};return jsonResponse({ok:true,settings:window.__mockSettings,runtime:{ai:{available:true,reachable:true,model:window.__mockSettings.aiModel||'mock-wayfinder'},references:{available:window.__referencesOnline!==false,wikivoyage:window.__referencesOnline!==false,wikipedia:window.__referencesOnline!==false},mapquest:{configured:window.__mockSettings.mapQuestConfigured},pbf:{available:false,message:'Not configured'}}});}
    if(path==='/api/settings/pick-folder'&&init.method==='POST')return jsonResponse({ok:true,cancelled:false,folder:'C:\\Maps\\Geofabrik'});

    if(path==='/api/offline/status'){const on=Boolean(window.__mockSettings?.pbfRoot);return jsonResponse(on?{available:true,kind:'raw-osm-pbf-library',catalogCount:1,renderReady:true,message:'Installed test .osm.pbf covers route.'}:{available:false,kind:'raw-osm-pbf-library',renderReady:false,message:'Not configured'});}
    if(path==='/api/offline/render'&&init.method==='POST')return jsonResponse({ok:true,job:{id:'mock-pbf-job'}});
    if(path==='/api/offline/job/mock-pbf-job')return jsonResponse({ok:true,job:{id:'mock-pbf-job',state:'ready',percent:100,message:'Offline map ready.',svg:'<svg viewBox=\"0 0 1200 600\"></svg>',bounds:{west:12,east:16,south:36,north:39},routeSegments:[],sourceFiles:['mock.osm.pbf']}});
    if(path==='/api/mapquest/route'&&init.method==='POST'){const model=JSON.parse(init.body||'{}');const geometry=(model.occurrences||[]).filter(x=>x.resolution).map(x=>({lat:x.resolution.lat,lon:x.resolution.lon}));return jsonResponse({tripId:model.tripId,authorityVersion:model.authorityVersion,snapshotKey:model.snapshotKey,occurrenceIds:(model.occurrences||[]).map(x=>x.occurrenceId),geometry});}
    if(path==='/api/geocode'){if(window.__geoOffline)return jsonResponse({results:[]});const q=(url.searchParams.get('q')||'').toLowerCase();return jsonResponse({results:(geo[q]||[]).map(x=>({...x,confidence:x.confidence??0.98}))})}
    if(path==='/api/references/search'){const q=url.searchParams.get('q')||'Place';return jsonResponse({query:q,results:[{title:q,source:'Wikivoyage',url:`local://${encodeURIComponent(q)}`,excerpt:`Local reference evidence for ${q}.`}]})}
    if(path==='/api/chat'){
      const body=JSON.parse(init.body||'{}'),system=String(body.messages?.[0]?.content||''),user=String(body.messages?.at(-1)?.content||''),all=body.messages?.map(x=>String(x.content||'')).join('\n')||'';
      if(window.__serialModelProbe){window.__activeMockChats=(window.__activeMockChats||0)+1;window.__maxConcurrentChats=Math.max(window.__maxConcurrentChats||0,window.__activeMockChats);await wait(280);window.__activeMockChats--}
      if(window.__chatFail)return jsonResponse({error:'simulated local model outage'},503)
      if(system.includes('Traveler Contract extractor')){await wait(800);const prompt=user.split('Traveler request:').pop();return jsonResponse({choices:[{message:{content:JSON.stringify(extraction(prompt))}}]})}
      if(system.includes('WAYFINDER Spark skeleton completion')){const list=sparkFor(all);return jsonResponse({choices:[{message:{content:JSON.stringify({proposals:[proposal('Corsica Inland & Coast',['Ajaccio','Propriano','Corte','Bastia'],'one_way',11),...list].slice(0,1)})}}]})}
      if(system.includes('You enrich already-validated WAYFINDER route skeletons')){await wait(2500);return jsonResponse({choices:[{message:{content:JSON.stringify({enrichments:[{index:0,summary:'First route details',themes:['local culture']},{index:1,summary:'Second route details',themes:['local culture']},{index:2,summary:'Third route details',themes:['local culture']}]})}}]})}
      if(system.includes('Return ONE route skeleton'))return sseResponse([sparkFor(all)[0]],90,Number(window.__sparkFirstDelayMs||0),init.signal)
      if(system.includes('Stream up to'))return sseResponse(sparkFor(all).slice(1),90,Number(window.__sparkAlternativesDelayMs||0),init.signal)
      if(system.includes('WAYFINDER Spark')||system.includes('Spark stage of WAYFINDER'))return sseResponse(sparkFor(all),120,0,init.signal)
      if(system.includes('WAYFINDER Documentation')&&window.__docFail)return jsonResponse({error:'simulated documentation model outage'},503)
      if(system.includes('WAYFINDER Documentation'))return doneStream()
      if(system.includes('Revision compiler'))return jsonResponse({choices:[{message:{content:JSON.stringify(window.__revisionInvalid?{summary:'Invalid mock revision',commands:[{type:'UNKNOWN_COMMAND',payload:{}}]}:{summary:'Updated trip duration',commands:[{type:'SET_DURATION',payload:{kind:'exact',days:22}}]})}}]})
      return jsonResponse({choices:[{message:{content:'{}'}}]})
    }
    throw new Error('Unexpected mocked fetch '+u)
  };
}'''
MOCK_FETCH=MOCK_FETCH.replace('WAYFINDER-RM-2026-09-24-E',RELEASE['releaseId'])

def make_page(browser,seed_storage=None):
    page=browser.new_page(viewport={'width':1440,'height':1000})
    page.set_content(html)
    page.evaluate("seed=>{let mem={...(seed||{})};Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null,setItem:(k,v)=>mem[k]=String(v),removeItem:k=>delete mem[k],clear:()=>{mem={}}}});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{window.__clipboard=String(t)}}});window.open=(u)=>{window.__lastOpened=u;return null}}",seed_storage or {})
    page.evaluate(MOCK_FETCH)
    urls={}
    for rel in order:
        src=mods[rel]
        def repl(m):
            dep=posixpath.normpath(posixpath.join(posixpath.dirname(rel),m.group(2)))
            return m.group(1)+urls[dep]+m.group(3)
        src2=imp_re.sub(repl,src)
        urls[rel]=page.evaluate("src=>URL.createObjectURL(new Blob([src],{type:'text/javascript'}))",src2)
    page.evaluate("url=>{const s=document.createElement('script');s.type='module';s.src=url;document.body.appendChild(s)}",urls['app.js'])
    page.wait_for_function("document.querySelector('#runtimeBadge')?.textContent.includes('mock-wayfinder')",timeout=5000)
    return page

def visible(page,sel):return page.locator(sel).is_visible()
def text(page,sel):return page.locator(sel).inner_text()
def prompt(page,value):page.locator('#brief').fill(value);page.locator('#sparkBtn').click()
def wait_props(page,n=1):page.wait_for_function(f"document.querySelectorAll('#proposals .proposal').length>={n}",timeout=10000)

def scenario_immediate(page):
    t=time.perf_counter();prompt(page,'Give me a tour of Corsica.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    ms=round((time.perf_counter()-t)*1000)
    assert ms<500,ms
    assert 'Corsica' in page.locator('#basicsDestination').input_value()
    assert 'temple' not in text(page,'#tripBasicsPanel').lower()
    assert page.locator('#basicsStart').input_value()==''
    assert 'Destination(s):' in text(page,'#tripBasicsSignals') and 'Start:' in text(page,'#tripBasicsSignals')
    assert 'background' in text(page,'#sparkStatus').lower()
    assert page.locator('#proposals .proposal').count()==0
    return {'tripBasicsVisibleMs':ms}

def scenario_single_app_lifecycle(page):
    assert page.locator('#exitBtn').is_visible()
    page.wait_for_function("(window.__lifecycleCalls||[]).includes('register')",timeout=1500)
    page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
    page.wait_for_function("(window.__lifecycleCalls||[]).includes('close')",timeout=1500)
    # re-register because pagehide intentionally closed the first session, then exercise the visible app Exit control.
    page.evaluate("fetch('/api/system/client/register',{method:'POST',headers:{'X-WAYFINDER-Client':'1'}}).then(r=>r.json()).then(d=>window.__testClient=d.clientId)")
    page.wait_for_function("window.__testClient==='mock-client'",timeout=1500)
    page.on('dialog',lambda dialog: dialog.accept())
    page.locator('#exitBtn').click()
    page.wait_for_function("document.body.textContent.includes('WAYFINDER closed')",timeout=2000)
    assert 'local WAYFINDER process has been stopped' in text(page,'body')
    assert page.evaluate("(window.__lifecycleCalls||[]).includes('exit')")
    return {'exitControlVisible':True,'pagehideCloseWired':True}

def scenario_home_service_health(page):
    assert page.locator('#referenceBadge').is_visible()
    assert page.locator('#checkServicesBtn').is_visible()
    page.evaluate("window.__referencesOnline=false")
    page.locator('#checkServicesBtn').click()
    page.wait_for_function("document.querySelector('#referenceBadge')?.textContent.includes('offline')",timeout=3000)
    assert 'Kiwix' in text(page,'#referenceBadge')
    page.evaluate("window.__referencesOnline=true")
    page.locator('#checkServicesBtn').click()
    page.wait_for_function("document.querySelector('#referenceBadge')?.textContent.includes('Kiwix running')",timeout=3000)
    return {'offlineVisible':True,'recheckRecovered':True}

def scenario_fresh_spark_prompt_clean(page):
    browser=page.context.browser
    seeded={'wayfinder.rebuild.state.v3':json.dumps({'briefText':'I wish this non-travel test text would not appear','revisionLog':[]})}
    fresh=make_page(browser,seed_storage=seeded)
    try:
        assert fresh.locator('#brief').input_value()==''
        assert fresh.locator('#brief').get_attribute('autocomplete')=='off'
        return {'orphanPromptDiscarded':True}
    finally:fresh.close()

def scenario_background(page):
    prompt(page,'Give me a tour of Corsica.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    page.wait_for_function("(document.querySelector('#sparkLiveStatus')?.innerText||'').trim().length>8",timeout=500)
    live_status=text(page,'#sparkLiveStatus')
    assert any(word in live_status.lower() for word in ['background','checking','preparing','ideating','route','finished']), repr(live_status)
    page.wait_for_function("document.querySelector('#backgroundSignals')?.textContent.includes('Interests:')",timeout=3000)
    assert 'coast' in text(page,'#backgroundSignals').lower()
    t=time.perf_counter();page.locator('#confirmBasicsBtn').click();wait_props(page,1);first_ms=round((time.perf_counter()-t)*1000)
    assert first_ms<15000,first_ms
    assert page.locator('#proposals .proposal').first.is_visible()
    assert page.locator('#proposals .proposal-stream-note').count()>=1
    return {'firstVisibleConcepts':page.locator('#proposals .proposal').count(),'firstIdeaAfterConfirmMs':first_ms}

def scenario_corsica_scope(page):
    prompt(page,'Give me a tour of Corsica.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    page.locator('#confirmBasicsBtn').click();page.wait_for_function("document.querySelectorAll('#proposals .proposal').length>=3",timeout=10000)
    routes=text(page,'#proposals')
    assert 'Saint-Tropez' not in routes
    stop_lines=page.locator('#proposals .stops').all_inner_texts();assert all('→ Corsica' not in x and 'Corsica →' not in x for x in stop_lines)
    return {'visibleConcepts':page.locator('#proposals .proposal').count()}

def scenario_sardinia_corsica(page):
    prompt(page,'Plan a trip for me for 3 weeks around Sardinia and Corsica.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    value=page.locator('#basicsDestination').input_value();assert 'Sardinia' in value and 'Corsica' in value,value
    assert page.locator('#basicsDuration').input_value()=='21 days'
    assert 'temple' not in text(page,'#tripBasicsPanel').lower()
    t=time.perf_counter();page.locator('#confirmBasicsBtn').click();wait_props(page,1);first_ms=round((time.perf_counter()-t)*1000);assert first_ms<15000,first_ms
    page.wait_for_function("document.querySelector('#sparkSignals')?.textContent.includes('Sardinia') && document.querySelector('#sparkSignals')?.textContent.includes('Corsica')",timeout=5000)
    page.wait_for_function("document.querySelectorAll('#proposals .proposal').length>=2",timeout=10000)
    routes=text(page,'#proposals');assert any(x in routes for x in ['Cagliari','Alghero','Olbia']);assert any(x in routes for x in ['Ajaccio','Bastia','Bonifacio'])
    return {'firstIdeaAfterConfirmMs':first_ms}

def scenario_shikoku(page):
    prompt(page,'I heard about a walk or trek in Japan. something like a Shikoku route.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    assert 'Shikoku 88-Temple Pilgrimage' in text(page,'#recognizedTripBox')
    assert 'Temple 1' in page.locator('#basicsStart').input_value();assert 'Temple 88' in page.locator('#basicsEnd').input_value()
    assert 'Traditional start' in text(page,'#basicsStartMeta')
    assert page.locator('#basicsDuration').input_value()==''
    assert 'Return to Temple 1 after Temple 88' in text(page,'#recognizedTripBox')
    return {}

def scenario_sicily_open(page):
    prompt(page,'I have three weeks to do a loop tour of Sicily.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    assert page.locator('#basicsDestination').input_value()=='Sicily'
    assert page.locator('#basicsStart').input_value()=='' and page.locator('#basicsEnd').input_value()==''
    assert page.locator('#basicsDuration').input_value()=='21 days'
    assert page.locator('#basicsTopology').input_value()=='loop'
    page.locator('#confirmBasicsBtn').click();wait_props(page,1)
    assert all('loop' in x.lower() for x in page.locator('#proposals .stops b').all_inner_texts())
    return {}

def scenario_palermo(page):
    prompt(page,'I have three weeks to do a loop tour of Sicily. Start and finish in Palermo.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    assert page.locator('#basicsStart').input_value()=='Palermo';assert page.locator('#basicsEnd').input_value()=='Palermo';assert page.locator('#basicsTopology').input_value()=='loop'
    return {}

def scenario_crete(page):
    prompt(page,'I want a loop tour of Crete.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    assert page.locator('#basicsDestination').input_value()=='Crete'
    assert page.locator('#basicsStart').input_value()=='' and page.locator('#basicsEnd').input_value()==''
    assert page.locator('#basicsTopology').input_value()=='loop'
    return {}

def scenario_paris_london(page):
    prompt(page,'I want a one way from Paris to London.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    assert page.locator('#basicsStart').input_value()=='Paris';assert page.locator('#basicsEnd').input_value()=='London';assert page.locator('#basicsTopology').input_value()=='one_way'
    return {}

def scenario_baltic_one_way(page):
    prompt(page,'i will arrive Tallinn and I will depart from Riga. I have 5 weeks to see Estonia, Latvia, and Lithuania. Suggest some itineraries.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    assert page.locator('#basicsDestination').input_value()=='Estonia + Latvia + Lithuania'
    assert page.locator('#basicsStart').input_value()=='Tallinn';assert page.locator('#basicsEnd').input_value()=='Riga'
    assert page.locator('#basicsDuration').input_value()=='35 days';assert page.locator('#basicsTopology').input_value()=='one_way'
    page.locator('#confirmBasicsBtn').click();page.wait_for_function("document.querySelectorAll('#proposals .proposal').length>=3",timeout=10000)
    contract=text(page,'#sparkSignals')
    assert 'Scope: Estonia, Latvia, Lithuania' in contract
    assert 'Required: Estonia' not in contract and 'Required: Latvia' not in contract and 'Required: Lithuania' not in contract
    titles=page.locator('#proposals .proposal h3').all_inner_texts();assert all('loop' not in x.lower() for x in titles),titles
    stop_blocks=page.locator('#proposals .stops').all_inner_texts()
    for block in stop_blocks:
        route=block.splitlines()[-1].strip()
        assert route.startswith('Tallinn'),route
        assert route.endswith('Riga'),route
        assert '→ Estonia' not in route and '→ Latvia' not in route and '→ Lithuania' not in route,route
        labels=[x.strip() for x in route.split('→')]
        assert len(labels)==len({x.lower() for x in labels}),route
        assert any(x in route for x in ['Vilnius','Kaunas','Klaipėda','Šiauliai']),route
    return {'visibleConcepts':page.locator('#proposals .proposal').count()}


def scenario_generic_semantic_matrix(page):
    prompt(page,'I will arrive Lisbon and depart Madrid. I have 12 days to see Portugal and Spain. Suggest itineraries.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    assert page.locator('#basicsStart').input_value()=='Lisbon';assert page.locator('#basicsEnd').input_value()=='Madrid';assert page.locator('#basicsTopology').input_value()=='one_way'
    destination=page.locator('#basicsDestination').input_value();assert 'Portugal' in destination and 'Spain' in destination,destination
    page.locator('#confirmBasicsBtn').click();page.wait_for_function("document.querySelectorAll('#proposals .proposal').length>=3",timeout=10000)
    titles=page.locator('#proposals .proposal h3').all_inner_texts();assert all('loop' not in x.lower() for x in titles),titles
    for block in page.locator('#proposals .stops').all_inner_texts():
        route=block.splitlines()[-1].strip();labels=[x.strip() for x in route.split('→')]
        assert labels[0]=='Lisbon' and labels[-1]=='Madrid',route
        assert len(labels)==len({x.casefold() for x in labels}),route
        assert 'Portugal' not in labels and 'Spain' not in labels,route
    return {'visibleConcepts':page.locator('#proposals .proposal').count()}

def scenario_geography_fail_closed(page):
    prompt(page,'Give me a tour of Madeira.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    page.locator('#confirmBasicsBtn').click();page.wait_for_function("document.querySelectorAll('#proposals .proposal').length>=3",timeout=10000)
    cards=page.locator('#proposals .proposal');routes=text(page,'#proposals');assert 'Unknown Village' in routes
    unverified=cards.filter(has_text='Unknown Village');assert unverified.count()==1
    assert unverified.locator('.refine-proposal').is_disabled();assert unverified.locator('.route-proposal').is_disabled();assert unverified.locator('.document-proposal').is_disabled()
    assert 'could not be verified' in unverified.inner_text().lower()
    assert all('Madeira' not in [x.strip() for x in b.splitlines()[-1].split('→')] for b in page.locator('#proposals .stops').all_inner_texts())
    return {'visibleConcepts':cards.count(),'unverifiedCandidateVisibleAndBlocked':True}

def scenario_trip_basics_contradiction(page):
    prompt(page,'I want a one way from Paris to London.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    page.locator('#basicsTopology').select_option('loop')
    page.locator('#confirmBasicsBtn').click()
    page.wait_for_function("document.querySelector('#tripBasicsStatus').classList.contains('error')",timeout=1500)
    assert 'loop' in text(page,'#tripBasicsStatus').lower()
    assert page.locator('#proposals .proposal').count()==0
    return {'contradictionBlocked':True}

def scenario_stale_spark_navigation(page):
    prompt(page,'Give me a tour of Corsica.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    page.locator('#editSparkPromptBtn').click()
    page.locator('#brief').fill('Give me a tour of Madeira.')
    page.locator('#sparkBtn').click()
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    assert page.locator('#basicsDestination').input_value()=='Madeira'
    page.locator('#confirmBasicsBtn').click()
    page.wait_for_function("document.querySelectorAll('#proposals .proposal').length>=3",timeout=10000)
    cards=text(page,'#proposals')
    assert 'Madeira' in cards
    assert 'Corsica Coast' not in cards and 'Corsica North & South' not in cards
    return {'staleExplorationDiscarded':True}

def scenario_navigation(page):
    prompt(page,'I have three weeks to do a loop tour of Sicily. Start and finish in Palermo.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500);page.locator('#confirmBasicsBtn').click();wait_props(page,1)
    page.locator('#proposals .refine-proposal').first.click();page.wait_for_function("!document.querySelector('#workspace').hidden")
    assert 'I have three weeks' in text(page,'#originalRequestText')
    assert page.locator('.hero').evaluate("e=>e.classList.contains('spark-collapsed')")
    page.locator('#refineBackToSparkBtn').click();assert page.locator('#proposals .proposal').first.is_visible()
    page.locator('#sparkReturnBtn').count() # control exists downstream
    return {}

def scenario_precision(page):
    page.locator('#blankBtn').click();page.wait_for_function("!document.querySelector('#workspace').hidden")
    for _ in range(3):page.locator('#addStopBtn').click()
    rows=page.locator('#routeEditor .route-row')
    for i,v in enumerate(['Tallinn','Tartu','Tallinn']):rows.nth(i).locator('.stop-label').fill(v)
    page.locator('#topologyInput').select_option('loop');page.locator('#savePrecisionBtn').click();page.wait_for_function("document.querySelector('#precisionStatus').classList.contains('ok')")
    rows=page.locator('#routeEditor .route-row');rows.nth(2).locator('.stop-label').fill('Riga');page.locator('#topologyInput').select_option('flexible');page.locator('#savePrecisionBtn').click();page.wait_for_function("document.querySelector('#precisionStatus').classList.contains('ok')")
    assert [rows.nth(i).locator('.stop-label').input_value() for i in range(3)]==['Tallinn','Tartu','Riga']
    assert page.locator('#topologyInput').input_value()=='flexible'
    return {}

def scenario_resolution(page):
    prompt(page,'I have three weeks to do a loop tour of Sicily. Start and finish in Palermo.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500);page.locator('#confirmBasicsBtn').click();wait_props(page,1)
    page.locator('#proposals .route-proposal').first.click();page.wait_for_function("!document.querySelector('#workspace').hidden")
    page.locator('#mapResolveBtn').click()
    page.wait_for_function("document.querySelector('#mapStatus').textContent.includes('occurrences resolved')",timeout=10000)
    coord=text(page,'#coordinateFact').lower();assert not re.search(r'\b[1-9]\d* unresolved\b',coord),coord
    assert page.locator('#mapCanvas svg').count()==1
    assert page.locator('#offlinePbfBtn').is_disabled()
    assert 'not configured' in text(page,'#pbfFact').lower()
    return {'resolutionStatus':text(page,'#mapStatus'),'offlineDegradedVisible':True}

def scenario_export_import_persistence(page):
    page.locator('#blankBtn').click();page.wait_for_function("!document.querySelector('#workspace').hidden")
    for _ in range(3):page.locator('#addStopBtn').click()
    rows=page.locator('#routeEditor .route-row')
    for i,v in enumerate(['Alpha Port','Beta Town','Gamma City']):rows.nth(i).locator('.stop-label').fill(v)
    page.locator('#topologyInput').select_option('one_way');page.locator('#durationKindInput').select_option('exact');page.locator('#durationDaysInput').fill('9')
    page.locator('#savePrecisionBtn').click();page.wait_for_function("document.querySelector('#precisionStatus').classList.contains('ok')")
    with page.expect_download(timeout=3000) as info: page.locator('#exportBtn').click()
    download=info.value;path=download.path();assert path
    rows=page.locator('#routeEditor .route-row');rows.nth(1).locator('.stop-label').fill('Changed Town');page.locator('#savePrecisionBtn').click();page.wait_for_function("document.querySelector('#precisionStatus').classList.contains('ok')")
    page.locator('#importFile').set_input_files(path)
    page.wait_for_function("document.querySelector('#precisionStatus').textContent.includes('Trip imported')",timeout=3000)
    page.locator('[data-tab="precision"]').click()
    loc=page.locator('#routeEditor .stop-label');restored=[loc.nth(i).input_value() for i in range(loc.count())]
    assert restored[:3]==['Alpha Port','Beta Town','Gamma City'],restored
    assert page.locator('#durationKindInput').input_value()=='exact' and page.locator('#durationDaysInput').input_value()=='9'
    return {'exportImportRestored':True}

def scenario_document(page):
    prompt(page,'I have three weeks to do a loop tour of Sicily. Start and finish in Palermo.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500);page.locator('#confirmBasicsBtn').click();wait_props(page,1)
    page.locator('#proposals .document-proposal').first.click();page.wait_for_function("!document.querySelector('#workspace').hidden")
    page.locator('[data-tab="document"]').click();assert page.locator('#documentSections input[type=checkbox]').count()>=5
    page.locator('#documentBtn').click();page.wait_for_function("document.querySelector('#documentOutput').textContent.includes('Sources / References')",timeout=10000)
    doc=text(page,'#documentOutput');assert '[S1]' in doc and 'Sources / References' in doc
    return {}

def scenario_serial_local_model_jamaica(page):
    # Regression for the traveler-found 120-second Jamaica failure, but the asserted
    # invariant is generic: the client must never submit concurrent local-model jobs
    # during first-route preparation because many local servers have one worker.
    page.evaluate("window.__serialModelProbe=true;window.__activeMockChats=0;window.__maxConcurrentChats=0")
    prompt(page,'I have two weeks to visit Jamaica')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    assert page.locator('#basicsDestination').input_value()=='Jamaica'
    assert page.locator('#basicsDuration').input_value()=='14 days'
    t=time.perf_counter();page.locator('#confirmBasicsBtn').click()
    page.wait_for_function("document.querySelectorAll('#proposals .proposal').length>=1",timeout=14900)
    first_ms=round((time.perf_counter()-t)*1000)
    assert first_ms<15000,first_ms
    assert page.evaluate("window.__maxConcurrentChats")==1,page.evaluate("window.__maxConcurrentChats")
    route=text(page,'#proposals .stops')
    assert any(x in route for x in ['Kingston','Ocho Rios','Montego Bay','Port Antonio','Negril']),route
    page.wait_for_function("document.querySelector('#proposals .refine-proposal:not([disabled])')",timeout=8000)
    assert '120-second' not in text(page,'#sparkStatus')
    return {'firstUsefulValidatedSkeletonMs':first_ms,'maxConcurrentLocalModelJobs':page.evaluate("window.__maxConcurrentChats"),'jamaicaRegression':True}

def scenario_slow_model_first_useful(page):
    # First streamed Corsica proposal is intentionally invalid (Saint-Tropez is outside Corsica).
    # Delay it to near the release target, then require the independent alternatives pass to
    # reject it and surface a valid skeleton before 15 seconds from confirmation.
    page.evaluate("window.__sparkFirstDelayMs=12500;window.__sparkAlternativesDelayMs=0")
    prompt(page,'Give me a tour of Corsica.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    t=time.perf_counter();page.locator('#confirmBasicsBtn').click()
    page.wait_for_function("document.querySelectorAll('#proposals .proposal').length>=1",timeout=14900)
    first_ms=round((time.perf_counter()-t)*1000)
    assert first_ms<15000,first_ms
    route=text(page,'#proposals .stops')
    assert 'Saint-Tropez' not in route,route
    assert any(x in route for x in ['Bonifacio','Corte','Bastia','Calvi']),route
    return {'simulatedFirstStreamDelayMs':12500,'firstUsefulValidatedSkeletonMs':first_ms,'invalidSlowSkeletonRejected':True}

def scenario_guide_executable_controls(page):
    # Settings instructions are exercised as rendered controls, not source-string assertions.
    page.locator('#settingsBtn').click();page.wait_for_function("document.querySelector('#settingsDialog')?.open===true",timeout=2000)
    page.locator('#settingsAiEndpoint').fill('http://127.0.0.1:8080')
    page.locator('#settingsAiModel').fill('mock-wayfinder')
    page.locator('#settingsReferenceEndpoint').fill('http://127.0.0.1:8091')
    page.locator('#settingsGazetteerEndpoint').fill('http://127.0.0.1:8765')
    page.locator('#settingsMapQuestKey').fill('test-key')
    page.locator('#settingsAllowWebGeocode').uncheck()
    page.locator('#browsePbfRootBtn').click();page.wait_for_function("document.querySelector('#settingsPbfRoot').value.includes('Geofabrik')",timeout=2000)
    page.locator('#saveSettingsBtn').click();page.wait_for_function("document.querySelector('#settingsStatus').textContent.includes('Settings saved locally')",timeout=3000)
    page.locator('#refreshSettingsBtn').click();page.wait_for_timeout(100)
    page.locator('#settingsDialog').evaluate("d=>d.close()")
    # Spark + adoption + Refine controls.
    prompt(page,'I have three weeks to do a loop tour of Sicily. Start and finish in Palermo.')
    page.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=500)
    page.locator('#confirmBasicsBtn').click();wait_props(page,1)
    page.locator('#proposals .save-proposal').first.click()
    page.locator('#proposals .refine-proposal').first.click();page.wait_for_function("!document.querySelector('#workspace').hidden")
    assert page.locator('#revisionBtn').is_visible() and page.locator('#refineBackToSparkBtn').is_visible()
    page.locator('#revisionText').fill('Keep the route but make no structural change.')
    page.locator('#revisionBtn').click();page.wait_for_function("document.querySelector('#revisionStatus').classList.contains('ok')",timeout=2000)
    # Precision controls: add, dirty, discard, save.
    page.locator('[data-tab="precision"]').click();page.locator('#addStopBtn').click()
    assert 'Unsaved' in text(page,'#tripMeta')
    page.locator('#discardPrecisionBtn').click();page.wait_for_timeout(100)
    page.locator('#savePrecisionBtn').click();page.wait_for_timeout(100)
    # Confirm a traveler-owned transport mode so provider handoff can be exercised faithfully.
    page.locator('#transportInput').select_option('Car');page.locator('#transportConfirmed').check();page.locator('#savePrecisionBtn').click();page.wait_for_timeout(100)
    # Mapping instructions: resolve, route with MapQuest, load PBF, and verify share links.
    page.locator('[data-tab="mapping"]').click();assert page.locator('#mapResolveBtn').is_visible();page.locator('#mapResolveBtn').click()
    page.wait_for_function("document.querySelector('#mapStatus').textContent.includes('occurrences resolved')",timeout=10000)
    page.wait_for_function("!document.querySelector('#routeMapQuestBtn').disabled",timeout=3000);page.locator('#routeMapQuestBtn').click();page.wait_for_timeout(150)
    assert 'validated routed geometry points' in text(page,'#mapQuestFact')
    page.wait_for_function("!document.querySelector('#offlinePbfBtn').disabled",timeout=3000);page.locator('#offlinePbfBtn').click()
    page.wait_for_function("document.querySelector('#pbfFact').textContent.includes('Offline map ready')",timeout=5000)
    assert page.locator('#googleBtn').get_attribute('href') not in [None,'#']
    assert page.locator('#mapQuestShareBtn').get_attribute('href') not in [None,'#']
    # Documentation controls, section persistence surface, build and copy.
    page.locator('[data-tab="document"]').click();assert page.locator('#documentSections input[type=checkbox]').count()>=5
    page.locator('#documentBtn').click();page.wait_for_function("document.querySelector('#documentOutput').textContent.length>20",timeout=5000)
    assert page.locator('#copyDocBtn').is_visible();page.locator('#copyDocBtn').click();page.wait_for_function("document.querySelector('#documentStatus').textContent.includes('Copied')",timeout=1500)
    # Save/export/import/new-trip controls are present and executable in their dedicated journey.
    for sel in ['#exportBtn','#importFile','#resetBtn','#exitBtn','#checkServicesBtn']:
        assert page.locator(sel).count()==1
    return {'settingsExecuted':True,'sparkExecuted':True,'refineExecuted':True,'precisionExecuted':True,'mappingControlsRendered':True,'documentationExecuted':True}

SCENARIOS=[
 ('immediate-trip-basics',scenario_immediate),('single-app-lifecycle-ui',scenario_single_app_lifecycle),('home-local-service-health',scenario_home_service_health),('fresh-spark-prompt-clean',scenario_fresh_spark_prompt_clean),('background-feedback',scenario_background),('corsica-geographic-scope',scenario_corsica_scope),('sardinia-corsica-multi-area',scenario_sardinia_corsica),('shikoku',scenario_shikoku),('sicily-loop-open-gateway',scenario_sicily_open),('palermo-loop',scenario_palermo),('crete-loop',scenario_crete),('paris-london-one-way',scenario_paris_london),('baltic-one-way-scope-semantics',scenario_baltic_one_way),('generic-semantic-invariant-matrix',scenario_generic_semantic_matrix),('geography-verification-fail-closed',scenario_geography_fail_closed),('trip-basics-contradiction-block',scenario_trip_basics_contradiction),('stale-spark-navigation-cancel',scenario_stale_spark_navigation),('spark-return-navigation',scenario_navigation),('precision-loop-to-flexible',scenario_precision),('route-resolution',scenario_resolution),('export-import-persistence',scenario_export_import_persistence),('document-preferences-citations',scenario_document),('serial-local-model-jamaica',scenario_serial_local_model_jamaica),('slow-model-first-useful-skeleton',scenario_slow_model_first_useful),('guide-executable-controls',scenario_guide_executable_controls)
]
required_ids=[j['id'] for j in ACCEPTANCE['journeys'] if j.get('required',True)]
scenario_ids=[sid for sid,_ in SCENARIOS]
if not os.environ.get('WAYFINDER_RENDERED_SCENARIO') and scenario_ids!=required_ids:raise RuntimeError(f'Rendered scenario list does not match ACCEPTANCE_JOURNEYS.json: {scenario_ids} != {required_ids}')

def run_release_rendered(write=True):
    results=[];verdict='PASS'
    with sync_playwright() as pw:
        browser=launch_chromium(pw)
        selected=os.environ.get('WAYFINDER_RENDERED_SCENARIO','').strip()
        scenarios=[x for x in SCENARIOS if not selected or x[0]==selected]
        if selected and not scenarios: raise RuntimeError(f'Unknown rendered scenario: {selected}')
        for sid,fn in scenarios:
            page=None
            try:
                page=make_page(browser);details=fn(page) or {};results.append({'id':sid,'status':'PASS',**details})
            except Exception as e:
                verdict='FAIL';results.append({'id':sid,'status':'FAIL','error':str(e)});traceback.print_exc()
            finally:
                if page:page.close()
        browser.close()
    evidence={'releaseId':RELEASE['releaseId'],'verdict':verdict,'criticalHash':critical_hash(),'createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'engine':'Chromium rendered DOM via Playwright with deterministic mocked local services','scenarios':results}
    if write:(ROOT/'RENDERED_ACCEPTANCE.json').write_text(json.dumps(evidence,indent=2)+'\n',encoding='utf-8')
    return evidence

if __name__=='__main__':
    evidence=run_release_rendered(write='--no-write' not in sys.argv)
    print(json.dumps(evidence,indent=2))
    if evidence['verdict']!='PASS':sys.exit(1)
