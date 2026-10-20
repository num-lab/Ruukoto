from pathlib import Path
import shutil,subprocess,hashlib,json,time
root=Path('/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable')
base=Path('/tmp/ruukoto-model-review-tJYsF1')
evidence=base/'final-evidence'; evidence.mkdir()
copy=base/'mutation-final'; (copy/'apps/ruukoto').mkdir(parents=True)
shutil.copytree(root/'apps/ruukoto/src',copy/'apps/ruukoto/src')
(copy/'test/helpers').mkdir(parents=True)
for rel in ['package.json','test/personal-work-tools.test.ts','test/helpers/mock-provider.ts']:
 shutil.copy2(root/rel,copy/rel)
(copy/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
(copy/'apps/ruukoto/node_modules').symlink_to(root/'apps/ruukoto/node_modules',target_is_directory=True)
inputs=list((root/'apps/ruukoto/src').glob('*.ts'))+[root/'test/personal-work-tools.test.ts',root/'test/helpers/mock-provider.ts']
manifest={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
(evidence/'source-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
records=[]
def run(label,args,cwd,expected):
 t=time.monotonic(); p=subprocess.run(args,cwd=cwd,capture_output=True)
 (evidence/(label+'.stdout.log')).write_bytes(p.stdout); (evidence/(label+'.stderr.log')).write_bytes(p.stderr)
 records.append({'name':label,'args':list(map(str,args)),'cwd':str(cwd),'exitCode':p.returncode,'expectedExitCode':expected,'durationSeconds':time.monotonic()-t})
 assert p.returncode==expected,records[-1]
run('final-work-tools',[root/'node_modules/.bin/tsx','--test','test/personal-work-tools.test.ts'],root,0)
run('cancel-baseline',[root/'node_modules/.bin/tsx','--test','--test-name-pattern=取消处理 faulted',copy/'test/personal-work-tools.test.ts'],copy,0)
p=copy/'apps/ruukoto/src/personal-work-tools.ts'
s=p.read_text(); before='const stopped = agent && agent.work?.taskId !== result.cancel.taskId && ["completed", "failed", "aborted"].includes(settled.state.outcome.status);'
assert s.count(before)==1
p.write_text(s.replace(before,'const stopped = true;'))
run('cancel-mutation',[root/'node_modules/.bin/tsx','--test','--test-name-pattern=取消处理 faulted',copy/'test/personal-work-tools.test.ts'],copy,1)
assert b'stop_unverified' in (evidence/'cancel-mutation.stdout.log').read_bytes()
changed=[rel for rel,digest in manifest.items() if hashlib.sha256((root/rel).read_bytes()).hexdigest()!=digest]
assert not changed,changed
shutil.rmtree(copy)
(evidence/'summary.json').write_text(json.dumps({'sourceUnchanged':True,'manifestFiles':len(manifest),'mutationCopyRemoved':True,'records':records},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'directory':str(evidence),'sourceUnchanged':True,'records':[{k:v for k,v in r.items() if k in ['name','exitCode','durationSeconds']} for r in records]},ensure_ascii=False))
