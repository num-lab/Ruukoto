import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineTask, ROOT_CONVERSATION_ID, type Task } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PersonalImApiError, type PersonalImAccess } from "../apps/ruukoto/src/personal-im-api.ts";
import { PersonalTelegramDoc, type PersonalEntryIdentity } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { personalTelegramCallbacks, PersonalTelegramCallbacksDoc, PersonalTelegramCallbackDoc, PersonalTelegramCallbackObservation, type PersonalTelegramCallbackOutcome, type PersonalTelegramCallbackRecord, type PersonalTelegramCallbackRef } from "../apps/ruukoto/src/personal-telegram-callbacks.ts";
import type { PersonalTelegramApi } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";

const context = BACKGROUND_CONTEXT, source: PersonalEntryIdentity = { botId: "123", ownerId: "456", generation: "original-generation" }, queryId = "query-string-identifier", key = `telegram-callback:123:${queryId}`, fingerprint = createHash("sha256").update("original-callback").digest("hex");
const config = { version: 1 as const, enabled: true, ...source, apiBase: "http://127.0.0.1:1", tokenEnv: "CALLBACK_UNUSED_TOKEN", tokenDigest: "0".repeat(64), boundary: 0 };
const modelConfig = { api: "openai-completions" as const, baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "CALLBACK_UNUSED_MODEL_KEY", contextWindow: 4096, maxTokens: 1024 };
async function until(check: () => boolean | Promise<boolean>) { const deadline = Date.now() + 10_000; while (!await check()) { assert.ok(Date.now() < deadline, "Callback acknowledgement did not settle"); await delay(5); } }

async function fixture(t: TestContext, acknowledge: (id: string, signal: AbortSignal) => Promise<void> = async () => {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "rk-callback-ack-")), sent: string[] = [];
  let harness!: Harness, current = { ...source };
  const api: PersonalTelegramApi = { me: async () => ({ id: "123", username: "unused" }), updates: async () => [], photo: () => { throw new Error("unused"); }, send: async () => { throw new Error("Acknowledgement cannot send a business message"); }, edit: async () => { throw new Error("Acknowledgement cannot edit a business card"); }, document: async () => { throw new Error("unused"); }, typing: async () => { throw new Error("unused"); }, answerCallback: async (id, signal) => { sent.push(id); await acknowledge(id, signal); } };
  const im: PersonalImAccess = { withEntry: async (_entry, action) => action(), sender: () => undefined, configurationVersion: () => "original", isActive: value => value.botId === current.botId && value.ownerId === current.ownerId && value.generation === current.generation };
  const callbacks = personalTelegramCallbacks(im, () => api), registry = createRegistry(); registry.install(callbacks.extension);
  const open = async () => { harness = await Harness.open(await openNodeSqliteStorage(path.join(root, "personal.sqlite")), { registry, models: recordedModels(personalProvider(modelConfig), async () => assert.fail("Acknowledgement never calls a model")) }, context); await harness.root(context); return harness; };
  await open(); await harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config = config; }, context);
  t.after(async () => { await harness.close(context); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, sent, callbacks, open, get harness() { return harness; },
    async request(rejected = false) {
      return harness.commit(async tx => {
        const old = await callbacks.lookup(tx, key, fingerprint); if (old) return { ...old.ref };
        const origin = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: rejected ? "ruukoto.telegram-callback-rejected" : "ruukoto.telegram-callback", data: rejected ? { requestId: key, generation: source.generation, queryId, fingerprint, reason: "inaccessible_context" } : { requestId: key, generation: source.generation, queryId, token: "opaque-token", display: "original-display" } })).id;
        return callbacks.request(tx, { key, source, queryId, fingerprint, origin });
      }, context);
    },
    get: (ref: PersonalTelegramCallbackRef) => harness.commit(async tx => { const value = await callbacks.lookup(tx, ref.key); assert.ok(value); return copyJson(value) as PersonalTelegramCallbackRecord; }, context),
    async rebind() { current = { ...source, generation: "new-generation" }; await harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config = { ...config, generation: current.generation }; }, context); },
  };
}

