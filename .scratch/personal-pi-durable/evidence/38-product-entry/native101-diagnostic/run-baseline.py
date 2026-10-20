import pathlib,subprocess,json,hashlib,datetime,os
root=pathlib.Path('/tmp/ruukoto38-docs-20261018').resolve(); evidence=pathlib.Path('/tmp/ruukoto38-native101-diagnostic'); current=pathlib.Path.cwd()
paths=['test/101-native-macos-helper.test.ts','packages/agent/src/execution/native-macos-supervisor.c','packages/agent/src/execution/native-macos.ts','packages/agent/src/execution/native.ts','scripts/build-native.mjs']
records=[]
for name in paths:
 baseline=(root/name).read_bytes(); candidate=(current/name).read_bytes(); committed=subprocess.check_output(['git','show','HEAD:'+name],cwd=root)
 records.append({'path':name,'baselineSha256':hashlib.sha256(baseline).hexdigest(),'candidateSha256':hashlib.sha256(candidate).hexdigest(),'headSha256':hashlib.sha256(committed).hexdigest(),'allEqual':baseline==candidate==committed})
 assert baseline==candidate==committed,name
binaries={key:hashlib.sha256((tree/'worker/native-macos-supervisor').read_bytes()).hexdigest() for key,tree in [('baseline',root),('candidate',current)]}
argv=[subprocess.check_output(['node','-p','process.execPath'],text=True).strip(),'--import','tsx','--test','--test-concurrency=1','--test-name-pattern=macOS 控制通道关闭回收独立进程组内忽略 TERM 的已累计后代','test/101-native-macos-helper.test.ts']
results=[]
for i in range(1,4):
 with (evidence/f'baseline-{i}.log').open('w') as log:
  started=datetime.datetime.now(datetime.timezone.utc).isoformat(); result=subprocess.run(argv,cwd=root,env=dict(os.environ,RUN_MODEL_CHECK='0'),stdout=log,stderr=subprocess.STDOUT,timeout=45)
 results.append({'run':i,'exit':result.returncode,'startedUtc':started,'log':f'baseline-{i}.log'}); print(json.dumps(results[-1]),flush=True)
processes=subprocess.check_output(['ps','-axo','pid,ppid,command']).decode(errors='replace').splitlines()
remaining=[line for line in processes if 'rk-native-stop-' in line and any(token in line.split(None,2)[-1].split()[0] for token in ['node','native-macos-supervisor'])]
summary={'cwd':str(root),'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'argv':argv,'env':{'RUN_MODEL_CHECK':'0'},'sourceEquivalence':records,'binaryHashes':binaries,'binaryEqual':binaries['candidate']==binaries['baseline'],'results':results,'remainingFixtureProcesses':remaining,'dependencyNote':'baseline worktree reuses current node_modules link; target test directly invokes independently compiled HEAD C supervisor, and all referenced native TS files/test bytes equal HEAD.'}
(evidence/'baseline-results.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n'); print(json.dumps(summary,ensure_ascii=False))
