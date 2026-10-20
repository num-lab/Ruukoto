import datetime,hashlib,json,os,pathlib,stat,subprocess,sys,time,tarfile
logs=pathlib.Path(__file__).resolve().parent
config=json.loads((logs/'paths.json').read_text()); source=pathlib.Path(config['source']);tmp=pathlib.Path(config['temp_root']);entries=[json.loads(line) for line in (logs/'source-manifest.jsonl').read_text().splitlines()]
def processes():
 result=[]
 for raw in pathlib.Path('/proc').iterdir():
  if not raw.name.isdigit():continue
  try:
   if raw.stat().st_uid!=os.getuid():continue
   text=(raw/'stat').read_text();fields=text[text.rfind(')')+2:].split()
   cmd=(raw/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace').strip()
   try:cwd=os.readlink(raw/'cwd')
   except OSError:cwd=None
   result.append({'pid':int(raw.name),'ppid':int(fields[1]),'pgid':int(fields[2]),'sid':int(fields[3]),'state':fields[0],'cwd':cwd,'cmdline':cmd})
  except (FileNotFoundError,ProcessLookupError):continue
 return result
(logs/'processes-before.json').write_text(json.dumps(processes(),indent=2)+'\n')
with (logs/'environment.txt').open('w') as out:
 for args in [['date','-u','+%FT%TZ'],['hostname'],['uname','-a'],['id'],['node','--version'],['npm','--version'],['python3','-c','import pty,fcntl,termios,os; a,b=pty.openpty();os.close(a);os.close(b);print("Python3 PTY available")'],['df','-h','/dev/shm','/tmp']]:subprocess.run(args,stdout=out,stderr=subprocess.STDOUT)
with tarfile.open(logs/'source.tar.gz','r:gz') as archive:archive.extractall(source,filter='data')
def verify():
 mismatches=[]
 for item in entries:
  p=source/item['path']; data=os.readlink(p).encode() if p.is_symlink() else p.read_bytes()
  if hashlib.sha256(data).hexdigest()!=item['sha256']:mismatches.append(item['path'])
 return mismatches
if verify():raise RuntimeError(verify())
summary={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_manifest_sha256':hashlib.sha256((logs/'source-manifest.jsonl').read_bytes()).hexdigest(),'source_files':len(entries),'commands':[]}
env=os.environ.copy();env.update({'RUN_MODEL_CHECK':'0','TMPDIR':str(tmp),'npm_config_cache':str(source/'.npm-cache'),'XDG_CACHE_HOME':str(source/'.cache')})
def run(name,args):
 start=time.time()
 with (logs/(name+'.log')).open('w') as out:result=subprocess.run(args,cwd=source,env=env,stdout=out,stderr=subprocess.STDOUT)
 record={'name':name,'argv':args,'exit_code':result.returncode,'seconds':round(time.time()-start,3)};summary['commands'].append(record);(logs/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(record),flush=True);return result.returncode
for name,args in [('git-init',['git','init','--quiet']),('git-add',['git','add','.']),('git-snapshot',['git','-c','user.name=Linux validation','-c','user.email=linux-validation@localhost','-c','core.hooksPath=/dev/null','commit','--quiet','-m','isolated validation source snapshot']),('setup',['npm','run','setup','--','--skip-hooks'])]:
 if run(name,args):sys.exit(1)
commands=[('inspection-controls-targeted',['npx','tsx','--test','--test-name-pattern=检查重核','test/personal-services.test.ts','test/personal-cli.test.ts']),('personal-tests',['npx','tsx','--test','test/personal-durable.test.ts','test/personal-cli.test.ts','test/personal-services.test.ts','test/personal-work.test.ts','test/personal-work-tools.test.ts','test/personal-work-controls.test.ts','test/personal-work-notes.test.ts','test/personal-delegations.test.ts','test/personal-reports.test.ts','test/personal-service-operations.test.ts','test/personal-telegram.test.ts','test/personal-telegram-permissions.test.ts']),('build',['npm','run','build'])]
code=0
for name,args in commands:
 code=run(name,args)
 if code:break
summary['source_content_mismatches_after']=verify();summary['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(logs/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');(logs/'processes-after.json').write_text(json.dumps(processes(),indent=2)+'\n')
with (logs/'storage-after.txt').open('w') as out:subprocess.run(['df','-h','/dev/shm','/tmp'],stdout=out)
sys.exit(code)
