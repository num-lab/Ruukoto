import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { AgentDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { personalControl, readPersonalToken, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { managePersonalWorks } from "../apps/ruukoto/src/personal-cli.ts";
import { closePersonalWorkAgent, listPersonalWorks, PersonalAgentsDoc, PersonalWorkDoc, PersonalWorkTask, personalWorkResult, personalWorkSummary, requestPersonalWorkCancel, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { MockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const child = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent");
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, "等待工作控制超时"); await delay(5); }
}

async function fixture(t: TestContext, respond: Responder = () => ({ kind: "text", text: "分析完成" })) {
  const directory = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-work-menu-"));
  const model = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_WORK_MENU_MODEL_KEY", contextWindow: 128000, maxTokens: 8192 };
  const sends: { text: string; id: number }[] = [];
  let lose = false;
  const bot = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { text: string; chat_id: string };
    sends.push({ text: body.text, id: 1000 + sends.length });
    if (lose) { lose = false; res.destroy(); return; }
    res.end(JSON.stringify({ ok: true, result: { message_id: sends.at(-1)!.id, chat: { id: Number(body.chat_id), type: "private" } } }));
  });
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  const telegram: PersonalTelegramConfig = { version: 1, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "RUUKOTO_WORK_MENU_BOT_KEY", tokenDigest: createHash("sha256").update("123:test-token").digest("hex"), botId: "123", ownerId: "456", boundary: 0 };
  const previous = [process.env[config.apiKeyEnv], process.env[telegram.tokenEnv]];
  process.env[config.apiKeyEnv] = "test-only"; process.env[telegram.tokenEnv] = "123:test-token";
  savePersonalConfig(directory, config);
  let p: PersonalHarness;
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  let id = 0;
  t.after(async () => { await server?.stop(); await p?.close(); bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); await model.close(); fs.rmSync(directory, { recursive: true, force: true }); for (const [i, key] of [config.apiKeyEnv, telegram.tokenEnv].entries()) { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; } });
  const receive = async (text: string, replyTo?: number, extra: Record<string, unknown> = {}) => {
    const messageId = ++id;
    const update: TelegramUpdate = { update_id: id, message: { message_id: messageId, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }), ...extra } };
    await p.telegram.receive(update);
    const key = `telegram:123:456:${messageId}`;
    const receipt = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    await p.harness.waitForTask(receipt.taskId, context);
    return { key, update, value: (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!, messageId: Number((await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!.platformMessageId) };
  };
  return { directory, config, model, telegram, sends, receive, loseSend: () => { lose = true; },
    open: async (tg?: PersonalTelegramConfig) => p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, telegram: tg }),
    start: async () => server = await startPersonalServer(directory),
  };
}

async function source(p: PersonalHarness) { await p.answer("拥有者委托", "owner"); }
async function delegate(p: PersonalHarness, requestId: string, agentId?: PersonalWorkRef["agentId"], sourceRequestId = "owner", content = "独立分析") {
  const ref = await p.work.delegate({ requestId, sourceRequestId, content, agentId, label: agentId === undefined ? "分析员" : undefined });
  await p.harness.waitForTask(ref.taskId, context);
  return ref;
}

