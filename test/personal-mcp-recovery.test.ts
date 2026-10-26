import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTask, ROOT_CONVERSATION_ID, type EntryId, type TaskId } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalMcpDoc } from "../apps/ruukoto/src/personal-mcp.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { PersonalDelegationDoc, listPersonalDelegations, personalDelegationProgress, type PersonalDelegationRef } from "../apps/ruukoto/src/personal-delegation.ts";
import { personalReportResult } from "../apps/ruukoto/src/personal-report.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer as MockModelServer } from "./helpers/mock-provider.ts";

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
    if (request.method !== "POST") { response.writeHead(204).end(); return; }
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
    return { kind: "text", text: content.startsWith("宿主委托汇总参考") ? "原 MCP 结果未知，人工收尾后报告" : "独立聊天完成" };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_MCP_RECOVERY_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-mcp-recovery-")));
  const mcp = parsePersonalMcp({ version: 4, generation: "original-generation", services: [{ id: "late", label: "迟到结果服务", endpoint: `http://127.0.0.1:${address.port}/mcp`, enabled: true, tools: [definition], toolEffects: { act: "unknown" } }] });
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

test("durable MCP：未知写跨重启不续流，人工收尾后成员停止才生成报告，原来源仍禁执行", { timeout: 20000 }, async t => {
  const f = await fixture(t, { result: { content: [{ type: "text", text: "未取回的结果" }] } });
  let p = await f.open();
  const { group, member } = await f.delegate(p);
  await p.answer("安排报告", "report-source");
  const reportTask = (await report(p, group)).taskId;
  f.release();
  const operation = await first(p);
  await until(async () => (await record(p, operation)).code === "timeout");
  const original = await record(p, operation);
  assert.equal(original.recordVersion, 2); assert.deepEqual(original.evidence, {});
  assert.equal(original.effect, "effect_unknown"); assert.equal(original.remoteEnded, false);
  const summaries = () => f.model.calls.filter(request => String(request.messages.at(-1)?.content).startsWith("宿主委托汇总参考"));
  assert.equal(summaries().length, 0);
  await p.mcp!.resolve(operation, "applied", "业务记录存在，原结果仍未知");
  assert.equal(summaries().length, 0);
  await p.close();
  const networkBefore = f.requests.length;
  p = await f.open();
  assert.equal(f.requests.length, networkBefore); assert.equal(f.calls.length, 1);
  assert.equal((await record(p, operation)).admission, original.admission);
  await p.mcp!.end(operation);
  await p.harness.waitForTask(member.taskId, context);
  await p.harness.waitForTask(reportTask, context);
  const final = await record(p, operation);
  assert.equal(final.effect, "effect_unknown"); assert.equal(final.remoteEnded, false); assert.ok(final.ended);
  assert.equal((await p.work.list()).find(agent => agent.id === member.agentId)!.work, undefined);
  const summary = await p.harness.commit(tx => personalReportResult(tx, group), context);
  assert.equal(summary.delivery, "local"); assert.match(summary.text!, /结果未知/); assert.equal(summaries().length, 1);
  await assert.rejects(p.work.delegate({ requestId: "same-source", sourceRequestId: "owner-source", content: "换键重试" }), code("work_source_paused"));
  await p.close(); p = await f.open();
  assert.deepEqual((await record(p, operation)).ended, final.ended); assert.equal(f.calls.length, 1);
});

test("durable MCP：取消不会伪造远端结束，人工收尾释放本地身份供独立工作复用", { timeout: 20000 }, async t => {
  const f = await fixture(t, { result: { content: [{ type: "text", text: "未取回的原结果" }] } }, 10000), p = await f.open();
  const { member } = await f.delegate(p); f.release();
  const operation = await first(p); await until(() => f.calls.length === 1);
  let ended = false;
  const canceled = p.work.cancel(member).then(value => { ended = true; return value; });
  await until(async () => (await record(p, operation)).code === "canceled");
  assert.equal(ended, false); assert.equal((await record(p, operation)).remoteEnded, false);
  await p.mcp!.end(operation);
  assert.equal((await canceled).state.outcome.status, "aborted"); assert.equal(ended, true);
  assert.equal((await record(p, operation)).remoteEnded, false);
  await assert.rejects(p.work.delegate({ requestId: "same-source", sourceRequestId: "owner-source", content: "重试", agentId: member.agentId }), code("work_source_paused"));
  await p.answer("独立聊天", "independent-source");
  const reused = await p.work.delegate({ requestId: "safe-reuse", sourceRequestId: "independent-source", content: "完成分析", agentId: member.agentId });
  assert.equal(reused.agentId, member.agentId); await p.harness.waitForTask(reused.taskId, context);
  assert.equal(f.calls.length, 1); assert.equal(f.requests.filter(request => request.token).length, 0);
});

test("durable MCP：旧重核 v1 verify 阶段只核实归属后退役，零 GET/POST 且原操作不改写", { timeout: 20000 }, async t => {
  const f = await fixture(t, { result: { content: [] } }), p = await f.open();
  await f.delegate(p); f.release();
  const operation = await first(p); await until(async () => (await record(p, operation)).code === "timeout");
  const original = await record(p, operation), before = f.requests.length;
  const legacy = defineTask<{ operation: TaskId; admission: EntryId }, { phase: "verify" }, object>({ name: "ruukoto.mcp-recheck", version: 1, initial: () => ({ phase: "verify" }), phases: { async verify() { throw new Error("应调用安装的退役定义"); } }, async abort() { throw new Error("应调用安装的退役定义"); } });
  const task = await p.harness.commit(tx => tx.createTask(legacy, { operation, admission: original.admission }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }), context);
  p.harness.resume();
  const result = await p.harness.waitForTask(task, context);
  assert.equal(result.state.outcome.status, "completed"); assert.deepEqual(result.state.outcome.result, { retired: true });
  assert.deepEqual(await record(p, operation), original); assert.equal(f.requests.length, before);
});
