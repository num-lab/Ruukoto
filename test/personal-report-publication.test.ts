import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalDelegationDoc, cancelPersonalDelegation, listPersonalDelegations, type PersonalDelegationRef } from "../apps/ruukoto/src/personal-delegation.ts";
import { PersonalReportCoverageEntry, PersonalReportPublication, personalReportPublicationMessage, personalReportResult, personalReportsFor, type PersonalReportFacts } from "../apps/ruukoto/src/personal-report.ts";
import { personalLocalInput } from "../apps/ruukoto/src/personal-local-records.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalTimeline } from "../apps/ruukoto/src/personal-history.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";
import { PersonalMockModelServer, type RecordedRequest } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const child = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent");
const summary = (request: RecordedRequest) => String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考");
const gate = (t: TestContext) => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); t.after(() => release()); return { promise, release }; };
async function until(read: () => boolean | Promise<boolean>) { const deadline = Date.now() + 10_000; while (!await read()) { assert.ok(Date.now() < deadline, "report condition timed out"); await delay(5); } }

async function fixture(t: TestContext, hold?: { report?: ReturnType<typeof gate>; query?: ReturnType<typeof gate>; arrangement?: ReturnType<typeof gate>; reportQuery?: boolean; unknownUrl?: string; onReportPayload?: (p: PersonalHarness) => Promise<void>; telegram?: PersonalTelegramConfig; streamReport?: boolean }) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-report-publication-")));
  let summaries = 0, queryStarted = false;
  const model = new PersonalMockModelServer(async request => {
    if (request.system?.startsWith("You are a context summarization assistant")) return { kind: "text", text: "NATIVE_COMPACTION_SUMMARY" };
    if (child(request)) {
      if (hold?.unknownUrl && request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content === "make-source-unknown") return { kind: "tool_calls", calls: [{ id: "unknown-post", name: "http_request", arguments: { url: hold.unknownUrl, method: "POST", body: "accepted request" } }] };
      return { kind: "text", text: `RESULT:${request.messages.findLast(message => message.role === "user")?.content}` };
    }
    if (summary(request)) {
      summaries++;
      if (hold?.reportQuery && request.messages.at(-1)?.role !== "tool") return { kind: "tool_calls", calls: [{ id: "report-progress", name: "background_work", arguments: { action: "progress", delegation: ref!.entryId } }] };
      if (hold?.streamReport) return { kind: "text", text: "UNPUBLISHED_PARTIAL ".repeat(30), chunkDelayMs: 20 };
      if (summaries === 1) await hold?.report?.promise;
      return { kind: "text", text: summaries === 1 ? "ORIGINAL_REPORT" : "UPDATED_REPORT" };
    }
    const last = request.messages.at(-1), text = String(last?.content);
    if (text === "arrange-two") return { kind: "tool_calls", calls: [{ id: "fast-first", name: "background_work", arguments: { action: "delegate", content: "first work" } }, { id: "continue-main", name: "background_work", arguments: { action: "list" } }] };
    if (last?.role === "tool" && hold?.arrangement) {
      await hold.arrangement.promise;
      const groups = request.messages.filter(message => message.role === "tool").map(message => { try { return JSON.parse(String(message.content)); } catch { return {}; } });
      const group = groups.find(value => typeof value.delegation === "number");
      if (group) return { kind: "tool_calls", calls: [{ id: "second-arranged", name: "background_work", arguments: { action: "delegate", content: "second work", delegation: group.delegation } }] };
    }
    if (text === "status-query" || text === "append-in-publish-gap") {
      queryStarted = true; await hold?.query?.promise;
      if (text === "append-in-publish-gap") {
        const work = (await p!.harness.snapshot(PersonalDelegationDoc, String(ref!.entryId), context))!.delegation!.members[0];
        return { kind: "tool_calls", calls: [{ id: "publish-amendment", name: "background_work", arguments: { action: "append", work: work.taskId, content: "revised requirement" } }] };
      }
      return { kind: "text", text: "Current progress." };
    }
    if (last?.role === "tool") return { kind: "text", text: text };
    if (text === "new-member") return { kind: "tool_calls", calls: [{ id: "second", name: "background_work", arguments: { action: "delegate", content: "second work", delegation: ref!.entryId } }] };
    return { kind: "tool_calls", calls: [{ id: "first", name: "background_work", arguments: { action: "delegate", content: "first work" } }] };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_PUBLICATION_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  let p: PersonalHarness | undefined, ref: PersonalDelegationRef | undefined;
  const workspace = directory + "-workspace";
  const tools = hold?.unknownUrl ? (() => { fs.mkdirSync(workspace); const identity = fs.statSync(workspace); return parsePersonalTools({ version: 1, generation: "report-source-tools", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] }); })() : undefined;
  t.after(async () => { await p?.close(); await model.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  isolateSkillHome(t);
  const base = personalProvider(config), provider = hold?.onReportPayload ? { ...base, streamSimple: (model: Parameters<typeof base.streamSimple>[0], input: Parameters<typeof base.streamSimple>[1], options?: Parameters<typeof base.streamSimple>[2]) => base.streamSimple(model, input, { ...options, onPayload: async (payload: unknown, model: Parameters<typeof base.streamSimple>[0]) => {
    if (String(input.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考")) await hold.onReportPayload!(p!);
    return await options?.onPayload?.(payload, model) ?? payload;
  } }) } : base;
  const open = async () => p = await openPersonalHarness({ directory, provider, modelId: config.modelId, tools, telegram: hold?.telegram });
  await open();
  return { directory, config, model, open, get p() { return p!; }, get ref() { return ref!; }, get summaries() { return summaries; }, get queryStarted() { return queryStarted; },
    async delegate(input = "delegate") { await p!.answer(input, "owner"); ref = (await p!.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref; return ref; },
    async receive(update: TelegramUpdate) {
      assert.ok(hold?.telegram); await p!.telegram.receive(update);
      const id = (update.message as { message_id: number }).message_id, key = `telegram:${hold.telegram.botId}:${hold.telegram.ownerId}:${id}`;
      const receipt = (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
      await p!.harness.waitForTask(receipt.taskId, context);
      ref = (await p!.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
      return (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    },
    async saved(): Promise<PersonalReportFacts> { return (await p!.harness.snapshot(PersonalDelegationDoc, String(ref!.entryId), context))!.delegation!.report!; },
    async result() { return p!.harness.commit(tx => personalReportResult(tx, ref!), context); },
  };
}

test("report publication: a queued progress query preserves the completed unchanged draft", { timeout: 30_000 }, async t => {
  const report = gate(t), query = gate(t), f = await fixture(t, { report, query });
  await f.delegate(); await until(() => f.summaries === 1);
  const queried = f.p.answer("status-query", "query");
  await until(async () => (await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "query"), context))?.status === "queued");
  report.release(); await until(() => f.queryStarted);
  const saved = await f.saved(); assert.equal(saved.version, 2);
  if (saved.version !== 2) throw new Error("expected current report version");
  assert.equal(saved.publication, undefined); assert.equal(saved.attempts[0].superseded, undefined);
  const attempt = await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, `personal-report:${saved.taskId}:0`), context);
  assert.equal(attempt?.status, "done"); assert.ok(attempt?.answer);
  query.release(); assert.equal(await queried, "Current progress.");
  await f.p.harness.waitForTask(saved.taskId, context);
  assert.equal(f.summaries, 1); assert.equal((await f.result()).text, "ORIGINAL_REPORT");
  const publication = (await f.saved()).version === 2 ? (await f.saved() as Extract<PersonalReportFacts, { version: 2 }>).publication : undefined;
  assert.ok(publication); const entry = await f.p.harness.commit(tx => tx.entry(publication!), context);
  assert.ok(entry); assert.equal(entry.model, undefined); assert.equal(entry.kind, PersonalReportPublication.kind);
});

test("report publication: completed work changes retain the prior publication and create one successor", { timeout: 30_000 }, async t => {
  const f = await fixture(t); await f.delegate(); const first = await f.saved(); await f.p.harness.waitForTask(first.taskId, context);
  assert.equal((await f.result()).text, "ORIGINAL_REPORT");
  const original = await f.saved(); assert.equal(original.version, 2); if (original.version !== 2) throw new Error("expected current report version");
  await f.p.answer("new-member", "another-work");
  const next = await f.saved(); assert.notEqual(next.taskId, original.taskId); await f.p.harness.waitForTask(next.taskId, context);
  assert.equal((await f.result()).text, "UPDATED_REPORT");
  const value = (await f.p.harness.snapshot(PersonalDelegationDoc, String(f.ref.entryId), context))!.delegation!;
  assert.equal(personalReportsFor(value).length, 2); assert.equal(value.reports![0].taskId, original.taskId);
  assert.equal(value.reports![0].version, 2); const publication = await f.p.harness.commit(tx => tx.entry(original.publication!), context);
  assert.ok(publication); const old = await f.p.harness.commit(tx => personalReportPublicationMessage(tx, publication), context);
  assert.equal(old?.content.filter(part => part.type === "text").map(part => part.text).join(""), "ORIGINAL_REPORT");
  await f.p.close(); await f.open(); assert.equal((await f.result()).text, "UPDATED_REPORT");
});

test("report publication: canonical covered native answers and work facts reject tampering on reopen", { timeout: 30_000 }, async t => {
  for (const mutation of ["facts", "answer", "sources"] as const) await t.test(mutation, async t => {
    const f = await fixture(t); await f.delegate(); const saved = await f.saved(); await f.p.harness.waitForTask(saved.taskId, context);
    const current = await f.saved(); assert.equal(current.version, 2); if (current.version !== 2) throw new Error("expected current report version");
    await f.p.close();
    const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
    const row = db.prepare("SELECT record FROM entries WHERE id = ?").get(current.attempts[0].coverage) as { record: string };
    const entry = JSON.parse(row.record) as { data: { coverage: { sources: unknown[]; members: { facts: unknown; submissionId?: number; answer?: number }[] } } };
    if (mutation === "facts") entry.data.coverage.members[0].facts = { tools: [{ operation: 987654, admission: 987655, effect: "invented" }] };
    if (mutation === "answer") entry.data.coverage.members[0].answer = 99999;
    if (mutation === "sources") entry.data.coverage.sources = [];
    db.prepare("UPDATE entries SET record = ? WHERE id = ?").run(JSON.stringify(entry), current.attempts[0].coverage);
    db.close();
    await assert.rejects(f.open(), error => error instanceof PersonalError && error.code.startsWith("report_"));
  });
});

test("report publication: canceling a held report retracts only its input and leaves main usable", { timeout: 30_000 }, async t => {
  const report = gate(t), f = await fixture(t, { report }); await f.delegate(); await until(() => f.summaries === 1);
  const saved = await f.saved(); await f.p.harness.commit(tx => cancelPersonalDelegation(tx, f.ref), context);
  await f.p.harness.waitForTask(saved.taskId, context);
  assert.equal((await f.result()).delivery, "canceled"); assert.equal((await f.result()).text, undefined);
  report.release(); assert.match(await f.p.answer("status-query", "after-cancel"), /Current progress/);
});


test("report publication: accepted local input before native placement delays the unchanged draft", { timeout: 30_000 }, async t => {
  const report = gate(t), f = await fixture(t, { report }); await f.delegate(); await until(() => f.summaries === 1);
  await f.p.harness.commit(tx => personalLocalInput(tx, "received-only", "status-query"), context);
  report.release();
  const saved = await f.saved(); if (saved.version !== 2) throw new Error("expected current report version");
  await until(async () => (await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, `personal-report:${saved.taskId}:0`), context))?.status === "done");
  assert.equal((await f.saved() as Extract<PersonalReportFacts, { version: 2 }>).publication, undefined);
  assert.equal(f.summaries, 1);
  assert.equal(await f.p.answer("status-query", "received-only"), "Current progress.");
  await f.p.harness.waitForTask(saved.taskId, context);
  assert.equal((await f.result()).text, "ORIGINAL_REPORT"); assert.equal(f.summaries, 1);
});

test("report publication: a fast first member waits for main to arrange the second", { timeout: 30_000 }, async t => {
  const arrangement = gate(t), f = await fixture(t, { arrangement });
  const owner = f.delegate("arrange-two");
  await until(async () => (await f.p.harness.commit(tx => listPersonalDelegations(tx), context)).items.length === 1);
  const ref = (await f.p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  const value = (await f.p.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!;
  await f.p.harness.waitForTask(value.members[0].taskId, context);
  assert.equal(f.summaries, 0); assert.equal(value.report!.version, 2);
  arrangement.release(); await owner;
  const saved = await f.saved(); await f.p.harness.waitForTask(saved.taskId, context);
  if (saved.version !== 2) throw new Error("expected current report version");
  const latest = await f.saved() as Extract<PersonalReportFacts, { version: 2 }>;
  const coverage = await f.p.harness.commit(tx => tx.entry(PersonalReportCoverageEntry, latest.attempts[0].coverage), context);
  assert.equal(coverage!.data.coverage.members.length, 2); assert.equal(f.summaries, 1);
});


test("report publication: an amendment accepted during the publication wait supersedes the completed old draft", { timeout: 30_000 }, async t => {
  const report = gate(t), query = gate(t), f = await fixture(t, { report, query });
  await f.delegate(); await until(() => f.summaries === 1);
  const amended = f.p.answer("append-in-publish-gap", "amendment");
  await until(async () => (await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "amendment"), context))?.status === "queued");
  report.release(); await until(() => f.queryStarted);
  const before = await f.saved(); if (before.version !== 2) throw new Error("expected current report version");
  const old = await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, `personal-report:${before.taskId}:0`), context);
  assert.equal(old?.status, "done"); assert.ok(old?.answer); assert.equal(before.publication, undefined);
  query.release(); await amended; await f.p.harness.waitForTask(before.taskId, context);
  const after = await f.saved(); if (after.version !== 2) throw new Error("expected current report version");
  assert.equal(after.taskId, before.taskId); assert.equal(after.attempts.length, 2); assert.ok(after.attempts[0].superseded);
  assert.equal((await f.result()).text, "UPDATED_REPORT");
  const oldAnswer = await f.p.harness.commit(tx => tx.entry(old!.answer!), context);
  assert.equal(oldAnswer!.model?.[0]?.role, "assistant");
  assert.equal(oldAnswer!.model?.[0]?.role === "assistant" ? oldAnswer!.model[0].content.filter(part => part.type === "text").map(part => part.text).join("") : undefined, "ORIGINAL_REPORT");
  await f.p.close(); await f.open(); assert.equal((await f.result()).text, "UPDATED_REPORT");
});




