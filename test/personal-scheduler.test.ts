import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, configure, createRegistry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { personalScheduler, type PersonalSchedulerDeps } from "../apps/ruukoto/src/personal-scheduler.ts";
import { PersonalScheduleDoc, PersonalScheduleRunDoc, PersonalSchedulesDoc, PersonalScheduledConversationDoc, ScheduleSummary, ScheduleResult, ScheduleSendAdmission, personalScheduledSource, requireScheduledSourceReady, scheduledConversation, verifySchedules, type PersonalScheduleRun, type PersonalScheduleScope } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalImApiError } from "../apps/ruukoto/src/personal-im-api.ts";
import { PersonalTelegramDoc, type TelegramControlInput } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (value: string) => (error: unknown) => error instanceof PersonalError && error.code === value;
async function until(check: () => Promise<boolean>) { const end = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < end, "等待定时工作超时"); await delay(5); } }
async function fixture(t: TestContext, responder: Responder = () => ({ kind: "text", text: "本次工作完成" }), overrides: Partial<PersonalSchedulerDeps> = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "rk-schedule-")), server = new MockModelServer(responder), prior = process.env.RUUKOTO_SCHEDULE_TEST_KEY;
  process.env.RUUKOTO_SCHEDULE_TEST_KEY = "test-only";
  const provider = personalProvider({ api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_SCHEDULE_TEST_KEY", contextWindow: 128000, maxTokens: 8192 });
  let harness!: Harness, clock = Date.parse("2026-10-18T00:00:00Z"), scope: PersonalScheduleScope = { tools: [], extensions: [], snapshot: { revision: 1 } };
  const scheduler = personalScheduler(() => harness, { authorize: async () => ({ permission: { mode: "auto-review", version: 1 }, proof: { authenticated: true } }), verifyCreator: async (_tx, plan) => { assert.deepEqual(plan.createdBy.authority.proof, { authenticated: true }); }, captureScope: async () => structuredClone(scope), verifyScope: async (_tx, saved) => { if (JSON.stringify(saved) !== JSON.stringify(scope)) throw new PersonalError("schedule_scope_changed", "配置已变化。"); }, configure: async (tx, conversationId) => { await configure(tx, conversationId, { model: { provider: provider.id, modelId: "mock-model" }, thinkingLevel: "off", extensions: [scheduler.extension], tools: [] }); }, settle: async () => ({ failed: false, facts: "全部外部工作已核实" }), send: async () => "sent", now: () => clock, ...overrides });
  const registry = createRegistry(); registry.install(scheduler.extension);
  const open = async () => {
    harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "personal.sqlite")), { registry, models: recordedModels(provider, async () => undefined) }, context);
    await harness.root(context, { agent: { model: { provider: provider.id, modelId: "mock-model" }, thinkingLevel: "off", extensions: [scheduler.extension], tools: [] } });
    return harness;
  };
  await open();
  t.after(async () => { await harness.close(context); await server.close(); fs.rmSync(directory, { recursive: true, force: true }); if (prior === undefined) delete process.env.RUUKOTO_SCHEDULE_TEST_KEY; else process.env.RUUKOTO_SCHEDULE_TEST_KEY = prior; });
  return { get harness() { return harness; }, scheduler, server, open, time: (value: string) => { clock = Date.parse(value); }, scope: (value: PersonalScheduleScope) => { scope = value; },
    create: (requestId: string, rule: unknown = { kind: "once", at: "2026-10-18T00:00:01Z", time_zone: "UTC" }) => harness.commit(tx => scheduler.create(tx, { requestId, label: "测试定时工作", instruction: "本轮独立工作说明", rule }, { kind: "local", requestId }), context),
    run: async (id: string) => harness.commit(async tx => { const plan = (await tx.doc(PersonalScheduleDoc, id, null)).plan!; return plan.activeRun ? JSON.parse(JSON.stringify((await tx.doc(PersonalScheduleRunDoc, plan.activeRun, null)).run!)) as PersonalScheduleRun : undefined; }, context),
  };
}

