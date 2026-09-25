// Defensive minimal Mapbox Vector Tile decoder for local XYZ .pbf tiles.
// Geometry-only: attributes are intentionally ignored for the background map.
class Reader{
  constructor(bytes){this.b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);this.p=0}
  eof(){return this.p>=this.b.length}
  ensure(n){if(!Number.isInteger(n)||n<0||this.p+n>this.b.length)throw new Error('Unexpected protobuf EOF')}
  varint(){let x=0,shift=0;while(this.p<this.b.length){const c=this.b[this.p++];x+=(c&0x7f)*2**shift;if(!(c&0x80))return x;shift+=7;if(shift>56)throw new Error('Invalid protobuf varint')}throw new Error('Unexpected protobuf EOF')}
  bytes(n){this.ensure(n);const s=this.b.subarray(this.p,this.p+n);this.p+=n;return s}
  skip(wire){if(wire===0){this.varint();return}if(wire===1){this.ensure(8);this.p+=8;return}if(wire===2){const n=this.varint();this.ensure(n);this.p+=n;return}if(wire===5){this.ensure(4);this.p+=4;return}throw new Error(`Unsupported protobuf wire type ${wire}`)}
}
const zz=n=>(n>>>1)^(-(n&1))
function fields(bytes,onField){const r=new Reader(bytes);while(!r.eof()){const tag=r.varint();if(!tag)throw new Error('Invalid protobuf field tag 0');const field=tag>>>3,wire=tag&7;if(wire===2){const len=r.varint(),data=r.bytes(len);onField(field,wire,data)}else if(wire===0)onField(field,wire,r.varint());else r.skip(wire)}}
function packedVarints(bytes){const r=new Reader(bytes),out=[];while(!r.eof())out.push(r.varint());return out}
function decodeFeature(bytes,extent,tileX,tileY,z,layerName){
  let type=0,geom=[];fields(bytes,(f,w,v)=>{if(f===3&&w===0)type=v;if(f===4&&w===2)geom=packedVarints(v)})
  if(!geom.length||![1,2,3].includes(type))return[]
  let x=0,y=0,i=0,current=[],parts=[]
  const need=n=>{if(i+n>geom.length)throw new Error(`Truncated MVT geometry in layer ${layerName}`)}
  function point(px,py){const n=2**z,worldX=(tileX+px/extent)/n,worldY=(tileY+py/extent)/n;return{lon:worldX*360-180,lat:Math.atan(Math.sinh(Math.PI*(1-2*worldY)))*180/Math.PI}}
  while(i<geom.length){const cmd=geom[i++],cmdId=cmd&7,count=cmd>>>3;if(!count)throw new Error(`Invalid MVT geometry command count in ${layerName}`)
    if(cmdId===1){need(count*2);for(let c=0;c<count;c++){x+=zz(geom[i++]);y+=zz(geom[i++]);if(current.length)parts.push(current);current=[point(x,y)]}}
    else if(cmdId===2){need(count*2);for(let c=0;c<count;c++){x+=zz(geom[i++]);y+=zz(geom[i++]);current.push(point(x,y))}}
    else if(cmdId===7){for(let c=0;c<count;c++)if(current.length>1)current.push({...current[0]})}
    else throw new Error(`Unsupported MVT geometry command ${cmdId} in ${layerName}`)
  }
  if(current.length)parts.push(current)
  return parts.filter(p=>type===1?p.length>=1:p.length>=2).map(points=>({layer:layerName,type:type===3?'polygon':type===2?'line':'point',points}))
}
function parseLayer(bytes){let name='',extent=4096;const featureBuffers=[];fields(bytes,(f,w,v)=>{if(f===1&&w===2)name=new TextDecoder().decode(v);else if(f===2&&w===2)featureBuffers.push(v);else if(f===5&&w===0)extent=v});if(!Number.isFinite(extent)||extent<=0)throw new Error(`Invalid MVT extent in layer ${name||'[unnamed]'}`);return{name,extent,featureBuffers}}
function interesting(name){return/road|street|transport|highway|path|trail|track|rail|train|ferry|route|water|river|lake|landuse|landcover|park|boundary|admin|place|building|coast/i.test(name)}
export function decodeMvt(arrayBuffer,tileX,tileY,z,{maxFeatures=350}={}){
  const layerBuffers=[];fields(new Uint8Array(arrayBuffer),(f,w,v)=>{if(f===3&&w===2)layerBuffers.push(v)})
  const parsed=layerBuffers.map(parseLayer).filter(l=>interesting(l.name)),out=[];const perLayer=Math.max(20,Math.floor(maxFeatures/Math.max(1,parsed.length)));let truncated=false
  for(const layer of parsed){let emitted=0;for(const fb of layer.featureBuffers){const decoded=decodeFeature(fb,layer.extent,tileX,tileY,z,layer.name);for(const feature of decoded){if(emitted>=perLayer||out.length>=maxFeatures){truncated=true;break}out.push(feature);emitted++}if(emitted>=perLayer||out.length>=maxFeatures){if(layer.featureBuffers.length>emitted)truncated=true;break}}}
  out.meta={truncated,layerCount:parsed.length,featureCount:out.length};return out
}

