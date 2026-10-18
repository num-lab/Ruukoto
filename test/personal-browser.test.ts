import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type ConversationId, type EntryId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BrowserManager, BrowserError, type BrowserBinding } from "@ruukoto/agent/browser-manager.ts";
import { personalBrowser, configureBrowser, browserOperations, browserRequestAllowed, browserSessionStopped, browserDetail, browserResolve, browserSourceBlocker, PersonalBrowserOperationDoc, PersonalBrowserDoc, PersonalBrowserSessionDoc, verifyBrowser, type PersonalBrowserOperation } from "../apps/ruukoto/src/personal-browser.ts";
import { personalLocalInput } from "../apps/ruukoto/src/personal-local-records.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { personalProvider, recordedModels, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { loadPersonalArtifact } from "../apps/ruukoto/src/personal-artifacts.ts";
import { parsePersonalBrowser, savePersonalBrowser, readPersonalBrowser } from "../apps/ruukoto/src/personal-browser-config.ts";
import { capturePersonalScheduleScope } from "../apps/ruukoto/src/personal-schedule-scope.ts";
import { PersonalSchedulesDoc, PersonalScheduleDoc, PersonalScheduleRunDoc, PersonalScheduledConversationDoc, ScheduleAdmission, ScheduleRunAdmission, SCHEDULE_RUN_TASK, SCHEDULE_INPUT, scheduleRequestId, scheduleAdmissionData, scheduleRunAdmissionData, type PersonalSchedule, type PersonalScheduleRun } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const invoke = (action: string, args: Record<string, unknown> = {}) => `browser:${JSON.stringify({ action, ...args })}`;
const responder: Responder = request => { const last = request.messages.at(-1), value = String(last?.content); return last?.role === "user" && value.startsWith("browser:") ? { kind: "tool_calls", calls: [{ id: "browser-call", name: "browser", arguments: JSON.parse(value.slice(8)) }] } : { kind: "text", text: value }; };
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < end, "等待浏览器状态超时"); await delay(5); } }
function binding(session = String(ROOT_CONVERSATION_ID), directory?: string): BrowserBinding { const id = directory && createHash("sha256").update(`${directory}\0${session}`).digest("hex").slice(0, 24); return { sessionId: session, generation: "first", kind: "owned", state: "ready", profileDir: null, socketDir: id ? `/tmp/ruukoto-browser-${process.getuid?.() ?? "unknown"}-${id}` : "", cliSession: id ? `rk-${id}` : "", cdpUrl: null, targetId: null, chrome: null, daemon: null, dashboard: null, chromePending: false, daemonPending: false, dashboardPending: false, lockDir: null, pauseTaskId: null, pauseAfterSeq: null, outcomeUnknown: false, failureCode: null, dashboardUrl: null, headed: false }; }
async function fixture(t: TestContext, respond = responder) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-browser-"))), directory = path.join(root, "profile"), lock = lockPersonalProfile(directory), model = new MockModelServer(respond);
  const modelConfig: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RK_BROWSER_TEST_KEY", contextWindow: 128000, maxTokens: 8192 }, previousKey = process.env[modelConfig.apiKeyEnv]; process.env[modelConfig.apiKeyEnv] = "test-only";
  let harness: Harness, current = binding(String(ROOT_CONVERSATION_ID), directory), calls = 0, closes = 0;
  const states = new Map<string, BrowserBinding>(), commandSessions: string[] = [], closeSessions: string[] = [], imageSources: ConversationId[] = [];
  const state = (session: string) => { if (session === String(ROOT_CONVERSATION_ID)) return current; if (!states.has(session)) states.set(session, binding(session, directory)); return states.get(session)!; };
  async function persistBinding(session: string) { await harness.commit(async tx => { const value = state(session), stateJson = JSON.stringify({ version: 1, bindings: [value] }), conversationId = Number(session) as ConversationId, doc = conversationId === ROOT_CONVERSATION_ID ? await tx.doc(PersonalBrowserDoc) : await tx.doc(PersonalBrowserSessionDoc, session, null); doc.stateJson = stateJson; doc.bindingEntry = (await tx.appendEntry(conversationId, { kind: "ruukoto.browser-binding-changed", data: { stateJson, sessionId: session, generation: value.generation, state: value.state } })).id; }, context); }
  const scheduledTask = defineTask<{ runId: string }, { phase: "hold" }, null>({ name: SCHEDULE_RUN_TASK, version: 1, initial: () => ({ phase: "hold" }), phases: { async hold(_task, runtime, taskContext) { await runtime.sleep(runtime.now() + 3600000, taskContext); } }, async abort(_task, runtime, taskContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: null } }), taskContext); } });
  const scheduledExtension = defineExtension({ name: "browser-scheduled-fixture", tasks: [scheduledTask] });
  const previous = { command: BrowserManager.prototype.command, status: BrowserManager.prototype.status, pause: BrowserManager.prototype.pause, resume: BrowserManager.prototype.resume, close: BrowserManager.prototype.close };
  BrowserManager.prototype.status = session => structuredClone(state(session));
  BrowserManager.prototype.close = async session => { closes++; closeSessions.push(session); state(session).state = "closed"; await persistBinding(session); return true; };
  BrowserManager.prototype.pause = async (session, task) => { const value = state(session); value.state = "paused"; value.pauseTaskId = task; await persistBinding(session); return structuredClone(value); };
  BrowserManager.prototype.resume = async session => { const value = state(session); value.state = "ready"; value.generation = "resumed"; await persistBinding(session); return structuredClone(value); };
  BrowserManager.prototype.command = async (session, args) => { calls++; commandSessions.push(session); if (args[0] === "screenshot") fs.writeFileSync(args[1], Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex")); return { data: { refs: { e1: { role: "button", name: "确认" } } } }; };
  const config = parsePersonalBrowser({ version: 1, generation: "browser-fixture", binaryPath: "/unused/agent-browser", chromePath: "/unused/chrome", headed: false });
  const browser = personalBrowser(directory, config, () => harness, { async registerImage(_tx, artifact, source) { imageSources.push(source.conversationId); return { type: "image", mimeType: artifact.mime, data: `ruukoto-image:${artifact.id}` }; } });
  const registry = createRegistry(); registry.install(browser.extension); registry.install(scheduledExtension);
  harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "personal.sqlite")), { models: recordedModels(personalProvider(modelConfig), async () => {}), registry }, context);
  const main = await harness.root(context, { agent: { model: { provider: "personal", modelId: "mock-model" }, thinkingLevel: "off", extensions: [browser.extension], tools: browser.extension.tools }, init: async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; await configureBrowser(tx, config); } });
  await browser.recover(); current = binding(String(ROOT_CONVERSATION_ID), directory); closes = 0; closeSessions.length = 0;
  t.after(async () => { await browser.close(); await harness.close(context); lock.release(); await model.close(); Object.assign(BrowserManager.prototype, previous); if (previousKey === undefined) delete process.env[modelConfig.apiKeyEnv]; else process.env[modelConfig.apiKeyEnv] = previousKey; fs.rmSync(root, { recursive: true, force: true }); });
  const submit = async (content: string, requestId: string) => { await harness.commit(tx => personalLocalInput(tx, requestId, content), context); return main.submit({ type: "input", content, requestId, whenBusy: "followUp" }, context); };
  const answer = async (content: string, requestId: string) => { const submitted = await submit(content, requestId); await submitted.wait(context); return submitted; };
  const operations = () => harness.commit(async tx => JSON.parse(JSON.stringify(await browserOperations(tx))) as PersonalBrowserOperation[], context);
  const scheduled = async (content: string, options: { mode?: "full_access" | "confirm"; browser?: boolean } = {}) => {
    const planId = randomUUID(), id = createHash("sha256").update(JSON.stringify([planId, 1, "2026-10-18T00:00:00.000Z"])).digest("hex"), requestId = scheduleRequestId(id), conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "personal", modelId: "mock-model" }, thinkingLevel: "off", extensions: [browser.extension, scheduledExtension], tools: browser.extension.tools } }, context);
    const run = await harness.commit(async tx => {
      const scope = await capturePersonalScheduleScope(tx), permission = { mode: options.mode ?? "full_access", version: 1 };
      if (options.browser === false) { scope.tools = scope.tools.filter(name => name !== "browser"); scope.extensions = scope.extensions.filter(name => name !== browser.extension.name); }
      const plan: PersonalSchedule = { id: planId, version: 1, requestId: `browser-plan:${id}`, label: "浏览器定时测试", instruction: content, rule: { kind: "once", at: "2026-10-18T00:00:00", timeZone: "UTC", disambiguation: "compatible" }, createdAt: "2026-10-18T00:00:00.000Z", createdBy: { actor: { kind: "local", requestId: "browser-creator" }, authority: { permission, proof: null } }, permission, scope, admission: 0 as EntryId, nextDueAt: null, canceled: false, activeRun: id };
      plan.admission = (await tx.appendEntry(ScheduleAdmission, ROOT_CONVERSATION_ID, { data: scheduleAdmissionData(plan) })).id;
      const taskId = await tx.createTask(scheduledTask, { runId: id }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
      const run: PersonalScheduleRun = { id, planId, planVersion: 1, scheduledFor: "2026-10-18T00:00:00.000Z", mergedFrom: "2026-10-18T00:00:00.000Z", mergedThrough: "2026-10-18T00:00:00.000Z", admission: 0 as EntryId, taskId, conversationId: conversation.id, requestId, cancelRequested: false, sealed: false, members: [] };
      run.admission = (await tx.appendEntry(ScheduleRunAdmission, conversation.id, { data: scheduleRunAdmissionData(run) })).id;
      (await tx.doc(PersonalScheduledConversationDoc, String(conversation.id), null)).runId = id;
      (await tx.doc(PersonalScheduleDoc, planId, null)).plan = plan; (await tx.doc(PersonalScheduleRunDoc, id, null)).run = run;
      const index = await tx.doc(PersonalSchedulesDoc); index.plans.push(planId); index.runs.push(id);
      return { ...run };
    }, context);
    return { conversation, requestId, run, submit: () => conversation.submit({ type: "input", requestId, content, entry: { kind: SCHEDULE_INPUT, data: { runId: id, admission: run.admission } } }, context) };
  };
  return { directory, harness, main, browser, model, submit, answer, operations, scheduled, commandSessions, closeSessions, imageSources, persistBinding, current: () => current, calls: () => calls, closes: () => closes };
}

