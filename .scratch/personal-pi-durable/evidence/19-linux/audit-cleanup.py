import datetime,hashlib,json,os,pathlib,shutil,stat,subprocess,sys
logs=pathlib.Path(__file__).resolve().parent;config=json.loads((logs/'paths.json').read_text());source=pathlib.Path(config['source']);tmp=pathlib.Path(config['temp_root']);manifest=(logs/'source-manifest-v6.jsonl').read_bytes()
def processes():
 result=[]
 for raw in pathlib.Path('/proc').iterdir():
  if not raw.name.isdigit():continue
  try:
   if raw.stat().st_uid!=os.getuid():continue
   text=(raw/'stat').read_text();fields=text[text.rfind(')')+2:].split();cmd=(raw/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace').strip()
   try:cwd=os.readlink(raw/'cwd')
   except OSError:cwd=None
   result.append({'pid':int(raw.name),'ppid':int(fields[1]),'pgid':int(fields[2]),'sid':int(fields[3]),'state':fields[0],'cwd':cwd,'cmdline':cmd})
  except (FileNotFoundError,ProcessLookupError):continue
 return result
before=json.loads((logs/'processes-before.json').read_text());initial={p['pid']:p for p in before};original=[p for p in before if (p['cwd'] or '').startswith('/opt/ruukoto')]
after=processes();owned=[p for p in after if p['pid']!=os.getpid() and any((p['cwd'] or '').startswith(str(folder)) or str(folder) in p['cmdline'] for folder in [source,tmp])]
content=[];modes=[]
for raw in manifest.splitlines():
 item=json.loads(raw);p=source/item['path'];data=os.readlink(p).encode() if p.is_symlink() else p.read_bytes()
 if hashlib.sha256(data).hexdigest()!=item['sha256']:content.append(item['path'])
 if item['kind']=='file' and stat.S_IMODE(p.stat().st_mode)!=item['mode']:modes.append({'path':item['path'],'before':oct(item['mode']),'after':oct(stat.S_IMODE(p.stat().st_mode))})
proof=[]
for old in original:
 new=next((p for p in after if p['pid']==old['pid']),None);proof.append({'pid':old['pid'],'still_present':new is not None,'cmdline_unchanged':new is not None and new['cmdline']==old['cmdline'],'cwd_unchanged':new is not None and new['cwd']==old['cwd']})
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'manifest_sha256':hashlib.sha256(manifest).hexdigest(),'content_mismatches':content,'mode_changes':modes,'owned_processes':owned,'original_backends':proof,'tmp_entries_before_cleanup':sorted(p.name for p in tmp.iterdir()),'new_processes_since_baseline':[p for p in after if p['pid'] not in initial]}
(logs/'processes-final.json').write_text(json.dumps(after,indent=2)+'\n');(logs/'final-audit.json').write_text(json.dumps(report,indent=2)+'\n')
with (logs/'processes-final.txt').open('w') as out:subprocess.run(['ps','-u',os.environ['USER'],'-o','pid=,ppid=,pgid=,sid=,stat=,args='],stdout=out)
if owned or content or any(not p['still_present'] or not p['cmdline_unchanged'] or not p['cwd_unchanged'] for p in proof):print(json.dumps(report,indent=2));sys.exit(1)
assert source.parent==pathlib.Path('/dev/shm') and source.name.startswith('rk19-linux-')
assert tmp.parent==pathlib.Path('/dev/shm') and tmp.name.startswith('k19t-')
shutil.rmtree(source);shutil.rmtree(tmp)
remaining=processes();left=[p for p in remaining if p['pid']!=os.getpid() and any((p['cwd'] or '').startswith(str(folder)) or str(folder) in p['cmdline'] for folder in [source,tmp])]
cleanup={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_exists':source.exists(),'tmp_exists':tmp.exists(),'owned_processes_after':left,'original_backends_after':[{'pid':old['pid'],'still_present':any(p['pid']==old['pid'] and p['cwd']==old['cwd'] and p['cmdline']==old['cmdline'] for p in remaining)} for old in original]}
(logs/'cleanup.json').write_text(json.dumps(cleanup,indent=2)+'\n')
with (logs/'storage-cleanup.txt').open('w') as out:subprocess.run(['df','-h','/dev/shm','/tmp'],stdout=out)
print(json.dumps({'audit':report,'cleanup':cleanup},indent=2));sys.exit(bool(left))
