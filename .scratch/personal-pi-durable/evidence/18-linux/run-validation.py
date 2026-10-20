import datetime,hashlib,json,os,pathlib,stat,subprocess,sys,time
source=pathlib.Path('/dev/shm/rk-18-linux-20261017T074832Z')
logs=pathlib.Path('/tmp/rk-18-linux-20261017T074832Z')
manifest=(logs/'source-manifest.jsonl').read_bytes()
entries=[json.loads(line) for line in manifest.splitlines()]
with __import__('tarfile').open(logs/'source.tar.gz','r:gz') as archive: archive.extractall(source,filter='data')
def verify():
 mismatches=[]
 for item in entries:
  p=source/item['path']; st=p.lstat(); data=os.readlink(p).encode() if p.is_symlink() else p.read_bytes()
  if hashlib.sha256(data).hexdigest()!=item['sha256'] or (item['kind']=='file' and stat.S_IMODE(st.st_mode)!=item['mode']): mismatches.append(item['path'])
 return mismatches
mismatches=verify()
if mismatches: raise RuntimeError(mismatches)
summary={'source_manifest_sha256':hashlib.sha256(manifest).hexdigest(),'source_files':len(entries),'commands':[]}
env=os.environ.copy(); env['RUN_MODEL_CHECK']='0'; env['XDG_CACHE_HOME']=str(source/'.cache')
def run(name,args):
 start=time.time()
 with (logs/(name+'.log')).open('w') as out:
  result=subprocess.run(args,cwd=source,env=env,stdout=out,stderr=subprocess.STDOUT)
 record={'name':name,'argv':args,'exit_code':result.returncode,'seconds':round(time.time()-start,3)}
 summary['commands'].append(record)
 (logs/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 print(json.dumps(record),flush=True)
 return result.returncode
if run('git-init',['git','init','--quiet']):sys.exit(1)
if run('git-add',['git','add','.']):sys.exit(1)
if run('git-snapshot',['git','-c','user.name=Linux validation','-c','user.email=linux-validation@localhost','-c','core.hooksPath=/dev/null','commit','--quiet','-m','isolated validation source snapshot']):sys.exit(1)
commands=[
 ('setup',['npm','run','setup','--','--skip-hooks']),
 ('build',['npm','run','build']),
 ('personal-tests',['npx','tsx','--test','test/personal-durable.test.ts','test/personal-cli.test.ts','test/personal-services.test.ts','test/personal-work.test.ts','test/personal-work-tools.test.ts','test/personal-work-controls.test.ts','test/personal-work-notes.test.ts','test/personal-delegations.test.ts','test/personal-reports.test.ts','test/personal-service-operations.test.ts','test/personal-telegram.test.ts','test/personal-telegram-permissions.test.ts']),
 ('entry-tests',['npx','tsx','--test','test/71-product-entry.test.ts']),
]
for name,args in commands:
 code=run(name,args)
 if code:break
summary['source_mismatches_after']=verify()
summary['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
(logs/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
with (logs/'processes-after.txt').open('w') as out: subprocess.run(['ps','-u',os.environ['USER'],'-o','pid=,ppid=,pgid=,sid=,args='],stdout=out)
with (logs/'storage-after.txt').open('w') as out: subprocess.run(['df','-h','/dev/shm','/tmp'],stdout=out)
sys.exit(code)
