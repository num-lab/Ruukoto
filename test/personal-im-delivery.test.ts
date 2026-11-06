import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineEntry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type EntryId, type Task, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { personalImDelivery, PersonalImDeliveryDoc, PersonalImDeliveriesDoc, PERSONAL_IM_SEND_ATTEMPTS, personalImDeliveryTextReceipt, personalImTextSegments, type PersonalImDeliveryAuthorization, type PersonalImDeliveryDocument, type PersonalImDeliveryInput, type PersonalImDeliveryOutputLoader, type PersonalImDeliveryRef } from "../apps/ruukoto/src/personal-im-delivery.ts";
import { PersonalImApiError, type PersonalImAccess, type PersonalImKeyboard } from "../apps/ruukoto/src/personal-im-api.ts";
import { PersonalTelegramDoc, type PersonalEntryIdentity } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";

const context = BACKGROUND_CONTEXT;
const source: PersonalEntryIdentity = { botId: "123", ownerId: "456", generation: "original-generation" };
const config = { version: 1 as const, enabled: true, ...source, apiBase: "http://127.0.0.1:1", tokenEnv: "UNUSED_TELEGRAM_KEY", tokenDigest: "0".repeat(64), boundary: 0 };
const output = (id: number) => ({ publication: 10 as EntryId, output: id as EntryId });
const modelConfig = { api: "openai-completions" as const, baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "IM_DELIVERY_UNUSED_KEY", contextWindow: 4096, maxTokens: 1024 };
const models = () => recordedModels(personalProvider(modelConfig), async () => assert.fail("Delivering original text never calls a model"));
function document(text: string): PersonalImDeliveryDocument { const bytes = Buffer.from(text); return { bytes, name: "final.txt", mime: "text/plain", sha256: createHash("sha256").update(bytes).digest("hex"), partial: false }; }
const parentTask = defineTask<object, { phase: "wait" }, object>({ name: "delivery-test-parent", version: 1, initial: () => ({ phase: "wait" }), phases: { async wait(_current, runtime, callContext) { await runtime.sleep(runtime.now() + 3600000, callContext); await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), callContext); } }, async abort(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: {} } }), callContext); } });
async function until(check: () => boolean | Promise<boolean>) { const deadline = Date.now() + 10_000; while (!await check()) { assert.ok(Date.now() < deadline, "Delivery did not reach the expected state"); await delay(5); } }
async function fixture(t: TestContext, options: { send?: (text: string, signal: AbortSignal) => Promise<string>; document?: (file: PersonalImDeliveryDocument, signal: AbortSignal) => Promise<string>; loadOutput?: PersonalImDeliveryOutputLoader; authorize?: PersonalImDeliveryAuthorization } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "rk-im-delivery-"));
  const texts: string[] = [], files: Uint8Array[] = [], keyboards: (PersonalImKeyboard | undefined)[] = [];
  let harness!: Harness, current = { ...source };
  const sender = {
    async send(owner: string, message: number, text: string, signal: AbortSignal, keyboard?: PersonalImKeyboard) { assert.equal(owner, source.ownerId); assert.equal(message, 99); texts.push(text); keyboards.push(keyboard); return options.send ? options.send(text, signal) : `text-${texts.length}`; },
    async document(owner: string, message: number, file: PersonalImDeliveryDocument, signal: AbortSignal) { assert.equal(owner, source.ownerId); assert.equal(message, 99); files.push(file.bytes); return options.document ? options.document(file, signal) : `file-${files.length}`; },
  };
  const im: PersonalImAccess = { async withEntry(_source, action) { return action(); }, sender: () => sender, configurationVersion: () => "original-configuration", isActive: value => value.generation === current.generation && value.botId === current.botId && value.ownerId === current.ownerId };
  const delivery = personalImDelivery(() => harness, im, options.loadOutput ?? (async () => document("Exact bytes 🦉\n")), options.authorize), registry = createRegistry();
  registry.install(delivery.extension); registry.install(defineExtension({ name: "delivery-test", tasks: [parentTask] }));
  const open = async () => { harness = await Harness.open(await openNodeSqliteStorage(path.join(root, "personal.sqlite")), { registry, models: models() }, context); await harness.root(context); return harness; };
  await open();
  await harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config = config; }, context);
  t.after(async () => { await harness.close(context); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, texts, files, keyboards, delivery, open, get harness() { return harness; }, request: async (input: Partial<PersonalImDeliveryInput> = {}, parent?: TaskId) => { const ref = await harness.commit(tx => delivery.request(tx, { key: "original", source, messageId: 99, text: "Exact original\n", ...input }, parent), context); harness.resume(); return ref; },
    async rebind() { current = { ...source, generation: "new-generation" }; await harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config = { ...config, generation: current.generation }; }, context); },
  };
}

