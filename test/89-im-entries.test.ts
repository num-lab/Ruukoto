/**
 * 拥有者 IM 入口表（架构工单 10）：模块在临时 Store 上直接构造，入口用实现 ImEntry
 * 的假入口；启动配置停用一例用真 adapter + 回环探针核对「不连接、不轮询」。
 * 集成证据（队列循环、编排器、审批确实走本模块）在 38、40、77、84。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { CredentialStore } from "../src/agent/execution/credentials.ts";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import type { InboundEvent, NotifyTarget, Task } from "../src/core/types.ts";
import { QqAdapter } from "../src/qq/adapter.ts";
import { QqStore } from "../src/qq/store.ts";
import { SchedulerStore } from "../src/scheduler/store.ts";
import { TelegramAdapter, TelegramStore } from "../src/telegram/adapter.ts";
import { ImEntries, type ImEntry } from "../src/runtime/im-entries.ts";

const SELECTION = { provider: "mock", modelId: "mock", thinkingLevel: "off" as const };

type FakeEntry = ImEntry & { current: NotifyTarget | null; gateResult: "run" | "wait" | { drop: string }; credential: string | null; calls: string[] };

/** 假入口：门、目标与凭据引用由测试直接改。 */
function fakeEntry(source: string): FakeEntry {
  const entry: FakeEntry = {
    source,
    startupDisabled: false,
    current: { channel: source, account: "acct", chatId: "chat", configVersion: 1 },
    gateResult: "run",
    credential: null,
    calls: [],
    target: () => entry.current,
    send: async () => ({ platformMessageId: "1" }),
    gatePrivate: () => entry.gateResult,
    expectedActor: () => `${source}:owner`,
    replyCapChars: () => 5,
    capReply: (text) => text.slice(0, 5),
    externalIdPrefix: (t) => `${t.account}:${t.chatId}:`,
    usesCredential: (name) => entry.credential === name,
    bumpGeneration: () => void entry.calls.push("bump"),
    onConfigChanged: async () => void entry.calls.push("changed"),
  };
  return entry;
}

