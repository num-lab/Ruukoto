import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry, ROOT_CONVERSATION_ID, GenerationTask, ToolTask, LiveDoc, InboxDoc, watchEvents, type TaskId, type SubmissionRecord } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";
import { personalLocalInput } from "../apps/ruukoto/src/personal-local-records.ts";
import { recordPersonalOwnerInput } from "../apps/ruukoto/src/personal-owner-input.ts";
import { PersonalToolDoc, PersonalToolsDoc, ToolAdmission, toolDecide, type PersonalToolOperation } from "../apps/ruukoto/src/personal-tools.ts";
import { personalBackgroundWork, personalSubAgent } from "../apps/ruukoto/src/personal-work.ts";
import { delegatePersonalAnalysis, personalAnalysisDelegations } from "../apps/ruukoto/src/personal-delegation.ts";
import { personalDesktopEvents, personalDesktopLive, PERSONAL_DESKTOP_FRAME_LIMIT } from "../apps/ruukoto/src/personal-desktop-events.ts";
import { personalTimeline } from "../apps/ruukoto/src/personal-history.ts";
import type { PersonalDesktopFrame } from "@ruukoto/view/personal-protocol.ts";

const context = BACKGROUND_CONTEXT;
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, "Desktop frame budget probe timed out"); await delay(5); }
}
function message(thinking: number) {
  return { role: "assistant" as const, content: [{ type: "text" as const, text: "\u0000".repeat(4096) }, { type: "thinking" as const, thinking: "\u0000".repeat(thinking) }], api: "openai-completions" as const, provider: "test", model: "unused", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: 1 };
}

