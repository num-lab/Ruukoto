import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMcpConfigDoc, PersonalMcpDoc } from "../apps/ruukoto/src/personal-mcp.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { personalToolOrigin } from "../apps/ruukoto/src/personal-tool-source.ts";
import { PersonalWorkDoc } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const invalidInput = (error: unknown) => error instanceof PersonalError && error.code === "work_source_invalid";
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, "MCP state did not settle"); await delay(5); }
}

async function fixture(t: TestContext, beforeList?: () => Promise<void>) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-tool-source-")));
  const definition = { name: "act", description: "Original action", inputSchema: { type: "object", additionalProperties: false } };
  const calls: unknown[] = [];
  const remote = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const call = JSON.parse(Buffer.concat(chunks).toString()) as { id: number | string; method: string };
    let result: unknown;
    if (call.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "source-test", version: "1" } };
    else if (call.method === "tools/list") { await beforeList?.(); result = { tools: [definition] }; }
    else if (call.method === "tools/call") { calls.push(call); result = { content: [{ type: "text", text: "returned" }] }; }
    else { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address(); assert.ok(address && typeof address !== "string");
  const model = new PersonalMockModelServer(request => request.messages.at(-1)?.content === "invoke-mcp" ? { kind: "tool_calls", calls: [{ id: "original", name: "mcp_call", arguments: { service: "test", tool: "act", arguments: {} } }] } : { kind: "text", text: "complete" });
  const key = "RUUKOTO_TOOL_SOURCE_TEST_KEY", previous = process.env[key]; process.env[key] = "test-only";
  const provider = personalProvider({ api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 8192 });
  const options = { directory: path.join(directory, "profile"), provider, modelId: "mock-model", mcp: parsePersonalMcp({ version: 4, generation: "source-test", services: [{ id: "test", label: "Original service", enabled: true, endpoint: `http://127.0.0.1:${address.port}/mcp`, tools: [definition], toolEffects: { act: "unknown" } }] }) };
  let p: PersonalHarness | undefined;
  t.after(async () => { await p?.close(); await model.close(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const open = async () => p = await openPersonalHarness(options);
  p = await open();
  await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "confirm"; permission.version++; }, context);
  await p.answer("owner source", "source-owner");
  const work = await p.work.delegate({ requestId: "source-work", sourceRequestId: "source-owner", content: "invoke-mcp" });
  await until(async () => !!(await p!.harness.snapshot(PersonalMcpConfigDoc, context))?.operations.length);
  const operation = (await p.harness.snapshot(PersonalMcpConfigDoc, context))!.operations[0];
  const record = () => p!.harness.snapshot(PersonalMcpDoc, String(operation), context).then(value => value!.operation!);
  const original = await record(), live = await p.harness.snapshot(LiveDoc, work.agentId, context);
  assert.ok(original.instructions); assert.ok(live?.run); assert.equal(original.started, false);
  const foreign = (await p.harness.snapshot(PersonalWorkDoc, work.requestId, context))!.source!.submissionId;
  const replaceInputs = () => p!.harness.commit(async tx => { (await tx.doc(LiveDoc, work.agentId)).run!.inputs = [foreign]; }, context);
  const restoreInputs = () => p!.harness.commit(async tx => { const current = await tx.doc(LiveDoc, work.agentId); if (current.run?.taskId === original.origin.generation) current.run.inputs = live.run!.inputs.slice(); }, context);
  return { p, work, operation, original, calls, record, open, replaceInputs, restoreInputs };
}

test("Personal tool source: foreign live inputs cannot approve a captured pending MCP operation", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.replaceInputs();
  await assert.rejects(f.p.harness.commit(tx => personalToolOrigin(tx, { conversationId: f.work.agentId, taskId: f.operation }, f.original.origin.source.requestId, { snapshot: f.original.instructions!.snapshot }), context), invalidInput);
  await assert.rejects(f.p.mcp!.decide(f.operation, "approved"), invalidInput);
  const pending = await f.record(); assert.equal(pending.decision, "pending"); assert.equal(pending.started, false); assert.equal(f.calls.length, 0);
  await f.restoreInputs(); await f.p.mcp!.decide(f.operation, "rejected");
  await f.p.harness.waitForTask(f.work.taskId, context);
});

test("Personal tool source: foreign live inputs after approval prevent MCP consumption and survive reopen", { timeout: 20000 }, async t => {
  let listed!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { listed = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, async () => { listed(); await gate; });
  await f.p.mcp!.decide(f.operation, "approved"); await waiting;
  await f.replaceInputs(); release();
  await until(async () => (await f.record()).observation !== undefined);
  const stopped = await f.record();
  assert.equal(stopped.decision, "approved"); assert.equal(stopped.started, false); assert.equal(stopped.effect, "not_executed"); assert.equal(stopped.code, "work_source_invalid");
  assert.equal(stopped.admission, f.original.admission); assert.deepEqual(stopped.origin, f.original.origin); assert.equal(f.calls.length, 0);
  await f.restoreInputs();
  await f.p.work.cancel(f.work);
  await f.p.close(); const reopened = await f.open();
  const recovered = (await reopened.harness.snapshot(PersonalMcpDoc, String(f.operation), context))!.operation!;
  assert.deepEqual(recovered.origin, f.original.origin); assert.deepEqual(recovered.instructions, f.original.instructions);
  assert.equal(recovered.decision, "approved"); assert.equal(recovered.started, false); assert.equal(recovered.effect, "not_executed"); assert.equal(f.calls.length, 0);
});
