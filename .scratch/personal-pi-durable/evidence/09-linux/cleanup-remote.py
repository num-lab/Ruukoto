import json,os,pathlib,shutil,stat,subprocess
outer=pathlib.Path('/dev/shm/rpd09.6ksdtsk1'); cache=pathlib.Path('/tmp/rpd09-cache.fl05nhfw')
assert outer.parent==pathlib.Path('/dev/shm') and outer.name.startswith('rpd09.')
assert cache.parent==pathlib.Path('/tmp') and cache.name.startswith('rpd09-cache.')
def processes():
    result=[]
    for proc in pathlib.Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name)==os.getpid(): continue
        try:
            command=(proc/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
            cwd=os.readlink(proc/'cwd')
        except (FileNotFoundError,ProcessLookupError,PermissionError):
            # /proc 的其他账户项可能不可读，进程也可能已退出；仅调查本轮唯一目录的进程。
            continue
        if any(str(root) in command or cwd==str(root) or cwd.startswith(str(root)+'/') for root in [outer,cache]): result.append({'pid':int(proc.name),'command':command,'cwd':cwd})
    return result
def sockets():
    return [line for line in pathlib.Path('/proc/net/unix').read_text().splitlines() if any(str(root) in line for root in [outer,cache])]
def socket_files():
    found=[]
    for root in [outer,cache]:
        if not root.exists(): continue
        for directory,dirs,files in os.walk(root):
            for filename in files:
                candidate=pathlib.Path(directory)/filename
                if stat.S_ISSOCK(candidate.lstat().st_mode): found.append(str(candidate))
    return found
result={'remote_source':str(outer/'src'),'remote_outer':str(outer),'remote_cache':str(cache),'matching_processes_before':processes(),'active_socket_paths_before':sockets(),'socket_files_before':socket_files()}
if result['matching_processes_before'] or result['active_socket_paths_before']:
    result['cleanup_complete']=False
    print(json.dumps(result,ensure_ascii=False,indent=2)); raise SystemExit(1)
for root in [outer,cache]: shutil.rmtree(root)
result.update({'source_removed':not outer.exists(),'cache_removed':not cache.exists(),'matching_processes_after':processes(),'active_socket_paths_after':sockets()})
result['cleanup_complete']=result['source_removed'] and result['cache_removed'] and not result['matching_processes_after'] and not result['active_socket_paths_after']
print(json.dumps(result,ensure_ascii=False,indent=2))
raise SystemExit(0 if result['cleanup_complete'] else 1)
