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
import { type TaskId, type EntryId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { McpRemoteTool } from "@ruukoto/agent/mcp/transport.ts";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalMcpDoc, PersonalMcpConfigDoc } from "../apps/ruukoto/src/personal-mcp.ts";
import { migratePersonalMcp, personalMcpCredential, parsePersonalMcp, readPersonalMcp, savePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { lockPersonalProfile, type PersonalProfileLock } from "../apps/ruukoto/src/personal-profile.ts";
import { PersonalConfigurationDoc, PersonalSettingsOperationDoc } from "../apps/ruukoto/src/personal-settings-records.ts";
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
type RpcReply = { result: unknown } | { error: { code: number; message: string; data?: unknown } } | { httpStatus: number };
async function remote(t: TestContext, respond: (call: RpcCall) => RpcReply | undefined = () => ({ result: { content: [{ type: "text", text: "远端结果" }] } }), beforeList?: () => Promise<void>, sessionId?: string) {
  const tools = [structuredClone(definition)], calls: RpcCall[] = [], requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const call = JSON.parse(Buffer.concat(chunks).toString()) as RpcCall;
    requests.push(call.method);
    let reply: RpcReply | undefined;
    if (call.method === "initialize") reply = { result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "durable-mcp-test", version: "1" } } };
    else if (call.method === "tools/list") { await beforeList?.(); reply = { result: { tools } }; }
    else if (call.method === "tools/call") { calls.push(call); reply = respond(call); }
    else { res.writeHead(202).end(); return; }
    if (reply && "httpStatus" in reply) res.writeHead(reply.httpStatus).end();
    else if (reply) res.writeHead(200, { "content-type": "application/json", ...(sessionId ? { "mcp-session-id": sessionId } : {}) }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...reply }));
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
  const mcp = parsePersonalMcp({ version: 4, generation: "mcp-test-first", services: [{ id: "test", label: "测试服务", endpoint: server.endpoint, enabled: true, tools: structuredClone(server.tools), toolEffects: { act: "unknown" } }] });
  const options = { directory, provider: personalProvider(modelConfig), modelId: modelConfig.modelId, mcp, mcpTimeouts: { connectTimeoutMs: 1000, listTimeoutMs: 1000, callTimeoutMs: 1000 } };
  let current: PersonalHarness | undefined;
  t.after(async () => { await current?.close(); await model.close(); if (previous === undefined) delete process.env[modelConfig.apiKeyEnv]; else process.env[modelConfig.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, model, modelConfig, options, mcp,
    async open(overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}, profile?: PersonalProfileLock) { const { directory: _directory, ...defaults } = options; return current = await openPersonalHarness(profile ? { ...defaults, ...overrides, profile } : { ...options, ...overrides }); },
  };
}
async function mode(p: PersonalHarness, value: "confirm" | "auto-review" | "full_access") { await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = value; permission.version++; }, context); }
async function first(p: PersonalHarness) { await until(async () => !!(await p.mcp!.list()).items.length); return (await p.mcp!.list()).items[0].operation; }
async function record(p: PersonalHarness, operation: TaskId) { return (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!; }
async function details(p: PersonalHarness, operation: TaskId) {
  let text = "", offset = 0;
  do { const page = await p.mcp!.detail(operation, offset); assert.ok(page.text.length <= 3072); text += page.text; offset = page.nextOffset ?? -1; } while (offset >= 0);
  return JSON.parse(text) as { definition: McpRemoteTool; arguments: Record<string, unknown>; request?: string; response?: string; result?: Record<string, unknown>; remoteError?: Record<string, unknown>; code: string; remoteEnded: boolean };
}

const MCP_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
for (const variant of ["pure", "mixed", "error", "invalid", "disk"] as const) {
  test(`durable MCP 图片：${variant} 保留原动作事实与原生工具图片，重开不重发`, { timeout: 20000 }, async t => {
    const image = { type: "image", data: variant === "invalid" ? "aGVsbG8=" : MCP_PNG, mimeType: "image/png" };
    const content = variant === "mixed" ? [{ type: "text", text: "图前" }, image, { type: "text", text: "图间" }, image, { type: "text", text: "图后" }] : [image];
    const server = await remote(t, () => ({ result: { content, isError: variant === "error" } })), f = await fixture(t, server);
    const provider = personalProvider({ ...f.modelConfig, imageInput: true });
    let p = await f.open({ provider }); await mode(p, "full_access");
    if (variant === "disk") fs.writeFileSync(path.join(f.directory, "artifacts"), "blocked", { mode: 0o600 });
    const answer = await p.answer(invocation(), "image-call");
    const operation = await first(p), saved = await record(p, operation), failed = variant === "invalid" || variant === "disk";
    assert.equal(saved.effect, "returned"); assert.equal(saved.remoteEnded, true);
    assert.equal(saved.code, variant === "error" ? "tool_error" : "returned");
    assert.equal(saved.imageProjection?.issues.length, failed ? 1 : 0, JSON.stringify({ answer, saved }));
    assert.equal(saved.imageProjection?.output.filter(part => part.type === "image").length, failed ? 0 : variant === "mixed" ? 2 : 1);
    assert.deepEqual(saved.imageProjection?.output.map(part => part.type), failed ? ["text"] : content.map(part => part.type));
    const detail = await details(p, operation);
    assert.ok(!JSON.stringify(detail).includes(MCP_PNG), "模型分页证据不能含图片 base64 文本");
    if (!failed) assert.ok(JSON.stringify(f.model.calls.at(-1)!.raw).includes(`data:image/png;base64,${MCP_PNG}`), answer);
    else assert.ok(JSON.stringify(f.model.calls.at(-1)!.raw).includes("勿因缺图重试原动作"));
    const requests = await p.harness.commit(async tx => (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 256)).items.filter(entry => entry.kind === "ruukoto.model-request"), context);
    assert.ok(!JSON.stringify(requests).includes(MCP_PNG), "实际模型请求证据只保存可重建的引用");
    if (!failed) assert.ok(JSON.stringify(requests).includes("ruukotoImage"));
    const task = await p.harness.commit(tx => tx.task(operation), context);
    assert.equal(task!.kind, "pi.tool");
    assert.equal(task!.state.status, "terminal");
    assert.ok(task!.state.status === "terminal");
    const result = task!.state.outcome.result;
    assert.ok(result && typeof result === "object" && !Array.isArray(result) && typeof result.entryId === "number");
    const entry = await p.harness.commit(tx => tx.entry(result.entryId as EntryId), context);
    assert.equal(entry!.model?.find(message => message.role === "toolResult")?.isError, failed || variant === "error");
    if (variant === "disk") fs.unlinkSync(path.join(f.directory, "artifacts"));
    await p.close(); p = await f.open({ provider });
    await p.answer("描述原图", "after-reopen");
    if (!failed) assert.ok(JSON.stringify(f.model.calls.at(-1)!.raw).includes(`data:image/png;base64,${MCP_PNG}`));
    assert.equal(server.calls.length, 1);
    await p.harness.commit(async tx => { const value = (await tx.doc(PersonalMcpDoc, String(operation), null)).operation!; value.imageProjection!.issues.push("tampered"); }, context);
    await p.close();
    await assert.rejects(f.open({ provider }), code("mcp_record_invalid"));
  });
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
  assert.equal(detail.request, undefined); assert.deepEqual(detail.arguments, { value: "原参数" });
  assert.equal(detail.response, undefined); assert.deepEqual(detail.result, result); assert.equal(detail.remoteEnded, true);
  assert.equal(server.calls.length, 1);
  const saved = await record(p, answer.operation), task = await p.harness.commit(tx => tx.task(answer.operation), context);
  assert.equal(task!.kind, "pi.tool"); assert.equal(task!.owner, saved.origin.generation);
  assert.deepEqual(saved.config, f.mcp);
  await p.close(); const reopened = await f.open();
  assert.deepEqual(await details(reopened, answer.operation), detail); assert.equal(server.calls.length, 1);
});

