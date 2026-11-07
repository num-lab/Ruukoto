import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, SessionFailed, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc, type TelegramReceipt } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalTelegramDisplaysDoc, PersonalTelegramDisplayDoc, type PersonalTelegramDisplay } from "../apps/ruukoto/src/personal-telegram-display-records.ts";
import { PersonalTelegramCallbackDoc } from "../apps/ruukoto/src/personal-telegram-callbacks.ts";
import { PersonalTelegramAttachmentsDoc, PersonalTelegramAttachmentGroupDoc, TELEGRAM_ATTACHMENT_SEND, TELEGRAM_ATTACHMENT_DISCARD, type PersonalTelegramAttachmentGroup } from "../apps/ruukoto/src/personal-telegram-attachments.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalImDeliveryRecord } from "../apps/ruukoto/src/personal-im-delivery.ts";
import { loadPersonalArtifact } from "../apps/ruukoto/src/personal-artifacts.ts";
import { PersonalMediaMessageDoc, personalAttachmentReference, personalAttachmentGrant, preparePersonalAttachments } from "../apps/ruukoto/src/personal-media.ts";
import { PersonalWorkDoc } from "../apps/ruukoto/src/personal-work.ts";
import { answerPersonalQuestion, personalQuestion, personalQuestionList } from "../apps/ruukoto/src/personal-questions.ts";
import { personalTimeline, personalDesktopTimelineEntry, readPersonalDesktopHistory, readPersonalHistory } from "../apps/ruukoto/src/personal-history.ts";
import { personalControl, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { personalDesktopEvents } from "../apps/ruukoto/src/personal-desktop-events.ts";
import type { PersonalDesktopFrame, PersonalTimelineEntry } from "@ruukoto/view/personal-protocol.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { PersonalMockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fixtureFile = (name: string) => fs.readFileSync(new URL(`./fixtures/personal-attachments/${name}`, import.meta.url));
async function until(check: () => boolean | Promise<boolean>) { const deadline = Date.now() + 15000; while (!await check()) { assert.ok(Date.now() < deadline, "attachment interaction did not settle"); await delay(10); } }
type File = { bytes: Buffer; mime: string; getSize?: number; fail?: boolean; truncated?: boolean; hold?: Promise<void> };

async function fixture(t: TestContext, imageInput = false, holdModel?: Promise<void>, respond?: Responder) {
  isolateSkillHome(t);
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-tg-attachments-")), profile = path.join(root, "profile"), token = "123:attachment-test-only", tokenEnv = "TG_ATTACHMENT_BOT_KEY", modelEnv = "TG_ATTACHMENT_MODEL_KEY", previous = [process.env[tokenEnv], process.env[modelEnv]];
  process.env[tokenEnv] = token; process.env[modelEnv] = "test-only";
  const files = new Map<string, File>(), downloads: string[] = [], sends: { messageId: number; text: string }[] = [];
  let nextPlatformId = 1000, loseText = false;
  const bot = http.createServer(async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks).toString(), body = content ? JSON.parse(content) as Record<string, unknown> : {};
    const send = (result: unknown) => reply.end(JSON.stringify({ ok: true, result }));
    if (request.url?.endsWith("/getMe")) { send({ id: 123, is_bot: true, username: "attachment_bot" }); return; }
    if (request.url?.endsWith("/getUpdates")) { await delay(10); if (!reply.destroyed) send([]); return; }
    if (request.url?.endsWith("/getFile")) {
      const id = String(body.file_id), file = files.get(id);
      if (!file || file.fail) { reply.writeHead(400); reply.end(JSON.stringify({ ok: false, error_code: 400 })); return; }
      send({ file_path: `documents/${id}`, file_size: file.getSize ?? file.bytes.length }); return;
    }
    if (request.url?.startsWith(`/file/bot${token}/documents/`)) {
      const id = request.url.split("/").at(-1)!, file = files.get(id)!; downloads.push(id); await file.hold; reply.setHeader("content-type", file.mime);
      reply.end(file.truncated ? file.bytes.subarray(0, file.bytes.length - 1) : file.bytes); return;
    }
    if (request.url?.endsWith("/sendChatAction") || request.url?.endsWith("/answerCallbackQuery")) { send(true); return; }
    if (request.url?.endsWith("/editMessageText")) { send({ message_id: body.message_id, chat: { id: Number(body.chat_id), type: "private" } }); return; }
    assert.ok(request.url?.endsWith("/sendMessage"));
    const messageId = ++nextPlatformId; sends.push({ messageId, text: String(body.text) });
    if (loseText) { loseText = false; reply.destroy(); return; }
    send({ message_id: messageId, chat: { id: Number(body.chat_id), type: "private" } });
  });
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  const model = new PersonalMockModelServer(respond ?? (async () => { await holdModel; return { kind: "text", text: "已收到附件，请说明如何使用。" }; }));
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: modelEnv, contextWindow: 128000, maxTokens: 8192, imageInput };
  const telegram = { version: 1 as const, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv, tokenDigest: hash(token), botId: "123", ownerId: "456", boundary: 0 };
  let p: PersonalHarness | undefined, nextInput = 10;
  const open = async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => p = await openPersonalHarness({ directory: profile, provider: personalProvider(config), modelId: config.modelId, telegram, ...overrides });
  const requestEvidence = () => p!.harness.commit(async tx => (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256)).items.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data), context);
  const document = (fileId: string, group?: string, caption = "", extra: Record<string, unknown> = {}): TelegramUpdate => {
    const file = files.get(fileId)!;
    return { update_id: ++nextInput, message: { message_id: nextInput, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, caption, document: { file_id: fileId, file_unique_id: `${fileId}-identity`, file_name: fileId, mime_type: file.mime, file_size: file.bytes.length }, ...(group === undefined ? {} : { media_group_id: group }), ...extra } };
  };
  const receive = async (update: TelegramUpdate) => { await p!.telegram.receive(update); return update; };
  const text = (content: string, replyTo?: number): TelegramUpdate => ({ update_id: ++nextInput, message: { message_id: nextInput, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text: content, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }) } });
  const receipt = async (update: TelegramUpdate) => {
    const id = (update.message as { message_id: number }).message_id, key = `telegram:123:456:${id}`;
    await until(async () => (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))?.receipt !== undefined);
    const initial = (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    await p!.harness.waitForTask(initial.taskId, context); return (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
  };
  const groups = async () => {
    const keys = (await p!.harness.snapshot(PersonalTelegramAttachmentsDoc, context))?.keys ?? [];
    return Promise.all(keys.map(async key => (await p!.harness.snapshot(PersonalTelegramAttachmentGroupDoc, key, context))!.group!));
  };
  const displays = async () => p!.harness.commit(async tx => { const result: PersonalTelegramDisplay[] = []; for (const key of (await tx.doc(PersonalTelegramDisplaysDoc)).keys) { const display = (await tx.doc(PersonalTelegramDisplayDoc, key, null)).display; if (display) result.push(copy(display)); } return result; }, context);
  const card = async (group: PersonalTelegramAttachmentGroup) => {
    let found: PersonalTelegramDisplay | undefined;
    await until(async () => { found = (await displays()).find(display => display.selection.kind === "attachment-group" && display.selection.group === group.key && display.selection.revision === group.revision && display.buttons.length > 0); return !!found && p!.harness.commit(async tx => (await personalImDeliveryRecord(tx, found!.delivery)).parts.at(-1)?.state === "sent", context); });
    return found!;
  };
  const callback = async (display: PersonalTelegramDisplay, action: string) => {
    const button = display.buttons.find(button => button.action === action)!; assert.ok(button);
    const messageId = await p!.harness.commit(async tx => Number((await personalImDeliveryRecord(tx, display.delivery)).parts.at(-1)!.platformMessageId), context), queryId = randomUUID();
    const update: TelegramUpdate = { update_id: ++nextInput, callback_query: { id: queryId, data: button.token, from: { id: 456, is_bot: false }, message: { message_id: messageId, date: 1, from: { id: 123, is_bot: true }, chat: { id: 456, type: "private" } } } };
    await receive(update); const key = `telegram-callback:123:${queryId}`;
    await until(async () => (await p!.harness.snapshot(PersonalTelegramCallbackDoc, key, context))?.ack?.observation !== undefined);
    return { update, key, receipt: (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))?.receipt };
  };
  const entries = () => p!.harness.commit(async tx => (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256)).items, context);
  t.after(async () => { await p?.close(); bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); await model.close(); for (const [index, key] of [tokenEnv, modelEnv].entries()) if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; fs.rmSync(root, { recursive: true, force: true }); });
  return { open, receive, document, text, receipt, groups, displays, card, callback, entries, files, downloads, sends, model, config, requestEvidence, telegram, profile, get p() { return p!; }, loseText: () => { loseText = true; } };
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("Telegram ordinary binary and empty attachments reach text-only models with retained exact bytes", async t => {
  const f = await fixture(t); await f.open();
  const binary = fixtureFile("binary.bin"); f.files.set("binary.bin", { bytes: binary, mime: "application/octet-stream" }); f.files.set("empty.bin", { bytes: Buffer.alloc(0), mime: "application/octet-stream" });
  for (const fileId of ["binary.bin", "empty.bin"]) {
    const input = await f.receive(f.document(fileId, undefined, "")), saved = await f.receipt(input);
    assert.equal(saved.mediaRejected, undefined); assert.ok(saved.submissionId); assert.equal(saved.control, undefined);
    const media = (await f.p.harness.snapshot(PersonalMediaMessageDoc, saved.requestId, context))!.message!;
    assert.equal(media.state, "bound"); assert.equal(media.members![0].name, fileId); assert.equal(media.members![0].kind, "file");
    assert.deepEqual(loadPersonalArtifact(f.profile, media.artifacts[0]), f.files.get(fileId)!.bytes);
  }
  assert.equal(f.model.calls.length, 2); assert.doesNotMatch(JSON.stringify(f.model.calls), /image_url/);
  const original = (await f.p.harness.snapshot(PersonalMediaMessageDoc, "telegram:123:456:11", context))!.message!;
  await f.p.close(); await f.open(); assert.deepEqual(loadPersonalArtifact(f.profile, original.artifacts[0]), binary); assert.equal(f.downloads.length, 2); assert.equal(f.model.calls.length, 2);
});

