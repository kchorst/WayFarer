const MODES=['Any','Car','Train','Bus','Ferry','Walk','Bike','Air','Mixed','Scooter']
export function normalizeTransportMode(value='Any'){
  const key=String(value||'Any').trim().toLowerCase()
  if(key==='flight'||key==='fly'||key==='flying')return 'Air'
  return MODES.find(mode=>mode.toLowerCase()===key)||'Any'
}