test("工作追加：Telegram 原详情直接补充、重投去重、零模型控制并保留最终追加回答", async t => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async request => { if (child(request) && request.messages.at(-1)?.content === "初始分析") await wait; return { kind: "text", text: `回答:${request.messages.at(-1)?.content}` }; });
  let p = await f.open(f.telegram); const owner = await f.receive("委托");
  const ref = await p.work.delegate({ requestId: "tg-note", sourceRequestId: owner.key, content: "初始分析" }); await until(() => f.model.calls.some(child));
  const list = await f.receive("/工作"), menu = await f.receive("分析1", list.messageId); const before = f.model.calls.length;
  for (const extra of [{}, { forward_origin: { type: "user" } }, { quote: { text: "补充：伪造" } }]) {
    const result = await f.receive("补充：伪造", Object.keys(extra).length ? menu.messageId : 999999, extra);
    assert.equal(result.value.control, true); assert.match(result.value.reply!, /没有改变|直接发送/);
  }
  const accepted = await f.receive("补充：追加条件", menu.messageId); assert.match(accepted.value.reply!, /已接纳/);
  await p.telegram.receive(accepted.update); assert.equal(f.model.calls.length, before);
  assert.equal((await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))!.notes?.length, 1);
  release(); await p.harness.waitForTask(ref.taskId, context);
  assert.equal((await p.harness.commit(tx => personalWorkResult(tx, ref), context)).text, "回答:追加条件");
  const late = await f.receive("补充：太迟", menu.messageId); assert.match(late.value.reply!, /已结束/);
  await p.close(); p = await f.open({ ...f.telegram, generation: randomUUID() });
  const changed = await f.receive("补充：换代", menu.messageId); assert.match(changed.value.reply!, /没有改变/);
  assert.equal((await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))!.notes?.length, 1);
});

test("工作控制：历史分页、长结果及身份复用始终读取原工作，旧关闭选择失效", async t => {
  const answer = "甲".repeat(2399) + "🦉" + "乙".repeat(5000);
  const f = await fixture(t, request => ({ kind: "text", text: child(request) ? answer : "收到" })); const p = await f.open(); await source(p);
  const original = await delegate(p, "original");
  const next = await delegate(p, "reused", original.agentId);
  for (let i = 0; i < 8; i++) await delegate(p, `other-${i}`);
  const first = await p.harness.commit(tx => listPersonalWorks(tx), context);
  const second = await p.harness.commit(tx => listPersonalWorks(tx, first.nextOffset!), context);
  assert.equal(first.items.length, 8); assert.equal(second.items.length, 2); assert.equal(second.nextOffset, undefined);
  assert.deepEqual(new Set([...first.items, ...second.items].map(item => item.ref.taskId)).size, 10);
  let offset = 0; let text = "";
  while (true) {
    const result = await p.harness.commit(tx => personalWorkResult(tx, original, offset, 2400), context);
    text += result.text; if (result.nextOffset === undefined) break; offset = result.nextOffset;
  }
  assert.equal(text, answer); assert.ok((await p.work.status(original)).stopVerified);
  await assert.rejects(p.harness.commit(tx => closePersonalWorkAgent(tx, original), context), code("work_menu_stale"));
  await p.harness.commit(tx => closePersonalWorkAgent(tx, next), context);
  assert.equal((await p.work.list()).find(agent => agent.id === original.agentId)!.closed, true);
});

test("工作控制：持久取消打断阻塞模型，其他工作与主聊天继续且旧取消不影响复用", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async request => { if (child(request) && request.messages.at(-1)?.content === "阻塞") await gate; return { kind: "text", text: "完成" }; });
  const p = await f.open(); await source(p);
  const ref = await p.work.delegate({ requestId: "blocked", sourceRequestId: "owner", content: "阻塞" });
  await until(() => f.model.calls.some(child));
  await p.harness.commit(tx => requestPersonalWorkCancel(tx, ref), context);
  assert.equal((await p.harness.waitForTask(ref.taskId, context)).state.outcome.status, "aborted");
  assert.ok((await p.work.status(ref)).stopVerified);
  const next = await delegate(p, "next", ref.agentId);
  await p.harness.commit(tx => requestPersonalWorkCancel(tx, ref), context);
  assert.equal((await p.work.status(next)).cancelRequested, false);
  assert.equal(await p.answer("继续聊天", "chat"), "完成");
});