test("Telegram invalid, incomplete and oversized documents reject their captions and embedded controls", async t => {
  const f = await fixture(t); await f.open(); const bytes = fixtureFile("input.csv");
  f.files.set("incomplete.csv", { bytes, mime: "text/csv", truncated: true });
  f.files.set("oversized.bin", { bytes: Buffer.alloc(8 * 1024 * 1024 + 1), mime: "application/octet-stream" });
  f.files.set("bad.csv", { bytes, mime: "text/csv" });
  const invalid = f.document("bad.csv", undefined, "完全访问"); (invalid.message as { document: Record<string, unknown> }).document.file_name = "../bad.csv";
  for (const input of [invalid, f.document("incomplete.csv", undefined, "完全访问"), f.document("oversized.bin", undefined, "完全访问")]) {
    await f.receive(input); const saved = await f.receipt(input); assert.equal(saved.mediaRejected, true); assert.equal(saved.submissionId, undefined); assert.equal(saved.control, undefined); assert.match(saved.reply!, /未交给模型/);
  }
  assert.equal(f.model.calls.length, 0); assert.equal((await f.p.harness.snapshot(PersonalPermissionsDoc, context))!.mode, "auto-review");
});

test("Telegram mixed groups admit all four members only after current source-bound Send, once across reopen", async t => {
  const f = await fixture(t, true); await f.open();
  f.files.set("input.csv", { bytes: fixtureFile("input.csv"), mime: "text/csv" }); f.files.set("image.png", { bytes: fixtureFile("image.png"), mime: "image/png" }); f.files.set("binary.bin", { bytes: fixtureFile("binary.bin"), mime: "application/octet-stream" }); f.files.set("empty.bin", { bytes: Buffer.alloc(0), mime: "application/octet-stream" });
  const updates = [f.document("input.csv", "group-one", "Read row 17."), f.document("image.png", "group-one"), f.document("binary.bin", "group-one"), f.document("empty.bin", "group-one")];
  for (const update of updates) await f.receive(update);
  const group = (await f.groups())[0], display = await f.card(group);
  assert.equal(f.model.calls.length, 0); assert.equal(f.downloads.length, 0);
  const decision = await f.callback(display, TELEGRAM_ATTACHMENT_SEND); assert.ok(decision.receipt?.attachmentChoice); assert.equal(decision.receipt?.submissionId, undefined); assert.equal(decision.receipt?.control, true);
  const saved = await f.receipt(updates[0]); assert.equal(saved.content, "Read row 17."); assert.equal(saved.attachmentGroup?.key, group.key); assert.ok(saved.submissionId);
  const media = (await f.p.harness.snapshot(PersonalMediaMessageDoc, saved.requestId, context))!.message!;
  assert.equal(media.artifacts.length, 4); for (let index = 0; index < updates.length; index++) assert.deepEqual(loadPersonalArtifact(f.profile, media.artifacts[index]), f.files.get(["input.csv", "image.png", "binary.bin", "empty.bin"][index])!.bytes);
  assert.equal(f.model.calls.length, 1); assert.match(JSON.stringify(f.model.calls), /image_url/); assert.doesNotMatch(JSON.stringify(await f.requestEvidence()), new RegExp(fixtureFile("image.png").toString("base64")));
  for (const update of updates) await f.receive(update); await f.receive(decision.update); assert.equal(f.model.calls.length, 1); assert.equal(f.downloads.length, 4);
  await f.p.close(); await f.open(); for (const update of updates) await f.receive(update); await f.receive(decision.update); assert.equal(f.model.calls.length, 1); assert.equal(f.downloads.length, 4);
});

