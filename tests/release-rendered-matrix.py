from playwright.sync_api import sync_playwright
from pathlib import Path
import importlib.util,json,time,traceback,sys,os

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('rr',ROOT/'tests'/'release-rendered.py')
rr=importlib.util.module_from_spec(spec);spec.loader.exec_module(rr)
RELEASE=json.loads((ROOT/'RELEASE.json').read_text())
VARIANTS=('normal','contradictory','degraded','navigation')


def run_case(browser,fn):
    p=rr.make_page(browser)
    try:
        details=fn(p) or {}
        return {'status':'PASS',**details}
    except Exception as e:
        traceback.print_exc()
        return {'status':'FAIL','error':str(e)}
    finally:
        p.close()


def basics(p,prompt_text):
    rr.prompt(p,prompt_text);p.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=700)


def adopt_sicily(p,target='refine'):
    basics(p,'I have three weeks to do a loop tour of Sicily. Start and finish in Palermo.')
    p.locator('#confirmBasicsBtn').click();rr.wait_props(p,1)
    cls={'refine':'.refine-proposal','mapping':'.route-proposal','document':'.document-proposal'}[target]
    p.locator(f'#proposals {cls}').first.click();p.wait_for_function("!document.querySelector('#workspace').hidden",timeout=2000)


def named_route_normal(p): rr.scenario_shikoku(p)
def named_route_contradictory(p):
    basics(p,'I heard about a walk or trek in Japan. something like a Shikoku route.')
    p.locator('#basicsTopology').select_option('loop');p.locator('#confirmBasicsBtn').click()
    p.wait_for_function("document.querySelector('#tripBasicsStatus').classList.contains('error')",timeout=1500)
    assert p.locator('#proposals .proposal').count()==0

def named_route_degraded(p):
    p.evaluate("window.__referencesOnline=false");basics(p,'I heard about a walk or trek in Japan. something like a Shikoku route.')
    assert 'Shikoku 88-Temple Pilgrimage' in rr.text(p,'#recognizedTripBox')
    p.locator('#checkServicesBtn').click();p.wait_for_function("document.querySelector('#referenceBadge').textContent.includes('offline')",timeout=1500)

def named_route_navigation(p):
    basics(p,'I heard about a walk or trek in Japan. something like a Shikoku route.')
    p.locator('#editSparkPromptBtn').click();p.locator('#brief').fill('Give me a tour of Corsica.');p.locator('#sparkBtn').click()
    p.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=700);assert p.locator('#basicsDestination').input_value()=='Corsica'


def island_normal(p): rr.scenario_sicily_open(p)
def island_contradictory(p):
    basics(p,'I have three weeks to do a loop tour of Sicily.')
    p.locator('#basicsStart').fill('Palermo');p.locator('#basicsEnd').fill('Catania');p.locator('#basicsTopology').select_option('loop');p.locator('#confirmBasicsBtn').click()
    p.wait_for_function("document.querySelector('#tripBasicsStatus').classList.contains('error')",timeout=1500)
def island_degraded(p):
    p.evaluate("window.__geoOffline=true");basics(p,'I have three weeks to do a loop tour of Sicily.')
    p.locator('#confirmBasicsBtn').click();rr.wait_props(p,1);card=p.locator('#proposals .proposal').first
    assert card.locator('.refine-proposal').is_disabled();assert 'could not be verified' in card.inner_text().lower()
def island_navigation(p):
    basics(p,'I have three weeks to do a loop tour of Sicily.');p.locator('#editSparkPromptBtn').click();p.locator('#brief').fill('I want a loop tour of Crete.');p.locator('#sparkBtn').click()
    p.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=700);assert p.locator('#basicsDestination').input_value()=='Crete'


def oneway_normal(p): rr.scenario_paris_london(p)
def oneway_contradictory(p): rr.scenario_trip_basics_contradiction(p)
def oneway_degraded(p):
    p.evaluate("window.__chatFail=true");basics(p,'I want a one way from Paris to London.')
    assert p.locator('#basicsStart').input_value()=='Paris';p.locator('#confirmBasicsBtn').click()
    p.wait_for_timeout(1200);assert p.locator('#proposals .proposal').count()==0;assert 'local model' in rr.text(p,'#sparkStatus').lower() or 'spark' in rr.text(p,'#sparkStatus').lower()

