import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord";
import { AgentDoc, ROOT_CONVERSATION_ID, type EntryId } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { personalTimeline } from "../apps/ruukoto/src/personal-history.ts";
import { PersonalOutputsDoc, personalOutputChunk, personalOutputIntent } from "../apps/ruukoto/src/personal-outputs.ts";
import { personalPublishedOutput } from "../apps/ruukoto/src/personal-report.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { appendPersonalWork, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { capturePersonalScheduleScope, verifyPersonalScheduleScope } from "../apps/ruukoto/src/personal-schedule-scope.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { LocalInputDoc, personalInputDigest } from "../apps/ruukoto/src/personal-local-records.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < deadline, "Output publication timed out"); await delay(5); }
}
const code = (value: string) => (error: unknown) => error instanceof PersonalError && error.code === value;

async function fixture(t: TestContext, options: { report?: Promise<void>; afterOutput?: Promise<void>; count?: number; foreign?: string; name?: string | number; output?: () => void; reuse?: () => PersonalWorkRef | undefined } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-output-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  let outputCount = 0, reportCount = 0;
  const model = new PersonalMockModelServer(async request => {
    const last = request.messages.at(-1), text = String(last?.content);
    if (request.system?.includes("你是个人助手的子 Agent")) {
      if (last?.role === "user") { outputCount = 0; return { kind: "tool_calls", calls: [{ id: "source", name: "read_file", arguments: { path: path.join(workspace, text) } }] }; }
      const results = request.messages.filter(message => message.role === "tool").map(message => { const content = String(message.content); return content.startsWith("{") ? JSON.parse(content) as { artifact?: string; output?: number } : {}; });
      if (results.at(-1)?.artifact) outputCount = 0;
      if (outputCount < (options.count ?? 1)) {
        const artifact = options.foreign ?? results.findLast(result => result.artifact)?.artifact;
        return { kind: "tool_calls", calls: [{ id: `publish-${++outputCount}`, name: "publish_output", arguments: { name: options.name ?? `final-${outputCount}.bin`, artifact } }] };
      }
      options.output?.();
      await options.afterOutput;
      return { kind: "text", text: `DELIVERED:${text}` };
    }
    if (String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考")) { reportCount++; await options.report; return { kind: "text", text: "FINAL_REPORT" }; }
    if (last?.role === "tool") return { kind: "text", text };
    const content = text.replace(/^【本轮拥有者输入，独立于此前宿主汇总参考】\n/, "").replace(/\n【本轮拥有者输入结束】$/, "");
    const reused = options.reuse?.();
    return { kind: "tool_calls", calls: [{ id: "delegate", name: "background_work", arguments: { action: "delegate", content, ...(reused ? { agent: reused.agentId } : {}) } }] };
  });
  const apiKeyEnv = "PERSONAL_OUTPUT_TEST_KEY", previous = process.env[apiKeyEnv]; process.env[apiKeyEnv] = "test-only";
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv, contextWindow: 128000, maxTokens: 2048 };
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: randomUUID(), workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  let p: PersonalHarness | undefined;
  t.after(async () => { await p?.close(); await model.close(); if (previous === undefined) delete process.env[apiKeyEnv]; else process.env[apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  isolateSkillHome(t);
  const open = async () => p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools });
  await open();
  const timeline = () => p!.harness.commit(tx => personalTimeline(tx, {}), context);
  const publication = async () => { let result; await until(async () => { result = (await timeline()).items.find(entry => entry.outputs?.length); return !!result; }); return result! as Awaited<ReturnType<typeof timeline>>["items"][number]; };
  return { root, directory, workspace, model, open, timeline, publication, get p() { return p!; }, get reportCount() { return reportCount; } };
}

test("Final output is unavailable before validated publication and preserves exact 8MiB bytes through reopen", { timeout: 60_000 }, async t => {
  let release!: () => void; const report = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { report }), content = Buffer.alloc(8 * 1024 * 1024, 0xa5); fs.writeFileSync(path.join(f.workspace, "boundary.bin"), content);
  await f.p.answer("boundary.bin", "owner"); await until(() => f.reportCount > 0);
  const intent = (await f.p.harness.snapshot(PersonalOutputsDoc, context))!.intents[0]; assert.ok(intent);
  assert.equal((await f.timeline()).items.some(entry => entry.outputs), false);
  await assert.rejects(f.p.harness.commit(tx => personalPublishedOutput(tx, intent, intent), context), code("output_unpublished"));
  release(); const published = await f.publication(), output = published.outputs![0];
  assert.equal(output.bytes, content.length); assert.equal(output.partial, false); assert.equal(output.sha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(JSON.stringify(output).includes(f.workspace), false);
  const pages: Buffer[] = []; let offset = 0;
  do {
    const entry = await f.p.harness.commit(tx => personalPublishedOutput(tx, published.entry as EntryId, output.output as EntryId), context);
    const page = personalOutputChunk(f.directory, published.entry as EntryId, entry, offset), bytes = Buffer.from(page.base64, "base64"); pages.push(bytes);
    assert.equal(bytes.length, 128 * 1024); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024); offset = page.nextOffset ?? -1;
  } while (offset !== -1);
  assert.equal(pages.length, 64); assert.deepEqual(Buffer.concat(pages), content);
  await f.p.close(); await f.open(); assert.deepEqual((await f.publication()).outputs, published.outputs);
  assert.equal(await f.p.harness.commit(async tx => (await toolOperations(tx)).length, context), 1);
  const mainCalls = f.model.calls.filter(request => !request.system?.includes("你是个人助手的子 Agent"));
  assert.ok(mainCalls.every(request => !request.tools?.some(tool => (tool.function as { name: string }).name === "publish_output")));
  assert.ok(f.model.calls.some(request => request.tools?.some(tool => (tool.function as { name: string }).name === "publish_output")));
  const entry = await f.p.harness.commit(tx => personalOutputIntent(tx, intent), context);
  assert.throws(() => personalOutputChunk(f.directory, published.entry as EntryId, entry, 1), code("output_offset_invalid"));
  assert.throws(() => personalOutputChunk(f.workspace, published.entry as EntryId, entry, 0), code("artifact_unavailable"));
});

