import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID, type Harness, type ConversationId, type EntryId } from "@earendil-works/pi-durable";
import { BrowserManager, BrowserError, type BrowserBinding } from "@ruukoto/agent/browser-manager.ts";
import { personalBrowser, configureBrowser, browserOperations, browserRequestAllowed, browserSessionStopped, browserDetail, browserResolve, browserSourceBlocker, PersonalBrowserOperationDoc, PersonalBrowserDoc, PersonalBrowserSessionDoc, verifyBrowser, type PersonalBrowserOperation } from "../apps/ruukoto/src/personal-browser.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { appendPersonalWork, PersonalWorkDoc, personalWorkNoteSource, personalWorkResult, requestPersonalWorkCancel } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalInteractiveResourceDoc } from "../apps/ruukoto/src/personal-interactive.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { loadPersonalArtifact } from "../apps/ruukoto/src/personal-artifacts.ts";
import { parsePersonalBrowser, savePersonalBrowser, readPersonalBrowser } from "../apps/ruukoto/src/personal-browser-config.ts";
import { PersonalSchedulesDoc, PersonalScheduleRunDoc, SCHEDULE_INPUT } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const invoke = (action: string, args: Record<string, unknown> = {}) => `browser:${JSON.stringify({ action, ...args })}`;
const responder: Responder = request => { const last = request.messages.at(-1), value = String(last?.content); return last?.role === "user" && value.startsWith("browser:") ? { kind: "tool_calls", calls: [{ id: "browser-call", name: "browser", arguments: JSON.parse(value.slice(8)) }] } : { kind: "text", text: value }; };
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < end, "等待浏览器状态超时"); await delay(5); } }
function binding(session = String(ROOT_CONVERSATION_ID), directory?: string): BrowserBinding { const id = directory && createHash("sha256").update(`${directory}\0${session}`).digest("hex").slice(0, 24); return { sessionId: session, generation: "first", kind: "owned", state: "ready", profileDir: null, socketDir: id ? `/tmp/ruukoto-browser-${process.getuid?.() ?? "unknown"}-${id}` : "", cliSession: id ? `rk-${id}` : "", cdpUrl: null, targetId: null, chrome: null, daemon: null, dashboard: null, chromePending: false, daemonPending: false, dashboardPending: false, lockDir: null, pauseTaskId: null, pauseAfterSeq: null, outcomeUnknown: false, failureCode: null, dashboardUrl: null, headed: false }; }
async function fixture(t: TestContext, respond = responder) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-browser-"))), directory = path.join(root, "profile"), model = new MockModelServer(respond);
  const modelConfig: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RK_BROWSER_TEST_KEY", contextWindow: 128000, maxTokens: 8192, imageInput: true }, previousKey = process.env[modelConfig.apiKeyEnv]; process.env[modelConfig.apiKeyEnv] = "test-only";
  let harness: Harness, current = binding(String(ROOT_CONVERSATION_ID), directory), calls = 0, closes = 0;
  const states = new Map<string, BrowserBinding>(), commandSessions: string[] = [], closeSessions: string[] = [], imageSources: ConversationId[] = [];
  const state = (session: string) => { if (session === String(ROOT_CONVERSATION_ID)) return current; if (!states.has(session)) states.set(session, binding(session, directory)); return states.get(session)!; };
  async function persistBinding(session: string) { if (!harness) return; await harness.commit(async tx => { const value = state(session), stateJson = JSON.stringify({ version: 1, bindings: [value] }), conversationId = Number(session) as ConversationId, doc = conversationId === ROOT_CONVERSATION_ID ? await tx.doc(PersonalBrowserDoc) : await tx.doc(PersonalBrowserSessionDoc, session, null); doc.stateJson = stateJson; doc.bindingEntry = (await tx.appendEntry(conversationId, { kind: "ruukoto.browser-binding-changed", data: { stateJson, sessionId: session, generation: value.generation, state: value.state } })).id; }, context); }
  const previous = { command: BrowserManager.prototype.command, status: BrowserManager.prototype.status, pause: BrowserManager.prototype.pause, resume: BrowserManager.prototype.resume, close: BrowserManager.prototype.close };
  BrowserManager.prototype.status = session => structuredClone(state(session));
  BrowserManager.prototype.close = async session => { closes++; closeSessions.push(session); state(session).state = "closed"; await persistBinding(session); return true; };
  BrowserManager.prototype.pause = async (session, task) => { const value = state(session); value.state = "paused"; value.pauseTaskId = task; await persistBinding(session); return structuredClone(value); };
  BrowserManager.prototype.resume = async session => { const value = state(session); value.state = "ready"; value.generation = "resumed"; await persistBinding(session); return structuredClone(value); };
  BrowserManager.prototype.command = async (session, args) => { calls++; commandSessions.push(session); await persistBinding(session); if (args[0] === "screenshot") fs.writeFileSync(args[1], Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex")); return { data: { refs: { e1: { role: "button", name: "确认" } } } }; };
  const config = parsePersonalBrowser({ version: 1, generation: "browser-fixture", binaryPath: "/unused/agent-browser", chromePath: "/unused/chrome", headed: false });
  const personal = await openPersonalHarness({ directory, provider: personalProvider(modelConfig), modelId: modelConfig.modelId, browser: config });
  harness = personal.harness; const browser = personal.browser!, main = personal.main;
  await harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
  current = binding(String(ROOT_CONVERSATION_ID), directory); closes = 0; closeSessions.length = 0;
  t.after(async () => { await personal.close(); await model.close(); Object.assign(BrowserManager.prototype, previous); if (previousKey === undefined) delete process.env[modelConfig.apiKeyEnv]; else process.env[modelConfig.apiKeyEnv] = previousKey; fs.rmSync(root, { recursive: true, force: true }); });
  const submit = async (content: string, requestId: string) => {
    await personal.answer("安排浏览器工作", requestId);
    const work = await personal.work.delegate({ content, requestId: `browser-work:${requestId}`, sourceRequestId: requestId });
    return { work, wait: async (_context: typeof context) => { await until(async () => (await operations()).some(value => value.origin.work?.ref.taskId === work.taskId && value.observation !== undefined) || (await harness.getTask(work.taskId, context))?.state.status === "terminal"); return harness.commit(tx => personalWorkResult(tx, work), context); } };
  };
  const answer = async (content: string, requestId: string) => { const submitted = await submit(content, requestId); await submitted.wait(context); return submitted; };
  const operations = () => harness.commit(async tx => JSON.parse(JSON.stringify(await browserOperations(tx))) as PersonalBrowserOperation[], context);
  const scheduled = async (content: string, options: { mode?: "full_access" | "confirm"; browser?: boolean } = {}) => {
    await harness.commit(async tx => {
      const permission = await tx.doc(PersonalPermissionsDoc); const previous = permission.mode; permission.mode = options.mode ?? "full_access";
      const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); const extensions = agent.extensions, tools = agent.tools;
      if (options.browser === false && Array.isArray(agent.extensions) && Array.isArray(agent.tools)) { agent.extensions = agent.extensions.filter(name => name !== "personal-browser"); agent.tools = agent.tools.filter(name => name !== "browser"); }
      const plan = await personal.scheduler.create(tx, { requestId: randomUUID(), label: "Browser schedule", instruction: content, rule: { kind: "once", at: "2099-01-01T00:00:00Z", timeZone: "UTC" } }, { kind: "local", requestId: "browser-creator" });
      permission.mode = previous; agent.extensions = extensions; agent.tools = tools;
      return plan;
    }, context);
    await harness.commit(tx => personal.scheduler.scan(tx, Date.parse("2099-01-01T00:00:00Z")), context); harness.resume();
    const index = await harness.snapshot(PersonalSchedulesDoc, context), run = (await harness.snapshot(PersonalScheduleRunDoc, index!.runs.at(-1)!, context))!.run!;
    const conversation = (await harness.conversation(run.conversationId, context))!;
    return { conversation, requestId: run.requestId, run, submit: async () => ({ wait: async (_context: typeof context) => { await until(async () => (await operations()).some(value => value.origin.conversationId === run.conversationId && (value.observation !== undefined || value.params.action === "pause" && value.code === "started")) || (await harness.getTask(run.taskId, context))?.state.status === "terminal"); } }) };
  };
  return { directory, harness, main, browser, model, personal, submit, answer, operations, scheduled, commandSessions, closeSessions, imageSources, persistBinding, current: () => current, calls: () => calls, closes: () => closes };
}