test("Telegram group selection refuses stale cards, failed members and fifth files without text execution", async t => {
  const f = await fixture(t); await f.open(); const bytes = fixtureFile("input.csv"); f.files.set("input.csv", { bytes, mime: "text/csv" }); f.files.set("failed.bin", { bytes: Buffer.from("missing"), mime: "application/octet-stream", fail: true });
  const first = f.document("input.csv", "failed-group", "Do not execute alone."); await f.receive(first); const old = await f.card((await f.groups())[0]);
  await f.receive(f.document("failed.bin", "failed-group")); const group = (await f.groups())[0], current = await f.card(group);
  const stale = await f.callback(old, TELEGRAM_ATTACHMENT_SEND); assert.equal(stale.receipt?.attachmentChoice, undefined); assert.equal(f.downloads.length, 0);
  await f.callback(current, TELEGRAM_ATTACHMENT_SEND); const rejected = await f.receipt(first); assert.equal(rejected.mediaRejected, true); assert.equal(rejected.submissionId, undefined); assert.equal(f.model.calls.length, 0);
  for (let index = 0; index < 12; index++) await f.receive(f.document("input.csv", "five-group", index ? "" : "Execute this text"));
  const five = (await f.groups()).find(group => group.groupId === "five-group")!, display = await f.card(five);
  assert.equal(five.members.length, 5); assert.equal(five.revision, 5); assert.equal(Object.hasOwn(five, "late"), false);
  assert.equal((await f.entries()).filter(entry => entry.kind === "ruukoto.telegram-attachment-rejected").length, 7);
  assert.equal(display.buttons.some(button => button.action === TELEGRAM_ATTACHMENT_SEND), false); assert.match(display.text, /最多4个/);
  await f.callback(display, TELEGRAM_ATTACHMENT_DISCARD); assert.equal(f.model.calls.length, 0); assert.equal((await f.groups()).find(group => group.key === five.key)?.state, "discarded");
  await f.p.close(); await f.open(); assert.equal((await f.groups()).find(group => group.key === five.key)?.members.length, 5); assert.equal(f.model.calls.length, 0);
});

test("Telegram pending-group display uncertainty needs explicit retrieval; late members remain outside confirmed input", async t => {
  const f = await fixture(t); await f.open(); f.files.set("input.csv", { bytes: fixtureFile("input.csv"), mime: "text/csv" });
  f.loseText(); const first = await f.receive(f.document("input.csv", "lost-card"));
  await until(async () => (await f.displays()).some(display => display.selection.kind === "attachment-group"));
  const original = (await f.displays()).find(display => display.selection.kind === "attachment-group")!;
  await until(async () => f.p.harness.commit(async tx => (await personalImDeliveryRecord(tx, original.delivery)).parts.at(-1)?.state === "effect_unknown", context));
  const sent = f.sends.length; await f.p.close(); await f.open(); await delay(900); assert.equal(f.sends.length, sent); assert.equal(f.model.calls.length, 0);
  const query = await f.receive(f.text("/附件")), list = await f.receipt(query); assert.equal(list.selection?.kind, "attachment-list");
  const view = await f.receive(f.text("附件1", Number(list.platformMessageId))), viewReceipt = await f.receipt(view);
  const display = (await f.displays()).find(display => display.key === viewReceipt.display)!; await f.callback(display, TELEGRAM_ATTACHMENT_SEND); await f.receipt(first);
  const before = f.model.calls.length, selected = (await f.groups())[0], late = f.document("input.csv", "lost-card", "New delayed caption");
  await f.receive(late); await f.receive(late); assert.equal(f.model.calls.length, before);
  assert.deepEqual((await f.groups())[0], selected); assert.equal((await f.entries()).filter(entry => entry.kind === "ruukoto.telegram-attachment-rejected").length, 1);
  assert.ok((await f.displays()).some(display => display.text.includes("不在已确认")));
  await f.p.close(); await f.open(); await f.receive(late); assert.deepEqual((await f.groups())[0], selected); assert.equal(f.model.calls.length, before);
});

test("Telegram re-pairing rejects old attachment members and choices before download", async t => {
  const f = await fixture(t); await f.open(); f.files.set("input.csv", { bytes: fixtureFile("input.csv"), mime: "text/csv" });
  const input = await f.receive(f.document("input.csv", "original-generation")), group = (await f.groups())[0], display = await f.card(group);
  await f.p.close(); f.telegram.generation = randomUUID(); await f.open();
  await f.receive(input); const decision = await f.callback(display, TELEGRAM_ATTACHMENT_SEND); assert.equal(decision.receipt, undefined); assert.equal(f.model.calls.length, 0); assert.equal(f.downloads.length, 0);
  assert.equal(await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "telegram:123:456:11"), context), undefined);
});

test("Telegram group message identity cannot be downgraded to a single attachment or control text", async t => {
  const f = await fixture(t); await f.open(); f.files.set("input.csv", { bytes: fixtureFile("input.csv"), mime: "text/csv" });
  const first = await f.receive(f.document("input.csv", "fixed-group", "Original task")), group = (await f.groups())[0];
  const withoutGroup = structuredClone(first); delete (withoutGroup.message as Record<string, unknown>).media_group_id;
  await f.receive(withoutGroup);
  const asControl = structuredClone(withoutGroup), message = asControl.message as Record<string, unknown>;
  delete message.document; delete message.caption; message.text = "完全访问"; await f.receive(asControl);
  assert.equal(f.downloads.length, 0); assert.equal(f.model.calls.length, 0); assert.equal((await f.p.harness.snapshot(PersonalPermissionsDoc, context))!.mode, "auto-review");
  await f.callback(await f.card(group), TELEGRAM_ATTACHMENT_SEND); await f.receipt(first);
  const admitted = (await f.groups())[0]; await f.receive(withoutGroup); await f.receive(asControl);
  assert.deepEqual((await f.groups())[0], admitted); assert.equal(f.downloads.length, 1); assert.equal(f.model.calls.length, 1);
  await f.p.close(); await f.open(); await f.receive(withoutGroup); assert.equal(f.downloads.length, 1); assert.equal(f.model.calls.length, 1);
});

