import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type SubmissionId, type Task, type TaskId } from "@earendil-works/pi-durable";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalImApiError, type PersonalImAccess, type PersonalImKeyboard } from "../apps/ruukoto/src/personal-im-api.ts";
import { personalImDelivery } from "../apps/ruukoto/src/personal-im-delivery.ts";
import { authorizePersonalTelegramDisplay, personalTelegramDisplays, personalTelegramReceiptDisplay, personalTelegramTarget, preparePersonalTelegramReceiptDisplay, requestPersonalTelegramDisplay, validatePersonalTelegramDisplayAction, verifyPersonalTelegramDisplays } from "../apps/ruukoto/src/personal-telegram-displays.ts";
import { PersonalTelegramDisplayAdmission, PersonalTelegramDisplayDoc, PersonalTelegramDisplaysDoc, type PersonalTelegramDisplay } from "../apps/ruukoto/src/personal-telegram-display-records.ts";
import { personalTelegramDisplaySelection } from "../apps/ruukoto/src/personal-telegram-selection.ts";
import { PERSONAL_TELEGRAM_CUA_VIEW, PersonalTelegramDoc, PersonalTelegramReceiptDoc, type PersonalEntryIdentity, type TelegramControlInput, type TelegramResult } from "../apps/ruukoto/src/personal-telegram-records.ts";
import type { PersonalTelegramApi } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { PersonalToolsDoc, PersonalToolDoc, ToolAdmission, toolOperation } from "../apps/ruukoto/src/personal-tools.ts";
import { PersonalMcpConfigDoc, PersonalMcpDoc, McpAdmission } from "../apps/ruukoto/src/personal-mcp.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { BrowserAdmission, PersonalBrowserDoc, PersonalBrowserOperationDoc } from "../apps/ruukoto/src/personal-browser.ts";