test("durable 浏览器：仅当前唯一拥有者的完全访问来源开放，旧本机输入不随默认模式扩权", async t => {
  const f = await fixture(t);
  await f.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "confirm"; }, context);
  await f.answer(invoke("open", { url: "https://example.com" }), "restricted"); assert.equal(f.calls(), 0); assert.equal((await f.operations()).length, 0);
  await f.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
  await f.answer(invoke("open", { url: "https://example.com" }), "full"); assert.equal(f.calls(), 1); assert.equal((await f.operations())[0].effect, "returned");
  await f.harness.commit(async tx => { assert.equal(await browserRequestAllowed(tx, ROOT_CONVERSATION_ID, "restricted"), false); }, context);
  await assert.rejects(f.harness.commit(async tx => verifyBrowser(tx, ["missing"], f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context), { code: "browser_record_invalid" });
});

test("durable 浏览器：导航丢答仅发送一次，网页效果与实际停止分开核实", async t => {
  const f = await fixture(t); let sent = 0;
  BrowserManager.prototype.command = async () => { sent++; throw new BrowserError("outcome_unknown", "原导航应答丢失", true); };
  await f.answer(invoke("open", { url: "https://example.com" }), "unknown");
  const operation = (await f.operations())[0]; assert.equal(sent, 1); assert.equal(operation.effect, "effect_unknown"); assert.equal(operation.stopped, true); assert.ok(f.closes() >= 1);
  await f.harness.commit(async tx => { assert.equal((await browserSourceBlocker(tx, "unknown"))?.browser, String(operation.operation)); await browserResolve(tx, operation.operation, "applied", "拥有者核对目标网页已导航"); }, context);
  await f.harness.commit(async tx => { assert.equal(await browserSourceBlocker(tx, "unknown"), undefined); await verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)); }, context);
});

