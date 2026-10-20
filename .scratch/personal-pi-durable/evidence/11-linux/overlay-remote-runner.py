
import pathlib,os,json,hashlib,datetime,subprocess,signal,sys
root=pathlib.Path(sys.argv[1]);repo=root/'repo';logs=root/'logs';meta=json.loads((root/'input-overlay.json').read_text());content=(root/meta['snapshot']).read_bytes()
if hashlib.sha256(content).hexdigest()!=meta['sha256']:raise RuntimeError('overlay upload hash mismatch')
p=repo/meta['path'];p.write_bytes(content);os.chmod(p,int(meta['mode'],8))
if hashlib.sha256(p.read_bytes()).hexdigest()!=meta['sha256']:raise RuntimeError('overlay applied hash mismatch')
meta['appliedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();(logs/'input-overlay.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
env=os.environ.copy();env.update({'RUN_MODEL_CHECK':'0','npm_config_cache':str(root/'npm-cache'),'npm_config_update_notifier':'false','npm_config_audit':'false','npm_config_fund':'false'});args=['npx','--no-install','tsx','--test','test/personal-work-controls.test.ts'];start=datetime.datetime.now(datetime.timezone.utc).isoformat();timedout=False
with (logs/'work-controls-final.stdout').open('wb') as out,(logs/'work-controls-final.stderr').open('wb') as err:
 p=subprocess.Popen(args,cwd=repo,env=env,stdout=out,stderr=err,start_new_session=True)
 try:code=p.wait(timeout=120)
 except subprocess.TimeoutExpired:
  timedout=True;os.killpg(p.pid,signal.SIGTERM)
  try:code=p.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);code=p.wait()
 try:os.killpg(p.pid,signal.SIGTERM)
 except ProcessLookupError:pass
(logs/'work-controls-final.json').write_text(json.dumps({'command':args,'cwd':str(repo),'env':{k:env[k] for k in ['RUN_MODEL_CHECK','npm_config_cache','npm_config_update_notifier','npm_config_audit','npm_config_fund']},'exitCode':code,'timedOut':timedout,'started':start,'ended':datetime.datetime.now(datetime.timezone.utc).isoformat()},ensure_ascii=False,indent=2)+'\n');print('work-controls-final: exit '+str(code));sys.exit(code)
