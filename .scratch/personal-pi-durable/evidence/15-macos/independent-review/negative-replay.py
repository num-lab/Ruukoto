import pathlib, subprocess, tempfile, shutil
review = pathlib.Path(tempfile.mkdtemp(prefix='rk-helper-review-'))
try:
    source = review / 'apps/ruukoto/src/service-helper.ts'
    source.parent.mkdir(parents=True)
    source.write_bytes(subprocess.check_output(['git','show','HEAD:apps/ruukoto/src/service-helper.ts']))
    tests = review / 'test/service-helper-transport.test.ts'
    tests.parent.mkdir()
    shutil.copyfile('test/service-helper-transport.test.ts', tests)
    run = subprocess.run(['node','--experimental-transform-types','--test',str(tests)], cwd=review, text=True, capture_output=True, timeout=20)
    print('OLD_HEAD_REPLAY_EXIT=' + str(run.returncode))
    print(run.stdout)
    print(run.stderr)
    if run.returncode == 0 or 'ℹ fail 3' not in run.stdout:
        raise SystemExit('未观察到预期三个回归失败')
finally:
    shutil.rmtree(review)
    print('REVIEW_DIRECTORY_REMOVED=' + str(not review.exists()))