test("Personal browser pause waits off main and only an original explicit choice resumes with a fresh snapshot", async t => {
  const f = await fixture(t), paused = await f.submit(invoke("pause"), "pause");
  await until(async () => (await f.operations()).some(value => value.params.action === "pause" && value.code === "started"));
  const operation = (await f.operations())[0], session = String(operation.origin.conversationId);
  await until(() => f.browser.status(operation.origin.conversationId).state === "paused");
  assert.equal((await browserDetailIn(f, operation.operation)).summary.canResume, true);
  await f.personal.answer("现在能继续聊天", "chat-while-paused"); assert.equal(f.browser.status(operation.origin.conversationId).state, "paused");
  await assert.rejects(f.harness.commit(tx => f.browser.chooseResume(tx, operation.operation, { requestId: "wrong-source", botId: "123", ownerId: "456", generation: "new" }), context), { code: "browser_original_entry" });
  const choice = await f.harness.commit(tx => f.browser.chooseResume(tx, operation.operation, undefined, "native-choice"), context);
  assert.equal(await f.harness.commit(tx => f.browser.chooseResume(tx, operation.operation, undefined, "native-choice"), context), choice);
  await paused.wait(context);
  const saved = (await f.operations())[0], state = await f.harness.snapshot(PersonalBrowserSessionDoc, session, context);
  assert.equal(saved.effect, "returned"); assert.ok(state!.choices![0].consumed); assert.ok(state!.choices![0].observation);
  assert.ok(f.commandSessions.includes(session)); assert.match(JSON.stringify(saved.result), /snapshot/);
  const values = await f.operations(); await f.harness.commit(async tx => verifyBrowser(tx, values.map(value => String(value.operation)), f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context);
});
async function browserDetailIn(f: Awaited<ReturnType<typeof fixture>>, operation: PersonalBrowserOperation["operation"]) { return f.harness.commit(tx => browserDetail(tx, operation), context); }

test("Personal browser assignments queue durably; an amendment supersedes the unstarted queued operation", async t => {
  const f = await fixture(t), first = await f.submit(invoke("pause"), "first-assignment");
  await until(async () => (await f.operations()).some(value => value.params.action === "pause" && value.code === "started"));
  const second = await f.submit(invoke("snapshot"), "second-assignment");
  await until(async () => (await f.operations()).some(value => value.origin.work?.ref.taskId === second.work.taskId));
  const old = (await f.operations()).find(value => value.origin.work?.ref.taskId === second.work.taskId)!;
  assert.equal(old.started, false); assert.equal(f.calls(), 0);
  const claimState = await f.harness.snapshot(PersonalInteractiveResourceDoc, "browser", context); assert.equal(claimState!.claims.length, 2); assert.equal(claimState!.owner, claimState!.claims[0].claim);
  await f.personal.answer("改为新的页面要求", "amended-owner");
  await f.harness.commit(async tx => appendPersonalWork(tx, second.work, { requestId: "queued-browser-note", content: invoke("status"), source: await personalWorkNoteSource(tx, "amended-owner") }), context); f.harness.resume();
  await until(async () => (await f.operations()).find(value => value.operation === old.operation)?.code === "tool_requirements_changed");
  await f.harness.commit(tx => requestPersonalWorkCancel(tx, first.work), context); f.harness.resume();
  await first.wait(context); await second.wait(context);
  const superseded = (await f.operations()).find(value => value.operation === old.operation)!; assert.equal(superseded.started, false); assert.equal(superseded.effect, "not_executed"); assert.ok(superseded.superseded);
  await f.harness.waitForTask(second.work.taskId, context);
  await f.harness.commit(async tx => verifyBrowser(tx, (await browserOperations(tx)).map(value => String(value.operation)), f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context);
});

test("Personal browser unknown stopping keeps the original WorkTask and resource until a bound recheck", async t => {
  const f = await fixture(t); let verified = false;
  const close = BrowserManager.prototype.close; BrowserManager.prototype.close = async session => verified ? close.call(f.browser.manager(), session) : false;
  const first = await f.answer(invoke("snapshot"), "uncertain-stop");
  await until(async () => (await f.harness.snapshot(PersonalInteractiveResourceDoc, "browser", context))!.owner !== undefined);
  await delay(30); assert.notEqual((await f.harness.getTask(first.work.taskId, context))!.state.status, "terminal");
  const second = await f.submit(invoke("snapshot"), "waiting-after-uncertain-stop");
  await until(async () => (await f.operations()).some(value => value.origin.work?.ref.taskId === second.work.taskId));
  assert.equal((await f.operations()).at(-1)!.started, false);
  verified = true; await f.browser.verifyStop((await f.operations())[0].operation);
  await f.harness.waitForTask(first.work.taskId, context); await second.wait(context); await f.harness.waitForTask(second.work.taskId, context);
  assert.equal((await f.harness.snapshot(PersonalInteractiveResourceDoc, "browser", context))!.owner, undefined);
});

test("Personal browser keeps assignment ownership when an amendment arrives during final cleanup", async t => {
  const f = await fixture(t), settle = f.browser.settleWork;
  let enter!: () => void, release!: () => void, hold = true;
  const entered = new Promise<void>(resolve => { enter = resolve; }), cleanup = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(f.browser, "settleWork", async (...args: Parameters<typeof settle>) => { await settle(...args); if (hold) { hold = false; enter(); await cleanup; } });
  const first = await f.answer(invoke("snapshot"), "cleanup-owner"); await entered;
  const original = (await f.operations())[0], second = await f.submit(invoke("snapshot"), "cleanup-queued-owner");
  await until(async () => (await f.operations()).some(value => value.origin.work?.ref.taskId === second.work.taskId));
  await f.personal.answer("清理期间追加新要求", "cleanup-amend-owner");
  await f.personal.work.append(first.work, { requestId: "cleanup-amendment", sourceRequestId: "cleanup-amend-owner", content: invoke("status") });
  const held = (await f.harness.snapshot(PersonalInteractiveResourceDoc, "browser", context))!;
  assert.equal(held.owner, original.claim); assert.equal(held.claims[0].released, undefined);
  assert.equal((await f.operations()).find(value => value.origin.work?.ref.taskId === second.work.taskId)!.started, false);
  release(); await f.harness.waitForTask(first.work.taskId, context); await f.harness.waitForTask(second.work.taskId, context);
  const values = await f.operations(), amended = values.find(value => value.origin.work?.ref.taskId === first.work.taskId && value.operation !== original.operation)!;
  assert.ok(amended.instructions?.snapshot.notes.length); assert.equal(amended.claim, original.claim); assert.equal(amended.effect, "returned");
  const state = (await f.harness.snapshot(PersonalInteractiveResourceDoc, "browser", context))!;
  assert.ok(state.claims[0].released! > amended.observation!); assert.ok(state.claims[1].acquired! > state.claims[0].released!);
  assert.equal((await f.harness.snapshot(PersonalWorkDoc, first.work.requestId, context))!.notes!.at(-1)!.requestId, "cleanup-amendment");
  await f.harness.commit(async tx => verifyBrowser(tx, values.map(value => String(value.operation)), f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context);
});

test("Personal browser historical stop recheck does not stop a reused child's current assignment", async t => {
  const f = await fixture(t), first = await f.answer(invoke("snapshot"), "historical-browser-owner"); await f.harness.waitForTask(first.work.taskId, context);
  const operation = (await f.operations())[0];
  await f.personal.answer("复用身份的新浏览器工作", "current-browser-owner");
  const current = await f.personal.work.delegate({ requestId: "current-browser-work", sourceRequestId: "current-browser-owner", agentId: first.work.agentId, content: invoke("pause") });
  await until(async () => !!(await f.harness.snapshot(PersonalBrowserSessionDoc, String(current.agentId), context))?.pause);
  const closes = f.closes(); assert.equal((await browserDetailIn(f, operation.operation)).summary.canVerifyStop, false);
  assert.equal(await f.browser.verifyStop(operation.operation), true);
  const recheck = await f.harness.commit(tx => f.browser.requestStop(tx, operation.operation), context); await f.harness.waitForTask(recheck, context);
  assert.equal(f.closes(), closes); assert.equal(f.browser.status(current.agentId).state, "paused");
  await f.personal.work.cancel(current);
});

test("Personal browser connection management targets the current child and stops a paused call", async t => {
  const f = await fixture(t), first = await f.submit(invoke("pause"), "managed-browser-owner");
  await until(async () => !!(await f.harness.snapshot(PersonalBrowserSessionDoc, String(first.work.agentId), context))?.pause);
  assert.equal((await f.browser.connectionStatus()).state, "paused");
  assert.equal(await f.browser.stopCurrent(), true); await f.harness.waitForTask(first.work.taskId, context);
  assert.equal((await f.operations())[0].stopped, true); assert.ok(f.closeSessions.includes(String(first.work.agentId)));
  assert.equal((await f.harness.snapshot(PersonalInteractiveResourceDoc, "browser", context))!.owner, undefined);
});

for (const priorBinding of ["missing", "closed"] as const) for (const control of ["verifyStop", "stopCurrent"] as const) test(`Personal browser ${control} of a ${priorBinding} binding cannot stop a reused child's next assignment`, { timeout: 20000 }, async t => {
  const f = await fixture(t), readStatus = BrowserManager.prototype.status;
  let originalBinding = true;
  BrowserManager.prototype.status = session => originalBinding ? priorBinding === "missing" ? null : { ...readStatus.call(f.browser.manager(), session)!, state: "closed" } : readStatus.call(f.browser.manager(), session);
  t.after(() => { BrowserManager.prototype.status = readStatus; });
  let enterCleanup!: () => void, releaseCleanup!: () => void, enterStop!: () => void, releaseStop!: () => void;
  const cleanupEntered = new Promise<void>(resolve => { enterCleanup = resolve; }), cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const stopEntered = new Promise<void>(resolve => { enterStop = resolve; }), stop = new Promise<void>(resolve => { releaseStop = resolve; });
  t.after(() => { releaseCleanup(); releaseStop(); });
  const settle = f.browser.settleWork;
  let holdCleanup = true;
  t.mock.method(f.browser, "settleWork", async (...args: Parameters<typeof settle>) => {
    if (holdCleanup) { holdCleanup = false; enterCleanup(); await cleanup; }
    await settle(...args);
  });
  const first = await f.answer(invoke("status"), `unbound-original-${priorBinding}-${control}`); await cleanupEntered;
  const operation = (await f.operations())[0], commit = f.harness.commit.bind(f.harness);
  let holdStop = false;
  t.mock.method(f.harness, "commit", async (...args: Parameters<typeof f.harness.commit>) => {
    const result = await commit(...args);
    if (holdStop) { holdStop = false; enterStop(); await stop; }
    return result;
  });
  holdStop = true;
  const historicalStop = control === "verifyStop" ? f.browser.verifyStop(operation.operation) : f.browser.stopCurrent();
  await stopEntered;
  releaseCleanup(); await f.harness.waitForTask(first.work.taskId, context);
  originalBinding = false;
  await f.personal.answer("复用空闲身份", `unbound-reuse-${priorBinding}-${control}`);
  const current = await f.personal.work.delegate({ requestId: `unbound-reused-work-${priorBinding}-${control}`, sourceRequestId: `unbound-reuse-${priorBinding}-${control}`, agentId: first.work.agentId, content: invoke("pause") });
  await until(() => f.browser.status(current.agentId).state === "paused");
  const closes = f.closes(); releaseStop(); assert.equal(await historicalStop, true);
  assert.equal(f.closes(), closes, "The historical stop must not close a later binding.");
  assert.equal(f.browser.status(current.agentId).state, "paused");
  await f.personal.work.cancel(current);
});

test("Personal browser delayed stop evidence cannot mark a reused child's new operation stopped", { timeout: 20000 }, async t => {
  const f = await fixture(t), original = await f.submit(invoke("pause"), "stop-evidence-old-owner");
  await until(async () => !!(await f.harness.snapshot(PersonalBrowserSessionDoc, String(original.work.agentId), context))?.pause);
  await until(() => f.browser.status(original.work.agentId).state === "paused");
  const old = (await f.operations())[0], close = BrowserManager.prototype.close;
  let enterClose!: () => void, releaseClose!: () => void, enterCommand!: () => void, releaseCommand!: () => void;
  const closed = new Promise<void>(resolve => { enterClose = resolve; }), heldClose = new Promise<void>(resolve => { releaseClose = resolve; });
  const commandEntered = new Promise<void>(resolve => { enterCommand = resolve; }), heldCommand = new Promise<void>(resolve => { releaseCommand = resolve; });
  t.after(() => { releaseClose(); releaseCommand(); });
  let holdClose = true;
  BrowserManager.prototype.close = async session => {
    const result = await close.call(f.browser.manager(original.work.agentId), session);
    if (holdClose) { holdClose = false; enterClose(); await heldClose; }
    return result;
  };
  const historicalStop = f.browser.stopCurrent(); await closed;
  await f.harness.waitForTask(original.work.taskId, context);
  const command = BrowserManager.prototype.command;
  BrowserManager.prototype.command = async (...args: Parameters<typeof command>) => { enterCommand(); await heldCommand; return command.call(f.browser.manager(original.work.agentId), ...args); };
  await f.personal.answer("Reuse child after exact old close", "stop-evidence-new-owner");
  const next = await f.personal.work.delegate({ requestId: "stop-evidence-new-work", sourceRequestId: "stop-evidence-new-owner", agentId: original.work.agentId, content: invoke("snapshot") });
  await commandEntered;
  const current = (await f.operations()).find(value => value.origin.work?.ref.taskId === next.taskId)!;
  assert.ok(current.started); assert.equal(current.stopped, false); assert.equal(current.observation, undefined);
  releaseClose(); assert.equal(await historicalStop, true);
  const after = (await f.operations()).find(value => value.operation === current.operation)!;
  releaseCommand();
  assert.equal(after.stopped, false, "An old stop must not create stop evidence for a later assignment.");
  assert.equal(after.stopEvidence, undefined);
  await f.harness.waitForTask(next.taskId, context);
  assert.equal((await f.operations()).find(value => value.operation === old.operation)!.stopped, true);
});

for (const corruption of ["participant", "origin", "instructions", "acquisition", "binding", "observation", "unresolved"] as const) test(`Personal browser recovery rejects a claim with invalid ${corruption} evidence`, async t => {
  const f = await fixture(t), work = await f.answer(invoke("snapshot"), `claim-${corruption}`); await f.harness.waitForTask(work.work.taskId, context);
  const operation = (await f.operations())[0], state = await f.harness.snapshot(PersonalInteractiveResourceDoc, "browser", context), claim = state!.claims[0];
  assert.ok(claim.acquired && claim.released && claim.stopped?.includes(operation.observation!));
  await f.harness.commit(async tx => {
    const doc = await tx.doc(PersonalInteractiveResourceDoc, "browser", null), original = doc.claims[0];
    if (corruption === "participant") { const entry = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.interactive-admission", data: { version: 1, resource: "browser", origin: claim.origin, instructions: claim.instructions! } }); doc.claims.push({ claim: entry.id, origin: claim.origin, instructions: claim.instructions }); }
    else if (corruption === "origin") original.origin.inputs = [];
    else if (corruption === "instructions") delete original.instructions;
    else if (corruption === "acquisition") original.acquired = operation.observation;
    else if (corruption === "binding") { const bindingEntry = (await tx.doc(PersonalBrowserSessionDoc, String(operation.origin.conversationId), null)).bindingEntry; original.stopped = original.stopped!.filter(entry => entry !== bindingEntry); }
    else if (corruption === "observation") original.stopped = original.stopped!.filter(entry => entry !== operation.observation);
    else delete (await tx.doc(PersonalBrowserOperationDoc, String(operation.operation), null)).operation!.observation;
  }, context);
  await assert.rejects(f.harness.commit(async tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context), { code: "browser_record_invalid" });
  await f.harness.commit(async tx => { Object.assign(await tx.doc(PersonalInteractiveResourceDoc, "browser", null), state); Object.assign((await tx.doc(PersonalBrowserOperationDoc, String(operation.operation), null)).operation!, operation); }, context);
});

test("Personal browser status without a binding releases from the original settled observation", async t => {
  const f = await fixture(t);
  BrowserManager.prototype.status = () => null; BrowserManager.prototype.close = async () => true;
  const work = await f.answer(invoke("status"), "no-binding"); await f.harness.waitForTask(work.work.taskId, context);
  const operation = (await f.operations())[0], state = await f.harness.snapshot(PersonalInteractiveResourceDoc, "browser", context);
  assert.equal(operation.effect, "returned"); assert.ok(state!.claims[0].released); assert.deepEqual(state!.claims[0].stopped, [operation.observation]);
  assert.equal((await f.harness.snapshot(PersonalBrowserSessionDoc, String(operation.origin.conversationId), context))!.bindingEntry, undefined);
  await f.harness.commit(async tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context);
});

test("Personal browser canceled queued work on a reused child releases only its own claim", async t => {
  const f = await fixture(t), original = await f.answer(invoke("snapshot"), "previous-browser-work"); await f.harness.waitForTask(original.work.taskId, context);
  const holder = await f.submit(invoke("pause"), "browser-holder"); await until(async () => !!(await f.harness.snapshot(PersonalBrowserSessionDoc, String(holder.work.agentId), context))?.pause);
  await f.personal.answer("新排队工作", "reused-browser-owner");
  const queued = await f.personal.work.delegate({ requestId: "reused-browser-work", agentId: original.work.agentId, sourceRequestId: "reused-browser-owner", content: invoke("snapshot") });
  await until(async () => (await f.operations()).some(value => value.origin.work?.ref.taskId === queued.taskId));
  const old = (await f.operations()).find(value => value.origin.work?.ref.taskId === queued.taskId)!; assert.equal(old.started, false);
  await f.harness.commit(tx => requestPersonalWorkCancel(tx, queued), context); f.harness.resume(); await f.harness.waitForTask(queued.taskId, context);
  const state = await f.harness.snapshot(PersonalInteractiveResourceDoc, "browser", context), canceled = state!.claims.find(value => value.claim === old.claim)!;
  assert.ok(canceled.released); assert.equal(canceled.acquired, undefined); assert.ok(canceled.stopped!.every(entry => entry > canceled.claim));
  assert.equal(f.browser.status(holder.work.agentId).state, "paused");
  await f.harness.commit(tx => requestPersonalWorkCancel(tx, holder.work), context); f.harness.resume(); await f.harness.waitForTask(holder.work.taskId, context);
  await f.harness.commit(async tx => verifyBrowser(tx, (await browserOperations(tx)).map(value => String(value.operation)), f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context);
});

test("durable 浏览器：截图先落可校验产物，视觉结果只保留稳定图片引用", async t => {
  const f = await fixture(t); await f.answer(invoke("screenshot"), "screenshot");
  const operation = (await f.operations())[0]; assert.ok(operation.artifact); assert.equal(operation.artifact.mime, "image/png"); assert.match(operation.image!.data, /ruukotoImage/); assert.equal(loadPersonalArtifact(f.directory, operation.artifact).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const entries = (await (await f.harness.conversation(operation.origin.conversationId, context))!.entries({ order: "ascending" }, 256, undefined, context)).items;
  assert.ok(JSON.stringify(entries).includes(operation.artifact.id)); assert.ok(!JSON.stringify(entries).includes("iVBORw0KGgo"));
  await f.harness.commit(async tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context);
});

test("durable 浏览器：取消在途写动作先收旧浏览器，保留网页效果未知", async t => {
  const f = await fixture(t); let sent = 0;
  BrowserManager.prototype.command = async (_session, _args, signal) => { sent++; return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new BrowserError("outcome_unknown", "已发动作取消", true)), { once: true })); };
  const submission = await f.submit(invoke("open", { url: "https://example.com" }), "cancel"); await until(() => sent === 1); await f.harness.commit(tx => requestPersonalWorkCancel(tx, submission.work), context); f.harness.resume(); await submission.wait(context);
  const operation = (await f.operations())[0]; assert.equal(operation.effect, "effect_unknown"); assert.equal(operation.stopped, true); assert.equal(sent, 1); assert.ok(f.closes() >= 1);
});

test("Personal browser recovery keeps the original action unknown and serializes later work", async t => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async request => { if (request.system?.includes("你是个人助手的子 Agent") && request.messages.at(-1)?.role === "tool") await held; return responder(request, 0); }); t.after(release);
  const original = await f.answer(invoke("open", { url: "https://example.com" }), "original");
  const operation = (await f.operations())[0], sent = f.calls();
  await f.harness.commit(async tx => { const value = (await tx.doc(PersonalBrowserOperationDoc, String(operation.operation), null)).operation!; delete value.observation; delete value.result; value.effect = "effect_unknown"; value.code = "started"; value.stopped = false; }, context);
  await f.browser.recover();
  const recovered = (await f.operations())[0]; assert.equal(f.calls(), sent); assert.equal(recovered.effect, "effect_unknown"); assert.equal(recovered.code, "interrupted"); assert.equal(recovered.stopped, true);
  const next = await f.submit(invoke("open", { url: "https://example.com/again" }), "other-source");
  await until(async () => (await f.operations()).some(value => value.origin.work?.ref.taskId === next.work.taskId));
  await delay(40); assert.equal(f.calls(), sent);
  await f.harness.commit(tx => browserResolve(tx, operation.operation, "not_applied", "Original page effect checked"), context);
  release();
  await f.harness.waitForTask(original.work.taskId, context); await next.wait(context); assert.equal(f.calls(), sent + 1);
  const values = await f.operations(); await f.harness.commit(async tx => verifyBrowser(tx, values.map(value => String(value.operation)), f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context);
});

test("durable 浏览器：停止未核实继续保留占用，后台停止核实不解除未知网页效果", async t => {
  const f = await fixture(t); let verified = false;
  BrowserManager.prototype.close = async () => verified;
  BrowserManager.prototype.command = async () => { throw new BrowserError("outcome_unknown", "原写动作应答丢失", true); };
  await f.answer(invoke("open", { url: "https://example.com" }), "stop-unverified"); const operation = (await f.operations())[0]; assert.equal(operation.stopped, false);
  const stopTask = await f.harness.commit(tx => f.browser.requestStop(tx, operation.operation), context); f.harness.resume(); await f.harness.waitForTask(stopTask, context); assert.equal((await f.operations())[0].stopped, false);
  verified = true; assert.equal(await f.browser.verifyStop(operation.operation), true);
  assert.equal((await f.operations())[0].stopped, true); await f.harness.commit(async tx => { assert.ok(await browserSourceBlocker(tx, "stop-unverified")); }, context);
  await f.harness.commit(async tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context);
});

test("durable 浏览器：长网页结果只返回预览，完整原JSON作为产物保留", async t => {
  const f = await fixture(t), body = { refs: { e1: { text: "长网页".repeat(3000) } } };
  BrowserManager.prototype.command = async () => ({ data: body }); await f.answer(invoke("snapshot"), "long-snapshot"); const operation = (await f.operations())[0];
  assert.ok(operation.artifact); assert.equal(operation.image, undefined); assert.deepEqual(JSON.parse(loadPersonalArtifact(f.directory, operation.artifact).toString("utf8")), body); assert.ok(JSON.stringify(operation.result).length < 4000);
});

test("durable 浏览器：恢复核实使用同一SDK参数规范化，不把字符串数值误判为篡改", async t => {
  const f = await fixture(t); await f.answer(invoke("scroll", { direction: "down", pixels: "123" }), "coerced-params");
  const operation = (await f.operations())[0]; assert.equal(operation.params.pixels, 123); assert.equal(operation.effect, "returned");
  await f.harness.commit(async tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context);
});

test("durable 浏览器：删除未知操作的document与索引不能抹掉原历史暂停事实", async t => {
  const f = await fixture(t); BrowserManager.prototype.command = async () => { throw new BrowserError("outcome_unknown", "已发导航丢答", true); };
  await f.answer(invoke("open", { url: "https://example.com" }), "hidden-operation"); const operation = (await f.operations())[0];
  await f.harness.commit(async tx => { delete (await tx.doc(PersonalBrowserOperationDoc, String(operation.operation), null)).operation; (await tx.doc(PersonalBrowserDoc)).operations = []; }, context);
  await assert.rejects(f.harness.commit(async tx => verifyBrowser(tx, [], f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context), { code: "browser_record_invalid" });
});

test("durable 浏览器：抹掉配置或最近停止任务指针都在恢复前拒绝", async t => {
  const f = await fixture(t); BrowserManager.prototype.command = async () => { throw new BrowserError("outcome_unknown", "已发导航丢答", true); }; BrowserManager.prototype.close = async () => false;
  await f.answer(invoke("open", { url: "https://example.com" }), "stop-pointer"); const operation = (await f.operations())[0];
  const stop = await f.harness.commit(tx => f.browser.requestStop(tx, operation.operation), context); f.harness.resume(); await f.harness.waitForTask(stop, context);
  await f.harness.commit(async tx => { delete (await tx.doc(PersonalBrowserOperationDoc, String(operation.operation), null)).operation!.stopTask; }, context);
  await assert.rejects(f.harness.commit(async tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context), { code: "browser_record_invalid" });
  await f.harness.commit(async tx => { (await tx.doc(PersonalBrowserOperationDoc, String(operation.operation), null)).operation!.stopTask = stop; delete (await tx.doc(PersonalBrowserDoc)).config; }, context);
  await assert.rejects(f.harness.commit(async tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)), context), { code: "browser_record_invalid" });
});

test("durable 浏览器配置拒绝模型管理参数、相同代次改写与不安全文件", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-browser-config-"))), profile = path.join(root, "profile"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const value = { version: 1, generation: "first", binaryPath: "/bin/unused", chromePath: "/bin/unused-chrome", headed: false };
  assert.throws(() => parsePersonalBrowser({ ...value, noSandbox: true }), { code: "browser_config_invalid" });
  await savePersonalBrowser(profile, value); const lock = lockPersonalProfile(profile); try { assert.deepEqual(readPersonalBrowser(lock), value); } finally { lock.release(); }
  await assert.rejects(savePersonalBrowser(profile, { ...value, headed: true }), { code: "browser_config_invalid" });
  const secondLock = lockPersonalProfile(profile); try { fs.chmodSync(path.join(profile, "browser.json"), 0o644); assert.throws(() => readPersonalBrowser(secondLock), { code: "browser_config_invalid" }); } finally { secondLock.release(); }
});

