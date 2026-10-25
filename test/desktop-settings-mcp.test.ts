import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { handleRequest } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge } from "../apps/desktop/src/shared/bridge.ts";
import { CodeMcpState } from "../apps/desktop/src/renderer/code-mcp-state.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { startMockMcp, MOCK_MCP_SECRET } from "./helpers/mock-mcp.ts";
import { startTestRuntime } from "./helpers/testkit.ts";

// Note: 见 .agents/notes/implemented/testing/2026-10-24-test-suite-reduction.md
const SECRET = MOCK_MCP_SECRET;
type Service = OpResult<"mcp_list">["services"][number];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, withWorkspaces = true) {
  const kit = await startTestRuntime("desktop-settings-mcp", () => ({ kind: "text", text: "ok" }), { config: { product: product.runtime } });
  const mcp = await startMockMcp({ tools: [{ name: "lookup", annotations: { readOnlyHint: true } }, { name: "change" }] });
  t.after(async () => { await mcp.close(); await kit.shutdown(); });
  const requests: { op: string; params: Record<string, unknown> }[] = [];
  const hook: { before?: (op: string) => Promise<void>; after?: (op: string) => Promise<void> } = {};
  const bridge: Pick<DesktopBridge, "request"> = { request: (target, op, params) => handleRequest(target, op, params, async () => {}, async (name, input) => {
    requests.push({ op: name, params: structuredClone(input) });
    await hook.before?.(name);
    const result = await kit.client.request(name, input);
    await hook.after?.(name);
    return result;
  }) };
  const workspaces = withWorkspaces ? await Promise.all(kit.work.map(cwd => kit.runtime.openWorkspace({ cwd }))) : [];
  const code = new CodeState(bridge, () => {});
  code.update({ type: "snapshot", result: await kit.client.handshake(), instanceChanged: false });
  code.update({ type: "state", state: "online" });
  const context = { instanceId: code.view.instanceId, online: true };
  const createState = () => new CodeMcpState(bridge, () => {}, code.view.instanceId!, () => context);
  const state = createState();
  await state.read();
  const list = async () => (await kit.client.request<OpResult<"mcp_list">>("mcp_list", {})).services;
  const create = (name = "docs", credential?: string) => kit.client.request<Service>("mcp_configure", { name, endpoint: mcp.url, credential: credential ?? null, tool_allowlist: [], enabled: false, expected_version: 0 });
  return { ...kit, mcp, requests, hook, bridge, code, context, state, createState, workspaces, list, create };
}

async function rendererFixture() {
  const service: Service = { id: "service", name: "docs", endpoint: "https://mcp.example.com/mcp", credential: null, toolAllowlist: [], enabled: false, configVersion: 1, createdAt: "now", updatedAt: "now" };
  const services: Service[] = [], credentials: OpResult<"list_credentials"> = [], requests: { op: string; params: Record<string, unknown> }[] = [];
  const context = { instanceId: "instance", online: true };
  const hook: { before?: (op: string) => Promise<void>; after?: (op: string) => Promise<void>; reply?: (op: string, params: Record<string, unknown>) => unknown } = {};
  const bridge: Pick<DesktopBridge, "request"> = { request: (target, op, params) => handleRequest(target, op, params, async () => {}, async (name, input) => {
    requests.push({ op: name, params: structuredClone(input) }); await hook.before?.(name);
    const result = name === "mcp_list" ? { services: structuredClone(services) }
      : name === "list_credentials" ? structuredClone(credentials)
      : name === "mcp_cua_targets" ? { targets: [], issues: [] }
      : name === "mcp_check" ? { ok: true, service: structuredClone(service), tools: [] }
      : hook.reply ? hook.reply(name, input) : assert.fail(`未预期的写操作：${name}`);
    await hook.after?.(name); return result;
  }) };
  const state = new CodeMcpState(bridge, () => {}, "instance", () => context);
  await state.read();
  return { state, service, services, credentials, requests, context, hook, url: service.endpoint! };
}

