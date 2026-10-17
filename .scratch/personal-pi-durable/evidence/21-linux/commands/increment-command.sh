set -e
run_dir=/tmp/rk-linux-verify.CohhCfz7
repo_dir=/dev/shm/rk-linux-deps.H6A9ny4b/repo
sha256sum "$run_dir/increment.tar.gz" > "$run_dir/logs/increment-archive.sha256"
tar -xzf "$run_dir/increment.tar.gz" -C "$repo_dir"
cd "$repo_dir"
python3 - <<'CHECK'
import hashlib,json,pathlib,os
root=pathlib.Path.cwd()
run=pathlib.Path('/tmp/rk-linux-verify.CohhCfz7')
change=json.loads((run/'increment.json').read_text())
for name in change['removed']:
    path=root/name
    if path.exists() or path.is_symlink(): path.unlink()
manifest=json.loads((run/'tested-manifest.json').read_text())
errors=[]
for name,expected in manifest.items():
    path=root/name
    actual={'symlink':os.readlink(path)} if path.is_symlink() else {'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    if actual!=expected: errors.append(name)
result={'files':len(manifest),'changed':len(change['changed']),'removed':len(change['removed']),'mismatches':errors}
(run/'logs/increment-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
if errors: raise SystemExit(1)
CHECK
