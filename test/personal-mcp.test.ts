import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type TaskId } from "@earendil-works/pi-durable";
import type { McpRemoteTool } from "@ruukoto/agent/mcp/transport.ts";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalMcpDoc } from "../apps/ruukoto/src/personal-mcp.ts";
import { personalMcpCredential, parsePersonalMcp, savePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { PersonalWorkDoc, requestPersonalWorkCancel, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalDelegationDoc, listPersonalDelegations, personalDelegationProgress, type PersonalDelegationRef } from "../apps/ruukoto/src/personal-delegation.ts";
import { personalReportResult } from "../apps/ruukoto/src/personal-report.ts";
import { personalServiceSourceBlocker } from "../apps/ruukoto/src/personal-service-operations.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const definition: McpRemoteTool = { name: "act", description: "远端原定义", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, annotations: { readOnlyHint: true } };
const invocation = (value = "原参数") => `mcp:${JSON.stringify({ service: "test", tool: "act", arguments: { value } })}`;
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < end, "等待 MCP 状态超时"); await delay(5); }
}
type RpcCall = { id: string | number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type RpcReply = { result: unknown } | { error: { code: number; message: string; data?: unknown } };
async function remote(t: TestContext, respond: (call: RpcCall) => RpcReply | undefined = () => ({ result: { content: [{ type: "text", text: "远端结果" }] } })) {
  const tools = [structuredClone(definition)], calls: RpcCall[] = [], requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const call = JSON.parse(Buffer.concat(chunks).toString()) as RpcCall;
    requests.push(call.method);
    let reply: RpcReply | undefined;
    if (call.method === "initialize") reply = { result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "durable-mcp-test", version: "1" } } };
    else if (call.method === "tools/list") reply = { result: { tools } };
    else if (call.method === "tools/call") { calls.push(call); reply = respond(call); }
    else { res.writeHead(202).end(); return; }
    if (reply) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...reply }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, tools, calls, requests };
}
const defaultResponder: Responder = request => {
  const last = request.messages.at(-1), content = String(last?.content);
  if (last?.role === "user" && content.startsWith("mcp:")) return { kind: "tool_calls", calls: [{ id: "remote", name: "mcp_call", arguments: JSON.parse(content.slice(4)) as Record<string, unknown> }] };
  if (last?.role === "user" && content === "definitions") return { kind: "tool_calls", calls: [{ id: "definitions", name: "mcp_tools", arguments: {} }] };
  return { kind: "text", text: last?.role === "tool" ? content : "完成" };
};
async function fixture(t: TestContext, server: Awaited<ReturnType<typeof remote>>, responder = defaultResponder) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-mcp-"))), directory = path.join(root, "profile");
  const model = new MockModelServer(responder);
  const modelConfig: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_MCP_MODEL_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[modelConfig.apiKeyEnv]; process.env[modelConfig.apiKeyEnv] = "test-only";
  const mcp = parsePersonalMcp({ version: 1, generation: "mcp-test-first", services: [{ id: "test", label: "测试服务", endpoint: server.endpoint, tools: structuredClone(server.tools) }] });
  const options = { directory, provider: personalProvider(modelConfig), modelId: modelConfig.modelId, mcp, mcpTimeouts: { connectTimeoutMs: 1000, listTimeoutMs: 1000, callTimeoutMs: 1000 } };
  let current: PersonalHarness | undefined;
  t.after(async () => { await current?.close(); await model.close(); if (previous === undefined) delete process.env[modelConfig.apiKeyEnv]; else process.env[modelConfig.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, model, modelConfig, options, mcp,
    async open(overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) { return current = await openPersonalHarness({ ...options, ...overrides }); },
  };
}
async function mode(p: PersonalHarness, value: "confirm" | "auto-review" | "full_access") { await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = value; permission.version++; }, context); }
async function first(p: PersonalHarness) { await until(async () => !!(await p.mcp!.list()).items.length); return (await p.mcp!.list()).items[0].operation; }
async function record(p: PersonalHarness, operation: TaskId) { return (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!; }
async function details(p: PersonalHarness, operation: TaskId) {
  let text = "", offset = 0;
  do { const page = await p.mcp!.detail(operation, offset); assert.ok(page.text.length <= 3072); text += page.text; offset = page.nextOffset ?? -1; } while (offset >= 0);
  return JSON.parse(text) as { definition: McpRemoteTool; arguments: Record<string, unknown>; request?: string; response?: string; code: string; remoteEnded: boolean };
}

test("durable MCP：主会话完全访问保留原定义、原参数与完整长响应分页", { timeout: 20000 }, async t => {
  const result = { content: [{ type: "text", text: "完整原文".repeat(3000) }], structuredContent: { nested: ["原始值", { count: 7 }] } };
  const server = await remote(t, () => ({ result })), f = await fixture(t, server);
  const p = await f.open(); await mode(p, "full_access");
  assert.deepEqual((JSON.parse(await p.answer("definitions", "definitions")) as { tools: { definition: McpRemoteTool }[] }).tools[0].definition, definition);
  const answer = JSON.parse(await p.answer(invocation(), "owner-call")) as { operation: TaskId; effect: string; code: string };
  assert.equal(answer.effect, "returned"); assert.equal(answer.code, "returned");
  const detail = await details(p, answer.operation);
  assert.deepEqual(detail.definition, definition); assert.deepEqual(detail.arguments, { value: "原参数" });
  assert.deepEqual(JSON.parse(detail.request!).params, { name: "act", arguments: { value: "原参数" } });
  assert.deepEqual(JSON.parse(detail.response!).result, result); assert.equal(detail.remoteEnded, true);
  assert.equal(server.calls.length, 1);
  const saved = await record(p, answer.operation), task = await p.harness.commit(tx => tx.task(answer.operation), context);
  assert.equal(task!.kind, "pi.tool"); assert.equal(task!.owner, saved.origin.generation);
  assert.deepEqual(saved.config, f.mcp);
  await p.close(); const reopened = await f.open();
  assert.deepEqual(await details(reopened, answer.operation), detail); assert.equal(server.calls.length, 1);
});

test("durable MCP：端点的查询别名不能绕过未知调用占用", { timeout: 20000 }, async t => {
  const server = await remote(t, () => undefined), f = await fixture(t, server);
  const mcp = parsePersonalMcp({ ...f.mcp, services: [f.mcp.services[0], { ...f.mcp.services[0], id: "alias", endpoint: server.endpoint + "?alias=1" }] });
  const p = await f.open({ mcp, mcpTimeouts: { callTimeoutMs: 30 } }); await mode(p, "full_access");
  await p.answer(invocation(), "original");
  const original = await record(p, await first(p));
  assert.equal(original.remoteEnded, false); assert.equal(server.calls.length, 1);
  await p.answer(`mcp:${JSON.stringify({ service: "alias", tool: "act", arguments: { value: "另一来源" } })}`, "independent-alias");
  assert.equal(server.calls.length, 1);
  assert.equal((await p.mcp!.list()).items[0].code, "mcp_endpoint_busy");
});

for (const damage of ["observation", "arguments", "approval"] as const) test(`durable MCP：${damage} 原证据损坏时启动拒绝，不能重新外调`, { timeout: 20000 }, async t => {
  const server = await remote(t, () => undefined), f = await fixture(t, server);
  const p = await f.open({ mcpTimeouts: { callTimeoutMs: 30 } }); await mode(p, "full_access");
  await p.answer(invocation(), "original"); const operation = await first(p);
  await p.harness.commit(async tx => {
    const value = (await tx.doc(PersonalMcpDoc, String(operation), null)).operation!;
    if (damage === "observation") delete value.observation;
    else if (damage === "arguments") value.args = { value: "伪造参数" };
    else value.decision = "approved";
  }, context);
  await p.close();
  await assert.rejects(f.open(), code("mcp_record_invalid"));
  assert.equal(server.calls.length, 1);
});

for (const failure of ["tool", "rpc"] as const) test(`durable MCP：完整保存 ${failure} 错误原响应且不伪装未知`, { timeout: 20000 }, async t => {
  const reply: RpcReply = failure === "tool" ? { result: { isError: true, content: [{ type: "text", text: "远端业务失败" }], structuredContent: { reason: "拒绝" } } } : { error: { code: -32007, message: "远端 RPC 失败", data: { detail: ["必须保留", { count: 19 }] } } };
  const server = await remote(t, () => reply), f = await fixture(t, server), p = await f.open(); await mode(p, "full_access");
  await p.answer(invocation(), "failure"); const operation = await first(p), detail = await details(p, operation);
  assert.equal(detail.code, failure === "tool" ? "tool_error" : "remote_error"); assert.equal(detail.remoteEnded, true);
  const response = JSON.parse(detail.response!) as Record<string, unknown>;
  assert.deepEqual(failure === "tool" ? response.result : response.error, failure === "tool" && "result" in reply ? reply.result : "error" in reply ? reply.error : undefined);
  assert.equal((await record(p, operation)).effect, "returned"); assert.equal(server.calls.length, 1);
});

for (const permission of ["confirm", "auto-review"] as const) test(`durable MCP：${permission} 不信只读标注，每次批准仅消费一次`, { timeout: 20000 }, async t => {
  const server = await remote(t), f = await fixture(t, server), p = await f.open(); await mode(p, permission);
  const answer = p.answer(invocation(), "approved");
  const operation = await first(p); assert.equal((await record(p, operation)).decision, "pending"); assert.equal(server.requests.length, 0);
  await p.mcp!.decide(operation, "approved"); await answer;
  assert.equal(server.calls.length, 1); assert.equal((await record(p, operation)).decision, "approved");
  await assert.rejects(p.mcp!.decide(operation, "approved"), code("mcp_decision_invalid"));
  const rejected = p.answer(invocation("第二次"), "rejected");
  await until(async () => (await p.mcp!.list()).items.length === 2);
  const second = (await p.mcp!.list()).items[0].operation;
  assert.equal((await record(p, second)).decision, "pending"); assert.equal(server.calls.length, 1);
  await p.mcp!.decide(second, "rejected"); await rejected;
  assert.equal((await record(p, second)).effect, "not_executed"); assert.equal(server.calls.length, 1);
});

for (const changed of ["credential", "definition"] as const) test(`durable MCP：${changed} 失效在实际调用前拒绝`, { timeout: 20000 }, async t => {
  const server = await remote(t), f = await fixture(t, server);
  if (changed === "credential") { const filename = path.join(f.root, "token"); fs.writeFileSync(filename, "test-token", { mode: 0o600 }); f.mcp.services[0].credential = personalMcpCredential(filename); fs.unlinkSync(filename); }
  else server.tools[0].description = "发现时的新定义";
  const p = await f.open(); await mode(p, "full_access");
  await p.answer(invocation(), "invalidated"); const operation = await first(p), saved = await record(p, operation);
  assert.equal(saved.started, false); assert.equal(saved.effect, "not_executed"); assert.equal(saved.code, changed === "credential" ? "auth_failed" : "mcp_definition_changed");
  assert.equal(server.calls.length, 0); if (changed === "credential") assert.equal(server.requests.length, 0);
});

test("durable MCP：子工具超时跨重启接回同 Task，未知效果保留占用且不能人工伪造远端结束", { timeout: 20000 }, async t => {
  const server = await remote(t, () => undefined), f = await fixture(t, server), options = { mcpTimeouts: { connectTimeoutMs: 1000, listTimeoutMs: 1000, callTimeoutMs: 50 } };
  let p = await f.open(options); await mode(p, "full_access"); await p.answer("原拥有者工作", "owner-source");
  const work = await p.work.delegate({ requestId: "unknown-work", sourceRequestId: "owner-source", content: invocation() });
  const operation = await first(p);
  await until(async () => (await record(p, operation)).code === "timeout");
  const before = await record(p, operation);
  assert.equal(before.origin.work!.ref.taskId, work.taskId); assert.equal(before.effect, "effect_unknown"); assert.equal(before.remoteEnded, false);
  assert.equal(server.calls.length, 1);
  await assert.rejects(p.work.delegate({ requestId: "bypass", sourceRequestId: "owner-source", content: "换工具重试" }), code("work_source_paused"));
  await assert.rejects(p.work.append(work, { requestId: "append", sourceRequestId: "owner-source", content: "继续" }), code("work_source_paused"));
  assert.equal(await p.answer("独立聊天", "independent"), "完成");
  await p.close(); p = await f.open(options);
  const resumed = await record(p, operation); assert.equal(resumed.operation, before.operation); assert.equal(resumed.admission, before.admission); assert.equal(server.calls.length, 1);
  await p.mcp!.resolve(operation, "applied", "远端业务记录存在原操作");
  await assert.rejects(p.mcp!.resolve(operation, "not_applied", "不得覆盖"), code("mcp_resolution_invalid"));
  await assert.rejects(p.mcp!.requestRecheck(operation), code("mcp_recheck_unavailable"));
  await delay(25);
  assert.equal((await p.work.list()).find(agent => agent.id === work.agentId)!.work!.taskId, work.taskId);
  assert.equal((await p.harness.commit(tx => tx.task(work.taskId), context))!.state.status, "running");
  assert.equal((await p.mcp!.detail(operation)).summary.remoteEnded, false); assert.equal(server.calls.length, 1);
});

test("durable MCP：响应已到达但未提交时 SIGKILL，恢复保留同原调用且远端只执行一次", { timeout: 20000 }, async t => {
  const server = await remote(t), f = await fixture(t, server);
  const script = `
    import { openPersonalHarness } from './apps/ruukoto/src/personal-harness.ts';
    import { personalProvider } from './apps/ruukoto/src/personal-model.ts';
    import { PersonalPermissionsDoc } from './apps/ruukoto/src/personal-permissions.ts';
    import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
    import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
    const input = JSON.parse(process.env.RUUKOTO_MCP_CRASH);
    const p = await openPersonalHarness({directory:input.directory,provider:personalProvider(input.model),modelId:input.model.modelId,mcp:input.mcp,
      openStorage: async filename => {
        const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
        storage.commit = async (writes, context) => {
          if (writes.some(write => write.type === 'entry' && write.value.kind === 'ruukoto.mcp-observation' && write.value.data.evidence.response)) {
            process.stdout.write('response-commit-gap\\n');
            await new Promise(() => {});
          }
          return commit(writes, context);
        };
        return storage;
      }});
    await p.harness.commit(async tx => {(await tx.doc(PersonalPermissionsDoc)).mode='full_access';}, BACKGROUND_CONTEXT);
    await p.answer('原拥有者工作','owner-source');
    const work=await p.work.delegate({requestId:'crash-work',sourceRequestId:'owner-source',content:input.content});
    process.stdout.write('work:'+JSON.stringify(work)+'\\n');
  `;
  const worker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_MCP_CRASH: JSON.stringify({ directory: f.directory, model: f.modelConfig, mcp: f.mcp, content: invocation() }) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  worker.stdout.on("data", chunk => { output += String(chunk); }); worker.stderr.on("data", chunk => { errors += String(chunk); });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); });
  await until(() => { assert.equal(worker.exitCode, null, errors); return output.includes("response-commit-gap"); });
  const exit = once(worker, "exit"); worker.kill("SIGKILL"); await exit;
  assert.equal(worker.signalCode, "SIGKILL"); assert.equal(server.calls.length, 1);
  const work = JSON.parse(output.split("\n").find(line => line.startsWith("work:"))!.slice(5)) as PersonalWorkRef;
  const p = await f.open(), operation = await first(p);
  await until(async () => (await record(p, operation)).code === "interrupted");
  const saved = await record(p, operation);
  assert.equal(saved.origin.work!.ref.taskId, work.taskId); assert.equal(saved.effect, "effect_unknown"); assert.equal(saved.remoteEnded, false); assert.equal(saved.evidence.response, undefined);
  assert.equal((await p.harness.commit(tx => tx.task(operation), context))!.kind, "pi.tool");
  assert.equal(server.calls.length, 1);
  await p.close(); const reopened = await f.open();
  assert.equal((await first(reopened)), operation); assert.equal(server.calls.length, 1);
});

