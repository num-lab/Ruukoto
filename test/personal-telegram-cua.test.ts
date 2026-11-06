import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Task, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { personalCuaLinux, type CuaLinuxGeneration } from "../apps/ruukoto/src/personal-cua-linux.ts";
import { PersonalMcpDoc, verifyMcp } from "../apps/ruukoto/src/personal-mcp.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalDesktopActionsDoc, PersonalDesktopActionDoc } from "../apps/ruukoto/src/personal-desktop-actions.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc, type TelegramReceipt } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalTelegramDisplayDoc, PersonalTelegramDisplaysDoc, type PersonalTelegramDisplay } from "../apps/ruukoto/src/personal-telegram-display-records.ts";
import { PersonalTelegramCallbackDoc } from "../apps/ruukoto/src/personal-telegram-callbacks.ts";
import { personalImDeliveryRecord } from "../apps/ruukoto/src/personal-im-delivery.ts";
import { verifyPersonalTelegram } from "../apps/ruukoto/src/personal-telegram.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { loadPersonalArtifact } from "../apps/ruukoto/src/personal-artifacts.ts";
import { PersonalTelegramCuaImages, personalTelegramCuaImagesDelivered } from "../apps/ruukoto/src/personal-telegram-cua-images.ts";
import { PERSONAL_TELEGRAM_CUA_VIEW } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
const definitions = [{ name: "computer_screenshot", inputSchema: { type: "object", properties: { sandbox: { type: "string" }, hang: { type: "boolean" } }, additionalProperties: false } }];
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 12000; while (!await check()) { assert.ok(Date.now() < end, "Telegram Cua did not settle"); await delay(5); } }