function fillNew(state: CodeMcpState, endpoint: string, name = "docs") {
  state.select(null); state.edit("name", name); state.edit("endpoint", endpoint);
}

function assertRedacted(value: unknown, extra: string[] = []) {
  const encoded = JSON.stringify(value);
  for (const secret of [SECRET, ...extra]) assert.equal(encoded.includes(secret), false, "读取和显示不得包含秘密");
}



test("Code MCP 无工作区可创建服务，打开两个工作区后共用身份与版本", async t => {
  const h = await fixture(t, false);
  assert.equal(h.runtime.store.listProjects().filter(project => project.rootDir !== null).length, 0);
  fillNew(h.state, h.mcp.url); h.state.edit("auth", "anonymous");
  assert.equal(await h.state.save(), true, h.state.message);
  const original = h.state.service!;
  await Promise.all(h.work.map(cwd => h.runtime.openWorkspace({ cwd })));
  const other = h.createState(); await other.read(); other.select(original.id);
  assert.deepEqual(other.service, original);
  assert.equal(await other.setEnabled(true), true, other.message);
  await h.state.read();
  assert.equal(h.state.service?.id, original.id); assert.equal(h.state.service?.enabled, true);
  assert.equal(h.state.service?.configVersion, original.configVersion + 1);
  assert.equal(await h.state.setEnabled(false), true, h.state.message);
  await other.read(); assert.equal(other.service?.enabled, false);
  assert.equal(await other.remove(), true, other.message);
  await h.state.read(); assert.equal(h.state.services.length, 0);
  assert.ok(h.requests.filter(request => request.op.startsWith("mcp_") || request.op === "list_credentials").every(request => !["project_id", "workspace_id", "selected_project_id"].some(key => Object.hasOwn(request.params, key))));
});

test("Code MCP 先保存禁用匿名草稿再发现，允许项默认 unknown，显式启停移除均读回版本", async t => {
  const h = await fixture(t);
  fillNew(h.state, h.mcp.url);
  assert.equal(await h.state.save(), false);
  assert.ok(h.state.fieldErrors.auth);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").length, 0);
  h.state.edit("auth", "anonymous");
  assert.equal(await h.state.save(), true, h.state.message);
  assert.equal(h.state.service?.enabled, false); assert.equal(h.state.service?.configVersion, 1);
  assert.equal(h.mcp.hits.length, 0, "保存配置不等于连接测试");
  await h.state.discover();
  assert.equal(h.state.check?.ok, true, h.state.message);
  assert.deepEqual(h.state.check?.tools.map(tool => ({ name: tool.name, allowed: tool.allowed })), [{ name: "lookup", allowed: false }, { name: "change", allowed: false }]);
  assert.ok(h.mcp.hits.some(hit => hit.rpcMethod === "tools/list"));
  assert.equal(h.mcp.hits.some(hit => hit.rpcMethod === "tools/call"), false);
  h.state.allow("lookup", true); h.state.allow("change", true);
  assert.deepEqual(h.state.draft.toolAllowlist, [{ name: "lookup", effect: "unknown" }, { name: "change", effect: "unknown" }]);
  h.state.effect("lookup", "read"); h.state.effect("change", "write");
  assert.equal(await h.state.save(), true, h.state.message);
  assert.equal(h.state.service?.enabled, false); assert.equal(h.state.service?.configVersion, 2);
  assert.equal(await h.state.setEnabled(true), true, h.state.message);
  assert.equal(h.state.service?.enabled, true); assert.equal(h.state.service?.configVersion, 3);
  assert.equal(await h.state.setEnabled(false), true, h.state.message);
  assert.equal(h.state.service?.enabled, false); assert.equal(h.state.service?.configVersion, 4);
  assert.equal(await h.state.remove(), true, h.state.message);
  assert.equal(h.state.services.length, 0);
  assert.equal(h.mcp.hits.some(hit => hit.rpcMethod === "tools/call"), false);
});

