from pathlib import Path
import json,os,platform,shlex,subprocess,time
base=Path('/dev/shm/rk34-linux.mngs687u'); repo=base/'repo'; logs=base/'logs'; env=os.environ.copy(); env['RUN_MODEL_CHECK']='0'; env['TMPDIR']=str(base/'tmp')
commands=[('app-data',['node','--import','tsx','--test','test/personal-app-data.test.ts']),('qq-app-data',['node','--import','tsx','--test','--test-name-pattern=应用数据批准','test/personal-qq.test.ts']),('cli-app-data-linux-http',['node','--import','tsx','--test','--test-name-pattern=本机应用数据|服务核实 HTTP：Linux sudo','test/personal-cli.test.ts'])]
metadata={'platform':platform.platform(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'npm':subprocess.check_output(['npm','--version'],text=True).strip(),'repository':str(repo),'network_install':False,'system_sudo':False,'existing_checkout_changed':False,'commands':[]}
for name,args in commands:
    started=time.monotonic()
    with (logs/(name+'.log')).open('w') as out:
        out.write('$ '+shlex.join(args)+'\n');out.flush()
        try:result=subprocess.run(args,cwd=repo,env=env,stdout=out,stderr=subprocess.STDOUT,timeout=180);code=result.returncode
        except subprocess.TimeoutExpired:code=124;out.write('Timed out after 180 seconds\n')
    item={'name':name,'command':shlex.join(args),'exit_code':code,'seconds':round(time.monotonic()-started,3)};metadata['commands'].append(item);print(json.dumps(item),flush=True)
    (logs/'summary.json').write_text(json.dumps(metadata,indent=2,ensure_ascii=False)+'\n')
raise SystemExit(any(v['exit_code'] for v in metadata['commands']))