test("durable MCP：已完成旧历史显式迁入后逐服务启停，原接纳和响应跨重启保留", { timeout: 20000 }, async t => {
  const server = await remote(t), f = await fixture(t, server);
  await savePersonalMcp(f.directory, f.mcp);
  let p = await f.open(); await mode(p, "full_access");
  const answer = JSON.parse(await p.answer(invocation(), "old-call")) as { operation: TaskId };
  const original = await record(p, answer.operation), originalDetail = await details(p, answer.operation);
  await p.close();
  await migratePersonalMcp(f.directory);
  const lock = lockPersonalProfile(f.directory);
  const migrated = readPersonalMcp(lock)!;
  lock.release();
  p = await f.open({ mcp: migrated });
  assert.deepEqual(await record(p, answer.operation), original);
  assert.deepEqual(await details(p, answer.operation), originalDetail);
  await p.close();
  const disabled = parsePersonalMcp({ ...migrated, generation: "disabled", services: [
    { ...migrated.services[0], enabled: false }, { ...migrated.services[0], id: "other", enabled: true },
  ] });
  await savePersonalMcp(f.directory, disabled);
  p = await f.open({ mcp: disabled });
  const definitions = JSON.parse(await p.answer("definitions", "disabled-definitions")) as { tools: { service: string }[] };
  assert.deepEqual(definitions.tools.map(tool => tool.service), ["other"]);
  const requests = server.requests.length;
  assert.match(await p.answer(invocation(), "disabled-call"), /mcp_tool_unavailable/);
  assert.equal(server.requests.length, requests);
  assert.equal((await p.mcp!.list()).items.length, 1);
  assert.deepEqual(await record(p, answer.operation), original);
  await p.close();
  p = await f.open({ mcp: f.mcp });
  assert.deepEqual((await p.harness.snapshot(PersonalMcpConfigDoc, context))!.config!.services, disabled.services);
  await p.close();
  const enabled = parsePersonalMcp({ ...disabled, generation: "enabled-again", services: disabled.services.map(service => ({ ...service, enabled: true })) });
  await savePersonalMcp(f.directory, enabled);
  p = await f.open({ mcp: enabled });
  await p.answer(invocation(), "enabled-call");
  assert.equal(server.calls.length, 2);
  assert.deepEqual(await record(p, answer.operation), original);
  await p.close(); p = await f.open({ mcp: enabled });
  assert.deepEqual(await details(p, answer.operation), originalDetail);
  assert.equal(server.calls.length, 2);
});

