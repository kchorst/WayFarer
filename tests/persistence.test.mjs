import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePersistedState } from '../public/core/persistence.js'
import { emptyAuthority, applyCommand } from '../public/core/authority.js'

test('persisted state rejects unsupported schema and structurally corrupt authority',()=>{
  let a=emptyAuthority();a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'A',role:'start'},{label:'B',role:'end'}]}})
  assert.equal(validatePersistedState({authority:a}).authority.id,a.id)
  assert.throws(()=>validatePersistedState({authority:{...a,schemaVersion:99}}),/Unsupported trip schema/)
  const duplicate={...a,occurrences:[a.occurrences[0],{...a.occurrences[1],id:a.occurrences[0].id}]}
  assert.throws(()=>validatePersistedState({authority:duplicate}),/integrity checks/)
})

test('persisted Spark gallery cannot belong to a different active trip',()=>{
  let a=emptyAuthority({brief:'Trip A'});a=applyCommand(a,{type:'SET_PRECISION_OCCURRENCES',payload:{occurrences:[{label:'Paris',role:'start'},{label:'London',role:'end'}]}})
  const e={id:'explore_other',prompt:'Different trip',confirmed:true,proposals:[]}
  const restored=validatePersistedState({authority:a,activeSpark:{id:'active_other-trip',tripId:'other-trip',prompt:'Different trip',exploration:e},exploration:e,revisionLog:[]})
  assert.equal(restored.activeSpark,null)
  assert.equal(restored.authority.id,a.id)
})

test('orphan composer text is not restored as durable trip state',()=>{
  const restored=validatePersistedState({briefText:'I wish this random test text stayed here',revisionLog:[]})
  assert.equal(restored.briefText,'')
})
