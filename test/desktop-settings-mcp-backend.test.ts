import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import { RuntimeApiError } from "@ruukoto/runtime/runtime.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { CODE_MCP_OPS, CODE_WEB_SEARCH_OPS, handleRequest } from "../apps/desktop/src/main/ipc.ts";
import { startTestRuntime, createProjectSession, type TestRuntime } from "./helpers/testkit.ts";
import { startMockMcp, MOCK_MCP_SECRET } from "./helpers/mock-mcp.ts";

const quiet = () => ({ kind: "text" as const, text: "ok" });
const endpoint = "https://mcp.example.com/mcp";
function request<K extends TuiOp>(t: TestRuntime, op: K, params: OpParams<K>): Promise<OpResult<K>> { return t.client.request<OpResult<K>>(op, params); }
function rejected(code: string) { return (error: unknown) => error instanceof ControlClientError && error.code === code; }

test("Code Cua 检查禁用草稿：静态工具与当前宿主权限分别返回，坏制品可行动且不启动 runtime", { skip: process.platform !== "darwin" }, async () => {
  const t = await startTestRuntime("d-cua-check", quiet, { config: { product: product.runtime } });
  const executable = path.join(t.dirs.root, "driver"), args = path.join(t.dirs.root, "args.json");
  const tools = [{ name: "get_desktop_state", description: "观察", input_schema: { type: "object", properties: {} } }, { name: "run_script", description: "脚本", input_schema: { type: "object", properties: {} } }];
  fs.writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(JSON.stringify({ version: "0.38.0", tools }))});`, { mode: 0o700 });
  try {
    const cua = { kind: "cua-mac" as const, version: "0.38.0" as const, executable, sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex") };
    const service = await request(t, "mcp_configure", { name: "mac", cua, tool_allowlist: [], enabled: false });
    const checked = await request(t, "mcp_check", { service_id: service.id });
    assert.deepEqual(checked.tools.map(tool => [tool.name, tool.allowed, tool.effect]), [["get_desktop_state", false, "read"]]);
    assert.equal(typeof checked.permissions?.accessibility, "boolean"); assert.equal(typeof checked.permissions?.screenRecording, "boolean");
    assert.equal(checked.ok, checked.permissions!.accessibility && checked.permissions!.screenRecording);
    assert.deepEqual(JSON.parse(fs.readFileSync(args, "utf8")), ["dump-docs", "--type", "mcp"]);
    assert.equal((await request(t, "mcp_cua_status", {})).state, "idle");
    fs.appendFileSync(executable, "\n");
    const changed = await request(t, "mcp_check", { service_id: service.id });
    assert.equal(changed.ok, false); assert.equal(changed.errorCode, "cua_config_invalid");
    assert.match(changed.error!, /本机电脑程序.*固定版本/); assert.doesNotMatch(changed.error!, /端点与网络/);
  } finally { await t.shutdown(); }
});

test("Code MCP 操作只向 Code 放行，通用凭据写入与移除保持关闭", async () => {
  for (const op of [...CODE_MCP_OPS, ...CODE_WEB_SEARCH_OPS]) {
    let called = false;
    const result = await handleRequest("personal", op, {}, async () => {}, async () => { called = true; });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "op_not_allowed");
    assert.equal(called, false);
  }
  for (const op of ["add_credential", "upsert_credential", "save_credential", "remove_credential"]) {
    const result = await handleRequest("code", op, {}, async () => {}, async () => { assert.fail("通用凭据操作不应转发"); });
    assert.equal(result.ok, false);
  }
});

test("Code 控制面退役独立开始恢复，拒绝旧请求且不改原事件", async () => {
  const t = await startTestRuntime("d-cua-retired", quiet);
  try {
    const events = t.runtime.store.getEventsAfter(0);
    await assert.rejects(t.client.request("mcp_cua_begin_recovery", {}), rejected("unknown_op"));
    assert.deepEqual(t.runtime.store.getEventsAfter(0), events);
  } finally { await t.shutdown(); }
});

test("Web 搜索凭据专用 op 只写固定 Tavily 绑定，项目开关按版本生效", async () => {
  const t = await startTestRuntime("d-web-search-credential", quiet);
  try {
    assert.deepEqual(await request(t, "list_credentials", { purpose: "tavily_search" }), []);
    const saved = await request(t, "web_search_save_credential", { secret: "tvly-secret-1" });
    assert.deepEqual({ name: saved.name, host: saved.host, header: saved.header, purpose: saved.purpose }, { name: "web-search", host: "api.tavily.com", header: "authorization", purpose: "tavily_search" });
    assert.equal(t.runtime.credentials.get("web-search")?.scope, undefined);
    await request(t, "web_search_save_credential", { secret: "tvly-secret-2" });
    assert.deepEqual((await request(t, "list_credentials", { purpose: "tavily_search" })).map(item => item.name), ["web-search"]);
    for (const secret of ["", " spaced", "line\nbreak"]) await assert.rejects(request(t, "web_search_save_credential", { secret }), rejected("invalid_params"));
    assert.equal((await request(t, "list_credentials", { purpose: "tavily_search" })).length, 1, "无效秘密不新增绑定");
    assert.equal((await request(t, "web_search_remove_credential", {})).removed, true);
    assert.equal((await request(t, "web_search_remove_credential", {})).removed, false);
    await request(t, "mcp_save_credential", { name: "web-search", endpoint, secret: MOCK_MCP_SECRET });
    await assert.rejects(request(t, "web_search_save_credential", { secret: "tvly-secret-1" }), rejected("credential_scope_mismatch"));
    await assert.rejects(request(t, "web_search_remove_credential", {}), rejected("credential_scope_mismatch"));
    assert.equal(t.runtime.credentials.get("web-search")?.purpose, "mcp", "同名 MCP 凭据不被专用 op 改写或删除");
    assert.ok(!JSON.stringify(t.runtime.credentials.list()).includes("tvly-secret"));
    const disabled = await request(t, "set_web_search", { enabled: false, expected_version: 1 });
    assert.deepEqual(disabled, { state: "disabled", version: 2 });
    await assert.rejects(request(t, "set_web_search", { enabled: true, expected_version: 1 }), rejected("version_conflict"));
    const enabled = await request(t, "set_web_search", { enabled: true, expected_version: 2 });
    assert.equal(enabled.state, "enabled");
  } finally { await t.shutdown(); }
});

test("MCP 无工作区可管理，实例内名称唯一且其他实例不共享", async () => {
  const t = await startTestRuntime("d-mcp-instance", quiet, { config: { product: product.runtime } });
  const other = await startTestRuntime("d-mcp-isolated", quiet, { config: { product: product.runtime } });
  try {
    assert.equal(t.runtime.store.listProjects().filter(project => project.rootDir !== null).length, 0);
    const service = await request(t, "mcp_configure", { name: "docs", endpoint, credential: null, tool_allowlist: [], enabled: false, expected_version: 0 });
    assert.equal(Object.hasOwn(service, "projectId"), false);
    await Promise.all(t.work.map(cwd => t.runtime.openWorkspace({ cwd })));
    assert.deepEqual((await request(t, "mcp_list", {})).services, [service]);
    await assert.rejects(request(t, "mcp_configure", { name: "docs", endpoint, credential: null, tool_allowlist: [], expected_version: 0 }), rejected("version_conflict"));
    const isolated = await request(other, "mcp_configure", { name: "docs", endpoint, credential: null, tool_allowlist: [], enabled: false, expected_version: 0 });
    assert.notEqual(isolated.id, service.id);
    const toggled = await request(t, "mcp_set_enabled", { service_id: service.id, enabled: true, expected_version: 1 });
    assert.equal(toggled.configVersion, 2);
    assert.equal((await request(t, "mcp_list", {})).services[0].enabled, true);
    assert.equal((await request(other, "mcp_list", {})).services[0].enabled, false);
    await assert.rejects(request(t, "mcp_set_enabled", { service_id: service.id, enabled: false, expected_version: 1 }), rejected("version_conflict"));
    await assert.rejects(request(t, "mcp_remove", { service_id: service.id, expected_version: 1 }), rejected("version_conflict"));
    assert.equal((await request(t, "mcp_remove", { service_id: service.id, expected_version: 2 })).removed, true);
    assert.deepEqual((await request(t, "mcp_list", {})).services, []);
    assert.equal((await request(other, "mcp_list", {})).services[0].id, isolated.id);
  } finally { await t.shutdown(); await other.shutdown(); }
});

test("旧 MCP 来源操作与归属参数明确拒绝，不转成实例操作或联网", async () => {
  const mcp = await startMockMcp({ tools: [] });
  const t = await startTestRuntime("d-mcp-old-params", quiet, { config: { product: product.runtime } });
  try {
    const service = await request(t, "mcp_configure", { name: "draft", endpoint: mcp.url, credential: null, tool_allowlist: [], enabled: false });
    await request(t, "mcp_save_credential", { name: "bound", endpoint: mcp.url, secret: MOCK_MCP_SECRET });
    await assert.rejects(t.client.request("mcp_sources", {}), rejected("unknown_op"));
    const operations: Array<[string, Record<string, unknown>]> = [
      ["mcp_configure", { name: "new", endpoint: mcp.url, credential: null, tool_allowlist: [] }],
      ["mcp_list", {}], ["mcp_check", { service_id: service.id }],
      ["mcp_set_enabled", { service_id: service.id, enabled: true }], ["mcp_remove", { service_id: service.id }],
      ["mcp_save_credential", { name: "new", endpoint: mcp.url, secret: MOCK_MCP_SECRET }], ["mcp_remove_credential", { name: "bound" }],
      ["mcp_cua_status", {}], ["mcp_cua_targets", {}], ["mcp_cua_stop", {}], ["mcp_cua_observe", {}], ["mcp_cua_accept", { observation_id: "old" }],
      ["list_credentials", { purpose: "mcp" }],
      ["add_credential", { name: "new", host: new URL(mcp.url).host, header: "authorization", purpose: "mcp", secret: MOCK_MCP_SECRET }], ["remove_credential", { name: "bound" }],
    ];
    const events = t.runtime.store.getEventsAfter(0), credentials = t.runtime.credentials.list();
    for (const [op, params] of operations) for (const key of ["project_id", "workspace_id", "selected_project_id"]) await assert.rejects(t.client.request(op, { ...params, [key]: "old" }), rejected("invalid_params"));
    assert.deepEqual((await request(t, "mcp_list", {})).services, [service]);
    assert.deepEqual(t.runtime.credentials.list(), credentials); assert.deepEqual(t.runtime.store.getEventsAfter(0), events);
    assert.equal(mcp.hits.length, 0);
    const result = await handleRequest("code", "mcp_sources", {}, async () => {}, async () => { assert.fail("旧操作不能进入后台"); });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "op_not_allowed");
  } finally { await t.shutdown(); await mcp.close(); }
});

test("MCP 凭据首次写入限定实例操作，所有引用解除前专用与通用删除都拒绝", async () => {
  const t = await startTestRuntime("d-mcp-creds", quiet);
  try {
    const a = await createProjectSession(t.client, t.work[0]);
    const b = await createProjectSession(t.client, t.work[1]);
    const saved = await request(t, "mcp_save_credential", { name: "new-mcp", endpoint, secret: MOCK_MCP_SECRET });
    assert.deepEqual(saved.scope, { operations: ["mcp"] });
    assert.equal(t.runtime.credentials.getForUse(saved.name), null);
    for (const projectId of [a.projectId, b.projectId]) assert.notEqual(t.runtime.credentials.getForUse(saved.name, { projectId, operation: "mcp" }), null);
    const disk = JSON.parse(fs.readFileSync(path.join(t.dirs.agentDir, "credentials.json"), "utf8"));
    assert.deepEqual(disk.bindings.find((binding: { name: string }) => binding.name === saved.name).scope, saved.scope);
    await assert.rejects(request(t, "mcp_configure", { name: "docs", endpoint, credential: saved.name, tool_allowlist: [], expected_version: 99 }), rejected("version_conflict"));
    assert.equal(t.runtime.credentials.getForUse(saved.name), null);
    await assert.rejects(request(t, "mcp_save_credential", { name: saved.name, endpoint, secret: "replace" }), rejected("credential_exists"));
    const service = await request(t, "mcp_configure", { name: "docs", endpoint, credential: saved.name, tool_allowlist: [], enabled: false });
    const listed = await request(t, "list_credentials", { purpose: "mcp", endpoint });
    assert.deepEqual(listed[0].references, [{ serviceId: service.id, serviceName: "docs" }]);
    assert.ok(!JSON.stringify([saved, listed, t.runtime.store.getEventsAfter(0)]).includes(MOCK_MCP_SECRET));
    for (const op of ["mcp_remove_credential", "remove_credential"] as const) await assert.rejects(request(t, op, { name: saved.name }), rejected("credential_in_use"));
    const second = await request(t, "mcp_configure", { name: "second", endpoint, credential: saved.name, tool_allowlist: [] });
    await request(t, "mcp_remove", { service_id: service.id, expected_version: service.configVersion });
    for (const op of ["mcp_remove_credential", "remove_credential"] as const) await assert.rejects(request(t, op, { name: saved.name }), rejected("credential_in_use"));
    await request(t, "mcp_remove", { service_id: second.id, expected_version: second.configVersion });
    assert.deepEqual(await request(t, "remove_credential", { name: saved.name }), { removed: true });
  } finally { await t.shutdown(); }
});

test("通用凭据入口首次保存即限 MCP，旧绑定不能借轮换扩大范围", async () => {
  const mcp = await startMockMcp({ requireAuth: true, tools: [{ name: "read" }] });
  const t = await startTestRuntime("d-mcp-generic-credential", quiet);
  try {
    const input = { name: "terminal", host: new URL(mcp.url).host, header: "authorization", purpose: "mcp", secret: MOCK_MCP_SECRET };
    await assert.rejects(t.client.request("add_credential", { ...input, header: "x-token" }), rejected("invalid_params"));
    assert.equal(t.runtime.credentials.get(input.name), null);
    await t.client.request("add_credential", input);
    const binding = t.runtime.credentials.get(input.name)!;
    assert.deepEqual(binding.scope, { operations: ["mcp"] }); assert.equal(t.runtime.credentials.getForUse(input.name), null);
    const service = await request(t, "mcp_configure", { name: "terminal", endpoint: mcp.url, credential: input.name, tool_allowlist: [], enabled: false });
    assert.equal((await request(t, "mcp_check", { service_id: service.id })).ok, true);
    await t.client.request("add_credential", { ...input, secret: "rotated" });
    assert.deepEqual(t.runtime.credentials.get(input.name)?.scope, binding.scope);
    await assert.rejects(t.client.request("add_credential", { ...input, purpose: "http" }), rejected("invalid_params"));
    const sends = mcp.hits.length;
    for (const patch of [{ scope: { projectId: "old", operations: ["mcp"] } }, { scope: { repoId: 7, operations: ["mcp"] } }, { scope: undefined }, { scope: { operations: ["mcp", "http"] } }, { purpose: "http", scope: { operations: ["http"] } }]) {
      const legacy = { ...input, name: "old", ...patch };
      t.runtime.credentials.upsert(legacy);
      await assert.rejects(t.client.request("add_credential", { ...input, name: legacy.name }), rejected("credential_scope_mismatch"));
      assert.deepEqual(t.runtime.credentials.get(legacy.name), legacy);
      await assert.rejects(request(t, "mcp_configure", { name: "old", endpoint: mcp.url, credential: legacy.name, tool_allowlist: [] }), rejected("invalid_params"));
      await assert.rejects(request(t, "mcp_remove_credential", { name: legacy.name }), rejected("credential_scope_mismatch"));
      const filtered = await request(t, "list_credentials", { purpose: "mcp", endpoint: mcp.url });
      assert.deepEqual(filtered.map(credential => credential.name), [input.name]);
    }
    assert.equal(mcp.hits.length, sends);
    assert.equal(mcp.hits.some(hit => hit.rpcMethod === "tools/call"), false);
  } finally { await t.shutdown(); await mcp.close(); }
});

test("MCP 编辑核实实际保留的凭据，匿名须显式清除引用", async () => {
  const t = await startTestRuntime("d-mcp-keep", quiet);
  try {
    await request(t, "mcp_save_credential", { name: "bound", endpoint, secret: MOCK_MCP_SECRET });
    const base = { name: "docs", endpoint, tool_allowlist: [] };
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
    for (const patch of [{ host: "other.example.com" }, { header: "x-token" }, { purpose: "other" }, { scope: { projectId: "other-source", operations: ["mcp"] } }, { scope: { repoId: 7, operations: ["mcp"] } }, { scope: undefined }, { scope: { operations: ["http"] } }, { scope: { operations: ["mcp", "http"] } }]) {
      t.runtime.credentials.upsert({ name: "wrong", host: "mcp.example.com", header: "authorization", purpose: "mcp", secret: MOCK_MCP_SECRET, scope: { operations: ["mcp"] }, ...patch });
      await assert.rejects(request(t, "mcp_configure", { ...base, credential: "wrong", expected_version: anonymous.configVersion }), rejected("invalid_params"));
      await assert.rejects(request(t, "mcp_configure", { ...base, name: "invalid-new", credential: "wrong", expected_version: 0 }), rejected("invalid_params"));
    }
    await assert.rejects(request(t, "mcp_configure", { ...base, name: "invalid-new", credential: "missing", expected_version: 0 }), rejected("invalid_params"));
    assert.equal(t.runtime.mcp.listServices().length, 1);
    await assert.rejects(t.client.request("mcp_configure", { ...base, credential: false }), rejected("invalid_params"));
  } finally { await t.shutdown(); }
});

test("禁用草稿只握手和发现工具，凭据 host、用途、认证头或范围变化时不联网", async () => {
  const mcp = await startMockMcp({ requireAuth: true, tools: [{ name: "read" }, { name: "write", annotations: { readOnlyHint: true } }] });
  const t = await startTestRuntime("d-mcp-check", quiet);
  try {
    await request(t, "mcp_save_credential", { name: "bound", endpoint: mcp.url, secret: MOCK_MCP_SECRET });
    const service = await request(t, "mcp_configure", { name: "draft", endpoint: mcp.url, credential: "bound", tool_allowlist: [], enabled: false, expected_version: 0 });
    const checked = await request(t, "mcp_check", { service_id: service.id });
    assert.equal(checked.ok, true);
    assert.equal(checked.service.enabled, false);
    assert.equal(checked.tools.length, 2);
    assert.ok(checked.tools.every(tool => !tool.allowed && tool.effect === undefined));
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
    const binding = t.runtime.credentials.get("bound")!;
    for (const patch of [{ host: "other.example.com" }, { purpose: "other" }, { header: "x-token" }, { scope: { projectId: "old", operations: ["mcp"] } }, { scope: { repoId: 1, operations: ["mcp"] } }, { scope: undefined }, { scope: { operations: ["http"] } }]) {
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
    const service = await request(t, "mcp_configure", { name: "bad", endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, credential: null, tool_allowlist: [], enabled: false });
    const result = await request(t, "mcp_check", { service_id: service.id });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(MOCK_MCP_SECRET));
  } finally { await t.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("MCP 启停与事件同事务提交，事件失败保留原状态和版本", async () => {
  const t = await startTestRuntime("d-mcp-tx", quiet);
  try {
    const service = t.runtime.mcpConfigure({ name: "docs", endpoint, credential: null, toolAllowlist: [], enabled: false });
    const append = t.runtime.store.appendEvent;
    t.runtime.store.appendEvent = () => { throw new RuntimeApiError("injected", "事件写入失败"); };
    try { assert.throws(() => t.runtime.mcpSetEnabled(service.id, true, service.configVersion), error => error instanceof RuntimeApiError && error.code === "injected"); }
    finally { t.runtime.store.appendEvent = append; }
    assert.equal(t.runtime.mcp.getService(service.id)!.enabled, false);
    assert.equal(t.runtime.mcp.getService(service.id)!.configVersion, service.configVersion);
  } finally { await t.shutdown(); }
});