test("durable 浏览器：真实定时来源的截图与执行只属于独立会话", async t => {
  const f = await fixture(t); await f.answer(invoke("screenshot"), "main-picture");
  const scheduled = await f.scheduled(invoke("screenshot")), submission = await scheduled.submit(); await submission.wait(context);
  const values = await f.operations(), operation = values.at(-1)!;
  assert.equal(operation.effect, "returned"); assert.equal(operation.origin.conversationId, scheduled.conversation.id); assert.equal(operation.origin.source.requestId, scheduled.requestId);
  assert.equal(JSON.parse(operation.image!.data).ruukotoImage.conversationId, scheduled.conversation.id); assert.equal(f.commandSessions.at(-1), String(scheduled.conversation.id));
  await f.harness.commit(async tx => { assert.equal((await tx.entry(operation.origin.source.entryId))?.kind, SCHEDULE_INPUT); assert.equal((await tx.entry(operation.admission))?.conversationId, scheduled.conversation.id); await verifyBrowser(tx, values.map(value => String(value.operation)), f.directory, f.browser.extension.tools, ((await tx.doc(PersonalBrowserDoc)).sessions ?? []).map(String)); }, context);
  assert.equal((await f.harness.snapshot(PersonalBrowserDoc, context))?.pause, undefined);
});

