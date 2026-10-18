import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SessionFailed } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalDelegationDoc, listPersonalDelegations } from "../apps/ruukoto/src/personal-delegation.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import { parsePersonalQq, qqToken, readPersonalQq, savePersonalQq, type PersonalQqConfig } from "../apps/ruukoto/src/personal-qq-config.ts";
import { personalQqApi } from "../apps/ruukoto/src/personal-qq-api.ts";
import { configurePersonalQq } from "../apps/ruukoto/src/personal-qq-cli.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { startMockOneBot, MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET } from "./helpers/mock-onebot.ts";

const context = BACKGROUND_CONTEXT;
const OWNER = "880001";
const UNIT = "qq-approval-test.service";
const TOKEN = `${MOCK_QQ_ACCOUNT}:telegram-test-secret`;
const key = (id: number, platform = "qq") => `${platform}:${MOCK_QQ_ACCOUNT}:${OWNER}:${id}`;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const event = (id: number, text = `消息 ${id}`, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ post_type: "message", message_type: "private", sub_type: "friend", self_id: Number(MOCK_QQ_ACCOUNT), user_id: Number(OWNER), message_id: id, time: 20, message: [{ type: "text", data: { text } }], ...extra });
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (!await check()) { assert.ok(Date.now() < deadline, "等待 QQ 收发超时"); await delay(10); }
}
async function settled(p: PersonalHarness, id: number, platform = "qq") {
  const value = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key(id, platform), context))!.receipt!;
  await p.harness.waitForTask(value.taskId, context);
  return (await p.harness.snapshot(PersonalTelegramReceiptDoc, value.requestId, context))!.receipt!;
}

