from pathlib import Path
import tempfile,shutil,subprocess,json,hashlib,datetime,os
root=Path.cwd(); out=Path(tempfile.mkdtemp(prefix='ruukoto-notes-independent-',dir='/tmp'))
inputs=list((root/'apps/ruukoto/src').glob('*.ts'))+[root/'test'/f for f in ['personal-work-notes.test.ts','personal-work-controls.test.ts','personal-service-operations.test.ts']]
manifest={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
(out/'source-before.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
for name in ['ruukoto-notes-review-probe.mjs','ruukoto-notes-review-probe.log','ruukoto-old-server-note-probe.mjs','ruukoto-old-server-note-probe.log','ruukoto-notes-review-tests.log']:
 shutil.copy2(Path('/tmp')/name,out/name)
shutil.copy2('/tmp/rk-old-note-control/old-control.mts',out/'old-control.mts')
script=out/'ruukoto-old-server-note-probe.mjs';script.write_text(script.read_text().replace('/tmp/rk-old-note-control/old-control.mts',str(out/'old-control.mts')))
(out/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
app=out/'snapshot/apps/ruukoto';app.mkdir(parents=True)
shutil.copytree(root/'apps/ruukoto/src',app/'src');shutil.copy2(root/'apps/ruukoto/package.json',app/'package.json')
(app/'node_modules').symlink_to(root/'apps/ruukoto/node_modules',target_is_directory=True)
shutil.copy2(root/'package.json',out/'snapshot/package.json')
(out/'snapshot/node_modules').symlink_to(root/'node_modules',target_is_directory=True)
(out/'snapshot/test').mkdir()
shutil.copy2(root/'test/personal-work-notes.test.ts',out/'snapshot/test/personal-work-notes.test.ts')
shutil.copytree(root/'test/helpers',out/'snapshot/test/helpers')
p=app/'src/personal-work.ts';old=p.read_text();needle='if (settled?.status === "done" && (work.notes?.length ?? 0) > index + 1)';assert old.count(needle)==1
new=old.replace(needle,'if (false)');p.write_text(new)
patch=subprocess.run(['diff','-u',str(root/'apps/ruukoto/src/personal-work.ts'),str(p)],capture_output=True,text=True);(out/'ignore-new-notes.diff').write_text(patch.stdout)
cmd=['node','--import','tsx','--test','--test-name-pattern=原回答 done 至 abort','test/personal-work-notes.test.ts']
r=subprocess.run(cmd,cwd=out/'snapshot',stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=30)
(out/'ignore-new-notes-test.log').write_text(r.stdout)
after={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
(out/'source-after.json').write_text(json.dumps(after,ensure_ascii=False,indent=2)+'\n')
summary={'base':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'positive_tests':{'command':'npx tsx --test test/personal-work-notes.test.ts test/personal-work-controls.test.ts test/personal-service-operations.test.ts','pass':72,'fail':0,'skipped':0,'log':'ruukoto-notes-review-tests.log'},'negative_test':{'command':cmd,'cwd':'snapshot','exit_code':r.returncode,'log':'ignore-new-notes-test.log','mutation':'ignore-new-notes.diff'},'workspace_inputs_unchanged':manifest==after,'output':str(out)}
(out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
shutil.copy2('/tmp/ruukoto-notes-independent-review.py',out/'review.py')
print(json.dumps(summary,ensure_ascii=False,indent=2))
assert r.returncode!=0,'Removing final transaction note check unexpectedly passed'
assert 'before-stop' in r.stdout and 'after-stop' in r.stdout
assert manifest==after,'Root changed runtime/test inputs during the experiment'