async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-tg-cua-")), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"), callsFile = path.join(root, "calls.jsonl"), schemas = path.join(root, "tools.json");
  fs.mkdirSync(workspace); fs.writeFileSync(callsFile, ""); fs.writeFileSync(schemas, JSON.stringify(definitions)); isolateSkillHome(t);
  const tokenEnv = "TG_CUA_TEST_BOT_KEY", modelEnv = "TG_CUA_TEST_MODEL_KEY", previous = [process.env[tokenEnv], process.env[modelEnv]], token = "123:cua-test-only";
  process.env[tokenEnv] = token; process.env[modelEnv] = "test-only";
  const sends: { messageId: number; text: string }[] = [], stops: CuaLinuxGeneration[] = [], documents: { name: string; mime: string; bytes: Buffer }[] = [];
  let loseDocument = false;
  let platformId = 1000, sequence = 0, stopped = false, generation: CuaLinuxGeneration = { containerId: "b".repeat(64), startedAt: "2026-10-23T01:00:00Z", bootId: "c".repeat(36), pid: 42, processIdentity: "10" };
  const host: ReturnType<typeof personalCuaLinux> = {
    ...personalCuaLinux(), verifyTarget() {}, async generation() { return { ...generation }; }, async stopped() { return stopped; },
    async stop(original) { assert.deepEqual(original, generation); stops.push({ ...original }); stopped = true; return true; },
    async restart() { stopped = false; generation = { ...generation, startedAt: "2026-10-23T02:00:00Z" }; return { ...generation }; },
    prepare(program) { return { scope: `scope-${++sequence}`, description: "Telegram Cua fixture", program }; },
    async execution(scope, description) { return { scope, description, invocationId: "test", group: "/test", dev: 1, ino: 1 }; }, async stopCli() { return true; }, async stopPrepared() { return true; },
    async program() { return { command: process.execPath, args: [fileURLToPath(new URL("./helpers/personal-cua-stdio-fixture.mjs", import.meta.url)), callsFile, schemas], env: { PATH: "/usr/bin:/bin", HOME: directory } }; },
  };
  const bot = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const wire = Buffer.concat(chunks);
    const reply = (result: unknown) => response.end(JSON.stringify({ ok: true, result }));
    if (request.url?.endsWith("/sendDocument")) {
      const form = await new Response(wire, { headers: { "content-type": String(request.headers["content-type"]) } }).formData(), file = form.get("document"); assert.ok(file instanceof File); assert.equal(form.get("chat_id"), "456");
      const bytes = Buffer.from(await file.arrayBuffer()); documents.push({ name: file.name, mime: file.type, bytes });
      if (loseDocument) { loseDocument = false; response.destroy(); return; }
      reply({ message_id: ++platformId, chat: { id: 456, type: "private" }, document: { file_id: "original-scene", file_name: file.name, file_size: bytes.length } }); return;
    }
    const body = JSON.parse(wire.toString()) as Record<string, unknown>;
    if (request.url?.endsWith("/getMe")) { reply({ id: 123, is_bot: true, username: "cua_fixture_bot" }); return; }
    if (request.url?.endsWith("/sendChatAction") || request.url?.endsWith("/answerCallbackQuery")) { reply(true); return; }
    if (request.url?.endsWith("/editMessageText")) { reply({ message_id: body.message_id, chat: { id: 456, type: "private" } }); return; }
    assert.ok(request.url?.endsWith("/sendMessage")); const messageId = ++platformId; sends.push({ messageId, text: String(body.text) }); reply({ message_id: messageId, chat: { id: 456, type: "private" } });
  });
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  let releaseChild: (() => void) | undefined, closing = false, holdActions = false, releaseAction: (() => void) | undefined, actionEntered = false;
  const model = new PersonalMockModelServer(async request => {
    const tail = request.messages.at(-1), last = tail?.role === "user" && Array.isArray(tail.content) ? request.messages.findLast(message => message.role === "tool") : tail, content = String(last?.content);
    if (request.system?.includes("你是个人助手的子 Agent")) {
      if (last?.role === "user" && content.startsWith("调用:")) return { kind: "tool_calls", calls: [{ id: "cua", name: "mcp_call", arguments: JSON.parse(content.slice(3)) }] };
      if (last?.role === "tool" && content.includes("remoteEnded") && !closing) await new Promise<void>(resolve => { releaseChild = resolve; });
    }
    return { kind: "text", text: "完成" };
  });
  const provider = personalProvider({ api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: modelEnv, contextWindow: 128000, maxTokens: 8192, imageInput: true });
  const telegram = { version: 1 as const, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv, tokenDigest: createHash("sha256").update(token).digest("hex"), botId: "123", ownerId: "456", boundary: 0 };
  const mcp = parsePersonalMcp({ version: 3, generation: "original-telegram-cua", services: [{ id: "desktop", label: "Original computer", enabled: true, cua: { kind: "cua-linux", executable: "/usr/local/bin/cua", version: "0.7.0", sha256: "a".repeat(64), sandbox: "local:desktop", sandboxId: "b".repeat(64) }, tools: definitions }] });
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "original-tools", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  let p: PersonalHarness | undefined, inputId = 10;
  const open = async () => {
    p = await openPersonalHarness({ directory, provider, modelId: "mock-model", telegram, mcp, tools, mcpCuaHost: host, mcpTimeouts: { callTimeoutMs: 100 } });
    // The SDK registry erases task types; gate before the canonical action-start transaction.
    const task = p.desktopActions.extension.tasks![0] as Task<{ requestId: string }, { phase: "run" }, null, object>, run = task.definition.phases.run;
    Object.defineProperty(task.definition.phases, "run", { value: async (...args: Parameters<typeof run>) => { if (holdActions) { actionEntered = true; await new Promise<void>(resolve => { releaseAction = resolve; }); } return run(...args); } });
    return p;
  };
  const raw = (text: string, replyTo?: number, extra: Record<string, unknown> = {}): TelegramUpdate => { const id = ++inputId; return { update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }), ...extra } }; };
  const receipt = async (key: string) => (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))?.receipt;
  const sendUpdate = async (update: TelegramUpdate, key: string) => { await p!.telegram.receive(update); const saved = await receipt(key); if (saved) await p!.harness.waitForTask(saved.taskId, context); return { update, key, receipt: await receipt(key) }; };
  const receive = async (text: string, replyTo?: number, extra?: Record<string, unknown>) => { const update = raw(text, replyTo, extra); return sendUpdate(update, `telegram:123:456:${inputId}`); };
  const displays = () => p!.harness.commit(async tx => { const result: PersonalTelegramDisplay[] = []; for (const key of (await tx.doc(PersonalTelegramDisplaysDoc)).keys) result.push(JSON.parse(JSON.stringify((await tx.doc(PersonalTelegramDisplayDoc, key, null)).display!)) as PersonalTelegramDisplay); return result; }, context);
  const messageId = (display: PersonalTelegramDisplay) => p!.harness.commit(async tx => Number((await personalImDeliveryRecord(tx, display.delivery)).parts.at(-1)!.platformMessageId), context);
  const card = async (operation: TaskId, action: string) => {
    let found: PersonalTelegramDisplay | undefined;
    await until(async () => { found = (await displays()).findLast(display => display.target?.operation === operation && !display.edit && display.buttons.some(button => button.action === action)); return !!found && Number.isSafeInteger(await messageId(found)); });
    return found!;
  };
  const callback = async (display: PersonalTelegramDisplay, action: string, extra: Record<string, unknown> = {}) => {
    const button = display.buttons.find(button => button.action === action); assert.ok(button); const id = randomUUID(), platformMessageId = await messageId(display);
    const update: TelegramUpdate = { update_id: ++inputId, callback_query: { id, data: button.token, from: { id: 456, is_bot: false }, message: { message_id: platformMessageId, date: 1, chat: { id: 456, type: "private" }, from: { id: 123, is_bot: true } }, ...extra } };
    const result = await sendUpdate(update, `telegram-callback:123:${id}`); await until(async () => ["sent", "failed", "effect_unknown", "canceled"].includes((await p!.harness.snapshot(PersonalTelegramCallbackDoc, result.key, context))?.ack?.state ?? "")); return result;
  };
  const waitAction = async (value: TelegramReceipt | undefined) => { assert.ok(value?.cuaAction); const key = value.cuaAction.requestId; await until(async () => (await p!.harness.commit(tx => p!.desktopActions.receipt(tx, key), context))?.state !== "admitted"); return (await p!.harness.snapshot(PersonalDesktopActionDoc, key, context))!.action!; };
  const operation = async (id: TaskId) => (await p!.harness.snapshot(PersonalMcpDoc, String(id), context))!.operation!;
  const view = async (id: TaskId) => { const display = await card(id, PERSONAL_TELEGRAM_CUA_VIEW), seen = await callback(display, PERSONAL_TELEGRAM_CUA_VIEW); assert.ok(seen.receipt?.cuaImages && seen.receipt.multipart); await p!.harness.waitForTask(seen.receipt.multipart.taskId, context); return { ...seen, display }; };
  const begin = async (hang = false) => {
    await p!.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
    const source = (await receive("Original computer authority")).receipt!, work = await p!.work.delegate({ requestId: `cua-work:${source.requestId}`, sourceRequestId: source.requestId, content: "调用:" + JSON.stringify({ service: "desktop", tool: "computer_screenshot", arguments: { ...(hang ? { hang: true } : {}) } }) });
    let saved: Awaited<ReturnType<typeof operation>> | undefined;
    await until(async () => { for (const item of (await p!.mcp!.list()).items) { const value = await operation(item.operation); if (value.origin.work?.ref.taskId === work.taskId && value.observation !== undefined) { saved = value; return !((await p!.mcp!.cuaStatus()).busy) && (hang || releaseChild !== undefined); } } return false; });
    assert.ok(saved); assert.equal(saved.origin.telegram?.generation, telegram.generation); assert.equal(saved.origin.source!.requestId, source.requestId); assert.ok(source.accepted); return saved;
  };
  const calls = () => fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { method: string }).filter(item => item.method === "tools/call");
  const hold = (value: boolean) => { holdActions = value; if (value) actionEntered = false; else { releaseAction?.(); releaseAction = undefined; } };
  t.after(async () => { closing = true; releaseChild?.(); hold(false); await p?.close(); bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); await model.close(); for (const [index, key] of [tokenEnv, modelEnv].entries()) if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; fs.rmSync(root, { recursive: true, force: true }); });
  return { open, begin, card, messageId, receive, raw, callback, waitAction, operation, view, calls, stops, sends, documents, telegram, hold, directory, loseDocument: () => { loseDocument = true; }, actionEntered: () => actionEntered, get personal() { return p!; } };
}

