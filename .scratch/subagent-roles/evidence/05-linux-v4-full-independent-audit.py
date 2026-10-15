from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,tarfile,re
base=Path('/tmp/rk05-linux-evidence.H8sjfX/full-v4-raw')
out=Path('/tmp/05-linux-v4-full-independent-audit.json')
def sha(data): return hashlib.sha256(data).hexdigest()
def read(name): return json.loads((base/name).read_text())
manifest=read('full-v4-raw-manifest.json')
raw=[]
for row in manifest:
 b=(base/row['file']).read_bytes()
 raw.append({'path':row['file'],'bytes':len(b),'sha256':sha(b),'match':len(b)==row['bytes'] and sha(b)==row['sha256']})
assert len({r['path'] for r in raw})==23 and all(r['match'] for r in raw)
inputs=read('full-check-inputs-v4.json'); frozen=read('main-final-source-inputs-v4.json')
expected={r['file']:r for r in inputs['files']}
assert len(expected)==1552
checks=[]; source_contents={}
with tarfile.open(base/'full-check-v4-source.tar.gz','r:gz') as tar:
 members=tar.getmembers(); assert len(members)==1552
 assert len({m.name for m in members})==1552
 assert set(expected)=={m.name for m in members}
 for m in members:
  row=expected[m.name]
  if row['type']=='symlink':
   ok=m.issym() and m.linkname==row['target']
   checks.append({'path':m.name,'kind':'symlink','target':m.linkname,'match':ok})
  else:
   b=tar.extractfile(m).read(); source_contents[m.name]=b
   ok=m.isfile() and len(b)==row['size'] and sha(b)==row['sha256']
   checks.append({'path':m.name,'kind':'file','bytes':len(b),'sha256':sha(b),'match':ok})
assert all(r['match'] for r in checks)
frozen_checks=[]
for r in frozen['entries']:
 e=expected[r['path']]
 ok=r['kind']==e['type'] and (r['target']==e['target'] if r['kind']=='symlink' else r['bytes']==e['size'] and r['sha256']==e['sha256'])
 frozen_checks.append({'path':r['path'],'match':ok})
assert len(frozen_checks)==620 and all(r['match'] for r in frozen_checks)
after=read('full-check-v4-source-after.json'); before=read('full-check-v4-source-before.json')
assert before['all_620_match'] and before['all_1552_match'] and before['git_status']==''
for key,n in [('selected_checks',1552),('frozen_checks',620)]:
 rows=after[key]; assert len(rows)==n and all(x['match'] for x in rows)
 for r in rows:
  e=expected[r['path']]
  assert r['kind']==e['type']
  if r['kind']=='file': assert r['sha256']==e['sha256']
  else: assert r['target']==e['target']
assert after['git_status']==''
required=read('required-scratch-v4.json'); assert len(required)==116
assert all(r['file'] in expected and expected[r['file']]['size']==r['size'] for r in required)
assert len(inputs['excluded'])==31 and not any(r['file'] in expected for r in inputs['excluded'])
diag='test/122-workflow-code-acceptance.180-diagnostic.ts'
exclusion=read('full-check-v4-diagnostic-exclusion.json');cleanup=read('122-diagnostic-cleanup.json')
assert diag not in expected and before['diagnostic_file_absent'] and exclusion['startup_explicit_absence'] and exclusion['after_full_diagnostic_absent'] and cleanup['diagnostic_file_absent']
assert exclusion['cleanup_record_sha256']==sha((base/'122-diagnostic-cleanup.json').read_bytes())
assert expected['test/122-workflow-code-acceptance.test.ts']['sha256']==before['formal_122_sha256']=='c37206ab1f4f05a9c15038f45d6bff1b27f8123a7dfd87a461e4b246fded343e'
log=(base/'logs/full-final-check-v4.log').read_text();command=read('logs/full-final-check-v4.command.json')
assert command['command']==['npm','run','check'] and command['exit_code']==1
assert after['command']==command
for text in ['ℹ tests 1658','ℹ pass 1644','ℹ fail 1','ℹ cancelled 0','ℹ skipped 13','ℹ duration_ms 1382898.992716']:
 assert text in log
