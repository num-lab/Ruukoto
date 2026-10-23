import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { defineDocFamily, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { test, type TestContext } from "node:test";
import { savePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { savePersonalSkills } from "../apps/ruukoto/src/personal-skills-config.ts";
import { personalControl, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { dispatchPersonalSettings, executePersonalSettings, parsePersonalSettingsRequest, runPersonalSettingsMachine, testPersonalModel } from "../apps/ruukoto/src/personal-settings.ts";
import type { PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";
import { startMockMcp } from "./helpers/mock-mcp.ts";

type Snapshot = { profile: { directory: string; id: string }; revisions: { model: string; skills: string; mcp: string }; online: boolean; model: { config: PersonalModelConfig; credential: { state: string } }; blockers: { kind: string }[]; skills: { sourceHost: string; revision: string; config: { directory: string } | null; externalAvailable: boolean; diagnostics: string[]; skills: { id: string; name: string; source: string; readOnly: boolean; state: string }[] } };
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;

async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-settings-")), directory = path.join(root, "p"), model = new PersonalMockModelServer(() => ({ kind: "text", text: "秘密响应不应回显" }));
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: `SETTINGS_TEST_${randomUUID().replaceAll("-", "_").toUpperCase()}`, contextWindow: 4096, maxTokens: 32 };
  process.env[config.apiKeyEnv] = "test-secret-value";
  await savePersonalConfig(directory, config);
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  t.after(async () => { await server?.stop(); await model.close(); delete process.env[config.apiKeyEnv]; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, model, config, read: () => executePersonalSettings(directory, { v: 1, op: "settings.read" }) as Promise<Snapshot>, start: async (development = false) => server = await startPersonalServer(directory, { development }) };
}

function save(snapshot: Snapshot, value: unknown, target = "model") {
  return { v: 1, op: "config.save", profile: snapshot.profile, target, expectedRevision: snapshot.revisions[target as keyof Snapshot["revisions"]], value };
}

async function machine(directory: string, value: unknown) {
  let output = "";
  const status = await runPersonalSettingsMachine(directory, (async function* () { yield JSON.stringify(value); })(), value => { output += value; });
  return { status, output, body: JSON.parse(output) as { v: number; product: string; ok: boolean; code?: string; result?: unknown } };
}

test("设置机器入口：未知操作、错误版本、额外参数及请求限额返回有界结构化错误", async t => {
  const f = await fixture(t);
  for (const [request, expected] of [[{ v: 1, op: "exec", command: "echo secret" }, "settings_operation_unsupported"], [{ v: 9, op: "settings.read" }, "settings_request_invalid"], [{ v: 1, op: "settings.read", sql: "select *" }, "settings_request_invalid"], [{ v: 1, op: "settings.read", limit: 51 }, "settings_request_invalid"]] as const) {
    const result = await machine(f.directory, request);
    assert.equal(result.status, 1); assert.equal(result.body.code, expected); assert.equal(result.body.product, "ruukoto"); assert.equal(result.body.v, 1);
  }
  let output = "";
  assert.equal(await runPersonalSettingsMachine(f.directory, (async function* () { yield "x".repeat(128 * 1024 + 1); })(), value => { output += value; }), 1);
  assert.equal(JSON.parse(output).code, "settings_request_large"); assert.ok(output.length < 1024); assert.equal(f.model.calls.length, 0);
  assert.throws(() => parsePersonalSettingsRequest({ v: 1, op: "config.save" }), code("settings_request_invalid"));
});

test("设置查询：离线持锁与修订保存，错档案、旧修订及非法配置保留原文件", async t => {
  const f = await fixture(t), initial = await f.read(), before = fs.readFileSync(path.join(f.directory, "model.json"), "utf8");
  assert.equal(initial.online, false); assert.equal(initial.model.credential.state, "unverified"); assert.ok(!JSON.stringify(initial).includes("test-secret-value"));
  const lock = lockPersonalProfile(f.directory);
  try { await assert.rejects(f.read(), code("profile_busy")); } finally { lock.release(); }
  await assert.rejects(executePersonalSettings(f.directory, { ...save(initial, { ...f.config, modelId: "wrong" }), profile: { ...initial.profile, id: `sha256:${"0".repeat(64)}` } }), code("settings_profile_changed"));
  await assert.rejects(executePersonalSettings(f.directory, { ...save(initial, f.config), expectedRevision: "missing" }), code("settings_revision_changed"));
  await assert.rejects(executePersonalSettings(f.directory, save(initial, { ...f.config, maxTokens: 9000 })), code("model_config_invalid"));
  assert.equal(fs.readFileSync(path.join(f.directory, "model.json"), "utf8"), before);
  const next = { ...f.config, modelId: "next-model" };
  assert.equal((await executePersonalSettings(f.directory, save(initial, next)) as { saved: boolean }).saved, true);
  const updated = await f.read(); assert.equal(updated.model.config.modelId, "next-model"); assert.notEqual(updated.revisions.model, initial.revisions.model);
  await assert.rejects(executePersonalSettings(f.directory, save(initial, f.config)), code("settings_revision_changed"));
  assert.equal(f.model.calls.length, 0);
});

test("设置保存：待核实本机输入阻断无变化保存，原配置与请求保留；原子替换失败不改原文件", async t => {
  const f = await fixture(t), initial = await f.read(), before = fs.readFileSync(path.join(f.directory, "model.json"), "utf8");
  for (const name of [`pending-${randomUUID()}.json`, `pending-question-${randomUUID()}.json`, "pending-background-end.json"]) {
    const pending = path.join(f.directory, name);
    fs.writeFileSync(pending, "{}\n", { mode: 0o600 });
    assert.deepEqual((await f.read()).blockers, [{ kind: "pending-input" }]);
    await assert.rejects(executePersonalSettings(f.directory, save(initial, f.config)), code("settings_pending"));
    assert.equal(fs.existsSync(pending), true); assert.equal(fs.readFileSync(path.join(f.directory, "model.json"), "utf8"), before);
    fs.unlinkSync(pending);
  }
  const profile = lockPersonalProfile(f.directory);
  try {
    fs.mkdirSync(path.join(f.directory, "model.json.tmp"), { mode: 0o700 });
    await assert.rejects(dispatchPersonalSettings({ profile }, save(initial, { ...f.config, modelId: "changed" })), code("model_config_write_failed"));
    assert.equal(fs.readFileSync(path.join(f.directory, "model.json"), "utf8"), before);
  } finally { fs.rmdirSync(path.join(f.directory, "model.json.tmp")); profile.release(); }
});

test("设置在线查询：认证、脱敏、明确停机保存与开发实例生命周期，不联网或创建工作", async t => {
  const f = await fixture(t); await f.start(true);
  const result = await f.read(); assert.equal(result.online, true); assert.equal(result.model.credential.state, "available"); assert.equal(f.model.calls.length, 0);
  const lifecycle = await executePersonalSettings(f.directory, { v: 1, op: "lifecycle.status" }) as { lifecycle: { managedDevelopment: boolean; automaticRestart: boolean; originalEnvironment: string } };
  assert.deepEqual(lifecycle.lifecycle, { state: "running", pid: process.pid, managedDevelopment: true, automaticRestart: false, originalEnvironment: "unverified" });
  await assert.rejects(executePersonalSettings(f.directory, save(result, f.config)), code("settings_stop_required"));
  const unauthorized = await new Promise<string>((resolve, reject) => {
    const request = http.request({ socketPath: path.join(f.directory, "control.sock"), path: "/settings", headers: { authorization: "Bearer wrong" } }, response => { let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve(text)); }); request.on("error", reject); request.end();
  });
  assert.equal(JSON.parse(unauthorized).code, "control_unauthorized"); assert.ok(!unauthorized.includes("test-secret-value"));
});

test("显式模型测试：只发1 token无工具请求，隐藏回复，后台工作与输入不变；离线凭据环境不冒充通过", async t => {
  const f = await fixture(t), offline = await f.read(), request = { v: 1, op: "model.test", profile: offline.profile, expectedRevision: offline.revisions.model, value: f.config };
  assert.equal((await executePersonalSettings(f.directory, request) as { test: { status: string } }).test.status, "unverified"); assert.equal(f.model.calls.length, 0);
  const server = await f.start();
  const before = await personalControl(f.directory, "GET", "/status"), tested = await executePersonalSettings(f.directory, request) as { test: { status: string; code: string } };
  assert.equal(tested.test.status, "passed"); assert.equal(tested.test.code, "model_connection_ok"); assert.ok(!JSON.stringify(tested).includes("秘密响应"));
  assert.equal(f.model.calls.length, 1); assert.equal(f.model.calls[0].tools, undefined); assert.equal(f.model.calls[0].raw.max_tokens ?? f.model.calls[0].raw.max_completion_tokens, 1); assert.deepEqual(f.model.calls[0].messages, [{ role: "user", content: "ping" }]);
  assert.deepEqual(await personalControl(f.directory, "GET", "/status"), before);
  await server.stop();
  const instance = await openPersonalHarness({ directory: f.directory, provider: personalProvider(f.config), modelId: f.config.modelId });
  try {
    const entries = (await instance.main.entries({ order: "ascending" }, 256, undefined, BACKGROUND_CONTEXT)).items, tests = entries.filter(entry => entry.kind === "ruukoto.settings-model-test");
    assert.equal(tests.length, 2); assert.ok(!tests.some(entry => entry.model));
    assert.match(JSON.stringify(tests[0].data), /ping/); assert.ok(!JSON.stringify(tests).includes("test-secret-value"));
    const evidence = tests.map(entry => entry.data as { requestId: string; payload?: unknown });
    assert.equal(evidence[0].requestId, evidence[1].requestId); assert.deepEqual(evidence[1].payload, f.model.calls[0].raw);
    await instance.answer("常规输入", "after-diagnostic"); assert.doesNotMatch(JSON.stringify(f.model.calls.at(-1)!.messages), /"ping"/);
  } finally { await instance.close(); }
});

test("模型测试：规范输入或实际payload的证据写失败都不发HTTP", async t => {
  const f = await fixture(t);
  for (const failAt of [1, 2]) {
    let recorded = 0;
    const result = await testPersonalModel(f.config, { record: async () => { if (++recorded === failAt) throw new Error("storage-unavailable"); } });
    assert.equal(result.code, "model_test_evidence_failed"); assert.equal(recorded, failAt); assert.equal(f.model.calls.length, 0);
  }
});

test("模型测试失败：认证响应脱敏、超时有界，未创建个人工作", async t => {
  const f = await fixture(t), replies = http.createServer((request, response) => {
    if (request.url?.startsWith("/hang")) return;
    response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "secret-token-and-provider-response" } }));
  });
  replies.listen(0, "127.0.0.1"); await once(replies, "listening");
  t.after(() => { replies.closeAllConnections(); return new Promise<void>(resolve => replies.close(() => resolve())); });
  const address = replies.address(); assert.ok(address && typeof address === "object");
  const denied = await testPersonalModel({ ...f.config, baseUrl: `http://127.0.0.1:${address.port}/denied` });
  assert.equal(denied.code, "model_connection_failed"); assert.ok(!JSON.stringify(denied).includes("secret-token"));
  const started = Date.now(), timed = await testPersonalModel({ ...f.config, baseUrl: `http://127.0.0.1:${address.port}/hang` }, { timeoutMs: 30 });
  assert.equal(timed.code, "model_test_timeout"); assert.ok(Date.now() - started < 2000);
});