test("report publication: a terminal callback fault is retained and a later admitted work creates a successor", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const subscribe = f.p.harness.subscribeCommits.bind(f.p.harness);
  f.p.harness.subscribeCommits = () => { throw new Error("fixture report wait subscription failed"); };
  try { await f.delegate(); } finally { f.p.harness.subscribeCommits = subscribe; }
  const failed = await f.saved();
  const receipt = await f.p.harness.waitForTask(failed.taskId, context); assert.equal(receipt.state.outcome.status, "faulted");
  await f.p.answer("status-query", "query-after-fault"); assert.equal(f.summaries, 0); assert.equal((await f.saved()).taskId, failed.taskId);
  await f.p.answer("new-member", "work-after-fault");
  const next = await f.saved(); assert.notEqual(next.taskId, failed.taskId); await f.p.harness.waitForTask(next.taskId, context);
  assert.equal(f.summaries, 1); assert.equal((await f.result()).text, "ORIGINAL_REPORT");
  const value = (await f.p.harness.snapshot(PersonalDelegationDoc, String(f.ref.entryId), context))!.delegation!;
  assert.equal(value.reports![0].taskId, failed.taskId); assert.equal(value.reports![0].delivery, "unanswered");
  assert.equal((await f.p.harness.getTask(failed.taskId, context))!.state.status, "terminal");
  await f.p.close(); await f.open(); assert.equal((await f.result()).text, "ORIGINAL_REPORT");
});


