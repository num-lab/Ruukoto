import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID, type SubmissionId, type TaskId, type TaskRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MCP_LIMITS, McpError, type McpRemoteTool } from "@ruukoto/agent/mcp/transport.ts";
import { migratePersonalMcp, parsePersonalMcp, readPersonalMcp, savePersonalMcp, personalMcpCredential, resolvePersonalMcpToken, discoverPersonalMcp, type PersonalMcpConfig } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { startMockMcp, MOCK_MCP_SECRET } from "./helpers/mock-mcp.ts";

const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const context = BACKGROUND_CONTEXT;
const tool: McpRemoteTool = { name: "read", description: "原工具", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, outputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { source: "original" } };
const config: PersonalMcpConfig = parsePersonalMcp({ version: 1, generation: "first-generation", services: [{ id: "test-service", label: "测试服务", endpoint: "https://mcp.example.test/mcp", tools: [structuredClone(tool)] }] });
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "personal-mcp-config-")));
  const directory = path.join(root, "profile");
  const profile = lockPersonalProfile(directory);
  t.after(() => { profile.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const filename = path.join(root, "token");
  fs.writeFileSync(filename, MOCK_MCP_SECRET + "\n", { mode: 0o600 });
  return { root, directory, profile, filename };
}

test("个人 MCP 配置：保留完整工具定义，拒绝端点、版本、未知字段和重复允许项", t => {
  fixture(t);
  assert.deepEqual(parsePersonalMcp(config), config);
  const service = config.services[0];
  const invalidServices = [
    { ...service, endpoint: "https://mcp.example.test/mcp#alias" },
    { ...service, endpoint: "http://unsafe.example/mcp" },
    { ...service, endpoint: "https://owner:secret@example.test/mcp" },
    { ...service, credential: { path: "relative", sha256: "a".repeat(64) } },
    { ...service, token: "never-save" },
    { ...service, tools: [tool, tool] },
    { ...service, tools: [{ ...tool, name: "unsafe/name" }] },
    { ...service, tools: [{ ...tool, inputSchema: { type: "array" } }] },
    { ...service, tools: [{ ...tool, inputSchema: { type: "object", properties: { value: { type: "string", pattern: "[" } } } }] },
    { ...service, tools: [{ ...tool, outputSchema: { type: "string" } }] },
    { ...service, tools: [{ ...tool, inputSchema: { type: "object", description: "x".repeat(MCP_LIMITS.maxToolSchemaBytes) } }] },
    { ...service, tools: [{ ...tool, description: "x".repeat(MCP_LIMITS.maxToolDescriptionChars + 1) }] },
    { ...service, tools: Array.from({ length: MCP_LIMITS.maxToolsPerService + 1 }, (_, index) => ({ ...tool, name: `tool_${index}` })) },
  ];
  for (const value of [null, [], { ...config, version: 2 }, { ...config, generation: "" }, { ...config, token: "never-save" }, { ...config, services: [service, service] }, ...invalidServices.map(service => ({ ...config, services: [service] }))]) assert.throws(() => parsePersonalMcp(value), code("mcp_config_invalid"), JSON.stringify(value));
});

test("个人 MCP 配置：持锁私有原子保存，幂等不覆写，变更必须换代", async t => {
  const f = fixture(t);
  assert.equal(readPersonalMcp(f.profile), undefined);
  await assert.rejects(savePersonalMcp(f.directory, config), code("profile_busy"));
  await savePersonalMcp(f.profile, config);
  const filename = path.join(f.directory, "mcp.json"), before = fs.statSync(filename);
  assert.equal(before.mode & 0o777, 0o600);
  assert.deepEqual(readPersonalMcp(f.profile), config);
  await savePersonalMcp(f.profile, config);
  assert.equal(fs.statSync(filename).ino, before.ino);
  const changed = { ...config, services: [{ ...config.services[0], label: "更新服务" }] };
  await assert.rejects(savePersonalMcp(f.profile, changed), code("mcp_config_changed"));
  assert.deepEqual(readPersonalMcp(f.profile), config);
  await savePersonalMcp(f.profile, { ...changed, generation: "second-generation" });
  assert.equal(readPersonalMcp(f.profile)?.generation, "second-generation");
  assert.equal(fs.existsSync(path.join(f.directory, "mcp.json.tmp")), false);
});

test("个人 MCP 配置：显式迁入逐服务启停格式，保留旧定义且拒绝降版和不完整状态", async t => {
  const f = fixture(t);
  await assert.rejects(migratePersonalMcp(f.profile), code("mcp_config_missing"));
  await savePersonalMcp(f.profile, config);
  await assert.rejects(migratePersonalMcp(f.directory), code("profile_busy"));
  const migrated = await migratePersonalMcp(f.profile);
  assert.equal(migrated.version, 2);
  assert.notEqual(migrated.generation, config.generation);
  assert.deepEqual(migrated.services, config.services.map(service => ({ ...service, enabled: true })));
  assert.deepEqual(await migratePersonalMcp(f.profile), migrated);
  assert.deepEqual(readPersonalMcp(f.profile), migrated);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, "mcp.json"), "utf8")).version, 2);
  await assert.rejects(savePersonalMcp(f.profile, { ...config, generation: "downgrade" }), code("mcp_config_downgrade"));
  for (const invalid of [
    { ...migrated, services: config.services },
    { ...migrated, services: [{ ...migrated.services[0], enabled: "false" }] },
    { ...config, services: [{ ...config.services[0], enabled: true }] },
    { ...migrated, version: 4 },
  ]) assert.throws(() => parsePersonalMcp(invalid), code("mcp_config_invalid"));
  const stopped = { ...migrated, generation: "stopped", services: migrated.services.map(service => ({ ...service, enabled: false })) };
  await savePersonalMcp(f.profile, stopped);
  assert.deepEqual(readPersonalMcp(f.profile), stopped);
});

