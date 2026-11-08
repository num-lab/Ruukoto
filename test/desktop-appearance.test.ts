import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "./helpers/vite.ts";
import { loadAppearance, saveAppearance } from "../apps/desktop/src/main/appearance.ts";

test("Electron appearance: missing/corrupt/unknown -> system, round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "ruukoto-appearance-"));
  try {
    assert.equal(loadAppearance(dir), "system");
    writeFileSync(join(dir, "desktop-preferences.json"), "{not json");
    assert.equal(loadAppearance(dir), "system");
    writeFileSync(join(dir, "desktop-preferences.json"), JSON.stringify({ v: 1, appearance: "sepia" }));
    assert.equal(loadAppearance(dir), "system");
    saveAppearance(dir, "dark");
    assert.equal(loadAppearance(dir), "dark");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "desktop-preferences.json"), "utf8")), { v: 1, appearance: "dark" });
    saveAppearance(dir, "light");
    assert.equal(loadAppearance(dir), "light");
    assert.ok(!readdirSync(dir).some(name => name.endsWith(".tmp")), "temporary file left");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Electron appearance: a directory at the preference path resolves to system without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ruukoto-appearance-"));
  try {
    mkdirSync(join(dir, "desktop-preferences.json"));
    assert.equal(loadAppearance(dir), "system");
    assert.throws(() => saveAppearance(dir, "dark"));
    assert.deepEqual(readdirSync(dir), ["desktop-preferences.json"], "failed save left a temporary file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Electron appearance: invalid values are rejected by the validator", async () => {
  const { appearanceValue } = await import("../apps/desktop/src/main/appearance.ts");
  for (const value of ["sepia", "", null, 1, {}, []]) assert.equal(appearanceValue(value), null);
  assert.equal(appearanceValue("system"), "system");
  assert.equal(appearanceValue("light"), "light");
  assert.equal(appearanceValue("dark"), "dark");
});

let server: ViteDevServer;
let SettingsContents: ComponentType<Record<string, unknown>>;
let App: ComponentType;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  ({ SettingsContents } = await server.ssrLoadModule("/settings-dialog.tsx"));
  ({ App } = await server.ssrLoadModule("/app.tsx"));
});
after(async () => { await server?.close(); });

test("外观分段控件呈现三项并绑定 appearance 取值", async () => {
  const { SettingsState } = await server.ssrLoadModule("/settings-state.ts") as { SettingsState: new (changed: () => void) => { chooseCategory(c: string): void; show(t: string): void } };
  const { CodeState } = await server.ssrLoadModule("/code-state.ts") as { CodeState: new (bridge: unknown, redraw: () => void) => { view: { applySnapshot(s: unknown, c: boolean): void }; status: unknown } };
  const { PersonalState } = await server.ssrLoadModule("/personal-state.ts") as { PersonalState: new (bridge: unknown, redraw: () => void) => unknown };
  const { fakeSnapshot } = await import("./helpers/fake-control.ts");
  const bridge = { request: async () => ({ ok: true, value: null }) };
  const code = new CodeState(bridge, () => {});
  code.view.applySnapshot({ snapshot: fakeSnapshot({ projects: [], sessions: [] }), replay: [], seq: 0 }, false);
  code.status = { type: "state", state: "online" };
  const personal = new PersonalState(bridge, () => {});
  const settings = new SettingsState(() => {});
  settings.show("code");
  settings.chooseCategory("appearance");
  const props = { settings, code, personal, appearance: "dark", onAppearance() {} };
  const html = renderToStaticMarkup(createElement(SettingsContents, props));
  assert.match(html, /System/); assert.match(html, /Light/); assert.match(html, /Dark/);
  assert.match(html, /aria-pressed="true"[^>]*>[^<]*<svg[^]*?Dark/);
});

test("没有当前会话时不渲染右栏开关", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      ruukoto: {
        subscribe: () => () => {},
        request: async () => ({ ok: true, value: undefined }),
        appearance: async () => ({ ok: true, value: "system" }),
        setAppearance: async () => ({ ok: true, value: undefined }),
      },
    },
  });
  try {
    const html = renderToStaticMarkup(createElement(App));
    assert.doesNotMatch(html, /inspector-toggle/);
  } finally { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); }
});