test("定时：创建同键去重、异参拒绝；一次性接纳和真实custom source反链跨重启保持", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async () => { await gate; return { kind: "text", text: "本次完成" }; });
  const plan = await f.create("once"); assert.deepEqual(await f.create("once"), plan);
  await assert.rejects(f.harness.commit(tx => f.scheduler.create(tx, { requestId: "once", label: "不同说明", instruction: "另一个任务", rule: plan.rule }, { kind: "local", requestId: "once" }), context), code("schedule_request_conflict"));
  assert.equal(await f.harness.commit(tx => f.scheduler.createByRequest(tx, "missing"), context), null);
  f.time("2026-10-18T00:00:02Z"); assert.equal(await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-18T00:00:02Z")), context), 1);
  assert.equal(await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-18T00:00:02Z")), context), 0);
  const run = (await f.run(plan.id))!; assert.notEqual(run.conversationId, ROOT_CONVERSATION_ID); f.harness.resume();
  await until(async () => !!(await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))?.run?.entryId);
  const source = await f.harness.commit(tx => personalScheduledSource(tx, run.requestId), context); assert.ok(source); assert.equal(source.entry.kind, "ruukoto.schedule-input"); assert.equal(source.entry.conversationId, run.conversationId);
  assert.equal(await f.harness.commit(tx => personalScheduledSource(tx, "owner"), context), undefined);
  assert.equal(await f.harness.commit(tx => scheduledConversation(tx, ROOT_CONVERSATION_ID), context), undefined);
  await f.harness.commit(tx => requireScheduledSourceReady(tx, run.requestId), context);
  release(); await f.harness.waitForTask(run.taskId, context);
  const done = (await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))!.run!; assert.equal(done.result?.status, "completed");
  await assert.rejects(f.harness.commit(tx => requireScheduledSourceReady(tx, run.requestId), context), code("schedule_run_inactive"));
  await f.harness.close(context); await f.open();
  await f.harness.commit(tx => verifySchedules(tx, [plan.id], [run.id], true, f.scheduler.verifyCreator), context);
  assert.equal((await f.harness.commit(tx => personalScheduledSource(tx, run.requestId), context))?.entry.id, source.entry.id);
  assert.equal((await f.harness.snapshot(PersonalScheduleDoc, plan.id, context))?.plan?.nextDueAt, null);
});

test("定时：停机多期只接最近一次；活动漏期合并且外部核实前不关闭，主聊天独立", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, () => ({ kind: "text", text: "已处理" }), { settle: async () => { await gate; return { failed: false, facts: "核实完成" }; } });
  const main = (await f.harness.conversation(ROOT_CONVERSATION_ID, context))!; const privateInput = await main.submit({ type: "input", content: "PRIVATE-MAIN-HISTORY", requestId: "private" }, context); f.harness.resume(); await privateInput.wait(context);
  const plan = await f.create("daily", { kind: "daily", time: "09:00", time_zone: "Asia/Tokyo" });
  f.time("2026-10-21T00:05:00Z"); await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-21T00:05:00Z")), context);
  const run = (await f.run(plan.id))!; assert.equal(run.scheduledFor, "2026-10-21T00:00:00.000Z"); assert.equal(run.mergedFrom, "2026-10-19T00:00:00.000Z");
  await until(async () => !!(await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))?.run?.sealed);
  f.time("2026-10-23T00:05:00Z"); assert.equal(await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-23T00:05:00Z")), context), 0);
  assert.equal((await f.run(plan.id))!.mergedThrough, "2026-10-23T00:00:00.000Z"); assert.equal((await f.run(plan.id))!.result, undefined);
  const chat = await main.submit({ type: "input", content: "主聊天继续", requestId: "chat" }, context); assert.equal((await chat.wait(context)).status, "done");
  const scheduledCall = f.server.calls.find(call => call.messages.some(message => message.content === plan.instruction)); assert.ok(scheduledCall); assert.doesNotMatch(JSON.stringify(scheduledCall.messages), /PRIVATE-MAIN-HISTORY/);
  release(); await f.harness.waitForTask(run.taskId, context);
  assert.equal((await f.harness.snapshot(PersonalScheduleDoc, plan.id, context))!.plan!.nextDueAt, "2026-10-24T00:00:00.000Z");
  assert.equal((await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))!.run!.result?.status, "completed");
});

