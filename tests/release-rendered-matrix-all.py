from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import subprocess,os,json,time,sys

ROOT=Path(__file__).resolve().parents[1]
FAMILIES=['vague-named-route','island-loop','one-way-city-anchors','multi-country-route','multi-area-island','revision','precision','mapping','documentation','return-to-spark','save-reload-import']
VARIANTS=['normal','contradictory','degraded','navigation']
release=json.loads((ROOT/'RELEASE.json').read_text())


def run_family(family):
    env=os.environ.copy();env['WAYFINDER_MATRIX_FAMILY']=family
    proc=subprocess.run(
        [sys.executable,str(ROOT/'tests'/'release-rendered-matrix.py'),'--no-write'],
        cwd=ROOT,env=env,capture_output=True,text=True,timeout=120
    )
    if proc.returncode!=0:
        return family,None,{'status':'FAIL','error':(proc.stderr or proc.stdout)[-5000:]}
    try:
        data=json.loads(proc.stdout)
    except Exception as e:
        return family,None,{'status':'FAIL','error':f'invalid JSON from family runner: {e}; tail={(proc.stdout or proc.stderr)[-2000:]}'}
    return family,data,None

results={};verdict='PASS';critical=None
# Run isolated family processes concurrently so the full release matrix is bounded
# without sharing browser/session state between canonical families.
workers=min(4,len(FAMILIES))
with ThreadPoolExecutor(max_workers=workers) as pool:
    futures={pool.submit(run_family,f):f for f in FAMILIES}
    for fut in as_completed(futures):
        family=futures[fut]
        try:
            family,data,error=fut.result()
        except Exception as e:
            results[family]={'_runner':{'status':'FAIL','error':str(e)}};verdict='FAIL';continue
        if error:
            results[family]={'_runner':error};verdict='FAIL';continue
        this_hash=data.get('criticalHash')
        critical=critical or this_hash
        if this_hash!=critical:
            results[family]={'_runner':{'status':'FAIL','error':'critical hash drift across matrix families'}};verdict='FAIL';continue
        fam=data.get('families',{}).get(family,{})
        missing=[v for v in VARIANTS if fam.get(v,{}).get('status')!='PASS']
        if missing: verdict='FAIL'
        results[family]=fam

# Preserve canonical family ordering in evidence regardless of completion order.
results={f:results.get(f,{'_runner':{'status':'FAIL','error':'family produced no evidence'}}) for f in FAMILIES}
if any('_runner' in results[f] for f in FAMILIES): verdict='FAIL'
evidence={
    'releaseId':release['releaseId'],'verdict':verdict,'criticalHash':critical,
    'createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
    'engine':'Chromium rendered canonical-family four-variant matrix (isolated parallel family processes)',
    'requiredFamilies':FAMILIES,'requiredVariants':VARIANTS,'families':results
}
if '--no-write' not in sys.argv:
    (ROOT/'RENDERED_VARIANT_EVIDENCE.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps(evidence,indent=2))
if verdict!='PASS': sys.exit(1)
