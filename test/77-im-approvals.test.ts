import { product as personalProduct } from "./helpers/legacy-product.ts";
/** 旧审批恢复保留已消费事实，未决批准失效，未知通知不重发。 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import type { AppDataStore } from "@ruukoto/agent/app-data/store.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import type { NotificationOp } from "@ruukoto/channels/scheduler/store.ts";
import { cleanupDirs, lastUserText, makeTestDirs, waitFor, writeModelsJson } from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "./helpers/mock-onebot.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";

const QQ_OWNER = "880001";
const TG_TOKEN = "123456:SECRET-TOKEN-XYZ";
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
const ops = (rt: Runtime, kind: NotificationOp["sourceKind"]) => rt.sched.listOps({ limit: 50 }).items.filter((op) => op.sourceKind === kind);
const noticeOps = (rt: Runtime) => ops(rt, "confirmation").filter((op) => op.sourceKey.startsWith("im-approval:"));
const tgTexts = (api: FakeBotApi) => api.sends.map((s) => String(s.text));
const events = (rt: Runtime, type: string) => rt.store.db.prepare("SELECT body FROM events").all().map((r: any) => JSON.parse(r.body)).filter((b: any) => b.type === type) as any[];

async function waitPending(rt: Runtime, count = 1): Promise<void> {
  await waitFor(`待审批数 ${count}`, () => rt.store.listConfirmationsByStatus("pending").length === count);
}
const solePending = (rt: Runtime) => {
  const all = rt.store.listConfirmationsByStatus("pending");
  assert.equal(all.length, 1, "恰有一个待审批");
  return all[0]!;
};

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
