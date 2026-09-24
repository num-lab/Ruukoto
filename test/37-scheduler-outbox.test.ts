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
import { firstDue, latestAtOrBefore, nextAfter, parseRule, RuleError } from "../src/scheduler/time.ts";

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
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { createMockTools } from "../src/agent/mock-tools.ts";
import { Db } from "../src/core/db.ts";
import { NotSentError, type NotifyChannel } from "../src/scheduler/runtime.ts";
import type { NotifyTarget } from "../src/core/types.ts";
import { cleanupDirs, lastUserText, makeTestDirs, pendingConfirmation, waitFor, writeModelsJson, connectAuthedClient } from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { ControlServer } from "../src/control/server.ts";

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
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
    scheduler: { channel: opts.noChannel ? undefined : channel, now: () => clock.t, tickMs: 0, sendTimeoutMs: opts.sendTimeoutMs ?? 2_000 },
  };
  return {
    dirs, server, clock, channel, config, requests, reqs,
    async close() {
      await server.close();
      await cleanupDirs(dirs);
    },
  };
}

/** 宿主直接登记计划（绕过工具与审批，只验证调度/发送语义）。 */
function addSchedule(rt: Runtime, h: Harness, input: { key: string; action: "wake_main" | "notify"; rule: Record<string, unknown>; text: string }) {
  const rule = parseRule(input.rule);
  return rt.store.withTx(() =>
    rt.sched.insertSchedule({
      createKey: input.key, paramsDigest: "test", createTaskId: null, createOpId: null, action: input.action, rule,
      payload: { text: input.text, sourceRefs: [] }, target: input.action === "notify" ? { ...TARGET } : null,
      approvalId: null, nextDueAt: firstDue(rule, h.clock.t), tzData: "test", reason: "test",
    }, "test"),
  );
}

async function tickAt(rt: Runtime, h: Harness, iso: string): Promise<void> {
  h.clock.t = ms(iso);
  await rt.scheduler.tick();
  await rt.scheduler.idle();
}

const opsOf = (rt: Runtime) => rt.sched.listOps({ limit: 50 }).items;
const schedulerEvents = (rt: Runtime) =>
  rt.store.db.prepare("SELECT * FROM inbound_events WHERE source = 'scheduler'").all() as any[];

