import { product as personalProduct } from "../apps/ruukoto/src/product.ts";
/**
 * 调度器与通知 outbox 集成测试（daily-agent issue 03）。
 *
 * 覆盖工单验证项：
 * - 时区与每日/每周规则跨夏令时边界不漂移（纽约 gap/fold、Lord_Howe 半小时、Kathmandu 偏移）；
 * - 同一幂等键最多一次可见发送（重复 tick、重复登记、并发领取）；
 * - 进程重启不丢到期提醒（pending 继续、sending → effect_unknown、长期停机只合并一次）；
 * - 发送失败、超时和结果未知可查询；
 * - 调度器不阻塞现有编码任务队列。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { firstDue, latestAtOrBefore, nextAfter, parseRule, RuleError } from "@ruukoto/channels/scheduler/time.ts";

// ---------- 时间规则 ----------

const ms = (s: string) => Date.parse(s);

test("时间：一次性必须带偏移；非法时区/越界日期/无效钟点拒绝", () => {
  assert.throws(() => parseRule({ kind: "once", at: "2026-10-01T09:00:00", time_zone: "Asia/Shanghai" }), RuleError);
  assert.throws(() => parseRule({ kind: "once", at: "2026-02-30T09:00:00Z", time_zone: "UTC" }), RuleError);
  assert.throws(() => parseRule({ kind: "daily", time: "24:00", time_zone: "UTC" }), RuleError);
  assert.throws(() => parseRule({ kind: "daily", time: "09:00", time_zone: "Mars/Olympus" }), RuleError);
  assert.throws(() => parseRule({ kind: "daily", time: "09:00", time_zone: "+08:00" }), RuleError);
  assert.throws(() => parseRule({ kind: "weekly", time: "09:00", weekdays: [1, 1], time_zone: "UTC" }), RuleError);
  assert.throws(() => parseRule({ kind: "weekly", time: "09:00", weekdays: [0], time_zone: "UTC" }), RuleError);
  const once = parseRule({ kind: "once", at: "2026-10-01T09:00:00+08:00", time_zone: "Asia/Shanghai" });
  assert.equal(once.kind === "once" && once.at, "2026-10-01T01:00:00.000Z");
  // 已过去的一次性时间：首次到期仍是原定时刻（登记后产生一次延迟触发）
  assert.equal(firstDue(once, ms("2027-01-01T00:00:00Z")), "2026-10-01T01:00:00.000Z");
});

test("时间：纽约 DST gap 向后移、次日回到原钟点；fold 只取第一次", () => {
  const daily = parseRule({ kind: "daily", time: "02:30", time_zone: "America/New_York" });
  // 2026-03-08 春季跳时：02:30 不存在 → 03:30 EDT（07:30Z）
  assert.equal(nextAfter(daily, ms("2026-03-08T05:00:00Z")), "2026-03-08T07:30:00.000Z");
  // 次日回到 02:30 EDT（06:30Z），不是 +24h 的 07:30Z
  assert.equal(nextAfter(daily, ms("2026-03-08T07:30:00Z")), "2026-03-09T06:30:00.000Z");
  const fold = parseRule({ kind: "daily", time: "01:30", time_zone: "America/New_York" });
  // 2026-11-01 秋季重复 01:30：只取较早的 EDT（05:30Z），下一次是次日 EST（06:30Z）
  assert.equal(nextAfter(fold, ms("2026-11-01T04:00:00Z")), "2026-11-01T05:30:00.000Z");
  assert.equal(nextAfter(fold, ms("2026-11-01T05:30:00Z")), "2026-11-02T06:30:00.000Z");
  // 钟点跨 DST 不漂移：DST 前后都在当地 09:00
  const nine = parseRule({ kind: "daily", time: "09:00", time_zone: "America/New_York" });
  assert.equal(nextAfter(nine, ms("2026-03-07T15:00:00Z")), "2026-03-08T13:00:00.000Z");
  assert.equal(nextAfter(nine, ms("2026-03-06T15:00:00Z")), "2026-03-07T14:00:00.000Z");
});

test("时间：Lord_Howe 半小时 DST、Kathmandu +05:45、每周与跨年闰日", () => {
  // Lord Howe 2026-10-04 02:00 → 02:30（半小时缺口）：02:15 不存在 → 02:45 +11:00
  const lh = parseRule({ kind: "daily", time: "02:15", time_zone: "Australia/Lord_Howe" });
  assert.equal(nextAfter(lh, ms("2026-10-03T14:00:00Z")), "2026-10-03T15:45:00.000Z");
  const ktm = parseRule({ kind: "daily", time: "00:10", time_zone: "Asia/Kathmandu" });
  assert.equal(nextAfter(ktm, ms("2026-12-31T12:00:00Z")), "2026-12-31T18:25:00.000Z"); // 次日 00:10 +05:45
  // 每周一、四 08:00 上海：周四（2026-09-24）之后是下周一
  const weekly = parseRule({ kind: "weekly", time: "08:00", weekdays: [4, 1], time_zone: "Asia/Shanghai" });
  assert.equal(nextAfter(weekly, ms("2026-09-24T00:00:00Z")), "2026-09-28T00:00:00.000Z");
  assert.equal(latestAtOrBefore(weekly, ms("2026-09-27T00:00:00Z")), "2026-09-24T00:00:00.000Z");
  // 跨年 + 闰日：2028-02-28 之后下一天是 02-29
  const utc = parseRule({ kind: "daily", time: "23:59", time_zone: "UTC" });
  assert.equal(nextAfter(utc, ms("2028-02-28T23:59:00Z")), "2028-02-29T23:59:00.000Z");
  assert.equal(nextAfter(utc, ms("2026-12-31T23:59:00Z")), "2027-01-01T23:59:00.000Z");
  // 多年停机：最近一次直接定位，不枚举全部周期
  assert.equal(latestAtOrBefore(utc, ms("2031-06-15T12:00:00Z")), "2031-06-14T23:59:00.000Z");
});

// ---------- 集成：Runtime + 可控时钟 + 模拟渠道 ----------

import * as path from "node:path";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { Db } from "@ruukoto/core/db.ts";
import { NotSentError, type NotifyChannel } from "@ruukoto/channels/scheduler/runtime.ts";
import type { NotifyTarget } from "@ruukoto/core/types.ts";
import { cleanupDirs, lastUserText, makeTestDirs, pendingConfirmation, waitFor, writeModelsJson, connectAuthedClient } from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { DatabaseSync } from "node:sqlite";

const TARGET: NotifyTarget = { channel: "mock", account: "bot1", chatId: "owner-chat", configVersion: 1 };

type SendBehavior = (input: { opId: string; text: string; signal: AbortSignal }) => Promise<{ platformMessageId: string }>;

function mockChannel() {
  const ch = {
    cfg: { ...TARGET } as NotifyTarget | null,
    online: true,
    sends: [] as Array<{ opId: string; text: string }>,
    behavior: (async () => ({ platformMessageId: "" })) as SendBehavior,
    target: () => (ch.cfg ? { ...ch.cfg } : null),
    available: () => ch.online,
    async send(input: { opId: string; target: NotifyTarget; text: string; signal: AbortSignal }) {
      ch.sends.push({ opId: input.opId, text: input.text });
      const r = await ch.behavior(input);
      return { platformMessageId: r.platformMessageId || `msg-${ch.sends.length}` };
    },
  };
  return ch satisfies NotifyChannel;
}

interface Harness {
  dirs: Awaited<ReturnType<typeof makeTestDirs>>["dirs"];
  server: MockModelServer;
  clock: { t: number };
  channel: ReturnType<typeof mockChannel>;
  config: RuntimeConfig;
  requests: string[];
  reqs: any[];
  close(): Promise<void>;
}

async function harness(prefix: string, startIso: string, responder?: Responder, opts: { sendTimeoutMs?: number; noChannel?: boolean } = {}): Promise<Harness> {
  const { dirs } = await makeTestDirs(prefix, 1);
  const requests: string[] = [];
  const reqs: any[] = [];
  const server = new MockModelServer(async (req, i) => {
    requests.push(lastUserText(req));
    reqs.push(req);
    return responder ? responder(req, i) : { kind: "text", text: "ok" };
  });
  await writeModelsJson(dirs, await server.start());
  const clock = { t: ms(startIso) };
  const channel = mockChannel();
  const config: RuntimeConfig = {
    product: personalProduct.runtime,
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
    scheduler: { channel: opts.noChannel ? undefined : channel, now: () => clock.t, tickMs: 0, sendTimeoutMs: opts.sendTimeoutMs ?? 2_000 },
    // 无模拟渠道时也不加载 Telegram 适配器（= 发送器未加载）
    telegramDisabled: opts.noChannel,
  };
  return {
    dirs, server, clock, channel, config, requests, reqs,
    async close() {
      await server.close();
      await cleanupDirs(dirs);
    },
  };
}

/** 宿主播种只验证调度机制；工具创建的来源复核由工具用例承担。 */
function addPlan(rt: Runtime, h: Harness, input: { key: string; rule: Record<string, unknown>; text: string; accessMode?: "confirm" | "full_access"; target?: NotifyTarget | null }) {
  const rule = parseRule(input.rule);
  return rt.store.withTx(() => rt.sched.insertSchedule({
    createKey: input.key, paramsDigest: "test", createTaskId: null, createOpId: null,
    projectId: rt.store.getAgentRole("main")!.projectId, createPermissionVersion: 1, accessMode: input.accessMode ?? "confirm",
    rule, instruction: input.text, sourceRefs: [], target: input.target === undefined ? { ...TARGET } : input.target,
    nextDueAt: firstDue(rule, h.clock.t), tzData: "test", reason: "test",
  }, "test"));
}

