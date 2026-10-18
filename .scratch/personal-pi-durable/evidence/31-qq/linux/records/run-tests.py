import os,sys,json,subprocess,time,hashlib,pathlib
base=pathlib.Path(__file__).resolve().parent;repo=base/'repo'
env={k:v for k,v in os.environ.items() if not k.startswith(('RUUKOTO_','RUUKOTO_CODE_'))};env['RUN_MODEL_CHECK']='0'
groups=[('personal',['test/personal-qq.test.ts','test/personal-cli.test.ts']),('shared',['test/26-qq.test.ts','test/40-qq-private.test.ts','test/41-qq-private-scope.test.ts','test/89-im-entries.test.ts'])]
if len(sys.argv)>1:groups=[group for group in groups if group[0]==sys.argv[1]]
results=[]
for name,files in groups:
 args=['node','--import','tsx','--test','--test-concurrency=1',*files];started=time.time()
 with open(base/(name+'-tests.log'),'w') as log:
  result=subprocess.run(args,cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT)
 record={'group':name,'command':args,'cwd':str(repo),'started':started,'elapsedSeconds':time.time()-started,'exitCode':result.returncode}
 results.append(record);(base/('test-results-'+(sys.argv[1] if len(sys.argv)>1 else 'all')+'.json')).write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(record),flush=True)
 if result.returncode:print((base/(name+'-tests.log')).read_text()[-15000:],flush=True)
print(json.dumps({'passed':all(x['exitCode']==0 for x in results),'groups':len(results)}),flush=True)
sys.exit(0 if all(x['exitCode']==0 for x in results) else 1)
