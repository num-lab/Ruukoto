import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "./helpers/vite.ts";
import react from "@vitejs/plugin-react";
import type { Project, Session } from "@ruukoto/core/types.ts";
import type { DesktopBridge, DesktopResult } from "../apps/desktop/src/shared/bridge.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { SettingsState, type SettingsForm, type SettingsPhase, type SettingsScope } from "../apps/desktop/src/renderer/settings-state.ts";
import { fakeSnapshot } from "./helpers/fake-control.ts";

type SettingsContentsProps = { settings: SettingsState; code: CodeState; appearance: "system" | "light" | "dark"; onAppearance: (appearance: "system" | "light" | "dark") => void; pages?: Partial<Record<string, ComponentType<{ scope: SettingsScope }>>> };
let server: ViteDevServer;
let SettingsContents: ComponentType<SettingsContentsProps>;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  ({ SettingsContents } = await server.ssrLoadModule("/settings-dialog.tsx"));
});
after(async () => { await server?.close(); });
const ok = (value: unknown): DesktopResult<unknown> => ({ ok: true, value });
function project(id: string, workspace = true): Project {
  return { id, name: `名称 ${id}`, createRequestId: null, rootDir: workspace ? { cwd: `/work/${id}`, cwdReal: `/work/${id}`, dev: 1, ino: id === "a" ? 1 : 2 } : null, instructionFiles: [], settingsVersion: 1, createdAt: "2026-10-21" };
}
function session(): Session {
  return { id: "session", projectId: "b", kind: "dev", name: null, branchSource: null, cwd: "/work/b", cwdReal: "/work/b", cwdDev: 1, cwdIno: 2, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 1, defaultAccessMode: "confirm", defaultAccessModeVersion: 1, queueState: "active", queuePauseReason: null, queueRevision: 0, archivedAt: null, createdAt: "2026-10-21" };
}
function harness(withSession = false) {
  const bridge: Pick<DesktopBridge, "request"> = { request: async () => ok(null) };
  const code = new CodeState(bridge, () => {});
  const snapshot = fakeSnapshot({ projects: [project("a"), project("b"), project("legacy", false)], sessions: withSession ? [session()] : [] });
  code.view.applySnapshot({ snapshot, replay: [], seq: 0 }, false); code.view.currentSessionId = withSession ? "session" : null;
  code.status = { type: "state", state: "online" };
  const settings = new SettingsState(() => {});
  settings.show("code");
  return { settings, code };
}
function draftForm(phase: SettingsPhase = "ready"): SettingsForm & { dirty: boolean; phase: SettingsPhase; revision: number; draft: string; current: string } {
  return { dirty: true, phase, revision: 7, draft: "草稿", current: "当前", async save() { this.dirty = false; return true; }, discard() { this.dirty = false; }, invalidate() {} };
}

test("Settings remain instance-scoped without a workspace or conversation", () => {
  const { settings, code } = harness();
  settings.chooseCategory("code-mcp");
  assert.deepEqual(settings.scope(code), { target: "code", instanceId: "inst-1" });
  assert.equal(code.view.currentSessionId, null);
  const form = draftForm(); settings.form = form;
  const scope = settings.scope(code), pageKey = settings.pageKey;
  code.view.projects = [];
  assert.deepEqual(settings.scope(code), scope);
  assert.equal(settings.pageKey, pageKey);
  assert.equal(settings.form, form);
});

test("关闭与分类切换统一保护草稿，三种决定确实执行", async () => {
  for (const action of ["close", "category"] as const) {
    const { settings } = harness(); settings.chooseCategory("code-mcp"); const form = draftForm(); settings.form = form;
    const change = () => {
      if (action === "close") settings.close();
      else settings.chooseCategory("code-skills");
    };
    change(); assert.ok(settings.leave); assert.equal(form.dirty, true);
    settings.continueEditing(); assert.equal(settings.leave, null); assert.equal(settings.category, "code-mcp");
    change(); await settings.saveAndLeave(); assert.equal(form.dirty, false); assert.equal(settings.leave, null);
  }
  const { settings } = harness(); const form = draftForm(); settings.form = form; let collapsed = false;
  settings.close(() => { collapsed = true; }); assert.equal(collapsed, false);
  settings.discardAndLeave(); assert.equal(settings.open, false); assert.equal(collapsed, true); assert.equal(form.dirty, false);
});