for (const limit of ["mode", "scope"] as const) test(`durable 浏览器：定时创建时${limit}未开放不会因主会话完全访问而扩权`, async t => {
  const f = await fixture(t), scheduled = await f.scheduled(invoke("open", { url: "https://example.com" }), limit === "mode" ? { mode: "confirm" } : { browser: false });
  const submission = await scheduled.submit(); await submission.wait(context);
  assert.equal(f.calls(), 0); assert.equal((await f.operations()).length, 0);
});

test("Personal scheduled browser unknown effects retain ownership while main chat remains usable", async t => {
  const f = await fixture(t);
  const command = BrowserManager.prototype.command, scheduled = await f.scheduled(invoke("open", { url: "https://example.com" })); let sent = 0;
  BrowserManager.prototype.command = async (session, args, signal) => { if (session === String(scheduled.conversation.id)) { sent++; throw new BrowserError("outcome_unknown", "定时网页写入丢答", true); } return command.call(f.browser.manager(), session, args, signal); };
  const submission = await scheduled.submit(); await submission.wait(context); const operation = (await f.operations()).at(-1)!;
  assert.equal(operation.effect, "effect_unknown"); assert.equal(sent, 1); assert.ok(f.closeSessions.every(value => value === String(scheduled.conversation.id)));
  await f.personal.answer("主聊天仍可继续", "main-still-usable");
  const other = await f.scheduled(invoke("snapshot")), second = await other.submit();
  await until(async () => (await f.operations()).some(value => value.origin.conversationId === other.conversation.id)); await delay(30);
  assert.equal((await f.operations()).at(-1)?.started, false);
  await f.harness.commit(tx => browserResolve(tx, operation.operation, "not_applied", "Original scheduled page checked"), context);
  await f.browser.releaseConversation(scheduled.conversation.id); await second.wait(context); assert.equal((await f.operations()).at(-1)?.effect, "returned");
  await f.harness.commit(async tx => { assert.equal(await browserSourceBlocker(tx, scheduled.requestId), undefined); assert.equal(await browserSourceBlocker(tx, "main-still-usable"), undefined); assert.equal(await browserSourceBlocker(tx, other.requestId), undefined); }, context);
  const values = await f.operations(); await f.harness.commit(async tx => verifyBrowser(tx, values.map(value => String(value.operation)), f.directory, f.browser.extension.tools, [String(scheduled.conversation.id), String(other.conversation.id)]), context);
});