test("report publication: omitted actual request report identity cannot expose a raw draft on reopen", { timeout: 30_000 }, async t => {
  const f = await fixture(t); await f.delegate(); const saved = await f.saved(); await f.p.harness.waitForTask(saved.taskId, context);
  await f.p.close();
  const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
  const entries = db.prepare("SELECT id, record FROM entries").all() as { id: number; record: string }[];
  let changed = 0;
  for (const row of entries) {
    const entry = JSON.parse(row.record) as { kind: string; data?: { references?: { report?: unknown } } };
    if (entry.kind !== "ruukoto.model-request" || entry.data?.references?.report === undefined) continue;
    delete entry.data.references.report;
    db.prepare("UPDATE entries SET record = ? WHERE id = ?").run(JSON.stringify(entry), row.id); changed++;
  }
  db.close(); assert.ok(changed > 0);
  await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "report_record_invalid");
});


test("report publication: omitted references in an earlier report tool round reject recovery", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { reportQuery: true }); await f.delegate(); const saved = await f.saved(); await f.p.harness.waitForTask(saved.taskId, context);
  await f.p.close();
  const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
  const entries = db.prepare("SELECT id, record FROM entries ORDER BY id").all() as { id: number; record: string }[];
  let generation: number | undefined, count = 0;
  for (const row of entries) {
    const entry = JSON.parse(row.record) as { kind: string; data?: { references?: { generation?: number; report?: unknown } } };
    if (entry.kind !== "ruukoto.model-request" || entry.data?.references?.report === undefined) continue;
    generation ??= entry.data.references.generation;
    if (entry.data.references.generation !== generation) continue;
    delete entry.data.references.report;
    db.prepare("UPDATE entries SET record = ? WHERE id = ?").run(JSON.stringify(entry), row.id); count++;
  }
  db.close(); assert.ok(count > 0); assert.equal(f.summaries, 2);
  await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "report_record_invalid");
});