async function fixture(t: TestContext, respond: Responder = () => ({ kind: "text", text: "固定回答" })) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-qq-")));
  const bot = await startMockOneBot({ imageUrl: "https://gchat.qpic.cn/test.png" });
  const telegramSends: Record<string, unknown>[] = [];
  const telegramServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    assert.equal(req.url, `/bot${TOKEN}/sendMessage`); telegramSends.push(body);
    res.end(JSON.stringify({ ok: true, result: { message_id: 900000 + telegramSends.length, chat: { id: Number(body.chat_id), type: "private" } } }));
  });
  telegramServer.listen(0, "127.0.0.1"); await once(telegramServer, "listening"); const address = telegramServer.address(); assert.ok(address && typeof address !== "string");
  const helper = path.join(root, "helper"); fs.mkdirSync(path.join(helper, "units"), { recursive: true }); fs.mkdirSync(path.join(helper, "ops"));
  const helperPath = path.join(helper, "helper.mjs"); fs.copyFileSync(new URL("./helpers/fake-service-helper.mjs", import.meta.url), helperPath);
  const policyPath = path.join(helper, "services.json"); fs.writeFileSync(policyPath, JSON.stringify({ machineId: "test-machine", inspectUid: 1, inspectGid: 1, services: { [UNIT]: { actions: ["restart"] } } }));
  fs.writeFileSync(path.join(helper, "units", UNIT), "[Service]\nExecStart=/usr/bin/true\n");
  fs.writeFileSync(path.join(helper, "state.json"), JSON.stringify({ [UNIT]: { loadState: "loaded", activeState: "active", subState: "running", mainPid: 123, invocationId: "before", result: "success", activeEnterTimestamp: "2026-10-17T00:00:00Z", starts: 0 } }));
  const model = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_QQ_MODEL_KEY", contextWindow: 128000, maxTokens: 8192, imageInput: false };
  const generation = randomUUID();
  const qq: PersonalQqConfig = { version: 1, enabled: true, generation, endpoint: bot.url, tokenEnv: "RUUKOTO_QQ_TEST_KEY", tokenDigest: createHash("sha256").update(MOCK_QQ_SECRET).digest("hex"), botId: MOCK_QQ_ACCOUNT, ownerId: OWNER, boundary: 10, boundaryMessageId: "0" };
  // 平台故意共用数字身份和代次，单靠账号或代次无法隔离菜单和授权。
  const telegram: PersonalTelegramConfig = { version: 1, enabled: true, generation, apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "RUUKOTO_QQ_TELEGRAM_KEY", tokenDigest: createHash("sha256").update(TOKEN).digest("hex"), botId: qq.botId, ownerId: qq.ownerId, boundary: 0 };
  const previous = new Map([config.apiKeyEnv, qq.tokenEnv, telegram.tokenEnv].map(name => [name, process.env[name]]));
  process.env[config.apiKeyEnv] = "model-test-only"; process.env[qq.tokenEnv] = MOCK_QQ_SECRET; process.env[telegram.tokenEnv] = TOKEN;
  const options = { directory: path.join(root, "profile"), provider: personalProvider(config), modelId: config.modelId, qq, telegram, service: { helperPath, policyPath, useSudo: false, sudoPath: "/usr/bin/sudo", timeouts: { inspectMs: 1000, restartMs: 2000, stopMs: 1000 } }, serviceOperations: true };
  let p: PersonalHarness | undefined, aborter: AbortController | undefined, loop: Promise<void> | undefined, id = 100;
  const stop = async () => { aborter?.abort(); try { await loop; } finally { loop = undefined; await p?.close(); p = undefined; } };
  t.after(async () => { await stop(); await bot.close(); telegramServer.closeAllConnections(); await new Promise<void>(resolve => telegramServer.close(() => resolve())); await model.close(); fs.rmSync(root, { recursive: true, force: true }); for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const open = async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => {
    p = await openPersonalHarness({ ...options, ...overrides });
    if ((overrides.qq ?? qq).enabled) {
      aborter = new AbortController(); loop = p.qq.poll(aborter.signal);
      await until(async () => { const status = await p!.qq.status(); return status.receiving && status.online; });
    }
    return p;
  };
  const receive = async (text: string, replyTo?: number, platform: "qq" | "telegram" = "qq") => {
    const messageId = ++id;
    if (platform === "qq") await p!.qq.receive(event(messageId, text, replyTo === undefined ? {} : { message: [{ type: "reply", data: { id: String(replyTo) } }, { type: "text", data: { text } }] }));
    else await p!.telegram.receive({ update_id: messageId, message: { message_id: messageId, chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER), is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: Number(qq.botId), is_bot: true } } }) } });
    return { key: key(messageId, platform), value: await settled(p!, messageId, platform) };
  };
  return { root, bot, model, config, qq, telegram, telegramSends, options, open, stop, receive,
    sends: () => bot.actions.filter(action => action.action === "send_private_msg"),
    starts: () => (JSON.parse(fs.readFileSync(path.join(helper, "state.json"), "utf8")) as Record<string, { starts: number }>)[UNIT].starts,
  };
}

test("QQ：双平台共用主会话，负消息号、乱序和重投只接纳一次", async t => {
  const f = await fixture(t, (_request, index) => ({ kind: "text", text: `回答 ${index + 1}` })); const p = await f.open();
  await p.qq.receive(event(-14, "QQ 记住共享内容")); const first = await settled(p, -14);
  await f.receive("Telegram 查阅共享内容", undefined, "telegram");
  assert.match(JSON.stringify(f.model.calls[1].messages), /QQ 记住共享内容/);
  await p.qq.receive(event(12, "乱序消息")); await settled(p, 12);
  await p.qq.receive(event(-14, "QQ 记住共享内容"));
  await assert.rejects(p.qq.receive(event(-14, "同键不同正文")), code("telegram_input_conflict"));
  assert.equal((await settled(p, -14)).submissionId, first.submissionId);
  assert.equal(first.platform, "qq"); assert.equal(first.delivery, "sent");
  assert.equal(f.model.calls.length, 3); assert.equal(f.sends().length, 2); assert.equal(f.telegramSends.length, 1);
  assert.ok(f.sends().every(action => String(action.params.user_id) === OWNER));
  assert.match(JSON.stringify(f.model.calls[2].messages), /Telegram 查阅共享内容/);
  assert.doesNotMatch(JSON.stringify((await p.main.entries({}, 256, undefined, context)).items), /qq-onebot-test-secret/);
});