test("Personal scheduled browser pause retains the run and cancellation closes only that browser", async t => {
  const f = await fixture(t), scheduled = await f.scheduled(invoke("pause")), submission = await scheduled.submit(); await submission.wait(context);
  const operation = (await f.operations())[0], session = await f.harness.snapshot(PersonalBrowserSessionDoc, String(scheduled.conversation.id), context);
  assert.ok(session?.pause); assert.equal((await f.harness.snapshot(PersonalBrowserDoc, context))?.pause, undefined);
  await f.harness.commit(async tx => { assert.equal((await browserSourceBlocker(tx, scheduled.requestId))?.browser, String(operation.operation)); }, context);
  await f.personal.answer("主会话不能自行继续定时浏览器", "main-cannot-resume-scheduled");
  await f.harness.commit(async tx => { assert.ok(await browserSourceBlocker(tx, scheduled.requestId)); }, context);
  await f.harness.commit(tx => f.personal.scheduler.cancel(tx, scheduled.run.planId, { kind: "local", requestId: randomUUID() }), context);
  f.harness.resume(); await until(async () => (await f.operations())[0].observation !== undefined);
  await f.browser.stop(scheduled.conversation.id);
  await f.harness.commit(async tx => { assert.equal(await browserSourceBlocker(tx, scheduled.requestId), undefined); const values = await browserOperations(tx); await verifyBrowser(tx, values.map(value => String(value.operation)), f.directory, f.browser.extension.tools, [String(scheduled.conversation.id)]); assert.equal(operation.origin.conversationId, scheduled.conversation.id); }, context);
});