test("report publication: malformed actual request identity cannot bypass recovery", { timeout: 30_000 }, async t => {
  for (const mutation of ["generation", "references", "messages", "conversation", "other_generation", "empty_messages", "no_system", "null_data", "missing_data"] as const) await t.test(mutation, async t => {
    const f = await fixture(t); await f.delegate(); const saved = await f.saved(); await f.p.harness.waitForTask(saved.taskId, context);
    const member = (await f.p.harness.snapshot(PersonalDelegationDoc, String(f.ref.entryId), context))!.delegation!.members[0];
    await f.p.close();
    const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
    const rows = db.prepare("SELECT id, record FROM entries").all() as { id: number; record: string }[];
    const otherRequest = rows.map(row => JSON.parse(row.record) as { kind: string; data?: { references?: { generation?: number; report?: unknown } } }).find(entry => entry.kind === "ruukoto.model-request" && entry.data?.references?.generation !== undefined && entry.data.references.report === undefined);
    assert.ok(otherRequest?.data?.references?.generation);
    let changed = 0;
    for (const row of rows) {
      const entry = JSON.parse(row.record) as { kind: string; conversationId: number; data?: { references?: { conversationId?: number; generation?: number; report?: unknown }; input?: { messages?: { role?: string }[] } } | null };
      if (entry.kind !== "ruukoto.model-request" || entry.data?.references?.report === undefined) continue;
      if (mutation === "generation") delete entry.data.references.generation;
      if (mutation === "references") delete entry.data.references;
      if (mutation === "messages") delete entry.data.input!.messages;
      if (mutation === "conversation") { entry.conversationId = member.agentId; entry.data.references!.conversationId = member.agentId; }
      if (mutation === "other_generation") entry.data.references!.generation = otherRequest.data!.references!.generation;
      if (mutation === "empty_messages") { entry.data.input!.messages = []; delete entry.data.references!.report; }
      if (mutation === "no_system") { entry.data.input!.messages = entry.data.input!.messages!.filter(message => message.role !== "system"); delete entry.data.references!.report; }
      if (mutation === "null_data") entry.data = null;
      if (mutation === "missing_data") delete entry.data;
      db.prepare("UPDATE entries SET record = ?, conversation_id = ? WHERE id = ?").run(JSON.stringify(entry), entry.conversationId, row.id); changed++;
    }
    db.close(); assert.ok(changed > 0);
    await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "report_record_invalid");
  });
});