test("个人 MCP 配置：停用仍核实原凭据，失效时保留当前配置", async t => {
  const f = fixture(t), service = { ...config.services[0], credential: personalMcpCredential(f.filename) };
  await savePersonalMcp(f.profile, { ...config, services: [service] });
  const migrated = await migratePersonalMcp(f.profile);
  fs.unlinkSync(f.filename);
  await assert.rejects(savePersonalMcp(f.profile, { ...migrated, generation: "stopped", services: migrated.services.map(service => ({ ...service, enabled: false })) }), code("mcp_credentials_invalid"));
  assert.deepEqual(readPersonalMcp(f.profile), migrated);
});

for (const kind of ["invalid-json", "version", "mode", "symlink", "hardlink"] as const) {
  test(`个人 MCP 配置：${kind} 拒绝读取，不能当未配置继续`, async t => {
    const f = fixture(t), filename = path.join(f.directory, "mcp.json");
    fs.writeFileSync(filename, kind === "invalid-json" ? "broken" : JSON.stringify({ ...config, version: kind === "version" ? 2 : 1 }), { mode: 0o600 });
    if (kind === "mode") fs.chmodSync(filename, 0o644);
    if (kind === "symlink") { fs.unlinkSync(filename); fs.symlinkSync(path.join(f.root, "missing"), filename); }
    if (kind === "hardlink") fs.linkSync(filename, path.join(f.root, "alias"));
    assert.throws(() => readPersonalMcp(f.profile), code("mcp_config_invalid"));
    await assert.rejects(savePersonalMcp(f.profile, config), code("mcp_config_invalid"));
  });
}

test("个人 MCP 凭据：每次重读，撤销、替换、链接和开放权限均不能降级匿名", async t => {
  const f = fixture(t), credential = personalMcpCredential(f.filename);
  const service = { ...config.services[0], credential };
  assert.equal(await resolvePersonalMcpToken(service), MOCK_MCP_SECRET);
  await savePersonalMcp(f.profile, { ...config, services: [service] });
  assert.ok(!fs.readFileSync(path.join(f.directory, "mcp.json"), "utf8").includes(MOCK_MCP_SECRET));
  fs.writeFileSync(f.filename, "replacement");
  await assert.rejects(resolvePersonalMcpToken(service), code("mcp_credentials_invalid"));
  fs.unlinkSync(f.filename);
  await assert.rejects(resolvePersonalMcpToken(service), code("mcp_credentials_invalid"));
  for (const kind of ["empty", "mode", "symlink", "hardlink", "directory"] as const) {
    fs.writeFileSync(f.filename, kind === "empty" ? "\n" : MOCK_MCP_SECRET + "\n", { mode: 0o600 });
    if (kind === "mode") fs.chmodSync(f.filename, 0o644);
    if (kind === "symlink") { fs.unlinkSync(f.filename); fs.symlinkSync(path.join(f.root, "missing"), f.filename); }
    if (kind === "hardlink") fs.linkSync(f.filename, path.join(f.root, "token-alias"));
    if (kind === "directory") { fs.unlinkSync(f.filename); fs.mkdirSync(f.filename); }
    assert.throws(() => personalMcpCredential(f.filename), code("mcp_credentials_invalid"));
    await assert.rejects(resolvePersonalMcpToken(service), code("mcp_credentials_invalid"));
    fs.rmSync(f.filename, { recursive: true });
  }
});