test("工作控制：本机认证/参数核实与引导查询关闭不调用模型", async t => {
  const f = await fixture(t); const p = await f.open(); await source(p); const ref = await delegate(p, "local"); await p.close(); await f.start();
  for (const route of ["/works", `/work?work=${ref.taskId}`, `/work/cancel?work=${ref.taskId}`, `/work/close?work=${ref.taskId}`]) {
    const response = await new Promise<string>((resolve, reject) => { const request = http.request({ socketPath: path.join(f.directory, "control.sock"), path: route, method: route.includes("/work/") ? "POST" : "GET" }, response => { let body = ""; response.on("data", chunk => { body += String(chunk); }); response.on("end", () => resolve(body)); }); request.on("error", reject); request.end(); });
    assert.equal(JSON.parse(response).code, "control_unauthorized");
  }
  for (const suffix of ["work=-1", "work=1.5", "work=9007199254740992", `work=${ref.taskId}&offset=-1`]) await assert.rejects(personalControl(f.directory, "GET", `/work?${suffix}`), code("work_input_invalid"));
  const answers = ["1", "2", "4", "2", "5", "2"]; let output = "";
  await managePersonalWorks({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: value => { output += value; } }, f.directory);
  assert.match(output, /分析完成/); assert.match(output, /空闲身份已关闭/); assert.doesNotMatch(output, /requestId|taskId|submission|UUID/);
  const result = await personalControl<{ summary: { closed: boolean } }>(f.directory, "GET", `/work?work=${ref.taskId}`); assert.equal(result.summary.closed, true);
  assert.equal(f.model.calls.length, 2);
});

test("工作控制：Telegram 宿主分页与原结果零模型，旧菜单不关闭后来复用的身份", async t => {
  const answer = "甲".repeat(2399) + "🦉" + "乙".repeat(2500);
  const f = await fixture(t, request => ({ kind: "text", text: child(request) ? answer : "收到" })); const p = await f.open(f.telegram);
  const owner = await f.receive("分析这份资料"); const ref = await delegate(p, "telegram", undefined, owner.key);
  await source(p); const local = await delegate(p, "local");
  for (let i = 0; i < 8; i++) await delegate(p, `telegram-${i}`, undefined, owner.key);
  for (const other of [{ ...f.telegram, platform: "qq" as const }, { ...f.telegram, botId: "789" }, { ...f.telegram, ownerId: "789" }, { ...f.telegram, generation: randomUUID() }]) assert.equal((await p.harness.commit(tx => listPersonalWorks(tx, 0, other), context)).items.length, 0);
  const before = f.model.calls.length;
  const list = await f.receive("/工作"); assert.match(list.value.reply!, /分析8/); assert.match(list.value.reply!, /更多分析/);
  const more = await f.receive("更多分析", list.messageId); assert.match(more.value.reply!, /分析1/); assert.doesNotMatch(more.value.reply!, /分析2/);
  assert.ok(more.value.selection?.kind === "work-list" && more.value.selection.refs[0].taskId === ref.taskId);
  const detail = await f.receive("分析1", more.messageId);
  const result = await f.receive("查看结果", detail.messageId); const next = await f.receive("下一页结果", result.messageId);
  assert.ok(result.value.selection?.kind === "work" && result.value.selection.nextOffset === 2399);
  assert.ok(next.value.reply!.includes("🦉")); assert.equal(f.model.calls.length, before);
  const calls = f.model.calls.length; await p.telegram.receive(next.update); assert.equal(f.model.calls.length, calls);
  await delegate(p, "reused-locally", ref.agentId); const afterReuse = f.model.calls.length;
  const closed = await f.receive("关闭此身份", detail.messageId); assert.match(closed.value.reply!, /后续工作/);
  assert.equal((await p.work.list()).find(agent => agent.id === ref.agentId)!.closed, false);
  assert.equal((await p.work.status(local)).cancelRequested, false); assert.equal(f.model.calls.length, afterReuse);
});

