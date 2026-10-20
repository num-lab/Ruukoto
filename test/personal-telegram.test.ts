import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SessionFailed } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram.ts";
import { parsePersonalTelegram, readPersonalTelegram, savePersonalTelegram, telegramToken, type PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import { personalTelegramApi, telegramOffset, type TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { configurePersonalTelegram, personalChildEnv } from "../apps/ruukoto/src/personal-cli.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { personalControl, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const TOKEN = "123:telegram-test-secret";
const OWNER = "456";
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const update = (id: number, messageId = id, text = `消息 ${messageId}`, owner = OWNER): TelegramUpdate => ({ update_id: id, message: { message_id: messageId, chat: { id: Number(owner), type: "private" }, from: { id: Number(owner), is_bot: false, first_name: "测试拥有者" }, text } });
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (!await check()) { assert.ok(Date.now() < deadline, "等待 Telegram 收发超时"); await delay(10); }
}

class Bot {
  updates: TelegramUpdate[] = [];
  polls: Record<string, unknown>[] = [];
  sends: Record<string, unknown>[] = [];
  responses: string[] = [];
  private server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
    if (req.url === `/bot${TOKEN}/getMe`) { reply({ id: 123, is_bot: true, username: "test_bot" }); return; }
    if (req.url === `/bot${TOKEN}/getUpdates`) {
      this.polls.push(body);
      if (typeof body.offset === "number") this.updates = body.offset === -1 ? this.updates.slice(-1) : this.updates.filter(item => item.update_id >= Number(body.offset));
      await delay(20);
      if (!res.destroyed) reply(this.updates.slice(0, Number(body.limit)));
      return;
    }
    assert.equal(req.url, `/bot${TOKEN}/sendMessage`);
    this.sends.push(body);
    const response = this.responses.shift() ?? "ok";
    if (response === "lost") { res.destroy(); return; }
    if (response === "json") { res.end("broken"); return; }
    if (response === "proxy429") { res.writeHead(429).end("proxy failed"); return; }
    if (response === "wrong-target") { reply({ message_id: 1, chat: { id: 789, type: "private" } }); return; }
    if (response !== "ok") { const status = Number(response); res.writeHead(status).end(JSON.stringify({ ok: false, error_code: status, parameters: { retry_after: 1 } })); return; }
    reply({ message_id: 1000 + this.sends.length, chat: { id: Number(body.chat_id), type: "private" } });
  });
  async start() { this.server.listen(0, "127.0.0.1"); await once(this.server, "listening"); const address = this.server.address(); assert.ok(address && typeof address !== "string"); return `http://127.0.0.1:${address.port}`; }
  async close() { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}

