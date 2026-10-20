import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { startTestRuntime, lastUserText, waitFor } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/test/helpers/testkit.ts';
import { product } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/apps/ruukoto-code/src/product.ts';

const repository = '/Users/eitrous/.codex/worktrees/6f13/ruukoto';
const evidence = import.meta.dirname;
const executable = path.join(evidence, 'dist/darwin-arm64/Ruukoto File Tree QA.app/Contents/MacOS/Ruukoto File Tree QA');
if (!fs.existsSync(executable)) throw new Error('先运行 node prepare.mjs 构建 QA 应用');
const t = await startTestRuntime('file-tree-qa', async request => ({ kind: 'text', text: `隔离性能验收：${lastUserText(request)}` }), { config: { product: product.runtime } });
const control = fs.mkdtempSync('/tmp/rft-c-');
const profile = fs.mkdtempSync('/tmp/rft-u-');
fs.symlinkSync(path.join(t.runtime.controlDir(), 'owner.token'), path.join(control, 'owner.token'));
fs.symlinkSync(t.runtime.socketPath(), path.join(control, 'control.sock'));
const workspace = path.join(t.work[0], 'file-tree-performance');
fs.mkdirSync(workspace);
for (let index = 0; index < 28; index++) fs.writeFileSync(path.join(workspace, `root-${String(index).padStart(3, '0')}.txt`), `根目录 ${index}\n`);
const populated = path.join(workspace, 'sample-dir');
fs.mkdirSync(populated);
for (let index = 0; index < 200; index++) fs.writeFileSync(path.join(populated, `child-${String(index).padStart(3, '0')}.txt`), `子目录 ${index}\n`);
fs.mkdirSync(path.join(workspace, 'empty-dir'));
const { session } = await t.runtime.openWorkspace({ cwd: workspace });
const task = await t.runtime.submit({ sessionId: session.id, requestId: crypto.randomUUID(), input: '文件树性能验收', modelSelection: t.runtime.defaultSelection });
await waitFor('初始化性能验收会话', () => t.runtime.store.getTask(task.id)?.status === 'completed');
const records: Array<Record<string, unknown>> = [];
const direct: Array<Record<string, unknown>> = [];
let phase = 'baseline';
let flush: ReturnType<typeof setTimeout> | undefined;
const writeMeasurements = () => fs.writeFileSync(path.join(evidence, 'server-measurements.json'), JSON.stringify({ phase, service: records, controlRoundTrips: direct }, null, 2) + '\n');
const original = t.runtime.listWorkspaceFiles.bind(t.runtime);
t.runtime.listWorkspaceFiles = input => {
  const started = performance.now();
  let count: number | undefined;
  let error: string | undefined;
  try { const value = original(input); count = value.entries.length; return value; }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); throw cause; }
  finally {
    records.push({ phase, workspaceId: input.workspaceId, path: input.path ?? '', elapsedMs: Math.round((performance.now() - started) * 1000) / 1000, count, error, at: new Date().toISOString() });
    if (flush) clearTimeout(flush);
    flush = setTimeout(writeMeasurements, 30);
  }
};
for (const relative of ['', 'sample-dir', 'empty-dir']) for (let sample = 0; sample < 10; sample++) {
  const began = performance.now();
  const value = await t.client.request('list_workspace_files', { workspace_id: session.projectId, path: relative });
  direct.push({ path: relative, sample, elapsedMs: Math.round((performance.now() - began) * 1000) / 1000, count: value.entries.length });
}
phase = 'ui';
writeMeasurements();
const child = spawn(executable, [], { cwd: repository, env: { ...process.env, RUUKOTO_DESKTOP_MANAGED: '1', RUUKOTO_DESKTOP_MYGO_USER_DATA: profile, RUUKOTO_CODE_CONTROL_DIR: control, RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir }, stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', data => fs.appendFileSync(path.join(evidence, 'mygo-stderr.log'), data));
const metadata = { pid: child.pid, profile, control, workspace, sessionId: session.id, workspaceId: session.projectId, rootEntryCount: 30, childEntryCount: 200, runtime: '真实临时 Runtime / ControlServer', model: '本地确定性 MockModelServer', executable };
fs.writeFileSync(path.join(evidence, 'ready.json'), JSON.stringify(metadata, null, 2) + '\n');
process.stdout.write(`File tree QA ready: ${JSON.stringify(metadata)}\n`);
let shuttingDown = false;
const stop = () => { if (!shuttingDown && child.exitCode === null && child.signalCode === null) { shuttingDown = true; child.kill('SIGTERM'); } };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try { await new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); }); }
finally {
  if (flush) clearTimeout(flush);
  writeMeasurements();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await t.shutdown();
  fs.rmSync(control, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  fs.writeFileSync(path.join(evidence, 'cleanup.json'), JSON.stringify({ endedAt: new Date().toISOString(), pid: child.pid, appExitCode: child.exitCode, appSignal: child.signalCode, profileRemoved: !fs.existsSync(profile), controlRemoved: !fs.existsSync(control), runtimeRemoved: !fs.existsSync(t.dirs.root) }, null, 2) + '\n');
}
