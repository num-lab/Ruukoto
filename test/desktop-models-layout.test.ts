import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "./helpers/vite.ts";
import react from "@vitejs/plugin-react";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { CodeModelsState } from "../apps/desktop/src/renderer/code-models-state.ts";
import type { SettingsScope } from "../apps/desktop/src/renderer/settings-state.ts";

const scope: SettingsScope = { target: "code", instanceId: "layout" };
let server: ViteDevServer;
let Editor: ComponentType<{ state: CodeModelsState; scope: SettingsScope; online: boolean }>;
let Provider: ComponentType<{ state: CodeModelsState; scope: SettingsScope; online: boolean; save: () => void; confirm: () => void }>;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ CodeModelsEditor: Editor, ProviderSettings: Provider } = await server.ssrLoadModule("/code-models-settings.tsx"));
});
after(async () => { await server?.close(); });

async function state(testOk = true, testGate?: Promise<void>) {
  const config: OpResult<"get_model_config"> = {
    revision: "layout-revision", providers: { mock: { name: "测试提供方", api: "openai-completions", baseUrl: "http://127.0.0.1/v1", apiKey: true, models: [{ id: "reasoner", name: "推理模型", reasoning: true, contextWindow: 128000, maxTokens: 4096 }] } },
    credentials: { mock: { configured: true, type: "oauth" } }, credentialSources: { mock: { locations: [{ source: "storage", type: "oauth" }, { source: "catalog", scope: "provider", field: "apiKey" }], verification: "unverified" } },
    models: [{ provider: "mock", modelId: "reasoner", name: "推理模型", thinkingLevels: ["off", "high"] }], defaultModel: { provider: "mock", modelId: "reasoner", thinkingLevel: "high" }, summaryModel: null,
    runtimeDefault: { provider: "mock", modelId: "reasoner", thinkingLevel: "high" }, runtimeOverrides: { model: true, thinking: false }, busyProviders: [],
  };
  const result = new CodeModelsState({ request: async (_target, op) => { if (op === "test_model_connection") { await testGate; return { ok: true, value: { ok: testOk, detail: testOk ? "连接成功" : "合成连接失败" } }; } return { ok: true, value: config }; } }, () => {}, "layout", () => ({ instanceId: "layout", online: true }));
  await result.read(); return result;
}
const render = (state: CodeModelsState, online = true) => renderToStaticMarkup(createElement(Editor, { state, scope, online }));
const renderProvider = (state: CodeModelsState) => renderToStaticMarkup(createElement(Provider, { state, scope, online: true, save: () => {}, confirm: () => {} }));

test("模型总览直接设置默认与摘要模型，不混入新建字段、二级导航或保存栏", async () => {
  const html = render(await state());
  assert.match(html, /Defaults/);
  assert.match(html, /提供方/);
  for (const id of ["settings-model-choice", "settings-model-effort", "settings-summary-model"]) assert.ok(html.includes(`id="${id}"`));
  assert.doesNotMatch(html, /auto.?sav|saved automatically/i);
  assert.match(html, /aria-label="Configure 测试提供方"/);
  assert.match(html, /http:\/\/127.0.0.1\/v1/);
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /model-settings-footer/);
});

test("提供方表单同窗包含连接、认证和模型，保留 OAuth 语义与高级字段", async () => {
  const model = await state(); model.selectProvider("mock");
  const html = renderProvider(model);
  for (const title of ["Connection", "Credential source", "Catalog models"]) assert.ok(html.includes(title));
  assert.match(html, /OAuth stored entry/);
  assert.match(html, /type="password"/); assert.match(html, /View all locations/);
  assert.match(html, /Catalog keys and headers/); assert.match(html, /Add model/);
  assert.match(html, /id="catalog-model-0-id"/);
  assert.doesNotMatch(html, /Back to all providers/);
  assert.doesNotMatch(html, /id="catalog-api-key"/);
  assert.doesNotMatch(html, /model-settings-footer/);
});