test("durable 浏览器：仅当前唯一拥有者的完全访问来源开放，旧本机输入不随默认模式扩权", async t => {
  const f = await fixture(t);
  await f.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "confirm"; }, context);
  await f.answer(invoke("open", { url: "https://example.com" }), "restricted"); assert.equal(f.calls(), 0); assert.equal((await f.operations()).length, 0);
  await f.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
  await f.answer(invoke("open", { url: "https://example.com" }), "full"); assert.equal(f.calls(), 1); assert.equal((await f.operations())[0].effect, "returned");
  await f.harness.commit(async tx => { assert.equal(await browserRequestAllowed(tx, ROOT_CONVERSATION_ID, "restricted"), false); }, context);
  await assert.rejects(f.harness.commit(tx => verifyBrowser(tx, ["missing"], f.directory, f.browser.extension.tools), context), { code: "browser_record_invalid" });
});

test("durable 浏览器：导航丢答仅发送一次，网页效果与实际停止分开核实", async t => {
  const f = await fixture(t); let sent = 0;
  BrowserManager.prototype.command = async () => { sent++; throw new BrowserError("outcome_unknown", "原导航应答丢失", true); };
  await f.answer(invoke("open", { url: "https://example.com" }), "unknown");
  const operation = (await f.operations())[0]; assert.equal(sent, 1); assert.equal(operation.effect, "effect_unknown"); assert.equal(operation.stopped, true); assert.equal(f.closes(), 1);
  await f.harness.commit(async tx => { assert.equal((await browserSourceBlocker(tx, "unknown"))?.browser, String(operation.operation)); await browserResolve(tx, operation.operation, "applied", "拥有者核对目标网页已导航"); }, context);
  await f.harness.commit(async tx => { assert.equal(await browserSourceBlocker(tx, "unknown"), undefined); await verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools); }, context);
});

