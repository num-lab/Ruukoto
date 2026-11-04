import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, ROOT_CONVERSATION_ID, type EntryId, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { WebSocket } from "ws";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { personalControl, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { personalDesktopEvents } from "../apps/ruukoto/src/personal-desktop-events.ts";
import { personalTimeline, readPersonalHistory } from "../apps/ruukoto/src/personal-history.ts";
import { PersonalDelegationDoc, listPersonalDelegations } from "../apps/ruukoto/src/personal-delegation.ts";
import type { PersonalDesktopFrame, PersonalTimelineEntry } from "@ruukoto/view/personal-protocol.ts";
import { PersonalMockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
const child = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent") === true;
const summary = (request: RecordedRequest) => String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考");
const args = (action: string, values: Record<string, unknown> = {}) => JSON.stringify({ action, ...values });
function gate(t: TestContext) {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  return { promise, release };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < deadline, "Report projection did not reach its expected boundary"); await delay(5); }
}
function entries(frames: PersonalDesktopFrame[]): PersonalTimelineEntry[] {
  return frames.flatMap(frame => frame.type === "snapshot" ? frame.timeline.items : frame.events.flatMap(event => event.type === "message_end" || event.type === "entry_appended" ? [event.entry] : []));
}
async function fixture(t: TestContext, respond: Responder, openStorage?: (filename: string) => Promise<Storage>) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-report-projection-")), directory = path.join(root, "profile"), socketPath = path.join(root, "events.sock");
  const model = new PersonalMockModelServer((request, index) => {
    if (child(request) || summary(request)) return respond(request, index);
    const last = request.messages.at(-1), content = String(last?.content).replace(/^【本轮拥有者输入，独立于此前宿主汇总参考】\n/, "").replace(/\n【本轮拥有者输入结束】$/, "");
    if (last?.role === "tool") return { kind: "text", text: String(last.content) };
    if (content.startsWith("{")) return { kind: "tool_calls", calls: [{ id: "arrangement", name: "background_work", arguments: JSON.parse(content) as Record<string, unknown> }] };
    return { kind: "text", text: `Ordinary: ${content}` };
  });
  const apiKeyEnv = "PERSONAL_REPORT_PROJECTION_KEY", previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "test-only";
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv, contextWindow: 128000, maxTokens: 8192 };
  const provider = personalProvider(config);
  let p: PersonalHarness | undefined, server: http.Server | undefined, events: ReturnType<typeof personalDesktopEvents> | undefined;
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    await events?.close();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await p?.close(); await model.close();
    if (previous === undefined) delete process.env[apiKeyEnv]; else process.env[apiKeyEnv] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  isolateSkillHome(t);
  p = await openPersonalHarness({ directory, provider, modelId: config.modelId, openStorage });
  server = http.createServer();
  const token = "test-token";
  events = personalDesktopEvents(server, p.harness, token, randomUUID());
  server.listen(socketPath); await once(server, "listening");
  const connect = async () => {
    const client = new WebSocket(`ws+unix:${socketPath}:/events`, { headers: { authorization: `Bearer ${token}` } }), frames: PersonalDesktopFrame[] = [];
    clients.push(client);
    client.on("message", data => { frames.push(JSON.parse(data.toString()) as PersonalDesktopFrame); });
    await once(client, "open"); await until(() => frames.length > 0);
    return { client, frames };
  };
  const group = async () => { const value = (await p!.harness.commit(tx => listPersonalDelegations(tx), context)).items[0]; assert.ok(value, "The owner delegate call must accept its work and automatic report before projection checks"); return value.ref; };
  const saved = async () => (await p!.harness.snapshot(PersonalDelegationDoc, String((await group()).entryId), context))!.delegation!;
  return { p, provider, model, directory, config, connect, group, saved };
}

