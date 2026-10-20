import datetime,hashlib,json,os,pathlib,subprocess,sys,time,tarfile
logs=pathlib.Path(__file__).resolve().parent;config=json.loads((logs/'paths.json').read_text());source=pathlib.Path(config['source']);tmp=pathlib.Path(config['temp_root'])
for version in ['v2','v3','v4']:
 with tarfile.open(logs/f'incremental-{version}.tar.gz','r:gz') as archive:archive.extractall(source,filter='data')
manifest=(logs/'source-manifest-v4.jsonl').read_bytes();entries=[json.loads(line) for line in manifest.splitlines()]
def verify():
 mismatches=[]
 for item in entries:
  p=source/item['path'];data=os.readlink(p).encode() if p.is_symlink() else p.read_bytes()
  if hashlib.sha256(data).hexdigest()!=item['sha256']:mismatches.append(item['path'])
 return mismatches
if verify():raise RuntimeError(verify())
summary={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_manifest_sha256':hashlib.sha256(manifest).hexdigest(),'source_content_mismatches_before':verify(),'commands':[]}
env=os.environ.copy();env.update({'RUN_MODEL_CHECK':'0','TMPDIR':str(tmp),'npm_config_cache':str(source/'.npm-cache'),'XDG_CACHE_HOME':str(source/'.cache')})
def run(name,args):
 start=time.time()
 with (logs/(name+'.log')).open('w') as out:result=subprocess.run(args,cwd=source,env=env,stdout=out,stderr=subprocess.STDOUT)
 record={'name':name,'argv':args,'exit_code':result.returncode,'seconds':round(time.time()-start,3)};summary['commands'].append(record);(logs/'incremental-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(record),flush=True);return result.returncode
code=0
commands=[('incremental-two-files',['npx','tsx','--test','test/personal-services.test.ts','test/personal-cli.test.ts']),('service-operation-cancel-recovery',['npx','tsx','--test','--test-name-pattern=prepare.*取消|取消.*prepare','test/personal-service-operations.test.ts'])]
for name,args in commands:
 code=run(name,args)
 if code:break
summary['source_content_mismatches_after']=verify();summary['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(logs/'incremental-summary.json').write_text(json.dumps(summary,indent=2)+'\n');sys.exit(code)
