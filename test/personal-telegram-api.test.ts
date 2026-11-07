import assert from "node:assert/strict";
import * as http from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { PersonalImApiError } from "../apps/ruukoto/src/personal-im-api.ts";
import { personalTelegramApi, PersonalTelegramApiError, telegramCallback, telegramMessage, telegramText, type TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";

const token = "123:transport-test-secret", owner = "456", signal = new AbortController().signal;
const callback = (): TelegramUpdate => ({ update_id: 11, callback_query: { id: "opaque-query-identifier", data: "opaque-token", from: { id: 456, is_bot: false }, message: { message_id: 789, date: 1_800_000_000, from: { id: 123, is_bot: true }, chat: { id: 456, type: "private" } } } });
const message = (messageId = 789) => ({ message_id: messageId, chat: { id: 456, type: "private" } });
const effect = (expected: string) => (error: unknown) => error instanceof PersonalImApiError && error.effect === expected && !String(error).includes(token);

type Call = { method: string; headers: http.IncomingHttpHeaders; bytes: Buffer; json?: Record<string, unknown> };
async function fixture(t: TestContext) {
  const calls: Call[] = [];
  let reply: (call: Call, response: http.ServerResponse) => void = (call, response) => response.end(JSON.stringify({ ok: true, result: ["answerCallbackQuery", "sendChatAction"].includes(call.method) ? true : message() }));
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), call: Call = { method: request.url!.split("/").at(-1)!, headers: request.headers, bytes, ...(request.headers["content-type"] === "application/json" ? { json: JSON.parse(bytes.toString()) as Record<string, unknown> } : {}) };
    calls.push(call); response.setHeader("content-type", "application/json"); reply(call, response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { calls, api: personalTelegramApi(`http://127.0.0.1:${address.port}`, token), reply: (value: typeof reply) => { reply = value; } };
}

test("Telegram callback parsing requires an accessible bot card in its owner's private chat", () => {
  assert.deepEqual(telegramCallback(callback()), { queryId: "opaque-query-identifier", data: "opaque-token", ownerId: owner, botId: "123", chatId: owner, messageId: 789, date: 1_800_000_000 });
  const mutations: ((query: Record<string, unknown>, card: Record<string, unknown>) => void)[] = [
    (_query, card) => { card.date = 0; },
    (_query, card) => { delete card.date; },
    (_query, card) => { card.from = { id: 123, is_bot: false }; },
    (_query, card) => { card.chat = { id: 456, type: "group" }; },
    (_query, card) => { card.chat = { id: 999, type: "private" }; },
    (query) => { query.from = { id: 456, is_bot: true }; },
    (query) => { query.from = { id: 999, is_bot: false }; },
    (query) => { query.id = 123; },
    (query) => { query.data = "é".repeat(33); },
    (query) => { query.inline_message_id = "inline"; },
    (query) => { query.game_short_name = "game"; },
    (query) => { query.forward_origin = {}; },
    (_query, card) => { card.forward_origin = {}; },
    (_query, card) => { card.forward_from = {}; },
    (_query, card) => { card.via_bot = {}; },
    (_query, card) => { card.quote = {}; },
  ];
  for (const mutate of mutations) {
    const update = callback(), query = update.callback_query as Record<string, unknown>, card = query.message as Record<string, unknown>;
    mutate(query, card); assert.equal(telegramCallback(update), undefined);
  }
  assert.equal(telegramCallback({ update_id: 12, message: {} }), undefined);
});

test("Telegram documents retain metadata and invalid media never falls back to caption text", () => {
  const input: TelegramUpdate = { update_id: 10, message: { message_id: 10, from: { id: 456, is_bot: false }, chat: { id: 456, type: "private" }, caption: "完全访问", document: { file_id: "original-file", file_unique_id: "original-identity", file_name: "original.csv", mime_type: "text/csv", file_size: 0 }, media_group_id: "group-one" } };
  assert.deepEqual(telegramMessage(input)?.media, [{ identity: "original-identity", fileId: "original-file", name: "original.csv", declaredMime: "text/csv", kind: "file", sizeBytes: 0 }]);
  assert.equal(telegramMessage(input)?.text, "完全访问"); assert.equal(telegramMessage(input)?.mediaGroupId, "group-one"); assert.equal(telegramText(input), undefined);
  const image = structuredClone(input); (image.message as { document: Record<string, unknown> }).document.mime_type = "image/png";
  assert.equal(telegramMessage(image)?.media?.[0].kind, "image");
  (image.message as { document: Record<string, unknown> }).document.mime_type = "IMAGE/PNG; charset=binary";
  assert.equal(telegramMessage(image)?.media?.[0].kind, "image");
  (image.message as { document: Record<string, unknown> }).document.mime_type = "image/gif";
  assert.equal(telegramMessage(image)?.media?.[0].kind, "image");
  const mutations: ((message: Record<string, unknown>) => void)[] = [
    message => { message.document = {}; },
    message => { message.document = "invalid"; },
    message => { message.photo = []; },
    message => { delete message.document; message.photo = []; },
    message => { delete message.document; message.video = {}; },
    message => { (message.document as Record<string, unknown>).file_name = "../escape.csv"; },
    message => { (message.document as Record<string, unknown>).mime_type = "text/csv\r\nInjected:value"; },
    message => { (message.document as Record<string, unknown>).file_size = "0"; },
    message => { (message.document as Record<string, unknown>).file_unique_id = ""; },
    message => { (message.document as Record<string, unknown>).file_id = ""; },
    message => { message.media_group_id = {}; },
    message => { delete message.document; message.paid_media = {}; message.text = "完全访问"; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(input), message = value.message as Record<string, unknown>; mutate(message);
    const parsed = telegramMessage(value); assert.ok(parsed?.media?.length); assert.equal(parsed.media[0].fileId, ""); assert.equal(telegramText(value), undefined);
  }
  const emptyCaption = structuredClone(input); delete (emptyCaption.message as Record<string, unknown>).caption;
  assert.equal(telegramMessage(emptyCaption)?.text, "");
});

test("Telegram photo metadata failure blocks the entire media message", () => {
  const input: TelegramUpdate = { update_id: 10, message: { message_id: 10, from: { id: 456, is_bot: false }, chat: { id: 456, type: "private" }, caption: "完全访问", photo: [{ file_id: "small", file_unique_id: "small-identity", width: 1, height: 1, file_size: 4 }, { file_id: "large", file_unique_id: "large-identity", width: 10, height: 10, file_size: 40 }] } };
  assert.deepEqual(telegramMessage(input)?.media, [{ identity: "large-identity", fileId: "large", sizeBytes: 40 }]);
  for (const field of ["file_id", "file_unique_id", "width", "height", "file_size"]) {
    const invalid = structuredClone(input), photos = (invalid.message as { photo: Record<string, unknown>[] }).photo;
    photos[0][field] = field.startsWith("file_") && field !== "file_size" ? "" : "invalid";
    assert.equal(telegramMessage(invalid)?.media?.[0].fileId, ""); assert.equal(telegramText(invalid), undefined);
  }
});

test("Telegram download preserves ordinary metadata and checks getFile size before body admission", async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255, 1, 128, 13, 10]);
  f.reply((call, response) => {
    if (call.method === "getFile") { response.end(JSON.stringify({ ok: true, result: { file_path: "documents/original.bin", file_size: bytes.length } })); return; }
    response.setHeader("content-type", "application/octet-stream"); response.end(bytes);
  });
  const file = f.api.photo({ identity: "file-identity", fileId: "file-id", kind: "file", name: "original.bin", declaredMime: "application/octet-stream", sizeBytes: bytes.length });
  assert.equal(file.kind, "file"); assert.equal(file.name, "original.bin"); assert.equal(file.sizeBytes, bytes.length);
  const response = await file.download(signal);
  assert.equal(response.headers.get("content-length"), String(bytes.length)); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(f.calls[0].json, { file_id: "file-id" });
  f.reply((_call, response) => response.end(JSON.stringify({ ok: true, result: { file_path: "documents/original.bin", file_size: bytes.length - 1 } })));
  await assert.rejects(file.download(signal), error => error instanceof PersonalError && error.code === "download_incomplete");
  f.reply((_call, response) => response.end(JSON.stringify({ ok: true, result: { file_path: "documents/original.bin", file_size: 8 * 1024 * 1024 + 1 } })));
  await assert.rejects(file.download(signal), error => error instanceof PersonalError && error.code === "file_too_large");
  for (const file_size of [-1, 0.5, "6"]) {
    f.reply((_call, response) => response.end(JSON.stringify({ ok: true, result: { file_path: "documents/original.bin", file_size } })));
    await assert.rejects(file.download(signal), error => error instanceof PersonalError && error.code === "download_incomplete");
  }
  const calls = f.calls.length;
  await assert.rejects(f.api.photo({ identity: "bad", fileId: "file-id", kind: "file", name: "../bad.bin" }).download(signal), error => error instanceof PersonalError && error.code === "attachment_invalid");
  assert.equal(f.calls.length, calls);
});