test("冲突保留读取修订、草稿与当前值，保存中和待核实不能离开或重复保存", async () => {
  const { settings } = harness(); const form = draftForm("conflict"); settings.form = form;
  form.save = async () => false;
  settings.close(); await settings.saveAndLeave();
  assert.deepEqual([form.revision, form.draft, form.current, settings.open], [7, "草稿", "当前", true]);
  settings.continueEditing();
  for (const phase of ["saving", "unknown"] as const) {
    form.phase = phase; let called = false; form.save = async () => { called = true; return true; };
    assert.equal(settings.close(), false); assert.equal(settings.leave, null);
    await settings.saveAndLeave(); assert.equal(called, false); assert.equal(settings.open, true); assert.match(settings.message, /Saving|unverified/);
    form.phase = "ready"; assert.equal(settings.message, "", "完成保存或核实后不残留禁止导航的旧状态");
  }
});

test("关闭、切分组、断线后重连和换实例都淘汰原读取票据", () => {
  const { settings } = harness(); settings.chooseCategory("code-mcp");
  const beforeSource = settings.ticket(); settings.chooseCategory("code-models"); assert.equal(settings.accepts(beforeSource), false);
  settings.chooseCategory("code-mcp");
  const beforeDisconnect = settings.ticket(); settings.observe("code", { type: "state", state: "reconnecting" });
  settings.observe("code", { type: "state", state: "online" }); assert.equal(settings.accepts(beforeDisconnect), false);
  const beforeSnapshot = settings.ticket(); settings.observe("code", { type: "snapshot", result: { snapshot: fakeSnapshot({ instanceId: "other" }), replay: [], seq: 0 }, instanceChanged: true });
  assert.equal(settings.accepts(beforeSnapshot), false);
  const beforeClose = settings.ticket(); settings.close(); settings.show("code"); assert.equal(settings.accepts(beforeClose), false);
});

test("换实例保留原表单供待核实，配置范围只反映当前实例", () => {
  const { settings, code } = harness(true);
  settings.chooseCategory("code-mcp");
  const form = draftForm("saving"); form.invalidate = () => { form.phase = "unknown"; }; settings.form = form;
  const pageKey = settings.pageKey;
  const result = { snapshot: fakeSnapshot({ instanceId: "third" }), replay: [], seq: 0 };
  code.view.applySnapshot(result, true);
  settings.observe("code", { type: "snapshot", result, instanceChanged: true });
  assert.deepEqual(settings.scope(code), { target: "code", instanceId: "third" });
  assert.equal(settings.form, form); assert.equal(settings.pageKey, pageKey); assert.equal(form.phase, "unknown");
});


test("设置 SSR 保留分组导航与真实内容插槽，MCP 无工作区与来源选择", () => {
  const h = harness();
  const props: SettingsContentsProps = { ...h, appearance: "dark", onAppearance() {} };
  const render = () => renderToStaticMarkup(createElement(SettingsContents, props));
  let html = render();
  for (const label of ["Appearance", "Models", "Skills", "MCP", "Computer", "Web search", "Archived chats"]) assert.ok(html.includes(label));
  h.settings.chooseCategory("appearance");
  html = render();
  assert.match(html, /aria-label="Settings categories"/); assert.match(html, /aria-label="Theme"/); assert.match(html, /System/); assert.match(html, /Light/); assert.match(html, /Dark/);
  h.settings.chooseCategory("code-mcp");
  html = render();
  assert.doesNotMatch(html, /aria-label="[Cc]onfiguration target"/); assert.doesNotMatch(html, /for="settings-target"|chat target/); assert.doesNotMatch(html, /for="settings-workspace"|for="settings-source"/); assert.match(html, /Manage HTTP services shared by this ruukoto instance/);
  let seen = "";
  props.pages = { "code-mcp": ({ scope }) => { seen = `${scope.target}/${scope.instanceId}`; return createElement("p", null, "实际页面内容"); } };
  html = render(); assert.match(html, /实际页面内容/); assert.equal(seen, "code/inst-1");
  h.settings.chooseCategory("code-mcp"); h.code.view.projects = []; h.code.view.sessions = []; html = render();
  assert.match(html, /实际页面内容/); assert.equal(seen, "code/inst-1"); assert.doesNotMatch(html, /Add( a)? workspace/);
});
