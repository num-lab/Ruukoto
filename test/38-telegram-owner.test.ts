import { product as personalProduct } from "./helpers/legacy-product.ts";
/** 旧 Telegram 档案去重、回复恢复与目标失效。 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { cleanupDirs, lastUserText, makeTestDirs, waitFor, writeModelsJson } from "./helpers/testkit.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";

const TOKEN = "123456:SECRET-TOKEN-XYZ";
const OWNER = 42;

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
  const api = new FakeBotApi({ token: TOKEN, ownerId: OWNER });
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
  await rt.addCredentialBinding({ name: "tg", host: new URL(h.apiBase).host, header: "none", purpose: "telegram_bot", secret: TOKEN });
  await rt.telegramConfigure({ apiBase: h.apiBase, credential: "tg", ownerUserId: String(OWNER) });
  await rt.telegramSetEnabled(true);
}

const mainTasks = (rt: Runtime) => rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId);
const replyOps = (rt: Runtime) => rt.sched.listOps({ limit: 50 }).items.filter((o) => o.sourceKind === "owner_reply");

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
    const { Db } = await import("@ruukoto/core/db.ts");
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
    await rt.addCredentialBinding({ name: "wrong", host, header: "none", purpose: "qq_onebot", secret: TOKEN });
    await rt.addCredentialBinding({ name: "bad", host, header: "none", purpose: "telegram_bot", secret: "not-a-token" });
    await rt.addCredentialBinding({ name: "other", host: "api.telegram.org", header: "none", purpose: "telegram_bot", secret: TOKEN });
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
