import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "./helpers/vite.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { NativeBrowserState } from "../apps/desktop/src/renderer/native-browser.ts";

let server: ViteDevServer, Panel: ComponentType<{ model: CodeState; sessionId: string; visible: boolean }>;
before(async () => {
  server = await createServer({ configFile: false, root: "apps/desktop/src/renderer", server: { middlewareMode: true, hmr: false }, esbuild: { jsx: "automatic" } });
  ({ NativeBrowserPanel: Panel } = await server.ssrLoadModule("/native-browser-panel.tsx"));
});
after(async () => { await server?.close(); });

test("Native browser controls distinguish idle, Agent use and explicit takeover", t => {
  const request = async () => ({ ok: true as const, value: null });
  const model = new CodeState({ request }, () => {});
  const browser = { rect: request, state: request, takeover: request, returnToAgent: request, navigate: request, back: request, forward: request, reload: request, close: request };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ruukoto: { browser } } });
  t.after(() => { Reflect.deleteProperty(globalThis, "window"); });
  const render = () => renderToStaticMarkup(createElement(Panel, { model, sessionId: "current", visible: true }));
  const control = (markup: string, label: string) => markup.match(new RegExp(`<[^>]+aria-label="${label}"[^>]*>`))?.[0] ?? "";
  let markup = render();
  assert.doesNotMatch(control(markup, "网页地址"), / disabled=""/); assert.match(control(markup, "接管浏览器"), / disabled=""/);
  model.browser.update({ type: "browser_event", event: { session: "other", kind: "gate", owned: true, source: "host", generation: 1 } });
  assert.doesNotMatch(control(render(), "网页地址"), / disabled=""/, "another page cannot lock this browser");
  model.browser.update({ type: "browser_event", event: { session: "current", kind: "gate", owned: true, source: "host", generation: 2 } });
  markup = render();
  assert.match(control(markup, "网页地址"), / disabled=""/); assert.doesNotMatch(control(markup, "接管浏览器"), / disabled=""/);
  assert.match(markup, /aria-label="接管浏览器"[^>]*><svg/); assert.doesNotMatch(markup, />接管<|browser-gate-note/);
  model.browser.update({ type: "browser_event", event: { session: "current", kind: "gate", owned: false, source: "owner", generation: 3 } });
  markup = render(); assert.doesNotMatch(control(markup, "网页地址"), / disabled=""/); assert.match(markup, /aria-label="交还 Agent"[^>]*><svg/);
  model.browser.update({ type: "browser_event", event: { session: "current", kind: "gate", owned: false, source: "host", generation: 4 } });
  markup = render(); assert.doesNotMatch(control(markup, "网页地址"), / disabled=""/); assert.match(control(markup, "接管浏览器"), / disabled=""/); assert.doesNotMatch(markup, /交还 Agent/);
});

test("Late native browser gates cannot undo a newer takeover or reopened page", () => {
  const state = new NativeBrowserState();
  state.update({ type: "browser_event", event: { session: "s", kind: "nav", url: "https://example.test", owned: true, ownerHeld: false, generation: 2 } });
  state.update({ type: "browser_event", event: { session: "s", kind: "gate", owned: true, source: "host", generation: 1 } });
  assert.equal(state.pages.get("s")?.owned, true);
  state.update({ type: "browser_event", event: { session: "s", kind: "gate", owned: false, source: "owner", generation: 5 } });
  state.update({ type: "browser_event", event: { session: "s", kind: "gate", owned: false, source: "host", generation: 4 } });
  assert.equal(state.pages.get("s")?.ownerHeld, true);
  state.update({ type: "browser_event", event: { session: "s", kind: "closed", generation: 6 } });
  state.update({ type: "browser_event", event: { session: "s", kind: "gate", owned: true, source: "host", generation: 7 } });
  state.update({ type: "browser_event", event: { session: "s", kind: "closed", generation: 6 } });
  assert.equal(state.pages.get("s")?.gone, false); assert.equal(state.pages.get("s")?.owned, true);
});
