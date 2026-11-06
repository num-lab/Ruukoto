import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type Task } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalImDeliveryDoc, verifyPersonalImDeliveries, type PersonalImDeliveryResult } from "../apps/ruukoto/src/personal-im-delivery.ts";
import { PersonalScheduleRunDoc, PersonalSchedulesDoc, ScheduleSendObservation, verifySchedules } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
const text = " \nOriginal scheduled result " + "🦉𠮷e\u0301".repeat(1600) + "\r\nEnd\n ";
async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < deadline, "Scheduled send did not reach its original task"); await delay(5); } }

async function fixture(t: TestContext, childFault: boolean, recurring = false) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-schedule-cold-"))), sends: { text: string; messageId: string }[] = [];
  const token = "123:schedule-cold-test-only", tokenEnv = "SCHEDULE_COLD_BOT_KEY", modelEnv = "SCHEDULE_COLD_MODEL_KEY", previous = [process.env[tokenEnv], process.env[modelEnv]];
  process.env[tokenEnv] = token; process.env[modelEnv] = "test-only";
  let personal: PersonalHarness | undefined;
  const bot = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { chat_id: string; text: string; message_id?: number };
    const reply = (result: unknown) => response.end(JSON.stringify({ ok: true, result }));
    if (request.url?.endsWith("/getMe")) { reply({ id: 123, is_bot: true }); return; }
    if (request.url?.endsWith("/sendChatAction") || request.url?.endsWith("/answerCallbackQuery")) { reply(true); return; }
    if (request.url?.endsWith("/editMessageText")) { reply({ message_id: body.message_id, chat: { id: Number(body.chat_id), type: "private" } }); return; }
    assert.ok(request.url?.endsWith("/sendMessage"));
    const messageId = String(1000 + sends.length + 1); sends.push({ text: body.text, messageId });
    reply({ message_id: Number(messageId), chat: { id: Number(body.chat_id), type: "private" } });
  });
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  const due = Math.floor(Date.now() / 60000) * 60000 + 120000;
  const model = new PersonalMockModelServer(request => {
    if (request.messages.at(-1)?.role === "user" && String(request.messages.at(-1)?.content).includes("Create the original schedule")) return { kind: "tool_calls", calls: [{ id: "original-schedule", name: "schedule_create", arguments: { label: "Original cold recovery", instruction: "Return the complete original scheduled result", rule: recurring ? { kind: "daily", time_zone: "UTC", time: new Date(due).toISOString().slice(11, 16) } : { kind: "once", time_zone: "UTC", at: new Date(due).toISOString() } } }] };
    return { kind: "text", text: request.system?.includes("你是个人助手的一次独立定时执行") ? text : "Original schedule saved." };
  });
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: modelEnv, contextWindow: 128000, maxTokens: 8192 };
  const telegram = { version: 1 as const, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv, tokenDigest: createHash("sha256").update(token).digest("hex"), botId: "123", ownerId: "456", boundary: 0 };
  const injectedChildren = new Set<string>();
  const openHarness = Harness.open;
  t.mock.method(Harness, "open", async (...args: Parameters<typeof openHarness>) => {
    const delivery = args[1].registry.snapshot().task("ruukoto.im-delivery") as Task<{ key: string }, { phase: "send"; index: number; retryAt?: number } | { phase: "verify"; index: number }, PersonalImDeliveryResult, object>, send = delivery.definition.phases.send;
    t.mock.method(delivery.definition.phases, "send", async (...[task, runtime, taskContext]: Parameters<typeof send>) => {
      if (!childFault || injectedChildren.has(task.input.key) || !task.input.key.startsWith("schedule:")) return send(task, runtime, taskContext);
      let commits = 0;
      return send(task, { ...runtime, async commit(...parameters) { if (++commits === 3) { injectedChildren.add(task.input.key); throw new Error("Injected original delivery observation commit failure"); } return runtime.commit(...parameters); } }, taskContext);
    });
    return openHarness(...args);
  });
  const open = async () => personal = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, telegram });
  t.after(async () => { await personal?.close(); bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); await model.close(); for (const [index, key] of [tokenEnv, modelEnv].entries()) { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; } fs.rmSync(directory, { recursive: true, force: true }); });
  isolateSkillHome(t);
  const p = await open(), deliver = p.scheduler.sendTask.definition.phases.deliver;
  t.mock.method(p.scheduler.sendTask.definition.phases, "deliver", async (...[task, runtime, taskContext]: Parameters<typeof deliver>) => {
    const ref = (await runtime.snapshot(PersonalScheduleRunDoc, task.input.runId, taskContext))?.run?.delivery?.multipart; assert.ok(ref);
    await runtime.waitForTask(ref.taskId, taskContext);
    // Fault before any receipt helper can reconcile either the child or the parent mirror.
    throw new Error("Injected scheduled parent observation commit failure");
  });
  await p.telegram.receive({ update_id: 11, message: { message_id: 11, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text: "Create the original schedule" } });
  const original = (await p.harness.snapshot(PersonalTelegramReceiptDoc, "telegram:123:456:11", context))!.receipt!;
  await p.harness.waitForTask(original.taskId, context);
  const plan = (await p.harness.commit(tx => p.scheduler.list(tx), context)).items[0]; assert.ok(plan?.telegram); assert.equal(plan.createdBy.actor.kind, "model");
  await p.harness.commit(tx => p.scheduler.scan(tx, due + 1), context);
  let runId = "";
  await until(async () => { runId = (await p.harness.snapshot(PersonalSchedulesDoc, context))!.runs[0] ?? ""; return !!runId && !!(await p.harness.snapshot(PersonalScheduleRunDoc, runId, context))?.run?.delivery; });
  const run = (await p.harness.snapshot(PersonalScheduleRunDoc, runId, context))!.run!; assert.ok(run.delivery);
  const parent = await p.harness.waitForTask(run.delivery.taskId, context); assert.equal(parent.state.outcome.status, "faulted");
  const saved = (await p.harness.snapshot(PersonalScheduleRunDoc, runId, context))!.run!; assert.ok(saved.delivery?.multipart);
  const ledger = (await p.harness.snapshot(PersonalImDeliveryDoc, saved.delivery.multipart.key, context))!.delivery!;
  assert.equal(ledger.input.text, text); assert.equal(saved.delivery.state, "sending"); assert.equal(saved.delivery.observation, undefined); assert.equal(injectedChildren.has(ledger.ref.key), childFault);
  assert.deepEqual(ledger.parts.map(part => part.state), childFault ? ["sending", "pending", "pending"] : ["sent", "sent", "sent"]);
  const child = (await p.harness.getTask(ledger.ref.taskId, context))!; assert.equal(child.state.outcome?.status, childFault ? "faulted" : "completed");
  return { get personal() { return personal!; }, open, plan, run: saved, ledger, parent, child, sends, model };
}

