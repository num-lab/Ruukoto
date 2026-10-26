from pathlib import Path
import argparse
import json
import os
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, required=True)
parser.add_argument('--logs', type=Path, required=True)
args = parser.parse_args()
repo = args.repo.resolve()
args.logs.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='rk-personal-claim-audit-') as folder:
    root = Path(folder)
    os.symlink(repo / 'node_modules', root / 'node_modules', target_is_directory=True)
    (root / 'package.json').write_text('{"type":"module"}\n')
    helper = (repo / 'test/helpers/fake-service-helper.mjs').read_text()
    marker = '    fs.writeFileSync(path.join(dir, "claim.json"), JSON.stringify({ inspectionId, machineId, pid: process.pid }));'
    assert marker in helper
    helper = helper.replace(marker, '    sleepMs(200);\n' + marker, 1)
    helper_file = root / 'fake-service-helper.mjs'
    helper_file.write_text(helper)
    source = (repo / 'test/personal-services.test.ts').read_text()
    source = source.replace('"../apps/', '"' + str(repo) + '/apps/')
    source = source.replace('"./helpers/mock-provider.ts"', '"' + str(repo) + '/test/helpers/mock-provider.ts"')
    source = source.replace('"./helpers/fake-service-helper.mjs"', json.dumps(helper_file.as_uri()))
    test_file = root / 'claim-race.test.ts'
    test_file.write_text(source)
    command = [str(repo / 'node_modules/.bin/tsx'), '--test', '--test-name-pattern=工具取消仍保存停止证据', str(test_file)]
    with (args.logs / 'personal-claim-race-baseline.log').open('w') as log:
        red = subprocess.run(command, cwd=repo, stdout=log, stderr=subprocess.STDOUT)
    original = 'await p.submit("检查", "cancel-tool"); await until(() => f.calls().some(call => call[0] === "inspect-op"));'
    fixed = 'await p.submit("检查", "cancel-tool"); await until(() => f.calls().some(call => call[0] === "inspect-op" && fs.existsSync(path.join(f.helper, "inspections", call[1], "claim.json"))));'
    assert original in source
    test_file.write_text(source.replace(original, fixed))
    with (args.logs / 'personal-claim-race-readiness.log').open('w') as log:
        green = subprocess.run(command, cwd=repo, stdout=log, stderr=subprocess.STDOUT)
    report = {'repo': str(repo), 'injectedWindow': '200ms between inspection directory creation and claim write', 'baselineExit': red.returncode, 'readinessExit': green.returncode}
    (args.logs / 'personal-claim-race-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    assert red.returncode != 0 and green.returncode == 0
