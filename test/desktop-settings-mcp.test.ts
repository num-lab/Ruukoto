import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { CODE_MCP_OPS, handleRequest } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge } from "../apps/desktop/src/shared/bridge.ts";
import { CodeMcpState } from "../apps/desktop/src/renderer/code-mcp-state.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { SettingsState } from "../apps/desktop/src/renderer/settings-state.ts";
import { startMockMcp, MOCK_MCP_SECRET } from "./helpers/mock-mcp.ts";
import { startTestRuntime } from "./helpers/testkit.ts";

const SECRET = MOCK_MCP_SECRET;
type Service = OpResult<"mcp_list">["services"][number];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
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
  const workspaces = await Promise.all(kit.work.map(cwd => kit.runtime.openWorkspace({ cwd })));
  const code = new CodeState(bridge, () => {});
  code.update({ type: "snapshot", result: await kit.client.handshake(), instanceChanged: false });
  code.update({ type: "state", state: "online" });
  const context = { instanceId: code.view.instanceId, online: true };
  const createState = (workspaceId = workspaces[0].session.projectId, sourceId = workspaceId) => new CodeMcpState(bridge, () => {}, code.view.instanceId!, workspaceId, sourceId, () => context);
  const state = createState();
  await state.read();
  const list = async (projectId = state.sourceId) => (await kit.client.request<OpResult<"mcp_list">>("mcp_list", { project_id: projectId })).services;
  const create = (projectId = state.sourceId, name = "docs", credential?: string) => kit.client.request<Service>("mcp_configure", { project_id: projectId, name, endpoint: mcp.url, credential: credential ?? null, tool_allowlist: [], enabled: false, expected_version: 0 });
  const legacy = (name: string) => {
    const identity = fs.statSync(kit.work[0]);
    return kit.runtime.store.withTx(() => {
      const project = kit.runtime.store.createProject(name);
      const session = kit.runtime.store.createSession({ projectId: project.id, kind: "dev", cwd: kit.work[0], cwdReal: fs.realpathSync(kit.work[0]), cwdDev: Number(identity.dev), cwdIno: Number(identity.ino), piSessionId: crypto.randomUUID(), confirmTools: [] });
      kit.runtime.store.mapSessionToWorkspace(session.id, workspaces[0].session.projectId);
      return project;
    });
  };
  return { ...kit, mcp, requests, hook, bridge, code, context, state, createState, workspaces, list, create, legacy };
}

function fillNew(state: CodeMcpState, endpoint: string, name = "docs") {
  state.select(null); state.edit("name", name); state.edit("endpoint", endpoint);
}

function assertRedacted(value: unknown, extra: string[] = []) {
  const encoded = JSON.stringify(value);
  for (const secret of [SECRET, ...extra]) assert.equal(encoded.includes(secret), false, "读取和显示不得包含秘密");
}

test("Desktop MCP 操作只向 Code 放行且不开放通用凭据写入", async () => {
  for (const op of CODE_MCP_OPS) {
    let forwarded = false;
    const result = await handleRequest("personal", op, {}, async () => {}, async () => { forwarded = true; });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "op_not_allowed");
    assert.equal(forwarded, false);
  }
  for (const op of ["upsert_credential", "save_credential", "remove_credential"]) {
    const result = await handleRequest("code", op, {}, async () => {}, async () => assert.fail("不得转发通用凭据写入"));
    assert.equal(result.ok, false);
  }
});

