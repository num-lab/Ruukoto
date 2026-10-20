import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import { prepareNativeLaunch } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/packages/agent/src/execution/native.ts';
import { launchLinuxExecution, stopLinuxExecution } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/packages/agent/src/execution/native-linux-identity.ts';

const self = fileURLToPath(import.meta.url);
const codeRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const workerPath = path.join(codeRoot, 'worker/personal-command-worker.mjs');
const base = process.argv[3] ?? path.dirname(codeRoot);
const evidence = path.join(base, 'evidence');
const sha = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const waitFor = async (predicate, description) => {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${description}`);
    await sleep(20);
  }
};
const write = (target, value) => fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
const attach = unit => {
  const stdout = [], stderr = [];
  unit.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  unit.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  unit.stdin.on('error', error => { throw error; });
  const completion = Promise.all([unit.exit, finished(unit.stdout), finished(unit.stderr)]).then(([exit]) => ({
    ...exit, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
  }));
  return { completion };
};

if (process.argv[2] === 'owner') {
  const fixture = process.argv[4];
  const input = JSON.parse(fs.readFileSync(path.join(fixture, 'input.json'), 'utf8'));
  const prepared = await prepareNativeLaunch({ workerPath, dependencyRoots: [], protectedRoots: [codeRoot, input.claims] }, input.spec);
  write(path.join(fixture, 'prepared.json'), prepared);
  const unit = await launchLinuxExecution(input.claims, input.ref, prepared, input.spec);
  const collected = attach(unit);
  unit.stdin.end(JSON.stringify(input.payload));
  void collected.completion.then(result => write(path.join(fixture, 'unit-exit.json'), {
    code: result.code, signal: result.signal,
    stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8'),
  }));
  write(path.join(fixture, 'ready.json'), { scope: unit.entry.id, owner: process.pid });
  setInterval(() => {}, 1000);
} else {
  fs.mkdirSync(evidence, { recursive: true });
  const machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  const results = [];
  const fixtureRoot = path.join(base, 'fixtures');
  fs.mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  write(path.join(evidence, 'environment.json'), {
    timestamp: new Date().toISOString(), platform: process.platform, arch: process.arch,
    node: process.version, executable: process.execPath, uid: process.getuid(),
    kernel: execFileSync('uname', ['-a'], { encoding: 'utf8' }).trim(),
    bwrap: execFileSync('/usr/bin/bwrap', ['--version'], { encoding: 'utf8' }).trim(),
    systemd: execFileSync('/usr/bin/systemctl', ['--version'], { encoding: 'utf8' }).split('\n')[0],
    userManager: execFileSync('/usr/bin/systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).trim(),
    cgroupVersion: fs.existsSync('/sys/fs/cgroup/cgroup.controllers') ? 2 : null,
    worker: { path: workerPath, sha256: sha(fs.readFileSync(workerPath)) },
    probe: { path: self, sha256: sha(fs.readFileSync(self)) },
    codeRoot, hasNodeModules: fs.existsSync(path.join(codeRoot, 'node_modules')),
  });
  const fixture = name => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(fixtureRoot, name + '-')));
    const workspace = path.join(directory, 'work'), claims = path.join(directory, 'claims');
    fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(claims, { mode: 0o700 });
    const { dev, ino } = fs.statSync(workspace);
    const ref = { executionId: `native_${randomBytes(12).toString('hex')}`, machineId };
    const spec = { taskId: `real-personal-worker-${name}`, mode: 'confirm', workspace, workspaceIdentity: { dev, ino }, grantedPaths: [] };
    return { directory, workspace, claims, ref, spec, workspacePayload: { path: workspace, dev, ino } };
  };
  const finish = async (f, prepared, name) => {
    const stopped = await stopLinuxExecution(f.claims, f.ref);
    assert.equal(stopped.exited, true, `清理前必须核实原 scope 已停止：${name}`);
    const again = await stopLinuxExecution(f.claims, f.ref);
    assert.equal(again.exited, true, '重复停止应保持已核实');
    await assert.rejects(launchLinuxExecution(f.claims, f.ref, prepared, f.spec), { code: 'execution_claim_failed' });
    const claimDir = path.join(f.claims, f.ref.executionId);
    const observed = fs.existsSync(path.join(claimDir, 'observation.json')) ? JSON.parse(fs.readFileSync(path.join(claimDir, 'observation.json'), 'utf8')) : null;
    write(path.join(evidence, `${name}-stop.json`), { ref: f.ref, observation: observed, stopped, repeated: again, sameRefRejected: true, tempDir: prepared.tempDir });
    fs.rmSync(prepared.tempDir, { recursive: true, force: true });
    fs.rmSync(f.directory, { recursive: true, force: true });
  };
  const run = async (name, command, verify) => {
    const f = fixture(name);
    const prepared = await prepareNativeLaunch({ workerPath, dependencyRoots: [], protectedRoots: [codeRoot, f.claims] }, f.spec);
    assert.ok(!prepared.runtimeReadRoots.some(root => root.endsWith('/node_modules')));
    assert.ok(!prepared.runtimeReadRoots.includes(codeRoot));
    write(path.join(evidence, `${name}-input.json`), { command, spec: f.spec, prepared, payload: { command, workspace: f.workspacePayload } });
    try {
      const unit = await launchLinuxExecution(f.claims, f.ref, prepared, f.spec);
      const collected = attach(unit);
      unit.stdin.end(JSON.stringify({ command, workspace: f.workspacePayload }));
      const result = await collected.completion;
      verify(result, f);
      results.push({ name, scope: unit.entry.id, code: result.code, signal: result.signal,
        stdoutBytes: result.stdout.length, stdoutSha256: sha(result.stdout),
        stderrBytes: result.stderr.length, stderrSha256: sha(result.stderr),
        stdoutUtf8: result.stdout.length < 1000 ? result.stdout.toString('utf8') : undefined,
        stderrUtf8: result.stderr.length < 1000 ? result.stderr.toString('utf8') : undefined });
    } finally { await finish(f, prepared, name); }
  };
  try {
    await run('immediate', 'exit 0', result => { assert.equal(result.code, 0); assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0); });
    await run('binary-nonzero', "printf '\\000\\377A'; printf '\\200\\000Z' >&2; exit 37", result => {
      assert.equal(result.code, 37); assert.deepEqual(result.stdout, Buffer.from([0, 255, 65])); assert.deepEqual(result.stderr, Buffer.from([128, 0, 90]));
    });
    await run('signal', 'kill -TERM $$', result => { assert.equal(result.code, 143); });
    await run('large-output', "python3 -I -c 'import os; os.write(1,bytes(range(256))*8192); os.write(2,bytes(reversed(range(256)))*4096)'", result => {
      assert.equal(result.code, 0); assert.deepEqual(result.stdout, Buffer.concat(Array(8192).fill(Buffer.from(Array.from({ length: 256 }, (_, i) => i)))));
      assert.deepEqual(result.stderr, Buffer.concat(Array(4096).fill(Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i)))));
    });
    const outside = path.join(base, 'unauthorized-fixture.txt');
    const secret = 'synthetic-unauthorized-' + randomBytes(12).toString('hex');
    fs.writeFileSync(outside, secret, { mode: 0o600 });
    const server = net.createServer(socket => socket.end('host-positive-control'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const positive = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1'); let content = '';
      socket.on('data', bytes => { content += bytes; }); socket.on('error', reject); socket.on('end', () => resolve(content));
    });
    assert.equal(positive, 'host-positive-control');
    try {
      const python = `import json,socket,os\nr={}\nfor op in ['read','write']:\n try:\n  f=open(${JSON.stringify(outside)},'r' if op=='read' else 'w');f.close();r[op]='unexpected-success'\n except OSError as e:r[op]=e.errno\ntry:\n s=socket.socket(socket.AF_INET,socket.SOCK_STREAM);s.connect(('127.0.0.1',${port}));r['network']='unexpected-success'\nexcept OSError as e:r['network']=e.errno\nprint(json.dumps(r,sort_keys=True))\n`;
      await run('restricted', `python3 -I -c ${quote(python)}`, result => {
        assert.equal(result.code, 0); const report = JSON.parse(result.stdout.toString('utf8'));
        assert.ok(Number.isInteger(report.read)); assert.ok(Number.isInteger(report.write)); assert.equal(report.network, 1);
        assert.equal(fs.readFileSync(outside, 'utf8'), secret);
        assert.ok(!result.stdout.includes(Buffer.from(secret)));
      });
      write(path.join(evidence, 'restricted-positive-control.json'), { hostFileAccessible: fs.readFileSync(outside, 'utf8') === secret, hostNetworkConnected: positive, fixtureContentSha256: sha(secret), networkAddress: '127.0.0.1', port });
    } finally { server.close(); fs.rmSync(outside); }

    for (const crash of [false, true]) {
      const name = crash ? 'descendant-owner-sigkill' : 'descendant-owner-live';
      const f = fixture(name), heart = path.join(f.workspace, 'heart'), identity = path.join(f.workspace, 'child-identity.json');
      const python = `import os,time,json\nos.setsid()\nopen(${JSON.stringify(identity)},'w').write(json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'pgid':os.getpgid(0),'sid':os.getsid(0)}))\nf=open(${JSON.stringify(heart)},'a',buffering=1)\nwhile True:\n f.write('tick\\n');time.sleep(.02)\n`;
      const command = `python3 -I -c ${quote(python)} & wait`;
      write(path.join(f.directory, 'input.json'), { ...f, command, payload: { command, workspace: f.workspacePayload } });
      write(path.join(evidence, `${name}-input.json`), { command, ref: f.ref, spec: f.spec, payload: { command, workspace: f.workspacePayload } });
      const owner = spawn(process.execPath, [self, 'owner', base, f.directory], { stdio: ['ignore', 'pipe', 'pipe'] });
      let errorText = ''; owner.stderr.on('data', bytes => { errorText += bytes; }); owner.stdout.resume();
      const ownerExit = new Promise(resolve => owner.once('exit', (code, signal) => resolve({ code, signal })));
      let prepared;
      try {
        await waitFor(() => fs.existsSync(path.join(f.directory, 'ready.json')) || owner.exitCode !== null, 'owner ready');
        assert.ok(fs.existsSync(path.join(f.directory, 'ready.json')), errorText);
        prepared = JSON.parse(fs.readFileSync(path.join(f.directory, 'prepared.json'), 'utf8'));
        await waitFor(() => fs.existsSync(heart) && fs.statSync(heart).size > 20 && fs.existsSync(identity), 'setsid 心跳');
        const child = JSON.parse(fs.readFileSync(identity, 'utf8'));
        assert.equal(child.sid, child.pid); assert.equal(child.pgid, child.pid);
        const ready = JSON.parse(fs.readFileSync(path.join(f.directory, 'ready.json'), 'utf8'));
        const observation = JSON.parse(fs.readFileSync(path.join(f.claims, f.ref.executionId, 'observation.json'), 'utf8'));
        assert.ok(fs.readFileSync(path.join(observation.group, 'cgroup.events'), 'utf8').includes('populated 1'));
        if (crash) { owner.kill('SIGKILL'); assert.deepEqual(await ownerExit, { code: null, signal: 'SIGKILL' }); }
        const stopped = await stopLinuxExecution(f.claims, f.ref);
        assert.equal(stopped.exited, true, JSON.stringify({ stopped, errorText }));
        const size = fs.statSync(heart).size;
        await sleep(250); assert.equal(fs.statSync(heart).size, size, '原引用停止后 setsid 心跳须冻结');
        results.push({ name, ref: f.ref, scope: ready.scope, owner: ready.owner, ownerKilledBeforeStop: crash,
          child, observation, stopped, heartbeatBytes: size, heartbeatFrozenForMs: 250, ownerErrors: errorText });
      } finally {
        owner.kill('SIGKILL'); await ownerExit;
        prepared ??= JSON.parse(fs.readFileSync(path.join(f.directory, 'prepared.json'), 'utf8'));
        await finish(f, prepared, name);
      }
    }
    write(path.join(evidence, 'summary.json'), { passed: true, results, cleaned: true, effectReceiptClaimed: false,
      limitations: ['未执行 durable 命令业务链、完全访问、MCP、真实模型或 IM', '未运行 Linux 全产品构建或全量测试；本探针使用纯 Node bundle 和已构建的自包含 worker'] });
    fs.rmdirSync(fixtureRoot);
    write(path.join(evidence, 'cleanup.json'), { fixturesRemoved: !fs.existsSync(fixtureRoot), temporaryNativeDirs: '每项仅在原引用停止证明为 true 后删除', remainingCaseDirectories: [] });
    process.stdout.write(JSON.stringify({ passed: true, cases: results.length, evidence, cleaned: true }) + '\n');
  } catch (error) {
    write(path.join(evidence, 'failure.json'), { message: error.message, stack: error.stack, results, remainingCaseDirectories: fs.existsSync(fixtureRoot) ? fs.readdirSync(fixtureRoot) : [] });
    throw error;
  }
}
