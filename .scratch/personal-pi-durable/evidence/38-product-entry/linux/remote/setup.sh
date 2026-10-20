set -eu
r38_dir=/tmp/r38-linux-JgNUHm
mkdir -p "$r38_dir/source" "$r38_dir/logs" "$r38_dir/sdk" "$r38_dir/tmp" "$r38_dir/npm-cache"
node --version > "$r38_dir/logs/node-version.txt"
id > "$r38_dir/logs/account.txt"
df -k /tmp > "$r38_dir/logs/disk-before.txt"
sha256sum "$r38_dir/source.tar.gz" > "$r38_dir/logs/archive-sha256.txt"
tar -xzf "$r38_dir/source.tar.gz" -C "$r38_dir/source"
cd "$r38_dir/source"
sha256sum -c "$r38_dir/source-sha256.txt" > "$r38_dir/logs/source-verify.txt"
python3 - "$r38_dir" <<'PY'
from pathlib import Path
import json,sys
work=Path(sys.argv[1]); source=work/'source'; old=Path('/opt/ruukoto/node_modules'); target=source/'node_modules';target.mkdir()
workspaces={}
for parent in [source/'packages',source/'apps']:
 for directory in parent.iterdir():
  manifest=directory/'package.json'
  if manifest.exists(): workspaces[json.loads(manifest.read_text())['name']]=directory
for entry in old.iterdir():
 if entry.name=='@ruukoto': continue
 (target/entry.name).symlink_to(workspaces.get(entry.name,entry),target_is_directory=entry.is_dir())
(target/'@ruukoto').mkdir()
for name,directory in workspaces.items():
 if name.startswith('@ruukoto/'):(target/name).symlink_to(directory,target_is_directory=True)
manifest={'name':'ruukoto38-personal-sdk-verification','version':'0.0.0','private':True,'type':'module','dependencies':{'@earendil-works/chord':'1.3.0','@earendil-works/pi-ai':'1.3.0','@earendil-works/pi-durable':'1.3.0','typebox':'1.0.12'}}
(work/'sdk/package.json').write_text(json.dumps(manifest,indent=2)+'\n')
PY
set +e
npm --prefix "$r38_dir/sdk" --cache "$r38_dir/npm-cache" view @earendil-works/chord@1.3.0 @earendil-works/pi-ai@1.3.0 @earendil-works/pi-durable@1.3.0 typebox@1.0.12 dist.unpackedSize --json > "$r38_dir/logs/package-size-estimate.txt" 2>&1
r38_size_status=$?
printf '%s\n' "$r38_size_status" > "$r38_dir/logs/package-size-estimate.exit"
npm --prefix "$r38_dir/sdk" --cache "$r38_dir/npm-cache" install --ignore-scripts --no-audit --no-fund > "$r38_dir/logs/sdk-install.txt" 2>&1
r38_install_status=$?
printf '%s\n' "$r38_install_status" > "$r38_dir/logs/sdk-install.exit"
df -k /tmp > "$r38_dir/logs/disk-after-install.txt"
du -sk "$r38_dir/source" "$r38_dir/sdk" "$r38_dir/npm-cache" > "$r38_dir/logs/install-space.txt"
exit "$r38_install_status"