test("Telegram Cua callbacks accept the displayed scene and typed resume retains the original IM actor", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(), original = await f.begin(), id = original.operation;
  await p.mcp!.pauseCua(true); const pause = (await f.operation(id)).takeover!.paused;
  const observed = await f.callback(await f.card(id, "观察原电脑现场"), "观察原电脑现场"), observeAction = await f.waitAction(observed.receipt); assert.equal(observeAction.receipt.state, "completed");
  const scene = (await f.operation(id)).takeover!.observation!; assert.ok(scene.images.length);
  await assert.rejects(p.mcp!.recoverCua(id, "accept", scene.entry), { code: "mcp_original_entry" }); assert.equal((await f.operation(id)).takeover!.accepted, undefined); assert.equal(f.documents.length, 0);
  const viewed = await f.view(id); assert.equal(viewed.receipt!.cuaAction, undefined); assert.equal(viewed.receipt!.submissionId, undefined); assert.equal(f.documents.length, scene.images.length); assert.deepEqual(f.documents.map(file => file.bytes), scene.images.map(image => loadPersonalArtifact(f.directory, image))); assert.equal(f.documents[0].mime, scene.images[0].mime);
  assert.equal(await p.harness.commit(tx => personalTelegramCuaImagesDelivered(tx, id, scene.entry, f.telegram, viewed.receipt!.cuaImages!.entry), context), false); assert.equal(await p.harness.commit(tx => personalTelegramCuaImagesDelivered(tx, id, scene.entry, f.telegram), context), true);
  const acceptCard = await f.card(id, "接受原电脑现场"); assert.equal(acceptCard.continuation!.observation, scene.entry);
  const accepted = await f.callback(acceptCard, "接受原电脑现场"), acceptAction = await f.waitAction(accepted.receipt); assert.equal(acceptAction.receipt.state, "completed"); assert.equal(acceptAction.receipt.request.observation, scene.entry);
  const resumeCard = await f.card(id, "继续原电脑工作"), expected = { pause, observation: scene.entry, accepted: (await f.operation(id)).takeover!.accepted };
  await assert.rejects(p.mcp!.pauseCua(false), { code: "mcp_original_entry" }); assert.equal((await p.mcp!.cuaStatus()).paused, true);
  await assert.rejects(p.harness.commit(tx => p.desktopActions.admit(tx, { v: 1, requestId: randomUUID(), family: "mcp", operation: id, admission: original.admission, occurrence: original.admission, action: "resume" }), context), { code: "desktop_action_original_entry" });
  const foreign = await f.callback(resumeCard, "继续原电脑工作", { from: { id: 789, is_bot: false }, message: { message_id: await f.messageId(resumeCard), date: 1, from: { id: 123, is_bot: true }, chat: { id: 789, type: "private" } } }); assert.equal(foreign.receipt, undefined);
  const resumed = await f.receive("继续原电脑工作", await f.messageId(resumeCard)), resumeAction = await f.waitAction(resumed.receipt); assert.equal(resumeAction.receipt.state, "completed");
  assert.deepEqual(resumeAction.actor, { kind: "im", requestId: resumed.key, menuRequestId: resumeCard.key, botId: "123", ownerId: "456", generation: f.telegram.generation, messageId: await f.messageId(resumeCard) });
  assert.deepEqual(resumeAction.continuation, { ...expected, execution: original.cua!.execution }); assert.equal((await p.mcp!.cuaStatus()).paused, false); assert.equal(f.stops.length, 0); assert.equal(f.calls().length, 2);
  assert.equal(accepted.receipt!.permission, undefined); assert.equal(accepted.receipt!.submissionId, undefined);
  await assert.rejects(p.harness.commit(async tx => { delete (await tx.doc(PersonalTelegramReceiptDoc, viewed.key, null)).receipt!.accepted; await verifyPersonalTelegram(tx, [viewed.key], f.telegram); }, context), { code: "telegram_receipt_invalid" });
  await p.harness.commit(tx => p.desktopActions.verify(tx, true), context); await p.harness.commit(tx => verifyMcp(tx, [String(id)]), context);
  await assert.rejects(p.harness.commit(async tx => { delete (await tx.doc(PersonalTelegramReceiptDoc, accepted.key, null)).receipt!.accepted; await p.desktopActions.verify(tx, true); }, context), { code: "desktop_action_stale" });
  await assert.rejects(p.harness.commit(async tx => { delete (await tx.doc(PersonalTelegramReceiptDoc, resumed.key, null)).receipt!.accepted; await verifyPersonalTelegram(tx, [resumed.key], f.telegram); }, context), { code: "telegram_receipt_invalid" });
  await p.telegram.receive(resumed.update); assert.equal(f.calls().length, 2); await p.close(); await f.open();
});