test("设置命令：真实非交互入口只输出一份版本化 JSON", async t => {
  const f = await fixture(t);
  const result = await new Promise<{ status: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/ruukoto/src/personal-entry.ts", "settings"], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, RUUKOTO_PERSONAL_DIR: f.directory }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", value => { out += value; }); child.stderr.on("data", value => { err += value; }); child.on("error", reject); child.on("exit", status => resolve({ status, out, err })); child.stdin.end(JSON.stringify({ v: 1, op: "settings.read" }));
  });
  assert.equal(result.status, 0, result.err); assert.equal(JSON.parse(result.out).product, "ruukoto"); assert.equal(result.out.trim().split("\n").length, 1); assert.ok(!result.out.includes("test-secret-value"));
});

for (const state of ["input", "mcp"] as const) test(`设置保存：持久化 ${state} 未决阻断所有保存，原配置保留`, async t => {
  const f = await fixture(t), initial = await f.read(), before = fs.readFileSync(path.join(f.directory, "model.json"), "utf8");
  const instance = await openPersonalHarness({ directory: f.directory, provider: personalProvider(f.config), modelId: f.config.modelId });
  try {
    await instance.harness.commit(async tx => {
      if (state === "input") await tx.createSubmission({ conversationId: ROOT_CONVERSATION_ID, type: "input", requestId: "unplaced", status: "queued" });
      else {
        const doc = defineDocFamily<{ operation?: { operation: number; started: boolean; remoteEnded: boolean; effect: string } }, null>({ kind: "ruukoto.mcp", scope: "session", version: 1, family: true, initial: () => ({}) });
        (await tx.doc(doc, "7", null)).operation = { operation: 7, started: true, remoteEnded: false, effect: "effect_unknown" };
      }
    }, BACKGROUND_CONTEXT);
  } finally { await instance.close(); }
  assert.ok((await f.read()).blockers.some(item => item.kind === (state === "input" ? "pending-work" : "mcp-unresolved")));
  await assert.rejects(executePersonalSettings(f.directory, save(initial, f.config)), code("settings_pending"));
  assert.equal(fs.readFileSync(path.join(f.directory, "model.json"), "utf8"), before);
});

