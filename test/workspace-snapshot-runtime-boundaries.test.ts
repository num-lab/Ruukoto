import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import type { SubAgentDelegation } from "@ruukoto/runtime/subagents.ts";
import { agentReportKey, claimAgentReports, endAgentWait, getAgentReport, registerAgentReport, registerAgentWait } from "@ruukoto/core/agent-wait.ts";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { randomId, type SubAgentMessage, type Task } from "@ruukoto/core/types.ts";
import { holdParentResponse } from "./helpers/active-parent.ts";
import { delegateFromActiveTask } from "./helpers/active-subagent-source.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";
import { afterTool, lastUserText, realTools, startTestRuntime, waitFor, type TestRuntime } from "./helpers/testkit.ts";

async function parentFor(t: TestRuntime): Promise<Task> {
  fs.writeFileSync(path.join(t.work[0], "value.txt"), "baseline\n");
  initGitRepo(t.work[0]);
  const session = await t.runtime.createSession({ projectName: "snapshot-source", cwd: t.work[0] });
  const parent = await t.runtime.submit({ sessionId: session.id, requestId: "parent", input: "开始快照工作", modelSelection: t.runtime.defaultSelection });
  await waitFor("父任务持有真实来源", () => t.runtime.store.getTask(parent.id)!.status === "running" && t.server.calls.length > 0);
  return parent;
}

function corruptSnapshot(rt: Runtime, workId: string): string {
  const row = rt.store.db.prepare("SELECT write_target FROM work_delegations WHERE id = ?").get(workId)!;
  const target = JSON.parse(String(row.write_target)) as Record<string, unknown>;
  delete target.snapshot;
  const corrupted = JSON.stringify(target);
  rt.store.withTx(() => rt.store.db.prepare("UPDATE work_delegations SET write_target = ? WHERE id = ?").run(corrupted, workId));
  return corrupted;
}

function pendingMessage(rt: Runtime, delegation: SubAgentDelegation, parent: Task): SubAgentMessage {
  const msg: SubAgentMessage = { id: randomId("smsg"), workId: delegation.work.id, parentSessionId: parent.sessionId,
    fromSubAgentId: null, fromTaskId: parent.id, accessMode: parent.accessMode, sourcePermissionVersion: parent.permissionVersion,
    toSubAgentId: delegation.agent.id, requestKey: "pending", paramsDigest: "pending", body: "不能投递的工作内消息",
    createdAt: new Date().toISOString(), deliveredTaskId: null, deliveredAt: null, undeliveredReason: null };
  rt.store.withTx(() => rt.store.insertSubAgentMessage(msg));
  return msg;
}

async function healthyTask(rt: Runtime, cwd: string): Promise<void> {
  const session = await rt.createSession({ projectName: "snapshot-healthy", cwd });
  const task = await rt.submit({ sessionId: session.id, requestId: "healthy", input: "健康检查", modelSelection: rt.defaultSelection });
  await waitFor("无关会话仍可执行", () => rt.store.getTask(task.id)!.status === "completed");
}

test("坏快照只失败受影响排队任务，不产生模型请求或未处理拒绝，主服务仍可执行", async () => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "OWNER-DONE" }));
  const t = await startTestRuntime("snapshot-queued-boundary", gate.responder, { config: realTools() });
  try {
    const rt = t.runtime, parent = await parentFor(t);
    const insert = rt.store.insertQueuedTask.bind(rt.store);
    rt.store.insertQueuedTask = input => {
      const result = insert(input);
      if (input.subAgentId) rt.store.setSessionQueueState(result.task.sessionId, "paused", "fixture");
      return result;
    };
    const child = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "queued", request: "排队目标", target: ".", paramsDigest: "queued" });
    rt.store.insertQueuedTask = insert;
    assert.equal(rt.store.getTask(child.task.id)!.status, "queued");
    const sourceBytes = fs.readFileSync(path.join(t.work[0], "value.txt"));
    const corrupted = corruptSnapshot(rt, child.work.id), calls = t.server.calls.length;
    await rt.resumeQueue(child.agent.sessionId);
    await waitFor("坏目标任务失败", () => rt.store.getTask(child.task.id)!.status === "failed");
    assert.match(rt.store.getTask(child.task.id)!.errorMessage!, /snapshot_missing/);
    assert.equal(t.server.calls.length, calls);
    assert.equal(rt.store.getOccupancyByDir(child.work.writeTarget!.path), null);
    assert.equal(rt.store.db.prepare("SELECT write_target FROM work_delegations WHERE id = ?").get(child.work.id)!.write_target, corrupted);
    assert.deepEqual(fs.readFileSync(path.join(t.work[0], "value.txt")), sourceBytes);
    assert.ok(fs.existsSync(child.work.writeTarget!.path));
    await healthyTask(rt, t.work[1]);
  } finally { gate.release(); await t.shutdown(); }
});

