import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(process.argv[2]);
const sources = ['apps/ruukoto/src/personal-cli.ts', 'apps/ruukoto/src/personal-control.ts', 'apps/ruukoto/src/personal-service-controls.ts'];
const hashes = () => Object.fromEntries(sources.map(source => [source, createHash('sha256').update(fs.readFileSync(path.join(repo, source))).digest('hex')]));
const sourceSHA256 = hashes();
const { runPersonalCli } = await import(pathToFileURL(path.join(repo, sources[0])).href);
const profile = path.join(root, 'profile');
fs.mkdirSync(profile, { mode: 0o700 });
const token = randomBytes(32).toString('hex');
fs.writeFileSync(path.join(profile, 'control.token'), token + '\n', { mode: 0o600 });
process.env.RUUKOTO_PERSONAL_DIR = profile;
const requests = [];
const failures = [];
const decisions = new Map();
const operations = [
  { ref: { taskId: 730011, requestId: 'hidden-first-request' }, unit: 'alpha-worker.service', machine: 'isolated-host-alpha' },
  { ref: { taskId: 730012, requestId: 'hidden-second-request' }, unit: 'beta-worker.service', machine: 'isolated-host-beta' },
];
let authChecks = 0;
function summary(item) {
  const decision = decisions.get(item.ref.taskId);
  return { ref: item.ref, unit: item.unit, status: !decision ? `等待批准：在机器 ${item.machine} 重启 ${item.unit}；仅本次固定策略和单元修订` : decision === 'approved' ? '尚未得到执行结果（pending）' : '已知未执行（owner_rejected）', canDecide: !decision, canResolve: false, canRecheck: false };
}
const server = http.createServer(async (req, res) => {
  try {
    assert.ok(req.headers.authorization === `Bearer ${token}`, 'Every request must authenticate with the private local token');
    authChecks++;
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const route = `${req.method} ${req.url}`;
    requests.push({ route, ...(body ? { body: JSON.parse(body) } : {}), authenticated: true });
    const url = new URL(req.url, 'http://localhost');
    let result;
    if (req.method === 'GET' && url.pathname === '/services') {
      assert.equal(url.search, '?offset=0');
      assert.equal(body, '');
      result = { items: operations.map(summary) };
    } else if (req.method === 'GET' && url.pathname === '/service') {
      assert.equal(url.searchParams.get('offset'), '0');
      assert.equal(body, '');
      const item = operations.find(op => String(op.ref.taskId) === url.searchParams.get('service'));
      assert.ok(item, 'Detail must use a task from the original menu');
      result = { summary: summary(item), evidence: '尚无人工核实说明；请独立检查服务实际效果后保存证据。' };
    } else if (req.method === 'POST' && url.pathname === '/service/decide') {
      const id = Number(url.searchParams.get('service'));
      const item = operations.find(op => op.ref.taskId === id);
      assert.ok(item, 'Decision must use a task from the original menu');
      assert.equal(url.search, `?service=${id}`);
      assert.ok(!decisions.has(id), 'Refresh must never repeat a decision');
      const expected = id === operations[0].ref.taskId ? 'approved' : 'rejected';
      assert.deepEqual(JSON.parse(body), { decision: expected });
      decisions.set(id, expected);
      result = { saved: true };
    } else throw new Error(`Unexpected request ${route}`);
    res.end(JSON.stringify({ v: 1, ok: true, result }));
  } catch (error) {
    failures.push(String(error.stack));
    res.statusCode = 500;
    res.end(JSON.stringify({ v: 1, ok: false, code: 'stub_failure', message: '替身断言失败。' }));
  }
});
let code;
try {
  server.listen(path.join(profile, 'control.sock'));
  await once(server, 'listening');
  assert.ok(process.stdin.isTTY && process.stdout.isTTY);
  code = await runPersonalCli([]);
  assert.equal(code, 0);
  assert.deepEqual(failures, []);
  assert.equal(decisions.get(operations[0].ref.taskId), 'approved');
  assert.equal(decisions.get(operations[1].ref.taskId), 'rejected');
  assert.equal(requests.filter(r => r.route.startsWith('POST ')).length, 2);
  assert.equal(requests.filter(r => r.route.startsWith('GET /services?')).length, 3);
  assert.equal(requests.filter(r => r.route.startsWith('GET /service?')).length, 7);
  assert.equal(authChecks, requests.length);
  assert.deepEqual(hashes(), sourceSHA256, 'Sources must remain stable during validation');
  fs.writeFileSync(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'source-sha256.json'), JSON.stringify(sourceSHA256, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: true, code, stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, authChecks, requests: requests.length, approvePosts: 1, rejectPosts: 1, stableSources: true, tokenRecorded: false, realPty: true, realRunPersonalCli: true, unixSocketHttp: 'local stub', helper: 'not invoked', systemd: 'not invoked', realBackend: 'not started or stopped', model: 'not invoked', telegram: 'not invoked', platform: process.platform, nodeVersion: process.version, sourceSHA256 }, null, 2) + '\n');
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
  if (failures.length) fs.writeFileSync(path.join(root, 'stub-errors.txt'), failures.join('\n') + '\n');
}
process.exitCode = code;
