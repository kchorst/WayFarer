export const DOCUMENT_SECTIONS=Object.freeze([
  {key:'route',label:'Route at a glance',description:'Ordered canonical route occurrences.'},
  {key:'overview',label:'Overview',description:'Trip-wide summary from the frozen authority.'},
  {key:'stops',label:'Stop-by-stop planning notes',description:'Planning notes for every canonical route occurrence.'},
  {key:'transport',label:'Transport notes',description:'Traveler-confirmed and unresolved transport guidance.'},
  {key:'practical',label:'Practical preparation',description:'Preparation and verification reminders.'},
])

export function defaultDocumentPreferences(){
  return{version:1,sections:Object.fromEntries(DOCUMENT_SECTIONS.map(s=>[s.key,true]))}
}

export function normalizeDocumentPreferences(value){
  const base=defaultDocumentPreferences(),raw=value&&typeof value==='object'?value:{},sections=raw.sections&&typeof raw.sections==='object'?raw.sections:{}
  for(const def of DOCUMENT_SECTIONS)if(def.key in sections)base.sections[def.key]=Boolean(sections[def.key])
  // A travel document must contain something. Corrupt/all-off imported settings recover to the
  // complete default instead of producing an empty document while claiming success.
  if(!DOCUMENT_SECTIONS.some(s=>base.sections[s.key]))return defaultDocumentPreferences()
  return base
}

export function createDocumentPlan(authority,mapModel,preferences,{references=[]}={}){
  if(!authority||!mapModel||mapModel.tripId!==authority.id||Number(mapModel.authorityVersion)!==Number(authority.version))throw new Error('Document plan snapshot does not match the authoritative trip version.')
  const prefs=normalizeDocumentPreferences(preferences),selected=DOCUMENT_SECTIONS.filter(s=>prefs.sections[s.key]).map(s=>s.key)
  return Object.freeze({
    tripId:authority.id,
    authorityVersion:authority.version,
    preferences:prefs,
    selectedSections:selected,
    includeSources:Array.isArray(references)&&references.length>0,
  })
}