test("Multipart text preserves exact whitespace, Unicode and surrogate boundaries within 4096 UTF-16 units", () => {
  const text = " \n" + "a".repeat(4093) + "🦉" + "\r\n" + "𠮷e\u0301👩‍👩‍👧‍👧".repeat(650) + "\n ";
  const parts = personalImTextSegments(text);
  assert.ok(parts.length > 2); assert.equal(parts.join(""), text);
  for (let index = 0; index < parts.length; index++) { assert.ok(parts[index].length <= 4096); if (index > 0) assert.doesNotMatch(parts[index], /^[\udc00-\udfff]/); if (index + 1 < parts.length) assert.doesNotMatch(parts[index], /[\ud800-\udbff]$/); }
  assert.deepEqual(personalImTextSegments(""), []);
});

test("Delivery persists exact input once and ordered part claims/outcomes; restart and same key do not send again", async t => {
  const f = await fixture(t), text = "\n" + "🦉".repeat(4500) + "\n ", ref = await f.request({ text });
  assert.deepEqual(await f.request({ text }), ref);
  await assert.rejects(f.request({ text: text + "changed" }), { code: "im_delivery_conflict" });
  assert.deepEqual(await f.delivery.wait(ref), { state: "sent", textState: "sent", outputState: "none" });
  const saved = await f.delivery.get(ref);
  assert.equal(saved.input.text, text); assert.equal(f.texts.join(""), text); assert.deepEqual(saved.parts.map(part => part.index), [0, 1, 2]);
  assert.ok(saved.parts.every(part => part.claims.length === 1 && part.observations.length === 1 && part.claims[0] < part.observations[0]));
  await assert.rejects(f.delivery.get({ ...ref, taskId: (ref.taskId + 1) as PersonalImDeliveryRef["taskId"] }), { code: "im_delivery_invalid" });
  await f.harness.commit(tx => f.delivery.verify(tx), context);
  await f.harness.close(context); await f.open();
  await f.harness.commit(tx => f.delivery.verify(tx, [ref.key]), context);
  assert.deepEqual(await f.request({ text }), ref); assert.deepEqual(await f.delivery.get(ref), saved); assert.equal(f.texts.length, 3);
});

test("An unknown middle part stops all later text and outputs; explicit retrieval copies selected originals without work", async t => {
  let sends = 0;
  const f = await fixture(t, { async send() { if (++sends === 2) throw new PersonalImApiError("telegram_unverified", "Lost reply", "effect_unknown"); return `message-${sends}`; } });
  const text = "A".repeat(4096) + "🦉".repeat(2048) + "last\n", ref = await f.request({ text, outputs: [output(11)] });
  assert.deepEqual(await f.delivery.wait(ref), { state: "effect_unknown", textState: "effect_unknown", outputState: "canceled" });
  const original = await f.delivery.get(ref);
  assert.deepEqual(original.parts.map(part => part.state), ["sent", "effect_unknown", "canceled", "canceled"]); assert.equal(f.texts.length, 2); assert.equal(f.files.length, 0);
  await f.harness.commit(tx => f.delivery.verify(tx), context);
  const selected = original.parts.slice(1, 3).map(part => part.kind === "text" ? part.text : "").join("");
  await assert.rejects(f.request({ key: "wrong-copy", text: selected + "changed", retrieval: { delivery: ref, segments: [1, 2] } }), { code: "im_retrieval_invalid" });
  const redisplay = await f.request({ key: "explicit-copy", text: selected, retrieval: { delivery: ref, segments: [1, 2] } });
  assert.equal((await f.delivery.wait(redisplay)).textState, "sent");
  assert.equal(f.texts.slice(2).join(""), selected); assert.deepEqual(await f.delivery.get(ref), original);
  await f.harness.commit(tx => f.delivery.verify(tx), context);
  await f.rebind();
  await assert.rejects(f.request({ key: "cross-generation", source: { ...source, generation: "new-generation" }, text: selected, retrieval: { delivery: ref, segments: [1, 2] } }), { code: "im_retrieval_invalid" });
});