test("report publication: native compaction during generation retains report identity on reopen", { timeout: 30_000 }, async t => {
  const report = gate(t), f = await fixture(t, { report }); await f.delegate(); await until(() => f.summaries === 1);
  const compacted = await f.p.main.compact("Keep the original work and report source.", context);
  const receipt = await f.p.harness.waitForTask(compacted, context); assert.equal(receipt.state.outcome.status, "completed");
  report.release(); const saved = await f.saved(); await f.p.harness.waitForTask(saved.taskId, context);
  assert.equal((await f.result()).text, "ORIGINAL_REPORT"); assert.equal(f.summaries, 1);
  await f.p.close(); await f.open(); assert.equal((await f.result()).text, "ORIGINAL_REPORT");
});

test("report publication: source pause retains an authentic operation and rejects a forged blocker", { timeout: 30_000 }, async t => {
  const remote = http.createServer(request => { request.resume(); request.once("end", () => request.socket.destroy()); });
  remote.listen(0, "127.0.0.1"); await once(remote, "listening");
  t.after(async () => { remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); });
  const address = remote.address(); assert.ok(address && typeof address !== "string");
  let injected = false;
  const f = await fixture(t, { unknownUrl: `http://127.0.0.1:${address.port}/accepted-post`, onReportPayload: async p => {
    if (injected) return; injected = true;
    await p.work.delegate({ requestId: "source-operation", sourceRequestId: "owner", content: "make-source-unknown" });
    await until(() => p.harness.commit(async tx => (await toolOperations(tx)).some(operation => operation.effect === "effect_unknown" && operation.code !== "started"), context));
  } });
  await f.p.harness.commit(async tx => { const value = await tx.doc(PersonalPermissionsDoc); value.mode = "full_access"; value.version++; }, context);
  await f.delegate();
  await until(async () => { const saved = await f.saved(); return saved.version === 2 && saved.pauses.length > 0; });
  const saved = await f.saved(); if (saved.version !== 2) throw new Error("expected current report version");
  assert.equal(saved.publication, undefined); assert.equal(f.summaries, 0);
  await f.p.close(); await f.open(); await f.p.close();
  const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
  const row = db.prepare("SELECT record FROM entries WHERE id = ?").get(saved.pauses[0]) as { record: string };
  const pause = JSON.parse(row.record) as { data: { reason: string; blocker: unknown } };
  assert.equal(pause.data.reason, "source_paused"); pause.data.blocker = { tool: "987654", admission: 987655 };
  db.prepare("UPDATE entries SET record = ? WHERE id = ?").run(JSON.stringify(pause), saved.pauses[0]); db.close();
  await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "report_record_invalid");
});