test("Telegram Cua sandbox stopping needs an exact original-card choice and preserves its IM admission", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(), original = await f.begin(true), id = original.operation, card = await f.card(id, "停止原电脑沙箱"), messageId = await f.messageId(card);
  assert.match(card.text, /停止整个电脑沙箱可能丢失其他未保存内容/);
  for (const extra of [{ forward_origin: { type: "user" } }, { reply_to_message: { message_id: messageId, from: { id: 789, is_bot: true } } }]) assert.equal((await f.receive("停止原电脑沙箱", messageId, extra)).receipt?.cuaAction, undefined);
  const ordinary = (await f.receive("好的", messageId)).receipt!;
  assert.equal(ordinary.cuaAction, undefined); assert.equal(ordinary.control, undefined); assert.equal(ordinary.content, "好的"); assert.equal(ordinary.rawContent, undefined); assert.ok(ordinary.submissionId);
  const wrong = await f.callback(card, "停止原电脑沙箱", { message: { message_id: messageId + 999, date: 1, from: { id: 123, is_bot: true }, chat: { id: 456, type: "private" } } }); assert.equal(wrong.receipt, undefined);
  assert.equal(f.stops.length, 0);
  const stopped = await f.receive("停止原电脑沙箱", messageId), action = await f.waitAction(stopped.receipt); assert.equal(action.receipt.state, "completed"); assert.equal(action.receipt.request.action, "stop_sandbox"); assert.equal(action.actor.kind, "im");
  const admission = await p.harness.commit(tx => tx.entry(stopped.receipt!.cuaAction!.entry), context); assert.equal(admission?.kind, "ruukoto.desktop-action-admission"); assert.ok(admission?.data && typeof admission.data === "object" && !Array.isArray(admission.data)); assert.deepEqual(admission.data.actor, action.actor); assert.deepEqual(f.stops, [original.cua!.execution.sandbox]);
  const final = await f.operation(id); assert.ok(final.cua!.recovery!.stopped); assert.equal(final.effect, "no_write"); assert.equal(final.remoteEnded, false);
  await p.telegram.receive(stopped.update); assert.equal(f.stops.length, 1); await p.harness.commit(tx => p.desktopActions.verify(tx, true), context); await p.harness.commit(tx => verifyMcp(tx, [String(id)]), context);
});

