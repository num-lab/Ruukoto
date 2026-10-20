import pathlib,subprocess,os,json,datetime,signal,hashlib,sys
root=pathlib.Path(sys.argv[1]);repo=root/'repo';logs=root/'logs';logs.mkdir(exist_ok=True)
env=os.environ.copy();env.update({'RUN_MODEL_CHECK':'0','npm_config_cache':str(root/'npm-cache'),'npm_config_update_notifier':'false','npm_config_audit':'false','npm_config_fund':'false'})
def command(name,args,cwd=repo,timeout=900):
 start=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with (logs/(name+'.stdout')).open('wb') as out,(logs/(name+'.stderr')).open('wb') as err:
  p=subprocess.Popen(args,cwd=cwd,env=env,stdout=out,stderr=err,start_new_session=True)
  timedout=False
  try:code=p.wait(timeout=timeout)
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
manifest=json.loads((root/'input-manifest.json').read_text());verified=[]
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
 command('personal-tests',['npx','--no-install','tsx','--test','test/personal-durable.test.ts','test/personal-cli.test.ts','test/personal-services.test.ts','test/personal-work.test.ts','test/personal-work-tools.test.ts','test/personal-work-controls.test.ts','test/personal-service-operations.test.ts','test/personal-telegram.test.ts','test/personal-telegram-permissions.test.ts'],timeout=900)
 command('build',['npm','run','build'],timeout=900)
else:(logs/'blocked.json').write_text(json.dumps({'blocked':'setup failed; tests/build not started'},ensure_ascii=False,indent=2)+'\n')
command('final-environment',['bash','-c','df -h /tmp /dev/shm; free -h'],timeout=30)
