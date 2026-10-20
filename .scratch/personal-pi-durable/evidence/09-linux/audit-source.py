import hashlib,json,os,pathlib,stat,sys
root=pathlib.Path(sys.argv[1]); manifest=json.loads(pathlib.Path(sys.argv[2]).read_text()); content_failures=[]; mode_changes=[]; executable_failures=[]
for name,record in manifest.items():
    path=root/name
    if record['kind']=='symlink':
        actual={'kind':'symlink','target':os.readlink(path)} if path.is_symlink() else {'kind':'missing_or_not_symlink'}
    elif path.is_file() and not path.is_symlink():
        actual={'kind':'file','sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'mode':stat.S_IMODE(path.stat().st_mode)}
    else:
        actual={'kind':'missing_or_not_file'}
    if {k:v for k,v in actual.items() if k!='mode'} != {k:v for k,v in record.items() if k!='mode'}: content_failures.append({'path':name,'expected':record,'actual':actual})
    if 'mode' in record and 'mode' in actual and record['mode'] != actual['mode']:
        item={'path':name,'expected_octal':oct(record['mode']),'actual_octal':oct(actual['mode'])}; mode_changes.append(item)
        if record['mode']&0o111 != actual['mode']&0o111: executable_failures.append(item)
result={'checked_files':len(manifest),'content_unchanged':not content_failures,'executable_bits_unchanged':not executable_failures,'content_failures':content_failures,'executable_failures':executable_failures,'mode_changes':mode_changes}
print(json.dumps(result,ensure_ascii=False,indent=2))
sys.exit(bool(content_failures or executable_failures))