test("Telegram mixed groups reject every member and caption when images are unsupported or metadata is invalid", async t => {
  const f = await fixture(t); await f.open();
  f.files.set("input.csv", { bytes: fixtureFile("input.csv"), mime: "text/csv" }); f.files.set("image.png", { bytes: fixtureFile("image.png"), mime: "image/png" }); f.files.set("image.gif", { bytes: Buffer.from("GIF89a"), mime: "image/gif" });
  const first = await f.receive(f.document("input.csv", "no-vision", "完全访问")); await f.receive(f.document("image.png", "no-vision"));
  await f.callback(await f.card((await f.groups())[0]), TELEGRAM_ATTACHMENT_SEND); const rejected = await f.receipt(first);
  assert.equal(rejected.mediaRejected, true); assert.equal(rejected.submissionId, undefined); assert.equal(f.downloads.length, 0); assert.equal(f.model.calls.length, 0);
  const badFirst = await f.receive(f.document("input.csv", "bad-metadata", "Execute only together")), bad = f.document("input.csv", "bad-metadata");
  (bad.message as { document: Record<string, unknown> }).document.file_size = "invalid";
  await f.receive(bad); await f.callback(await f.card((await f.groups()).find(group => group.groupId === "bad-metadata")!), TELEGRAM_ATTACHMENT_SEND);
  assert.equal((await f.receipt(badFirst)).mediaRejected, true); assert.equal(f.model.calls.length, 0);
  await f.p.close(); await f.open({ provider: personalProvider({ ...f.config, imageInput: true }) });
  const gif = await f.receive(f.document("image.gif", undefined, "完全访问")), gifReceipt = await f.receipt(gif);
  assert.equal(gifReceipt.mediaRejected, true); assert.equal(gifReceipt.submissionId, undefined); assert.equal(f.model.calls.length, 0); assert.equal((await f.p.harness.snapshot(PersonalPermissionsDoc, context))!.mode, "auto-review");
});

test("Telegram inbound accepts an entire 8 MiB file and preserves the full immutable metadata", async t => {
  const f = await fixture(t); await f.open(); const bytes = Buffer.alloc(8 * 1024 * 1024, 251); bytes[0] = 0; bytes[bytes.length - 1] = 255;
  f.files.set("boundary.bin", { bytes, mime: "application/octet-stream" });
  const input = await f.receive(f.document("boundary.bin")), saved = await f.receipt(input), media = (await f.p.harness.snapshot(PersonalMediaMessageDoc, saved.requestId, context))!.message!;
  assert.equal(media.artifacts[0].bytes, bytes.length); assert.equal(media.artifacts[0].sha256, hash(bytes)); assert.equal(media.artifacts[0].mime, "application/octet-stream"); assert.deepEqual(loadPersonalArtifact(f.profile, media.artifacts[0]), bytes);
  assert.deepEqual(media.source, { platform: "telegram", accountId: "123", ownerId: "456", generation: f.telegram.generation });
  assert.deepEqual(media.members, [{ identity: "boundary.bin-identity", kind: "file", name: "boundary.bin", mime: "application/octet-stream", size: bytes.length }]);
  await f.p.close(); await f.open(); assert.deepEqual(loadPersonalArtifact(f.profile, media.artifacts[0]), bytes); assert.equal(f.downloads.length, 1); assert.equal(f.model.calls.length, 1);
});

test("Telegram group reception cannot submit after source revocation during download", async t => {
  const f = await fixture(t); await f.open(); let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  f.files.set("input.csv", { bytes: fixtureFile("input.csv"), mime: "text/csv", hold });
  const first = await f.receive(f.document("input.csv", "revoked-during-download", "Do not execute after revoke")), display = await f.card((await f.groups())[0]);
  await f.callback(display, TELEGRAM_ATTACHMENT_SEND); await until(() => f.downloads.length === 1);
  f.p.suspendSettings("telegram", "*"); release();
  await until(async () => (await f.groups())[0].state === "canceled"); assert.equal(f.model.calls.length, 0); assert.equal((await f.p.harness.snapshot(PersonalTelegramReceiptDoc, "telegram:123:456:11", context))?.receipt, undefined);
  const group = (await f.groups())[0]; await f.p.close(); f.telegram.generation = randomUUID(); await f.open(); await f.receive(first);
  assert.equal((await f.groups())[0].state, "canceled"); assert.deepEqual((await f.groups())[0].choice, group.choice); assert.equal(f.model.calls.length, 0); assert.equal(f.downloads.length, 1);
});

test("Telegram group reopen rejects missing member, choice and reciprocal receipt proofs", async t => {
  for (const mutation of ["member", "choice-members", "original-group", "orphan-choice"] as const) await t.test(mutation, async t => {
    const f = await fixture(t); await f.open(); f.files.set("input.csv", { bytes: fixtureFile("input.csv"), mime: "text/csv" });
    const first = await f.receive(f.document("input.csv", "proof-group", "Keep exact original task")), group = (await f.groups())[0];
    await f.callback(await f.card(group), TELEGRAM_ATTACHMENT_SEND); const saved = await f.receipt(first);
    if (mutation === "member") await f.p.harness.commit(async tx => { (await tx.doc(PersonalTelegramAttachmentGroupDoc, group.key, null)).group!.members[0].message.media![0].name = "forged.csv"; }, context);
    else if (mutation === "choice-members") await f.p.harness.commit(async tx => { (await tx.doc(PersonalTelegramAttachmentGroupDoc, group.key, null)).group!.choice!.entry = group.members[0].entry; }, context);
    else if (mutation === "original-group") await f.p.harness.commit(async tx => { (await tx.doc(PersonalTelegramReceiptDoc, saved.requestId, null)).receipt!.attachmentGroup!.choice = group.members[0].entry; }, context);
    else {
      const unrelated = await f.receipt(await f.receive(f.text("/附件")));
      const choice = (await f.groups())[0].choice!;
      await f.p.harness.commit(async tx => { (await tx.doc(PersonalTelegramReceiptDoc, unrelated.requestId, null)).receipt!.attachmentChoice = { key: group.key, revision: group.revision, action: "send", entry: choice.entry }; }, context);
    }
    await f.p.close(); await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "telegram_attachment_invalid"); assert.equal(f.model.calls.length, 1);
  });
});

test("Telegram sealed groups recover committed receive and submission response loss with the original request", async t => {
  for (const phase of ["receipt", "submission"] as const) await t.test(phase, async t => {
    const f = await fixture(t), cause = new Error(`telegram-group-${phase}-response-lost`); let armed = false;
    await f.open({ openStorage: async filename => {
      const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
      storage.commit = async (writes, callContext) => {
        const seq = await commit(writes, callContext);
        if (armed && writes.some(write => phase === "receipt" ? write.type === "document.create" && write.record.kind === PersonalTelegramReceiptDoc.definition.kind && write.record.key === "telegram:123:456:11" : write.type === "submission" && write.value.requestId === "telegram:123:456:11")) { armed = false; throw cause; }
        return seq;
      };
      return storage;
    } });
    f.files.set("input.csv", { bytes: fixtureFile("input.csv"), mime: "text/csv" });
    const first = await f.receive(f.document("input.csv", `lost-${phase}`, "Original request only")), display = await f.card((await f.groups())[0]); armed = true;
    try { await f.callback(display, TELEGRAM_ATTACHMENT_SEND); } catch (error) { assert.ok(error === cause || error instanceof SessionFailed); }
    await until(() => !armed); await f.p.close(); await f.open(); const saved = await f.receipt(first);
    assert.ok(saved.submissionId); assert.equal((await f.groups())[0].state, "received"); assert.equal(f.model.calls.length, 1); assert.equal(f.downloads.length, 1);
    const media = (await f.p.harness.snapshot(PersonalMediaMessageDoc, saved.requestId, context))!.message!;
    assert.equal(media.state, "bound"); assert.deepEqual(loadPersonalArtifact(f.profile, media.artifacts[0]), fixtureFile("input.csv"));
    await f.receive(first); assert.equal(f.model.calls.length, 1); assert.equal(f.downloads.length, 1);
  });
});

