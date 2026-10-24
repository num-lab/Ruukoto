import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { workCopyHostFor } from "@ruukoto/core/work-copy-host.ts";
import { holdParentResponse } from "./helpers/active-parent.ts";
import { controlledWorkCopy } from "./helpers/controlled-work-copy.ts";
import { realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";

test("普通捕获独立宿主任务借持源占用，账本与停止身份不写父任务或新模型会话", async () => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "完成" }));
  const t = await startTestRuntime("ordinary-host", gate.responder, { config: realTools() });
  const controlled = controlledWorkCopy(async () => true, "snapshot-result");
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "宿主捕获", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始捕获", modelSelection: rt.defaultSelection });
    await waitFor("父任务实际执行", () => rt.store.getTask(parent.id)!.status === "running" && t.server.calls.length > 0);
    const calls = t.server.calls.length, sessions = rt.store.listSessions().length;
    const copyDir = fs.realpathSync(t.work[1]), sourceStat = fs.statSync(session.cwdReal);
    rt.launcherFor = () => controlled.launcher;
    const result = await rt.executeWorkCopy({ parentTaskId: parent.id, workId: "probe", operation: "capture",
      source: { path: session.cwdReal, dev: sourceStat.dev, ino: sourceStat.ino }, workspace: copyDir, copyDir, branch: "probe",
      command: "capture", extraGrants: [{ path: session.cwdReal, access: "read", purpose: "捕获来源" }] });
    assert.equal(result.content, "snapshot-result");
    const host = rt.store.listTasksBySession(session.id).find(task => task.readScope?.workCopyHost)!;
    assert.notEqual(host.id, parent.id);
    assert.equal(host.parentTaskId, parent.id);
    assert.equal(host.modelSelection, null);
    assert.equal(host.subAgentId, null);
    assert.equal(host.workId, null);
    assert.equal(host.status, "completed");
    assert.equal(workCopyHostFor(host)!.stopVerified, true);
    assert.ok(workCopyHostFor(host)!.units.some(unit => unit.id === "controlled-work-copy"));
    assert.deepEqual(rt.store.listToolOpsByTask(host.id).map(op => op.toolName), ["worktree_start", "worktree_capture"]);
    assert.equal(rt.store.listToolOpsByTask(parent.id).length, 0);
    assert.equal(rt.store.getOccupancyByDir(session.cwdReal)?.taskId, parent.id);
    assert.equal(rt.store.getOccupancyByDir(copyDir), null);
    assert.equal(rt.store.listSessions().length, sessions);
    assert.equal(t.server.calls.length, calls);
    rt.store.withTx(() => rt.store.db.prepare("UPDATE tasks SET status = 'interrupted' WHERE id = ?").run(host.id));
    await assert.rejects(rt.continueTask({ taskId: host.id, requestId: "continue", input: "不能继续宿主操作", modelSelection: rt.defaultSelection }), { code: "invalid_state" });
  } finally { gate.release(); controlled.finish(); await t.shutdown(); }
});

test("捕获停止未核实独立保留副本占用，父任务保留来源；拥有者恢复后核实宿主停止", async () => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "完成" }));
  const t = await startTestRuntime("ordinary-host-stop", gate.responder, { config: realTools() });
  const controlled = controlledWorkCopy(async () => false, "captured");
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "宿主停止", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始捕获", modelSelection: rt.defaultSelection });
    await waitFor("父任务实际执行", () => rt.store.getTask(parent.id)!.status === "running" && t.server.calls.length > 0);
    const copyDir = fs.realpathSync(t.work[1]), sourceStat = fs.statSync(session.cwdReal);
    rt.launcherFor = () => controlled.launcher;
    await assert.rejects(rt.executeWorkCopy({ parentTaskId: parent.id, workId: "probe", operation: "capture",
      source: { path: session.cwdReal, dev: sourceStat.dev, ino: sourceStat.ino }, workspace: copyDir, copyDir, branch: "probe", command: "capture" }), { code: "worker_stop_unverified" });
    await waitFor("父任务中断", () => rt.store.getTask(parent.id)!.status === "interrupted");
    const host = rt.store.listTasksBySession(session.id).find(task => task.readScope?.workCopyHost)!;
    assert.equal(rt.store.getOccupancyByDir(session.cwdReal)?.taskId, parent.id);
    assert.equal(rt.store.getOccupancyByDir(copyDir)?.taskId, host.id);
    assert.equal(workCopyHostFor(host)!.stopVerified, false);
    assert.equal(rt.store.listToolOpsByTask(host.id).find(op => op.toolName === "worktree_capture")!.resultSummary, "captured");
    assert.equal(rt.store.getTask(parent.id)!.effectUnknown, false);
    await rt.resumeQueue(session.id);
    assert.equal(rt.store.getOccupancyByDir(copyDir), null);
    assert.equal(rt.store.getOccupancyByDir(session.cwdReal), null);
    assert.equal(workCopyHostFor(rt.store.getTask(host.id)!)!.stopVerified, true);
  } finally { gate.release(); controlled.finish(); await t.shutdown(); }
});

