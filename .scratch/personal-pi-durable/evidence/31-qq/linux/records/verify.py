import pathlib,json,hashlib,sys
base=pathlib.Path(__file__).resolve().parent;repo=base/'repo';errors=[]
manifest=json.loads((base/'source-manifest.json').read_text())
for rec in manifest['records']:
 p=repo/rec['path']
 if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=rec['sha256']:errors.append(rec['path'])
deps=json.loads((base/'runtime-dependencies.json').read_text())
for rec in deps:
 p=repo/rec['path']/'package.json'
 if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=rec['packageJsonSha256']:errors.append(rec['path'])
result={'sourceFiles':len(manifest['records']),'dependencyPackages':len(deps),'errors':errors};(base/'source-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));sys.exit(bool(errors))