const context = BACKGROUND_CONTEXT;
const source: PersonalEntryIdentity = { botId: "123", ownerId: "456", generation: "original-generation" };
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 8000; while (!await check()) { assert.ok(Date.now() < end, "Display did not reach the expected state"); await delay(5); } }
async function fixture(t: TestContext, options: { unknownSend?: boolean; edit?: () => Promise<void> } = {}) {
  const models = recordedModels(personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "DISPLAY_UNUSED_MODEL_KEY", contextWindow: 4096, maxTokens: 1024 }), async () => assert.fail("Projecting a Telegram display never calls a model"));
  let harness!: Harness;
  const sends: { text: string; messageId: string; keyboard?: PersonalImKeyboard }[] = [], edits: { messageId: number; text: string }[] = [];
  const transport: PersonalTelegramApi = {
    async me() { return { id: source.botId, username: "unused" }; }, async updates() { return []; },
    photo(input) { return { ...input, async download() { assert.fail("Display does not download an input photo"); } }; },
    async send(ownerId, _replyTo, text, _signal, keyboard) { assert.equal(ownerId, source.ownerId); const messageId = String(1000 + sends.length); sends.push({ text, messageId, ...(keyboard ? { keyboard } : {}) }); if (options.unknownSend) throw new PersonalImApiError("telegram_unverified", "Unverified send", "effect_unknown"); return messageId; },
    async document() { assert.fail("A display does not publish a file"); }, async answerCallback() {}, async typing() {},
    async edit(ownerId, messageId, text) { assert.equal(ownerId, source.ownerId); edits.push({ messageId, text }); await options.edit?.(); },
  };
  const im: PersonalImAccess = { async withEntry(_source, action) { return action(); }, sender: () => transport, configurationVersion: () => "original", isActive: candidate => candidate.generation === source.generation && candidate.botId === source.botId && candidate.ownerId === source.ownerId };
  const cards = personalTelegramDisplays(() => harness, im, () => transport), delivery = personalImDelivery(() => harness, im, undefined, authorizePersonalTelegramDisplay), registry = createRegistry(); registry.install(cards.extension); registry.install(delivery.extension);
  const ownerInput = defineTask<{ requestId: string }, { phase: "run" }, TelegramResult>({ name: "ruukoto.telegram-input", version: 1, initial: () => ({ phase: "run" }), phases: { async run(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { delivery: "sent" } } }), callContext); } }, async abort(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext); } });
  registry.install(defineExtension({ name: "test-display-source", tasks: [ownerInput] }));
  harness = await Harness.open(new MemoryStorage(), { registry, models }, context); await harness.root(context);
  t.after(async () => { await cards.close(); await harness.close(context); });
  const operation = 500 as TaskId;
  const initial = await harness.commit(async tx => {
    (await tx.doc(PersonalTelegramDoc)).config = { version: 1, enabled: true, ...source, apiBase: "http://127.0.0.1:1", tokenEnv: "UNUSED", tokenDigest: "0".repeat(64), boundary: 0 };
    const original = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: "Original exact operation", timestamp: 1 }] })).id;
    const ownerTask = await tx.createTask(ownerInput, { requestId: "original" }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
    (await tx.doc(PersonalTelegramReceiptDoc, "original", null)).receipt = { ...source, taskId: ownerTask, requestId: "original", messageId: 99, updateId: 99, content: "Original exact operation", direct: true, permission: { mode: "confirm", version: 1 }, delivery: "sent", accepted: original };
    const origin = { conversationId: ROOT_CONVERSATION_ID, generation: 499 as TaskId, inputs: [], sources: [], source: { entryId: original, requestId: "original", submissionId: 1 as SubmissionId }, permission: { mode: "confirm" as const, version: 1 }, telegram: { ...source, mode: "confirm" as const, version: 1 } };
    const admitted = { operation, origin, kind: "http_request" as const, params: { method: "POST", url: "http://127.0.0.1:1/original", body: "exact body" }, prepared: { kind: "http" as const, request: { method: "POST", url: "http://127.0.0.1:1/original", body: "exact body", headers: {}, pinnedAddress: "127.0.0.1", pinnedFamily: 4 } }, grantVersion: 1, approval: "pending" as const };
    const admission = (await tx.appendEntry(ToolAdmission, ROOT_CONVERSATION_ID, { data: admitted })).id;
    (await tx.doc(PersonalToolsDoc)).operations.push(operation); (await tx.doc(PersonalToolDoc, String(operation), null)).operation = { ...admitted, admission, started: false, stopped: true, effect: "not_executed", code: "awaiting_approval" };
    return { original, admission, origin };
  }, context);
  const target = { family: "tools" as const, operation, admission: initial.admission, occurrence: initial.admission };
  const displays = () => harness.commit(async tx => { const result: PersonalTelegramDisplay[] = []; for (const key of (await tx.doc(PersonalTelegramDisplaysDoc)).keys) result.push(copyJson((await tx.doc(PersonalTelegramDisplayDoc, key, null)).display!) as PersonalTelegramDisplay); return result; }, context);
  const input = (display: PersonalTelegramDisplay, content: string, token?: string): TelegramControlInput => ({ ...source, requestId: token ? "telegram-callback:123:test-query" : "telegram:123:456:101", messageId: token ? Number(sends.find(send => send.keyboard?.some(row => row.some(button => button.callback_data === token)))!.messageId) : 101, updateId: 101, content, direct: true, replyTo: Number(sends.find(send => send.text === display.text)!.messageId), replyBotId: source.botId, delivery: "waiting", ...(token ? { callback: { queryId: "test-query", token, display: display.key } } : {}) });
  return { harness, cards, delivery, transport, sends, edits, registry, ownerInput, operation, target, initial, displays, input };
}

