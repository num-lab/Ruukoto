from pathlib import Path
import json,shutil,subprocess
root=Path('/tmp/ruukoto-full-26.R7idsd');archive=Path('/tmp/ruukoto-full-26.R7idsd-records.tar.gz')
scopes=json.loads((root/'process-cleanup.json').read_text())['scopes']
assert root.is_dir() and root.parent==Path('/tmp') and root.name=='ruukoto-full-26.R7idsd'
shutil.rmtree(root);archive.unlink()
checks=[]
for row in scopes:
 result=subprocess.run(['systemctl','--user','show',row['scope'],'--property=LoadState,ControlGroup'],capture_output=True,text=True)
 checks.append({'scope':row['scope'],'absent':'LoadState=not-found' in result.stdout and 'ControlGroup=\n' in result.stdout})
assert all(r['absent'] for r in checks)
print(json.dumps({'directory':str(root),'directoryAbsent':not root.exists(),'archive':str(archive),'archiveAbsent':not archive.exists(),'scopeChecks':checks},indent=2))
