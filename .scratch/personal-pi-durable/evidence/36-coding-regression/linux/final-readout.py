import pathlib,json,hashlib,subprocess,shutil,time,sys
base=pathlib.Path('/dev/shm/rk-coding36-linux.gaWtu6'); out=base/'final-evidence'
assert json.loads((base/'final-122-evidence/result.json').read_text())['exit']==0
assert json.loads((base/'final-minimal-evidence/result.json').read_text())['exit']==0
artifacts=json.loads((out/'artifacts-sha256.json').read_text()); errors=[]
for item in artifacts:
    p=base/'current'/item['path']
    if hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']: errors.append(item['path'])
(out/'post-artifacts-verification.json').write_text(json.dumps({'count':len(artifacts),'changed':errors},indent=2)+'\n'); assert not errors
with (out/'pre-dependency-cleanup-processes.json').open('w') as f: scan=subprocess.run(['sudo','-n','python3',str(base/'scan-processes.py'),'current'],stdout=f,stderr=subprocess.STDOUT)
assert scan.returncode==0
(out/'final-resource-checkpoint.json').write_text(json.dumps({'time':time.time(),'shm':shutil.disk_usage(base)._asdict(),'root':shutil.disk_usage('/')._asdict(),'cache_root':shutil.disk_usage('/tmp/rk-coding36-linux-npm.rhwyky')._asdict(),'current_dependency_cleanup':'pending after evidence transfer verification'},indent=2)+'\n')
entries=[]
for p in sorted(base.rglob('*')):
    rel=p.relative_to(base)
    if any(x in {'node_modules','baseline-tmp','current-tmp','.git','_cacache'} for x in rel.parts): continue
    if len(rel.parts)>1 and rel.parts[0] in {'baseline','current','final-patch'}: continue
    if p.is_file() and p.name!='evidence-transfer-sha256.json': entries.append({'path':str(rel),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size})
(base/'evidence-transfer-sha256.json').write_text(json.dumps({'time':time.time(),'excluded':['node_modules/','baseline-tmp/','current-tmp/','.git/','npm-cache/_cacache/','baseline/ source tree','current/ source tree','final-patch/ source files separately checked by frozen patch hashes'],'entries':entries},indent=2)+'\n')
print(len(entries),'evidence files ready',flush=True)