test("目录占用或来源身份不符时不创建宿主任务及执行单元", async () => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "完成" }));
  const t = await startTestRuntime("ordinary-host-source", gate.responder, { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "宿主来源", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始捕获", modelSelection: rt.defaultSelection });
    await waitFor("父任务实际执行", () => rt.store.getTask(parent.id)!.status === "running" && t.server.calls.length > 0);
    const copyDir = fs.realpathSync(t.work[1]), sourceStat = fs.statSync(session.cwdReal), before = rt.store.listTasksBySession(session.id).length;
    await assert.rejects(rt.executeWorkCopy({ parentTaskId: parent.id, workId: "probe", operation: "capture",
      source: { path: session.cwdReal, dev: sourceStat.dev, ino: sourceStat.ino + 1 }, workspace: copyDir, copyDir, branch: "probe", command: "capture" }), { code: "task_ending" });
    assert.equal(rt.store.listTasksBySession(session.id).length, before);
    assert.equal(rt.store.getOccupancyByDir(copyDir), null);
    assert.equal(fs.existsSync(path.join(copyDir, ".git")), false);
  } finally { gate.release(); await t.shutdown(); }
});

test("宿主启动期间登记参数改变，在 Git 调用前拒绝并保留损坏记录", async () => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "完成" }));
  const t = await startTestRuntime("ordinary-host-binding", gate.responder, { config: realTools() });
  const controlled = controlledWorkCopy(async () => true, "不可执行");
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "宿主参数", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始捕获", modelSelection: rt.defaultSelection });
    await waitFor("父任务实际执行", () => rt.store.getTask(parent.id)!.status === "running" && t.server.calls.length > 0);
    const launch = controlled.launcher.launch;
    controlled.launcher.launch = async spec => {
      const unit = await launch(spec);
      const host = rt.store.listTasksBySession(session.id).find(task => task.readScope?.workCopyHost)!;
      rt.store.withTx(() => rt.store.db.prepare("UPDATE tasks SET read_scope = ? WHERE id = ?")
        .run(JSON.stringify({ ...host.readScope, workCopyHost: { ...workCopyHostFor(host), workId: "corrupted-work" } }), host.id));
      return unit;
    };
    const copyDir = fs.realpathSync(t.work[1]), sourceStat = fs.statSync(session.cwdReal);
    rt.launcherFor = () => controlled.launcher;
    await assert.rejects(rt.executeWorkCopy({ parentTaskId: parent.id, workId: "probe", operation: "capture",
      source: { path: session.cwdReal, dev: sourceStat.dev, ino: sourceStat.ino }, workspace: copyDir, copyDir, branch: "probe", command: "capture" }), { code: "source_invalid" });
    assert.equal(controlled.requests.some(request => request.type === "tool_call"), false);
    const host = rt.store.listTasksBySession(session.id).find(task => task.readScope?.workCopyHost)!;
    assert.equal(workCopyHostFor(host)!.workId, "corrupted-work");
    assert.equal(host.status, "failed");
    assert.equal(rt.store.listToolOpsByTask(host.id).some(op => op.toolName === "worktree_capture"), false);
    assert.equal(rt.store.getOccupancyByDir(copyDir), null);
  } finally { gate.release(); controlled.finish(); await t.shutdown(); }
});

