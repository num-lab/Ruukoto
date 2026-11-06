import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type Task } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc, type TelegramReceipt } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalTelegramDisplayDoc, PersonalTelegramDisplaysDoc, type PersonalTelegramDisplay } from "../apps/ruukoto/src/personal-telegram-display-records.ts";
import { PersonalTelegramCallbackDoc, verifyPersonalTelegramCallbacks, type PersonalTelegramCallbackOutcome } from "../apps/ruukoto/src/personal-telegram-callbacks.ts";
import { personalImDeliveryRecord } from "../apps/ruukoto/src/personal-im-delivery.ts";
import { personalTelegramApprovalAction } from "../apps/ruukoto/src/personal-telegram.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { PersonalMockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function until(check: () => boolean | Promise<boolean>) { const deadline = Date.now() + 12000; while (!await check()) { assert.ok(Date.now() < deadline, "Telegram interaction did not settle"); await delay(5); } }
async function fixture(t: TestContext, response?: Responder) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-tg-interaction-")), workspace = path.join(root, "workspace"), target = path.join(root, "protected.txt"); fs.mkdirSync(workspace); fs.writeFileSync(target, "original");
  const token = "123:interaction-test-only", tokenEnv = "TG_INTERACTION_BOT_KEY", modelEnv = "TG_INTERACTION_MODEL_KEY", previous = [process.env[tokenEnv], process.env[modelEnv]];
  process.env[tokenEnv] = token; process.env[modelEnv] = "test-only"; isolateSkillHome(t);
  const sends: { messageId: number; text: string; markup?: unknown }[] = [], typing: unknown[] = [], acknowledgements: unknown[] = [], edits: unknown[] = [];
  let nextPlatformId = 1000, loseAck = false, loseEdit = false, loseTextAt: number | undefined;
  const bot = http.createServer(async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    const send = (result: unknown) => reply.end(JSON.stringify({ ok: true, result }));
    if (request.url?.endsWith("/getMe")) { send({ id: 123, is_bot: true, username: "interaction_bot" }); return; }
    if (request.url?.endsWith("/sendChatAction")) { typing.push(body); send(true); return; }
    if (request.url?.endsWith("/answerCallbackQuery")) { acknowledgements.push(body); if (loseAck) { loseAck = false; reply.destroy(); return; } send(true); return; }
    if (request.url?.endsWith("/editMessageText")) { edits.push(body); if (loseEdit) { loseEdit = false; reply.destroy(); return; } send({ message_id: body.message_id, chat: { id: Number(body.chat_id), type: "private" } }); return; }
    assert.ok(request.url?.endsWith("/sendMessage"));
    const messageId = ++nextPlatformId; sends.push({ messageId, text: String(body.text), ...(body.reply_markup ? { markup: body.reply_markup } : {}) });
    if (sends.length === loseTextAt) { reply.destroy(); return; }
    send({ message_id: messageId, chat: { id: Number(body.chat_id), type: "private" } });
  });
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  const model = new PersonalMockModelServer(response ?? (request => {
    const last = request.messages.at(-1);
    if (request.system?.includes("你是个人助手的子 Agent")) return last?.role === "user" ? { kind: "tool_calls", calls: [{ id: "write", name: "write_file", arguments: { path: target, content: "owner-approved" } }] } : { kind: "text", text: "已写入。" };
    if (last?.role === "user" && String(last.content).includes("start work")) return { kind: "tool_calls", calls: [{ id: "delegate", name: "background_work", arguments: { action: "delegate", content: `Write exactly owner-approved into ${target}. Do not read other files.` } }] };
    return { kind: "text", text: "普通聊天回答。" };
  }));
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: modelEnv, contextWindow: 128000, maxTokens: 8192 };
  const telegram = { version: 1 as const, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv, tokenDigest: hash(token), botId: "123", ownerId: "456", boundary: 0 };
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: randomUUID(), workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  let p: PersonalHarness | undefined, nextInput = 10;
  const open = async () => p = await openPersonalHarness({ directory: path.join(root, "profile"), provider: personalProvider(config), modelId: config.modelId, telegram, tools });
  const raw = (text: string, replyTo?: number, extra: Record<string, unknown> = {}): TelegramUpdate => { const id = ++nextInput; return { update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }), ...extra } }; };
  const receive = async (text: string, replyTo?: number, extra?: Record<string, unknown>): Promise<{ update: TelegramUpdate; receipt: TelegramReceipt }> => {
    const update = raw(text, replyTo, extra); await p!.telegram.receive(update); const key = `telegram:123:456:${nextInput}`, value = (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    await p!.harness.waitForTask(value.taskId, context); return { update, receipt: (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt! };
  };
  const displays = () => p!.harness.commit(async tx => { const result: PersonalTelegramDisplay[] = []; for (const key of (await tx.doc(PersonalTelegramDisplaysDoc)).keys) { const value = (await tx.doc(PersonalTelegramDisplayDoc, key, null)).display!; result.push(JSON.parse(JSON.stringify(value)) as PersonalTelegramDisplay); } return result; }, context);
  const card = async () => { let found: PersonalTelegramDisplay | undefined; await until(async () => { found = (await displays()).find(display => display.buttons.some(button => button.action === "工具批准本次")); if (!found) return false; return p!.harness.commit(async tx => (await personalImDeliveryRecord(tx, found!.delivery)).parts.at(-1)?.state === "sent", context); }); return found!; };
  const callback = async (display: PersonalTelegramDisplay, action: string, extra: Record<string, unknown> = {}) => {
    const button = display.buttons.find(button => button.action === action)!; assert.ok(button);
    const messageId = await p!.harness.commit(async tx => Number((await personalImDeliveryRecord(tx, display.delivery)).parts.at(-1)!.platformMessageId), context), id = randomUUID();
    const update: TelegramUpdate = { update_id: ++nextInput, callback_query: { id, from: { id: 456, is_bot: false }, data: button.token, message: { message_id: messageId, date: 1, from: { id: 123, is_bot: true }, chat: { id: 456, type: "private" } }, ...extra } };
    await p!.telegram.receive(update); const key = `telegram-callback:123:${id}`;
    await until(async () => (await p!.harness.snapshot(PersonalTelegramCallbackDoc, key, context))?.ack?.state !== "pending" && (await p!.harness.snapshot(PersonalTelegramCallbackDoc, key, context))?.ack?.state !== "sending");
    const receipt = (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))?.receipt; if (receipt) await p!.harness.waitForTask(receipt.taskId, context);
    return { update, key, receipt: (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))?.receipt };
  };
  t.after(async () => { await p?.close(); bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); await model.close(); for (const [index, key] of [tokenEnv, modelEnv].entries()) if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; fs.rmSync(root, { recursive: true, force: true }); });
  return { open, receive, raw, displays, card, callback, model, sends, typing, acknowledgements, edits, target, telegram, get personal() { return p!; }, loseAck: () => { loseAck = true; }, loseEdit: () => { loseEdit = true; }, loseText: (offset: number) => { loseTextAt = sends.length + offset; } };
}

