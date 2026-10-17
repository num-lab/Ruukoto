import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalMcpDoc } from "../apps/ruukoto/src/personal-mcp.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { PersonalDelegationDoc, listPersonalDelegations, personalDelegationProgress, type PersonalDelegationRef } from "../apps/ruukoto/src/personal-delegation.ts";
import { personalReportResult } from "../apps/ruukoto/src/personal-report.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const definition = { name: "act", description: "迟到原工具定义", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, annotations: { readOnlyHint: true } };
const invocation = { service: "late", tool: "act", arguments: { value: "原批准参数" } };
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < end, "等待原 MCP 恢复状态超时"); await delay(5); }
}
type Rpc = { id: string | number; method: string; params?: { arguments?: unknown } };
type Reply = { result: unknown } | { error: { code: number; message: string; data: unknown } };
async function fixture(t: TestContext, reply: Reply, callTimeoutMs = 80) {
  const requests: Array<{ method: string; rpc?: string; token?: string; session?: string; protocol?: string }> = [], calls: Rpc[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET") {
      const token = request.headers["last-event-id"] as string | undefined;
      requests.push({ method: "GET", token, session: request.headers["mcp-session-id"] as string | undefined, protocol: request.headers["mcp-protocol-version"] as string | undefined });
      if (!token) { response.writeHead(405).end(); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`id: terminal\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: calls[0].id, ...reply })}\n\n`);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Rpc;
    requests.push({ method: request.method!, rpc: rpc.method });
    if (rpc.method === "tools/call") {
      calls.push(rpc);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`id: original-event\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: rpc.id, progress: 0 } })}\n\n`);
    } else if (rpc.method === "initialize") response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "original-session" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "late-mcp", version: "1" } } }));
    else if (rpc.method === "tools/list") response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [definition] } }));
    else response.writeHead(202).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let release!: () => void;
  const childReady = new Promise<void>(resolve => { release = resolve; });
  let group: PersonalDelegationRef | undefined;
  const model = new MockModelServer(async request => {
    const last = request.messages.at(-1), content = String(last?.content);
    if (request.system?.includes("你是个人助手的子 Agent")) {
      if (last?.role === "user" && content === "调用原 MCP") { await childReady; return { kind: "tool_calls", calls: [{ id: "original-call", name: "mcp_call", arguments: invocation }] }; }
      return { kind: "text", text: "子工作结束" };
    }
    if (last?.role === "user" && content === "委派") return { kind: "tool_calls", calls: [{ id: "delegate", name: "background_work", arguments: { action: "delegate", content: "调用原 MCP" } }] };
    if (last?.role === "user" && content === "安排报告") return { kind: "tool_calls", calls: [{ id: "report", name: "background_work", arguments: { action: "report", delegation: group!.entryId } }] };
    return { kind: "text", text: content.startsWith("宿主委托汇总参考") ? "原请求已核实，报告恢复" : "独立聊天完成" };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_MCP_RECOVERY_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-mcp-recovery-")));
  const mcp = parsePersonalMcp({ version: 1, generation: "original-generation", services: [{ id: "late", label: "迟到结果服务", endpoint: `http://127.0.0.1:${address.port}/mcp`, tools: [definition] }] });
  let current: PersonalHarness | undefined;
  t.after(async () => {
    release(); await current?.close(); await model.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous;
  });
  return { calls, requests, model, release,
    open: async () => current = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, mcp, mcpTimeouts: { callTimeoutMs } }),
    async delegate(p: PersonalHarness) {
      await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
      await p.answer("委派", "owner-source");
      group = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
      return { group, member: (await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.members[0] };
    },
  };
}
const record = async (p: PersonalHarness, operation: TaskId) => (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!;
async function first(p: PersonalHarness) { await until(async () => !!(await p.mcp!.list()).items.length); return (await p.mcp!.list()).items[0].operation; }
const report = async (p: PersonalHarness, group: PersonalDelegationRef) => (await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.report!;

for (const result of ["success", "tool_error", "remote_error"] as const) test(`durable MCP SSE：超时后 GET 接回原 ${result}，释放工作并恢复原报告`, { timeout: 20000 }, async t => {
  const reply: Reply = result === "remote_error" ? { error: { code: -32007, message: "原远端错误", data: { nested: ["原错误证据", { count: 17 }] } } } : { result: { content: [{ type: "text", text: "迟到原结果" }], ...(result === "tool_error" ? { isError: true, structuredContent: { reason: "远端业务失败" } } : {}) } };
  const f = await fixture(t, reply);
  let p = await f.open();
  const { group, member } = await f.delegate(p);
  await p.answer("安排报告", "report-source");
  const reportTask = (await report(p, group)).taskId;
  f.release();
  const operation = await first(p);
  await until(async () => (await record(p, operation)).code === "timeout");
  const original = await record(p, operation);
  assert.equal(original.origin.work!.ref.taskId, member.taskId); assert.equal(original.evidence.resumptionToken, "original-event");
  assert.equal(original.remoteEnded, false); assert.equal(original.effect, "effect_unknown");
  assert.equal((await p.work.list()).find(agent => agent.id === member.agentId)!.work!.taskId, member.taskId);
  assert.equal((await p.harness.commit(tx => personalDelegationProgress(tx, group), context)).paused, true);
  assert.equal((await p.harness.commit(tx => tx.task(reportTask), context))!.state.status, "waiting");
  assert.equal(f.model.calls.filter(request => String(request.messages.at(-1)?.content).startsWith("宿主委托汇总参考")).length, 0);
  await p.mcp!.resolve(operation, "applied", "业务记录能确认原操作，但不能证明原请求结束");
  assert.equal((await record(p, operation)).remoteEnded, false);
  assert.equal(await p.answer("独立聊天", "independent-source"), "独立聊天完成");
  await p.close(); p = await f.open();
  assert.equal((await record(p, operation)).admission, original.admission);
  assert.equal((await record(p, operation)).remoteEnded, false);
  const initialized = f.requests.filter(request => request.rpc === "initialize").length;
  const recheck = await p.mcp!.requestRecheck(operation);
  const verified = await p.harness.waitForTask(recheck, context);
  assert.equal(verified.state.outcome.status, "completed");
  const final = await record(p, operation);
  assert.equal(final.remoteEnded, true); assert.equal(final.effect, "returned");
  assert.equal(final.evidence.request, original.evidence.request);
  assert.equal(final.code, result === "success" ? "returned" : result);
  assert.deepEqual(JSON.parse(final.evidence.response!), { jsonrpc: "2.0", id: f.calls[0].id, ...reply });
  assert.equal(final.evidence.resumptionToken, "terminal");
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].params?.arguments, invocation.arguments);
  assert.equal(f.requests.filter(request => request.rpc === "initialize").length, initialized);
  assert.deepEqual(f.requests.filter(request => request.token), [{ method: "GET", token: "original-event", session: "original-session", protocol: "2025-06-18" }]);
  await p.harness.waitForTask(member.taskId, context);
  await p.harness.waitForTask(reportTask, context);
  assert.equal((await p.work.list()).find(agent => agent.id === member.agentId)!.work, undefined);
  assert.equal((await p.harness.commit(tx => personalDelegationProgress(tx, group), context)).paused, false);
  const summary = await p.harness.commit(tx => personalReportResult(tx, group), context);
  assert.equal(summary.delivery, "local"); assert.match(summary.text!, /报告恢复/);
  await p.close(); p = await f.open();
  assert.deepEqual((await record(p, operation)).evidence, final.evidence); assert.equal(f.calls.length, 1);
});