test("MCP 设置：查询隐藏端点 query 与令牌、显式迁入及保存代次，缺凭据保留认证引用", async t => {
  const f = await fixture(t), filename = path.join(f.root, "token"); fs.writeFileSync(filename, "mcp-private-secret", { mode: 0o600 });
  const { personalMcpCredential } = await import("../apps/ruukoto/src/personal-mcp-config.ts");
  const service = { id: "service", label: "服务", endpoint: "https://mcp.example.test/api?token=endpoint-private-secret", credential: personalMcpCredential(filename), tools: [] };
  await savePersonalMcp(f.directory, { version: 1, generation: "original", services: [service] });
  const initial = await f.read(), queried = await executePersonalSettings(f.directory, { v: 1, op: "mcp.get", profile: initial.profile, expectedRevision: initial.revisions.mcp, id: service.id }) as { service: typeof service & { endpointRedacted: boolean; credentialStatus: string } };
  assert.equal(queried.service.endpointRedacted, true); assert.equal(queried.service.credentialStatus, "valid"); assert.ok(!JSON.stringify(queried).includes("endpoint-private-secret")); assert.ok(!JSON.stringify(queried).includes("mcp-private-secret"));
  await assert.rejects(executePersonalSettings(f.directory, save(initial, { version: 2, services: [{ ...queried.service, enabled: false }] }, "mcp")), code("mcp_migration_required"));
  await executePersonalSettings(f.directory, { v: 1, op: "mcp.migrate", profile: initial.profile, expectedRevision: initial.revisions.mcp });
  const migrated = await f.read();
  assert.notEqual(migrated.revisions.mcp, initial.revisions.mcp);
  await executePersonalSettings(f.directory, save(migrated, { version: 2, services: [{ ...queried.service, enabled: false }] }, "mcp"));
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, "mcp.json"), "utf8")); assert.equal(saved.version, 2); assert.equal(saved.services[0].enabled, false); assert.equal(saved.services[0].endpoint, service.endpoint); assert.notEqual(saved.generation, "original");
  fs.unlinkSync(filename);
  const current = await f.read(), missing = await executePersonalSettings(f.directory, { v: 1, op: "mcp.get", profile: current.profile, expectedRevision: current.revisions.mcp, id: service.id }) as { service: { credentialStatus: string; credential?: unknown } };
  assert.equal(missing.service.credentialStatus, "missing"); assert.ok(missing.service.credential);
  await assert.rejects(executePersonalSettings(f.directory, save(current, { version: 2, services: [{ ...queried.service, enabled: true }] }, "mcp")), code("mcp_credentials_invalid"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, "mcp.json"), "utf8")).services[0].enabled, false);
});