test("定时：配置新增不扩大旧计划；执行前失效保留通用失败及创建范围", async t => {
  const f = await fixture(t); const plan = await f.create("scope"); f.scope({ tools: ["write_file"], extensions: [], snapshot: { revision: 2 } });
  f.time("2026-10-18T00:00:02Z"); await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-18T00:00:02Z")), context); const run = (await f.run(plan.id))!; f.harness.resume(); await f.harness.waitForTask(run.taskId, context);
  assert.equal(f.server.calls.length, 0); const saved = (await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))!.run!; assert.equal(saved.result?.status, "failed"); assert.equal(saved.submissionId, undefined); assert.deepEqual((await f.harness.snapshot(PersonalScheduleDoc, plan.id, context))!.plan!.scope, plan.scope);
  await f.harness.commit(tx => verifySchedules(tx, [plan.id], [run.id], true, f.scheduler.verifyCreator), context);
});

test("定时：已受理取消禁止晚结果复活；只取消原计划并保留完整结果", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async () => { await gate; return { kind: "text", text: "迟到完成" }; }); const plan = await f.create("cancel");
  f.time("2026-10-18T00:00:02Z"); await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-18T00:00:02Z")), context); const run = (await f.run(plan.id))!; f.harness.resume(); await until(async () => f.server.calls.length === 1);
  await f.harness.commit(tx => f.scheduler.cancel(tx, plan.id, { kind: "local", requestId: "cancel-request" }), context); release(); await f.harness.waitForTask(run.taskId, context);
  const saved = (await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))!.run!; assert.equal(saved.result?.status, "canceled"); assert.equal(saved.delivery?.state, "canceled"); assert.equal(f.server.calls.length, 1);
  assert.equal(await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-11-01T00:00:00Z")), context), 0);
  assert.equal((await f.harness.commit(tx => f.scheduler.result(tx, run.id, 0, 10), context)).text?.length, 10);
});

test("定时：外部收尾失败进入确定失败结果，反链损坏拒绝恢复", async t => {
  const f = await fixture(t, undefined, { settle: async () => ({ failed: true, facts: "原操作已核实失败" }) }); const plan = await f.create("failed"); f.time("2026-10-18T00:00:02Z");
  await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-18T00:00:02Z")), context); const run = (await f.run(plan.id))!; f.harness.resume(); await f.harness.waitForTask(run.taskId, context);
  assert.equal((await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))!.run!.result?.status, "failed");
  await f.harness.commit(async tx => { (await tx.doc(PersonalScheduledConversationDoc, String(run.conversationId), null)).runId = "missing"; }, context);
  await assert.rejects(f.harness.commit(tx => verifySchedules(tx, [plan.id], [run.id], true), context), code("schedule_record_invalid"));
});

test("定时：回报认领后丢答及重启只保留未知，不重复发送；配置目标换代不改发", async t => {
  const target = { generation: "schedule-target", botId: "123", ownerId: "456", mode: "auto-review" as const, version: 1 }; let sends = 0; let sentText = "";
  const f = await fixture(t, () => ({ kind: "text", text: "结果".repeat(2500) }), { authorize: async () => ({ permission: { mode: target.mode, version: 1 }, telegram: target, proof: { authenticated: true } }), send: async (_plan, text) => { sends++; sentText = text; throw new PersonalImApiError("send_timeout", "回报结果未知。", "effect_unknown"); } });
  await f.harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config = { version: 1, enabled: true, generation: target.generation, botId: target.botId, ownerId: target.ownerId, apiBase: "https://api.telegram.org", tokenEnv: "RUUKOTO_SCHEDULE_UNUSED_BOT_KEY", tokenDigest: "0".repeat(64), boundary: 0 }; }, context);
  const plan = await f.create("unknown-send"); f.time("2026-10-18T00:00:02Z"); await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-18T00:00:02Z")), context); const run = (await f.run(plan.id))!; f.harness.resume(); await f.harness.waitForTask(run.taskId, context);
  const complete = (await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))!.run!; await f.harness.waitForTask(complete.delivery!.taskId, context);
  assert.equal((await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))!.run!.delivery!.state, "effect_unknown"); assert.equal(sends, 1); assert.equal(sentText, complete.delivery!.text); assert.equal(Array.from(sentText).length < 4096, true); assert.equal(complete.result!.text.length, 5000);
  await f.harness.close(context); await f.open(); await f.harness.commit(tx => verifySchedules(tx, [plan.id], [run.id], true, f.scheduler.verifyCreator), context); f.harness.resume(); await delay(20); assert.equal(sends, 1);
  await f.harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config!.generation = "new-generation"; }, context);
  assert.equal((await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))!.run!.delivery!.platformMessageId, undefined);
});

