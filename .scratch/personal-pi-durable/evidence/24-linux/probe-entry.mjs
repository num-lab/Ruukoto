import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { runPersonalCommand, readPersonalCommandReceipt, stopPersonalCommand } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-command-execution.ts';
import { prepareNativeLaunch } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/packages/agent/src/execution/native.ts';

const self = process.argv[1];
const base = process.argv[3];
const codeRoot = path.resolve(path.dirname(self), '../../..');
const evidence = path.join(base, 'evidence');
const sha = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n');
const waitFor = async (test, description) => {
  const deadline = Date.now() + 20_000;
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${description}`);
    await sleep(20);
  }
};
const fixtureData = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));

if (process.argv[2] === 'read') {
  const input = fixtureData(process.argv[4]);
  const receipt = await readPersonalCommandReceipt(input.directory, input.ref);
  process.stdout.write(JSON.stringify({ receipt }) + '\n');
} else if (process.argv[2] === 'stop') {
  const input = fixtureData(process.argv[4]);
  process.stdout.write(JSON.stringify(await stopPersonalCommand(input.directory, input.ref)) + '\n');
} else if (process.argv[2] === 'owner') {
  const input = fixtureData(process.argv[4]);
  write(path.join(path.dirname(process.argv[4]), 'owner-started.json'), { pid: process.pid });
  const result = await runPersonalCommand(input);
  write(path.join(path.dirname(process.argv[4]), 'owner-result.json'), result);
} else {
  fs.mkdirSync(evidence, { recursive: true });
  const fixtureRoot = path.join(base, 'fixtures');
  fs.mkdirSync(fixtureRoot, { mode: 0o700 });
  const machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  const results = [];
  const fixtures = [];
  write(path.join(evidence, 'environment.json'), {
    timestamp: new Date().toISOString(), node: process.version, platform: process.platform,
    arch: process.arch, uid: process.getuid(), kernel: execFileSync('uname', ['-a'], { encoding: 'utf8' }).trim(),
    bwrap: execFileSync('bwrap', ['--version'], { encoding: 'utf8' }).trim(),
    userManager: execFileSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).trim(),
    cgroupV2: fs.existsSync('/sys/fs/cgroup/cgroup.controllers'), self, codeRoot,
    bundledProbeSha256: sha(fs.readFileSync(self)), workerSha256: sha(fs.readFileSync(path.join(codeRoot, 'worker/personal-command-worker.mjs'))),
    hasRepositoryNodeModules: fs.existsSync(path.join(codeRoot, 'node_modules')),
  });
  const fixture = name => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(fixtureRoot, name + '-')));
    const workspace = path.join(root, 'work');
    const directory = path.join(root, 'commands');
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.mkdirSync(directory, { mode: 0o700 });
    const { dev, ino } = fs.statSync(workspace);
    const ref = { executionId: `native_${randomBytes(12).toString('hex')}`, machineId };
    const input = { directory, ref, command: 'exit 0', spec: { taskId: `personal-command-24-${name}`, mode: 'confirm', workspace, workspaceIdentity: { dev, ino }, grantedPaths: [] }, timeoutMs: 15_000 };
    const value = { name, root, workspace, directory, input, inputFile: path.join(root, 'input.json') };
    fixtures.push(value);
    return value;
  };
  const fresh = (mode, f) => JSON.parse(execFileSync(process.execPath, [self, mode, base, f.inputFile], { encoding: 'utf8', timeout: 20_000 }));
  const freshAsync = (mode, f) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, mode, base, f.inputFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`独立 ${mode} 超时`)); }, 20_000);
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(stderr || `独立 ${mode} 退出 ${code}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  const saveInput = async f => {
    f.input.input = await prepareNativeLaunch({ workerPath: path.join(codeRoot, 'worker/personal-command-worker.mjs'), dependencyRoots: [], protectedRoots: [codeRoot, f.directory] }, f.input.spec);
    assert.ok(!f.input.input.runtimeReadRoots.includes(codeRoot));
    assert.ok(!f.input.input.runtimeReadRoots.some(root => root.endsWith('/node_modules')));
    write(f.inputFile, f.input); write(path.join(evidence, `${f.name}-input.json`), f.input);
  };
  const sameRef = async f => {
    let result, failure;
    try { result = await runPersonalCommand(f.input); }
    catch (error) { failure = { name: error.name, code: error.code, message: error.message }; }
    return { result, failure };
  };
  const finish = async f => {
    const stop = fresh('stop', f);
    assert.equal(stop.exited, true, `原执行停止必须核实：${f.name}`);
    const repeated = fresh('stop', f);
    assert.equal(repeated.exited, true);
    fs.cpSync(f.directory, path.join(evidence, `${f.name}-records`), { recursive: true });
    write(path.join(evidence, `${f.name}-stop.json`), { stop, repeated });
    fs.rmSync(f.root, { recursive: true });
    return stop;
  };
  try {
    {
      const f = fixture('binary-nonzero');
      f.input.command = "printf x >> count; printf '\\000\\377A'; printf '\\200\\000Z' >&2; exit 37";
      await saveInput(f);
      const completed = await runPersonalCommand(f.input);
      assert.equal(completed.exited, true);
      assert.equal(completed.cleaned, true);
      assert.ok(completed.receipt, '正常非零退出仍须有宿主完成回执');
      assert.deepEqual(completed.receipt.exit, { code: 37, signal: null });
      assert.deepEqual(completed.receipt.stdout, { bytes: 3, sha256: sha(Buffer.from([0, 255, 65])) });
      assert.deepEqual(completed.receipt.stderr, { bytes: 3, sha256: sha(Buffer.from([128, 0, 90])) });
      assert.deepEqual(fresh('read', f).receipt, completed.receipt, '新进程读取原回执');
      const repeated = await sameRef(f);
      assert.ok(repeated.failure);
      assert.equal(fs.readFileSync(path.join(f.workspace, 'count'), 'utf8'), 'x', '同 ref 不能重放命令');
      results.push({ name: f.name, completed, repeated });
      await finish(f);
    }
    {
      const f = fixture('large-output');
      f.input.command = "python3 -I -c 'import os; os.write(1,bytes(range(256))*8192); os.write(2,bytes(reversed(range(256)))*4096)'";
      await saveInput(f);
      const completed = await runPersonalCommand(f.input);
      assert.equal(completed.exited, true);
      assert.ok(completed.receipt);
      assert.deepEqual(completed.receipt.exit, { code: 0, signal: null });
      const stdout = Buffer.concat(Array(8192).fill(Buffer.from(Array.from({ length: 256 }, (_, i) => i))));
      const stderr = Buffer.concat(Array(4096).fill(Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i))));
      assert.deepEqual(completed.receipt.stdout, { bytes: stdout.length, sha256: sha(stdout) });
      assert.deepEqual(completed.receipt.stderr, { bytes: stderr.length, sha256: sha(stderr) });
      assert.deepEqual(fresh('read', f).receipt, completed.receipt);
      results.push({ name: f.name, completed });
      await finish(f);
    }
    for (const mode of ['timeout', 'cancel', 'independent-stop']) {
      const f = fixture(`${mode}-descendant`);
      const heart = path.join(f.workspace, 'heart');
      const identity = path.join(f.workspace, 'identity.json');
      const python = `import os,time,json\nos.setsid()\nopen(${JSON.stringify(identity)},'w').write(json.dumps({'pid':os.getpid(),'sid':os.getsid(0),'pgid':os.getpgid(0)}))\nf=open(${JSON.stringify(heart)},'a',buffering=1)\nwhile True:\n f.write('tick\\n');time.sleep(.02)\n`;
      f.input.command = `python3 -I -c ${quote(python)} & wait`;
      if (mode === 'timeout') f.input.timeoutMs = 1500;
      await saveInput(f);
      const controller = new AbortController();
      const running = runPersonalCommand({ ...f.input, ...(mode === 'cancel' ? { signal: controller.signal } : {}) });
      const settled = running.then(value => ({ result: value }), error => ({ failure: { name: error.name, code: error.code, message: error.message } }));
      await waitFor(() => fs.existsSync(heart) && fs.statSync(heart).size > 20, 'setsid 后代心跳');
      const child = fixtureData(identity);
      assert.equal(child.sid, child.pid); assert.equal(child.pgid, child.pid);
      let independentStop;
      if (mode === 'cancel') controller.abort();
      if (mode === 'independent-stop') {
        independentStop = await freshAsync('stop', f);
        assert.equal(independentStop.exited, true);
      }
      const outcome = await settled;
      assert.equal(outcome.failure?.code, 'command_result_unknown');
      assert.equal(fresh('read', f).receipt, undefined, '中断运行不能发布完整回执');
      const stop = fresh('stop', f);
      assert.equal(stop.exited, true);
      const bytes = fs.statSync(heart).size;
      await sleep(250);
      assert.equal(fs.statSync(heart).size, bytes, '停止后后代心跳冻结');
      results.push({ name: f.name, child, outcome, independentStop, stop, heartbeatBytes: bytes, heartbeatFrozenForMs: 250 });
      await finish(f);
    }
    for (const replace of [false, true]) {
      const f = fixture(replace ? 'owner-sigkill-temp-replaced' : 'owner-sigkill');
      const heart = path.join(f.workspace, 'heart');
      const identity = path.join(f.workspace, 'identity.json');
      const python = `import os,time,json\nos.setsid()\nopen(${JSON.stringify(identity)},'w').write(json.dumps({'pid':os.getpid(),'sid':os.getsid(0),'pgid':os.getpgid(0)}))\nf=open(${JSON.stringify(heart)},'a',buffering=1)\nwhile True:\n f.write('tick\\n');time.sleep(.02)\n`;
      f.input.command = `printf x >> count; python3 -I -c ${quote(python)} & wait`;
      await saveInput(f);
      const owner = spawn(process.execPath, [self, 'owner', base, f.inputFile], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; owner.stderr.on('data', bytes => { stderr += bytes; }); owner.stdout.resume();
      const exited = new Promise(resolve => owner.once('exit', (code, signal) => resolve({ code, signal })));
      try {
        await waitFor(() => fs.existsSync(heart) && fs.statSync(heart).size > 20 || owner.exitCode !== null, '独立 owner 派发命令');
        assert.equal(owner.exitCode, null, stderr);
        const child = fixtureData(identity);
        assert.equal(child.sid, child.pid); assert.equal(child.pgid, child.pid);
        owner.kill('SIGKILL');
        const ownerExit = await exited;
        assert.deepEqual(ownerExit, { code: null, signal: 'SIGKILL' });
        assert.equal(fresh('read', f).receipt, undefined, 'owner 强杀后没有宿主完成回执');
        const repeated = await sameRef(f);
        assert.equal(repeated.failure?.code, 'command_already_claimed');
        assert.equal(fs.readFileSync(path.join(f.workspace, 'count'), 'utf8'), 'x', '无回执也不得重放同 ref');
        const temp = fixtureData(path.join(f.directory, `command-${f.input.ref.executionId}`, 'request.json')).temp;
        const moved = temp.path + '-preserved';
        if (replace) {
          fs.renameSync(temp.path, moved);
          fs.mkdirSync(temp.path, { mode: 0o700 });
          fs.writeFileSync(path.join(temp.path, 'replacement-marker'), 'preserve replacement\n');
        }
        const stop = fresh('stop', f);
        assert.equal(stop.exited, true);
        assert.equal(stop.cleaned, !replace);
        if (replace) assert.equal(fs.readFileSync(path.join(temp.path, 'replacement-marker'), 'utf8'), 'preserve replacement\n');
        else assert.equal(fs.existsSync(temp.path), false);
        const bytes = fs.statSync(heart).size;
        await sleep(250); assert.equal(fs.statSync(heart).size, bytes);
        results.push({ name: f.name, ownerExit, child, repeated, stop, temp, replacementPreserved: replace, heartbeatBytes: bytes, heartbeatFrozenForMs: 250, stderr });
        if (replace) {
          fs.rmSync(temp.path, { recursive: true });
          fs.rmSync(moved, { recursive: true });
        }
      } finally { owner.kill('SIGKILL'); await exited; }
      await finish(f);
    }
    fs.rmdirSync(fixtureRoot);
    write(path.join(evidence, 'summary.json'), { passed: true, cases: results.length, results, limitations: ['不覆盖 durable 工具、权限、审批、工作暂停或占用', '不覆盖完全访问、MCP、真实模型、IM 或生产部署'] });
    write(path.join(evidence, 'cleanup.json'), { fixturesRemoved: !fs.existsSync(fixtureRoot), remainingCaseDirectories: [] });
    process.stdout.write(JSON.stringify({ passed: true, cases: results.length, evidence }) + '\n');
  } catch (error) {
    const cleanup = [];
    for (const f of fixtures) if (fs.existsSync(f.root)) {
      try { cleanup.push({ name: f.name, stop: fresh('stop', f) }); }
      catch (failure) { cleanup.push({ name: f.name, failure: { message: failure.message, code: failure.code } }); }
    }
    write(path.join(evidence, 'failure.json'), { message: error.message, stack: error.stack, results, cleanup, remainingCaseDirectories: fs.existsSync(fixtureRoot) ? fs.readdirSync(fixtureRoot) : [] });
    throw error;
  }
}