test("QQ：群聊、临时会话、错账号、错拥有者、接管前及畸形事件不建任务", async t => {
  const f = await fixture(t); const p = await f.open();
  const rejected = [event(11, "群聊", { message_type: "group", sub_type: "normal", group_id: 42 }), event(12, "临时", { sub_type: "group" }), event(13, "错账号", { self_id: 789 }), event(14, "错拥有者", { user_id: 789 }), event(15, "接管前", { time: 9 }), event(16, "无稳定身份", { message_id: "-01" }), event(17, "裸字符串", { message: "裸字符串" })];
  for (const input of rejected) await p.qq.receive(input);
  assert.equal(f.model.calls.length, 0); assert.equal(f.sends().length, 0);
  for (let id = 11; id <= 17; id++) assert.equal((await p.harness.snapshot(PersonalTelegramReceiptDoc, key(id), context))?.receipt, undefined);
  f.bot.setAccount("789"); f.bot.pushHeartbeat();
  await until(async () => !(await p.qq.status()).online);
  f.bot.pushPrivateMessage({ userId: OWNER, messageId: 18, segments: [{ type: "text", data: { text: "错登录账号" } }] }); await delay(50);
  assert.equal(f.model.calls.length, 0); assert.equal(f.sends().length, 0);
});

test("QQ：回复已发送菜单才能改权限，同身份代次的 Telegram 菜单不混用", async t => {
  const f = await fixture(t); const p = await f.open();
  const qqMenu = await f.receive("/权限");
  const crossed = await f.receive("完全访问", Number(qqMenu.value.platformMessageId), "telegram");
  assert.match(crossed.value.reply!, /权限未改变/);
  assert.equal((await p.harness.snapshot(PersonalPermissionsDoc, context))!.mode, "auto-review");
  const telegramMenu = await f.receive("/权限", undefined, "telegram");
  const invalid = await f.receive("完全访问", Number(telegramMenu.value.platformMessageId)); assert.match(invalid.value.reply!, /权限未改变/);
  await f.receive("完全访问", Number(qqMenu.value.platformMessageId));
  assert.equal((await p.harness.snapshot(PersonalPermissionsDoc, context))!.qq!.mode, "full_access");
  assert.equal((await p.harness.snapshot(PersonalPermissionsDoc, context))!.mode, "auto-review");
  const qqInput = await f.receive("按 QQ 权限继续"); const telegramInput = await f.receive("按 Telegram 权限继续", undefined, "telegram");
  assert.equal(qqInput.value.permission!.mode, "full_access"); assert.equal(telegramInput.value.permission!.mode, "auto-review");
  assert.equal(f.model.calls.length, 2);
});

test("QQ：审批和长期授权固定原平台，同数字身份和代次也不能继承", async t => {
  const f = await fixture(t); const p = await f.open();
  const request = async (platform: "qq" | "telegram") => {
    const source = await f.receive("重启测试服务", undefined, platform);
    const ref = await p.service!.request({ requestId: randomUUID(), sourceRequestId: source.key, unit: UNIT });
    await until(async () => !!(await p.service!.status(ref)).operation.snapshot); return ref;
  };
  const original = await request("qq"); const originalMenu = await f.receive("/审批");
  assert.match((await f.receive("/审批", undefined, "telegram")).value.reply!, /暂无/);
  await f.receive("批准并长期授权", Number(originalMenu.value.platformMessageId), "telegram");
  assert.equal((await p.service!.status(original)).operation.decision, "pending"); assert.equal(f.starts(), 0);
  await assert.rejects(p.service!.decide(original, "approved"), code("service_original_entry_required"));
  await f.receive("批准并长期授权", Number(originalMenu.value.platformMessageId)); await p.harness.waitForTask(original.taskId, context); assert.equal(f.starts(), 1);
  assert.match((await f.receive("/授权", undefined, "telegram")).value.reply!, /没有/);
  const other = await request("telegram"); await delay(50);
  assert.equal((await p.service!.status(other)).operation.decision, "pending"); assert.equal(f.starts(), 1);
  const otherMenu = await f.receive("/审批", undefined, "telegram");
  await f.receive("批准本次", Number(otherMenu.value.platformMessageId), "telegram"); await p.harness.waitForTask(other.taskId, context);
  const repeated = await request("qq"); await p.harness.waitForTask(repeated.taskId, context); assert.equal(f.starts(), 3);
  assert.equal(f.model.calls.length, 3);
});