test("定时：最终发送等待不占计划下一周期；限流原意图延后，换代只取消旧目标", async t => {
  const target = { generation: "schedule-limit", botId: "123", ownerId: "456", mode: "auto-review" as const, version: 1 }; let sends = 0;
  const f = await fixture(t, undefined, { authorize: async () => ({ permission: { mode: target.mode, version: 1 }, telegram: target, proof: { authenticated: true } }), send: async () => { sends++; throw new PersonalImApiError("rate_limited", "明确未发送。", "not_sent", 864000000); } });
  await f.harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config = { version: 1, enabled: true, generation: target.generation, botId: target.botId, ownerId: target.ownerId, apiBase: "https://api.telegram.org", tokenEnv: "RUUKOTO_SCHEDULE_UNUSED_BOT_KEY", tokenDigest: "0".repeat(64), boundary: 0 }; }, context);
  const plan = await f.create("limit", { kind: "daily", time: "00:01", time_zone: "UTC" }); f.time("2026-10-18T00:01:01Z"); await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-18T00:01:01Z")), context); const first = (await f.run(plan.id))!; f.harness.resume(); await f.harness.waitForTask(first.taskId, context);
  await until(async () => sends === 1 && (await f.harness.snapshot(PersonalScheduleRunDoc, first.id, context))?.run?.delivery?.state === "pending");
  assert.equal((await f.harness.snapshot(PersonalScheduleDoc, plan.id, context))!.plan!.activeRun, undefined);
  f.time("2026-10-19T00:01:01Z"); assert.equal(await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-19T00:01:01Z")), context), 1); const second = (await f.run(plan.id))!; assert.notEqual(second.id, first.id);
  await f.harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config!.generation = "new-generation"; }, context);
  await f.harness.waitForTask(second.taskId, context); assert.equal(sends, 1);
  await f.harness.commit(tx => verifySchedules(tx, [plan.id], [first.id, second.id], true, f.scheduler.verifyCreator), context);
});

test("定时：取消不可变证据和同IM草稿重复确认；无未来计划不建立supervisor", async t => {
  const f = await fixture(t);
  assert.equal(await f.harness.commit(tx => f.scheduler.start(tx), context), undefined);
  const actor = { kind: "im" as const, menuRequestId: "draft-menu", input: { requestId: "confirmation-1", content: "确认创建计划", generation: "original", botId: "123", ownerId: "456", direct: true, control: true } as TelegramControlInput };
  const body = { requestId: "draft-request", label: "同一草稿", instruction: "自足说明", rule: { kind: "once", at: "2026-10-18T00:00:01Z", time_zone: "UTC" } };
  const first = await f.harness.commit(tx => f.scheduler.create(tx, body, actor), context), second = await f.harness.commit(tx => f.scheduler.create(tx, body, { ...actor, input: { ...actor.input, requestId: "confirmation-2" } }), context); assert.equal(second.id, first.id); assert.equal(second.createdBy.actor.kind, "im");
  await f.harness.commit(tx => f.scheduler.cancel(tx, first.id, { kind: "local", requestId: "cancel" }), context);
  const plan = (await f.harness.snapshot(PersonalScheduleDoc, first.id, context))!.plan!; assert.ok(plan.cancelEntry);
  await f.harness.commit(tx => verifySchedules(tx, [first.id], [], true, f.scheduler.verifyCreator), context);
  await f.harness.commit(async tx => { (await tx.doc(PersonalScheduleDoc, first.id, null)).plan!.cancelEntry = undefined; }, context);
  await assert.rejects(f.harness.commit(tx => verifySchedules(tx, [first.id], [], true), context), code("schedule_record_invalid"));
});


