from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
import time

root = Path('/tmp/ruukoto-07-linux.V1tB4o')
files = subprocess.check_output(['git', 'ls-files', 'packages', 'apps', 'test', 'scripts'], cwd=root, text=True).splitlines()
files += ['test/121-workflow-personal-acceptance.test.ts', 'test/122-workflow-code-acceptance.test.ts']
manifest = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in sorted(set(files)) if (root / name).is_file()}
(root / 'linux-final-source-hashes.json').write_text(json.dumps(manifest, indent=2) + '\n')
entries = []
for label in ['node22', 'node24']:
    node = Path('/tmp/ruukoto-script-isolation.v2XPXY') / label / 'node_modules/node/bin/node'
    env = os.environ.copy()
    env['PATH'] = str(node.parent) + ':' + env.get('PATH', '')
    env['RUN_MODEL_CHECK'] = '0'
    commands = [
        (['npm', 'run', 'build'], 'build-' + label + '-final.log'),
        ([str(node), '--import', 'tsx', '--test', '--test-concurrency=1', 'test/104-workflow-script.test.ts', 'test/112-workflow-real-steps.test.ts', 'test/113-workflow-source-capabilities.test.ts', 'test/121-workflow-personal-acceptance.test.ts', 'test/122-workflow-code-acceptance.test.ts'], 'matrix-' + label + '-final.log'),
        ([str(node), '--import', 'tsx', '--test', '--test-name-pattern=查询进程先 exit 后关闭 stdout', 'test/28-main-data.test.ts'], 'query-regression-' + label + '-final.log'),
        ([str(node), '--import', 'tsx', 'verification/smoke/smoke-26-native-worker.mts'], 'smoke26-' + label + '-final.log'),
    ]
    for command, log in commands:
        started = time.time()
        print(json.dumps({'state': 'running', 'command': command, 'log': log}), flush=True)
        with (root / log).open('w') as output:
            result = subprocess.run(command, cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT)
        entry = {'node': subprocess.check_output([str(node), '--version'], text=True).strip(), 'command': command, 'log': log, 'exit': result.returncode, 'seconds': round(time.time() - started, 3)}
        entries.append(entry)
        (root / 'linux-final-commands.json').write_text(json.dumps(entries, indent=2) + '\n')
        print(json.dumps(entry), flush=True)
        if result.returncode:
            (root / 'linux-final-completion.json').write_text(json.dumps({'exit': result.returncode, 'failedLog': log}) + '\n')
            sys.exit(result.returncode)
after = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in manifest}
assert manifest == after, 'sources changed while matrix was running'
(root / 'linux-final-worker-hashes.json').write_text(json.dumps({name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in ['worker/worker.mjs', 'worker/workflow-script.mjs', 'worker/workflow-script.wasm']}, indent=2) + '\n')
(root / 'linux-final-completion.json').write_text(json.dumps({'exit': 0, 'sourceHashesStable': True}) + '\n')