test("Telegram interrupted group staging retains its partial artifact and never submits a caption alone", async t => {
  const f = await fixture(t), cause = new Error("telegram-group-partial-staging-lost"); let armed = false;
  await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = async (writes, callContext) => {
      const seq = await commit(writes, callContext);
      if (armed && writes.some(write => write.type === "document.change")) {
        const record = await storage.findDocument({ kind: PersonalMediaMessageDoc.definition.kind, scope: { kind: "session" }, key: "telegram:123:456:11" }, "current", callContext), saved = record && await storage.document(record.id, "current", callContext), value = saved?.value.message;
        if (value && typeof value === "object" && !Array.isArray(value) && value.state === "staging" && Array.isArray(value.artifacts) && value.artifacts.length === 1) { armed = false; throw cause; }
      }
      return seq;
    };
    return storage;
  } });
  f.files.set("input.csv", { bytes: fixtureFile("input.csv"), mime: "text/csv" }); f.files.set("binary.bin", { bytes: fixtureFile("binary.bin"), mime: "application/octet-stream" });
  const first = await f.receive(f.document("input.csv", "interrupted-staging", "Never execute this text alone")); await f.receive(f.document("binary.bin", "interrupted-staging"));
  const display = await f.card((await f.groups())[0]); armed = true;
  try { await f.callback(display, TELEGRAM_ATTACHMENT_SEND); } catch (error) { assert.ok(error === cause || error instanceof SessionFailed); }
  await until(() => !armed); await f.p.close(); await f.open();
  await until(async () => ["received", "failed"].includes((await f.groups())[0].state));
  const group = (await f.groups())[0], media = (await f.p.harness.snapshot(PersonalMediaMessageDoc, "telegram:123:456:11", context))!.message!;
  assert.equal(media.state, "rejected"); assert.equal(media.reason, "download_interrupted"); assert.equal(media.artifacts.length, 1); assert.deepEqual(loadPersonalArtifact(f.profile, media.artifacts[0]), fixtureFile("input.csv"));
  if (group.state === "received") assert.equal((await f.receipt(first)).mediaRejected, true);
  else assert.equal(group.failure, "telegram_attachment_interrupted");
  assert.equal(f.model.calls.length, 0); assert.deepEqual(f.downloads, ["input.csv"]); await f.receive(first); assert.equal(f.model.calls.length, 0); assert.equal(f.downloads.length, 1);
});

test("Telegram admitted attachment descriptors must match the immutable full input before reuse or reopen", async t => {
  for (const image of [false, true]) await t.test(image ? "image document" : "ordinary document", async t => {
    const f = await fixture(t, image); await f.open(); const name = image ? "image.png" : "binary.bin";
    f.files.set(name, { bytes: fixtureFile(name), mime: image ? "image/png" : "application/octet-stream" });
    const input = await f.receive(f.document(name, undefined, "Original attachment task")), saved = await f.receipt(input), media = (await f.p.harness.snapshot(PersonalMediaMessageDoc, saved.requestId, context))!.message!;
    const submission = await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, saved.requestId), context); assert.ok(submission?.entry);
    const original = await f.p.harness.commit(tx => tx.entry(submission.entry!), context); assert.ok(original);
    await f.p.close(); const database = path.join(f.profile, "personal.sqlite"), baseline = fs.readFileSync(database), calls = f.model.calls.length;
    for (const mutation of ["drop", "replace"]) {
      fs.writeFileSync(database, baseline);
      const db = new DatabaseSync(database), changed: EntryRecord = copy(original), model = changed.model![0]; assert.equal(model.role, "user"); assert.ok(Array.isArray(model.content));
      const descriptor = model.content.findIndex(part => part.type === "text" && part.text.includes("artifact=")); assert.ok(descriptor >= 0);
      if (mutation === "drop") model.content.splice(descriptor, 1);
      else model.content[descriptor] = { type: "text", text: "Altered attachment descriptor" };
      db.prepare("UPDATE entries SET record = ? WHERE id = ?").run(JSON.stringify(changed), submission.entry); db.close();
      await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "image_reference_invalid"); assert.equal(f.model.calls.length, calls);
    }
    fs.writeFileSync(database, baseline); await f.open();
    const ref = await f.p.harness.commit(tx => personalAttachmentReference(tx, media.artifacts[0].id), context); assert.equal(ref.name, name); assert.equal(ref.requestId, saved.requestId); assert.deepEqual(loadPersonalArtifact(f.profile, ref.artifact), fixtureFile(name)); assert.equal(f.model.calls.length, calls);
  });
});

test("Telegram file intake shows its caption and exact attachment metadata in Desktop history and live events", async t => {
  const f = await fixture(t); await f.open(); const socketPath = path.join(path.dirname(f.profile), "desktop-audit.sock"), server = http.createServer(), events = personalDesktopEvents(server, f.p.harness, "attachment-desktop-audit", randomUUID());
  server.listen(socketPath); await once(server, "listening"); const client = new WebSocket(`ws+unix:${socketPath}:/events`, { headers: { authorization: "Bearer attachment-desktop-audit" } }), frames: PersonalDesktopFrame[] = [];
  let closed: { code: number; reason: string } | undefined;
  client.on("message", data => frames.push(JSON.parse(data.toString()) as PersonalDesktopFrame));
  client.on("close", (code, reason) => { closed = { code, reason: reason.toString() }; });
  t.after(async () => { client.terminate(); await events.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await once(client, "open"); await until(() => frames.some(frame => frame.type === "snapshot"));
  const bytes = fixtureFile("binary.bin"); f.files.set("binary.bin", { bytes, mime: "application/octet-stream" });
  const input = await f.receive(f.document("binary.bin", undefined, "Use the complete original file")), saved = await f.receipt(input), media = (await f.p.harness.snapshot(PersonalMediaMessageDoc, saved.requestId, context))!.message!;
  const expected = [{ id: media.artifacts[0].id, name: "binary.bin", size: bytes.length, mime: "application/octet-stream", sha256: hash(bytes) }];
  const submission = await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, saved.requestId), context); assert.ok(submission?.entry);
  const native = await f.p.harness.commit(tx => tx.entry(submission.entry!), context); assert.ok(native);
  const shown = await f.p.harness.commit(tx => personalDesktopTimelineEntry(tx, native), context); assert.ok(shown);
  assert.equal(shown.text, "Use the complete original file"); assert.deepEqual(shown.attachments, expected); assert.doesNotMatch(shown.text, /background_work|artifact=|附件按当前/);
  const timeline = await f.p.harness.commit(tx => personalTimeline(tx, {}), context); assert.deepEqual(timeline.items.find(entry => entry.entry === native.id)?.attachments, expected);
  const received = (): PersonalTimelineEntry[] => frames.flatMap(frame => frame.type === "snapshot" ? frame.timeline.items : frame.events.flatMap(event => event.type === "entry_appended" || event.type === "message_end" ? [event.entry] : []));
  await until(() => closed !== undefined || received().some(entry => entry.entry === native.id));
  assert.equal(closed, undefined, "Telegram attachment admission must preserve the Desktop live subscription");
  const live = received().filter(entry => entry.entry === native.id); assert.ok(live.length);
  assert.ok(live.every(entry => entry.text === "Use the complete original file")); assert.ok(live.every(entry => JSON.stringify(entry.attachments) === JSON.stringify(expected)));
});