for (const rollback of [false, true]) test(`宿主 attach 同步失败：零单元启动，结果、终态与停止结论${rollback ? "一起回滚" : "同事务提交"}`, async () => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "完成" }));
  const t = await startTestRuntime("ordinary-host-attach", gate.responder, { config: realTools() });
  const rt = t.runtime, attach = rt.hostExecutions.attach.bind(rt.hostExecutions), endTask = rt.store.endTask.bind(rt.store);
  const controlled = controlledWorkCopy(async () => true, "不可执行");
  try {
    const session = await rt.createSession({ projectName: "attach", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始捕获", modelSelection: rt.defaultSelection });
    await waitFor("父任务执行", () => t.server.calls.length > 0);
    rt.hostExecutions.attach = () => { throw new Error("attach failure"); };
    rt.launcherFor = () => controlled.launcher;
    rt.store.endTask = (...args) => {
      const changed = endTask(...args);
      if (rollback && changed && args[0] !== parent.id) throw new Error("host terminal transaction failure");
      return changed;
    };
    const copyDir = fs.realpathSync(t.work[1]);
    await assert.rejects(rt.executeWorkCopy({ parentTaskId: parent.id, workId: "attach", operation: "capture", workspace: session.cwdReal, copyDir, branch: "attach", command: "capture" }), rollback ? /host terminal transaction failure/ : /attach failure/);
    const host = rt.store.listTasksBySession(session.id).find(task => workCopyHostFor(task))!;
    assert.equal(controlled.specs.length, 0);
    assert.equal(rt.hostExecutions.has(host.id), false);
    assert.equal(host.status, rollback ? "running" : "failed");
    assert.equal(host.resultSummary === null, rollback);
    assert.equal(workCopyHostFor(host)!.stopVerified, rollback ? null : true);
    assert.equal(rt.store.getOccupancyByDir(copyDir)?.taskId ?? null, rollback ? host.id : null);
    assert.equal(rt.store.getTaskEventsAfter(host.id, 0, 100).filter(e => e.body.type === "task.failed").length, rollback ? 0 : 1);
  } finally { rt.hostExecutions.attach = attach; rt.store.endTask = endTask; gate.release(); controlled.finish(); await t.shutdown(); }
});

for (const rollback of [false, true]) test(`父任务停止失败兜底：保留请求前上下文与占用${rollback ? "，再次落盘失败可见且不产生未处理拒绝" : "，迟到结果仍按首次快照结算"}`, async tctx => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "完成" }));
  const t = await startTestRuntime("ordinary-parent-fallback", gate.responder, { config: realTools() });
  const rt = t.runtime, controlled = controlledWorkCopy(async () => false, "captured");
  const endTask = rt.store.endTask.bind(rt.store);
  let driver: any, requestStop: any, ending: any;
  const diagnostics: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  tctx.mock.method(process.stderr, "write", (chunk: string) => { diagnostics.push(String(chunk)); return write(chunk); });
  try {
    const session = await rt.createSession({ projectName: "fallback", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始捕获", modelSelection: rt.defaultSelection });
    await waitFor("父任务执行", () => t.server.calls.length > 0);
    driver = await (rt as any).getDriver(session); requestStop = driver.requestStop; ending = driver.currentTaskEnding;
    let stops = 0, snapshots = 0, releases = 0;
    const ledger = (rt as any).ledger, beginStop = ledger.beginStop.bind(ledger);
    tctx.mock.method(ledger, "beginStop", (taskId: string) => { if (taskId === parent.id) snapshots++; return beginStop(taskId); });
    const released = driver.deps.onOccupancyReleased;
    driver.deps.onOccupancyReleased = () => { releases++; released(); };
    rt.store.withTx(() => rt.store.recordToolIntent({ id: "parent-write", taskId: parent.id, sessionId: parent.sessionId, toolName: "write", params: {} }));
    driver.requestStop = async () => {
      stops++;
      ending.stopSnapshot = ledger.beginStop(parent.id);
      rt.store.withTx(() => ledger.recordResult(parent, "parent-write", "迟到结果", true));
      driver.taskEnding = { taskId: "later-task", stopSnapshot: [] };
      throw new Error("parent stop failure");
    };
    rt.store.endTask = (...args) => { const changed = endTask(...args); if (rollback && args[0] === parent.id) throw new Error("fallback transaction failure"); return changed; };
    rt.launcherFor = () => controlled.launcher;
    const copyDir = fs.realpathSync(t.work[1]);
    await assert.rejects(rt.executeWorkCopy({ parentTaskId: parent.id, workId: "fallback", operation: "capture", workspace: session.cwdReal, copyDir, branch: "fallback", command: "capture" }), { code: "worker_stop_unverified" });
    await waitFor("兜底处理完成", () => rollback ? diagnostics.some(line => line.includes("兜底收尾未落盘")) : rt.store.getTask(parent.id)!.status === "interrupted");
    assert.equal(stops, 1); assert.equal(snapshots, 1); assert.equal(releases, 0);
    assert.equal(rt.store.getOccupancyByDir(session.cwdReal)!.taskId, parent.id);
    assert.equal(rt.store.getToolOp("parent-write")!.effectUnknown, !rollback);
    assert.equal(rt.store.getTask(parent.id)!.status, rollback ? "running" : "interrupted");
    assert.ok(diagnostics.some(line => line.includes("工作副本来源停止收尾失败")));
    if (rollback) assert.ok(diagnostics.some(line => line.includes("保留任务与占用")));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    rt.store.endTask = endTask;
    if (driver) { driver.requestStop = requestStop; driver.taskEnding = ending; }
    gate.release(); controlled.finish(); await t.shutdown();
  }
});
