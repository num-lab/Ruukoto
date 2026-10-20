set -eu
r38_dir=/tmp/r38-linux-JgNUHm
python3 - "$r38_dir" <<'PY'
from pathlib import Path
import json,sys
work=Path(sys.argv[1]);source=work/'source';target=source/'node_modules';history=Path('/tmp/ruukoto-agent-wait-20261014-root/node_modules')
actions=[]
def link(name,dependency):
 if '/' in name:
  scope=target/name.split('/')[0]
  if scope.is_symlink():
   old=scope.resolve();scope.unlink();scope.mkdir()
   for child in old.iterdir():(scope/child.name).symlink_to(child,target_is_directory=child.is_dir())
  elif not scope.exists():scope.mkdir()
 out=target/name
 if out.is_symlink():out.unlink()
 out.symlink_to(dependency,target_is_directory=True)
 manifest=json.loads((dependency/'package.json').read_text());actions.append({'name':name,'version':manifest['version'],'path':str(dependency.resolve())})
link('@earendil-works/pi-durable',work/'sdk/node_modules/@earendil-works/pi-durable')
for manifest in (source/'packages').glob('*/package.json'):
 for name,version in json.loads(manifest.read_text()).get('dependencies',{}).items():
  if version=='*' or (target/name/'package.json').exists():continue
  candidate=history/name
  if (candidate/'package.json').exists():link(name,candidate)
  else:actions.append({'name':name,'expected':version,'missing':True})
(work/'logs/dependency-overlay.json').write_text(json.dumps(actions,indent=2)+'\n')
PY
cd "$r38_dir/source"
set +e
TMPDIR="$r38_dir/tmp" node --import tsx --test --test-concurrency=1 test/personal-entry.test.ts test/personal-cli.test.ts > "$r38_dir/logs/personal-tests-layout-fixed.txt" 2>&1
r38_test_status=$?
printf '%s\n' "$r38_test_status" > "$r38_dir/logs/personal-tests-layout-fixed.exit"
sha256sum -c "$r38_dir/source-sha256.txt" > "$r38_dir/logs/source-verify-after-layout.txt" 2>&1
printf '%s\n' "$?" > "$r38_dir/logs/source-verify-after-layout.exit"
printf 'personal-tests=%s\n' "$r38_test_status"
