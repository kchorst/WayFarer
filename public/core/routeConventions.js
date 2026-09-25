// Data-driven recognition for well-established named routes. The Trip Basics
// parser treats matches as suggestions with provenance; entries never become
// traveler-owned constraints until the traveler confirms them.
export const ROUTE_CONVENTIONS=Object.freeze([
  Object.freeze({
    id:'shikoku-88-temple-pilgrimage',
    aliases:['shikoku'],
    contextAny:['pilgrimage','88','temple','route','walk','trek'],
    name:'Shikoku 88-Temple Pilgrimage',
    destination:'Shikoku, Japan',
    start:'Temple 1 — Ryōzenji',
    startNote:'Traditional start — suggested',
    end:'Temple 88 — Ōkuboji',
    endNote:'Traditional final temple — suggested',
    topology:'one_way',
    note:'Traditional numbered pilgrimage: Temple 1 is the conventional start and Temple 88 the traditional final temple.',
    contextOptions:[{id:'close-traditional-route',label:'Return to Temple 1 after Temple 88',effect:'return_to_start'}],
  }),
])

const norm=value=>String(value||'').trim().toLowerCase()
const hasPhrase=(text,phrase)=>norm(text).includes(norm(phrase))

export function findRouteConvention(text,catalog=ROUTE_CONVENTIONS){
  const source=norm(text)
  if(!source)return null
  for(const item of catalog||[]){
    if(!item||!Array.isArray(item.aliases)||!item.aliases.some(alias=>hasPhrase(source,alias)))continue
    if(Array.isArray(item.contextAny)&&item.contextAny.length&&!item.contextAny.some(word=>hasPhrase(source,word)))continue
    return structuredClone(item)
  }
  return null
}