test("Telegram queued ordinary attachments remain bound across reopen without a placed user entry", async t => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const f = await fixture(t, false, held); await f.open(); const busy = f.receive(f.text("Keep main busy until restart")); await busy; await until(() => f.model.calls.length === 1);
  f.files.set("binary.bin", { bytes: fixtureFile("binary.bin"), mime: "application/octet-stream" }); const input = await f.receive(f.document("binary.bin", undefined, "Queued original attachment"));
  const key = `telegram:123:456:${(input.message as { message_id: number }).message_id}`;
  await until(async () => (await f.p.harness.snapshot(PersonalMediaMessageDoc, key, context))?.message?.state === "bound");
  const submission = await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, key), context); assert.equal(submission?.status, "queued"); assert.equal(submission?.entry, undefined);
  const media = (await f.p.harness.snapshot(PersonalMediaMessageDoc, key, context))!.message!;
  await f.p.close(); release(); await f.open(); const restored = await f.receipt(input);
  assert.equal(restored.submissionId, submission!.id); assert.deepEqual(loadPersonalArtifact(f.profile, media.artifacts[0]), fixtureFile("binary.bin")); assert.equal(f.downloads.length, 1);
  const calls = f.model.calls.length; await f.receive(input); assert.equal(f.model.calls.length, calls); assert.equal(f.downloads.length, 1);
});

test("Telegram ready ordinary attachment recovery rejects missing or corrupt bytes before the original submission", async t => {
  const f = await fixture(t), cause = new Error("telegram-ready-receipt-response-lost"), key = "telegram:123:456:11"; let armed = false;
  await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = async (writes, callContext) => {
      const seq = await commit(writes, callContext);
      if (armed && writes.some(write => write.type === "document.create" && write.record.kind === PersonalTelegramReceiptDoc.definition.kind && write.record.key === key)) { armed = false; throw cause; }
      return seq;
    };
    return storage;
  } });
  const bytes = fixtureFile("binary.bin"); f.files.set("binary.bin", { bytes, mime: "application/octet-stream" }); const input = f.document("binary.bin", undefined, "Never execute without the complete original"); armed = true;
  await assert.rejects(f.receive(input), error => error === cause || error instanceof SessionFailed);
  assert.equal(armed, false); await f.p.close(); assert.equal(f.model.calls.length, 0);
  const storage = await openNodeSqliteStorage(path.join(f.profile, "personal.sqlite"));
  let media: Awaited<ReturnType<PersonalHarness["media"]["message"]>>;
  try {
    const record = await storage.findDocument({ kind: PersonalMediaMessageDoc.definition.kind, scope: { kind: "session" }, key }, "current", context); assert.ok(record);
    const saved = await storage.document(record.id, "current", context); assert.ok(saved?.value.message);
    media = saved.value.message as NonNullable<typeof media>;
    const receipt = await storage.findDocument({ kind: PersonalTelegramReceiptDoc.definition.kind, scope: { kind: "session" }, key }, "current", context); assert.ok(receipt);
    const received = await storage.document(receipt.id, "current", context); assert.ok(received?.value.receipt);
    assert.equal(await storage.submissionByRequest(ROOT_CONVERSATION_ID, key, context), undefined);
  } finally { await storage.close(context); }
  assert.ok(media); assert.equal(media.state, "ready"); assert.equal(media.submissionId, undefined); assert.deepEqual(loadPersonalArtifact(f.profile, media.artifacts[0]), bytes);
  const artifact = path.join(f.profile, "artifacts", `${media.artifacts[0].id}.bin`), preserved = path.join(f.profile, "artifacts", `.retained-${media.artifacts[0].id}`);
  fs.renameSync(artifact, preserved);
  try { await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "artifact_unavailable"); } finally { fs.renameSync(preserved, artifact); }
  assert.equal(f.model.calls.length, 0); assert.equal(f.downloads.length, 1);
  const corrupted = Buffer.from(bytes); corrupted[0] ^= 0xff; fs.writeFileSync(artifact, corrupted);
  try { await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "artifact_unavailable"); } finally { fs.writeFileSync(artifact, bytes); }
  assert.equal(f.model.calls.length, 0); assert.equal(f.downloads.length, 1);
  await f.open(); const restored = await f.receipt(input);
  assert.ok(restored.submissionId); assert.equal(f.model.calls.length, 1); assert.equal(f.downloads.length, 1);
  const bound = await f.p.media.message(key); assert.equal(bound?.state, "bound"); assert.equal(bound?.submissionId, restored.submissionId); assert.deepEqual(loadPersonalArtifact(f.profile, media.artifacts[0]), bytes);
});

