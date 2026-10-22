import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { resolveDirIdentity } from "@ruukoto/core/dir-identity.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import { RuntimeApiError } from "@ruukoto/runtime/runtime.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { CODE_MCP_OPS, handleRequest } from "../apps/desktop/src/main/ipc.ts";
import { startTestRuntime, createProjectSession, type TestRuntime } from "./helpers/testkit.ts";
import { startMockMcp, MOCK_MCP_SECRET } from "./helpers/mock-mcp.ts";

const quiet = () => ({ kind: "text" as const, text: "ok" });
const endpoint = "https://mcp.example.com/mcp";
function request<K extends TuiOp>(t: TestRuntime, op: K, params: OpParams<K>): Promise<OpResult<K>> { return t.client.request<OpResult<K>>(op, params); }
function rejected(code: string) { return (error: unknown) => error instanceof ControlClientError && error.code === code; }

test("Code MCP 操作只向 Code 放行，通用凭据写入与移除保持关闭", async () => {
  for (const op of CODE_MCP_OPS) {
    let called = false;
    const result = await handleRequest("personal", op, {}, async () => {}, async () => { called = true; });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  }
  for (const op of ["add_credential", "remove_credential"]) {
    const result = await handleRequest("code", op, {}, async () => {}, async () => { assert.fail("通用凭据操作不应转发"); });
    assert.equal(result.ok, false);
  }
});

test("MCP 来源有界分页保留工作区自身与组织映射原项目，同名服务隔离", async () => {
  const t = await startTestRuntime("d-mcp-src", quiet, { workDirs: 3, config: { product: product.runtime } });
  try {
    const own = t.runtime.store.createProject("工作区", undefined, await resolveDirIdentity(t.work[0]));
    const other = t.runtime.store.createProject("其他工作区", undefined, await resolveDirIdentity(t.work[1]));
    const empty = t.runtime.store.createProject("无会话工作区", undefined, await resolveDirIdentity(t.work[2]));
    const a = await createProjectSession(t.client, t.work[0], { projectName: "原项目 A" });
    const b = await createProjectSession(t.client, t.work[0], { projectName: "原项目 B" });
    t.runtime.store.withTx(() => { t.runtime.store.mapSessionToWorkspace(a.sessionId, own.id); t.runtime.store.mapSessionToWorkspace(b.sessionId, own.id); });
    const serviceA = await request(t, "mcp_configure", { project_id: a.projectId, name: "docs", endpoint, credential: null, tool_allowlist: [], enabled: false, expected_version: 0 });
    const serviceB = await request(t, "mcp_configure", { project_id: b.projectId, name: "docs", endpoint, credential: null, tool_allowlist: [], enabled: false, expected_version: 0 });
    assert.notEqual(serviceA.id, serviceB.id);
    const first = await request(t, "mcp_sources", { workspace_id: own.id, limit: 2, selected_project_id: b.projectId });
    assert.deepEqual(first.sources.map(source => source.projectId), [own.id, b.projectId]);
    assert.deepEqual(first.sources.map(source => [source.name, source.serviceCount]), [["工作区", 0], ["原项目 B", 1]]);
    assert.equal(first.hasMore, true);
    const next = await request(t, "mcp_sources", { workspace_id: own.id, limit: 2, offset: 2, selected_project_id: b.projectId });
    assert.deepEqual(next.sources.map(source => source.projectId), [a.projectId]);
    assert.equal(next.hasMore, false);
    const unrelated = await request(t, "mcp_sources", { workspace_id: other.id, selected_project_id: a.projectId });
    assert.deepEqual(unrelated.sources.map(source => source.projectId), [other.id]);
    assert.deepEqual((await request(t, "mcp_sources", { workspace_id: empty.id })).sources.map(source => [source.projectId, source.isWorkspace]), [[empty.id, true]]);
    const toggled = await request(t, "mcp_set_enabled", { service_id: serviceA.id, enabled: true, expected_version: 1 });
    assert.equal(toggled.configVersion, 2);
    assert.equal((await request(t, "mcp_list", { project_id: b.projectId })).services[0].enabled, false);
    assert.deepEqual((await request(t, "mcp_list", { project_id: other.id })).services, []);
    await assert.rejects(request(t, "mcp_set_enabled", { service_id: serviceA.id, enabled: false, expected_version: 1 }), rejected("version_conflict"));
    await assert.rejects(request(t, "mcp_remove", { service_id: serviceA.id, expected_version: 1 }), rejected("version_conflict"));
    assert.equal((await request(t, "mcp_remove", { service_id: serviceA.id, expected_version: 2 })).removed, true);
    assert.equal((await request(t, "mcp_list", { project_id: b.projectId })).services[0].id, serviceB.id);
    for (const params of [{ workspace_id: own.id, limit: 101 }, { workspace_id: own.id, offset: -1 }, { workspace_id: own.id, offset: "1" }]) await assert.rejects(t.client.request("mcp_sources", params), rejected("invalid_params"));
  } finally { await t.shutdown(); }
});

