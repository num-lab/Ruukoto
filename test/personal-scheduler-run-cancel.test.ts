import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, ROOT_CONVERSATION_ID, createRegistry, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { authorizePersonalSchedule, validatePersonalScheduleActor, verifyPersonalScheduleRunCancellation } from "../apps/ruukoto/src/personal-schedule-authority.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc, type TelegramControlInput, type TelegramReceipt, type TelegramResult } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { personalScheduler } from "../apps/ruukoto/src/personal-scheduler.ts";
import { PersonalScheduleDoc, PersonalScheduleRunDoc, PersonalSchedulesDoc, ScheduleRunCancellation, personalScheduledSource } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { PersonalWorkDoc, PersonalWorkTask, personalBackgroundWork } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, "Schedule run did not settle"); await delay(5); }
}

test("Schedule run cancellation: real authority commits populated member cancellation before table writes", async t => {
  let harness!: Harness;
  const scheduler = personalScheduler(() => harness, { validateActor: validatePersonalScheduleActor, authorize: authorizePersonalSchedule, verifyCreator: async () => {}, captureScope: async () => ({ tools: [], extensions: [], snapshot: {} }), verifyScope: async () => {}, configure: async () => {}, settle: async () => ({ failed: false, facts: "settled" }), send: async () => "sent", now: () => Date.parse("2026-10-18T00:00:00Z") });
  const registry = createRegistry(); registry.install(scheduler.extension); registry.install(personalBackgroundWork);
  const models = recordedModels(personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "RUN_CANCEL_UNUSED_KEY", contextWindow: 4096, maxTokens: 1024 }), async () => { assert.fail("Transaction fixture cannot invoke a model"); });
  harness = await Harness.open(new MemoryStorage(), { registry, models }, context); const main = await harness.root(context); t.after(() => harness.close(context));
  const plan = await harness.commit(tx => scheduler.create(tx, { requestId: "populated", label: "Populated run", instruction: "Work", rule: { kind: "daily", time: "00:01", time_zone: "UTC" } }, { kind: "local", requestId: "populated" }), context);
  await harness.commit(tx => scheduler.scan(tx, Date.parse("2026-10-18T00:01:02Z")), context);
  const runId = (await harness.snapshot(PersonalScheduleDoc, plan.id, context))!.plan!.activeRun!;
  const ref = await harness.commit(async tx => {
    const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const taskId = await tx.createTask(PersonalWorkTask, { requestId: "member", agentId: child.id, content: "Member" }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
    const ref = { requestId: "member", taskId, agentId: child.id };
    (await tx.doc(PersonalWorkDoc, ref.requestId, null)).ref = ref;
    (await tx.doc(PersonalScheduleRunDoc, runId, null)).run!.members.push(ref);
    return ref;
  }, context);
  const canceled = await harness.commit(tx => scheduler.cancelRun(tx, runId, { kind: "local", requestId: "cancel-populated" }), context);
  assert.equal(canceled.cancelRequested, true); assert.equal(canceled.sealed, true); assert.ok(canceled.cancelEntry);
  assert.equal((await harness.snapshot(PersonalWorkDoc, ref.requestId, context))!.cancelRequested, true);
  const future = (await harness.snapshot(PersonalScheduleDoc, plan.id, context))!.plan!;
  assert.equal(future.canceled, false); assert.equal(future.nextDueAt, "2026-10-19T00:01:00.000Z"); assert.deepEqual(future.createdBy, plan.createdBy);
  const cancellation = await harness.commit(tx => tx.entry(ScheduleRunCancellation, canceled.cancelEntry!), context); assert.equal(cancellation?.data.reason, "owner");
  const before = (await main.entries({ order: "ascending" }, 256, undefined, context)).items.filter(entry => entry.kind === "ruukoto.schedule-authority");
  const duplicate = await harness.commit(tx => scheduler.cancelRun(tx, runId, { kind: "local", requestId: "cancel-repeat" }), context);
  assert.equal(duplicate.cancelEntry, canceled.cancelEntry);
  const after = (await main.entries({ order: "ascending" }, 256, undefined, context)).items.filter(entry => entry.kind === "ruukoto.schedule-authority");
  assert.deepEqual(after, before);
  await assert.rejects(harness.commit(tx => scheduler.cancelRun(tx, runId, { kind: "local", requestId: " " }), context), code("schedule_authority_invalid"));
  await assert.rejects(harness.commit(tx => scheduler.cancelRun(tx, runId, { kind: "local", requestId: "x".repeat(257) }), context), code("schedule_authority_invalid"));
});