test("运行中的快照失去私有基线，下一次模型请求拒绝并保留源与副本", async () => {
  let release!: () => void;
  const childGate = new Promise<void>(resolve => { release = resolve; });
  let childCalls = 0;
  const gate = holdParentResponse(async req => {
    if (!lastUserText(req).startsWith("[SubAgent 委派")) return { kind: "text", text: "OWNER-DONE" };
    childCalls++;
    if (!afterTool(req)) {
      await childGate;
      return { kind: "tool_calls", calls: [{ id: "read", name: "read", arguments: { path: "value.txt" } }] };
    }
    return { kind: "text", text: "不应请求第二次模型" };
  });
  const t = await startTestRuntime("snapshot-running-boundary", gate.responder, { config: realTools() });
  try {
    const rt = t.runtime, parent = await parentFor(t);
    const child = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "running", request: "运行目标", target: ".", paramsDigest: "running" });
    await waitFor("子模型首次请求", () => childCalls === 1);
    const target = child.work.writeTarget!;
    assert.equal(target.kind, "worktree");
    if (target.kind !== "worktree") assert.fail("需要 Git 副本");
    fs.writeFileSync(path.join(target.snapshot.repository.path, "ruukoto-baseline"), "{}");
    release();
    await waitFor("子任务收尾", () => ["completed", "failed", "interrupted", "canceled"].includes(rt.store.getTask(child.task.id)!.status));
    assert.equal(childCalls, 1);
    const task = rt.store.getTask(child.task.id)!;
    assert.ok(["failed", "interrupted"].includes(task.status));
    assert.match(`${task.errorMessage ?? ""} ${task.interruptReason ?? ""}`, /snapshot_corrupt/);
    assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "baseline\n");
    assert.equal(fs.readFileSync(path.join(target.path, "value.txt"), "utf8"), "baseline\n");
    assert.equal(fs.readFileSync(path.join(target.snapshot.repository.path, "ruukoto-baseline"), "utf8"), "{}");
    await healthyTask(rt, t.work[1]);
  } finally { release(); gate.release(); await t.shutdown(); }
});

test("冷恢复坏快照的待投消息明确未投递，历史与副本保留，后台仍可启动", async () => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "DONE" }));
  const t = await startTestRuntime("snapshot-message-recovery", gate.responder, { config: realTools() });
  let restarted: Runtime | null = null;
  try {
    const rt = t.runtime, parent = await parentFor(t);
    const child = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "message", request: "消息目标", target: ".", paramsDigest: "message" });
    await waitFor("首任务结果与空闲保存", () => rt.store.getTask(child.task.id)!.resultSummary !== null && rt.store.getSubAgent(child.agent.id)!.state === "idle");
    const msg = pendingMessage(rt, child, parent), corrupted = corruptSnapshot(rt, child.work.id);
    t.client.close();
    await rt.stop("cold_snapshot_fixture");
    const calls = t.server.calls.length;
    restarted = await Runtime.start(rt.config);
    const persisted = restarted.store.getSubAgentMessage(msg.id)!;
    assert.equal(persisted.undeliveredReason, "snapshot_missing");
    assert.equal(persisted.deliveredTaskId, null);
    assert.equal(persisted.deliveredAt, null);
    assert.equal(persisted.body, msg.body);
    assert.equal(t.server.calls.length, calls);
    assert.equal(restarted.store.db.prepare("SELECT write_target FROM work_delegations WHERE id = ?").get(child.work.id)!.write_target, corrupted);
    assert.ok(fs.existsSync(child.work.writeTarget!.path));
    await healthyTask(restarted, t.work[1]);
  } finally { gate.release(); await restarted?.stop("test_end"); await t.shutdown(); }
});