test("durable 浏览器：暂停前已排队输入不能恢复，新拥有者接纳才可恢复", async t => {
  let release!: () => void, first = true; const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async request => { if (first) { first = false; await hold; } return responder(request, 0); });
  const paused = await f.submit(invoke("pause"), "pause"); await until(() => f.model.calls.length === 1);
  const old = await f.submit(invoke("resume"), "queued-before-pause"); release(); await paused.wait(context); await old.wait(context);
  assert.equal(f.current().state, "paused"); assert.equal((await f.operations()).at(-1)?.code, "browser_paused");
  await f.answer(invoke("resume"), "accepted-after-pause"); assert.equal(f.current().state, "ready"); assert.equal(f.current().generation, "resumed");
  const values = await f.operations(); await f.harness.commit(tx => verifyBrowser(tx, values.map(value => String(value.operation)), f.directory, f.browser.extension.tools), context);
});

test("durable 浏览器：截图先落可校验产物，视觉结果只保留稳定图片引用", async t => {
  const f = await fixture(t); await f.answer(invoke("screenshot"), "screenshot");
  const operation = (await f.operations())[0]; assert.ok(operation.artifact); assert.equal(operation.artifact.mime, "image/png"); assert.match(operation.image!.data, /^ruukoto-image:/); assert.equal(loadPersonalArtifact(f.directory, operation.artifact).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const entries = (await f.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  assert.ok(JSON.stringify(entries).includes(operation.image!.data)); assert.ok(!JSON.stringify(entries).includes("iVBORw0KGgo"));
  await f.harness.commit(tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools), context);
});

test("durable 浏览器：取消在途写动作先收旧浏览器，保留网页效果未知", async t => {
  const f = await fixture(t); let sent = 0;
  BrowserManager.prototype.command = async (_session, _args, signal) => { sent++; return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new BrowserError("outcome_unknown", "已发动作取消", true)), { once: true })); };
  const submission = await f.submit(invoke("open", { url: "https://example.com" }), "cancel"); await until(() => sent === 1); await f.main.abort(context); await submission.wait(context);
  const operation = (await f.operations())[0]; assert.equal(operation.effect, "effect_unknown"); assert.equal(operation.stopped, true); assert.equal(sent, 1); assert.equal(f.closes(), 1);
});