test("Code MCP 新凭据首次落盘已限实例 MCP 用途，编辑省略保留而显式匿名以 null 清除，引用中拒绝删除", async t => {
  const h = await fixture(t);
  fillNew(h.state, h.mcp.url); h.state.edit("auth", "new"); h.state.editSecret(SECRET);
  assert.equal(await h.state.save(), true, h.state.message);
  assert.equal(h.state.secret, "");
  const credential = h.state.service!.credential!;
  assert.deepEqual(h.runtime.credentials.get(credential)?.scope, { operations: ["mcp"] });
  assert.equal(h.runtime.credentials.getForUse(credential), null);
  assert.notEqual(h.runtime.credentials.getForUse(credential, { projectId: h.workspaces[1].session.projectId, operation: "mcp" }), null);
  const metadata = h.state.credentials.find(item => item.name === credential)!;
  assert.equal(metadata.references.length, 1);
  assert.equal(metadata.references[0].serviceId, h.state.service!.id);
  assert.equal(await h.state.removeCredential(credential), false);
  assert.notEqual(h.runtime.credentials.get(credential), null);
  h.state.edit("endpoint", `${h.mcp.url}/edited`);
  assert.equal(await h.state.save(), true, h.state.message);
  const edit = h.requests.filter(request => request.op === "mcp_configure").at(-1)!;
  assert.equal(Object.hasOwn(edit.params, "credential"), false);
  assert.equal(h.state.service?.credential, credential);
  h.state.edit("auth", "anonymous");
  assert.equal(await h.state.save(), true, h.state.message);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").at(-1)?.params.credential, null);
  assert.equal(h.state.service?.credential, null);
  assert.equal(await h.state.removeCredential(credential), true, h.state.message);
  assert.equal(h.runtime.credentials.get(credential), null);
  assertRedacted([h.state.services, h.state.credentials, h.state.draft, h.state.message, h.runtime.store.getEventsAfter(0)]);
});

test("Code MCP 后台拒绝凭据时保留草稿且不退回匿名", async () => {
  const h = await rendererFixture();
  h.hook.before = async op => { if (op === "mcp_configure") throw new ControlClientError("invalid_params", "凭据不匹配", "rejected"); };
  fillNew(h.state, h.url); h.state.edit("auth", "existing");
  for (const credential of ["wrong-host", "wrong-purpose", "wrong-source", "missing"]) {
    h.state.edit("credential", credential);
    assert.equal(await h.state.save(), false);
    assert.equal(h.state.services.length, 0);
    assert.equal(h.requests.filter(request => request.op === "mcp_configure").at(-1)?.params.credential, credential);
    assert.notEqual(h.state.phase, "unknown");
    assertRedacted([h.state.message, h.state.services, h.state.credentials]);
  }
});

test("Code MCP 版本冲突读回当前值并保留草稿，已保存凭据仍仅限 MCP 且可跨工作区使用", async t => {
  const h = await fixture(t);
  const original = await h.create(); await h.state.read(); h.state.select(original.id);
  h.state.edit("endpoint", `${h.mcp.url}/draft`); h.state.edit("auth", "new"); h.state.editSecret(SECRET);
  await h.client.request("mcp_set_enabled", { service_id: original.id, enabled: true, expected_version: original.configVersion });
  assert.equal(await h.state.save(), false);
  assert.equal(h.state.phase, "conflict"); assert.equal(h.state.secret, "");
  assert.equal(h.state.draft.endpoint, `${h.mcp.url}/draft`);
  assert.equal(h.state.service?.endpoint, h.mcp.url); assert.equal(h.state.service?.configVersion, 2);
  const created = h.requests.find(request => request.op === "mcp_save_credential")!;
  const credential = String(created.params.name);
  assert.deepEqual(h.runtime.credentials.get(credential)?.scope, { operations: ["mcp"] });
  assert.equal(h.runtime.credentials.getForUse(credential), null);
  assert.notEqual(h.runtime.credentials.getForUse(credential, { projectId: h.workspaces[1].session.projectId, operation: "mcp" }), null);
  assert.equal(h.runtime.credentials.getForUse(credential, { operation: "http" }), null);
  h.state.discard();
  assert.equal(h.state.draft.endpoint, h.state.service!.endpoint);
  assert.equal(h.state.draft.credential, h.state.service!.credential ?? "");
  assert.equal(h.state.dirty, false);
  h.state.closeEditor();
  assert.equal(h.runtime.credentials.getForUse(credential), null, "取消服务草稿不扩大已创建凭据范围");
  assert.equal(await h.state.removeCredential(credential), true, h.state.message);
  assertRedacted([h.state.draft, h.state.pending, h.state.message]);
});

