import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); manifest=json.loads(pathlib.Path(sys.argv[2]).read_text()); failures=[]
for name, record in manifest.items():
    path=root/name
    if record["kind"]=="symlink":
        actual={"kind":"symlink","target":str(path.readlink())} if path.is_symlink() else {"kind":"missing_or_not_symlink"}
    else:
        actual={"kind":"file","sha256":hashlib.sha256(path.read_bytes()).hexdigest()} if path.is_file() else {"kind":"missing_or_not_file"}
    if actual != record: failures.append({"path":name,"expected":record,"actual":actual})
print(json.dumps({"checked_files":len(manifest),"unchanged":not failures,"failures":failures},ensure_ascii=False,indent=2))
sys.exit(bool(failures))