test("定时恢复：监督任务与原索引双向唯一，损坏指针不能另造控制器", async t => {
  for (const mutation of ["missing", "foreign", "duplicate", "older-active", "conversation", "input"] as const) await t.test(mutation, async t => {
    const f = await fixture(t), plan = await f.create(`supervisor-${mutation}`, { kind: "daily", time: "01:00", time_zone: "UTC" });
    await f.harness.commit(async tx => {
      const index = await tx.doc(PersonalSchedulesDoc);
      if (mutation === "missing") delete index.supervisor;
      else if (mutation === "foreign") index.supervisor = 999999 as NonNullable<typeof index.supervisor>;
      else { const conversation = mutation === "conversation" ? (await tx.createConversation({ ownership: { kind: "ownerless" } })).id : ROOT_CONVERSATION_ID; const id = await tx.createTask(f.scheduler.supervisorTask, mutation === "input" ? { foreign: true } : {}, { conversationId: conversation, ownership: { kind: "conversation" }, background: true }); if (mutation !== "duplicate") index.supervisor = id; }
    }, context);
    if (mutation === "older-active") await f.harness.abortTask((await f.harness.snapshot(PersonalSchedulesDoc, context))!.supervisor!, context);
    await assert.rejects(f.harness.commit(tx => verifySchedules(tx, [plan.id], [], true), context), code("schedule_record_invalid"));
    await assert.rejects(f.create("after-invalid-supervisor"), code("schedule_record_invalid"));
    assert.equal((await f.harness.snapshot(PersonalSchedulesDoc, context))!.plans.length, 1);
  });
});

test("定时恢复：首次回答与汇总必须来自原会话，宿主历史不能因删字段失踪", async t => {
  for (const mutation of ["initial-answer", "initial-answer-deleted", "summary-submission", "summary-answer", "summary-answer-deleted", "failed-summary-answer-deleted", "summary-deleted", "summary-failed", "result-deleted", "orphan-summary", "orphan-result", "orphan-send"] as const) await t.test(mutation, async t => {
    const f = await fixture(t, undefined, mutation === "failed-summary-answer-deleted" ? { settle: async () => ({ failed: true, facts: "已核实本轮失败" }) } : {}), main = (await f.harness.conversation(ROOT_CONVERSATION_ID, context))!;
    const owner = await main.submit({ type: "input", content: "主聊天自己的回答", requestId: "foreign-owner" }, context); f.harness.resume(); const ownerStatus = await owner.wait(context); assert.ok(ownerStatus.type === "input" && ownerStatus.status === "done");
    const plan = await f.create(`recovery-${mutation}`); f.time("2026-10-18T00:00:02Z"); await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-18T00:00:02Z")), context); const run = (await f.run(plan.id))!; await f.harness.waitForTask(run.taskId, context);
    await f.harness.commit(async tx => {
      const value = (await tx.doc(PersonalScheduleRunDoc, run.id, null)).run!;
      if (mutation === "initial-answer") value.initialAnswer = ownerStatus.answer;
      if (mutation === "initial-answer-deleted") delete value.initialAnswer;
      if (mutation === "summary-submission") value.summary!.submissionId = ownerStatus.id;
      if (mutation === "summary-answer") value.summary!.answer = ownerStatus.answer;
      if (mutation === "summary-answer-deleted" || mutation === "failed-summary-answer-deleted") delete value.summary!.answer;
      if (mutation === "summary-deleted") delete value.summary;
      if (mutation === "summary-failed") value.summary!.failed = !value.summary!.failed;
      if (mutation === "result-deleted") { delete value.result; delete value.delivery; (await tx.doc(PersonalScheduleDoc, plan.id, null)).plan!.activeRun = run.id; }
      if (mutation === "orphan-summary") await tx.appendEntry(ScheduleSummary, run.conversationId, { data: { runId: run.id, content: value.summary!.content, failed: value.summary!.failed } });
      if (mutation === "orphan-result") await tx.appendEntry(ScheduleResult, run.conversationId, { data: { runId: run.id, status: value.result!.status, text: value.result!.text } });
      if (mutation === "orphan-send") await tx.appendEntry(ScheduleSendAdmission, run.conversationId, { data: { runId: run.id, taskId: value.delivery!.taskId, text: value.delivery!.text } });
    }, context);
    await assert.rejects(f.harness.commit(tx => verifySchedules(tx, [plan.id], [run.id], true), context), code("schedule_record_invalid"));
  });
});