failure=(base/'full-check-v4-failure.log').read_text()
assert failure in log
for text in ['test/14-tui-app.test.ts:291:12','单条补读不依赖任务元数据',"text: '启动工作'",'entryId: null',"key: 'input:task_0252a2e254fbf8a29324e691'",'seq: -1','- []']:
 assert text in failure
app=source_contents['scripts/test-app.mjs'].decode(); package=json.loads(source_contents['package.json'])
assert 'if (platform !== "darwin") return [{ files: [...files], serial: false }]' in app
assert package['scripts']['test']=='node scripts/check-environment.mjs && npm run test:app && npm run test:foundation'
assert '\n> ruukoto@' not in log.split('ℹ tests 1658')[-1]
assert '> RUN_MODEL_CHECK=0 npm --prefix verification/foundation test' not in log
archive=base/'full-check-v4-source.tar.gz'
audit={
 'auditedAt':datetime.now(timezone.utc).isoformat(),
 'scope':'只读独立回读 Linux v4 正式全量原始日志、冻结源码包与前后输入核对；不重跑测试，不改主仓。',
 'rawManifest':{'path':str(base/'full-v4-raw-manifest.json'),'sha256':sha((base/'full-v4-raw-manifest.json').read_bytes()),'verified':23,'mismatches':0,'checks':raw},
 'sourceArchive':{'path':str(archive),'sha256':sha(archive.read_bytes()),'verified':1552,'mismatches':0,'regularFiles':1551,'symlinks':1},
 'frozenSource':{'sha256':sha((base/'main-final-source-inputs-v4.json').read_bytes()),'verified':620,'mismatches':0},
 'sourceBeforeAndAfter':{'startupEvidence1552':before['all_1552_match'],'startupEvidence620':before['all_620_match'],'after1552ChecksAllMatch':True,'after620ChecksAllMatch':True,'gitStatusBefore':before['git_status'],'gitStatusAfter':after['git_status'],'immutableSnapshotMatchesCatalog':True},
 'requiredScratch':{'included':116,'allPresentWithExpectedSize':True,'historicalUnlinkedArchivesExcluded':31},
 'diagnosticExclusion':{'path':diag,'notIn1552CatalogOrArchive':True,'startupExplicitAbsence':True,'afterFullExplicitAbsence':True,'cleanupRecordVerified':True,'cleanupPrecedesFormalUpdate':True,'formal122Sha256':before['formal_122_sha256']},
 'command':command,
 'applicationResults':{'tests':1658,'pass':1644,'fail':1,'skip':13,'cancel':0,'durationMs':1382898.992716},
 'soleFailure':{'path':'test/14-tui-app.test.ts:291:12','assertion':'单条补读不依赖任务元数据','expected':[],'actualRole':'user','actualText':'启动工作','actualKey':'input:task_0252a2e254fbf8a29324e691','actualSeq':-1,'actualEntryId':None,'matchesIndependentOwnerGetTaskAndListTasksGatedReproduction':True,'internalWorkflowInputInFailure':False,'rawFailureSha256':sha(failure.encode())},
 'foundation':{'executedInThisFull':False,'reason':'package.json 的 && 在 test:app 退出1后短路；单独基础9通过1模型门skip另列，不能算本轮全量。'},
 'batchBoundary':'Linux appTestBatches 为单个全部文件批次；末尾通用“剩余批次未运行”不证明另有 Linux 应用批次未跑。',
 'conclusion':'该轮全量实际 exit1；唯一失败与独立门控复现的旧恢复迟到拥有者行吻合。最终 v6 只在 v4 上增加 runtime 等价机械调整与 test14 夹具隔离，必须按 Linux 最终受影响整文件/30例/静态的实际结果另列，不能改称本轮全量通过。'
}
out.write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'audit':str(out),'sha256':sha(out.read_bytes()),'rawVerified':23,'sourceVerified':1552,'frozenVerified':620,'requiredScratch':116,'result':audit['applicationResults'],'exit':command['exit_code'],'failure':'test/14-tui-app.test.ts:291:12, actual owner 启动工作; matches independent gates'},ensure_ascii=False))
