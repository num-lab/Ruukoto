import { product as personalProduct } from "../apps/ruukoto/src/product.ts";
/**
 * agent-direction issue 08：绑定拥有者在 QQ 私聊 / Telegram 私聊完成审批。
 *
 * 真实 Runtime + mock 模型 + 回环 OneBot + 模拟 Bot API，不接触真实平台。
 * 受控数据操作使用主会话真实的 app_data 多行删除（凭执行效果断言，不只看回复文本）：
 * - 双平台各自：申请 → 原入口通知 → 列表/分页详情 → 批准 → 原操作恰好一次 → 原入口结果；
 *   拒绝与失效变体零执行；
 * - 命令经 event_kind=im_approval 控制事件直接处理（不建任务、零模型调用、不排在等待
 *   审批的普通任务后面）；重投读原回执、同键异命令拒绝；决定/控制/回执同事务提交；
 * - 身份逐项核实（平台/actor/钉版目标/配置版本/完整 ID/正整数版本）；跨平台、无来源、
 *   部分 ID、版本错误、转发、引用、群与临时会话、错误 self_id/sender 一律不能执行；
 * - owner/账号/配置版本/启停/凭据 A→B→A/删除的旧代次失效到达两平台（等待解除、
 *   未消费批准失效、旧消息不污染新代次），只影响原平台；
 * - 事务中途故障全部回滚；重启覆盖未决定与已批准未消费；遗留 sending 记 effect_unknown
 *   不重发；429 原键延后；迟到旧 token 错误脱敏。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import type { AppDataStore } from "@ruukoto/agent/app-data/store.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import type { NotificationOp } from "@ruukoto/channels/scheduler/store.ts";
import type { InboundEvent } from "@ruukoto/core/types.ts";
import { cleanupDirs, lastUserText, makeTestDirs, realTools, waitFor, writeModelsJson } from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "./helpers/mock-onebot.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";

const QQ_OWNER = "880001";
const QQ_OTHER = "880002";
const TG_TOKEN = "123456:SECRET-TOKEN-XYZ";
const TG_TOKEN_B = "654321:SECRET-TOKEN-B";
const TG_OWNER = 42;
const QQ_TIMEOUTS = { actionTimeoutMs: 400, probeIntervalMs: 100, reconnectMinMs: 50, reconnectMaxMs: 150, sweepIntervalMs: 80 };

// ---------- 脚本化模型：DEL2-<a><b>-<TAG> → 删除 todos 的第 a、b 行（多行写，需审批） ----------

function deleteResponder(): Responder {
  const deleted = new Set<string>();
  return async (req) => {
    if (req.messages.at(-1)?.role === "tool") return { kind: "text", text: "done" };
    const text = lastUserText(req);
    if (text.includes("DANGER-TUI")) {
      return { kind: "tool_calls", calls: [{ id: "danger-1", name: "mock_gate", arguments: { note: "受控危险操作" } }] };
    }
    const m = text.match(/DEL2-(\d)(\d)-([A-Z0-9]+)/);
    if (m && !deleted.has(m[0])) {
      deleted.add(m[0]);
      return {
        kind: "tool_calls",
        calls: [{
          id: `x-${m[0]}`,
          name: "app_data_delete",
          arguments: { table: "todos", rows: [{ id: Number(m[1]), expected_version: 1 }, { id: Number(m[2]), expected_version: 1 }], reason: "清理" },
        }],
      };
    }
    return { kind: "text", text: "REPLY-TEXT" };
  };
}

// ---------- 双平台 harness ----------

interface ImHarness {
  dirs: Awaited<ReturnType<typeof makeTestDirs>>["dirs"];
  config: RuntimeConfig;
  model: MockModelServer;
  onebot: MockOneBot;
  api: FakeBotApi;
  apiBase: string;
  rt: Runtime | null;
  close(): Promise<void>;
}

async function imHarness(prefix: string, responder: Responder): Promise<ImHarness> {
  const { dirs } = await makeTestDirs(prefix, 0);
  const onebot = await startMockOneBot({});
  const model = new MockModelServer(responder);
  await writeModelsJson(dirs, await model.start());
  const api = new FakeBotApi({ token: TG_TOKEN, ownerId: TG_OWNER });
  const apiBase = await api.start();
  const config: RuntimeConfig = {
    product: personalProduct.runtime,
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
    qq: QQ_TIMEOUTS,
    telegram: { pollTimeoutSec: 1, backoffMs: 50 },
    scheduler: { tickMs: 30, sendTimeoutMs: 1_000 },
  };
  return {
    dirs, config, model, onebot, api, apiBase, rt: null,
    async close() {
      await onebot.close();
      await api.close();
      await model.close();
      await cleanupDirs(dirs);
    },
  };
}

async function startWithPlatforms(h: ImHarness): Promise<Runtime> {
  const rt = await Runtime.start(h.config);
  h.rt = rt;
  await rt.addCredentialBinding({ name: "qq-test", host: h.onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
  await rt.qqConfigure({ endpoint: h.onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq-test", ownerUserId: QQ_OWNER });
  await rt.qqSetEnabled(true);
  await rt.addCredentialBinding({ name: "tg", host: new URL(h.apiBase).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN });
  await rt.telegramConfigure({ apiBase: h.apiBase, credential: "tg", ownerUserId: String(TG_OWNER) });
  await rt.telegramSetEnabled(true);
  await waitFor("QQ 已核实登录账号在线", () => rt.qqStatus().online === true);
  await waitFor("Telegram 轮询在线", () => rt.telegramStatus().online === true);
  return rt;
}

// ---------- 通用辅助 ----------

let seedSeq = 0;
function seedTodos(rt: Runtime, titles: string[]): void {
  const app = (rt as unknown as { appDataStore: AppDataStore }).appDataStore;
  const ctx = { taskId: "seed", sessionId: "seed", agentId: "main" as const };
  if (!app.listTables().some((t) => t.name === "todos")) {
    app.defineTable({ table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "建表", opId: `seed-def-${++seedSeq}`, ctx });
  }
  app.insert({ table: "todos", records: titles.map((title) => ({ title })), reason: "造数", opId: `seed-ins-${++seedSeq}`, ctx });
}

const countRows = (rt: Runtime) => (rt as unknown as { appDataStore: AppDataStore }).appDataStore.countRows("todos");
const controlEvents = (rt: Runtime): any[] => rt.store.db.prepare("SELECT * FROM inbound_events WHERE event_kind = 'im_approval' ORDER BY received_at, rowid").all() as any[];
const ops = (rt: Runtime, kind: NotificationOp["sourceKind"]) => rt.sched.listOps({ limit: 50 }).items.filter((op) => op.sourceKind === kind);
const receiptOps = (rt: Runtime) => ops(rt, "inbound_event");
const noticeOps = (rt: Runtime) => ops(rt, "confirmation").filter((op) => op.sourceKey.startsWith("im-approval:"));
const tgTexts = (api: FakeBotApi) => api.sends.map((s) => String(s.text));
const qqTexts = (onebot: MockOneBot) =>
  onebot.actions
    .filter((a) => a.action === "send_private_msg")
    .map((a) => (a.params.message as any[]).filter((s) => s?.type === "text").map((s) => String(s.data?.text ?? "")).join(""));
const pushQq = (onebot: MockOneBot, messageId: number, text: string, userId = QQ_OWNER) =>
  onebot.pushPrivateMessage({ userId, messageId, segments: [{ type: "text", data: { text } }] });
const events = (rt: Runtime, type: string) => rt.store.db.prepare("SELECT body FROM events").all().map((r: any) => JSON.parse(r.body)).filter((b: any) => b.type === type) as any[];
const imProcessed = (rt: Runtime) => events(rt, "im_approval.processed");

async function waitPending(rt: Runtime, count = 1): Promise<void> {
  await waitFor(`待审批数 ${count}`, () => rt.store.listConfirmationsByStatus("pending").length === count);
}
const solePending = (rt: Runtime) => {
  const all = rt.store.listConfirmationsByStatus("pending");
  assert.equal(all.length, 1, "恰有一个待审批");
  return all[0]!;
};

// ---------- 1. Telegram 端到端 ----------

test("Telegram：通知 → 列表 → 分页详情 → 批准 → 原操作恰好一次 → 原入口结果；重复决定拒绝", async () => {
  const h = await imHarness("im08-tg-flow", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    h.api.push({ text: "DEL2-12-T1，主人批准一下" });
    await waitPending(rt);
    const conf = solePending(rt);
    assert.equal(conf.toolName, "app_data_delete");
    assert.equal(countRows(rt), 3, "批准前零变更");
    // 原入口通知：工具、版本、完整审批 ID 与查询/批准/拒绝命令
    await waitFor("通知送达 Telegram", () => tgTexts(h.api).some((t) => t.includes("【需要审批】") && t.includes(conf.id)));
    const notice = tgTexts(h.api).find((t) => t.includes("【需要审批】"))!;
    assert.ok(notice.includes(`/approve ${conf.id} ${conf.permissionVersion}`));
    assert.ok(notice.includes(`/reject ${conf.id} ${conf.permissionVersion}`));
    assert.ok(notice.includes(`/approval ${conf.id}`));
    const noticeOp = noticeOps(rt).find((op) => op.sourceKey === `im-approval:${conf.id}`)!;
    assert.deepEqual(noticeOp.target, rt.store.getInboundEvent(rt.store.getTask(conf.taskId)!.sourceEventId!)!.replyTarget);

    const callsBefore = h.model.calls.length;
    // 列表
    h.api.push({ text: "/approvals" });
    await waitFor("列表回执", () => tgTexts(h.api).some((t) => t.includes("待处理审批 1 项")));
    const list = tgTexts(h.api).find((t) => t.includes("待处理审批"))!;
    assert.ok(list.includes(conf.id) && list.includes("app_data_delete") && list.includes(`v${conf.permissionVersion}`));
    // 分页详情：范围与参数分段、继续指引、决定命令
    h.api.push({ text: `/approval ${conf.id}` });
    await waitFor("详情回执", () => tgTexts(h.api).some((t) => t.includes(`审批 ${conf.id}`) && t.includes("参数（")));
    const detail = tgTexts(h.api).find((t) => t.includes(`审批 ${conf.id}`))!;
    assert.ok(detail.includes(`权限版本 v${conf.permissionVersion}`) && detail.includes("范围：") && detail.includes(`/approve ${conf.id} ${conf.permissionVersion}`));
    assert.equal(h.model.calls.length, callsBefore, "审批命令零额外模型调用");
    assert.equal(rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId).length, 1, "命令不建普通任务");
    assert.equal(controlEvents(rt).length, 2, "两条命令各一条控制事件");
    assert.ok(controlEvents(rt).every((e) => e.status === "done"));

    // 批准：决定/控制事件/回执同事务；操作恰好一次；原入口收最终回答
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    await waitFor("批准回执", () => tgTexts(h.api).some((t) => t.includes("已接受批准") && t.includes(conf.id)));
    await waitFor("任务完成", () => rt.store.getTask(conf.taskId)!.status === "completed");
    assert.equal(countRows(rt), 1, "多行删除恰好执行一次");
    assert.ok(rt.store.getConfirmation(conf.id)!.consumedAt);
    await waitFor("原入口最终回答", () => tgTexts(h.api).some((t) => t.includes("done")));
    const doneControl = controlEvents(rt).find((e) => e.body === `/approve ${conf.id} ${conf.permissionVersion}`)!;
    assert.equal(doneControl.status, "done");
    const receipt = receiptOps(rt).find((op) => op.sourceKey === doneControl.id)!;
    assert.equal(receipt.status, "sent");
    assert.ok(receipt.text.includes("已接受批准") && receipt.text.includes("执行前仍按当前绑定与权限复核"));
    assert.ok(imProcessed(rt).some((p) => p.outcome === "approved"));

    // 另一条消息对同一审批重复决定：只回执“已失效或已处理”，不重复执行
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    await waitFor("重复决定回执", () => tgTexts(h.api).filter((t) => t.includes("已失效或已处理")).length >= 1);
    assert.equal(countRows(rt), 1);
    assert.equal(rt.store.listConfirmationsByTask(conf.taskId).filter((c) => c.consumedAt).length, 1);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});


// ---------- 2. QQ 端到端 + 拒绝零执行 + 命令不死锁 ----------

test("QQ：批准/拒绝经私聊完成；命令在任务等待审批时直处理不死锁，普通消息继续排队", async () => {
  const h = await imHarness("im08-qq-flow", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    pushQq(h.onebot, 1, "DEL2-12-Q1 请批准");
    await waitPending(rt);
    const conf = solePending(rt);
    assert.equal(countRows(rt), 3);
    await waitFor("通知送达 QQ", () => qqTexts(h.onebot).some((t) => t.includes("【需要审批】") && t.includes(`/approve ${conf.id}`)));

    // main 正等待审批：命令直处理解除等待在前，普通新消息排队在后
    const callsBefore = h.model.calls.length;
    pushQq(h.onebot, 2, "/approvals");
    await waitFor("列表回执（任务仍在等待）", () => qqTexts(h.onebot).some((t) => t.includes("待处理审批 1 项")));
    assert.equal(rt.store.getTask(conf.taskId)!.status, "awaiting_confirmation", "查询不打断等待");
    assert.equal(countRows(rt), 3);
    pushQq(h.onebot, 3, "MARK-NORMAL 普通消息");
    await waitFor("普通消息已登记", () => rt.store.listInboundByStatus(["registered", "queued"]).some((e) => e.body.includes("MARK-NORMAL")));
    // 普通消息排队期间不启动新模型调用
    assert.ok(!h.model.calls.some((c) => lastUserText(c).includes("MARK-NORMAL")), "排队消息未提前启动");
    // 格式错误的已识别命令：宿主返回用法，不交给模型
    pushQq(h.onebot, 4, "/approve 缺参数");
    await waitFor("用法回执", () => qqTexts(h.onebot).some((t) => t.includes("用法：/approvals")));
    assert.equal(h.model.calls.length, callsBefore, "审批/查询/用法命令零额外模型调用");

    // 拒绝：零执行
    pushQq(h.onebot, 5, `/reject ${conf.id} ${conf.permissionVersion}`);
    await waitFor("拒绝回执", () => qqTexts(h.onebot).some((t) => t.includes("已拒绝") && t.includes(conf.id)));
    await waitFor("任务收尾", () => rt.store.getTask(conf.taskId)!.status === "completed");
    assert.equal(countRows(rt), 3, "拒绝后零执行");
    assert.equal(rt.store.getConfirmation(conf.id)!.consumedAt, null);
    assert.equal(rt.store.listToolOpsByTask(conf.taskId).find((o) => o.toolName === "app_data_delete")!.isError, true);
    // 普通消息随后继续（不饿死排队任务）
    await waitFor("排队消息恢复处理", () => h.model.calls.some((c) => lastUserText(c).includes("MARK-NORMAL")));
    await waitFor("普通消息最终回复", () => qqTexts(h.onebot).some((t) => t.includes("REPLY-TEXT")));

    // 批准后换另一条消息拒绝同一审批：只有先到的决定生效
    pushQq(h.onebot, 6, "DEL2-34-Q2");
    seedTodos(rt, ["四", "五"]);
    // seed 先于消息：行 4、5 就位后再触发
    pushQq(h.onebot, 7, "DEL2-45-Q2");
    await waitPending(rt);
    const conf2 = solePending(rt);
    pushQq(h.onebot, 8, `/approve ${conf2.id} ${conf2.permissionVersion}`);
    pushQq(h.onebot, 9, `/reject ${conf2.id} ${conf2.permissionVersion}`);
    await waitFor("决定回执（批准）", () => qqTexts(h.onebot).some((t) => t.includes("已接受批准") && t.includes(conf2.id)));
    await waitFor("反向决定回执为失效", () => qqTexts(h.onebot).some((t) => t.includes("已失效或已处理") && t.includes(conf2.id)));
    await waitFor("任务 2 完成", () => rt.store.getTask(conf2.taskId)!.status === "completed");
    assert.equal(countRows(rt), 3, "相反决定只生效一次，操作未重复也未被撤销");
    assert.equal(rt.store.listToolOpsByTask(conf2.taskId).filter((o) => o.toolName === "app_data_delete" && !o.isError).length, 1, "恰好一次成功执行");
    assert.ok(controlEvents(rt).every((e) => e.status === "done"));
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

// ---------- 3. 身份与格式矩阵 ----------

test("Telegram：非 owner/群/转发/格式/部分 ID/版本错误/跨平台/无来源一律不能执行，未核实不给详情", async () => {
  const h = await imHarness("im08-identity", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    h.api.push({ text: "DEL2-12-I1" });
    await waitPending(rt);
    const conf = solePending(rt);
    await waitFor("通知送达", () => tgTexts(h.api).some((t) => t.includes(conf.id)));
    const callsBefore = h.model.calls.length;
    const controlBefore = controlEvents(rt).length;

    // 非 owner：适配器直接拒收，不产生控制事件
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}`, from: 43, chatId: 43 });
    // 群消息中的命令
    h.api.push({ text: "/approvals", chatType: "group", from: TG_OWNER, chatId: -100 });
    await waitFor("两条拒收事件", () => events(rt, "telegram.rejected").length >= 2);
    assert.deepEqual(events(rt, "telegram.rejected").map((e) => e.reason).sort(), ["not_owner", "not_private"]);
    // 转发消息照常成为普通任务，但其内容不构成审批命令（不产生控制事件、零执行）
    const fwd = h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}`, forwardOrigin: { type: "hidden_user" } });
    await waitFor("转发消息按普通任务登记", () =>
      rt.store.listInboundByStatus(["registered", "queued", "done"]).some((e) => e.eventKind === "task" && e.body.includes(`message ${fwd.message_id}`)),
    );
    assert.ok(!controlEvents(rt).some((e) => e.external_id === `123456:42:${fwd.message_id}`), "转发内容不产生审批控制事件");
    // 引用（回复）正文仍按原发送文本处理：命令在引用里不构成批准——引用消息正文为普通内容时不解释为命令
    h.api.push({ text: "看到了，稍后处理", replyTo: { message_id: 1, text: `/approve ${conf.id} ${conf.permissionVersion}`, from: { is_bot: false } } });
    // 错误的决定命令：部分 ID
    h.api.push({ text: `/approve ${conf.id.slice(0, 8)} ${conf.permissionVersion}` });
    await waitFor("部分 ID 回执", () => tgTexts(h.api).some((t) => t.includes("不存在或不属于本入口")));
    // 版本错误
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion + 1}` });
    await waitFor("版本错误回执", () => tgTexts(h.api).some((t) => t.includes(`权限版本现在是 v${conf.permissionVersion}`)));
    // 不存在的审批 ID
    h.api.push({ text: "/approve cnf_nonexistent 1" });
    await waitFor("不存在回执", () => tgTexts(h.api).filter((t) => t.includes("不存在或不属于本入口")).length >= 2);

    // 跨平台：QQ 私聊查 Telegram 的审批详情 → 不提供详情
    pushQq(h.onebot, 1, `/approval ${conf.id}`);
    await waitFor("跨平台详情回执", () => qqTexts(h.onebot).some((t) => t.includes("不存在、已失效或不属于本入口")));
    const cross = qqTexts(h.onebot).find((t) => t.includes("不存在、已失效或不属于本入口"))!;
    assert.ok(!cross.includes("app_data_delete") && !cross.includes("rowIds"), "未经核实身份不泄露操作详情");

    // 无 IM 来源的审批（控制面发起的普通开发会话任务，mock 受控工具）：IM 不能决定
    seedTodos(rt, ["四", "五"]);
    const project = rt.store.createProject("tui-project");
    const workDir = fs.mkdtempSync(path.join(h.dirs.root, "work-"));
    const stat = fs.statSync(workDir);
    const tuiSession = rt.store.createSession({ projectId: project.id, cwd: workDir, cwdReal: fs.realpathSync(workDir), cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "pi-tui", confirmTools: ["mock_gate"] });
    await rt.submit({ sessionId: tuiSession.id, requestId: "tui-1", input: "DANGER-TUI", modelSelection: rt.defaultSelection });
    await waitPending(rt, 2);
    const tuiConf = rt.store.listConfirmationsByStatus("pending").find((c) => c.id !== conf.id)!;
    assert.equal(tuiConf.toolName, "mock_gate");
    h.api.push({ text: `/approve ${tuiConf.id} ${tuiConf.permissionVersion}` });
    await waitFor("无来源回执", () => tgTexts(h.api).some((t) => t.includes(tuiConf.id) && t.includes("不存在或不属于本入口")));

    assert.equal(countRows(rt), 5, "一切非法命令零执行");
    assert.ok(rt.store.listConfirmationsByStatus("pending").length >= 1);
    // 引用（回复）消息被当作普通正文登记为普通任务事件（引用中的命令不构成批准）；
    // 主会话仍被首个等待中的任务占用，该消息只排队、不产生控制事件
    const replyEvent = rt.store.listInboundByStatus(["registered", "queued"]).find((e) => e.body.includes("看到了，稍后处理"));
    assert.ok(replyEvent && replyEvent.eventKind === "task", "引用中的命令不进入审批路径");
    assert.equal(h.model.calls.length, callsBefore + 1, "命令零模型调用（仅 mock_gate 任务一次调用）");
    assert.equal(controlEvents(rt).length > controlBefore, true, "合法命令形态留有控制记录供重投去重");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("QQ：temporary/subtype、错误 self_id/sender 与群消息不进入审批路径", async () => {
  const h = await imHarness("im08-qq-identity", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    pushQq(h.onebot, 1, "DEL2-12-QI");
    await waitPending(rt);
    const conf = solePending(rt);
    await waitFor("通知送达", () => qqTexts(h.onebot).some((t) => t.includes(conf.id)));
    const callsBefore = h.model.calls.length;
    // 临时会话/群来源的私聊命令
    h.onebot.pushPrivateMessage({ userId: QQ_OWNER, messageId: 2, subType: "group", segments: [{ type: "text", data: { text: `/approve ${conf.id} 1` } }] });
    // 错误 self_id
    h.onebot.pushEvent({ post_type: "message", message_type: "private", sub_type: "friend", self_id: 990099, user_id: Number(QQ_OWNER), message_id: 3, message: [{ type: "text", data: { text: `/approve ${conf.id} 1` } }] });
    // sender 与 user_id 不一致
    h.onebot.pushEvent({ post_type: "message", message_type: "private", sub_type: "friend", self_id: Number(MOCK_QQ_ACCOUNT), user_id: Number(QQ_OWNER), message_id: 4, sender: { user_id: Number(QQ_OTHER) }, message: [{ type: "text", data: { text: `/approve ${conf.id} 1` } }] });
    // 群消息中的 /approve
    h.onebot.pushGroupMessage({ groupId: "100001", userId: QQ_OWNER, messageId: 5, segments: [{ type: "at", data: { qq: MOCK_QQ_ACCOUNT } }, { type: "text", data: { text: ` /approve ${conf.id} 1` } }] });
    // 非 owner 私聊
    pushQq(h.onebot, 6, `/approve ${conf.id} 1`, QQ_OTHER);
    // 等一段确保没有误处理
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(countRows(rt), 3, "一切非绑定私聊命令零执行");
    assert.equal(rt.store.getConfirmation(conf.id)!.status, "pending");
    assert.equal(controlEvents(rt).length, 0, "不产生审批控制事件");
    assert.equal(h.model.calls.length, callsBefore, "零额外模型调用");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

// ---------- 4. 竞争与重复投递 ----------

test("TUI 抢先与平台重投：决定及操作只生效一次；同键异命令拒绝；重投读原回执", async () => {
  const h = await imHarness("im08-races", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    h.api.push({ text: "DEL2-12-R1" });
    await waitPending(rt);
    const conf = solePending(rt);
    await waitFor("通知送达", () => tgTexts(h.api).some((t) => t.includes(conf.id)));

    // 控制面（TUI）抢先批准；IM 命令随后到达 → 已失效或已处理，操作不失序
    await (rt as any).respondConfirmation(conf.id, "approved", conf.permissionVersion);
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    await waitFor("IM 迟到回执", () => tgTexts(h.api).some((t) => t.includes(conf.id) && t.includes("已失效或已处理")));
    await waitFor("任务完成", () => rt.store.getTask(conf.taskId)!.status === "completed");
    assert.equal(countRows(rt), 1, "操作恰好一次（TUI 批准生效）");

    // 平台重投同一消息（同 message_id 新 update_id）：读原回执，不重复决定
    const before = { calls: h.model.calls.length, controls: controlEvents(rt).length, ops: receiptOps(rt).length };
    const dup = h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    const dupUpdateId = h.api.updates.at(-1)!.update_id;
    h.api.push({ message: dup });
    const redeliveredUpdateId = h.api.updates.at(-1)!.update_id;
    await waitFor("两条迟到命令与重投均已处理", () => Number(rt.telegramStore.getConfig()!.lastUpdateId) >= redeliveredUpdateId);
    assert.ok(redeliveredUpdateId > dupUpdateId);
    assert.equal(controlEvents(rt).length, before.controls + 1, "首条 IM 迟到命令登记控制事件，同键重投不新建");
    assert.equal(controlEvents(rt).filter((e) => e.external_id === `123456:${TG_OWNER}:${dup.message_id}`).length, 1);
    assert.equal(countRows(rt), 1);
    assert.equal(h.model.calls.length, before.calls);

    // 同键异命令（同 message_id 不同正文）：拒绝，不重复执行、不登记新回执
    const opsBefore = receiptOps(rt).length;
    h.api.push({ message: { message_id: dup.message_id, date: 1_790_000_000, chat: { id: TG_OWNER, type: "private" }, from: { id: TG_OWNER, is_bot: false }, text: `/reject ${conf.id} ${conf.permissionVersion}` } });
    await waitFor("同键异命令拒绝事件", () => events(rt, "im_approval.redelivery_rejected").length >= 1);
    assert.equal(receiptOps(rt).length, opsBefore, "同键异命令不产生新回执");
    assert.equal(countRows(rt), 1);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});


// ---------- 5. QQ 失效矩阵 ----------

test("QQ：owner 变化、停用再启用、凭据 A→B→A、凭据删除——旧批准失效零执行，等待解除，不波及 Telegram", async () => {
  const h = await imHarness("im08-qq-invalidation", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    seedTodos(rt, ["tg-a", "tg-b"]);
    // QQ 审批先占用 main；Telegram 消息随后入队——作为"不波及另一平台"的见证
    pushQq(h.onebot, 1, "DEL2-12-IA");
    await waitPending(rt);
    const iaConf = solePending(rt);
    await waitFor("QQ 通知", () => qqTexts(h.onebot).some((t) => t.includes(iaConf.id)));
    h.api.push({ text: "DEL2-45-TX" });
    let tgTaskId: string | null = null;
    await waitFor("Telegram 消息已入队等待", () => {
      const event = rt.store.listInboundByStatus(["registered", "queued"]).find((e) => e.source === "telegram");
      tgTaskId = rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId).find((t) => t.input.includes("DEL2-45-TX"))?.id ?? null;
      return event !== undefined || tgTaskId !== null;
    });

    // -- owner 变化：QQ 旧批准失效、任务取消；通知不发给新 owner；Telegram 排队任务不受影响
    const v0 = rt.qqStore.getConfig()!.configVersion;
    await rt.qqConfigure({ endpoint: h.onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq-test", ownerUserId: QQ_OTHER });
    assert.ok(rt.qqStore.getConfig()!.configVersion > v0, "配置版本单调推进");
    await waitFor("旧 owner 审批已失效", () => rt.store.getConfirmation(iaConf.id)!.status === "stale");
    assert.equal(rt.store.getTask(iaConf.taskId)!.status, "canceled");
    assert.equal(countRows(rt), 5, "旧批准零执行");
    assert.ok(!h.onebot.actions.some((a) => a.action === "send_private_msg" && String(a.params.user_id) === QQ_OTHER && JSON.stringify(a.params.message).includes("【需要审批】")), "旧 owner 通知不改发到新 owner");
    if (tgTaskId) assert.notEqual(rt.store.getTask(tgTaskId)!.status, "canceled", "另一平台排队任务不被取消");
    // 新 owner 也不能执行旧 owner 的审批（等代次重建连接后再发命令）
    await waitFor("QQ 新代次在线", () => rt.qqStatus().online === true);
    pushQq(h.onebot, 2, `/approve ${iaConf.id} ${iaConf.permissionVersion}`, QQ_OTHER);
    await waitFor("新 owner 收到不属本入口回执", () => qqTexts(h.onebot).some((t) => t.includes("不存在或不属于本入口")));
    assert.equal(countRows(rt), 5);
    await rt.qqConfigure({ endpoint: h.onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq-test", ownerUserId: QQ_OWNER });
    await waitFor("QQ 恢复在线", () => rt.qqStatus().online === true);

    // Telegram 排队任务随后正常开始并形成审批：先批准执行（行 4、5）
    await waitFor("Telegram 任务进入待审批", () => rt.store.listConfirmationsByStatus("pending").length === 1);
    const tgConf = solePending(rt);
    h.api.push({ text: `/approve ${tgConf.id} ${tgConf.permissionVersion}` });
    await waitFor("Telegram 批准生效", () => rt.store.getTask(tgConf.taskId)!.status === "completed");
    assert.equal(countRows(rt), 3, "Telegram 审批不受 QQ 代次变化影响，恰好执行一次");

    // -- 停用再启用：停用即失效，启用不复活旧代次
    pushQq(h.onebot, 3, "DEL2-12-EN");
    await waitPending(rt);
    const enConf = solePending(rt);
    await rt.qqSetEnabled(false);
    await waitFor("停用后审批失效", () => rt.store.getConfirmation(enConf.id)!.status === "stale");
    assert.equal(rt.qqStatus().online, false);
    await rt.qqSetEnabled(true);
    await waitFor("QQ 重新在线", () => rt.qqStatus().online === true);
    pushQq(h.onebot, 4, `/approve ${enConf.id} ${enConf.permissionVersion}`);
    await waitFor("启用后旧批准仍失效", () => qqTexts(h.onebot).some((t) => t.includes(enConf.id) && t.includes("不存在或不属于本入口")));
    assert.equal(countRows(rt), 3, "停用/启用不复活旧批准");

    // -- 凭据 A→B→A：每次变化推进代次，旧批准失效；回到 A 后新流程正常
    pushQq(h.onebot, 5, "DEL2-12-CR");
    await waitPending(rt);
    const crConf = solePending(rt);
    const v1 = rt.qqStore.getConfig()!.configVersion;
    await rt.addCredentialBinding({ name: "qq-test", host: h.onebot.host, header: "authorization", purpose: "qq_onebot", secret: "OTHER-SECRET" });
    assert.ok(rt.qqStore.getConfig()!.configVersion > v1, "A→B 推进代次");
    await waitFor("A→B 后审批失效", () => rt.store.getConfirmation(crConf.id)!.status === "stale");
    await waitFor("B 凭据未获接纳（QQ 离线）", () => rt.qqStatus().online === false);
    assert.equal(countRows(rt), 3);
    const v2 = rt.qqStore.getConfig()!.configVersion;
    await rt.addCredentialBinding({ name: "qq-test", host: h.onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
    assert.ok(rt.qqStore.getConfig()!.configVersion > v2, "B→A 再推进（旧代次不复活）");
    await waitFor("QQ 恢复在线", () => rt.qqStatus().online === true);
    pushQq(h.onebot, 6, "DEL2-12-CR2");
    await waitPending(rt);
    const cr2Conf = solePending(rt);
    pushQq(h.onebot, 7, `/approve ${cr2Conf.id} ${cr2Conf.permissionVersion}`);
    await waitFor("新代次批准生效", () => rt.store.getTask(cr2Conf.taskId)!.status === "completed");
    assert.equal(countRows(rt), 1, "新代次恰好执行一次（行 1、2 删除）");

    // -- 凭据删除：引用它的配置代次失效并断开
    seedTodos(rt, ["x", "y"]);
    pushQq(h.onebot, 8, "DEL2-45-DL");
    await waitPending(rt);
    const dlConf = solePending(rt);
    await rt.removeCredentialBinding("qq-test");
    await waitFor("凭据删除后审批失效", () => rt.store.getConfirmation(dlConf.id)!.status === "stale");
    assert.equal(rt.qqStatus().online, false, "凭据删除即断开");
    assert.equal(countRows(rt), 3, "行 4、5（x、y）未删除");
    const sendsBeforeDelete = h.onebot.actions.length;
    pushQq(h.onebot, 9, `/approve ${dlConf.id} ${dlConf.permissionVersion}`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.onebot.actions.filter((a) => a.action === "send_private_msg" && h.onebot.actions.indexOf(a) >= sendsBeforeDelete).length, 0, "凭据删除后不再发出任何私聊消息（含旧批准回执）");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

// ---------- 6. Telegram 失效矩阵 + 旧代次不污染 ----------

test("Telegram：凭据轮换使旧批准失效且旧偏移重置；旧轮询结果与重投不污染新代次；旧 null 目标明确失效", async () => {
  const h = await imHarness("im08-tg-invalidation", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    h.api.push({ text: "DEL2-12-TV" });
    await waitPending(rt);
    const tvConf = solePending(rt);
    await waitFor("通知送达", () => tgTexts(h.api).some((t) => t.includes(tvConf.id)));
    const tasksBefore = rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId).length;

    // A→B：批准失效、轮询断线；B 未获平台接纳（模拟 API 只认 A）
    const v0 = rt.telegramStore.getConfig()!.configVersion;
    await rt.addCredentialBinding({ name: "tg", host: new URL(h.apiBase).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN_B });
    assert.ok(rt.telegramStore.getConfig()!.configVersion > v0, "A→B 推进代次并归零偏移");
    await waitFor("轮换后审批失效", () => rt.store.getConfirmation(tvConf.id)!.status === "stale");
    await waitFor("B 未获接纳（轮询离线）", () => rt.telegramStatus().online === false);
    assert.equal(countRows(rt), 3);
    assert.equal(rt.store.getTask(tvConf.taskId)!.status, "canceled");

    // B→A：旧代次不复活；偏移归零后平台重投全部旧 update——按外部 id 去重，不重建任务、不重放批准
    await rt.addCredentialBinding({ name: "tg", host: new URL(h.apiBase).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN });
    await waitFor("A 恢复在线", () => rt.telegramStatus().online === true);
    await waitFor("平台重投已按幂等键去重", () => Number(rt.telegramStore.getConfig()!.lastUpdateId) >= h.api.updates.at(-1)!.update_id);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId).length, tasksBefore, "旧轮询结果不重建任务");
    assert.equal(countRows(rt), 3, "旧批准不重放执行");

    // 新代次流程正常（行 1、3 删除）
    h.api.push({ text: "DEL2-13-TW" });
    await waitFor("新代次待审批", () => rt.store.listConfirmationsByStatus("pending").length === 1);
    const twConf = solePending(rt);
    h.api.push({ text: `/approve ${twConf.id} ${twConf.permissionVersion}` });
    await waitFor("新代次批准生效", () => rt.store.getTask(twConf.taskId)!.status === "completed");
    assert.equal(countRows(rt), 1);

    // 旧 null 目标事件：无法证明接收时版本，派发门明确失效，不建任务、零模型调用
    const callsBefore = h.model.calls.length;
    const { event: legacy } = await rt.orchestrator!.registerInboundEvent({ source: "telegram", externalId: "legacy:42:1", actor: "telegram:42", targetRole: "main", body: "LEGACY-NULL 旧消息" });
    await rt.orchestrator!.dispatchRegisteredEvents();
    assert.equal(rt.store.getInboundEvent(legacy.id)!.status, "failed");
    assert.ok(events(rt, "inbound.skipped").some((e) => e.eventId === legacy.id && String(e.reason).includes("telegram_target_changed")));
    assert.equal(h.model.calls.length, callsBefore, "旧消息不启动模型");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});


// ---------- 7. 事务回滚与恢复 ----------

test("通知登记中途故障：审批创建整笔回滚（无审批、无通知、零执行），恢复后可重新申请", async () => {
  const h = await imHarness("im08-tx-notice", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    rt.store.db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON notification_ops WHEN NEW.source_key GLOB 'im-approval:*' BEGIN SELECT RAISE(ABORT, '注入故障'); END");
    h.api.push({ text: "DEL2-12-TF" });
    await waitFor("任务收场", () => {
      const task = rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId)[0];
      return task ? task.status !== "queued" && task.status !== "running" && task.status !== "awaiting_confirmation" : false;
    });
    assert.equal(rt.store.listConfirmationsByStatus("pending").length, 0, "通知失败不留审批");
    assert.equal(noticeOps(rt).length, 0, "通知未登记");
    assert.equal(countRows(rt), 3, "零执行");
    const task = rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId)[0]!;
    assert.equal(rt.store.listToolOpsByTask(task.id).find((o) => o.toolName === "app_data_delete")?.isError ?? null, true);
    // 故障解除后重新申请：新审批正常登记（含通知），批准可执行
    rt.store.db.exec("DROP TRIGGER fail_notice");
    h.api.push({ text: "DEL2-12-TG" });
    await waitPending(rt);
    const conf = solePending(rt);
    await waitFor("恢复后通知送达", () => tgTexts(h.api).some((t) => t.includes(conf.id)));
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    await waitFor("恢复后批准生效", () => rt.store.getTask(conf.taskId)!.status === "completed");
    assert.equal(countRows(rt), 1);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("决定/控制/回执中途故障全部回滚：审批保持待决，平台重投后成功一次", async () => {
  const h = await imHarness("im08-tx-decide", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    h.api.push({ text: "DEL2-12-TD" });
    await waitPending(rt);
    const conf = solePending(rt);
    await waitFor("通知送达", () => tgTexts(h.api).some((t) => t.includes(conf.id)));
    // 让"决定并入回执"的事务在控制事件已 INSERT 之后失败
    rt.store.db.exec("CREATE TRIGGER fail_rcpt BEFORE INSERT ON notification_ops WHEN NEW.source_kind = 'inbound_event' BEGIN SELECT RAISE(ABORT, '注入故障'); END");
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    // 平台在偏移未推进下重投；多次尝试都整笔回滚
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(rt.store.getConfirmation(conf.id)!.status, "pending", "决定随回执一起回滚");
    assert.equal(controlEvents(rt).length, 0, "控制事件未落盘");
    assert.equal(receiptOps(rt).length, 0, "回执未登记");
    assert.equal(countRows(rt), 3, "零执行");
    assert.ok(!tgTexts(h.api).some((t) => t.includes("已接受批准")), "决定接受不误报");
    // 故障解除：平台重投的消息再次到达审批路径，成功一次
    rt.store.db.exec("DROP TRIGGER fail_rcpt");
    await waitFor("重投后批准回执", () => tgTexts(h.api).some((t) => t.includes("已接受批准") && t.includes(conf.id)));
    await waitFor("重投后执行完成", () => rt.store.getTask(conf.taskId)!.status === "completed");
    assert.equal(countRows(rt), 1, "恰好执行一次");
    assert.equal(controlEvents(rt).length, 1);
    assert.equal(receiptOps(rt).length, 1);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("重启恢复：待决与已批准未消费一律失效，旧批准消息不重执行；遗留控制事件不派发；遗留 sending 不重发", async () => {
  const h = await imHarness("im08-recovery", deleteResponder());
  let rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    h.api.push({ text: "DEL2-12-TR" });
    await waitPending(rt);
    const conf = solePending(rt);
    await waitFor("通知送达", () => tgTexts(h.api).some((t) => t.includes(conf.id)));
    // 已批准未消费（崩溃窗口形态，直接构造）
    rt.store.db
      .prepare(
        `INSERT INTO confirmations (id, task_id, session_id, tool_op_id, tool_name, params, scope, permission_version, status, created_at, responded_at)
         SELECT 'cnf_crafted', task_id, session_id, tool_op_id, tool_name, params, scope, permission_version, 'approved', ?, ? FROM confirmations WHERE id = ?`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), conf.id);
    // 已消费在途（消费即执行开始；任何收尾都不得撤回或重放）
    rt.store.db
      .prepare(
        `INSERT INTO confirmations (id, task_id, session_id, tool_op_id, tool_name, params, scope, permission_version, status, created_at, responded_at, consumed_at)
         SELECT 'cnf_consumed', task_id, session_id, tool_op_id, tool_name, params, scope, permission_version, 'approved', ?, ?, ? FROM confirmations WHERE id = ?`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), conf.id);
    // 崩溃前的 registered 控制事件（未走完处理事务的遗留形态）
    rt.store.withTx(() =>
      rt.store.registerInboundEvent({ source: "telegram", externalId: "ctrl:stray:1", actor: "telegram:42", targetRole: "main", body: "/approve x 1", eventKind: "im_approval", replyTarget: { channel: "telegram", account: "123456", chatId: "42", configVersion: rt.telegramStore.getConfig()!.configVersion } }),
    );
    await rt.stop("restart");
    h.rt = null;

    rt = h.rt = await Runtime.start(h.config);
    // 恢复后：待决与已批准未消费一律失效；旧 waiter 不重建；已消费的事实保留、不重放
    assert.equal(rt.store.getConfirmation(conf.id)!.status, "stale", "待决审批恢复后失效");
    assert.equal(rt.store.getConfirmation("cnf_crafted")!.status, "stale", "已批准未消费恢复后失效");
    assert.equal(rt.store.getConfirmation("cnf_consumed")!.consumedAt !== null, true, "已消费的批准保持执行事实");
    assert.equal(rt.store.getConfirmation("cnf_consumed")!.status, "approved", "已消费不标失效、不重放");
    assert.equal(rt.store.getConfirmation(conf.id)!.consumedAt, null);
    assert.equal(countRows(rt), 3, "零重放执行");
    // registered 控制事件被恢复派发排除并作废，不作为新批准重放
    const stray = rt.store.findInboundEvent("telegram", "ctrl:stray:1")!;
    assert.equal(stray.eventKind, "im_approval");
    await waitFor("遗留控制事件作废", () => rt.store.findInboundEvent("telegram", "ctrl:stray:1")!.status === "failed");
    assert.ok(events(rt, "inbound.skipped").some((e) => e.reason?.includes("control_event_not_dispatched")));
    assert.equal(rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId).filter((t) => t.input.includes("ctrl:stray")).length, 0, "控制消息不建任务");
    // 旧批准消息再次到达：只回执已失效，不执行
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    await waitFor("旧批准回执为已失效", () => tgTexts(h.api).some((t) => t.includes(conf.id) && t.includes("已失效或已处理")));
    assert.equal(countRows(rt), 3);
    // 历史与执行事实保留：旧任务/事件可查
    assert.ok(rt.store.getTask(conf.taskId) !== null);
    await rt.stop("test_end");
    h.rt = null;

    // 遗留 sending（通知已领取未收尾）：重启记 effect_unknown 且不重新发送
    const sendsBefore = h.api.sends.length;
    rt = h.rt = await Runtime.start(h.config);
    // 制造一个真实遗留窗口：新审批通知领取后进程即停
    h.api.push({ text: "DEL2-13-TS" });
    await waitPending(rt);
    const conf2 = solePending(rt);
    const notice = noticeOps(rt).find((op) => op.sourceKey === `im-approval:${conf2.id}`)!;
    await waitFor("通知已领取或已发送", () => ["sending", "sent", "failed", "effect_unknown"].includes(rt.sched.getOp(notice.id)!.status));
    const claimed = rt.store.withTx(() => rt.sched.claim(notice.id));
    assert.equal(claimed || rt.sched.getOp(notice.id)!.status !== "pending", true);
    const noticeSendCount = () => h.api.sends.filter((s) => String(s.text).includes(conf2.id) && String(s.text).includes("【需要审批】")).length;
    const noticeCountBefore = noticeSendCount();
    await rt.stop("crash");
    h.rt = null;
    rt = h.rt = await Runtime.start(h.config);
    const after = rt.sched.getOp(notice.id)!;
    const restartMark = h.api.sends.length;
    await new Promise((r) => setTimeout(r, 400));
    if (after.status === "effect_unknown") {
      assert.equal(noticeSendCount() <= noticeCountBefore + 1, true, "飞行中的发送至多完成一次");
      assert.equal(h.api.sends.slice(restartMark).filter((s) => String(s.text).includes(conf2.id)).length, 0, "结果未知不自动重发（其他终态回执不属重发）");
    } else {
      assert.equal(after.status, "sent", "崩溃窗口外已完成的只得是确定结果");
      assert.equal(noticeSendCount(), 1, "已发送通知恰一次");
    }
    assert.equal(countRows(rt), 3, "重启后仍零执行");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

// ---------- 8. 发送边界 ----------

test("429 只按原通知操作延后重试，不换键；领取与 fetch 之间的配置变化按 target_changed 终止", async () => {
  const h = await imHarness("im08-send-limits", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    // 首个 sendMessage 限流一次，此后正常
    let firstDone = false;
    const defaultBehavior = h.api.behavior;
    h.api.behavior = (body, n) => {
      if (!firstDone) {
        firstDone = true;
        return { status: 429, body: { ok: false, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } } };
      }
      return defaultBehavior(body, n);
    };
    h.api.push({ text: "DEL2-12-TL" });
    await waitPending(rt);
    const conf = solePending(rt);
    const noticeKey = `im-approval:${conf.id}`;
    const notice = noticeOps(rt).find((op) => op.sourceKey === noticeKey)!;
    await waitFor("通知 429 后按原键重试成功", () => rt.sched.getOp(notice.id)!.status === "sent", 5_000);
    assert.equal(rt.sched.getOp(notice.id)!.status, "sent");
    const attempts = h.api.sends.filter((s) => String(s.text).includes(conf.id)).length;
    assert.equal(attempts, 2, "同一键先 429 后按 retry_after 重试（不向平台发第三份）");

    // 领取与实际 fetch 之间的配置变化：send 内最终复核按 target_changed 终止，可证明未发出
    const currentTarget = { channel: "telegram", account: "123456", chatId: "42", configVersion: rt.telegramStore.getConfig()!.configVersion };
    await rt.telegramConfigure({ apiBase: h.apiBase, credential: "tg", ownerUserId: String(TG_OWNER) });
    const sendsBefore = h.api.sends.length;
    const adapter = (rt as unknown as { telegram: { send(input: unknown): Promise<unknown> } }).telegram;
    const err = await adapter
      .send({ opId: notice.id, target: currentTarget, text: "x", signal: new AbortController().signal })
      .then(() => null, (e) => e);
    assert.ok(err && String(err.kind ?? err.message).includes("target_changed"));
    assert.equal(h.api.sends.length, sendsBefore, "目标变化后请求未发出");

    // QQ 同类边界：send 前最终复核拒绝旧目标，不产生平台动作
    const qqTarget = { channel: "qq_private", account: MOCK_QQ_ACCOUNT, chatId: QQ_OWNER, configVersion: rt.qqStore.getConfig()!.configVersion };
    await rt.qqConfigure({ endpoint: h.onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq-test", ownerUserId: QQ_OWNER });
    const qqAdapter = (rt as unknown as { qqAdapter: { send(input: unknown): Promise<unknown> } }).qqAdapter;
    const qqErr = await qqAdapter
      .send({ opId: notice.id, target: qqTarget, text: "x", signal: new AbortController().signal })
      .then(() => null, (e) => e);
    assert.ok(qqErr && String(qqErr.kind ?? qqErr.message).includes("target_changed"));
    assert.equal(h.onebot.actions.filter((a) => a.action === "send_private_msg" && ((a.params.message as any[]) ?? []).some((s) => s?.data?.text === "x")).length, 0);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("旧 token 的迟到错误在账本与事件里均脱敏（凭据轮换期间完成的发送）", async () => {
  const h = await imHarness("im08-token-redact", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    seedTodos(rt, ["一", "二", "三"]);
    // 首个 sendMessage 挂起，待凭据轮换完成后才以“引用旧 token 的错误描述”应答
    let release: ((r: { status: number; body: unknown }) => void) | null = null;
    let intercepted = false;
    h.api.behavior = (body, n) => {
      if (intercepted) return { status: 200, body: { ok: true, result: { message_id: 1000 + n } } };
      intercepted = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    h.api.push({ text: "DEL2-12-TR" });
    await waitPending(rt);
    const conf = solePending(rt);
    const notice = noticeOps(rt).find((op) => op.sourceKey === `im-approval:${conf.id}`)!;
    await waitFor("发送已在途", () => intercepted);
    // 凭据轮换发生在该请求的飞行途中（旧 token 仍是这次请求的错误来源）
    await rt.addCredentialBinding({ name: "tg", host: new URL(h.apiBase).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN_B });
    release!({ status: 400, body: { ok: false, description: `bad request /bot${TG_TOKEN}/sendMessage 已失效` } });
    await waitFor("发送收尾", () => ["failed", "sent", "effect_unknown"].includes(rt.sched.getOp(notice.id)!.status));
    const settled = rt.sched.getOp(notice.id)!;
    assert.equal(settled.status, "failed");
    assert.ok(settled.errorMessage!.includes("<token>"), "错误描述按该请求捕获的旧 token 脱敏");
    assert.ok(!settled.errorMessage!.includes(TG_TOKEN), "账本不含旧秘密值");
    const bodies = rt.store.db.prepare("SELECT body FROM events").all().map((r: any) => String(r.body)).join("\n");
    assert.ok(!bodies.includes(TG_TOKEN) && !bodies.includes(TG_TOKEN_B), "事件不含新旧秘密值");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});


// ---------- 10. 分页 ----------

test("列表翻页与详情参数分段：/approvals 游标与 /approval 偏移逐段到达全部数据", async () => {
  const h = await imHarness("im08-paging", deleteResponder());
  const rt = await startWithPlatforms(h);
  try {
    // 宿主直接构造 6 条同一 Telegram 委托任务的待决审批（命令路径只读核实归属与内容，
    // 不依赖串行工具轮制造并发等待）；来源事件按存储层登记，不经编排器派发；
    // 其中一条带超大参数供分段详情
    const { event } = rt.store.withTx(() =>
      rt.store.registerInboundEvent({
        source: "telegram",
        externalId: "123456:42:777",
        actor: "telegram:42",
        targetRole: "main",
        body: "[Telegram 私聊] 六个删除",
        replyTarget: { channel: "telegram", account: "123456", chatId: "42", configVersion: rt.telegramStore.getConfig()!.configVersion },
      }),
    );
    const main = rt.store.getAgentRole("main")!;
    const { task } = rt.store.insertQueuedTask({
      sessionId: main.sessionId,
      requestId: "im-many-1",
      input: "六个删除",
      modelSelection: rt.defaultSelection,
      submissionDigest: "im-many-1",
      agentId: "main",
      sourceEventId: event.id,
      accessMode: "confirm",
    });
    rt.store.transitionTask(task.id, ["queued"], "running", {});
    rt.store.markInboundQueued(event.id, task.id);
    const confs = rt.store.withTx(() =>
      Array.from({ length: 6 }, (_, i) =>
        rt.store.createConfirmation({
          taskId: task.id,
          sessionId: task.sessionId,
          toolOpId: `op_many_${i}`,
          toolName: "app_data_delete",
          params: { table: "todos", rows: [{ id: i * 2 + 1, expected_version: 1 }, { id: i * 2 + 2, expected_version: 1 }], reason: i === 0 ? `清理-${"长".repeat(1800)}` : "清理" },
          scope: {
            kind: "app_data_change",
            appDbInstanceId: "appdb-paging",
            taskId: task.id,
            toolOpId: `op_many_${i}`,
            table: "todos",
            operation: "delete",
            change: "multi_row_write",
            schemaVersion: 1,
            revision: 1,
            paramsSha256: "paging",
            affected: 2,
            rowIds: [i * 2 + 1, i * 2 + 2],
            rowVersions: { [i * 2 + 1]: 1, [i * 2 + 2]: 1 },
            definitionBefore: null,
            definitionAfter: null,
          },
          permissionVersion: 1,
        }),
      ),
    );
    assert.equal(confs.length, 6);
    const callsBefore = h.model.calls.length;
    // 第 0 页：5 条 + 下一页指引；第 1 页：1 条，无下一页
    h.api.push({ text: "/approvals" });
    await waitFor("列表第 0 页", () => tgTexts(h.api).some((t) => t.includes("待处理审批 6 项（第 0/1 页）") && t.includes("下一页：/approvals 1")));
    const page0 = tgTexts(h.api).find((t) => t.includes("第 0/1 页"))!;
    h.api.push({ text: "/approvals 1" });
    await waitFor("列表第 1 页", () => tgTexts(h.api).some((t) => t.includes("待处理审批 6 项（第 1/1 页）")));
    const page1 = tgTexts(h.api).find((t) => t.includes("第 1/1 页"))!;
    const idsOf = (text: string) => [...new Set([...text.matchAll(/conf_[a-z0-9]+/g)].map((m) => m[0]))];
    assert.equal(idsOf(page0).length + idsOf(page1).length, 6, "两页合计恰好 6 条");
    assert.equal(new Set([...idsOf(page0), ...idsOf(page1)]).size, 6, "两页不重叠");
    assert.ok(!page1.includes("下一页："));
    // 详情参数分段：大分段首段给出继续偏移，逐段读到完整的参数
    const bigConf = rt.store.listConfirmationsByStatus("pending").find((c) => Buffer.byteLength(JSON.stringify(c.params), "utf8") > 5000)!;
    h.api.push({ text: `/approval ${bigConf.id}` });
    await waitFor("详情首段", () => tgTexts(h.api).some((t) => t.includes(`审批 ${bigConf.id}`) && t.includes("非最后一段") && t.includes("继续：/approval")));
    const seg0 = tgTexts(h.api).find((t) => t.includes(`审批 ${bigConf.id}`) && t.includes("继续：/approval"))!;
    const nextOffset = Number(seg0.match(new RegExp(`继续：/approval ${bigConf.id} (\\d+)`))![1]);
    assert.ok(nextOffset > 0);
    h.api.push({ text: `/approval ${bigConf.id} ${nextOffset}` });
    await waitFor("详情续段", () => tgTexts(h.api).some((t) => t.includes(`审批 ${bigConf.id}`) && t.includes(`参数（字节 ${nextOffset}–`)));
    const seg1 = tgTexts(h.api).filter((t) => t.includes(`审批 ${bigConf.id}`) && t.includes(`参数（字节 ${nextOffset}–`)).at(-1)!;
    assert.ok(seg1.includes("已到末尾"), "续段标明剩余为完整部分");
    assert.ok(seg1.includes(`/approve ${bigConf.id} ${bigConf.permissionVersion}`), "续段仍给出决定命令");
    assert.equal(h.model.calls.length, callsBefore, "分页命令零额外模型调用");
    // 非等待中的任务不接受 IM 决定（回执如实标注，不执行）
    h.api.push({ text: `/approve ${bigConf.id} ${bigConf.permissionVersion}` });
    await waitFor("非等待任务回执为已失效", () => tgTexts(h.api).some((t) => t.includes("已失效") && t.includes(bigConf.id)));
    assert.equal(rt.store.getConfirmation(bigConf.id)!.consumedAt, null, "零执行");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});