test("Only a proven not-sent rate limit retries the same part; explicit refusal stops later text", async t => {
  let requests = 0;
  const f = await fixture(t, { async send() { requests++; if (requests === 1) throw new PersonalImApiError("telegram_rate_limited", "Rate limited", "not_sent", 20); if (requests === 3) throw new PersonalImApiError("telegram_refused", "Refused", "not_sent"); return `message-${requests}`; } });
  const ref = await f.request({ text: "A".repeat(8193) });
  assert.equal((await f.delivery.wait(ref)).textState, "failed");
  const record = await f.delivery.get(ref);
  assert.deepEqual(record.parts.map(part => part.state), ["sent", "failed", "canceled"]); assert.deepEqual(record.parts.map(part => part.claims.length), [2, 1, 0]); assert.equal(f.texts[0], f.texts[1]);
  assert.equal(record.parts[0].observations.length, 2);
  await f.harness.commit(tx => f.delivery.verify(tx), context);
});

test("Repeated confirmed rate limits exhaust a durable per-part attempt budget and do not replay after reopen", async t => {
  const f = await fixture(t, { async send() { throw new PersonalImApiError("telegram_rate_limited", "Rate limited", "not_sent", 1); } });
  const ref = await f.request({ text: "A".repeat(8193) });
  assert.equal((await f.delivery.wait(ref)).textState, "failed");
  const saved = await f.delivery.get(ref);
  assert.deepEqual(saved.parts.map(part => part.state), ["failed", "canceled", "canceled"]);
  assert.equal(saved.parts[0].claims.length, PERSONAL_IM_SEND_ATTEMPTS); assert.equal(saved.parts[0].code, "telegram_rate_limited"); assert.equal(f.texts.length, PERSONAL_IM_SEND_ATTEMPTS);
  await f.harness.commit(tx => f.delivery.verify(tx), context); await f.harness.close(context); await f.open();
  assert.deepEqual(await f.delivery.get(ref), saved); assert.deepEqual(await f.request({ text: "A".repeat(8193) }), ref); assert.equal(f.texts.length, PERSONAL_IM_SEND_ATTEMPTS);
});

test("A confirmed refusal with an overflowing retry deadline remains a terminal known-not-sent failure", async t => {
  const f = await fixture(t, { async send() { throw new PersonalImApiError("telegram_rate_limited", "Rate limited", "not_sent", Number.MAX_SAFE_INTEGER); } }), ref = await f.request();
  assert.equal((await f.delivery.wait(ref)).textState, "failed"); assert.equal(f.texts.length, 1); await f.harness.commit(tx => f.delivery.verify(tx), context);
});

test("A persisted keyboard appears only on the final confirmed text segment and does not enter retrievals", async t => {
  const f = await fixture(t), keyboard = [[{ text: "批准", callback_data: "opaque-original-token" }], [{ text: "拒绝", callback_data: "opaque-other-token" }]];
  const ref = await f.request({ text: "A".repeat(8193), keyboard }); await f.delivery.wait(ref);
  assert.deepEqual(f.keyboards, [undefined, undefined, keyboard]); assert.deepEqual((await f.delivery.get(ref)).input.keyboard, keyboard);
  await assert.rejects(f.request({ key: "media-keyboard", outputs: [output(11)], keyboard }), { code: "im_delivery_invalid" });
  await assert.rejects(f.request({ key: "bad-token", keyboard: [[{ text: "批准", callback_data: "🦉".repeat(17) }]] }), { code: "im_delivery_invalid" });
  await assert.rejects(f.request({ key: "retrieval-keyboard", keyboard, retrieval: { delivery: ref, segments: [2] }, text: "A" }), { code: "im_delivery_invalid" });
  await f.harness.commit(tx => f.delivery.verify(tx), context);
});

test("Canceling a proven rate-limit wait preserves its rejection receipt and verifies before task abort", async t => {
  const f = await fixture(t, { async send() { throw new PersonalImApiError("telegram_rate_limited", "Rate limited", "not_sent", 60000); } });
  const ref = await f.request({ text: "A".repeat(8193) });
  await until(async () => (await f.delivery.get(ref)).parts[0].retryAt !== undefined);
  await f.harness.commit(tx => f.delivery.cancel(tx, ref), context);
  await f.harness.commit(tx => f.delivery.verify(tx), context);
  await f.harness.abortTask(ref.taskId, context);
  assert.deepEqual(await f.delivery.wait(ref), { state: "canceled", textState: "canceled", outputState: "none" });
  assert.equal(f.texts.length, 1); assert.equal((await f.delivery.get(ref)).parts[0].claims.length, 1);
  await f.harness.commit(tx => f.delivery.verify(tx), context);
});

