import { product as personalProduct } from "./helpers/legacy-product.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createModelCatalog, modelResponseBudget } from "@ruukoto/agent/model-selection.ts";
import { makeTestDirs, cleanupDirs, writeModelsJson } from "./helpers/testkit.ts";

test("模型目录仅列出显式配置，校验认证与思考档位且不泄露请求配置", async () => {
  const { dirs } = await makeTestDirs("model-catalog");
  try {
    await writeModelsJson(dirs, "http://127.0.0.1:1/v1");
    const file = path.join(dirs.agentDir, "models.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.providers.second = { ...config.providers.mock, models: [{ ...config.providers.mock.models[0], id: "reasoner", reasoning: true }] };
    config.providers.missing = { ...config.providers.mock, apiKey: "${RUUKOTO_TEST_MISSING_MODEL_KEY}" };
    fs.writeFileSync(file, JSON.stringify(config));
    const runtime = await ModelRuntime.create({
      authPath: path.join(dirs.agentDir, "auth.json"), modelsPath: file,
      modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
    });
    const catalog = await createModelCatalog(runtime, dirs.agentDir);
    const page = await catalog.list({ limit: 2 });
    assert.equal(page.total, 3);
    assert.equal(page.nextOffset, 2);
    assert.equal(page.models[0].available, true);
    assert.deepEqual(page.models[0].thinkingLevels, ["off"]);
    assert.ok(page.models[1].thinkingLevels.includes("low"));
    const json = JSON.stringify(page);
    assert.ok(!json.includes("mock-key"));
    assert.ok(!json.includes("127.0.0.1"));
    await assert.rejects(catalog.resolve({ provider: "mock", modelId: "mock-model", thinkingLevel: "high" }), { code: "thinking_not_supported" });
    await assert.rejects(catalog.resolve({ provider: "unknown", modelId: "x", thinkingLevel: "off" }), { code: "model_not_found" });
    await assert.rejects(catalog.resolve({ provider: "missing", modelId: "mock-model", thinkingLevel: "off" }), { code: "model_auth_missing" });
    const model = await catalog.resolve({ provider: "second", modelId: "reasoner", thinkingLevel: "low" });
    assert.deepEqual(modelResponseBudget(model), { contextWindow: 200000, maxTokens: 1024, thinkingBudget: 0 });
    await runtime.setRuntimeApiKey("missing", "now-configured");
    assert.equal((await catalog.resolve({ provider: "missing", modelId: "mock-model", thinkingLevel: "off" })).provider, "missing");
  } finally { await cleanupDirs(dirs); }
});

import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { connectAuthedClient, createProjectSession, taskStatus, waitFor } from "./helpers/testkit.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";

test("控制接口切换提供方和思考强度，排队任务固定配置且 SDK 保留跨提供方工具历史", async () => {
  const { dirs, work } = await makeTestDirs("model-switch");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const server = new MockModelServer(async (_req, index) => {
    if (index === 0) { await blocked; return { kind: "tool_calls", calls: [{ id: "switch-call", name: "mock_echo", arguments: { text: "record" } }] }; }
    return { kind: "text", text: "done" };
  });
  let runtime: Runtime | undefined;
  let client: Awaited<ReturnType<typeof connectAuthedClient>> | undefined;
  try {
    const baseUrl = await server.start();
    await writeModelsJson(dirs, baseUrl);
    const file = path.join(dirs.agentDir, "models.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.providers.second = { ...config.providers.mock, models: [{ ...config.providers.mock.models[0], id: "reasoner", reasoning: true, maxTokens: 4096 }] };
    fs.writeFileSync(file, JSON.stringify(config));
    runtime = await Runtime.start({
    product: personalProduct.runtime, dataDir: dirs.dataDir, agentDir: dirs.agentDir,
      socketPath: path.join(dirs.root, "c.sock"), modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off",
      toolFactory: (ctx) => createMockTools(ctx) });
    await ControlServer.start(runtime);
    client = await connectAuthedClient(runtime);
    await client.handshake();
    const { sessionId } = await createProjectSession(client, work[0]!);
    const a = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
    const b = { provider: "second", modelId: "reasoner", thinkingLevel: "low" };
    const session = await client.request<any>("get_session", { session_id: sessionId });
    const one = await client.request<any>("submit", { session_id: sessionId, request_id: "one", input: "first", model_selection: a });
    await waitFor("首个模型请求", () => server.calls.length === 1);
    const queued = await client.request<any>("submit", { session_id: sessionId, request_id: "queued", input: "queued", model_selection: a });
    const selected = await client.request<any>("set_session_model", { session_id: sessionId, expected_version: session.modelSelectionVersion, model_selection: b });
    assert.deepEqual(selected.modelSelection, b);
    await assert.rejects(client.request("set_session_model", { session_id: sessionId, expected_version: selected.modelSelectionVersion, model_selection: { ...a, thinkingLevel: "high" } }));
    const last = await client.request<any>("submit", { session_id: sessionId, request_id: "last", input: "last", model_selection: b });
    release();
    await waitFor("切换前后任务完成", async () => {
      const statuses = await Promise.all([one, queued, last].map((task) => taskStatus(client!, task.id)));
      return statuses.every((item) => item.task.status === "completed");
    });
    assert.deepEqual(server.calls.map((call) => call.raw.model), ["mock-model", "mock-model", "mock-model", "reasoner"]);
    assert.equal(server.calls.at(-1)!.raw.reasoning_effort, "low");
    assert.equal(server.calls.at(-1)!.raw.max_completion_tokens, 4096);
    assert.ok(server.calls.at(-1)!.messages.some((message) => message.role === "tool"));
    assert.deepEqual((await taskStatus(client, queued.id)).task.modelSelection, a);
    assert.deepEqual((await taskStatus(client, last.id)).task.modelSelection, b);
    const records = runtime.store.listSelectionRecordsByTask(last.id);
    assert.equal(records.at(-1)?.model, "second/reasoner");
  } finally {
    release(); client?.close(); await runtime?.stop("test_end"); await server.close(); await cleanupDirs(dirs);
  }
});
