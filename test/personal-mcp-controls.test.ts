import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { mcpList, mcpOriginal, mcpOperations, mcpUnresolved, PersonalMcpDoc } from "../apps/ruukoto/src/personal-mcp.ts";
import { verifyMcpControls } from "../apps/ruukoto/src/personal-mcp-controls.ts";
import { discoverPersonalMcp, readPersonalMcp, savePersonalMcp, type PersonalMcpConfig } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { configurePersonalMcp, managePersonalMcp } from "../apps/ruukoto/src/personal-mcp-cli.ts";
import { personalControl, readPersonalToken, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer as MockModelServer } from "./helpers/mock-provider.ts";
import { startMockMcp } from "./helpers/mock-mcp.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => boolean | Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < deadline, "等待 MCP 控制超时"); await delay(5); } }
function directory(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-mcp-ui-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t: TestContext, unknown = false) {
  const dir = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-mcp-tg-"));
  const mcp = await startMockMcp({ ...(unknown ? { dropOnCall: true } : {}), tools: [{ name: "write", result: { content: [{ type: "text", text: "原响应".repeat(1400) }] } }] });
  const target = { id: "owner-service", label: "拥有者文档服务", endpoint: mcp.url };
  const mcpConfig: PersonalMcpConfig = { version: 1, generation: randomUUID(), services: [{ ...target, tools: await discoverPersonalMcp(target) }] };
  const model = new MockModelServer((_request, index) => index === 0 ? { kind: "tool_calls", calls: [{ id: "original-call", name: "mcp_call", arguments: { service: target.id, tool: "write", arguments: {} } }] } : { kind: "text", text: "已核对原响应" });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_MCP_UI_MODEL_KEY", contextWindow: 128000, maxTokens: 4096 };
  const bot = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.end(JSON.stringify({ ok: true, result: { message_id: ++sent, chat: { id: 456, type: "private" } } }));
  });
  let sent = 1000;
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  const telegram: PersonalTelegramConfig = { version: 1, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "RUUKOTO_MCP_UI_BOT_KEY", tokenDigest: createHash("sha256").update("123:test-token").digest("hex"), botId: "123", ownerId: "456", boundary: 0 };
  const previous = [process.env[config.apiKeyEnv], process.env[telegram.tokenEnv]];
  process.env[config.apiKeyEnv] = "test-only"; process.env[telegram.tokenEnv] = "123:test-token";
  let p: PersonalHarness | undefined;
  t.after(async () => { await p?.close(); bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); await model.close(); await mcp.close(); fs.rmSync(dir, { recursive: true, force: true }); for (const [index, key] of [config.apiKeyEnv, telegram.tokenEnv].entries()) { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; } });
  p = await openPersonalHarness({ directory: dir, provider: personalProvider(config), modelId: config.modelId, telegram, mcp: mcpConfig });
  const keys: string[] = [];
  let messageId = 0;
  async function receive(text: string, replyTo?: number, extra: Record<string, unknown> = {}, settle = true) {
    const id = ++messageId;
    const update: TelegramUpdate = { update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }), ...extra } };
    await p!.telegram.receive(update);
    const key = `telegram:123:456:${id}`; keys.push(key);
    const receipt = (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    if (settle) await p!.harness.waitForTask(receipt.taskId, context);
    const value = (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    return { key, value, sentId: Number(value.platformMessageId), update };
  }
  const owner = await receive("执行 MCP 写入", undefined, {}, false);
  await until(async () => (await p!.harness.commit(tx => mcpOperations(tx), context)).length === 1);
  const operation = await p.harness.commit(async tx => (await mcpOperations(tx))[0].operation, context);
  return { p, mcp, model, config, telegram, operation, owner, keys, receive };
}