test("Code MCP 配置丢答后只读核实原实例，不重发且读回失败仍保留待核实", async () => {
  const h = await rendererFixture();
  h.hook.reply = op => { assert.equal(op, "mcp_configure"); h.services.push(h.service); return h.service; };
  fillNew(h.state, h.url); h.state.edit("auth", "anonymous");
  h.hook.after = async op => { if (op === "mcp_configure") throw new ControlClientError("request_timeout", "合成丢答", "unknown"); };
  assert.equal(await h.state.save(), false);
  assert.equal(h.state.phase, "unknown");
  const pending = h.state.pending;
  assert.equal(pending?.instanceId, h.state.instanceId);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").length, 1);
  const writes = h.requests.filter(request => request.op === "mcp_configure").length;
  assert.equal(await h.state.save(), false);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").length, writes);
  h.hook.after = undefined;
  h.hook.before = async op => { if (op === "mcp_list") throw new ControlClientError("request_timeout", "合成读回失败", "unknown"); };
  assert.equal(await h.state.read(), false); assert.equal(h.state.phase, "unknown"); assert.equal(h.state.pending, pending);
  h.hook.before = undefined;
  assert.equal(await h.state.read(), true);
  assert.equal(h.state.pending, null); assert.equal(h.state.services[0].name, "docs");
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").length, writes);
  assert.match(h.state.message, /读回|比较/);
});

test("Code MCP 启停和凭据丢答分别核实，不连带重发服务配置或秘密", async () => {
  const h = await rendererFixture();
  h.services.push(h.service); await h.state.read(); h.state.select(h.service.id);
  h.hook.reply = (op, input) => {
    if (op === "mcp_set_enabled") { assert.equal(input.enabled, true); h.service.enabled = true; h.service.configVersion = 2; return h.service; }
    assert.equal(op, "mcp_save_credential");
    const credential = { name: String(input.name), host: "mcp.example.com", header: "authorization", purpose: "mcp", scope: { operations: ["mcp"] }, references: [] };
    h.credentials.push(credential); return credential;
  };
  h.hook.after = async op => { if (op === "mcp_set_enabled") throw new ControlClientError("request_timeout", "合成丢答", "unknown"); };
  assert.equal(await h.state.setEnabled(true), false); assert.equal(h.state.phase, "unknown");
  assert.equal(await h.state.setEnabled(true), false);
  h.hook.after = undefined; await h.state.read();
  assert.equal(h.state.service?.enabled, true); assert.equal(h.state.service?.configVersion, 2);
  assert.equal(h.requests.filter(request => request.op === "mcp_set_enabled").length, 1);
  h.state.discard(); h.state.edit("auth", "new"); h.state.editSecret(SECRET);
  const configs = h.requests.filter(request => request.op === "mcp_configure").length;
  h.hook.after = async op => { if (op === "mcp_save_credential") throw new ControlClientError("request_timeout", "合成凭据丢答", "unknown"); };
  assert.equal(await h.state.save(), false); assert.equal(h.state.phase, "unknown"); assert.equal(h.state.secret, "");
  assert.ok(h.state.pending?.name);
  const name = h.state.pending.name;
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").length, configs);
  h.hook.after = undefined; await h.state.read();
  assert.equal(h.state.draft.auth, "existing"); assert.equal(h.state.draft.credential, name);
  assert.equal(h.requests.filter(request => request.op === "mcp_save_credential").length, 1);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").length, configs);
  assertRedacted([h.state.draft, h.state.credentials, h.state.pending, h.state.message]);
});

