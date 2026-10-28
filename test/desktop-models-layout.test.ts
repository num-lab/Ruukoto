import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
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
  assert.match(html, /默认设置/);
  assert.match(html, /提供方/);
  for (const id of ["settings-model-choice", "settings-model-effort", "settings-summary-model"]) assert.ok(html.includes(`id="${id}"`));
  assert.doesNotMatch(html, /选择后自动保存/);
  assert.match(html, /aria-label="配置 测试提供方"/);
  assert.match(html, /http:\/\/127.0.0.1\/v1/);
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /model-settings-footer/);
});

test("提供方表单同窗包含连接、认证和模型，保留 OAuth 语义与高级字段", async () => {
  const model = await state(); model.selectProvider("mock");
  const html = renderProvider(model);
  for (const title of ["连接设置", "认证来源", "目录模型"]) assert.ok(html.includes(title));
  assert.match(html, /OAuth 存储条目/);
  assert.match(html, /type="password"/); assert.match(html, /查看全部配置位置/);
  assert.match(html, /目录密钥与请求头/); assert.match(html, /添加模型/);
  assert.match(html, /id="catalog-model-0-id"/);
  assert.doesNotMatch(html, /返回所有提供方/);
  assert.doesNotMatch(html, /id="catalog-api-key"/);
  assert.doesNotMatch(html, /model-settings-footer/);
});

test("模型能力直接在提供方表单编辑，多模型字段有独立标签，存储凭据保留替换说明", async () => {
  const model = await state(); model.selectProvider("mock"); model.addModel("second");
  const html = renderProvider(model);
  assert.match(html, /单独指定接口/); assert.match(html, /id="catalog-model-0-contextWindow"/);
  assert.match(html, /id="catalog-model-1-contextWindow"/);
  assert.match(html, /type="password"/); assert.match(html, /填写新 Key 会替换 OAuth/);
  assert.match(html, /不会撤销远端令牌/);
  for (const text of ["正在保存", "有未保存的更改", "放弃并关闭", "留空不添加存储条目", "配置位置不代表认证有效", "仅修改所选位置", "输入后留空保留原值"]) assert.ok(!html.includes(text));
});

test("默认与摘要始终留在总览，待核实与离线状态有显式恢复入口", async () => {
  const model = await state(); model.chooseScreen("default");
  assert.match(render(model), /运行时显式启动参数仍覆盖此处默认/);
  model.chooseScreen("summary");
  assert.match(render(model), /id="settings-model-choice"/);
  assert.match(render(model), /id="settings-summary-model"/);
  model.phase = "unknown"; model.message = "原操作结果待核实";
  assert.match(render(model), /核实原操作结果/);
  assert.match(render(model, false), /Code 已离线/);
});

test("同窗多个模型只标记实际无效字段，API 类型使用选择框", async () => {
  const model = await state(); model.selectProvider("mock"); model.addModel();
  assert.equal(await model.save(), false);
  assert.deepEqual(Object.keys(model.fieldErrors), ["catalog-model-1-id"]);
  const html = renderProvider(model);
  assert.match(html, /id="catalog-model-0-id"[^>]*aria-invalid="false"/);
  assert.match(html, /id="catalog-model-1-id"[^>]*aria-invalid="true"/);
  assert.match(html, /<select[^>]*id="model-api"/);
  assert.doesNotMatch(html, /<input[^>]*id="model-api"/);
});

test("连接测试在模型行说明中区分未测、成功与失败，不展示成功提示", async () => {
  for (const ok of [true, false]) {
    const model = await state(ok); model.selectProvider("mock");
    assert.match(renderProvider(model), /未测试/);
    await model.testConnection("reasoner");
    const html = renderProvider(model);
    assert.match(html, new RegExp(ok ? "连接测试成功" : "连接测试失败"));
    assert.doesNotMatch(html, /role="status">连接成功/);
    assert.doesNotMatch(html, /联网测试连接？/);
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