test("A temporary content check waits outside the entry lock and resumes the same unsent part on a commit", async t => {
  let waiting = true, checked = 0;
  const f = await fixture(t, { async authorize() { checked++; return waiting ? "wait" : true; } }), ref = await f.request();
  await until(() => checked > 0); assert.equal(f.texts.length, 0); assert.equal((await f.delivery.get(ref)).parts[0].claims.length, 0);
  waiting = false;
  await f.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.original-content-ready" }), context);
  assert.equal((await f.delivery.wait(ref)).textState, "sent"); assert.equal(f.texts.length, 1); assert.equal((await f.delivery.get(ref)).parts[0].claims.length, 1);
  await f.harness.commit(tx => f.delivery.verify(tx), context);
});

test("Cancellation wakes a waiting content check without claiming or sending the held part", async t => {
  let checked = false;
  const f = await fixture(t, { async authorize() { checked = true; return "wait"; } }), ref = await f.request(); await until(() => checked);
  await f.harness.commit(tx => f.delivery.cancel(tx, ref), context);
  assert.equal((await f.delivery.wait(ref)).textState, "canceled"); assert.equal(f.texts.length, 0); assert.equal((await f.delivery.get(ref)).parts[0].claims.length, 0);
  await f.harness.commit(tx => f.delivery.verify(tx), context);
});

test("Generation replacement does not redirect a started part and cancels its remaining text", async t => {
  let started = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { async send() { started = true; await held; return "original-message"; } }), ref = await f.request({ text: "A".repeat(8193) });
  await until(() => started); await f.rebind(); release();
  assert.deepEqual(await f.delivery.wait(ref), { state: "canceled", textState: "canceled", outputState: "none" });
  assert.deepEqual((await f.delivery.get(ref)).parts.map(part => part.state), ["sent", "canceled", "canceled"]); assert.equal(f.texts.length, 1);
  await f.harness.commit(tx => f.delivery.verify(tx), context);
});

test("Parent cancellation during an output read prevents its send; confirmed text delivery remains sent", async t => {
  let loading = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { async loadOutput() { loading = true; await held; return document("Exact bytes"); } });
  const parent = await f.harness.commit(tx => tx.createTask(parentTask, {}, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true }), context);
  const ref = await f.request({ outputs: [output(11)] }, parent); await until(() => loading);
  await f.harness.abortTask(parent, context); release();
  assert.deepEqual(await f.delivery.wait(ref), { state: "canceled", textState: "sent", outputState: "canceled" }); assert.equal(f.files.length, 0);
  const record = await f.delivery.get(ref); assert.equal(record.parent, parent); assert.equal(record.parts[1].claims.length, 0);
  await f.harness.commit(tx => f.delivery.verify(tx), context);
});

test("An explicit cancel and abort retain an in-flight unknown part and all unsent segments", async t => {
  let requests = 0, started = false;
  const f = await fixture(t, { async send(_text, signal) { if (++requests === 1) return "first-part"; started = true; return new Promise<string>((_resolve, reject) => { const abort = () => reject(new PersonalImApiError("telegram_unverified", "Interrupted send", "effect_unknown")); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }); } });
  const ref = await f.request({ text: "A".repeat(8193), outputs: [output(11)] }); await until(() => started);
  await f.harness.commit(tx => f.delivery.cancel(tx, ref), context); await f.harness.abortTask(ref.taskId, context);
  assert.deepEqual(await f.delivery.wait(ref), { state: "effect_unknown", textState: "effect_unknown", outputState: "canceled" });
  const record = await f.delivery.get(ref); assert.ok(record.canceled); assert.deepEqual(record.parts.map(part => part.state), ["sent", "effect_unknown", "canceled", "canceled"]); assert.equal(f.texts.length, 2);
  await f.harness.commit(tx => f.delivery.verify(tx), context);
});

