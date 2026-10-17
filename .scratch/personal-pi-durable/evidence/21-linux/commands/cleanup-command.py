import datetime,json,os,pathlib,shutil
run=pathlib.Path('/tmp/rk-linux-verify.CohhCfz7')
deps=pathlib.Path('/dev/shm/rk-linux-deps.H6A9ny4b')
assert run.parent==pathlib.Path('/tmp') and run.name.startswith('rk-linux-verify.') and not run.is_symlink()
assert deps.parent==pathlib.Path('/dev/shm') and deps.name.startswith('rk-linux-deps.') and not deps.is_symlink()
baseline=[]
for line in (run/'logs/processes-before.txt').read_text().splitlines():
    pid,ppid,comm=line.strip().split(maxsplit=2)
    baseline.append({'pid':int(pid),'ppid':int(ppid),'comm':comm})
baseline_ids={row['pid'] for row in baseline}
roots=[os.fsencode(str(run)),os.fsencode(str(deps))]
steps=[json.loads(line) for line in (run/'steps.jsonl').read_text().splitlines()]
started_alive=[row['pid'] for row in steps if pathlib.Path('/proc',str(row['pid'])).exists()]
assert not started_alive,started_alive
self_pid=os.getpid()
ancestors={self_pid}
current=self_pid
while current>1:
    try:
        current=int(pathlib.Path('/proc',str(current),'stat').read_text().rsplit(')',1)[1].split()[1])
    except (FileNotFoundError,ProcessLookupError): break
    if current in ancestors: break
    ancestors.add(current)
def scan():
    matches=[]
    unknown_unreadable=[]
    zombies=[]
    observed={}
    for proc in pathlib.Path('/proc').iterdir():
        if not proc.name.isdecimal(): continue
        pid=int(proc.name)
        try:
            tail=(proc/'stat').read_text().rsplit(')',1)[1].split()
            item={'pid':pid,'ppid':int(tail[1]),'comm':(proc/'comm').read_text().strip()}
            observed[pid]=item
            if tail[0]=='Z' and pid not in baseline_ids: zombies.append(item)
            if pid in ancestors or proc.stat().st_uid!=os.getuid(): continue
            fields=[]
            for name in ['cmdline','environ']:
                try:
                    value=(proc/name).read_bytes()
                    if any(root in value for root in roots): fields.append(name)
                except (PermissionError,FileNotFoundError,ProcessLookupError):
                    if pid not in baseline_ids: unknown_unreadable.append({**item,'field':name})
            for name in ['cwd','exe']:
                try:
                    value=os.fsencode(os.readlink(proc/name))
                    if any(value==root or value.startswith(root+b'/') for root in roots): fields.append(name)
                except (PermissionError,FileNotFoundError,ProcessLookupError):
                    if pid not in baseline_ids: unknown_unreadable.append({**item,'field':name})
            if fields: matches.append({**item,'matched_fields':fields})
        except (PermissionError,FileNotFoundError,ProcessLookupError): pass
    return {'matches':matches,'new_zombies':zombies,'unknown_same_uid_unreadable':unknown_unreadable,'observed':observed}
before=scan()
assert not before['matches'],before['matches']
assert not before['new_zombies'],before['new_zombies']
assert not before['unknown_same_uid_unreadable'],before['unknown_same_uid_unreadable']
shutil.rmtree(deps)
shutil.rmtree(run)
after=scan()
stable=[row for row in baseline if row['comm'] in ['MainThread','esbuild']]
comparison=[{'before':row,'after':after['observed'].get(row['pid']),'unchanged':after['observed'].get(row['pid'])==row} for row in stable]
result={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'run_dir':str(run),'deps_dir':str(deps),'remaining_roots':{'run_dir':run.exists(),'deps_dir':deps.exists()},'started_step_pids_alive':started_alive,'own_path_matches_before':before['matches'],'own_path_matches_after':after['matches'],'new_zombies':after['new_zombies'],'unknown_same_uid_unreadable':after['unknown_same_uid_unreadable'],'existing_mainthread_esbuild_comparison':comparison,'signals_sent':[],'process_probe':'仅比较本次路径；不输出或保存 cmdline/environ 字节；排除本次探针祖先与已存在但不可读的进程'}
print(json.dumps(result,ensure_ascii=False,indent=2))
assert not run.exists() and not deps.exists()
assert not after['matches'] and not after['new_zombies'] and not after['unknown_same_uid_unreadable']
assert all(row['unchanged'] for row in comparison)
