import os,sys,json,hashlib,pathlib,subprocess,time,shutil,threading,sqlite3,tarfile,tempfile
base=pathlib.Path('/dev/shm/rk-coding36-linux.gaWtu6'); name,label,*files=sys.argv[1:]
assert name in ('baseline','current') and label.replace('-','').isalnum() and files
repo=base/name; out=base/(label+'-evidence'); out.mkdir(exist_ok=False)
tmp=base/(name+'-tmp'); tmp.mkdir(exist_ok=True)
env=os.environ.copy(); env.update(TMPDIR=str(tmp),npm_config_cache=str(base/'npm-cache'),ELECTRON_SKIP_BINARY_DOWNLOAD='1',RUN_MODEL_CHECK='0')
command=['timeout','--signal=TERM','--kill-after=10s','300s','npx','tsx','--test',*files]
record={'start':time.time(),'cwd':str(repo),'command':command,'environment':{k:env[k] for k in ('TMPDIR','npm_config_cache','ELECTRON_SKIP_BINARY_DOWNLOAD','RUN_MODEL_CHECK')},'space_before':shutil.disk_usage(base)._asdict()}
(out/'command.json').write_text(json.dumps(record,indent=2)+'\n')
record['minimum_free_bytes']=64*1024*1024
record['minimum_free_reason']='first usable122 consumed under 1MiB net plus warmed tsx cache; reserve 64MiB, stop new batch if below'
(out/'space-preflight.json').write_text(json.dumps(record,indent=2)+'\n')
assert record['space_before']['free']>64*1024*1024,record['space_before']
start=time.time(); done=threading.Event()
def snapshot():
    for at in (30,150,175):
        if done.wait(max(0,at-(time.time()-start))): break
        roots=list(tmp.glob('ruukoto-it-workflow-code-batch-*'))
        if not roots: continue
        with tempfile.TemporaryDirectory(prefix='snapshot-next-',dir=out) as staging:
            stage=pathlib.Path(staging)
            for root in roots:
                for pattern in ('*.db','*.sqlite','*.sqlite3'):
                    for db in root.rglob(pattern):
                        dest=stage/db.relative_to(tmp); dest.parent.mkdir(parents=True,exist_ok=True)
                        try:
                            src=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True); dst=sqlite3.connect(dest); src.backup(dst); dst.close(); src.close()
                        except Exception as e: (out/'snapshot-errors.log').open('a').write(repr(e)+'\n')
            with (stage/'processes.log').open('w') as f: subprocess.run(['ps','-u',str(os.getuid()),'-o','pid,ppid,pgid,stat,etime,args'],stdout=f)
            (stage/'time.json').write_text(json.dumps({'elapsed':time.time()-start,'roots':[str(p) for p in roots],'space':shutil.disk_usage(base)._asdict()})+'\n')
            temporary=out/'snapshot-next.tar.gz'
            with tarfile.open(temporary,'w:gz') as tar:
                tar.add(stage,arcname='snapshot',recursive=True)
                for root in roots:
                    for p in root.rglob('*'):
                        if p.is_file() and p.suffix not in ('.db','.sqlite','.sqlite3') and not p.name.endswith(('-wal','-shm')):
                            try: tar.add(p,arcname=str(p.relative_to(tmp)),recursive=False)
                            except FileNotFoundError: pass
            os.replace(temporary,out/'live-snapshot.tar.gz')
watcher=threading.Thread(target=snapshot,daemon=True); watcher.start()
with (out/'test.log').open('wb') as f: result=subprocess.run(command,cwd=repo,env=env,stdout=f,stderr=subprocess.STDOUT)
done.set(); watcher.join()
if (out/'live-snapshot.tar.gz').exists(): os.replace(out/'live-snapshot.tar.gz',out/'final-snapshot.tar.gz')
record.update(end=time.time(),exit=result.returncode,space_after=shutil.disk_usage(base)._asdict())
(out/'test.exit').write_text(str(result.returncode)+'\n'); (out/'result.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record),flush=True)
sys.exit(result.returncode)