test("Oversized output remains visibly partial and cannot be downloaded", { timeout: 30_000 }, async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.workspace, "large.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 1));
  await f.p.answer("large.bin", "owner"); const publication = await f.publication(), output = publication.outputs![0];
  assert.equal(output.partial, true); assert.equal(output.bytes, 8 * 1024 * 1024);
  const entry = await f.p.harness.commit(tx => personalPublishedOutput(tx, publication.entry as EntryId, output.output as EntryId), context);
  assert.throws(() => personalOutputChunk(f.directory, publication.entry as EntryId, entry, 0), code("output_partial"));
  await f.p.close(); await f.open(); assert.equal((await f.publication()).outputs![0].partial, true);
});

test("Output recovery validates the same normalized arguments accepted by the SDK", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { name: 123 }); fs.writeFileSync(path.join(f.workspace, "source.bin"), "ORIGINAL");
  await f.p.answer("source.bin", "owner"); const publication = await f.publication();
  assert.equal(publication.outputs![0].name, "123"); await f.p.close(); await f.open();
  assert.deepEqual((await f.publication()).outputs, publication.outputs);
});

test("Publication bounds file metadata and rejects a ninth registration without hiding the first eight", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { count: 9, name: '"'.repeat(128) }); fs.writeFileSync(path.join(f.workspace, "small.bin"), "COMPLETE");
  await f.p.answer("small.bin", "owner"); const publication = await f.publication();
  assert.equal(publication.outputs!.length, 8); assert.equal((await f.p.harness.snapshot(PersonalOutputsDoc, context))!.intents.length, 8);
  assert.ok(publication.outputs!.every(output => output.name === '"'.repeat(128)));
  assert.ok(Buffer.byteLength(JSON.stringify(await f.timeline())) < 96 * 1024);
  assert.ok(f.model.calls.some(request => JSON.stringify(request.messages).includes("output_limit")));
});

test("Old schedules retain their original ceiling when output capability is introduced", async t => {
  const f = await fixture(t);
  await f.p.harness.commit(async tx => {
    const scope = await capturePersonalScheduleScope(tx);
    scope.extensions = scope.extensions.filter(name => name !== "personal-outputs"); scope.tools = scope.tools.filter(name => name !== "publish_output");
    await verifyPersonalScheduleScope(tx, scope);
    const widened = structuredClone(scope); widened.tools.push("unrelated_tool");
    await assert.rejects(verifyPersonalScheduleScope(tx, widened), code("schedule_scope_changed"));
  }, context);
});

test("An amendment excludes its already registered old output and publishes only the current file", { timeout: 30_000 }, async t => {
  let release!: () => void, registered = false;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { afterOutput: held, output: () => { registered = true; } });
  fs.writeFileSync(path.join(f.workspace, "before.bin"), "BEFORE"); fs.writeFileSync(path.join(f.workspace, "after.bin"), "AFTER");
  await f.p.answer("before.bin", "owner"); await until(() => registered);
  const first = (await f.p.harness.snapshot(PersonalOutputsDoc, context))!.intents[0], work = (await f.p.work.list())[0].work!;
  await f.p.harness.commit(async tx => {
    const requestId = randomUUID(), intent = await tx.doc(LocalInputDoc, requestId, personalInputDigest("after.bin", work.taskId)); intent.work = work.taskId;
    await appendPersonalWork(tx, work, { requestId, content: "after.bin", source: { kind: "local" } });
  }, context);
  release(); const publication = await f.publication(), output = publication.outputs![0];
  assert.equal(publication.outputs!.length, 1); assert.notEqual(output.output, first); assert.equal(output.sha256, createHash("sha256").update("AFTER").digest("hex"));
  await assert.rejects(f.p.harness.commit(tx => personalPublishedOutput(tx, publication.entry as EntryId, first), context), code("output_unpublished"));
  assert.equal((await f.p.harness.snapshot(PersonalOutputsDoc, context))!.intents.length, 2);
  await f.p.close(); await f.open(); assert.deepEqual((await f.publication()).outputs, publication.outputs);
});