function haversineKm(a,b){const R=6371,toRad=x=>x*Math.PI/180,dLat=toRad(b.lat-a.lat),dLon=toRad(b.lon-a.lon),q=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(q)))}
function normalizedLon(value){let x=Number(value);while(x>=180)x-=360;while(x<-180)x+=360;return x}
function networkLayerAllowed(name,mode){
  const n=String(name||'').toLowerCase()
  if(mode==='Car')return /road|street|highway|transportation/.test(n)
  if(mode==='Walk'||mode==='Bike')return /road|street|highway|transportation|path|trail|track|pedestrian|cycle/.test(n)
  return false
}
class MinHeap{
  constructor(){this.a=[]}
  push(item){let i=this.a.push(item)-1;while(i){const p=(i-1)>>1;if(this.a[p][0]<=item[0])break;this.a[i]=this.a[p];i=p;this.a[i]=item}this.a[i]=item}
  pop(){if(!this.a.length)return null;const root=this.a[0],last=this.a.pop();if(this.a.length){let i=0;this.a[0]=last;while(true){let l=i*2+1,r=l+1,b=i;if(l<this.a.length&&this.a[l][0]<this.a[b][0])b=l;if(r<this.a.length&&this.a[r][0]<this.a[b][0])b=r;if(b===i)break;[this.a[i],this.a[b]]=[this.a[b],this.a[i]];i=b}}return root}
  get length(){return this.a.length}
}
function graphKey(p){return`${Number(p.lat).toFixed(4)},${normalizedLon(p.lon).toFixed(4)}`}
function buildNetworkGraph(features,mode,{maxNodes=60000}={}){
  const nodes=new Map(),adj=new Map();let capped=false
  const ensure=p=>{const key=graphKey(p);if(!nodes.has(key)){if(nodes.size>=maxNodes){capped=true;return null}nodes.set(key,{lat:Number(p.lat),lon:normalizedLon(p.lon)});adj.set(key,[])}return key}
  const link=(a,b)=>{if(!a||!b||a===b)return;const w=haversineKm(nodes.get(a),nodes.get(b));if(!Number.isFinite(w)||w<=0||w>100)return;adj.get(a).push([b,w]);adj.get(b).push([a,w])}
  for(const f of features||[]){if(f?.type!=='line'||!networkLayerAllowed(f.layer,mode))continue;let prev=null;for(const p of f.points||[]){if(!Number.isFinite(Number(p?.lat))||!Number.isFinite(Number(p?.lon)))continue;const key=ensure(p);if(!key)break;link(prev,key);prev=key}if(capped)break}
  return{nodes,adj,capped}
}
function nearestNode(nodes,point,maxSnapKm=30){let best=null,bestD=Infinity;for(const [key,p] of nodes){const d=haversineKm(point,p);if(d<bestD){bestD=d;best=key}}return bestD<=maxSnapKm?{key:best,distanceKm:bestD}:null}
function shortestPath(graph,start,end){
  if(start===end)return[start]
  const dist=new Map([[start,0]]),prev=new Map(),heap=new MinHeap();heap.push([0,start]);const visited=new Set()
  while(heap.length){const item=heap.pop();if(!item)break;const[d,u]=item;if(visited.has(u))continue;visited.add(u);if(u===end)break;for(const[v,w] of graph.adj.get(u)||[]){const nd=d+w;if(nd<(dist.get(v)??Infinity)){dist.set(v,nd);prev.set(v,u);heap.push([nd,v])}}}
  if(!dist.has(end))return null;const path=[];let cur=end;while(cur!=null){path.push(cur);if(cur===start)break;cur=prev.get(cur)}return path.at(-1)===start?path.reverse():null
}
export function deriveOfflineRouteSegments(model,features,{maxSnapKm=30,maxNodes=60000}={}){
  const mode=model?.transport?.primaryMode||'Any',total=model?.legs?.length||0
  if(!model?.transport?.confirmed)return{supported:false,complete:false,segments:[],routedLegs:0,totalLegs:total,reason:'Transport is not traveler-confirmed, so offline mode-specific routing was not attempted.'}
  if(!['Car','Walk','Bike'].includes(mode))return{supported:false,complete:false,segments:[],routedLegs:0,totalLegs:total,reason:`Offline PBF network routing is not asserted for confirmed ${mode}; the PBF remains a map background.`}
  if((model.transport?.scoped||[]).length)return{supported:false,complete:false,segments:[],routedLegs:0,totalLegs:total,reason:'Scoped transport rules exist; offline whole-trip road routing was withheld rather than collapsing them.'}
  if((model.transport?.pendingLegReviews||[]).length||(model.transport?.reconfirmationRequiredLegIds||[]).length)return{supported:false,complete:false,segments:[],routedLegs:0,totalLegs:total,reason:'Edited leg transport still needs traveler reconfirmation; offline route geometry was withheld.'}
  const incompatible=(model.legs||[]).find(leg=>!leg.modeConfirmed||leg.mode!==mode)
  if(incompatible)return{supported:false,complete:false,segments:[],routedLegs:0,totalLegs:total,reason:`Canonical leg ${Number(incompatible.index)+1} is not confirmed as ${mode}; offline whole-trip road routing was withheld.`}
  const graph=buildNetworkGraph(features,mode,{maxNodes});if(graph.nodes.size<2)return{supported:true,complete:false,segments:[],routedLegs:0,totalLegs:total,reason:`No usable ${mode.toLowerCase()} network was decoded from the selected PBF tiles.`}
  if(graph.capped)return{supported:true,complete:false,segments:[],routedLegs:0,totalLegs:model?.legs?.length||0,reason:'Offline routing graph exceeded its safety cap; no route geometry was asserted.'}
  const byId=new Map((model.occurrences||[]).map(o=>[o.occurrenceId,o])),segments=[];let routed=0
  for(const leg of model.legs||[]){const from=byId.get(leg.fromOccurrenceId),to=byId.get(leg.toOccurrenceId);if(!from?.resolution||!to?.resolution)continue
    const a=nearestNode(graph.nodes,from.resolution,maxSnapKm),b=nearestNode(graph.nodes,to.resolution,maxSnapKm);if(!a||!b)continue
    const keys=shortestPath(graph,a.key,b.key);if(!keys?.length)continue
    const points=[{lat:from.resolution.lat,lon:from.resolution.lon},...keys.map(k=>graph.nodes.get(k)),{lat:to.resolution.lat,lon:to.resolution.lon}]
    segments.push({legId:leg.id,fromOccurrenceId:leg.fromOccurrenceId,toOccurrenceId:leg.toOccurrenceId,mode,points,snapKm:{from:a.distanceKm,to:b.distanceKm}});routed++
  }
  const complete=total>0&&routed===total
  return{supported:true,complete,segments,routedLegs:routed,totalLegs:total,reason:complete?`Offline ${mode} network geometry routed all ${total} canonical legs.`:`Offline ${mode} network geometry routed ${routed}/${total} canonical legs; unrouted legs remain explicit gaps.`}
}