test("MCP 设置发现：必须选凭据或明确匿名，只返回原定义而不调用业务工具", async t => {
  const f = await fixture(t), mock = await startMockMcp({ tools: [{ name: "original", description: "原定义", inputSchema: { type: "object", properties: { value: { type: "string" } } }, annotations: { readOnlyHint: true } }] });
  t.after(() => mock.close());
  const initial = await f.read(), request = { v: 1, op: "mcp.discover", profile: initial.profile, expectedRevision: initial.revisions.mcp, service: { id: "service", label: "服务", endpoint: mock.url } };
  await assert.rejects(executePersonalSettings(f.directory, request), code("mcp_credentials_required")); assert.equal(mock.hits.length, 0);
  const result = await executePersonalSettings(f.directory, { ...request, service: { ...request.service, authentication: "anonymous" } }) as { tools: { name: string; annotations: unknown }[] };
  assert.equal(result.tools[0].name, "original"); assert.deepEqual(result.tools[0].annotations, { readOnlyHint: true });
  assert.ok(mock.hits.some(hit => hit.rpcMethod === "tools/list")); assert.ok(mock.hits.every(hit => hit.rpcMethod !== "tools/call"));
  assert.equal(fs.existsSync(path.join(f.directory, "mcp.json")), false);
});

test("MCP 设置：超过请求限额的既有合法配置仍可分页读、迁入、启停与更新，原工具不丢失", async t => {
  const f = await fixture(t), tools = Array.from({ length: 34 }, (_, index) => ({ name: `tool_${index}`, description: "d".repeat(4000), inputSchema: { type: "object" } }));
  await savePersonalMcp(f.directory, { version: 1, generation: "large-original", services: [{ id: "large", label: "原服务", endpoint: "https://mcp.example.test/api", tools }] });
  assert.ok(fs.statSync(path.join(f.directory, "mcp.json")).size > 128 * 1024);
  let snapshot = await f.read();
  let base = { v: 1, profile: snapshot.profile, expectedRevision: snapshot.revisions.mcp };
  assert.equal((await machine(f.directory, { ...base, op: "mcp.migrate" })).status, 0);
  snapshot = await f.read(); base = { ...base, expectedRevision: snapshot.revisions.mcp };
  const page = await executePersonalSettings(f.directory, { ...base, op: "mcp.get", id: "large", limit: 1 }) as { service: { tools: typeof tools }; toolsHasMore: boolean };
  assert.deepEqual(page.service.tools, tools.slice(0, 1)); assert.equal(page.toolsHasMore, true);
  assert.equal((await machine(f.directory, { ...base, op: "mcp.set-enabled", id: "large", enabled: false })).status, 0);
  snapshot = await f.read(); base = { ...base, expectedRevision: snapshot.revisions.mcp };
  assert.equal((await machine(f.directory, { ...base, op: "mcp.save-service", service: { id: "large", label: "新名称" } })).status, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, "mcp.json"), "utf8"));
  assert.equal(saved.services[0].enabled, false); assert.equal(saved.services[0].label, "新名称"); assert.deepEqual(saved.services[0].tools, tools);
  snapshot = await f.read(); base = { ...base, expectedRevision: snapshot.revisions.mcp };
  assert.equal((await machine(f.directory, { ...base, op: "mcp.remove", id: "large" })).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, "mcp.json"), "utf8")).services, []);
});