test("Report projection: v2 drafts stay inspectable while WebSocket and reconnect expose only publication", { timeout: 30_000 }, async t => {
  const analyzing = gate(t), generating = gate(t), publication = gate(t);
  let generated = false, publishing = false;
  let delegationId: number;
  const reportPrefix = "VALIDATED_REPORT_BODY", reportText = reportPrefix + "x".repeat(4095 - reportPrefix.length) + "🙂" + reportPrefix.repeat(50);
  const f = await fixture(t, async request => {
    if (child(request)) { await analyzing.promise; return { kind: "text", text: "Child result" }; }
    if (request.messages.at(-1)?.role !== "tool") return { kind: "tool_calls", calls: [{ id: "report-progress", name: "background_work", arguments: { action: "progress", delegation: delegationId } }] };
    generated = true;
    await generating.promise;
    return { kind: "text", text: reportText };
  }, async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = async (writes, ctx) => {
      if (!publishing && writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.report-publication")) {
        publishing = true;
        await publication.promise;
      }
      return commit(writes, ctx);
    };
    return storage;
  });
  const live = await f.connect();
  await f.p.answer(args("delegate", { content: "Report work" }), "owner");
  const group = await f.group();
  delegationId = group.entryId;
  await f.p.answer(args("report", { delegation: group.entryId }), "report-arrangement");
  assert.equal(await f.p.answer("chat while child waits", "chat"), "Ordinary: chat while child waits");
  analyzing.release();
  await until(() => generated);
  const before = await f.connect();
  const snapshot = before.frames[0];
  assert.ok(snapshot.type === "snapshot");
  assert.ok(snapshot.live.run);
  assert.equal(snapshot.live.generation, undefined);
  assert.equal(snapshot.live.tools.length, 0);
  assert.doesNotMatch(JSON.stringify(before.frames), /宿主委托汇总参考|VALIDATED_REPORT_BODY/);
  generating.release();
  await until(() => publishing);
  assert.doesNotMatch(JSON.stringify(live.frames), /宿主委托汇总参考|VALIDATED_REPORT_BODY/);
  assert.equal(live.frames.some(frame => frame.type === "events" && frame.events.some(event => "toolCallId" in event && event.toolCallId === "report-progress")), false);
  assert.equal(entries(live.frames).some(entry => entry.kind === "ruukoto.report-publication"), false);
  publication.release();
  const saved = await f.saved();
  await f.p.harness.waitForTask(saved.report!.taskId, context);
  await until(() => entries(live.frames).some(entry => entry.kind === "ruukoto.report-publication"));
  const published = entries(live.frames).filter(entry => entry.kind === "ruukoto.report-publication");
  assert.equal(published.length, 1);
  assert.equal(published[0].text, reportText.slice(0, 4096));
  assert.equal(published[0].truncated, true);
  const all = await f.p.harness.commit(tx => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 256), context);
  const prompt = all.items.find(entry => entry.kind === "ruukoto.delegation-report")!;
  const draft = all.items.find(entry => entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes(reportText))!;
  assert.notEqual(draft.id, published[0].entry);
  assert.equal((await f.p.harness.commit(tx => readPersonalHistory(tx, ROOT_CONVERSATION_ID, { entry: draft.id }), context)).text, reportText.slice(0, 4096));
  let body = "", offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = await f.p.harness.commit(tx => readPersonalHistory(tx, ROOT_CONVERSATION_ID, { entry: published[0].entry as EntryId, offset }), context);
    body += page.text; offset = page.nextOffset;
  }
  assert.equal(body, reportText);
  const heldTimeline = await f.p.harness.commit(tx => personalTimeline(tx, { through: Number(published[0].entry) - 1 }), context);
  assert.equal(heldTimeline.items.some(entry => entry.entry === draft.id || entry.entry === prompt.id || entry.kind === "ruukoto.report-publication"), false);
  const replay = await f.connect();
  assert.equal(entries(replay.frames).filter(entry => entry.kind === "ruukoto.report-publication").length, 1);
  assert.equal(entries(replay.frames).some(entry => entry.entry === draft.id || entry.entry === prompt.id), false);
  assert.equal(await f.p.answer("ordinary after publication", "after"), "Ordinary: ordinary after publication");
  await until(() => entries(live.frames).some(entry => entry.text === "Ordinary: ordinary after publication"));
  const reportSubmissions = live.frames.flatMap(frame => frame.type === "events" ? frame.events.filter(event => event.type === "submission" && event.record.entry === prompt.id) : []);
  assert.ok(reportSubmissions.length > 0);
  assert.ok(reportSubmissions.every(event => event.type === "submission" && event.record.answer === undefined));
  await f.p.close();
  await savePersonalConfig(f.directory, f.config);
  const backend = await startPersonalServer(f.directory);
  try {
    let routeBody = "", next: number | undefined = 0;
    while (next !== undefined) {
      const page: { text: string; nextOffset?: number } = await personalControl(f.directory, "GET", `/history/entry?entry=${published[0].entry}&offset=${next}`);
      routeBody += page.text;
      if (next === 0) { assert.equal(page.nextOffset, 4095); assert.equal(page.text.endsWith("x"), true); }
      next = page.nextOffset;
    }
    assert.equal(routeBody, reportText);
  } finally { await backend.stop(); }
});

