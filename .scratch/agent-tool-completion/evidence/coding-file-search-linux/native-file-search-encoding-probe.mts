import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolWorkerHost } from './packages/agent/src/tool-worker/host.ts';
import { createNativeLauncher } from './packages/agent/src/execution/native.ts';
import type { FileSearchResult } from './packages/agent/src/file-search.ts';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ruukoto-native-search-check-')));
const work = path.join(root, 'work'), granted = path.join(root, 'source'), privateRoot = path.join(root, 'private');
for (const directory of [work, granted, privateRoot]) fs.mkdirSync(directory);
fs.writeFileSync(path.join(work, 'sample.txt'), 'Needle literal.*\nneedle lower\n');
fs.writeFileSync(path.join(work, '.gitignore'), 'ignored.txt\n');
fs.writeFileSync(path.join(work, 'ignored.txt'), 'needle ignored\n');
fs.writeFileSync(path.join(work, '.hidden.txt'), 'needle hidden\n');
fs.writeFileSync(path.join(granted, 'source.txt'), 'needle readonly source\n');
fs.writeFileSync(path.join(privateRoot, 'secret.txt'), 'private must remain private\n');
fs.symlinkSync(privateRoot, path.join(work, 'linked'));
const stat = fs.statSync(work), sourceStat = fs.statSync(granted);
let host: ToolWorkerHost | undefined;
let serial = 0;
const passed: string[] = [];
try {
  host = await ToolWorkerHost.start(createNativeLauncher({protectedRoots: [privateRoot]}), {
    taskId: 'linux-file-search-native-probe', mode: 'confirm', workspace: work,
    workspaceIdentity: {dev: stat.dev, ino: stat.ino},
    grantedPaths: [{path: granted, access: 'read', purpose: '独立验收只读来源'}],
    readRoots: [{path: granted, dev: sourceStat.dev, ino: sourceStat.ino}],
  });
  const identity = host.identity();
  assert.equal(identity?.kind, 'systemd_unit');
  const call = async (name: string, params: Record<string, unknown> = {}) => {
    const raw: Buffer[] = [];
    const response = await host!.call({opId: `native-${++serial}`, sdkCallId: `sdk-${serial}`, name, params,
      timeoutMs: 20000, onData: (_stream, bytes) => raw.push(bytes)});
    return {response, result: response.details as FileSearchResult, raw: Buffer.concat(raw)};
  };
  const listed = (await call('list_files')).result;
  assert.equal(listed.scanComplete, true);
  assert.deepEqual(listed.entries.map(entry => entry.path), ['sample.txt']);
  passed.push('真实Linux原生边界列文件、ignore/隐藏过滤、链接不跟随');
  const globbed = (await call('list_files', {glob: '*.txt'})).result;
  assert.deepEqual(globbed.entries.map(entry => entry.path).sort(), ['.hidden.txt', 'ignored.txt', 'sample.txt']);
  passed.push('显式glob覆盖ignore/隐藏且不扩大读取范围');
  const found = await call('search_files', {query: 'literal.*', glob: 'sample.txt'});
  assert.equal(found.response.isError, false);
  assert.deepEqual(found.result.entries, [{path: 'sample.txt', line: 1, text: 'Needle literal.*'}]);
  assert.ok(found.raw.includes(Buffer.from('literal.*')));
  const insensitive = (await call('search_files', {query: 'NEEDLE', ignore_case: true, glob: 'sample.txt'})).result;
  assert.equal(insensitive.capturedCount, 2);
  const read = await call('read', {path: 'sample.txt'});
  assert.equal(read.response.isError, false);
  passed.push('字面搜索、大小写、行号、原流捕获与命中后重新read');
  const source = (await call('search_files', {query: 'needle', path: granted})).result;
  assert.deepEqual(source.entries, [{path: 'source.txt', line: 1, text: 'needle readonly source'}]);
  const deniedWrite = await call('bash', {command: `printf changed > '${path.join(granted, 'source.txt')}'`});
  assert.equal(deniedWrite.response.isError, true);
  assert.equal(fs.readFileSync(path.join(granted, 'source.txt'), 'utf8'), 'needle readonly source\n');
  passed.push('获授只读来源可检索、OS真实拒绝修改来源');
  for (const params of [{path: privateRoot}, {path: '..', glob: '**/*'}, {path: 'linked', glob: '*'}]) {
    const denied = (await call('list_files', params)).result;
    assert.equal(denied.code, 'file_search_path_denied');
    assert.equal(denied.partial, true);
    assert.ok(!JSON.stringify(denied).includes('private must remain private'));
  }
  passed.push('越界根、保护目录与链接根具名拒绝');
  const encoding = path.join(work, 'encoding'); fs.mkdirSync(encoding);
  fs.writeFileSync(Buffer.concat([Buffer.from(encoding + '/'), Buffer.from([0xff]), Buffer.from('.txt')]), 'needle\n');
  for (const name of ['list_files', 'search_files']) {
    const out = (await call(name, {path: 'encoding', ...(name === 'search_files' ? {query: 'needle'} : {})})).result;
    assert.equal(out.code, 'file_search_encoding_unsupported');
    assert.equal(out.partial, true);
    assert.ok(out.entries.every(entry => !entry.path.includes('\uFFFD')));
  }
  passed.push('真实Linux非UTF8路径明确拒绝、无替换字符路径');
  fs.renameSync(work, path.join(root, 'old-work')); fs.mkdirSync(work);
  await assert.rejects(call('list_files'), (error: any) => error?.code === 'execution_unavailable');
  passed.push('目录身份替换在调用前拒绝并停止旧单元');
  assert.equal(await host.stop(), true);
  console.log(JSON.stringify({platform: process.platform, architecture: process.arch, identity, passed, stopped: true}, null, 2));
} finally {
  if (host) assert.equal(await host.stop(), true);
  fs.rmSync(root, {recursive: true, force: true});
}