test("Escaped desktop state preserves durable facts through snapshot fallback and owner update batches", async t => {
  const registry = createRegistry();
  for (const extension of [personalBackgroundWork, personalSubAgent, personalAnalysisDelegations]) registry.install(extension);
  const models = recordedModels(personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "DESKTOP_UNUSED_KEY", contextWindow: 128000, maxTokens: 1024 }), async () => assert.fail("Observation must not call a model"));
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
  await harness.root(context);
  const directory = fs.mkdtempSync("/tmp/rk-frame-budget-"), server = http.createServer(), runId = randomUUID();
  const events = personalDesktopEvents(server, harness, "test-token", runId), clients: WebSocket[] = [];
  t.after(async () => { for (const client of clients) client.terminate(); await events.close(); await new Promise<void>(resolve => server.close(() => resolve())); await harness.close(context); fs.rmSync(directory, { recursive: true, force: true }); });
  const body = "\u0000".repeat(4096), operations: TaskId[] = [], sources: SubmissionRecord[] = [];
  for (let index = 0; index < 8; index++) {
    const requestId = randomUUID();
    await harness.commit(tx => personalLocalInput(tx, requestId, body), context);
    sources.push(await harness.commit(async tx => {
      const entry = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: body, timestamp: 1 }] });
      const native = await tx.createSubmission({ conversationId: ROOT_CONVERSATION_ID, requestId, type: "input", status: "placed", entry: entry.id });
      await recordPersonalOwnerInput(tx, { type: "input", requestId, content: body }, native, 1);
      return native;
    }, context));
    await harness.commit(tx => delegatePersonalAnalysis(tx, { provider: "test", modelId: "unused" }, { content: body, requestId: `${index}${"\u0000".repeat(255)}`, sourceRequestId: requestId, label: "\u0000".repeat(128) }), context);
  }
  await harness.commit(async tx => {
    const index = await tx.doc(PersonalToolsDoc);
    for (let id = 0; id < 8; id++) {
      const generation = await tx.createTask(GenerationTask, {}, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" } });
      const assistant = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.assistant" });
      const operation = await tx.createTask(ToolTask, { kind: "model", assistant: assistant.id, callId: `read-${id}` }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "task", taskId: generation } });
      const target = `/${"\u0001".repeat(200)}/${"\u0001".repeat(200)}/${"\u0001".repeat(200)}`;
      const data = { operation, origin: { conversationId: ROOT_CONVERSATION_ID, generation, inputs: [sources[id].id], sources: [sources[id].id], source: { requestId: sources[id].requestId!, submissionId: sources[id].id, entryId: sources[id].entry! }, permission: { mode: "confirm" as const, version: 1 } }, kind: "read_file" as const, params: { path: target }, prepared: { kind: "file" as const, request: { path: target, access: "read" as const, targetDev: 1, targetIno: id + 1, originalSha256: "a".repeat(64), protectedRoots: [] } }, grantVersion: 1, approval: "pending" as const, fileIoVersion: 1 as const };
      const admission = await tx.appendEntry(ToolAdmission, ROOT_CONVERSATION_ID, { data });
      const value: PersonalToolOperation = { ...data, admission: admission.id, started: false, stopped: true, effect: "not_executed", code: "approval_pending" };
      (await tx.doc(PersonalToolDoc, String(operation), null)).operation = value;
      index.operations.push(operation); operations.push(operation);
    }
  }, context);
  const queued: SubmissionRecord[] = [];
  for (let index = 0; index < 8; index++) {
    const requestId = randomUUID();
    await harness.commit(tx => personalLocalInput(tx, requestId, body), context);
    queued.push(await harness.commit(async tx => {
      const value = await tx.createSubmission({ conversationId: ROOT_CONVERSATION_ID, requestId, type: "input", status: "queued" });
      await recordPersonalOwnerInput(tx, { type: "input", requestId, content: body }, value, 2);
      return value;
    }, context));
  }
  const inboxItems = [...queued];
  for (let index = 0; index < 56; index++) inboxItems.push(await harness.commit(tx => tx.createSubmission({ conversationId: ROOT_CONVERSATION_ID, requestId: randomUUID(), type: "input", status: "queued" }), context));
  await harness.commit(async tx => {
    for (let index = 0; index < 2; index++) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.assistant", model: [message(4064)] });
    const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
    live.run = { taskId: await tx.createTask(GenerationTask, {}, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" } }), inputs: [sources[0].id] };
    live.generation = { attempt: 1, message: message(4077) };
    const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
    for (const value of inboxItems) inbox.items.push({ id: value.id, mode: "followUp", content: queued.some(saved => saved.id === value.id) ? body : "Short queued input" });
  }, context);
  const watch = await watchEvents(harness, ROOT_CONVERSATION_ID, context), fullLive = personalDesktopLive(watch.snapshot);
  await watch.stop();
  const state = await events.state(), timeline = await harness.commit(tx => personalTimeline(tx, {}), context);
  const untrimmed = { v: 1, runId, subscription: randomUUID(), seq: 0, type: "snapshot", timeline, live: fullLive, state };
  assert.ok(Buffer.byteLength(JSON.stringify(untrimmed)) > PERSONAL_DESKTOP_FRAME_LIMIT);
  const socketPath = path.join(directory, "control.sock"); server.listen(socketPath); await once(server, "listening");
  const frames: PersonalDesktopFrame[] = [], sizes: number[] = [];
  const client = new WebSocket(`ws+unix:${socketPath}:/events`, { headers: { authorization: "Bearer test-token" } }); clients.push(client);
  client.on("message", data => { const text = data.toString(); sizes.push(Buffer.byteLength(text)); frames.push(JSON.parse(text)); });
  await once(client, "open"); await until(() => frames.length > 0);
  const snapshot = frames[0]; assert.equal(snapshot.type, "snapshot");
  assert.ok(snapshot.type === "snapshot");
  assert.equal(snapshot.live.generation, undefined); assert.deepEqual(snapshot.live.tools, []);
  assert.deepEqual(snapshot.timeline, timeline); assert.deepEqual(snapshot.state, state);
  assert.deepEqual(snapshot.live.run, fullLive.run); assert.deepEqual(snapshot.live.inbox, fullLive.inbox);
  await harness.commit(async tx => {
    for (const operation of operations) await toolDecide(tx, operation, "rejected", directory);
    for (const submission of queued) tx.settleSubmission(submission.id, { status: "unanswered", reason: "withdrawn" });
  }, context);
  const ownerUpdates = () => frames.flatMap(frame => frame.type === "events" ? frame.events.flatMap(event => event.type === "entry_appended" && event.entry.input?.status === "unanswered" ? [event.entry.input.submission] : []) : []);
  await until(() => new Set(ownerUpdates()).size === 8);
  assert.deepEqual(new Set(ownerUpdates()), new Set(queued.map(value => value.id)));
  assert.equal(client.readyState, WebSocket.OPEN);
  assert.ok(sizes.every(bytes => bytes <= PERSONAL_DESKTOP_FRAME_LIMIT));
  assert.ok(frames.every((frame, index) => frame.seq === index));
  t.diagnostic(JSON.stringify({ untrimmedSnapshotBytes: Buffer.byteLength(JSON.stringify(untrimmed)), snapshotBytes: sizes[0], maxEventBytes: Math.max(...sizes.slice(1)), ownerStatuses: new Set(ownerUpdates()).size }));
});