for (const damage of ["record", "baseline"] as const) test(`冷恢复已有父总结遇到坏快照 ${damage}，原回报记来源失效且启动不重建汇报`, async () => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "已持久化的唯一总结" }));
  const t = await startTestRuntime("snapshot-report-recovery", gate.responder, { config: realTools() });
  let restarted: Runtime | null = null;
  try {
    const rt = t.runtime, parent = await parentFor(t);
    const child = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "report", request: "回报目标", target: ".", paramsDigest: "report" });
    await waitFor("子任务持久结果", () => rt.store.getTask(child.task.id)!.resultSummary !== null && rt.store.getSubAgent(child.agent.id)!.state === "idle");
    const source = rt.store.getTask(child.task.id)!.readScope!.execution!.source;
    gate.release();
    await waitFor("父总结落盘", () => rt.store.getTask(parent.id)!.status === "completed");
    const historyFile = rt.store.getSession(parent.sessionId)!.sessionFile!, history = fs.readFileSync(historyFile);
    const sourceBytes = fs.readFileSync(path.join(t.work[0], "value.txt")), sourceRecord = JSON.stringify(source), config = rt.config;
    t.client.close();
    await rt.stop("snapshot_report_fixture");
    const db = new Db(t.dirs.dataDir), store = new Store(db);
    let reportKey = "", corrupted = "";
    try {
      store.withTx(() => {
        store.db.prepare("UPDATE tasks SET status = 'running', ended_at = NULL WHERE id = ?").run(parent.id);
        const report = registerAgentReport(store, { target: { kind: "task", taskId: child.task.id }, parentSessionId: parent.sessionId, source });
        reportKey = report.key;
        claimAgentReports(store, { taskId: parent.id, keys: [report.key] });
        const row = store.db.prepare("SELECT write_target FROM work_delegations WHERE id = ?").get(child.work.id)!;
        corrupted = String(row.write_target);
        if (damage === "record") {
          const target = JSON.parse(corrupted) as Record<string, unknown>;
          delete target.snapshot;
          corrupted = JSON.stringify(target);
          store.db.prepare("UPDATE work_delegations SET write_target = ? WHERE id = ?").run(corrupted, child.work.id);
        } else {
          const target = child.work.writeTarget!;
          if (target.kind !== "worktree") assert.fail("需要 Git 副本");
          fs.writeFileSync(path.join(target.snapshot.repository.path, "ruukoto-baseline"), "{}");
        }
      });
    } finally { db.close(); }
    const calls = t.server.calls.length;
    restarted = await Runtime.start(config);
    const report = getAgentReport(restarted.store, reportKey)!;
    assert.equal(report.status, "undelivered");
    assert.equal(report.reason, "source_invalid");
    assert.equal(report.claimTaskId, null);
    assert.equal(JSON.stringify(report.source), sourceRecord);
    assert.equal(t.server.calls.length, calls);
    assert.deepEqual(fs.readFileSync(historyFile), history);
    assert.deepEqual(fs.readFileSync(path.join(t.work[0], "value.txt")), sourceBytes);
    assert.equal(restarted.store.db.prepare("SELECT write_target FROM work_delegations WHERE id = ?").get(child.work.id)!.write_target, corrupted);
    assert.ok(fs.existsSync(child.work.writeTarget!.path));
    await healthyTask(restarted, t.work[1]);
  } finally { gate.release(); await restarted?.stop("test_end"); await t.shutdown(); }
});