test("技能设置：远端有界目录选择、预览/导入/详情/启停/移除、修订与忙状态闭环", async t => {
  const f = await fixture(t), sources = path.join(f.root, "sources"), source = path.join(sources, "alpha");
  fs.mkdirSync(path.join(source, "refs"), { recursive: true }); fs.mkdirSync(path.join(sources, "beta")); fs.writeFileSync(path.join(sources, "not-a-directory"), "不应列出");
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\ndescription: 原远端技能\n---\n技能正文\n"); fs.writeFileSync(path.join(source, "refs", "guide.md"), "引用原字节");
  const initial = await f.read(), base = { v: 1, profile: initial.profile, expectedRevision: initial.skills.revision };
  assert.equal(initial.skills.sourceHost, "personal"); assert.deepEqual(initial.skills.skills, []);
  const selected = await executePersonalSettings(f.directory, { ...base, op: "skills.select-directory", purpose: "import", directory: sources, limit: 1 }) as { directories: { name: string; directory: string }[]; hasMore: boolean };
  assert.deepEqual(selected.directories, [{ name: "alpha", directory: source }]); assert.equal(selected.hasMore, true); assert.ok(!JSON.stringify(selected).includes("not-a-directory"));
  const preview = await executePersonalSettings(f.directory, { ...base, op: "skills.preview-import", directory: source }) as { id: string; contentRevision: string; sourceDir: string; revision: string };
  assert.equal(preview.sourceDir, source);
  const many = path.join(f.root, "many"); fs.mkdirSync(many);
  for (let index = 0; index < 1001; index++) fs.writeFileSync(path.join(many, `file-${index}`), "");
  const bounded = await executePersonalSettings(f.directory, { ...base, op: "skills.select-directory", purpose: "import", directory: many }) as { directories: unknown[]; truncated: boolean };
  assert.equal(bounded.truncated, true); assert.deepEqual(bounded.directories, []);
  const linked = path.join(f.root, "linked"); fs.symlinkSync(source, linked);
  await assert.rejects(executePersonalSettings(f.directory, { ...base, op: "skills.select-directory", purpose: "import", directory: linked }), code("skills_directory_invalid"));
  const external = path.join(f.root, "external-root"), actual = path.join(f.root, "actual-skills"); fs.mkdirSync(external); fs.mkdirSync(actual); fs.symlinkSync(actual, path.join(external, "skills"));
  const libraryChoice = await executePersonalSettings(f.directory, { ...base, op: "skills.select-directory", purpose: "library", directory: external }) as { selectable: boolean };
  assert.equal(libraryChoice.selectable, true);
  const request = { ...base, op: "skills.import", directory: source, id: preview.id, contentRevision: preview.contentRevision };
  const pending = path.join(f.directory, `pending-work-${randomUUID()}.json`); fs.writeFileSync(pending, "{}", { mode: 0o600 });
  await assert.rejects(executePersonalSettings(f.directory, request), code("settings_pending")); assert.equal(fs.existsSync(path.join(f.directory, "managed-skills")), false); fs.unlinkSync(pending);
  const imported = await executePersonalSettings(f.directory, request) as { saved: boolean; target: string; revision: string; source: string; readOnly: boolean };
  assert.equal(imported.saved, true); assert.equal(imported.target, "skills");
  assert.equal(imported.source, "managed"); assert.equal(imported.readOnly, false); assert.equal("body" in imported, false);
  assert.equal((await machine(f.directory, { ...base, op: "skills.get", id: preview.id })).body.code, "skills_revision_conflict");
  const current = { ...base, expectedRevision: imported.revision };
  await assert.rejects(executePersonalSettings(f.directory, { ...current, op: "skills.list", profile: { ...initial.profile, id: `sha256:${"0".repeat(64)}` } }), code("settings_profile_changed"));
  const server = await f.start();
  const listing = await executePersonalSettings(f.directory, { ...current, op: "skills.list" }) as Snapshot["skills"];
  assert.equal(listing.skills[0].name, "alpha"); assert.equal(listing.sourceHost, "personal");
  const detail = await executePersonalSettings(f.directory, { ...current, op: "skills.get", id: preview.id }) as { body: string };
  assert.equal(detail.body, "技能正文");
  await assert.rejects(executePersonalSettings(f.directory, { ...current, op: "skills.set-enabled", id: preview.id, enabled: false }), code("settings_stop_required"));
  const invalid = await machine(f.directory, { ...current, op: "skills.get", id: preview.id, path: "/etc/passwd" }); assert.equal(invalid.body.code, "settings_request_invalid");
  await server.stop();
  const disabled = await executePersonalSettings(f.directory, { ...current, op: "skills.set-enabled", id: preview.id, enabled: false }) as { saved: boolean; target: string; revision: string; state: string };
  assert.equal(disabled.saved, true); assert.equal(disabled.target, "skills");
  assert.equal(disabled.state, "disabled");
  const removed = await executePersonalSettings(f.directory, { ...current, expectedRevision: disabled.revision, op: "skills.remove", id: preview.id }) as { saved: boolean; target: string; revision: string; state: string };
  assert.equal(removed.saved, true); assert.equal(removed.target, "skills");
  assert.equal(removed.state, "removed"); assert.deepEqual((await f.read()).skills.skills, []);
  assert.equal(fs.readFileSync(path.join(source, "refs", "guide.md"), "utf8"), "引用原字节");
  assert.equal(fs.readFileSync(path.join(f.directory, "managed-skills", "packages", preview.id, "alpha", "refs", "guide.md"), "utf8"), "引用原字节");
});

