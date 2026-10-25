import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { handleRequest } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge, DesktopResult } from "../apps/desktop/src/shared/bridge.ts";
import { CodeWebSearchState } from "../apps/desktop/src/renderer/code-web-search-state.ts";

// Note: 见 .agents/notes/implemented/feature/2026-10-25-desktop-computer-websearch-settings.md
type Credential = { name: string; host: string; header: string; purpose: string; references: unknown[] };
const tavilyBinding = (name: string): Credential => ({ name, host: "api.tavily.com", header: "authorization", purpose: "tavily_search", references: [] });

function webSearchFixture() {
  const credentials: Credential[] = [];
  const requests: { op: string; params: Record<string, unknown> }[] = [];
  const hooks: { reply?: (op: string, params: Record<string, unknown>) => unknown } = {};
  const context = { instanceId: "instance", online: true };
  const bridge: Pick<DesktopBridge, "request"> = { request: (target, op, params) => handleRequest(target, op, params, async () => {}, async (name, input) => {
    requests.push({ op: name, params: structuredClone(input) });
    if (name === "list_credentials") return structuredClone(credentials);
    if (hooks.reply) return hooks.reply(name, input as Record<string, unknown>);
    assert.fail(`未预期的操作：${name}`);
  }) };
  const state = new CodeWebSearchState(bridge, () => {}, "instance", () => context);
  return { state, credentials, requests, hooks, context, bridge };
}

test("Web 搜索读取 Tavily 凭据并按名称排序呈现生效绑定", async () => {
  const h = webSearchFixture();
  await h.state.read();
  const initial = h.state.effective;
  assert.equal(h.state.phase, "ready"); assert.ok(initial === null); assert.equal(h.state.desktopManaged, false);
  h.credentials.push(tavilyBinding("zeta"), tavilyBinding("web-search"));
  await h.state.read();
  assert.equal(h.state.effective?.name, "web-search"); assert.equal(h.state.desktopManaged, true);
  h.credentials.push(tavilyBinding("alpha"));
  await h.state.read();
  assert.equal(h.state.effective?.name, "alpha", "CLI 创建的字典序靠前绑定义生效");
});

test("Web 搜索凭据保存只发密钥，校验失败不发，成功后清空秘密并重读", async () => {
  const h = webSearchFixture(); await h.state.read();
  assert.equal(await h.state.saveSecret(), false); assert.ok(h.state.fieldErrors.secret);
  h.state.editSecret(" spaced\n");
  assert.equal(await h.state.saveSecret(), false); assert.ok(h.state.fieldErrors.secret);
  assert.deepEqual(h.requests.map(request => request.op), ["list_credentials"]);
  h.hooks.reply = (op, input) => {
    assert.equal(op, "web_search_save_credential");
    assert.deepEqual(input, { secret: "tvly-secret" });
    h.credentials.push(tavilyBinding("web-search"));
    return tavilyBinding("web-search");
  };
  h.state.editSecret("tvly-secret");
  assert.equal(await h.state.saveSecret(), true, h.state.message);
  assert.equal(h.state.secret, "");
  assert.equal(h.state.desktopManaged, true);
  assert.match(h.state.message, /已保存/);
  assert.ok(!JSON.stringify([h.state.credentials, h.state.message]).includes("tvly-secret"), "秘密不进任何读取结果或提示");
  assert.deepEqual(h.requests.at(-1)?.op, "list_credentials", "保存后重读核实");
});

test("Web 搜索移除凭据走专用 op；全局开关带期望版本", async () => {
  const h = webSearchFixture(); await h.state.read();
  h.hooks.reply = op => {
    if (op === "web_search_remove_credential") { h.credentials.splice(0); return { removed: true }; }
    assert.equal(op, "set_web_search");
    return { state: "disabled", version: 2 };
  };
  assert.equal(await h.state.removeCredential(), true, h.state.message);
  assert.equal(await h.state.setWebSearch(false, 1), true, h.state.message);
  assert.deepEqual(h.requests.find(request => request.op === "set_web_search")?.params, { enabled: false, expected_version: 1 });
  assert.match(h.state.message, /已停用/);
});

test("Web 搜索全局开关版本冲突提示重选，丢答保留待核实并读回核对", async () => {
  const h = webSearchFixture(); await h.state.read();
  h.hooks.reply = () => { throw new ControlClientError("version_conflict", "设置已被其他客户端修改", "rejected"); };
  assert.equal(await h.state.setWebSearch(false, 1), false);
  assert.match(h.state.message, /重新选择/);
  h.hooks.reply = () => { throw new ControlClientError("request_timeout", "合成丢答", "unknown"); };
  assert.equal(await h.state.setWebSearch(false, 1), false);
  assert.equal(h.requests.filter(request => request.op === "set_web_search").length, 2);
  assert.match(h.state.message, /核对|待核实/);
  h.context.online = false;
  assert.equal(await h.state.setWebSearch(false, 1), false);
  assert.equal(await h.state.read(), false);
});

test("Web 搜索操作仅向 Code 目标放行", async () => {
  for (const op of ["web_search_save_credential", "web_search_remove_credential", "set_web_search"]) {
    let called = false;
    const result = await handleRequest("personal", op, {}, async () => {}, async () => { called = true; return {}; });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "op_not_allowed");
    assert.equal(called, false);
  }
});

test("Web 搜索页 SSR 呈现凭据状态与项目开关", async t => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createServer } = await import("vite"); const { default: react } = await import("@vitejs/plugin-react");
  const { fileURLToPath } = await import("node:url");
  const { CodeState } = await import("../apps/desktop/src/renderer/code-state.ts");
  const { fakeSnapshot } = await import("./helpers/fake-control.ts");
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { CodeWebSearchSettings } = await server.ssrLoadModule("/code-web-search-settings.tsx");
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ruukoto: { request: async (): Promise<DesktopResult<unknown>> => ({ ok: true, value: [] }) } } });
  try {
    const bridge: Pick<DesktopBridge, "request"> = { request: async () => ({ ok: true, value: null }) };
    const code = new CodeState(bridge, () => {});
    code.view.applySnapshot({ snapshot: fakeSnapshot({}), replay: [], seq: 0 }, false);
    code.status = { type: "state", state: "online" };
    let html = renderToStaticMarkup(createElement(CodeWebSearchSettings, { code }));
    assert.match(html, /Tavily 凭据/); assert.match(html, /Tavily API Key/); assert.match(html, /保存密钥/);
    assert.match(html, /所有项目共用/); assert.match(html, /从下一任务生效/);
    code.view.instanceId = null;
    html = renderToStaticMarkup(createElement(CodeWebSearchSettings, { code }));
    assert.match(html, /Code 已离线/);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window");
  }
});
