import json,os,pathlib,time
run=pathlib.Path('/tmp/rk-linux-verify.CohhCfz7')
deps=pathlib.Path('/dev/shm/rk-linux-deps.H6A9ny4b')
roots=[os.fsencode(str(run)),os.fsencode(str(deps))]
self_pid=os.getpid()
processes=[]
matches=[]
unreadable=[]
for proc in pathlib.Path('/proc').iterdir():
    if not proc.name.isdecimal(): continue
    pid=int(proc.name)
    try:
        stat=(proc/'stat').read_text()
        tail=stat.rsplit(')',1)[1].split()
        item={'pid':pid,'ppid':int(tail[1]),'comm':(proc/'comm').read_text().strip()}
        processes.append(item)
        if pid==self_pid or proc.stat().st_uid!=os.getuid(): continue
        fields=[]
        for name in ['cmdline','environ']:
            try:
                value=(proc/name).read_bytes()
                if any(root in value for root in roots): fields.append(name)
            except (PermissionError,ProcessLookupError,FileNotFoundError):
                unreadable.append({'pid':pid,'field':name})
        for name in ['cwd','exe']:
            try:
                value=os.fsencode(os.readlink(proc/name))
                if any(value==root or value.startswith(root+b'/') for root in roots): fields.append(name)
            except (PermissionError,ProcessLookupError,FileNotFoundError):
                unreadable.append({'pid':pid,'field':name})
        if fields: matches.append({**item,'matched_fields':fields})
    except (PermissionError,ProcessLookupError,FileNotFoundError):
        pass
baseline=[]
for line in (run/'logs/processes-before.txt').read_text().splitlines():
    pid,ppid,comm=line.strip().split(maxsplit=2)
    baseline.append({'pid':int(pid),'ppid':int(ppid),'comm':comm})
by_pid={row['pid']:row for row in processes}
stable=[row for row in baseline if row['comm'] in ['MainThread','esbuild']]
comparison=[{'before':row,'after':by_pid.get(row['pid']),'unchanged':by_pid.get(row['pid'])==row} for row in stable]
result={'own_path_matches':matches,'unreadable_same_uid_fields':unreadable,'existing_mainthread_esbuild_comparison':comparison,'process_count':len(processes),'excluded_probe_pid':self_pid}
(run/'logs/processes-before-cleanup.json').write_text(json.dumps(processes,indent=2)+'\n')
(run/'logs/cleanup-preflight.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
if matches: raise SystemExit(1)
