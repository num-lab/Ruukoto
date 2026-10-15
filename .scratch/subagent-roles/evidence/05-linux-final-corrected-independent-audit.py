from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,tarfile
base=Path('/tmp/rk05-linux-evidence.H8sjfX')
main=Path('/Users/eitrous/orca/workspaces/ruukoto/subagent-roles')
def sha(b):return hashlib.sha256(b).hexdigest()
previous=Path('/tmp/05-linux-final-independent-audit.json');old=json.loads(previous.read_text())
archive=base/'linux-final-evidence.tar.gz';b=archive.read_bytes()
assert sha(b)=='6d5a6be9c22e7caeb1c0d57c775a3136a62e319c4640ccb55efa2c2c476a73de'
assert b==(main/'.scratch/subagent-roles/evidence/05-linux-final-evidence.tar.gz').read_bytes()
manifest=json.loads((base/'linux-final-manifest.json').read_text());expected={r['file']:r for r in manifest};prior={r['path']:r for r in old['archive']['checks']}
assert len(expected)==52 and set(expected)==set(prior)
checks=[]
with tarfile.open(archive,'r:gz') as t:
 members=t.getmembers();assert len(members)==53 and all(m.isfile() for m in members)
 by={m.name:m for m in members};assert set(by)==set(expected)|{'linux-final-manifest.json'}
 assert t.extractfile(by['linux-final-manifest.json']).read()==(base/'linux-final-manifest.json').read_bytes()
 for p,r in expected.items():
  data=t.extractfile(by[p]).read();assert len(data)==r['bytes'] and sha(data)==r['sha256'] and data==(base/p).read_bytes()
  checks.append({'path':p,'bytes':len(data),'sha256':sha(data),'match':True})
changed=sorted(p for p in expected if expected[p]['sha256']!=prior[p]['sha256'])
assert changed==['linux-final-report.md']
report=(base/'linux-final-report.md').read_bytes()
assert report==(main/'.scratch/subagent-roles/evidence/05-linux-final-report.md').read_bytes()
assert sha(report)=='9173b4d3dddc3d44805acb510b0d1cedc32c2097904e96a8140a4b4f7bb17a38'
text=report.decode();assert '按拥有者批准' not in text and '按协调者确认的受影响范围' in text
assert '最终 v6 执行过一次全绿' in text and '没有声称' in text
result={
 'auditedAt':datetime.now(timezone.utc).isoformat(),
 'scope':'最终修订包的逐项只读核对；与前一技术审计比较全部52 payload，确认仅报告归属用语改变。未重新运行检查，未写主仓。',
 'archive':{'path':str(archive),'sha256':sha(b),'bytes':len(b),'members':53,'payloadVerified':52,'mismatches':0,'mainCopyIdentical':True,'manifestFormat':'[{file,bytes,sha256}, ...]，52 payload + manifest self','checks':checks},
 'report':{'sha256':sha(report),'bytes':len(report),'mainCopyIdentical':True,'previousOnlyDifference':'把未经拥有者逐项批准的foundation复用归属改为协调者按受影响范围确认；没有新增运行或改变原始结果。'},
 'previousTechnicalAudit':{'path':str(previous),'sha256':sha(previous.read_bytes()),'archiveSha256':old['archive']['sha256'],'payloadUnchanged':51,'onlyChangedPayload':changed,'allRawSourceAndLogAuditsRemainApplicable':True},
 'sourceReconstruction':old['sourceReconstruction'],
 'finalV6Results':old['finalV6Results'],
 'fullV4Results':old['fullV4Results'],
 'conclusion':old['conclusion']
}
p=Path('/tmp/05-linux-final-corrected-independent-audit.json');p.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'audit':str(p),'sha256':sha(p.read_bytes()),'archive':sha(b),'verifiedPayloads':52,'unchangedRawPayloads':51,'onlyChanged':'linux-final-report.md','mainArchiveAndReportCopyIdentical':True},ensure_ascii=False))