async function runningFixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-cancel-run-")));
  let waiting = true;
  const model = new PersonalMockModelServer(async request => {
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content === "delegate-member") return { kind: "tool_calls", calls: [{ id: "member", name: "background_work", arguments: { action: "delegate", content: "held-member" } }] };
    if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith("cancel-run:")) return { kind: "tool_calls", calls: [{ id: "cancel", name: "schedule_cancel", arguments: { run: last.content.slice("cancel-run:".length) } }] };
    if (last?.role === "user" && last.content === "held-member") while (waiting) await delay(5);
    return { kind: "text", text: "complete" };
  });
  const key = "RUUKOTO_RUN_CANCEL_TEST_KEY", previous = process.env[key]; process.env[key] = "test-only";
  const provider = personalProvider({ api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 8192 });
  let p: PersonalHarness | undefined, clock = Date.parse("2026-10-18T00:00:00Z");
  const open = async () => p = await openPersonalHarness({ directory, provider, modelId: "mock-model", now: () => clock });
  t.after(async () => { waiting = false; await p?.close(); await model.close(); fs.rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  p = await open();
  const plan = await p.harness.commit(tx => p!.scheduler.create(tx, { requestId: "live-plan", label: "Recurring work", instruction: "delegate-member", rule: { kind: "daily", time: "00:01", time_zone: "UTC" } }, { kind: "local", requestId: "live-plan" }), context);
  clock = Date.parse("2026-10-18T00:01:02Z"); await p.harness.commit(tx => p!.scheduler.scan(tx, clock), context);
  const id = (await p.harness.snapshot(PersonalScheduleDoc, plan.id, context))!.plan!.activeRun!;
  const run = () => p!.harness.snapshot(PersonalScheduleRunDoc, id, context).then(value => value!.run!);
  await until(async () => (await run()).members.length === 1 && model.calls.some(request => request.messages.at(-1)?.content === "held-member"));
  return { p, plan, id, model, open, run, release: () => { waiting = false; }, time: (value: string) => { clock = Date.parse(value); }, now: () => clock };
}

test("Schedule run cancellation: original authority and member identity survive reopen, future occurrence remains enabled", { timeout: 20000 }, async t => {
  const f = await runningFixture(t), original = await f.run(), member = original.members[0];
  const source = await f.p.harness.commit(tx => personalScheduledSource(tx, original.requestId), context); assert.ok(source);
  const memberBefore = await f.p.harness.snapshot(PersonalWorkDoc, member.requestId, context);
  const canceled = await f.p.harness.commit(tx => f.p.scheduler.cancelRun(tx, f.id, { kind: "local", requestId: "owner-cancel" }), context);
  assert.equal(canceled.cancelRequested, true); assert.equal(canceled.result, undefined);
  assert.equal((await f.p.harness.snapshot(PersonalWorkDoc, member.requestId, context))!.cancelRequested, true);
  assert.equal(await f.p.answer("independent main input", "independent-main"), "complete");
  f.release(); await f.p.harness.waitForTask(original.taskId, context);
  const settled = await f.run(); assert.equal(settled.result?.status, "canceled"); assert.equal(settled.delivery?.state, "canceled");
  const scheduled = await f.p.harness.snapshot(PersonalScheduleDoc, f.plan.id, context); assert.equal(scheduled!.plan!.nextDueAt, "2026-10-19T00:01:00.000Z"); assert.equal(scheduled!.plan!.canceled, false);
  await f.p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "full_access"; permission.version++; }, context);
  await f.p.close(); const reopened = await f.open();
  const historical = (await reopened.harness.snapshot(PersonalScheduleRunDoc, f.id, context))!.run!, memberAfter = await reopened.harness.snapshot(PersonalWorkDoc, member.requestId, context);
  assert.equal(historical.cancelEntry, canceled.cancelEntry); assert.deepEqual(historical.members, original.members); assert.equal(historical.result?.status, "canceled");
  assert.deepEqual(memberAfter!.source, memberBefore!.source); assert.deepEqual(memberAfter!.permission, memberBefore!.permission);
  assert.deepEqual((await reopened.harness.commit(tx => reopened.scheduler.get(tx, f.plan.id), context)).createdBy, f.plan.createdBy);
  const recoveredSource = await reopened.harness.commit(tx => personalScheduledSource(tx, original.requestId), context); assert.deepEqual(recoveredSource!.permission, source.permission);
  f.time("2026-10-19T00:01:02Z"); await reopened.harness.commit(tx => reopened.scheduler.scan(tx, f.now()), context);
  let nextId = "";
  await until(async () => { const ids = (await reopened.harness.snapshot(PersonalSchedulesDoc, context))!.runs; for (const id of ids) { const value = (await reopened.harness.snapshot(PersonalScheduleRunDoc, id, context))!.run!; if (value.planId === f.plan.id && id !== f.id) { nextId = id; return true; } } return false; });
  await until(async () => !!(await reopened.harness.snapshot(PersonalScheduleRunDoc, nextId, context))?.run?.result);
  const next = (await reopened.harness.snapshot(PersonalScheduleRunDoc, nextId, context))!.run!;
  assert.equal(next.result?.status, "completed");
  const nextMember = await reopened.harness.snapshot(PersonalWorkDoc, next.members[0].requestId, context); assert.deepEqual(nextMember!.permission, f.plan.permission);
});

