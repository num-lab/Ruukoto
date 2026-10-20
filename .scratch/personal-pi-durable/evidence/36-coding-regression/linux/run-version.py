import os,sys,json,hashlib,pathlib,subprocess,time,shutil,threading,sqlite3,tarfile
base=pathlib.Path('/dev/shm/rk-coding36-linux.gaWtu6')
name=sys.argv[1]
assert name in ('baseline','current')
repo=base/name
out=base/(name+'-evidence'); out.mkdir(exist_ok=True)
tmp=base/(name+'-tmp'); tmp.mkdir(exist_ok=True)
cache=base/'npm-cache'; cache.mkdir(exist_ok=True)
env=os.environ.copy(); env.update(TMPDIR=str(tmp),npm_config_cache=str(cache),ELECTRON_SKIP_BINARY_DOWNLOAD='1',RUN_MODEL_CHECK='0')
manifest=json.loads((base/(name+'-source-sha256.json')).read_text())
errors=[]
for entry in manifest['entries']:
    p=repo/entry['path']
    try:
        actual=os.readlink(p) if 'symlink' in entry else hashlib.sha256(p.read_bytes()).hexdigest()
        expected=entry.get('symlink',entry.get('sha256'))
        if actual!=expected: errors.append(entry['path'])
    except OSError as e: errors.append(str(e))
(out/'source-verification.json').write_text(json.dumps({'ref':manifest['ref'],'count':len(manifest['entries']),'errors':errors},indent=2)+'\n')
assert not errors,errors
commands=[['date','-u','--iso-8601=seconds'],['id'],['uname','-a'],['node','--version'],['npm','--version'],['git','--version'],['python3','--version'],['df','-h','/dev/shm','/'],['mount']]
with (out/'environment.log').open('w') as f:
    for command in commands:
        f.write('$ '+' '.join(command)+'\n'); f.flush(); subprocess.run(command,stdout=f,stderr=subprocess.STDOUT)
    f.write(json.dumps({k:env.get(k) for k in ['TMPDIR','npm_config_cache','ELECTRON_SKIP_BINARY_DOWNLOAD','RUN_MODEL_CHECK','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS']})+'\n')
(out/'commands.json').write_text(json.dumps({'ref':manifest['ref'],'cwd':str(repo),'environment':{k:env[k] for k in ['TMPDIR','npm_config_cache','ELECTRON_SKIP_BINARY_DOWNLOAD','RUN_MODEL_CHECK']},'commands':[['npm','run','setup','--','--skip-hooks'],['npm','run','build'],['timeout','--signal=TERM','--kill-after=10s','300s','npx','tsx','--test','test/122-workflow-code-acceptance.test.ts']]},indent=2)+'\n')
def phase(name,args):
    start=time.time(); print(name,'start',flush=True)
    with (out/(name+'.log')).open('wb') as f:
        result=subprocess.run(args,cwd=repo,env=env,stdout=f,stderr=subprocess.STDOUT)
    (out/(name+'.exit')).write_text(str(result.returncode)+'\n')
    (out/(name+'-time.json')).write_text(json.dumps({'start':start,'end':time.time(),'exit':result.returncode})+'\n')
    print(name,'exit',result.returncode,flush=True)
    return result.returncode
if phase('setup',['npm','run','setup','--','--skip-hooks']): sys.exit(1)
print(subprocess.check_output(['du','-sh',str(repo),str(cache)],text=True),flush=True)
print(subprocess.check_output(['df','-h','/dev/shm'],text=True),flush=True)
if phase('build',['npm','run','build']): sys.exit(1)
artifacts=[]
for prefix in ['worker','apps/desktop/dist']:
    root=repo/prefix
    if root.exists():
        for p in sorted(root.rglob('*')):
            if p.is_file(): artifacts.append({'path':str(p.relative_to(repo)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size})
(out/'artifacts-sha256.json').write_text(json.dumps(artifacts,indent=2)+'\n')
done=threading.Event()
def snapshot():
    for delay in (30,90,150,175,185,195,240,290):
        if done.wait(max(0,delay-(time.time()-test_start))): break
        roots=list(tmp.glob('ruukoto-it-workflow-code-batch-*'))
        if not roots: continue
        destination=out/('snapshot-'+str(delay)); destination.mkdir(exist_ok=True)
        subprocess.run(['ps','-u',str(os.getuid()),'-o','pid,ppid,pgid,stat,etime,args'],stdout=(destination/'processes.log').open('w'))
        for root in roots:
            for pattern in ('*.db','*.sqlite','*.sqlite3'):
                for db in root.rglob(pattern):
                    rel=db.relative_to(tmp); dest=destination/rel; dest.parent.mkdir(parents=True,exist_ok=True)
                    try:
                        src=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True)
                        dst=sqlite3.connect(dest); src.backup(dst); dst.close(); src.close()
                    except Exception as e: (destination/'snapshot-errors.log').open('a').write(repr(e)+'\n')
            with tarfile.open(destination/(root.name+'-files.tar.gz'),'w:gz') as tar:
                for p in root.rglob('*'):
                    if p.is_file() and p.suffix not in ('.db','.sqlite','.sqlite3') and not p.name.endswith(('-wal','-shm')):
                        try: tar.add(p,arcname=str(p.relative_to(tmp)),recursive=False)
                        except FileNotFoundError: pass
        (destination/'time.json').write_text(json.dumps({'elapsed':time.time()-test_start,'roots':[str(p) for p in roots]})+'\n')
test_start=time.time(); watcher=threading.Thread(target=snapshot,daemon=True); watcher.start()
result=phase('122-first',['timeout','--signal=TERM','--kill-after=10s','300s','npx','tsx','--test','test/122-workflow-code-acceptance.test.ts'])
done.set(); watcher.join()
print(subprocess.check_output(['df','-h','/dev/shm'],text=True),flush=True)
sys.exit(result)
