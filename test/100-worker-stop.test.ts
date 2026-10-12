/**
 * 停止核实的模拟回归与真实同组进程验证分别覆盖；local 不证明脱离组后代回收。
 * Note: 见 .agents/notes/implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolWorkerHost, WorkerStartError } from "@ruukoto/agent/tool-worker/host.ts";
import { createContainerLauncher, createLocalLauncher, ExecutionError, type LaunchedUnit, type LaunchSpec, type WorkerLauncher } from "@ruukoto/agent/execution/launchers.ts";
import { createManagedProcessRegistry, killProcessGroup } from "@ruukoto/agent/managed-processes.ts";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { ToolRouter } from "@ruukoto/agent/tool-router.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import { CredentialStore } from "@ruukoto/agent/execution/credentials.ts";
import { realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";

const spec: LaunchSpec = { taskId: "worker-stop", mode: "confirm", workspace: process.cwd(), grantedPaths: [] };

function controlledUnit(stop: () => Promise<boolean>, opts: { fatal?: boolean; initError?: boolean } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: string[] = [];
  let exit!: (value: { code: number | null; signal: string | null }) => void;
  const unit: LaunchedUnit = {
    entry: { kind: "process_group", id: "123456", label: "模拟 worker", stop },
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString());
      requests.push(request.type);
      if (request.type === "shutdown") exit({ code: 0, signal: null });
      callback(request.type === "init" && opts.initError ? new ExecutionError("init_write_failed", "模拟 init 写入失败") : undefined);
      if (request.type === "init" && opts.initError) exit({ code: 1, signal: null });
    } }),
    stdout, stderr,
    exit: new Promise(resolve => { exit = resolve; }),
  };
  const launcher: WorkerLauncher = { kind: "local", async launch() {
    setImmediate(() => stdout.write(JSON.stringify(opts.fatal ? { type: "fatal", message: "模拟 ready 失败" } : { type: "ready", pid: 123456 }) + "\n"));
    return unit;
  } };
  return { unit, launcher, requests, finish: () => exit({ code: 0, signal: null }) };
}

test("同一 host 并发与重复停止保留 false，只回收一次", async () => {
  let calls = 0;
  const controlled = controlledUnit(async () => { calls++; return false; });
  const host = await ToolWorkerHost.start(controlled.launcher, spec);
  assert.deepEqual(await Promise.all([host.stop(), host.stop(), host.stop()]), [false, false, false]);
  assert.equal(await host.stop(), false);
  assert.equal(calls, 1);
  assert.equal(host.identity()?.id, controlled.unit.entry.id);
});

for (const outcome of [true, false, "throws"] as const) {
  test(`ready 失败保留单元与停止结论：${outcome}`, async () => {
    let calls = 0;
    const controlled = controlledUnit(async () => {
      calls++;
      if (outcome === "throws") throw new ExecutionError("fake_stop_failed", "模拟停止异常");
      return outcome;
    }, { fatal: true });
    const host = ToolWorkerHost.create(controlled.launcher, spec);
    await assert.rejects(host.start(), { code: "worker_fatal" });
    assert.equal(await host.stop(), outcome === true);
    assert.equal(await host.stop(), outcome === true);
    assert.equal(calls, 1);
    assert.equal(host.identity()?.id, controlled.unit.entry.id);
    if (outcome === "throws") assert.equal(host.stopFailure?.code, "fake_stop_failed");
  });
}

test("尚未创建单元的拒绝无需回收，停止先于 start 时不启动", async () => {
  let launches = 0;
  const launcher: WorkerLauncher = { kind: "local", async launch() {
    launches++;
    throw new ExecutionError("execution_unavailable", "未创建单元");
  } };
  const failed = ToolWorkerHost.create(launcher, spec);
  await assert.rejects(failed.start(), { code: "execution_unavailable" });
  assert.equal(await failed.stop(), true);
  assert.equal(failed.identity(), null);
  const canceled = ToolWorkerHost.create(launcher, spec);
  assert.equal(await canceled.stop(), true);
  await assert.rejects(canceled.start(), { code: "worker_stopped" });
  assert.equal(launches, 1);
});

test("launch 期间停止回收迟到单元，不发送 init 或提供服务", async () => {
  let release!: (unit: LaunchedUnit) => void;
  let calls = 0;
  const controlled = controlledUnit(async () => { calls++; return false; });
  controlled.finish();
  const host = ToolWorkerHost.create({ kind: "local", launch: () => new Promise(resolve => { release = resolve; }) }, spec);
  const start = host.start();
  const rejected = assert.rejects(start, { code: "worker_stopped" });
  await waitFor("launcher 已开始", () => Boolean(release));
  const stop = host.stop();
  release(controlled.unit);
  assert.equal(await stop, false);
  await rejected;
  assert.equal(await host.stop(), false);
  assert.equal(calls, 1);
  assert.ok(!controlled.requests.includes("init"));
});

test("launcher 已产生单元后拒绝保留停止身份", async () => {
  let calls = 0;
  const controlled = controlledUnit(async () => { calls++; return false; });
  controlled.finish();
  const host = ToolWorkerHost.create({ kind: "local", async launch() {
    throw new ExecutionError("launch_failed", "已产生单元后失败", controlled.unit);
  } }, spec);
  await assert.rejects(host.start(), { code: "launch_failed" });
  assert.equal(await host.stop(), false);
  assert.equal(host.identity()?.id, controlled.unit.entry.id);
  assert.equal(calls, 1);
});

test("init 排队写入失败仍核实停止，不交出可服务 host", async () => {
  let calls = 0;
  const controlled = controlledUnit(async () => { calls++; return false; }, { initError: true });
  const host = ToolWorkerHost.create(controlled.launcher, spec);
  await assert.rejects(host.start(), { code: "init_write_failed" });
  assert.equal(await host.stop(), false);
  assert.equal(calls, 1);
});

test("真实原进程组：主进程先退出仍停止同组后代心跳", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-stop-group-"));
  const heartbeat = path.join(root, "heartbeat");
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', ${JSON.stringify("const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20);")}, process.argv[1]], { stdio: 'ignore' });
    descendant.unref();
    setTimeout(()=>process.exit(0),150);
  `, heartbeat], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await waitFor("后代持续写心跳", () => fs.existsSync(heartbeat) && fs.statSync(heartbeat).size >= 3);
    await exited;
    const reaped = await killProcessGroup(pid, { termGraceMs: 100, killGraceMs: 2000 });
    const size = fs.statSync(heartbeat).size;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(fs.statSync(heartbeat).size, size, "核实结果返回后同组后代不能继续写入");
    assert.equal(reaped, true);
  } finally {
    await killProcessGroup(pid, { termGraceMs: 100, killGraceMs: 2000 });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("真实原进程组：短暂查询失败在停止预算内继续核实", { skip: process.platform === "win32" }, async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-stop-query-"));
  const ready = path.join(root, "ready");
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1],'ready'); setInterval(()=>{},20);", ready], { detached: true, stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let queries = 0;
  const execFile = childProcess.execFile;
  context.mock.method(childProcess, "execFile", (_file: string, args: string[], options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
    queries++;
    if (queries <= 2) {
      callback(new Error("模拟两次短暂 ps 查询失败"), "", "");
      return new childProcess.ChildProcess();
    }
    return execFile("/bin/ps", args, options, callback);
  });
  syncBuiltinESMExports();
  try {
    await waitFor("进程组忽略 TERM 后就绪", () => fs.existsSync(ready));
    assert.equal(await killProcessGroup(child.pid!, { termGraceMs: 200, killGraceMs: 500 }), true);
    assert.ok(queries >= 3, "两次短暂失败后仍实际调用宿主 ps 核实");
    await exited;
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await killProcessGroup(child.pid!, { termGraceMs: 0, killGraceMs: 500 });
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const query of ["失败", "输出不完整"] as const) {
  test(`原进程组持续存在且查询${query}：预算耗尽仍保留未核实`, { skip: process.platform === "win32" }, async context => {
    let queries = 0;
    context.mock.method(process, "kill", () => true);
    context.mock.method(childProcess, "execFile", (_file: string, _args: string[], _options: childProcess.ExecFileOptionsWithStringEncoding,
      callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
      queries++;
      callback(query === "失败" ? new Error("模拟 ps 查询失败") : null, query === "输出不完整" ? "incomplete\n" : "", "");
      return new childProcess.ChildProcess();
    });
    syncBuiltinESMExports();
    try {
      assert.equal(await killProcessGroup(123456, { termGraceMs: 20, killGraceMs: 20 }), false);
      assert.ok(queries >= 2, "两个停止阶段都收到指定的失败回执");
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

test("停止预算：查询超时与休眠受剩余预算限制，耗尽后不再发 ps", async context => {
  let now = 0;
  const queries: Array<{ at: number; timeout: number | undefined }> = [];
  const sleeps: number[] = [];
  const schedule = globalThis.setTimeout;
  context.mock.method(process, "kill", () => true);
  context.mock.method(Date, "now", () => now);
  context.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    sleeps.push(delay);
    now += delay;
    return schedule(callback, 0);
  });
  context.mock.method(childProcess, "execFile", (_file: string, _args: string[], options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
    queries.push({ at: now, timeout: options.timeout });
    if (queries.length === 1) now += 5;
    callback(null, "incomplete\n", "");
    return new childProcess.ChildProcess();
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await killProcessGroup(123456, { termGraceMs: 20, killGraceMs: 0 }), false);
    assert.deepEqual(queries, [{ at: 0, timeout: 20 }, { at: 20, timeout: 1 }], "TERM 预算耗尽后只保留 KILL 的首次核实");
    assert.deepEqual(sleeps, [15], "休眠只使用剩余预算");
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

for (const result of ["ESRCH", "僵尸", "查询失败"] as const) {
  test(`零停止预算仍核实首次结果：${result}`, async context => {
    let now = 0;
    const timeouts: Array<number | undefined> = [];
    context.mock.method(Date, "now", () => now);
    context.mock.method(process, "kill", (_pid: number, signal: string | number) => {
      if (signal === 0 && result === "ESRCH") throw Object.assign(new Error("模拟原组已消失"), { code: "ESRCH" });
      return true;
    });
    context.mock.method(childProcess, "execFile", (_file: string, _args: string[], options: childProcess.ExecFileOptionsWithStringEncoding,
      callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
      timeouts.push(options.timeout);
      now += 5;
      callback(result === "查询失败" ? new Error("模拟查询失败") : null, "123456 Z\n", "");
      return new childProcess.ChildProcess();
    });
    syncBuiltinESMExports();
    try {
      assert.equal(await killProcessGroup(123456, { termGraceMs: 0, killGraceMs: 0 }), result !== "查询失败");
      assert.deepEqual(timeouts, result === "ESRCH" ? [] : result === "僵尸" ? [1] : [1, 1]);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}


test("静态 start 失败交出可核实的宿主记录与原错误", async () => {
  const controlled = controlledUnit(async () => false, { fatal: true });
  let failure: unknown;
  try { await ToolWorkerHost.start(controlled.launcher, spec); } catch (error) { failure = error; }
  assert.ok(failure instanceof WorkerStartError);
  assert.equal(failure.code, "worker_fatal");
  assert.ok(failure.cause instanceof ExecutionError);
  assert.equal(await failure.host.stop(), false);
});

function routerKit(launcher: WorkerLauncher) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-router-stop-")));
  const db = new Db(root);
  const store = new Store(db);
  const project = store.createProject("worker-stop");
  const stat = fs.statSync(root);
  const session = store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "test", confirmTools: [] });
  const { task } = store.insertQueuedTask({ sessionId: session.id, requestId: "start", input: "停止回归", modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, submissionDigest: "start" });
  const registry = createManagedProcessRegistry();
  const router = new ToolRouter({ store, registry, ledger: new ToolOpLedger(store), artifacts: new ArtifactStore(root, store), credentials: new CredentialStore(root), launcherFor: () => launcher, protectedRoots: [], approvals: { request: async () => { throw new ExecutionError("approval_unused", "本用例不请求审批"); }, supersedeAll() {} } });
  const run = () => router.executeTool({ task, hostOpId: "op", sdkCallId: "call", name: "read", params: { path: "file" } });
  return { store, task, router, registry, run, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("router 的 starting 与实际登记保留 ready 失败，不重建未知退出单元", async () => {
  let launches = 0;
  const controlled = controlledUnit(async () => false, { fatal: true });
  const kit = routerKit({ kind: "local", async launch(spec) { launches++; return controlled.launcher.launch(spec); } });
  try {
    assert.equal((await kit.run()).isError, true);
    assert.deepEqual(await Promise.all(kit.registry.list().map(entry => entry.stop())), [false, false]);
    assert.equal(await kit.router.stopWorker(), false);
    assert.equal((await kit.run()).isError, true);
    assert.equal(launches, 1);
    assert.equal(kit.router.workerIdentity()?.id, controlled.unit.entry.id);
    await assert.rejects(kit.router.prepareToolBoundary({ ...kit.task, pendingAccessMode: "full_access" }), { code: "mode_switch_unverified" });
    assert.equal(kit.store.getTask(kit.task.id)?.accessMode, "confirm");
  } finally { kit.close(); }
});

test("router 在 launch 前登记；启动期间取消不会安装迟到 worker", async () => {
  let release!: (unit: LaunchedUnit) => void;
  const controlled = controlledUnit(async () => true);
  const kit = routerKit({ kind: "local", launch: () => new Promise(resolve => { release = resolve; }) });
  try {
    const result = kit.run();
    assert.equal(kit.registry.list()[0]?.kind, "starting");
    await waitFor("启动器进入启动窗口", () => Boolean(release));
    const stopped = kit.registry.list()[0].stop();
    release(controlled.unit);
    assert.equal(await stopped, true);
    assert.equal((await result).isError, true);
    assert.equal(kit.router.workerIdentity(), null);
    assert.ok(!controlled.requests.includes("init"));
  } finally { kit.close(); }
});

for (const queried of [true, false]) {
  test(`容器停止只接受成功查询的缺失证据：查询成功=${queried}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-stop-docker-"));
    const cli = path.join(root, "docker");
    fs.writeFileSync(cli, `#!/usr/bin/env node
if(process.argv[2]==='run') {
  process.stdout.write(JSON.stringify({type:'ready',pid:process.pid})+'\\n');
  process.stdin.on('data',data=>{if(String(data).includes('shutdown'))process.exit(0)});
} else if(process.argv[2]==='ps')process.exit(${queried ? 0 : 1});
`, { mode: 0o755 });
    try {
      const host = await ToolWorkerHost.start(createContainerLauncher({ dockerPath: cli, image: "mock", uid: 1000, gid: 1000 }), spec);
      assert.equal(await host.stop(), queried);
      assert.equal(await host.stop(), queried);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const reaped of [true, false, null]) {
  test(`完全访问同时核实命令组与 worker 组：命令组结论=${reaped}`, async () => {
    const controlled = controlledUnit(async () => true);
    const host = await ToolWorkerHost.start(controlled.launcher, { ...spec, mode: "full_access" });
    if (reaped !== null) controlled.unit.stdout.emit("data", JSON.stringify({ type: "stopped", reaped }) + "\n");
    assert.equal(await host.stop(), reaped === true);
    assert.equal(await host.stop(), reaped === true);
    if (reaped !== true) assert.equal(host.stopFailure?.code, "worker_stop_unverified");
  });
}

test("内置启动器 spawn 拒绝保留原 code，未创建单元无需停止", async () => {
  const host = ToolWorkerHost.create(createContainerLauncher({ dockerPath: "ruukoto-missing-docker-stop-test", image: "mock", uid: 1000, gid: 1000 }), spec);
  await assert.rejects(host.start(), { code: "execution_unavailable" });
  assert.equal(host.identity(), null);
  assert.equal(await host.stop(), true);
});

test("start 与已取消调用不重复启动或发送工具帧", async () => {
  let launches = 0;
  const controlled = controlledUnit(async () => true);
  const host = ToolWorkerHost.create({ kind: "local", launch(spec) { launches++; return controlled.launcher.launch(spec); } }, spec);
  const first = host.start();
  assert.equal(host.start(), first);
  await first;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(host.call({ opId: "canceled", sdkCallId: "call", name: "bash", params: { command: "write" }, signal: controller.signal }), { code: "tool_aborted" });
  assert.ok(!controlled.requests.includes("tool_call"));
  assert.equal(await host.stop(), true);
  assert.equal(launches, 1);
});

test("router 每次启动使用独立 starting 身份", async () => {
  const kit = routerKit({ kind: "local", launch: spec => controlledUnit(async () => true, { fatal: true }).launcher.launch(spec) });
  try {
    assert.equal((await kit.run()).isError, true);
    assert.equal((await kit.run()).isError, true);
    const starting = kit.registry.list().filter(entry => entry.kind === "starting");
    assert.equal(starting.length, 2);
    assert.notEqual(starting[0].id, starting[1].id);
    assert.deepEqual(await Promise.all(kit.registry.list().map(entry => entry.stop())), [true, true, true]);
  } finally { kit.close(); }
});


test("launcher 同步抛错也保留已产生的单元", async () => {
  const controlled = controlledUnit(async () => false);
  controlled.finish();
  const host = ToolWorkerHost.create({ kind: "local", launch() {
    throw new ExecutionError("launch_failed", "同步启动失败", controlled.unit);
  } }, spec);
  await assert.rejects(host.start(), { code: "launch_failed" });
  assert.equal(host.identity()?.id, controlled.unit.entry.id);
  assert.equal(await host.stop(), false);
});


for (const failure of ["false", "throw"] as const) {
  test(`Runtime 实际 SDK 的 ready 失败：stop ${failure} 保留终态、原因与父目录占用`, async () => {
    let stops = 0;
    let launches = 0;
    const controlled = controlledUnit(async () => {
      stops++;
      if (failure === "throw") throw new ExecutionError("fake_stop_failed", "模拟启动后停止异常");
      return false;
    }, { fatal: true });
    const t = await startTestRuntime(`ready-unreaped-${failure}`, request => {
      if (!request.messages.some(message => message.role === "tool")) {
        return { kind: "tool_calls", calls: [{ id: "startup-bash", name: "bash", arguments: { command: "echo forbidden > must-not-exist" } }] };
      }
      return { kind: "text", text: "执行环境不可用，已收到工具失败结果" };
    }, { workDirs: 1, config: realTools() });
    const originalLauncher = t.runtime.launcherFor;
    t.runtime.launcherFor = () => ({ kind: "local", launch(spec) { launches++; return controlled.launcher.launch(spec); } });
    try {
      const session = await t.runtime.createSession({ projectName: "ready-stop", cwd: t.work[0] });
      const driver = await t.runtime["getDriver"](session);
      const replayFrom = t.runtime.store.getMaxSeq();
      const parent = await t.runtime.submit({ sessionId: session.id, requestId: "parent", input: "启动工具工作进程", accessMode: "full_access", modelSelection: t.runtime.defaultSelection });
      await waitFor("父任务已收到工具启动失败并完成", () => t.runtime.store.getTask(parent.id)!.status === "completed");
      const completed = t.runtime.store.getTask(parent.id)!;
      assert.equal(completed.effectUnknown, false, "没有命令帧，已知的启动失败不变成效果未知");
      const ops = t.runtime.store.listToolOpsByTask(parent.id);
      assert.equal(ops.length, 1);
      assert.equal(ops[0].toolName, "bash");
      assert.equal(ops[0].isError, true);
      assert.match(ops[0].resultSummary!, /模拟 ready 失败/);
      assert.ok(!controlled.requests.includes("init"));
      assert.ok(!controlled.requests.includes("tool_call"));
      assert.equal(fs.existsSync(path.join(t.work[0], "must-not-exist")), false);
      const events = t.runtime.store.getTaskEventsAfter(parent.id, 0, 100);
      assert.equal(events.filter(event => event.body.type === "task.completed").length, 1);
      const unreaped = events.filter(event => event.body.type === "task.tool_process_unreaped");
      assert.equal(unreaped.length, 1);
      assert.ok(unreaped[0].body.type === "task.tool_process_unreaped" && unreaped[0].body.reason === "tool_process_unreaped");
      assert.deepEqual(t.runtime.store.getOccupancyByDir(session.cwdReal), { taskId: parent.id, sessionId: session.id });
      assert.equal(t.runtime.snapshot().tasks.find(task => task.id === parent.id)?.status, "completed");
      const reconnect = await t.client.handshake(replayFrom);
      assert.equal(reconnect.snapshot.tasks.find(task => task.id === parent.id)?.status, "completed");
      assert.ok(reconnect.replay.some(event => event.body.type === "task.tool_process_unreaped" && event.taskId === parent.id));
      const blockedSession = await t.runtime.createSession({ projectName: "same-ready-stop-dir", cwd: t.work[0] });
      const blocked = await t.runtime.submit({ sessionId: blockedSession.id, requestId: "blocked", input: "同目录后续任务", modelSelection: t.runtime.defaultSelection });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(t.runtime.store.getTask(blocked.id)!.status, "queued");
      assert.equal(t.server.calls.length, 2, "启动失败后仅消费一次工具结果，同目录任务不调用模型");
      assert.equal(launches, 1);
      assert.equal(await driver.stopManagedProcesses(parent.id), false);
      assert.equal(await driver.stopManagedProcesses(parent.id), false);
      assert.equal(stops, 1);
      assert.equal(t.runtime.store.getOccupancyByDir(session.cwdReal)?.taskId, parent.id);
      assert.equal(t.runtime.store.getTaskEventsAfter(parent.id, 0, 100).filter(event => event.body.type === "task.tool_process_unreaped").length, 1);
    } finally {
      t.runtime.launcherFor = originalLauncher;
      await t.shutdown();
    }
  });
}

test("拥有者同进程核实恢复后使用新 worker，旧停止失败与命令不重放", async () => {
  let oldStops = 0;
  let modelCalls = 0;
  const controlled = controlledUnit(async () => { oldStops++; return false; }, { fatal: true });
  const t = await startTestRuntime("ready-owner-resume", () => {
    modelCalls++;
    if (modelCalls === 1 || modelCalls === 3) {
      return { kind: "tool_calls", calls: [{ id: `resume-bash-${modelCalls}`, name: "bash", arguments: { command: modelCalls === 1 ? "echo old > old-marker" : "echo repaired > new-marker" } }] };
    }
    return { kind: "text", text: "已收到工具结果" };
  }, { workDirs: 1, config: { ...realTools(), execution: { backend: "local" } } });
  const originalLauncher = t.runtime.launcherFor;
  t.runtime.launcherFor = () => controlled.launcher;
  try {
    const session = await t.runtime.createSession({ projectName: "owner-resume", cwd: t.work[0] });
    const originalDriver = await t.runtime["getDriver"](session);
    const old = await t.runtime.submit({ sessionId: session.id, requestId: "old", input: "第一次启动失败", accessMode: "full_access", modelSelection: t.runtime.defaultSelection });
    await waitFor("旧任务终态仍持有未核实占用", () => t.runtime.store.getTask(old.id)!.status === "completed");
    assert.equal(t.runtime.store.getOccupancyByDir(session.cwdReal)?.taskId, old.id);
    assert.equal(await originalDriver.stopManagedProcesses(old.id), false);
    t.runtime.launcherFor = originalLauncher;
    await t.runtime.resumeQueue(session.id);
    const next = await t.runtime.submit({ sessionId: session.id, requestId: "new", input: "核实后执行新命令", accessMode: "full_access", modelSelection: t.runtime.defaultSelection });
    await waitFor("新任务完成", () => t.runtime.store.getTask(next.id)!.status === "completed");
    assert.equal(fs.existsSync(path.join(t.work[0], "new-marker")), true, "恢复后的新任务必须能建立新 worker 执行");
    assert.equal(fs.readFileSync(path.join(t.work[0], "new-marker"), "utf8").trim(), "repaired");
    assert.equal(t.runtime.store.getOccupancyByDir(session.cwdReal), null);
    assert.equal(t.runtime.store.listToolOpsByTask(next.id)[0].isError, false);
    assert.equal(fs.existsSync(path.join(t.work[0], "old-marker")), false, "核实恢复不重放旧命令");
    assert.ok(!controlled.requests.includes("tool_call"));
    assert.equal(await originalDriver.stopManagedProcesses(old.id), false, "拥有者核实不改写旧执行记录的停止事实");
    assert.equal(oldStops, 1);
    assert.equal(modelCalls, 4);
    assert.equal(t.runtime.store.getTaskEventsAfter(old.id, 0, 100).filter(event => event.body.type === "task.tool_process_unreaped").length, 1);
    assert.equal(t.runtime.store.getTaskEventsAfter(next.id, 0, 100).filter(event => event.body.type === "task.tool_process_unreaped").length, 0);
  } finally {
    t.runtime.launcherFor = originalLauncher;
    await t.shutdown();
  }
});

test("真实完全访问 worker 停止独立 Shell 组及忽略 TERM 的同组后代", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-full-stop-"));
  const heartbeat = path.join(root, "heartbeat");
  const host = await ToolWorkerHost.start(createLocalLauncher(), { ...spec, workspace: root, mode: "full_access" });
  try {
    const child = "const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20)";
    const command = `"${process.execPath}" -e '${child.replaceAll("'", "'\\''")}' '${heartbeat}' & wait`;
    const call = host.call({ opId: "descendant", sdkCallId: "descendant", name: "bash", params: { command } });
    void call.catch(() => undefined);
    await waitFor("后代心跳开始", () => fs.existsSync(heartbeat) && fs.statSync(heartbeat).size >= 3);
    assert.equal(await host.stop(), true);
    await assert.rejects(call, { code: "worker_stopped" });
    const size = fs.statSync(heartbeat).size;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.statSync(heartbeat).size, size);
  } finally {
    await host.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
