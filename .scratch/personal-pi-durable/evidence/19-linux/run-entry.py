import datetime,hashlib,json,os,pathlib,subprocess,sys,time,tarfile
logs=pathlib.Path(__file__).resolve().parent;config=json.loads((logs/'paths.json').read_text());source=pathlib.Path(config['source']);tmp=pathlib.Path(config['temp_root'])
with tarfile.open(logs/'incremental-v5.tar.gz','r:gz') as archive:archive.extractall(source,filter='data')
manifest=(logs/'source-manifest-v5.jsonl').read_bytes();entries=[json.loads(line) for line in manifest.splitlines()];mismatches=[]
for item in entries:
 p=source/item['path'];data=os.readlink(p).encode() if p.is_symlink() else p.read_bytes()
 if hashlib.sha256(data).hexdigest()!=item['sha256']:mismatches.append(item['path'])
if mismatches:raise RuntimeError(mismatches)
env=os.environ.copy();env.update({'RUN_MODEL_CHECK':'0','TMPDIR':str(tmp),'npm_config_cache':str(source/'.npm-cache'),'XDG_CACHE_HOME':str(source/'.cache')})
args=['npx','tsx','--test','test/71-product-entry.test.ts'];start=time.time()
with (logs/'entry-tests.log').open('w') as out:result=subprocess.run(args,cwd=source,env=env,stdout=out,stderr=subprocess.STDOUT)
summary={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_manifest_sha256':hashlib.sha256(manifest).hexdigest(),'source_content_mismatches_before':mismatches,'argv':args,'exit_code':result.returncode,'seconds':round(time.time()-start,3)};(logs/'entry-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary));sys.exit(result.returncode)