test("durable 浏览器：缺观察恢复只停止原浏览器，不重发已开始动作", async t => {
  const f = await fixture(t); await f.answer(invoke("open", { url: "https://example.com" }), "original");
  const operation = (await f.operations())[0], sent = f.calls();
  await f.harness.commit(async tx => { const value = (await tx.doc(PersonalBrowserOperationDoc, String(operation.operation), null)).operation!; delete value.observation; delete value.result; value.effect = "effect_unknown"; value.code = "started"; value.stopped = false; }, context);
  await f.browser.recover();
  const recovered = (await f.operations())[0]; assert.equal(f.calls(), sent); assert.equal(recovered.effect, "effect_unknown"); assert.equal(recovered.code, "interrupted"); assert.equal(recovered.stopped, true);
  await f.answer(invoke("open", { url: "https://example.com/again" }), "other-source"); assert.equal(f.calls(), sent);
  await f.answer(invoke("status"), "status-source"); assert.equal((await f.operations()).at(-1)?.effect, "returned");
  const values = await f.operations(); await f.harness.commit(tx => verifyBrowser(tx, values.map(value => String(value.operation)), f.directory, f.browser.extension.tools), context);
});

test("durable 浏览器：停止未核实继续保留占用，后台停止核实不解除未知网页效果", async t => {
  const f = await fixture(t); let verified = false;
  BrowserManager.prototype.close = async () => verified;
  BrowserManager.prototype.command = async () => { throw new BrowserError("outcome_unknown", "原写动作应答丢失", true); };
  await f.answer(invoke("open", { url: "https://example.com" }), "stop-unverified"); const operation = (await f.operations())[0]; assert.equal(operation.stopped, false);
  const stopTask = await f.harness.commit(tx => f.browser.requestStop(tx, operation.operation), context); f.harness.resume(); await f.harness.waitForTask(stopTask, context); assert.equal((await f.operations())[0].stopped, false);
  verified = true; assert.equal(await f.browser.verifyStop(operation.operation), true);
  assert.equal((await f.operations())[0].stopped, true); await f.harness.commit(async tx => { assert.ok(await browserSourceBlocker(tx, "stop-unverified")); }, context);
  await f.harness.commit(tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools), context);
});

test("durable 浏览器：长网页结果只返回预览，完整原JSON作为产物保留", async t => {
  const f = await fixture(t), body = { refs: { e1: { text: "长网页".repeat(3000) } } };
  BrowserManager.prototype.command = async () => ({ data: body }); await f.answer(invoke("snapshot"), "long-snapshot"); const operation = (await f.operations())[0];
  assert.ok(operation.artifact); assert.equal(operation.image, undefined); assert.deepEqual(JSON.parse(loadPersonalArtifact(f.directory, operation.artifact).toString("utf8")), body); assert.ok(JSON.stringify(operation.result).length < 4000);
});

