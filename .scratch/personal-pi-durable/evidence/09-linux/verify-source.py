import hashlib,json,os,pathlib,stat,sys
root=pathlib.Path(sys.argv[1]); manifest=json.loads(pathlib.Path(sys.argv[2]).read_text()); failures=[]
for name,record in manifest.items():
    path=root/name
    if record['kind']=='symlink':
        actual={'kind':'symlink','target':os.readlink(path)} if path.is_symlink() else {'kind':'missing_or_not_symlink'}
    elif path.is_file() and not path.is_symlink():
        actual={'kind':'file','sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'mode':stat.S_IMODE(path.stat().st_mode)}
    else:
        actual={'kind':'missing_or_not_file'}
    if actual != record: failures.append({'path':name,'expected':record,'actual':actual})
print(json.dumps({'checked_files':len(manifest),'unchanged':not failures,'failures':failures},ensure_ascii=False,indent=2))
sys.exit(bool(failures))