test("汇报同组另一工作区已坏，既有回报记来源失效且不补造坏目标的回报", async () => {
  let release!: () => void;
  const secondGate = new Promise<void>(resolve => { release = resolve; });
  const gate = holdParentResponse(async req => {
    if (lastUserText(req).includes("SECOND-RESULT")) await secondGate;
    return { kind: "text", text: "持久结果" };
  });
  const t = await startTestRuntime("snapshot-group-boundary", gate.responder, { config: realTools() });
  try {
    const rt = t.runtime, parent = await parentFor(t);
    const first = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "first", request: "FIRST-RESULT", target: ".", paramsDigest: "first" });
    await waitFor("第一个子结果", () => rt.store.getTask(first.task.id)!.resultSummary !== null);
    const second = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "second", request: "SECOND-RESULT", target: ".", paramsDigest: "second" });
    await waitFor("第二个子模型请求", () => rt.store.getTask(second.task.id)!.status === "running");
    const source = rt.store.getTask(first.task.id)!.readScope!.execution!.source;
    rt.store.withTx(() => {
      registerAgentWait(rt.store, { id: "group", sdkCallId: "group", taskId: parent.id, sessionId: parent.sessionId, deadline: null,
        targets: [{ kind: "task", taskId: first.task.id }, { kind: "task", taskId: second.task.id }], source,
        snapshot: { taskId: parent.id, permissionVersion: parent.permissionVersion, selectionRecordId: null, promptArtifactId: null, instructions: null, skills: null } });
      endAgentWait(rt.store, "group", "timeout");
    });
    gate.release();
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const historyFile = rt.store.getSession(parent.sessionId)!.sessionFile!, history = fs.readFileSync(historyFile);
    const corrupted = corruptSnapshot(rt, first.work.id), calls = t.server.calls.length;
    release();
    const key = agentReportKey({ kind: "task", taskId: second.task.id });
    await waitFor("同组回报登记", () => getAgentReport(rt.store, key) !== null && rt.store.getTask(second.task.id)!.resultSummary !== null);
    const report = getAgentReport(rt.store, key)!;
    assert.equal(report.status, "undelivered");
    assert.equal(report.reason, "source_invalid");
    assert.equal(getAgentReport(rt.store, agentReportKey({ kind: "task", taskId: first.task.id })), null);
    assert.equal(t.server.calls.length, calls);
    assert.deepEqual(fs.readFileSync(historyFile), history);
    assert.equal(rt.store.db.prepare("SELECT write_target FROM work_delegations WHERE id = ?").get(first.work.id)!.write_target, corrupted);
    assert.ok(fs.existsSync(first.work.writeTarget!.path));
    await healthyTask(rt, t.work[1]);
  } finally { release(); gate.release(); await t.shutdown(); }
});

test("无等待报告的普通父注入拒绝失去私有基线的结果和消息，原完成记录保留", async () => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "COMPLETED-RESULT" }));
  const t = await startTestRuntime("snapshot-ordinary-injection", gate.responder, { config: realTools() });
  try {
    const rt = t.runtime, parent = await parentFor(t);
    const child = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "injection", request: "注入目标", target: ".", paramsDigest: "injection" });
    await waitFor("真实子结果保存", () => rt.store.getTask(child.task.id)!.resultSummary !== null);
    const before = rt.store.getTask(child.task.id)!, target = child.work.writeTarget!;
    if (target.kind !== "worktree") assert.fail("需要 Git 副本");
    const message = pendingMessage(rt, child, parent);
    rt.store.withTx(() => rt.store.db.prepare("UPDATE subagent_messages SET to_sub_agent_id = NULL, from_sub_agent_id = ?, from_task_id = ? WHERE id = ?")
      .run(child.agent.id, child.task.id, message.id));
    fs.unlinkSync(path.join(target.snapshot.repository.path, "ruukoto-baseline"));
    const injection = rt["parentDelivery"].takeInjection(parent.sessionId);
    assert.equal(injection.results.length, 0);
    assert.equal(injection.messages.length, 0);
    const saved = rt.store.getSubAgentMessage(message.id)!;
    assert.equal(saved.undeliveredReason, "snapshot_corrupt");
    assert.equal(saved.deliveredAt, null);
    assert.equal(saved.body, message.body);
    const dropped = () => rt.store.db.prepare("SELECT body FROM events WHERE json_extract(body, '$.type') = 'subagent_message.dropped' AND json_extract(body, '$.messageId') = ?").all(message.id);
    assert.equal(dropped().length, 1);
    rt["parentDelivery"].takeInjection(parent.sessionId);
    assert.equal(dropped().length, 1);
    const after = rt.store.getTask(child.task.id)!;
    assert.equal(after.status, "completed");
    assert.equal(after.resultRef, before.resultRef);
    assert.equal(after.resultSummary, before.resultSummary);
    assert.equal(after.resultDeliveredAt, null);
    assert.equal(getAgentReport(rt.store, agentReportKey({ kind: "task", taskId: child.task.id })), null);
  } finally { gate.release(); await t.shutdown(); }
});