test("Exact direct-reply approval words map only one-shot approval kinds", () => {
  const menu = { kind: "tool" as const, operation: 1 as import("@earendil-works/pi-durable").TaskId };
  for (const word of ["好", "好的", "可以", "行", "同意", "确认", "ok", "OK"]) assert.equal(personalTelegramApprovalAction(menu, ` \n${word}\t `), "工具批准本次");
  for (const word of ["不", "不要", "不行", "先别", "拒绝", "算了", "取消"]) assert.equal(personalTelegramApprovalAction(menu, word), "工具拒绝");
  for (const word of ["嗯", "是", "Ok", "ok!", "可以。", "确认一下", "1."]) assert.equal(personalTelegramApprovalAction(menu, word), undefined);
  assert.equal(personalTelegramApprovalAction({ kind: "question-list", ids: [] }, "好的"), undefined);
});

test("Proactive approval cards accept one exact reply and preserve raw input on duplicate/reopen", async t => {
  const f = await fixture(t), p = await f.open(); await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "confirm"; }, context);
  await f.receive("start work"); const card = await f.card(), messageId = await p.harness.commit(async tx => Number((await personalImDeliveryRecord(tx, card.delivery)).parts.at(-1)!.platformMessageId), context);
  assert.equal(fs.readFileSync(f.target, "utf8"), "original");
  const prose = await f.receive("可以。", messageId); assert.equal(prose.receipt.control, undefined); assert.equal(prose.receipt.rawContent, undefined);
  const forwarded = await f.receive("好的", messageId, { forward_origin: { type: "user" } }); assert.equal(forwarded.receipt.toolDecision, undefined);
  const decision = await f.receive(" \n好的\t ", messageId); assert.equal(decision.receipt.content, "工具批准本次"); assert.equal(decision.receipt.rawContent, " \n好的\t "); assert.ok(decision.receipt.toolDecision);
  await p.telegram.receive(decision.update); await until(() => fs.readFileSync(f.target, "utf8") === "owner-approved");
  const stale = await f.receive("OK", messageId); assert.equal(stale.receipt.toolDecision, undefined);
  await until(() => f.edits.length > 0); const count = f.sends.length; await p.close(); const reopened = await f.open(); await reopened.telegram.receive(decision.update); assert.equal(f.sends.length, count);
  assert.equal(await reopened.harness.commit(async tx => (await toolOperations(tx)).filter(operation => operation.started).length, context), 1);
});