test("定时恢复：删除已受理取消字段不能恢复计划或当前运行", async t => {
  for (const mutation of ["plan", "run"] as const) await t.test(mutation, async t => {
    const f = await fixture(t), plan = await f.create(`cancel-proof-${mutation}`, { kind: "daily", time: "00:01", time_zone: "UTC" });
    f.time("2026-10-18T00:01:02Z"); await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-18T00:01:02Z")), context); const run = (await f.run(plan.id))!;
    await f.harness.commit(tx => f.scheduler.cancel(tx, plan.id, { kind: "local", requestId: "cancel-once" }), context);
    await f.harness.commit(async tx => { if (mutation === "plan") { const value = (await tx.doc(PersonalScheduleDoc, plan.id, null)).plan!; value.canceled = false; delete value.cancelEntry; value.nextDueAt = "2026-10-19T00:01:00Z"; } else { const value = (await tx.doc(PersonalScheduleRunDoc, run.id, null)).run!; value.cancelRequested = false; delete value.cancelEntry; } }, context);
    await assert.rejects(f.harness.commit(tx => verifySchedules(tx, [plan.id], [run.id], true), context), code("schedule_record_invalid"));
  });
});


test("定时：跨下一到期点后先收尾或取消再扫描，也把漏期合入原运行", async t => {
  for (const end of ["finish", "cancel", "abort"] as const) await t.test(end, async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, undefined, { settle: async () => { await gate; return { failed: false, facts: "外部收尾完成" }; } }), plan = await f.create("finish-before-scan", { kind: "daily", time: "00:01", time_zone: "UTC" });
  f.time("2026-10-18T00:01:02Z"); await f.harness.commit(tx => f.scheduler.scan(tx, Date.parse("2026-10-18T00:01:02Z")), context); const run = (await f.run(plan.id))!;
  if (end !== "abort") { f.harness.resume(); await until(async () => !!(await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))?.run?.sealed); }
  f.time("2026-10-19T00:01:02Z");
  if (end === "cancel") { await f.harness.commit(tx => f.scheduler.cancel(tx, plan.id, { kind: "local", requestId: "cross-period-cancel" }), context); f.time("2026-10-20T00:01:02Z"); }
  const aborted = end === "abort" ? f.harness.abortTask(run.taskId, context) : undefined;
  if (end === "abort") { await until(async () => !!(await f.harness.commit(tx => tx.task(run.taskId), context))?.abortRequested); f.harness.resume(); await until(async () => !!(await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))?.run?.cancelRequested); f.time("2026-10-20T00:01:02Z"); }
  release(); await aborted; await f.harness.waitForTask(run.taskId, context);
  assert.equal((await f.harness.snapshot(PersonalScheduleRunDoc, run.id, context))!.run!.mergedThrough, "2026-10-19T00:01:00.000Z");
  assert.equal((await f.harness.snapshot(PersonalScheduleDoc, plan.id, context))!.plan!.nextDueAt, end === "cancel" ? null : end === "abort" ? "2026-10-21T00:01:00.000Z" : "2026-10-20T00:01:00.000Z");
  });
});
