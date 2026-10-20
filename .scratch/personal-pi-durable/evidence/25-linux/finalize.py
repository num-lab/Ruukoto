from pathlib import Path
import os,json,hashlib,subprocess
b=Path('/tmp/ruukoto-command-25.sSTsx4')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
m=json.loads((b/'source-manifest.json').read_text())
comparison=[dict(r,actual=sha(b/'source'/r['path']),matches=sha(b/'source'/r['path'])==r['sha256']) for r in m['records']]
bundle=b/'source/apps/ruukoto/src/linux-command-probe.mjs'
checks={'records':comparison,'bundleSha256':sha(bundle),'bundleMatches':sha(bundle)==m['bundleSha256']}
(b/'remote-source-comparison.json').write_text(json.dumps(checks,indent=2)+'\n')
assert all(r['matches'] for r in comparison) and checks['bundleMatches']
cleanup=json.loads((b/'evidence/cleanup.json').read_text())
assert cleanup['fixturesRemaining']==[]
temps=[r['tempDir'] for r in cleanup['cleanup']]
matches=[]
for p in Path('/proc').iterdir():
    if not p.name.isdigit() or int(p.name) in [os.getpid(),os.getppid()]:continue
    try:
        if p.stat().st_uid!=os.getuid():continue
        args=p.joinpath('cmdline').read_bytes().split(bytes([0])); executable=Path(os.fsdecode(args[0])).name
        if executable not in ['node','bash','bwrap','systemd-run','sleep']:continue
        command=b' '.join(args).decode(errors='replace')
        try:cwd=os.readlink(p/'cwd')
        except OSError:cwd=''
        if str(b) in command or any(t in command or cwd.startswith(t) for t in temps):matches.append({'pid':int(p.name),'command':command,'cwd':cwd})
    except (OSError,ValueError):continue
processes={'remainingMatchingProcesses':matches,'remainingTemps':[t for t in temps if Path(t).exists()],'fixturesRemaining':list((b/'fixtures').iterdir()),'allScopesNotFound':all('LoadState=not-found' in r['unit'] for r in cleanup['cleanup'])}
(b/'process-cleanup.json').write_text(json.dumps(processes,indent=2,default=str)+'\n')
assert not matches and not processes['remainingTemps'] and not processes['fixturesRemaining'] and processes['allScopesNotFound']
records=[]
for name in ['evidence','evidence-initial','evidence-second','evidence-pre-final']:
    for p in sorted((b/name).rglob('*')):
        if p.is_file():records.append({'path':str(p.relative_to(b)),'bytes':p.stat().st_size,'sha256':sha(p)})
(b/'artifact-manifest.json').write_text(json.dumps({'records':records},indent=2)+'\n')
print(json.dumps({'sourceFiles':len(comparison),'evidenceFiles':len(records),'remainingProcesses':len(matches),'allScopesNotFound':True}))