test("Callback decisions survive ack/edit loss; duplicate and invalid-context callbacks cannot reapprove", async t => {
  const f = await fixture(t), p = await f.open(); await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "confirm"; }, context);
  await f.receive("start work"); const card = await f.card();
  const wrong = await f.callback(card, "工具批准本次", { message: { message_id: 99999, date: 1, from: { id: 123, is_bot: true }, chat: { id: 456, type: "private" } } }); assert.equal(wrong.receipt, undefined);
  const inaccessible = await f.callback(card, "工具批准本次", { message: { message_id: 99999, date: 0, chat: { id: 456, type: "private" } } }); assert.equal(inaccessible.receipt, undefined);
  const beforeCalls = f.model.calls.length; f.loseAck(); f.loseEdit(); const decision = await f.callback(card, "工具拒绝"); assert.ok(decision.receipt?.toolDecision); assert.equal(decision.receipt.toolDecision.decision, "rejected");
  await until(() => f.edits.length > 0); assert.equal(fs.readFileSync(f.target, "utf8"), "original");
  await p.telegram.receive({ ...decision.update, callback_query: { ...(decision.update.callback_query as Record<string, unknown>), message: { ...((decision.update.callback_query as { message: Record<string, unknown> }).message), text: "Terminal edited text", reply_markup: { inline_keyboard: [] } } } }); const stale = await f.callback(card, "工具批准本次"); assert.equal(stale.receipt?.toolDecision, undefined);
  const state = (await p.harness.snapshot(PersonalTelegramCallbackDoc, decision.key, context))!.ack!; assert.equal(state.state, "effect_unknown");
  await p.close(); const reopened = await f.open(); await reopened.telegram.receive(wrong.update); await reopened.telegram.receive(inaccessible.update); await reopened.telegram.receive(decision.update);
  assert.equal((await reopened.harness.snapshot(PersonalTelegramDoc, context))!.rejected, 2); assert.equal(f.acknowledgements.length, 4); assert.ok(f.model.calls.length >= beforeCalls);
  assert.equal(await reopened.harness.commit(async tx => (await toolOperations(tx)).filter(operation => operation.started).length, context), 0);
});

