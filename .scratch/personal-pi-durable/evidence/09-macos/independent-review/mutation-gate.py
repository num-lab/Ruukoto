from pathlib import Path
import tempfile, shutil, subprocess, os
repo = Path(os.environ['RUUKOTO_REVIEW_REPO'])
root = Path(tempfile.mkdtemp(prefix='rk-service-mutation-', dir='/tmp'))
try:
    (root / 'apps/ruukoto').mkdir(parents=True)
    shutil.copytree(repo / 'apps/ruukoto/src', root / 'apps/ruukoto/src')
    (root / 'test/helpers').mkdir(parents=True)
    shutil.copy2(repo / 'test/personal-cli.test.ts', root / 'test/personal-cli.test.ts')
    shutil.copy2(repo / 'test/helpers/mock-provider.ts', root / 'test/helpers/mock-provider.ts')
    os.symlink(repo / 'node_modules', root / 'node_modules')
    os.symlink(repo / 'apps/ruukoto/node_modules', root / 'apps/ruukoto/node_modules')
    (root / 'package.json').write_text('{"type":"module"}\n')
    harness = root / 'apps/ruukoto/src/personal-harness.ts'
    source = harness.read_text()
    gate = next(line for line in source.splitlines(keepends=True) if '((service && !savedService)' in line)
    anchor = '    if (operations) await harness.commit(tx => verifyServiceGrants(tx, operationKeys), context);\n'
    assert anchor in source
    harness.write_text(source.replace(gate, '').replace(anchor, anchor + gate))
    result = subprocess.run(['node', '--import', 'tsx', '--test', '--test-name-pattern=未决输入阻止固化文件和授权', str(root / 'test/personal-cli.test.ts')], cwd=repo, text=True, capture_output=True, timeout=20)
    assert result.returncode != 0, '移回旧顺序后回归用例不红'
    print('Mutation: move initial gate after verifyServiceGrants -> expected test failure, exit', result.returncode)
    print(result.stdout)
    print(result.stderr)
finally:
    shutil.rmtree(root)
