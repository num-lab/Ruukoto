umask 077
run_dir=/tmp/rk-linux-verify.CohhCfz7
deps_dir=/dev/shm/rk-linux-deps.H6A9ny4b
ps -eo pid=,ppid=,comm= > "$run_dir/logs/processes-before.txt"
sha256sum "$run_dir/source.tar.gz" > "$run_dir/logs/source-archive.sha256"
tar -xzf "$run_dir/source.tar.gz" -C "$deps_dir/repo"
cd "$deps_dir/repo" || exit 1
git init --quiet
python3 - <<'CHECK'
import hashlib,json,pathlib,os
root=pathlib.Path.cwd()
manifest=json.loads(pathlib.Path('/tmp/rk-linux-verify.CohhCfz7/source-manifest.json').read_text())
errors=[]
for name,expected in manifest.items():
    path=root/name
    actual={'symlink':os.readlink(path)} if path.is_symlink() else {'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    if actual != expected:
        errors.append(name)
pathlib.Path('/tmp/rk-linux-verify.CohhCfz7/logs/source-verification.json').write_text(json.dumps({'files':len(manifest),'mismatches':errors},indent=2)+'\n')
if errors:
    raise SystemExit(1)
CHECK
verified=$?
if [ "$verified" -ne 0 ]; then exit "$verified"; fi
date -u +%Y-%m-%dT%H:%M:%SZ > "$run_dir/logs/setup-start.txt"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_cache="$deps_dir/npm-cache" TMPDIR="$run_dir/tmp" npm run setup -- --skip-hooks > "$run_dir/logs/setup.log" 2>&1
result=$?
date -u +%Y-%m-%dT%H:%M:%SZ > "$run_dir/logs/setup-end.txt"
printf '%s\n' "$result" > "$run_dir/logs/setup-exit-code.txt"
df -h /tmp /dev/shm > "$run_dir/logs/space-after-setup.txt"
tail -n 30 "$run_dir/logs/setup.log"
cat "$run_dir/logs/space-after-setup.txt"
exit "$result"