test("QQ：收件事务提交后丢答，重启按原消息补接且只回复一次", async t => {
  const f = await fixture(t), cause = new Error("qq-receipt-answer-lost");
  const p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = async (writes, ctx) => { const result = await commit(writes, ctx); if (writes.some(write => write.type === "document.create" && write.record.kind === PersonalTelegramReceiptDoc.definition.kind)) throw cause; return result; }; return storage;
  } });
  await assert.rejects(p.qq.receive(event(-11)), error => error === cause || error instanceof SessionFailed); await assert.rejects(f.stop(), error => error instanceof SessionFailed);
  const restored = await f.open(); assert.equal((await settled(restored, -11)).delivery, "sent");
  await restored.qq.receive(event(-11)); assert.equal(f.model.calls.length, 1); assert.equal(f.sends().length, 1);
});

test("QQ：发送丢答、异步和畸形成功均记未知，明确拒绝失败，重启不重发", async t => {
  for (const failure of ["lost", "internal_error", "async", "missing_id", "fail"] as const) await t.test(failure, async t => {
    const f = await fixture(t); f.bot.setSendBehavior(failure === "lost" ? "silent" : failure); let p = await f.open();
    await p.qq.receive(event(11));
    if (failure === "lost") { await until(() => f.sends().length === 1); f.bot.dropConnections(); }
    assert.equal((await settled(p, 11)).delivery, failure === "fail" ? "failed" : "effect_unknown");
    await f.stop(); f.bot.setSendBehavior("ok"); p = await f.open(); await p.qq.receive(event(11));
    assert.equal(f.sends().length, 1); assert.equal(f.model.calls.length, 1);
  });
});

test("QQ：断线期间生成的回复等原账号重连，只发送一次", async t => {
  let release!: () => void; const generated = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async () => { await generated; return { kind: "text", text: "断线期间生成的完整回答" }; }); const p = await f.open();
  await p.qq.receive(event(11)); await until(() => f.model.calls.length === 1);
  f.bot.setOnline(false); f.bot.dropConnections(); await until(async () => !(await p.qq.status()).online); release();
  await until(async () => (await p.harness.snapshot(PersonalTelegramReceiptDoc, key(11), context))!.receipt!.delivery === "pending");
  assert.equal(f.sends().length, 0); f.bot.setOnline(true);
  assert.equal((await settled(p, 11)).delivery, "sent");
  await p.qq.receive(event(11)); assert.equal(f.sends().length, 1); assert.equal(f.model.calls.length, 1);
});

test("QQ：待回复换代取消，旧消息不改发 Telegram，新主聊天继续", async t => {
  const f = await fixture(t, () => ({ kind: "text", text: "尚未完成".repeat(30), chunkDelayMs: 20 })); let p = await f.open();
  await p.qq.receive(event(11)); await until(() => f.model.calls.length === 1); await f.stop();
  p = await f.open({ qq: { ...f.qq, generation: randomUUID(), enabled: false } });
  assert.equal((await settled(p, 11)).delivery, "canceled");
  await assert.rejects(p.qq.receive(event(11)), code("telegram_target_changed")); assert.equal(f.sends().length, 0); assert.equal(f.telegramSends.length, 0);
  await f.receive("新 Telegram 主聊天继续", undefined, "telegram"); assert.equal(f.telegramSends.length, 1);
  assert.equal((await settled(p, 11)).generation, f.qq.generation);
});

