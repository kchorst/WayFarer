import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function clean(value=''){return String(value??'').trim()}
function defaultConfig(){
  return {
    aiEndpoint: clean(process.env.WAYFINDER_AI_ENDPOINT),
    aiModel: clean(process.env.WAYFINDER_AI_MODEL),
    referenceEndpoint: clean(process.env.WAYFINDER_REFERENCE_ENDPOINT || 'http://127.0.0.1:8091'),
    gazetteerEndpoint: clean(process.env.WAYFINDER_GAZETTEER_ENDPOINT),
    allowWebGeocode: String(process.env.WAYFINDER_ALLOW_WEB_GEOCODE ?? '1') !== '0',
    mapQuestKey: clean(process.env.WAYFINDER_MAPQUEST_KEY),
    pbfRoot: clean(process.env.WAYFINDER_PBF_ROOT),
  }
}

export function settingsPath(){
  const explicit=clean(process.env.WAYFINDER_SETTINGS_PATH)
  if(explicit)return path.resolve(explicit)
  const base=process.platform==='win32'
    ? clean(process.env.APPDATA)||path.join(os.homedir(),'AppData','Roaming')
    : clean(process.env.XDG_CONFIG_HOME)||path.join(os.homedir(),'.config')
  return path.join(base,'WAYFINDER','settings.json')
}

export function loadRuntimeSettings(){
  const defaults=defaultConfig(),file=settingsPath()
  try{
    const parsed=JSON.parse(fs.readFileSync(file,'utf8'))
    return normalizeSettings({...defaults,...parsed})
  }catch{return normalizeSettings(defaults)}
}

export function normalizeSettings(value={}){
  return {
    aiEndpoint: clean(value.aiEndpoint),
    aiModel: clean(value.aiModel),
    referenceEndpoint: clean(value.referenceEndpoint)||'http://127.0.0.1:8091',
    gazetteerEndpoint: clean(value.gazetteerEndpoint),
    allowWebGeocode: value.allowWebGeocode!==false,
    mapQuestKey: clean(value.mapQuestKey),
    pbfRoot: clean(value.pbfRoot),
  }
}

export function saveRuntimeSettings(next={},current=loadRuntimeSettings()){
  const merged={...current}
  for(const key of ['aiEndpoint','aiModel','referenceEndpoint','gazetteerEndpoint','pbfRoot']){
    if(Object.prototype.hasOwnProperty.call(next,key))merged[key]=clean(next[key])
  }
  if(Object.prototype.hasOwnProperty.call(next,'allowWebGeocode'))merged.allowWebGeocode=Boolean(next.allowWebGeocode)
  if(Object.prototype.hasOwnProperty.call(next,'mapQuestKey')&&clean(next.mapQuestKey))merged.mapQuestKey=clean(next.mapQuestKey)
  if(next.removeMapQuestKey===true)merged.mapQuestKey=''
  const normalized=normalizeSettings(merged),file=settingsPath(),dir=path.dirname(file)
  fs.mkdirSync(dir,{recursive:true})
  const tmp=`${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp,JSON.stringify(normalized,null,2),'utf8')
  fs.renameSync(tmp,file)
  return normalized
}

export function publicRuntimeSettings(settings){
  const s=normalizeSettings(settings)
  return {
    aiEndpoint:s.aiEndpoint,
    aiModel:s.aiModel,
    referenceEndpoint:s.referenceEndpoint,
    gazetteerEndpoint:s.gazetteerEndpoint,
    allowWebGeocode:s.allowWebGeocode,
    pbfRoot:s.pbfRoot,
    mapQuestConfigured:Boolean(s.mapQuestKey),
    mapQuestKeyHint:s.mapQuestKey?`••••${s.mapQuestKey.slice(-4)}`:'',
    settingsPath:settingsPath(),
  }
}
