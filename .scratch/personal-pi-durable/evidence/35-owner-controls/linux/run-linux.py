from pathlib import Path
import hashlib,json,os,platform,re,shlex,subprocess,time
base=Path('/dev/shm/rk35-linux.yBeoMXF5'); repo=base/'repo'; logs=base/'logs'; logs.mkdir(); (base/'tmp').mkdir()
manifest=json.loads((base/'source-manifest.json').read_text())
checked={p:hashlib.sha256((repo/p).read_bytes()).hexdigest() for p in manifest}
if checked!=manifest:raise SystemExit('copied source hash mismatch')
(logs/'source-manifest.json').write_text(json.dumps(checked,indent=2)+'\n')
deps=['node_modules/tsx/package.json','node_modules/esbuild/package.json','node_modules/@earendil-works/pi-durable/package.json','node_modules/@earendil-works/pi-durable/node_modules/@earendil-works/chord/package.json','apps/ruukoto/node_modules/@earendil-works/chord/package.json','apps/ruukoto/node_modules/@earendil-works/pi-ai/package.json']
depmeta={}
for p in deps:
 data=json.loads((repo/p).read_text());depmeta[p]={'name':data['name'],'version':data['version'],'sha256':hashlib.sha256((repo/p).read_bytes()).hexdigest()}
(logs/'dependency-metadata.json').write_text(json.dumps(depmeta,indent=2)+'\n')
commands=[('configuration-controls',None,'test/personal-configuration-controls.test.ts'),('cli-owner-linux','本机权限|本机长期授权|分组向导|服务核实 HTTP：Linux sudo','test/personal-cli.test.ts'),('owner-navigation','拥有者导航','test/personal-qq.test.ts'),('local-standing-grants','长期授权：本机','test/personal-telegram-permissions.test.ts'),('command-menus','命令菜单|命令停止菜单','test/personal-command-work.test.ts')]
metadata={'platform':platform.platform(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'npm':subprocess.check_output(['npm','--version'],text=True).strip(),'repository':str(repo),'network_install':False,'system_sudo':False,'existing_checkout_changed':False,'source_manifest_verified':True,'source_files':len(manifest),'real_im':False,'real_model':False,'commands':[]}
env=os.environ.copy();env['RUN_MODEL_CHECK']='0';env['TMPDIR']=str(base/'tmp')
for name,pattern,file in commands:
 args=['node','--import','tsx','--test','--test-reporter=tap']
 if pattern:args.append('--test-name-pattern='+pattern)
 args.append(file);started=time.monotonic()
 with (logs/(name+'.log')).open('w') as out:
  out.write('$ '+shlex.join(args)+'\n');out.flush()
  try:code=subprocess.run(args,cwd=repo,env=env,stdout=out,stderr=subprocess.STDOUT,timeout=180).returncode
  except subprocess.TimeoutExpired:code=124;out.write('Timed out after 180 seconds\n')
 content=(logs/(name+'.log')).read_text();counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$',content,re.M)}
 item={'name':name,'command':shlex.join(args),'exit_code':code,'seconds':round(time.monotonic()-started,3),'counts':counts};metadata['commands'].append(item);print(json.dumps(item),flush=True)
 (logs/'summary.json').write_text(json.dumps(metadata,indent=2,ensure_ascii=False)+'\n')
 if 'ERR_MODULE_NOT_FOUND' in content:break
existing=Path('/home/eitrous/ruukoto');items=[]
for root,dirs,files in os.walk(existing):
 for name in sorted(dirs+files):
  p=Path(root)/name;st=p.lstat();items.append([str(p.relative_to(existing)),st.st_size,st.st_mtime_ns,os.readlink(p) if p.is_symlink() else None])
items.sort();after={'root':str(existing),'entries':len(items),'metadata_sha256':hashlib.sha256(json.dumps(items,separators=(',',':')).encode()).hexdigest()}
before=json.loads((base/'existing-before.json').read_text());metadata['existing_checkout_changed']=before!=after
(logs/'existing-tree-proof.json').write_text(json.dumps({'before':before,'after':after,'unchanged':before==after},indent=2)+'\n')
metadata['totals']={k:sum(c['counts'].get(k,0) for c in metadata['commands']) for k in ['tests','pass','fail','cancelled','skipped','todo']}
(logs/'summary.json').write_text(json.dumps(metadata,indent=2,ensure_ascii=False)+'\n')
raise SystemExit(any(c['exit_code'] for c in metadata['commands']))