for (const childFault of [true, false]) test(`Cold production schedule recovery validates ${childFault ? "unknown" : "confirmed"} delivery before appending its mirror`, { timeout: 30000 }, async t => {
  const f = await fixture(t, childFault), before = f.sends.length, calls = f.model.calls.length;
  await f.personal.close(); let reopened = await f.open();
  const recovered = (await reopened.harness.snapshot(PersonalScheduleRunDoc, f.run.id, context))!.run!, ledger = (await reopened.harness.snapshot(PersonalImDeliveryDoc, f.ledger.ref.key, context))!.delivery!;
  assert.equal(recovered.delivery?.state, childFault ? "effect_unknown" : "sent"); assert.deepEqual(recovered.delivery?.multipart, f.ledger.ref); assert.ok(recovered.delivery?.observation);
  assert.deepEqual(ledger.parts.map(part => part.state), childFault ? ["effect_unknown", "canceled", "canceled"] : ["sent", "sent", "sent"]);
  const observation = await reopened.harness.commit(tx => tx.entry(ScheduleSendObservation, recovered.delivery!.observation!), context);
  assert.deepEqual(observation?.data, { runId: f.run.id, state: childFault ? "effect_unknown" : "sent", code: childFault ? "send_interrupted" : "sent", ...(childFault ? {} : { platformMessageId: ledger.parts.at(-1)!.platformMessageId }) });
  assert.equal(observation?.conversationId, f.run.conversationId); assert.equal(f.sends.length, before); assert.equal(f.model.calls.length, calls);
  assert.deepEqual((await reopened.harness.getTask(f.parent.id, context))!.state, f.parent.state); assert.deepEqual((await reopened.harness.getTask(f.child.id, context))!.state, f.child.state);
  await reopened.close(); reopened = await f.open();
  assert.deepEqual((await reopened.harness.snapshot(PersonalScheduleRunDoc, f.run.id, context))!.run!.delivery, recovered.delivery);
  assert.equal(f.sends.length, before); assert.equal(f.model.calls.length, calls);
  const history = await reopened.harness.commit(tx => tx.scanEntries({ conversationId: f.run.conversationId }, 256), context);
  assert.equal(history.items.filter(ScheduleSendObservation.is).length, 1);
});

