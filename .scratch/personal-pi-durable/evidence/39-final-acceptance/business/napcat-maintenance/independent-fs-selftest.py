from pathlib import Path
import ast,contextlib,copy,errno,hashlib,importlib.util,io,json,os,shutil,stat,tempfile,unittest
from unittest.mock import patch
SOURCE=Path('/Users/eitrous/Developer/Temp/napcat-v4.18.38-candidate/napcat-maintenance.py')
EXPECTED='6fea248c51a103f1eea13cf72c29cadde6e53be9d0488d391acbe0290ff0fbd5'
raw=SOURCE.read_bytes();assert hashlib.sha256(raw).hexdigest()==EXPECTED
os.umask(0o077)
spec=importlib.util.spec_from_file_location('napcat_review_only',SOURCE);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
# 所有动作只落完全合成目录；维护入口、真实路径解析与ps边界不执行。
root=Path(tempfile.mkdtemp(prefix='ruukoto39-napcat-fs-',dir='/private/tmp'));root.chmod(0o700)
def directory(name):
 p=root/name;p.mkdir(mode=0o700);return p
def put(p,text):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text);p.chmod(0o600)
def snap(p):return {str(x.relative_to(p)):('link',os.readlink(x)) if x.is_symlink() else ('dir',stat.S_IMODE(x.stat().st_mode)) if x.is_dir() else ('file',hashlib.sha256(x.read_bytes()).hexdigest()) for x in p.rglob('*')}
result={'source':str(SOURCE),'sourceSha256':EXPECTED,'syntheticRoot':str(root),'realPathCalls':0,'qqProcessQueries':0,'realUpgradeOrRollback':False,'tests':[]}
module_ast=ast.parse(raw);upgrade=next(n for n in module_ast.body if isinstance(n,ast.FunctionDef) and n.name=='upgrade');loop=next(n for n in ast.walk(upgrade) if isinstance(n,ast.For) and isinstance(n.target,ast.Name) and n.target.id=='rel');copy_code=compile(ast.fix_missing_locations(ast.Module(body=[copy.deepcopy(loop)],type_ignores=[])),str(SOURCE)+':actual-copy-loop','exec')
def runloop(ready,staged,files):exec(copy_code,{**m.__dict__,'ready':ready,'staged':staged,'files':files})
class Tests(unittest.TestCase):
 def test_stage_all_nonkeep_posthash(self):
  b=directory('posthash');ready=b/'ready';staged=b/'stage';ready.mkdir();staged.mkdir();put(ready/'native.node','expected-native');files={'native.node':m.digest(ready/'native.node')};runloop(ready,staged,files);self.assertEqual(m.digest(staged/'native.node'),files['native.node']);result['tests'].append('actual copy loop accepts exact nonKEEP file')
 def test_stage_directory_collision_refused(self):
  b=directory('collision');ready=b/'ready';staged=b/'stage';ready.mkdir();staged.mkdir();put(ready/'offset.json','official-offset');(staged/'offset.json').mkdir();files={'offset.json':m.digest(ready/'offset.json')}
  with self.assertRaises(RuntimeError):runloop(ready,staged,files)
  self.assertTrue((staged/'offset.json').is_dir());result['tests'].append('directory copy2 collision rejected by exact post-copy file guard')
 def test_stage_hash_drift_refused(self):
  b=directory('hash-drift');ready=b/'ready';staged=b/'stage';ready.mkdir();staged.mkdir();put(ready/'offset.json','official-offset');files={'offset.json':m.digest(ready/'offset.json')};put(ready/'offset.json','changed-after-candidate-check')
  with self.assertRaises(RuntimeError):runloop(ready,staged,files)
  result['tests'].append('nonKEEP drift rejected by actual post-copy hash')
 def test_swap_stage_rename_failure_restores_original(self):
  b=directory('rename-failure');program=b/'program';staged=b/'staged';backup=b/'backup';program.mkdir();staged.mkdir();backup.mkdir();put(program/'napcat.mjs','old');put(program/'config/account.json','current');put(staged/'napcat.mjs','new');before=snap(program);orig=os.replace
  def fail(src,dst):
   if Path(src)==staged and Path(dst)==program:raise OSError(errno.EIO,'synthetic stage rename failure')
   return orig(src,dst)
  with patch.object(m,'qq_stopped',lambda:None),patch.object(m.os,'replace',fail):
   with self.assertRaises(OSError) as e:m.swap_program(program,staged,{'phase':'backed_up'},backup)
   self.assertEqual(e.exception.errno,errno.EIO)
  self.assertEqual(snap(program),before);self.assertTrue(staged.is_dir());result['tests'].append('stage→program rename failure restores complete original')
 def test_swap_metadata_failure_preserves_both_and_restores_original(self):
  b=directory('metadata-failure');program=b/'program';staged=b/'staged';backup=b/'backup';program.mkdir();staged.mkdir();backup.mkdir();put(program/'napcat.mjs','old');put(program/'config/account.json','current');put(staged/'napcat.mjs','new');before=snap(program)
  with patch.object(m,'qq_stopped',lambda:None),patch.object(m,'write_record',side_effect=OSError(errno.EIO,'synthetic metadata failure')):
   with self.assertRaises(OSError):m.swap_program(program,staged,{'phase':'backed_up'},backup)
  self.assertEqual(snap(program),before);incomplete=list(b.glob('.napcat-incomplete-*'));self.assertEqual(len(incomplete),1);self.assertEqual((incomplete[0]/'napcat.mjs').read_text(),'new');self.assertEqual(stat.S_IMODE(incomplete[0].stat().st_mode),0o700);result['tests'].append('metadata failure restores original and preserves incomplete new bytes privately')
 def test_rollback_preserves_current_keep_and_external_data(self):
  b=directory('rollback');program=b/'program';backup=b/'backup';workdir=b/'workdir';program.mkdir();backup.mkdir();workdir.mkdir();old=backup/'program';old.mkdir();loader=b/'loader.js';put(loader,'synthetic-loader');put(backup/'loadNapCat.js','synthetic-loader');put(old/'napcat.mjs','old-program');put(old/'package.json','{"version":"4.18.30"}');put(old/'native.node','old-native');put(program/'napcat.mjs','new-program');put(program/'native.node','new-native');put(workdir/'config/account.json','current-external-data')
  for name in m.KEEP:put(old/name/'state.json','old-'+name)
  put(program/'config/account.json','new-current-config');put(program/'cache','current-cache-file');put(program/'logs/today.log','current-log');(program/'plugins').symlink_to('config',target_is_directory=True)
  # 当前data不存在：不能把备份旧data复活。
  manifest=backup/'program-manifest.json';manifest.write_text(json.dumps(m.inventory(old))+'\n');record={'operation':'upgrade','phase':'committed','program':str(program),'workdir':str(workdir),'programManifestSha256':m.digest(manifest)};(backup/'maintenance.json').write_text(json.dumps(record)+'\n');keep=m.state_inventory(program);external=m.inventory(workdir);frozen_backup=m.inventory(old)
  with patch.object(m,'qq_stopped',lambda:None),patch.object(m,'live_paths',lambda:(program,loader)),patch.object(m,'OLD_BUNDLE_SHA',m.digest(old/'napcat.mjs')),patch.object(m,'NEW_BUNDLE_SHA',m.digest(program/'napcat.mjs')),patch.object(m,'LOADER_SHA',m.digest(loader)),contextlib.redirect_stdout(io.StringIO()):m.rollback(str(backup))
  self.assertEqual((program/'napcat.mjs').read_text(),'old-program');self.assertEqual((program/'native.node').read_text(),'old-native');self.assertEqual(m.state_inventory(program),keep);self.assertEqual(m.inventory(workdir),external);self.assertEqual(m.inventory(old),frozen_backup);self.assertFalse((program/'data').exists());self.assertEqual(read_record:=m.read_json(backup/'maintenance.json')['operation'],'rollback');result['tests'].append('rollback restores program while preserving current KEEP dirs/files/link/absence and external data')
try:
 suite=unittest.defaultTestLoader.loadTestsFromTestCase(Tests);run=unittest.TextTestRunner(verbosity=2).run(suite);result.update(testsRun=run.testsRun,failures=len(run.failures),errors=len(run.errors),passed=run.wasSuccessful(),sourceStillSame=hashlib.sha256(SOURCE.read_bytes()).hexdigest()==EXPECTED);assert result['sourceStillSame'];Path('/tmp/ruukoto39-napcat-final-audit/fs-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 if not run.wasSuccessful():raise SystemExit(1)
finally:shutil.rmtree(root)