test("Redisplayed cards share one canonical decision and original-message authority", async t => {
  const f = await fixture(t), p = await f.open(); await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "confirm"; }, context);
  await f.receive("start work"); const original = await f.card(), id = await p.harness.commit(async tx => Number((await personalImDeliveryRecord(tx, original.delivery)).parts.at(-1)!.platformMessageId), context);
  const shown = await f.receive("重新显示", id); assert.equal(shown.receipt.selection, undefined); assert.deepEqual(shown.receipt.redisplay, { display: original.key });
  const fresh = (await f.displays()).find(display => display.key === shown.receipt.display)!; assert.ok(fresh); assert.deepEqual(fresh.target, original.target); assert.notEqual(fresh.buttons[0].token, original.buttons[0].token);
  const accepted = await f.callback(fresh, "工具批准本次"); assert.ok(accepted.receipt?.toolDecision); await until(() => fs.readFileSync(f.target, "utf8") === "owner-approved");
  const stale = await f.callback(original, "工具批准本次"); assert.equal(stale.receipt?.toolDecision, undefined);
  await p.close(); await f.open(); assert.equal(await f.personal.harness.commit(async tx => (await toolOperations(tx)).filter(operation => operation.started).length, context), 1);
});

test("Middle-part uncertainty stops later sends and explicit original retrieval neither reruns nor rewrites it", async t => {
  const text = " \n" + "🦉𠮷e\u0301".repeat(2000) + "\r\nEnd\n ", f = await fixture(t, () => ({ kind: "text", text })), p = await f.open(); f.loseText(2);
  const source = await f.receive("long answer"); assert.equal(source.receipt.delivery, "effect_unknown"); assert.equal(f.sends.length, 2); assert.equal(f.model.calls.length, 1);
  const original = await p.harness.commit(async tx => JSON.parse(JSON.stringify(await personalImDeliveryRecord(tx, source.receipt.multipart!))) as Awaited<ReturnType<typeof personalImDeliveryRecord>>, context); assert.equal(original.parts[2].state, "canceled");
  const list = await f.receive("/结果"), selected = await f.receive("1", Number(list.receipt.platformMessageId)), calls = f.model.calls.length;
  const retrieved = await f.receive("全部原文", Number(selected.receipt.platformMessageId)); assert.equal(retrieved.receipt.delivery, "sent"); assert.equal(retrieved.receipt.reply, text); assert.equal(f.model.calls.length, calls);
  const reread = await p.harness.commit(async tx => JSON.parse(JSON.stringify(await personalImDeliveryRecord(tx, source.receipt.multipart!))) as Awaited<ReturnType<typeof personalImDeliveryRecord>>, context); assert.equal(reread.parts[1].state, "effect_unknown"); assert.equal(reread.parts[2].state, "canceled");
  assert.equal(f.sends.slice(4).map(send => send.text).join(""), text);
  await p.close(); await f.open(); assert.equal(f.model.calls.length, 1);
});

test("Saved result paging reaches older originals and keeps nonmatching card replies ordinary", async t => {
  const f = await fixture(t, (_request, index) => ({ kind: "text", text: `Saved answer ${index}` })); await f.open();
  for (let index = 0; index < 10; index++) await f.receive(`message ${index}`);
  const first = await f.receive("/结果"), second = await f.receive("更多结果", Number(first.receipt.platformMessageId)); assert.equal(second.receipt.selection?.kind, "result-list");
  if (second.receipt.selection?.kind === "result-list") { assert.equal(second.receipt.selection.offset, 8); assert.equal(second.receipt.selection.refs.length, 2); }
  const prose = await f.receive("是", Number(second.receipt.platformMessageId)); assert.equal(prose.receipt.control, undefined);
  const selected = await f.receive("2", Number(second.receipt.platformMessageId)), before = f.model.calls.length, reread = await f.receive("原文 1", Number(selected.receipt.platformMessageId)); assert.equal(reread.receipt.reply, "Saved answer 0"); assert.equal(f.model.calls.length, before);
  await f.personal.close(); await f.open();
});

test("Typing is advisory and stops with closed source while held work keeps original input", async t => {
  let release!: () => void, started = false; const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async () => { started = true; await held; return { kind: "text", text: "Completed original" }; }), p = await f.open();
  const update = f.raw("held"); await p.telegram.receive(update); await until(() => started && f.typing.length > 0); assert.equal(f.sends.length, 0);
  release(); const receipt = (await p.harness.snapshot(PersonalTelegramReceiptDoc, "telegram:123:456:11", context))!.receipt!; await p.harness.waitForTask(receipt.taskId, context);
  await p.close(); const count = f.typing.length; await delay(20); assert.equal(f.typing.length, count);
});

