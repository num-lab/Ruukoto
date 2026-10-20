set -eu
r38_dir=/tmp/r38-linux-JgNUHm
cd "$r38_dir/source"
ln -s "$r38_dir/sdk/node_modules" apps/ruukoto/node_modules
node --input-type=module - "$r38_dir" > "$r38_dir/logs/dependency-versions.txt" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const work=process.argv[2];
for(const [base,names] of [[path.join(work,'source'),['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','tsx','esbuild']],[path.join(work,'source/apps/ruukoto'),['@earendil-works/pi-ai','@earendil-works/pi-durable','@earendil-works/chord','typebox']]]){
 for(const name of names){
  const r=spawnSync(process.execPath,['--input-type=module','--eval',`import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';const name=${JSON.stringify(name)},module=import.meta.resolve(name);let directory=path.dirname(fileURLToPath(module));while(true){const p=path.join(directory,'package.json');if(fs.existsSync(p)){const manifest=JSON.parse(fs.readFileSync(p,'utf8'));if(manifest.name===name){process.stdout.write(JSON.stringify({cwd:process.cwd(),module,manifest:p,version:manifest.version}));break;}}const parent=path.dirname(directory);if(parent===directory)throw Error('manifest not found');directory=parent;}`],{cwd:base,encoding:'utf8'});
  process.stdout.write(JSON.stringify({name,status:r.status,...(r.status===0?JSON.parse(r.stdout):{error:r.stderr.trim()})})+'\n');
  if(r.status!==0)process.exitCode=1;
 }
}
JS
set +e
npm run build:worker > "$r38_dir/logs/build-worker.txt" 2>&1
r38_build_status=$?
printf '%s\n' "$r38_build_status" > "$r38_dir/logs/build-worker.exit"
if test "$r38_build_status" -eq 0; then
 TMPDIR="$r38_dir/tmp" node --import tsx --test --test-concurrency=1 test/personal-entry.test.ts test/personal-command-worker.test.ts test/personal-cli.test.ts test/service-helper-transport.test.ts > "$r38_dir/logs/targeted-tests.txt" 2>&1
 r38_test_status=$?
 printf '%s\n' "$r38_test_status" > "$r38_dir/logs/targeted-tests.exit"
fi
python3 - "$r38_dir" "$(id -un)" "$(id -gn)" "$(id -u)" "$(node -p 'process.execPath')" <<'PY'
from pathlib import Path
import sys
work=Path(sys.argv[1]);text=(work/'source/deploy/systemd/ruukoto-backend.service').read_text()
for key,value in zip(['RUN_USER','RUN_GROUP','RUN_UID','NODE_BIN'],sys.argv[2:]):text=text.replace('@'+key+'@',value)
(work/'ruukoto-backend.service').write_text(text)
PY
systemd-analyze verify "$r38_dir/ruukoto-backend.service" > "$r38_dir/logs/template-verify.txt" 2>&1
r38_template_status=$?
printf '%s\n' "$r38_template_status" > "$r38_dir/logs/template-verify.exit"
sha256sum -c "$r38_dir/source-sha256.txt" > "$r38_dir/logs/source-verify-after.txt" 2>&1
printf '%s\n' "$?" > "$r38_dir/logs/source-verify-after.exit"
sha256sum worker/worker.mjs worker/personal-command-worker.mjs "$r38_dir/ruukoto-backend.service" > "$r38_dir/logs/artifact-sha256.txt"
df -k /tmp > "$r38_dir/logs/disk-after-checks.txt"
du -sk "$r38_dir" > "$r38_dir/logs/final-space.txt"
printf 'build=%s tests=%s template=%s\n' "$r38_build_status" "${r38_test_status:-not-run}" "$r38_template_status"
exit 0
