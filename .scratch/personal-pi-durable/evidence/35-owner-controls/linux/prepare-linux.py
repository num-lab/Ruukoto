from pathlib import Path
import hashlib,json,os,shutil,tarfile
base=Path('/dev/shm/rk35-linux.yBeoMXF5');repo=base/'repo';repo.mkdir()
with tarfile.open(base/'runtime.tar.gz','r:gz') as tar:tar.extractall(repo,filter='fully_trusted')
links=json.loads((base/'dependency-reuse.json').read_text())['reuse']
for relative,target in links:
 p=repo/relative;p.parent.mkdir(parents=True,exist_ok=True);p.symlink_to(target,target_is_directory=True)
existing=Path('/home/eitrous/ruukoto');items=[]
for root,dirs,files in os.walk(existing):
 for name in sorted(dirs+files):
  p=Path(root)/name;st=p.lstat();items.append([str(p.relative_to(existing)),st.st_size,st.st_mtime_ns,os.readlink(p) if p.is_symlink() else None])
items.sort();result={'root':str(existing),'entries':len(items),'metadata_sha256':hashlib.sha256(json.dumps(items,separators=(',',':')).encode()).hexdigest()}
(base/'existing-before.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'source_extracted':str(repo),'reused_packages':len(links),'existing_before':result}))