test("Code MCP 断线换实例或关闭后的迟到读取与发现失效，秘密在取消和失效时清空", async () => {
  const h = await rendererFixture();
  h.services.push(h.service); await h.state.read(); h.state.select(h.service.id);
  h.state.edit("auth", "new"); h.state.editSecret(SECRET); h.state.discard();
  assert.equal(h.state.secret, "");
  const began = deferred(), release = deferred();
  h.hook.after = async op => { if (op === "mcp_check") { began.resolve(); await release.promise; } };
  const discovering = h.state.discover(); await began.promise;
  h.context.online = false; h.state.invalidate(); release.resolve(); await discovering;
  assert.equal(h.state.check, null); assert.equal(h.state.checking, false);
  h.hook.after = undefined; h.context.online = true;
  h.state.edit("auth", "new"); h.state.editSecret(SECRET);
  const readingBegan = deferred(), readingRelease = deferred();
  h.hook.after = async op => { if (op === "mcp_list") { readingBegan.resolve(); await readingRelease.promise; } };
  const before = structuredClone(h.state.services), reading = h.state.read(); await readingBegan.promise;
  h.context.instanceId = "another-instance"; h.state.invalidate(); readingRelease.resolve();
  assert.equal(await reading, false); assert.equal(h.state.secret, ""); assert.deepEqual(h.state.services, before);
  assert.equal(h.state.disabled, true);
  assertRedacted([h.state.services, h.state.credentials, h.state.draft, h.state.pending, h.state.message]);
});

test("Code MCP 写入应答迟到后保留原实例待核实，只在恢复原连接后读回", async () => {
  const h = await rendererFixture();
  h.hook.reply = op => { assert.equal(op, "mcp_configure"); h.services.push(h.service); return h.service; };
  fillNew(h.state, h.url); h.state.edit("auth", "anonymous");
  const began = deferred(), release = deferred();
  h.hook.after = async op => { if (op === "mcp_configure") { began.resolve(); await release.promise; } };
  const saving = h.state.save(); await began.promise;
  h.context.online = false; h.state.invalidate();
  h.context.instanceId = "another-instance"; release.resolve();
  assert.equal(await saving, false);
  assert.equal(h.state.phase, "unknown"); assert.equal(h.state.services.length, 0);
  assert.equal(h.state.pending?.instanceId, "instance");
  assert.equal(await h.state.read(), false);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").length, 1);
  h.hook.after = undefined; h.context.instanceId = "instance"; h.context.online = true;
  assert.equal(await h.state.read(), true);
  assert.equal(h.state.services[0].name, "docs"); assert.equal(h.state.pending, null);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").length, 1);
});

