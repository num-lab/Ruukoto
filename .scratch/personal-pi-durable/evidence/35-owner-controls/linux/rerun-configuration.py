from pathlib import Path
import hashlib,json,os,re,shlex,shutil,subprocess,tempfile,time
base=Path('/dev/shm/rk35-linux.yBeoMXF5');repo=base/'repo';logs=base/'logs'
summary=json.loads((logs/'summary.json').read_text());(logs/'initial-summary.json').write_text(json.dumps(summary,indent=2,ensure_ascii=False)+'\n');(logs/'configuration-controls.log').rename(logs/'configuration-controls-protected-tmpdir.log')
tmp=Path(tempfile.mkdtemp(prefix='rk35-linux-tmp.',dir='/tmp'));env=os.environ.copy();env['RUN_MODEL_CHECK']='0';env['TMPDIR']=str(tmp)
args=['node','--import','tsx','--test','--test-reporter=tap','test/personal-configuration-controls.test.ts'];started=time.monotonic()
with (logs/'configuration-controls.log').open('w') as out:
 out.write('$ TMPDIR='+str(tmp)+' '+shlex.join(args)+'\n');out.flush()
 try:code=subprocess.run(args,cwd=repo,env=env,stdout=out,stderr=subprocess.STDOUT,timeout=180).returncode
 except subprocess.TimeoutExpired:code=124;out.write('Timed out after 180 seconds\n')
content=(logs/'configuration-controls.log').read_text();counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$',content,re.M)}
item={'name':'configuration-controls','command':shlex.join(args),'exit_code':code,'seconds':round(time.monotonic()-started,3),'tmpdir':str(tmp),'counts':counts};print(json.dumps(item),flush=True)
shutil.rmtree(tmp);summary['environment_correction']={'initial_config_failure':'verifier set TMPDIR under protected /dev/shm; tools path validation correctly rejects /dev','rerun':'configuration group only, isolated /tmp TMPDIR','temporary_directory_removed':not tmp.exists(),'initial_evidence':'initial-summary.json and configuration-controls-protected-tmpdir.log'}
summary['commands'][0]=item
existing=Path('/home/eitrous/ruukoto');items=[]
for root,dirs,files in os.walk(existing):
 for name in sorted(dirs+files):
  p=Path(root)/name;st=p.lstat();items.append([str(p.relative_to(existing)),st.st_size,st.st_mtime_ns,os.readlink(p) if p.is_symlink() else None])
items.sort();after={'root':str(existing),'entries':len(items),'metadata_sha256':hashlib.sha256(json.dumps(items,separators=(',',':')).encode()).hexdigest()};before=json.loads((base/'existing-before.json').read_text());summary['existing_checkout_changed']=before!=after
(logs/'existing-tree-proof.json').write_text(json.dumps({'before':before,'after':after,'unchanged':before==after},indent=2)+'\n')
summary['totals']={k:sum(c['counts'].get(k,0) for c in summary['commands']) for k in ['tests','pass','fail','cancelled','skipped','todo']}
(logs/'summary.json').write_text(json.dumps(summary,indent=2,ensure_ascii=False)+'\n')
raise SystemExit(code)
