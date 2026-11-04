import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AppDataStore } from "@ruukoto/agent/app-data/store.ts";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalAppDataDoc, appDataOperations } from "../apps/ruukoto/src/personal-app-data.ts";
import { mcpOperations } from "../apps/ruukoto/src/personal-mcp.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalWorkDoc, personalWorkExecutionFacts, personalWorkResult, personalWorkSummary, type PersonalWorkResult } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
async function until(check: () => Promise<boolean>, diagnostic?: () => Promise<string>) {
  const deadline = Date.now() + 45000;
  while (!await check()) { if (Date.now() >= deadline) assert.fail(diagnostic ? await diagnostic() : "Work facts did not settle"); await delay(5); }
}

async function fixture(t: TestContext, unknown: boolean) {
  isolateSkillHome(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-work-facts-"))), directory = path.join(root, "profile"), workspace = path.join(root, "work");
  fs.mkdirSync(workspace); const target = path.join(workspace, "original.txt"); fs.writeFileSync(target, "Original file content");
  const definitions = ["read", "write"].map(name => ({ name, description: `${name} one fixture value`, inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }));
  const sent: string[] = [];
  const remote = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const call = JSON.parse(Buffer.concat(chunks).toString()) as { id: number | string; method: string; params?: { name: string } };
    let result: unknown;
    if (call.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "facts-fixture", version: "1" } };
    else if (call.method === "tools/list") result = { tools: definitions };
    else if (call.method === "tools/call") { sent.push(call.params!.name); if (unknown && call.params!.name === "write") return; result = { content: [{ type: "text", text: "Remote call returned" }] }; }
    else { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve)); const address = remote.address(); assert.ok(address && typeof address !== "string");
  const answer = "Saved answer ".repeat(700), batches = [
    ...Array.from({ length: 3 }, (_unused, batch) => Array.from({ length: batch === 2 ? 1 : 8 }, (_value, i) => ({ id: `insert-${batch * 8 + i}`, name: "app_data_insert", arguments: { table: "todos", records: [{ title: `row-${batch * 8 + i}` }], expected_schema_version: 1, reason: "Create work fact" } }))),
    ...Array.from({ length: 2 }, (_unused, batch) => Array.from({ length: batch === 1 ? 1 : 8 }, (_value, i) => ({ id: `read-${batch * 8 + i}`, name: "read_file", arguments: { path: target } }))),
    ...Array.from({ length: 2 }, (_unused, batch) => Array.from({ length: 8 }, (_value, i) => ({ id: `mcp-${batch * 8 + i}`, name: "mcp_call", arguments: { service: "fixture", tool: "read", arguments: { value: `read-${batch * 8 + i}` } } }))),
    [{ id: "held-write", name: "mcp_call", arguments: { service: "fixture", tool: "write", arguments: { value: "Unknown original write" } } }],
  ];
  let batch = 0;
  const model = new PersonalMockModelServer(request => {
    if (request.system?.includes("你是个人助手的子 Agent")) return batches[batch] ? { kind: "tool_calls", calls: batches[batch++] } : { kind: "text", text: answer };
    const last = request.messages.at(-1), text = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text };
    if (text === "delegate") return { kind: "tool_calls", calls: [{ id: "delegate", name: "background_work", arguments: { action: "delegate", content: "Create work facts", appData: true } }] };
    if (text.startsWith("query:")) return { kind: "tool_calls", calls: [{ id: "query", name: "background_work", arguments: JSON.parse(text.slice(6)) as Record<string, unknown> }] };
    return { kind: "text", text: "Main remains responsive" };
  });
  const credential = "RUUKOTO_WORK_FACTS_TEST_KEY", previous = process.env[credential]; process.env[credential] = "test-only";
  const provider = personalProvider({ api: "openai-completions", baseUrl: await model.start(), modelId: "facts-model", apiKeyEnv: credential, contextWindow: 128000, maxTokens: 8192 });
  const identity = fs.statSync(workspace), options = { directory, provider, modelId: "facts-model", tools: parsePersonalTools({ version: 1, generation: "facts-tools", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] }), mcp: parsePersonalMcp({ version: 4, generation: "facts-mcp", services: [{ id: "fixture", label: "Fixture", enabled: true, endpoint: `http://127.0.0.1:${address.port}/mcp`, tools: definitions, toolEffects: { read: "read", write: "write" } }] }), mcpTimeouts: { connectTimeoutMs: 1000, listTimeoutMs: 1000, callTimeoutMs: 100 } };
  let p: PersonalHarness;
  t.after(async () => { await p?.close(); await model.close(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); if (previous === undefined) delete process.env[credential]; else process.env[credential] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const open = async () => p = await openPersonalHarness(options); await open();
  await p!.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "confirm"; permission.version++; }, context);
  const store = new AppDataStore(path.join(directory, "agent-data", "main.db"), { expectedInstanceId: (await p!.harness.snapshot(PersonalAppDataDoc, context))!.instanceId });
  try { store.defineTable({ table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "Prepare work facts", opId: "seed-table", ctx: { taskId: "seed", sessionId: "fixture", agentId: "fixture" } }); } finally { store.close(); }
  return { answer, model, sent, open, get p() { return p; } };
}