test("Report projection: an owner amendment queued during generation keeps the stale answer out of every display", { timeout: 30_000 }, async t => {
  const analyzing = gate(t), firstSummary = gate(t);
  let summaries = 0, firstStarted = false;
  const f = await fixture(t, async request => {
    if (child(request)) {
      if (String(request.messages.at(-1)?.content) === "Initial child") await analyzing.promise;
      return { kind: "text", text: String(request.messages.at(-1)?.content) };
    }
    summaries++;
    if (summaries === 1) { firstStarted = true; await firstSummary.promise; return { kind: "text", text: "STALE_DRAFT_TO_RETAIN" }; }
    return { kind: "text", text: "CURRENT_PUBLISHED_RESULT" };
  });
  const live = await f.connect();
  await f.p.answer(args("delegate", { content: "Initial child" }), "owner");
  const group = await f.group();
  await f.p.answer(args("report", { delegation: group.entryId }), "arranged");
  analyzing.release();
  await until(() => firstStarted);
  const previous = (await f.saved()).members[0];
  const amendment = await f.p.submit(args("append", { work: previous.taskId, content: "Changed child requirements" }), "amendment");
  const received = await f.connect();
  assert.doesNotMatch(JSON.stringify(received.frames), /宿主委托汇总参考|STALE_DRAFT_TO_RETAIN/);
  firstSummary.release();
  const accepted = await amendment.wait(context);
  assert.equal(accepted.status, "done");
  await until(async () => (await f.p.harness.commit(tx => personalTimeline(tx, {}), context)).items.some(entry => entry.kind === "ruukoto.report-publication" && entry.text === "CURRENT_PUBLISHED_RESULT"));
  await until(() => entries(live.frames).some(entry => entry.kind === "ruukoto.report-publication" && entry.text === "CURRENT_PUBLISHED_RESULT"));
  assert.doesNotMatch(JSON.stringify(live.frames), /STALE_DRAFT_TO_RETAIN|宿主委托汇总参考/);
  assert.equal(entries(live.frames).filter(entry => entry.kind === "ruukoto.report-publication").length, 1);
  const raw = await f.p.harness.commit(tx => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 256), context);
  const stale = raw.items.find(entry => entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("STALE_DRAFT_TO_RETAIN"));
  assert.ok(stale, "Superseded generation remains in the authoritative history");
  assert.equal((await f.p.harness.commit(tx => readPersonalHistory(tx, ROOT_CONVERSATION_ID, { entry: stale.id }), context)).text, "STALE_DRAFT_TO_RETAIN");
  const reopened = await f.connect();
  assert.doesNotMatch(JSON.stringify(reopened.frames), /STALE_DRAFT_TO_RETAIN|宿主委托汇总参考/);
  assert.equal(entries(reopened.frames).filter(entry => entry.kind === "ruukoto.report-publication").length, 1);
});
test("Report projection: publication during asynchronous WebSocket attachment appears once without its draft", { timeout: 30_000 }, async t => {
  const analyzing = gate(t), generating = gate(t), attached = gate(t), release = gate(t);
  let summaryStarted = false;
  const f = await fixture(t, async request => {
    if (child(request)) { await analyzing.promise; return { kind: "text", text: "Result" }; }
    summaryStarted = true;
    await generating.promise;
    return { kind: "text", text: "BOUNDARY_PUBLICATION" };
  });
  await f.p.answer(args("delegate", { content: "Boundary child" }), "owner");
  const group = await f.group();
  await f.p.answer(args("report", { delegation: group.entryId }), "arranged");
  analyzing.release();
  await until(() => summaryStarted);
  const original = f.p.harness.commit.bind(f.p.harness);
  let captured = false;
  f.p.harness.commit = async (fn, ctx) => {
    const result = await original(fn, ctx);
    if (!captured && result && typeof result === "object" && "timeline" in result && "reportDraft" in result) {
      captured = true;
      attached.release();
      await release.promise;
    }
    return result;
  };
  const connecting = f.connect();
  await attached.promise;
  generating.release();
  const task = (await f.saved()).report!.taskId;
  await f.p.harness.waitForTask(task, context);
  release.release();
  const connected = await connecting;
  f.p.harness.commit = original;
  await until(() => entries(connected.frames).some(entry => entry.kind === "ruukoto.report-publication"));
  assert.equal(entries(connected.frames).filter(entry => entry.kind === "ruukoto.report-publication").length, 1);
  assert.equal(entries(connected.frames).filter(entry => entry.text === "BOUNDARY_PUBLICATION").length, 1);
  assert.doesNotMatch(JSON.stringify(connected.frames), /宿主委托汇总参考/);
  assert.ok(connected.frames.every((frame, index) => frame.seq === index));
});
test("Report projection: a held streamed v2 answer is absent from a reconnect snapshot", { timeout: 30_000 }, async t => {
  const analyzing = gate(t), entered = gate(t), response = gate(t);
  const f = await fixture(t, async request => {
    if (child(request)) { await analyzing.promise; return { kind: "text", text: "Result" }; }
    return { kind: "text", text: "HIDDEN_STREAMED_REPORT", chunkDelayMs: 100 };
  });
  const original = f.provider.streamSimple.bind(f.provider);
  f.provider.streamSimple = (model, input, options) => {
    const stream = original(model, input, options);
    const isSummary = JSON.stringify(input.messages.findLast(message => message.role === "user")).includes("宿主委托汇总参考");
    if (!isSummary) return stream;
    const push = stream.push.bind(stream), end = stream.end.bind(stream);
    let holding = false;
    stream.push = event => {
      if (event.type === "done") {
        holding = true;
        entered.release();
        void response.promise.then(() => { push(event); end(); });
      } else push(event);
    };
    stream.end = result => { if (!holding) end(result); };
    return stream;
  };
  const live = await f.connect();
  await f.p.answer(args("delegate", { content: "Streamed child" }), "owner");
  const group = await f.group();
  await f.p.answer(args("report", { delegation: group.entryId }), "arranged");
  analyzing.release();
  await entered.promise;
  await until(async () => JSON.stringify((await f.p.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.generation?.message).includes("HIDDEN_STREAMED_REPORT"));
  const connected = await f.connect(), snapshot = connected.frames[0];
  assert.ok(snapshot.type === "snapshot" && snapshot.live.run);
  assert.equal(snapshot.live.generation, undefined);
  assert.deepEqual(snapshot.live.tools, []);
  assert.doesNotMatch(JSON.stringify(live.frames), /HIDDEN_STREAMED_REPORT|宿主委托汇总参考/);
  assert.doesNotMatch(JSON.stringify(connected.frames), /HIDDEN_STREAMED_REPORT|宿主委托汇总参考/);
  response.release();
  await f.p.harness.waitForTask((await f.saved()).report!.taskId, context);
  await until(() => entries(live.frames).some(entry => entry.kind === "ruukoto.report-publication"));
  assert.equal(entries(live.frames).filter(entry => entry.text === "HIDDEN_STREAMED_REPORT").length, 1);
});
test("Report projection: old v1 report input and answers retain their existing timeline behavior", async t => {
  const f = await fixture(t, () => ({ kind: "text", text: "unused" }));
  const raw = await f.p.harness.commit(async tx => {
    const input = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.delegation-report", data: { delegation: 1, taskId: 1, attempt: 0 }, model: [{ role: "user", content: "LEGACY_REPORT_REFERENCE", timestamp: 1 }] });
    const answer = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "LEGACY_PUBLISHED_ANSWER" }], api: "openai-completions", provider: "personal", model: "unused", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 }] });
    return { input, answer };
  }, context);
  const result = await f.p.harness.commit(tx => personalTimeline(tx, {}), context);
  assert.equal(result.items.find(entry => entry.entry === raw.input.id)?.text, "LEGACY_REPORT_REFERENCE");
  assert.equal(result.items.find(entry => entry.entry === raw.answer.id)?.text, "LEGACY_PUBLISHED_ANSWER");
});
test("Report projection: malformed v2 report references fail closed during timeline and WebSocket attachment", { timeout: 15_000 }, async t => {
  const f = await fixture(t, () => ({ kind: "text", text: "unused" }));
  await f.p.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.delegation-report", data: { version: 2, delegation: 1, taskId: 1, attempt: 0, coverage: 1 }, model: [{ role: "user", content: "UNVERIFIED_INTERNAL_REPORT", timestamp: 1 }] }), context);
  await assert.rejects(f.p.harness.commit(tx => personalTimeline(tx, {}), context));
  await assert.rejects(f.connect());
});
test("Report projection: an owner message identical to old report content remains ordinary visible chat", { timeout: 30_000 }, async t => {
  const analyzing = gate(t);
  let summaryText = "";
  const f = await fixture(t, async request => {
    if (child(request)) { await analyzing.promise; return { kind: "text", text: "Result" }; }
    summaryText = String(request.messages.findLast(message => message.role === "user")?.content);
    return { kind: "text", text: "IDENTICAL_CONTENT_RESPONSE" };
  });
  await f.p.answer(args("delegate", { content: "Same text test" }), "owner");
  const group = await f.group();
  await f.p.answer(args("report", { delegation: group.entryId }), "arranged");
  analyzing.release();
  await f.p.harness.waitForTask((await f.saved()).report!.taskId, context);
  assert.ok(summaryText);
  const live = await f.connect();
  assert.equal(await f.p.answer(summaryText, "owner-identical-report-content"), "IDENTICAL_CONTENT_RESPONSE");
  const original = await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "owner-identical-report-content"), context);
  assert.ok(original?.type === "input" && original.status === "done");
  await until(() => entries(live.frames).some(entry => entry.entry === original.answer));
  const current = await f.p.harness.commit(tx => personalTimeline(tx, {}), context);
  assert.equal(current.items.find(entry => entry.entry === original.answer)?.text, "IDENTICAL_CONTENT_RESPONSE");
  assert.equal(current.items.find(entry => entry.entry === original.entry)?.role, "user");
});