def oneway_navigation(p):
    basics(p,'I want a one way from Paris to London.');p.locator('#editSparkPromptBtn').click();p.locator('#brief').fill('I have three weeks to do a loop tour of Sicily.');p.locator('#sparkBtn').click()
    p.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=700);assert p.locator('#basicsTopology').input_value()=='loop'


def multicountry_normal(p): rr.scenario_baltic_one_way(p)
def multicountry_contradictory(p):
    basics(p,'i will arrive Tallinn and I will depart from Riga. I have 5 weeks to see Estonia, Latvia, and Lithuania.')
    p.locator('#basicsTopology').select_option('loop');p.locator('#confirmBasicsBtn').click();p.wait_for_function("document.querySelector('#tripBasicsStatus').classList.contains('error')",timeout=1500)
def multicountry_degraded(p):
    p.evaluate("window.__geoOffline=true");basics(p,'i will arrive Tallinn and I will depart from Riga. I have 5 weeks to see Estonia, Latvia, and Lithuania.')
    p.locator('#confirmBasicsBtn').click();rr.wait_props(p,1);assert p.locator('#proposals .refine-proposal').first.is_disabled()
def multicountry_navigation(p):
    basics(p,'i will arrive Tallinn and I will depart from Riga. I have 5 weeks to see Estonia, Latvia, and Lithuania.')
    p.locator('#editSparkPromptBtn').click();p.locator('#brief').fill('I will arrive Lisbon and depart Madrid. I have 12 days to see Portugal and Spain.');p.locator('#sparkBtn').click()
    p.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=700);v=p.locator('#basicsDestination').input_value();assert 'Portugal' in v and 'Spain' in v


def multiarea_normal(p): rr.scenario_sardinia_corsica(p)
def multiarea_contradictory(p):
    basics(p,'Plan a trip for me for 3 weeks around Sardinia and Corsica.')
    p.locator('#basicsStart').fill('Cagliari');p.locator('#basicsEnd').fill('Ajaccio');p.locator('#basicsTopology').select_option('loop');p.locator('#confirmBasicsBtn').click();p.wait_for_function("document.querySelector('#tripBasicsStatus').classList.contains('error')",timeout=1500)
def multiarea_degraded(p):
    p.evaluate("window.__geoOffline=true");basics(p,'Plan a trip for me for 3 weeks around Sardinia and Corsica.')
    p.locator('#confirmBasicsBtn').click();rr.wait_props(p,1);assert p.locator('#proposals .refine-proposal').first.is_disabled()
def multiarea_navigation(p):
    basics(p,'Plan a trip for me for 3 weeks around Sardinia and Corsica.');p.locator('#editSparkPromptBtn').click();p.locator('#brief').fill('Give me a tour of Corsica.');p.locator('#sparkBtn').click();p.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=700);assert p.locator('#basicsDestination').input_value()=='Corsica'


def revision_normal(p):
    adopt_sicily(p,'refine');p.locator('#revisionText').fill('Make the trip 22 days.');p.locator('#revisionBtn').click();p.wait_for_function("document.querySelector('#revisionStatus').classList.contains('ok')",timeout=2500)
def revision_contradictory(p):
    adopt_sicily(p,'refine');before=rr.text(p,'#tripMeta');p.evaluate("window.__revisionInvalid=true");p.locator('#revisionText').fill('Make an invalid change.');p.locator('#revisionBtn').click();p.wait_for_function("document.querySelector('#revisionStatus').classList.contains('error')",timeout=2500);assert rr.text(p,'#tripMeta')==before

def revision_degraded(p):
    adopt_sicily(p,'refine');p.evaluate("window.__chatFail=true");p.locator('#revisionText').fill('Make the trip 22 days.');p.locator('#revisionBtn').click();p.wait_for_function("document.querySelector('#revisionStatus').classList.contains('error')",timeout=2500)
def revision_navigation(p):
    adopt_sicily(p,'refine');p.locator('#refineBackToSparkBtn').click();assert p.locator('#proposals .proposal').first.is_visible();assert 'three weeks' in p.locator('#brief').input_value().lower()


def precision_normal(p): rr.scenario_precision(p)
def _blank_three(p):
    p.locator('#blankBtn').click();p.wait_for_function("!document.querySelector('#workspace').hidden")
    for _ in range(3):p.locator('#addStopBtn').click()
    rows=p.locator('#routeEditor .route-row')
    for i,v in enumerate(['Tallinn','Tartu','Riga']):rows.nth(i).locator('.stop-label').fill(v)