test("Callback acknowledgement persists one admission/claim/outcome and deduplicates independently of business receipts", async t => {
  const f = await fixture(t), ref = await f.request();
  assert.deepEqual(await f.request(), ref); await f.harness.commit(tx => f.callbacks.verify(tx), context);
  f.harness.resume(); await f.harness.waitForTask(ref.taskId, context);
  const saved = await f.get(ref); assert.equal(saved.state, "sent"); assert.equal(saved.effect, "returned"); assert.deepEqual(f.sent, [queryId]);
  assert.ok(saved.input.origin < saved.admission && saved.admission < saved.claim! && saved.claim! < saved.observation!);
  await f.harness.commit(tx => f.callbacks.verify(tx), context);
  await assert.rejects(f.harness.commit(tx => f.callbacks.lookup(tx, key, "f".repeat(64)), context), { code: "telegram_input_conflict" });
  await f.harness.close(context); await f.open(); await f.harness.commit(tx => f.callbacks.verify(tx), context);
  assert.deepEqual(await f.request(), ref); assert.deepEqual(await f.get(ref), saved); assert.deepEqual(f.sent, [queryId]);
});

test("Rejected/inaccessible callback origins can be acknowledged without granting a decision", async t => {
  const f = await fixture(t), ref = await f.request(true); f.harness.resume(); await f.harness.waitForTask(ref.taskId, context);
  assert.equal((await f.get(ref)).state, "sent"); assert.deepEqual(f.sent, [queryId]); await f.harness.commit(tx => f.callbacks.verify(tx), context);
});

test("Callback acknowledgement refusals and unknown effects remain final without retries", async t => {
  for (const failure of [new PersonalImApiError("telegram_refused", "Expired query", "not_sent"), new PersonalImApiError("telegram_rate_limited", "Rate limited", "not_sent", 1), new PersonalImApiError("telegram_unverified", "Lost reply", "effect_unknown"), new Error("credential-free injected failure")]) await t.test(failure instanceof PersonalImApiError ? failure.code : "unexpected", async t => {
    const f = await fixture(t, async () => { throw failure; }), ref = await f.request(); f.harness.resume(); await f.harness.waitForTask(ref.taskId, context);
    const saved = await f.get(ref); assert.equal(saved.state, failure instanceof PersonalImApiError && failure.effect === "not_sent" ? "failed" : "effect_unknown"); assert.equal(saved.code, failure instanceof PersonalImApiError ? failure.code : "telegram_callback_ack_unverified"); assert.equal(f.sent.length, 1);
    await f.harness.commit(tx => f.callbacks.verify(tx), context); await f.harness.close(context); await f.open(); await f.harness.commit(tx => f.callbacks.verify(tx), context); await f.request(); assert.equal(f.sent.length, 1);
  });
});

for (const outcome of ["failed", "faulted", "orphaned"] as const) for (const phase of ["pending", "sending"] as const) test(`Callback ${outcome} recovery reconciles a ${phase} acknowledgement without resending`, async t => {
  const f = await fixture(t), task = f.callbacks.extension.tasks![0] as Task<{ key: string }, { phase: "send" } | { phase: "verify" }, PersonalTelegramCallbackOutcome, object>, send = task.definition.phases.send;
  const failure = new Error("Injected callback observation commit failure");
  t.mock.method(task.definition.phases, "send", async (...[current, runtime, callContext]: Parameters<typeof send>) => {
    const fail = () => {
      if (outcome === "faulted") throw failure;
      return runtime.commit(() => ({ status: "terminal", outcome: outcome === "failed" ? { status: "failed", error: { message: failure.message } } : { status: "orphaned", reason: failure.message } }), callContext);
    };
    if (phase === "pending") return fail();
    let commits = 0;
    return send(current, { ...runtime, async commit(...args) { if (++commits === 2) return fail(); return runtime.commit(...args); } }, callContext);
  });
  const ref = await f.request(); f.harness.resume(); const settled = await f.harness.waitForTask(ref.taskId, context), before = await f.get(ref);
  assert.equal(settled.state.outcome.status, outcome); assert.equal(before.state, phase); assert.equal(before.observation, undefined); assert.equal(f.sent.length, phase === "sending" ? 1 : 0);
  await f.harness.commit(tx => f.callbacks.verify(tx), context);
  const after = await f.get(ref); assert.equal(after.state, phase === "sending" ? "effect_unknown" : "canceled"); assert.equal(after.effect, phase === "sending" ? "effect_unknown" : "not_sent"); assert.equal(after.code, "telegram_callback_ack_interrupted");
  const observation = await f.harness.commit(tx => tx.entry(PersonalTelegramCallbackObservation, after.observation!), context);
  assert.deepEqual(observation!.data, { ref, admission: before.admission, ...(before.claim === undefined ? {} : { claim: before.claim }), state: after.state, code: after.code, effect: after.effect });
  assert.ok(observation!.id > (before.claim ?? before.admission)); assert.deepEqual((await f.harness.getTask(ref.taskId, context))!.state, settled.state);
  await f.harness.commit(tx => f.callbacks.verify(tx), context); await f.harness.close(context); await f.open(); await f.harness.commit(tx => f.callbacks.verify(tx), context);
  assert.deepEqual(await f.request(), ref); assert.deepEqual(await f.get(ref), after); assert.equal(f.sent.length, phase === "sending" ? 1 : 0);
});