test("MCP 未装配：宿主只回复配置指引，不能登记恢复时无效的菜单", async t => {
  const f = await fixture(t), dir = directory(t);
  const options = { directory: dir, provider: personalProvider(f.config), modelId: f.config.modelId, telegram: f.telegram };
  let empty = await openPersonalHarness(options);
  t.after(async () => { await empty.close(); });
  const calls = f.model.calls.length;
  await empty.telegram.receive({ update_id: 1, message: { message_id: 1, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text: "/MCP" } });
  const received = (await empty.harness.snapshot(PersonalTelegramReceiptDoc, "telegram:123:456:1", context))!.receipt!;
  await empty.harness.waitForTask(received.taskId, context);
  const receipt = (await empty.harness.snapshot(PersonalTelegramReceiptDoc, received.requestId, context))!.receipt!;
  assert.match(receipt.reply!, /MCP 尚未装配/); assert.equal(receipt.selection, undefined); assert.equal(f.model.calls.length, calls);
  await empty.close(); empty = await openPersonalHarness(options);
  assert.equal((await empty.harness.snapshot(PersonalTelegramReceiptDoc, receipt.requestId, context))!.receipt!.selection, undefined);
});

test("MCP 原入口控制：原宿主菜单批准只消费一次，转发、引用、错回复与代次不能审批", async t => {
  const f = await fixture(t);
  const list = await f.receive("/MCP"); const menu = await f.receive("MCP1", list.sentId);
  assert.match(menu.value.reply!, /MCP批准本次/);
  const calls = f.model.calls.length;
  for (const [replyTo, extra] of [[undefined, {}], [999999, {}], [menu.sentId, { forward_origin: { type: "user" } }], [menu.sentId, { quote: { text: "MCP批准本次" } }], [menu.sentId, { reply_to_message: { message_id: menu.sentId, from: { id: 789, is_bot: true } } }]] as const) {
    const rejected = await f.receive("MCP批准本次", replyTo, extra);
    assert.equal(rejected.value.control, true); assert.equal(rejected.value.mcpDecision, undefined);
  }
  for (const changed of [{ ...f.telegram, platform: "qq" as const }, { ...f.telegram, botId: "789" }, { ...f.telegram, ownerId: "789" }, { ...f.telegram, generation: randomUUID() }]) {
    assert.equal((await f.p.harness.commit(tx => mcpList(tx, 0, changed), context)).items.length, 0);
    await assert.rejects(f.p.harness.commit(tx => mcpOriginal(tx, f.operation, { ...changed, requestId: "wrong-entry" }), context), code("mcp_original_entry"));
  }
  assert.equal(f.model.calls.length, calls); assert.equal(f.mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
  const approved = await f.receive("MCP批准本次", menu.sentId); assert.equal(approved.value.mcpDecision?.operation, f.operation);
  await until(async () => !!(await f.p.harness.snapshot(PersonalMcpDoc, String(f.operation), context))?.operation?.remoteEnded);
  await f.p.harness.waitForTask(f.owner.value.taskId, context);
  await f.p.telegram.receive(approved.update);
  const duplicate = await f.receive("MCP批准本次", menu.sentId); assert.equal(duplicate.value.mcpDecision, undefined);
  assert.equal(f.mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 1);
  let result = await f.receive("刷新MCP", menu.sentId); let pages = 1;
  while (result.value.selection?.kind === "mcp" && result.value.selection.nextOffset !== undefined) { result = await f.receive("下一页MCP原记录", result.sentId); pages++; }
  assert.ok(pages > 1); assert.equal(result.value.selection?.kind, "mcp");
  await f.p.harness.commit(tx => verifyMcpControls(tx, f.keys, true), context);
});

test("MCP 效果核实：原菜单保存业务证据仍不证明远端结束，回链缺失拒绝恢复", async t => {
  const f = await fixture(t, true);
  const list = await f.receive("/MCP"), menu = await f.receive("MCP1", list.sentId);
  await f.receive("MCP批准本次", menu.sentId);
  await until(async () => { const op = (await f.p.harness.snapshot(PersonalMcpDoc, String(f.operation), context))?.operation; return op?.effect === "effect_unknown" && op.code !== "started"; });
  const detail = await f.receive("刷新MCP", menu.sentId);
  const selected = await f.receive("MCP确认已生效", detail.sentId);
  assert.equal(selected.value.selection?.kind, "mcp-resolution");
  const saved = await f.receive("MCP核实说明 远端业务记录已核对", selected.sentId);
  const op = (await f.p.harness.snapshot(PersonalMcpDoc, String(f.operation), context))!.operation!;
  assert.equal(op.resolution?.effect, "applied"); assert.equal(op.remoteEnded, false); assert.equal(mcpUnresolved(op), true);
  assert.equal(f.mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 1);
  assert.match(saved.value.reply!, /人工说明不证明原远端请求已结束/);
  await f.p.harness.commit(tx => verifyMcpControls(tx, f.keys, true), context);
  await f.p.harness.commit(async tx => { delete (await tx.doc(PersonalTelegramReceiptDoc, saved.key, null)).receipt!.mcpResolution; }, context);
  await assert.rejects(f.p.harness.commit(tx => verifyMcpControls(tx, f.keys, true), context), code("mcp_control_invalid"));
});

test("MCP 配置向导：显式匿名、逐项允许工具，服务键和配置代次由程序生成", async t => {
  const dir = directory(t), mcp = await startMockMcp({ tools: [{ name: "allow" }, { name: "exclude" }] }); t.after(() => mcp.close());
  const answers = ["1", "自己的服务", mcp.url, "2", "2", "1", "2"]; let output = "";
  await configurePersonalMcp({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: text => { output += text; } }, dir);
  const profile = lockPersonalProfile(dir);
  try {
    const config = readPersonalMcp(profile)!;
    assert.equal(config.version, 2); assert.equal(config.services[0].enabled, true);
    assert.equal(config.services.length, 1); assert.equal(config.services[0].label, "自己的服务"); assert.equal(config.services[0].credential, undefined);
    assert.deepEqual(config.services[0].tools.map(tool => tool.name), ["allow"]); assert.match(config.generation, /^[0-9a-f-]{36}$/); assert.match(config.services[0].id, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(output, new RegExp(`${config.generation}|${config.services[0].id}`));
  } finally { profile.release(); }
  assert.equal(answers.length, 0); assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
});

test("MCP 配置向导：旧配置经明确选择迁入，启停保留端点与允许项并生成新代次", async t => {
  const dir = directory(t);
  const original: PersonalMcpConfig = { version: 1, generation: "legacy", services: [{ id: "service", label: "原服务", endpoint: "https://mcp.example.test/endpoint", tools: [{ name: "read", inputSchema: { type: "object" } }] }] };
  await savePersonalMcp(dir, original);
  const run = async (answers: string[]) => {
    await configurePersonalMcp({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: () => {} }, dir);
    assert.equal(answers.length, 0);
    const profile = lockPersonalProfile(dir);
    try { return readPersonalMcp(profile)!; } finally { profile.release(); }
  };
  assert.deepEqual(await run(["3", "1"]), original);
  const migrated = await run(["3", "2"]);
  assert.equal(migrated.version, 2); assert.equal(migrated.services[0].enabled, true);
  assert.notEqual(migrated.generation, original.generation);
  const disabled = await run(["2", "4"]);
  assert.notEqual(disabled.generation, migrated.generation);
  assert.deepEqual(disabled.services, migrated.services.map(service => ({ ...service, enabled: false })));
  const enabled = await run(["2", "4"]);
  assert.notEqual(enabled.generation, disabled.generation);
  assert.deepEqual(enabled.services, migrated.services);
});

test("MCP 操作向导：分页固定原操作，批准和效果核实分别提交且不伪造远端结束", async t => {
  const dir = directory(t); fs.writeFileSync(path.join(dir, "control.token"), "a".repeat(64));
  const routes: string[] = []; let approved = false, resolved = false;
  const item = { operation: 12, service: "文档服务", tool: "write", decision: "pending", started: false, remoteEnded: false, effect: "not_executed", canDecide: true, canResolve: false, canRecheck: false };
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${"a".repeat(64)}`); routes.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let result;
    if (req.url === "/mcp/decide?operation=12") { assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { decision: "approved" }); approved = true; result = { saved: true }; }
    else if (req.url === "/mcp/resolve?operation=12") { assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { effect: "applied", evidence: "业务记录已核对" }); resolved = true; result = { saved: true }; }
    else if (req.url?.startsWith("/mcp/operation?")) { const offset = new URL(req.url, "http://localhost").searchParams.get("offset"); result = { summary: { ...item, canDecide: !approved, canResolve: approved && !resolved }, text: offset === "0" ? "原请求" : "原响应", ...(offset === "0" ? { nextOffset: 1200 } : {}) }; }
    else result = { items: resolved ? [] : req.url === "/mcp/operations?offset=0" ? Array(8).fill(item) : [item], ...(!resolved && req.url === "/mcp/operations?offset=0" ? { nextOffset: 8 } : {}) };
    res.end(JSON.stringify({ v: 1, ok: true, result }));
  });
  server.listen(path.join(dir, "control.sock")); await once(server, "listening"); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const answers = ["9", "1", "2", "2", "3", "业务记录已核对", "3", "1"]; let output = "";
  await managePersonalMcp({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: text => { output += text; } }, dir);
  assert.equal(answers.length, 0); assert.equal(approved, true); assert.equal(resolved, true); assert.match(output, /人工说明不证明原远端请求已结束/); assert.doesNotMatch(output, /taskId|UUID/);
  assert.deepEqual(routes, ["GET /mcp/operations?offset=0", "GET /mcp/operations?offset=8", "GET /mcp/operation?operation=12&offset=0", "GET /mcp/operation?operation=12&offset=1200", "POST /mcp/decide?operation=12", "GET /mcp/operation?operation=12&offset=0", "POST /mcp/resolve?operation=12", "GET /mcp/operation?operation=12&offset=0", "GET /mcp/operations?offset=0"]);
});


test("MCP 本机控制：先认证再校验原操作与正文，非法请求不调用模型或远端", async t => {
  const dir = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-mcp-http-"));
  const model = new MockModelServer(() => ({ kind: "text", text: "不应调用" }));
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_MCP_HTTP_MODEL_KEY", contextWindow: 128000, maxTokens: 1024 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  await savePersonalConfig(dir, config);
  await savePersonalMcp(dir, { version: 2, generation: "disabled", services: [{ id: "disabled", label: "已停用服务", endpoint: "https://mcp.example.test/endpoint", tools: [], enabled: false }] });
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  t.after(async () => { await server?.stop(); await model.close(); fs.rmSync(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; });
  server = await startPersonalServer(dir);
  assert.equal((await personalControl<{ capabilities: { mcp: boolean } }>(dir, "GET", "/status")).capabilities.mcp, false);
  const raw = (method: string, route: string, body?: string, token?: string) => new Promise<{ code: string }>((resolve, reject) => {
    const req = http.request({ socketPath: path.join(dir, "control.sock"), method, path: route, headers: token ? { authorization: `Bearer ${token}` } : {} }, res => { let text = ""; res.on("data", chunk => { text += String(chunk); }); res.on("end", () => resolve(JSON.parse(text))); });
    req.on("error", reject); req.end(body);
  });
  for (const [method, route] of [["GET", "/mcp/operations"], ["GET", "/mcp/operation?operation=1"], ["POST", "/mcp/decide?operation=1"], ["POST", "/mcp/resolve?operation=1"], ["POST", "/mcp/recheck?operation=1"]]) assert.equal((await raw(method, route, "invalid")).code, "control_unauthorized");
  const token = readPersonalToken(dir);
  assert.equal((await raw("POST", "/mcp/decide?operation=1", JSON.stringify({ decision: "approved", extra: true }), token)).code, "mcp_decision_invalid");
  assert.equal((await raw("POST", "/mcp/resolve?operation=1", JSON.stringify({ effect: "applied", evidence: "说明", remoteEnded: true }), token)).code, "mcp_resolution_invalid");
  await assert.rejects(personalControl(dir, "GET", "/mcp/operation?operation=0"), code("mcp_input_invalid"));
  await assert.rejects(personalControl(dir, "GET", "/mcp/operations?offset=-1"), code("work_input_invalid"));
  assert.deepEqual(await personalControl(dir, "GET", "/mcp/operations"), { items: [] }); assert.equal(model.calls.length, 0);
});