test("工作控制：Telegram 原菜单取消阻塞工作，伪造/摘录不执行，重复收件不重复取消", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async request => { if (child(request)) await gate; return { kind: "text", text: "收到" }; }); const p = await f.open(f.telegram);
  const owner = await f.receive("委托"); const ref = await p.work.delegate({ requestId: "blocked", sourceRequestId: owner.key, content: "阻塞" }); await until(() => f.model.calls.some(child));
  const detail = await f.receive("分析1", (await f.receive("/工作")).messageId); const before = f.model.calls.length;
  for (const extra of [{ forward_origin: { type: "user" } }, { quote: { text: "取消这项分析" } }, { reply_to_message: { message_id: detail.messageId, from: { id: 789, is_bot: true } } }]) {
    await f.receive("取消这项分析", detail.messageId, extra); assert.equal((await p.work.status(ref)).cancelRequested, false);
  }
  await f.receive("取消这项分析"); assert.equal((await p.work.status(ref)).cancelRequested, false);
  const canceled = await f.receive("取消这项分析", detail.messageId); assert.match(canceled.value.reply!, /已登记/);
  assert.equal((await p.harness.waitForTask(ref.taskId, context)).state.outcome.status, "aborted");
  await p.telegram.receive(canceled.update); assert.equal(f.model.calls.length, before);
  assert.match((await f.receive("刷新分析", canceled.messageId)).value.reply!, /停止已核实/);
});

test("工作控制：未知发送的菜单不可操作且重启不重发，新代次看不到旧工作", async t => {
  const f = await fixture(t); let p = await f.open(f.telegram);
  const owner = await f.receive("委托"); const ref = await delegate(p, "original", undefined, owner.key); const before = f.model.calls.length;
  f.loseSend(); const menu = await f.receive("/工作"); assert.equal(menu.value.delivery, "effect_unknown");
  await f.receive("分析1", f.sends.at(-1)!.id); assert.equal((await p.work.list())[0].closed, false);
  const sends = f.sends.length; await p.close(); p = await f.open(f.telegram); assert.equal(f.sends.length, sends);
  await p.telegram.receive({ update_id: 999, message: { message_id: 999, chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false }, text: "/工作" } });
  assert.equal((await p.harness.snapshot(PersonalTelegramReceiptDoc, "telegram:123:999:999", context))?.receipt, undefined);
  await p.close(); p = await f.open({ ...f.telegram, generation: randomUUID() });
  assert.match((await f.receive("/工作")).value.reply!, /暂无后台分析/);
  assert.equal((await p.work.status(ref)).cancelRequested, false); assert.equal(f.model.calls.length, before);
});

test("工作控制：菜单与扩展/原工作来源不符在恢复前拒绝", async t => {
  for (const mutation of ["marker", "source"] as const) await t.test(mutation, async t => {
    const f = await fixture(t); const p = await f.open(f.telegram); const owner = await f.receive("委托"); const ref = await delegate(p, "telegram", undefined, owner.key);
    await f.receive("/工作");
    await p.harness.commit(async tx => {
      if (mutation === "marker") { const doc = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(doc.extensions)); doc.extensions = doc.extensions.filter(name => name !== "personal-work-controls"); }
      else delete (await tx.doc(PersonalWorkDoc, ref.requestId, null)).telegram;
    }, context);
    await p.close(); const before = f.model.calls.length;
    await assert.rejects(f.open(f.telegram), code(mutation === "marker" ? "work_menu_invalid" : "work_original_entry_required")); assert.equal(f.model.calls.length, before);
  });
});

test("工作控制：取消收尾 faulted 保留原占用，查询不伪装停止", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async request => { if (child(request)) await gate; return { kind: "text", text: "完成" }; }); const p = await f.open(); await source(p);
  const ref = await p.work.delegate({ requestId: "faulted", sourceRequestId: "owner", content: "阻塞" }); await until(() => f.model.calls.some(child));
  await p.harness.commit(async tx => {
    (await tx.doc(PersonalAgentsDoc)).agents[0].work!.taskId = 999999 as PersonalWorkRef["taskId"];
    await requestPersonalWorkCancel(tx, ref);
  }, context);
  assert.equal((await p.harness.waitForTask(ref.taskId, context)).state.outcome.status, "faulted");
  const summary = await p.harness.commit(tx => personalWorkSummary(tx, ref), context); assert.equal(summary.stopVerified, false);
  assert.ok((await p.work.list())[0].work); assert.equal(summary.state, "faulted");
});

