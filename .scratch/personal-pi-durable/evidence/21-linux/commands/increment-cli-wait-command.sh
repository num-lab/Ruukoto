cd /dev/shm/rk-linux-deps.H6A9ny4b/repo || exit 1
python3 - <<'CHECK'
import hashlib,json,pathlib,os
root=pathlib.Path.cwd()
run=pathlib.Path('/tmp/rk-linux-verify.CohhCfz7')
manifest=json.loads((run/'tested-manifest.json').read_text())
errors=[]
for name,expected in manifest.items():
    path=root/name
    actual={'symlink':os.readlink(path)} if path.is_symlink() else {'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    if actual!=expected: errors.append(name)
result={'files':len(manifest),'mismatches':errors}
(run/'logs/cli-wait-source-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
if errors: raise SystemExit(1)
CHECK
