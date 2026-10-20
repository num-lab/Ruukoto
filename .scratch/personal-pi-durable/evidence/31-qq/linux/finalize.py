import pathlib,json,os,hashlib,subprocess,shutil,tarfile
base=pathlib.Path(__file__).resolve().parent;repo=base/'repo';records=base/'records';records.mkdir(exist_ok=True)
for name in ['environment.json','source-manifest.json','runtime-dependencies.json','source-verification.json','test-results.json','test-results-attempt1.json','test-results-personal.json','setup.log','shared-tests.log','personal-load-attempt1.log','personal-tests.log','run-tests.py','verify.py']:
 p=base/name
 if p.is_file():shutil.copy2(p,records/name)
processes=[]
for p in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  if p.name==str(os.getpid()):continue
  argv=(p/'cmdline').read_bytes().decode(errors='replace').split('\0')[:-1]
  if any(arg.startswith(str(repo)) for arg in argv):processes.append({'pid':int(p.name),'argv':argv})
 except (FileNotFoundError,PermissionError,ProcessLookupError):pass
cache=pathlib.Path('/tmp/ruukoto-07-linux.V1tB4o/node_modules/@esbuild/linux-x64/bin/esbuild')
result={'dedicatedDirectory':str(base),'matchingRepositoryProcesses':processes,'disk':subprocess.check_output(['df','-h','/tmp'],text=True),'cacheBinary':{'path':str(cache),'sha256':hashlib.sha256(cache.read_bytes()).hexdigest(),'version':subprocess.check_output([str(cache),'--version'],text=True).strip(),'readOnlyReuse':True}}
(records/'cleanup-preflight.json').write_text(json.dumps(result,indent=2)+'\n')
with tarfile.open(base/'records.tar.gz','w:gz')as tar:tar.add(records,arcname='records')
print(json.dumps({'records':len(list(records.iterdir())),'repositoryProcesses':len(processes),'archiveSha256':hashlib.sha256((base/'records.tar.gz').read_bytes()).hexdigest(),'personalSummary':'\n'.join((base/'personal-tests.log').read_text().splitlines()[-9:]),'sharedSummary':'\n'.join((base/'shared-tests.log').read_text().splitlines()[-9:])}),flush=True)
