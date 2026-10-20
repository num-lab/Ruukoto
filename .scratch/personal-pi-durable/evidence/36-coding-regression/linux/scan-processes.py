import os,pathlib,json,time,sys
base=pathlib.Path('/dev/shm/rk-coding36-linux.gaWtu6'); name=sys.argv[1]; assert name in ('baseline','current')
prefixes=(str(base/name),str(base/(name+'-tmp'))); matches=[]; errors=[]
for p in pathlib.Path('/proc').iterdir():
    if not p.name.isdigit() or int(p.name)==os.getpid(): continue
    try:
        uid=p.stat().st_uid
        args=[a.decode(errors='replace') for a in (p/'cmdline').read_bytes().split(b'\0') if a]
        try: cwd=os.readlink(p/'cwd')
        except FileNotFoundError: cwd=''
        if any(cwd.startswith(prefix) or any(a.startswith(prefix) for a in args) for prefix in prefixes): matches.append({'pid':int(p.name),'uid':uid,'cwd':cwd,'args':args})
    except (FileNotFoundError,ProcessLookupError): pass
    except PermissionError as e:
        if uid==1003: errors.append(str(e))
print(json.dumps({'time':time.time(),'reader_uid':os.getuid(),'prefixes':prefixes,'matches':matches,'inaccessible_target_uid_processes':errors},indent=2),flush=True)
sys.exit(bool(matches or errors))