test("Telegram Cua rejects old observation callbacks and original-card actions after a later pause", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(), original = await f.begin(), id = original.operation; await p.mcp!.pauseCua(true);
  await f.waitAction((await f.callback(await f.card(id, "观察原电脑现场"), "观察原电脑现场")).receipt); await f.view(id); const oldAccept = await f.card(id, "接受原电脑现场"), oldObservation = oldAccept.continuation!.observation;
  await f.waitAction((await f.receive("观察原电脑现场", await f.messageId(oldAccept))).receipt); assert.notEqual((await f.operation(id)).takeover!.observation!.entry, oldObservation);
  const stale = await f.callback(oldAccept, "接受原电脑现场"); assert.equal(stale.receipt?.cuaAction, undefined); assert.equal((await f.operation(id)).takeover!.accepted, undefined);
  const current = await f.card(id, "观察原电脑现场"); f.hold(true); const queued = await f.callback(current, "观察原电脑现场"); await until(f.actionEntered);
  const oldPause = (await f.operation(id)).takeover!.paused;
  await p.mcp!.recoverCua(id, "observe"); await f.view(id);
  f.hold(false); const queuedAction = await f.waitAction(queued.receipt); assert.equal(queuedAction.receipt.state, "completed"); await f.view(id);
  await f.waitAction((await f.callback(await f.card(id, "接受原电脑现场"), "接受原电脑现场")).receipt); const resumeCard = await f.card(id, "继续原电脑工作");
  await f.waitAction((await f.callback(resumeCard, "继续原电脑工作")).receipt); await p.mcp!.pauseCua(true);
  assert.notEqual((await f.operation(id)).takeover!.paused, oldPause); const calls = f.calls().length;
  assert.equal((await f.receive("观察原电脑现场", await f.messageId(current))).receipt?.cuaAction, undefined); assert.equal(f.calls().length, calls);
  assert.equal(f.calls().length, calls); assert.equal((await p.mcp!.cuaStatus()).paused, true);
  await p.harness.commit(tx => p.desktopActions.verify(tx, true), context);
});