function lon2tileUnwrapped(lon,z){return Math.floor((lon+180)/360*2**z)}
function lat2tile(lat,z){const clamped=Math.max(-85.05112878,Math.min(85.05112878,lat)),rad=clamped*Math.PI/180;return Math.floor((1-Math.asinh(Math.tan(rad))/Math.PI)/2*2**z)}
function unwrapLons(values){const out=[];let prev=null;for(const rawValue of values){let lon=Number(rawValue);if(!Number.isFinite(lon))continue;if(prev!==null){while(lon-prev>180)lon-=360;while(lon-prev<-180)lon+=360}out.push(lon);prev=lon}return out}
function bbox(model){const pts=model.occurrences.filter(o=>o.resolution).map(o=>o.resolution);if(!pts.length)return null;const lons=unwrapLons(pts.map(p=>p.lon)),lats=pts.map(p=>p.lat).filter(Number.isFinite);if(!lons.length||!lats.length)return null;return{minLon:Math.min(...lons),maxLon:Math.max(...lons),minLat:Math.min(...lats),maxLat:Math.max(...lats),crossesDateline:lons.some(l=>l>180||l<-180)}}
function tileRange(b,z){const n=2**z,rawMinX=lon2tileUnwrapped(b.minLon,z),rawMaxX=lon2tileUnwrapped(b.maxLon,z),xValues=[...new Set(Array.from({length:Math.max(0,rawMaxX-rawMinX+1)},(_,i)=>((rawMinX+i)%n+n)%n))],minY=Math.max(0,Math.min(n-1,lat2tile(b.maxLat,z))),maxY=Math.max(0,Math.min(n-1,lat2tile(b.minLat,z)));return{xValues,minY,maxY,count:xValues.length*(maxY-minY+1)}}
export function choosePbfZoom(model,availableZooms=[],maxTiles=24){const b=bbox(model);if(!b)return null;const zs=[...availableZooms].map(Number).filter(Number.isFinite).sort((a,b)=>b-a);for(const z of zs){const r=tileRange(b,z);if(r.count<=maxTiles)return{z,...r,bbox:b}}return zs.length?{z:zs.at(-1),...tileRange(b,zs.at(-1)),bbox:b}:null}
export async function loadOfflinePbf(model,status,{signal,onProgress=()=>{},maxTiles=24,maxFeatures=1200}={}){
  if(!status?.available||!Array.isArray(status.zooms))return{features:[],complete:false,requestedTiles:0,succeededTiles:0,missingTiles:0,malformedTiles:0,message:'Offline PBF tiles are not available.'}
  const selection=choosePbfZoom(model,status.zooms,maxTiles);if(!selection)return{features:[],complete:false,requestedTiles:0,succeededTiles:0,missingTiles:0,malformedTiles:0,message:'No resolved route extent is available.'}
  if(selection.count>maxTiles)return{features:[],complete:false,requestedTiles:selection.count,succeededTiles:0,missingTiles:0,malformedTiles:0,message:`Route needs ${selection.count} tiles at available zoom ${selection.z}; offline background was not loaded.`}
  const features=[];let attempted=0,succeeded=0,missing=0,malformed=0,truncated=false
  for(const x of selection.xValues)for(let y=selection.minY;y<=selection.maxY;y++){
    onProgress(`Offline PBF ${attempted+1}/${selection.count}`);attempted++
    try{const r=await fetch(`/api/offline/tile/${selection.z}/${x}/${y}.pbf`,{signal});if(!r.ok){missing++;continue}const buf=await r.arrayBuffer();let decoded;try{decoded=decodeMvt(buf,x,y,selection.z,{maxFeatures:Math.max(20,maxFeatures-features.length)})}catch{malformed++;continue}succeeded++;if(decoded.meta?.truncated)truncated=true;features.push(...decoded);if(features.length>=maxFeatures)truncated=true}catch(e){if(e.name==='AbortError')throw e;missing++}
  }
  onProgress('');const complete=missing===0&&malformed===0&&!truncated&&succeeded===selection.count,parts=[`${succeeded}/${selection.count} tiles loaded`];if(missing)parts.push(`${missing} missing`);if(malformed)parts.push(`${malformed} malformed`);if(truncated)parts.push('feature cap reached')
  const kept=features.slice(0,maxFeatures),offlineRoute=deriveOfflineRouteSegments(model,kept),routeSegments=complete?offlineRoute.segments:[]
  const routeNote=complete?offlineRoute.reason:'Offline route geometry was withheld because the selected PBF background is incomplete.'
  return{features:kept,routeSegments,routeComplete:Boolean(complete&&offlineRoute.complete),routeRouting:offlineRoute,zoom:selection.z,tileCount:selection.count,requestedTiles:selection.count,succeededTiles:succeeded,missingTiles:missing,malformedTiles:malformed,truncated,complete,message:`Offline PBF ${complete?'complete':'incomplete'}: ${parts.join(' · ')}; ${features.length} renderable vector features. ${routeNote}`}
}
