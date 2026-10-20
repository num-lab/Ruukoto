import pathlib,subprocess,json,hashlib,datetime,os
root=pathlib.Path.cwd(); evidence=pathlib.Path('/tmp/ruukoto38-native101-diagnostic')
paths=['test/101-native-macos-helper.test.ts','packages/agent/src/execution/native-macos-supervisor.c','packages/agent/src/execution/native-macos.ts','packages/agent/src/execution/native.ts','scripts/build-native.mjs','worker/native-macos-supervisor']
hashes={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in paths}
(evidence/'current-source-before.json').write_text(json.dumps(hashes,indent=2)+'\n')
argv=[subprocess.check_output(['node','-p','process.execPath'],text=True).strip(),'--import','tsx','--test','--test-concurrency=1','--test-name-pattern=macOS 控制通道关闭回收独立进程组内忽略 TERM 的已累计后代','test/101-native-macos-helper.test.ts']
results=[]
for i in range(1,4):
 with (evidence/f'current-{i}.log').open('w') as log:
  started=datetime.datetime.now(datetime.timezone.utc).isoformat()
  result=subprocess.run(argv,cwd=root,env=dict(os.environ,RUN_MODEL_CHECK='0'),stdout=log,stderr=subprocess.STDOUT,timeout=45)
 results.append({'run':i,'exit':result.returncode,'startedUtc':started,'log':f'current-{i}.log'})
 print(json.dumps(results[-1]),flush=True)
changed=[name for name,value in hashes.items() if hashlib.sha256((root/name).read_bytes()).hexdigest()!=value]
processes=subprocess.check_output(['ps','-axo','pid,ppid,command']).decode(errors='replace').splitlines()
remaining=[line for line in processes if 'rk-native-stop-' in line and any(token in line.split(None,2)[-1].split()[0] for token in ['node','native-macos-supervisor'])]
summary={'cwd':str(root),'argv':argv,'env':{'RUN_MODEL_CHECK':'0'},'results':results,'sourceChanged':changed,'remainingFixtureProcesses':remaining}
(evidence/'current-results.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False))
