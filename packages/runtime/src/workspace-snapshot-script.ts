/** 宿主固定脚本只在工作进程内运行 Git；原始内容不经过仓库过滤器。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-15-current-workspace-snapshots.md
 */
export const WORKSPACE_SNAPSHOT_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { isUtf8 } = require('node:buffer');

const baseEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR']) delete baseEnv[key];
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function git(args, env = baseEnv, input) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { env, input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(\`git failed (\${result.status}): \${result.stderr.toString().trim()}\`);
  return result.stdout;
}
function parsePaths(bytes) {
  if (!isUtf8(bytes)) fail('snapshot_unsupported', '文件名不是 UTF-8，请使用 UTF-8 名字后重新准备目标');
  return bytes.toString('utf8').split('\\0').filter(Boolean);
}
function treeEntries(gitdir, tree) {
  const entries = new Map();
  for (const item of parsePaths(git(['--git-dir', gitdir, 'ls-tree', '-r', '-z', tree]))) {
    const tab = item.indexOf('\\t');
    const [mode, type, oid] = item.slice(0, tab).split(' ');
    if (type !== 'blob') fail('snapshot_unsupported', '目标含嵌套 Git 或子模块，请拆分目标后委派');
    entries.set(item.slice(tab + 1), { mode, oid });
  }
  return entries;
}
function safePath(root, name, absentParents = new Set()) {
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep) || name.split('/').some(part => part === '.git' || part === '..')) fail('snapshot_unsupported', '基线含越界路径，请保留现场并报告拥有者');
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    let st;
    try { st = fs.lstatSync(path.join(root, ...parts.slice(0, i))); }
    catch (error) { if (error.code === 'ENOENT') return resolved; throw error; }
    if (st.isSymbolicLink()) {
      if (absentParents.has(parts.slice(0, i).join('/'))) return null;
      fail('snapshot_changed', '文件的父目录已变化或指向来源外，请重新准备目标');
    }
    if (!st.isDirectory()) return null;
  }
  return resolved;
}
function payloadAt(root, name, absentParents = new Set(), directories = new Map()) {
  const resolved = safePath(root, name, absentParents);
  if (resolved === null) return null;
  let st;
  try { st = fs.lstatSync(resolved); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (st.isDirectory()) {
    let marker;
    try { marker = fs.lstatSync(path.join(resolved, '.git')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (marker) fail('snapshot_unsupported', '目标含嵌套 Git，请拆分目标后委派');
    return null;
  }
  if (!st.isFile() && !st.isSymbolicLink()) fail('snapshot_unsupported', '目标含非普通文件，请拆分目标后委派');
  let actual;
  if (st.isSymbolicLink()) {
    const parent = fs.realpathSync.native(path.dirname(resolved));
    let names = directories.get(parent);
    if (!names) {
      names = { exact: new Set(), folded: new Map() };
      for (const name of fs.readdirSync(parent)) {
        names.exact.add(name);
        const key = name.normalize('NFD').toUpperCase();
        names.folded.set(key, [...(names.folded.get(key) || []), name]);
      }
      directories.set(parent, names);
    }
    const leaf = path.basename(resolved);
    const physical = names.exact.has(leaf) ? leaf : (names.folded.get(leaf.normalize('NFD').toUpperCase()) || []).find(name => {
      const candidate = fs.lstatSync(path.join(parent, name));
      return candidate.dev === st.dev && candidate.ino === st.ino;
    });
    if (!physical) fail('snapshot_changed', '无法核实实际文件名，请保留现场并重新准备目标');
    actual = path.join(parent, physical);
  } else actual = fs.realpathSync.native(resolved);
  const canonicalRoot = fs.realpathSync.native(root), relative = path.relative(canonicalRoot, actual);
  if (!actual.startsWith(canonicalRoot + path.sep) || relative.split('/').some(part => part === '.git' || part === '..')) fail('snapshot_changed', '文件指向来源外，请保留现场并重新准备目标');
  return { name: relative, mode: st.isSymbolicLink() ? '120000' : (st.mode & 0o111) === 0 ? '100644' : '100755',
    bytes: st.isSymbolicLink() ? fs.readlinkSync(actual, { encoding: 'buffer' }) : fs.readFileSync(actual) };
}
function inspectRepository(gitdir) {
  for (const name of ['commondir', 'gitdir', 'objects/info/alternates']) if (fs.existsSync(path.join(gitdir, name))) fail('snapshot_corrupt', '私有基线含外部 Git 指向，请保留副本并报告拥有者');
  const inspectObjects = directory => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('snapshot_corrupt', '基线对象目录含路径别名，请保留副本并报告拥有者');
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) inspectObjects(file);
      else if (!stat.isFile() || stat.nlink !== 1) fail('snapshot_corrupt', '基线对象含文件别名，请保留副本并报告拥有者');
    }
  };
  inspectObjects(path.join(gitdir, 'objects'));
}
function sourceObjectEnv(source) {
  const objects = git(['-C', source, 'rev-parse', '--path-format=absolute', '--git-path', 'objects']).toString().trim();
  // 只读视图不加载来源的 promisor remotes；缺失对象直接失败，旧 Git 也不能下载到来源。
  const env = { ...baseEnv, GIT_OBJECT_DIRECTORY: objects, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' };
  delete env.GIT_CONFIG_PARAMETERS;
  return env;
}
function rawTree(source, gitdir, index, seedTree, sourceIndex) {
  const env = { ...baseEnv, GIT_INDEX_FILE: index };
  // 写对象时不使用来源对象或 alternates，避免刷新来源 loose object 的修改时间。
  git(['--git-dir', gitdir, 'read-tree', '--empty'], env);
  let names;
  const absentParents = new Set();
  if (seedTree) {
    // 副本索引仍是 HEAD；只用捕获树追踪已有文件，新文件按该私有索引枚举。
    git(['--git-dir', gitdir, 'read-tree', seedTree], env);
    names = new Set(parsePaths(sourceFiles(source, gitdir, { env }, ['--others', '--exclude-standard'])));
    for (const name of treeEntries(gitdir, seedTree).keys()) {
      names.add(name);
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i += 1) absentParents.add(parts.slice(0, i).join('/'));
    }
    git(['--git-dir', gitdir, 'read-tree', '--empty'], env);
  } else {
    sourceIndex ||= copySourceIndex(source, gitdir, path.join(path.dirname(index), 'source-index'));
    names = new Set(parsePaths(sourceFiles(source, gitdir, sourceIndex, ['--cached', '--others', '--exclude-standard'])));
    // 后续登记要读取 HEAD 树；只读私有视图先核实其存在，不把旧路径加入当前内容。
    git(['--git-dir', gitdir, 'ls-tree', '-r', '-z', git(['-C', source, 'rev-parse', '--verify', 'HEAD']).toString().trim()], sourceObjectEnv(source));
  }
  const currentFiles = new Map(), directories = new Map();
  for (const name of [...names].sort()) {
    const current = payloadAt(source, name, absentParents, directories);
    if (current) currentFiles.set(current.name, current);
  }
  const records = [];
  for (const name of [...currentFiles.keys()].sort()) {
    const current = currentFiles.get(name);
    const oid = git(['--git-dir', gitdir, 'hash-object', '--no-filters', '-w', '--stdin'], env, current.bytes).toString().trim();
    records.push(Buffer.from(\`\${current.mode} \${oid}\\t\${name}\\0\`));
  }
  git(['--git-dir', gitdir, 'update-index', '-z', '--index-info'], env, Buffer.concat(records));
  return git(['--git-dir', gitdir, 'write-tree'], env).toString().trim();
}
function materialize(tree, gitdir, destination) {
  for (const [name, item] of treeEntries(gitdir, tree)) {
    const target = safePath(destination, name);
    if (target === null) fail('snapshot_changed', '物化目标的父目录已被替换，请保留副本并报告拥有者');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = git(['--git-dir', gitdir, 'cat-file', 'blob', item.oid]);
    if (item.mode === '120000') fs.symlinkSync(bytes, target);
    else {
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: item.mode === '100755' ? 0o755 : 0o644 });
      fs.chmodSync(target, item.mode === '100755' ? 0o755 : 0o644);
    }
  }
}
function checkAffected(source, gitdir, baselineTree, childTree) {
  const baseline = treeEntries(gitdir, baselineTree);
  const final = treeEntries(gitdir, childTree);
  const names = parsePaths(git(['--git-dir', gitdir, 'diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', baselineTree, childTree]));
  let matchesBaseline = true;
  let matchesFinal = true;
  const mismatches = [];
  const directories = new Map();
  for (const name of names) {
    const parts = name.split('/'), absentParents = new Set();
    for (let i = 1; i < parts.length; i += 1) if (final.has(parts.slice(0, i).join('/'))) absentParents.add(parts.slice(0, i).join('/'));
    const payload = payloadAt(source, name, absentParents, directories);
    const current = payload?.name === name ? payload : null;
    const actual = current && { mode: current.mode, oid: createHash('sha1').update(\`blob \${current.bytes.length}\\0\`).update(current.bytes).digest('hex') };
    const same = expected => actual === null ? expected === undefined : expected?.mode === actual.mode && expected.oid === actual.oid;
    const baseMatches = same(baseline.get(name));
    const finalMatches = same(final.get(name));
    matchesBaseline &&= baseMatches;
    matchesFinal &&= finalMatches;
    if (!baseMatches && !finalMatches) mismatches.push(name);
  }
  return { state: matchesBaseline ? 'baseline' : matchesFinal ? 'already' : 'conflict', files: names, mismatches };
}

function readIndexFile(file, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return Buffer.alloc(0); throw error; }
  if (!stat.isFile() || stat.nlink !== 1) fail('snapshot_corrupt', '索引文件含路径别名，请保留现场并报告拥有者');
  return fs.readFileSync(file);
}
function copySourceIndex(source, gitdir, destination) {
  const sourcePath = git(['-C', source, 'rev-parse', '--path-format=absolute', '--git-path', 'index']).toString().trim();
  const head = git(['-C', source, 'rev-parse', '--verify', 'HEAD']).toString().trim();
  if (!/^[0-9a-f]{40}$/.test(head)) fail('snapshot_unsupported', '当前仅支持 SHA-1 Git 目标，请使用受支持仓库后重新准备目标');
  const bytes = readIndexFile(sourcePath, true);
  fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
  // Git 读取 split-index 会刷新 sharedindex；只让它读取宿主复制的索引和共享文件。
  for (const name of fs.readdirSync(path.dirname(sourcePath)).filter(name => /^sharedindex\\.[0-9a-f]{40}$/.test(name))) {
    const file = path.join(gitdir, name), bytes = readIndexFile(path.join(path.dirname(sourcePath), name));
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    else if (!readIndexFile(file).equals(bytes)) fail('snapshot_changed', '共享索引在捕获期间变化，请重新准备目标');
  }
  const env = { ...baseEnv, GIT_INDEX_FILE: bytes.length ? destination : destination + '-missing' };
  const sharedPath = git(['--git-dir', gitdir, '--work-tree', source, 'rev-parse', '--shared-index-path'], env).toString().trim();
  const shared = sharedPath ? path.basename(sharedPath) : null;
  if (shared && (!/^sharedindex\\.[0-9a-f]{40}$/.test(shared) || path.resolve(sharedPath) !== path.join(gitdir, shared))) fail('snapshot_corrupt', '私有索引指向其他目录，请保留现场并报告拥有者');
  return { env, sourcePath, shared };
}
function sourceFiles(source, gitdir, index, args) {
  const excludePath = git(['-C', source, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']).toString().trim();
  const configured = spawnSync('git', ['-C', source, 'config', '--path', '--get', 'core.excludesfile'], { env: baseEnv });
  if (configured.error) throw configured.error;
  if (configured.status !== 0 && configured.status !== 1) throw new Error(configured.stderr.toString().trim());
  const excludes = configured.status === 0 ? configured.stdout.toString().trim() : null;
  const ignorecase = spawnSync('git', ['-C', source, 'config', '--bool', '--get', 'core.ignorecase'], { env: baseEnv });
  if (ignorecase.error) throw ignorecase.error;
  if (ignorecase.status !== 0 && ignorecase.status !== 1) throw new Error(ignorecase.stderr.toString().trim());
  return git(['--git-dir', gitdir, '--work-tree', source, '-c', 'core.untrackedCache=false',
    ...(ignorecase.status === 0 ? ['-c', 'core.ignorecase=' + ignorecase.stdout.toString().trim()] : []),
    ...(excludes === null ? [] : ['-c', 'core.excludesfile=' + (excludes ? path.resolve(source, excludes) : '')]),
    'ls-files', '-z', ...args, ...(args.includes('--exclude-standard') && fs.existsSync(excludePath) ? ['--exclude-from=' + excludePath] : [])], index.env);
}
function indexDigest(files, read) {
  const digest = createHash('sha256');
  for (const name of files) {
    const bytes = read(name);
    digest.update(name + '\\0' + bytes.length + '\\0').update(bytes);
  }
  return digest.digest('hex');
}
function fingerprint(source, index, files, gitdir) {
  const head = git(['-C', source, 'rev-parse', '--verify', 'HEAD']).toString().trim();
  const stat = fs.statSync(source);
  const commonGitPath = fs.realpathSync(git(['-C', source, 'rev-parse', '--path-format=absolute', '--git-common-dir']).toString().trim());
  return { head, commonGitPath, indexDigest: indexDigest(files, name => name === 'ruukoto-source-index' ? readIndexFile(index.sourcePath, true)
    : name === 'ruukoto-source-stages' ? readIndexFile(path.join(gitdir, name)) : readIndexFile(path.join(path.dirname(index.sourcePath), name))), dev: stat.dev, ino: stat.ino };
}
try {
const action = process.argv[1];
const input = JSON.parse(process.argv[2]);
if (process.argv[3]) input.childTree = process.argv[3];
if (action === 'capture') {
  git(['init', '--bare', '--object-format=sha1', '--template=', '-q', input.gitdir]);
  inspectRepository(input.gitdir);
  const sourceIndex = copySourceIndex(input.source, input.gitdir, path.join(input.gitdir, 'ruukoto-source-index'));
  const stages = sourceFiles(input.source, input.gitdir, sourceIndex, ['--stage']);
  if (parsePaths(stages).some(item => item.startsWith('160000 '))) fail('snapshot_unsupported', '目标含子模块，请拆分目标后委派');
  fs.writeFileSync(path.join(input.gitdir, 'ruukoto-source-stages'), stages, { flag: 'wx', mode: 0o600 });
  const files = ['ruukoto-source-index', 'ruukoto-source-stages', ...(sourceIndex.shared ? [sourceIndex.shared] : [])];
  fs.writeFileSync(path.join(input.gitdir, 'ruukoto-index-files'), JSON.stringify(files), { flag: 'wx', mode: 0o600 });
  const before = fingerprint(input.source, sourceIndex, files, input.gitdir);
  if (before.indexDigest !== indexDigest(files, name => readIndexFile(path.join(input.gitdir, name)))) fail('snapshot_changed', '索引在捕获期间变化，请重新准备目标');
  const tree = rawTree(input.source, input.gitdir, input.index, undefined, sourceIndex);
  const afterTree = rawTree(input.source, input.gitdir, input.index, undefined, sourceIndex);
  for (const item of parsePaths(stages)) {
    const oid = item.split(' ')[1];
    const file = path.join(input.gitdir, 'objects', oid.slice(0, 2), oid.slice(2));
    if (!fs.existsSync(file)) {
      const bytes = git(['--git-dir', input.gitdir, 'cat-file', 'blob', oid], sourceObjectEnv(input.source));
      git(['--git-dir', input.gitdir, 'hash-object', '--no-filters', '-w', '--stdin'], baseEnv, bytes);
    }
  }
  const after = fingerprint(input.source, sourceIndex, files, input.gitdir);
  if (tree !== afterTree || JSON.stringify(before) !== JSON.stringify(after)) fail('snapshot_changed', '捕获期间来源已变化，请重新准备目标');
  fs.writeFileSync(path.join(input.gitdir, 'ruukoto-baseline'), JSON.stringify({ ...before, tree }) + '\\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write('RUUKOTO_SNAPSHOT=' + JSON.stringify({ ...before, tree }) + '\\n');
} else {
  inspectRepository(input.gitdir);
  const savedIndex = path.join(input.gitdir, 'ruukoto-source-index');
  git(['--git-dir', input.gitdir, 'fsck', '--full', '--no-reflogs', '--no-dangling', '--no-progress'], { ...baseEnv, GIT_INDEX_FILE: readIndexFile(savedIndex).length ? savedIndex : savedIndex + '-missing' });
  if (action === 'tree') process.stdout.write(rawTree(input.source, input.gitdir, input.index, input.seedTree) + '\\n');
  else if (action === 'materialize') materialize(input.tree, input.gitdir, input.destination);
  else if (action === 'check') {
    const result = checkAffected(input.source, input.gitdir, input.baselineTree, input.childTree);
    fs.writeFileSync(input.report, JSON.stringify(result) + '\\n', { mode: 0o600 });
    process.stdout.write(result.state + '\\n');
  }
  else fail('snapshot_invalid', '未知宿主快照操作');
}
} catch (error) {
  process.stderr.write('[ruukoto:workspace-snapshot] ' + error.message + '\\n');
  process.stdout.write('RUUKOTO_SNAPSHOT_ERROR=' + JSON.stringify({ code: error.code || 'snapshot_failed', message: error.message }) + '\\n');
  process.exitCode = 1;
}
`;
