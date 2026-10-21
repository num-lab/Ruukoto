import { product as personalProduct } from "./helpers/legacy-product.ts";
/**
 * 集成与单元：模型配置管理（issue 21 §3/§4）。
 *
 * 覆盖：
 * - get_model_config 脱敏（apiKey → true，秘密不出现在响应/事件）；
 * - save_model_catalog 空闲应用、list_models 即时反映、修订冲突、结构校验失败不动文件；
 * - set_model_api_key 0600 持久化（非内存覆盖）、重启后仍有效、脱敏；
 * - 应用门闩：running/queued/awaiting_confirmation 任务阻止受影响 provider，
 *   未受影响的新 provider 照常应用；被阻止时文件字节不变；
 * - remove_model_provider 引用检查（会话/角色/默认模型）；
 * - set_default_model 持久化、新会话生效、旧会话不改写、重启存活、显式启动参数优先；
 * - 配置锁互斥（同 agentDir 不同 dataDir、在线拒绝离线、遗留锁接管）；
 * - test_model_connection 显式联网探测；
 * - 重建失败整体回滚（文件恢复旧字节、旧目录继续可用）；
 * - 门闩窗口内受影响 provider 的提交与并发应用被拒绝（model_config_busy）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { acquireConfigLock, InstanceLockError } from "@ruukoto/core/instance-lock.ts";
import { configRevision, configSecrets, loadModelConfigMetadata, probeModelConfig, readModelConfigMetadata, removeProviderCredential, restoreCatalogSecrets, sanitizeCatalog } from "@ruukoto/agent/model-config.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import {
  makeTestDirs,
  cleanupDirs,
  writeModelsJson,
  connectAuthedClient,
  createProjectSession,
  taskStatus,
  waitFor,
  pendingConfirmation,
  type TestDirs,
} from "./helpers/testkit.ts";
import type { ControlClient } from "@ruukoto/control/client.ts";

const MOCK_SELECTION = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

interface ManualRuntime {
  dirs: TestDirs;
  work: string[];
  server: MockModelServer;
  baseUrl: string;
  runtime: Runtime;
  client: ControlClient;
}

/** 进程内启动后台（不固定启动 provider，让默认模型走 models.json/持久默认解析）。 */
async function startRt(dirs: TestDirs, extra: Partial<RuntimeConfig> = {
    product: personalProduct.runtime,}): Promise<{ runtime: Runtime; client: ControlClient }> {
  const runtime = await Runtime.start({
    product: personalProduct.runtime,
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    toolFactory: (ctx) => createMockTools(ctx),
    ...extra,
  });
  await ControlServer.start(runtime);
  const client = await connectAuthedClient(runtime);
  await client.handshake();
  return { runtime, client };
}

async function startManual(prefix: string, responder: Responder, opts: { secondProvider?: boolean } = {}): Promise<ManualRuntime> {
  const { dirs, work } = await makeTestDirs(prefix, 2);
  const server = new MockModelServer(responder);
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  if (opts.secondProvider) {
    const file = path.join(dirs.agentDir, "models.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.providers.second = {
      ...config.providers.mock,
      models: [{ ...config.providers.mock.models[0], id: "reasoner", name: "Reasoner", reasoning: true, maxTokens: 4096 }],
    };
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
  }
  const { runtime, client } = await startRt(dirs);
  return { dirs, work, server, baseUrl, runtime, client };
}

async function stopRt(t: { runtime?: Runtime; client?: ControlClient }): Promise<void> {
  t.client?.close();
  if (t.runtime) await t.runtime.stop("test_end");
}

async function cleanupManual(t: ManualRuntime): Promise<void> {
  await stopRt(t);
  await t.server.close();
  await cleanupDirs(t.dirs);
}

const textResponder: Responder = () => ({ kind: "text", text: "ok" });

function readModels(dirs: TestDirs): any {
  return JSON.parse(fs.readFileSync(path.join(dirs.agentDir, "models.json"), "utf8"));
}

function submitMock(client: ControlClient, sessionId: string, requestId: string, input = "ping"): Promise<any> {
  return client.request("submit", { session_id: sessionId, request_id: requestId, input, model_selection: MOCK_SELECTION });
}

test("get_model_config 脱敏：apiKey 以 true 代替，响应不携带秘密", async () => {
  const t = await startManual("model-config-view", textResponder);
  try {
    const view = await t.client.request<any>("get_model_config", {});
    assert.equal(view.providers.mock.apiKey, true, "内联 apiKey 必须替换为 true");
    assert.equal(view.providers.mock.models[0].id, "mock-model");
    assert.deepEqual(view.credentials, {}, "auth.json 缺失时凭据为空");
    assert.equal(view.defaultModel, null);
    assert.deepEqual(view.runtimeDefault, MOCK_SELECTION);
    assert.deepEqual(view.busyProviders, []);
    assert.deepEqual(view.runtimeOverrides, { model: false, thinking: false });
    assert.deepEqual(view.models, [{ provider: "mock", modelId: "mock-model", name: "Mock Model", thinkingLevels: ["off"] }]);
    assert.deepEqual(view.credentialSources.mock, { locations: [{ source: "catalog", field: "apiKey", scope: "provider" }], verification: "unverified" });
    assert.match(view.revision, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(view).includes("mock-key"), "响应不得包含秘密值");
  } finally {
    await cleanupManual(t);
  }
});

