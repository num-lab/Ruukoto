import datetime,json,os,pathlib,subprocess,time
run=pathlib.Path('/tmp/rk-linux-verify.CohhCfz7')
repo=pathlib.Path('/dev/shm/rk-linux-deps.H6A9ny4b/repo')
env=dict(os.environ)
env.update({'ELECTRON_SKIP_BINARY_DOWNLOAD':'1','RUN_MODEL_CHECK':'0','npm_config_cache':'/dev/shm/rk-linux-deps.H6A9ny4b/npm-cache','TMPDIR':str(run/'tmp')})
command=['npm','run','build']
step={'name':'build','command':command,'start':datetime.datetime.now(datetime.timezone.utc).isoformat()}
start=time.monotonic()
with (run/'logs/build.log').open('wb') as output:
    child=subprocess.Popen(command,cwd=repo,env=env,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
    step['pid']=child.pid
    step['exit_code']=child.wait()
step.update({'end':datetime.datetime.now(datetime.timezone.utc).isoformat(),'seconds':round(time.monotonic()-start,3)})
with (run/'steps.jsonl').open('a') as output: output.write(json.dumps(step)+'\n')
print(json.dumps(step),flush=True)
with (run/'logs/space-after-build.txt').open('wb') as output: subprocess.run(['df','-h','/tmp','/dev/shm'],stdout=output,check=True)
print((run/'logs/build.log').read_text()[-7000:])
print((run/'logs/space-after-build.txt').read_text())
raise SystemExit(step['exit_code'])
