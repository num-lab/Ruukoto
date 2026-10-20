import os,pathlib,json,hashlib,shutil,subprocess,time,sys
base=pathlib.Path('/dev/shm/rk-coding36-linux.gaWtu6'); repo=base/'current'; out=base/'final-evidence'; out.mkdir(exist_ok=False)
raw=json.loads((base/'current-first-evidence/result.json').read_text()); assert 'end' in raw
with (out/'pre-patch-processes.json').open('w') as f: checked=subprocess.run(['sudo','-n','python3',str(base/'scan-processes.py'),'current'],stdout=f,stderr=subprocess.STDOUT)
assert checked.returncode==0
manifest=json.loads((base/'current-source-sha256.json').read_text())
changed=[]
for entry in manifest['entries']:
    p=repo/entry['path']; actual=os.readlink(p) if 'symlink' in entry else hashlib.sha256(p.read_bytes()).hexdigest()
    if actual!=entry.get('symlink',entry.get('sha256')): changed.append(entry['path'])
(out/'pre-patch-source-verification.json').write_text(json.dumps({'count':len(manifest['entries']),'changed':changed},indent=2)+'\n'); assert not changed
changes={'packages/agent/src/tool-worker/host.ts':'100f5842d48d55416f8398647ed6a790db924643b895fd7dfcf24d49c8f288c7','test/100-worker-stop.test.ts':'f03f13862be3cf50ba60ccdbb5d0a1e75214475c4f7f9b92a3ff1c10fa99fa34'}
for name,sha in changes.items():
    source=base/'final-patch'/name; assert hashlib.sha256(source.read_bytes()).hexdigest()==sha
    preserved=out/'source-before-patch'/name; preserved.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(repo/name,preserved)
    shutil.copy2(source,repo/name)
final=json.loads((base/'final-source-sha256.json').read_text()); errors=[]
for entry in final['entries']:
    p=repo/entry['path']; actual=os.readlink(p) if 'symlink' in entry else hashlib.sha256(p.read_bytes()).hexdigest()
    if actual!=entry.get('symlink',entry.get('sha256')): errors.append(entry['path'])
(out/'final-source-verification.json').write_text(json.dumps({'count':len(final['entries']),'changed':errors,'frozen_patch':changes},indent=2)+'\n'); assert not errors
env=os.environ.copy(); env.update(TMPDIR=str(base/'current-tmp'),npm_config_cache=str(base/'npm-cache'),ELECTRON_SKIP_BINARY_DOWNLOAD='1',RUN_MODEL_CHECK='0')
start=time.time()
with (out/'build.log').open('wb') as f: built=subprocess.run(['npm','run','build'],cwd=repo,env=env,stdout=f,stderr=subprocess.STDOUT)
(out/'build.exit').write_text(str(built.returncode)+'\n'); (out/'build-command.json').write_text(json.dumps({'start':start,'end':time.time(),'cwd':str(repo),'command':['npm','run','build'],'environment':{k:env[k] for k in ('TMPDIR','npm_config_cache','ELECTRON_SKIP_BINARY_DOWNLOAD','RUN_MODEL_CHECK')}},indent=2)+'\n'); assert built.returncode==0
artifacts=[]
for prefix in ['worker','apps/desktop/dist']:
    root=repo/prefix
    if root.exists():
        for p in sorted(root.rglob('*')):
            if p.is_file(): artifacts.append({'path':str(p.relative_to(repo)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size})
(out/'artifacts-sha256.json').write_text(json.dumps(artifacts,indent=2)+'\n')
files=['test/100-worker-stop.test.ts','test/101-native-execution.test.ts','test/101-native-linux-scope.test.ts','test/native-linux-identity.test.ts','test/71-product-entry.test.ts','test/24-mcp.test.ts','test/25-mcp-write.test.ts','test/mcp-transport.test.ts']
group=subprocess.run(['python3',str(base/'run-test-final.py'),'current','final-minimal','--test-concurrency=1',*files])
with (out/'pre-final122-processes.json').open('w') as f: checked=subprocess.run(['sudo','-n','python3',str(base/'scan-processes.py'),'current'],stdout=f,stderr=subprocess.STDOUT)
assert checked.returncode==0
last=subprocess.run(['python3',str(base/'run-test-final.py'),'current','final-122','test/122-workflow-code-acceptance.test.ts'])
sys.exit(group.returncode or last.returncode)