test("技能设置：外部来源只读，源目录失效仍可查询模型及诊断并修复配置", async t => {
  const f = await fixture(t), agent = path.join(f.root, "external"), source = path.join(agent, "skills", "external-skill");
  fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, "SKILL.md"), "---\ndescription: 外部来源\n---\n正文\n");
  await savePersonalSkills(f.directory, { version: 1, directory: agent });
  const initial = await f.read(), external = initial.skills.skills[0]; assert.equal(external.source, "external"); assert.equal(external.readOnly, true);
  const response = await machine(f.directory, { v: 1, op: "skills.remove", profile: initial.profile, expectedRevision: initial.skills.revision, id: external.id });
  assert.equal(response.body.code, "skills_read_only"); assert.equal(fs.existsSync(path.join(source, "SKILL.md")), true);
  fs.renameSync(agent, `${agent}-moved`);
  const broken = await f.read(); assert.equal(broken.model.config.modelId, f.config.modelId); assert.equal(broken.skills.externalAvailable, false); assert.match(broken.skills.diagnostics.join(""), /外部技能库不可用/);
  await executePersonalSettings(f.directory, save(broken, { version: 1, directory: `${agent}-moved` }, "skills"));
  assert.equal((await f.read()).skills.externalAvailable, true);
});


test("MCP 设置发现：具名Cua经过解析并报告制品不可用，不走HTTP认证", async t => {
  const f = await fixture(t), initial = await f.read();
  const request = { v: 1, op: "mcp.discover", profile: initial.profile, expectedRevision: initial.revisions.mcp, service: { label: "电脑", cua: { kind: "cua-linux", executable: "/missing/official-cua", version: "0.7.0", sha256: "a".repeat(64), sandbox: "local:desktop", sandboxId: "b".repeat(64) } } };
  await assert.rejects(executePersonalSettings(f.directory, request), (error: unknown) => error instanceof Error && "code" in error && ["mcp_discovery_failed"].includes(String(error.code)));
  assert.equal(fs.existsSync(path.join(f.directory, "mcp.json")), false);
});

