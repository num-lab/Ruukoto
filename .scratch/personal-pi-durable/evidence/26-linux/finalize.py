from pathlib import Path
import os,json,hashlib,subprocess
b=Path('/tmp/ruukoto-full-26.R7idsd')
read=lambda p:json.loads(p.read_text())
write=lambda p,v:p.write_text(json.dumps(v,indent=2,ensure_ascii=False)+'\n')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
m=read(b/'source-manifest.json')
comparison=[dict(r,actual=sha(b/'source'/r['path']),matches=sha(b/'source'/r['path'])==r['sha256']) for r in m['records']]
bundle=b/'source/apps/ruukoto/src/linux-command-probe.mjs'
checks={'records':comparison,'bundleSha256':sha(bundle),'bundleMatches':sha(bundle)==m['bundleSha256']}
write(b/'remote-source-comparison.json',checks)
assert all(r['matches'] for r in comparison) and checks['bundleMatches']
six=b/'evidence-six-scenarios';names=['normal','no-receipt-crash','receipt-before-observation','stop-unverified','cancel-full','restricted']
results=[]
for name in names:
    result=read(six/name/('result.json' if name in ['normal','cancel-full','restricted'] else 'restore-result.json'))
    op=result['command'];assert op['stopped'] and op['prepared']['spec']['mode']==('confirm' if name=='restricted' else 'full_access')
    assert result['settled']['state']['outcome']['status']==('aborted' if name=='cancel-full' else 'completed')
    assert result['nativeTask']['owner']==result['work']['taskId']
    results.append({'name':name,'result':result})
# The original summary path was wrong for the two new scenarios; preserve that failure and regenerate only from their already completed assertions/results.
write(six/'summary-recovered.json',{'passed':names,'scenarios':results,'originalSummaryFailure':'run-six-scenarios-summary-failure.log','summaryOnlyFix':True})
assert read(six/'normal/old-refusal.json')['rejected']['code']=='command_record_invalid'
final=b/'evidence-final-section';result=read(final/'normal/result.json')
request=read(final/'normal/permission-request.json');assert '当前工作命令权限：完全访问。' in request['system']
assert result['command']['prepared']['spec']['mode']=='full_access'
cleanupGroups=[];temps=[];scopes=[]
for group in sorted(b.glob('evidence*')):
    p=group/'cleanup.json'
    if not p.exists():continue
    cleanup=read(p);assert cleanup['fixturesRemaining']==[]
    for row in cleanup['cleanup']:
        if row.get('noCommand'):continue
        assert row['stop']['exited'] and not row['tempExists']
        temp=row['tempDir'];temps.append(temp)
        state=subprocess.run(['systemctl','--user','show',row['scope'],'--property=LoadState,ActiveState,ControlGroup,InvocationID'],capture_output=True,text=True)
        assert 'LoadState=not-found' in state.stdout and 'ControlGroup=\n' in state.stdout
        scopes.append({'scope':row['scope'],'state':state.stdout.strip(),'group':group.name})
    cleanupGroups.append(group.name)
matches=[]
for p in Path('/proc').iterdir():
    if not p.name.isdigit() or int(p.name) in [os.getpid(),os.getppid()]:continue
    try:
        if p.stat().st_uid!=os.getuid():continue
        args=p.joinpath('cmdline').read_bytes().split(bytes([0]));executable=Path(os.fsdecode(args[0])).name
        if executable not in ['node','bash','bwrap','systemd-run','sleep']:continue
        command=b' '.join(args).decode(errors='replace')
        try:cwd=os.readlink(p/'cwd')
        except OSError:cwd=''
        if str(b) in command or cwd.startswith(str(b)) or any(t in command or cwd.startswith(t) for t in temps):matches.append({'pid':int(p.name),'command':command,'cwd':cwd})
    except (OSError,ValueError):continue
processes={'remainingMatchingProcesses':matches,'remainingTemps':[t for t in sorted(set(temps)) if Path(t).exists()],'fixturesRemaining':list((b/'fixtures').iterdir()),'allScopesNotFound':True,'scopes':scopes,'cleanupGroups':cleanupGroups}
write(b/'process-cleanup.json',processes)
assert not matches and not processes['remainingTemps'] and not processes['fixturesRemaining']
records=[]
for group in sorted(b.glob('evidence*')):
    for p in sorted(group.rglob('*')):
        if p.is_file():records.append({'path':str(p.relative_to(b)),'bytes':p.stat().st_size,'sha256':sha(p)})
write(b/'artifact-manifest.json',{'records':records})
print(json.dumps({'sourceFiles':len(comparison),'uniqueScenarios':len(results),'evidenceFiles':len(records),'remainingProcesses':len(matches),'scopesRechecked':len(scopes),'allScopesNotFound':True}))