test("durable MCP：独立拥有者工作可用同端点别名，原未知事实保留", { timeout: 20000 }, async t => {
  const server = await remote(t, () => undefined), f = await fixture(t, server);
  const mcp = parsePersonalMcp({ ...f.mcp, services: [f.mcp.services[0], { ...f.mcp.services[0], id: "alias", endpoint: server.endpoint + "?alias=1" }] });
  const p = await f.open({ mcp, mcpTimeouts: { callTimeoutMs: 30 } }); await mode(p, "full_access");
  await p.answer(invocation(), "original");
  const original = await record(p, await first(p));
  assert.equal(original.remoteEnded, false); assert.equal(server.calls.length, 1);
  await p.answer(`mcp:${JSON.stringify({ service: "alias", tool: "act", arguments: { value: "另一来源" } })}`, "independent-alias");
  assert.equal(server.calls.length, 2);
  assert.equal((await p.mcp!.list()).items[0].effect, "effect_unknown");
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
  const response = detail.remoteError ? { error: detail.remoteError } : { result: detail.result };
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
  else server.tools[0].inputSchema = { type: "object", properties: { value: { type: "number" } }, required: ["value"] };
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
  assert.equal("requestRecheck" in p.mcp!, false);
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
          if (writes.some(write => write.type === 'entry' && write.value.kind === 'ruukoto.mcp-result' && write.value.data.result)) {
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

test("durable MCP：未知HTTP调用不阻止更新，原版本和待核实效果保留且不重发", { timeout: 20000 }, async t => {
  const server = await remote(t, () => undefined), f = await fixture(t, server);
  let p = await f.open({ mcpTimeouts: { callTimeoutMs: 50 } }); await mode(p, "full_access");
  await p.answer(invocation(), "terminal-main"); const operation = await first(p);
  const inspected = await p.harness.inspect(context);
  assert.equal(inspected.tasks.length, 0); assert.equal(inspected.submissions.length, 0);
  assert.equal((await record(p, operation)).effect, "effect_unknown");
  const original = await record(p, operation);
  const next = parsePersonalMcp({ ...f.mcp, generation: "second-generation", services: f.mcp.services.map(service => ({ ...service, tools: service.tools.map(tool => ({ ...tool, description: "候选定义" })) })) });
  await p.close();
  await savePersonalMcp(f.directory, next);
  p = await f.open({ mcp: next });
  const index = await p.harness.snapshot(PersonalConfigurationDoc, context);
  const receipt = (await p.harness.snapshot(PersonalSettingsOperationDoc, index!.operations.at(-1)!, context))!.operation!.receipt;
  assert.equal(receipt.status, "active");
  assert.equal((await p.harness.snapshot(PersonalMcpConfigDoc, context))!.config!.services[0].tools[0].description, "候选定义");
  assert.deepEqual(await record(p, operation), original);
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
  await p.mcp!.end(operation);
  await p.harness.waitForTask(saved.origin.work!.ref.taskId, context);
  await p.harness.waitForTask((await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.report!.taskId, context);
  assert.equal(summaryCalls().length, 1);
  assert.equal((await p.harness.commit(tx => personalReportResult(tx, group), context)).delivery, "local");
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

test("durable MCP：read 免批准，读取中断无写效果；描述变化兼容而参数 schema 变化拒绝", { timeout: 20000 }, async t => {
  const server = await remote(t, call => call.params?.arguments?.value === "interrupt" ? undefined : { result: { content: [{ type: "text", text: "只读结果" }] } }), f = await fixture(t, server);
  const mcp = parsePersonalMcp({ ...f.mcp, services: f.mcp.services.map(service => ({ ...service, toolEffects: { act: "read" } })) });
  server.tools[0].description = "更新说明，不改变参数";
  const p = await f.open({ mcp, mcpTimeouts: { callTimeoutMs: 40 } }); await mode(p, "confirm");
  await p.answer(invocation(), "read-confirm");
  let saved = await record(p, await first(p));
  assert.equal(saved.localEffect, "read"); assert.equal(saved.decisionEntry, undefined); assert.equal(saved.effect, "returned");
  await mode(p, "auto-review"); await p.answer(invocation("interrupt"), "read-auto");
  saved = await record(p, await first(p));
  assert.equal(saved.localEffect, "read"); assert.equal(saved.code, "read_failed"); assert.equal(saved.effect, "no_write");
  assert.equal(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "read-auto"), context), undefined);
  await p.close(); await f.open({ mcp });
  assert.equal(server.calls.length, 2);
});

test("durable MCP：异步开始持久化超过调用期限，提交后不首次发送工具", { timeout: 20000 }, async t => {
  const server = await remote(t), f = await fixture(t, server);
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { entered = resolve; });
  const p = await f.open({ mcpTimeouts: { callTimeoutMs: 25 }, openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = async (writes, context) => { if (writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.mcp-start")) { entered(); await gate; } return commit(writes, context); };
    return storage;
  } });
  await mode(p, "full_access");
  const answer = p.answer(invocation(), "slow-start");
  await inside; await delay(40); release(); await answer;
  assert.equal(server.calls.length, 0);
  const saved = await record(p, await first(p));
  assert.equal(saved.started, true); assert.equal(saved.effect, "not_executed"); assert.equal(saved.code, "timeout");
  assert.equal(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "slow-start"), context), undefined);
});

test("durable MCP：开始持久化期间凭据文件替换，最终解析拒绝且零业务发送", { timeout: 20000 }, async t => {
  const server = await remote(t), f = await fixture(t, server), filename = path.join(f.root, "token");
  fs.writeFileSync(filename, "original-token\n", { mode: 0o600 }); f.mcp.services[0].credential = personalMcpCredential(filename);
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { entered = resolve; });
  const p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = async (writes, context) => { if (writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.mcp-start")) { entered(); await gate; } return commit(writes, context); };
    return storage;
  } });
  await mode(p, "full_access"); const answer = p.answer(invocation(), "credential-commit-gap");
  await inside; fs.writeFileSync(filename, "replacement-token\n"); release(); await answer;
  const saved = await record(p, await first(p));
  assert.equal(server.calls.length, 0); assert.equal(saved.started, true); assert.equal(saved.effect, "not_executed"); assert.equal(saved.code, "auth_failed");
  await p.close(); await f.open(); assert.equal(server.calls.length, 0);
});