test("MCP 凭据首次写入即限定来源和操作，配置冲突或取消不遗留通用凭据", async () => {
  const t = await startTestRuntime("d-mcp-creds", quiet);
  try {
    const a = await createProjectSession(t.client, t.work[0]);
    const b = await createProjectSession(t.client, t.work[1]);
    const saved = await request(t, "mcp_save_credential", { project_id: a.projectId, name: "new-mcp", endpoint, secret: MOCK_MCP_SECRET });
    assert.deepEqual(saved.scope, { projectId: a.projectId, operations: ["mcp"] });
    assert.equal(t.runtime.credentials.getForUse("new-mcp"), null);
    assert.equal(t.runtime.credentials.getForUse("new-mcp", { projectId: b.projectId, operation: "mcp" }), null);
    const disk = JSON.parse(fs.readFileSync(path.join(t.dirs.agentDir, "credentials.json"), "utf8"));
    assert.deepEqual(disk.bindings.find((binding: { name: string }) => binding.name === "new-mcp").scope, saved.scope);
    await assert.rejects(request(t, "mcp_configure", { project_id: a.projectId, name: "docs", endpoint, credential: saved.name, tool_allowlist: [], expected_version: 99 }), rejected("version_conflict"));
    assert.equal(t.runtime.credentials.getForUse("new-mcp"), null);
    await assert.rejects(request(t, "mcp_configure", { project_id: b.projectId, name: "docs", endpoint, credential: saved.name, tool_allowlist: [] }), rejected("invalid_params"));
    await assert.rejects(request(t, "mcp_save_credential", { project_id: b.projectId, name: saved.name, endpoint, secret: "replace" }), rejected("credential_exists"));
    assert.deepEqual(await request(t, "list_credentials", { project_id: b.projectId, endpoint }), []);
    await assert.rejects(request(t, "mcp_remove_credential", { project_id: b.projectId, name: saved.name }), rejected("credential_scope_mismatch"));
    const service = await request(t, "mcp_configure", { project_id: a.projectId, name: "docs", endpoint, credential: saved.name, tool_allowlist: [], enabled: false });
    const listed = await request(t, "list_credentials", { project_id: a.projectId, endpoint });
    assert.deepEqual(listed[0].references, [{ serviceId: service.id, serviceName: "docs", projectId: a.projectId, projectName: t.runtime.store.getProject(a.projectId)!.name }]);
    assert.ok(!JSON.stringify([saved, listed, t.runtime.store.getEventsAfter(0)]).includes(MOCK_MCP_SECRET));
    await assert.rejects(request(t, "mcp_remove_credential", { project_id: a.projectId, name: saved.name }), rejected("credential_in_use"));
    const second = await request(t, "mcp_configure", { project_id: a.projectId, name: "second", endpoint, credential: saved.name, tool_allowlist: [] });
    await request(t, "mcp_remove", { service_id: service.id, expected_version: service.configVersion });
    await assert.rejects(request(t, "mcp_remove_credential", { project_id: a.projectId, name: saved.name }), rejected("credential_in_use"));
    await request(t, "mcp_remove", { service_id: second.id, expected_version: second.configVersion });
    assert.deepEqual(await request(t, "mcp_remove_credential", { project_id: a.projectId, name: saved.name }), { removed: true });
  } finally { await t.shutdown(); }
});

