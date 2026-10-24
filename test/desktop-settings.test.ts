import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { Project, Session } from "@ruukoto/core/types.ts";
import type { DesktopBridge, DesktopFailure, DesktopResult } from "../apps/desktop/src/shared/bridge.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { PersonalConnectionState } from "../apps/desktop/src/renderer/personal-connection-state.ts";
import { SettingsState, type SettingsForm, type SettingsPhase, type SettingsScope } from "../apps/desktop/src/renderer/settings-state.ts";
import { fakeSnapshot } from "./helpers/fake-control.ts";

type SettingsContentsProps = { settings: SettingsState; code: CodeState; personal: CodeState; dark: boolean; onDark: (dark: boolean) => void; pages?: { mcp?: ComponentType<{ scope: SettingsScope }> } };
let server: ViteDevServer;
let SettingsContents: ComponentType<SettingsContentsProps>;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ SettingsContents } = await server.ssrLoadModule("/settings-dialog.tsx"));
});
after(async () => { await server?.close(); });
const ok = (value: unknown): DesktopResult<unknown> => ({ ok: true, value });
const fail = (outcome: DesktopFailure["outcome"], code = "test_failure"): DesktopResult<unknown> => ({ ok: false, error: { code, outcome, message: "测试失败" } });
const initial = { host: "pa", controlDir: "/control" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function project(id: string, workspace = true): Project {
  return { id, name: `名称 ${id}`, createRequestId: null, rootDir: workspace ? { cwd: `/work/${id}`, cwdReal: `/work/${id}`, dev: 1, ino: id === "a" ? 1 : 2 } : null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: "2026-10-21" };
}
function session(): Session {
  return { id: "session", projectId: "legacy", workspaceProjectId: "b", kind: "dev", name: null, branchSource: null, cwd: "/work/b", cwdReal: "/work/b", cwdDev: 1, cwdIno: 2, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 1, defaultAccessMode: "confirm", defaultAccessModeVersion: 1, queueState: "active", queuePauseReason: null, archivedAt: null, createdAt: "2026-10-21" };
}
function harness(withSession = false) {
  const bridge: Pick<DesktopBridge, "request"> = { request: async () => ok(null) };
  const code = new CodeState(bridge, () => {}), personal = new CodeState(bridge, () => {}, "personal");
  const snapshot = fakeSnapshot({ projects: [project("a"), project("b"), project("legacy", false)], sessions: withSession ? [session()] : [] });
  code.view.applySnapshot({ snapshot, replay: [], seq: 0 }, false); code.view.currentSessionId = withSession ? "session" : null;
  code.status = { type: "state", state: "online" };
  const settings = new SettingsState(() => {});
  settings.show("code");
  return { settings, code, personal };
}
function draftForm(phase: SettingsPhase = "ready"): SettingsForm & { dirty: boolean; phase: SettingsPhase; revision: number; draft: string; current: string } {
  return { dirty: true, phase, revision: 7, draft: "草稿", current: "当前", async save() { this.dirty = false; return true; }, discard() { this.dirty = false; }, invalidate() {} };
}

test("设置无工作区与会话可用，各类别独立选目标，MCP 只关联实例", () => {
  const { settings, code, personal } = harness();
  settings.chooseCategory("mcp");
  assert.deepEqual(settings.scope(code, personal), { target: "code", instanceId: "inst-1" });
  settings.chooseTarget("mcp", "personal");
  assert.equal(code.view.currentSessionId, null);
  assert.deepEqual(settings.scope(code, personal), { target: "personal", instanceId: null });
  settings.chooseCategory("models"); assert.equal(settings.scope(code, personal).target, "code");
  settings.chooseCategory("skills"); settings.chooseTarget("skills", "personal");
  settings.chooseCategory("models"); assert.equal(settings.scope(code, personal).target, "code");
  const mapped = harness(true);
  mapped.settings.close(); mapped.settings.show("code", "mcp");
  const scope = mapped.settings.scope(mapped.code, mapped.personal), pageKey = mapped.settings.pageKey;
  const form = draftForm(); mapped.settings.form = form;
  mapped.code.view.currentSessionId = null; mapped.code.view.projects = [];
  assert.deepEqual(mapped.settings.scope(mapped.code, mapped.personal), scope);
  assert.equal(mapped.settings.pageKey, pageKey); assert.equal(mapped.settings.form, form); assert.equal(form.dirty, true);
});

test("关闭、分类与目标切换统一保护草稿，三种决定确实执行", async () => {
  for (const action of ["close", "category", "target"] as const) {
    const { settings } = harness(); settings.chooseCategory("mcp"); const form = draftForm(); settings.form = form;
    const change = () => {
      if (action === "close") settings.close();
      else if (action === "category") settings.chooseCategory("skills");
      else settings.chooseTarget("mcp", "personal");
    };
    change(); assert.ok(settings.leave); assert.equal(form.dirty, true);
    settings.continueEditing(); assert.equal(settings.leave, null); assert.equal(settings.category, "mcp");
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
    await settings.saveAndLeave(); assert.equal(called, false); assert.equal(settings.open, true); assert.match(settings.message, /保存/);
    form.phase = "ready"; assert.equal(settings.message, "", "完成保存或核实后不残留禁止导航的旧状态");
  }
});

test("关闭、切目标、断线后重连和换实例都淘汰原读取票据", () => {
  const { settings } = harness(); settings.chooseCategory("mcp");
  const beforeSource = settings.ticket(); settings.chooseTarget("mcp", "personal"); assert.equal(settings.accepts(beforeSource), false);
  settings.chooseTarget("mcp", "code");
  const beforeDisconnect = settings.ticket(); settings.observe("code", { type: "state", state: "reconnecting" });
  settings.observe("code", { type: "state", state: "online" }); assert.equal(settings.accepts(beforeDisconnect), false);
  const beforeSnapshot = settings.ticket(); settings.observe("code", { type: "snapshot", result: { snapshot: fakeSnapshot({ instanceId: "other" }), replay: [], seq: 0 }, instanceChanged: true });
  assert.equal(settings.accepts(beforeSnapshot), false);
  const beforeClose = settings.ticket(); settings.close(); settings.show("code"); assert.equal(settings.accepts(beforeClose), false);
});

test("换实例保留原表单供待核实，配置范围只反映当前实例", () => {
  const { settings, code, personal } = harness(true);
  settings.chooseCategory("mcp");
  const form = draftForm("saving"); form.invalidate = () => { form.phase = "unknown"; }; settings.form = form;
  const pageKey = settings.pageKey;
  const result = { snapshot: fakeSnapshot({ instanceId: "third" }), replay: [], seq: 0 };
  code.view.applySnapshot(result, true);
  settings.observe("code", { type: "snapshot", result, instanceChanged: true });
  assert.deepEqual(settings.scope(code, personal), { target: "code", instanceId: "third" });
  assert.equal(settings.form, form); assert.equal(settings.pageKey, pageKey); assert.equal(form.phase, "unknown");
});

for (const outcome of ["not_sent", "rejected", "unknown", "disconnected"] as const) test(`PA 本机连接配置：${outcome} 保留草稿并按结果决定能否再保存`, async () => {
  const calls: string[] = [];
  let readResult = ok(initial);
  const state = new PersonalConnectionState({ request: async (_target, op) => { calls.push(op); return op.endsWith("read") ? readResult : fail(outcome); } }, () => {});
  await state.read(); state.edit("host", "next");
  assert.equal(await state.save(), false); assert.equal(state.draft.host, "next");
  const uncertain = outcome === "unknown" || outcome === "disconnected";
  assert.equal(state.phase, uncertain ? "unknown" : "error"); assert.equal(!!state.pending, uncertain);
  if (uncertain) {
    assert.deepEqual(state.pending, { target: "personal", op: "desktop_personal_config_save", config: { host: "next", controlDir: "/control" } });
    assert.equal(await state.save(), false); readResult = fail("not_sent"); await state.read();
    assert.equal(state.phase, "unknown"); assert.equal(state.draft.host, "next");
    readResult = ok({ ...initial, host: "next" }); await state.read();
    assert.equal(state.phase, "ready"); assert.equal(state.dirty, false); assert.equal(state.pending, null);
  }
  assert.equal(calls.filter(op => op.endsWith("save")).length, 1);
});

test("PA 保存和读取绑定原轮次，重复提交不发送，冲突读回不覆盖草稿", async () => {
  const response = deferred<DesktopResult<unknown>>(); let writes = 0;
  const state = new PersonalConnectionState({ request: async (_target, op) => {
    if (op.endsWith("read")) return ok(initial);
    ++writes; return response.promise;
  } }, () => {});
  await state.read(); state.edit("host", "next"); const saving = state.save();
  assert.equal(state.phase, "saving"); assert.equal(await state.save(), false); assert.equal(writes, 1);
  state.invalidate(); response.resolve(ok({ ...initial, host: "next" })); await saving;
  assert.equal(state.phase, "unknown"); assert.equal(state.draft.host, "next");
  await state.read(); assert.equal(state.phase, "conflict"); assert.equal(state.current?.host, "pa"); assert.equal(state.draft.host, "next");
  assert.equal(state.dirty, true);
  const readResponse = deferred<DesktopResult<unknown>>();
  const reading = new PersonalConnectionState({ request: async () => readResponse.promise }, () => {});
  const pending = reading.read(); reading.invalidate(); readResponse.resolve(ok(initial)); await pending;
  assert.equal(reading.loaded, false); assert.equal(reading.draft.host, "");
});

test("PA 字段校验定位错误，未知 IPC 异常保留待核实", async () => {
  const state = new PersonalConnectionState({ request: async (_target, op) => { if (op.endsWith("read")) return ok(initial); throw new Error("bridge lost"); } }, () => {});
  await state.read(); state.edit("host", "bad host"); assert.equal(await state.save(), false); assert.ok(state.fieldErrors.host);
  state.edit("host", "next"); assert.equal(await state.save(), false); assert.equal(state.phase, "unknown");
});

test("设置 SSR 保留六分类与真实内容插槽，MCP 无工作区与来源选择", () => {
  const h = harness();
  const props: SettingsContentsProps = { ...h, dark: true, onDark() {} };
  const render = () => renderToStaticMarkup(createElement(SettingsContents, props));
  let html = render();
  for (const label of ["外观", "模型", "Skills", "MCP", "PA 远程连接", "已存档会话"]) assert.ok(html.includes(label));
  assert.match(html, /aria-label="设置类别"/); assert.match(html, /for="settings-theme"/);
  h.settings.chooseCategory("mcp");
  html = render();
  const targetTabs = html.match(/<div[^>]*role="tablist"[^>]*aria-label="配置目标"[^>]*>(.*?)<\/div>/s)?.[1];
  assert.ok(targetTabs); assert.equal((targetTabs.match(/role="tab"/g) ?? []).length, 2);
  assert.match(targetTabs, />Code<\/button>/); assert.match(targetTabs, />PA<\/button>/);
  assert.doesNotMatch(html, /for="settings-target"|仅选择设置的归属，不切换聊天目标。/); assert.doesNotMatch(html, /for="settings-workspace"|for="settings-source"/); assert.match(html, /Code MCP 配置/);
  let seen = "";
  props.pages = { mcp: ({ scope }) => { seen = `${scope.target}/${scope.instanceId}`; return createElement("p", null, "实际页面内容"); } };
  html = render(); assert.match(html, /实际页面内容/); assert.equal(seen, "code/inst-1");
  h.settings.chooseTarget("mcp", "personal"); html = render(); assert.doesNotMatch(html, /for="settings-workspace"|for="settings-source"/); assert.match(html, /data-state="active"[^>]*value="personal"|aria-selected="true"[^>]*aria-controls="[^"]*content-personal"/);
  h.settings.chooseTarget("mcp", "code"); h.code.view.projects = []; h.code.view.sessions = []; html = render();
  assert.match(html, /实际页面内容/); assert.equal(seen, "code/inst-1"); assert.doesNotMatch(html, /先添加工作区|添加工作区/);
});

test("PA 新管理连接有独立用途页签、对应面板与字段标签", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ruukoto: { request: async () => ok(null) } } });
  try {
    const h = harness(); h.settings.chooseCategory("personal");
    const html = renderToStaticMarkup(createElement(SettingsContents, { ...h, dark: false, onDark() {} }));
    assert.match(html, /aria-label="PA 连接用途"/); assert.match(html, /role="tabpanel"/);
    assert.match(html, /aria-label="PA 设置管理连接"/);
    for (const field of ["host", "profileDir", "program", "lifecycle"]) assert.ok(html.includes(`for="management-${field}"`));
    assert.match(html, /检测程序/); assert.match(html, /旧聊天连接/);
    assert.doesNotMatch(html, /name="token"|name="command"/);
  } finally { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); }
});