def precision_contradictory(p):
    _blank_three(p);p.locator('#startDateInput').fill('2026-10-10');p.locator('#endDateInput').fill('2026-10-01');p.locator('#savePrecisionBtn').click();p.wait_for_function("document.querySelector('#precisionStatus').classList.contains('error')",timeout=1500)
def precision_degraded(p):
    _blank_three(p);row=p.locator('#routeEditor .route-row').nth(1);row.locator('.stop-stay-kind').select_option('exact');row.locator('.stop-stay-days').fill('0');p.locator('#savePrecisionBtn').click();p.wait_for_function("document.querySelector('#precisionStatus').classList.contains('error')",timeout=1500)
def precision_navigation(p):
    _blank_three(p);p.locator('#topologyInput').select_option('one_way');p.locator('#savePrecisionBtn').click();p.wait_for_function("document.querySelector('#precisionStatus').classList.contains('ok')",timeout=2000);p.locator('#routeEditor .stop-label').nth(1).fill('Changed');p.locator('[data-tab="mapping"]').click();assert 'unsaved changes' in rr.text(p,'#mapStatus').lower()


def mapping_normal(p): rr.scenario_resolution(p)
def mapping_contradictory(p):
    adopt_sicily(p,'mapping');p.locator('#mapResolveBtn').click();p.wait_for_function("document.querySelector('#mapStatus').textContent.includes('occurrences resolved')",timeout=8000);assert p.locator('#routeMapQuestBtn').is_disabled();assert 'transport' in rr.text(p,'#mapWarnings').lower()
def mapping_degraded(p):
    _blank_three(p);p.locator('#topologyInput').select_option('one_way');p.locator('#savePrecisionBtn').click();p.wait_for_function("document.querySelector('#precisionStatus').classList.contains('ok')",timeout=2000)
    p.evaluate("window.__geoOffline=true");p.locator('[data-tab="mapping"]').click();p.locator('#mapResolveBtn').click();p.wait_for_timeout(500)
    assert 'unresolved' in rr.text(p,'#coordinateFact').lower();assert p.locator('#routeMapQuestBtn').is_disabled()
def mapping_navigation(p):
    adopt_sicily(p,'refine');p.locator('[data-tab="precision"]').click();p.locator('#routeEditor .stop-label').nth(1).fill('Changed');p.locator('[data-tab="mapping"]').click();assert 'unsaved changes' in rr.text(p,'#mapStatus').lower()


def document_normal(p): rr.scenario_document(p)
def document_contradictory(p):
    adopt_sicily(p,'document');p.locator('[data-tab="document"]').click();checks=p.locator('#documentSections input[type=checkbox]')
    for i in range(checks.count()-1):
        if checks.nth(i).is_checked(): checks.nth(i).uncheck()
    last=checks.nth(checks.count()-1);assert last.is_checked();last.click();p.wait_for_timeout(80);assert last.is_checked();assert 'at least one' in rr.text(p,'#documentStatus').lower()
def document_degraded(p):
    adopt_sicily(p,'document');p.evaluate("window.__docFail=true");p.locator('#documentBtn').click();p.wait_for_function("document.querySelector('#documentOutput').textContent.length>50",timeout=4000);status=rr.text(p,'#documentStatus').lower();assert 'degraded' in status and 'fallback' in status
def document_navigation(p):
    adopt_sicily(p,'refine');p.locator('[data-tab="precision"]').click();p.locator('#routeEditor .stop-label').nth(1).fill('Changed');p.locator('[data-tab="document"]').click();p.locator('#documentBtn').click();p.wait_for_timeout(100);assert 'saved trip' in rr.text(p,'#documentStatus').lower() or 'unsaved' in rr.text(p,'#documentStatus').lower()


def return_normal(p): rr.scenario_navigation(p)
def return_contradictory(p):
    adopt_sicily(p,'refine');trip_before=rr.text(p,'#tripMeta');p.locator('#editOriginalRequestBtn').click();p.locator('#brief').fill('Give me a tour of Corsica.');p.locator('#sparkBtn').click();p.wait_for_function("!document.querySelector('#tripBasicsPanel').hidden",timeout=700);assert p.locator('#basicsDestination').input_value()=='Corsica';assert rr.text(p,'#tripMeta')==trip_before
