import http from 'node:http'
const PORT=Number(process.env.MOCK_PORT||18080)
const MAPQUEST_DELAY_MS=Number(process.env.MOCK_MAPQUEST_DELAY_MS||0)
const coords={
  'genoa':[44.4056,8.9463],'bologna':[44.4949,11.3426],'florence':[43.7696,11.2558],'rome':[41.9028,12.4964],'naples':[40.8518,14.2681],'palermo':[38.1157,13.3615],'catania':[37.5079,15.0830],'turin':[45.0703,7.6869],
  'taipei':[25.0330,121.5654],'tainan':[22.9999,120.2270],'kaohsiung':[22.6273,120.3014]
}
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))}
async function body(req){const chunks=[];for await(const c of req)chunks.push(c);return JSON.parse(Buffer.concat(chunks).toString()||'{}')}
function spark(){return JSON.stringify({constraints:{duration:{kind:'exact',days:30},topology:'loop',start:'Genoa',end:'Genoa',requiredPlaces:['Bologna'],scopes:[{kind:'country',label:'Italy'},{kind:'island',label:'Sicily'}],transport:{primaryMode:'Bus',confirmed:true},experiences:{required:[],preferred:['food'],excluded:[]},commitments:[],exclusions:[],travelers:[],homeOrigin:''},proposals:[
{title:'Classic Italy loop',summary:'Major cities plus Sicily.',stops:['Genoa','Bologna','Florence','Rome','Naples','Palermo','Catania','Genoa'],days:30,topology:'loop',themes:['food','history']},
{title:'Markets and coast',summary:'Full Italy scope with market emphasis.',stops:['Genoa','Bologna','Parma','Florence','Rome','Naples','Palermo','Catania','Genoa'],days:30,topology:'loop',themes:['markets','coast']},
{title:'History and islands',summary:'Full Italy scope with history emphasis.',stops:['Genoa','Bologna','Verona','Florence','Rome','Naples','Palermo','Catania','Genoa'],days:30,topology:'loop',themes:['history','food']}]})}
function contract(){return JSON.stringify({duration:{kind:'exact',days:30},topology:'loop',start:'Genoa',end:'Genoa',requiredPlaces:['Bologna'],scopes:[{kind:'country',label:'Italy'},{kind:'island',label:'Sicily'}],transport:{primaryMode:'Bus',confirmed:true},experiences:{required:[],preferred:['food'],excluded:[]},commitments:[],exclusions:[],travelers:[],homeOrigin:''})}
function revision(user){
  let snap={version:1,route:[]};try{const start=user.indexOf('CURRENT AUTHORITY:\n')+'CURRENT AUTHORITY:\n'.length;const end=user.indexOf('\n\nTRAVELER REVISION:');snap=JSON.parse(user.slice(start,end))}catch{}
  const endOcc=snap.route?.findLast?.(x=>x.role==='end')||snap.route?.at?.(-1);return JSON.stringify({baseVersion:snap.version,summary:'Added Turin before the final return to Genoa.',commands:[{type:'INSERT_OCCURRENCE',payload:{label:'Turin',beforeOccurrenceId:endOcc?.id}}]})
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host}`)
  if(url.pathname==='/v1/models')return json(res,200,{data:[{id:'mock-wayfinder'}]})
  if(url.pathname==='/catalog/v2/entries') {res.writeHead(200,{'Content-Type':'application/xml'});return res.end('<feed><entry><title>wikivoyage_en_all_maxi</title></entry><entry><title>wikipedia_en_all_maxi</title></entry></feed>')}
  if(url.pathname==='/search') {const q=String(url.searchParams.get('pattern')||'Place');res.writeHead(200,{'Content-Type':'application/xml'});return res.end(`<rss><item><title>${q}</title><link>http://127.0.0.1:${PORT}/content/${encodeURIComponent(q)}</link><description>Local travel guidance for ${q}.</description></item></rss>`)}
  if(url.pathname.startsWith('/content/')) {const q=decodeURIComponent(url.pathname.slice('/content/'.length)),key=Object.keys(coords).find(k=>q.toLowerCase().includes(k)),geo=key?`<meta name="geo.position" content="${coords[key][0]},${coords[key][1]}">`:'';res.writeHead(200,{'Content-Type':'text/html'});return res.end(`<html><head>${geo}</head><body><main>${q} is covered by the local travel reference. Practical notes are available offline.</main></body></html>`)}
  if(url.pathname==='/geocode'){
    const q=String(url.searchParams.get('q')||'').toLowerCase();const key=Object.keys(coords).find(k=>q.includes(k));if(!key)return json(res,200,{results:[]});const [lat,lon]=coords[key];return json(res,200,{results:[{label:q,lat,lon,countryCode:'IT',confidence:1}]})
  }
  if(url.pathname==='/directions/v2/route'){
    const d=await body(req);if(MAPQUEST_DELAY_MS>0)await new Promise(r=>setTimeout(r,MAPQUEST_DELAY_MS));const loc=d.locations||[];const shape=[];for(let i=0;i<loc.length;i++){const p=loc[i].latLng;shape.push(p.lat,p.lng);if(i<loc.length-1){const n=loc[i+1].latLng;shape.push((p.lat+n.lat)/2,(p.lng+n.lng)/2)}}return json(res,200,{info:{statuscode:0,messages:[]},route:{distance:1234,time:50000,shape:{shapePoints:shape}}})
  }
  if(url.pathname==='/v1/chat/completions'&&req.method==='POST'){
    const d=await body(req);const sys=d.messages?.find(m=>m.role==='system')?.content||'';const user=d.messages?.findLast?.(m=>m.role==='user')?.content||''
    if(d.stream){
      res.writeHead(200,{'Content-Type':'text/event-stream'})
      if(sys.includes('WAYFINDER Spark')||sys.includes('Spark stage')){
        const proposals=JSON.parse(spark()).proposals
        for(const proposal of proposals)res.write(`data: ${JSON.stringify({choices:[{delta:{content:`${JSON.stringify(proposal)}\n`}}]})}\n\n`)
        res.write('data: [DONE]\n\n');return res.end()
      }
      const route=[...user.matchAll(/^\d+\.\s+(.+?)\s+\[(?:start|visit|end)\]/gm)].map(m=>m[1]);const stopNotes=route.map((label,i)=>`### ${i+1}. ${label}\nPlanning notes for ${label}.`).join('\n\n');const chunks=[`## Overview\nThis document uses the frozen canonical trip.\n\n## Stop-by-stop planning notes\n${stopNotes}\n\n`,`## Transport notes\nTransport guidance respects the traveler choice.\n\n`,`## Practical preparation\nVerify time-sensitive details before travel.`];for(const t of chunks)res.write(`data: ${JSON.stringify({choices:[{delta:{content:t}}]})}\n\n`);res.write('data: [DONE]\n\n');return res.end()}
    const content=sys.includes('Traveler Contract extractor')?contract():(sys.includes('WAYFINDER Spark')||sys.includes('Spark stage'))?spark():sys.includes('You enrich already-validated WAYFINDER route skeletons')?JSON.stringify({enrichments:[]}):sys.includes('Revision compiler')?revision(user):JSON.stringify({ok:true});return json(res,200,{choices:[{message:{content}}]})
  }
  json(res,404,{error:'not found'})
})
server.listen(PORT,'127.0.0.1',()=>console.log(`mock stack ${PORT}`))
