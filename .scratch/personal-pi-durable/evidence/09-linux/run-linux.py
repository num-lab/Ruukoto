import datetime,json,os,pathlib,platform,pty,subprocess,sys,time
outer=pathlib.Path(sys.argv[1]); cache=pathlib.Path(sys.argv[2]); root=outer/'src'; logs=outer/'logs'; logs.mkdir(exist_ok=True); (outer/'tmp').mkdir(exist_ok=True)
env=os.environ.copy(); env.update({'TMPDIR':str(outer/'tmp'),'npm_config_cache':str(cache/'npm-cache'),'RUN_MODEL_CHECK':'0'})
def capture(cmd):
    result=subprocess.run(cmd,cwd=root,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    return {'command':cmd,'exit':result.returncode,'output':result.stdout}
def environment():
    result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':platform.node(),'platform':platform.platform(),'uid':os.getuid(),'environment':{key:env[key] for key in ['TMPDIR','npm_config_cache','RUN_MODEL_CHECK']}}
    for key,command in [('node',['node','--version']),('npm',['npm','--version']),('python',['python3','--version']),('disk',['df','-h','/','/dev/shm']),('memory',['free','-h'])]: result[key]=capture(command)
    master,slave=pty.openpty(); os.close(master); os.close(slave); result['python_pty_probe']='passed'
    return result
def verify(filename, manifest):
    data=capture(['python3',str(outer/'verify-source.py'),str(root),str(outer/manifest)])
    (logs/filename).write_text(data['output']); return data['exit']
status={'scope':'09 initial Linux snapshot; final workspace matching requires later freeze comparison','source_before_exit':verify('source-before.json','source-manifest.json'),'runtime_before_exit':verify('runtime-before.json','runtime-manifest.json')}
(logs/'environment-before.json').write_text(json.dumps(environment(),ensure_ascii=False,indent=2)+'\n')
commands=[('setup',['npm','run','setup','--','--skip-hooks']),('tests',['npx','tsx','--test','test/personal-durable.test.ts','test/personal-cli.test.ts','test/personal-services.test.ts','test/personal-work.test.ts','test/personal-service-operations.test.ts','test/personal-telegram.test.ts','test/personal-telegram-permissions.test.ts']),('build',['npm','run','build'])]
(logs/'commands.json').write_text(json.dumps({'cwd':str(root),'environment':{key:env[key] for key in ['TMPDIR','npm_config_cache','RUN_MODEL_CHECK']},'commands':commands},indent=2)+'\n')
try:
    if status['source_before_exit'] or status['runtime_before_exit']: raise RuntimeError('snapshot input mismatch')
    for name,command in commands:
        started=time.monotonic()
        with (logs/(name+'.log')).open('w') as output:
            result=subprocess.run(command,cwd=root,env=env,stdout=output,stderr=subprocess.STDOUT)
        status[name]={'exit':result.returncode,'seconds':round(time.monotonic()-started,3)}
        (logs/'status.json').write_text(json.dumps(status,indent=2)+'\n')
        print(json.dumps({name:status[name]}),flush=True)
        if result.returncode: break
finally:
    status['source_after_exit']=verify('source-after.json','source-manifest.json')
    status['runtime_after_exit']=verify('runtime-after.json','runtime-manifest.json')
    (logs/'environment-after.json').write_text(json.dumps(environment(),ensure_ascii=False,indent=2)+'\n')
    (logs/'status.json').write_text(json.dumps(status,indent=2)+'\n')
print(json.dumps(status),flush=True)
sys.exit(0 if all(value.get('exit',0)==0 if isinstance(value,dict) else value==0 for key,value in status.items() if key!='scope') and all(name in status for name,_ in commands) else 1)