test("Schedule run cancellation: repeated and finished requests still require a valid actor", { timeout: 20000 }, async t => {
  const f = await runningFixture(t);
  const scheduled = await f.run();
  await f.p.harness.commit(tx => f.p.scheduler.cancelRun(tx, f.id, { kind: "local", requestId: "authorized" }), context);
  const badModel = { kind: "model" as const, conversationId: ROOT_CONVERSATION_ID, taskId: scheduled.taskId, requestId: "missing" };
  await assert.rejects(f.p.harness.commit(tx => f.p.scheduler.cancelRun(tx, f.id, badModel), context), code("tool_inactive"));
  await assert.rejects(f.p.harness.commit(tx => f.p.scheduler.cancelRun(tx, f.id, { kind: "im", menuRequestId: "missing", input: { requestId: "missing", content: "取消本次运行", direct: false, generation: "foreign", botId: "123", ownerId: "456", delivery: "waiting", messageId: 1, updateId: 1 } }), context), code("schedule_authority_invalid"));
  f.release(); await f.p.harness.waitForTask(scheduled.taskId, context);
  await assert.rejects(f.p.harness.commit(tx => f.p.scheduler.cancelRun(tx, f.id, badModel), context), code("tool_inactive"));
  const before = (await f.p.main.entries({ order: "ascending" }, 256, undefined, context)).items.filter(entry => entry.kind === "ruukoto.schedule-authority");
  const repeated = await f.p.harness.commit(tx => f.p.scheduler.cancelRun(tx, f.id, { kind: "local", requestId: "repeat-finished" }), context); assert.equal(repeated.result?.status, "canceled");
  const after = (await f.p.main.entries({ order: "ascending" }, 256, undefined, context)).items.filter(entry => entry.kind === "ruukoto.schedule-authority"); assert.deepEqual(after, before);
  assert.equal((await f.p.harness.snapshot(PersonalSchedulesDoc, context))!.plans.length, 1);
});