test("Callback fault reconciliation validates the original claim before appending any recovery observation", async t => {
  const f = await fixture(t), task = f.callbacks.extension.tasks![0] as Task<{ key: string }, { phase: "send" } | { phase: "verify" }, PersonalTelegramCallbackOutcome, object>, send = task.definition.phases.send;
  t.mock.method(task.definition.phases, "send", async (...[current, runtime, callContext]: Parameters<typeof send>) => { let commits = 0; return send(current, { ...runtime, async commit(...args) { if (++commits === 2) throw new Error("Injected callback observation commit failure"); return runtime.commit(...args); } }, callContext); });
  const ref = await f.request(); f.harness.resume(); await f.harness.waitForTask(ref.taskId, context); const before = await f.get(ref);
  await f.harness.commit(async tx => { (await tx.doc(PersonalTelegramCallbackDoc, ref.key, null)).ack!.claim = before.admission; }, context);
  await assert.rejects(f.harness.commit(tx => f.callbacks.verify(tx), context), { code: "telegram_callback_ack_invalid" });
  assert.equal((await f.get(ref)).observation, undefined); assert.equal((await f.get(ref)).state, "sending"); assert.equal(f.sent.length, 1);
});

test("Callback acknowledgements cancel an inactive original generation and retain started old-generation outcomes", async t => {
  await t.test("pending", async t => { const f = await fixture(t), ref = await f.request(); await f.rebind(); f.harness.resume(); await f.harness.waitForTask(ref.taskId, context); const value = await f.get(ref); assert.equal(value.state, "canceled"); assert.equal(value.claim, undefined); assert.equal(value.effect, "not_sent"); assert.equal(f.sent.length, 0); await f.harness.commit(tx => f.callbacks.verify(tx), context); });
  await t.test("started", async t => { let entered = false, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release()); const f = await fixture(t, async () => { entered = true; await gate; }), ref = await f.request(); f.harness.resume(); await until(() => entered); await f.rebind(); release(); await f.harness.waitForTask(ref.taskId, context); assert.equal((await f.get(ref)).state, "sent"); assert.equal(f.sent.length, 1); await f.harness.commit(tx => f.callbacks.verify(tx), context); });
});

test("Callback acknowledgement rejects key drift and orphan immutable evidence", async t => {
  const f = await fixture(t), ref = await f.request(); f.harness.resume(); await f.harness.waitForTask(ref.taskId, context);
  const origin = await f.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.forged", data: { requestId: "telegram-callback:123:forged", generation: source.generation, queryId: "forged" } }), context);
  await assert.rejects(f.harness.commit(tx => f.callbacks.request(tx, { key: "telegram-callback:999:forged", source, queryId: "forged", fingerprint, origin: origin.id }), context), { code: "telegram_callback_ack_invalid" });
  const saved = await f.get(ref);
  await f.harness.commit(tx => tx.appendEntry(PersonalTelegramCallbackObservation, ROOT_CONVERSATION_ID, { data: { ref, admission: saved.admission, claim: saved.claim, state: "sent", code: "forged-second-attempt", effect: "returned" } }), context);
  await assert.rejects(f.harness.commit(tx => f.callbacks.verify(tx), context), { code: "telegram_callback_ack_invalid" });
});

test("Callback origin validation precedes every acknowledgement claim", async t => {
  const f = await fixture(t), origin = await f.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.forged", data: { requestId: key, generation: source.generation, queryId } }), context);
  const ref = await f.harness.commit(tx => f.callbacks.request(tx, { key, source, queryId, fingerprint, origin: origin.id }), context);
  await assert.rejects(f.harness.commit(tx => f.callbacks.verify(tx), context), { code: "telegram_callback_ack_invalid" });
  f.harness.resume(); await f.harness.waitForTask(ref.taskId, context);
  assert.equal(f.sent.length, 0); assert.equal((await f.get(ref)).claim, undefined);
});

test("Callback acknowledgement verification rejects an unowned accepted or rejected origin", async t => {
  for (const rejected of [false, true]) await t.test(rejected ? "rejected" : "accepted", async t => {
    const f = await fixture(t);
    await f.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: rejected ? "ruukoto.telegram-callback-rejected" : "ruukoto.telegram-callback", data: rejected ? { requestId: key, generation: source.generation, queryId, fingerprint, reason: "stale" } : { requestId: key, generation: source.generation, queryId, token: "opaque-token", display: "original-display" } }), context);
    await assert.rejects(f.harness.commit(tx => f.callbacks.verify(tx), context), { code: "telegram_callback_ack_invalid" });
    assert.equal(f.sent.length, 0);
  });
});

