import pathlib,json,hashlib,datetime,subprocess,shlex,os
E=pathlib.Path(__file__).parent;W=pathlib.Path('/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable');ID=json.loads((E/'session.json').read_text())['remoteId'];remote='/tmp/'+ID
name='test/personal-work-controls.test.ts';content=(W/name).read_bytes();snapshot=E/'updated-personal-work-controls.test.ts';snapshot.write_bytes(content);sha=hashlib.sha256(content).hexdigest()
original=json.loads((E/'input-manifest.json').read_text());prior=next(x for x in original if x['path']==name)
meta={'path':name,'previousSha256':prior['sha256'],'sha256':sha,'bytes':len(content),'mode':oct((W/name).stat().st_mode&0o777),'snapshot':snapshot.name,'preparedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()};(E/'input-overlay.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
for item in original:
 if item['path']==name:item.update({'sha256':sha,'bytes':len(content),'mode':meta['mode']})
(E/'effective-input-manifest.json').write_text(json.dumps(original,ensure_ascii=False,indent=2)+'\n')
def run(label,args):
 start=datetime.datetime.now(datetime.timezone.utc).isoformat();r=subprocess.run(args,capture_output=True)
 (E/(label+'.stdout')).write_bytes(r.stdout);(E/(label+'.stderr')).write_bytes(r.stderr);(E/(label+'.json')).write_text(json.dumps({'command':args,'exitCode':r.returncode,'started':start,'ended':datetime.datetime.now(datetime.timezone.utc).isoformat()},ensure_ascii=False,indent=2)+'\n');print(label+': exit '+str(r.returncode),flush=True)
 if r.returncode:raise RuntimeError(r.stderr.decode(errors='replace'))
run('overlay-upload',['scp',str(snapshot),str(E/'input-overlay.json'),'tx:'+remote+'/'])
script=r'''
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
'''
(E/'overlay-remote-runner.py').write_text(script)
run('overlay-validation',['ssh','tx','python3 -c '+shlex.quote(script)+' '+shlex.quote(remote)])
run('overlay-download',['scp','-r','tx:'+remote+'/logs/.',str(E/'remote-logs')])
