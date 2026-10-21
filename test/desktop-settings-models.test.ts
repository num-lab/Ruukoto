import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { ControlClientError, type ControlClient } from "@ruukoto/control/client.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import type { ModelSelection } from "@ruukoto/core/types.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { CODE_MODEL_OPS, handleRequest } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge } from "../apps/desktop/src/shared/bridge.ts";
import { CodeModelsState } from "../apps/desktop/src/renderer/code-models-state.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { cleanupDirs, connectAuthedClient, makeTestDirs, waitFor, writeModelsJson } from "./helpers/testkit.ts";

const primary: ModelSelection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
const secondary: ModelSelection = { provider: "second", modelId: "reasoner", thinkingLevel: "high" };
const secrets = ["mock-key", "provider-header-secret", "model-header-secret", "override-header-secret", "second-key"];

test("Code 模型管理操作不向旧 Personal 控制连接放行", async () => {
  for (const op of CODE_MODEL_OPS) {
    let forwarded = false;
    const result = await handleRequest("personal", op, {}, async () => {}, async () => { forwarded = true; });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "op_not_allowed");
    assert.equal(forwarded, false);
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, responder: Responder = () => ({ kind: "text", text: "ok" })) {
  const { dirs, work } = await makeTestDirs("desktop-settings-models", 1);
  const server = new MockModelServer(responder);
  let runtime: Runtime | undefined, client: ControlClient | undefined;
  t.after(async () => { client?.close(); await runtime?.stop("test_end"); await server.close(); await cleanupDirs(dirs); });
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  const file = path.join(dirs.agentDir, "models.json");
  const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
  catalog.providers.mock.headers = { "x-provider-key": secrets[1] };
  catalog.providers.mock.models[0].headers = { "x-model-key": secrets[2] };
  catalog.providers.mock.modelOverrides = { "mock-model": { headers: { "x-override-key": secrets[3] } } };
  catalog.providers.second = { ...catalog.providers.mock, apiKey: secrets[4], models: [{ ...catalog.providers.mock.models[0], id: "reasoner", name: "Reasoner", reasoning: true, maxTokens: 4096 }] };
  fs.writeFileSync(file, JSON.stringify(catalog));
  runtime = await Runtime.start({ product: product.runtime, dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"), toolFactory: context => createMockTools(context) });
  await ControlServer.start(runtime);
  client = await connectAuthedClient(runtime);
  const backend = runtime, transport = client;
  const requests: { op: string; params: Record<string, unknown> }[] = [];
  const hook: { before?: (op: string) => Promise<void>; after?: (op: string) => Promise<void> } = {};
  const bridge: Pick<DesktopBridge, "request"> = { request: (target, op, params) => handleRequest(target, op, params, async () => {}, async (name, input) => {
    requests.push({ op: name, params: structuredClone(input) });
    await hook.before?.(name);
    const result = await transport.request(name, input);
    await hook.after?.(name);
    return result;
  }) };
  const code = new CodeState(bridge, () => {});
  code.update({ type: "snapshot", result: await transport.handshake(), instanceChanged: false });
  code.update({ type: "state", state: "online" });
  const context = { instanceId: code.view.instanceId, online: true };
  const createState = () => new CodeModelsState(bridge, () => {}, code.view.instanceId!, () => context);
  const state = createState();
  await state.read();
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const config = () => transport.request<OpResult<"get_model_config">>("get_model_config", {});
  return { dirs, work, server, baseUrl, runtime: backend, client: transport, bridge, code, context, state, createState, file, read, config, requests, hook };
}

function assertRedacted(value: unknown, additional: string[] = []) {
  const text = JSON.stringify(value);
  for (const secret of [...secrets, ...additional]) assert.ok(!text.includes(secret), `不能回显 ${secret}`);
}

function catalogModels(providers: Record<string, Record<string, unknown>>, provider = "mock"): Record<string, unknown>[] {
  const models = providers[provider].models;
  assert.ok(Array.isArray(models));
  return models;
}

test("Desktop 模型目录经真实 IPC 保存，保留高级字段与各层秘密占位，重开读回且不发模型请求", async t => {
  const h = await fixture(t);
  const { state } = h;
  assert.equal(state.view?.providers.mock.apiKey, true);
  assert.deepEqual(state.view?.providers.mock.headers, { "x-provider-key": true });
  assertRedacted(state.view);
  const original = h.read();
  state.selectProvider("mock"); state.selectModel(0);
  state.editModel("name", "Renamed"); state.editModel("contextWindow", 123456);
  assert.equal(state.dirty, true);
  assert.equal(await state.save(), true, state.message);
  const saved = h.read();
  const expected = structuredClone(original);
  expected.providers.mock.models[0].name = "Renamed";
  expected.providers.mock.models[0].contextWindow = 123456;
  assert.deepEqual(saved, expected);
  assert.equal(state.dirty, false);
  assert.notEqual(state.view?.revision, h.requests.find(request => request.op === "save_model_catalog")?.params.expected_revision);
  const reopened = h.createState(); await reopened.read();
  assert.equal(catalogModels(reopened.draft)[0].name, "Renamed");
  assertRedacted([reopened.view, reopened.draft, state.message]);
  assert.equal(h.server.calls.length, 0, "读取与保存不等于显式连接测试");
});

test("Desktop 提供方和模型增改删走既有目录操作", async t => {
  const h = await fixture(t);
  const { state } = h;
  state.addProvider("third");
  state.editProvider("baseUrl", h.baseUrl); state.editProvider("api", "openai-completions");
  state.editSecret({ scope: "provider", field: "apiKey" }, "third-key");
  state.addModel("third-model"); state.editModel("name", "Third");
  assert.equal(await state.save(), true, state.message);
  assert.equal(h.read().providers.third.models[0].id, "third-model");
  state.addModel("spare"); assert.equal(await state.save(), true, state.message);
  state.selectModel(1); await state.removeModel();
  assert.deepEqual(h.read().providers.third.models.map((model: { id: string }) => model.id), ["third-model"]);
  await state.removeProvider();
  assert.equal(h.read().providers.third, undefined);
  assert.equal(h.server.calls.length, 0);
});

test("Desktop 后台默认与摘要分别保存，默认只影响后续会话且摘要可清除", async t => {
  const h = await fixture(t);
  const before = (await h.runtime.openWorkspace({ cwd: h.work[0] })).session;
  h.state.chooseScreen("default"); h.state.selection = { ...secondary };
  assert.equal(await h.state.save(), true, h.state.message);
  assert.deepEqual((await h.config()).defaultModel, secondary);
  assert.deepEqual(h.runtime.getSession(before.id).modelSelection, primary);
  const created = await h.runtime.createSession({ projectId: before.projectId, cwd: before.cwdReal });
  assert.deepEqual(created.modelSelection, secondary);
  h.state.chooseScreen("summary"); h.state.selection = { ...primary };
  assert.equal(await h.state.save(), true, h.state.message);
  assert.deepEqual((await h.config()).summaryModel, { provider: primary.provider, modelId: primary.modelId });
  h.state.selection = null;
  assert.equal(await h.state.save(), true, h.state.message);
  assert.equal((await h.config()).summaryModel, null);
});

test("Desktop 提供方弹窗一次保存目录与存储 Key，按读回后的修订继续且清空秘密", async t => {
  const h = await fixture(t);
  h.state.chooseScreen("default"); h.state.addProvider("dialog-provider");
  assert.equal(h.state.screen, "catalog");
  h.state.editProvider("name", "弹窗提供方"); h.state.editProvider("baseUrl", h.baseUrl);
  h.state.addModel(); h.state.editModel("id", "dialog-model");
  h.state.editStoredSecret("dialog-key");
  const start = h.requests.length;
  assert.equal(await h.state.save(), true, h.state.message);
  const writes = h.requests.slice(start);
  assert.deepEqual(writes.map(request => request.op), ["save_model_catalog", "get_model_config", "set_model_api_key", "get_model_config"]);
  assert.notEqual(writes[0].params.expected_revision, writes[2].params.expected_revision);
  assert.equal(h.read().providers["dialog-provider"].models[0].id, "dialog-model");
  assert.equal((await h.config()).credentials["dialog-provider"].configured, true);
  assert.equal(h.state.secret, ""); assert.equal(h.state.dirty, false);
  assertRedacted([h.state.draft, h.state.view, h.state.pending, h.state.message], ["dialog-key"]);
  assert.equal(h.server.calls.length, 0);
});

test("Desktop 提供方只替换存储 Key 时不重写目录", async t => {
  const h = await fixture(t);
  h.state.selectProvider("mock"); h.state.editStoredSecret("dialog-key-only");
  const original = h.read(), start = h.requests.length;
  assert.equal(await h.state.save(), true, h.state.message);
  assert.deepEqual(h.requests.slice(start).map(request => request.op), ["set_model_api_key", "get_model_config"]);
  assert.deepEqual(h.read(), original);
});

test("Desktop 新提供方允许先填写模型 ID 并省略模型名称与存储凭据", async t => {
  const h = await fixture(t);
  h.state.addProvider("without-key"); h.state.editProvider("baseUrl", h.baseUrl);
  h.state.addModel(); h.state.editModel("id", "unnamed-model");
  assert.equal(await h.state.save(), true, h.state.message);
  assert.equal(h.read().providers["without-key"].models[0].id, "unnamed-model");
  assert.equal(h.requests.filter(request => request.op === "set_model_api_key").length, 0);
});

test("Desktop 提供方目录丢答时不提交后续 Key，核实只读且要求重新输入", async t => {
  const h = await fixture(t);
  h.state.selectProvider("mock"); h.state.editProvider("name", "Committed catalog"); h.state.editStoredSecret("not-submitted-key");
  h.hook.after = async op => { if (op === "save_model_catalog") throw new ControlClientError("request_timeout", "合成丢答", "unknown"); };
  assert.equal(await h.state.save(), false);
  assert.equal(h.state.phase, "unknown"); assert.equal(h.state.secret, "");
  assert.match(h.state.message, /存储 API Key 尚未提交/);
  assert.equal(h.requests.filter(request => request.op === "set_model_api_key").length, 0);
  const pending = h.state.pending;
  h.state.closeProvider();
  assert.equal(h.state.providerId, null); assert.equal(h.state.pending, pending); assert.equal(h.state.phase, "unknown");
  h.hook.after = undefined; await h.state.read();
  assert.equal(h.state.view?.providers.mock.name, "Committed catalog");
  assert.equal(h.requests.filter(request => request.op === "set_model_api_key").length, 0);
  assert.equal(h.state.dirty, false);
});

test("Desktop 提供方目录成功而存储 Key 丢答时保留部分成功，核实不重发", async t => {
  const h = await fixture(t);
  h.state.selectProvider("mock"); h.state.editProvider("name", "Saved first"); h.state.editStoredSecret("committed-key");
  h.hook.after = async op => { if (op === "set_model_api_key") throw new ControlClientError("request_timeout", "合成丢答", "unknown"); };
  assert.equal(await h.state.save(), false);
  assert.equal(h.state.phase, "unknown"); assert.equal(h.state.provider.name, "Saved first");
  assert.match(h.state.message, /模型目录已保存/); assert.equal(h.state.secret, "");
  h.hook.after = undefined; await h.state.read();
  assert.equal(h.requests.filter(request => request.op === "set_model_api_key").length, 1);
  assert.equal(h.state.dirty, false);
  assertRedacted([h.state.view, h.state.draft, h.state.message], ["committed-key"]);
});

test("Desktop 提供方提交中点叉号退出并丢弃草稿，不继续后续 Key 写入", async t => {
  const h = await fixture(t), gate = deferred();
  h.state.selectProvider("mock"); h.state.editProvider("name", "Committed after close"); h.state.editStoredSecret("cancelled-key");
  h.hook.before = async op => { if (op === "save_model_catalog") await gate.promise; };
  const saving = h.state.save();
  assert.equal(h.state.phase, "saving");
  h.state.closeProvider(); assert.equal(h.state.providerId, null); assert.ok(h.state.pending); assert.equal(h.state.secret, "");
  gate.resolve(); assert.equal(await saving, false);
  assert.equal(h.state.providerId, null); assert.equal(h.state.phase, "ready"); assert.equal(h.state.dirty, false);
  assert.equal(h.requests.filter(request => request.op === "set_model_api_key").length, 0);
  assert.equal(h.read().providers.mock.name, "Committed after close");
  assert.match(h.state.message, /存储 API Key 尚未提交/);
});

test("Desktop 跨客户端 revision 冲突保留草稿、显示当前值且不自动重发", async t => {
  const h = await fixture(t);
  h.state.selectProvider("mock"); h.state.selectModel(0); h.state.editModel("name", "Desktop draft");
  const other = await connectAuthedClient(h.runtime); t.after(() => other.close());
  const current = await other.request<OpResult<"get_model_config">>("get_model_config", {});
  catalogModels(current.providers)[0].name = "Other client";
  await other.request("save_model_catalog", { providers: current.providers, expected_revision: current.revision });
  assert.equal(await h.state.save(), false);
  assert.equal(h.state.phase, "conflict");
  assert.equal(catalogModels(h.state.draft)[0].name, "Desktop draft");
  assert.equal(catalogModels(h.state.view!.providers)[0].name, "Other client");
  assert.equal(h.state.dirty, true);
  assert.equal(h.requests.filter(request => request.op === "save_model_catalog").length, 1);
  h.state.discard();
  assert.equal(h.state.dirty, false);
  assert.equal(catalogModels(h.state.draft)[0].name, "Other client");
});

test("Desktop 应答丢失保留原操作，核实失败仍待核实，读回只核实而不重发", async t => {
  const h = await fixture(t);
  h.state.selectProvider("mock"); h.state.selectModel(0); h.state.editModel("name", "Committed without answer");
  h.hook.after = async op => { if (op === "save_model_catalog") throw new ControlClientError("request_timeout", "合成丢答", "unknown"); };
  h.hook.before = async op => { if (op === "get_model_config") throw new ControlClientError("request_timeout", "合成读取失败", "unknown"); };
  await h.state.save();
  assert.equal(h.read().providers.mock.models[0].name, "Committed without answer");
  assert.equal(h.state.phase, "unknown"); assert.ok(h.state.pending);
  await h.state.read(); assert.equal(h.state.phase, "unknown");
  await h.state.save();
  assert.equal(h.requests.filter(request => request.op === "save_model_catalog").length, 1);
  h.hook.before = undefined; h.hook.after = undefined;
  await h.state.read();
  assert.equal(h.state.phase, "ready"); assert.equal(h.state.pending, null); assert.equal(h.state.dirty, false);
  assert.equal(h.requests.filter(request => request.op === "save_model_catalog").length, 1);
});

test("Desktop 受影响提供方忙时拒绝写入，默认及会话引用阻止删除", async t => {
  const release = deferred();
  t.after(() => release.resolve());
  const h = await fixture(t, async () => { await release.promise; return { kind: "text", text: "done" }; });
  const source = (await h.runtime.openWorkspace({ cwd: h.work[0] })).session;
  const task = await h.client.request<OpResult<"submit">>("submit", { session_id: source.id, request_id: "desktop-model-busy", input: "wait", model_selection: primary });
  await waitFor("模型请求开始", () => h.server.calls.length === 1);
  const before = fs.readFileSync(h.file, "utf8");
  h.state.selectProvider("mock"); h.state.editProvider("name", "Blocked");
  assert.equal(await h.state.save(), false);
  assert.equal(fs.readFileSync(h.file, "utf8"), before);
  assert.match(h.state.message, /任务|使用|忙|提供方/);
  release.resolve();
  await waitFor("任务完成", () => h.runtime.store.getTask(task.id)?.status === "completed");
  h.state.discard(); await h.state.removeProvider();
  assert.ok(h.read().providers.mock, "当前会话引用的提供方不可删除");
  assert.match(h.state.message, /引用|会话/);
  await h.state.read(); h.state.chooseScreen("default"); h.state.selection = { ...secondary };
  assert.equal(await h.state.save(), true, h.state.message);
  h.state.chooseScreen("catalog"); h.state.selectProvider("second"); await h.state.removeProvider();
  assert.ok(h.read().providers.second, "后台默认引用的提供方不可删除");
  assert.match(h.state.message, /引用|默认/);
});

test("Desktop 移除存储凭据保留目录来源，重开仍显示未验证且秘密不回显", async t => {
  const h = await fixture(t);
  const storedSecret = "desktop-stored-secret";
  h.state.selectProvider("mock"); h.state.chooseScreen("credential"); h.state.secret = storedSecret;
  assert.equal(await h.state.save(), true, h.state.message);
  assert.equal(h.state.secret, "");
  assert.equal((await h.config()).credentials.mock.configured, true);
  const bytes = fs.readFileSync(h.file, "utf8");
  await h.state.removeStoredCredential();
  assert.equal(fs.readFileSync(h.file, "utf8"), bytes, "移除存储条目不改目录中的秘密");
  assert.equal((await h.config()).credentials.mock, undefined);
  assert.match(h.state.message, /存储/); assert.doesNotMatch(h.state.message, /已无凭据|不可用/);
  const reopened = h.createState(); await reopened.read();
  const sources = reopened.view?.credentialSources.mock;
  assert.equal(sources?.verification, "unverified");
  assert.ok(sources?.locations.some(location => location.source === "catalog" && location.field === "apiKey"));
  assertRedacted([reopened.view, h.runtime.getEventLog(0), h.state.message], [storedSecret]);
  assert.equal(h.server.calls.length, 0);
});

test("Desktop 清除单个目录 header 只作用于选定位置，其他秘密和高级字段保留", async t => {
  const h = await fixture(t);
  h.state.selectProvider("mock");
  const before = h.read();
  h.state.editSecret({ scope: "model", modelId: "mock-model", field: "headers", header: "x-model-key" }, null);
  assert.equal(await h.state.save(), true, h.state.message);
  const saved = h.read();
  delete before.providers.mock.models[0].headers["x-model-key"];
  assert.deepEqual(saved, before);
  h.state.editSecret({ scope: "modelOverrides", modelId: "mock-model", field: "headers", header: "x-override-key" }, "override-replacement");
  assert.equal(await h.state.save(), true, h.state.message);
  before.providers.mock.modelOverrides["mock-model"].headers["x-override-key"] = "override-replacement";
  assert.deepEqual(h.read(), before);
  assertRedacted([h.state.view, h.state.draft, h.runtime.getEventLog(0)], ["override-replacement"]);
});

test("Desktop 设置保存与主动连接测试分别报告，保存后重读仍不自动测试", async t => {
  const h = await fixture(t);
  h.state.selectProvider("mock"); h.state.selectModel(0); h.state.editModel("name", "Saved only");
  assert.equal(await h.state.save(), true, h.state.message);
  assert.equal(h.server.calls.length, 0);
  await h.state.testConnection("mock-model");
  assert.equal(h.server.calls.length, 1);
  assert.equal(h.requests.filter(request => request.op === "test_model_connection").length, 1);
  assert.equal(h.read().providers.mock.models[0].name, "Saved only");
  assert.equal(h.state.connectionTest("mock-model")?.ok, true); assert.equal(h.state.testMessage, "");
  h.state.editModel("name", "Changed after test"); assert.equal(h.state.connectionTest("mock-model"), null);
  assert.equal(await h.state.save(), true, h.state.message); assert.equal(h.state.connectionTest("mock-model"), null);
});

test("移除最后可用来源导致重建失败时恢复存储条目与原修订，不显示已移除", async t => {
  const h = await fixture(t);
  h.state.selectProvider("mock"); h.state.chooseScreen("credential"); h.state.secret = "last-stored-key";
  assert.equal(await h.state.save(), true, h.state.message);
  h.state.chooseScreen("catalog");
  h.state.editSecret({ scope: "provider", field: "apiKey" }, null);
  h.state.editSecret({ scope: "provider", field: "headers", header: "x-provider-key" }, null);
  h.state.editSecret({ scope: "model", modelId: "mock-model", field: "headers", header: "x-model-key" }, null);
  h.state.editSecret({ scope: "modelOverrides", modelId: "mock-model", field: "headers", header: "x-override-key" }, null);
  assert.equal(await h.state.save(), true, h.state.message);
  h.state.chooseScreen("credential");
  const authFile = path.join(h.dirs.agentDir, "auth.json"), before = fs.readFileSync(authFile, "utf8"), revision = h.state.revision;
  assert.equal(await h.state.removeStoredCredential(), false);
  assert.equal(fs.readFileSync(authFile, "utf8"), before);
  assert.equal((await h.config()).revision, revision);
  assert.equal((await h.config()).credentials.mock.configured, true);
  assert.doesNotMatch(h.state.message, /已移除所选/);
});

test("Desktop 离线及实例变化后不写入，旧读取迟到也不能覆盖当前草稿", async t => {
  const h = await fixture(t);
  h.state.selectProvider("mock"); h.state.selectModel(0); h.state.editModel("name", "Keep draft");
  h.context.online = false; assert.equal(await h.state.save(), false);
  h.context.online = true; h.context.instanceId = "replacement-instance";
  assert.equal(await h.state.save(), false);
  assert.equal(h.requests.filter(request => request.op === "save_model_catalog").length, 0);
  h.context.instanceId = h.code.view.instanceId;
  const release = deferred(), began = deferred();
  h.hook.after = async op => { if (op === "get_model_config") { began.resolve(); await release.promise; } };
  const reading = h.state.read(true); await began.promise;
  h.state.invalidate(); release.resolve(); await reading;
  assert.equal(catalogModels(h.state.draft)[0].name, "Keep draft");
});

test("Desktop 目录事件刷新会话与新聊天列表，旧分页不能覆盖新目录", async t => {
  const h = await fixture(t);
  const stop = h.client.onEvent(event => h.code.update({ type: "event", event, kind: "live" }));
  t.after(stop);
  await h.code.writes.loadModels();
  const release = deferred(), began = deferred();
  t.after(() => release.resolve());
  let delayed = false;
  h.hook.after = async op => { if (op === "list_models" && !delayed) { delayed = true; began.resolve(); await release.promise; } };
  const stale = h.code.writes.loadModels(); await began.promise;
  h.state.selectProvider("second"); h.state.selectModel(0); h.state.editModel("name", "Latest reasoner");
  assert.equal(await h.state.save(), true, h.state.message);
  await waitFor("目录事件刷新", () => h.code.writes.models.some(model => model.provider === "second" && model.name === "Latest reasoner"));
  release.resolve(); await stale;
  assert.equal(h.code.writes.models.find(model => model.provider === "second")?.name, "Latest reasoner");
  assert.equal(h.server.calls.length, 0);
});

test("目录秘密输入清空保留旧占位，显式清除才删除；新增请求头草稿也受导航保护", async t => {
  const { state } = await fixture(t);
  state.selectProvider("mock");
  for (const location of [
    { scope: "provider" as const, field: "apiKey" as const },
    { scope: "provider" as const, field: "headers" as const, header: "x-provider-key" },
    { scope: "model" as const, modelId: "mock-model", field: "headers" as const, header: "x-model-key" },
    { scope: "modelOverrides" as const, modelId: "mock-model", field: "headers" as const, header: "x-override-key" },
  ]) {
    const original = structuredClone(state.draft);
    state.editSecret(location, "replacement-secret"); assert.equal(state.dirty, true);
    state.editSecret(location, ""); assert.deepEqual(state.draft, original); assert.equal(state.dirty, false);
  }
  state.editNewHeader({ scope: "provider", field: "headers" }, "x-new", "new-header-secret");
  assert.equal(state.dirty, true); state.selectProvider("second"); assert.equal(state.providerId, "mock");
  state.discard(); assert.equal(state.headerDraft, null); assert.equal(state.dirty, false);
  state.editNewHeader({ scope: "provider", field: "headers" }, "x-new", "new-header-secret");
  assert.equal(await state.save(), true, state.message); assert.equal(state.headerDraft, null);
  assertRedacted([state.draft, state.view, state.pending], ["replacement-secret", "new-header-secret"]);
  state.selectModel(0); state.editModel("id", "");
  assert.equal(await state.save(), false); assert.ok(state.fieldErrors["catalog-model-0-id"]);
  state.discard(); state.selectModel(null);
  state.editSecret({ scope: "provider", field: "headers", header: "__proto__" }, "proto-header-secret");
  assert.ok(Object.hasOwn(state.provider.headers!, "__proto__"));
  for (const header of ["__proto__", "toString", "constructor"]) {
    state.editSecret({ scope: "provider", field: "headers", header }, "temporary");
    state.editSecret({ scope: "provider", field: "headers", header }, "");
    assert.equal(Object.hasOwn(state.provider.headers!, header), false);
  }
  assert.doesNotThrow(() => structuredClone(state.draft));
});

test("默认与摘要读回同步选择，丢答分别比较真实当前值并清理已保存草稿", async t => {
  const h = await fixture(t);
  h.state.chooseScreen("default");
  let current = await h.config();
  await h.client.request("set_default_model", { provider: secondary.provider, model_id: secondary.modelId, thinking_level: secondary.thinkingLevel, expected_revision: current.revision });
  await h.state.read(); assert.deepEqual(h.state.selection, secondary); assert.equal(h.state.dirty, false);
  h.state.selection = { ...primary };
  h.hook.before = async op => { if (op === "set_default_model") throw new ControlClientError("request_timeout", "合成未确定写入", "unknown"); };
  await h.state.save(); h.hook.before = undefined;
  await h.state.read(); assert.equal(h.state.phase, "conflict"); assert.deepEqual(h.state.selection, primary); assert.deepEqual(h.state.view?.defaultModel, secondary);
  h.state.discard(); h.state.selection = { ...primary };
  h.hook.after = async op => { if (op === "set_default_model") throw new ControlClientError("request_timeout", "合成已写入丢答", "unknown"); };
  await h.state.save(); h.hook.after = undefined;
  await h.state.read(); assert.equal(h.state.phase, "ready"); assert.equal(h.state.dirty, false); assert.deepEqual(h.state.selection, primary);
  h.state.chooseScreen("summary"); current = await h.config();
  await h.client.request("set_summary_model", { provider: secondary.provider, model_id: secondary.modelId, expected_revision: current.revision });
  await h.state.read(); assert.deepEqual(h.state.selection, { provider: secondary.provider, modelId: secondary.modelId, thinkingLevel: "off" });
  assert.equal(h.state.dirty, false);
});

test("冲突读回失败如实报告，保存成功但读回失败保留待核实并禁止重发", async t => {
  const h = await fixture(t);
  h.state.selectProvider("mock"); h.state.editProvider("name", "Draft");
  const current = await h.config(); current.providers.second.name = "External";
  await h.client.request("save_model_catalog", { providers: current.providers, expected_revision: current.revision });
  h.hook.before = async op => { if (op === "get_model_config") throw new ControlClientError("request_timeout", "合成读取失败", "unknown"); };
  assert.equal(await h.state.save(), false); assert.equal(h.state.phase, "conflict");
  assert.match(h.state.message, /读取失败/); assert.doesNotMatch(h.state.message, /已读回当前值/);
  h.hook.before = undefined; await h.state.read(); h.state.discard();
  h.state.editProvider("name", "Committed");
  h.hook.before = async op => { if (op === "get_model_config") throw new ControlClientError("request_timeout", "合成读取失败", "unknown"); };
  assert.equal(await h.state.save(), false); assert.equal(h.state.phase, "unknown"); assert.ok(h.state.pending);
  const writes = h.requests.filter(request => request.op === "save_model_catalog").length;
  await h.state.save(); assert.equal(h.requests.filter(request => request.op === "save_model_catalog").length, writes);
  h.hook.before = undefined; await h.state.read(); assert.equal(h.state.phase, "ready"); assert.equal(h.state.dirty, false);
});

test("连接测试迟到不能写入另一提供方，默认变更事件刷新新聊天默认值", async t => {
  const h = await fixture(t);
  h.state.selectProvider("mock"); h.state.selectModel(0);
  const began = deferred(), release = deferred();
  h.hook.after = async op => { if (op === "test_model_connection") { began.resolve(); await release.promise; } };
  const testing = h.state.testConnection("mock-model"); await began.promise;
  h.state.selectModel(null); h.state.selectProvider("second"); release.resolve(); await testing;
  assert.equal(h.state.testMessage, ""); assert.equal(h.state.testing, false);
  const current = await h.config();
  h.client.onEvent(event => h.code.update({ type: "event", event, kind: "live" }));
  await h.client.request("set_default_model", { provider: secondary.provider, model_id: secondary.modelId, thinking_level: secondary.thinkingLevel, expected_revision: current.revision });
  await waitFor("新聊天默认刷新", () => h.code.view.defaultModel.provider === "second");
  assert.equal(h.code.view.defaultModel.id, secondary.modelId); assert.equal(h.code.view.defaultModel.thinkingLevel, secondary.thinkingLevel);
  await waitFor("新目录可用", () => h.code.writes.models.some(model => model.provider === "second"));
  assert.deepEqual(h.code.newChatSelection(null), secondary, "新聊天保留后台默认的真实 Effort");
  assert.equal(await h.code.create("open_workspace", { cwd: h.work[0] }, { mode: "confirm", modelSelection: h.code.newChatSelection(null) }), true);
  assert.deepEqual(h.runtime.getSession(h.code.view.currentSessionId!).modelSelection, secondary);
  h.hook.before = async op => { if (op === "get_model_config") throw new ControlClientError("request_timeout", "合成默认值读取失败", "unknown"); };
  const config = await h.config();
  await h.client.request("set_default_model", { provider: primary.provider, model_id: primary.modelId, thinking_level: primary.thinkingLevel, expected_revision: config.revision });
  await waitFor("默认值不可核实提示", () => !!h.code.message?.includes("默认模型刷新失败"));
  assert.equal(h.code.newChatSelection(null), null, "无法核实默认值时不沿用旧默认");
  assert.deepEqual(h.code.newChatSelection(primary), primary, "明确选择仍可使用");
});