test("Callback acknowledgement recovery detects deleted index/doc, immutable mismatches, transitions and task orphaning", async t => {
  for (const corruption of ["index", "doc", "fingerprint", "source", "origin", "claim", "outcome", "state", "task"] as const) await t.test(corruption, async t => {
    const f = await fixture(t), ref = await f.request(); f.harness.resume(); await f.harness.waitForTask(ref.taskId, context);
    await f.harness.commit(async tx => {
      const value = (await tx.doc(PersonalTelegramCallbackDoc, key, null)).ack!;
      if (corruption === "index") (await tx.doc(PersonalTelegramCallbacksDoc)).keys = [];
      else if (corruption === "doc") delete (await tx.doc(PersonalTelegramCallbackDoc, key, null)).ack;
      else if (corruption === "fingerprint") value.input.fingerprint = "f".repeat(64);
      else if (corruption === "source") value.input.source.ownerId = "999";
      else if (corruption === "origin") value.input.origin = value.admission;
      else if (corruption === "claim") delete value.claim;
      else if (corruption === "outcome") value.code = "forged";
      else if (corruption === "state") value.state = "pending";
      else {
        const task = defineTask<object, { phase: "run" }, null>({ name: "ruukoto.telegram-callback-ack", version: 1, initial: () => ({ phase: "run" }), phases: { async run() { throw new Error("must not run"); } }, async abort(_current, runtime, context) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: null } }), context); } });
        await tx.createTask(task, {}, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
      }
    }, context);
    await assert.rejects(f.harness.commit(tx => f.callbacks.verify(tx), context), { code: "telegram_callback_ack_invalid" });
  });
});

test("A real process crash after callback claim recovers unknown without a second API attempt", { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.harness.close(context);
  const script = `import { Harness,createRegistry,ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";import { personalTelegramCallbacks } from "./apps/ruukoto/src/personal-telegram-callbacks.ts";import { PersonalTelegramDoc } from "./apps/ruukoto/src/personal-telegram-records.ts";import { personalProvider,recordedModels } from "./apps/ruukoto/src/personal-model.ts";
const context=BACKGROUND_CONTEXT;const {directory,source,config,key,queryId,fingerprint,modelConfig}=JSON.parse(process.env.CALLBACK_CRASH_INPUT);const im={withEntry:async(_source,action)=>action(),isActive:()=>true,configurationVersion:()=>"original",sender:()=>undefined};const callbacks=personalTelegramCallbacks(im,()=>({answerCallback:async()=>{process.send("claimed");await new Promise(()=>{});}}));const registry=createRegistry();registry.install(callbacks.extension);const harness=await Harness.open(await openNodeSqliteStorage(directory+"/personal.sqlite"),{registry,models:recordedModels(personalProvider(modelConfig),async()=>{throw new Error("no model");})},context);await harness.root(context);await harness.commit(async tx=>{(await tx.doc(PersonalTelegramDoc)).config=config;const origin=(await tx.appendEntry(ROOT_CONVERSATION_ID,{kind:"ruukoto.telegram-callback-rejected",data:{requestId:key,generation:source.generation,queryId,fingerprint,reason:"stale"}})).id;await callbacks.request(tx,{key,source,queryId,fingerprint,origin});},context);harness.resume();setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, CALLBACK_CRASH_INPUT: JSON.stringify({ directory: f.root, source, config, key, queryId, fingerprint, modelConfig }) }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let entered = false, diagnostics = ""; child.on("message", message => { if (message === "claimed") entered = true; }); child.stderr!.on("data", chunk => { diagnostics += String(chunk); }); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await until(() => { assert.equal(child.exitCode, null, diagnostics); return entered; }); const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  await f.open(); await f.harness.commit(tx => f.callbacks.verify(tx), context);
  const saved = await f.harness.commit(async tx => { const value = await f.callbacks.lookup(tx, key, fingerprint); return value && copyJson(value) as PersonalTelegramCallbackRecord; }, context); assert.ok(saved); f.harness.resume(); await f.harness.waitForTask(saved.ref.taskId, context);
  const recovered = await f.get(saved.ref); assert.equal(recovered.state, "effect_unknown"); assert.equal(recovered.code, "telegram_callback_ack_interrupted"); assert.equal(f.sent.length, 0); await f.harness.commit(tx => f.callbacks.verify(tx), context);
});