test("Telegram polling includes callbacks and validates their bounded update batch", async t => {
  const f = await fixture(t); f.reply((_call, response) => response.end(JSON.stringify({ ok: true, result: [callback()] })));
  assert.deepEqual(await f.api.updates(signal, 10, 0), [callback()]);
  assert.deepEqual(f.calls[0].json, { offset: 10, timeout: 0, limit: 16, allowed_updates: ["message", "callback_query"] });
  f.reply((_call, response) => response.end(JSON.stringify({ ok: true, result: [callback(), callback()] })));
  await assert.rejects(f.api.updates(signal, undefined, 0), effect("effect_unknown"));
});

test("Telegram cards send opaque keyboards and terminal edits remove them", async t => {
  const f = await fixture(t), keyboard = [[{ text: "同意", callback_data: "é".repeat(32) }, { text: "拒绝", callback_data: "deny-token" }]];
  assert.equal(await f.api.send(owner, 10, "原决定", signal, keyboard), "789");
  assert.deepEqual(f.calls[0].json, { chat_id: owner, text: "原决定", reply_parameters: { message_id: 10, allow_sending_without_reply: true }, reply_markup: { inline_keyboard: keyboard } });
  await f.api.answerCallback("opaque-query-identifier", signal);
  await f.api.edit(owner, 789, "已同意", signal);
  await f.api.typing(owner, signal);
  assert.deepEqual(f.calls.slice(1).map(call => [call.method, call.json]), [["answerCallbackQuery", { callback_query_id: "opaque-query-identifier" }], ["editMessageText", { chat_id: owner, message_id: 789, text: "已同意", reply_markup: { inline_keyboard: [] } }], ["sendChatAction", { chat_id: owner, action: "typing" }]]);
  const count = f.calls.length;
  await assert.rejects(f.api.send(owner, 10, "原决定", signal, [[{ text: "同意", callback_data: "é".repeat(33) }]]), effect("not_sent"));
  await assert.rejects(f.api.send(owner, 10, "x".repeat(4097), signal), effect("not_sent"));
  await assert.rejects(f.api.send(owner, 10, "原决定", signal, [[{ text: "", callback_data: "token" }]]), effect("not_sent"));
  await assert.rejects(f.api.typing("-1", signal), effect("not_sent"));
  assert.equal(f.calls.length, count);
  assert.equal(await f.api.send(owner, 10, "🙂".repeat(4096), signal), "789");
});