async function fixture(t: TestContext, respond: Responder = () => ({ kind: "text", text: "固定回答" })) {
  const root = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-tg-"));
  const bot = new Bot(); const apiBase = await bot.start();
  const model = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_TG_MODEL_KEY", contextWindow: 128000, maxTokens: 8192 };
  const telegram: PersonalTelegramConfig = { version: 1, enabled: true, generation: randomUUID(), apiBase, tokenEnv: "RUUKOTO_TG_TEST_KEY", tokenDigest: createHash("sha256").update(TOKEN).digest("hex"), botId: "123", ownerId: OWNER, boundary: 10 };
  const oldModel = process.env[config.apiKeyEnv]; const oldToken = process.env[telegram.tokenEnv];
  process.env[config.apiKeyEnv] = "model-test-only"; process.env[telegram.tokenEnv] = TOKEN;
  const options = { directory: path.join(root, "profile"), provider: personalProvider(config), modelId: config.modelId, telegram };
  let personal: PersonalHarness | undefined;
  t.after(async () => {
    await personal?.close(); await bot.close(); await model.close();
    if (oldModel === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = oldModel;
    if (oldToken === undefined) delete process.env[telegram.tokenEnv]; else process.env[telegram.tokenEnv] = oldToken;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, bot, model, config, telegram, options,
    open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => personal = await openPersonalHarness({ ...options, ...overrides }),
  };
}

async function settled(p: PersonalHarness, id: number) {
  const value = (await p.harness.snapshot(PersonalTelegramReceiptDoc, `telegram:123:${OWNER}:${id}`, context))!.receipt!;
  await p.harness.waitForTask(value.taskId, context);
  return (await p.harness.snapshot(PersonalTelegramReceiptDoc, value.requestId, context))!.receipt!;
}

test("Telegram：绑定私聊、稳定消息去重与同键异参，回复严格归属自己的提交", async t => {
  const f = await fixture(t, (_call, index) => ({ kind: "text", text: `回答 ${index + 1}` })); const p = await f.open();
  await p.telegram.receive(update(11, 11, "来自另一人", "789"));
  const group = update(12); (group.message as { chat: { type: string } }).chat.type = "group"; await p.telegram.receive(group);
  await p.telegram.receive({ update_id: 13, message: { chat: { type: "private", id: 456 } } });
  assert.equal(f.model.calls.length, 0);
  await p.telegram.receive(update(14, 14, "第一条"));
  await p.telegram.receive(update(15, 15, "第二条"));
  await p.telegram.receive(update(16, 14, "第一条"));
  await assert.rejects(p.telegram.receive(update(17, 14, "伪装拥有者的新正文")), code("telegram_input_conflict"));
  assert.equal((await settled(p, 14)).delivery, "sent"); assert.equal((await settled(p, 15)).delivery, "sent");
  assert.equal(f.model.calls.length, 2);
  assert.deepEqual(f.bot.sends.map(body => [body.text, body.reply_parameters]), [["回答 1", { message_id: 14, allow_sending_without_reply: true }], ["回答 2", { message_id: 15, allow_sending_without_reply: true }]]);
  assert.ok(f.bot.sends.every(body => body.chat_id === OWNER));
  assert.equal((await p.telegram.status()).rejected, 3);
  assert.doesNotMatch(JSON.stringify((await p.main.entries({}, 256, undefined, context)).items), /telegram-test-secret/);
});

test("Telegram：一次性短期确认，空批/重启/一周空闲后的较小 update_id 不漏收", async t => {
  assert.equal(telegramOffset({ offset: 900, receivedAt: 100 }, 60099), 900);
  assert.equal(telegramOffset({ offset: 900, receivedAt: 100 }, 60100), undefined);
  assert.equal(telegramOffset({ offset: 900, receivedAt: 100 }, 7 * 86400 * 1000), undefined);
  const f = await fixture(t); let p = await f.open(); const aborter = new AbortController(); t.after(() => aborter.abort());
  f.bot.updates = Array.from({ length: 17 }, (_, index) => update(900 + index, 20 + index)); const loop = p.telegram.poll(aborter.signal);
  await until(() => f.bot.polls.some(poll => poll.offset === 916));
  assert.equal(f.bot.polls[0].limit, 16);
  await until(() => f.bot.polls.slice(2).some(poll => !("offset" in poll)));
  f.bot.updates = [update(0, 37)];
  await until(() => f.bot.sends.length === 18);
  aborter.abort(); await loop; await p.close();
  const before = f.bot.polls.length;
  // 模拟确认应答丢失：平台在重启后重投同一消息，结果不再发送。
  f.bot.updates = [update(6, 37)]; p = await f.open(); const second = new AbortController(); t.after(() => second.abort()); const resumed = p.telegram.poll(second.signal);
  await until(() => f.bot.polls.length > before + 1); second.abort(); await resumed;
  assert.equal("offset" in f.bot.polls[before], false);
  assert.equal(f.model.calls.length, 18); assert.equal(f.bot.sends.length, 18);
});

test("Telegram：断线/5xx/畸形成功/错误目标/代理429都记未知且重启不重发", async t => {
  for (const failure of ["lost", "500", "json", "wrong-target", "proxy429"]) await t.test(failure, async t => {
    const f = await fixture(t); f.bot.responses = [failure]; let p = await f.open(); await p.telegram.receive(update(11));
    assert.equal((await settled(p, 11)).delivery, "effect_unknown"); await p.close(); p = await f.open(); await p.telegram.receive(update(12, 11));
    assert.equal((await settled(p, 11)).delivery, "effect_unknown"); assert.equal(f.bot.sends.length, 1);
  });
});

test("Telegram：明确429持久延后原发送，明确403失败不重试", async t => {
  const f = await fixture(t); f.bot.responses = ["429", "ok", "403"]; const p = await f.open();
  await p.telegram.receive(update(11)); assert.equal((await settled(p, 11)).delivery, "sent");
  assert.deepEqual(f.bot.sends[0], f.bot.sends[1]);
  await p.telegram.receive(update(12)); assert.equal((await settled(p, 12)).delivery, "failed"); assert.equal(f.bot.sends.length, 3);
});

test("Telegram：超长回答单条截断且不破坏 Unicode，完整回答留在会话", async t => {
  const f = await fixture(t, () => ({ kind: "text", text: "😀".repeat(4100) })); const p = await f.open();
  await p.telegram.receive(update(11)); const value = await settled(p, 11);
  assert.ok(Array.from(value.reply!).length <= 4096); assert.match(value.reply!, /显示已截断/);
  assert.ok(f.model.calls.length === 1 && JSON.stringify((await p.main.entries({}, 32, undefined, context)).items).includes("😀".repeat(4100)));
  assert.equal(f.bot.sends.length, 1);
});

test("Telegram：unanswered 中断片段不外发；换代未发送回复取消，普通主聊天继续", async t => {
  for (const action of ["abort", "rebind"] as const) await t.test(action, async t => {
    const f = await fixture(t, () => ({ kind: "text", text: "尚未完成".repeat(30), chunkDelayMs: 20 })); let p = await f.open();
    await p.telegram.receive(update(11)); await until(() => f.model.calls.length === 1);
    if (action === "abort") await p.main.abort(context);
    else { await p.close(); p = await f.open({ telegram: { ...f.telegram, generation: randomUUID(), enabled: false } }); }
    assert.equal((await settled(p, 11)).delivery, action === "abort" ? "unanswered" : "canceled");
    assert.equal(f.bot.sends.length, 0);
    await p.answer("本机独立聊天继续", "local-independent");
  });
});

test("Telegram：收件事务已经提交而 admission 未执行就故障，重开原键补接一次", async t => {
  const f = await fixture(t); const cause = new Error("receipt-commit-answer-lost");
  const p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
    storage.commit = async (writes, context) => {
      const seq = await commit(writes, context);
      if (writes.some(write => write.type === "document.create" && write.record.kind === PersonalTelegramReceiptDoc.definition.kind)) throw cause;
      return seq;
    };
    return storage;
  } });
  await assert.rejects(p.telegram.receive(update(11)), error => error === cause || error instanceof SessionFailed); await p.close();
  const restored = await f.open(); assert.equal((await settled(restored, 11)).delivery, "sent");
  assert.equal(f.model.calls.length, 1); assert.equal(f.bot.sends.length, 1);
});

