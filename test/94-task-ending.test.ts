/** 架构工单 14（审查第 7 条）：真实 Store 事务与 Runtime 收尾竞争。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import { ToolOpLedger } from "../src/agent/tool-op-ledger.ts";
import type { Task } from "../src/core/types.ts";
import { Runtime } from "../src/runtime/runtime.ts";
import { startTestRuntime, waitFor } from "./helpers/testkit.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-task-ending-"));
  const db = new Db(root);
  const store = new Store(db);
  const project = store.withTx(() => store.createProject("test"));
  const session = store.withTx(() => store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: 1, piSessionId: "pi", confirmTools: [] }));
  let n = 0;
  const newTask = () => store.withTx(() => store.insertQueuedTask({
    sessionId: session.id, requestId: `request-${++n}`, input: "input",
    modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, submissionDigest: "digest",
  }).task);
  const task = newTask();
  const occupy = (t = task) => store.withTx(() => store.tryAcquireOccupancy({ cwdReal: root, cwdDev: 1, cwdIno: 1, sessionId: session.id, taskId: t.id }));
  const approval = (decision: "pending" | "approved" | "consumed" | "rejected") => store.withTx(() => {
    const opId = `op-${++n}`;
    store.recordToolIntent({ id: opId, taskId: task.id, sessionId: session.id, toolName: "bash", params: {} });
    const c = store.createConfirmation({
      taskId: task.id, sessionId: session.id, toolOpId: opId, toolName: "bash", params: {},
      scope: { kind: "tool", workspaceOnly: true }, permissionVersion: 1,
      ...(decision === "pending" ? { review: { model: "mock", policyVersion: "test" } } : {}),
    });
    if (decision !== "pending") store.respondConfirmation(c.id, decision === "rejected" ? "rejected" : "approved", { source: "owner" });
    if (decision === "consumed") assert.equal(store.consumeApproval({ confirmationId: c.id, expectedPermissionVersion: 1, activeStatuses: ["running"] }), true);
    return store.getConfirmation(c.id)!;
  });
  const thinking = () => store.withTx(() => store.appendEvent({
    type: "task.thinking", taskId: task.id, sessionId: session.id, thinkingId: "thinking",
    messageId: "message", startedAt: task.createdAt, endedAt: null, text: "尚未结束",
  }, { taskId: task.id, sessionId: session.id }));
  return { db, store, session, task, newTask, occupy, approval, thinking, cleanup: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

for (const status of ["completed", "failed", "canceled", "interrupted"] as const) {
  test(`终态 ${status}：清理审批、模式和思考；已消费与已拒绝审批保留；重复收尾零副作用`, () => {
    const f = fixture();
    try {
      f.store.withTx(() => f.store.transitionTask(f.task.id, ["queued"], "running"));
      const pending = f.approval("pending");
      const approved = f.approval("approved");
      const consumed = f.approval("consumed");
      const rejected = f.approval("rejected");
      f.store.withTx(() => f.store.requestModeSwitch(f.task.id, "full_access"));
      f.thinking();
      assert.equal(f.occupy(), true);
      const seq = f.store.getMaxSeq();
      const endedAt = "2026-10-07T00:00:00.000Z";
      assert.equal(f.store.withTx(() => f.store.endTask(f.task.id, ["running"], status, { errorMessage: "原因", interruptReason: "原因", endedAt })), true);
      const ended = f.store.getTask(f.task.id)!;
      assert.equal(ended.status, status);
      assert.equal(ended.pendingAccessMode, null);
      assert.equal(ended.endedAt, endedAt);
      assert.equal(f.store.getConfirmation(pending.id)!.status, "stale");
      assert.equal(f.store.getConfirmation(pending.id)!.reviewStatus, "superseded");
      assert.equal(f.store.getConfirmation(approved.id)!.status, "stale");
      assert.deepEqual(f.store.getConfirmation(consumed.id), consumed);
      assert.deepEqual(f.store.getConfirmation(rejected.id), rejected);
      assert.equal(f.store.listAllOccupancy().length, 0);
      const events = f.store.getEventsAfter(seq);
      assert.equal(events.filter((e) => e.body.type === `task.${status}`).length, 1);
      assert.ok(events.some((e) => e.body.type === "task.thinking" && e.body.endedAt === endedAt));
      if (status === "failed") assert.ok(events.some((e) => e.body.type === "task.failed" && e.body.errorMessage === ended.errorMessage));

      const next = f.newTask();
      assert.equal(f.occupy(next), true);
      const after = f.store.getMaxSeq();
      // 连错误地把终态写进起点集合，也不能改写已结束任务。
      assert.equal(f.store.withTx(() => f.store.endTask(f.task.id, ["running", status], "failed", { onChanged: () => assert.fail("重复收尾不能执行账本钩子") })), false);
      assert.deepEqual(f.store.getTask(f.task.id), ended);
      assert.equal(f.store.getMaxSeq(), after);
      assert.equal(f.store.listAllOccupancy()[0]!.taskId, next.id);
    } finally { f.cleanup(); }
  });
}

test("占用释放失败：收尾、审批、模式、思考和账本全部回滚，重试成功后才广播", () => {
  const f = fixture();
  try {
    f.store.withTx(() => f.store.transitionTask(f.task.id, ["queued"], "running"));
    const approved = f.approval("approved");
    const consumed = f.approval("consumed");
    f.store.withTx(() => f.store.requestModeSwitch(f.task.id, "full_access"));
    f.thinking();
    assert.equal(f.occupy(), true);
    const before = f.store.getTask(f.task.id)!;
    const seq = f.store.getMaxSeq();
    const ledger = new ToolOpLedger(f.store);
    let commits = 0;
    f.store.onCommitted = () => {
      commits++;
      assert.equal(f.store.getTask(f.task.id)!.status, "interrupted");
      assert.equal(f.store.getConfirmation(approved.id)!.status, "stale");
      assert.equal(f.store.listAllOccupancy().length, 0);
    };
    f.db.exec("CREATE TRIGGER reject_release BEFORE DELETE ON occupancy BEGIN SELECT RAISE(ABORT, 'release failure'); END");
    const end = () => f.store.withTx(() => f.store.endTask(f.task.id, ["running"], "interrupted", {
      interruptReason: "test", onChanged: (task) => { ledger.markEffectUnknown(task, consumed.toolOpId); },
    }));
    assert.throws(end, /release failure/);
    assert.deepEqual(f.store.getTask(f.task.id), before);
    assert.deepEqual(f.store.getConfirmation(approved.id), approved);
    assert.deepEqual(f.store.getConfirmation(consumed.id), consumed);
    assert.equal(f.store.getToolOp(consumed.toolOpId)!.effectUnknown, false);
    assert.equal(f.store.listAllOccupancy().length, 1);
    assert.equal(f.store.getMaxSeq(), seq);
    assert.equal(commits, 0);
    f.db.exec("DROP TRIGGER reject_release");
    assert.equal(end(), true);
    assert.equal(commits, 1);
    const events = f.store.getEventsAfter(seq);
    assert.ok(events.some((e) => e.body.type === "task.interrupted" && e.body.effectUnknown));
    assert.ok(events.findIndex((e) => e.body.type === "task.tool_effect_unknown") < events.findIndex((e) => e.body.type === "task.interrupted"));
  } finally { f.cleanup(); }
});

for (const reason of ["backend_restart", "tool_process_unreaped", "mode_switch_unverified"] as const) {
  test(`保留占用 ${reason}：清待切换模式、读真实任务标记、保留原事件种类`, () => {
    const f = fixture();
    try {
      f.store.withTx(() => {
        f.store.transitionTask(f.task.id, ["queued"], "running");
        f.store.requestModeSwitch(f.task.id, "full_access");
        f.store.setCancelRequested(f.task.id, true);
        f.store.setEffectUnknown(f.task.id);
      });
      assert.equal(f.occupy(), true);
      const seq = f.store.getMaxSeq();
      assert.equal(f.store.withTx(() => f.store.endTask(f.task.id, ["running"], "interrupted", {
        interruptReason: reason, keepOccupancy: true,
        ...(reason === "tool_process_unreaped" ? { occupancyIssueReason: reason } : {}),
        ...(reason === "mode_switch_unverified" ? { modeSwitchFailure: { to: "full_access" as const, reason } } : {}),
      })), true);
      assert.equal(f.store.getTask(f.task.id)!.pendingAccessMode, null);
      assert.equal(f.store.listAllOccupancy()[0]!.taskId, f.task.id);
      const events = f.store.getEventsAfter(seq);
      if (reason === "mode_switch_unverified") {
        assert.equal(events.length, 1);
        assert.ok(events.some((e) => e.body.type === "task.mode_switch_failed" && e.body.taskId === f.task.id && e.body.sessionId === f.session.id));
      } else {
        assert.ok(events.some((e) => e.body.type === "task.interrupted" && e.body.cancelRequested && e.body.effectUnknown));
      }
      assert.equal(events.filter((e) => e.body.type === "task.tool_process_unreaped").length, reason === "tool_process_unreaped" ? 1 : 0);
      const after = f.store.getMaxSeq();
      assert.equal(f.store.withTx(() => f.store.endTask(f.task.id, ["running"], "failed")), false);
      assert.equal(f.store.listAllOccupancy()[0]!.taskId, f.task.id, "失败兜底不能删除待核实占用");
      assert.equal(f.store.getMaxSeq(), after);
    } finally { f.cleanup(); }
  });
}

test("Runtime 驱动器收尾后抛错：只保留原终态和待核实占用，不新增 task.failed", async () => {
  const t = await startTestRuntime("task-end-race", async () => ({ kind: "text", text: "不应调用模型" }));
  const rt = t.runtime;
  const original = (rt as any).getDriver;
  try {
    const session = await rt.createSession({ projectName: "test", cwd: t.work[0]! });
    (rt as any).getDriver = async () => ({
      run: async (task: Task) => {
        rt.store.withTx(() => rt.store.endTask(task.id, ["running"], "interrupted", { interruptReason: "unverified", keepOccupancy: true }));
        throw new Error("收尾后异常");
      },
    });
    const task = await rt.submit({ sessionId: session.id, requestId: "race", input: "test", modelSelection: rt.defaultSelection });
    // 让实际队列兜底 catch 和 finally 都执行完，再核对持久事实。
    await waitFor("调度循环结束", () => rt.store.getTask(task.id)!.status === "interrupted" && !(rt as any).loopActive.has(session.id));
    assert.equal(rt.store.getTask(task.id)!.interruptReason, "unverified");
    const events = rt.store.getEventsAfter(0).filter((e) => e.taskId === task.id);
    assert.equal(events.filter((e) => e.body.type === "task.interrupted").length, 1);
    assert.equal(events.filter((e) => e.body.type === "task.failed").length, 0);
    assert.equal(rt.store.listAllOccupancy()[0]!.taskId, task.id);
    assert.equal(t.server.calls.length, 0);
  } finally {
    (rt as any).getDriver = original;
    await t.shutdown();
  }
});

for (const reason of ["backend_restart", "backend_stop"] as const) {
  test(`Runtime ${reason}：无驱动器的活动任务清模式、失效审批，保留占用和实际任务标记`, async () => {
    const t = await startTestRuntime(`task-end-${reason}`, async () => ({ kind: "text", text: "不应调用模型" }));
    let recovered: Runtime | null = null;
    let db: Db | null = null;
    try {
      const session = await t.runtime.createSession({ projectName: "seed", cwd: t.work[0]! });
      // 重启从离线库播种崩溃形态；停止则在在线库播种尚未有驱动器的启动窗口。
      if (reason === "backend_restart") {
        await t.runtime.stop("prepare");
        db = new Db(t.dirs.dataDir);
      }
      const store = db ? new Store(db) : t.runtime.store;
      const { task, confirmation } = store.withTx(() => {
        const task = store.insertQueuedTask({ sessionId: session.id, requestId: "seed", input: "seed", modelSelection: t.runtime.defaultSelection, submissionDigest: "seed" }).task;
        store.transitionTask(task.id, ["queued"], "running");
        store.requestModeSwitch(task.id, "full_access");
        store.setCancelRequested(task.id, true);
        store.setEffectUnknown(task.id);
        const confirmation = store.createConfirmation({ taskId: task.id, sessionId: session.id, toolOpId: "seed-op", toolName: "bash", params: {}, scope: { kind: "tool", workspaceOnly: true }, permissionVersion: 1 });
        assert.equal(store.tryAcquireOccupancy({ cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno, sessionId: session.id, taskId: task.id }), true);
        return { task, confirmation };
      });
      if (reason === "backend_restart") {
        db!.close();
        db = null;
        recovered = await Runtime.start(t.runtime.config);
      } else {
        await t.runtime.stop("test");
        db = new Db(t.dirs.dataDir);
      }
      const current = recovered?.store ?? new Store(db!);
      assert.equal(current.getTask(task.id)!.status, "interrupted");
      assert.equal(current.getTask(task.id)!.pendingAccessMode, null);
      assert.equal(current.getConfirmation(confirmation.id)!.status, "stale");
      assert.equal(current.listAllOccupancy()[0]!.taskId, task.id);
      assert.ok(current.getEventsAfter(0).some((e) => e.body.type === "task.interrupted" && e.body.taskId === task.id && e.body.reason === reason && e.body.cancelRequested && e.body.effectUnknown));
      assert.equal(t.server.calls.length, 0);
    } finally {
      db?.close();
      await recovered?.stop("end");
      await t.shutdown();
    }
  });
}