test("durable MCP：待批准调用兼容说明变更，连续执行配置 A→B→A 不复活原批准", { timeout: 20000 }, async t => {
  const server = await remote(t), f = await fixture(t, server); await savePersonalMcp(f.directory, f.mcp);
  const profile = lockPersonalProfile(f.directory), p = await f.open({}, profile); await mode(p, "confirm");
  const { dispatchPersonalSettings, readPersonalSettings } = await import("../apps/ruukoto/src/personal-settings.ts");
  const save = async (service: Record<string, unknown>) => {
    const snapshot = await readPersonalSettings(profile);
    return dispatchPersonalSettings({ profile, instance: p }, { v: 2, id: (await import("node:crypto")).randomUUID(), profile: snapshot.profile, expectedRevision: snapshot.revisions.mcp, op: { kind: "mcp.save-service", service: { id: "test", ...service } } }) as Promise<{ status: string }>;
  };
  let answer = p.answer(invocation(), "metadata-compatible"), operation = await first(p);
  assert.equal((await save({ label: "改后的显示名", tools: server.tools.map(tool => ({ ...tool, description: "新说明" })) })).status, "active");
  assert.equal(p.isSettingsSuspended("mcp", "test"), false); assert.equal((await record(p, operation)).observation, undefined);
  await p.mcp!.decide(operation, "approved"); await answer; assert.equal(server.calls.length, 1);
  answer = p.answer(invocation(), "aba-original"); await until(async () => (await first(p)) !== operation); operation = await first(p);
  assert.equal((await save({ toolEffects: { act: "write" } })).status, "active"); await answer;
  assert.equal((await save({ toolEffects: { act: "unknown" } })).status, "active");
  const stale = await record(p, operation); assert.equal(stale.started, false); assert.equal(stale.effect, "not_executed"); assert.equal(stale.code, "mcp_config_changed");
  await assert.rejects(p.mcp!.decide(operation, "approved"), code("mcp_decision_invalid")); assert.equal(server.calls.length, 1);
});

