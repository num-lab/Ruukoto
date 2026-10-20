import pathlib,subprocess,json,datetime,shlex,sys
E=pathlib.Path(__file__).parent;ID=json.loads((E/'session.json').read_text())['remoteId']
assert ID.startswith('ruukoto-work-controls-') and '/' not in ID
remote='/tmp/'+ID;shm='/dev/shm/'+ID
script='''
import pathlib,os,signal,time,shutil,json,sys
roots=[pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2])]
def belongs(pid):
 try:return any((pathlib.Path('/proc')/str(pid)/'cwd').resolve().is_relative_to(r) for r in roots)
 except (FileNotFoundError,PermissionError,ProcessLookupError):return False
def owned():
 return [int(p.name) for p in pathlib.Path('/proc').iterdir() if p.name.isdigit() and int(p.name)!=os.getpid() and belongs(int(p.name))]
pids=owned()
for pid in pids:
 if belongs(pid):
  try:os.kill(pid,signal.SIGTERM)
  except ProcessLookupError:pass
if pids:time.sleep(1)
for pid in pids:
 if belongs(pid):
  try:os.kill(pid,signal.SIGKILL)
  except ProcessLookupError:pass
remaining=owned()
if remaining:raise RuntimeError('owned processes remain: '+repr(remaining))
for root in roots:shutil.rmtree(root)
print(json.dumps({'terminatedOwnedPids':pids,'remainingOwnedPids':owned(),'removed':[str(r) for r in roots],'remainingDirectories':[str(r) for r in roots if r.exists()]}))
'''
args=['ssh','tx','python3 -c '+shlex.quote(script)+' '+shlex.quote(remote)+' '+shlex.quote(shm)]
start=datetime.datetime.now(datetime.timezone.utc).isoformat();r=subprocess.run(args,capture_output=True)
(E/'cleanup.stdout').write_bytes(r.stdout);(E/'cleanup.stderr').write_bytes(r.stderr)
(E/'cleanup.json').write_text(json.dumps({'command':args,'exitCode':r.returncode,'started':start,'ended':datetime.datetime.now(datetime.timezone.utc).isoformat()},ensure_ascii=False,indent=2)+'\n')
print(r.stdout.decode());print(r.stderr.decode());print('cleanup: exit '+str(r.returncode),flush=True)
sys.exit(r.returncode)
