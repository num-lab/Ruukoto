import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { handleRequest } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge } from "../apps/desktop/src/shared/bridge.ts";
import { CodeMcpState } from "../apps/desktop/src/renderer/code-mcp-state.ts";

// Note: 见 .agents/notes/implemented/feature/2026-10-25-desktop-computer-websearch-settings.md
type Service = OpResult<"mcp_list">["services"][number];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function cuaSettingsFixture() {
  const config = { kind: "cua-mac" as const, executable: "/Applications/Cua.app/Contents/MacOS/cua-driver", version: "0.38.0" as const, sha256: "a".repeat(64) };
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
  const artifact = { id: "screenshot", taskId: "original-task", sessionId: "original-session", name: "screenshot", byteCount: bytes.length, status: "complete", mimeType: "image/png", contentHash: createHash("sha256").update(bytes).digest("hex"), createdAt: "now" };
  const services: Service[] = [];
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const control = { fail: "", unavailable: false, image: artifact, before: undefined as ((op: string) => Promise<void>) | undefined, status: { state: "recovering", stopped: true, ownerStarted: true, original: { opId: "unknown-operation", taskId: artifact.taskId, sessionId: artifact.sessionId, toolName: "click", effect: "write", state: "frozen" }, observation: { id: "new-observation", artifactIds: [artifact.id] } } as NonNullable<CodeMcpState["cuaStatus"]> };
  const context = { instanceId: "instance", online: true };
  const bridge: Pick<DesktopBridge, "request"> = { request: (target, op, params) => handleRequest(target, op, params, async () => {}, async (name, input) => {
    const fields = input as Record<string, unknown>;
    calls.push({ op: name, params: structuredClone(fields) });
    await control.before?.(name);
    if (name === control.fail) throw new ControlClientError("cua_unavailable", "当前电脑程序或权限未核实", "rejected");
    if (name === "mcp_list") return { services: structuredClone(services) };
    if (name === "list_credentials") return [];
    if (name === "mcp_cua_targets") return { targets: control.unavailable ? [] : [{ label: "本机 Cua Driver 0.38.0", config }], issues: control.unavailable ? [{ code: "cua_not_installed", message: "请安装固定版本 Cua Driver。" }] : [] };
    if (name === "mcp_configure") { const service = { id: "computer", name: fields.name, cua: fields.cua, credential: null, toolAllowlist: fields.tool_allowlist, enabled: fields.enabled, configVersion: 1, createdAt: "now", updatedAt: "now" }; services.push(service as Service); return service; }
    if (name === "mcp_set_enabled") { services[0].enabled = !!fields.enabled; services[0].configVersion++; return services[0]; }
    if (name === "mcp_check") return { ok: false, service: services[0], tools: [], permissions: { accessibility: false, screenRecording: true }, errorCode: "cua_permissions_missing", error: "实际 direct 启动宿主缺少辅助功能权限。" };
    if (name === "get_tool_op_mcp") return { text: '{"arguments":{"x":12,"y":34}}', offset: 0, totalBytes: 35, truncated: false };
    if (name === "read_artifact") return { artifact: control.image, encoding: "base64", data: bytes.subarray(Number(fields.offset), Number(fields.offset) + Number(fields.length)).toString("base64") };
    if (name === "mcp_cua_accept") { control.status = { state: "idle", stopped: false, ownerStarted: false }; return control.status; }
    if (name.startsWith("mcp_cua_")) return structuredClone(control.status);
    assert.fail(`未覆盖的 Code Cua 操作：${name}`);
  }) };
  const state = new CodeMcpState(bridge, () => {}, "instance", () => context, "computer");
  return { state, config, services, calls, control, context, bridge };
}