test("main 无等待报告时不为失去私有基线的新结果创建或准入唤醒", async () => {
  let release!: () => void;
  const childGate = new Promise<void>(resolve => { release = resolve; });
  const gate = holdParentResponse(async req => {
    if (lastUserText(req).startsWith("[SubAgent 委派")) await childGate;
    return { kind: "text", text: "CHILD-FINISHED" };
  });
  const t = await startTestRuntime("snapshot-ordinary-wake", gate.responder, { config: realTools() });
  try {
    const rt = t.runtime, main = rt.store.getAgentRole("main")!, session = rt.store.getSession(main.sessionId)!;
    fs.writeFileSync(path.join(session.cwdReal, "value.txt"), "baseline\n");
    initGitRepo(session.cwdReal);
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始 main 快照工作", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("main 父任务运行", () => rt.store.getTask(parent.id)!.status === "running");
    const child = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "wake", request: "唤醒目标", target: ".", paramsDigest: "wake" });
    await waitFor("子模型已请求", () => t.server.calls.length === 2);
    const target = child.work.writeTarget!;
    if (target.kind !== "worktree") assert.fail("需要 Git 副本");
    fs.unlinkSync(path.join(target.snapshot.repository.path, "ruukoto-baseline"));
    release();
    await waitFor("坏基线结果保存", () => rt.store.getTask(child.task.id)!.resultSummary !== null);
    const task = rt.store.getTask(child.task.id)!;
    assert.equal(JSON.parse(task.resultRef!).outcome, "failed");
    assert.equal(JSON.parse(task.resultRef!).failure, "snapshot_corrupt");
    assert.equal(rt.store.findTaskByRequest(parent.sessionId, `wake:${task.id}`), null);
    const wake = rt.store.withTx(() => rt.store.insertQueuedTask({ sessionId: parent.sessionId, requestId: `wake:${task.id}`, input: "迟到唤醒夹具",
      modelSelection: rt.defaultSelection, submissionDigest: "late-wake" }).task);
    assert.equal(rt["parentDelivery"].wakeAdmitted(wake), false);
    assert.equal(t.server.calls.length, 2);
    assert.equal(fs.readFileSync(path.join(session.cwdReal, "value.txt"), "utf8"), "baseline\n");
  } finally { release(); gate.release(); await t.shutdown(); }
});

test("冷补记真实 private 基线缺失的结果记失败，保持 completed 执行史且不重跑", async () => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "COMPLETED-BEFORE-CRASH" }));
  const t = await startTestRuntime("snap-cold", gate.responder, { config: realTools() });
  let restarted: Runtime | null = null;
  try {
    const rt = t.runtime, parent = await parentFor(t);
    const child = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "cold", request: "冷补记目标", target: ".", paramsDigest: "cold" });
    await waitFor("真实子任务完成", () => rt.store.getTask(child.task.id)!.status === "completed" && rt.store.getTask(child.task.id)!.resultSummary !== null);
    const target = child.work.writeTarget!, config = rt.config;
    if (target.kind !== "worktree") assert.fail("需要 Git 副本");
    t.client.close();
    gate.release();
    await rt.stop("before_result_fixture");
    const db = new Db(t.dirs.dataDir);
    try { db.prepare("UPDATE tasks SET result_ref = NULL, result_summary = NULL WHERE id = ?").run(child.task.id); }
    finally { db.close(); }
    fs.unlinkSync(path.join(target.snapshot.repository.path, "ruukoto-baseline"));
    const calls = t.server.calls.length;
    restarted = await Runtime.start(config);
    await waitFor("冷恢复失败结果登记", () => restarted!.store.getTask(child.task.id)!.resultSummary !== null);
    const saved = restarted.store.getTask(child.task.id)!;
    assert.equal(saved.status, "completed");
    assert.equal(JSON.parse(saved.resultRef!).outcome, "failed");
    assert.equal(JSON.parse(saved.resultRef!).failure, "snapshot_corrupt");
    assert.equal(t.server.calls.length, calls);
    assert.ok(fs.existsSync(target.path));
    assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "baseline\n");
  } finally { gate.release(); await restarted?.stop("test_end"); await t.shutdown(); }
});
