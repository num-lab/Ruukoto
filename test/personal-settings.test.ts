import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { defineDocFamily, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { test, type TestContext } from "node:test";
import { savePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { personalControl, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { dispatchPersonalSettings, executePersonalSettings, parsePersonalSettingsRequest, runPersonalSettingsMachine, testPersonalModel } from "../apps/ruukoto/src/personal-settings.ts";
import type { PersonalSettingsReceipt } from "../apps/ruukoto/src/personal-settings-records.ts";
import type { PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";
import { startMockMcp } from "./helpers/mock-mcp.ts";

type Snapshot = { profile: { directory: string; id: string }; revisions: { model: string; skills: string; mcp: string }; online: boolean; model: { config: PersonalModelConfig; credential: { state: string } }; blockers: { kind: string }[]; skills: { sourceHost: string; revision: string; config: null; directory: string; diagnostics: string[]; skills: { id: string; name: string; source: string; readOnly: boolean; state: string }[] } };
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;

async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-settings-")), directory = path.join(root, "p"), model = new PersonalMockModelServer(() => ({ kind: "text", text: "秘密响应不应回显" }));
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: `SETTINGS_TEST_${randomUUID().replaceAll("-", "_").toUpperCase()}`, contextWindow: 4096, maxTokens: 32 };
  process.env[config.apiKeyEnv] = "test-secret-value";
  await savePersonalConfig(directory, config);
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  t.after(async () => { await server?.stop(); await model.close(); delete process.env[config.apiKeyEnv]; fs.rmSync(root, { recursive: true, force: true }); });
  isolateSkillHome(t);
  return { root, directory, model, config, read: () => executePersonalSettings(directory, { v: 1, op: "settings.read" }) as Promise<Snapshot>, start: async (development = false) => server = await startPersonalServer(directory, { development }) };
}

function write(base: { profile: Snapshot["profile"]; expectedRevision: string }, op: Record<string, unknown>) {
  return { v: 2, id: randomUUID(), profile: base.profile, expectedRevision: base.expectedRevision, op };
}
function save(snapshot: Snapshot, value: unknown, target = "model") {
  return write({ profile: snapshot.profile, expectedRevision: snapshot.revisions[target as keyof Snapshot["revisions"]] }, { kind: "config.save", target, value });
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
  const receipt = await executePersonalSettings(f.directory, save(initial, next)) as PersonalSettingsReceipt;
  assert.equal(receipt.status, "saved"); assert.equal(receipt.savedRevision, (await f.read()).revisions.model); assert.notEqual(receipt.effectiveRevision, receipt.savedRevision);
  const updated = await f.read(); assert.equal(updated.model.config.modelId, "next-model"); assert.notEqual(updated.revisions.model, initial.revisions.model);
  await assert.rejects(executePersonalSettings(f.directory, save(initial, f.config)), code("settings_revision_changed"));
  assert.equal(f.model.calls.length, 0);
});

test("设置保存：本机待核实输入不阻止配置，无效替换目标保留原文件与原键", async t => {
  const f = await fixture(t), initial = await f.read(), before = fs.readFileSync(path.join(f.directory, "model.json"), "utf8");
  for (const name of [`pending-${randomUUID()}.json`, `pending-question-${randomUUID()}.json`, "pending-background-end.json"]) {
    const pending = path.join(f.directory, name);
    fs.writeFileSync(pending, "{}\n", { mode: 0o600 });
    assert.deepEqual((await f.read()).blockers, []);
    assert.equal((await executePersonalSettings(f.directory, save(initial, f.config)) as PersonalSettingsReceipt).status, "saved");
    assert.equal(fs.existsSync(pending), true); assert.equal(fs.readFileSync(path.join(f.directory, "model.json"), "utf8"), before);
    fs.unlinkSync(pending);
  }
  const profile = lockPersonalProfile(f.directory);
  try {
    fs.mkdirSync(path.join(f.directory, "model.json.tmp"), { mode: 0o700 });
    await assert.rejects(dispatchPersonalSettings({ profile }, save(initial, { ...f.config, modelId: "changed" })), code("settings_history_invalid"));
    assert.equal(fs.readFileSync(path.join(f.directory, "model.json"), "utf8"), before);
  } finally { fs.rmdirSync(path.join(f.directory, "model.json.tmp")); profile.release(); }
});

test("设置在线查询：认证与脱敏保持，开发实例同 PID 保存而不触发生命周期或模型", async t => {
  const f = await fixture(t); await f.start(true);
  const result = await f.read(); assert.equal(result.online, true); assert.equal(result.model.credential.state, "available"); assert.equal(f.model.calls.length, 0);
  const lifecycle = await executePersonalSettings(f.directory, { v: 1, op: "lifecycle.status" }) as { lifecycle: { managedDevelopment: boolean; automaticRestart: boolean; originalEnvironment: string } };
  assert.deepEqual(lifecycle.lifecycle, { state: "running", pid: process.pid, managedDevelopment: true, automaticRestart: false, originalEnvironment: "unverified" });
  const receipt = await executePersonalSettings(f.directory, save(result, f.config)) as PersonalSettingsReceipt;
  assert.equal(receipt.status, "active"); assert.equal(receipt.savedRevision, receipt.effectiveRevision);
  assert.deepEqual((await executePersonalSettings(f.directory, { v: 1, op: "lifecycle.status" }) as typeof lifecycle).lifecycle, lifecycle.lifecycle); assert.equal(f.model.calls.length, 0);
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

for (const state of ["input", "mcp"] as const) test(`设置保存：持久化 ${state} 未决不阻止独立模型保存，原业务记录保留`, async t => {
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
  assert.deepEqual((await f.read()).blockers, []);
  assert.equal((await executePersonalSettings(f.directory, save(initial, f.config)) as PersonalSettingsReceipt).status, "saved");
  assert.equal(fs.readFileSync(path.join(f.directory, "model.json"), "utf8"), before);
});

test("MCP 设置：查询隐藏端点 query 与令牌、显式迁入及保存代次，缺凭据保留认证引用", async t => {
  const f = await fixture(t), filename = path.join(f.root, "token"); fs.writeFileSync(filename, "mcp-private-secret", { mode: 0o600 });
  const { personalMcpCredential } = await import("../apps/ruukoto/src/personal-mcp-config.ts");
  const service = { id: "service", label: "服务", endpoint: "https://mcp.example.test/api?token=endpoint-private-secret", credential: { path: filename, sha256: createHash("sha256").update(fs.readFileSync(filename)).digest("hex") }, tools: [] };
  await savePersonalMcp(f.directory, { version: 1, generation: "original", services: [service] });
  const initial = await f.read(), queried = await executePersonalSettings(f.directory, { v: 1, op: "mcp.get", profile: initial.profile, expectedRevision: initial.revisions.mcp, id: service.id }) as { service: typeof service & { endpointRedacted: boolean; credentialStatus: string } };
  assert.equal(queried.service.endpointRedacted, true); assert.equal(queried.service.credentialStatus, "valid"); assert.ok(!JSON.stringify(queried).includes("endpoint-private-secret")); assert.ok(!JSON.stringify(queried).includes("mcp-private-secret"));
  await assert.rejects(executePersonalSettings(f.directory, save(initial, { version: 2, services: [{ ...queried.service, enabled: false }] }, "mcp")), code("mcp_migration_required"));
  await executePersonalSettings(f.directory, write({ profile: initial.profile, expectedRevision: initial.revisions.mcp }, { kind: "mcp.migrate" }));
  const migrated = await f.read();
  assert.notEqual(migrated.revisions.mcp, initial.revisions.mcp);
  await executePersonalSettings(f.directory, save(migrated, { version: 4, services: [{ ...queried.service, enabled: false, toolEffects: {} }] }, "mcp"));
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, "mcp.json"), "utf8")); assert.equal(saved.version, 4); assert.equal(saved.services[0].enabled, false); assert.equal(saved.services[0].endpoint, service.endpoint); assert.notEqual(saved.generation, "original");
  fs.unlinkSync(filename);
  const current = await f.read(), missing = await executePersonalSettings(f.directory, { v: 1, op: "mcp.get", profile: current.profile, expectedRevision: current.revisions.mcp, id: service.id }) as { service: { credentialStatus: string; credential?: unknown } };
  assert.equal(missing.service.credentialStatus, "missing"); assert.ok(missing.service.credential);
  await assert.rejects(executePersonalSettings(f.directory, save(current, { version: 4, services: [{ ...queried.service, enabled: true, toolEffects: {} }] }, "mcp")), code("mcp_credentials_invalid"));
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
  assert.equal((await machine(f.directory, write(base, { kind: "mcp.migrate" }))).status, 0);
  snapshot = await f.read(); base = { ...base, expectedRevision: snapshot.revisions.mcp };
  const page = await executePersonalSettings(f.directory, { ...base, op: "mcp.get", id: "large", limit: 1 }) as { service: { tools: typeof tools }; toolsHasMore: boolean };
  assert.deepEqual(page.service.tools, tools.slice(0, 1)); assert.equal(page.toolsHasMore, true);
  assert.equal((await machine(f.directory, write(base, { kind: "mcp.set-enabled", id: "large", enabled: false }))).status, 0);
  snapshot = await f.read(); base = { ...base, expectedRevision: snapshot.revisions.mcp };
  assert.equal((await machine(f.directory, write(base, { kind: "mcp.save-service", service: { id: "large", label: "新名称" } }))).status, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, "mcp.json"), "utf8"));
  assert.equal(saved.services[0].enabled, false); assert.equal(saved.services[0].label, "新名称"); assert.deepEqual(saved.services[0].tools, tools);
  snapshot = await f.read(); base = { ...base, expectedRevision: snapshot.revisions.mcp };
  assert.equal((await machine(f.directory, write(base, { kind: "mcp.remove", id: "large" }))).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, "mcp.json"), "utf8")).services, []);
});