test("Cold schedule verification rejects an orphan observation before reconciling a faulted mirror", { timeout: 30000 }, async t => {
  const f = await fixture(t, true), p = f.personal;
  await p.harness.commit(tx => verifyPersonalImDeliveries(tx), context);
  await p.harness.commit(tx => tx.appendEntry(ScheduleSendObservation, f.run.conversationId, { data: { runId: f.run.id, state: "sent", code: "forged", platformMessageId: "9000" } }), context);
  await assert.rejects(p.harness.commit(tx => verifySchedules(tx, [f.plan.id], [f.run.id], true, p.scheduler.verifyCreator), context), error => error instanceof PersonalError && error.code === "schedule_record_invalid");
  const saved = (await p.harness.snapshot(PersonalScheduleRunDoc, f.run.id, context))!.run!;
  assert.equal(saved.delivery?.state, "sending"); assert.equal(saved.delivery?.observation, undefined);
  assert.deepEqual((await p.harness.getTask(f.parent.id, context))!.state, f.parent.state);
});

test("A live schedule query reconciles multiple faulted sends only after reading every run", { timeout: 30000 }, async t => {
  const f = await fixture(t, true, true), p = f.personal;
  await p.harness.commit(tx => p.scheduler.scan(tx, Date.parse(f.run.scheduledFor) + 86400000 + 1), context);
  let secondId = "";
  await until(async () => { secondId = (await p.harness.snapshot(PersonalSchedulesDoc, context))!.runs[1] ?? ""; return !!secondId && !!(await p.harness.snapshot(PersonalScheduleRunDoc, secondId, context))?.run?.delivery; });
  const second = (await p.harness.snapshot(PersonalScheduleRunDoc, secondId, context))!.run!, parent = await p.harness.waitForTask(second.delivery!.taskId, context);
  assert.equal(parent.state.outcome.status, "faulted");
  const before = f.sends.length, calls = f.model.calls.length;
  for (const id of [f.run.id, secondId]) {
    const saved = (await p.harness.snapshot(PersonalScheduleRunDoc, id, context))!.run!;
    assert.equal(saved.delivery?.state, "sending"); assert.equal(saved.delivery?.observation, undefined);
    const ledger = (await p.harness.snapshot(PersonalImDeliveryDoc, saved.delivery!.multipart!.key, context))!.delivery!;
    assert.deepEqual(ledger.parts.map(part => part.state), ["sending", "pending", "pending"]);
  }
  const page = await p.harness.commit(tx => p.scheduler.runs(tx, f.plan.id), context);
  assert.deepEqual(page.items.map(item => item.id), [secondId, f.run.id]); assert.ok(page.items.every(item => item.state === "completed" && item.delivery === "effect_unknown"));
  for (const id of [f.run.id, secondId]) {
    const saved = (await p.harness.snapshot(PersonalScheduleRunDoc, id, context))!.run!;
    const ledger = (await p.harness.snapshot(PersonalImDeliveryDoc, saved.delivery!.multipart!.key, context))!.delivery!;
    assert.deepEqual(ledger.parts.map(part => part.state), ["effect_unknown", "canceled", "canceled"]);
    assert.ok(saved.delivery?.observation); assert.equal(saved.delivery.platformMessageId, undefined);
    const history = await p.harness.commit(tx => tx.scanEntries({ conversationId: saved.conversationId }, 256), context);
    assert.equal(history.items.filter(ScheduleSendObservation.is).length, 1);
  }
  assert.deepEqual(await p.harness.commit(tx => p.scheduler.runs(tx, f.plan.id), context), page);
  assert.deepEqual((await p.harness.getTask(f.parent.id, context))!.state, f.parent.state); assert.deepEqual((await p.harness.getTask(parent.id, context))!.state, parent.state);
  assert.equal(f.sends.length, before); assert.equal(f.model.calls.length, calls);
});

