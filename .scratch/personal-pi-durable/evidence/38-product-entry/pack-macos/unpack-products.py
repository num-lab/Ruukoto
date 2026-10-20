from pathlib import Path, PurePosixPath
import json, tarfile, hashlib, shutil, datetime
work=Path('/tmp/ruukoto38-pack-20261018-1').resolve()
evidence=Path('/tmp/ruukoto38-pack-evidence-20261018-1')
records=[]
for name in ['ruukoto','ruukoto-code']:
    archive=work/'dist'/f'{name}-0.1.0.tgz'
    assert archive.is_file(),archive
    shutil.copy2(archive,evidence/archive.name)
    stage=evidence/f'unpack-{name}'
    if stage.exists():shutil.rmtree(stage)
    stage.mkdir()
    with tarfile.open(archive,'r:gz') as tf:
        listing=[]
        for member in tf.getmembers():
            path=PurePosixPath(member.name)
            assert path.parts[0]=='package' and '..' not in path.parts and not path.is_absolute() and (member.isfile() or member.isdir()),member.name
            data=tf.extractfile(member).read() if member.isfile() else b''
            listing.append({'path':member.name,'bytes':member.size,'mode':oct(member.mode),'sha256':hashlib.sha256(data).hexdigest() if member.isfile() else None})
        if name=='ruukoto':
            removed=['package/src/product.ts','package/src/scheduler-tools.ts','package/src/service-tools.ts','package/src/personal-import.ts']
            assert not any(x['path'] in removed for x in listing)
        else:
            assert any(x['path']=='package/src/product.ts' for x in listing),'Coding product stays'
        tf.extractall(stage,filter='data')
    (evidence/f'{name}-tar-manifest.json').write_text(json.dumps(listing,ensure_ascii=False,indent=2)+'\n')
    target=work/'apps'/name
    installedModules=(target/'node_modules').resolve() if (target/'node_modules').exists() else None
    for directory in ['src','bin']:
        shutil.rmtree(target/directory)
        shutil.copytree(stage/'package'/directory,target/directory,copy_function=shutil.copy2)
    shutil.copy2(stage/'package/package.json',target/'package.json')
    assert installedModules==((target/'node_modules').resolve() if (target/'node_modules').exists() else None)
    for item in listing:
        if item['sha256'] is not None:
            rel=Path(item['path']).relative_to('package')
            p=target/rel
            assert hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256'],str(p)
    records.append({'product':name,'archive':str(archive),'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'fileCount':len(listing),'unpackedReplaced':['src','bin','package.json'],'keptInstalledNodeModules':str(installedModules) if installedModules else None,'unpackedFilesMatchArchive':True})
assert not (work/'packages/channels/src/personal-import.ts').exists()
source=json.loads((evidence/'source-manifest.json').read_text())
mismatch=[]
for item in source:
    p=work/item['path']
    if item.get('deleted'):
        if p.exists():mismatch.append(item['path'])
    elif 'symlink' in item:
        if not p.is_symlink() or str(p.readlink())!=item['symlink']:mismatch.append(item['path'])
    elif hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']:
        mismatch.append(item['path'])
assert not mismatch,mismatch
artifacts=[]
for p in sorted((work/'worker').rglob('*')):
    if p.is_file():artifacts.append({'path':str(p.relative_to(work)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size})
for p in sorted((work/'dist').glob('*.tgz')):
    artifacts.append({'path':str(p.relative_to(work)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size})
(evidence/'artifact-manifest-before-tests.json').write_text(json.dumps(artifacts,indent=2)+'\n')
results={'timeUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'returncode':0,'completeWorkspaceRequired':True,'personalTarContainsRemovedEntryFamilies':False,'channelsPersonalImportAbsent':True,'allSourceEntriesStillMatchSnapshot':True,'products':records,'independentNodeModulesRoot':str((work/'node_modules').resolve()),'workspaceAgentLink':str((work/'node_modules/@ruukoto/agent').resolve()),'personalBinLink':str((work/'node_modules/.bin/ruukoto').resolve())}
assert (work/'node_modules').resolve().is_relative_to(work)
assert (work/'node_modules/@ruukoto/agent').resolve().is_relative_to(work)
(evidence/'unpack-verification.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(results,ensure_ascii=False,indent=2))