/** 已授权宿主通知替身，不使用退役的定时固定通知动作。 */
function enqueue(rt: Runtime, key: string, text: string) {
  return rt.store.withTx(() => rt.sched.insertOp({ sourceKind: "confirmation", sourceKey: key, taskId: null, hostOpId: null, target: { ...TARGET }, text, sourceRefs: [] }).op);
}

async function tickAt(rt: Runtime, h: Harness, iso: string): Promise<void> {
  h.clock.t = ms(iso);
  await rt.scheduler!.tick();
  await rt.scheduler!.idle();
  rt.scheduler!.kickSender();
  await rt.scheduler!.idle();
}

const opsOf = (rt: Runtime) => rt.sched.listOps({ limit: 50 }).items;
const schedulerEvents = (rt: Runtime) =>
  rt.store.db.prepare("SELECT * FROM inbound_events WHERE source = 'scheduler'").all() as any[];

test("通用计划：独立会话使用创建模式，重复扫描只运行一次并固定最终回报", async () => {
  const h = await harness("sched-run", "2026-09-24T00:00:00Z");
  const rt = await Runtime.start(h.config);
  try {
    const main = rt.store.getAgentRole("main")!;
    const schedule = addPlan(rt, h, { key: "run", accessMode: "full_access", rule: { kind: "daily", time: "09:00", time_zone: "Asia/Shanghai" }, text: "RUN-MARK 看看待办" });
    await tickAt(rt, h, "2026-09-24T00:59:59Z");
    assert.equal(schedulerEvents(rt).length, 0);
    h.clock.t = ms("2026-09-24T01:00:05Z");
    await Promise.all([rt.scheduler!.tick(), rt.scheduler!.tick(), rt.scheduler!.tick()]);
    await waitFor("独立运行完成", () => {
      rt.scheduler!.closeFinished();
      return Boolean(rt.sched.listRuns(schedule.id, 10)[0]?.closedAt);
    });
    rt.scheduler!.kickSender();
    await rt.scheduler!.idle();
    const [run] = rt.sched.listRuns(schedule.id, 10);
    assert.ok(run.sessionId && run.rootTaskId);
    assert.notEqual(run.sessionId, main.sessionId);
    assert.equal(rt.store.getTask(run.rootTaskId)!.accessMode, "full_access");
    assert.equal(rt.store.listTasksBySession(main.sessionId).length, 0, "计划不进入日常主聊天");
    assert.equal(run.resultStatus, "completed");
    assert.equal(rt.sched.getOp(run.notificationOpId!)!.status, "sent");
    assert.equal(h.channel.sends.length, 1);
    assert.equal(schedulerEvents(rt).length, 1);
    assert.equal(rt.sched.getSchedule(schedule.id)!.nextDueAt, "2026-09-25T01:00:00.000Z");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("outbox：同来源键同参返回原操作、异参冲突；同一操作只发送一次", async () => {
  const h = await harness("outbox-idempotent", "2026-09-24T00:00:00Z");
  const rt = await Runtime.start(h.config);
  try {
    const op = enqueue(rt, "message-1", "喝水提醒");
    assert.equal(enqueue(rt, "message-1", "喝水提醒").id, op.id);
    assert.throws(() => enqueue(rt, "message-1", "不同正文"), /已绑定不同/);
    await tickAt(rt, h, "2026-09-24T08:00:01Z");
    await tickAt(rt, h, "2026-09-24T08:00:02Z");
    assert.equal(h.channel.sends.length, 1);
    assert.equal(rt.sched.getOp(op.id)!.status, "sent");
    assert.equal(rt.store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("发送失败/超时/结果未知/迟到回执：状态可查询，均不自动重发", async () => {
  const h = await harness("sched-fail", "2026-09-24T00:00:00Z", undefined, { sendTimeoutMs: 150 });
  const rt = await Runtime.start(h.config);
  try {
    const once = (key: string, text: string) => enqueue(rt, key, text);
    const opFor = (text: string) => opsOf(rt).find((o) => o.text === text)!;
    h.channel.behavior = async () => { throw new NotSentError("rejected", "平台拒绝：chat not found"); };
    once("f1", "A-failed");
    await tickAt(rt, h, "2026-09-24T01:00:00Z");
    assert.equal(opFor("A-failed").status, "failed");
    assert.equal(opFor("A-failed").errorKind, "rejected");

    let resolveLate!: (v: { platformMessageId: string }) => void;
    h.channel.behavior = () => new Promise((r) => { resolveLate = r; });
    once("f2", "B-timeout");
    await tickAt(rt, h, "2026-09-24T01:00:01Z");
    assert.equal(opFor("B-timeout").status, "effect_unknown");
    resolveLate({ platformMessageId: "late-1" });
    await waitFor("迟到回执落库", () => opFor("B-timeout").lateReceipt !== null);
    assert.equal(opFor("B-timeout").status, "effect_unknown", "迟到成功不改状态");

    h.channel.behavior = async () => { throw new Error("ECONNRESET"); };
    once("f3", "C-ambiguous");
    await tickAt(rt, h, "2026-09-24T01:00:02Z");
    assert.equal(opFor("C-ambiguous").status, "effect_unknown");

    // 同步抛错的渠道：仍按可证明未发送收尾，不留 sending，也无未处理的超时拒绝
    const asyncSend = h.channel.send;
    h.channel.send = (() => { throw new NotSentError("invalid_request", "同步拒绝"); }) as any;
    once("f4", "D-sync-throw");
    await tickAt(rt, h, "2026-09-24T01:00:03Z");
    assert.equal(opFor("D-sync-throw").status, "failed");
    await new Promise((r) => setTimeout(r, 250)); // 超过 sendTimeoutMs，确认超时计时器已清理
    h.channel.send = asyncSend;

    const sendsBefore = h.channel.sends.length;
    h.channel.behavior = async () => ({ platformMessageId: "" });
    await tickAt(rt, h, "2026-09-25T01:00:00Z");
    assert.equal(h.channel.sends.length, sendsBefore, "失败/未知不自动重发");
    // 控制面可查询
    const listed = rt.notificationList({ status: "effect_unknown" });
    assert.equal(listed.operations.length, 2);
    assert.equal("text" in listed.operations[0]!, false, "列表不带正文");
    assert.equal(rt.notificationGet(opFor("B-timeout").id).operation.text, "B-timeout");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("目标：离线保持 pending 并显示原因；配置版本变化/停用取消；未加载发送器保持 pending", async () => {
  const h = await harness("sched-target", "2026-09-24T00:00:00Z");
  const rt = await Runtime.start(h.config);
  try {
    enqueue(rt, "t1", "T1");
    h.channel.online = false;
    await tickAt(rt, h, "2026-09-24T01:00:00Z");
    let [op] = opsOf(rt);
    assert.equal(op!.status, "pending");
    assert.match(op!.waitReason ?? "", /channel_offline/);
    assert.equal(h.channel.sends.length, 0);
    h.channel.cfg = { ...TARGET, configVersion: 2 };
    h.channel.online = true;
    await tickAt(rt, h, "2026-09-24T01:30:00Z");
    [op] = opsOf(rt);
    assert.equal(op!.status, "canceled");
    assert.match(op!.errorMessage ?? "", /target_changed/);
    assert.equal(h.channel.sends.length, 0, "不自动改发到新目标");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
  const h2 = await harness("sched-nosender", "2026-09-24T00:00:00Z", undefined, { noChannel: true });
  const rt2 = await Runtime.start(h2.config);
  try {
    enqueue(rt2, "t2", "T2");
    await tickAt(rt2, h2, "2026-09-24T01:00:00Z");
    const [op] = opsOf(rt2);
    assert.equal(op!.status, "pending");
    assert.match(op!.waitReason ?? "", /sender_unavailable/);
  } finally {
    await rt2.stop("test_end");
    await h2.close();
  }
});

test("重启：pending 继续发送一次；遗留 sending 转 effect_unknown 不重发；sent 不重发；未落结果的调度工具操作按账本核实", async () => {
  const h = await harness("sched-restart", "2026-09-24T00:00:00Z");
  let rt!: Runtime;
  let mainSession = "";
  let sentId = "";
  let hostOpId = "";
  try {
    rt = await Runtime.start(h.config);
    mainSession = rt.store.getAgentRole("main")!.sessionId;
    enqueue(rt, "r-sent", "SENT");
    await tickAt(rt, h, "2026-09-24T01:00:00Z");
    sentId = opsOf(rt)[0]!.id;
    h.channel.online = false;
    enqueue(rt, "r-pending", "PENDING");
    enqueue(rt, "r-sending", "SENDING");
    await tickAt(rt, h, "2026-09-24T02:00:00Z");
    // "已提交 sending、网络调用前崩溃"窗口：直接领取不发送
    const sending = opsOf(rt).find((o) => o.text === "SENDING")!;
    assert.ok(rt.store.withTx(() => rt.sched.claim(sending.id)));
    // 工具调用已登记但结果未落库（崩溃窗口）：伪造一条 schedule_create 意图
    const task = await rt.submit({ sessionId: mainSession, requestId: "seed", input: "seed", modelSelection: rt.defaultSelection });
    await waitFor("seed 完成", () => rt.store.getTask(task.id)!.status === "completed");
    hostOpId = "op_crash_window";
    rt.store.withTx(() => {
      rt.store.recordToolIntent({ id: hostOpId, taskId: task.id, sessionId: mainSession, toolName: "schedule_create", sdkCallId: "x", params: {} });
      rt.store.recordToolIntent({ id: "op_not_committed", taskId: task.id, sessionId: mainSession, toolName: "notification_enqueue", sdkCallId: "y", params: {} });
      rt.sched.insertSchedule({
        createKey: "main:tool", paramsDigest: "d", createTaskId: task.id, createOpId: hostOpId,
        projectId: rt.store.getAgentRole("main")!.projectId, createPermissionVersion: 1, accessMode: "confirm",
        rule: parseRule({ kind: "daily", time: "23:00", time_zone: "UTC" }), instruction: "x", sourceRefs: [], target: null, nextDueAt: "2026-09-24T23:00:00.000Z", tzData: "t", reason: "r",
      }, "test");
    });
    await rt.stop("restart");
    h.channel.online = true;
    rt = await Runtime.start(h.config);
    await rt.scheduler!.idle();
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    const byText = (t: string) => opsOf(rt).find((o) => o.text === t)!;
    assert.equal(byText("SENDING").status, "effect_unknown", "遗留 sending 不重发");
    assert.equal(byText("PENDING").status, "sent");
    assert.equal(rt.sched.getOp(sentId)!.status, "sent");
    assert.deepEqual(h.channel.sends.map((s) => s.text).sort(), ["PENDING", "SENT"], "每个操作至多一次可见发送");
    assert.match(rt.store.getToolOp(hostOpId)!.resultSummary ?? "", /已提交/);
    assert.match(rt.store.getToolOp("op_not_committed")!.resultSummary ?? "", /已知未提交/);
    assert.equal(rt.store.getToolOp(hostOpId)!.effectUnknown, false);
  } finally {
    try {
      await rt?.stop("test_end");
    } finally {
      await h.close();
    }
  }
});

/** main 工具脚本：按任务输入标记依次发出工具调用。 */
function toolScript(scripts: Record<string, Array<{ name: string; arguments: Record<string, unknown> }>>): Responder {
  const step = new Map<string, number>();
  return async (req) => {
    // 按当前任务输入匹配（同一 main 会话的历史里有更早任务的标记）
    const text = lastUserText(req);
    for (const [mark, calls] of Object.entries(scripts)) {
      if (!text.includes(mark)) continue;
      const i = step.get(mark) ?? 0;
      step.set(mark, i + 1);
      const call = calls[i];
      if (call) return { kind: "tool_calls", calls: [{ id: `${mark}-${i}`, name: call.name, arguments: call.arguments }] };
      return { kind: "text", text: `done:${mark}` };
    }
    return { kind: "text", text: `done:${text.slice(0, 20)}` };
  };
}

test("工具：通用计划固定创建模式、目标与资料；重复键幂等、旧动作及模型指定模式拒绝", async () => {
  const rule = { kind: "once", at: "2099-01-01T00:00:00Z", time_zone: "UTC" };
  const plan = { create_key: "plan", rule, instruction: "检查明确资料", content: [{ kind: "text", text: "MATERIAL-MARK" }], reason: "定时检查" };
  const h = await harness("schedule-tool-mode", "2026-09-24T00:00:00Z", toolScript({
    "CREATE": [
      { name: "schedule_create", arguments: plan },
      { name: "schedule_create", arguments: plan },
      { name: "schedule_create", arguments: { ...plan, instruction: "不同说明" } },
      { name: "schedule_create", arguments: { ...plan, create_key: "old", action: "news" } },
      { name: "schedule_create", arguments: { ...plan, create_key: "mode", access_mode: "full_access" } },
    ],
    "NO-TARGET": [{ name: "schedule_create", arguments: { create_key: "no-target", rule, instruction: "不要求消息推送", reason: "仅留记录" } }],
  }));
  let rt = await Runtime.start(h.config);
  try {
    const main = rt.store.getAgentRole("main")!;
    const task = await rt.submit({ sessionId: main.sessionId, requestId: "create", input: "CREATE", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("通用计划创建完成", () => rt.store.getTask(task.id)!.status === "completed");
    const [schedule] = rt.sched.listSchedules({}).items;
    assert.equal(rt.sched.countActive(), 1);
    assert.equal(schedule.accessMode, "full_access");
    assert.equal(schedule.projectId, main.projectId);
    assert.equal(schedule.createTaskId, task.id);
    assert.equal(schedule.createPermissionVersion, task.permissionVersion);
    assert.deepEqual(schedule.target, TARGET);
    assert.match(schedule.instruction, /MATERIAL-MARK/);
    const calls = rt.store.listToolOpsByTask(task.id);
    assert.match(calls[1].resultSummary ?? "", /重复登记返回原计划/);
    assert.equal(calls.slice(2).every((call) => call.isError), true);
    assert.equal(rt.store.listConfirmationsByTask(task.id).length, 0);
    const session = rt.store.getSession(main.sessionId)!;
    await rt.setSessionDefaultMode({ sessionId: main.sessionId, mode: "confirm", expectedVersion: session.defaultAccessModeVersion });
    h.channel.cfg = null;
    const noTarget = await rt.submit({ sessionId: main.sessionId, requestId: "no-target", input: "NO-TARGET", accessMode: "confirm", modelSelection: rt.defaultSelection });
    await waitFor("无目标计划创建完成", () => rt.store.getTask(noTarget.id)!.status === "completed");
    assert.equal(rt.sched.findScheduleByCreateKey("main:no-target")!.target, null);
    await rt.stop("test_restart");
    rt = await Runtime.start(h.config);
    assert.equal(rt.sched.getSchedule(schedule.id)!.accessMode, "full_access", "会话改模式与重启不重算已登记计划");
    assert.deepEqual(rt.sched.getSchedule(schedule.id)!.target, TARGET, "原目标不改发");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("通用计划：无IM目标仍独立运行并保留结果，终态与回报失败同事务回滚", async () => {
  const h = await harness("schedule-no-target", "2026-09-24T00:00:00Z");
  const rt = await Runtime.start(h.config);
  try {
    const schedule = addPlan(rt, h, { key: "record", target: null, rule: { kind: "once", at: "2026-09-24T01:00:00Z", time_zone: "UTC" }, text: "只保存结果" });
    await tickAt(rt, h, "2026-09-24T01:00:00Z");
    await waitFor("无目标运行任务完成", () => {
      const run = rt.sched.listRuns(schedule.id, 10)[0];
      return run?.rootTaskId !== null && rt.store.getTask(run.rootTaskId!)?.status === "completed";
    });
    await tickAt(rt, h, "2026-09-24T01:00:01Z");
    const [run] = rt.sched.listRuns(schedule.id, 10);
    assert.equal(run.resultStatus, "completed");
    assert.ok(run.resultText);
    assert.equal(run.notificationOpId, null);
    assert.equal(rt.sched.getSchedule(schedule.id)!.status, "completed");
    assert.equal(h.channel.sends.length, 0);

    const reportPlan = addPlan(rt, h, { key: "rollback", rule: { kind: "once", at: "2026-09-24T02:00:00Z", time_zone: "UTC" }, text: "最终结果" });
    await tickAt(rt, h, "2026-09-24T02:00:00Z");
    await waitFor("回报运行任务完成", () => {
      const current = rt.sched.listRuns(reportPlan.id, 10)[0];
      return current?.rootTaskId !== null && rt.store.getTask(current.rootTaskId!)?.resultSummary !== null;
    });
    const [before] = rt.sched.listRuns(reportPlan.id, 10);
    rt.store.db.exec("CREATE TRIGGER fail_run_report BEFORE INSERT ON notification_ops BEGIN SELECT RAISE(ABORT, 'report failed'); END");
    assert.throws(() => rt.scheduler!.closeFinished(), /report failed/);
    assert.equal(rt.sched.getRun(before.id)!.closedAt, null);
    assert.equal(rt.sched.getRun(before.id)!.resultStatus, null);
    assert.equal(rt.sched.findOpBySource("schedule_run", before.id), null);
    rt.store.db.exec("DROP TRIGGER fail_run_report");
    await tickAt(rt, h, "2026-09-24T02:00:01Z");
    assert.equal(rt.sched.getRun(before.id)!.resultStatus, "completed");
    assert.equal(h.channel.sends.length, 1);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("独立定时执行：应用数据免审批并审计真实scheduled身份", async () => {
  const h = await harness("scheduled-app-data-audit", "2026-09-24T00:00:00Z", toolScript({
    "SCHEDULED-APPDATA": [
      { name: "app_data_define_table", arguments: { table: "items", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "任务建表" } },
      { name: "app_data_insert", arguments: { table: "items", records: [{ title: "一" }, { title: "二" }], reason: "任务写入" } },
      { name: "app_data_delete", arguments: { table: "items", rows: [{ id: 1, expected_version: 1 }, { id: 2, expected_version: 1 }], reason: "任务清理" } },
    ],
  }));
  const rt = await Runtime.start(h.config);
  try {
    const schedule = addPlan(rt, h, { key: "data", target: null, accessMode: "full_access", rule: { kind: "once", at: "2026-09-24T01:00:00Z", time_zone: "UTC" }, text: "SCHEDULED-APPDATA" });
    await tickAt(rt, h, "2026-09-24T01:00:00Z");
    await waitFor("定时业务工具完成", () => {
      const run = rt.sched.listRuns(schedule.id, 1)[0];
      return Boolean(run?.rootTaskId && rt.store.getTask(run.rootTaskId)?.status === "completed");
    });
    const [run] = rt.sched.listRuns(schedule.id, 1);
    assert.equal(rt.store.listConfirmationsByTask(run.rootTaskId!).length, 0);
    const calls = rt.store.listToolOpsByTask(run.rootTaskId!);
    assert.equal(calls.length, 3);
    assert.equal(calls.every((call) => call.isError === false), true);
    assert.equal(calls[2].authorization?.source, "full_access");
    const app = new DatabaseSync(path.join(h.dirs.dataDir, "agent-data", "main.db"), { readOnly: true });
    try {
      const receipts = app.prepare("SELECT task_id, session_id, agent_id FROM app_audit ORDER BY seq").all();
      assert.equal(receipts.length, 3);
      assert.equal(receipts.every((receipt) => receipt.task_id === run.rootTaskId && receipt.session_id === run.sessionId && receipt.agent_id === "scheduled"), true);
    } finally {
      app.close();
    }
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("工具：受限一次通知须拥有者确认；批准前零发送；同槽幂等；非 main 无工具", async () => {
  const h = await harness("sched-tools", "2026-09-24T00:00:00Z", toolScript({
    "ONCE-NOTIFY": [
      { name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "构建完成" }], reason: "告知" } },
      { name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "构建完成" }], reason: "告知" } },
      { name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "换个说法" }], reason: "告知" } },
      { name: "notification_query", arguments: {} },
    ],
    "REJECT-NOTIFY": [{ name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "不该发" }], reason: "x" } }],
  }));
  const rt = await Runtime.start(h.config);
  await ControlServer.start(rt);
  const client = await connectAuthedClient(rt);
  await client.handshake();
  try {
    const main = rt.store.getAgentRole("main")!;
    const once = await rt.submit({ sessionId: main.sessionId, requestId: "o1", input: "ONCE-NOTIFY", modelSelection: rt.defaultSelection });
    const c2 = await pendingConfirmation(client, once.id);
    assert.equal(c2.scope.mode, "once");
    await client.request("respond_confirmation", { confirmation_id: c2.id, decision: "approve" });
    await waitFor("一次通知任务完成", () => rt.store.getTask(once.id)!.status === "completed");
    await rt.scheduler!.idle();
    const onceOps = rt.store.listToolOpsByTask(once.id);
    assert.match(onceOps[0]!.resultSummary!, /已排队/);
    assert.match(onceOps[1]!.resultSummary!, /重复调用返回原操作/);
    assert.match(onceOps[2]!.resultSummary!, /不能换键重发/);
    assert.equal(h.channel.sends.filter((x) => x.text === "构建完成").length, 1);

    const rej = await rt.submit({ sessionId: main.sessionId, requestId: "r1", input: "REJECT-NOTIFY", modelSelection: rt.defaultSelection });
    const c3 = await pendingConfirmation(client, rej.id);
    await client.request("respond_confirmation", { confirmation_id: c3.id, decision: "reject" });
    await waitFor("拒绝任务完成", () => rt.store.getTask(rej.id)!.status === "completed");
    assert.equal(opsOf(rt).some((o) => o.text === "不该发"), false);

    const sentOp = opsOf(rt).find((o) => o.text === "构建完成")!;
    assert.equal((await client.request<any>("notification_get", { op_id: sentOp.id })).operation.status, "sent");

    // 非 main 会话看不到 scheduler 工具（按实际请求载荷）
    const project = rt.createProject("plain");
    const dev = await rt.createSession({ projectId: project.id, cwd: h.dirs.root + "/work-0" });
    const devTask = await rt.submit({ sessionId: dev.id, requestId: "d1", input: "DEV-PLAIN", modelSelection: rt.defaultSelection });
    await waitFor("dev 完成", () => rt.store.getTask(devTask.id)!.status === "completed");
    const devReq = h.reqs.find((r: any) => lastUserText(r).includes("DEV-PLAIN"))!;
    const names = (devReq.tools ?? []).map((t: any) => t.function?.name ?? t.name);
    assert.equal(names.some((n: string) => n.startsWith("schedule_") || n.startsWith("notification_")), false);
    const mainReq = h.reqs.find((r: any) => lastUserText(r).includes("ONCE-NOTIFY"))!;
    assert.ok((mainReq.tools ?? []).some((t: any) => (t.function?.name ?? t.name) === "schedule_create"));
  } finally {
    client.close();
    await rt.stop("test_end");
    await h.close();
  }
});

test("完全访问一次通知：零审批、单次认领与正文固定，完成后跨重启发送", async () => {
  const h = await harness("notify-full-access", "2026-09-24T00:00:00Z", toolScript({
    "ONCE": [
      { name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "已完成" }], reason: "汇报" } },
      { name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "已完成" }], reason: "汇报" } },
      { name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "更换正文" }], reason: "汇报" } },
    ],
  }));
  h.channel.online = false;
  let rt = await Runtime.start(h.config);
  try {
    const main = rt.store.getAgentRole("main")!;
    const task = await rt.submit({ sessionId: main.sessionId, requestId: "full", input: "ONCE", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("通知登记任务完成", () => rt.store.getTask(task.id)!.status === "completed");
    await rt.scheduler!.idle();
    assert.equal(rt.store.listConfirmationsByTask(task.id).length, 0);
    const calls = rt.store.listToolOpsByTask(task.id);
    assert.equal(calls[0].authorization?.source, "full_access");
    assert.match(calls[1].resultSummary ?? "", /重复调用返回原操作/);
    assert.match(calls[2].resultSummary ?? "", /不能换键重发/);
    const [op] = opsOf(rt);
    assert.equal(op.sourceKind, "tool");
    assert.equal(op.hostOpId, calls[0].id);
    assert.equal(op.status, "pending");
    assert.equal(h.channel.sends.length, 0);
    await rt.stop("test_restart");
    h.channel.online = true;
    rt = await Runtime.start(h.config);
    await rt.scheduler!.idle();
    assert.equal(rt.sched.getOp(op.id)!.status, "sent");
    assert.deepEqual(h.channel.sends.map((item) => item.text), ["已完成"]);
    await tickAt(rt, h, "2026-09-24T00:00:01Z");
    assert.equal(h.channel.sends.length, 1);
    assert.equal(rt.store.getToolOp(op.hostOpId!)!.authorization?.source, "full_access");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("完全访问一次通知：权限变更、取消、目标或正文失配拒绝发送；登记失败回滚授权", async () => {
  const actions = ["permission", "cancel", "target", "text", "commit-failure"];
  const h = await harness("notify-full-access-recheck", "2026-09-24T00:00:00Z", toolScript(Object.fromEntries(actions.map((action) => [action, [
    { name: "notification_enqueue", arguments: { content: [{ kind: "text", text: action }], reason: "验证" } },
  ]]))));
  h.channel.online = false;
  const rt = await Runtime.start(h.config);
  try {
    const main = rt.store.getAgentRole("main")!;
    for (const action of actions) {
      if (action === "commit-failure") rt.store.db.exec("CREATE TRIGGER fail_notification_insert BEFORE INSERT ON notification_ops BEGIN SELECT RAISE(ABORT, 'notification insert failed'); END");
      const task = await rt.submit({ sessionId: main.sessionId, requestId: action, input: action, accessMode: "full_access", modelSelection: rt.defaultSelection });
      await waitFor("通知登记结束", () => rt.store.getTask(task.id)!.status === "completed");
      await rt.scheduler!.idle();
      assert.equal(rt.store.listConfirmationsByTask(task.id).length, 0);
      const hostOp = rt.store.listToolOpsByTask(task.id)[0];
      if (action === "commit-failure") {
        assert.equal(hostOp.authorization, null, "授权与 outbox 同事务回滚");
        assert.equal(rt.sched.findOpBySource("tool", `task:${task.id}`), null);
        rt.store.db.exec("DROP TRIGGER fail_notification_insert");
        continue;
      }
      const op = rt.sched.findOpBySource("tool", `task:${task.id}`)!;
      rt.store.withTx(() => {
        if (action === "permission") rt.store.applyModeSwitch(task.id, "confirm");
        else if (action === "cancel") rt.store.db.prepare("UPDATE tasks SET cancel_requested = 1 WHERE id = ?").run(task.id);
        else if (action === "target") rt.store.db.prepare("UPDATE notification_ops SET target = ? WHERE id = ?").run(JSON.stringify({ ...TARGET, chatId: "other" }), op.id);
        else rt.store.db.prepare("UPDATE notification_ops SET text_sha256 = ? WHERE id = ?").run("different", op.id);
      });
      h.channel.online = true;
      rt.scheduler!.kickSender();
      await rt.scheduler!.idle();
      assert.equal(rt.sched.getOp(op.id)!.status, "canceled");
      h.channel.online = false;
    }
    assert.equal(h.channel.sends.length, 0);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("完全访问一次通知：发送结果未知保持原键，不重发", async () => {
  const h = await harness("notify-full-access-unknown", "2026-09-24T00:00:00Z", toolScript({
    "UNKNOWN": [{ name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "未知" }], reason: "汇报" } }],
  }));
  h.channel.behavior = async () => { throw new Error("模拟发送后断线"); };
  const rt = await Runtime.start(h.config);
  try {
    const task = await rt.submit({ sessionId: rt.store.getAgentRole("main")!.sessionId, requestId: "u", input: "UNKNOWN", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("发送任务完成", () => rt.store.getTask(task.id)!.status === "completed");
    await rt.scheduler!.idle();
    const op = rt.sched.findOpBySource("tool", `task:${task.id}`)!;
    assert.equal(op.status, "effect_unknown");
    await tickAt(rt, h, "2026-09-24T00:00:01Z");
    assert.equal(h.channel.sends.length, 1);
    assert.equal(rt.store.listConfirmationsByTask(task.id).length, 0);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("取消通用计划：来源任务已完成的pending一次通知与最终回报均不再发送", async () => {
  const h = await harness("schedule-cancel-pending", "2026-09-24T00:00:00Z", toolScript({
    "ROOT-NOTICE": [{ name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "普通通知" }], reason: "汇报" } }],
  }));
  h.channel.online = false;
  const rt = await Runtime.start(h.config);
  try {
    const schedule = addPlan(rt, h, { key: "cancel-notice", accessMode: "full_access", rule: { kind: "daily", time: "01:00", time_zone: "UTC" }, text: "ROOT-NOTICE" });
    await tickAt(rt, h, "2026-09-24T01:00:00Z");
    await waitFor("运行整项收尾", () => {
      rt.scheduler!.closeFinished();
      return Boolean(rt.sched.listRuns(schedule.id, 10)[0]?.closedAt);
    });
    const [run] = rt.sched.listRuns(schedule.id, 10);
    const notice = rt.sched.findOpBySource("tool", `task:${run.rootTaskId}`)!;
    assert.equal(rt.store.getTask(run.rootTaskId!)!.status, "completed");
    assert.equal(notice.status, "pending");
    await rt.scheduleCancel({ scheduleId: schedule.id, expectedVersion: 1, reason: "停止计划与待发消息" });
    h.channel.online = true;
    await tickAt(rt, h, "2026-09-24T01:00:01Z");
    assert.equal(rt.sched.getOp(notice.id)!.status, "canceled");
    assert.equal(rt.sched.getOp(run.notificationOpId!)!.status, "canceled");
    assert.equal(h.channel.sends.length, 0);
    assert.equal(rt.sched.getRun(run.id)!.resultStatus, "completed", "取消保留已完成的执行事实");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("工具：同一批并行的宿主工具先结束，不影响获批通知的复核与登记（架构工单 04）", async () => {
  // main 的宿主工具并行执行：notification_query 在审批等待期间结束并解绑宿主上下文；
  // 获批后的身份复核必须用调用开始时捕获的上下文
  let step = 0;
  const h = await harness("sched-parallel", "2026-09-24T00:00:00Z", async (req) => {
    if (!lastUserText(req).includes("PARALLEL-NOTIFY") || step++ > 0) return { kind: "text", text: "done" };
    return {
      kind: "tool_calls",
      calls: [
        { id: "p-0", name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "并行批次" }], reason: "告知" } },
        { id: "p-1", name: "notification_query", arguments: {} },
      ],
    };
  });
  const rt = await Runtime.start(h.config);
  await ControlServer.start(rt);
  const client = await connectAuthedClient(rt);
  await client.handshake();
  try {
    const main = rt.store.getAgentRole("main")!;
    const task = await rt.submit({ sessionId: main.sessionId, requestId: "par1", input: "PARALLEL-NOTIFY", modelSelection: rt.defaultSelection });
    const conf = await pendingConfirmation(client, task.id);
    await waitFor("并行的查询先结束", () => rt.store.listToolOpsByTask(task.id).some((op) => op.toolName === "notification_query" && op.resultSummary !== null));
    await client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("任务完成", () => rt.store.getTask(task.id)!.status === "completed");
    const enqueue = rt.store.listToolOpsByTask(task.id).find((op) => op.toolName === "notification_enqueue")!;
    assert.match(enqueue.resultSummary!, /已排队/);
    assert.notEqual(rt.store.getConfirmation(conf.id)!.consumedAt, null, "批准已消费");
    assert.equal(opsOf(rt).filter((o) => o.text === "并行批次").length, 1);
  } finally {
    client.close();
    await rt.stop("test_end");
    await h.close();
  }
});

test("工具：未配置可信目标拒绝外发；应用数据快照登记后行修改不改变正文", async () => {
  const h = await harness("sched-snapshot", "2026-09-24T00:00:00Z", toolScript({
    "SNAP-NOTIFY": [{ name: "notification_enqueue", arguments: { content: [{ kind: "app_data", table: "notes", row_id: 1, field: "body" }], reason: "快照" } }],
    "NO-TARGET": [{ name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "x" }], reason: "x" } }],
  }));
  h.channel.online = false;
  const rt = await Runtime.start(h.config);
  await ControlServer.start(rt);
  const client = await connectAuthedClient(rt);
  await client.handshake();
  try {
    const app = (rt as any).appDataStore;
    const ctx = { taskId: "t", sessionId: "s", agentId: "main" };
    app.defineTable({ table: "notes", fields: [{ name: "body", type: "text" }], expected_schema_version: 0, reason: "r", opId: "a1", ctx });
    app.insert({ table: "notes", records: [{ body: "原始正文" }], reason: "r", opId: "a2", ctx });
    const main = rt.store.getAgentRole("main")!;
    const t = await rt.submit({ sessionId: main.sessionId, requestId: "s1", input: "SNAP-NOTIFY", modelSelection: rt.defaultSelection });
    const conf = await pendingConfirmation(client, t.id);
    assert.match(conf.scope.sourceRefs[0], /^app_data:.*notes#1\.body$/);
    await client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("快照任务完成", () => rt.store.getTask(t.id)!.status === "completed");
    app.updateRows({ table: "notes", rows: [{ id: 1, expected_version: 1, set: { body: "改过了" } }], reason: "r", opId: "a3", ctx });
    h.channel.online = true;
    await tickAt(rt, h, "2026-09-24T02:00:00Z");
    assert.deepEqual(h.channel.sends.map((x) => x.text), ["原始正文"], "已批准正文不随业务数据变化");

    h.channel.cfg = null;
    const t2 = await rt.submit({ sessionId: main.sessionId, requestId: "s2", input: "NO-TARGET", modelSelection: rt.defaultSelection });
    await waitFor("无目标任务完成", () => rt.store.getTask(t2.id)!.status === "completed");
    assert.match(rt.store.listToolOpsByTask(t2.id)[0]!.resultSummary!, /未配置可信 owner 通知目标/);
    assert.equal(rt.store.listConfirmationsByTask(t2.id).length, 0, "无目标不产生审批");
  } finally {
    client.close();
    await rt.stop("test_end");
    await h.close();
  }
});

test("发送函数挂起时控制面与普通任务继续推进；stop 中止在途发送并在关库前收尾", async () => {
  const h = await harness("sched-hang", "2026-09-24T00:00:00Z", undefined, { sendTimeoutMs: 60_000 });
  let release!: () => void;
  h.channel.behavior = () => new Promise((r) => { release = () => r({ platformMessageId: "late" }); });
  const rt = await Runtime.start(h.config);
  let opId = "";
  try {
    await rt.scheduler!.idle();
    enqueue(rt, "h1", "HANG");
    rt.scheduler!.kickSender();
    h.clock.t = ms("2026-09-24T01:00:00Z");
    await rt.scheduler!.tick();
    await waitFor("发送进行中", () => opsOf(rt)[0]?.status === "sending");
    opId = opsOf(rt)[0]!.id;
    const project = rt.createProject("side");
    const dev = await rt.createSession({ projectId: project.id, cwd: h.dirs.root + "/work-0" });
    const task = await rt.submit({ sessionId: dev.id, requestId: "d1", input: "SIDE-TASK", modelSelection: rt.defaultSelection });
    await waitFor("独立任务完成", () => rt.store.getTask(task.id)!.status === "completed", 10_000);
    assert.equal(rt.notificationList({}).operations[0]!.status, "sending", "查询不被发送阻塞");
  } finally {
    const started = Date.now();
    await rt.stop("test_end");
    assert.ok(Date.now() - started < 10_000, "停止不等满发送时限");
  }
  release();
  await new Promise((r) => setTimeout(r, 50)); // 关库后迟到回调不得写库/抛错
  const db = new Db(h.dirs.dataDir);
  const row = db.prepare("SELECT status, error_kind FROM notification_ops WHERE id = ?").get(opId) as any;
  db.close();
  assert.equal(row.status, "effect_unknown");
  await h.close();
});

test("旧调度 schema 拒绝启动，不转换或回填执行授权", async () => {
  const { dirs } = await makeTestDirs("sched-old-schema", 0);
  try {
    const db = new Db(dirs.dataDir);
    db.exec("UPDATE meta SET value = '12' WHERE key = 'schema_version'");
    db.close();
    assert.throws(() => new Db(dirs.dataDir), { code: "schema_version_unsupported" });
  } finally {
    await cleanupDirs(dirs);
  }
});

// ---------- 真实后台子进程终止：平台已接收、本地未落结果 ----------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("子进程 SIGKILL：平台已接收但本地未落结果 → 重启标 effect_unknown，不重发", async () => {
  const h = await harness("sched-kill", "2026-09-24T00:00:00Z");
  const received = path.join(h.dirs.root, "received.log");
  // 先在本进程登记一个已到期的 pending 通知（渠道离线）
  h.channel.online = false;
  let rt = await Runtime.start(h.config);
  enqueue(rt, "k", "KILL-WINDOW");
  await tickAt(rt, h, "2026-09-24T01:00:00Z");
  await rt.stop("handoff");
  const child = childProcess.spawn(
    path.join(repoRoot, "node_modules", ".bin", "tsx"),
    [path.join(repoRoot, "test", "helpers", "scheduler-child.ts"), h.dirs.dataDir, h.dirs.agentDir, received, path.join(h.dirs.root, "k.sock")],
    { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const exited = new Promise((r) => child.once("exit", r));
  try {
    await waitFor("子进程平台已接收", () => {
      if (child.exitCode !== null) throw new Error(`子进程提前退出：${stderr.slice(0, 2000)}`);
      return fs.existsSync(received);
    }, 60_000);
  } finally {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* 已退出 */ }
    await exited;
    // tsx 包装器先退出；等锁记录的内层 node 进程也被回收（僵尸期间锁仍判为被持有）
    const lockOwner = (dir: string) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")).pid as number; } catch { return null; }
    };
    for (const dir of [path.join(h.dirs.agentDir, "config.lock"), path.join(h.dirs.dataDir, "instance.lock")]) {
      const pid = lockOwner(dir);
      if (pid) await waitFor(`锁持有进程 ${pid} 退出`, () => { try { process.kill(pid, 0); return false; } catch { return true; } }, 15_000);
    }
  }
  h.channel.online = true;
  rt = await Runtime.start(h.config);
  try {
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    const [op] = opsOf(rt);
    assert.equal(op!.status, "effect_unknown");
    assert.equal(op!.errorKind, "backend_restart");
    assert.equal(h.channel.sends.length, 0, "重启不重发");
    assert.equal(fs.readFileSync(received, "utf8").trim().split("\n").length, 1, "平台只收到一次");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});


test("inbound_event 发送核实分流：宿主 IM 控制事件回执放行，来源不明的入站通知不发送（issue 08）", async () => {
  const h = await harness("sched-im-receipt", "2026-09-24T00:00:00Z");
  const rt = await Runtime.start(h.config);
  try {
    // 宿主控制的 IM 审批事件（处理终态，钉版目标与 actor）→ 回执按 outbox 正常发送
    const { op: receipt, event } = rt.store.withTx(() => {
      const { event } = rt.store.registerInboundEvent({
        source: "telegram", externalId: "123456:42:99", actor: "telegram:42", targetRole: "main",
        body: "/approve abc 1", replyTarget: { ...TARGET }, eventKind: "im_approval", terminal: "done",
      });
      const { op } = rt.sched.insertOp({ sourceKind: "inbound_event", sourceKey: event.id, taskId: null, hostOpId: null, target: { ...TARGET }, text: "已接受批准", sourceRefs: [] });
      return { op, event };
    });
    // 无对应控制事件的 inbound_event 键 → 来源不可核实，不发送
    const { op: bogus } = rt.store.withTx(() =>
      rt.sched.insertOp({ sourceKind: "inbound_event", sourceKey: "evt-nonexistent", taskId: null, hostOpId: null, target: { ...TARGET }, text: "伪造回执", sourceRefs: [] }),
    );
    // 普通任务类别的入站事件也不能被认领为控制回执
    const { op: taskKind } = rt.store.withTx(() => {
      const { event: plain } = rt.store.registerInboundEvent({
        source: "telegram", externalId: "123456:42:100", actor: "telegram:42", targetRole: "main", body: "普通", replyTarget: { ...TARGET },
      });
      const { op } = rt.sched.insertOp({ sourceKind: "inbound_event", sourceKey: plain.id, taskId: null, hostOpId: null, target: { ...TARGET }, text: "伪造回执2", sourceRefs: [] });
      return { op };
    });
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    assert.equal(rt.sched.getOp(receipt.id)!.status, "sent");
    assert.deepEqual(h.channel.sends.map((s) => s.text), ["已接受批准"]);
    assert.equal(rt.sched.getOp(bogus.id)!.status, "canceled");
    assert.match(rt.sched.getOp(bogus.id)!.errorMessage ?? "", /source_revoked|不可核实/);
    assert.equal(rt.sched.getOp(taskKind.id)!.status, "canceled");
    assert.equal(event.eventKind, "im_approval");

    // IM 审批初始通知：未发出时审批已决定的不再发出；仍待决的正常发送（issue 08）
    const project = rt.store.createProject("p-notice");
    const session = rt.store.createSession({ projectId: project.id, cwd: h.dirs.root, cwdReal: fs.realpathSync(h.dirs.root), cwdDev: 1, cwdIno: 1, piSessionId: "pi-n", confirmTools: [] });
    const { task } = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "n1", input: "受控操作", modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, submissionDigest: "n1" });
    const noticeFor = (suffix: string, decided: boolean) =>
      rt.store.withTx(() => {
        const c = rt.store.createConfirmation({ taskId: task.id, sessionId: session.id, toolOpId: `op-${suffix}`, toolName: "app_data_delete", params: {}, scope: { kind: "tool", workspaceOnly: true }, permissionVersion: 1 });
        if (decided) rt.store.respondConfirmation(c.id, "approved", { source: "owner" });
        const { op } = rt.sched.insertOp({ sourceKind: "confirmation", sourceKey: `im-approval:${c.id}`, taskId: task.id, hostOpId: null, target: { ...TARGET }, text: `通知-${suffix}`, sourceRefs: [] });
        return op;
      });
    const staleNotice = noticeFor("stale", true);
    const liveNotice = noticeFor("live", false);
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    assert.equal(rt.sched.getOp(staleNotice.id)!.status, "canceled", "已决定的未发出通知取消");
    assert.match(rt.sched.getOp(staleNotice.id)!.errorMessage ?? "", /审批已决定或失效/);
    assert.equal(rt.sched.getOp(liveNotice.id)!.status, "sent", "仍待决的通知正常发送");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});