test("Schedule run cancellation: an actual main tool records its exact target and reopens without canceling the plan", { timeout: 20000 }, async t => {
  const f = await runningFixture(t), original = await f.run();
  assert.equal(await f.p.answer(`cancel-run:${f.id}`, "cancel-input"), "complete");
  const canceled = await f.run(), proof = await f.p.harness.commit(tx => tx.entry(ScheduleRunCancellation, canceled.cancelEntry!), context);
  assert.ok(proof); const data = proof.data;
  assert.equal(data.reason, "owner"); if (data.reason !== "owner") assert.fail("Cancellation has no owner authority");
  assert.equal(data.actor.kind, "model"); if (data.actor.kind !== "model") assert.fail("Cancellation has no model source");
  assert.equal(data.actor.requestId, "cancel-input"); assert.equal(data.runId, f.id);
  const taskId = data.actor.taskId, tool = await f.p.harness.commit(tx => tx.task(taskId), context); assert.equal(tool!.kind, "pi.tool");
  f.release(); await f.p.harness.waitForTask(original.taskId, context);
  await f.p.close(); const reopened = await f.open();
  assert.equal((await reopened.harness.snapshot(PersonalScheduleRunDoc, f.id, context))!.run!.cancelEntry, canceled.cancelEntry);
  assert.equal((await reopened.harness.commit(tx => reopened.scheduler.get(tx, f.plan.id), context)).canceled, false);
});

test("Schedule run cancellation: later plan cancellation retains the original run cancellation evidence", { timeout: 20000 }, async t => {
  const f = await runningFixture(t), original = await f.run();
  const canceled = await f.p.harness.commit(tx => f.p.scheduler.cancelRun(tx, f.id, { kind: "local", requestId: "run-first" }), context);
  const plan = await f.p.harness.commit(tx => f.p.scheduler.cancel(tx, f.plan.id, { kind: "local", requestId: "future-second" }), context);
  assert.equal(plan.canceled, true); assert.equal(plan.nextDueAt, null); assert.notEqual(plan.cancelEntry, canceled.cancelEntry);
  assert.equal((await f.run()).cancelEntry, canceled.cancelEntry);
  f.release(); await f.p.harness.waitForTask(original.taskId, context);
  await f.p.close(); const reopened = await f.open();
  assert.equal((await reopened.harness.snapshot(PersonalScheduleRunDoc, f.id, context))!.run!.cancelEntry, canceled.cancelEntry);
  assert.equal((await reopened.harness.commit(tx => reopened.scheduler.get(tx, f.plan.id), context)).cancelEntry, plan.cancelEntry);
  f.time("2026-10-19T00:01:02Z"); assert.equal(await reopened.harness.commit(tx => reopened.scheduler.scan(tx, f.now()), context), 0);
});