test("Telegram callback acknowledgement, edit and typing failures remain separate API failures", async t => {
  const f = await fixture(t);
  f.reply((_call, response) => { response.writeHead(400); response.end(JSON.stringify({ ok: false, error_code: 400 })); });
  await assert.rejects(f.api.answerCallback("expired-query", signal), effect("not_sent"));
  f.reply((_call, response) => response.end(JSON.stringify({ ok: true, result: message(999) })));
  await assert.rejects(f.api.edit(owner, 789, "已拒绝", signal), effect("effect_unknown"));
  f.reply((_call, response) => response.end(JSON.stringify({ ok: true, result: false })));
  await assert.rejects(f.api.typing(owner, signal), effect("effect_unknown"));
  f.reply((_call, response) => response.destroy());
  await assert.rejects(f.api.answerCallback("lost-query", signal), effect("effect_unknown"));
});

test("Telegram document multipart preserves exact bytes, MIME and basename at 8 MiB", async t => {
  const f = await fixture(t), bytes = Buffer.alloc(8 * 1024 * 1024);
  for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = offset % 251;
  const input = { name: "最终文件.bin", mime: "application/octet-stream", bytes };
  f.reply((_call, response) => response.end(JSON.stringify({ ok: true, result: { ...message(), document: { file_id: "original-file", file_size: bytes.length, file_name: input.name } } })));
  assert.equal(await f.api.document(owner, 10, input, signal), "789");
  assert.equal(f.calls[0].method, "sendDocument");
  assert.match(f.calls[0].headers["content-type"]!, /^multipart\/form-data; boundary=/);
  const form = await new Request("http://localhost", { method: "POST", headers: { "content-type": f.calls[0].headers["content-type"]! }, body: Uint8Array.from(f.calls[0].bytes) }).formData();
  assert.equal(form.get("chat_id"), owner);
  assert.equal(form.get("reply_parameters"), JSON.stringify({ message_id: 10, allow_sending_without_reply: true }));
  assert.equal(form.get("disable_content_type_detection"), "true");
  const file = form.get("document"); assert.ok(file && typeof file !== "string");
  assert.equal(file.name, input.name); assert.equal(file.type, input.mime); assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  const count = f.calls.length;
  for (const invalid of [{ ...input, name: "../file.bin" }, { ...input, name: "file\n.bin" }, { ...input, mime: "application/octet-stream\r\nInjected: value" }, { ...input, bytes: Buffer.alloc(bytes.length + 1) }]) await assert.rejects(f.api.document(owner, 10, invalid, signal), effect("not_sent"));
  assert.equal(f.calls.length, count);
});

