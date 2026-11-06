import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type Task } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { personalImDeliveryRecord, requestPersonalImDelivery, type PersonalImDeliveryRef, type PersonalImDeliveryResult } from "../apps/ruukoto/src/personal-im-delivery.ts";
import { PersonalTelegramReceiptDoc, type TelegramReceipt } from "../apps/ruukoto/src/personal-telegram-records.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
const originalText = " \n" + "🦉𠮷e\u0301".repeat(1500) + "\r\nEnd\n ";
const invalidOwner = (error: unknown) => error instanceof PersonalError && ["im_retrieval_invalid", "telegram_receipt_invalid", "im_delivery_invalid"].includes(error.code);
type DeliveryTask = Task<{ key: string }, { phase: "send"; index: number; retryAt?: number } | { phase: "verify"; index: number }, PersonalImDeliveryResult, object>;

async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-telegram-retrieval-")), directory = path.join(root, "profile");
  const token = "123:retrieval-test-only", tokenEnv = "TG_RETRIEVAL_BOT_KEY", modelEnv = "TG_RETRIEVAL_MODEL_KEY", previous = [process.env[tokenEnv], process.env[modelEnv]];
  process.env[tokenEnv] = token; process.env[modelEnv] = "test-only";
  const sends: string[] = [];
  let platformId = 1000, inputId = 10, p: PersonalHarness | undefined;
  const bot = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { chat_id: string; message_id?: number; text: string };
    const reply = (result: unknown) => response.end(JSON.stringify({ ok: true, result }));
    if (request.url?.endsWith("/getMe")) { reply({ id: 123, is_bot: true, username: "retrieval_bot" }); return; }
    if (request.url?.endsWith("/sendChatAction") || request.url?.endsWith("/answerCallbackQuery")) { reply(true); return; }
    if (request.url?.endsWith("/editMessageText")) { reply({ message_id: body.message_id, chat: { id: Number(body.chat_id), type: "private" } }); return; }
    assert.ok(request.url?.endsWith("/sendMessage")); sends.push(body.text);
    reply({ message_id: ++platformId, chat: { id: Number(body.chat_id), type: "private" } });
  });
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  const model = new PersonalMockModelServer(() => ({ kind: "text", text: originalText }));
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: modelEnv, contextWindow: 128000, maxTokens: 8192 };
  const source = { botId: "123", ownerId: "456", generation: randomUUID() };
  const telegram = { version: 1 as const, enabled: true, ...source, apiBase: `http://127.0.0.1:${address.port}`, tokenEnv, tokenDigest: createHash("sha256").update(token).digest("hex"), boundary: 0 };
  let gate: { prefix: string; entered: boolean; ready: Promise<void>; enter: () => void; pending: Promise<void>; release: () => void } | undefined;
  const openHarness = Harness.open;
  t.mock.method(Harness, "open", async (...args: Parameters<typeof openHarness>) => {
    const task = args[1].registry.snapshot().task("ruukoto.im-delivery") as DeliveryTask, send = task.definition.phases.send;
    // Hold only the scheduling boundary; the production sender and authorizer remain installed.
    t.mock.method(task.definition.phases, "send", async (...[current, runtime, callContext]: Parameters<typeof send>) => {
      if (gate && !gate.entered && current.input.key.startsWith(gate.prefix)) { const held = gate; held.entered = true; held.enter(); await held.pending; }
      return send(current, runtime, callContext);
    });
    return openHarness(...args);
  });
  const open = async () => p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, telegram });
  const snapshot = async (key: string) => (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))?.receipt;
  const record = (ref: PersonalImDeliveryRef) => p!.harness.commit(async tx => copyJson(await personalImDeliveryRecord(tx, ref)) as Awaited<ReturnType<typeof personalImDeliveryRecord>>, context);
  const admit = async (text: string, replyTo?: number) => {
    const id = ++inputId, key = `telegram:123:456:${id}`;
    const update: TelegramUpdate = { update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }) } };
    await p!.telegram.receive(update); const receipt = await snapshot(key); assert.ok(receipt); return { update, receipt };
  };
  const receive = async (text: string, replyTo?: number) => { const value = await admit(text, replyTo); await p!.harness.waitForTask(value.receipt.taskId, context); return { ...value, receipt: (await snapshot(value.receipt.requestId))! }; };
  const original = async () => { const value = await receive("Original long answer"), saved = await record(value.receipt.multipart!); assert.equal(value.receipt.reply, originalText); assert.ok(saved.parts.length > 1); assert.ok(saved.parts.every(part => part.state === "sent")); assert.equal(saved.parent, value.receipt.taskId); return { ...value, saved }; };
  const select = async (value: TelegramReceipt) => { const list = await receive("/结果"), menu = list.receipt.selection; assert.equal(menu?.kind, "result-list"); if (menu?.kind !== "result-list") assert.fail("Original result list is missing"); assert.deepEqual(menu.refs, [value.multipart]); const selected = await receive("1", Number(list.receipt.platformMessageId)); assert.deepEqual(selected.receipt.selection, { kind: "result", ref: value.multipart }); return selected; };
  const hold = (prefix: string) => {
    let enter!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
    gate = { prefix, entered: false, ready, enter, pending, release }; return { ready, release };
  };
  t.after(async () => { gate?.release(); await p?.close(); bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); await model.close(); for (const [index, key] of [tokenEnv, modelEnv].entries()) if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; fs.rmSync(root, { recursive: true, force: true }); });
  isolateSkillHome(t);
  return { open, receive, admit, snapshot, original, select, record, hold, sends, model, source };
}