test("电脑页添加默认固定 Cua 草稿，同名冲突只认电脑服务", async () => {
  const h = cuaSettingsFixture();
  const cuaService = { id: "mac", name: "computer", cua: h.config, credential: null, toolAllowlist: [], enabled: true, configVersion: 2, createdAt: "now", updatedAt: "now" } as Service;
  const httpService = { id: "docs", name: "docs", endpoint: "https://mcp.example.com/mcp", credential: null, toolAllowlist: [], enabled: true, configVersion: 1, createdAt: "now", updatedAt: "now" } as Service;
  h.services.push(cuaService, httpService);
  await h.state.read(); h.state.select(null);
  assert.equal(h.state.draft.kind, "cua-mac"); assert.equal(h.state.draft.name, "computer"); assert.equal(h.state.draft.auth, "anonymous");
  h.state.phase = "conflict";
  assert.equal(h.state.conflictingService?.id, "mac");
  const mcpState = new CodeMcpState(h.bridge, () => {}, "instance", () => h.context);
  await mcpState.read(); mcpState.select(null); mcpState.edit("name", "computer"); mcpState.phase = "conflict";
  assert.equal(mcpState.draft.kind, "http");
  assert.equal(mcpState.conflictingService, null, "MCP 页的同名冲突不认领电脑服务");
});

test("Code 旧开始恢复操作在IPC拒绝，停止后直接使用合并观察", async () => {
  let called = false;
  const retired = await handleRequest("code", "mcp_cua_begin_recovery", {}, async () => {}, async () => { called = true; });
  assert.equal(retired.ok, false); if (!retired.ok) assert.equal(retired.error.code, "op_not_allowed");
  assert.equal(called, false);
  const h = cuaSettingsFixture(); await h.state.read();
  h.control.status = { ...h.control.status, state: "frozen", stopped: true, ownerStarted: false, observation: undefined };
  await h.state.refreshCua(); await h.state.cuaAction("observe");
  assert.equal(h.calls.filter(call => call.op === "mcp_cua_observe").length, 1);
  assert.equal(h.calls.some(call => call.op === "mcp_cua_begin_recovery"), false);
});

test("Code Cua 正常设置选择固定程序，不走HTTP认证；缺安装、缺权限与保存拒绝保留草稿", async () => {
  const h = cuaSettingsFixture(); await h.state.read(); h.state.select(null);
  assert.equal(h.state.dirty, false, "未选择 Driver 前没有可保存的草稿");
  h.state.edit("name", "mac");
  assert.equal(await h.state.save(), false); assert.ok(h.state.fieldErrors.cua);
  h.control.unavailable = true; await h.state.read();
  assert.equal(h.state.cuaTargets.length, 0); assert.match(h.state.cuaIssues[0].message, /安装/);
  h.control.unavailable = false; await h.state.read(); h.state.selectCua(0);
  h.control.fail = "mcp_configure"; assert.equal(await h.state.save(), false); assert.equal(h.state.dirty, true); assert.deepEqual(h.state.draft.cua, h.config);
  h.control.fail = ""; assert.equal(await h.state.save(), true);
  const saved = h.calls.find(call => call.op === "mcp_configure")!.params;
  assert.deepEqual(saved.cua, h.config); assert.equal(saved.enabled, false); assert.equal(saved.expected_version, 0);
  assert.equal(Object.hasOwn(saved, "endpoint"), false); assert.equal(Object.hasOwn(saved, "credential"), false);
  await h.state.discover(); assert.equal(h.state.check?.permissions?.accessibility, false); assert.match(h.state.check!.error!, /direct.*辅助功能/);
  assert.equal(await h.state.setEnabled(true), true); await h.state.pauseCua();
  const disable = h.calls.findLastIndex(call => call.op === "mcp_set_enabled" && call.params.enabled === false), stop = h.calls.findIndex(call => call.op === "mcp_cua_stop");
  assert.ok(disable >= 0 && disable < stop, "先拒绝新调用，再核实原执行停止");
  assert.equal(h.calls[stop].params.service_id, h.state.service!.id, "停止绑定选中的原服务");
});