test("Cua 设置：发现绑定档案与修订，缺安装不影响查询；离线控制拒绝且请求不接受任意参数", async t => {
  const f = await fixture(t), initial = await f.read(), request = { v: 1, op: "mcp.cua-targets", profile: initial.profile, expectedRevision: initial.revisions.mcp };
  await assert.rejects(executePersonalSettings(f.directory, { ...request, expectedRevision: "sha256:" + "f".repeat(64) }), code("settings_revision_changed"));
  const result = await executePersonalSettings(f.directory, request) as { targets: unknown[]; issues: { code: string }[] };
  assert.ok(Array.isArray(result.targets)); assert.ok(Array.isArray(result.issues));
  await assert.rejects(executePersonalSettings(f.directory, { ...request, op: "mcp.cua-control", action: "pause" }), code("cua_offline"));
  for (const value of [{ ...request, executable: "/tmp/arbitrary" }, { ...request, op: "mcp.cua-control", action: "accept", operation: 1 }, { ...request, op: "mcp.cua-control", action: "pause", operation: 1 }, { ...request, op: "mcp.cua-image", operation: 1, observation: 2, image: "../../outside" }]) assert.throws(() => parsePersonalSettingsRequest(value), code("settings_request_invalid"));
  assert.equal((await f.read()).online, false); assert.equal(f.model.calls.length, 0);
});