test("QQ：图片不降为文本或执行 caption 控制，错拥有者和任意 URL 不下载", async t => {
  const f = await fixture(t); const p = await f.open(); let fetches = 0;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => { if (String(input).includes("qpic.cn") || String(input).includes("multimedia.nt.qq.com") || String(input).includes("attacker.invalid")) { fetches++; throw new Error("图片下载不应发生"); } return originalFetch(input, init); });
  const image = [{ type: "text", data: { text: "完全访问" } }, { type: "image", data: { file: "image-id", url: "https://gchat.qpic.cn/test.png" } }];
  await p.qq.receive(event(11, "", { user_id: 789, message: image })); assert.equal(fetches, 0);
  await p.qq.receive(event(12, "", { message: image })); const unsupported = await settled(p, 12);
  assert.equal(unsupported.submissionId, undefined); assert.equal(unsupported.control, undefined); assert.equal(unsupported.mediaRejected, true); assert.match(unsupported.reply!, /不支持图片/);
  await p.qq.receive(event(13, "", { message: [{ type: "image", data: { file: "bad-image", url: "https://attacker.invalid/private" } }] }));
  const invalid = await settled(p, 13); assert.equal(invalid.submissionId, undefined); assert.equal(invalid.mediaRejected, true);
  assert.equal(fetches, 0); assert.equal(f.model.calls.length, 0); assert.equal((await p.harness.snapshot(PersonalPermissionsDoc, context))!.qq?.mode ?? "auto-review", "auto-review");
});

test("QQ：后台分析不阻塞 Telegram，只有原 QQ 菜单可取消且控制零模型", async t => {
  let release!: () => void; const analyzing = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async request => { if (request.system?.includes("你是个人助手的子 Agent")) await analyzing; return { kind: "text", text: "收到" }; }); const p = await f.open();
  const source = await f.receive("QQ 独立分析");
  const work = await p.work.delegate({ requestId: "qq-blocked-analysis", sourceRequestId: source.key, content: "阻塞分析" });
  await until(() => f.model.calls.some(request => request.system?.includes("你是个人助手的子 Agent")));
  await f.receive("Telegram 聊天继续", undefined, "telegram");
  const menu = await f.receive("/工作"); const detail = await f.receive("分析1", Number(menu.value.platformMessageId)); const calls = f.model.calls.length;
  assert.match((await f.receive("/工作", undefined, "telegram")).value.reply!, /暂无/);
  await f.receive("取消这项分析", Number(detail.value.platformMessageId), "telegram"); assert.equal((await p.work.status(work)).cancelRequested, false);
  await f.receive("取消这项分析", Number(detail.value.platformMessageId));
  assert.equal((await p.harness.waitForTask(work.taskId, context)).state.outcome.status, "aborted");
  assert.equal(f.model.calls.length, calls);
});

test("QQ：后台最终报告固定原消息，Telegram 后续聊天不改变发送平台", async t => {
  let release!: () => void; const analyzing = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const report = "QQ 原入口的最终完整报告";
  const f = await fixture(t, async request => {
    if (request.system?.includes("你是个人助手的子 Agent")) { await analyzing; return { kind: "text", text: "完整分析结果" }; }
    const last = request.messages.at(-1), content = String(last?.content);
    if (content.startsWith("宿主委托汇总参考")) return { kind: "text", text: report };
    if (last?.role === "user" && content.startsWith("{")) { const action = JSON.parse(content) as Record<string, unknown>; return { kind: "tool_calls", calls: [{ id: `qq-${action.action}`, name: "background_work", arguments: action }] }; }
    return { kind: "text", text: "主聊天回答" };
  }); const p = await f.open();
  const original = await f.receive(JSON.stringify({ action: "delegate", content: "需要最终报告的分析" }));
  const ref = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  await f.receive(JSON.stringify({ action: "report", delegation: ref.entryId }));
  await f.receive("Telegram 后续聊天", undefined, "telegram"); release();
  const task = (await p.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!.taskId;
  await p.harness.waitForTask(task, context);
  const saved = (await p.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!;
  assert.equal(saved.delivery, "sent");
  const sends = f.sends().filter(send => JSON.stringify(send.params.message).includes(report)); assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].params.message, [{ type: "reply", data: { id: String(original.value.messageId) } }, { type: "text", data: { text: report } }]);
  assert.equal(String(sends[0].params.user_id), OWNER); assert.equal(f.telegramSends.filter(send => String(send.text).includes(report)).length, 0);
});

