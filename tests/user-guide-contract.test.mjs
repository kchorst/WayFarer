import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..')
const read=name=>fs.readFileSync(resolve(root,name),'utf8')
const guide=read('USER_GUIDE.md'),readme=read('README.md'),html=read('public/index.html'),app=read('public/app.js'),launcher=read('WAYFINDER.cmd'),recovery=read('SUPPORT/RECOVER-WAYFINDER.cmd'),control=read('wayfinder-control.mjs'),server=read('server.mjs'),lifecycle=read('tests/lifecycle.test.mjs'),serverLifecycle=read('server-lifecycle.mjs'),releaseManager=read('RELEASE_MANAGER.md'),renderedHarness=read('tests/release-rendered.py'),matrixHarness=read('tests/release-rendered-matrix.py'),matrixAggregator=read('tests/release-rendered-matrix-all.py'),releaseGate=read('release-gate.mjs'),acceptance=JSON.parse(read('ACCEPTANCE_JOURNEYS.json'))

test('packaged traveler documentation exists and README links to the guide',()=>{
  assert.match(readme,/\[USER_GUIDE\.md\]\(USER_GUIDE\.md\)/)
  assert.match(guide,/^# WAYFINDER User Guide/m)
  assert.doesNotMatch(readme,/preserves valid partial text/i)
})

test('guide workflow order matches the shipped workspace tabs',()=>{
  const order=['data-tab="revision"','data-tab="precision"','data-tab="mapping"','data-tab="document"'].map(x=>html.indexOf(x))
  assert.ok(order.every(x=>x>=0)); assert.deepEqual([...order].sort((a,b)=>a-b),order)
  for(const label of ['Explore trip ideas','Start in Precision','Apply revision','Save Precision','Resolve route','Route with MapQuest','Load offline map','Open same route in Google Maps','Open same route in MapQuest','Build document','Export trip','Import trip','New trip','Settings']){
    assert.ok(html.includes(label),`missing shipped control: ${label}`)
    assert.ok(guide.includes(`**${label}**`)||guide.includes(`\`${label}\``)||guide.includes(label),`guide does not name shipped control: ${label}`)
  }
})

test('Precision owns excluded places separately from the active routed spine',()=>{
  assert.match(html,/id="excludedPlacesInput"/)
  assert.doesNotMatch(html,/class="stop-disposition"[^>]*>[\s\S]*?<option value="excluded">excluded<\/option>/)
  assert.match(app,/base\.placeConstraints=\{[\s\S]{0,240}excluded:textLines\(\$\('#excludedPlacesInput'\)\.value\)/)
  assert.match(app,/precisionDraftFromUI/)
  assert.match(guide,/Excluded places \(not routed\)/)
})

test('Route Visual contains its own coordinate-resolution action and visible status',()=>{
  assert.match(html,/id="mapResolveBtn"[^>]*>Resolve route<\/button>/)
  assert.match(html,/id="mapStatus"/)
  assert.match(app,/\$\('#mapResolveBtn'\)\.onclick=.*resolveRoute\(\$\('#mapStatus'\)\)/)
  assert.match(app,/target==='mapping'\)status\(\$\('#mapStatus'\)/)
  assert.match(guide,/Resolve route.*available in both \*\*Precision\*\* and \*\*Route visual\*\*/s)
})

test('single normal Windows launcher and in-app shutdown behavior described by the guide are shipped',()=>{
  assert.match(launcher,/Node\.js 20 or newer/i)
  assert.match(launcher,/wayfinder-control\.mjs launch/)
  assert.doesNotMatch(launcher,/node server\.mjs/)
  assert.match(control,/cmd==='launch'/)
  assert.match(control,/WAYFINDER_MANAGED_LAUNCH/)
  assert.match(html,/id="exitBtn"[^>]*>Exit WAYFINDER<\/button>/)
  assert.match(app,/\/api\/system\/client\/exit/)
  assert.match(app,/pagehide.*closeClientSession/)
  assert.match(server,/\/api\/system\/client\/register/)
  assert.match(server,/\/api\/system\/client\/close/)
  assert.match(server,/\/api\/system\/client\/exit/)
  assert.match(recovery,/wayfinder-control\.mjs stop/)
  assert.doesNotMatch(guide,/START-WAYFINDER\.cmd|STOP-WAYFINDER\.cmd/)
  assert.match(guide,/WAYFINDER\.cmd/)
  assert.match(guide,/Exit WAYFINDER/)
  assert.match(guide,/close the last WAYFINDER browser tab\/window/i)
  assert.match(readme,/One-app lifecycle and deleteability/)
})

test('Release Manager owns both normal lifecycle paths and extracted-folder deleteability',()=>{
  assert.match(serverLifecycle,/server-control\.json/)
  assert.match(serverLifecycle,/server\.lock/)
  assert.match(lifecycle,/in-app Exit.*extracted folder deletable/i)
  assert.match(lifecycle,/closing the last registered app window auto-stops/i)
  assert.match(lifecycle,/fs\.renameSync\(app,renamed\)/)
  assert.match(lifecycle,/fs\.rmSync\(renamed/)
  assert.match(releaseManager,/Mandatory lifecycle proof/i)
  assert.match(releaseManager,/rename extraction.*delete extraction/i)
})

test('Spark guide matches fast Trip Basics, speculative work, progressive concepts, and collapsed selected-concept workspace',()=>{
  assert.match(html,/id="tripBasicsPanel"/)
  assert.match(html,/Confirm &amp; build ideas/)
  assert.match(app,/deriveTripBasics\(brief\)/)
  assert.match(app,/startSpeculativeSpark\(e\)/)
  assert.match(app,/generateSparkFromContract/)
  assert.match(app,/onProposal:p=>/)
  assert.match(app,/Show ideas \/ Change concept/)
  assert.match(app,/spark-collapsed/)
  assert.match(guide,/Confirm trip basics/i)
  assert.match(guide,/background|speculative/i)
  assert.match(guide,/first visible route skeleton|route skeleton.*enrich/i)
  assert.match(guide,/Selected trip concept/)
  assert.match(guide,/Show ideas \/ Change concept/)
})

test('Trip Basics is generic, multi-area aware, and first-route timing is release-gated',()=>{
  assert.match(html,/Destinations \/ trip area/)
  assert.doesNotMatch(html,/starting temple|traditional finish/i)
  assert.match(app,/splitDestinationAreas/)
  assert.match(guide,/Sardinia \+ Corsica/)
  assert.match(guide,/15 seconds or less|15-second/i)
  assert.match(guide,/Generic Trip Basics stays generic/i)
  assert.match(releaseManager,/First useful Spark route skeleton target.*15 seconds/i)
  assert.match(renderedHarness,/firstIdeaAfterConfirmMs/)
  assert.match(renderedHarness,/sardinia-corsica-multi-area/)
})

test('Documentation guide matches persisted section preferences and source citations',()=>{
  assert.match(html,/id="documentSections"/)
  assert.match(app,/documentPreferences/)
  assert.match(app,/normalizeDocumentPreferences/)
  assert.match(guide,/Route at a glance/)
  assert.match(guide,/Stop-by-stop planning notes/)
  assert.match(guide,/Sources \/ References/)
  assert.match(guide,/\[S1\]/)
  assert.doesNotMatch(guide,/does not yet contain the former document-section selection boxes/i)
  assert.doesNotMatch(readme,/document-section preferences are not yet restored/i)
})

test('Refine keeps the original Spark request visible and provides a return path to Spark',()=>{
  for(const id of ['originalRequestText','selectedTripContext','refineBackToSparkBtn','editOriginalRequestBtn','sparkReturnBtn'])assert.match(html,new RegExp(`id="${id}"`))
  assert.doesNotMatch(html,/revisionText[^>]*placeholder="[^"]*Bologna/i)
  assert.match(guide,/Original Spark request/)
  assert.match(guide,/Spark ideas & original request/)
})

test('Spark progress exposes immediate traveler-facing feedback and background status rather than hidden reasoning',()=>{
  for(const id of ['tripBasicsSignals','sparkLiveStatus','backgroundSignals','sparkSignals'])assert.match(html,new RegExp(`id="${id}"`))
  assert.match(html,/What WAYFINDER understood immediately/)
  assert.match(app,/Building trip ideas|Background preparation|background while you review/i)
  assert.match(app,/Confirmed Spark contract/)
  assert.match(app,/Scope:/)
  assert.match(app,/Start:/)
  assert.match(app,/Duration:/)
  assert.match(guide,/What WAYFINDER understood immediately/)
  assert.match(guide,/Background preparation/)
  assert.match(guide,/planning signals|confirmed Spark contract/i)
  assert.match(guide,/not.*chain-of-thought|does not expose.*chain-of-thought/i)
})

test('Precision commits one coherent Trip Draft instead of replaying independent fields',()=>{
  assert.match(app,/precisionDraftFromUI/)
  assert.match(app,/commitTripDraft\(original,draft\)/)
  assert.match(app,/previewTripDraft/)
  assert.doesNotMatch(app,/function savePrecision[\s\S]{0,1800}applyCommands\(/)
  assert.match(guide,/Trip Draft|atomic|one coherent change/i)
})

test('Trip Basics ships as the fast gate before ideas and supports open answers without becoming Precision',()=>{
  for(const id of ['tripBasicsPanel','tripBasicsPrompt','basicsDestination','basicsStart','basicsEnd','basicsDuration','basicsTopology','confirmBasicsBtn'])assert.match(html,new RegExp(`id="${id}"`))
  assert.match(app,/function startSparkExploration\(\)[\s\S]{0,900}deriveTripBasics\(brief\)[\s\S]{0,900}renderTripBasics\(\)/)
  assert.match(app,/startSpeculativeSpark\(e\)/)
  assert.match(app,/Open — suggest for me/)
  assert.match(guide,/open.*valid|leave.*open|Open.*WAYFINDER/is)
})

test('downstream stages never secretly commit an unsaved Precision draft',()=>{
  const slices=[
    app.match(/async function resolveRoute\([\s\S]*?\r?\n}\r?\n\$\('#resolveBtn'/)?.[0]||'',
    app.match(/async function routeWithMapQuest\([\s\S]*?\r?\n}\r?\n\$\('#routeMapQuestBtn'/)?.[0]||'',
    app.match(/async function loadPbfMap\([\s\S]*?\r?\n}\r?\n\$\('#offlinePbfBtn'/)?.[0]||'',
    app.match(/async function buildDocument\([\s\S]*?\r?\n}\r?\n\$\('#documentBtn'/)?.[0]||'',
  ]
  assert.ok(slices.every(Boolean),'could not inspect downstream action functions')
  for(const section of slices)assert.doesNotMatch(section,/savePrecision\(/)
  assert.match(app,/guardCommittedAuthority/)
  assert.match(guide,/last saved (?:trip|TripAuthority)|never commit the draft behind your back|does not silently save/i)
})

test('new Spark exploration is separate from the adopted trip until explicit adoption',()=>{
  assert.match(app,/exploration:null,activeSpark:null/)
  assert.match(app,/function restoreActiveSparkExploration/)
  assert.match(app,/state\.activeSpark=\{id:`active_\$\{candidate\.id\}`/)
  assert.match(app,/state\.revisionLog=\[\]/)
  assert.match(guide,/current authoritative trip.*remains|does not replace.*current|until.*adopt/i)
})


test('User Guide acceptance markers and rendered harness cover the same required release journeys',()=>{
  const required=acceptance.journeys.filter(x=>x.required!==false)
  assert.ok(required.length>=10)
  for(const journey of required){
    assert.ok(guide.includes(`<!-- ${journey.guideMarker} -->`),`guide missing ${journey.guideMarker}`)
    assert.match(renderedHarness,new RegExp(`['\"]${journey.id}['\"]`),`rendered harness missing ${journey.id}`)
  }
})

test('Release Manager contract blocks test-only promotion and requires exact rendered evidence',()=>{
  assert.match(releaseManager,/Green test counts alone never produce READY/i)
  assert.match(releaseManager,/exact packaged copy/i)
  assert.match(releaseManager,/Rendered adversarial walkthrough gate/i)
  assert.match(releaseManager,/Invariant \/ property gate/i)
  assert.match(releaseManager,/Independent hostile Release Manager audit/i)
  assert.match(readme,/Release Manager gate/)
  assert.match(readme,/ACCEPTANCE_JOURNEYS\.json/)
})

test('unverified Spark geography is blocked at the adoption boundary, not only by disabled buttons',()=>{
  assert.match(app,/function chooseProposal[\s\S]{0,900}verificationStatus==='unverified'[\s\S]{0,500}cannot be adopted/i)
})

test('Spark geographic scope validator is wired into both speculative and confirmed generation',()=>{
  assert.match(app,/validateProposalScopeGeography\(proposal,provisional/)
  assert.match(app,/validateProposalScopeGeography\(proposal,contract/)
  assert.doesNotMatch(app,/validateSparkProposalGeography/)
})


test('slow-model release gate proves first useful validated skeleton under near-target latency',()=>{
  assert.match(guide,/RM-SLOW-MODEL-FIRST-SKELETON/)
  assert.match(guide,/delays the first Spark stream to near the 15-second target/i)
  assert.match(renderedHarness,/__sparkFirstDelayMs=12500/)
  assert.match(renderedHarness,/firstUsefulValidatedSkeletonMs/)
  assert.match(renderedHarness,/assert first_ms<15000/)
  assert.match(renderedHarness,/Saint-Tropez.*not in route/s)
})

test('single-worker local-model release gate prevents concurrent Spark startup jobs and requires upstream cancellation coverage',()=>{
  assert.match(guide,/RM-SERIAL-LOCAL-MODEL/)
  assert.match(guide,/single-worker service/i)
  assert.match(renderedHarness,/scenario_serial_local_model_jamaica/)
  assert.match(renderedHarness,/maxConcurrentLocalModelJobs/)
  assert.match(app,/targetCount:1,enrich:false/)
  assert.match(app,/await prep\.generationPromise/)
  assert.match(server,/requestRuntimeSignal\(req,res,INTERACTIVE_AI_TIMEOUT_MS\)/)
  assert.ok(read('tests/chat-cancellation.test.mjs').includes('cancels the upstream local-model job'))
})

test('rendered guide walkthrough exercises documented non-Windows controls rather than only finding source strings',()=>{
  const controls=[
    ['Settings','#settingsBtn'],['Local AI endpoint','#settingsAiEndpoint'],['Model name','#settingsAiModel'],
    ['Kiwix / local references','#settingsReferenceEndpoint'],['Local gazetteer endpoint','#settingsGazetteerEndpoint'],
    ['MapQuest API key','#settingsMapQuestKey'],['Offline map library folder','#settingsPbfRoot'],['Browse…','#browsePbfRootBtn'],
    ['Allow online geocoding fallback when online','#settingsAllowWebGeocode'],['Save settings','#saveSettingsBtn'],['Refresh status','#refreshSettingsBtn'],
    ['Check local services','#checkServicesBtn'],['Explore trip ideas','#sparkBtn'],['Confirm & build ideas','#confirmBasicsBtn'],
    ['Apply revision','#revisionBtn'],['Back to Spark ideas','#refineBackToSparkBtn'],['+ Add stop','#addStopBtn'],
    ['Discard unsaved changes','#discardPrecisionBtn'],['Save Precision','#savePrecisionBtn'],['Resolve route','#mapResolveBtn'],
    ['Route with MapQuest','#routeMapQuestBtn'],['Load offline map','#offlinePbfBtn'],['Open same route in Google Maps','#googleBtn'],
    ['Open same route in MapQuest','#mapQuestShareBtn'],['Build document','#documentBtn'],['Copy','#copyDocBtn'],
    ['Export trip','#exportBtn'],['Import trip','#importFile'],['New trip','#resetBtn'],['Exit WAYFINDER','#exitBtn']
  ]
  assert.match(guide,/RM-GUIDE-EXECUTABLE-CONTROLS/)
  assert.match(renderedHarness,/scenario_guide_executable_controls/)
  for(const [label,selector] of controls){
    assert.ok(guide.includes(`**${label}**`)||guide.includes(label),`guide missing documented control ${label}`)
    const id=selector.startsWith('#')?selector.slice(1):null
    if(id)assert.ok(html.includes(`id="${id}"`),`rendered UI missing ${selector}`)
  }
  for(const requiredSnippet of ['#settingsBtn','#saveSettingsBtn','#refreshSettingsBtn','#sparkBtn','#confirmBasicsBtn','#revisionBtn','#addStopBtn','#discardPrecisionBtn','#savePrecisionBtn','[data-tab="mapping"]','#documentBtn']){
    assert.ok(renderedHarness.includes(requiredSnippet),`guide rendered walkthrough does not exercise ${requiredSnippet}`)
  }
})


test('canonical rendered journey families require all four adversarial variants and hash-bound matrix evidence',()=>{
  assert.match(guide,/RM-FOUR-VARIANT-MATRIX/)
  assert.match(releaseManager,/normal.*contradictory.*degraded\/offline.*navigation\/backtracking/is)
  for(const family of ['vague-named-route','island-loop','one-way-city-anchors','multi-country-route','multi-area-island','revision','precision','mapping','documentation','return-to-spark','save-reload-import']){
    assert.ok(matrixHarness.includes(`'${family}'`),`matrix missing canonical family ${family}`)
    assert.ok(matrixAggregator.includes(`'${family}'`),`aggregator missing canonical family ${family}`)
  }
  for(const variant of ['normal','contradictory','degraded','navigation']){
    assert.ok(matrixHarness.includes(`'${variant}'`),`matrix missing variant ${variant}`)
    assert.ok(matrixAggregator.includes(`'${variant}'`),`aggregator missing variant ${variant}`)
  }
  assert.match(releaseGate,/RENDERED_VARIANT_EVIDENCE\.json/)
  assert.match(releaseGate,/matrixEvidence\.criticalHash!==criticalHash/)
  assert.match(releaseGate,/rendered matrix missing\/not passing/)
})

test('every numbered User Guide section has an executable acceptance owner',()=>{
  const ga=JSON.parse(read('GUIDE_ACCEPTANCE.json'))
  const sections=[...guide.matchAll(/^## (\d+)\./gm)].map(m=>Number(m[1]))
  assert.deepEqual(sections,[1,2,3,4,5,6,7,8,9,10,11,12,13])
  assert.equal(ga.sections.filter(x=>x.required!==false).length,13)
  for(const [i,section] of ga.sections.entries()){
    assert.ok(section.id.startsWith(`${i+1}-`),`guide acceptance entry ${i+1} is not aligned to guide section`)
    assert.ok(section.nativeWindows||section.renderedScenarios?.length||section.matrixCells?.length,`${section.id} has no executable owner`)
  }
  assert.match(releaseGate,/GUIDE_ACCEPTANCE\.json/)
  assert.match(releaseGate,/executable User Guide acceptance must own all 13 guide sections/)
})


test('native Windows certificate verifies complete package integrity and live background work before Exit',()=>{
  const win=read('tests/windows-lifecycle-native.ps1')
  assert.match(win,/verify-integrity\.mjs/)
  assert.match(win,/integrityVerified=\$true/)
  assert.match(win,/jobState.*starting.*working/s)
  assert.match(releaseGate,/requiredChecks=\['integrityVerified','launcherUsed'/)
})