test("模型配置元数据：读取在线与离线列表不求值命令、环境模板、OAuth 或认证", async (t) => {
  const live = await startManual("model-metadata-safe", textResponder);
  const sentinel = path.join(live.dirs.root, "credential-command-ran");
  const command = `!touch '${sentinel}'`;
  const file = path.join(live.dirs.agentDir, "models.json");
  const catalog = readModels(live.dirs);
  catalog.providers.mock.apiKey = command;
  catalog.providers.mock.headers = { "X-Provider": "provider-secret" };
  catalog.providers.mock.models[0].headers = { "X-Model": "model-secret" };
  catalog.providers.mock.modelOverrides = { "mock-model": { headers: { "X-Override": "override-secret" }, compat: { supportsStore: false } } };
  catalog.providers.missing = { api: "openai-completions", baseUrl: live.baseUrl, apiKey: "$RUUKOTO_METADATA_MISSING", models: [{ id: "missing", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "extra", max: "maximum" } }] };
  catalog.providers.bad = { models: [{ id: "unresolved", name: "Unresolved", reasoning: true }] };
  fs.writeFileSync(file, JSON.stringify(catalog));
  const auth = { "openai-codex": { type: "oauth", access: "expired-access-secret", refresh: "expired-refresh-secret", expires: 0 }, stored: { type: "api_key", key: "!literal-stored-key" } };
  const authFile = path.join(live.dirs.agentDir, "auth.json");
  fs.writeFileSync(authFile, JSON.stringify(auth));
  const envBefore = process.env.RUUKOTO_METADATA_MISSING;
  delete process.env.RUUKOTO_METADATA_MISSING;
  let authCalls = 0;
  const rejectAuthentication = (): never => { authCalls += 1; throw new Error("列表不得求值认证"); };
  t.mock.method(ModelRuntime.prototype, "checkAuth", rejectAuthentication);
  t.mock.method(ModelRuntime.prototype, "getAuth", rejectAuthentication);
  t.mock.method(ModelRuntime.prototype, "refresh", rejectAuthentication);
  t.mock.method(globalThis, "fetch", rejectAuthentication);
  try {
    const online = await live.client.request<any>("get_model_config", {});
    const offline = await loadModelConfigMetadata(live.dirs.agentDir);
    assert.equal(authCalls, 0);
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(fs.readFileSync(authFile, "utf8"), JSON.stringify(auth));
    assert.equal(process.env.RUUKOTO_METADATA_MISSING, undefined);
    assert.ok(configSecrets(live.dirs.agentDir).includes(auth["openai-codex"].access));
    assert.ok(configSecrets(live.dirs.agentDir).includes(auth["openai-codex"].refresh));
    for (const metadata of [online, offline]) {
      assert.deepEqual(metadata.credentials["openai-codex"], { configured: true, type: "oauth" });
      assert.deepEqual(metadata.credentials.stored, { configured: true, type: "api_key" });
      assert.equal(metadata.credentials.mock, undefined);
      assert.equal(metadata.credentialSources.mock.verification, "unverified");
      const locations = metadata.credentialSources.mock.locations;
      assert.ok(locations.some((location: any) => location.scope === "provider" && location.field === "apiKey"));
      assert.ok(locations.some((location: any) => location.scope === "provider" && location.header === "X-Provider"));
      assert.ok(locations.some((location: any) => location.scope === "model" && location.modelId === "mock-model" && location.header === "X-Model"));
      assert.ok(locations.some((location: any) => location.scope === "modelOverrides" && location.modelId === "mock-model" && location.header === "X-Override"));
      const response = JSON.stringify(metadata);
      for (const secret of [command, "provider-secret", "model-secret", "override-secret", "expired-access-secret", "expired-refresh-secret", "!literal-stored-key"]) assert.ok(!response.includes(secret));
    }
    assert.deepEqual(offline.models.find((model) => model.provider === "missing")?.thinkingLevels, ["off", "low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(offline.models.find((model) => model.provider === "bad"), { provider: "bad", modelId: "unresolved", name: "Unresolved", thinkingLevels: null });
    const draft = sanitizeCatalog(catalog);
    delete draft.providers.mock.modelOverrides["mock-model"].headers["X-Override"];
    const restored = restoreCatalogSecrets(draft, catalog);
    const expected = structuredClone(catalog);
    delete expected.providers.mock.modelOverrides["mock-model"].headers["X-Override"];
    assert.deepEqual(restored, expected, "清除具体 header 只改变选定字段，其他高级字段与秘密保持原样");
  } finally {
    if (envBefore === undefined) delete process.env.RUUKOTO_METADATA_MISSING;
    else process.env.RUUKOTO_METADATA_MISSING = envBefore;
    t.mock.restoreAll();
    await cleanupManual(live);
  }
});

test("移除存储条目后内联与环境来源仍保留，元数据不宣称已无凭据", async () => {
  const { dirs } = await makeTestDirs("model-sources-remove", 0);
  const envBefore = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "environment-secret";
  try {
    await writeModelsJson(dirs, "http://127.0.0.1:1");
    const catalog = readModels(dirs);
    catalog.providers.openai = { headers: { "X-Source": "environment-header" } };
    fs.writeFileSync(path.join(dirs.agentDir, "models.json"), JSON.stringify(catalog));
    const stored = { mock: { type: "api_key", key: "stored-secret" }, openai: { type: "api_key", key: "stored-openai-secret" } };
    fs.writeFileSync(path.join(dirs.agentDir, "auth.json"), JSON.stringify(stored));
    const makeRuntime = () => ModelRuntime.create({ authPath: path.join(dirs.agentDir, "auth.json"), modelsPath: path.join(dirs.agentDir, "models.json"), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
    const before = await makeRuntime();
    assert.equal((await before.getAuth("mock"))?.auth.apiKey, "stored-secret");
    assert.equal((await before.getAuth("openai"))?.auth.apiKey, "stored-openai-secret");
    const modelBytes = fs.readFileSync(path.join(dirs.agentDir, "models.json"));
    removeProviderCredential(dirs.agentDir, "mock");
    removeProviderCredential(dirs.agentDir, "openai");
    const after = await makeRuntime();
    assert.equal((await after.getAuth("mock"))?.auth.apiKey, "mock-key");
    assert.equal((await after.getAuth("openai"))?.auth.apiKey, "environment-secret");
    const metadata = readModelConfigMetadata(dirs.agentDir, after);
    assert.deepEqual(metadata.credentials, {});
    assert.equal(metadata.credentialSources.mock.locations[0].source, "catalog");
    assert.equal(metadata.credentialSources.openai.verification, "unverified");
    assert.equal(fs.readFileSync(path.join(dirs.agentDir, "models.json")).equals(modelBytes), true);
    assert.equal(process.env.OPENAI_API_KEY, "environment-secret");
    assert.deepEqual(await loadModelConfigMetadata(dirs.agentDir), metadata, "重开后保留相同的来源语义");
  } finally {
    if (envBefore === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = envBefore;
    await cleanupDirs(dirs);
  }
});

test("离线模型元数据读取不创建缺失的 auth.json 或改变 revision", async () => {
  const { dirs } = await makeTestDirs("model-metadata-readonly", 0);
  try {
    await writeModelsJson(dirs, "http://127.0.0.1:1");
    const authFile = path.join(dirs.agentDir, "auth.json");
    const revision = configRevision(dirs.agentDir);
    const files = fs.readdirSync(dirs.agentDir);
    const metadata = await loadModelConfigMetadata(dirs.agentDir);
    assert.equal(metadata.models.length, 1);
    assert.equal(fs.existsSync(authFile), false);
    assert.equal(configRevision(dirs.agentDir), revision);
    assert.deepEqual(fs.readdirSync(dirs.agentDir), files);
  } finally {
    await cleanupDirs(dirs);
  }
});

test("模型配置解析失败不回显秘密文件中的原始 JSON 片段", async () => {
  const live = await startManual("model-metadata-parse-error", textResponder);
  try {
    for (const [file, secret] of [["auth.json", "auth-secret"], ["models.json", "catalog-secret"]]) {
      const target = path.join(live.dirs.agentDir, file);
      const before = fs.readFileSync(target);
      fs.writeFileSync(target, secret);
      try {
        await assert.rejects(live.client.request("get_model_config", {}), (error: Error) => {
          assert.ok(error.message.includes(file));
          assert.ok(!error.message.includes(secret));
          return true;
        });
      } finally {
        fs.writeFileSync(target, before);
      }
    }
  } finally {
    await cleanupManual(live);
  }
});

test("probeModelConfig：有配置可用 / 空目录不可用", async () => {
  const { dirs } = await makeTestDirs("model-config-probe", 0);
  try {
    const empty = await probeModelConfig(dirs.agentDir);
    assert.equal(empty.ok, false);
    assert.ok(empty.detail.length > 0);
    const server = new MockModelServer(textResponder);
    const baseUrl = await server.start();
    try {
      await writeModelsJson(dirs, baseUrl);
      const probed = await probeModelConfig(dirs.agentDir);
      assert.equal(probed.ok, true);
      assert.deepEqual(probed.selection, MOCK_SELECTION);
      // 首个 provider 的首个模型不可解析（缺 api，SDK 丢弃）：探测与 Runtime.start 同判不可用，
      // 不能探测放行、后台却 no_model 启动失败
      const file = path.join(dirs.agentDir, "models.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ providers: { bad: { baseUrl, models: [{ id: "x" }] }, ...config.providers } }));
      assert.equal((await probeModelConfig(dirs.agentDir)).ok, false);
      await assert.rejects(startRt(dirs), (err: any) => err.code === "no_model");
    } finally {
      await server.close();
    }
  } finally {
    await cleanupDirs(dirs);
  }
});

test("configRevision：按文件分隔，同一字节换一个文件不会得到相同修订", async () => {
  const { dirs: a } = await makeTestDirs("model-config-rev-a", 0);
  const { dirs: b } = await makeTestDirs("model-config-rev-b", 0);
  try {
    fs.writeFileSync(path.join(a.agentDir, "auth.json"), "{}");
    fs.writeFileSync(path.join(b.agentDir, "default-model.json"), "{}");
    assert.notEqual(configRevision(a.agentDir), configRevision(b.agentDir));
  } finally {
    await cleanupDirs(a);
    await cleanupDirs(b);
  }
});

test("save_model_catalog：空闲应用即时生效、修订变化、冲突与结构校验", async () => {
  const t = await startManual("model-config-save", textResponder);
  try {
    const before = await t.client.request<any>("get_model_config", {});
    const providers = readModels(t.dirs).providers;
    providers.extra = {
      name: "Extra",
      baseUrl: t.baseUrl,
      apiKey: "extra-secret-key",
      headers: { Authorization: "Bearer extra-header-secret" },
      api: "openai-completions",
      models: [{ id: "extra-model", name: "Extra Model", reasoning: false, contextWindow: 200000, maxTokens: 1024, headers: { "x-model-key": "model-header-secret" } }],
    };
    const saved = await t.client.request<any>("save_model_catalog", { providers, expected_revision: before.revision });
    assert.notEqual(saved.revision, before.revision, "应用后修订必须变化");
    // 不重启即反映到模型目录
    const listed = await t.client.request<any>("list_models", {});
    assert.ok(listed.models.some((m: any) => m.provider === "extra" && m.modelId === "extra-model"), "list_models 必须立即包含新 provider");
    // 新 provider 的内联 key 同样脱敏
    const after = await t.client.request<any>("get_model_config", {});
    assert.equal(after.providers.extra.apiKey, true);
    assert.equal(after.providers.extra.headers.Authorization, true, "headers 值同样脱敏");
    for (const secret of ["extra-secret-key", "extra-header-secret", "model-header-secret"]) assert.ok(!JSON.stringify(after).includes(secret), secret);
    // 过期修订冲突
    await assert.rejects(
      t.client.request("save_model_catalog", { providers, expected_revision: before.revision }),
      (err: any) => err.code === "config_conflict",
    );
    // 结构无效：文件字节不变、修订不变
    const bytesBefore = fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8");
    await assert.rejects(
      t.client.request("save_model_catalog", {
        providers: { bad: { baseUrl: t.baseUrl, models: [{ id: "m", contextWindow: 10, maxTokens: 20 }] } },
        expected_revision: saved.revision,
      }),
      (err: any) => err.code === "invalid_params",
    );
    await assert.rejects(
      t.client.request("save_model_catalog", { providers: [], expected_revision: saved.revision }),
      (err: any) => err.code === "invalid_params",
    );
    // 无原值可还原的占位符必须被拒绝（防止把 true 当成 apiKey 落盘）
    const ghost = { baseUrl: t.baseUrl, api: "openai-completions", apiKey: true, models: [{ id: "g" }] };
    await assert.rejects(
      t.client.request("save_model_catalog", { providers: { ...after.providers, ghost }, expected_revision: saved.revision }),
      (err: any) => err.code === "invalid_params",
    );
    const overrideGhost = structuredClone(after.providers);
    overrideGhost.extra.modelOverrides = { "extra-model": { headers: { "X-No-Original": true } } };
    await assert.rejects(
      t.client.request("save_model_catalog", { providers: overrideGhost, expected_revision: saved.revision }),
      (err: any) => err.code === "invalid_params",
      "modelOverrides 中没有原值的秘密占位符必须在写盘前拒绝",
    );
    overrideGhost.extra.modelOverrides = { "extra-model": { apiKey: true } };
    await assert.rejects(
      t.client.request("save_model_catalog", { providers: overrideGhost, expected_revision: saved.revision }),
      (err: any) => err.code === "invalid_params",
    );
    delete overrideGhost.extra.modelOverrides;
    overrideGhost.extra.models[0].apiKey = true;
    await assert.rejects(
      t.client.request("save_model_catalog", { providers: overrideGhost, expected_revision: saved.revision }),
      (err: any) => err.code === "invalid_params",
    );
    assert.equal(fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8"), bytesBefore, "校验失败不得改动文件");
    assert.equal((await t.client.request<any>("get_model_config", {})).revision, saved.revision);
    // 脱敏视图原样回写（只改名称；mock 的 key 仅内联、auth.json 无条目）：占位符还原为原值
    const view = await t.client.request<any>("get_model_config", {});
    view.providers.extra.name = "Extra 2";
    await t.client.request("save_model_catalog", { providers: view.providers, expected_revision: view.revision });
    const disk = readModels(t.dirs).providers;
    assert.equal(disk.extra.name, "Extra 2");
    assert.equal(disk.mock.apiKey, "mock-key");
    assert.equal(disk.extra.apiKey, "extra-secret-key");
    assert.deepEqual(disk.extra.headers, { Authorization: "Bearer extra-header-secret" });
    assert.deepEqual(disk.extra.models[0].headers, { "x-model-key": "model-header-secret" });
  } finally {
    await cleanupManual(t);
  }
});

test("set_model_api_key：0600 持久化、脱敏、重启后仍有效", async () => {
  const events: unknown[] = [];
  const t = await startManual("model-config-key", textResponder);
  try {
    t.client.onEvent((event) => events.push(event));
    const NEW_KEY = "sk-test-NEW-SECRET-47b2";
    const r0 = (await t.client.request<any>("get_model_config", {})).revision;
    const set = await t.client.request<any>("set_model_api_key", { provider: "mock", api_key: NEW_KEY, expected_revision: r0 });
    assert.equal(set.configured, true);
    assert.ok(!JSON.stringify(set).includes(NEW_KEY), "响应不得包含 key");
    // auth.json 0600 且内容为 api_key 凭据
    const authFile = path.join(t.dirs.agentDir, "auth.json");
    assert.equal(fs.statSync(authFile).mode & 0o777, 0o600, "auth.json 必须 0600");
    assert.deepEqual(JSON.parse(fs.readFileSync(authFile, "utf8")).mock, { type: "api_key", key: NEW_KEY });
    // 移除 models.json 内联 key：此后 mock 的凭据只来自 auth.json
    const providers = readModels(t.dirs).providers;
    delete providers.mock.apiKey;
    await t.client.request("save_model_catalog", { providers, expected_revision: set.revision });
    const catalogText = fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8");
    assert.ok(!catalogText.includes("mock-key") && !catalogText.includes(NEW_KEY), "models.json 不得再含任何 key");
    // key 生效：真实走一遍任务与显式连通性探测
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await submitMock(t.client, sessionId, "key-task");
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    const probe = await t.client.request<any>("test_model_connection", { provider: "mock", model_id: "mock-model" });
    assert.equal(probe.ok, true);
    // 事件与配置视图不含 key
    assert.ok(!JSON.stringify(events).includes(NEW_KEY), "事件不得包含 key");
    assert.ok(!JSON.stringify(t.runtime.getEventLog(0)).includes(NEW_KEY), "持久事件不得包含 key");
    assert.ok(!JSON.stringify(await t.client.request<any>("get_model_config", {})).includes(NEW_KEY));
    const view = await t.client.request<any>("get_model_config", {});
    assert.deepEqual(view.credentials.mock, { configured: true, type: "api_key" });

    // 重启后仍有效（auth.json 持久化，不是内存覆盖）
    await stopRt(t);
    const restarted = await startRt(t.dirs);
    t.runtime = restarted.runtime;
    t.client = restarted.client;
    const probe2 = await t.client.request<any>("test_model_connection", { provider: "mock", model_id: "mock-model" });
    assert.equal(probe2.ok, true, `重启后连通性应正常：${probe2.detail}`);
    const task2 = await submitMock(t.client, sessionId, "key-task-after-restart", "ping again");
    await waitFor("重启后任务完成", async () => (await taskStatus(t.client, task2.id)).task.status === "completed");
  } finally {
    await cleanupManual(t);
  }
});

test("应用门闩：运行中与排队任务阻止受影响 provider，未受影响的新 provider 照常应用", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const responder: Responder = async (_req, index) => {
    if (index === 0) await blocked;
    return { kind: "text", text: "done" };
  };
  const t = await startManual("model-config-gate", responder);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task1 = await submitMock(t.client, sessionId, "gate-1", "slow");
    await waitFor("首个模型请求在途", () => t.server.calls.length === 1);
    const task2 = await submitMock(t.client, sessionId, "gate-2", "queued");
    assert.equal((await taskStatus(t.client, task2.id)).task.status, "queued");

    // 只新增 provider q：mock 未变，不受影响，运行中也可应用
    const withQ = readModels(t.dirs).providers;
    withQ.q = { baseUrl: t.baseUrl, apiKey: "q-key", api: "openai-completions", models: [{ id: "q-model", contextWindow: 100000, maxTokens: 512 }] };
    const r0 = (await t.client.request<any>("get_model_config", {})).revision;
    const saved = await t.client.request<any>("save_model_catalog", { providers: withQ, expected_revision: r0 });
    const listed = await t.client.request<any>("list_models", { provider: "q" });
    assert.equal(listed.total, 1, "新 provider 应用后立即可见");

    // 修改 mock：running + queued 各一个任务 → 阻止，文件字节不变
    const bytesBefore = fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8");
    const authBefore = fs.existsSync(path.join(t.dirs.agentDir, "auth.json"))
      ? fs.readFileSync(path.join(t.dirs.agentDir, "auth.json"), "utf8")
      : null;
    const touching = readModels(t.dirs).providers;
    touching.mock.name = "Mock Renamed";
    await assert.rejects(
      t.client.request("save_model_catalog", { providers: touching, expected_revision: saved.revision }),
      (err: any) => err.code === "model_config_blocked" && err.message.includes("2"),
    );
    assert.equal(fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8"), bytesBefore, "被阻止时不得改动文件");
    const authAfter = fs.existsSync(path.join(t.dirs.agentDir, "auth.json"))
      ? fs.readFileSync(path.join(t.dirs.agentDir, "auth.json"), "utf8")
      : null;
    assert.equal(authAfter, authBefore, "被阻止时不得先改 auth.json");

    release();
    await waitFor("两个任务完成", async () => {
      const [s1, s2] = await Promise.all([taskStatus(t.client, task1.id), taskStatus(t.client, task2.id)]);
      return s1.task.status === "completed" && s2.task.status === "completed";
    });
    // 任务结束后同一修改可以应用
    await t.client.request("save_model_catalog", { providers: touching, expected_revision: saved.revision });
    assert.equal(readModels(t.dirs).providers.mock.name, "Mock Renamed");
    // 在线新增的 provider 在既有会话上可用（旧 SDK 会话按新模型栈重建）
    const qTask = await t.client.request<any>("submit", {
      session_id: sessionId, request_id: "gate-q", input: "use q",
      model_selection: { provider: "q", modelId: "q-model", thinkingLevel: "off" },
    });
    await waitFor("q 任务完成", async () => (await taskStatus(t.client, qTask.id)).task.status === "completed");
    assert.equal(t.server.calls.at(-1)!.raw.model, "q-model");
  } finally {
    release();
    await cleanupManual(t);
  }
});

test("应用门闩：等待确认的任务同样阻止受影响 provider", async () => {
  const gateResponder: Responder = (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) return { kind: "tool_calls", calls: [{ id: "c_gate", name: "mock_gate", arguments: { note: "需要确认" } }] };
    return { kind: "text", text: "已通过审批" };
  };
  const t = await startManual("model-config-gate-approval", gateResponder);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!, { confirmTools: ["mock_gate"] });
    const task = await submitMock(t.client, sessionId, "gate-approval", "触发审批");
    const confirmation = await pendingConfirmation(t.client, task.id);
    assert.equal((await taskStatus(t.client, task.id)).task.status, "awaiting_confirmation");
    const bytesBefore = fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8");
    const touching = readModels(t.dirs).providers;
    touching.mock.name = "Mock Renamed";
    const r0 = (await t.client.request<any>("get_model_config", {})).revision;
    await assert.rejects(
      t.client.request("save_model_catalog", { providers: touching, expected_revision: r0 }),
      (err: any) => err.code === "model_config_blocked",
    );
    assert.equal(fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8"), bytesBefore);
    await t.client.request("respond_confirmation", { confirmation_id: confirmation.id, decision: "approve" });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    await t.client.request("save_model_catalog", { providers: touching, expected_revision: r0 });
  } finally {
    await cleanupManual(t);
  }
});

test("remove_model_provider：被会话引用时拒绝，切换后允许并清理凭据", async () => {
  const t = await startManual("model-config-remove", textResponder);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    // 新增 provider extra（目录 + auth.json 凭据）
    const providers = readModels(t.dirs).providers;
    providers.extra = {
      name: "Extra",
      baseUrl: t.baseUrl,
      apiKey: "extra-inline-key",
      api: "openai-completions",
      models: [{ id: "extra-model", contextWindow: 200000, maxTokens: 1024 }],
    };
    let r = (await t.client.request<any>("get_model_config", {})).revision;
    r = (await t.client.request<any>("save_model_catalog", { providers, expected_revision: r })).revision;
    r = (await t.client.request<any>("set_model_api_key", { provider: "extra", api_key: "extra-stored-key", expected_revision: r })).revision;
    // 会话切到 extra → 引用成立，删除被拒绝
    const session = await t.client.request<any>("get_session", { session_id: sessionId });
    await t.client.request("set_session_model", {
      session_id: sessionId,
      expected_version: session.modelSelectionVersion,
      model_selection: { provider: "extra", modelId: "extra-model", thinkingLevel: "off" },
    });
    await assert.rejects(
      t.client.request("remove_model_provider", { provider: "extra", expected_revision: r }),
      (err: any) => err.code === "provider_in_use" && err.message.includes("1 个会话"),
    );
    // 切回可用的其他 provider 后允许删除，并清理 models.json 与 auth.json
    const current = await t.client.request<any>("get_session", { session_id: sessionId });
    await t.client.request("set_session_model", {
      session_id: sessionId,
      expected_version: current.modelSelectionVersion,
      model_selection: MOCK_SELECTION,
    });
    const removed = await t.client.request<any>("remove_model_provider", { provider: "extra", expected_revision: r });
    assert.match(removed.revision, /^[0-9a-f]{64}$/);
    assert.ok(!("extra" in readModels(t.dirs).providers), "models.json 必须移除该 provider");
    const auth = JSON.parse(fs.readFileSync(path.join(t.dirs.agentDir, "auth.json"), "utf8"));
    assert.ok(!("extra" in auth), "auth.json 必须移除该 provider 的凭据");
    const listed = await t.client.request<any>("list_models", {});
    assert.ok(listed.models.every((m: any) => m.provider === "mock"));
    // 剩余 provider 继续可用（重建后的目录解析 + SDK 应用路径）
    const task = await submitMock(t.client, sessionId, "after-remove");
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
  } finally {
    await cleanupManual(t);
  }
});

test("save_model_catalog：经目录保存删除被引用的 provider/模型同样拒绝（§4 不留悬空引用）", async () => {
  const t = await startManual("model-catalog-remove-ref", textResponder);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const providers = readModels(t.dirs).providers;
    providers.extra = {
      name: "Extra",
      baseUrl: t.baseUrl,
      apiKey: "extra-inline-key",
      api: "openai-completions",
      models: [
        { id: "extra-model", contextWindow: 200000, maxTokens: 1024 },
        { id: "extra-model-2", contextWindow: 200000, maxTokens: 1024 },
      ],
    };
    let r = (await t.client.request<any>("get_model_config", {})).revision;
    r = (await t.client.request<any>("save_model_catalog", { providers, expected_revision: r })).revision;
    const session = await t.client.request<any>("get_session", { session_id: sessionId });
    await t.client.request("set_session_model", {
      session_id: sessionId,
      expected_version: session.modelSelectionVersion,
      model_selection: { provider: "extra", modelId: "extra-model-2", thinkingLevel: "off" },
    });
    // 目录保存删除整个 provider → 引用检查拒绝（与 remove_model_provider 同一约束）
    const withoutProvider = readModels(t.dirs).providers;
    delete withoutProvider.extra;
    await assert.rejects(
      t.client.request("save_model_catalog", { providers: withoutProvider, expected_revision: r }),
      (err: any) => err.code === "provider_in_use" && err.message.includes("extra"),
    );
    // 目录保存只删除被引用的模型 extra-model-2 → 同样拒绝
    const withoutModel = readModels(t.dirs).providers;
    withoutModel.extra = { ...withoutModel.extra, models: [{ id: "extra-model", contextWindow: 200000, maxTokens: 1024 }] };
    await assert.rejects(
      t.client.request("save_model_catalog", { providers: withoutModel, expected_revision: r }),
      (err: any) => err.code === "provider_in_use" && err.message.includes("extra/extra-model-2"),
    );
    // 文件未被改动（拒绝先于任何写入）
    assert.equal(readModels(t.dirs).providers.extra.models.length, 2, "被拒的保存不得改动 models.json");
    // 切走后目录保存删除成功
    const current = await t.client.request<any>("get_session", { session_id: sessionId });
    await t.client.request("set_session_model", {
      session_id: sessionId,
      expected_version: current.modelSelectionVersion,
      model_selection: MOCK_SELECTION,
    });
    const saved = await t.client.request<any>("save_model_catalog", { providers: withoutModel, expected_revision: r });
    assert.match(saved.revision, /^[0-9a-f]{64}$/);
    assert.equal(readModels(t.dirs).providers.extra.models.length, 1);
  } finally {
    await cleanupManual(t);
  }
});

test("set_default_model：持久化、新会话生效、旧会话不变、重启存活、显式启动参数优先", async () => {
  const t = await startManual("model-config-default", textResponder, { secondProvider: true });
  const sel = { provider: "second", modelId: "reasoner", thinkingLevel: "low" };
  try {
    const { sessionId: sessionA } = await createProjectSession(t.client, t.work[0]!);
    const r0 = (await t.client.request<any>("get_model_config", {})).revision;
    // 校验失败：未知模型 / 不支持的思考档位 / 过期修订
    await assert.rejects(
      t.client.request("set_default_model", { provider: "second", model_id: "nope", thinking_level: "low", expected_revision: r0 }),
      (err: any) => err.code === "invalid_params",
    );
    await assert.rejects(
      t.client.request("set_default_model", { provider: "mock", model_id: "mock-model", thinking_level: "high", expected_revision: r0 }),
      (err: any) => err.code === "invalid_params",
    );
    const set = await t.client.request<any>("set_default_model", {
      provider: sel.provider, model_id: sel.modelId, thinking_level: sel.thinkingLevel, expected_revision: r0,
    });
    assert.deepEqual(set.defaultModel, sel);
    await assert.rejects(
      t.client.request("set_default_model", { provider: sel.provider, model_id: sel.modelId, thinking_level: sel.thinkingLevel, expected_revision: r0 }),
      (err: any) => err.code === "config_conflict",
    );
    // 持久化文件 0600 且内容一致
    const file = path.join(t.dirs.agentDir, "default-model.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), sel);
    // 新会话用新默认；旧会话钉住的选择不变
    const { sessionId: sessionB } = await createProjectSession(t.client, t.work[1]!);
    assert.deepEqual((await t.client.request<any>("get_session", { session_id: sessionB })).modelSelection, sel);
    assert.deepEqual((await t.client.request<any>("get_session", { session_id: sessionA })).modelSelection, MOCK_SELECTION);

    // 重启：持久默认存活（含思考档位）
    await stopRt(t);
    Object.assign(t, await startRt(t.dirs));
    const view = await t.client.request<any>("get_model_config", {});
    assert.deepEqual(view.defaultModel, sel, "持久默认模型重启后存活");
    assert.deepEqual(view.runtimeDefault, sel, "重启后运行时默认取持久配置");
    assert.equal(t.runtime.modelInfo().thinkingLevel, "low", "界面展示的思考档位取生效默认");

    // 显式启动参数优先于持久默认
    await stopRt(t);
    Object.assign(t, await startRt(t.dirs, { modelProvider: "mock", modelId: "mock-model" }));
    const overridden = await t.client.request<any>("get_model_config", {});
    assert.deepEqual(overridden.runtimeDefault, MOCK_SELECTION, "显式 modelProvider/modelId 优先于 default-model.json");
    assert.deepEqual(overridden.defaultModel, sel, "持久文件不被改写");
    assert.deepEqual(overridden.runtimeOverrides, { model: true, thinking: false });
    // 显式启动参数运行期间在线改默认：只落盘，运行时默认不变（不会等到重建才翻转）
    const next = { provider: "second", modelId: "reasoner", thinkingLevel: "off" };
    await t.client.request("set_default_model", { provider: next.provider, model_id: next.modelId, thinking_level: next.thinkingLevel, expected_revision: overridden.revision });
    const pinned = await t.client.request<any>("get_model_config", {});
    assert.deepEqual(pinned.defaultModel, next);
    assert.deepEqual(pinned.runtimeDefault, MOCK_SELECTION, "显式启动参数仍优先");
    await stopRt(t);
    Object.assign(t, await startRt(t.dirs, { thinkingLevel: "off" }));
    const thinkingOnly = await t.client.request<any>("get_model_config", {});
    assert.deepEqual(thinkingOnly.runtimeDefault, next);
    assert.deepEqual(thinkingOnly.runtimeOverrides, { model: false, thinking: true }, "覆盖是否存在不能靠值比较推断");
  } finally {
    await cleanupManual(t);
  }
});

test("配置锁：同 agentDir 互斥、在线时离线写入被拒、停止后释放、遗留锁接管", async () => {
  const t = await startManual("model-config-lock", textResponder);
  const other = await makeTestDirs("model-config-lock-other", 0);
  try {
    // 第二个后台：不同 dataDir、同一 agentDir → 配置锁拒绝
    await assert.rejects(
      Runtime.start({
    product: personalProduct.runtime,
        dataDir: other.dirs.dataDir,
        agentDir: t.dirs.agentDir,
        socketPath: path.join(other.dirs.root, "c.sock"),
        toolFactory: (ctx) => createMockTools(ctx),
      }),
      (err: any) => err instanceof InstanceLockError && err.message.includes("配置锁"),
    );
    // 在线期间离线写入方拿不到配置锁
    assert.throws(() => acquireConfigLock(t.dirs.agentDir), (err: any) => err instanceof InstanceLockError);
    // 停止后释放
    await stopRt(t);
    const held = acquireConfigLock(t.dirs.agentDir);
    held.release();
    // 遗留锁：owner.json 记录的死 pid → 接管
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    const lockDir = path.join(t.dirs.agentDir, "config.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: dead.pid, command: "ruukoto-backend stale", startedAt: new Date().toISOString() }));
    const taken = acquireConfigLock(t.dirs.agentDir);
    taken.release();
  } finally {
    await stopRt(t);
    await t.server.close();
    await cleanupDirs(t.dirs);
    await cleanupDirs(other.dirs);
  }
});

test("test_model_connection：显式联网探测，未知 provider 与服务端错误报失败且不泄露秘密", async () => {
  let failing = false;
  const oauth = { type: "oauth", access: "oauth-error-access-secret", refresh: "oauth-error-refresh-secret", expires: 0 };
  const t = await startManual("model-config-conn", (req, i) => {
    if (failing) throw new Error(`upstream down ${oauth.access} ${oauth.refresh}`);
    return textResponder(req, i);
  });
  try {
    fs.writeFileSync(path.join(t.dirs.agentDir, "auth.json"), JSON.stringify({ "metadata-oauth": oauth }));
    const ok = await t.client.request<any>("test_model_connection", { provider: "mock", model_id: "mock-model" });
    assert.equal(ok.ok, true, ok.detail);
    const unknownProvider = await t.client.request<any>("test_model_connection", { provider: "nope", model_id: "x" });
    assert.equal(unknownProvider.ok, false);
    assert.ok(unknownProvider.detail.length > 0);
    assert.ok(!JSON.stringify(unknownProvider).includes("mock-key"), "错误详情不得包含秘密");
    const unknownModel = await t.client.request<any>("test_model_connection", { provider: "mock", model_id: "nope" });
    assert.equal(unknownModel.ok, false);
    // 服务端返回错误：completeSimple 以 stopReason=error 返回而非 reject，仍须报失败
    failing = true;
    const down = await t.client.request<any>("test_model_connection", { provider: "mock", model_id: "mock-model" });
    assert.equal(down.ok, false, down.detail);
    assert.ok(!down.detail.includes("mock-key"), "错误详情不得包含秘密");
    assert.ok(down.detail.includes("***"), "真实 provider 错误中的 OAuth token 应脱敏");
    assert.ok(!down.detail.includes(oauth.access));
    assert.ok(!down.detail.includes(oauth.refresh));
  } finally {
    await cleanupManual(t);
  }
});

test("回滚：通过本地校验但 SDK 重建失败 → 文件恢复旧字节、旧目录继续可用", async () => {
  const t = await startManual("model-config-rollback", textResponder);
  try {
    const bytesBefore = fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8");
    const r0 = (await t.client.request<any>("get_model_config", {})).revision;
    // 缺 api（provider 与模型都没有）：本地结构校验通过，SDK 组合失败
    // leak：新增 provider 的内联 key 出现在错误文本里（模型 id 与 key 相同），回滚前必须先脱敏
    const broken = {
      leak: { baseUrl: t.baseUrl, apiKey: "sk-LEAK-9f3a", models: [{ id: "sk-LEAK-9f3a" }] },
      mock: { baseUrl: t.baseUrl, models: [{ id: "mock-model", contextWindow: 200000, maxTokens: 1024 }] },
    };
    const failure = await t.client.request<any>("save_model_catalog", { providers: broken, expected_revision: r0 }).then(
      () => null,
      (err: any) => err,
    );
    assert.equal(failure?.code, "model_config_invalid");
    assert.ok(!String(failure?.message).includes("sk-LEAK-9f3a"), `错误文本不得包含新写入的秘密：${failure?.message}`);
    assert.equal(fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8"), bytesBefore, "失败必须恢复旧字节");
    assert.equal((await t.client.request<any>("get_model_config", {})).revision, r0, "回滚后修订不变");
    // 旧目录继续可用
    const listed = await t.client.request<any>("list_models", {});
    assert.ok(listed.models.some((m: any) => m.provider === "mock" && m.modelId === "mock-model"));
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await submitMock(t.client, sessionId, "after-rollback");
    await waitFor("回滚后任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
  } finally {
    await cleanupManual(t);
  }
});

test("set_session_model 与删除 provider 竞态：resolve 期间应用已完成则拒绝，不留悬空引用", async () => {
  const t = await startManual("model-config-race", textResponder, { secondProvider: true });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const session = await t.client.request<any>("get_session", { session_id: sessionId });
    // 压住 set_session_model 的目录解析，让删除 provider 在其间整体完成
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const resolving = new Promise<void>((resolve) => (entered = resolve));
    const catalog = (t.runtime as any).modelCatalog;
    const origResolve = catalog.resolve.bind(catalog);
    catalog.resolve = async (sel: any) => {
      const model = await origResolve(sel);
      entered();
      await held;
      return model;
    };
    const pending = t.client.request("set_session_model", {
      session_id: sessionId,
      expected_version: session.modelSelectionVersion,
      model_selection: { provider: "second", modelId: "reasoner", thinkingLevel: "off" },
    }).then(() => null, (err: any) => err);
    await resolving;
    const r = (await t.client.request<any>("get_model_config", {})).revision;
    await t.client.request("remove_model_provider", { provider: "second", expected_revision: r });
    release();
    assert.equal((await pending)?.code, "model_config_busy", "目录已重建：必须拒绝按旧目录核实的写入");
    const after = await t.client.request<any>("get_session", { session_id: sessionId });
    assert.deepEqual(after.modelSelection, MOCK_SELECTION, "会话不得指向已删除的 provider");
  } finally {
    await cleanupManual(t);
  }
});

test("门闩窗口：应用期间受影响 provider 的提交与并发应用被拒绝", async () => {
  const t = await startManual("model-config-busy", textResponder);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    // 经测试钩子压住应用窗口（fn 延迟 400ms，重建在窗口内完成）
    const applyPromise = (t.runtime as any).applyModelConfigChange(["mock"], async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }) as Promise<void>;
    await waitFor("门闩生效", () => (t.runtime as any).modelConfigGate !== null);
    await assert.rejects(
      submitMock(t.client, sessionId, "busy-submit"),
      (err: any) => err.code === "model_config_busy",
    );
    // 内部提交（编排器/QQ 桥）不失败：等本次应用结束后按同一请求键重试
    let internalDone = false;
    const internal = ((t.runtime as any).submitInternal({ sessionId, requestId: "busy-internal", input: "ping", modelSelection: MOCK_SELECTION }) as Promise<any>)
      .then((task) => ((internalDone = true), task));
    const view = await t.client.request<any>("get_model_config", {});
    assert.deepEqual(view.busyProviders, ["mock"]);
    await assert.rejects(
      t.client.request("set_model_api_key", { provider: "mock", api_key: "k", expected_revision: view.revision }),
      (err: any) => err.code === "model_config_busy",
      "并发应用必须单-flight",
    );
    assert.equal(internalDone, false, "应用窗口内内部提交应等待");
    await applyPromise;
    const internalTask = await internal;
    await waitFor("内部提交任务完成", async () => (await taskStatus(t.client, internalTask.id)).task.status === "completed");
    assert.deepEqual((await t.client.request<any>("get_model_config", {})).busyProviders, []);
    const task = await submitMock(t.client, sessionId, "after-busy");
    await waitFor("门闩释放后任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
  } finally {
    await cleanupManual(t);
  }
});