test("Telegram transition displays reuse one operation and invalidate old callbacks without replaying sends", async t => {
  const f = await fixture(t); await f.cards.start(); await until(() => f.sends.length === 1);
  const pending = (await f.displays())[0]; assert.deepEqual(pending.buttons.map(button => button.action), ["工具批准本次", "工具拒绝"]);
  const approve = f.input(pending, pending.buttons[0].action, pending.buttons[0].token); assert.equal(await f.harness.commit(tx => validatePersonalTelegramDisplayAction(tx, approve), context), true);
  await f.harness.commit(async tx => { const value = await toolOperation(tx, f.operation); value.approval = "approved"; value.started = true; value.stopped = false; value.effect = "effect_unknown"; value.code = "http_timeout"; value.observation = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test-original-observation", data: { operation: f.operation } })).id; }, context);
  await until(async () => (await f.displays()).length === 2 && f.edits.length === 1 && (await f.displays())[0].edit?.state === "sent");
  const recovery = (await f.displays())[1]; assert.deepEqual(recovery.target, pending.target); assert.notEqual(recovery.key, pending.key); assert.deepEqual(recovery.buttons.map(button => button.action), ["工具确认已生效", "工具确认未生效", "核实工具原请求结束"]);
  assert.equal(await f.harness.commit(tx => validatePersonalTelegramDisplayAction(tx, approve), context), false);
  await f.harness.commit(tx => verifyPersonalTelegramDisplays(tx), context); await f.harness.commit(tx => f.delivery.verify(tx), context);
  await f.cards.close(); const reopened = personalTelegramDisplays(() => f.harness, { withEntry: async (_source, action) => action(), sender: () => f.transport, isActive: () => true, configurationVersion: () => "original" }, () => f.transport);
  t.after(() => reopened.close()); await reopened.start(); await delay(25); assert.equal(f.sends.length, 2); assert.equal(f.edits.length, 1);
});

test("Receipt display preparation precedes writes and committed acknowledgements retain delivery", async t => {
  const f = await fixture(t); await f.cards.start(); await until(() => f.sends.length === 1); const pending = (await f.displays())[0];
  const value = f.input(pending, "工具批准本次");
  const displayKey = await f.harness.commit(async tx => {
    const previous = await personalTelegramDisplaySelection(tx, value), preparation = await preparePersonalTelegramReceiptDisplay(tx, value, previous);
    const current = await toolOperation(tx, f.operation); current.approval = "approved"; current.decisionEntry = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test-decision" })).id;
    value.control = true; value.toolDecision = { operation: f.operation, decision: "approved" }; value.selection = { kind: "tool", operation: f.operation }; value.reply = "Your choice was saved.";
    value.accepted = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.telegram-received", data: { requestId: value.requestId, generation: value.generation } })).id;
    const ref = await personalTelegramReceiptDisplay(tx, value, preparation); assert.ok(ref);
    (await tx.doc(PersonalTelegramReceiptDoc, value.requestId, null)).receipt = { ...value, taskId: await tx.createTask(f.ownerInput, { requestId: value.requestId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }), multipart: ref };
    return value.display!;
  }, context);
  const display = (await f.displays()).find(display => display.key === displayKey)!; assert.equal(display.buttons.length, 0); f.harness.resume(); assert.equal((await f.delivery.wait(display.delivery)).textState, "sent");
  await f.harness.commit(tx => verifyPersonalTelegramDisplays(tx), context);
});

test("Persisted source/token/card checks reject forwarded, wrong-card and wrong-generation callbacks while typed prose remains chat", async t => {
  const f = await fixture(t); await f.cards.start(); await until(() => f.sends.length === 1); const display = (await f.displays())[0], button = display.buttons[0], value = f.input(display, button.action, button.token);
  for (const change of [{ direct: false }, { replyTo: value.replyTo! + 1 }, { replyBotId: "999" }, { generation: "other" }, { ownerId: "999" }, { callback: { ...value.callback!, token: display.buttons[1].token } }]) assert.equal(await f.harness.commit(tx => validatePersonalTelegramDisplayAction(tx, { ...value, ...change }), context), false);
  assert.equal(await f.harness.commit(tx => validatePersonalTelegramDisplayAction(tx, f.input(display, "Can you also review the result?")), context), true);
  const copied = { ...f.input(display, button.action, button.token), content: "工具确认已生效" }; assert.equal(await f.harness.commit(tx => validatePersonalTelegramDisplayAction(tx, copied), context), false);
});

test("Display requests compare the complete immutable input before reusing tokens", async t => {
  const f = await fixture(t), projection = (await f.harness.commit(async tx => copyJson((await personalTelegramTarget(tx, f.target, source))!), context)) as NonNullable<Awaited<ReturnType<typeof personalTelegramTarget>>>;
  const input = { key: "explicit-original", source, messageId: 99, selection: projection.selection, text: projection.text, actions: projection.actions, origin: f.initial.admission, target: f.target, binding: projection.binding, transition: projection.transition };
  const first = await f.harness.commit(async tx => copyJson(await requestPersonalTelegramDisplay(tx, input)), context); assert.deepEqual(await f.harness.commit(async tx => copyJson(await requestPersonalTelegramDisplay(tx, input)), context), first);
  for (const changed of [{ text: input.text + " altered" }, { messageId: 100 }, { actions: input.actions.slice(1) }, { origin: f.initial.original }, { selection: { kind: "tool" as const, operation: 999 as TaskId } }]) await assert.rejects(f.harness.commit(tx => requestPersonalTelegramDisplay(tx, { ...input, ...changed }), context), { code: "telegram_display_conflict" });
  await f.harness.commit(tx => verifyPersonalTelegramDisplays(tx), context);
});

test("Explicit redisplay issues new tokens for exact original text without inventing a business selection receipt", async t => {
  const f = await fixture(t); await f.cards.start(); await until(() => f.sends.length === 1); const original = (await f.displays())[0], value = f.input(original, "重新显示");
  const ref = await f.harness.commit(async tx => {
    const previous = await personalTelegramDisplaySelection(tx, value), preparation = await preparePersonalTelegramReceiptDisplay(tx, value, previous);
    value.control = true; value.reply = original.text; value.redisplay = { display: original.key }; value.accepted = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.telegram-received", data: { requestId: value.requestId, generation: value.generation } })).id;
    const ref = await personalTelegramReceiptDisplay(tx, value, preparation); assert.ok(ref); assert.equal(value.selection, undefined);
    (await tx.doc(PersonalTelegramReceiptDoc, value.requestId, null)).receipt = { ...value, multipart: ref, taskId: await tx.createTask(f.ownerInput, { requestId: value.requestId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }) }; return ref;
  }, context);
  f.harness.resume(); assert.equal((await f.delivery.wait(ref)).textState, "sent"); const redisplay = (await f.displays()).find(display => display.key === value.display)!;
  assert.deepEqual(redisplay.selection, original.selection); assert.deepEqual(redisplay.target, original.target); assert.deepEqual(redisplay.binding, original.binding); assert.equal(redisplay.text, original.text); assert.notEqual(redisplay.buttons[0].token, original.buttons[0].token);
  await f.harness.commit(tx => verifyPersonalTelegramDisplays(tx), context);
});

test("Unknown terminal edits retain one attempt and never restore current approval", async t => {
  const f = await fixture(t, { async edit() { throw new PersonalImApiError("telegram_unverified", "Unknown edit", "effect_unknown"); } }); await f.cards.start(); await until(() => f.sends.length === 1); const original = (await f.displays())[0];
  await f.harness.commit(async tx => { const value = await toolOperation(tx, f.operation); value.approval = "rejected"; value.code = "owner_rejected"; }, context);
  await until(async () => (await f.displays())[0].edit?.state === "effect_unknown"); assert.equal(f.edits.length, 1); await f.harness.commit(tx => verifyPersonalTelegramDisplays(tx), context);
  await f.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test-unrelated-event" }), context); await delay(25); assert.equal(f.edits.length, 1);
  assert.equal(await f.harness.commit(tx => validatePersonalTelegramDisplayAction(tx, f.input(original, original.buttons[0].action, original.buttons[0].token)), context), false);
});

test("Terminal edit observation commit faults recover unknown once and preserve the original decision", async t => {
  const f = await fixture(t), task = f.cards.extension.tasks![0] as Task<{ key: string }, { phase: "send" } | { phase: "verify" }, null, object>, send = task.definition.phases.send;
  t.mock.method(task.definition.phases, "send", async (...[current, runtime, callContext]: Parameters<typeof send>) => { let commits = 0; return send(current, { ...runtime, async commit(...args) { if (++commits === 2) throw new Error("Injected terminal edit observation commit failure"); return runtime.commit(...args); } }, callContext); });
  await f.cards.start(); await until(() => f.sends.length === 1); const original = (await f.displays())[0];
  const decision = await f.harness.commit(async tx => { const value = await toolOperation(tx, f.operation); value.approval = "rejected"; value.code = "owner_rejected"; value.decisionEntry = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test-original-decision", data: { operation: f.operation, decision: "rejected" } })).id; return value.decisionEntry; }, context);
  await until(async () => !!(await f.displays())[0].edit); const edit = (await f.displays())[0].edit!, settled = await f.harness.waitForTask(edit.taskId, context);
  assert.equal(settled.state.outcome.status, "faulted"); const before = (await f.displays())[0].edit!; assert.equal(before.state, "sending"); assert.ok(before.claim); assert.equal(before.observation, undefined); assert.equal(f.edits.length, 1);
  await f.harness.commit(tx => verifyPersonalTelegramDisplays(tx), context); const after = (await f.displays())[0].edit!;
  assert.equal(after.state, "effect_unknown"); assert.ok(after.observation! > before.claim!); assert.deepEqual((await f.harness.getTask(edit.taskId, context))!.state, settled.state);
  await f.harness.commit(async tx => { const value = await toolOperation(tx, f.operation); assert.equal(value.approval, "rejected"); assert.equal(value.decisionEntry, decision); assert.deepEqual((await tx.entry(decision))!.data, { operation: f.operation, decision: "rejected" }); }, context);
  assert.equal(await f.harness.commit(tx => validatePersonalTelegramDisplayAction(tx, f.input(original, original.buttons[0].action, original.buttons[0].token)), context), false);
  await f.harness.commit(tx => verifyPersonalTelegramDisplays(tx), context); await f.cards.close();
  const reopened = personalTelegramDisplays(() => f.harness, { withEntry: async (_source, action) => action(), sender: () => f.transport, isActive: () => true, configurationVersion: () => "original" }, () => f.transport); t.after(() => reopened.close());
  await reopened.start(); await delay(25); assert.equal(f.edits.length, 1); assert.equal((await f.displays())[0].edit!.observation, after.observation);
});

test("The display verifier rejects orphan immutable entries and invented edit success", async t => {
  const f = await fixture(t); await f.cards.start(); await until(() => f.sends.length === 1); const original = (await f.displays())[0];
  await assert.rejects(f.harness.commit(async tx => { (await tx.doc(PersonalTelegramDisplayDoc, original.key, null)).display!.edit = { taskId: original.delivery.taskId, admission: original.admission, text: "Invented success", state: "sent" }; await verifyPersonalTelegramDisplays(tx); }, context), { code: "telegram_display_invalid" });
  await f.harness.commit(async tx => { const { admission: _admission, edit: _edit, ...fixed } = original; await tx.appendEntry(PersonalTelegramDisplayAdmission, ROOT_CONVERSATION_ID, { data: { ...fixed, key: "orphan-original" } }); }, context);
  await assert.rejects(f.harness.commit(tx => verifyPersonalTelegramDisplays(tx), context), { code: "telegram_display_invalid" });
});

test("Cua recovery displays require image viewing and bind observation; browser pause exposes its original resume", async t => {
  const f = await fixture(t), operation = 700 as TaskId;
  const cuaConfig = parsePersonalMcp({ version: 3, generation: "original-cua", services: [{ id: "computer", label: "Original computer", enabled: true, cua: { kind: "cua-linux", executable: "/tmp/unused-computer-cli", version: "0.7.0", sha256: "a".repeat(64), sandbox: "local:original", sandboxId: "b".repeat(64) }, tools: [{ name: "computer_click", inputSchema: { type: "object" } }] }] });
  const admission = await f.harness.commit(async tx => {
    const admitted = { operation, origin: f.initial.origin, config: cuaConfig, service: "computer", tool: "computer_click", args: {} }, admission = (await tx.appendEntry(McpAdmission, ROOT_CONVERSATION_ID, { data: admitted })).id;
    (await tx.doc(PersonalMcpConfigDoc)).operations.push(operation); (await tx.doc(PersonalMcpConfigDoc)).config = cuaConfig;
    const pause = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.mcp-cua-pause", data: { paused: true, operation } })).id, observation = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test-original-observation" })).id;
    (await tx.doc(PersonalMcpConfigDoc)).cuaPause = { paused: true, entry: pause, operation };
    (await tx.doc(PersonalMcpDoc, String(operation), null)).operation = { ...admitted, admission, decision: "approved", started: true, remoteEnded: true, effect: "returned", code: "returned", evidence: {}, takeover: { version: 1, paused: pause, observation: { entry: observation, execution: { cli: { scope: "unused.scope", description: "Original", invocationId: "original", group: "original", dev: 1, ino: 1 }, sandbox: { containerId: "b".repeat(64), startedAt: "original", bootId: "original", pid: 1, processIdentity: "original" } }, images: [], evidence: {} } } }; return admission;
  }, context);
  const target = { family: "mcp" as const, operation, admission, occurrence: admission }, projection = await f.harness.commit(async tx => copyJson((await personalTelegramTarget(tx, target, source))!) as NonNullable<Awaited<ReturnType<typeof personalTelegramTarget>>>, context);
  assert.ok(projection.actions.some(action => action.action === "观察原电脑现场")); assert.ok(projection.actions.some(action => action.action === PERSONAL_TELEGRAM_CUA_VIEW)); assert.equal(projection.actions.some(action => action.action === "接受原电脑现场"), false); assert.ok(projection.continuation?.observation);
  const display = await f.harness.commit(tx => requestPersonalTelegramDisplay(tx, { key: "original-cua-display", source, messageId: 99, selection: projection.selection, text: projection.text, actions: projection.actions, target, binding: projection.binding, continuation: projection.continuation, transition: projection.transition, origin: admission }), context); f.harness.resume(); await f.delivery.wait(display.delivery);
  const view = display.buttons.find(button => button.action === PERSONAL_TELEGRAM_CUA_VIEW)!, value = f.input(display, view.action, view.token); assert.equal(await f.harness.commit(tx => validatePersonalTelegramDisplayAction(tx, value), context), true);
  await f.harness.commit(async tx => { const current = (await tx.doc(PersonalMcpDoc, String(operation), null)).operation!; current.takeover!.observation!.entry = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test-new-observation" })).id; }, context); assert.equal(await f.harness.commit(tx => validatePersonalTelegramDisplayAction(tx, value), context), false);
  const browser = 800 as TaskId, browserAdmission = await f.harness.commit(async tx => {
    const admitted = { operation: browser, origin: f.initial.origin, params: { action: "pause" as const }, config: { version: 1 as const, generation: "original-browser", binaryPath: "/tmp/unused-browser", chromePath: "/tmp/unused-chrome", headed: true } }, admission = (await tx.appendEntry(BrowserAdmission, ROOT_CONVERSATION_ID, { data: admitted })).id;
    (await tx.doc(PersonalBrowserDoc)).operations.push(browser); (await tx.doc(PersonalBrowserDoc)).pause = { operation: browser, entry: admission, submission: 1 as SubmissionId }; (await tx.doc(PersonalBrowserDoc)).stateJson = JSON.stringify({ version: 1, bindings: [{ sessionId: String(ROOT_CONVERSATION_ID), state: "paused" }] }); (await tx.doc(PersonalBrowserDoc)).bindingEntry = admission;
    (await tx.doc(PersonalBrowserOperationDoc, String(browser), null)).operation = { ...admitted, admission, started: true, stopped: false, effect: "effect_unknown", code: "started" }; return admission;
  }, context);
  const browserProjection = (await f.harness.commit(tx => personalTelegramTarget(tx, { family: "browser", operation: browser, admission: browserAdmission, occurrence: browserAdmission }, source), context))!; assert.ok(browserProjection.actions.some(action => action.action === "继续原浏览器工作")); assert.equal(browserProjection.continuation?.pause, browserAdmission);
});