test("MCP 编辑核实实际保留的凭据，匿名须显式清除引用", async () => {
  const t = await startTestRuntime("d-mcp-keep", quiet);
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]);
    await request(t, "mcp_save_credential", { project_id: projectId, name: "bound", endpoint, secret: MOCK_MCP_SECRET });
    const base = { project_id: projectId, name: "docs", endpoint, tool_allowlist: [] };
    const first = await request(t, "mcp_configure", { ...base, credential: "bound", enabled: false, expected_version: 0 });
    const updated = await request(t, "mcp_configure", { ...base, expected_version: first.configVersion });
    assert.equal(updated.credential, "bound");
    await assert.rejects(request(t, "mcp_configure", { ...base, endpoint: "https://other.example.com/mcp", expected_version: updated.configVersion }), rejected("invalid_params"));
    assert.equal(t.runtime.mcp.getService(first.id)!.configVersion, updated.configVersion);
    t.runtime.credentials.remove("bound");
    await assert.rejects(request(t, "mcp_configure", { ...base, expected_version: updated.configVersion }), rejected("invalid_params"));
    assert.equal(t.runtime.mcp.getService(first.id)!.configVersion, updated.configVersion);
    const anonymous = await request(t, "mcp_configure", { ...base, credential: null, expected_version: updated.configVersion });
    assert.equal(anonymous.credential, null);
    assert.equal(t.runtime.credentials.get("bound"), null);
    for (const patch of [{ header: "x-token" }, { purpose: "other" }, { scope: { projectId, repoId: 7, operations: ["mcp"] } }]) {
      t.runtime.credentials.upsert({ name: "wrong", host: "mcp.example.com", header: "authorization", purpose: "mcp", secret: MOCK_MCP_SECRET, ...patch });
      await assert.rejects(request(t, "mcp_configure", { ...base, credential: "wrong", expected_version: anonymous.configVersion }), rejected("invalid_params"));
    }
    await assert.rejects(t.client.request("mcp_configure", { ...base, credential: false }), rejected("invalid_params"));
  } finally { await t.shutdown(); }
});

test("禁用草稿只握手和发现工具，凭据用途或认证头变化时不联网", async () => {
  const mcp = await startMockMcp({ requireAuth: true, tools: [{ name: "read" }, { name: "write", annotations: { readOnlyHint: true } }] });
  const t = await startTestRuntime("d-mcp-check", quiet);
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]);
    await request(t, "mcp_save_credential", { project_id: projectId, name: "bound", endpoint: mcp.url, secret: MOCK_MCP_SECRET });
    const service = await request(t, "mcp_configure", { project_id: projectId, name: "draft", endpoint: mcp.url, credential: "bound", tool_allowlist: [], enabled: false, expected_version: 0 });
    const checked = await request(t, "mcp_check", { service_id: service.id });
    assert.equal(checked.ok, true);
    assert.equal(checked.service.enabled, false);
    assert.equal(checked.tools.length, 2);
    assert.ok(checked.tools.every(tool => !tool.allowed && tool.effect === undefined));
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
    const binding = t.runtime.credentials.get("bound")!;
    for (const patch of [{ purpose: "other" }, { header: "x-token" }]) {
      t.runtime.credentials.upsert({ ...binding, ...patch });
      const count = mcp.hits.length;
      const failure = await request(t, "mcp_check", { service_id: service.id });
      assert.equal(failure.ok, false);
      assert.equal(failure.errorCode, "auth_failed");
      assert.equal(mcp.hits.length, count);
      assert.ok(!JSON.stringify(failure).includes(MOCK_MCP_SECRET));
    }
  } finally { await t.shutdown(); await mcp.close(); }
});

test("MCP 检查不透传远端错误中的秘密", async () => {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: MOCK_MCP_SECRET } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const t = await startTestRuntime("d-mcp-redact", quiet);
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]);
    const service = await request(t, "mcp_configure", { project_id: projectId, name: "bad", endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, credential: null, tool_allowlist: [], enabled: false });
    const result = await request(t, "mcp_check", { service_id: service.id });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(MOCK_MCP_SECRET));
  } finally { await t.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("MCP 启停与事件同事务提交，事件失败保留原状态和版本", async () => {
  const t = await startTestRuntime("d-mcp-tx", quiet);
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]);
    const service = t.runtime.mcpConfigure({ projectId, name: "docs", endpoint, credential: null, toolAllowlist: [], enabled: false });
    const append = t.runtime.store.appendEvent;
    t.runtime.store.appendEvent = () => { throw new RuntimeApiError("injected", "事件写入失败"); };
    try { assert.throws(() => t.runtime.mcpSetEnabled(service.id, true, service.configVersion), error => error instanceof RuntimeApiError && error.code === "injected"); }
    finally { t.runtime.store.appendEvent = append; }
    assert.equal(t.runtime.mcp.getService(service.id)!.enabled, false);
    assert.equal(t.runtime.mcp.getService(service.id)!.configVersion, service.configVersion);
  } finally { await t.shutdown(); }
});