test("Telegram attachment human history pages only the complete caption while model history retains attachment guidance", async t => {
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined; t.after(() => server?.stop());
  const f = await fixture(t), profile = lockPersonalProfile(f.profile);
  try { fs.writeFileSync(path.join(f.profile, "model.json"), JSON.stringify(f.config) + "\n", { mode: 0o600 }); fs.writeFileSync(path.join(f.profile, "telegram.json"), JSON.stringify(f.telegram) + "\n", { mode: 0o600 }); } finally { profile.release(); }
  await f.open(); f.files.set("binary.bin", { bytes: fixtureFile("binary.bin"), mime: "application/octet-stream" });
  const caption = "a".repeat(4095) + "🙂" + "b".repeat(900) + " original caption end";
  const input = await f.receive(f.document("binary.bin", undefined, caption)), saved = await f.receipt(input);
  const submission = await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, saved.requestId), context); assert.ok(submission?.entry);
  const entry = submission.entry, shown = (await f.p.harness.commit(tx => personalTimeline(tx, {}), context)).items.find(item => item.entry === entry); assert.ok(shown);
  assert.equal(shown.text, caption.slice(0, 4096)); assert.equal(shown.truncated, true); assert.equal(shown.attachments?.length, 1); assert.doesNotMatch(shown.text, /artifact=|background_work|附件按当前/);
  const first = await f.p.harness.commit(tx => readPersonalDesktopHistory(tx, { entry }), context);
  assert.equal(first.text, caption.slice(0, 4095)); assert.equal(first.nextOffset, 4095); assert.equal(first.total, caption.length);
  const modelHistory = await f.p.harness.commit(tx => readPersonalHistory(tx, ROOT_CONVERSATION_ID, { entry, offset: caption.length }), context);
  assert.match(modelHistory.text, /artifact=/); assert.match(modelHistory.text, /附件按当前/);
  const calls = f.model.calls.length; await f.p.close();
  server = await startPersonalServer(f.profile);
  let offset: number | undefined = 0, joined = "";
  while (offset !== undefined) {
    const page: Awaited<ReturnType<typeof readPersonalDesktopHistory>> = await personalControl(f.profile, "GET", `/history/entry?entry=${entry}&offset=${offset}`);
    assert.equal(page.offset, offset); assert.equal(page.total, caption.length); assert.ok(page.text.length <= 4096); assert.doesNotMatch(page.text, /^[\udc00-\udfff]|[\ud800-\udbff]$/); assert.doesNotMatch(page.text, /artifact=|background_work|附件按当前/);
    if (offset === 0) assert.deepEqual(page, first);
    if (page.nextOffset !== undefined) assert.equal(page.nextOffset, offset + page.text.length);
    assert.equal(page.truncated, page.nextOffset !== undefined); joined += page.text; offset = page.nextOffset;
  }
  assert.equal(joined, caption);
  await assert.rejects(personalControl(f.profile, "GET", `/history/entry?entry=${entry}&offset=${caption.length + 1}`), error => error instanceof PersonalError && error.code === "history_offset_invalid");
  assert.equal(f.model.calls.length, calls); assert.equal(f.downloads.length, 1);
  await server.stop();
});

test("Telegram ready attachment without a receipt remains unsubmitted across two reopens and admits the original once", async t => {
  const f = await fixture(t), cause = new Error("telegram-ready-before-receipt-response-lost"), key = "telegram:123:456:11"; let armed = false;
  await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = async (writes, callContext) => {
      const seq = await commit(writes, callContext);
      if (armed && writes.some(write => write.type === "document.change")) {
        const record = await storage.findDocument({ kind: PersonalMediaMessageDoc.definition.kind, scope: { kind: "session" }, key }, "current", callContext), saved = record && await storage.document(record.id, "current", callContext), media = saved?.value.message;
        if (media && typeof media === "object" && !Array.isArray(media) && media.state === "ready") { armed = false; throw cause; }
      }
      return seq;
    };
    return storage;
  } });
  const bytes = fixtureFile("binary.bin"); f.files.set("binary.bin", { bytes, mime: "application/octet-stream" }); const input = f.document("binary.bin", undefined, "Only the original complete input"); armed = true;
  await assert.rejects(f.receive(input), error => error === cause || error instanceof SessionFailed); assert.equal(armed, false); await f.p.close();
  for (let reopen = 0; reopen < 2; reopen++) {
    await f.open();
    const media = await f.p.media.message(key); assert.ok(media); assert.equal(media.state, "ready"); assert.equal(media.submissionId, undefined); assert.deepEqual(loadPersonalArtifact(f.profile, media.artifacts[0]), bytes);
    assert.equal((await f.p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))?.receipt, undefined);
    assert.equal(await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, key), context), undefined);
    assert.equal(f.model.calls.length, 0); assert.equal(f.downloads.length, 1); await f.p.close();
  }
  await f.open(); await f.receive(input); const saved = await f.receipt(input); assert.ok(saved.submissionId);
  assert.equal(f.model.calls.length, 1); assert.equal(f.downloads.length, 1); await f.receive(input);
  assert.equal(f.model.calls.length, 1); assert.equal(f.downloads.length, 1);
});

test("Telegram actual question answers delegate only the original entry attachment with unchanged authority", { timeout: 30000 }, async t => {
  let artifact = "";
  const f = await fixture(t, false, undefined, request => {
    const last = request.messages.at(-1), content = last?.content, text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "", call = (name: string, args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ id: randomUUID(), name, arguments: args }] });
    if (request.system?.includes("你是个人助手的子 Agent")) return last?.role === "user" ? call("read_artifact", { artifact }) : { kind: "text", text: "The original attachment was read." };
    if (last?.role === "user" && text.includes("拥有者对原问题的回答")) return call("background_work", { action: "delegate", content: "Read the original after the actual answer", attachments: [artifact] });
    if (last?.role === "user" && text.includes("artifact=")) return call("ask_user", { questions: [{ question: "How should the original be used?" }] });
    return { kind: "text", text: "The task is recorded." };
  });
  await f.open(); f.files.set("binary.bin", { bytes: fixtureFile("binary.bin"), mime: "application/octet-stream" });
  const original = await f.receipt(await f.receive(f.document("binary.bin"))), media = (await f.p.media.message(original.requestId))!; artifact = media.artifacts[0].id;
  const item = (await f.p.harness.commit(tx => personalQuestionList(tx), context)).items[0]; assert.equal(item.status, "pending");
  const question = await f.p.harness.commit(async tx => copy(await personalQuestion(tx, item.id)), context);
  await assert.rejects(f.p.harness.commit(tx => answerPersonalQuestion(tx, { question: question.id, version: question.version, requestId: randomUUID(), answers: [{ text: "Read the original" }] }, { kind: "local" }), context), error => error instanceof PersonalError && error.code === "question_original_entry_required");
  const receive = async (text: string, replyTo?: number) => f.receipt(await f.receive(f.text(text, replyTo)));
  let menu = await receive("/问题"); menu = await receive("问题1", Number(menu.platformMessageId));
  const answered = await receive("Read the complete original without modifying it", Number(menu.platformMessageId)); assert.ok(answered.questionAnswer);
  const current = await f.p.harness.commit(async tx => copy(await personalQuestion(tx, question.id)), context); assert.ok(current.answer);
  await f.p.harness.waitForTask(current.answer.taskId, context);
  const tasks = await f.p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 64), context), input = tasks.items[0]?.input;
  assert.ok(input && typeof input === "object" && !Array.isArray(input) && typeof input.requestId === "string");
  const work = (await f.p.harness.snapshot(PersonalWorkDoc, input.requestId, context))!; assert.ok(work.ref && work.attachments); await f.p.harness.waitForTask(work.ref.taskId, context);
  const sourceKey = `personal-question:${current.answer.taskId}`, grant = await f.p.harness.commit(tx => personalAttachmentGrant(tx, work.attachments!), context);
  assert.equal(work.source?.requestId, sourceKey); assert.deepEqual(work.permission, original.permission); assert.deepEqual(grant.work, work.ref); assert.equal(grant.sourceRequestId, sourceKey);
  assert.deepEqual(grant.attachments, [{ version: 1, artifact: media.artifacts[0], name: "binary.bin", kind: "file", requestId: original.requestId, source: media.source, received: media.accepted }]);
  const child = f.model.calls.find(request => request.system?.includes("你是个人助手的子 Agent") && request.messages.at(-1)?.role === "tool"); assert.ok(child);
  const result = JSON.parse(String(child.messages.at(-1)!.content)) as { base64: string }; assert.deepEqual(Buffer.from(result.base64, "base64"), fixtureFile("binary.bin"));
  await f.p.answer("Native input cannot select the Telegram attachment", "native-question-input");
  await assert.rejects(f.p.harness.commit(tx => preparePersonalAttachments(tx, [artifact], "native-question-input"), context), error => error instanceof PersonalError && error.code === "attachment_original_entry");
  await f.p.close(); await f.open(); assert.deepEqual(await f.p.harness.commit(tx => personalAttachmentGrant(tx, work.attachments!), context), grant);
  await f.p.harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config!.generation = randomUUID(); }, context);
  await assert.rejects(f.p.harness.commit(tx => preparePersonalAttachments(tx, [artifact], sourceKey), context), error => error instanceof PersonalError && error.code === "question_record_invalid");
  assert.deepEqual(loadPersonalArtifact(f.profile, media.artifacts[0]), fixtureFile("binary.bin")); assert.equal(f.downloads.length, 1);
});