test("个人 MCP 配置：不安全暂存文件拒绝写入，原配置和外部文件保留", async t => {
  const f = fixture(t);
  await savePersonalMcp(f.profile, config);
  const temporary = path.join(f.directory, "mcp.json.tmp");
  fs.symlinkSync(f.filename, temporary);
  await assert.rejects(savePersonalMcp(f.profile, { ...config, generation: "second" }), code("mcp_config_write_failed"));
  assert.deepEqual(readPersonalMcp(f.profile), config);
  assert.equal(fs.readFileSync(f.filename, "utf8"), MOCK_MCP_SECRET + "\n");
});

test("个人 MCP 发现：固定凭据与原清单，凭据撤销后零外调", async t => {
  const f = fixture(t);
  const mcp = await startMockMcp({ requireAuth: true, tools: [{ name: "read", description: "完整描述", inputSchema: { type: "object", properties: { value: { type: "number" } } }, outputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] });
  t.after(() => mcp.close());
  const service = { id: "test", endpoint: mcp.url, credential: personalMcpCredential(f.filename) };
  const tools = await discoverPersonalMcp(service);
  assert.equal(tools[0].name, "read");
  assert.deepEqual(tools[0].annotations, { readOnlyHint: true });
  assert.deepEqual(tools[0].inputSchema.properties, { value: { type: "number" } });
  assert.ok(mcp.hits.every(hit => hit.hasAuth));
  const before = mcp.hits.length;
  fs.unlinkSync(f.filename);
  await assert.rejects(discoverPersonalMcp(service), error => error instanceof McpError && error.code === "auth_failed");
  assert.equal(mcp.hits.length, before);
});

for (const initial of [true, false]) {
  for (const pending of ["task", "submission"] as const) {
    test(`个人 MCP 配置：${initial ? "首次启用" : "变更"}拒绝未决 ${pending}，幂等保留原配置`, async t => {
      const f = fixture(t);
      const provider = personalProvider({ api: "openai-completions", baseUrl: "https://unused.example.test", modelId: "mock-model", apiKeyEnv: "UNUSED_MCP_CONFIG_KEY", contextWindow: 128000, maxTokens: 1024 });
      // 只建立真实业务格式，不发模型请求；之后直接写 durable 原生记录覆盖未决状态。
      const harness = await openPersonalHarness({ profile: f.profile, provider, modelId: "mock-model" });
      await harness.close();
      const profile = lockPersonalProfile(f.directory);
      t.after(() => profile.release());
      if (!initial) await savePersonalMcp(profile, config);
      const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
      try {
        if (pending === "task") {
          const id = await storage.mintId<TaskId<JsonValue>>();
          const task: TaskRecord<JsonValue, JsonValue, JsonValue> = { id, conversationId: ROOT_CONVERSATION_ID, kind: "test.pending", version: 1, input: {}, background: false, abortRequested: false, state: { status: "pending", checkpoint: { phase: "pending" } } };
          await storage.commit([{ type: "task", value: task }], context);
        } else {
          const id = await storage.mintId<SubmissionId>();
          await storage.commit([{ type: "submission", value: { id, conversationId: ROOT_CONVERSATION_ID, type: "input", status: "queued" } }], context);
        }
      } finally { await storage.close(context); }
      await assert.rejects(savePersonalMcp(profile, { ...config, generation: "new-generation" }), code("mcp_config_pending"));
      if (!initial) await assert.rejects(migratePersonalMcp(profile), code("mcp_config_pending"));
      assert.deepEqual(readPersonalMcp(profile), initial ? undefined : config);
      if (!initial) await savePersonalMcp(profile, config);
    });
  }
}