test("A live schedule result query preserves the original fault and exact text before any delivery wait", { timeout: 30000 }, async t => {
  const f = await fixture(t, true), p = f.personal, before = f.sends.length, calls = f.model.calls.length;
  const result = await p.harness.commit(tx => p.scheduler.result(tx, f.run.id, 0, 16384), context);
  assert.equal(result.state, "completed"); assert.equal(result.delivery, "effect_unknown"); assert.equal(result.text, text);
  assert.equal((await p.harness.commit(tx => p.scheduler.runs(tx, f.plan.id), context)).items[0]?.delivery, "effect_unknown");
  assert.deepEqual((await p.harness.getTask(f.parent.id, context))!.state, f.parent.state); assert.deepEqual((await p.harness.getTask(f.child.id, context))!.state, f.child.state);
  assert.equal(f.sends.length, before); assert.equal(f.model.calls.length, calls);
});

for (const status of ["completed", "aborted"] as const) for (const uncertainFirst of [false, true]) test(`A direct schedule verifier rejects ${status} parent evidence with ${uncertainFirst ? "unknown then pending" : "claimed then pending"} original text`, { timeout: 30000 }, async t => {
  const f = await fixture(t, true), p = f.personal;
  if (uncertainFirst) await p.harness.commit(async tx => {
    const run = (await tx.doc(PersonalScheduleRunDoc, f.run.id, null)).run!, ledger = (await tx.doc(PersonalImDeliveryDoc, f.ledger.ref.key, null)).delivery!;
    ledger.parts[0].state = "effect_unknown"; ledger.parts[0].code = "send_interrupted";
    run.delivery!.state = "effect_unknown"; run.delivery!.code = "send_interrupted";
    run.delivery!.observation = (await tx.appendEntry(ScheduleSendObservation, run.conversationId, { data: { runId: run.id, state: "effect_unknown", code: "send_interrupted" } })).id;
  }, context);
  const originalMirror = (await p.harness.snapshot(PersonalScheduleRunDoc, f.run.id, context))!.run!.delivery;
  await assert.rejects(p.harness.commit(async tx => {
    const task = tx.task.bind(tx);
    t.mock.method(tx, "task", async (...[id]: Parameters<typeof task>) => {
      const value = await task(id);
      return value?.id === f.parent.id ? { ...value, state: { status: "terminal", outcome: { status, result: {} } } } : value;
    });
    await verifySchedules(tx, [f.plan.id], [f.run.id], true, p.scheduler.verifyCreator);
  }, context), error => error instanceof PersonalError && error.code === "schedule_record_invalid");
  const saved = (await p.harness.snapshot(PersonalScheduleRunDoc, f.run.id, context))!.run!, ledger = (await p.harness.snapshot(PersonalImDeliveryDoc, f.ledger.ref.key, context))!.delivery!;
  assert.deepEqual(saved.delivery, originalMirror);
  assert.deepEqual(ledger.parts.map(part => part.state), [uncertainFirst ? "effect_unknown" : "sending", "pending", "pending"]);
  assert.deepEqual((await p.harness.getTask(f.parent.id, context))!.state, f.parent.state);
});