test("durable 浏览器：定时绑定或暂停索引删除及跨会话借用均在恢复前拒绝", async t => {
  const f = await fixture(t), scheduled = await f.scheduled(invoke("pause")), submission = await scheduled.submit(); await submission.wait(context);
  const operation = (await f.operations())[0], session = await f.harness.snapshot(PersonalBrowserSessionDoc, String(scheduled.conversation.id), context); assert.ok(session);
  await f.harness.commit(async tx => { const doc = await tx.doc(PersonalBrowserSessionDoc, String(scheduled.conversation.id), null); delete doc.pause; }, context);
  await assert.rejects(f.harness.commit(async tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, [String(scheduled.conversation.id)]), context), { code: "browser_record_invalid" });
  await f.harness.commit(async tx => { Object.assign(await tx.doc(PersonalBrowserSessionDoc, String(scheduled.conversation.id), null), session); (await tx.doc(PersonalBrowserDoc)).sessions = []; }, context);
  await assert.rejects(f.harness.commit(async tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, [String(scheduled.conversation.id)]), context), { code: "browser_record_invalid" });
  await f.harness.commit(async tx => { (await tx.doc(PersonalBrowserDoc)).sessions = [scheduled.conversation.id]; const doc = await tx.doc(PersonalBrowserSessionDoc, String(scheduled.conversation.id), null), root = await tx.doc(PersonalBrowserDoc); doc.stateJson = root.stateJson; doc.bindingEntry = root.bindingEntry; }, context);
  await assert.rejects(f.harness.commit(async tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, [String(scheduled.conversation.id)]), context), { code: "browser_record_invalid" });
});