function kit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-im-entries-"));
  const store = new Store(new Db(root));
  const sched = new SchedulerStore(store);
  const project = store.createProject("p");
  const main = store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: 1, piSessionId: "pi-main", confirmTools: [] });
  store.insertAgentRole({ id: "main", projectId: project.id, sessionId: main.id, workDir: root, modelSelection: null, tools: [], createdAt: main.createdAt });
  const qq = fakeEntry("qq_private");
  const tg = fakeEntry("telegram");
  const log = { canceled: [] as Array<[string, string]>, invalidated: [] as string[], kicked: 0, kickedSender: 0 };
  const replies = new Map<string, string>();
  let n = 0;
  const event = (source: string, opts: { queued?: boolean; target?: NotifyTarget | null } = {}): InboundEvent => {
    const target = opts.target === undefined ? { channel: source, account: "acct", chatId: "chat", configVersion: 1 } : opts.target;
    const { event } = store.registerInboundEvent({ source, externalId: `acct:chat:${++n}`, actor: `${source}:owner`, targetRole: "main", body: "hi", replyTarget: target });
    if (!opts.queued) return event;
    const { task } = store.insertQueuedTask({
      sessionId: main.id, requestId: `r${n}`, input: "hi", modelSelection: SELECTION, submissionDigest: `d${n}`,
      workId: null, subAgentId: null, parentTaskId: null, sourceEventId: event.id, agentId: null,
    });
    store.withTx(() => store.markInboundQueued(event.id, task.id));
    return store.getInboundEvent(event.id)!;
  };
  const entries = (list: ImEntry[] = [qq, tg]) => new ImEntries({
    store, sched, entries: list,
    readReply: (taskId) => replies.get(taskId) ?? null,
    cancelTask: async (taskId, reason) => void log.canceled.push([taskId, reason]),
    invalidateApprovals: (source) => void log.invalidated.push(source),
    kick: () => void log.kicked++,
    kickSender: () => void log.kickedSender++,
  });
  const ops = () => sched.listOps({ limit: 50 }).items;
  const events = (type: string) => store.getEventsAfter(0).map((e) => e.body as Record<string, unknown>).filter((b) => b.type === type);
  return { root, store, sched, qq, tg, log, replies, event, entries, ops, events, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("按来源 reconcile：作废门已作废的 registered、按 drop 原因取消活动任务，不波及另一平台", async () => {
  const k = kit();
  try {
    const qqRegistered = k.event("qq_private");
    const qqQueued = k.event("qq_private", { queued: true });
    const tgRegistered = k.event("telegram");
    const tgQueued = k.event("telegram", { queued: true });
    k.qq.gateResult = { drop: "qq_private_target_changed:x" };
    k.tg.gateResult = { drop: "telegram_target_changed:x" };
    await k.entries().reconcile("qq_private");
    assert.equal(k.store.getInboundEvent(qqRegistered.id)!.status, "failed");
    assert.deepEqual(k.log.canceled, [[qqQueued.taskId, "qq_private_target_changed:x"]]);
    assert.equal(k.store.getInboundEvent(tgRegistered.id)!.status, "registered", "另一平台的入站不动");
    assert.equal(k.store.getTask(tgQueued.taskId!)!.status, "queued", "另一平台的任务不取消");
    assert.deepEqual(k.log.invalidated, ["qq_private"]);
    assert.equal(k.log.kicked, 1);
    assert.equal(k.log.kickedSender, 1);

    // 暂时离线（wait）不作废
    k.log.canceled.length = 0;
    k.tg.gateResult = "wait";
    await k.entries().reconcile("telegram");
    assert.equal(k.store.getInboundEvent(tgRegistered.id)!.status, "registered");
    assert.deepEqual(k.log.canceled, []);
  } finally {
    k.close();
  }
});

test("owner 回复与工作汇报：目标一致时按入口截断登记，目标变化/前缀不符/旧 null 目标跳过", () => {
  const k = kit();
  try {
    const im = k.entries();
    const sent = k.event("telegram", { queued: true });
    const task = k.store.getTask(sent.taskId!)! as Task;
    k.replies.set(task.id, "  完整回答很长  ");
    im.enqueueOwnerReply(sent, task, "completed");
    im.sendWorkReport({ event: sent, key: `${sent.id}#work:w1`, wakeTaskId: task.id, text: "工作汇报正文" } as never);
    assert.deepEqual(k.ops().map((op) => [op.sourceKey, op.text, op.target.channel]).sort(), [
      [`${sent.id}#work:w1`, "工作汇报正", "telegram"],
      [sent.id, "完整回答很", "telegram"],
    ]);

    // 当前目标变化（配置版本前进）：不改发新目标，记跳过
    k.tg.current = { channel: "telegram", account: "acct", chatId: "chat", configVersion: 2 };
    const changed = k.event("telegram", { queued: true });
    im.enqueueOwnerReply(changed, k.store.getTask(changed.taskId!)!, "failed");
    im.sendWorkReport({ event: changed, key: `${changed.id}#work:w2`, wakeTaskId: changed.taskId!, text: "x" } as never);
    // externalId 不是由钉版账号 + chat 登记的
    k.tg.current = { channel: "telegram", account: "other", chatId: "chat", configVersion: 1 };
    const foreign = k.event("telegram", { queued: true, target: { channel: "telegram", account: "other", chatId: "chat", configVersion: 1 } });
    im.enqueueOwnerReply(foreign, k.store.getTask(foreign.taskId!)!, "completed");
    const legacy = k.event("telegram", { queued: true, target: null });
    im.enqueueOwnerReply(legacy, k.store.getTask(legacy.taskId!)!, "completed");
    assert.equal(k.ops().length, 2, "跳过的回复不登记发送");
    assert.deepEqual(k.events("telegram.reply_skipped").map((e) => e.reason), [
      "target_changed", "work_report:target_changed", "target_changed", "target_unavailable",
    ]);

    // 非拥有者 IM 来源不自动外发
    const github = k.event("github", { queued: true });
    im.enqueueOwnerReply(github, k.store.getTask(github.taskId!)!, "completed");
    assert.equal(k.ops().length, 2);
  } finally {
    k.close();
  }
});

test("凭据变化只推进并 reconcile 引用该凭据的入口", async () => {
  const k = kit();
  try {
    k.qq.credential = "shared";
    k.tg.credential = "tg-only";
    const im = k.entries();
    im.bumpForCredential("shared");
    await im.reconcileAfterCredential("shared");
    assert.deepEqual(k.qq.calls, ["bump", "changed"]);
    assert.deepEqual(k.tg.calls, []);
    assert.deepEqual(k.log.invalidated, ["qq_private"]);
    im.bumpForCredential("unrelated");
    await im.reconcileAfterCredential("unrelated");
    assert.deepEqual(k.qq.calls, ["bump", "changed"]);
  } finally {
    k.close();
  }
});

test("缺省渠道 Telegram 可被测试覆盖；QQ 来源通知只在钉版目标一致时发 QQ", () => {
  const k = kit();
  try {
    const override = { target: () => ({ channel: "mock", account: "m", chatId: "m", configVersion: 9 }), send: async () => ({ platformMessageId: "1" }) };
    const im = new ImEntries({ store: k.store, sched: k.sched, entries: [k.qq, k.tg], defaultChannel: override,
      readReply: () => null, cancelTask: async () => {}, invalidateApprovals: () => {}, kick: () => {}, kickSender: () => {} });
    assert.equal(im.channel(), override);
    assert.equal(im.channel("telegram"), override);
    assert.equal(im.channel("mock"), override);
    assert.equal(im.channel("qq_private"), k.qq, "非缺省入口不受覆盖");
    assert.equal(k.entries().channel("github"), null);

    const qqEvent = k.event("qq_private");
    assert.deepEqual(im.notificationTarget(qqEvent), k.qq.current);
    k.qq.current = { ...k.qq.current!, configVersion: 2 };
    assert.equal(im.notificationTarget(qqEvent), null, "QQ 钉版目标变化不改发");
    assert.equal(im.notificationTarget(k.event("telegram"))?.channel, "mock");
    assert.equal(im.notificationTarget(null)?.channel, "mock");
  } finally {
    k.close();
  }
});

test("启动配置停用：入口照常创建但不连接、不轮询；门作废、目标为 null、outbox 视为未加载，reconcile 取消排队任务", async () => {
  const k = kit();
  let connections = 0;
  const probe = net.createServer((socket) => { connections++; socket.destroy(); });
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  const credentials = new CredentialStore(path.join(k.root, "agent"));
  const qqStore = new QqStore((k.store as unknown as { db: Db }).db);
  const tgStore = new TelegramStore(k.store);
  try {
    credentials.upsert({ name: "qq", host: `127.0.0.1:${port}`, header: "authorization", purpose: "qq_onebot", secret: "s" });
    credentials.upsert({ name: "tg", host: `127.0.0.1:${port}`, header: "none", purpose: "telegram_bot", secret: "123:abc" });
    const qq = new QqAdapter({
      store: k.store, qqStore, sched: k.sched, credentials, startupDisabled: "dev",
      bridge: { registerPrivate: async () => {}, dispatchInbound: async () => {}, kickSession: () => {} },
    });
    const tg = new TelegramAdapter({ store: k.store, tg: tgStore, sched: k.sched, credentials, register: async () => {}, log: () => {}, startupDisabled: "product" });
    qq.configure({ endpoint: `ws://127.0.0.1:${port}/`, credential: "qq", selfId: "10001", ownerUserId: "10002" });
    qq.setEnabled(true);
    tg.configure({ apiBase: `http://127.0.0.1:${port}`, credential: "tg", ownerUserId: "42" });
    tg.setEnabled(true);
    await qq.start();
    tg.start();
    await qq.onConfigChanged();
    await tg.onConfigChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(connections, 0, "不打开 WebSocket、不轮询");
    assert.equal(qq.target(), null);
    assert.equal(tg.target(), null);
    assert.match(String(qq.status().stateDetail), /dev 开发实例/);
    assert.equal((qq.status() as { disabledByConfig?: boolean }).disabledByConfig, true);
    assert.match(String(tg.status().stateDetail), /ruukoto-dev/);

    const im = new ImEntries({ store: k.store, sched: k.sched, entries: [qq, tg],
      readReply: () => null, cancelTask: async (taskId, reason) => void k.log.canceled.push([taskId, reason]),
      invalidateApprovals: () => {}, kick: () => {}, kickSender: () => {} });
    assert.equal(im.channel("qq_private"), null, "outbox 等待（sender_unavailable），不按停用取消");
    assert.equal(im.channel("telegram"), null);
    const queued = k.event("qq_private", { queued: true });
    const tgQueued = k.event("telegram", { queued: true });
    assert.deepEqual(im.gate(queued), { drop: "qq_private_unavailable:QQ 私聊入口未启动（启动配置停用）" });
    assert.deepEqual(im.gate(tgQueued), { drop: "telegram_unavailable:Telegram 适配器未启动" });
    await im.reconcile("qq_private");
    assert.deepEqual(k.log.canceled, [[queued.taskId, "qq_private_unavailable:QQ 私聊入口未启动（启动配置停用）"]]);
    await qq.stop();
    await tg.stop();
  } finally {
    probe.close();
    k.close();
  }
});