test("durable 浏览器：恢复核实使用同一SDK参数规范化，不把字符串数值误判为篡改", async t => {
  const f = await fixture(t); await f.answer(invoke("scroll", { direction: "down", pixels: "123" }), "coerced-params");
  const operation = (await f.operations())[0]; assert.equal(operation.params.pixels, 123); assert.equal(operation.effect, "returned");
  await f.harness.commit(tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools), context);
});

test("durable 浏览器：删除未知操作的document与索引不能抹掉原历史暂停事实", async t => {
  const f = await fixture(t); BrowserManager.prototype.command = async () => { throw new BrowserError("outcome_unknown", "已发导航丢答", true); };
  await f.answer(invoke("open", { url: "https://example.com" }), "hidden-operation"); const operation = (await f.operations())[0];
  await f.harness.commit(async tx => { delete (await tx.doc(PersonalBrowserOperationDoc, String(operation.operation), null)).operation; (await tx.doc(PersonalBrowserDoc)).operations = []; }, context);
  await assert.rejects(f.harness.commit(tx => verifyBrowser(tx, [], f.directory, f.browser.extension.tools), context), { code: "browser_record_invalid" });
});

test("durable 浏览器：抹掉配置或最近停止任务指针都在恢复前拒绝", async t => {
  const f = await fixture(t); BrowserManager.prototype.command = async () => { throw new BrowserError("outcome_unknown", "已发导航丢答", true); }; BrowserManager.prototype.close = async () => false;
  await f.answer(invoke("open", { url: "https://example.com" }), "stop-pointer"); const operation = (await f.operations())[0];
  const stop = await f.harness.commit(tx => f.browser.requestStop(tx, operation.operation), context); f.harness.resume(); await f.harness.waitForTask(stop, context);
  await f.harness.commit(async tx => { delete (await tx.doc(PersonalBrowserOperationDoc, String(operation.operation), null)).operation!.stopTask; }, context);
  await assert.rejects(f.harness.commit(tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools), context), { code: "browser_record_invalid" });
  await f.harness.commit(async tx => { (await tx.doc(PersonalBrowserOperationDoc, String(operation.operation), null)).operation!.stopTask = stop; delete (await tx.doc(PersonalBrowserDoc)).config; }, context);
  await assert.rejects(f.harness.commit(tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools), context), { code: "browser_record_invalid" });
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
  for (const request of [f.model.calls[0], f.model.calls.at(-1)!]) assert.match(JSON.stringify(request.tools), /独立定时会话暂停后不能resume/);
  assert.equal(operation.effect, "returned"); assert.equal(operation.origin.conversationId, scheduled.conversation.id); assert.equal(operation.origin.source.requestId, scheduled.requestId);
  assert.deepEqual(f.imageSources, [ROOT_CONVERSATION_ID, scheduled.conversation.id]); assert.equal(f.commandSessions.at(-1), String(scheduled.conversation.id));
  await f.harness.commit(async tx => { assert.equal((await tx.entry(operation.origin.source.entryId))?.kind, SCHEDULE_INPUT); assert.equal((await tx.entry(operation.admission))?.conversationId, scheduled.conversation.id); await verifyBrowser(tx, values.map(value => String(value.operation)), f.directory, f.browser.extension.tools, [String(scheduled.conversation.id)]); }, context);
  assert.equal((await f.harness.snapshot(PersonalBrowserDoc, context))?.pause, undefined);
});

for (const limit of ["mode", "scope"] as const) test(`durable 浏览器：定时创建时${limit}未开放不会因主会话完全访问而扩权`, async t => {
  const f = await fixture(t), scheduled = await f.scheduled(invoke("open", { url: "https://example.com" }), limit === "mode" ? { mode: "confirm" } : { browser: false });
  const submission = await scheduled.submit(); await submission.wait(context);
  assert.equal(f.calls(), 0); assert.equal((await f.operations()).length, 0);
});

