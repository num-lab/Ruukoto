import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import type { Task } from "@ruukoto/core/types.ts";
import type { AgentReferenceSnapshot } from "@ruukoto/core/agent-wait.ts";
import {
  claimBackgroundLaunch, closeSessionBackgroundBarrier, findBackgroundProcessByOp, finishBackgroundStop,
  getBackgroundProcess, handoffBackgroundProcess, latestBackgroundReferenceSnapshot, listActiveBackgroundProcesses,
  pageBackgroundProcesses, registerBackgroundProcess, requestBackgroundStop, updateBackgroundObserved,
} from "@ruukoto/core/background-processes.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-background-core-"));
  const db = new Db(root), store = new Store(db);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = store.withTx(() => store.createProject("background"));
  const session = store.withTx(() => store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: 1, piSessionId: "pi", confirmTools: [] }));
  const workspace = { path: root, dev: 1, ino: 1 };
  let index = 0;
  const queued = () => store.withTx(() => store.insertQueuedTask({ sessionId: session.id, requestId: `request-${++index}`, input: "启动本地服务", accessMode: "full_access", grantedPaths: [], submissionDigest: "test", modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" } })).task;
  function activate(task: Task): Task {
    store.withTx(() => {
      store.transitionTask(task.id, ["queued"], "running");
      assert.equal(store.tryAcquireOccupancy({ cwdReal: root, cwdDev: 1, cwdIno: 1, sessionId: session.id, taskId: task.id }), true);
    });
    return store.getTask(task.id)!;
  }
  function register(task: Task, command = "node server.mjs") {
    const hostOpId = `op-${task.id}`;
    store.withTx(() => store.recordToolIntent({ id: hostOpId, taskId: task.id, sessionId: session.id, toolName: "process_start", params: { command } }));
    return store.withTx(() => registerBackgroundProcess(store, { taskId: task.id, sessionId: session.id, hostOpId, workspace, ref: { platform: "darwin", executionId: task.id } }));
  }
  const snapshot = (task: Task): AgentReferenceSnapshot => ({ taskId: task.id, permissionVersion: task.permissionVersion, selectionRecordId: null, promptArtifactId: null, instructions: { text: "已记录指令", version: "v1", problems: [] }, skills: null });
  return { db, store, session, workspace, queued, activate, register, snapshot };
}

test("后台目录交接与观测阶段同事务，Task终态和恢复释放不能清除独立占用", t => {
  const f = fixture(t), task = f.activate(f.queued()), process = f.register(task), snapshot = f.snapshot(task);
  const { store, db } = f, seq = store.getMaxSeq();
  db.exec("CREATE TRIGGER reject_phase BEFORE INSERT ON events WHEN json_extract(NEW.body, '$.type') = 'task.resources_changed' BEGIN SELECT RAISE(ABORT, 'phase failure'); END");
  assert.throws(() => store.withTx(() => handoffBackgroundProcess(store, { processId: process.id, snapshot, workspace: f.workspace })), /phase failure/);
  assert.deepEqual(store.getOccupancyByDir(f.workspace.path), { taskId: task.id, sessionId: f.session.id });
  assert.equal(getBackgroundProcess(store, process.id)!.handedOff, false);
  assert.equal(store.getMaxSeq(), seq);
  db.exec("DROP TRIGGER reject_phase");
  db.exec("CREATE TRIGGER reject_gap BEFORE DELETE ON occupancy BEGIN SELECT RAISE(ABORT, 'occupancy gap'); END");
  store.withTx(() => handoffBackgroundProcess(store, { processId: process.id, snapshot, workspace: f.workspace }));
  db.exec("DROP TRIGGER reject_gap");
  assert.deepEqual(store.getOccupancyByDir(f.workspace.path), { taskId: null, processId: process.id, sessionId: f.session.id });
  assert.throws(() => db.prepare("UPDATE occupancy SET task_id = ? WHERE process_id = ?").run(task.id, process.id), /CHECK constraint failed/);
  assert.equal(store.findBlockingOccupancy(path.join(f.workspace.path, "child"), 1, 2)?.processId, process.id);
  assert.deepEqual(latestBackgroundReferenceSnapshot(store, f.session.id), snapshot);
  assert.equal(store.withTx(() => claimBackgroundLaunch(store, process.id, "a".repeat(64))), true);
  store.withTx(() => updateBackgroundObserved(store, { processId: process.id, state: "running" }));
  store.withTx(() => store.endTask(task.id, ["running"], "completed"));
  assert.equal(store.withTx(() => store.releaseOccupancy(task.id)), false);
  assert.equal(store.withTx(() => store.releaseOccupancyForDir(task.id, f.workspace.path)), false);
  assert.equal(store.listAllOccupancy()[0].processId, process.id);
  const phase = store.getEventsAfter(seq).find(event => event.body.type === "task.resources_changed");
  assert.ok(phase && phase.body.type === "task.resources_changed" && phase.body.phase === "conversation");
});

test("启动只持久认领一次，退出观察不释放占用，停止失败保留到真实核实", t => {
  const f = fixture(t), task = f.activate(f.queued()), process = f.register(task), { store } = f;
  assert.throws(() => store.withTx(() => claimBackgroundLaunch(store, process.id)), { code: "background_not_ready" });
  store.withTx(() => handoffBackgroundProcess(store, { processId: process.id, snapshot: f.snapshot(task), workspace: f.workspace }));
  assert.equal(store.withTx(() => claimBackgroundLaunch(store, process.id, "b".repeat(64))), true);
  assert.equal(store.withTx(() => claimBackgroundLaunch(store, process.id, "b".repeat(64))), false);
  assert.throws(() => store.withTx(() => claimBackgroundLaunch(store, process.id, "c".repeat(64))), { code: "request_conflict" });
  store.withTx(() => updateBackgroundObserved(store, { processId: process.id, state: "running", exit: { code: 0, signal: null } }));
  assert.equal(getBackgroundProcess(store, process.id)!.stopVerified, false);
  assert.equal(store.listAllOccupancy().length, 1);
  store.withTx(() => requestBackgroundStop(store, process.id, "owner_stop"));
  store.withTx(() => updateBackgroundObserved(store, { processId: process.id, state: "running" }));
  assert.equal(getBackgroundProcess(store, process.id)!.state, "stop_requested");
  store.withTx(() => finishBackgroundStop(store, { processId: process.id, verified: false, reason: "identity_unknown" }));
  assert.equal(getBackgroundProcess(store, process.id)!.state, "stop_unverified");
  assert.equal(store.listAllOccupancy().length, 1);
  store.withTx(() => requestBackgroundStop(store, process.id, "owner_recheck"));
  f.db.exec("CREATE TRIGGER reject_stop_event BEFORE INSERT ON events WHEN json_extract(NEW.body, '$.type') = 'background_process.changed' BEGIN SELECT RAISE(ABORT, 'stop event failure'); END");
  assert.throws(() => store.withTx(() => finishBackgroundStop(store, { processId: process.id, verified: true, reason: null })), /stop event failure/);
  assert.equal(store.listAllOccupancy().length, 1);
  assert.equal(getBackgroundProcess(store, process.id)!.state, "stop_requested");
  f.db.exec("DROP TRIGGER reject_stop_event");
  store.withTx(() => finishBackgroundStop(store, { processId: process.id, verified: true, reason: null }));
  assert.equal(store.listAllOccupancy().length, 0);
  assert.equal(latestBackgroundReferenceSnapshot(store, f.session.id), null);
  assert.deepEqual(getBackgroundProcess(store, process.id)!.exit, { code: 0, signal: null });
  assert.equal(listActiveBackgroundProcesses(store).length, 0);
});

test("关闭屏障截住已接纳但尚未登记的旧Task，同请求重取不停止后来新执行", t => {
  const f = fixture(t), first = f.activate(f.queued()), process = f.register(first), queuedBeforeClose = f.queued(), { store } = f;
  const closed = store.withTx(() => closeSessionBackgroundBarrier(store, { sessionId: f.session.id, requestKey: "close-1" }));
  assert.deepEqual(closed.processIds, [process.id]);
  assert.equal(getBackgroundProcess(store, process.id)!.state, "stop_requested");
  assert.throws(() => store.withTx(() => handoffBackgroundProcess(store, { processId: process.id, snapshot: f.snapshot(first), workspace: f.workspace })), { code: "background_closed" });
  store.withTx(() => finishBackgroundStop(store, { processId: process.id, verified: true, reason: null }));
  assert.equal(store.getOccupancyByDir(f.workspace.path)?.taskId, first.id, "交接前停止保留原Task占用");
  store.withTx(() => store.endTask(first.id, ["running"], "completed"));
  f.activate(queuedBeforeClose);
  assert.throws(() => f.register(queuedBeforeClose), { code: "background_closed" });
  store.withTx(() => store.endTask(queuedBeforeClose.id, ["running"], "completed"));
  const later = f.activate(f.queued()), next = f.register(later);
  assert.deepEqual(store.withTx(() => closeSessionBackgroundBarrier(store, { sessionId: f.session.id, requestKey: "close-1" })), closed);
  assert.equal(getBackgroundProcess(store, next.id)!.state, "starting");
});

test("启动来源、权限、取消与根占用在交接前重核", async t => {
  for (const mutation of ["restricted", "plan", "canceled", "permissions", "missing-occupancy", "snapshot"] as const) await t.test(mutation, t => {
    const f = fixture(t), task = f.activate(f.queued()), { store } = f;
    if (mutation === "restricted") {
      f.db.prepare("UPDATE tasks SET access_mode = 'confirm' WHERE id = ?").run(task.id);
      assert.throws(() => f.register(task), { code: "background_source_invalid" });
      return;
    }
    if (mutation === "plan") {
      f.db.prepare("UPDATE tasks SET plan_mode = 1 WHERE id = ?").run(task.id);
      assert.throws(() => f.register(task), { code: "background_source_invalid" });
      return;
    }
    const process = f.register(task);
    if (mutation === "canceled") f.db.prepare("UPDATE tasks SET cancel_requested = 1 WHERE id = ?").run(task.id);
    if (mutation === "permissions") f.db.prepare("UPDATE tasks SET permission_version = permission_version + 1 WHERE id = ?").run(task.id);
    if (mutation === "missing-occupancy") store.withTx(() => store.releaseOccupancy(task.id));
    const snapshot = f.snapshot(task);
    if (mutation === "snapshot") snapshot.permissionVersion++;
    assert.throws(() => store.withTx(() => handoffBackgroundProcess(store, { processId: process.id, snapshot, workspace: f.workspace })), {
      code: mutation === "snapshot" ? "background_not_ready" : mutation === "missing-occupancy" ? "background_occupied" : "background_source_invalid",
    });
    assert.equal(getBackgroundProcess(store, process.id)!.handedOff, false);
  });
});

test("同操作返回原记录，一个会话只容一个未核实执行，输出计数单调且有界", t => {
  const f = fixture(t), task = f.activate(f.queued()), process = f.register(task), { store } = f;
  assert.equal(findBackgroundProcessByOp(store, process.hostOpId)!.id, process.id);
  assert.equal(store.withTx(() => registerBackgroundProcess(store, { taskId: task.id, sessionId: f.session.id, hostOpId: process.hostOpId, workspace: f.workspace, ref: process.ref })).id, process.id);
  store.withTx(() => store.recordToolIntent({ id: "second-op", taskId: task.id, sessionId: f.session.id, toolName: "process_start", params: { command: "second" } }));
  assert.throws(() => store.withTx(() => registerBackgroundProcess(store, { taskId: task.id, sessionId: f.session.id, hostOpId: "second-op", workspace: f.workspace, ref: process.ref })), { code: "background_occupied" });
  store.withTx(() => updateBackgroundObserved(store, { processId: process.id, stdoutBytes: 11, stderrBytes: 13, partial: true }));
  store.withTx(() => updateBackgroundObserved(store, { processId: process.id, partial: false }));
  assert.equal(getBackgroundProcess(store, process.id)!.partial, true);
  assert.throws(() => store.withTx(() => updateBackgroundObserved(store, { processId: process.id, stdoutBytes: 10 })), { code: "invalid_params" });
  assert.throws(() => store.withTx(() => updateBackgroundObserved(store, { processId: process.id, stderrBytes: 16 * 1024 * 1024 })), { code: "invalid_params" });
  assert.throws(() => store.withTx(() => updateBackgroundObserved(store, { processId: process.id, launchFingerprint: "bad" })), { code: "invalid_params" });
  const logEvidence = { stdout: { dev: 1, ino: 7, sha256: "a".repeat(64) }, stderr: { dev: 1, ino: 8, sha256: "b".repeat(64) } };
  store.withTx(() => updateBackgroundObserved(store, { processId: process.id, logEvidence }));
  assert.deepEqual(getBackgroundProcess(store, process.id)!.logEvidence, logEvidence);
  assert.throws(() => store.withTx(() => updateBackgroundObserved(store, { processId: process.id, logEvidence: { ...logEvidence, stdout: { ...logEvidence.stdout, ino: 9 } } })), { code: "invalid_params" });
  assert.equal("logEvidence" in pageBackgroundProcesses(store, { sessionId: f.session.id }).processes[0], false);
});

test("历史状态按20条分页，损坏JSON或索引反链拒绝读取", t => {
  const f = fixture(t), task = f.activate(f.queued()), { store } = f;
  for (let index = 0; index < 23; index++) {
    const hostOpId = `history-${index}`;
    store.withTx(() => store.recordToolIntent({ id: hostOpId, taskId: task.id, sessionId: f.session.id, toolName: "process_start", params: { command: `echo ${index}` } }));
    const process = store.withTx(() => registerBackgroundProcess(store, { taskId: task.id, sessionId: f.session.id, hostOpId, workspace: f.workspace, ref: { platform: "linux", executionId: hostOpId } }));
    store.withTx(() => finishBackgroundStop(store, { processId: process.id, verified: true, reason: null }));
  }
  const first = pageBackgroundProcesses(store, { sessionId: f.session.id });
  assert.equal(first.totalCount, 23);
  assert.equal(first.processes.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.processes[0].command, "echo 22");
  const second = pageBackgroundProcesses(store, { sessionId: f.session.id, offset: first.nextOffset! });
  assert.equal(second.processes.length, 3);
  assert.equal(second.nextOffset, null);
  assert.throws(() => pageBackgroundProcesses(store, { sessionId: f.session.id, offset: -1 }), { code: "invalid_params" });
  f.db.prepare("UPDATE background_processes SET payload = json_set(payload, '$.sessionId', 'unrelated') WHERE id = ?").run(first.processes[0].id);
  assert.throws(() => getBackgroundProcess(store, first.processes[0].id), { code: "background_corrupt" });
});

test("最坏JSON转义命令按字节收窄状态页，nextOffset遍历无漏无重", t => {
  const f = fixture(t), task = f.activate(f.queued()), { store } = f;
  for (let index = 0; index < 20; index++) {
    const hostOpId = `escaped-${index}`, command = "\u0001".repeat(16384);
    store.withTx(() => store.recordToolIntent({ id: hostOpId, taskId: task.id, sessionId: f.session.id, toolName: "process_start", params: { command } }));
    const process = store.withTx(() => registerBackgroundProcess(store, { taskId: task.id, sessionId: f.session.id, hostOpId, workspace: f.workspace, ref: { platform: "darwin", executionId: hostOpId } }));
    store.withTx(() => finishBackgroundStop(store, { processId: process.id, verified: true, reason: null }));
  }
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = pageBackgroundProcesses(store, { sessionId: f.session.id, offset });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
    assert.equal(page.totalCount, 20);
    for (const process of page.processes) { assert.equal(seen.has(process.id), false); seen.add(process.id); }
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.equal(seen.size, 20);
});


test("状态页预算计入响应容器、分隔符和游标", t => {
  const f = fixture(t), task = f.activate(f.queued()), { store } = f;
  for (let index = 0; index < 3; index++) {
    const hostOpId = `budget-${index}`;
    store.withTx(() => store.recordToolIntent({ id: hostOpId, taskId: task.id, sessionId: f.session.id, toolName: "process_start", params: { command: "x" } }));
    const process = store.withTx(() => registerBackgroundProcess(store, { taskId: task.id, sessionId: f.session.id, hostOpId, workspace: f.workspace, ref: { platform: "darwin", executionId: hostOpId } }));
    store.withTx(() => finishBackgroundStop(store, { processId: process.id, verified: true, reason: null }));
  }
  const records = pageBackgroundProcesses(store, { sessionId: f.session.id }).processes;
  let remaining = 256 * 1024 - 8;
  for (let index = 0; index < records.length; index++) {
    const row = records[index], overhead = Buffer.byteLength(JSON.stringify(row)) - 1;
    const length = index < 2 ? 98304 : remaining - overhead;
    const payload = getBackgroundProcess(store, row.id)!;
    payload.command = "\u0001".repeat(Math.floor(length / 6)) + "x".repeat(length % 6);
    store.db.prepare("UPDATE background_processes SET payload = ? WHERE id = ?").run(JSON.stringify(payload), row.id);
    remaining -= overhead + length;
  }
  const first = pageBackgroundProcesses(store, { sessionId: f.session.id });
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 256 * 1024);
  assert.equal(first.processes.length, 2);
  assert.equal(first.nextOffset, 2);
  const second = pageBackgroundProcesses(store, { sessionId: f.session.id, offset: first.nextOffset! });
  assert.equal(second.processes.length, 1);
  assert.equal(second.nextOffset, null);
});