test("report publication: a started send keeps its original identity through successor work", { timeout: 30_000 }, async t => {
  for (const delivery of ["sent", "effect_unknown"] as const) await t.test(delivery, async t => {
    const sending = gate(t), sends: Record<string, unknown>[] = [];
    let firstStarted = false;
    const bot = http.createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; sends.push(body);
      if (body.text === "ORIGINAL_REPORT") { firstStarted = true; await sending.promise; if (delivery === "effect_unknown") { request.socket.destroy(); return; } }
      response.end(JSON.stringify({ ok: true, result: { message_id: 1000 + sends.length, chat: { id: 456, type: "private" } } }));
    });
    bot.listen(0, "127.0.0.1"); await once(bot, "listening");
    t.after(async () => { bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); });
    const address = bot.address(); assert.ok(address && typeof address !== "string");
    const tokenEnv = "RUUKOTO_PUBLICATION_BOT_KEY", token = "123:publication-test-only", previous = process.env[tokenEnv]; process.env[tokenEnv] = token;
    t.after(() => { if (previous === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previous; });
    const telegram: PersonalTelegramConfig = { version: 1, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv, tokenDigest: createHash("sha256").update(token).digest("hex"), botId: "123", ownerId: "456", boundary: 10 };
    const update = (id: number, text: string): TelegramUpdate => ({ update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text } });
    const f = await fixture(t, { telegram }); await f.receive(update(11, "delegate")); await until(() => firstStarted);
    const original = await f.saved(); if (original.version !== 2) throw new Error("expected current report version");
    assert.equal(original.delivery, "sending"); assert.ok(original.publication); assert.ok(original.answer);
    await f.receive(update(12, "new-member"));
    const next = await f.saved(); assert.notEqual(next.taskId, original.taskId); await f.p.harness.waitForTask(next.taskId, context);
    const before = (await f.p.harness.snapshot(PersonalDelegationDoc, String(f.ref.entryId), context))!.delegation!.reports![0];
    assert.equal(before.taskId, original.taskId); assert.equal(before.delivery, "sending"); assert.equal(before.answer, original.answer);
    assert.equal(before.version === 2 ? before.publication : undefined, original.publication); assert.deepEqual(before.source, original.source);
    const firstSend = sends.filter(send => send.text === "ORIGINAL_REPORT"); assert.equal(firstSend.length, 1); assert.equal(firstSend[0].chat_id, "456"); assert.deepEqual(firstSend[0].reply_parameters, { message_id: 11, allow_sending_without_reply: true });
    sending.release(); await f.p.harness.waitForTask(original.taskId, context);
    const after = (await f.p.harness.snapshot(PersonalDelegationDoc, String(f.ref.entryId), context))!.delegation!.reports![0];
    assert.equal(after.taskId, original.taskId); assert.equal(after.delivery, delivery); assert.equal(after.answer, original.answer); assert.equal(after.reply, "ORIGINAL_REPORT");
    assert.equal((await f.result()).text, "UPDATED_REPORT"); assert.equal((await f.result()).delivery, "sent");
    await f.p.close(); await f.open();
    const recovered = (await f.p.harness.snapshot(PersonalDelegationDoc, String(f.ref.entryId), context))!.delegation!.reports![0];
    assert.equal(recovered.taskId, original.taskId); assert.equal(recovered.delivery, delivery); assert.equal(sends.filter(send => send.text === "ORIGINAL_REPORT").length, 1); assert.equal(sends.filter(send => send.text === "UPDATED_REPORT").length, 1);
  });
});