test("A faulted callback observation preserves its committed business refusal through production reopen", { timeout: 30000 }, async t => {
  const f = await fixture(t), open = Harness.open;
  t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
    const task = args[1].registry.snapshot().task("ruukoto.telegram-callback-ack") as Task<{ key: string }, { phase: "send" } | { phase: "verify" }, PersonalTelegramCallbackOutcome, object>, send = task.definition.phases.send;
    t.mock.method(task.definition.phases, "send", async (...[current, runtime, callContext]: Parameters<typeof send>) => { let commits = 0; return send(current, { ...runtime, async commit(...parameters) { if (++commits === 2) throw new Error("Injected callback observation commit failure"); return runtime.commit(...parameters); } }, callContext); });
    return open(...args);
  });
  const p = await f.open(); await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "confirm"; }, context);
  await f.receive("start work"); const card = await f.card(), button = card.buttons.find(button => button.action === "工具拒绝")!; assert.ok(button);
  const messageId = await p.harness.commit(async tx => Number((await personalImDeliveryRecord(tx, card.delivery)).parts.at(-1)!.platformMessageId), context), queryId = randomUUID(), key = `telegram-callback:123:${queryId}`;
  const update: TelegramUpdate = { update_id: 1000, callback_query: { id: queryId, from: { id: 456, is_bot: false }, data: button.token, message: { message_id: messageId, date: 1, from: { id: 123, is_bot: true }, chat: { id: 456, type: "private" } } } };
  await p.telegram.receive(update); const ack = (await p.harness.snapshot(PersonalTelegramCallbackDoc, key, context))!.ack!, settled = await p.harness.waitForTask(ack.ref.taskId, context);
  assert.equal(settled.state.outcome.status, "faulted"); const before = (await p.harness.snapshot(PersonalTelegramCallbackDoc, key, context))!.ack!; assert.equal(before.state, "sending"); assert.ok(before.claim); assert.equal(before.observation, undefined); assert.equal(f.acknowledgements.length, 1);
  const receipt = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!; await p.harness.waitForTask(receipt.taskId, context); assert.equal(receipt.toolDecision?.decision, "rejected"); assert.ok(receipt.accepted);
  const decision = await p.harness.commit(async tx => { const value = (await toolOperations(tx)).find(value => value.operation === receipt.toolDecision!.operation)!; assert.equal(value.approval, "rejected"); assert.equal(value.started, false); assert.equal(value.actor, key); return { entry: value.decisionEntry!, data: (await tx.entry(value.decisionEntry!))!.data }; }, context);
  assert.deepEqual(decision.data, { operation: receipt.toolDecision!.operation, decision: "rejected", actor: key }); assert.equal(fs.readFileSync(f.target, "utf8"), "original");
  await p.harness.commit(tx => verifyPersonalTelegramCallbacks(tx), context); const recovered = (await p.harness.snapshot(PersonalTelegramCallbackDoc, key, context))!.ack!;
  assert.equal(recovered.state, "effect_unknown"); assert.equal(recovered.code, "telegram_callback_ack_interrupted"); assert.ok(recovered.observation! > before.claim!); assert.deepEqual((await p.harness.getTask(ack.ref.taskId, context))!.state, settled.state);
  await p.close(); const reopened = await f.open(); await reopened.telegram.receive(update);
  assert.equal(f.acknowledgements.length, 1); assert.deepEqual((await reopened.harness.snapshot(PersonalTelegramCallbackDoc, key, context))!.ack, recovered);
  await reopened.harness.commit(async tx => { const value = (await toolOperations(tx)).find(value => value.operation === receipt.toolDecision!.operation)!; assert.equal(value.decisionEntry, decision.entry); assert.deepEqual((await tx.entry(decision.entry))!.data, decision.data); assert.equal(value.started, false); }, context);
});