test("wake_main：到期唤醒 main 一次（confirm 模式）；重复/并发 tick 不重复建任务；普通状态事件不调用模型", async () => {
  const h = await harness("sched-wake", "2026-09-24T00:00:00Z");
  const rt = await Runtime.start(h.config);
  try {
    const s = addSchedule(rt, h, { key: "k1", action: "wake_main", rule: { kind: "daily", time: "09:00", time_zone: "Asia/Shanghai" }, text: "WAKE-MARK 看看待办" });
    assert.equal(s.nextDueAt, "2026-09-24T01:00:00.000Z");
    await tickAt(rt, h, "2026-09-24T00:59:59Z");
    assert.equal(schedulerEvents(rt).length, 0, "未到期不登记");
    h.clock.t = ms("2026-09-24T01:00:05Z");
    await Promise.all([rt.scheduler.tick(), rt.scheduler.tick(), rt.scheduler.tick()]);
    await rt.scheduler.tick();
    const events = schedulerEvents(rt);
    assert.equal(events.length, 1, "同一周期只登记一次");
    const main = rt.store.getAgentRole("main")!;
    await waitFor("唤醒任务完成", () => rt.store.listTasksBySession(main.sessionId).some((t) => t.status === "completed"));
    const tasks = rt.store.listTasksBySession(main.sessionId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.accessMode, "confirm", "定时任务采用宿主固定的 confirm 模式");
    assert.ok(tasks[0]!.input.includes("WAKE-MARK") && tasks[0]!.input.includes("原定时间"));
    await tickAt(rt, h, "2026-09-24T02:00:00Z");
    const s2 = rt.sched.getSchedule(s.id)!;
    assert.equal(s2.nextDueAt, "2026-09-25T01:00:00.000Z");
    assert.equal(s2.currentRunId, null, "任务完成后运行关闭");
    assert.equal(h.requests.filter((r) => r.includes("WAKE-MARK")).length, 1, "只有一次模型请求");
    // 调度/发送状态只落事件表，不产生额外模型调用
    const before = h.requests.length;
    rt.store.withTx(() => rt.store.appendEvent({ type: "schedule.changed", scheduleId: s.id, action: "created", version: 1, source: "test" }));
    await tickAt(rt, h, "2026-09-24T03:00:00Z");
    assert.equal(h.requests.length, before);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("notify：到期发送一次；同来源键同参返回原操作、异参冲突；下一周期是独立新操作", async () => {
  const h = await harness("sched-notify", "2026-09-24T00:00:00Z");
  const rt = await Runtime.start(h.config);
  try {
    const s = addSchedule(rt, h, { key: "n1", action: "notify", rule: { kind: "daily", time: "08:00", time_zone: "UTC" }, text: "喝水提醒" });
    await tickAt(rt, h, "2026-09-24T08:00:01Z");
    await tickAt(rt, h, "2026-09-24T08:00:02Z");
    assert.equal(h.channel.sends.length, 1, "只发送一次");
    const [op] = opsOf(rt);
    assert.equal(op!.status, "sent");
    assert.equal(op!.platformMessageId, "msg-1");
    // 同来源键：同参返回原操作；异参冲突
    const again = rt.store.withTx(() => rt.sched.insertOp({ sourceKind: "schedule_run", sourceKey: op!.sourceKey, taskId: null, hostOpId: null, target: TARGET, text: "喝水提醒", sourceRefs: [] }));
    assert.equal(again.created, false);
    assert.equal(again.op.id, op!.id);
    assert.throws(() => rt.store.withTx(() => rt.sched.insertOp({ sourceKind: "schedule_run", sourceKey: op!.sourceKey, taskId: null, hostOpId: null, target: TARGET, text: "别的", sourceRefs: [] })), /已绑定不同/);
    await tickAt(rt, h, "2026-09-25T08:00:00Z");
    assert.equal(h.channel.sends.length, 2);
    assert.equal(rt.sched.listRuns(s.id, 10).length, 2);
    // 核心库完整性
    assert.equal((rt.store.db.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
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
    const once = (key: string, text: string) => addSchedule(rt, h, { key, action: "notify", rule: { kind: "once", at: "2026-09-24T01:00:00Z", time_zone: "UTC" }, text });
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
    // 一次性计划随运行关闭而完成
    assert.ok(rt.scheduleList({ status: "completed" }).schedules.length === 4);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("目标：离线保持 pending 并显示原因；配置版本变化/停用取消；未加载发送器保持 pending", async () => {
  const h = await harness("sched-target", "2026-09-24T00:00:00Z");
  const rt = await Runtime.start(h.config);
  try {
    addSchedule(rt, h, { key: "t1", action: "notify", rule: { kind: "daily", time: "01:00", time_zone: "UTC" }, text: "T1" });
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
    addSchedule(rt2, h2, { key: "t2", action: "notify", rule: { kind: "once", at: "2026-09-24T01:00:00Z", time_zone: "UTC" }, text: "T2" });
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
  let rt = await Runtime.start(h.config);
  let mainSession = "";
  let sentId = "";
  let hostOpId = "";
  try {
    mainSession = rt.store.getAgentRole("main")!.sessionId;
    addSchedule(rt, h, { key: "r-sent", action: "notify", rule: { kind: "once", at: "2026-09-24T01:00:00Z", time_zone: "UTC" }, text: "SENT" });
    await tickAt(rt, h, "2026-09-24T01:00:00Z");
    sentId = opsOf(rt)[0]!.id;
    h.channel.online = false;
    addSchedule(rt, h, { key: "r-pending", action: "notify", rule: { kind: "once", at: "2026-09-24T02:00:00Z", time_zone: "UTC" }, text: "PENDING" });
    addSchedule(rt, h, { key: "r-sending", action: "notify", rule: { kind: "once", at: "2026-09-24T02:00:00Z", time_zone: "UTC" }, text: "SENDING" });
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
        createKey: "main:tool", paramsDigest: "d", createTaskId: task.id, createOpId: hostOpId, action: "wake_main",
        rule: parseRule({ kind: "daily", time: "23:00", time_zone: "UTC" }), payload: { text: "x", sourceRefs: [] }, target: null,
        approvalId: null, nextDueAt: "2026-09-24T23:00:00.000Z", tzData: "t", reason: "r",
      }, "test");
    });
  } finally {
    await rt.stop("restart");
  }
  h.channel.online = true;
  rt = await Runtime.start(h.config);
  try {
    await rt.scheduler.idle();
    await rt.scheduler.tick();
    await rt.scheduler.idle();
    const byText = (t: string) => opsOf(rt).find((o) => o.text === t)!;
    assert.equal(byText("SENDING").status, "effect_unknown", "遗留 sending 不重发");
    assert.equal(byText("PENDING").status, "sent");
    assert.equal(rt.sched.getOp(sentId)!.status, "sent");
    assert.deepEqual(h.channel.sends.map((s) => s.text).sort(), ["PENDING", "SENT"], "每个操作至多一次可见发送");
    assert.match(rt.store.getToolOp(hostOpId)!.resultSummary ?? "", /已提交/);
    assert.match(rt.store.getToolOp("op_not_committed")!.resultSummary ?? "", /已知未提交/);
    assert.equal(rt.store.getToolOp(hostOpId)!.effectUnknown, false);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("恢复合并：周一 pending 到周四仍只一个操作、下次周五；已 sent 未关闭则补关闭后另补一次", async () => {
  // 2026-09-21 是周一
  const h = await harness("sched-merge", "2026-09-21T00:00:00Z");
  let rt = await Runtime.start(h.config);
  let pendingSchedule = "";
  let sentSchedule = "";
  try {
    pendingSchedule = addSchedule(rt, h, { key: "m1", action: "notify", rule: { kind: "daily", time: "09:00", time_zone: "UTC" }, text: "M-PENDING" }).id;
    sentSchedule = addSchedule(rt, h, { key: "m2", action: "notify", rule: { kind: "daily", time: "09:00", time_zone: "UTC" }, text: "M-SENT" }).id;
    h.channel.online = false;
    await tickAt(rt, h, "2026-09-21T09:00:00Z");
    // m2：模拟"已发送但关闭标记未回填"——直接改为 sent，运行仍未关闭
    const m2op = opsOf(rt).find((o) => o.text === "M-SENT")!;
    rt.store.db.prepare("UPDATE notification_ops SET status = 'sent' WHERE id = ?").run(m2op.id);
  } finally {
    await rt.stop("down");
  }
  h.clock.t = ms("2026-09-24T12:00:00Z"); // 周四
  h.channel.online = true;
  rt = await Runtime.start(h.config);
  try {
    await rt.scheduler.idle();
    const p = rt.sched.getSchedule(pendingSchedule)!;
    const pRuns = rt.sched.listRuns(pendingSchedule, 10);
    assert.equal(pRuns.length, 1, "pending 运行吸收漏过周期，不建第二个");
    assert.equal(pRuns[0]!.scheduledFor, "2026-09-21T09:00:00.000Z", "保留原运行与原键");
    assert.equal(pRuns[0]!.coalescedTo, "2026-09-24T09:00:00.000Z");
    assert.equal(p.nextDueAt, "2026-09-25T09:00:00.000Z", "下一次是周五");
    const sRuns = rt.sched.listRuns(sentSchedule, 10);
    assert.equal(sRuns.length, 2, "已 sent 的运行补关闭后另生成一次补发");
    const catchUp = sRuns.find((r) => r.scheduledFor === "2026-09-24T09:00:00.000Z")!;
    assert.equal(catchUp.coalescedFrom, "2026-09-22T09:00:00.000Z", "补发覆盖周二至周四");
    assert.ok(catchUp.delayMs >= 3 * 3600_000, "标记延迟");
    assert.deepEqual(h.channel.sends.map((s) => s.text).sort(), ["M-PENDING", "M-SENT"]);
    assert.equal(opsOf(rt).filter((o) => o.text === "M-PENDING").length, 1);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("恢复合并：wake_main 的排队任务占用位置——重启合并不新增补发，任务继续执行一次", async () => {
  const h = await harness("sched-merge-wake", "2026-09-21T00:00:00Z");
  let rt = await Runtime.start(h.config);
  let sid = "";
  try {
    const main = rt.store.getAgentRole("main")!;
    rt.store.withTx(() => rt.store.setSessionQueueState(main.sessionId, "paused", "owner"));
    sid = addSchedule(rt, h, { key: "w1", action: "wake_main", rule: { kind: "daily", time: "09:00", time_zone: "UTC" }, text: "MERGE-WAKE" }).id;
    await tickAt(rt, h, "2026-09-21T09:00:00Z");
    assert.equal(rt.store.listTasksBySession(main.sessionId)[0]!.status, "queued");
  } finally {
    await rt.stop("down");
  }
  h.clock.t = ms("2026-09-24T12:00:00Z");
  rt = await Runtime.start(h.config);
  try {
    const runs = rt.sched.listRuns(sid, 10);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.coalescedTo, "2026-09-24T09:00:00.000Z");
    assert.equal(schedulerEvents(rt).length, 1);
    const main = rt.store.getAgentRole("main")!;
    await rt.resumeQueue(main.sessionId).catch(() => {});
    await waitFor("排队的唤醒任务完成", () => rt.store.listTasksBySession(main.sessionId).every((t) => t.status === "completed"));
    await rt.scheduler.tick();
    assert.equal(rt.store.listTasksBySession(main.sessionId).length, 1, "没有新增补发任务");
    assert.equal(rt.sched.listRuns(sid, 10)[0]!.closedAt !== null, true);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("取消：未派发运行不再派发（含重启）；pending 操作取消；取消幂等、不复活；版本不符冲突", async () => {
  const h = await harness("sched-cancel", "2026-09-24T00:00:00Z");
  let rt = await Runtime.start(h.config);
  let wakeId = "";
  try {
    wakeId = addSchedule(rt, h, { key: "c1", action: "wake_main", rule: { kind: "daily", time: "01:00", time_zone: "UTC" }, text: "CANCEL-WAKE" }).id;
    const notify = addSchedule(rt, h, { key: "c2", action: "notify", rule: { kind: "daily", time: "01:00", time_zone: "UTC" }, text: "CANCEL-NOTIFY" });
    h.channel.online = false;
    // 登记但不派发（与恢复准备同一路径）：模拟提交后、派发前
    h.clock.t = ms("2026-09-24T01:00:00Z");
    rt.scheduler.prepareRecovery();
    assert.equal(schedulerEvents(rt)[0].status, "registered");
    await assert.rejects(rt.scheduleCancel({ scheduleId: wakeId, expectedVersion: 9, reason: "x" }), /版本不符/);
    await rt.scheduleCancel({ scheduleId: wakeId, expectedVersion: 1, reason: "不要了" });
    const again = await rt.scheduleCancel({ scheduleId: wakeId, expectedVersion: 1, reason: "不要了" });
    assert.equal(again.status, "canceled", "取消幂等");
    await rt.scheduleCancel({ scheduleId: notify.id, expectedVersion: 1, reason: "不要了" });
    assert.equal(opsOf(rt)[0]!.status, "canceled");
    await rt.orchestrator!.dispatchRegisteredEvents();
    await tickAt(rt, h, "2026-09-26T01:00:00Z");
  } finally {
    await rt.stop("restart");
  }
  rt = await Runtime.start(h.config);
  try {
    await tickAt(rt, h, "2026-09-27T01:00:00Z");
    const main = rt.store.getAgentRole("main")!;
    assert.equal(rt.store.listTasksBySession(main.sessionId).length, 0, "取消后恢复与派发都不建任务");
    assert.equal(rt.sched.getSchedule(wakeId)!.status, "canceled", "取消后不复活");
    assert.equal(h.channel.sends.length, 0);
  } finally {
    await rt.stop("test_end");
    await h.close();
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

test("工具：通知计划与一次通知须拥有者确认（full_access 也不例外）；批准前零发送；同键/同槽幂等；非 main 无工具", async () => {
  const content = [{ kind: "text", text: "每天九点吃药" }];
  const h = await harness("sched-tools", "2026-09-24T00:00:00Z", toolScript({
    "PLAN-NOTIFY": [
      { name: "schedule_create", arguments: { create_key: "pill", action: "notify", rule: { kind: "daily", time: "09:00", time_zone: "Asia/Shanghai" }, content, reason: "提醒吃药" } },
      { name: "schedule_create", arguments: { create_key: "pill", action: "notify", rule: { kind: "daily", time: "09:00", time_zone: "Asia/Shanghai" }, content, reason: "提醒吃药" } },
      { name: "schedule_create", arguments: { create_key: "pill", action: "notify", rule: { kind: "daily", time: "10:00", time_zone: "Asia/Shanghai" }, content, reason: "改时间" } },
    ],
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
    const plan = await rt.submit({ sessionId: main.sessionId, requestId: "p1", input: "PLAN-NOTIFY", accessMode: "full_access", modelSelection: rt.defaultSelection });
    const conf = await pendingConfirmation(client, plan.id);
    assert.equal(conf.scope.kind, "notification");
    assert.equal(conf.scope.duration, "until_canceled");
    assert.deepEqual(conf.scope.target, TARGET);
    assert.equal(conf.params.text, "每天九点吃药", "审批固定完整正文");
    assert.equal(rt.sched.countActive(), 0, "批准前未登记");
    // 拥有者在当日 09:00（上海）之后才批准：首次到期按批准时重算，不当作漏过立即补发
    h.clock.t = ms("2026-09-24T01:30:00Z");
    await client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("计划任务完成", () => rt.store.getTask(plan.id)!.status === "completed");
    const ops = rt.store.listToolOpsByTask(plan.id);
    assert.match(ops[0]!.resultSummary!, /已登记/);
    assert.match(ops[1]!.resultSummary!, /重复登记返回原计划/);
    assert.match(ops[2]!.resultSummary!, /同键异参冲突/);
    const [s] = rt.sched.listSchedules({}).items;
    assert.equal(s!.approvalId, conf.id);
    assert.equal(h.channel.sends.length, 0, "登记本身不发送");
    assert.equal(s!.nextDueAt, "2026-09-25T01:00:00.000Z");
    await tickAt(rt, h, "2026-09-24T01:40:00Z");
    assert.equal(h.channel.sends.length, 0, "批准前的时刻不补发");
    await tickAt(rt, h, "2026-09-25T01:00:00Z");
    assert.deepEqual(h.channel.sends.map((x) => x.text), ["每天九点吃药"]);

    const once = await rt.submit({ sessionId: main.sessionId, requestId: "o1", input: "ONCE-NOTIFY", modelSelection: rt.defaultSelection });
    const c2 = await pendingConfirmation(client, once.id);
    assert.equal(c2.scope.duration, "single");
    await client.request("respond_confirmation", { confirmation_id: c2.id, decision: "approve" });
    await waitFor("一次通知任务完成", () => rt.store.getTask(once.id)!.status === "completed");
    await rt.scheduler.idle();
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

    // 拥有者控制面：分页列表（无正文）、详情、取消（带版本）
    const listed = await client.request<any>("schedule_list", { status: "active" });
    assert.equal(listed.schedules.length, 1);
    assert.equal("payload" in listed.schedules[0], false);
    const detail = await client.request<any>("schedule_get", { schedule_id: s!.id });
    assert.equal(detail.runs.length, 1);
    const sentOp = opsOf(rt).find((o) => o.text === "构建完成")!;
    assert.equal((await client.request<any>("notification_get", { op_id: sentOp.id })).operation.status, "sent");
    const canceled = await client.request<any>("schedule_cancel", { schedule_id: s!.id, expected_version: 1, reason: "owner 停用" });
    assert.equal(canceled.status, "canceled");

    // 非 main 会话看不到 scheduler 工具（按实际请求载荷）
    const project = rt.createProject("plain");
    const dev = await rt.createSession({ projectId: project.id, cwd: h.dirs.root + "/work-0" });
    const devTask = await rt.submit({ sessionId: dev.id, requestId: "d1", input: "DEV-PLAIN", modelSelection: rt.defaultSelection });
    await waitFor("dev 完成", () => rt.store.getTask(devTask.id)!.status === "completed");
    const devReq = h.reqs.find((r: any) => lastUserText(r).includes("DEV-PLAIN"))!;
    const names = (devReq.tools ?? []).map((t: any) => t.function?.name ?? t.name);
    assert.equal(names.some((n: string) => n.startsWith("schedule_") || n.startsWith("notification_")), false);
    const mainReq = h.reqs.find((r: any) => lastUserText(r).includes("PLAN-NOTIFY"))!;
    assert.ok((mainReq.tools ?? []).some((t: any) => (t.function?.name ?? t.name) === "schedule_create"));
  } finally {
    client.close();
    await rt.stop("test_end");
    await h.close();
  }
});

test("工具：未配置可信目标拒绝外发；应用数据快照登记后行修改不改变正文", async () => {
  const h = await harness("sched-snapshot", "2026-09-24T00:00:00Z", toolScript({
    "SNAP-NOTIFY": [{ name: "schedule_create", arguments: { create_key: "snap", action: "notify", rule: { kind: "once", at: "2026-09-24T02:00:00Z", time_zone: "UTC" }, content: [{ kind: "app_data", table: "notes", row_id: 1, field: "body" }], reason: "快照" } }],
    "NO-TARGET": [{ name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "x" }], reason: "x" } }],
  }));
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
    addSchedule(rt, h, { key: "h1", action: "notify", rule: { kind: "once", at: "2026-09-24T01:00:00Z", time_zone: "UTC" }, text: "HANG" });
    h.clock.t = ms("2026-09-24T01:00:00Z");
    await rt.scheduler.tick();
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

test("schema v12 → v13：升级保留既有记录并新建调度三表", async () => {
  const { dirs } = await makeTestDirs("sched-migrate", 0);
  try {
    let db = new Db(dirs.dataDir);
    db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'keep', '2026-01-01T00:00:00Z')");
    db.exec("DROP TABLE notification_ops; DROP TABLE schedule_runs; DROP TABLE schedules; UPDATE meta SET value = '12' WHERE key = 'schema_version'");
    db.close();
    db = new Db(dirs.dataDir);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any;
    assert.equal(version.value, "13");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((r) => r.name);
    for (const t of ["schedules", "schedule_runs", "notification_ops"]) assert.ok(tables.includes(t), t);
    assert.equal((db.prepare("SELECT name FROM projects WHERE id = 'p1'").get() as any).name, "keep");
    db.close();
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
  addSchedule(rt, h, { key: "k", action: "notify", rule: { kind: "once", at: "2026-09-24T01:00:00Z", time_zone: "UTC" }, text: "KILL-WINDOW" });
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
    await rt.scheduler.tick();
    await rt.scheduler.idle();
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