test("Telegram Cua queued resume loses authority when its original entry generation changes", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(), original = await f.begin(), id = original.operation; await p.mcp!.pauseCua(true);
  await f.waitAction((await f.callback(await f.card(id, "观察原电脑现场"), "观察原电脑现场")).receipt); await f.view(id); await f.waitAction((await f.callback(await f.card(id, "接受原电脑现场"), "接受原电脑现场")).receipt);
  f.hold(true); const queued = await f.receive("继续原电脑工作", await f.messageId(await f.card(id, "继续原电脑工作"))); await until(f.actionEntered);
  await p.harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config!.generation = "replacement-entry"; }, context); const calls = f.calls().length; f.hold(false);
  const action = await f.waitAction(queued.receipt); assert.equal(action.receipt.state, "failed"); assert.equal(action.receipt.code, "desktop_action_stale"); assert.equal((await p.mcp!.cuaStatus()).paused, true); assert.equal(f.calls().length, calls);
  await p.harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config = f.telegram; }, context); await p.harness.commit(tx => p.desktopActions.verify(tx, true), context);
});

test("A typed Telegram Cua task-creation failure rolls back the action admission and owner receipt", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(), original = await f.begin(), id = original.operation; await p.mcp!.pauseCua(true); const card = await f.card(id, "观察原电脑现场"), update = f.raw("观察原电脑现场", await f.messageId(card)), key = `telegram:123:456:${update.update_id}`;
  let injected = false; const commit = p.harness.commit.bind(p.harness), mock = t.mock.method(p.harness, "commit", (change: (tx: Tx) => unknown | Promise<unknown>, callContext: typeof context) => commit(async tx => {
    const create = tx.createTask.bind(tx), taskMock = t.mock.method(tx, "createTask", (...args: Parameters<Tx["createTask"]>) => { if (args[0].definition.name === "ruukoto.desktop-action" && !injected) { injected = true; throw new PersonalError("test_cua_task_failure", "Injected task creation failure after action admission"); } return create(...args); });
    try { return await change(tx); } finally { taskMock.mock.restore(); }
  }, callContext));
  try { await assert.rejects(p.telegram.receive(update), { code: "test_cua_task_failure" }); } finally { mock.mock.restore(); }
  assert.equal(injected, true); assert.equal((await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))?.receipt, undefined); assert.deepEqual((await p.harness.snapshot(PersonalDesktopActionsDoc, context))?.requests ?? [], []);
  const entries = await p.harness.commit(tx => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256), context); assert.equal(entries.items.filter(entry => entry.kind === "ruukoto.desktop-action-admission").length, 0); assert.equal(f.calls().length, 1);
  await p.telegram.receive(update); const receipt = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!, action = await f.waitAction(receipt); assert.equal(action.receipt.state, "completed"); assert.equal(f.calls().length, 2);
  await p.harness.commit(tx => p.desktopActions.verify(tx, true), context);
});

