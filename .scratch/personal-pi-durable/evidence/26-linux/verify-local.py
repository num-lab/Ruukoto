from pathlib import Path
import json,hashlib,tarfile,subprocess
b=Path('/tmp/ruukoto-full-26-linux.9wDa5g');repo=Path('/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable')
sha=lambda data:hashlib.sha256(data).hexdigest()
read=lambda p:json.loads(p.read_text())
with tarfile.open(b/'records.tar.gz') as t:
 m=json.load(t.extractfile('./source-manifest.json'));source=[]
 for r in m['records']:
  data=t.extractfile('./source/'+r['path']).read();current=(repo/r['path']).read_bytes()
  source.append({**r,'archiveBytes':len(data),'archiveMatches':sha(data)==r['sha256'],'currentSha256':sha(current),'currentMatches':sha(current)==r['sha256']})
 assert all(r['archiveMatches'] and r['currentMatches'] for r in source)
 records=json.load(t.extractfile('./artifact-manifest.json'))['records'];artifact=[]
 for r in records:
  data=t.extractfile('./'+r['path']).read();artifact.append({**r,'matches':len(data)==r['bytes'] and sha(data)==r['sha256']})
 assert all(r['matches'] for r in artifact)
 old=json.load(t.extractfile('./old-source-manifest.json'));oldchecks=[]
 for r in old['records']:
  if r['path'].startswith('worker/'):continue
  data=t.extractfile('./old-source/'+r['path']).read();frozen=subprocess.check_output(['git','show','89b37f3:'+r['path']],cwd=repo)
  oldchecks.append({**r,'matches':sha(data)==r['sha256']==sha(frozen)})
 assert all(r['matches'] for r in oldchecks)
(b/'source-comparison.json').write_text(json.dumps({'records':source,'allMatch':True},indent=2)+'\n')
(b/'artifact-verification.json').write_text(json.dumps({'records':artifact,'allMatch':True},indent=2)+'\n')
(b/'old-source-comparison.json').write_text(json.dumps({'commit':'89b37f3','records':oldchecks,'allMatch':True},indent=2)+'\n')
print(json.dumps({'sourceFiles':len(source),'artifactFiles':len(artifact),'oldFrozenFiles':len(oldchecks),'allMatch':True}))