test("Telegram：发送已生效但结果未提交时真实强杀，重开转未知且零重复", { timeout: 20000 }, async t => {
  const f = await fixture(t); const p = await f.open(); await p.close();
  const marker = path.join(f.root, "send-result-blocked");
  const script = `import * as fs from "node:fs"; import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node"; const {directory,telegram,config,marker,update}=JSON.parse(process.env.RUUKOTO_TG_CRASH); const p=await openPersonalHarness({directory,telegram,provider:personalProvider(config),modelId:config.modelId,openStorage:async filename=>{const s=await openNodeSqliteStorage(filename);const commit=s.commit.bind(s);s.commit=(writes,c)=>{if(JSON.stringify(writes).includes('"sent"')){fs.writeFileSync(marker,"blocked");return new Promise(()=>{});}return commit(writes,c);};return s;}});await p.telegram.receive(update);setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_TG_CRASH: JSON.stringify({ directory: f.options.directory, telegram: f.telegram, config: f.config, marker, update: update(11) }) }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.pipe(process.stderr); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await until(() => fs.existsSync(marker)); assert.equal(f.bot.sends.length, 1);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const restored = await f.open(); assert.equal((await settled(restored, 11)).delivery, "effect_unknown");
  await restored.telegram.receive(update(12, 11)); assert.equal(f.bot.sends.length, 1);
});

test("Telegram：配置、收件、Task 与版本断链拒绝恢复", async t => {
  for (const kind of ["config", "binding", "receipt", "task", "version", "missing", "same-generation"] as const) await t.test(kind, async t => {
    const f = await fixture(t); const p = await f.open(); await p.telegram.receive(update(11)); await settled(p, 11);
    if (kind === "config") await p.harness.commit(tx => tx.retireDoc(PersonalTelegramDoc), context);
    if (kind === "binding") await p.harness.commit(async tx => { delete (await tx.doc(PersonalTelegramDoc)).config; }, context);
    if (kind === "receipt") await p.harness.commit(tx => tx.retireDoc(PersonalTelegramReceiptDoc, "telegram:123:456:11"), context);
    if (kind === "task") await p.harness.commit(async tx => { (await tx.doc(PersonalTelegramReceiptDoc, "telegram:123:456:11", null)).receipt!.requestId = "wrong-key"; }, context);
    await p.close();
    if (kind === "version") {
      const storage = await openNodeSqliteStorage(path.join(f.options.directory, "personal.sqlite"));
      const record = await storage.findDocument({ kind: PersonalTelegramReceiptDoc.definition.kind, scope: { kind: "session" }, key: "telegram:123:456:11" }, "current", context); const saved = await storage.document(record!.id, "current", context);
      await storage.commit([{ type: "document.change", id: record!.id, content: { kind: "base", version: 2, value: saved!.value } }], context); await storage.close(context);
    }
    await assert.rejects(f.open(kind === "missing" ? { telegram: undefined } : kind === "same-generation" ? { telegram: { ...f.telegram, ownerId: "789" } } : {}), code(kind === "config" || kind === "version" ? "telegram_version" : kind === "missing" ? "telegram_config_missing" : kind === "same-generation" ? "telegram_config_changed" : "telegram_receipt_invalid"));
    assert.equal(f.bot.sends.length, 1);
  });
});

test("Telegram：向导从真实配对消息选择身份，确认接管边界，离线文件无凭据", async t => {
  const f = await fixture(t); const answers = ["1", f.telegram.apiBase, f.telegram.tokenEnv, "2", "", "1"];
  f.bot.updates = [update(1), update(2)]; let output = "";
  await configurePersonalTelegram({ question: async prompt => {
    if (prompt.includes("私聊发送")) { const phrase = prompt.match(/“([^”]+)”/)![1]; f.bot.updates.push(update(3, 3, phrase)); }
    assert.ok(answers.length); return answers.shift()!;
  }, write: text => { output += text; } }, f.options.directory);
  const profile = lockPersonalProfile(f.options.directory); const saved = readPersonalTelegram(profile)!; profile.release();
  assert.equal(saved.ownerId, OWNER); assert.equal(saved.botId, "123"); assert.equal(saved.boundary, 3); assert.equal(saved.enabled, true);
  assert.equal(f.bot.polls[0].offset, -1); assert.equal(f.bot.polls.at(-1)!.offset, 4); assert.equal(f.bot.updates.length, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(f.options.directory, "telegram.json"), "utf8"), /telegram-test-secret/);
  assert.match(output, /已配对/); assert.equal(fs.statSync(path.join(f.options.directory, "telegram.json")).mode & 0o777, 0o600);
  const env = personalChildEnv(f.options.directory, [f.config.apiKeyEnv, f.telegram.tokenEnv], { RUUKOTO_DATA_DIR: "old", [f.config.apiKeyEnv]: "model", [f.telegram.tokenEnv]: TOKEN });
  assert.equal(env[f.telegram.tokenEnv], TOKEN); assert.equal(env.RUUKOTO_DATA_DIR, undefined);
  const lock = lockPersonalProfile(f.options.directory);
  assert.throws(() => savePersonalTelegram(f.options.directory, saved), code("profile_busy")); lock.release();
  assert.throws(() => parsePersonalTelegram({ ...saved, tokenEnv: "RUUKOTO_OWNER_TOKEN" }), code("telegram_config_invalid"));
  process.env[saved.tokenEnv] = "123:changed-token"; assert.throws(() => telegramToken(saved), code("telegram_credentials_changed"));
});

test("Telegram：真实本机后台装配轮询，停止收齐后释放档案锁", async t => {
  const f = await fixture(t); await savePersonalConfig(f.options.directory, f.config); savePersonalTelegram(f.options.directory, f.telegram);
  const server = await startPersonalServer(f.options.directory); t.after(() => server.stop());
  f.bot.updates.push(update(11)); await until(() => f.bot.sends.length === 1);
  const state = await personalControl<{ enabled: boolean; recent: { delivery: string }[] }>(f.options.directory, "GET", "/telegram"); assert.equal(state.enabled, true); assert.equal(state.recent[0].delivery, "sent");
  await server.stop(); lockPersonalProfile(f.options.directory).release();
  const count = f.bot.polls.length; await delay(60); assert.equal(f.bot.polls.length, count);
});

test("Telegram：配对身份选择过期，不发送旧确认水位或保存绑定", async t => {
  const f = await fixture(t); let clock = 0; t.mock.method(performance, "now", () => clock);
  const answers = ["1", f.telegram.apiBase, f.telegram.tokenEnv, "2", "", "1"];
  await assert.rejects(configurePersonalTelegram({ question: async prompt => {
    if (prompt.includes("私聊发送")) f.bot.updates.push(update(11, 11, prompt.match(/“([^”]+)”/)![1]));
    if (answers.length === 1) clock = 60_000;
    assert.ok(answers.length); return answers.shift()!;
  }, write: () => {} }, f.options.directory), code("telegram_pairing_expired"));
  assert.equal(fs.existsSync(path.join(f.options.directory, "telegram.json")), false);
  assert.equal(f.bot.polls.length, 2);
});