test("模型能力直接在提供方表单编辑，多模型字段有独立标签，存储凭据保留替换说明", async () => {
  const model = await state(); model.selectProvider("mock"); model.addModel("second");
  const html = renderProvider(model);
  assert.match(html, /Custom endpoint/); assert.match(html, /id="catalog-model-0-contextWindow"/);
  assert.match(html, /id="catalog-model-1-contextWindow"/);
  assert.match(html, /type="password"/); assert.match(html, /replaces the OAuth/);
  assert.match(html, /revoke the remote token/);
  for (const text of ["Saving", "Unsaved changes", "Discard and close", "leave empty to skip a stored entry", "location proves nothing about authentication", "only the selected location", "leave blank to keep the original value"]) assert.ok(!html.includes(text));
});

test("默认与摘要始终留在总览，待核实与离线状态有显式恢复入口", async () => {
  const model = await state(); model.chooseScreen("default");
  assert.match(render(model), /runtime launch args still override/);
  model.chooseScreen("summary");
  assert.match(render(model), /id="settings-model-choice"/);
  assert.match(render(model), /id="settings-summary-model"/);
  model.phase = "unknown"; model.message = "原操作结果待核实";
  assert.match(render(model), /Verify the original operation/);
  assert.match(render(model, false), /Code is offline/);
});

test("同窗多个模型只标记实际无效字段，API 类型使用选择框", async () => {
  const model = await state(); model.selectProvider("mock"); model.addModel();
  assert.equal(await model.save(), false);
  assert.deepEqual(Object.keys(model.fieldErrors), ["catalog-model-1-id"]);
  const html = renderProvider(model);
  assert.match(html, /id="catalog-model-0-id"[^>]*aria-invalid="false"/);
  assert.match(html, /id="catalog-model-1-id"[^>]*aria-invalid="true"/);
  assert.match(html, /<button[^>]*role="combobox"[^>]*id="model-api"/);
  assert.doesNotMatch(html, /<input[^>]*id="model-api"/);
});

test("连接测试在模型行说明中区分未测、成功与失败，不展示成功提示", async () => {
  for (const ok of [true, false]) {
    const model = await state(ok); model.selectProvider("mock");
    assert.match(renderProvider(model), /Not tested/);
    await model.testConnection("reasoner");
    const html = renderProvider(model);
    assert.match(html, new RegExp(ok ? "Connection test succeeded" : "Connection test failed"));
    assert.doesNotMatch(html, /role="status">Connection/);
    assert.doesNotMatch(html, /Test connection online/i);
  }
});

test("重新读取淘汰在途测试，旧应答不会留下测试中状态或旧结果", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = await state(true, gate); model.selectProvider("mock");
  const testing = model.testConnection("reasoner"); assert.equal(model.testing, true);
  await model.read(); assert.equal(model.testing, false);
  release(); await testing;
  assert.equal(model.connectionTest("reasoner"), null);
});

test("new provider fields use the guarded draft and show invalid API Key feedback", async () => {
  const { AddProviderPage } = await server.ssrLoadModule("/code-models-settings.tsx");
  const model = await state(); model.addProvider("custom");
  model.editProvider("name", "Custom provider"); model.editProvider("baseUrl", "https://custom.example/v1"); model.editProvider("api", "anthropic-messages"); model.editStoredSecret(" invalid-key ");
  assert.equal(await model.save(), false); assert.ok(model.fieldErrors.apiKey);
  const html = renderToStaticMarkup(createElement(AddProviderPage, { state: model, onBack() {}, onAdd() {} }));
  assert.match(html, /id="new-provider-name"[^>]*value="Custom provider"/);
  assert.match(html, /id="new-provider-api"[^>]*><span[^>]*>anthropic-messages/);
  assert.match(html, /id="new-provider-key"[^>]*aria-invalid="true"/);
  assert.match(html, /API key/);
  assert.doesNotMatch(html, /Read the configuration again/);
});