test("durable MCP：混合旧图片和未知记录可打开、人工收尾和显式迁入，原历史字节不改", { timeout: 20000 }, async t => {
  const { legacyMcpFixture } = await import("./helpers/personal-mcp-legacy.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const server = await remote(t, call => call.params?.arguments?.value === "legacy-image" ? { result: { isError: true, content: [{ type: "image", data: MCP_PNG, mimeType: "image/png" }] } } : undefined), f = await fixture(t, server);
  let p = await f.open({ provider: personalProvider({ ...f.modelConfig, imageInput: true }), mcpTimeouts: { callTimeoutMs: 40 } }); await mode(p, "full_access");
  await p.answer(invocation("legacy-image"), "legacy-image"); const image = await record(p, await first(p));
  await p.answer(invocation("legacy-unknown"), "legacy-unknown"); const unknown = await record(p, await first(p));
  await p.close();
  const legacy = await legacyMcpFixture(f.directory, [image, unknown], server.calls);
  p = await f.open({ mcp: legacy.config, provider: personalProvider({ ...f.modelConfig, imageInput: true }) });
  assert.equal((await record(p, image.operation)).recordVersion, undefined);
  assert.equal((await record(p, image.operation)).imageProjection?.output[0].type, "image");
  await p.mcp!.end(unknown.operation); await p.close();
  await savePersonalMcp(f.directory, legacy.config); await migratePersonalMcp(f.directory);
  p = await f.open({ provider: personalProvider({ ...f.modelConfig, imageInput: true }) });
  assert.equal((await p.harness.snapshot(PersonalMcpConfigDoc, context))!.config!.version, 4);
  assert.equal((await record(p, unknown.operation)).effect, "effect_unknown");
  assert.equal(server.calls.length, 2);
  await p.close();
  const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
  try { const entry = db.prepare("SELECT record FROM entries WHERE id = ?"); for (const original of legacy.historical) assert.equal(entry.get(original.id)?.record, original.record); }
  finally { db.close(); }
});

test("durable MCP：同路径显式轮换结算原待批准调用为未执行，新工作使用新配置", { timeout: 20000 }, async t => {
  const server = await remote(t), f = await fixture(t, server), filename = path.join(f.root, "token");
  fs.writeFileSync(filename, "first-token\n", { mode: 0o600 }); f.mcp.services[0].credential = personalMcpCredential(filename);
  await savePersonalMcp(f.directory, f.mcp);
  const profile = lockPersonalProfile(f.directory), p = await f.open({}, profile); await mode(p, "confirm");
  const answer = p.answer(invocation(), "waiting-rotation"), operation = await first(p);
  assert.equal((await record(p, operation)).decision, "pending"); assert.equal(server.calls.length, 0);
  fs.writeFileSync(filename, "second-token\n");
  const { dispatchPersonalSettings, readPersonalSettings } = await import("../apps/ruukoto/src/personal-settings.ts");
  const snapshot = await readPersonalSettings(profile);
  const receipt = await dispatchPersonalSettings({ profile, instance: p }, { v: 2, id: (await import("node:crypto")).randomUUID(), profile: snapshot.profile, expectedRevision: snapshot.revisions.mcp, op: { kind: "mcp.save-service", service: { id: "test", credentialPath: filename, credentialRebind: true } } }) as { status: string };
  assert.equal(receipt.status, "active"); await answer;
  const stale = await record(p, operation);
  assert.equal(stale.started, false); assert.equal(stale.effect, "not_executed"); assert.equal(stale.code, "mcp_config_changed");
  await assert.rejects(p.mcp!.decide(operation, "approved"), code("mcp_decision_invalid")); assert.equal(server.calls.length, 0);
  const freshAnswer = p.answer(invocation(), "after-rotation");
  await until(async () => (await p.mcp!.list()).items[0].operation !== operation);
  const fresh = (await p.mcp!.list()).items[0].operation;
  await p.mcp!.decide(fresh, "approved"); await freshAnswer;
  assert.equal(server.calls.length, 1);
  assert.notDeepEqual((await record(p, fresh)).config.services[0].credential, stale.config.services[0].credential);
});

for (const decision of ["pending", "approved"] as const) test(`durable MCP：旧 ${decision} 未开始调用经显式 v4 迁入结算，原接纳和批准字节保留且零发送`, { timeout: 20000 }, async t => {
  const { legacyMcpFixture } = await import("./helpers/personal-mcp-legacy.ts"), { DatabaseSync } = await import("node:sqlite");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { entered = resolve; });
  const server = await remote(t, undefined, async () => { entered(); await gate; }), f = await fixture(t, server);
  let p = await f.open(); await mode(p, "confirm");
  const answer = p.answer(invocation(), "legacy-pending").catch(() => undefined), operation = await first(p);
  if (decision === "approved") { await p.mcp!.decide(operation, "approved"); await inside; }
  const original = await record(p, operation); assert.equal(original.started, false); assert.equal(original.decision, decision);
  await p.close(); release(); await answer;
  const legacy = await legacyMcpFixture(f.directory, [original], []);
  await savePersonalMcp(f.directory, legacy.config);
  const profile = lockPersonalProfile(f.directory); p = await f.open({ mcp: legacy.config }, profile);
  assert.equal((await record(p, operation)).recordVersion, undefined); assert.equal(server.calls.length, 0);
  const { dispatchPersonalSettings, readPersonalSettings } = await import("../apps/ruukoto/src/personal-settings.ts"), snapshot = await readPersonalSettings(profile);
  const receipt = await dispatchPersonalSettings({ profile, instance: p }, { v: 2, id: (await import("node:crypto")).randomUUID(), profile: snapshot.profile, expectedRevision: snapshot.revisions.mcp, op: { kind: "mcp.migrate" } }) as { status: string };
  assert.equal(receipt.status, "active");
  const settled = await record(p, operation); assert.equal(settled.started, false); assert.equal(settled.effect, "not_executed"); assert.equal(settled.code, "mcp_config_changed"); assert.ok(settled.observation);
  await assert.rejects(p.mcp!.decide(operation, "approved"), code("mcp_decision_invalid")); assert.equal(server.calls.length, 0);
  await p.close(); p = await f.open(); assert.equal((await record(p, operation)).effect, "not_executed"); assert.equal(server.calls.length, 0); await p.close();
  const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
  try { const entry = db.prepare("SELECT record FROM entries WHERE id = ?"); for (const original of legacy.historical) assert.equal(entry.get(original.id)?.record, original.record); }
  finally { db.close(); }
});