test("Code MCP 无会话默认工作区自身来源，候选按名称展示并有界分页", async t => {
  const h = await fixture(t);
  const settings = new SettingsState(() => {});
  h.code.view.currentSessionId = null;
  settings.show("code", h.code, "mcp");
  assert.equal(settings.selections.mcp.workspaceId, h.code.view.projects.find(project => project.rootDir !== null)!.id);
  assert.equal(settings.selections.mcp.sourceId, settings.selections.mcp.workspaceId);
  assert.equal(h.state.sources.find(source => source.isWorkspace)?.projectId, h.state.workspaceId);
  const firstLegacy = h.legacy("旧来源-00");
  await h.create(firstLegacy.id);
  for (let i = 1; i < 53; ++i) h.legacy(`旧来源-${String(i).padStart(2, "0")}`);
  await h.state.read();
  assert.equal(h.state.sources.length, 50);
  assert.equal(h.state.hasMoreSources, true);
  await h.state.moreSources();
  assert.equal(h.state.sources.length, 54);
  assert.equal(h.state.hasMoreSources, false);
  assert.equal(new Set(h.state.sources.map(source => source.projectId)).size, 54);
  assert.equal(h.state.sources.find(source => source.projectId === firstLegacy.id)?.serviceCount, 1);
  assert.equal(h.state.sources.find(source => source.projectId === firstLegacy.id)?.name, "旧来源-00");
  const paged = h.requests.filter(request => request.op === "mcp_sources").at(-1)!;
  assert.equal(paged.params.offset, 50);
  assert.equal(paged.params.limit, 50);
  const emptyDir = `${h.dirs.root}/empty-workspace`;
  fs.mkdirSync(emptyDir);
  const stat = fs.statSync(emptyDir);
  const empty = h.runtime.store.withTx(() => h.runtime.store.createProject("无会话工作区", null, { cwd: emptyDir, cwdReal: fs.realpathSync(emptyDir), dev: Number(stat.dev), ino: Number(stat.ino) }));
  const emptyState = h.createState(empty.id); await emptyState.read();
  assert.equal(emptyState.phase, "ready");
  assert.deepEqual(emptyState.sources.map(source => ({ projectId: source.projectId, isWorkspace: source.isWorkspace, serviceCount: source.serviceCount })), [{ projectId: empty.id, isWorkspace: true, serviceCount: 0 }]);
  h.code.update({ type: "snapshot", result: await h.client.handshake(), instanceChanged: false });
  h.code.view.currentSessionId = h.runtime.store.listSessions().find(session => session.projectId === firstLegacy.id)!.id;
  const mapped = new SettingsState(() => {}); mapped.show("code", h.code, "mcp");
  assert.equal(mapped.selections.mcp.workspaceId, h.state.workspaceId);
  assert.equal(mapped.selections.mcp.sourceId, firstLegacy.id);
});

