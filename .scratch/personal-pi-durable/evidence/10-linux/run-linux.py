import pathlib,subprocess,json,datetime,hashlib,tarfile,shlex,os,sys
E=pathlib.Path(__file__).parent
W=pathlib.Path('/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable')
ID='ruukoto-personal-linux-20261017T034917Z-attempt2'
remote='/tmp/'+ID
shm='/dev/shm/'+ID

def run(name,args,**kw):
    start=datetime.datetime.now(datetime.timezone.utc).isoformat()
    r=subprocess.run(args,capture_output=True,**kw)
    (E/(name+'.stdout')).write_bytes(r.stdout)
    (E/(name+'.stderr')).write_bytes(r.stderr)
    (E/(name+'.json')).write_text(json.dumps({'command':args,'exitCode':r.returncode,'started':start,'ended':datetime.datetime.now(datetime.timezone.utc).isoformat()},ensure_ascii=False,indent=2)+'\n')
    print(name+': exit '+str(r.returncode),flush=True)
    if r.returncode:
        print(r.stderr.decode(errors='replace')[-4000:],flush=True)
    return r

files=subprocess.check_output(['git','ls-files','-z'],cwd=W).decode().split('\0')
files=[p for p in files if p]
files+=['apps/ruukoto/src/personal-work-tools.ts','test/personal-work-tools.test.ts']
files=sorted(set(files))
(E/'input-files.txt').write_text('\n'.join(files)+'\n')
manifest=[]
for name in files:
    p=W/name
    content=os.fsencode(os.readlink(p)) if p.is_symlink() else p.read_bytes()
    manifest.append({'path':name,'kind':'symlink' if p.is_symlink() else 'file','mode':oct(p.lstat().st_mode & 0o777),'sha256':hashlib.sha256(content).hexdigest(),'bytes':len(content)})