test("durable MCP SSE：实际取消在途子工作不证明远端停止，GET 原终结后才释放并复用身份", { timeout: 20000 }, async t => {
  const reply = { result: { content: [{ type: "text", text: "取消后远端迟到完成" }] } };
  const f = await fixture(t, reply, 10000), p = await f.open();
  const { member } = await f.delegate(p); f.release();
  const operation = await first(p);
  await until(async () => f.calls.length === 1 && !!(await record(p, operation)).evidence.resumptionToken);
  let ended = false;
  const canceled = p.work.cancel(member).then(value => { ended = true; return value; });
  await until(async () => (await record(p, operation)).code === "canceled");
  await p.mcp!.resolve(operation, "applied", "远端业务存在，原请求仍须单独结束核实");
  assert.equal(ended, false); assert.equal((await record(p, operation)).remoteEnded, false);
  assert.equal((await p.work.list()).find(agent => agent.id === member.agentId)!.work!.taskId, member.taskId);
  await assert.rejects(p.work.delegate({ requestId: "blocked-reuse", sourceRequestId: "owner-source", content: "完成分析", agentId: member.agentId }), code("work_source_paused"));
  assert.equal(await p.answer("独立聊天", "independent-source"), "独立聊天完成");
  const initialized = f.requests.filter(request => request.rpc === "initialize").length;
  await p.harness.waitForTask(await p.mcp!.requestRecheck(operation), context);
  assert.equal((await canceled).state.outcome.status, "aborted");
  assert.equal(ended, true); assert.equal((await record(p, operation)).remoteEnded, true);
  assert.deepEqual(JSON.parse((await record(p, operation)).evidence.response!), { jsonrpc: "2.0", id: f.calls[0].id, ...reply });
  assert.equal((await p.work.list()).find(agent => agent.id === member.agentId)!.work, undefined);
  const reused = await p.work.delegate({ requestId: "safe-reuse", sourceRequestId: "independent-source", content: "完成分析", agentId: member.agentId });
  assert.equal(reused.agentId, member.agentId);
  assert.equal((await p.harness.waitForTask(reused.taskId, context)).state.outcome.status, "completed");
  assert.equal(f.calls.length, 1); assert.equal(f.requests.filter(request => request.rpc === "initialize").length, initialized);
});