test("Code MCP 两个工作区与同工作区两个原来源的同名服务互不串写", async t => {
  const h = await fixture(t);
  const first = h.legacy("来源一"), second = h.legacy("来源二");
  const scopes = [h.state, h.createState(h.workspaces[1].session.projectId), h.createState(h.state.workspaceId, first.id), h.createState(h.state.workspaceId, second.id)];
  for (const state of scopes) {
    await state.read(); fillNew(state, h.mcp.url); state.edit("auth", "anonymous");
    assert.equal(await state.save(), true, state.message);
  }
  const originals = await Promise.all(scopes.map(state => h.list(state.sourceId)));
  assert.equal(new Set(originals.map(services => services[0].id)).size, 4);
  const state = scopes[2]; state.edit("endpoint", `${h.mcp.url}/changed`);
  assert.equal(await state.save(), true, state.message);
  assert.equal(state.service?.endpoint, `${h.mcp.url}/changed`);
  for (const index of [0, 1, 3]) assert.deepEqual(await h.list(scopes[index].sourceId), originals[index]);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").at(-1)?.params.project_id, first.id);
  assert.equal(await state.setEnabled(true), true, state.message);
  assert.equal((await h.list(first.id))[0].enabled, true);
  assert.equal((await h.list(second.id))[0].enabled, false);
  assert.equal(await state.remove(), true, state.message);
  assert.equal((await h.list(first.id)).length, 0);
  assert.equal((await h.list(second.id)).length, 1);
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

test("Code MCP 新凭据首次落盘已限来源，编辑省略保留而显式匿名以 null 清除，引用中拒绝删除", async t => {
  const h = await fixture(t);
  fillNew(h.state, h.mcp.url); h.state.edit("auth", "new"); h.state.editSecret(SECRET);
  assert.equal(await h.state.save(), true, h.state.message);
  assert.equal(h.state.secret, "");
  const credential = h.state.service!.credential!;
  assert.deepEqual(h.runtime.credentials.get(credential)?.scope, { projectId: h.state.sourceId, operations: ["mcp"] });
  assert.equal(h.runtime.credentials.getForUse(credential), null);
  assert.equal(h.runtime.credentials.getForUse(credential, { projectId: h.workspaces[1].session.projectId, operation: "mcp" }), null);
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

test("Code MCP 不匹配 host、用途和来源的凭据明确拒绝且不退回匿名", async t => {
  const h = await fixture(t);
  h.runtime.credentials.upsert({ name: "wrong-host", host: "other.example.com", header: "authorization", purpose: "mcp", secret: SECRET });
  h.runtime.credentials.upsert({ name: "wrong-purpose", host: h.mcp.host, header: "authorization", purpose: "tavily_search", secret: SECRET });
  h.runtime.credentials.upsert({ name: "wrong-source", host: h.mcp.host, header: "authorization", purpose: "mcp", secret: SECRET, scope: { projectId: h.workspaces[1].session.projectId, operations: ["mcp"] } });
  fillNew(h.state, h.mcp.url); h.state.edit("auth", "existing");
  for (const credential of ["wrong-host", "wrong-purpose", "wrong-source", "missing"]) {
    h.state.edit("credential", credential);
    assert.equal(await h.state.save(), false);
    assert.equal((await h.list()).length, 0);
    assert.notEqual(h.state.phase, "unknown");
    assertRedacted([h.state.message, h.state.services, h.state.credentials]);
  }
});

test("Code MCP 版本冲突读回当前值并保留草稿，凭据已保存后冲突仍不能通用 HTTP 或跨来源使用", async t => {
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
  assert.deepEqual(h.runtime.credentials.get(credential)?.scope, { projectId: h.state.sourceId, operations: ["mcp"] });
  assert.equal(h.runtime.credentials.getForUse(credential), null);
  assert.equal(h.runtime.credentials.getForUse(credential, { projectId: h.workspaces[1].session.projectId, operation: "mcp" }), null);
  await assert.rejects(h.client.request("mcp_configure", { project_id: h.workspaces[1].session.projectId, name: "docs", endpoint: h.mcp.url, credential, tool_allowlist: [] }), /范围|scope/i);
  h.state.discard();
  assert.equal(h.state.draft.endpoint, h.state.service!.endpoint);
  assert.equal(h.state.draft.credential, h.state.service!.credential ?? "");
  assert.equal(h.state.dirty, false);
  h.state.closeEditor();
  assert.equal(h.runtime.credentials.getForUse(credential), null, "取消服务草稿不扩大已创建凭据范围");
  assert.equal(await h.state.removeCredential(credential), true, h.state.message);
  assertRedacted([h.state.draft, h.state.pending, h.state.message]);
});

test("Code MCP 配置丢答后只读核实原来源，不重发且读回失败仍保留待核实", async t => {
  const h = await fixture(t);
  fillNew(h.state, h.mcp.url); h.state.edit("auth", "anonymous");
  h.hook.after = async op => { if (op === "mcp_configure") throw new ControlClientError("request_timeout", "合成丢答", "unknown"); };
  assert.equal(await h.state.save(), false);
  assert.equal(h.state.phase, "unknown");
  const pending = h.state.pending;
  assert.equal(pending?.projectId, h.state.sourceId);
  assert.equal((await h.list()).length, 1);
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

test("Code MCP 启停和凭据丢答分别核实，不连带重发服务配置或秘密", async t => {
  const h = await fixture(t);
  const original = await h.create(); await h.state.read(); h.state.select(original.id);
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

test("Code MCP 断线换实例或关闭后的迟到读取与发现失效，秘密在取消和失效时清空", async t => {
  const h = await fixture(t);
  const original = await h.create(); await h.state.read(); h.state.select(original.id);
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
  h.hook.after = async op => { if (op === "mcp_sources") { readingBegan.resolve(); await readingRelease.promise; } };
  const before = structuredClone(h.state.services), reading = h.state.read(); await readingBegan.promise;
  h.context.instanceId = "another-instance"; h.state.invalidate(); readingRelease.resolve();
  assert.equal(await reading, false); assert.equal(h.state.secret, ""); assert.deepEqual(h.state.services, before);
  assert.equal(h.state.disabled, true);
  assertRedacted([h.state.services, h.state.credentials, h.state.draft, h.state.pending, h.state.message]);
});

test("Code MCP 写入应答迟到后保留原实例待核实，只在恢复原连接后读回", async t => {
  const h = await fixture(t);
  fillNew(h.state, h.mcp.url); h.state.edit("auth", "anonymous");
  const began = deferred(), release = deferred();
  h.hook.after = async op => { if (op === "mcp_configure") { began.resolve(); await release.promise; } };
  const saving = h.state.save(); await began.promise;
  h.context.online = false; h.state.invalidate();
  h.context.instanceId = "another-instance"; release.resolve();
  assert.equal(await saving, false);
  assert.equal(h.state.phase, "unknown"); assert.equal(h.state.services.length, 0);
  assert.equal(h.state.pending?.instanceId, h.code.view.instanceId);
  assert.equal(await h.state.read(), false);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").length, 1);
  h.hook.after = undefined; h.context.instanceId = h.code.view.instanceId; h.context.online = true;
  assert.equal(await h.state.read(), true);
  assert.equal(h.state.services[0].name, "docs"); assert.equal(h.state.pending, null);
  assert.equal(h.requests.filter(request => request.op === "mcp_configure").length, 1);
});

test("Code MCP 发现中重新读取会使旧发现失效并清理 checking，不会永久禁用表单", async t => {
  const h = await fixture(t);
  const original = await h.create(); await h.state.read(); h.state.select(original.id);
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
    if (name === "mcp_sources") return { sources: [{ projectId: "source", name: "工作区", isWorkspace: true, serviceCount: services.length }], hasMore: false };
    if (name === "mcp_list") return { services: structuredClone(services) };
    if (name === "list_credentials") return [];
    if (name === "mcp_cua_targets") return { targets: control.unavailable ? [] : [{ label: "本机 Cua Driver 0.38.0", config }], issues: control.unavailable ? [{ code: "cua_not_installed", message: "请安装固定版本 Cua Driver。" }] : [] };
    if (name === "mcp_configure") { const service = { id: "computer", projectId: "source", name: fields.name, cua: fields.cua, credential: null, toolAllowlist: fields.tool_allowlist, enabled: fields.enabled, configVersion: 1, createdAt: "now", updatedAt: "now" }; services.push(service as Service); return service; }
    if (name === "mcp_set_enabled") { services[0].enabled = !!fields.enabled; services[0].configVersion++; return services[0]; }
    if (name === "mcp_check") return { ok: false, service: services[0], tools: [], permissions: { accessibility: false, screenRecording: true }, errorCode: "cua_permissions_missing", error: "实际 direct 启动宿主缺少辅助功能权限。" };
    if (name === "get_tool_op_mcp") return { text: '{"arguments":{"x":12,"y":34}}', offset: 0, totalBytes: 35, truncated: false };
    if (name === "read_artifact") return { artifact: control.image, encoding: "base64", data: bytes.subarray(Number(fields.offset), Number(fields.offset) + Number(fields.length)).toString("base64") };
    if (name === "mcp_cua_accept") { control.status = { state: "idle", stopped: false, ownerStarted: false }; return control.status; }
    if (name.startsWith("mcp_cua_")) return structuredClone(control.status);
    assert.fail(`未覆盖的 Code Cua 操作：${name}`);
  }) };
  return { state: new CodeMcpState(bridge, () => {}, "instance", "source", "source", () => context), config, services, calls, control, context };
}

test("Code Cua 正常设置选择固定程序，不走HTTP认证；缺安装、缺权限与保存拒绝保留草稿", async () => {
  const h = cuaSettingsFixture(); await h.state.read(); h.state.select(null); h.state.selectKind("cua-mac");
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
  assert.equal(h.calls[stop].params.service_id, h.state.service!.id, "停止绑定选中的原服务，不停止另一来源的电脑");
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
  const h = cuaSettingsFixture(); await h.state.read(); h.state.select(null); h.state.selectKind("cua-mac"); h.state.selectCua(0); await h.state.save(); await h.state.setEnabled(true);
  h.control.fail = "mcp_cua_stop"; await h.state.pauseCua();
  assert.equal(h.state.service?.enabled, false); assert.match(h.state.cuaError, /未核实/);
  h.control.fail = ""; await h.state.pauseCua();
  assert.equal(h.calls.filter(call => call.op === "mcp_cua_stop").length, 2);
  assert.equal(h.calls.filter(call => call.op === "mcp_set_enabled" && call.params.enabled === false).length, 1);
});

test("Code Cua 暂停读回时原服务已删除，停止仍绑定原选择且不抛错", async () => {
  const h = cuaSettingsFixture(); await h.state.read(); h.state.select(null); h.state.selectKind("cua-mac"); h.state.selectCua(0); await h.state.save(); await h.state.setEnabled(true);
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

test("Code Cua 设置页展示程序选择、宿主权限与实际恢复图片", async t => {
  const { createElement } = await import("react"), { renderToStaticMarkup } = await import("react-dom/server");
  const { createServer } = await import("vite"), { default: react } = await import("@vitejs/plugin-react"), { fileURLToPath } = await import("node:url");
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { CodeMcpEditor } = await server.ssrLoadModule("/code-mcp-settings.tsx");
  const h = cuaSettingsFixture(); await h.state.read(); h.state.select(null); h.state.selectKind("cua-mac"); h.state.selectCua(0); await h.state.save(); await h.state.discover(); await h.state.refreshCua();
  const html = renderToStaticMarkup(createElement(CodeMcpEditor, { state: h.state, settings: new SettingsState(() => {}), workspaceName: "工作区" }));
  assert.match(html, /本机 Cua Driver/); assert.match(html, /辅助功能：未授权/); assert.match(html, /屏幕录制：已授权/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,/); assert.match(html, /恢复新截图 1/); assert.match(html, /确认恢复/);
  assert.doesNotMatch(html, /HTTPS 端点|Bearer 令牌|恢复观察ID|进程代次/);
});
