from pathlib import Path
import json, hashlib, subprocess, datetime
work=Path('/tmp/ruukoto38-pack-20261018-1').resolve()
evidence=Path('/tmp/ruukoto38-pack-evidence-20261018-1')
source=json.loads((evidence/'source-manifest.json').read_text())
mismatch=[]
for item in source:
    p=work/item['path']
    if item.get('deleted'):
        if p.exists():mismatch.append(item['path'])
    elif 'symlink' in item:
        if not p.is_symlink() or str(p.readlink())!=item['symlink']:mismatch.append(item['path'])
    elif hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']:
        mismatch.append(item['path'])
artifacts=[]
for before in json.loads((evidence/'artifact-manifest-before-tests.json').read_text()):
    p=work/before['path']
    current={'path':before['path'],'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size}
    artifacts.append(current)
    assert current==before,current
(evidence/'artifact-manifest-after-tests.json').write_text(json.dumps(artifacts,indent=2)+'\n')
assert not mismatch,mismatch
lines=subprocess.check_output(['ps','-axo','pid=,ppid=,comm=,args='],encoding='utf8',errors='replace').splitlines()
active=[]
for line in lines:
    parts=line.strip().split(None,3)
    if len(parts)==4 and Path(parts[2]).name in ['node','npm','tsx'] and any(alias in parts[3] for alias in [str(work),'/tmp/ruukoto38-pack-20261018-1']):
        active.append(line)
record={'returncode':0,'finishedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceEntriesVerified':len(source),'sourceMismatches':mismatch,'artifactsVerified':len(artifacts),'artifactsUnchanged':True,'matchingNodeProcesses':active,'processScanScope':'Read-only matching of node/npm/tsx command arguments containing this isolated worktree; not a system-wide descendant proof.'}
(evidence/'post-test-verification.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record,indent=2))