test("Typed original-result retrieval preserves exact text and its immutable source through duplicate and reopen", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(), original = await f.original(), selected = await f.select(original.receipt), sent = f.sends.length;
  const read = await f.receive("全部原文", Number(selected.receipt.platformMessageId)), retrieval = await f.record(read.receipt.multipart!);
  assert.equal(read.receipt.control, true); assert.ok(read.receipt.accepted); assert.equal(read.receipt.delivery, "sent");
  assert.equal(retrieval.parent, undefined); assert.equal(retrieval.input.key, `telegram-retrieval:${read.receipt.requestId}`);
  assert.equal(retrieval.input.text, originalText); assert.deepEqual(retrieval.input.retrieval?.delivery, original.receipt.multipart);
  assert.equal(f.sends.slice(sent).join(""), originalText); assert.deepEqual(await f.record(original.receipt.multipart!), original.saved);
  assert.equal(f.model.calls.length, 1);
  const count = f.sends.length; await p.close(); const reopened = await f.open(); await reopened.telegram.receive(read.update);
  assert.equal(f.sends.length, count); assert.equal(f.model.calls.length, 1); assert.deepEqual(await f.record(original.receipt.multipart!), original.saved);
});

test("Typed retrieval rejects a missing or foreign accepted origin and missing owner receipt before dispatch and reopen", { timeout: 30000 }, async t => {
  for (const mutation of ["accepted", "foreign", "receipt"] as const) await t.test(mutation, async t => {
    const f = await fixture(t), p = await f.open(), original = await f.original(), selected = await f.select(original.receipt), held = f.hold("telegram-retrieval:");
    const read = await f.admit("全部原文", Number(selected.receipt.platformMessageId)); await held.ready;
    assert.ok(read.receipt.accepted); const count = f.sends.length;
    await p.harness.commit(async tx => { const doc = await tx.doc(PersonalTelegramReceiptDoc, read.receipt.requestId, null); if (mutation === "accepted") delete doc.receipt!.accepted; else if (mutation === "foreign") doc.receipt!.accepted = original.receipt.accepted; else delete doc.receipt; }, context);
    held.release(); const settled = await p.harness.waitForTask(read.receipt.multipart!.taskId, context);
    assert.ok(["failed", "faulted"].includes(settled.state.outcome.status));
    assert.ok((await f.record(read.receipt.multipart!)).parts.every(part => part.claims.length === 0));
    assert.equal(f.sends.length, count); assert.equal(f.model.calls.length, 1); assert.deepEqual(await f.record(original.receipt.multipart!), original.saved);
    await p.close(); await assert.rejects(f.open(), invalidOwner);
    assert.equal(f.sends.length, count); assert.equal(f.model.calls.length, 1);
  });
});

test("A parentless retrieval admission without the original typed owner request cannot dispatch or reopen", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(), original = await f.original(), held = f.hold("telegram-retrieval:"), count = f.sends.length;
  const ref = await p.harness.commit(tx => requestPersonalImDelivery(tx, { key: "telegram-retrieval:telegram:123:456:999999", source: f.source, messageId: 999999, text: originalText, retrieval: { delivery: original.receipt.multipart!, segments: original.saved.parts.map(part => part.index) } }), context);
  p.harness.resume(); await held.ready; held.release(); const settled = await p.harness.waitForTask(ref.taskId, context);
  assert.ok(["failed", "faulted"].includes(settled.state.outcome.status)); assert.ok((await f.record(ref)).parts.every(part => part.claims.length === 0));
  assert.equal(f.sends.length, count); assert.equal(f.model.calls.length, 1); assert.deepEqual(await f.record(original.receipt.multipart!), original.saved);
  await p.close(); await assert.rejects(f.open(), invalidOwner); assert.equal(f.sends.length, count); assert.equal(f.model.calls.length, 1);
});

test("A genuine Telegram parent cannot authorize an extra delivery absent from its original receipt", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(), original = await f.original(), count = f.sends.length;
  const ref = await p.harness.commit(tx => requestPersonalImDelivery(tx, { key: `telegram-reply:${original.receipt.requestId}:extra`, source: f.source, messageId: original.receipt.messageId, text: originalText }, original.receipt.taskId), context);
  p.harness.resume(); const settled = await p.harness.waitForTask(ref.taskId, context);
  assert.ok(["failed", "faulted"].includes(settled.state.outcome.status)); assert.ok((await f.record(ref)).parts.every(part => part.claims.length === 0));
  assert.deepEqual(await f.record(original.receipt.multipart!), original.saved); assert.deepEqual(await f.snapshot(original.receipt.requestId), original.receipt);
  assert.equal(f.sends.length, count); assert.equal(f.model.calls.length, 1);
  await p.close(); await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "im_delivery_invalid");
  assert.equal(f.sends.length, count); assert.equal(f.model.calls.length, 1);
});