test("QQ：配对从真实好友消息选拥有者，凭据不落盘，边界同秒不接纳，停用换代且在线持锁拒绝", async t => {
  const f = await fixture(t), answers = ["1", f.qq.endpoint, f.qq.tokenEnv, "", "1"], platformTime = Math.floor(Date.now() / 1000) + 60; let output = "";
  await configurePersonalQq({ question: async prompt => {
    if (prompt.includes("直接发送")) {
      const phrase = prompt.match(/“([^”]+)”/)![1];
      f.bot.pushPrivateMessage({ userId: OWNER, messageId: -1, time: platformTime, segments: [{ type: "text", data: { text: phrase } }] }); await delay(30);
    }
    assert.ok(answers.length); return answers.shift()!;
  }, write: value => { output += value; } }, f.options.directory);
  const profile = lockPersonalProfile(f.options.directory), saved = readPersonalQq(profile)!; profile.release();
  assert.equal(saved.botId, MOCK_QQ_ACCOUNT); assert.equal(saved.ownerId, OWNER); assert.equal(saved.enabled, true); assert.match(output, /已配对/); assert.equal(saved.boundary, platformTime); assert.equal(saved.boundaryMessageId, "-1");
  const file = path.join(f.options.directory, "qq.json"); assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.doesNotMatch(fs.readFileSync(file, "utf8"), /qq-onebot-test-secret/);
  const p = await f.open({ qq: saved });
  await p.qq.receive(event(-1, "边界同秒", { time: saved.boundary })); assert.equal(f.model.calls.length, 0);
  await p.qq.receive(event(-10, "平台时钟快时的旧积压", { time: platformTime - 20 })); assert.equal(f.model.calls.length, 0);
  await p.qq.receive(event(-1, "配对消息重投改时间", { time: platformTime + 1 })); assert.equal(f.model.calls.length, 0);
  await p.qq.receive(event(-2, "边界后新消息", { time: saved.boundary + 1 })); assert.equal((await settled(p, -2)).delivery, "sent");
  assert.throws(() => savePersonalQq(f.options.directory, saved), code("profile_busy"));
  await assert.rejects(configurePersonalQq({ question: async () => "2", write: () => {} }, f.options.directory), code("profile_busy"));
  await f.stop(); await configurePersonalQq({ question: async () => "2", write: () => {} }, f.options.directory);
  const stopped = lockPersonalProfile(f.options.directory), disabled = readPersonalQq(stopped)!; stopped.release();
  assert.equal(disabled.enabled, false); assert.notEqual(disabled.generation, saved.generation);
});


test("QQ：file 图片经 get_image 下载进入原 submission，快照不存下载 URL 或字节", async t => {
  const f = await fixture(t), p = await f.open({ provider: personalProvider({ ...f.config, imageInput: true }) });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex");
  const previous = globalThis.fetch; let downloads = 0;
  globalThis.fetch = async (input, init) => String(input) === "https://gchat.qpic.cn/test.png" ? (downloads++, new Response(png, { headers: { "content-type": "image/png" } })) : previous(input, init);
  try {
    await p.qq.receive(event(11, "", { message: [{ type: "text", data: { text: "看图" } }, { type: "image", data: { file: "platform-file-id" } }] }));
    const image = await settled(p, 11); assert.equal(image.delivery, "sent"); assert.ok(image.submissionId); assert.equal(downloads, 1);
    assert.equal(f.bot.actions.filter(action => action.action === "get_image").length, 1);
    assert.match(JSON.stringify(f.model.calls[0].raw), new RegExp(png.toString("base64")));
    const entries = await p.harness.commit(tx => tx.scanEntries({ conversationId: p.main.id }, 256), context);
    const evidence = JSON.stringify(entries.items.filter(entry => entry.kind === "ruukoto.model-request"));
    assert.match(evidence, /ruukotoImage/); assert.doesNotMatch(evidence, new RegExp(png.toString("base64"))); assert.doesNotMatch(evidence, /gchat\.qpic\.cn/);
    const calls = f.model.calls.length;
    await p.qq.receive(event(11, "", { message: [{ type: "text", data: { text: "看图" } }, { type: "image", data: { file: "platform-file-id" } }] }));
    assert.equal(downloads, 1); assert.equal(f.model.calls.length, calls);
  } finally { globalThis.fetch = previous; }
});

