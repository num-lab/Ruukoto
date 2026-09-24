/**
 * Telegram owner 入口集成测试（daily-agent issue 04）：本地模拟 Bot API + mock 模型。
 *
 * 覆盖工单验证项：
 * - 认证 owner 私聊进入同一个 main 会话，回复经 outbox 发回并关联原消息；
 * - 重复 update 不重复创建任务或发送消息；
 * - 非 owner / 群聊 / 非文本消息不触发 main（零模型调用）；
 * - 断线重连与重启不丢已登记消息；重启补登回复按任务读取；
 * - 发送失败和结果未知不自动重发；429 限流退回 pending 按 retry_after 再发；
 * - bot token 不进入模型请求、事件表与 stderr；会话默认 full_access 时 Telegram 任务仍为 confirm。
 */

import assert from "node:assert/strict";
import * as http from "node:http";
import * as path from "node:path";
import { test } from "node:test";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { createMockTools } from "../src/agent/mock-tools.ts";
import { cleanupDirs, lastUserText, makeTestDirs, waitFor, writeModelsJson } from "./helpers/testkit.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";

const TOKEN = "123456:SECRET-TOKEN-XYZ";
const OWNER = 42;

type Reply = { status: number; body: unknown };

/** 模拟 Bot API：getUpdates 按 offset 返回排队的 update；sendMessage 由 behavior 决定回执。 */
class FakeBotApi {
  updates: any[] = [];
  sends: any[] = [];
  paths: string[] = [];
  offline = false;
  behavior: (body: any, n: number) => Reply = () => ({ status: 200, body: { ok: true, result: { message_id: 1000 + this.sends.length } } });
  private server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      this.paths.push(req.url ?? "");
      const body = raw ? JSON.parse(raw) : {};
      const reply = (r: Reply) => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      };
      if (!req.url?.startsWith(`/bot${TOKEN}/`)) return reply({ status: 401, body: { ok: false, description: "Unauthorized" } });
      if (req.url.endsWith("/getUpdates")) {
        if (this.offline) return reply({ status: 502, body: { ok: false, description: "Bad Gateway" } });
        // 短暂挂起模拟长轮询，避免测试空转
        setTimeout(() => reply({ status: 200, body: { ok: true, result: this.updates.filter((u) => u.update_id >= (body.offset ?? 0)) } }), 30);
        return;
      }
      if (req.url.endsWith("/sendMessage")) {
        this.sends.push(body);
        return reply(this.behavior(body, this.sends.length));
      }
      reply({ status: 404, body: { ok: false, description: "Not Found" } });
    });
  });
  private nextUpdate = 1;
  private nextMessage = 1;

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as any).port}`;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  /** 推入一条私聊消息 update；返回 message_id（重复投递传入同一 message）。 */
  push(opts: { text?: string; from?: number; chatType?: string; chatId?: number; message?: any; replyTo?: any } = {}): any {
    const message = opts.message ?? {
      message_id: this.nextMessage++,
      date: 1_790_000_000,
      chat: { id: opts.chatId ?? opts.from ?? OWNER, type: opts.chatType ?? "private" },
      from: { id: opts.from ?? OWNER, is_bot: false },
      ...(opts.text !== undefined ? { text: opts.text } : { sticker: { file_id: "x" } }),
      ...(opts.replyTo ? { reply_to_message: opts.replyTo } : {}),
    };
    this.updates.push({ update_id: this.nextUpdate++, message });
    return message;
  }
}

interface Harness {
  api: FakeBotApi;
  apiBase: string;
  model: MockModelServer;
  reqs: any[];
  config: RuntimeConfig;
  close(): Promise<void>;
}

async function harness(prefix: string): Promise<Harness> {
  const { dirs } = await makeTestDirs(prefix, 1);
  const reqs: any[] = [];
  const model = new MockModelServer(async (req) => {
    reqs.push(req);
    const text = lastUserText(req);
    // 取最后一个标记（回复关联行会引用被回复消息里的标记）
    const marker = [...text.matchAll(/MARK-[A-Z0-9-]+/g)].at(-1)?.[0] ?? "none";
    return { kind: "text", text: `REPLY ${marker}` };
  });
  await writeModelsJson(dirs, await model.start());
  const api = new FakeBotApi();
  const apiBase = await api.start();
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
    scheduler: { tickMs: 30, sendTimeoutMs: 2_000 },
    telegram: { pollTimeoutSec: 1, backoffMs: 50 },
  };
  return {
    api, apiBase, model, reqs, config,
    async close() {
      await api.close();
      await model.close();
      await cleanupDirs(dirs);
    },
  };
}

async function configure(rt: Runtime, h: Harness): Promise<void> {
  rt.addCredentialBinding({ name: "tg", host: new URL(h.apiBase).host, header: "none", purpose: "telegram_bot", secret: TOKEN });
  await rt.telegramConfigure({ apiBase: h.apiBase, credential: "tg", ownerUserId: String(OWNER) });
  await rt.telegramSetEnabled(true);
}

const mainTasks = (rt: Runtime) => rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId);
const replyOps = (rt: Runtime) => rt.sched.listOps({ limit: 50 }).items.filter((o) => o.sourceKind === "owner_reply");
const modelSaw = (h: Harness, marker: string) => h.reqs.filter((r) => lastUserText(r).includes(marker)).length;

test("owner 私聊进入同一 main 会话并回复原消息；重复 update 与非 owner 消息不建任务；full_access 默认下仍 confirm；token 不外泄", async () => {
  const h = await harness("tg-owner");
  const stderr: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => (stderr.push(String(chunk)), origWrite(chunk, ...rest));
  const rt = await Runtime.start(h.config);
  try {
    const main = rt.store.getSession(rt.store.getAgentRole("main")!.sessionId)!;
    await rt.setSessionDefaultMode({ sessionId: main.id, mode: "full_access", expectedVersion: main.defaultAccessModeVersion });
    await configure(rt, h);

    const m1 = h.api.push({ text: "MARK-ONE 帮我记一下" });
    h.api.push({ message: m1 }); // 平台重投同一条消息（新 update_id）
    h.api.push({ text: "MARK-STRANGER 陌生人", from: 99 });
    h.api.push({ text: "MARK-GROUP 群聊", chatType: "group", chatId: -100 });
    h.api.push({}); // owner 发贴纸（非文本）
    await waitFor("第一条回复已发送", () => replyOps(rt).some((o) => o.status === "sent"));
    const m2 = h.api.push({ text: "MARK-TWO 再问一句", replyTo: { message_id: 1000, from: { id: 1, is_bot: true }, text: "REPLY MARK-ONE" } });
    await waitFor("第二条回复已发送", () => replyOps(rt).filter((o) => o.status === "sent").length === 2);

    const tasks = mainTasks(rt);
    assert.equal(tasks.length, 2, "重复 update 与被拒消息不建任务");
    assert.ok(tasks.every((t) => t.accessMode === "confirm"), "Telegram 任务不继承会话默认 full_access");
    assert.ok(tasks[1]!.input.includes("回复关联：message 1000（本 bot 发送）") && tasks[1]!.input.includes("[Telegram 私聊] chat 42 user 42"));
    assert.equal(modelSaw(h, "MARK-ONE 帮我记一下"), 1);
    assert.equal(modelSaw(h, "MARK-STRANGER") + modelSaw(h, "MARK-GROUP"), 0, "非 owner / 群聊零模型调用");

    assert.equal(h.api.sends.length, 2, "每条入站只发送一次");
    assert.deepEqual(h.api.sends.map((s) => [s.chat_id, s.text, s.reply_parameters?.message_id]), [
      ["42", "REPLY MARK-ONE", m1.message_id],
      ["42", "REPLY MARK-TWO", m2.message_id],
    ]);
    const rejected = (rt.store.db.prepare("SELECT body FROM events").all() as any[])
      .map((r) => JSON.parse(r.body)).filter((b) => b.type === "telegram.rejected").map((b) => b.reason).sort();
    assert.deepEqual(rejected, ["non_text", "not_owner", "not_private"]);
    assert.equal(rt.telegramStatus().online, true);

    // token 不进入模型请求、事件表、账本与 stderr；状态视图也不含
    const secret = "SECRET-TOKEN-XYZ";
    assert.ok(!JSON.stringify(h.reqs).includes(secret));
    assert.ok(!(rt.store.db.prepare("SELECT body FROM events").all() as any[]).some((r) => r.body.includes(secret)));
    assert.ok(!JSON.stringify(rt.sched.listOps({ limit: 50 })).includes(secret));
    assert.ok(!JSON.stringify(rt.telegramStatus()).includes(secret));
    assert.ok(!stderr.join("").includes(secret));
  } finally {
    await rt.stop("test_end");
    (process.stderr as any).write = origWrite;
    await h.close();
  }
});

test("发送明确失败与结果未知不重发；429 退回 pending 按 retry_after 再发一次", async () => {
  const h = await harness("tg-send");
  let limited = false;
  h.api.behavior = (body, n) => {
    if (body.text.includes("MARK-FAIL")) return { status: 400, body: { ok: false, description: "Bad Request: chat not found" } };
    if (body.text.includes("MARK-UNK")) return { status: 502, body: { ok: false } };
    if (body.text.includes("MARK-RL") && !limited) {
      limited = true;
      return { status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } } };
    }
    return { status: 200, body: { ok: true, result: { message_id: 2000 + n } } };
  };
  const rt = await Runtime.start(h.config);
  try {
    await configure(rt, h);
    h.api.push({ text: "MARK-FAIL" });
    h.api.push({ text: "MARK-UNK" });
    h.api.push({ text: "MARK-RL" });
    await waitFor("三条回复都有结果", () => {
      const ops = replyOps(rt);
      return ops.length === 3 && ops.every((o) => ["sent", "failed", "effect_unknown"].includes(o.status));
    });
    const byText = Object.fromEntries(replyOps(rt).map((o) => [o.text, o]));
    assert.equal(byText["REPLY MARK-FAIL"]!.status, "failed");
    assert.equal(byText["REPLY MARK-FAIL"]!.errorKind, "telegram_400");
    assert.equal(byText["REPLY MARK-UNK"]!.status, "effect_unknown");
    assert.equal(byText["REPLY MARK-RL"]!.status, "sent");
    assert.equal(byText["REPLY MARK-RL"]!.platformMessageId !== null, true);
    await new Promise((r) => setTimeout(r, 1_200));
    const count = (m: string) => h.api.sends.filter((s) => s.text.includes(m)).length;
    assert.deepEqual([count("MARK-FAIL"), count("MARK-UNK"), count("MARK-RL")], [1, 1, 2], "失败/未知不重发；限流只再发一次");
    const rl = h.api.sends.filter((s) => s.text.includes("MARK-RL"));
    assert.deepEqual(rl[0], rl[1], "限流重发的是同一操作的原目标与原正文");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("断线重连不丢消息；重启后重投不重复；重启补登回复按任务读取原回答", async () => {
  const h = await harness("tg-recover");
  let rt = await Runtime.start(h.config);
  try {
    await configure(rt, h);
    h.api.push({ text: "MARK-A" });
    await waitFor("A 已回复", () => replyOps(rt).some((o) => o.status === "sent"));

    // API 断开：轮询失败、状态离线；断开期间到达的消息在重连后处理
    h.api.offline = true;
    await waitFor("离线", () => rt.telegramStatus().online === false);
    h.api.push({ text: "MARK-B" });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(mainTasks(rt).length, 1);
    h.api.offline = false;
    await waitFor("B 已回复", () => replyOps(rt).filter((o) => o.status === "sent").length === 2);

    // 构造"A 任务已结束、结果与回复未落库"的崩溃窗口，且 main 之后已跑过 B
    const taskA = mainTasks(rt).find((t) => t.input.includes("MARK-A"))!;
    const opA = replyOps(rt).find((o) => o.taskId === taskA.id)!;
    await rt.stop("test_restart");
    const { Db } = await import("../src/core/db.ts");
    const db = new Db(h.config.dataDir);
    db.prepare("DELETE FROM notification_ops WHERE id = ?").run(opA.id);
    db.prepare("UPDATE tasks SET result_summary = NULL WHERE id = ?").run(taskA.id);
    // 偏移回退：平台重投全部 update（模拟登记后、推进偏移前崩溃）
    db.prepare("UPDATE telegram_config SET last_update_id = 0").run();
    db.close();

    const sendsBefore = h.api.sends.length;
    rt = await Runtime.start(h.config);
    await waitFor("A 的回复补发", () => h.api.sends.length === sendsBefore + 1);
    assert.equal(h.api.sends.at(-1).text, "REPLY MARK-A", "补登读取 A 任务自己的回答，不是会话最新一条");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mainTasks(rt).length, 2, "重投的 update 命中原外部 id，不重复建任务");
    assert.equal(h.api.sends.length, sendsBefore + 1, "B 不重复回复");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("配置校验：凭据用途/host/格式、api_base 协议；停用后未发送回复不改发", async () => {
  const h = await harness("tg-config");
  const rt = await Runtime.start(h.config);
  try {
    const host = new URL(h.apiBase).host;
    rt.addCredentialBinding({ name: "wrong", host, header: "none", purpose: "qq_onebot", secret: TOKEN });
    rt.addCredentialBinding({ name: "bad", host, header: "none", purpose: "telegram_bot", secret: "not-a-token" });
    rt.addCredentialBinding({ name: "other", host: "api.telegram.org", header: "none", purpose: "telegram_bot", secret: TOKEN });
    const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => e.code);
    assert.equal(await code(rt.telegramConfigure({ apiBase: h.apiBase, credential: "wrong", ownerUserId: "42" })), "invalid_params");
    assert.equal(await code(rt.telegramConfigure({ apiBase: h.apiBase, credential: "bad", ownerUserId: "42" })), "invalid_params");
    assert.equal(await code(rt.telegramConfigure({ apiBase: h.apiBase, credential: "other", ownerUserId: "42" })), "invalid_params");
    assert.equal(await code(rt.telegramConfigure({ apiBase: "http://example.com", credential: "other", ownerUserId: "42" })), "invalid_params");
    assert.equal(await code(rt.telegramSetEnabled(true)), "not_found");
    assert.equal(rt.telegramStatus().configured, false);

    await configure(rt, h);
    assert.equal(rt.credentials.get("tg")!.scope?.operations?.join(), "telegram_bot", "凭据 scope 收紧");
    // 重叠的配置变更串行执行：只留一个轮询循环（否则平台 409，且 stop 停不掉旧循环）
    await Promise.all([rt.telegramSetEnabled(false), rt.telegramSetEnabled(true), rt.telegramSetEnabled(true)]);
    const polls = () => h.api.paths.filter((p) => p.endsWith("/getUpdates")).length;
    const before = polls();
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(polls() - before <= 400 / 30 + 2, `只有一个循环在轮询（${polls() - before} 次）`);
    // 停用：已排队但未发送的回复因目标停用而取消，不改发
    h.api.behavior = () => ({ status: 429, body: { ok: false, parameters: { retry_after: 30 } } });
    h.api.push({ text: "MARK-HOLD" });
    await waitFor("回复被限流退回", () => replyOps(rt).some((o) => o.status === "pending" && o.notBefore !== null));
    await rt.telegramSetEnabled(false);
    assert.equal(await code(rt.telegramConfigure({ apiBase: h.apiBase, credential: "tg", ownerUserId: "42", expectedVersion: 1 })), "version_conflict");
    rt.store.db.prepare("UPDATE notification_ops SET not_before = NULL").run();
    await waitFor("回复取消", () => replyOps(rt).some((o) => o.status === "canceled"));
    assert.equal(h.api.sends.length, 1);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("schema v13 → v14：升级保留发送账本并新建 telegram_config 与 not_before 列", async () => {
  const { Db, SCHEMA_VERSION } = await import("../src/core/db.ts");
  const { dirs } = await makeTestDirs("tg-migrate", 0);
  try {
    let db = new Db(dirs.dataDir);
    db.exec(`INSERT INTO notification_ops (id, source_kind, source_key, target, text, text_sha256, status, created_at, updated_at)
      VALUES ('nop_keep', 'confirmation', 'k', '{}', 't', 'h', 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    db.exec("DROP TABLE telegram_config; ALTER TABLE notification_ops DROP COLUMN not_before; UPDATE meta SET value = '13' WHERE key = 'schema_version'");
    db.close();
    db = new Db(dirs.dataDir);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, String(SCHEMA_VERSION));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'telegram_config'").get());
    assert.equal((db.prepare("SELECT not_before FROM notification_ops WHERE id = 'nop_keep'").get() as any).not_before, null);
    db.close();
  } finally {
    await cleanupDirs(dirs);
  }
});