test("report publication: an owner amendment accepted during request preparation prevents the old answer from publishing", { timeout: 30_000 }, async t => {
  const query = gate(t);
  let amended: ReturnType<PersonalHarness["submit"]> | undefined;
  const f = await fixture(t, { query, onReportPayload: async p => { amended ??= p.submit("append-in-publish-gap", "prepare-amendment"); await amended; } });
  await f.delegate(); await until(() => amended !== undefined); await until(() => f.queryStarted);
  const before = await f.saved(); if (before.version !== 2) throw new Error("expected current report version");
  const queued = await amended!; assert.equal((await queued.status(context)).status, "placed");
  assert.equal(before.publication, undefined); assert.equal(f.summaries, 1);
  const original = await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, `personal-report:${before.taskId}:0`), context);
  assert.equal(original?.status, "done"); assert.ok(original?.answer); assert.equal(before.attempts[0].superseded, undefined);
  query.release(); await queued.wait(context); await f.p.harness.waitForTask(before.taskId, context);
  const after = await f.saved(); if (after.version !== 2) throw new Error("expected current report version");
  assert.equal(after.taskId, before.taskId); assert.ok(after.attempts[0].superseded); assert.equal(after.attempts[0].answer, original.answer); assert.equal(after.attempts.length, 2);
  assert.equal((await f.result()).text, "UPDATED_REPORT");
  await f.p.close(); await f.open(); assert.equal((await f.result()).text, "UPDATED_REPORT");
});

test("report publication: a canceled native streaming partial stays inspectable without publishing on reopen", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { streamReport: true }); await f.delegate();
  await until(async () => ((await f.p.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.generation?.message?.content.length ?? 0) > 0);
  const saved = await f.saved();
  await f.p.harness.commit(tx => cancelPersonalDelegation(tx, f.ref), context);
  await f.p.harness.waitForTask(saved.taskId, context);
  assert.equal((await f.result()).delivery, "canceled"); assert.equal((await f.result()).text, undefined);
  await f.p.close(); await f.open();
  assert.equal((await f.result()).delivery, "canceled"); assert.equal((await f.result()).text, undefined);
  const entries = (await f.p.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  assert.ok(entries.some(entry => entry.kind === "pi.assistant" && entry.model?.[0]?.role === "assistant" && entry.model[0].stopReason === "aborted" && entry.model[0].content.some(part => part.type === "text" && part.text.includes("UNPUBLISHED_PARTIAL"))));
  const timeline = await f.p.harness.commit(tx => personalTimeline(tx, {}), context);
  assert.ok(timeline.items.every(item => !item.text.includes("UNPUBLISHED_PARTIAL")));
});
