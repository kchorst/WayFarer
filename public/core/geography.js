const clean=v=>String(v??'').trim()
const key=v=>clean(v).toLocaleLowerCase('en').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[.’']/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim()

// ISO 3166-1 alpha-2 codes are data, not route-specific logic. Intl.DisplayNames
// turns them into the runtime's localized country names so country recognition is
// general and does not depend on a handful of itinerary-specific strings.
const ISO_ALPHA2=`AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(' ')
const display=typeof Intl!=='undefined'&&Intl.DisplayNames?new Intl.DisplayNames(['en'],{type:'region'}):null
const COUNTRY_BY_KEY=new Map()
for(const code of ISO_ALPHA2){const name=display?.of(code);if(name&&name!==code)COUNTRY_BY_KEY.set(key(name),code)}
for(const [name,code] of Object.entries({
  'United States':'US','United States of America':'US','USA':'US','U.S.A.':'US','US':'US','U.S.':'US',
  'United Kingdom':'GB','UK':'GB','U.K.':'GB','Great Britain':'GB',
  'South Korea':'KR','Republic of Korea':'KR','North Korea':'KP','Russia':'RU','Vietnam':'VN','Viet Nam':'VN',
  'Czech Republic':'CZ','Czechia':'CZ','Ivory Coast':'CI','Côte d’Ivoire':'CI','Cote d Ivoire':'CI',
  'Cape Verde':'CV','Eswatini':'SZ','Swaziland':'SZ','Laos':'LA','Bolivia':'BO','Venezuela':'VE',
  'Moldova':'MD','Tanzania':'TZ','Syria':'SY','Iran':'IR','Palestine':'PS','Taiwan':'TW'
}))COUNTRY_BY_KEY.set(key(name),code)

export function countryCodeForName(value){return COUNTRY_BY_KEY.get(key(value))||''}
export function isCountryName(value){return Boolean(countryCodeForName(value))}
export function geographyNameKey(value){return key(value)}
