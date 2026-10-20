import os,sys,pathlib,json,subprocess,time,hashlib
base=pathlib.Path('/dev/shm/rk-coding36-linux.gaWtu6')
name=sys.argv[1]; assert name in ('baseline','current')
repo=base/name; out=base/(name+'-evidence')
env=os.environ.copy(); env['npm_config_cache']=str(base/'npm-cache'); env['TMPDIR']=str(base/(name+'-tmp'))
for label,args in [('npm-tree',['npm','ls','--all','--json']),('npm-paths',['npm','ls','--all','--parseable'])]:
    with (out/(label+'.log')).open('wb') as f: result=subprocess.run(args,cwd=repo,env=env,stdout=f,stderr=subprocess.STDOUT)
    (out/(label+'.exit')).write_text(str(result.returncode)+'\n')
manifest=json.loads((base/(name+'-source-sha256.json')).read_text()); changed=[]
for entry in manifest['entries']:
    p=repo/entry['path']; expected=entry.get('symlink',entry.get('sha256'))
    actual=os.readlink(p) if 'symlink' in entry else hashlib.sha256(p.read_bytes()).hexdigest()
    if actual!=expected: changed.append(entry['path'])
(out/'post-source-verification.json').write_text(json.dumps({'count':len(manifest['entries']),'changed':changed},indent=2)+'\n'); assert not changed
matches=[]; inaccessible=[]
for p in pathlib.Path('/proc').iterdir():
    if not p.name.isdigit() or int(p.name)==os.getpid(): continue
    try:
        if p.stat().st_uid!=os.getuid(): continue
        args=[a.decode(errors='replace') for a in (p/'cmdline').read_bytes().split(b'\0') if a]
        try: cwd=os.readlink(p/'cwd')
        except FileNotFoundError: cwd=''
        if cwd.startswith(str(repo)) or cwd.startswith(str(base/(name+'-tmp'))) or any(a.startswith(str(repo)) or a.startswith(str(base/(name+'-tmp'))) for a in args):
            matches.append({'pid':int(p.name),'cwd':cwd,'args':args})
    except (FileNotFoundError,ProcessLookupError): pass
    except PermissionError as e: inaccessible.append(str(e))
record={'time':time.time(),'uid':os.getuid(),'repo':str(repo),'matches':matches,'inaccessible_owned_processes':inaccessible}
(out/'pre-dependency-cleanup-processes.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record),flush=True)
if matches or inaccessible: sys.exit(1)
print('ready for scoped dependency cleanup',flush=True)