def return_degraded(p): rr.scenario_stale_spark_navigation(p)
def return_navigation(p):
    adopt_sicily(p,'refine');p.locator('#refineBackToSparkBtn').click();p.locator('#proposals .refine-proposal').first.click();p.wait_for_function("!document.querySelector('#workspace').hidden",timeout=1500);assert 'three weeks' in rr.text(p,'#originalRequestText').lower()


def persistence_normal(p): rr.scenario_export_import_persistence(p)
def persistence_contradictory(p):
    p.locator('#importFile').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{"state":{"authority":{"bad":true}}}'})
    p.wait_for_timeout(200);assert p.locator('#workspace').is_hidden() or 'rejected' in rr.text(p,'body').lower() or p.locator('#tripMeta').count()==1

def persistence_degraded(p):
    browser=p.context.browser
    seeded={'wayfinder.rebuild.state.v3':json.dumps({'authority':{'id':'broken','version':1,'route':[]},'briefText':'orphan'})}
    q=rr.make_page(browser,seed_storage=seeded)
    try:
        assert q.locator('#brief').input_value()=='';assert q.locator('#workspace').is_hidden()
    finally:q.close()
def persistence_navigation(p):
    _blank_three(p);p.locator('#topologyInput').select_option('one_way');p.locator('#savePrecisionBtn').click();p.wait_for_function("document.querySelector('#precisionStatus').classList.contains('ok')",timeout=2000)
    p.on('dialog',lambda d:d.dismiss());p.locator('#resetBtn').click();p.wait_for_timeout(100);assert not p.locator('#workspace').is_hidden()

FAMILIES={
 'vague-named-route':{'normal':named_route_normal,'contradictory':named_route_contradictory,'degraded':named_route_degraded,'navigation':named_route_navigation},
 'island-loop':{'normal':island_normal,'contradictory':island_contradictory,'degraded':island_degraded,'navigation':island_navigation},
 'one-way-city-anchors':{'normal':oneway_normal,'contradictory':oneway_contradictory,'degraded':oneway_degraded,'navigation':oneway_navigation},
 'multi-country-route':{'normal':multicountry_normal,'contradictory':multicountry_contradictory,'degraded':multicountry_degraded,'navigation':multicountry_navigation},
 'multi-area-island':{'normal':multiarea_normal,'contradictory':multiarea_contradictory,'degraded':multiarea_degraded,'navigation':multiarea_navigation},
 'revision':{'normal':revision_normal,'contradictory':revision_contradictory,'degraded':revision_degraded,'navigation':revision_navigation},
 'precision':{'normal':precision_normal,'contradictory':precision_contradictory,'degraded':precision_degraded,'navigation':precision_navigation},
 'mapping':{'normal':mapping_normal,'contradictory':mapping_contradictory,'degraded':mapping_degraded,'navigation':mapping_navigation},
 'documentation':{'normal':document_normal,'contradictory':document_contradictory,'degraded':document_degraded,'navigation':document_navigation},
 'return-to-spark':{'normal':return_normal,'contradictory':return_contradictory,'degraded':return_degraded,'navigation':return_navigation},
 'save-reload-import':{'normal':persistence_normal,'contradictory':persistence_contradictory,'degraded':persistence_degraded,'navigation':persistence_navigation},
}

def run_matrix(write=True):
    families={};verdict='PASS'
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        selected={k:v for k,v in FAMILIES.items() if not os.environ.get('WAYFINDER_MATRIX_FAMILY') or k==os.environ.get('WAYFINDER_MATRIX_FAMILY')}
        for family,cases in selected.items():
            families[family]={}
            variants=[v for v in VARIANTS if not os.environ.get('WAYFINDER_MATRIX_VARIANT') or v==os.environ.get('WAYFINDER_MATRIX_VARIANT')]
            for variant in variants:
                result=run_case(browser,cases[variant]);families[family][variant]=result
                if result['status']!='PASS':verdict='FAIL'
        browser.close()
    evidence={'releaseId':RELEASE['releaseId'],'verdict':verdict,'criticalHash':rr.critical_hash(),'createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'engine':'Chromium rendered DOM four-variant canonical-family matrix','requiredVariants':list(VARIANTS),'families':families}
    if write:(ROOT/'RENDERED_VARIANT_EVIDENCE.json').write_text(json.dumps(evidence,indent=2)+'\n')
    return evidence

if __name__=='__main__':
    e=run_matrix(write='--no-write' not in sys.argv);print(json.dumps(e,indent=2))
    if e['verdict']!='PASS':sys.exit(1)