test("QQ：连接缺口持久可查，不把断线当作已接纳或补拉承诺", async t => {
  const f = await fixture(t), p = await f.open();
  const first = await p.qq.status(); assert.ok(first.gap?.until);
  await assert.rejects(p.qq.poll(new AbortController().signal), code("qq_poll_busy")); assert.equal((await p.qq.status()).receiving, true);
  f.bot.dropConnections();
  await until(async () => { const state = await p.harness.snapshot(PersonalTelegramDoc, context); return !!state?.qqGap && state.qqGap.until === undefined; });
  await until(async () => (await p.qq.status()).online);
  await until(async () => !!(await p.qq.status()).gap?.until);
  const entries = await p.harness.commit(tx => tx.scanEntries({ conversationId: p.main.id }, 256), context);
  assert.ok(entries.items.filter(entry => entry.kind === "ruukoto.qq-connection").length >= 4);
});


test("QQ：重新配对新代次恢复默认自动审查，旧完全访问只留在原输入快照", async t => {
  const f = await fixture(t), p = await f.open();
  const menu = await f.receive("/权限"); await f.receive("完全访问", Number(menu.value.platformMessageId));
  const old = await f.receive("旧代次委托"); assert.equal(old.value.permission?.mode, "full_access");
  await f.stop(); const fresh = await f.open({ qq: { ...f.qq, generation: randomUUID() } });
  await fresh.qq.receive(event(-1, "新代次委托")); const current = await settled(fresh, -1);
  assert.equal(current.permission?.mode, "auto-review"); assert.ok(current.permission.version > old.value.permission!.version);
  assert.equal((await fresh.harness.snapshot(PersonalTelegramReceiptDoc, old.key, context))!.receipt!.permission!.mode, "full_access");
});


test("QQ：收件失败停止原连接，仍提交离线缺口回调", async t => {
  const f = await fixture(t), api = personalQqApi(f.qq, MOCK_QQ_SECRET), states: boolean[] = [], signal = new AbortController();
  const loop = api.poll(async () => { throw new PersonalError("receipt_test_failure", "测试收件失败"); }, signal.signal, async online => { states.push(online); });
  const failure = assert.rejects(loop, code("receipt_test_failure"));
  await until(() => api.online); f.bot.pushPrivateMessage({ userId: OWNER, messageId: 11, time: 20, segments: [{ type: "text", data: { text: "触发失败" } }] });
  await failure; assert.equal(api.online, false); assert.deepEqual(states, [false, true, false]);
});


test("QQ：配置拒绝不受保护的端点、自身绑定、非规范边界与变更凭据", async t => {
  const f = await fixture(t);
  for (const endpoint of ["ws://remote.example/", "https://remote.example/", "wss://user:secret@remote.example/", "ws://127.0.0.1/?token=secret"]) assert.throws(() => parsePersonalQq({ ...f.qq, endpoint }), code("qq_config_invalid"));
  for (const patch of [{ ownerId: f.qq.botId }, { boundaryMessageId: "01" }, { tokenEnv: "RUUKOTO_OWNER_TOKEN" }]) assert.throws(() => parsePersonalQq({ ...f.qq, ...patch }), code("qq_config_invalid"));
  assert.equal(qqToken(f.qq), MOCK_QQ_SECRET); process.env[f.qq.tokenEnv] = "changed-test-secret";
  assert.throws(() => qqToken(f.qq), code("qq_credentials_changed"));
});
