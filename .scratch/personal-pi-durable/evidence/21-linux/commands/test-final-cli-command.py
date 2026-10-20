import datetime,json,os,pathlib,signal,subprocess,time
run=pathlib.Path('/tmp/rk-linux-verify.CohhCfz7')
repo=pathlib.Path('/dev/shm/rk-linux-deps.H6A9ny4b/repo')
env=dict(os.environ)
env.update({'ELECTRON_SKIP_BINARY_DOWNLOAD':'1','RUN_MODEL_CHECK':'0','npm_config_cache':'/dev/shm/rk-linux-deps.H6A9ny4b/npm-cache','TMPDIR':str(run/'tmp')})
commands=json.loads((run/'test-commands-final-cli.json').read_text())
failed=False
for step in commands:
    step['start']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    start=time.monotonic()
    print(json.dumps({'starting':step['name'],'command':step['command']}),flush=True)
    with (run/'logs'/f"{step['name']}.log").open('wb') as output:
        child=subprocess.Popen(step['command'],cwd=repo,env=env,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
        step['pid']=child.pid
        try:
            step['exit_code']=child.wait(timeout=360)
        except subprocess.TimeoutExpired:
            step['timed_out']=True
            os.killpg(child.pid,signal.SIGTERM)
            try:
                step['exit_code']=child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid,signal.SIGKILL)
                step['exit_code']=child.wait()
    step.update({'end':datetime.datetime.now(datetime.timezone.utc).isoformat(),'seconds':round(time.monotonic()-start,3)})
    with (run/'steps.jsonl').open('a') as output: output.write(json.dumps(step)+'\n')
    print(json.dumps(step),flush=True)
    print((run/'logs'/f"{step['name']}.log").read_text()[-4500:],flush=True)
    failed=failed or step['exit_code']!=0
raise SystemExit(1 if failed else 0)