test("durable 浏览器：定时未知动作只阻塞原来源并保留其他会话快照", async t => {
  const f = await fixture(t); await f.answer(invoke("snapshot"), "main-snapshot");
  const command = BrowserManager.prototype.command, scheduled = await f.scheduled(invoke("open", { url: "https://example.com" })); let sent = 0;
  BrowserManager.prototype.command = async (session, args, signal) => { if (session === String(scheduled.conversation.id)) { sent++; throw new BrowserError("outcome_unknown", "定时网页写入丢答", true); } return command.call(f.browser.manager(), session, args, signal); };
  const submission = await scheduled.submit(); await submission.wait(context); const operation = (await f.operations()).at(-1)!;
  assert.equal(operation.effect, "effect_unknown"); assert.equal(sent, 1); assert.deepEqual(f.closeSessions, [String(scheduled.conversation.id)]);
  await f.answer(invoke("click", { ref: "e1" }), "main-still-usable"); assert.equal((await f.operations()).at(-1)?.effect, "returned");
  const other = await f.scheduled(invoke("snapshot")), second = await other.submit(); await second.wait(context); assert.equal((await f.operations()).at(-1)?.effect, "returned");
  await f.harness.commit(async tx => { assert.equal((await browserSourceBlocker(tx, scheduled.requestId))?.browser, String(operation.operation)); assert.equal(await browserSourceBlocker(tx, "main-snapshot"), undefined); assert.equal(await browserSourceBlocker(tx, other.requestId), undefined); }, context);
  const values = await f.operations(); await f.harness.commit(tx => verifyBrowser(tx, values.map(value => String(value.operation)), f.directory, f.browser.extension.tools, [String(scheduled.conversation.id), String(other.conversation.id)]), context);
});

test("durable 浏览器：定时人工暂停保留占用，关闭核实只解除原会话等待", async t => {
  const f = await fixture(t), scheduled = await f.scheduled(invoke("pause")), submission = await scheduled.submit(); await submission.wait(context);
  const operation = (await f.operations())[0], session = await f.harness.snapshot(PersonalBrowserSessionDoc, String(scheduled.conversation.id), context);
  assert.ok(session?.pause); assert.equal((await f.harness.snapshot(PersonalBrowserDoc, context))?.pause, undefined);
  await f.harness.commit(async tx => { assert.equal((await browserSourceBlocker(tx, scheduled.requestId))?.pause, session.pause!.entry); }, context);
  await f.answer(invoke("resume"), "main-cannot-resume-scheduled"); assert.equal((await f.operations()).at(-1)?.code, "browser_paused");
  await f.harness.commit(async tx => { assert.ok(await browserSourceBlocker(tx, scheduled.requestId)); }, context);
  await f.browser.stop(scheduled.conversation.id);
  await f.harness.commit(async tx => { assert.equal(await browserSourceBlocker(tx, scheduled.requestId), undefined); const values = await browserOperations(tx); await verifyBrowser(tx, values.map(value => String(value.operation)), f.directory, f.browser.extension.tools, [String(scheduled.conversation.id)]); assert.equal(operation.origin.conversationId, scheduled.conversation.id); }, context);
});

test("durable 浏览器：定时绑定或暂停索引删除及跨会话借用均在恢复前拒绝", async t => {
  const f = await fixture(t), scheduled = await f.scheduled(invoke("pause")), submission = await scheduled.submit(); await submission.wait(context);
  const operation = (await f.operations())[0], session = await f.harness.snapshot(PersonalBrowserSessionDoc, String(scheduled.conversation.id), context); assert.ok(session);
  await f.harness.commit(async tx => { const doc = await tx.doc(PersonalBrowserSessionDoc, String(scheduled.conversation.id), null); delete doc.pause; }, context);
  await assert.rejects(f.harness.commit(tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, [String(scheduled.conversation.id)]), context), { code: "browser_record_invalid" });
  await f.harness.commit(async tx => { Object.assign(await tx.doc(PersonalBrowserSessionDoc, String(scheduled.conversation.id), null), session); (await tx.doc(PersonalBrowserDoc)).sessions = []; }, context);
  await assert.rejects(f.harness.commit(tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, [String(scheduled.conversation.id)]), context), { code: "browser_record_invalid" });
  await f.harness.commit(async tx => { (await tx.doc(PersonalBrowserDoc)).sessions = [scheduled.conversation.id]; const doc = await tx.doc(PersonalBrowserSessionDoc, String(scheduled.conversation.id), null), root = await tx.doc(PersonalBrowserDoc); doc.stateJson = root.stateJson; doc.bindingEntry = root.bindingEntry; }, context);
  await assert.rejects(f.harness.commit(tx => verifyBrowser(tx, [String(operation.operation)], f.directory, f.browser.extension.tools, [String(scheduled.conversation.id)]), context), { code: "browser_record_invalid" });
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