test("Partial or corrupt outputs never send; complete media has independent results and unknown sends stop later media", async t => {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 42);
  const f = await fixture(t, { async loadOutput(ref) { assert.ok("output" in ref); if (ref.output === 11) return { ...document("partial"), partial: true }; if (ref.output === 12) return { ...document("corrupt"), sha256: "0".repeat(64) }; return { ...document(""), name: "complete.bin", mime: "application/octet-stream", bytes, sha256: createHash("sha256").update(bytes).digest("hex") }; }, async document() { throw new PersonalImApiError("telegram_unverified", "Lost media reply", "effect_unknown"); } });
  const ref = await f.request({ outputs: [output(11), output(12), output(13), output(14)] });
  assert.deepEqual(await f.delivery.wait(ref), { state: "effect_unknown", textState: "sent", outputState: "effect_unknown" });
  const record = await f.delivery.get(ref); assert.deepEqual(record.parts.map(part => part.state), ["sent", "failed", "failed", "effect_unknown", "canceled"]); assert.deepEqual(record.parts.map(part => part.claims.length), [1, 0, 0, 1, 0]);
  assert.equal(f.files.length, 1); assert.deepEqual(f.files[0], bytes); assert.equal(record.parts[1].code, "output_partial"); assert.equal(record.parts[2].code, "artifact_unavailable");
  await f.harness.commit(tx => f.delivery.verify(tx), context);
});

test("Delivery verification rejects changed originals, source/claim mismatches and orphan indices", async t => {
  for (const corruption of ["text", "source", "index", "order"] as const) await t.test(corruption, async t => {
    const f = await fixture(t), ref = await f.request(); await f.delivery.wait(ref);
    await f.harness.commit(async tx => {
      const value = (await tx.doc(PersonalImDeliveryDoc, ref.key, null)).delivery!;
      if (corruption === "text") value.input.text += "changed";
      else if (corruption === "source") value.input.source.generation = "other-generation";
      else if (corruption === "order") value.parts[0].claims.push(value.parts[0].claims[0]);
      else (await tx.doc(PersonalImDeliveriesDoc)).keys = [];
    }, context);
    await assert.rejects(f.harness.commit(tx => f.delivery.verify(tx), context), { code: "im_delivery_invalid" });
  });
});

test("Verification rejects a persisted cancellation observation for a claimed send", async t => {
  const f = await fixture(t, { async authorize() { return "wait"; } }), ref = await f.request();
  await f.harness.commit(async tx => {
    const value = (await tx.doc(PersonalImDeliveryDoc, ref.key, null)).delivery!, part = value.parts[0];
    const claim = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.im-delivery-claim", data: { ref, admission: value.admission, index: 0, attempt: 0, source, messageId: 99, content: { kind: "text", text: value.input.text } } });
    const observed = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.im-delivery-observation", data: { ref, admission: value.admission, index: 0, claim: claim.id, state: "canceled", code: "false_cancellation" } });
    part.claims = [claim.id]; part.observations = [observed.id]; part.state = "canceled"; part.code = "false_cancellation";
  }, context);
  await assert.rejects(f.harness.commit(tx => f.delivery.verify(tx), context), { code: "im_delivery_invalid" }); assert.equal(f.texts.length, 0);
});

test("Historical text receipts retain the claim state before a later confirmed observation", async t => {
  const f = await fixture(t), ref = await f.request({ text: "A".repeat(8193) }); await f.delivery.wait(ref);
  const saved = await f.delivery.get(ref), last = saved.parts.at(-1)!;
  assert.deepEqual(await f.harness.commit(tx => personalImDeliveryTextReceipt(tx, ref, last.observations[0]), context), { state: "sending" });
  assert.deepEqual(await f.harness.commit(tx => personalImDeliveryTextReceipt(tx, ref), context), { state: "sent", platformMessageId: last.platformMessageId });
  const forged = defineEntry<{ ref: PersonalImDeliveryRef; admission: EntryId; index: number; state: "sent"; code: string; platformMessageId: string }>("ruukoto.im-delivery-observation");
  await f.harness.commit(async tx => { const entry = await tx.appendEntry(forged, ROOT_CONVERSATION_ID, { data: { ref: { ...ref, key: "other" }, admission: saved.admission, index: last.index, state: "sent", code: "sent", platformMessageId: "other" } }); (await tx.doc(PersonalImDeliveryDoc, ref.key, null)).delivery!.parts.at(-1)!.observations.push(entry.id); }, context);
  await assert.rejects(f.harness.commit(tx => personalImDeliveryTextReceipt(tx, ref, (saved.admission + 10000) as EntryId), context), { code: "im_delivery_invalid" });
});