test("A reused child cannot publish an artifact from its earlier work", { timeout: 30_000 }, async t => {
  let reused: PersonalWorkRef | undefined;
  const options = { reuse: () => reused, foreign: undefined as string | undefined }, f = await fixture(t, options);
  fs.writeFileSync(path.join(f.workspace, "first.bin"), "FIRST"); fs.writeFileSync(path.join(f.workspace, "second.bin"), "SECOND");
  await f.p.answer("first.bin", "first"); const first = await f.publication();
  const operation = await f.p.harness.commit(async tx => copyJson((await toolOperations(tx))[0]) as Awaited<ReturnType<typeof toolOperations>>[number], context);
  assert.ok(operation.artifact && operation.origin.work);
  reused = operation.origin.work.ref; options.foreign = operation.artifact.id;
  await until(async () => !(await f.p.work.list())[0].work);
  await f.p.answer("second.bin", "second");
  await until(async () => (await f.timeline()).items.filter(entry => entry.kind === "ruukoto.report-publication").length === 2);
  const second = (await f.timeline()).items.find(entry => entry.kind === "ruukoto.report-publication" && entry.entry !== first.entry)!;
  assert.equal(second.outputs, undefined); assert.equal((await f.p.harness.snapshot(PersonalOutputsDoc, context))!.intents.length, 1);
  assert.ok(f.model.calls.some(request => JSON.stringify(request.messages).includes("output_source_forbidden")));
  assert.deepEqual((await f.timeline()).items.find(entry => entry.entry === first.entry)!.outputs, first.outputs);
  await f.p.close(); await f.open();
});

// Note: See .agents/notes/implemented/testing/2026-10-24-test-suite-reduction.md
test("Output recovery rejects altered original sources, permissions and work provenance", { timeout: 60_000 }, async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.workspace, "source.bin"), "ORIGINAL");
  await f.p.answer("source.bin", "owner"); const publication = await f.publication(); await f.p.close();
  const database = path.join(f.directory, "personal.sqlite"), baseline = path.join(f.root, "baseline.sqlite"); fs.copyFileSync(database, baseline);
  const calls = f.model.calls.length;
  for (const mutation of ["source", "permission", "work", "telegram"] as const) await t.test(mutation, async () => {
    fs.copyFileSync(baseline, database);
    const db = new DatabaseSync(database), id = publication.outputs![0].output;
    const row = db.prepare("SELECT record FROM entries WHERE id = ?").get(id) as { record: string };
    const entry = JSON.parse(row.record) as { data: { origin: { source: unknown; permission: unknown; work: { permission: unknown }; telegram?: unknown } } };
    if (mutation === "source") entry.data.origin.source = { requestId: "forged-source", submissionId: 99999, entryId: 99998 };
    if (mutation === "permission") entry.data.origin.permission = { mode: "full_access", version: 999 };
    if (mutation === "work") entry.data.origin.work.permission = { mode: "full_access", version: 999 };
    if (mutation === "telegram") entry.data.origin.telegram = { platform: "telegram", ownerId: "foreign", generation: "foreign" };
    db.prepare("UPDATE entries SET record = ? WHERE id = ?").run(JSON.stringify(entry), id); db.close();
    await assert.rejects(f.open(), error => error instanceof PersonalError && ["output_record_invalid", "source_invalid"].includes(error.code));
    assert.equal(f.model.calls.length, calls);
  });
});

test("An old profile with pending work rejects output activation before history can change", async t => {
  const f = await fixture(t);
  await f.p.harness.commit(async tx => {
    const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(agent.extensions) && Array.isArray(agent.tools));
    agent.extensions = agent.extensions.filter(name => name !== "personal-outputs"); agent.tools = agent.tools.filter(name => name !== "publish_output");
    await tx.createSubmission({ conversationId: ROOT_CONVERSATION_ID, requestId: "old-pending", type: "input", status: "queued" });
  }, context);
  await f.p.close();
  const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
  const before = db.prepare("SELECT record FROM entries ORDER BY id").all();
  db.close();
  await assert.rejects(f.open(), code("outputs_cutover_pending"));
  const after = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
  assert.deepEqual(after.prepare("SELECT record FROM entries ORDER BY id").all(), before); after.close();
});
