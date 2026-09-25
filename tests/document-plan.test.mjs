import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultDocumentPreferences, normalizeDocumentPreferences, createDocumentPlan } from '../public/core/documentPlan.js'
import { authorityFromProposal } from '../public/core/authority.js'
import { buildMapModel } from '../public/core/mapModel.js'
import { validatePersistedState } from '../public/core/persistence.js'

test('document preferences are normalized, cannot persist as all-off, and survive persisted trip validation',()=>{
  const defaults=defaultDocumentPreferences();assert.ok(Object.values(defaults.sections).every(Boolean))
  const recovered=normalizeDocumentPreferences({sections:{route:false,overview:false,stops:false,transport:false,practical:false}});assert.ok(Object.values(recovered.sections).every(Boolean))
  const a=authorityFromProposal({brief:'x',constraints:{start:'A',end:'B'},proposal:{stops:['A','B']}}),prefs={version:1,sections:{route:true,overview:false,stops:true,transport:false,practical:true}}
  const state=validatePersistedState({authority:a,documentPreferences:prefs});assert.deepEqual(state.documentPreferences,prefs)
})

test('DocumentPlan freezes selected sections against the same authority snapshot',()=>{
  const a=authorityFromProposal({brief:'x',constraints:{start:'A',end:'B'},proposal:{stops:['A','B']}}),map=buildMapModel(a,{}),prefs={version:1,sections:{route:true,overview:false,stops:true,transport:false,practical:false}}
  const plan=createDocumentPlan(a,map,prefs,{references:[{routeLabel:'A'}]});assert.equal(plan.tripId,a.id);assert.equal(plan.authorityVersion,a.version);assert.deepEqual(plan.selectedSections,['route','stops']);assert.equal(plan.includeSources,true)
})
