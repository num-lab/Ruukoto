import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { workCopyHostFor } from "@ruukoto/core/work-copy-host.ts";
import { firstDue, parseRule } from "@ruukoto/channels/scheduler/time.ts";
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

test("定时运行收尾读取 Agent 的回复，较晚结束的宿主账本不能取代最终汇报", async () => {
  let now = Date.parse("2026-10-15T00:00:00Z");
  const target = { channel: "telegram", account: "1", chatId: "42", configVersion: 1 };
  const reports: string[] = [];
  const t = await startTestRuntime("ordinary-host-scheduler", async () => ({ kind: "text", text: "AGENT-FINAL" }), { config: {
    ...realTools(), scheduler: { now: () => now, tickMs: 0, channel: { target: () => target,
      send: async input => { reports.push(input.text); return { platformMessageId: "sent" }; } } },
  } });
  try {
    const rt = t.runtime, main = rt.store.getAgentRole("main")!;
    const rule = parseRule({ kind: "once", at: "2026-10-15T00:00:01Z", time_zone: "UTC" });
    const schedule = rt.store.withTx(() => rt.sched.insertSchedule({ createKey: "host-final", paramsDigest: "host-final", createTaskId: null,
      createOpId: null, projectId: main.projectId, createPermissionVersion: 1, accessMode: "full_access", rule, instruction: "定时工作",
      sourceRefs: [], target, nextDueAt: firstDue(rule, now), tzData: "test", reason: "test" }, "test"));
    now += 1000;
    await rt.scheduler!.tick();
    const run = rt.sched.listRuns(schedule.id, 1)[0]!;
    await waitFor("Agent 结果登记", () => rt.store.getTask(run.rootTaskId!)?.resultSummary != null);
    const parent = rt.store.getTask(run.rootTaskId!)!, session = rt.store.getSession(parent.sessionId)!;
    rt.store.withTx(() => {
      const host = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "work-copy-host:late:integrate:op", input: "宿主记录",
        modelSelection: null, submissionDigest: "late", parentTaskId: parent.id, sourcePermissionVersion: parent.permissionVersion, accessMode: parent.accessMode,
        readScope: { paths: [], sourceRefs: [], workCopyHost: { version: 1, parentTaskId: parent.id, workId: "late", operation: "integrate",
          source: { path: session.cwdReal, dev: session.cwdDev, ino: session.cwdIno }, units: [], stopVerified: true } } }).task;
      rt.store.setTaskResult(host.id, "HOST-NONMODEL-RESULT", "host");
      rt.store.endTask(host.id, ["queued"], "completed", { endedAt: new Date(Date.parse(parent.endedAt!) + 1000).toISOString() });
    });
    rt.scheduler!.closeFinished();
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    assert.equal(rt.sched.getRun(run.id)!.resultStatus, "completed");
    assert.ok(rt.sched.getRun(run.id)!.resultText!.includes("AGENT-FINAL"));
    assert.equal(reports.length, 1);
    assert.ok(reports[0].includes("AGENT-FINAL"));
    assert.ok(!reports[0].includes("HOST-NONMODEL-RESULT"));
  } finally { await t.shutdown(); }
});