test("Telegram document receipts cannot turn malformed or foreign results into confirmed delivery", async t => {
  const f = await fixture(t), input = { name: "result.txt", mime: "text/plain; charset=utf-8", bytes: Buffer.from("exact\r\n🙂\n") };
  for (const result of [message(), { ...message(), document: { file_id: "file", file_size: input.bytes.length - 1 } }, { ...message(), document: { file_id: "file", file_name: "other.txt" } }, { ...message(), chat: { id: 999, type: "private" }, document: { file_id: "file" } }]) {
    f.reply((_call, response) => response.end(JSON.stringify({ ok: true, result })));
    await assert.rejects(f.api.document(owner, 10, input, signal), effect("effect_unknown"));
  }
  f.reply((_call, response) => response.end(JSON.stringify({ ok: true, result: { ...message(), document: { file_id: "file" } } })));
  assert.equal(await f.api.document(owner, 10, input, signal), "789");
});

test("Telegram transport preserves definite refusal, rate-limit and unknown classifications", async t => {
  const f = await fixture(t);
  f.reply((_call, response) => { response.writeHead(429); response.end(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 2 } })); });
  await assert.rejects(f.api.send(owner, 10, "原文本", signal), (error: unknown) => error instanceof PersonalTelegramApiError && error.effect === "not_sent" && error.retryAfterMs === 2000);
  f.reply((_call, response) => { response.writeHead(429); response.end("proxy refusal"); });
  await assert.rejects(f.api.send(owner, 10, "原文本", signal), effect("effect_unknown"));
  f.reply((_call, response) => { response.writeHead(403); response.end(JSON.stringify({ ok: false, error_code: 403 })); });
  await assert.rejects(f.api.send(owner, 10, "原文本", signal), effect("not_sent"));
  f.reply((_call, response) => { response.writeHead(500); response.end(JSON.stringify({ ok: false, error_code: 500 })); });
  await assert.rejects(f.api.send(owner, 10, "原文本", signal), effect("effect_unknown"));
  f.reply((_call, response) => response.end("x".repeat(1024 * 1024 + 1)));
  await assert.rejects(f.api.send(owner, 10, "原文本", signal), effect("effect_unknown"));
});