test("Schedule run cancellation: real IM authority requires the original run menu on repeated requests", async t => {
  let harness!: Harness;
  const scheduler = personalScheduler(() => harness, { validateActor: validatePersonalScheduleActor, authorize: authorizePersonalSchedule, verifyCreator: async () => {}, captureScope: async () => ({ tools: [], extensions: [], snapshot: {} }), verifyScope: async () => {}, configure: async () => {}, settle: async () => ({ failed: false, facts: "settled" }), send: async () => "sent", now: () => Date.parse("2026-10-18T00:00:00Z") });
  const receiptTask = defineTask<{ requestId: string }, { phase: "done" }, TelegramResult>({ name: "ruukoto.telegram-input", version: 1, initial: () => ({ phase: "done" }), phases: { async done() { assert.fail("Receipt fixture cannot execute"); } }, async abort() {} });
  const registry = createRegistry(); registry.install(scheduler.extension); registry.install(defineExtension({ name: "test-run-cancel-im", tasks: [receiptTask] }));
  const models = recordedModels(personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "RUN_CANCEL_IM_UNUSED_KEY", contextWindow: 4096, maxTokens: 1024 }), async () => { assert.fail("IM authority fixture cannot invoke a model"); });
  harness = await Harness.open(new MemoryStorage(), { registry, models }, context); await harness.root(context); t.after(() => harness.close(context));
  const original = { botId: "123", ownerId: "456", generation: "original-entry", mode: "confirm" as const, version: 2 };
  let serial = 0;
  const receipt = (value: TelegramControlInput) => harness.commit(async tx => {
    const taskId = await tx.createTask(receiptTask, { requestId: value.requestId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
    const saved: TelegramReceipt = { ...value, taskId }; (await tx.doc(PersonalTelegramReceiptDoc, value.requestId, null)).receipt = saved; return saved;
  }, context);
  const base = () => ({ requestId: `menu-${++serial}`, botId: original.botId, ownerId: original.ownerId, generation: original.generation, messageId: serial, updateId: serial, direct: true, control: true, delivery: "sent" as const, platformMessageId: String(serial) });
  await harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config = { version: 1, enabled: true, botId: original.botId, ownerId: original.ownerId, generation: original.generation, apiBase: "https://api.telegram.org", tokenEnv: "RUN_CANCEL_IM_UNUSED_TOKEN", tokenDigest: "0".repeat(64), boundary: 0 }; const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = original.mode; permission.version = original.version; }, context);
  const draft = await receipt({ ...base(), content: "确认草稿", selection: { kind: "schedule-draft", draft: { requestId: "im-plan", step: "confirm", kind: "daily", timeZone: "UTC", time: "00:01", label: "Original IM plan", instruction: "Work" } } });
  const createInput: TelegramControlInput = { ...base(), content: "确认创建计划", replyTo: draft.messageId, replyBotId: original.botId };
  const plan = await harness.commit(tx => scheduler.create(tx, { requestId: "im-plan", label: "Original IM plan", instruction: "Work", rule: { kind: "daily", time: "00:01", time_zone: "UTC" } }, { kind: "im", input: createInput, menuRequestId: draft.requestId }), context);
  await harness.commit(tx => scheduler.scan(tx, Date.parse("2026-10-18T00:01:02Z")), context);
  const id = (await harness.snapshot(PersonalScheduleDoc, plan.id, context))!.plan!.activeRun!;
  const menu = await receipt({ ...base(), content: "刷新运行", selection: { kind: "schedule-run", id: plan.id, runId: id } });
  const input: TelegramControlInput = { ...base(), content: "取消本次运行", delivery: "waiting", replyTo: menu.messageId, replyBotId: original.botId };
  const actor = { kind: "im" as const, input, menuRequestId: menu.requestId };
  const canceled = await harness.commit(tx => scheduler.cancelRun(tx, id, actor), context);
  assert.equal(canceled.cancelRequested, true);
  const entry = await harness.commit(tx => tx.entry(ScheduleRunCancellation, canceled.cancelEntry!), context); assert.ok(entry);
  await receipt({ ...input, scheduleRunCancel: { runId: id }, delivery: "sent" });
  await harness.commit(tx => verifyPersonalScheduleRunCancellation(tx, canceled, entry.data), context);
  await harness.commit(tx => scheduler.cancelRun(tx, id, actor), context);
  await harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config!.generation = "changed-entry"; }, context);
  await assert.rejects(harness.commit(tx => scheduler.cancelRun(tx, id, actor), context), code("schedule_authority_invalid"));
  const foreignMenu = await receipt({ ...base(), generation: "changed-entry", content: "刷新运行", selection: { kind: "schedule-run", id: plan.id, runId: id } });
  const foreignActor = { kind: "im" as const, input: { ...base(), generation: "changed-entry", content: "取消本次运行", replyTo: foreignMenu.messageId, replyBotId: original.botId }, menuRequestId: foreignMenu.requestId };
  await assert.rejects(harness.commit(tx => scheduler.cancelRun(tx, id, foreignActor), context), code("schedule_original_entry"));
});
