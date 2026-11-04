import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Cursor } from "@earendil-works/pi-durable";
import { AppDataStore } from "@ruukoto/agent/app-data/store.ts";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { parsePersonalModel, personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { appDataDecide, appDataOperations, PersonalAppDataDoc } from "../apps/ruukoto/src/personal-app-data.ts";
import { mcpOperations } from "../apps/ruukoto/src/personal-mcp.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalWorkDoc, personalWorkStatus, type PersonalToolInstructions, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
type Catalog = { providers: Record<string, { api?: string; baseUrl: string; apiKey?: string; headers?: Record<string, string>; models: { id: string; api?: string; contextWindow?: number; maxTokens?: number; input?: string[] }[] }> };

test("Personal M2 real model: optional business work routes to the same child through progress, amendment, and cancellation", { skip: process.env.RUN_MODEL_CHECK !== "1" ? "Requires explicit real-model opt-in" : false, timeout: 360000 }, async t => {
  const sourceFile = process.env.RUN_PERSONAL_M2_MODELS_FILE;
  assert.ok(sourceFile && path.isAbsolute(sourceFile), "Set an explicit absolute RUN_PERSONAL_M2_MODELS_FILE");
  let source: Buffer, catalog: Catalog;
  try { source = fs.readFileSync(sourceFile); catalog = JSON.parse(source.toString("utf8")) as Catalog; }
  catch { throw new Error("The selected models configuration could not be read or parsed."); }
  const candidates = Object.entries(catalog.providers).flatMap(([id, provider]) => provider.models.map(model => ({ id, provider, model })));
  const selected = process.env.RUN_PERSONAL_M2_MODEL ? candidates.find(value => `${value.id}/${value.model.id}` === process.env.RUN_PERSONAL_M2_MODEL) : candidates.length === 1 ? candidates[0] : undefined;
  assert.ok(selected, "Choose RUN_PERSONAL_M2_MODEL when the configuration contains several models");
  assert.ok(selected.provider.apiKey && !selected.provider.apiKey.startsWith("!") && !Object.keys(selected.provider.headers ?? {}).length, "Use existing API key authentication without credential commands");
  const credential = process.env[selected.provider.apiKey] ?? selected.provider.apiKey, credentialName = "PERSONAL_M2_ACCEPTANCE_KEY", previous = process.env[credentialName];
  process.env[credentialName] = credential;
  t.after(() => { if (previous === undefined) delete process.env[credentialName]; else process.env[credentialName] = previous; });
  const config = parsePersonalModel({ api: selected.model.api ?? selected.provider.api, baseUrl: selected.provider.baseUrl, modelId: selected.model.id, apiKeyEnv: credentialName, contextWindow: selected.model.contextWindow ?? 128000, maxTokens: Math.min(selected.model.maxTokens ?? 4096, 4096), imageInput: selected.model.input?.includes("image") ?? false });
  const base = personalProvider(config);
  let requests = 0, phase = "startup", appDataComplete = false, mcpComplete = false;
  const provider = { ...base, streamSimple: (...args: Parameters<typeof base.streamSimple>) => { if (++requests > 32) throw new PersonalError("acceptance_request_limit", "M2 acceptance exceeded its request budget."); return base.streamSimple(...args); } };
  const deadline = Date.now() + 330000;
  const wait = async (check: () => boolean | Promise<boolean>) => { while (!await check()) { assert.ok(Date.now() < deadline, `M2 acceptance did not finish during ${phase}`); await delay(50); } };
  async function fixture(t: TestContext, mcp?: ReturnType<typeof parsePersonalMcp>) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-m2-model-"))), evidenceDirectory = fs.mkdtempSync(path.join(tmpdir(), "rk-m2-model-evidence-"));
    let p: PersonalHarness;
    const open = async () => p = await openPersonalHarness({ directory, provider, modelId: config.modelId, ...(mcp ? { mcp } : {}) });
    t.after(async () => {
      try {
        if (p) {
          const file = path.join(evidenceDirectory, "entries.jsonl"); fs.writeFileSync(file, "", { mode: 0o600 });
          let conversations: Cursor | undefined;
          do { const page = await p.harness.commit(tx => tx.scanConversations({}, 256, conversations), context); for (const conversation of page.items) { let cursor: Cursor | undefined; do { const entries = await p.harness.commit(tx => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 256, cursor), context); if (entries.items.length) fs.appendFileSync(file, entries.items.map(entry => JSON.stringify(entry).replaceAll(credential, "[redacted]")).join("\n") + "\n"); cursor = entries.next; } while (cursor); } conversations = page.next; } while (conversations);
        }
        process.stdout.write(JSON.stringify({ evidenceDirectory, phase, requests }) + "\n");
      } finally { await p?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
    });
    isolateSkillHome(t); await open();
    await p!.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "confirm"; permission.version++; }, context);
    const cancel = async (ref: PersonalWorkRef) => {
      phase = "whole-assignment cancellation";
      await p.answer("取消刚才这整项后台工作及剩余步骤，不再批准或执行任何修改。请登记取消，不修改要求，也不要换子工作重试。", `m2-cancel-${ref.taskId}`);
      assert.equal((await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))?.cancelRequested, true, "The model must register cancellation of the identified assignment");
      await wait(async () => (await p.harness.commit(tx => personalWorkStatus(tx, ref), context)).stopVerified);
      const status = await p.harness.commit(tx => personalWorkStatus(tx, ref), context);
      assert.equal(status.cancelRequested, true); assert.equal(status.task.state.status, "terminal"); assert.equal(status.task.state.status === "terminal" && status.task.state.outcome.status, "aborted");
    };
    const requestContains = async (instructions: PersonalToolInstructions, text: string) => {
      const request = await p.harness.commit(tx => tx.entry(instructions.requestEntry), context);
      assert.equal(request?.kind, "ruukoto.model-request"); assert.ok(JSON.stringify(request?.data).includes(text));
      assert.ok(!JSON.stringify(request?.data).includes(credential));
    };
    const querySucceeded = async (requestId: string) => {
      const input = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId), context);
      assert.ok(input?.entry && input.type === "input" && input.status === "done");
      const entries = (await p.main.entries({ minEntryId: input.entry, maxEntryId: input.answer, order: "ascending" }, 256, undefined, context)).items;
      const results = entries.flatMap(entry => entry.model?.filter(message => message.role === "toolResult") ?? []);
      assert.ok(results.length && results.every(result => !result.isError), "Progress must read existing work facts without an invalid operation query");
    };
    return { directory, open, cancel, requestContains, querySucceeded, get p() { return p; } };
  }
  try {
    await t.test("app-data destructive approval", async t => {
      const f = await fixture(t), file = path.join(f.directory, "agent-data", "main.db");
      const store = new AppDataStore(file, { expectedInstanceId: (await f.p.harness.snapshot(PersonalAppDataDoc, context))!.instanceId });
      try { const ctx = { taskId: "seed", sessionId: "fixture", agentId: "fixture" }; store.defineTable({ table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "Prepare M2 fixture", opId: "seed-schema", ctx }); store.insert({ table: "todos", records: [{ title: "first" }, { title: "second" }], reason: "Prepare M2 rows", opId: "seed-rows", ctx }); } finally { store.close(); }
      const operations = () => f.p.harness.commit(async tx => JSON.parse(JSON.stringify(await appDataOperations(tx))) as Awaited<ReturnType<typeof appDataOperations>>, context);
      const originalText = `ORIGINAL_${randomUUID()}`, currentText = `CURRENT_${randomUUID()}`;
      phase = "app-data delegation";
      await f.p.answer(`请在后台把应用数据 todos 表中两条待办的 title 都改为完整文本 ${JSON.stringify(originalText)}。必须先查询行版本，再只用一次批量 app_data_update 同时更新两行，不能拆成单行更新，不使用文件、网络或其他能力。写完报告。`, "m2-data-initial");
      const delegated = (await f.p.work.list()).find(agent => agent.work)?.work;
      assert.ok(delegated, "The app-data owner request must delegate independent business work");
      let original: Awaited<ReturnType<typeof appDataOperations>>[number] | undefined;
      await wait(async () => { original = (await operations()).find(value => value.name === "app_data_update"); if (original?.decision === "pending") return true; assert.notEqual((await f.p.harness.getTask(delegated.taskId, context))?.state.status, "terminal", "The app-data child ended before preparing the required exact approval"); return false; });
      assert.ok(original?.origin.work); const ref = original.origin.work.ref;
      assert.equal((await f.p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))?.appData, true); assert.equal(original.started, undefined); assert.ok(JSON.stringify(original.params).includes(originalText));
      assert.ok(Array.isArray(original.params.rows)); assert.equal(original.params.rows.length, 2); assert.deepEqual(new Set(original.params.rows), new Set([{ id: 1, expected_version: 1, set: { title: originalText } }, { id: 2, expected_version: 1, set: { title: originalText } }]));
      phase = "app-data progress query";
      const notes = (await f.p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))?.notes;
      const progress = await f.p.answer("刚才那项待办批量更新进展如何，有没有待我决定的事项？这是进度查询，内容和目标都不变，不追加要求。", "m2-data-progress");
      assert.match(progress, /批准|确认|决定/); await f.querySucceeded("m2-data-progress");
      assert.deepEqual((await f.p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))?.notes, notes); assert.deepEqual((await operations()).find(value => value.operation === original!.operation), original);
      phase = "app-data amendment";
      await f.p.answer(`修改刚才同一项后台工作的要求：不要写原文本，改把 todos 的两条 title 都改为完整文本 ${JSON.stringify(currentText)}。仍只用一次批量更新两行，请准备当前准确的批量更新并由宿主给我新的批准请求，不拆分操作，批准后完成并报告。`, "m2-data-amend");
      let current: typeof original | undefined;
      await wait(async () => { current = (await operations()).find(value => value.operation !== original!.operation && value.name === "app_data_update"); if (current?.decision === "pending") return true; assert.notEqual((await f.p.harness.getTask(ref.taskId, context))?.state.status, "terminal", "The amended child ended without preparing a fresh exact host approval"); return false; });
      assert.ok(current?.instructions); assert.deepEqual(current.origin.work?.ref, ref); assert.ok(JSON.stringify(current.params).includes(currentText));
      assert.ok(Array.isArray(current.params.rows)); assert.equal(current.params.rows.length, 2); assert.deepEqual(new Set(current.params.rows), new Set([{ id: 1, expected_version: 1, set: { title: currentText } }, { id: 2, expected_version: 1, set: { title: currentText } }]));
      await f.requestContains(current.instructions, currentText);
      const work = await f.p.harness.snapshot(PersonalWorkDoc, ref.requestId, context); assert.ok(work?.notes?.some(note => note.source.kind === "input" && note.source.requestId === "m2-data-amend")); assert.ok(current.instructions.snapshot.notes.length);
      const stale = (await operations()).find(value => value.operation === original!.operation)!; assert.equal(stale.started, undefined); assert.equal(stale.decision, "pending"); assert.equal(stale.result?.effect, "not_committed"); assert.equal(stale.result?.code, "tool_requirements_changed"); assert.ok(stale.superseded); assert.deepEqual(stale.origin, original.origin);
      await assert.rejects(f.p.harness.commit(tx => appDataDecide(tx, f.directory, original!.operation, "approved"), context), error => error instanceof PersonalError && error.code === "app_data_decision_invalid");
      await f.cancel(ref);
      const canceled = await operations(); assert.equal(canceled.length, 2); assert.ok(canceled.every(value => value.started === undefined && value.result?.effect === "not_committed"));
      const read = new DatabaseSync(file, { readOnly: true }); try { assert.deepEqual(read.prepare("SELECT title FROM todos ORDER BY _id").all().map(row => row.title), ["first", "second"]); assert.equal(read.prepare("SELECT count(*) AS n FROM app_audit").get()!.n, 2); } finally { read.close(); }
      phase = "app-data reopen"; await f.p.close(); await f.open(); assert.deepEqual(await operations(), canceled); appDataComplete = true;
    });
    assert.equal(appDataComplete, true, "App-data acceptance did not complete");
    await t.test("ordinary MCP held write", async t => {
      const sent: unknown[] = [], definition = { name: "record", description: "Record exactly one value in the test service", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };
      const server = http.createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const request = JSON.parse(Buffer.concat(chunks).toString()) as { id: number | string; method: string; params?: unknown }; let result: unknown; if (request.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "M2 fixture", version: "1" } }; else if (request.method === "tools/list") result = { tools: [definition] }; else if (request.method === "tools/call") { sent.push(request.params); result = { content: [{ type: "text", text: "Recorded" }] }; } else { res.writeHead(202).end(); return; } res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result })); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
      t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
      const f = await fixture(t, parsePersonalMcp({ version: 4, generation: randomUUID(), services: [{ id: "fixture", label: "M2 test records", enabled: true, endpoint: `http://127.0.0.1:${address.port}/mcp`, tools: [definition], toolEffects: { record: "write" } }] }));
      const operations = () => f.p.harness.commit(async tx => JSON.parse(JSON.stringify(await mcpOperations(tx))) as Awaited<ReturnType<typeof mcpOperations>>, context);
      const originalText = `ORIGINAL_${randomUUID()}`, currentText = `CURRENT_${randomUUID()}`;
      phase = "MCP delegation"; await f.p.answer(`请在后台通过已配置的 fixture MCP 服务 record 工具，记录完整值 ${JSON.stringify(originalText)}，参数是 value。只调用这一次，不使用应用数据、文件或其他能力，完成后报告。`, "m2-mcp-initial");
      assert.ok((await f.p.work.list()).some(agent => agent.work), "The MCP owner request must delegate independent business work");
      let original: Awaited<ReturnType<typeof mcpOperations>>[number] | undefined;
      await wait(async () => { original = (await operations())[0]; return original?.decision === "pending"; }); assert.ok(original?.origin.work); const ref = original.origin.work.ref; assert.deepEqual(original.args, { value: originalText }); assert.equal(sent.length, 0);
      phase = "MCP amendment"; await f.p.answer(`修改刚才同一项后台记录工作的要求：不要记录原值，改为通过 fixture/record 记录完整值 ${JSON.stringify(currentText)}。请准备当前准确的那一次记录并由宿主给我新的批准请求，不换子工作，不使用其他能力。`, "m2-mcp-amend");
      let current: typeof original | undefined; await wait(async () => { current = (await operations()).find(value => value.operation !== original!.operation); if (current?.decision === "pending") return true; assert.notEqual((await f.p.harness.getTask(ref.taskId, context))?.state.status, "terminal", "The amended MCP child ended without preparing a fresh exact host approval"); return false; }); assert.ok(current?.instructions); assert.deepEqual(current.origin.work?.ref, ref); assert.deepEqual(current.args, { value: currentText }); assert.ok(current.instructions.snapshot.notes.length);
      await f.requestContains(current.instructions, currentText);
      const stale = (await operations()).find(value => value.operation === original!.operation)!; assert.equal(stale.started, false); assert.equal(stale.decision, "pending"); assert.equal(stale.effect, "not_executed"); assert.equal(stale.code, "tool_requirements_changed"); assert.ok(stale.superseded); assert.equal(sent.length, 0);
      await assert.rejects(f.p.mcp!.decide(original.operation, "approved"), error => error instanceof PersonalError && error.code === "mcp_decision_invalid");
      await f.cancel(ref); const canceled = await operations(); assert.equal(canceled.length, 2); assert.ok(canceled.every(value => !value.started && value.effect === "not_executed")); assert.equal(sent.length, 0);
      phase = "MCP reopen"; await f.p.close(); await f.open(); assert.deepEqual(await operations(), canceled); assert.equal(sent.length, 0); mcpComplete = true;
    });
    assert.equal(mcpComplete, true, "MCP acceptance did not complete");
    assert.ok(requests > 0); process.stdout.write(JSON.stringify({ status: "passed", model: `${selected.id}/${selected.model.id}`, node: process.version, platform: process.platform, sourceSha256: createHash("sha256").update(source).digest("hex"), requests, appData: true, mcp: true }) + "\n");
  } catch (error) { throw new Error(`M2 real-model acceptance failed during ${phase}: ${error instanceof Error ? error.message.replaceAll(credential, "[redacted]") : "unknown failure"}`); }
});