test("durable MCP：非终结远端结果按原 JSON 保存，保持未知并不重发", { timeout: 20000 }, async t => {
  const result = { task: { taskId: "remote-task" }, resultType: "input_required", content: [{ type: "text", text: "原远端任务句柄" }] };
  const server = await remote(t, () => ({ result })), f = await fixture(t, server);
  let p = await f.open(); await mode(p, "full_access"); await p.answer(invocation(), "remote-task");
  const operation = await first(p), saved = await record(p, operation);
  assert.deepEqual(saved.result, result); assert.equal(saved.effect, "effect_unknown"); assert.equal(saved.remoteEnded, false); assert.equal(saved.code, "result_incomplete");
  await p.close(); p = await f.open(); assert.deepEqual((await record(p, operation)).result, result); assert.equal(server.calls.length, 1);
});

test("durable MCP：原会话 HTTP404 拒绝记为未执行，已接纳后丢答仍未知且不重发", { timeout: 20000 }, async t => {
  const server = await remote(t, call => call.params?.arguments?.value === "refused" ? { httpStatus: 404 } : undefined, undefined, "original-session"), f = await fixture(t, server);
  let p = await f.open({ mcpTimeouts: { callTimeoutMs: 40 } }); await mode(p, "full_access");
  await p.answer(invocation("refused"), "session-refused"); const refused = await first(p), firstResult = await record(p, refused);
  assert.equal(firstResult.started, true); assert.equal(firstResult.effect, "not_executed"); assert.equal(firstResult.code, "session_expired"); assert.equal(firstResult.remoteEnded, false);
  assert.equal(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "session-refused"), context), undefined);
  await p.answer(invocation("accepted"), "accepted-no-answer"); const accepted = await first(p), secondResult = await record(p, accepted);
  assert.equal(secondResult.started, true); assert.equal(secondResult.effect, "effect_unknown"); assert.equal(secondResult.remoteEnded, false);
  assert.ok(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "accepted-no-answer"), context)); assert.equal(server.calls.length, 2);
  await p.close(); p = await f.open(); assert.equal((await record(p, refused)).effect, "not_executed"); assert.equal((await record(p, accepted)).effect, "effect_unknown"); assert.equal(server.calls.length, 2);
});
