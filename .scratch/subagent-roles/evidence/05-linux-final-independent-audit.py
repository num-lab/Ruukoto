from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,tarfile,re
base=Path('/tmp/rk05-linux-evidence.H8sjfX')
main=Path('/Users/eitrous/orca/workspaces/ruukoto/subagent-roles')
def sha(b):return hashlib.sha256(b).hexdigest()
def read(rel):return json.loads((base/rel).read_text())
archive=base/'linux-final-evidence.tar.gz'
assert sha(archive.read_bytes())=='5035a87cbc1bae70317246c1bc79fafcc5fea9fc1252f7825de50ad45fa1e86b'
manifest=read('linux-final-manifest.json')
archive_checks=[]
with tarfile.open(archive,'r:gz') as tar:
 members=tar.getmembers(); assert len(members)==53 and all(m.isfile() for m in members)
 names={m.name:m for m in members};assert len(names)==53
 assert set(names)=={'linux-final-manifest.json'}|{r['file'] for r in manifest}
 assert tar.extractfile(names['linux-final-manifest.json']).read()==(base/'linux-final-manifest.json').read_bytes()
 for r in manifest:
  b=tar.extractfile(names[r['file']]).read()
  ok=len(b)==r['bytes'] and sha(b)==r['sha256'] and (base/r['file']).read_bytes()==b
  archive_checks.append({'path':r['file'],'bytes':len(b),'sha256':sha(b),'match':ok})
assert len(archive_checks)==52 and all(r['match'] for r in archive_checks)
inner={}
for prefix,name,count in [('full-v4-raw','full-v4-raw-manifest.json',23),('final-v6-raw','final-v6-raw-manifest.json',15)]:
 rows=read(prefix+'/'+name);assert len(rows)==count
 for r in rows:
  b=(base/prefix/r['file']).read_bytes(); assert len(b)==r['bytes'] and sha(b)==r['sha256']
 inner[prefix]={'verified':count,'mismatches':0,'manifestSha256':sha((base/prefix/name).read_bytes())}
v4=read('full-v4-raw/full-check-inputs-v4.json')
v6=read('final-v6-raw/final-v6-full-inputs.json')
old={r['file']:r for r in v4['files']};new={r['file']:r for r in v6['files']}
assert len(old)==len(new)==1552 and set(old)==set(new)
changed=sorted(p for p in old if old[p]!=new[p]);assert changed==['packages/runtime/src/runtime.ts','test/14-tui-app.test.ts']
# Read every archived v4 source member, then replace only the two actual final bytes.
reconstructed={}
with tarfile.open(base/'full-v4-raw/full-check-v4-source.tar.gz','r:gz') as t:
 members=t.getmembers();assert len(members)==1552
 for m in members:
  r=old[m.name]
  if r['type']=='symlink':
   assert m.issym() and m.linkname==r['target'];reconstructed[m.name]={'type':'symlink','target':m.linkname}
  else:
   b=t.extractfile(m).read();assert len(b)==r['size'] and sha(b)==r['sha256']
   reconstructed[m.name]={'type':'file','size':len(b),'sha256':sha(b)}
for p in changed:
 b=(base/'final-v6-raw/repo'/p).read_bytes();reconstructed[p]={'type':'file','size':len(b),'sha256':sha(b)}
 assert (main/p).read_bytes()==b
for p,r in reconstructed.items():
 e=new[p]
 assert r['type']==e['type']
 if r['type']=='symlink':assert r['target']==e['target']
 else:assert r['size']==e['size'] and r['sha256']==e['sha256']
frozen=read('final-v6-raw/main-final-source-inputs-v6.json')
assert sha((base/'final-v6-raw/main-final-source-inputs-v6.json').read_bytes())=='8e4c67ee72fcada1910073e6a5063341cf9fbd515f4293134ed1332a102ae0fa'
assert (base/'final-v6-raw/main-final-source-inputs-v6.json').read_bytes()==(main/'.scratch/subagent-roles/evidence/05-final-source-inputs-v6.json').read_bytes()
for r in frozen['entries']:
 e=reconstructed[r['path']];assert e['type']==r['kind']
 if r['kind']=='symlink':assert e['target']==r['target']
 else:assert e['size']==r['bytes'] and e['sha256']==r['sha256']
assert len(frozen['entries'])==620
before=read('final-v6-raw/final-v6-source-before.json');after=read('final-v6-raw/final-v6-source-after.json')
for record in [before,after]:
 assert record['all_620_match'] and record['git_status']=='' and len(record['checks'])==620 and all(r['match'] for r in record['checks'])
 for r in record['checks']:
  e=reconstructed[r['path']];assert r['actual']==(e['target'] if e['type']=='symlink' else e['sha256'])