test("Telegram group staging rejects every member and caption when an earlier saved original becomes unavailable", async t => {
  for (const mutation of ["missing", "corrupt"] as const) await t.test(mutation, async t => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); t.after(release);
    const f = await fixture(t); await f.open(); const bytes = Buffer.from("abc");
    f.files.set("first.bin", { bytes, mime: "application/octet-stream" }); f.files.set("second.bin", { bytes: Buffer.from("def"), mime: "application/octet-stream", hold: held });
    const input = await f.receive(f.document("first.bin", "unavailable-original", "Never execute this caption without both originals")); await f.receive(f.document("second.bin", "unavailable-original"));
    await f.callback(await f.card((await f.groups())[0]), TELEGRAM_ATTACHMENT_SEND);
    const key = `telegram:123:456:${(input.message as { message_id: number }).message_id}`;
    await until(async () => f.downloads.length === 2 && (await f.p.media.message(key))?.artifacts.length === 1);
    const partial = await f.p.media.message(key); assert.ok(partial); assert.equal(partial.state, "staging");
    const original = partial.artifacts[0], filename = path.join(f.profile, "artifacts", `${original.id}.bin`), retained = path.join(f.profile, "artifacts", `.held-${original.id}`);
    if (mutation === "missing") fs.renameSync(filename, retained); else fs.writeFileSync(filename, Buffer.from("xyz"));
    release();
    try {
      const saved = await f.receipt(input), media = await f.p.media.message(key); assert.ok(media);
      assert.equal(saved.mediaRejected, true); assert.equal(saved.submissionId, undefined); assert.equal(media.state, "rejected"); assert.equal(media.reason, "download_failed");
      assert.equal(await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, key), context), undefined); assert.equal(f.model.calls.length, 0); assert.deepEqual(f.downloads, ["first.bin", "second.bin"]);
      await f.receive(input); assert.equal(f.model.calls.length, 0); assert.equal(f.downloads.length, 2);
    } finally { if (mutation === "missing") fs.renameSync(retained, filename); else fs.writeFileSync(filename, bytes); }
    assert.deepEqual(loadPersonalArtifact(f.profile, original), bytes);
  });
});

test("Telegram bytes lost after receipt commit reject the complete input and report through its original delivery", async t => {
  for (const mutation of ["missing", "corrupt"] as const) await t.test(mutation, async t => {
    const f = await fixture(t), key = "telegram:123:456:11", bytes = fixtureFile("binary.bin"); let armed = false, artifactFile: string | undefined, retainedFile: string | undefined;
    await f.open({ openStorage: async filename => {
      const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
      storage.commit = async (writes, callContext) => {
        const seq = await commit(writes, callContext);
        if (armed && writes.some(write => write.type === "document.create" && write.record.kind === PersonalTelegramReceiptDoc.definition.kind && write.record.key === key)) {
          const record = await storage.findDocument({ kind: PersonalMediaMessageDoc.definition.kind, scope: { kind: "session" }, key }, "current", callContext), saved = record && await storage.document(record.id, "current", callContext), media = saved?.value.message;
          assert.ok(media && typeof media === "object" && !Array.isArray(media) && Array.isArray(media.artifacts) && media.artifacts.length === 1);
          const artifact = media.artifacts[0]; assert.ok(artifact && typeof artifact === "object" && !Array.isArray(artifact) && typeof artifact.id === "string");
          artifactFile = path.join(f.profile, "artifacts", `${artifact.id}.bin`); retainedFile = path.join(f.profile, "artifacts", `.before-input-${artifact.id}`);
          if (mutation === "missing") fs.renameSync(artifactFile, retainedFile); else fs.writeFileSync(artifactFile, Buffer.alloc(bytes.length));
          armed = false;
        }
        return seq;
      };
      return storage;
    } });
    f.files.set("binary.bin", { bytes, mime: "application/octet-stream" }); armed = true;
    const input = await f.receive(f.document("binary.bin", undefined, "Never execute this caption without its original")); assert.equal(armed, false); assert.ok(artifactFile && retainedFile);
    try {
      const saved = await f.receipt(input), media = await f.p.media.message(key); assert.ok(media);
      assert.equal(saved.mediaRejected, true); assert.equal(saved.submissionId, undefined); assert.equal(saved.delivery, "sent"); assert.ok(saved.reply && saved.multipart); assert.match(saved.reply, /本条消息未交给模型/);
      assert.equal(media.state, "rejected"); assert.equal(media.reason, "download_failed"); assert.equal(f.model.calls.length, 0);
      assert.equal(await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, key), context), undefined);
      const delivery = await f.p.harness.commit(async tx => copy(await personalImDeliveryRecord(tx, saved.multipart!)), context); assert.equal(delivery.parent, saved.taskId); assert.equal(delivery.input.messageId, 11); assert.equal(delivery.input.source.generation, f.telegram.generation); assert.equal(delivery.parts.filter(part => part.state === "sent").length, 1);
      assert.equal((await f.p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.telegram-input" }, 64), context)).items.length, 1);
      await f.receive(input); assert.equal(f.model.calls.length, 0); assert.equal(f.downloads.length, 1); assert.equal(f.sends.length, 1);
    } finally { if (mutation === "missing") fs.renameSync(retainedFile, artifactFile); else fs.writeFileSync(artifactFile, bytes); }
    await f.p.close(); await f.open(); const restored = await f.receipt(input); assert.equal(restored.delivery, "sent"); assert.equal(f.model.calls.length, 0); assert.equal(f.downloads.length, 1); assert.equal(f.sends.length, 1);
  });
});