test("durable MCP：主工具与输入均终结后仍拒绝绕过未知调用更换配置", { timeout: 20000 }, async t => {
  const server = await remote(t, () => undefined), f = await fixture(t, server);
  let p = await f.open({ mcpTimeouts: { callTimeoutMs: 50 } }); await mode(p, "full_access");
  await p.answer(invocation(), "terminal-main"); const operation = await first(p);
  const inspected = await p.harness.inspect(context);
  assert.equal(inspected.tasks.length, 0); assert.equal(inspected.submissions.length, 0);
  assert.equal((await record(p, operation)).effect, "effect_unknown");
  const next = { ...f.mcp, generation: "second-generation" };
  await p.close();
  await assert.rejects(savePersonalMcp(f.directory, next), code("mcp_config_pending"));
  await assert.rejects(f.open({ mcp: next }), code("mcp_config_pending"));
  p = await f.open();
  assert.equal((await first(p)), operation); assert.equal(server.calls.length, 1);
});

test("durable MCP：同来源暂停服务与委托报告，重启保留原暂停和占用", { timeout: 20000 }, async t => {
  let group!: PersonalDelegationRef;
  const server = await remote(t, () => undefined), f = await fixture(t, server, request => {
    const last = request.messages.at(-1);
    if (request.system?.includes("你是个人助手的子 Agent")) return defaultResponder(request, 0);
    if (last?.role === "user" && last.content === "multi") return { kind: "tool_calls", calls: ["A", "B"].map(id => ({ id, name: "background_work", arguments: { action: "delegate", content: id } })) };
    if (last?.role === "user" && last.content === "report") return { kind: "tool_calls", calls: [{ id: "report", name: "background_work", arguments: { action: "report", delegation: group.entryId } }] };
    return { kind: "text", text: "完成" };
  });
  let p!: PersonalHarness, operation: TaskId | undefined, armed = true;
  const provider = f.options.provider;
  p = await f.open({ mcpTimeouts: { callTimeoutMs: 50 }, provider: { ...provider, streamSimple: (model, input, options) => provider.streamSimple(model, input, { ...options, onPayload: async payload => {
    if (armed && JSON.stringify(input.messages.at(-1)).includes("宿主委托汇总参考")) {
      armed = false;
      await p.work.delegate({ requestId: "report-pause-mcp", sourceRequestId: "owner-source", content: invocation() });
      operation = await first(p); await until(async () => (await record(p, operation!)).code === "timeout");
    }
    return await options?.onPayload?.(payload, model) ?? payload;
  } }) } });
  await mode(p, "full_access"); await p.answer("multi", "owner-source");
  group = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  for (const member of (await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.members) await p.harness.waitForTask(member.taskId, context);
  await p.answer("report", "report-source");
  await until(async () => (await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.report!.attempt === 1);
  assert.ok(operation);
  const saved = await record(p, operation), report = (await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.report!;
  assert.equal(report.pauses.length, 1);
  const pause = await p.harness.commit(tx => tx.entry(report.pauses[0]), context);
  assert.equal(pause!.kind, "ruukoto.report-pause");
  assert.deepEqual(pause!.data && typeof pause!.data === "object" && !Array.isArray(pause!.data) && pause!.data.blocker, { mcp: String(operation), admission: saved.admission });
  assert.deepEqual(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "owner-source"), context), { mcp: String(operation), admission: saved.admission });
  assert.equal((await p.harness.commit(tx => personalDelegationProgress(tx, group), context)).paused, true);
  const summaryCalls = () => f.model.calls.filter(request => String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考"));
  assert.equal(summaryCalls().length, 0); assert.equal(server.calls.length, 1);
  assert.equal(await p.answer("独立聊天", "independent"), "完成");
  await p.close(); p = await f.open();
  assert.equal((await p.harness.commit(tx => personalDelegationProgress(tx, group), context)).paused, true);
  assert.equal((await p.harness.commit(tx => personalReportResult(tx, group), context)).state, "running");
  await p.mcp!.resolve(operation, "applied", "远端业务核实原操作存在");
  await delay(20);
  assert.equal(summaryCalls().length, 0); assert.equal((await record(p, operation)).remoteEnded, false); assert.equal(server.calls.length, 1);
});

test("durable MCP：实际主子模型请求可重建工具定义与结果，并记录启用前后开销", { timeout: 20000 }, async t => {
  const server = await remote(t), f = await fixture(t, server, (request, index) => {
    const last = request.messages.at(-1);
    if (request.system?.includes("你是个人助手的子 Agent") && last?.role === "user" && last.content === "child-definitions") return { kind: "tool_calls", calls: [{ id: "child-definitions", name: "mcp_tools", arguments: {} }] };
    if (request.system?.includes("你是个人助手的子 Agent") && last?.role === "tool" && String(last.content).includes('"tools":[')) return { kind: "tool_calls", calls: [{ id: "child-call", name: "mcp_call", arguments: { service: "test", tool: "act", arguments: { value: "子原参数" } } }] };
    return defaultResponder(request, index);
  });
  let p = await f.open({ mcp: undefined });
  await p.answer("启用前模型请求", "before-source");
  const beforeMain = f.model.calls.at(-1)!;
  const initial = await p.work.delegate({ requestId: "before-child", sourceRequestId: "before-source", content: "子请求基线" });
  await p.harness.waitForTask(initial.taskId, context);
  const beforeChild = f.model.calls.findLast(request => request.system?.includes("你是个人助手的子 Agent"))!;
  await p.close(); p = await f.open(); await mode(p, "full_access");
  await p.answer("definitions", "after-source");
  const afterMain = f.model.calls.findLast(request => !request.system?.includes("你是个人助手的子 Agent"))!;
  const work = await p.work.delegate({ requestId: "after-child", sourceRequestId: "after-source", content: "child-definitions", agentId: initial.agentId });
  await p.harness.waitForTask(work.taskId, context);
  const afterChild = f.model.calls.findLast(request => request.system?.includes("你是个人助手的子 Agent"))!;
  const toolNames = (request: typeof beforeMain) => (request.tools ?? []).map(tool => { const definition = tool.function; assert.ok(definition && typeof definition === "object" && "name" in definition); return definition.name; });
  for (const request of [afterMain, afterChild]) {
    for (const name of ["mcp_tools", "mcp_call", "read_mcp_result"]) assert.ok(toolNames(request).includes(name));
    assert.match(JSON.stringify(request.messages), /远端原定义/); assert.match(JSON.stringify(request.messages), /readOnlyHint/);
  }
  for (const request of [beforeMain, beforeChild]) assert.ok(toolNames(request).every(name => !["mcp_tools", "mcp_call", "read_mcp_result"].includes(String(name))));
  assert.match(JSON.stringify(afterChild.messages), /returned/);
  const estimate = (request: typeof beforeMain) => ({ systemPrompt: Math.ceil((request.system?.length ?? 0) / 4), toolSchemas: Math.ceil(JSON.stringify(request.tools ?? []).length / 4) });
  t.diagnostic(JSON.stringify({ estimatedTokens: { main: { before: estimate(beforeMain), after: estimate(afterMain) }, child: { before: estimate(beforeChild), after: estimate(afterChild) } } }));
  assert.equal(server.calls.length, 1);
});

test("durable MCP：取消仅停止本地等待，原调用未知和子工作占用跨重启保留", { timeout: 20000 }, async t => {
  const server = await remote(t, () => undefined), f = await fixture(t, server);
  let p = await f.open({ mcpTimeouts: { callTimeoutMs: 10000 } }); await mode(p, "full_access"); await p.answer("拥有者工作", "owner-source");
  const work = await p.work.delegate({ requestId: "cancel-work", sourceRequestId: "owner-source", content: invocation() });
  const operation = await first(p); await until(() => server.calls.length === 1);
  await p.harness.commit(tx => requestPersonalWorkCancel(tx, work), context);
  await p.harness.abortTask(work.taskId, context);
  await until(async () => (await record(p, operation)).code === "canceled");
  assert.equal((await record(p, operation)).effect, "effect_unknown"); assert.equal((await record(p, operation)).remoteEnded, false);
  assert.equal((await p.harness.snapshot(PersonalWorkDoc, work.requestId, context))!.cancelRequested, true);
  await assert.rejects(p.work.closeAgent(work.agentId), code("subagent_busy"));
  await p.close(); p = await f.open();
  assert.equal((await first(p)), operation); assert.equal(server.calls.length, 1);
  assert.equal((await p.work.list()).find(agent => agent.id === work.agentId)!.work!.taskId, work.taskId);
  assert.equal((await record(p, operation)).remoteEnded, false);
});