(E/'input-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
with tarfile.open(E/'source.tar.gz','w:gz',dereference=False) as t:
    for name in files:t.add(W/name,arcname=name,recursive=False)
(E/'source.sha256').write_text(hashlib.sha256((E/'source.tar.gz').read_bytes()).hexdigest()+'  source.tar.gz\n')
remote_script=r'''
import pathlib,subprocess,os,json,datetime,signal,hashlib,sys
root=pathlib.Path(sys.argv[1]);repo=root/'repo'; logs=root/'logs';logs.mkdir()
env=os.environ.copy();env.update({'RUN_MODEL_CHECK':'0','npm_config_cache':str(root/'npm-cache'),'npm_config_update_notifier':'false','npm_config_audit':'false','npm_config_fund':'false'})

def command(name,args,cwd=repo,timeout=900):
    start=datetime.datetime.now(datetime.timezone.utc).isoformat()
    with (logs/(name+'.stdout')).open('wb') as out,(logs/(name+'.stderr')).open('wb') as err:
        p=subprocess.Popen(args,cwd=cwd,env=env,stdout=out,stderr=err,start_new_session=True)
        timedout=False
        try: code=p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timedout=True;os.killpg(p.pid,signal.SIGTERM)
            try:code=p.wait(timeout=10)
            except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);code=p.wait()
        try:os.killpg(p.pid,signal.SIGTERM)
        except ProcessLookupError:pass
    result={'command':args,'cwd':str(cwd),'env':{k:env[k] for k in ['RUN_MODEL_CHECK','npm_config_cache','npm_config_update_notifier','npm_config_audit','npm_config_fund']},'exitCode':code,'timedOut':timedout,'started':start,'ended':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (logs/(name+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(name+': exit '+str(code),flush=True)
    if code:print((logs/(name+'.stderr')).read_text(errors='replace')[-3000:],flush=True)
    return code

command('environment',['bash','-c','uname -a; cat /etc/os-release; node --version; npm --version; python3 --version; git --version; df -h /tmp /dev/shm; free -h; mount | grep -E "(tmp|shm)"'])
manifest=json.loads((root/'input-manifest.json').read_text())
verified=[]
for item in manifest:
    p=repo/item['path'];content=os.fsencode(os.readlink(p)) if p.is_symlink() else p.read_bytes()
    observed={'path':item['path'],'kind':'symlink' if p.is_symlink() else 'file','mode':oct(p.lstat().st_mode & 0o777),'sha256':hashlib.sha256(content).hexdigest(),'bytes':len(content)}
    expected=dict(item)
    if item['kind']=='symlink':expected['mode']=observed['mode']
    if observed!=expected:raise RuntimeError('input mismatch: '+item['path'])
    verified.append(observed)
(logs/'input-manifest.json').write_text(json.dumps(verified,ensure_ascii=False,indent=2)+'\n')
command('git-init',['git','init'])
setup=command('setup',['npm','run','setup','--','--skip-hooks'],timeout=1200)
if setup==0:
    command('personal-tests',['npx','--no-install','tsx','--test','test/personal-durable.test.ts','test/personal-cli.test.ts','test/personal-services.test.ts','test/personal-work.test.ts','test/personal-work-tools.test.ts','test/personal-service-operations.test.ts','test/personal-telegram.test.ts','test/personal-telegram-permissions.test.ts'],timeout=900)
    command('build',['npm','run','build'],timeout=900)
else:
    (logs/'blocked.json').write_text(json.dumps({'blocked':'setup failed; tests/build not started'},ensure_ascii=False,indent=2)+'\n')
command('final-environment',['bash','-c','df -h /tmp /dev/shm; free -h; ps -eo pid,ppid,pgid,args'],timeout=30)
'''
(E/'remote-runner.py').write_text(remote_script)
created=False
try:
    r=run('create-remote',['ssh','tx','mkdir '+shlex.quote(remote)+' && mkdir '+shlex.quote(shm)+' && mkdir '+shlex.quote(shm+'/repo')+' && ln -s '+shlex.quote(shm+'/repo')+' '+shlex.quote(remote+'/repo')])
    if r.returncode:sys.exit(r.returncode)
    created=True
    r=run('upload',['scp',str(E/'source.tar.gz'),str(E/'input-manifest.json'),str(E/'remote-runner.py'),'tx:'+remote+'/'])
    if r.returncode:sys.exit(r.returncode)
    r=run('extract',['ssh','tx','tar -xzf '+shlex.quote(remote+'/source.tar.gz')+' -C '+shlex.quote(remote+'/repo')])
    if r.returncode:sys.exit(r.returncode)
    run('remote-validation',['ssh','tx','python3 '+shlex.quote(remote+'/remote-runner.py')+' '+shlex.quote(remote)])
    run('download-logs',['scp','-r','tx:'+remote+'/logs',str(E/'remote-logs')])
finally:
    if created:
        cleanup=r'''
import pathlib,os,signal,subprocess,time,shutil,json
roots=[pathlib.Path('/tmp/ruukoto-personal-linux-20261017T034917Z-attempt2'),pathlib.Path('/dev/shm/ruukoto-personal-linux-20261017T034917Z-attempt2')]
owned=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit() or int(p.name)==os.getpid():continue
 try:
  cwd=(p/'cwd').resolve()
  if any(cwd.is_relative_to(r) for r in roots):owned.append(int(p.name))
 except (FileNotFoundError,PermissionError,ProcessLookupError):pass
for pid in owned:
 try:os.kill(pid,signal.SIGTERM)
 except ProcessLookupError:pass
if owned:time.sleep(1)
for pid in owned:
 try:os.kill(pid,signal.SIGKILL)
 except ProcessLookupError:pass
for r in roots:shutil.rmtree(r)
print(json.dumps({'terminatedOwnedPids':owned,'removed':[str(r) for r in roots],'remaining':[str(r) for r in roots if r.exists()]}))
'''
        run('cleanup',['ssh','tx','python3 -c '+shlex.quote(cleanup)])
print('EVIDENCE_DIRECTORY='+str(E),flush=True)