test("Code Cua 恢复绑定实际展示的新截图；旧图片事件、重观察失败与错误归属均不能接受", async () => {
  const h = cuaSettingsFixture(); await h.state.read(); await h.state.refreshCua();
  assert.equal(h.state.cuaImages.length, 1); assert.match(h.state.cuaImages[0].source, /^data:image\/png;base64,/);
  assert.equal(h.state.canAcceptCua, false); await h.state.cuaAction("accept"); assert.equal(h.calls.some(call => call.op === "mcp_cua_accept"), false);
  h.state.imageLoaded("old-observation", "screenshot", true); assert.equal(h.state.canAcceptCua, false);
  h.state.imageLoaded("new-observation", "screenshot", true); assert.equal(h.state.canAcceptCua, true);
  h.control.fail = "mcp_cua_observe"; await h.state.cuaAction("observe");
  assert.equal(h.state.cuaImages.length, 0); assert.equal(h.state.canAcceptCua, false);
  h.state.imageLoaded("new-observation", "screenshot", true); assert.equal(h.state.canAcceptCua, false);
  h.control.fail = ""; await h.state.refreshCua(); assert.equal(h.state.cuaImages.length, 0); assert.equal(h.state.canAcceptCua, false);
  h.control.status = { ...h.control.status, observation: { id: "retry-observation", artifactIds: ["screenshot"] } };
  h.control.image = { ...h.control.image, taskId: "unrelated-task" }; await h.state.refreshCua();
  assert.equal(h.state.cuaImages.length, 0); assert.equal(h.state.canAcceptCua, false); assert.match(h.state.cuaError, /归属/);
  h.control.image = { ...h.control.image, taskId: "original-task" }; await h.state.refreshCua(); h.state.imageLoaded("retry-observation", "screenshot", true);
  await h.state.cuaAction("accept"); assert.equal(h.state.cuaStatus?.state, "idle");
  assert.deepEqual(h.calls.find(call => call.op === "mcp_cua_accept")?.params, { observation_id: "retry-observation" });
});

test("Code Cua 暂停停止未核实仍保持停用，中断原任务后可重新核实停止", async () => {
  const h = cuaSettingsFixture(); await h.state.read(); h.state.select(null); h.state.selectCua(0); await h.state.save(); await h.state.setEnabled(true);
  h.control.fail = "mcp_cua_stop"; await h.state.pauseCua();
  assert.equal(h.state.service?.enabled, false); assert.match(h.state.cuaError, /未核实/);
  h.control.fail = ""; await h.state.pauseCua();
  assert.equal(h.calls.filter(call => call.op === "mcp_cua_stop").length, 2);
  assert.equal(h.calls.filter(call => call.op === "mcp_set_enabled" && call.params.enabled === false).length, 1);
});

test("Code Cua 暂停读回时原服务已删除，停止仍绑定原选择且不抛错", async () => {
  const h = cuaSettingsFixture(); await h.state.read(); h.state.select(null); h.state.selectCua(0); await h.state.save(); await h.state.setEnabled(true);
  h.control.before = async op => { if (op === "mcp_list" && h.services[0]?.enabled === false) h.services.splice(0); };
  await assert.doesNotReject(h.state.pauseCua());
  assert.equal(h.state.service, null);
  assert.deepEqual(h.calls.findLast(call => call.op === "mcp_cua_stop")?.params, { service_id: "computer" });
});

test("Code Cua 关闭设置后的迟到图片不能恢复接受资格", async () => {
  const h = cuaSettingsFixture(); await h.state.read();
  const began = deferred(), release = deferred();
  h.control.before = async op => { if (op === "read_artifact") { began.resolve(); await release.promise; } };
  const reading = h.state.refreshCua(); await began.promise;
  h.state.invalidate(); release.resolve(); await reading;
  assert.equal(h.state.cuaImages.length, 0); assert.equal(h.state.canAcceptCua, false); assert.equal(h.state.checking, false);
});

test("Code 电脑设置页展示程序选择、宿主权限与实际恢复图片", async t => {
  const { createElement } = await import("react"), { renderToStaticMarkup } = await import("react-dom/server");
  const { createServer } = await import("vite"), { default: react } = await import("@vitejs/plugin-react"), { fileURLToPath } = await import("node:url");
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { CodeComputerEditor } = await server.ssrLoadModule("/code-computer-settings.tsx");
  const h = cuaSettingsFixture(); await h.state.read(); h.state.select(null); h.state.selectCua(0); await h.state.save(); await h.state.discover(); await h.state.refreshCua();
  const html = renderToStaticMarkup(createElement(CodeComputerEditor, { state: h.state }));
  assert.match(html, /本机 Cua Driver/); assert.match(html, /辅助功能：未授权/); assert.match(html, /屏幕录制：已授权/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,/); assert.match(html, /恢复新截图 1/); assert.match(html, /确认恢复/);
  assert.doesNotMatch(html, /HTTPS 端点|Bearer 令牌|恢复观察ID|进程代次/);
});