test("Cold delivery verification reconciles an observation-commit fault before any delivery wait", async t => {
  const f = await fixture(t), task = f.delivery.extension.tasks![0] as Task<{ key: string }, { phase: "send"; index: number; retryAt?: number } | { phase: "verify"; index: number }, import("../apps/ruukoto/src/personal-im-delivery.ts").PersonalImDeliveryResult, object>, send = task.definition.phases.send;
  t.mock.method(task.definition.phases, "send", async (...[current, runtime, callContext]: Parameters<typeof send>) => { let commits = 0; return send(current, { ...runtime, async commit(...args) { if (++commits === 3) throw new Error("Injected delivery observation commit failure"); return runtime.commit(...args); } }, callContext); });
  const text = "A".repeat(8193), ref = await f.request({ text }), settled = await f.harness.waitForTask(ref.taskId, context);
  assert.equal(settled.state.outcome.status, "faulted"); const before = (await f.harness.snapshot(PersonalImDeliveryDoc, ref.key, context))!.delivery!;
  assert.deepEqual(before.parts.map(part => part.state), ["sending", "pending", "pending"]); assert.deepEqual(before.parts.map(part => part.observations.length), [0, 0, 0]); assert.equal(f.texts.length, 1);
  await f.harness.commit(tx => f.delivery.verify(tx), context); const recovered = (await f.harness.snapshot(PersonalImDeliveryDoc, ref.key, context))!.delivery!;
  assert.deepEqual(recovered.parts.map(part => part.state), ["effect_unknown", "canceled", "canceled"]); assert.deepEqual(recovered.parts.map(part => part.observations.length), [1, 1, 1]); assert.deepEqual(recovered.parts.map(part => part.claims.length), [1, 0, 0]);
  assert.deepEqual((await f.harness.getTask(ref.taskId, context))!.state, settled.state);
  for (const part of recovered.parts) { const entry = await f.harness.commit(tx => tx.entry(part.observations[0]), context); assert.deepEqual(entry!.data, { ref, admission: recovered.admission, index: part.index, ...(part.index === 0 ? { claim: before.parts[0].claims[0] } : {}), state: part.state, code: part.index === 0 ? "send_interrupted" : "delivery_interrupted" }); }
  await f.harness.close(context); await f.open(); await f.harness.commit(tx => f.delivery.verify(tx), context);
  assert.deepEqual((await f.harness.snapshot(PersonalImDeliveryDoc, ref.key, context))!.delivery, recovered); assert.equal((await f.delivery.wait(ref)).textState, "effect_unknown"); assert.equal(f.texts.length, 1);
});

test("Cold delivery verification rejects orphan evidence before reconciling a terminal fault", async t => {
  const f = await fixture(t), task = f.delivery.extension.tasks![0] as Task<{ key: string }, { phase: "send"; index: number; retryAt?: number } | { phase: "verify"; index: number }, import("../apps/ruukoto/src/personal-im-delivery.ts").PersonalImDeliveryResult, object>, send = task.definition.phases.send;
  t.mock.method(task.definition.phases, "send", async (...[current, runtime, callContext]: Parameters<typeof send>) => { let commits = 0; return send(current, { ...runtime, async commit(...args) { if (++commits === 3) throw new Error("Injected delivery observation commit failure"); return runtime.commit(...args); } }, callContext); });
  const ref = await f.request({ text: "A".repeat(8193) }); await f.harness.waitForTask(ref.taskId, context);
  const before = (await f.harness.snapshot(PersonalImDeliveryDoc, ref.key, context))!.delivery!;
  await f.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.im-delivery-observation", data: { ref, admission: before.admission, index: 0, claim: before.parts[0].claims[0], state: "sent", code: "forged", platformMessageId: "forged" } }), context);
  await assert.rejects(f.harness.commit(tx => f.delivery.verify(tx), context), { code: "im_delivery_invalid" });
  assert.deepEqual((await f.harness.snapshot(PersonalImDeliveryDoc, ref.key, context))!.delivery, before); assert.equal(f.texts.length, 1);
});