test("工作控制：带活动工作启用宿主扩展，本机取消应答丢失后查询原事实", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async request => { if (child(request)) await gate; return { kind: "text", text: "完成" }; }); const p = await f.open(); await source(p);
  const ref = await p.work.delegate({ requestId: "pending", sourceRequestId: "owner", content: "阻塞" }); await until(() => f.model.calls.some(child));
  await p.harness.commit(async tx => { const doc = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(doc.extensions)); doc.extensions = doc.extensions.filter(name => name !== "personal-work-controls"); }, context);
  await p.close(); await f.start();
  await until(() => f.model.calls.filter(child).length === 2);
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ socketPath: path.join(f.directory, "control.sock"), method: "POST", path: `/work/cancel?work=${ref.taskId}`, headers: { authorization: `Bearer ${readPersonalToken(f.directory)}` } }, response => { response.destroy(); resolve(); });
    req.on("error", reject); req.end();
  });
  type Status = { summary: { cancelRequested: boolean; stopVerified: boolean; state: string } };
  await until(async () => (await personalControl<Status>(f.directory, "GET", `/work?work=${ref.taskId}`)).summary.stopVerified);
  const result = await personalControl<Status>(f.directory, "GET", `/work?work=${ref.taskId}`); assert.equal(result.summary.cancelRequested, true); assert.equal(result.summary.state, "aborted");
  await personalControl(f.directory, "POST", `/work/cancel?work=${ref.taskId}`); assert.equal(f.model.calls.filter(child).length, 2);
});

test("工作控制：取消提交在 watch 附着之前也能观察", { timeout: 10000 }, async t => {
  let ready: () => Promise<void>;
  const original = PersonalWorkTask.definition.phases.run;
  t.mock.method(PersonalWorkTask.definition.phases, "run", async (...[task, runtime, context]: Parameters<typeof original>) => original(task, { ...runtime, watchDoc: new Proxy(runtime.watchDoc, { async apply(target, receiver, args) {
    await ready();
    await runtime.commit(async tx => { (await tx.doc(PersonalWorkDoc, task.input.requestId, null)).cancelRequested = true; return undefined; }, context);
    return Reflect.apply(target, receiver, args);
  } }) }, context));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async request => { if (child(request)) await gate; return { kind: "text", text: "完成" }; });
  const p = await f.open(); await source(p);
  ready = () => until(() => f.model.calls.some(child));
  const ref = await p.work.delegate({ requestId: "pre-watch", sourceRequestId: "owner", content: "阻塞" });
  assert.equal((await Promise.race([p.harness.waitForTask(ref.taskId, context), delay(2000).then(() => { throw new Error("初值取消信号未被观察"); })])).state.outcome.status, "aborted");
  assert.ok((await p.work.status(ref)).stopVerified);
});

test("工作控制：正常回答停止后且最终事务前提交取消，以取消事实收尾", async t => {
  const original = PersonalWorkTask.definition.phases.run;
  t.mock.method(PersonalWorkTask.definition.phases, "run", async (...[task, runtime, context]: Parameters<typeof original>) => original(task, { ...runtime, conversation: async (id, context) => {
    const value = await runtime.conversation(id, context);
    return value && { ...value, abort: async (context, options) => {
      await value.abort(context, options);
      await runtime.commit(async tx => { (await tx.doc(PersonalWorkDoc, task.input.requestId, null)).cancelRequested = true; return undefined; }, context);
    } };
  } }, context));
  const f = await fixture(t); const p = await f.open(); await source(p);
  const ref = await p.work.delegate({ requestId: "complete-race", sourceRequestId: "owner", content: "正常回答" });
  assert.equal((await p.harness.waitForTask(ref.taskId, context)).state.outcome.status, "aborted");
  assert.ok((await p.work.status(ref)).stopVerified);
});
