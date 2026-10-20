import pathlib,json,subprocess,hashlib,tarfile,stat,sys
root=pathlib.Path.cwd(); logs=pathlib.Path('/tmp/rk19-linux-evidence'); config=json.loads((logs/'paths.json').read_text()); suffix=sys.argv[1]
previous=logs/('source-manifest.jsonl' if suffix=='v2' else 'source-manifest-v'+str(int(suffix[1:])-1)+'.jsonl'); entries=[json.loads(x) for x in previous.read_text().splitlines()]; changed=[]
for item in entries:
 f=root/item['path']; data=f.readlink().as_posix().encode() if f.is_symlink() else f.read_bytes(); h=hashlib.sha256(data).hexdigest()
 if h!=item['sha256']:
  changed.append(item['path']);item['sha256']=h;item['bytes']=len(data);item['mode']=stat.S_IMODE(f.lstat().st_mode)
archive=logs/f'incremental-{suffix}.tar.gz'
with tarfile.open(archive,'w:gz',dereference=False) as a:
 for name in changed:a.add(root/name,arcname=name,recursive=False)
manifest=''.join(json.dumps(e,ensure_ascii=False)+'\n' for e in entries).encode();(logs/f'source-manifest-{suffix}.jsonl').write_bytes(manifest);(logs/f'source-manifest-{suffix}.sha256').write_text(hashlib.sha256(manifest).hexdigest()+'\n');(logs/f'source-differences-{suffix}.json').write_text(json.dumps(changed,indent=2)+'\n')
subprocess.run(['scp',str(archive),str(logs/f'source-manifest-{suffix}.jsonl'),str(logs/f'source-manifest-{suffix}.sha256'),str(logs/f'source-differences-{suffix}.json'),'tx:'+config['remote_logs']+'/'],check=True)
print(json.dumps({'changed':changed,'manifest_sha256':hashlib.sha256(manifest).hexdigest(),**config}))