test("Code MCP 发现中重新读取会使旧发现失效并清理 checking，不会永久禁用表单", async () => {
  const h = await rendererFixture();
  h.services.push(h.service); await h.state.read(); h.state.select(h.service.id);
  const began = deferred(), release = deferred();
  h.hook.after = async op => { if (op === "mcp_check") { began.resolve(); await release.promise; } };
  const discovering = h.state.discover(); await began.promise;
  assert.equal(h.state.checking, true);
  assert.equal(await h.state.read(), true);
  assert.equal(h.state.checking, false); assert.equal(h.state.disabled, false);
  release.resolve(); await discovering;
  assert.equal(h.state.check, null); assert.equal(h.state.checking, false); assert.equal(h.state.disabled, false);
});
test("Code MCP 新增同名冲突保留版本零，只有显式选择当前服务后才更新它", async t => {
  const h = await fixture(t);
  fillNew(h.state, `${h.mcp.url}/draft`); h.state.edit("auth", "anonymous");
  const current = await h.create();
  assert.equal(await h.state.save(), false);
  assert.equal(h.state.phase, "conflict"); assert.equal(h.state.selectedId, null);
  assert.equal(h.state.conflictingService?.id, current.id);
  assert.equal(h.state.conflictingService?.endpoint, h.mcp.url);
  assert.equal(h.state.draft.endpoint, `${h.mcp.url}/draft`);
  assert.equal(await h.state.save(), false);
  assert.equal(h.state.selectedId, null);
  assert.deepEqual(h.requests.filter(request => request.op === "mcp_configure").map(request => request.params.expected_version), [0, 0]);
  assert.equal((await h.list())[0].endpoint, h.mcp.url);
  h.state.useCurrentService();
  assert.equal(h.state.selectedId, current.id);
  assert.equal(h.state.draft.endpoint, `${h.mcp.url}/draft`);
  assert.equal(await h.state.save(), true, h.state.message);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").at(-1)?.params.expected_version, current.configVersion);
  assert.equal(h.state.service?.endpoint, `${h.mcp.url}/draft`);
  assert.equal(h.state.service?.configVersion, current.configVersion + 1);
});

test("Code MCP 更新绑定原服务身份，删除重建的同名同版本服务不被旧表单覆盖", async t => {
  const h = await fixture(t);
  const original = await h.create(); await h.state.read(); h.state.select(original.id);
  h.state.edit("endpoint", `${h.mcp.url}/old-draft`);
  await h.client.request("mcp_remove", { service_id: original.id, expected_version: original.configVersion });
  const replacement = await h.create();
  assert.notEqual(replacement.id, original.id); assert.equal(replacement.configVersion, original.configVersion);
  assert.equal(await h.state.save(), false); assert.equal(h.state.phase, "conflict");
  assert.equal(h.state.selectedId, original.id); assert.equal(h.state.service, null);
  assert.equal(h.state.conflictingService?.id, replacement.id);
  assert.equal(h.state.draft.endpoint, `${h.mcp.url}/old-draft`);
  assert.equal((await h.list())[0].endpoint, h.mcp.url);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").at(-1)?.params.service_id, original.id);
});

test("Code MCP 原服务删除后读回不把编辑降为新增，重复保存仍拒绝", async t => {
  const h = await fixture(t);
  const original = await h.create(); await h.state.read(); h.state.select(original.id);
  h.state.edit("endpoint", `${h.mcp.url}/old-draft`);
  await h.client.request("mcp_remove", { service_id: original.id, expected_version: original.configVersion });
  assert.equal(await h.state.save(), false); assert.equal(h.state.phase, "conflict");
  assert.equal(await h.state.save(), false); assert.equal(h.state.phase, "conflict");
  assert.equal(h.state.selectedId, original.id); assert.equal((await h.list()).length, 0);
  assert.equal(h.state.draft.endpoint, `${h.mcp.url}/old-draft`);
});

test("Code MCP 页只呈现 HTTPS 服务，不再含电脑入口与恢复控制", async t => {
  const { createElement } = await import("react"), { renderToStaticMarkup } = await import("react-dom/server");
  const { createServer } = await import("vite"), { default: react } = await import("@vitejs/plugin-react"), { fileURLToPath } = await import("node:url");
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { CodeMcpEditor } = await server.ssrLoadModule("/code-mcp-settings.tsx");
  const h = await rendererFixture();
  h.services.push(h.service, { ...h.service, id: "computer", name: "computer", cua: { kind: "cua-mac", executable: "/Applications/Cua.app/Contents/MacOS/cua-driver", version: "0.38.0", sha256: "a".repeat(64) } } as Service);
  await h.state.read(); h.state.select(null);
  assert.equal(h.state.draft.kind, "http");
  const html = renderToStaticMarkup(createElement(CodeMcpEditor, { state: h.state }));
  assert.match(html, /HTTPS 端点/);
  assert.doesNotMatch(html, /computer|Cua|电脑|恢复|服务类型/);
});