test("SIGKILL at a middle send claim recovers unfinished or terminal-faulted delivery without replay", { timeout: 30000 }, async t => {
  for (const failVerify of [false, true]) await t.test(failVerify ? "terminal fault" : "live checkpoint", async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "rk-im-delivery-crash-")), filename = path.join(root, "personal.sqlite");
  let child: ReturnType<typeof spawn> | undefined, harness: Harness | undefined;
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } await harness?.close(context); fs.rmSync(root, { recursive: true, force: true }); });
  const text = "First" + "a".repeat(4091) + "🦉".repeat(2048) + "Third part\n";
  const script = `
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { personalImDelivery } from ${JSON.stringify(new URL("../apps/ruukoto/src/personal-im-delivery.ts", import.meta.url).href)};
import { PersonalTelegramDoc } from ${JSON.stringify(new URL("../apps/ruukoto/src/personal-telegram-records.ts", import.meta.url).href)};
import { personalProvider, recordedModels } from ${JSON.stringify(new URL("../apps/ruukoto/src/personal-model.ts", import.meta.url).href)};
const {filename,source,config,text,modelConfig}=JSON.parse(process.env.IM_DELIVERY_CRASH_TEST);
let harness,sends=0;
setInterval(()=>{},1000);
const im={withEntry:async(_source,action)=>action(),isActive:()=>true,configurationVersion:()=>"original-configuration",sender:()=>({send:async()=>{ if(++sends===1)return "first-message";process.send("middle-claimed");await new Promise(()=>{}); }})};
const delivery=personalImDelivery(()=>harness,im),registry=createRegistry();registry.install(delivery.extension);
harness=await Harness.open(await openNodeSqliteStorage(filename),{registry,models:recordedModels(personalProvider(modelConfig),async()=>{throw Error("No model call allowed");})},BACKGROUND_CONTEXT);
await harness.root(BACKGROUND_CONTEXT);
await harness.commit(async tx=>{(await tx.doc(PersonalTelegramDoc)).config=config;},BACKGROUND_CONTEXT);
const ref=await harness.commit(tx=>delivery.request(tx,{key:"original",source,messageId:99,text}),BACKGROUND_CONTEXT);
await delivery.wait(ref);
`;
  child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, IM_DELIVERY_CRASH_TEST: JSON.stringify({ filename, source, config, text, modelConfig }) }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let claimed = false, diagnostics = ""; child.on("message", message => { claimed ||= message === "middle-claimed"; }); child.stderr!.on("data", value => { diagnostics += String(value); });
  await until(() => { assert.equal(child!.exitCode, null, diagnostics); return claimed; });
  const exited = once(child, "exit"); child.kill("SIGKILL"); const [status, signal] = await exited; assert.equal(status, null, diagnostics); assert.equal(signal, "SIGKILL");
  let resend = 0;
  const im: PersonalImAccess = { async withEntry(_source, action) { return action(); }, isActive: () => true, configurationVersion: () => "original-configuration", sender: () => ({ async send() { resend++; return "should-not-send"; } }) };
  const delivery = personalImDelivery(() => harness!, im), registry = createRegistry();
  if (failVerify) {
    const task = delivery.extension.tasks![0] as Task<{ key: string }, { phase: "send"; index: number; retryAt?: number } | { phase: "verify"; index: number }, import("../apps/ruukoto/src/personal-im-delivery.ts").PersonalImDeliveryResult, object>;
    registry.install(defineExtension({ name: delivery.extension.name, tasks: [defineTask({ ...task.definition, phases: { ...task.definition.phases, async verify() { throw new Error("Injected result-observation persistence failure"); } } })] }));
  } else registry.install(delivery.extension);
  harness = await Harness.open(await openNodeSqliteStorage(filename), { registry, models: models() }, context);
  const ref = await harness.commit(async tx => ({ ...(await tx.doc(PersonalImDeliveryDoc, "original", null)).delivery!.ref }), context) as PersonalImDeliveryRef;
  assert.deepEqual(await delivery.wait(ref), { state: "effect_unknown", textState: "effect_unknown", outputState: "none" });
  const saved = await delivery.get(ref); assert.equal(saved.input.text, text); assert.deepEqual(saved.parts.map(part => part.state), ["sent", "effect_unknown", "canceled"]); assert.deepEqual(saved.parts.map(part => part.claims.length), [1, 1, 0]); assert.equal(resend, 0);
  await harness.commit(tx => delivery.verify(tx), context);
  });
});
