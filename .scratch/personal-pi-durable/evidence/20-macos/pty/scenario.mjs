import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { runPersonalCli } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-cli.ts';

const root = '/tmp/rk20-pty';
const profile = path.join(root, 'profile');
fs.mkdirSync(profile, { recursive: true });
const token = 'c'.repeat(64);
fs.writeFileSync(path.join(profile, 'control.token'), token + '\n', { mode: 0o600 });
process.env.RUUKOTO_PERSONAL_DIR = profile;
const socket = path.join(profile, 'control.sock');
fs.rmSync(socket, { force: true });
const evidence = '第一页开始；' + '独立检查服务日志、实例启动时间及实际响应。'.repeat(65) + '；第二页末尾。';
fs.writeFileSync(path.join(root, 'evidence-input.txt'), evidence);
const selected = { ref: { taskId: 120012, requestId: 'hidden-request-pty' }, unit: 'example.service', status: '', canResolve: true, canRecheck: true };
const routes = [];
let saved = false;
let stopRequests = 0;
let resolveRequests = 0;
let authChecks = 0;
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    authChecks++;
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const route = `${req.method} ${req.url}`;
    routes.push({ route, ...(body ? { body: JSON.parse(body) } : {}), authenticated: true });
    const url = new URL(req.url, 'http://localhost');
    let result;
    if (req.method === 'POST' && url.pathname === '/service/resolve') {
      assert.equal(url.searchParams.get('service'), '120012');
      assert.deepEqual(JSON.parse(body), { effect: 'applied', evidence });
      assert.equal(resolveRequests++, 0);
      saved = true;
      result = { saved: true };
    } else if (req.method === 'POST' && url.pathname === '/service/stop') {
      assert.equal(url.searchParams.get('service'), '120012');
      assert.equal(body, '');
      assert.equal(stopRequests++, 0);
      result = { requested: true };
    } else if (req.method === 'GET' && url.pathname === '/services') {
      const offset = Number(url.searchParams.get('offset'));
      assert.ok(offset === 0 || offset === 8);
      result = offset === 0 ? { items: Array.from({ length: 8 }, (_, i) => ({ ...selected, unit: `archived-${i + 1}.service` })), nextOffset: 8 } : { items: [selected] };
    } else if (req.method === 'GET' && url.pathname === '/service') {
      assert.equal(url.searchParams.get('service'), '120012');
      const offset = Number(url.searchParams.get('offset'));
      assert.ok(offset === 0 || offset === 1200);
      const full = saved ? evidence : '尚无人工核实说明；请独立检查服务实际效果后保存证据。';
      result = { summary: { ...selected, canResolve: !saved, status: `效果未知（helper_timeout）；${saved ? '效果已核实：已生效' : '未保存人工效果核实'}；原写操作停止未核实`, ...(stopRequests ? { stop: '重核进行中' } : {}) }, evidence: full.slice(offset, offset + 1200), ...(full.length > offset + 1200 ? { nextOffset: offset + 1200 } : {}) };
    } else throw new Error(`Unexpected request ${route}`);
    res.end(JSON.stringify({ v: 1, ok: true, result }));
  } catch (error) {
    fs.appendFileSync(path.join(root, 'stub-errors.txt'), String(error.stack) + '\n');
    res.statusCode = 500;
    res.end(JSON.stringify({ v: 1, ok: false, code: 'stub_failure', message: '替身断言失败。' }));
  }
});
server.listen(socket);
await once(server, 'listening');
let code;
try {
  assert.ok(process.stdin.isTTY && process.stdout.isTTY);
  code = await runPersonalCli([]);
  assert.equal(code, 0);
  assert.equal(resolveRequests, 1);
  assert.equal(stopRequests, 1);
  assert.ok(routes.some(item => item.route === 'GET /service?service=120012&offset=1200'));
  fs.writeFileSync(path.join(root, 'requests.json'), JSON.stringify(routes, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ code, stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, authChecks, resolveRequests, stopRequests, saved, stopVerified: false, evidenceCharacters: evidence.length, sourceSHA256: createHash('sha256').update(fs.readFileSync('/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-cli.ts')).digest('hex') }, null, 2) + '\n');
} finally {
  await new Promise(resolve => server.close(resolve));
}
process.exitCode = code;
