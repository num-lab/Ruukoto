import hashlib,json,os,pathlib,stat,subprocess
logs=pathlib.Path('/tmp/rk-18-linux-20261017T074832Z');source=pathlib.Path('/dev/shm/rk-18-linux-20261017T074832Z')
items=[]
for raw in pathlib.Path('/proc').iterdir():
 if not raw.name.isdigit():continue
 try:
  if raw.stat().st_uid!=os.getuid():continue
  text=(raw/'stat').read_text();end=text.rfind(')');fields=text[end+2:].split();state=fields[0]
  cmd=(raw/'cmdline').read_bytes().replace(b'\x00',b' ').decode(errors='replace').strip()
  try:cwd=os.readlink(raw/'cwd')
  except OSError:cwd=None
  items.append({'pid':int(raw.name),'ppid':int(fields[1]),'pgid':int(fields[2]),'sid':int(fields[3]),'state':state,'cwd':cwd,'cmdline':cmd})
 except (FileNotFoundError,ProcessLookupError):continue
with (logs/'processes-final.txt').open('w') as out:subprocess.run(['ps','-u',os.environ['USER'],'-o','pid=,ppid=,pgid=,sid=,stat=,args='],stdout=out)
(logs/'processes-final.json').write_text(json.dumps(items,indent=2)+'\n')
owned=[p for p in items if p['state']!='Z' and ((p['cwd'] or '').startswith(str(source)) or 'node_modules/tsx' in p['cmdline'] and str(source) in p['cmdline'])]
existing=[p for p in items if p['pid'] in {2163755,2163766,2178158,2178169}]
content=[];modes=[]
manifest=(logs/'source-manifest-v2.jsonl').read_bytes()
for raw in manifest.splitlines():
 item=json.loads(raw);p=source/item['path'];data=os.readlink(p).encode() if p.is_symlink() else p.read_bytes()
 if hashlib.sha256(data).hexdigest()!=item['sha256']:content.append(item['path'])
 if item['kind']=='file' and stat.S_IMODE(p.stat().st_mode)!=item['mode']:modes.append({'path':item['path'],'before':oct(item['mode']),'after':oct(stat.S_IMODE(p.stat().st_mode))})
report={'source_manifest_sha256':hashlib.sha256(manifest).hexdigest(),'content_mismatches':content,'mode_changes':modes,'live_processes_in_source':owned,'existing_backends_still_present':existing}
(logs/'final-audit.json').write_text(json.dumps(report,indent=2)+'\n')
with (logs/'storage-final.txt').open('w') as out:subprocess.run(['df','-h','/dev/shm','/tmp'],stdout=out)
print(json.dumps(report,indent=2))
