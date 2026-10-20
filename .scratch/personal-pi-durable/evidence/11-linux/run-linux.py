import pathlib,subprocess,json,datetime,hashlib,tarfile,shlex,os,sys
E=pathlib.Path(__file__).parent;W=pathlib.Path('/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable')
ID=json.loads((E/'session.json').read_text())['remoteId'];remote='/tmp/'+ID;shm='/dev/shm/'+ID

def run(name,args,**kw):
 start=datetime.datetime.now(datetime.timezone.utc).isoformat();r=subprocess.run(args,capture_output=True,**kw)
 (E/(name+'.stdout')).write_bytes(r.stdout);(E/(name+'.stderr')).write_bytes(r.stderr)
 (E/(name+'.json')).write_text(json.dumps({'command':args,'exitCode':r.returncode,'started':start,'ended':datetime.datetime.now(datetime.timezone.utc).isoformat()},ensure_ascii=False,indent=2)+'\n')
 print(name+': exit '+str(r.returncode),flush=True)
 if r.returncode:print(r.stderr.decode(errors='replace')[-4000:],flush=True)
 return r

run('local-git-status',['git','status','--short','--branch'],cwd=W)
run('local-base',['git','rev-parse','HEAD'],cwd=W)
files=subprocess.check_output(['git','ls-files','-z'],cwd=W).decode().split('\0');files=[p for p in files if p]
files+=['apps/ruukoto/src/personal-work-controls.ts','test/personal-work-controls.test.ts'];files=sorted(set(files))
(E/'input-files.txt').write_text('\n'.join(files)+'\n');manifest=[]
for name in files:
 p=W/name;content=os.fsencode(os.readlink(p)) if p.is_symlink() else p.read_bytes()
 manifest.append({'path':name,'kind':'symlink' if p.is_symlink() else 'file','mode':oct(p.lstat().st_mode & 0o777),'sha256':hashlib.sha256(content).hexdigest(),'bytes':len(content)})
(E/'input-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
with tarfile.open(E/'source.tar.gz','w:gz',dereference=False) as t:
 for name in files:t.add(W/name,arcname=name,recursive=False)
(E/'source.sha256').write_text(hashlib.sha256((E/'source.tar.gz').read_bytes()).hexdigest()+'  source.tar.gz\n')
r=run('preflight',['ssh','tx','uname -a; df -h / /tmp /dev/shm; free -m; node --version; npm --version; python3 --version'])
if r.returncode:sys.exit(r.returncode)
r=run('create-remote',['ssh','tx','mkdir '+shlex.quote(remote)+' && mkdir '+shlex.quote(shm)+' && mkdir '+shlex.quote(shm+'/repo')+' && ln -s '+shlex.quote(shm+'/repo')+' '+shlex.quote(remote+'/repo')])
if r.returncode:sys.exit(r.returncode)
r=run('upload',['scp',str(E/'source.tar.gz'),str(E/'input-manifest.json'),str(E/'remote-runner.py'),'tx:'+remote+'/'])
if r.returncode:sys.exit(r.returncode)
r=run('extract',['ssh','tx','tar -xzf '+shlex.quote(remote+'/source.tar.gz')+' -C '+shlex.quote(remote+'/repo')])
if r.returncode:sys.exit(r.returncode)
run('remote-validation',['ssh','tx','python3 '+shlex.quote(remote+'/remote-runner.py')+' '+shlex.quote(remote)])
run('download-logs',['scp','-r','tx:'+remote+'/logs',str(E/'remote-logs')])
print('EVIDENCE_DIRECTORY='+str(E),flush=True)
print('REMOTE_DIRECTORY='+remote,flush=True)
print('SHM_DIRECTORY='+shm,flush=True)