for (const unknown of [false, true]) test(`Personal work facts: ${unknown ? "unknown" : "completed"} genuine records page independently and preserve off-page blockers`, { timeout: 90000 }, async t => {
  const f = await fixture(t, unknown);
  await f.p.answer("delegate", "facts-owner"); const ref = (await f.p.work.list()).find(value => value.work)!.work!;
  const records = () => f.p.harness.commit(async tx => {
    const values = { appData: (await appDataOperations(tx)).filter(value => value.origin.work?.ref.taskId === ref.taskId), tools: (await toolOperations(tx)).filter(value => value.origin.work?.ref.taskId === ref.taskId), mcp: (await mcpOperations(tx)).filter(value => value.origin.work?.ref.taskId === ref.taskId) };
    return JSON.parse(JSON.stringify(values)) as typeof values;
  }, context);
  const diagnostic = async () => {
    const current = await records(), task = await f.p.harness.getTask(ref.taskId, context);
    return `Work facts did not settle: ${JSON.stringify({ work: ref.taskId, state: task?.state, appData: current.appData.map(value => ({ operation: value.operation, code: value.result?.code ?? value.decision })), tools: current.tools.map(value => ({ operation: value.operation, code: value.code, started: value.started })), mcp: current.mcp.map(value => ({ operation: value.operation, code: value.code, started: value.started })) })}`;
  };
  // Nine sequential file reads include native worker identity checks; the total gate covers their measured root-checkout latency.
  await until(async () => {
    if ((await records()).mcp.length === 17) return true;
    if ((await f.p.harness.getTask(ref.taskId, context))?.state.status === "terminal") assert.fail(await diagnostic());
    return false;
  }, diagnostic);
  const saved = await records(), held = saved.mcp.at(-1)!;
  assert.equal(saved.appData.length, 17); assert.ok(saved.appData.every(value => value.result?.effect === "committed"));
  assert.equal(saved.tools.length, 9); assert.ok(saved.tools.every(value => value.effect === "returned" && value.stopped));
  assert.equal(held.decision, "pending"); assert.equal(held.started, false); assert.equal(f.sent.length, 16);
  const query = async (arguments_: Record<string, unknown>, requestId: string) => JSON.parse(await f.p.answer(`query:${JSON.stringify(arguments_)}`, requestId)) as PersonalWorkResult;
  const first = await query({ action: "result", work: ref.taskId }, "facts-first");
  assert.match(first.state, /running|waiting/); assert.equal(first.appData!.length, 8); assert.equal(first.tools!.items.length, 8); assert.equal(first.mcp!.length, 8); assert.equal(first.nextFactsOffset, 8);
  assert.ok(first.mcp!.every(value => value.operation !== held.operation)); assert.deepEqual(first.factCounts!.mcp, { total: 17, pending: 1, unknown: 0 });
  const work = (await f.p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))!;
  const progress = JSON.parse(await f.p.answer(`query:${JSON.stringify({ action: "progress", delegation: work.delegation!.entryId })}`, "facts-progress")) as { members: PersonalWorkResult[] };
  assert.equal(progress.members[0].appData!.length, 8); assert.equal(progress.members[0].nextFactsOffset, 8); assert.deepEqual(progress.members[0].factCounts, first.factCounts);
  const summary = await f.p.harness.commit(tx => personalWorkSummary(tx, ref), context); assert.deepEqual(summary.appData, first.appData); assert.deepEqual(summary.factCounts, first.factCounts);
  await f.p.mcp!.decide(held.operation, "approved");
  if (unknown) {
    await until(async () => (await records()).mcp.at(-1)?.code === "timeout");
    const uncertain = await query({ action: "result", work: ref.taskId, factsOffset: 8 }, "facts-unknown");
    assert.equal(uncertain.mcp!.length, 8); assert.ok(uncertain.mcp!.every(value => value.operation !== held.operation)); assert.deepEqual(uncertain.factCounts!.mcp, { total: 17, pending: 1, unknown: 1 }); assert.match(uncertain.notice!, /MCP.*未知/);
    await f.p.mcp!.end(held.operation);
  }
  await f.p.harness.waitForTask(ref.taskId, context);
  const pages: PersonalWorkResult[] = [];
  for (let factsOffset: number | undefined = 0; factsOffset !== undefined;) { const page = await query({ action: "result", work: ref.taskId, offset: 4000, factsOffset }, `facts-page-${factsOffset}`); pages.push(page); factsOffset = page.nextFactsOffset; }
  assert.deepEqual(pages.map(page => page.factsOffset), [0, 8, 16]); assert.deepEqual(pages.map(page => page.appData!.length), [8, 8, 1]); assert.deepEqual(pages.map(page => page.tools!.items.length), [8, 1, 0]);
  assert.deepEqual(pages.flatMap(page => page.appData!.map(value => value.operation)), saved.appData.map(value => value.operation));
  assert.deepEqual(pages.flatMap(page => page.tools!.items.map(value => value.operation)), saved.tools.map(value => value.operation).reverse());
  assert.deepEqual(pages.flatMap(page => page.mcp!.map(value => value.operation)), saved.mcp.map(value => value.operation));
  for (const page of pages) { assert.deepEqual(page.factCounts!.mcp, { total: 17, pending: 0, unknown: unknown ? 1 : 0 }); if (!unknown) { assert.equal(page.state, "completed"); assert.equal(page.text, f.answer.slice(4000, 8096)); assert.equal(page.nextOffset, 8096); } }
  assert.equal(pages.at(-1)!.nextFactsOffset, undefined);
  const textPage = await query({ action: "result", work: ref.taskId, offset: 8096 }, "facts-text-page"); assert.equal(textPage.factsOffset, 0); assert.deepEqual(textPage.appData, pages[0].appData); if (!unknown) assert.equal(textPage.text, f.answer.slice(8096));
  const empty = await query({ action: "result", work: ref.taskId, factsOffset: 24 }, "facts-beyond-end"); assert.deepEqual(empty.appData, []); assert.deepEqual(empty.tools!.items, []); assert.deepEqual(empty.mcp, []); assert.equal(empty.nextFactsOffset, undefined); assert.deepEqual(empty.factCounts, pages[0].factCounts);
  await assert.rejects(f.p.harness.commit(tx => personalWorkExecutionFacts(tx, ref.taskId, -1), context), error => error instanceof PersonalError && error.code === "work_input_invalid");
  assert.match(await f.p.answer(`query:${JSON.stringify({ action: "progress", delegation: work.delegation!.entryId, factsOffset: 8 })}`, "facts-wrong-action"), /work_input_invalid/);
  const tool = f.model.calls[0].tools!.find(value => (value.function as { name: string }).name === "background_work")!.function as { parameters: { properties: { factsOffset: { description: string } } } };
  assert.match(tool.parameters.properties.factsOffset.description, /仅 result.*独立.*nextFactsOffset.*factCounts/);
  await f.p.close(); await f.open(); const restored = await f.p.harness.commit(tx => personalWorkResult(tx, ref, 4000, 4096, undefined, 16), context); assert.deepEqual(restored, pages[2]); assert.equal(f.sent.length, 17);
});