test("技能设置：固定 HOME 只读发现、详情与分页，退役操作拒绝且源文件保留", async t => {
  const f = await fixture(t), skills = path.join(isolateSkillHome(t), ".agents", "skills"), source = path.join(skills, "alpha");
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(path.join(skills, "beta"));
  const body = "---\ndescription: 固定目录技能\n---\n技能正文\n";
  fs.writeFileSync(path.join(source, "SKILL.md"), body); fs.writeFileSync(path.join(skills, "beta", "SKILL.md"), "---\ndescription: 第二个技能\n---\n正文\n");
  const initial = await f.read(), base = { v: 1, profile: initial.profile, expectedRevision: initial.skills.revision };
  assert.equal(initial.skills.sourceHost, "personal"); assert.equal(initial.skills.directory, skills); assert.equal(initial.skills.config, null);
  assert.deepEqual(initial.skills.skills.map(skill => [skill.name, skill.source, skill.readOnly, skill.state]), [["alpha", "external", true, "enabled"], ["beta", "external", true, "enabled"]]);
  const page = await executePersonalSettings(f.directory, { ...base, op: "skills.list", offset: 1, limit: 1 }) as Snapshot["skills"];
  assert.deepEqual(page.skills.map(skill => skill.name), ["beta"]);
  const detail = await executePersonalSettings(f.directory, { ...base, op: "skills.get", id: initial.skills.skills[0].id }) as { body: string };
  assert.equal(detail.body, "技能正文");
  await assert.rejects(executePersonalSettings(f.directory, { ...base, op: "skills.list", profile: { ...initial.profile, id: `sha256:${"0".repeat(64)}` } }), code("settings_profile_changed"));
  for (const op of ["skills.select-directory", "skills.preview-import", "skills.import", "skills.set-enabled", "skills.remove"]) {
    const v1 = await machine(f.directory, { ...base, op, directory: source, purpose: "import", id: randomUUID(), enabled: false });
    assert.equal(v1.status, 1); assert.equal(v1.body.code, "settings_operation_unsupported");
    if (!["skills.select-directory", "skills.preview-import"].includes(op)) {
      const v2 = await machine(f.directory, write(base, { kind: op, directory: source, id: randomUUID(), contentRevision: initial.skills.revision, enabled: false }));
      assert.equal(v2.status, 1); assert.equal(v2.body.code, "settings_request_invalid");
    }
  }
  for (const op of ["config.preflight", "config.save"]) {
    assert.equal((await machine(f.directory, { ...base, op, target: "skills", value: { version: 1, directory: f.root } })).body.code, "settings_request_invalid");
  }
  assert.equal((await machine(f.directory, write(base, { kind: "config.save", target: "skills", value: { version: 1, directory: f.root } }))).body.code, "settings_request_invalid");
  assert.equal(fs.existsSync(path.join(f.directory, "skills.json")), false); assert.equal(fs.existsSync(path.join(f.directory, "managed-skills")), false);
  assert.equal(fs.readFileSync(path.join(source, "SKILL.md"), "utf8"), body);
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