test("durable 浏览器：定时请求发出前按本会话真实输入筛选，不把子会话当拥有者", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (request, index) => { if (index === 0) await gate; return responder(request, index); }), scheduled = await f.scheduled(invoke("snapshot")), submission = await scheduled.submit();
  await until(() => f.model.calls.length === 1);
  await f.harness.commit(async tx => { assert.equal(await browserRequestAllowed(tx, scheduled.conversation.id, scheduled.requestId), true); assert.equal(await browserRequestAllowed(tx, ROOT_CONVERSATION_ID, scheduled.requestId), false); assert.equal(await browserRequestAllowed(tx, scheduled.conversation.id, "unknown-child-input"), false); }, context);
  release(); await submission.wait(context);
});

test("durable 浏览器：重建管理器从定时会话自己的绑定恢复，已开始动作不重发", async t => {
  const f = await fixture(t), scheduled = await f.scheduled(invoke("open", { url: "https://example.com" })), submission = await scheduled.submit(); await submission.wait(context);
  const operation = (await f.operations())[0], sent = f.calls(); await f.persistBinding(String(scheduled.conversation.id));
  await f.harness.commit(async tx => { const value = (await tx.doc(PersonalBrowserOperationDoc, String(operation.operation), null)).operation!; delete value.observation; delete value.result; value.effect = "effect_unknown"; value.code = "started"; value.stopped = false; }, context);
  const restored = personalBrowser(f.directory, f.browser.config, () => f.harness, { async registerImage(_tx, artifact) { return { type: "image", mimeType: artifact.mime, data: `ruukoto-image:${artifact.id}` }; } });
  t.after(() => restored.close()); await restored.recover();
  const recovered = (await f.operations())[0]; assert.equal(f.calls(), sent); assert.equal(recovered.code, "interrupted"); assert.equal(recovered.effect, "effect_unknown"); assert.equal(recovered.stopped, true); assert.ok(f.closeSessions.includes(String(scheduled.conversation.id)));
  await f.harness.commit(async tx => { assert.equal((await tx.entry(recovered.observation!))?.conversationId, scheduled.conversation.id); await verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, [String(scheduled.conversation.id)]); }, context);
  await restored.close();
});

test("durable 浏览器：封组后浏览器停止未核实保留可查询占用，原停止菜单核实后解除", async t => {
  const f = await fixture(t), scheduled = await f.scheduled(invoke("open", { url: "https://example.com" })), submission = await scheduled.submit(); await submission.wait(context);
  const operation = (await f.operations())[0]; await f.persistBinding(String(scheduled.conversation.id));
  await f.harness.commit(async tx => { assert.equal(await browserSourceBlocker(tx, scheduled.requestId), undefined); assert.equal(await browserSessionStopped(tx, scheduled.conversation.id), false); (await tx.doc(PersonalScheduleRunDoc, scheduled.run.id, null)).run!.sealed = true; }, context);
  const close = BrowserManager.prototype.close; BrowserManager.prototype.close = async () => false;
  assert.equal(await f.browser.stop(scheduled.conversation.id), false);
  await f.harness.commit(async tx => { assert.deepEqual(await browserSourceBlocker(tx, scheduled.requestId), { browser: String(operation.operation), admission: operation.admission, session: true }); assert.equal((await browserDetail(tx, operation.operation)).summary.canVerifyStop, true); }, context);
  const stopTask = await f.harness.commit(tx => f.browser.requestStop(tx, operation.operation), context); await f.harness.waitForTask(stopTask, context);
  await f.harness.commit(async tx => { assert.ok(await browserSourceBlocker(tx, scheduled.requestId)); }, context);
  BrowserManager.prototype.close = close; assert.equal(await f.browser.verifyStop(operation.operation), true);
  await f.harness.commit(async tx => { assert.equal(await browserSessionStopped(tx, scheduled.conversation.id), true); assert.equal(await browserSourceBlocker(tx, scheduled.requestId), undefined); assert.equal((await browserDetail(tx, operation.operation)).summary.canVerifyStop, false); await verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, [String(scheduled.conversation.id)]); }, context);
});
