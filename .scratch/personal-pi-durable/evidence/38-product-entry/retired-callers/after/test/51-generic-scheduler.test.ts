/** 通用调度使用真实 Runtime/SQLite；模型与固定通知渠道模拟，worker 为 local。 */
import * as fs from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Driver } from "@ruukoto/agent/driver.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { parseRule, firstDue } from "@ruukoto/channels/scheduler/time.ts";
import type { AccessMode } from "@ruukoto/core/types.ts";
import type { Responder } from "./helpers/mock-provider.ts";
import { afterTool, lastUserText, realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";

const TARGET = { channel: "telegram", account: "1", chatId: "42", configVersion: 1 };

async function kit(responder: Responder) {
  const clock = { now: Date.parse("2026-10-12T00:00:00Z") };
  const reports: string[] = [];
  const t = await startTestRuntime("generic-lifecycle", responder, { config: {
    ...realTools(), qqDisabled: true,
    scheduler: { now: () => clock.now, tickMs: 0, channel: { target: () => TARGET, send: async (input) => {
      reports.push(input.text); return { platformMessageId: `sent-${reports.length}` };
    } } },
  } });
  const plan = (instruction: string, mode: AccessMode = "full_access", recurring = false) => {
    const main = t.runtime.store.getAgentRole("main")!;
    const rule = parseRule(recurring ? { kind: "daily", time: "00:01", time_zone: "UTC" } : { kind: "once", at: "2026-10-12T00:00:01Z", time_zone: "UTC" });
    return t.runtime.store.withTx(() => t.runtime.sched.insertSchedule({
      createKey: instruction, paramsDigest: instruction, createTaskId: null, createOpId: null,
      projectId: main.projectId, createPermissionVersion: 1, accessMode: mode, rule,
      instruction, sourceRefs: [], target: TARGET, nextDueAt: firstDue(rule, clock.now), tzData: "test", reason: "test",
    }, "test"));
  };
  const fire = async () => { clock.now += 1_000; await t.runtime.scheduler!.tick(); };
  const settle = async () => { t.runtime.scheduler!.closeFinished(); await t.runtime.scheduler!.tick(); await t.runtime.scheduler!.idle(); };
  return { ...t, clock, reports, plan, fire, settle };
}

test("子任务与协作消息完成后才关闭整项运行；一次最终汇报，模式与上下文独立", async () => {
  let release!: () => void;
  const childGate = new Promise<void>((resolve) => { release = resolve; });
  const k = await kit(async (req) => {
    const input = lastUserText(req);
    if (input.startsWith("[SubAgent 委派")) {
      if (afterTool(req)) { await childGate; return { kind: "text", text: "CHILD-FINAL" }; }
      const work = /工作 (\S+)（/.exec(input)![1]!;
      return { kind: "tool_calls", calls: [{ id: "message", name: "subagent_message", arguments: { work_id: work, key: "progress", text: "CHILD-PROGRESS" } }] };
    }
    if (input.startsWith("[工作内消息")) return { kind: "text", text: "PROGRESS-RECEIVED" };
    if (input.startsWith("[编排器]")) return { kind: "text", text: "RUN-FINAL" };
    if (input.includes("RUN-DELEGATE")) {
      if (afterTool(req)) return { kind: "text", text: "INITIAL-ACK" };
      return { kind: "tool_calls", calls: [{ id: "delegate", name: "subagent_delegate", arguments: {
        key: "child", request: "分析", materials: [{ kind: "text", text: "EXPLICIT-MATERIAL" }],
      } }] };
    }
    return { kind: "text", text: "MAIN-CHAT" };
  });
  try {
    const main = k.runtime.store.getAgentRole("main")!;
    const prior = await k.runtime.submit({ sessionId: main.sessionId, requestId: "private", input: "PRIVATE-MAIN-HISTORY", modelSelection: k.runtime.defaultSelection });
    await waitFor("主聊天完成", () => k.runtime.store.getTask(prior.id)!.status === "completed");
    const plan = k.plan("RUN-DELEGATE");
    await k.fire();
    const run = k.runtime.sched.listRuns(plan.id, 10)[0]!;
    await waitFor("子任务发出进度消息", () => k.runtime.store.listPendingSubAgentMessages().length > 0 || k.runtime.store.listScheduledRunTasks(run.id).some((t) => t.requestId.startsWith("smsg:")));
    await k.settle();
    assert.equal(k.runtime.sched.getRun(run.id)!.closedAt, null, "根任务与进度回合完成也不能提前关闭");
    assert.equal(k.reports.length, 0);
    assert.notEqual(run.sessionId, main.sessionId);
    assert.equal(k.runtime.store.getSessionIdentity(run.sessionId!)!.kind, "scheduled");
    const root = k.runtime.store.getTask(run.rootTaskId!)!;
    assert.equal(root.accessMode, "full_access");
    const scheduledRequests = k.server.calls.filter((call) => lastUserText(call).includes("RUN-DELEGATE") || lastUserText(call).startsWith("[SubAgent 委派"));
    assert.ok(scheduledRequests.every((call) => !JSON.stringify(call).includes("PRIVATE-MAIN-HISTORY")));
    release();
    await waitFor("结果汇总完成", () => k.runtime.store.listScheduledRunTasks(run.id).some((t) => t.requestId.startsWith("wake:") && t.resultSummary !== null));
    await k.settle();
    const done = k.runtime.sched.getRun(run.id)!;
    assert.equal(done.resultStatus, "completed");
    assert.ok(done.resultText!.includes("RUN-FINAL"));
    assert.equal(k.reports.length, 1);
    assert.ok(k.reports[0]!.includes("RUN-FINAL") && !k.reports[0]!.includes("INITIAL-ACK"));
    assert.ok(k.runtime.store.listScheduledRunTasks(run.id).every((task) => task.accessMode === "full_access"));
    await k.settle();
    assert.equal(k.reports.length, 1, "重复收尾与发送不增加第二份回报");
  } finally { release(); await k.shutdown(); }
});

test("取消整项运行停止子任务与汇总，迟到新委派或消息被拒，成果记录保留", async () => {
  let childStarted = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const k = await kit(async (req) => {
    const input = lastUserText(req);
    if (input.startsWith("[SubAgent 委派")) { childStarted = true; await gate; return { kind: "text", text: "LATE-CHILD" }; }
    if (input.includes("RUN-CANCEL") && !afterTool(req)) return { kind: "tool_calls", calls: [{ id: "delegate", name: "subagent_delegate", arguments: {
      key: "child", request: "分析", materials: [{ kind: "text", text: "材料" }],
    } }] };
    return { kind: "text", text: "ROOT-ACK" };
  });
  try {
    const plan = k.plan("RUN-CANCEL");
    await k.fire();
    await waitFor("子任务正在执行", () => childStarted);
    const run = k.runtime.sched.listRuns(plan.id, 1)[0]!;
    await k.runtime.scheduleCancel({ scheduleId: plan.id, expectedVersion: plan.version, reason: "取消" });
    release();
    await waitFor("所有派生任务到终态", () => k.runtime.store.listScheduledRunTasks(run.id).every((task) => ["completed", "canceled", "interrupted", "failed"].includes(task.status)));
    const tasks = k.runtime.store.listScheduledRunTasks(run.id);
    await assert.rejects(() => k.runtime.subagents!.delegate({ parentTaskId: run.rootTaskId!, key: "late", request: "迟到", materials: [{ kind: "text", text: "材料" }], paramsDigest: "late" }), { code: "task_ending" });
    const child = tasks.find((task) => task.subAgentId)!;
    await assert.rejects(() => k.runtime.subagents!.message({ senderTaskId: child.id, workId: child.workId!, key: "late", text: "迟到", paramsDigest: "late" }), { code: "task_ending" });
    await waitFor("结果已登记", () => k.runtime.store.listScheduledRunTasks(run.id).every((task) => task.resultSummary !== null));
    await k.settle();
    assert.equal(k.runtime.sched.getRun(run.id)!.resultStatus, "canceled");
    assert.equal(k.runtime.store.listScheduledRunTasks(run.id).length, tasks.length);
    assert.equal(k.reports.length, 0);
  } finally { release(); await k.shutdown(); }
});

test("受限运行独立等待审批，主聊天继续响应，计划保存模式跨默认变化与重启不重算", async () => {
  let stage = 0;
  const k = await kit(async (req) => {
    const input = lastUserText(req);
    if (input.includes("RUN-APPROVAL")) {
      const action = [
        { name: "app_data_define_table", arguments: { table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "建表" } },
        { name: "app_data_insert", arguments: { table: "todos", records: [{ title: "一" }, { title: "二" }], reason: "准备审批资料" } },
        { name: "app_data_delete", arguments: { table: "todos", rows: [{ id: 1, expected_version: 1 }, { id: 2, expected_version: 1 }], reason: "删除两行需要审批" } },
      ][stage++];
      if (action) return { kind: "tool_calls", calls: [{ id: `call-${stage}`, ...action }] };
    }
    return { kind: "text", text: input.includes("MAIN-RESPOND") ? "MAIN-RESPONDED" : "RUN-DONE" };
  });
  let rt = k.runtime;
  try {
    const plan = k.plan("RUN-APPROVAL", "confirm");
    const main = rt.store.getSession(rt.store.getAgentRole("main")!.sessionId)!;
    await rt.setSessionDefaultMode({ sessionId: main.id, mode: "full_access", expectedVersion: main.defaultAccessModeVersion });
    await k.fire();
    const run = rt.sched.listRuns(plan.id, 1)[0]!;
    await waitFor("调度请求审批", () => rt.store.getTask(run.rootTaskId!)!.status === "awaiting_confirmation");
    assert.equal(rt.store.listConfirmationsByTask(run.rootTaskId!)[0]!.toolName, "app_data_delete");
    assert.equal(rt.store.getTask(run.rootTaskId!)!.accessMode, "confirm");
    const chat = await rt.submit({ sessionId: main.id, requestId: "chat", input: "MAIN-RESPOND", modelSelection: rt.defaultSelection });
    await waitFor("主聊天响应", () => rt.store.getTask(chat.id)!.status === "completed");
    assert.equal(rt.readTaskReplyText(chat.id), "MAIN-RESPONDED");
    k.client.close();
    const config = rt.config;
    await rt.stop("test_restart");
    rt = await Runtime.start(config);
    assert.equal(rt.sched.getSchedule(plan.id)!.accessMode, "confirm");
    assert.equal(rt.sched.getRun(run.id)!.rootTaskId, run.rootTaskId);
    assert.equal(rt.store.getTask(run.rootTaskId!)!.status, "interrupted");
    assert.equal(rt.store.listConfirmationsByTask(run.rootTaskId!)[0]!.status, "stale");
    rt.scheduler!.closeFinished();
    assert.equal(rt.sched.getRun(run.id)!.resultStatus, "interrupted");
    assert.equal(rt.sched.listRuns(plan.id, 10).length, 1);
  } finally { await rt.stop("test_end"); await k.shutdown(); }
});

test("queued 首次执行与已登记汇总重启沿原任务键、模式、目标和独立上下文继续", async () => {
  const k = await kit((req) => ({ kind: "text", text: lastUserText(req).startsWith("[编排器]") ? "RECOVERED-FINAL" : "QUEUED-DONE" }));
  let rt = k.runtime;
  try {
    const create = rt.store.createSession.bind(rt.store);
    rt.store.createSession = (input) => {
      const session = create(input);
      if (input.cwd.includes("/scheduled/")) rt.store.setSessionQueueState(session.id, "paused", "fixture");
      return session;
    };
    const plan = k.plan("QUEUED-FIRST");
    await k.fire();
    rt.store.createSession = create;
    const run = rt.sched.listRuns(plan.id, 1)[0]!;
    assert.equal(rt.store.getTask(run.rootTaskId!)!.status, "queued");
    const delegated = await rt.subagents!.delegate({ parentTaskId: run.rootTaskId!, key: "child", request: "调研", materials: [{ kind: "text", text: "显式资料" }], paramsDigest: "child" });
    await waitFor("子结果已登记且汇总排队", () => rt.store.findTaskByRequest(run.sessionId!, `wake:${delegated.task.id}`)?.status === "queued");
    const summary = rt.store.findTaskByRequest(run.sessionId!, `wake:${delegated.task.id}`)!;
    const before = rt.store.listScheduledRunTasks(run.id).map((task) => task.id).sort();
    k.client.close();
    const config = rt.config;
    await rt.stop("test_restart");
    // 崩溃窗口的持久形态：两个任务尚未执行，未核实占用为空。
    const { Db } = await import("@ruukoto/core/db.ts");
    const { Store } = await import("@ruukoto/core/store.ts");
    const db = new Db(config.dataDir);
    try { new Store(db).setSessionQueueState(run.sessionId!, "active", null); } finally { db.close(); }
    rt = await Runtime.start(config);
    await waitFor("原任务与汇总继续完成", () => rt.store.getTask(run.rootTaskId!)!.resultSummary !== null && rt.store.getTask(summary.id)!.resultSummary !== null);
    assert.deepEqual(rt.store.listScheduledRunTasks(run.id).map((task) => task.id).sort(), before);
    assert.equal(rt.store.getTask(summary.id)!.accessMode, "full_access");
    assert.equal(rt.sched.getRun(run.id)!.sessionId, run.sessionId);
    assert.equal(k.server.calls.filter((call) => lastUserText(call).includes("QUEUED-FIRST")).length, 1);
    rt.scheduler!.closeFinished();
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    assert.equal(rt.sched.getRun(run.id)!.resultStatus, "completed");
    assert.equal(k.reports.length, 1);
    assert.ok(k.reports[0]!.includes("RECOVERED-FINAL"));
  } finally { await rt.stop("test_end"); await k.shutdown(); }
});

test("独立执行绑定失败回滚会话、任务与来源关联，运行记录失败且只回报一次", async () => {
  const k = await kit(() => ({ kind: "text", text: "不应调用模型" }));
  try {
    const sessions = k.runtime.store.listSessions().length;
    const plan = k.plan("BIND-FAILURE");
    k.runtime.sched.bindRunExecution = () => { throw new Error("INJECTED-BIND-FAILURE"); };
    await k.fire();
    const run = k.runtime.sched.listRuns(plan.id, 1)[0]!;
    assert.equal(run.sessionId, null);
    assert.equal(run.rootTaskId, null);
    assert.equal(k.runtime.store.listSessions().length, sessions);
    assert.equal(k.runtime.store.getInboundEvent(run.inboundEventId!)!.status, "failed");
    assert.equal(k.server.calls.length, 0);
    await k.settle();
    assert.equal(k.runtime.sched.getRun(run.id)!.resultStatus, "failed");
    assert.equal(k.reports.length, 1);
    await k.settle();
    assert.equal(k.reports.length, 1);
  } finally { await k.shutdown(); }
});

test("取消尚未执行的 root、子任务及待消息：结果均登记，运行关闭且不调用模型", async () => {
  const k = await kit(() => ({ kind: "text", text: "不应执行" }));
  try {
    const create = k.runtime.store.createSession.bind(k.runtime.store);
    k.runtime.store.createSession = (input) => {
      const session = create(input);
      if (input.cwd.includes("/agent-work/")) k.runtime.store.setSessionQueueState(session.id, "paused", "fixture");
      return session;
    };
    const plan = k.plan("CANCEL-QUEUED");
    await k.fire();
    const run = k.runtime.sched.listRuns(plan.id, 1)[0]!;
    const child = await k.runtime.subagents!.delegate({ parentTaskId: run.rootTaskId!, key: "child", request: "调研", materials: [{ kind: "text", text: "资料" }], paramsDigest: "child" });
    const message = await k.runtime.subagents!.message({ senderTaskId: run.rootTaskId!, workId: child.work.id, toSubAgentId: child.agent.id, key: "msg", text: "补充", paramsDigest: "msg" });
    assert.equal(message.delivery, "pending");
    await k.runtime.scheduleCancel({ scheduleId: plan.id, expectedVersion: plan.version, reason: "取消排队运行" });
    await waitFor("排队取消结果全部登记", () => k.runtime.store.listScheduledRunTasks(run.id).every((task) => task.resultSummary !== null));
    await k.settle();
    assert.ok(k.runtime.sched.getRun(run.id)!.closedAt);
    assert.equal(k.runtime.sched.getRun(run.id)!.resultStatus, "canceled");
    assert.equal(k.runtime.store.getSubAgentMessage(message.message.id)!.undeliveredReason, "work_canceled");
    assert.equal(k.server.calls.length, 0);
    assert.equal(k.reports.length, 0);
  } finally { await k.shutdown(); }
});

test("退出未核实占用阻止整项关闭与下轮重叠，核实后保留原结果再收尾", async () => {
  const k = await kit(() => ({ kind: "text", text: "已收到真实结果，等待停止核实" }));
  try {
    const plan = k.plan("UNVERIFIED-STOP", "full_access", true);
    k.clock.now += 59_000;
    await k.fire();
    const run = k.runtime.sched.listRuns(plan.id, 1)[0]!;
    await waitFor("本轮执行结果已登记", () => k.runtime.store.getTask(run.rootTaskId!)!.resultSummary !== null);
    const session = k.runtime.store.getSession(run.sessionId!)!;
    const stat = fs.statSync(session.cwdReal);
    k.runtime.store.withTx(() => k.runtime.store.tryAcquireOccupancy({ cwdReal: session.cwdReal, cwdDev: stat.dev, cwdIno: stat.ino, sessionId: session.id, taskId: run.rootTaskId! }));
    k.clock.now += 24 * 60 * 60_000;
    await k.settle();
    assert.equal(k.runtime.sched.getRun(run.id)!.closedAt, null);
    assert.ok(k.runtime.scheduleGet(plan.id).runs[0]!.stopUnverifiedTaskIds.includes(run.rootTaskId!));
    assert.equal(k.runtime.sched.listRuns(plan.id, 10).length, 1, "忙碌下一次时间合并，未核实前不启动第二轮");
    assert.equal(k.reports.length, 0);
    k.runtime.store.withTx(() => k.runtime.store.releaseOccupancy(run.rootTaskId!));
    await k.settle();
    assert.equal(k.runtime.sched.getRun(run.id)!.resultStatus, "completed");
    assert.equal(k.reports.length, 1);
  } finally { await k.shutdown(); }
});

test("宿主取消停止未核实：task中断及占用可见，运行继续开放等待核实", { timeout: 5_000 }, async () => {
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const k = await kit(async (req) => {
    if (lastUserText(req).includes("SELF-UNKNOWN") && !afterTool(req)) {
      entered = true;
      await gate;
      return { kind: "text", text: "取消后迟到的结果" };
    }
    return { kind: "text", text: "运行结果" };
  });
  try {
    const plan = k.plan("SELF-UNKNOWN");
    await k.fire();
    const run = k.runtime.sched.listRuns(plan.id, 1)[0]!;
    await waitFor("模型已进入任务", () => entered);
    const drivers = Reflect.get(k.runtime, "drivers") as Map<string, Driver>;
    drivers.get(run.sessionId!)!.stopManagedProcesses = async () => false;
    const canceled = await k.runtime.scheduleCancel({ scheduleId: plan.id, expectedVersion: plan.version, reason: "取消本运行" });
    assert.equal(canceled.status, "canceled");
    release();
    await waitFor("停止未核实的持久终态", () => ["canceled", "interrupted"].includes(k.runtime.store.getTask(run.rootTaskId!)!.status), 3_000);
    await k.settle();
    assert.equal(k.runtime.sched.getRun(run.id)!.closedAt, null);
    assert.ok(k.runtime.scheduleGet(plan.id).runs[0]!.stopUnverifiedTaskIds.includes(run.rootTaskId!));
    assert.equal(k.runtime.store.getTask(run.rootTaskId!)!.cancelRequested, true);
    assert.equal(k.reports.length, 0);
  } finally { release(); await k.shutdown(); }
});