assert after['all_1552_match_expected_v6'] and after['only_actual_delta_from_v4']==changed
assert before['diagnostic_file_absent'] and after['diagnostic_path_absent']
expected_tests=sorted(p for p in new if p.startswith('test/') and p.endswith('.test.ts') and p.count('/')==1)
assert len(expected_tests)==169 and after['app_test_files']==expected_tests and after['app_test_files_exact_frozen_manifest']
commands=[]
for label,tests in [('final-v6-tui-app',35),('final-v6-source-recovery',30),('final-v6-static',None)]:
 cmd=read('final-v6-raw/logs/'+label+'.command.json');assert cmd['exit_code']==0
 log=(base/'final-v6-raw/logs'/cmd['log']).read_text()
 if tests is not None:
  for s in [f'ℹ tests {tests}',f'ℹ pass {tests}','ℹ fail 0','ℹ cancelled 0','ℹ skipped 0']:assert s in log
 else:
  for s in ['lint','typecheck','verify-notes','check:docs','verify-md-wrap']:assert s in log
 commands.append({'command':cmd,'tests':tests,'pass':tests,'fail':0,'skip':0 if tests else None,'cancel':0 if tests else None,'logSha256':sha(log.encode())})
assert [r['command'] for r in commands]==after['commands']
assert commands[0]['command']['ended_utc']<commands[1]['command']['started_utc']
assert commands[1]['command']['ended_utc']<commands[2]['command']['started_utc']
for r in after['artifacts']:
 b=(base/'full-v4-raw/repo'/r['path']).read_bytes();assert len(b)==r['bytes'] and sha(b)==r['sha256']
log=(base/'full-v4-raw/logs/full-final-check-v4.log').read_text()
skips=[l for l in log.splitlines() if l.startswith('﹣ ')]
assert len(skips)==13 and sum('真实模型' in l for l in skips)==7 and sum('macOS' in l for l in skips)==6
assert '✔ 编码六输入：共享三名额、失败依赖跳过、独立验证与实际五份冻结成果汇总，唯一部分失败回报 (174420.777978ms)' in log
result={
 'auditedAt':datetime.now(timezone.utc).isoformat(),
 'scope':'非作者只读核对 Linux 原始统一归档、全部记录/输入及最终命令；本次未重新运行测试或外部模型，未写主仓。',
 'archive':{'path':str(archive),'sha256':sha(archive.read_bytes()),'bytes':archive.stat().st_size,'members':53,'manifestPayloadChecks':52,'mismatches':0,'manifestFormat':'[{file,bytes,sha256}, ...]，不列自身；52 payload + manifest = 53 regular members','checks':archive_checks},
 'rawManifests':inner,
 'sourceReconstruction':{'v4ArchiveMembersIndividuallyReadAndMatched':1552,'actualFinalTwoFilesReadAndMatchedMain':changed,'reconstructedV6MatchesAll1552':True,'other1550Unchanged':True,'v6FrozenEntries':620,'v6FrozenSha256':sha((base/'final-v6-raw/main-final-source-inputs-v6.json').read_bytes()),'all620MatchMainAndReconstructedSource':True,'beforeAfter620ChecksMatched':True,'after1552AssertedMatched':True,'appTestFiles169ExactSetMatch':True,'diagnosticExplicitAbsentBeforeAndAfter':True,'gitStatusBefore':'','gitStatusAfter':''},
 'finalV6Results':commands,
 'fullV4Results':{'command':['npm','run','check'],'exit':1,'tests':1658,'pass':1644,'fail':1,'skip':13,'cancel':0,'elapsedSeconds':1520.285340776667,'appDurationMs':1382898.992716,'skipBreakdown':{'realModelGates':7,'macOSSpecific':6},'soleFailure':'test/14-tui-app.test.ts:291:12，单条补读不依赖任务元数据；actual 仅合法拥有者启动工作，entryId:null、seq:-1，与独立 get_task/list_tasks 门控同因。','formal122PassedInDefaultConcurrency':True,'formal122DurationMs':174420.777978,'foundationInThisCommand':False},
 'conclusion':'无未解决实现阻断或本轮受影响工程证据缺口；可交 ready-for-human 等待外部平台和拥有者体验。两次 Linux 完整检查仍为 exit1，macOS 原完整亦失败；最终 v6 没有单次全绿完整 check，最终35/30/静态只证明所述受影响范围。实际外部 MCP/IM、其他模型/Linux真实模型及拥有者主观体验未代验。'
}
p=Path('/tmp/05-linux-final-independent-audit.json');p.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'audit':str(p),'auditSha256':sha(p.read_bytes()),'archive':result['archive']['sha256'],'manifest':'52/52 + self','source':'1552 reconstructed; 620 frozen; 169 app files','results':'35/35,30/30,static0; full v4 remains exit1'},ensure_ascii=False))
