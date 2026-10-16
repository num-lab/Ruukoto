/** 架构工单 14（审查第 7 条）：真实 Store 事务与 Runtime 收尾竞争。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { endTaskExecution, type TaskEndingContext } from "@ruukoto/agent/task-ending.ts";
import type { Driver } from "@ruukoto/agent/driver.ts";
import { ExecutionError } from "@ruukoto/agent/execution/launchers.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import type { ManagedProcessRegistry } from "@ruukoto/agent/managed-processes.ts";
import type { Task } from "@ruukoto/core/types.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { startTestRuntime, waitFor } from "./helpers/testkit.ts";

async function driverFixture(stop: () => Promise<boolean>) {
  let registry: ManagedProcessRegistry | null = null;
  const t = await startTestRuntime("unverified-driver", async () => ({ kind: "text", text: "已知完成的结果" }), {
    config: { toolFactory: (ctx) => {
      registry = ctx.registry;
      registry.register({ kind: "starting", id: "controlled-worker", label: "可控执行单元", stop });
      return createMockTools(ctx);
    } },
  });
  const session = await t.runtime.createSession({ projectName: "test", cwd: t.work[0]! });
  const task = t.runtime.store.withTx(() => {
    t.runtime.store.setSessionQueueState(session.id, "paused", "test");
    const task = t.runtime.store.insertQueuedTask({ sessionId: session.id, requestId: "test", input: "test", modelSelection: t.runtime.defaultSelection, submissionDigest: "test" }).task;
    t.runtime.store.transitionTask(task.id, ["queued"], "running");
    assert.equal(t.runtime.store.tryAcquireOccupancy({ cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno, sessionId: session.id, taskId: task.id }), true);
    return t.runtime.store.getTask(task.id)!;
  });
  const driver: Driver = await (t.runtime as any).getDriver(session);
  return { ...t, session, task, driver, registry: () => registry! };
}

for (const failure of ["false", "throw"] as const) {
  for (const ending of ["completed", "prompt_error", "before_prompt_cancel"] as const) {
    test(`Driver ${ending}：stop ${failure} 保留占用与事件，继续清理其他单元`, async () => {
      let stops = 0;
      let siblingStops = 0;
      const t = await driverFixture(async () => {
        stops++;
        if (failure === "throw") throw new Error("可控停止失败");
        return false;
      });
      const original = (t.driver as any).ensureSdk;
      try {
        (t.driver as any).ensureSdk = async (...args: unknown[]) => {
          const sdk = await original.apply(t.driver, args);
          t.registry().register({ kind: "starting", id: "sibling-worker", label: "其他执行单元", stop: async () => { siblingStops++; return true; } });
          if (ending === "prompt_error") sdk.prompt = async () => { throw new Error("可控 prompt 异常"); };
          if (ending === "before_prompt_cancel") await t.driver.requestStop(t.task, { terminal: "canceled", reason: "owner_cancel", cancelIntent: true });
          return sdk;
        };
        await t.driver.run(t.task);
        const task = t.runtime.store.getTask(t.task.id)!;
        assert.equal(task.status, ending === "completed" ? "completed" : ending === "prompt_error" ? "failed" : "canceled");
        if (ending === "prompt_error") assert.match(task.errorMessage!, /可控 prompt 异常/);
        const events = t.runtime.store.getTaskEventsAfter(task.id, 0, 100);
        assert.equal(events.filter((e) => e.body.type === "task.tool_process_unreaped").length, 1);
        assert.equal(events.filter((e) => e.body.type === `task.${task.status}`).length, 1);
        assert.equal(t.runtime.store.listAllOccupancy()[0]!.taskId, task.id);
        assert.equal(t.runtime.snapshot().tasks.find((item) => item.id === task.id)!.status, task.status);
        assert.equal(stops, 1);
        assert.equal(siblingStops, 1, "单个停止异常不能跳过其他单元");
        assert.ok(t.registry().list().some((entry) => entry.id === "controlled-worker"), "未核实记录保留");

        const next = await t.runtime.createSession({ projectName: "same-dir", cwd: t.work[0]! });
        const queued = await t.runtime.submit({ sessionId: next.id, requestId: "blocked", input: "同目录等待", modelSelection: t.runtime.defaultSelection });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(t.runtime.store.getTask(queued.id)!.status, "queued");
        assert.equal(t.server.calls.length, ending === "completed" ? 1 : 0);
      } finally {
        (t.driver as any).ensureSdk = original;
        await t.shutdown();
      }
    });
  }
}

test("Driver 自然完成与并发取消共享停止结论；重复清理不把未核实改为成功", async () => {
  let stops = 0;
  let started!: () => void;
  let release!: (value: boolean) => void;
  const stopping = new Promise<void>((resolve) => { started = resolve; });
  const outcome = new Promise<boolean>((resolve) => { release = resolve; });
  const t = await driverFixture(async () => { stops++; started(); return outcome; });
  try {
    const run = t.driver.run(t.task);
    await stopping;
    const cancel = t.driver.requestStop(t.task, { terminal: "canceled", reason: "owner_cancel", cancelIntent: true });
    const interrupt = t.driver.requestStop(t.task, { terminal: "interrupted", reason: "owner_interrupt", cancelIntent: false });
    assert.throws(() => t.driver.registerManagedProcess(t.task.id, { kind: "starting", id: "late", label: "迟到单元", stop: async () => true }), (err: unknown) => err instanceof ExecutionError && err.code === "task_ending");
    release(false);
    assert.deepEqual(await Promise.all([cancel, interrupt]), [false, false]);
    await run;
    assert.equal(await t.driver.stopManagedProcesses(t.task.id), false);
    assert.equal(t.runtime.store.getTask(t.task.id)!.cancelRequested, true, "并发中断不能覆盖先到的拥有者取消意图");
    assert.equal(stops, 1);
    assert.equal(t.runtime.store.listAllOccupancy()[0]!.taskId, t.task.id);
    const events = t.runtime.store.getTaskEventsAfter(t.task.id, 0, 100);
    assert.equal(events.filter((e) => ["task.completed", "task.canceled", "task.interrupted"].includes(e.body.type)).length, 1);
    assert.equal(events.filter((e) => e.body.type === "task.tool_process_unreaped").length, 1);
  } finally { release(false); await t.shutdown(); }
});

for (const failure of ["false", "throw"] as const) {
  test(`Driver 工具边界模式切换：stop ${failure} 保留模式、占用和专用事件`, async () => {
    const t = await driverFixture(async () => {
      if (failure === "throw") throw new Error("可控停止失败");
      return false;
    });
    const original = (t.driver as any).ensureSdk;
    try {
      (t.driver as any).ensureSdk = async (...args: unknown[]) => {
        const sdk = await original.apply(t.driver, args);
        t.runtime.store.withTx(() => t.runtime.store.requestModeSwitch(t.task.id, "full_access"));
        await assert.rejects((t.driver as any).boundaryTask(t.runtime.store.getTask(t.task.id)), (err: unknown) => err instanceof ExecutionError && err.code === "mode_switch_unverified");
        return sdk;
      };
      await t.driver.run(t.task);
      const task = t.runtime.store.getTask(t.task.id)!;
      assert.equal(task.status, "interrupted");
      assert.equal(task.interruptReason, "mode_switch_unverified");
      assert.equal(task.accessMode, "confirm");
      assert.equal(task.permissionVersion, 1);
      assert.equal(task.pendingAccessMode, null);
      assert.equal(t.runtime.store.listAllOccupancy()[0]!.taskId, task.id);
      const events = t.runtime.store.getTaskEventsAfter(task.id, 0, 100);
      assert.equal(events.filter((e) => e.body.type === "task.mode_switch_failed").length, 1);
      assert.equal(events.filter((e) => e.body.type === "task.mode_switched").length, 0);
      assert.ok(events.some((e) => e.body.type === "task.tool_process_unreaped" && e.body.reason === "mode_switch_unverified"));
      assert.equal(t.server.calls.length, 0);
    } finally { (t.driver as any).ensureSdk = original; await t.shutdown(); }
  });
}

test("Driver 模式切换失败：效果未知与专用终态事件在同一事务保留", async () => {
  const t = await driverFixture(async () => false);
  const original = (t.driver as any).ensureSdk;
  try {
    (t.driver as any).ensureSdk = async (...args: unknown[]) => {
      const sdk = await original.apply(t.driver, args);
      t.runtime.store.withTx(() => {
        t.runtime.store.requestModeSwitch(t.task.id, "full_access");
        t.runtime.store.recordToolIntent({ id: "inflight-write", taskId: t.task.id, sessionId: t.session.id, toolName: "bash", params: {} });
      });
      await t.driver.requestStop(t.task, {
        terminal: "interrupted", reason: "mode_switch_unverified", cancelIntent: false,
        modeSwitchFailure: { to: "full_access", reason: "无法核实旧执行单元已退出" },
      });
      return sdk;
    };
    await t.driver.run(t.task);
    const task = t.runtime.store.getTask(t.task.id)!;
    assert.equal(task.status, "interrupted");
    assert.equal(task.effectUnknown, true);
    assert.equal(t.runtime.store.getToolOp("inflight-write")!.effectUnknown, true);
    const events = t.runtime.store.getTaskEventsAfter(task.id, 0, 100);
    const unknownIndex = events.findIndex((event) => event.body.type === "task.tool_effect_unknown");
    const endedIndex = events.findIndex((event) => event.body.type === "task.mode_switch_failed");
    assert.ok(unknownIndex >= 0 && unknownIndex < endedIndex);
    assert.equal(events.filter((event) => event.body.type === "task.mode_switch_failed").length, 1);
    assert.ok(events.some((event) => event.body.type === "task.tool_process_unreaped" && event.body.reason === "mode_switch_unverified"));
    assert.equal(task.pendingAccessMode, null);
    assert.equal(t.runtime.store.listAllOccupancy()[0]!.taskId, task.id);
  } finally { (t.driver as any).ensureSdk = original; await t.shutdown(); }
});

test("Driver 已核实停止后允许后续单元；新单元未核实仍保留占用", async () => {
  let firstStops = 0;
  let laterStops = 0;
  const t = await driverFixture(async () => { firstStops++; return true; });
  const original = (t.driver as any).ensureSdk;
  try {
    (t.driver as any).ensureSdk = async (...args: unknown[]) => {
      const sdk = await original.apply(t.driver, args);
      const wrong = { kind: "starting" as const, id: "wrong", label: "错误归属", stop: async () => true };
      assert.throws(() => t.driver.registerManagedProcess("other-task", wrong), (err: unknown) => err instanceof ExecutionError && err.code === "task_mismatch");
      assert.equal(await t.driver.stopManagedProcesses(t.task.id), true);
      assert.equal(await t.driver.stopManagedProcesses(t.task.id), true);
      t.driver.registerManagedProcess(t.task.id, { kind: "starting", id: "later", label: "后续单元", stop: async () => { laterStops++; return false; } });
      return sdk;
    };
    await t.driver.run(t.task);
    assert.equal(firstStops, 1);
    assert.equal(laterStops, 1);
    assert.equal(t.runtime.store.getTask(t.task.id)!.status, "completed");
    assert.equal(t.runtime.store.listAllOccupancy()[0]!.taskId, t.task.id);
  } finally { (t.driver as any).ensureSdk = original; await t.shutdown(); }
});

test("Driver 未核实的完成任务：后台重启仍保留结果、原因与占用，拥有者核实后恢复", async () => {
  const t = await driverFixture(async () => false);
  let recovered: Runtime | null = null;
  try {
    await t.driver.run(t.task);
    t.runtime.store.withTx(() => t.runtime.store.setSessionQueueState(t.session.id, "active", null));
    await t.runtime.stop("test_restart");
    recovered = await Runtime.start(t.runtime.config);
    assert.equal(recovered.store.getTask(t.task.id)!.status, "completed");
    assert.equal(recovered.snapshot().tasks.find((task) => task.id === t.task.id)!.status, "completed");
    assert.ok(recovered.store.getTaskEventsAfter(t.task.id, 0, 100).some((e) => e.body.type === "task.tool_process_unreaped" && e.body.reason === "tool_process_unreaped"));
    assert.equal(recovered.store.listAllOccupancy()[0]!.taskId, t.task.id);
    assert.equal(recovered.store.getSession(t.session.id)!.queuePauseReason, "occupancy_unverified");
    await recovered.resumeQueue(t.session.id);
    assert.equal(recovered.store.listAllOccupancy().length, 0);
    assert.equal(t.server.calls.length, 1, "核实恢复不重放已完成任务");
  } finally { await recovered?.stop("end"); await t.shutdown(); }
});

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

test("父任务持有多副本占用：已核实副本单独释放，未核实副本与父目录保留到整任务释放", () => {
  const f = fixture();
  try {
    assert.equal(f.occupy(), true);
    const copyA = `${f.session.cwdReal}-copy-a`;
    const copyB = `${f.session.cwdReal}-copy-b`;
    for (const [index, cwdReal] of [copyA, copyB].entries()) {
      assert.equal(f.store.withTx(() => f.store.tryAcquireOccupancy({ cwdReal, cwdDev: 1, cwdIno: index + 2, sessionId: f.session.id, taskId: f.task.id })), true);
    }
    assert.equal(f.store.releaseOccupancyForDir("another-task", copyA), false);
    assert.equal(f.store.releaseOccupancyForDir(f.task.id, copyA), true);
    assert.deepEqual(f.store.listAllOccupancy().map((o) => o.cwdReal).sort(), [f.session.cwdReal, copyB].sort());
    assert.equal(f.store.releaseOccupancy(f.task.id), true);
    assert.equal(f.store.listAllOccupancy().length, 0);
    assert.equal(f.store.releaseOccupancy(f.task.id), false);
  } finally { f.cleanup(); }
});

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
      stopManagedProcesses: async () => true,
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

function endingFixture() {
  const f = fixture();
  f.store.withTx(() => f.store.transitionTask(f.task.id, ["queued"], "running"));
  f.occupy();
  const ending: TaskEndingContext = { taskId: f.task.id, stopSnapshot: null };
  let releases = 0;
  const deps = { store: f.store, ledger: new ToolOpLedger(f.store), onReleased: () => { releases++; } };
  const intent = (id: string, toolName = "write") => f.store.withTx(() => f.store.recordToolIntent({ id, taskId: f.task.id, sessionId: f.session.id, toolName, params: {} }));
  return { ...f, ending, deps, intent, releases: () => releases };
}

for (const stop of ["true", "false", "throw", "missing"] as const) {
  test(`统一收尾：halt ${stop} 的占用、诊断原因、事务钩子与唯一唤醒`, async () => {
    const f = endingFixture();
    try {
      let inTx = 0;
      const result = await endTaskExecution(f.deps, f.task, f.ending, {
        terminal: "failed", reason: "执行失败", unreapedReason: "controlled_stop",
        ...(stop === "missing" ? {} : { halt: async () => { if (stop === "throw") throw new Error("stop failure"); return stop === "true"; } }),
        inTx: result => { assert.equal(result.changed, true); assert.equal(result.reaped, stop === "true"); inTx++; },
      });
      assert.deepEqual(result, { changed: true, reaped: stop === "true" });
      assert.equal(inTx, 1);
      assert.equal(f.store.getTask(f.task.id)!.errorMessage, "执行失败");
      assert.equal(f.store.listAllOccupancy().length, stop === "true" ? 0 : 1);
      assert.equal(f.releases(), stop === "true" ? 1 : 0);
      assert.equal(f.store.getTaskEventsAfter(f.task.id, 0, 100).some(e => e.body.type === "task.tool_process_unreaped" && e.body.reason === "controlled_stop"), stop !== "true");
    } finally { f.cleanup(); }
  });
}

for (const terminal of ["canceled", "interrupted"] as const) {
  test(`统一中止 ${terminal}：首次快照先于 halt，竞争失败仍补已知结果，不追加未知`, async () => {
    const f = endingFixture();
    try {
      f.intent("write");
      f.intent("read", "read");
      f.store.withTx(() => f.store.setCancelRequested(f.task.id, terminal !== "canceled"));
      let changed: boolean | undefined;
      const result = await endTaskExecution(f.deps, f.task, f.ending, { terminal, abort: true, unreapedReason: "stop",
        halt: async () => {
          assert.equal(f.store.getTask(f.task.id)!.cancelRequested, terminal === "canceled");
          assert.deepEqual(f.ending.stopSnapshot, ["write"]);
          f.store.withTx(() => f.store.endTask(f.task.id, ["running"], "completed"));
          return true;
        }, inTx: result => { changed = result.changed; } });
      assert.equal(result.changed, false);
      assert.equal(changed, false);
      assert.equal(f.store.getToolOp("write")!.effectUnknown, false);
      assert.match(f.store.getToolOp("read")!.resultSummary!, /无写入效果/);
      assert.equal(f.releases(), 0);
    } finally { f.cleanup(); }
  });
}

test("统一自然收尾：没有中止快照不补工具结果，新任务独立保存快照", async () => {
  const f = endingFixture();
  try {
    f.intent("write"); f.intent("read", "read");
    await endTaskExecution(f.deps, f.task, f.ending, { terminal: "completed", halt: async () => true, unreapedReason: "stop" });
    assert.equal(f.ending.stopSnapshot, null);
    for (const op of f.store.listToolOpsByTask(f.task.id)) { assert.equal(op.resultSummary, null); assert.equal(op.effectUnknown, false); }
    const next = f.newTask();
    f.store.withTx(() => f.store.transitionTask(next.id, ["queued"], "running"));
    const ending: TaskEndingContext = { taskId: next.id, stopSnapshot: null };
    await endTaskExecution(f.deps, next, ending, { terminal: "canceled", abort: true, halt: async () => true, unreapedReason: "stop" });
    assert.deepEqual(ending.stopSnapshot, []);
    assert.equal(f.store.getToolOp("write")!.effectUnknown, false);
  } finally { f.cleanup(); }
});

for (const race of ["nested", "natural"] as const) {
  test(`共享首次快照：${race} 赢得终态，迟到结果仍未知且事件先于唯一终态与唤醒`, async () => {
    const f = endingFixture();
    try {
      f.intent("write");
      const stop = { terminal: "interrupted" as const, abort: true as const, halt: async () => true, unreapedReason: "stop" };
      if (race === "nested") {
        await endTaskExecution(f.deps, f.task, f.ending, { ...stop, halt: async () => {
          f.store.withTx(() => f.deps.ledger.recordResult(f.task, "write", "迟到结果", true));
          assert.deepEqual(f.deps.ledger.beginStop(f.task.id), []);
          return (await endTaskExecution(f.deps, f.task, f.ending, stop)).reaped;
        } });
      } else {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const natural = endTaskExecution(f.deps, f.task, f.ending, { terminal: "completed", unreapedReason: "stop", halt: async () => {
          await gate;
          f.store.withTx(() => f.deps.ledger.recordResult(f.task, "write", "迟到结果", true));
          return true;
        } });
        let finishStop!: () => void;
        const stopping = endTaskExecution(f.deps, f.task, f.ending, { ...stop, halt: () => new Promise<boolean>(resolve => { finishStop = () => resolve(true); }) });
        release(); await natural; finishStop(); await stopping;
      }
      assert.deepEqual(f.ending.stopSnapshot, ["write"]);
      assert.equal(f.store.getToolOp("write")!.effectUnknown, true);
      const events = f.store.getTaskEventsAfter(f.task.id, 0, 100);
      const terminal = events.findIndex(e => e.body.type === "task.interrupted" || e.body.type === "task.completed");
      assert.ok(events.findIndex(e => e.body.type === "task.tool_effect_unknown") < terminal);
      assert.equal(events.filter(e => e.body.type === "task.interrupted" || e.body.type === "task.completed").length, 1);
      assert.equal(f.releases(), 1);
    } finally { f.cleanup(); }
  });
}

test("统一收尾事务回滚：已知结果与未知标记回滚，首次快照仍供保留占用的兜底使用", async () => {
  const f = endingFixture();
  try {
    f.intent("write"); f.intent("read", "read");
    await assert.rejects(endTaskExecution(f.deps, f.task, f.ending, { terminal: "interrupted", abort: true, unreapedReason: "stop",
      halt: async () => true, inTx: () => { throw new Error("transaction failure"); } }), /transaction failure/);
    assert.deepEqual(f.ending.stopSnapshot, ["write"]);
    assert.equal(f.store.getTask(f.task.id)!.status, "running");
    assert.equal(f.store.getTask(f.task.id)!.cancelRequested, false);
    assert.equal(f.store.getToolOp("read")!.resultSummary, null);
    assert.equal(f.store.getToolOp("write")!.effectUnknown, false);
    assert.equal(f.releases(), 0);
    f.store.withTx(() => f.deps.ledger.recordResult(f.task, "write", "迟到", true));
    await endTaskExecution(f.deps, f.task, f.ending, { terminal: "failed", reason: "兜底", unreapedReason: "fallback" });
    assert.equal(f.store.getToolOp("write")!.effectUnknown, true);
    assert.match(f.store.getToolOp("read")!.resultSummary!, /无写入效果/);
    assert.equal(f.store.listAllOccupancy().length, 1);
    assert.equal(f.releases(), 0);
  } finally { f.cleanup(); }
});

for (const acquired of [false, true]) {
  test(`真实队列：getDriver ${acquired ? "返回后执行" : "返回前"}异常，按完整停止证据决定占用`, async () => {
    const t = await startTestRuntime("queue-fallback", async () => ({ kind: "text", text: "不应调用模型" }));
    const rt = t.runtime, original = (rt as any).getDriver;
    let stops = 0;
    try {
      const session = await rt.createSession({ projectName: "fallback", cwd: t.work[0] });
      (rt as any).getDriver = async () => {
        if (!acquired) throw new Error("getDriver failure");
        return { run: async () => { throw new Error("run failure"); }, stopManagedProcesses: async () => { stops++; return true; } };
      };
      const task = await rt.submit({ sessionId: session.id, requestId: "fallback", input: "test", modelSelection: rt.defaultSelection });
      await waitFor("真实 catch 与 finally 完成", () => rt.store.getTask(task.id)!.status === "failed" && !(rt as any).loopActive.has(session.id));
      assert.equal(rt.store.listAllOccupancy().some(held => held.taskId === task.id), acquired);
      assert.equal(stops, acquired ? 1 : 0);
      assert.equal(rt.store.getTaskEventsAfter(task.id, 0, 100).filter(e => e.body.type === "task.tool_process_unreaped").length, acquired ? 1 : 0);
      assert.equal(t.server.calls.length, 0);
    } finally { (rt as any).getDriver = original; await t.shutdown(); }
  });
}

test("真实队列：浏览器未核实、终态变更后回滚、worker 已停，catch 仍保留首次快照与占用并挡住后续任务", async () => {
  let workerStops = 0, browserStops = 0;
  const t = await startTestRuntime("queue-browser-rollback", async () => ({ kind: "text", text: "不应调用模型" }), { config: {
    toolFactory: context => { context.registry.register({ kind: "starting", id: "worker", label: "worker", stop: async () => { workerStops++; return true; } }); return createMockTools(context); },
  } });
  const rt = t.runtime;
  const endTask = rt.store.endTask.bind(rt.store);
  const close = (rt as any).browserManager.close;
  let rolledBack = false;
  let driver: Driver | undefined, ensureSdk: any;
  try {
    const session = await rt.createSession({ projectName: "browser", cwd: t.work[0] });
    driver = await (rt as any).getDriver(session);
    ensureSdk = (driver as any).ensureSdk;
    (rt as any).browserManager.close = async () => { browserStops++; return false; };
    (driver as any).ensureSdk = async (...args: unknown[]) => {
      const sdk = await ensureSdk.apply(driver, args);
      sdk.prompt = async () => {
        const task = rt.store.getTask(driver!.currentTaskId!)!;
        rt.store.withTx(() => rt.store.recordToolIntent({ id: "rollback-write", taskId: task.id, sessionId: task.sessionId, toolName: "write", params: {} }));
        await driver!.requestStop(task, { terminal: "interrupted", reason: "owner_stop", cancelIntent: false });
      };
      return sdk;
    };
    rt.store.endTask = (...args) => {
      const changed = endTask(...args);
      if (changed && !rolledBack && args[2] === "interrupted") {
        rolledBack = true;
        assert.equal(rt.store.getTask(args[0])!.status, "interrupted");
        throw new Error("first terminal transaction failure");
      }
      return changed;
    };
    const task = await rt.submit({ sessionId: session.id, requestId: "rollback", input: "test", modelSelection: rt.defaultSelection });
    await waitFor("队列实际兜底与 finally", () => rt.store.getTask(task.id)!.status === "failed" && !(rt as any).loopActive.has(session.id));
    assert.equal(rolledBack, true);
    assert.equal(browserStops, 1);
    assert.equal(workerStops, 1);
    assert.equal(rt.store.getTask(task.id)!.effectUnknown, true);
    assert.equal(rt.store.getOccupancyByDir(session.cwdReal)!.taskId, task.id);
    const events = rt.store.getTaskEventsAfter(task.id, 0, 100);
    assert.equal(events.filter(e => e.body.type === "task.failed").length, 1);
    assert.equal(events.filter(e => e.body.type === "task.interrupted").length, 0);
    assert.ok(events.some(e => e.body.type === "task.tool_process_unreaped" && e.body.reason === "tool_process_unreaped"));
    const nextSession = await rt.createSession({ projectName: "next", cwd: t.work[0] });
    const next = await rt.submit({ sessionId: nextSession.id, requestId: "next", input: "等待占用", modelSelection: rt.defaultSelection });
    await waitFor("后续队列已检查", () => !(rt as any).loopActive.has(nextSession.id));
    assert.equal(rt.store.getTask(next.id)!.status, "queued");
    assert.equal(t.server.calls.length, 0);
  } finally {
    rt.store.endTask = endTask;
    (rt as any).browserManager.close = close;
    if (driver) (driver as any).ensureSdk = ensureSdk;
    await t.shutdown();
  }
});

for (const boundary of ["mode", "yield"] as const) {
  for (const reaped of [false, true]) {
    test(`Driver ${boundary} 交接${reaped ? "成功不保留中止事实" : "失败前快照覆盖停止期间迟到结果"}`, async () => {
      let late!: () => void;
      const t = await driverFixture(async () => { late(); return reaped; });
      const ensureSdk = (t.driver as any).ensureSdk;
      try {
        (t.driver as any).ensureSdk = async (...args: unknown[]) => {
          const sdk = await ensureSdk.apply(t.driver, args);
          t.runtime.store.withTx(() => t.runtime.store.recordToolIntent({ id: "handoff-write", taskId: t.task.id, sessionId: t.task.sessionId, toolName: "write", params: {} }));
          late = () => t.runtime.store.withTx(() => new ToolOpLedger(t.runtime.store).recordResult(t.task, "handoff-write", "停止期间迟到结果", true));
          if (boundary === "mode") {
            t.runtime.store.withTx(() => t.runtime.store.requestModeSwitch(t.task.id, "full_access"));
            const attempt = (t.driver as any).boundaryTask(t.runtime.store.getTask(t.task.id));
            if (reaped) await attempt;
            else await assert.rejects(attempt, { code: "mode_switch_unverified" });
          } else assert.equal(await t.driver.yieldWorkspace(t.task.id), reaped);
          assert.equal(t.driver.currentTaskEnding!.stopSnapshot === null, reaped);
          return sdk;
        };
        await t.driver.run(t.task);
        assert.equal(t.runtime.store.getToolOp("handoff-write")!.effectUnknown, !reaped);
        assert.equal(t.runtime.store.getTask(t.task.id)!.status, reaped ? "completed" : "interrupted");
        assert.equal(t.runtime.store.listAllOccupancy().length, reaped ? 0 : 1);
      } finally { (t.driver as any).ensureSdk = ensureSdk; await t.shutdown(); }
    });
  }
}

test("Driver 成功交接不能撤去外层已采用的快照，即使内层停止入口尚未到达", async () => {
  let entered = false, releaseWorker!: () => void, finishOuter!: () => void;
  const workerGate = new Promise<void>(resolve => { releaseWorker = resolve; });
  const outerGate = new Promise<void>(resolve => { finishOuter = resolve; });
  let late!: () => void;
  const t = await driverFixture(async () => { entered = true; await workerGate; late(); return true; });
  const ensureSdk = (t.driver as any).ensureSdk;
  let outer: Promise<unknown> | undefined;
  try {
    (t.driver as any).ensureSdk = async (...args: unknown[]) => {
      const sdk = await ensureSdk.apply(t.driver, args);
      t.runtime.store.withTx(() => t.runtime.store.recordToolIntent({ id: "adopted-write", taskId: t.task.id, sessionId: t.task.sessionId, toolName: "write", params: {} }));
      const ledger = new ToolOpLedger(t.runtime.store);
      late = () => t.runtime.store.withTx(() => ledger.recordResult(t.task, "adopted-write", "迟到结果", true));
      const handoff = t.driver.yieldWorkspace(t.task.id);
      await waitFor("交接停止已进入", () => entered);
      outer = endTaskExecution({ store: t.runtime.store, ledger }, t.task, t.driver.currentTaskEnding!, {
        terminal: "interrupted", abort: true, unreapedReason: "outer", halt: async () => { await outerGate; return true; },
      });
      releaseWorker();
      assert.equal(await handoff, true);
      assert.deepEqual(t.driver.currentTaskEnding!.stopSnapshot, ["adopted-write"]);
      return sdk;
    };
    await t.driver.run(t.task);
    finishOuter(); await outer;
    assert.equal(t.runtime.store.getToolOp("adopted-write")!.effectUnknown, true);
    assert.equal(t.runtime.store.getTaskEventsAfter(t.task.id, 0, 100).filter(e => ["task.completed", "task.interrupted"].includes(e.body.type)).length, 1);
  } finally { releaseWorker(); finishOuter(); await outer; (t.driver as any).ensureSdk = ensureSdk; await t.shutdown(); }
});