test("Telegram accepts a recovery scene only after exact image delivery and preserves unknown view attempts", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(), original = await f.begin(), id = original.operation; await p.mcp!.pauseCua(true);
  await f.waitAction((await f.callback(await f.card(id, "观察原电脑现场"), "观察原电脑现场")).receipt);
  const first = await f.card(id, PERSONAL_TELEGRAM_CUA_VIEW), scene = (await f.operation(id)).takeover!.observation!;
  assert.equal(first.buttons.some(button => button.action === "接受原电脑现场"), false);
  assert.equal((await f.receive("接受原电脑现场", await f.messageId(first))).receipt?.cuaAction, undefined);
  const calls = f.calls().length; f.loseDocument(); const lost = await f.view(id), ledger = await p.imDelivery.get(lost.receipt!.multipart!);
  assert.equal(ledger.parts.at(-1)!.state, "effect_unknown"); assert.equal(f.documents.length, 1); assert.equal((await f.operation(id)).takeover!.accepted, undefined);
  assert.equal((await f.receive("接受原电脑现场", await f.messageId(first))).receipt?.cuaAction, undefined); assert.equal(f.calls().length, calls);
  const oldRequest = (await p.harness.commit(tx => tx.entry(PersonalTelegramCuaImages, lost.receipt!.cuaImages!.entry), context))!;
  assert.equal(oldRequest.data.observation, scene.entry); assert.deepEqual(oldRequest.data.images, scene.images);
  await p.close(); const reopened = await f.open(); assert.equal(f.documents.length, 1); assert.equal(f.calls().length, calls);
  const reread = await f.view(id); assert.equal((await reopened.imDelivery.get(reread.receipt!.multipart!)).parts.at(-1)!.state, "sent"); assert.equal(f.documents.length, 2); assert.deepEqual(f.documents[0].bytes, f.documents[1].bytes);
  assert.equal((await reopened.imDelivery.get(lost.receipt!.multipart!)).parts.at(-1)!.state, "effect_unknown");
  await f.waitAction((await f.callback(await f.card(id, "接受原电脑现场"), "接受原电脑现场")).receipt); assert.equal(f.calls().length, calls);
});

test("Telegram rejects orphan recovery-image deliveries before dispatch and reopen", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(), original = await f.begin(), id = original.operation; await p.mcp!.pauseCua(true);
  await f.waitAction((await f.callback(await f.card(id, "观察原电脑现场"), "观察原电脑现场")).receipt); const viewed = await f.view(id), source = { botId: f.telegram.botId, ownerId: f.telegram.ownerId, generation: f.telegram.generation }, before = f.documents.length;
  const image = (await f.operation(id)).takeover!.observation!.images[0], orphan = await p.harness.commit(tx => p.imDelivery.request(tx, { key: "telegram-cua-images:telegram:123:456:999", source, messageId: 999, text: "Unrequested scene", outputs: [{ recovery: { requestId: "telegram:123:456:999", image: image.id } }] }), context);
  p.harness.resume(); const task = await p.harness.waitForTask(orphan.taskId, context); assert.equal(task.state.outcome.status, "faulted"); assert.equal(f.documents.length, before);
  await assert.rejects(p.close().then(() => f.open()), { code: "telegram_cua_images_invalid" });
  assert.ok(viewed.receipt!.cuaImages!.entry > 0);
});
