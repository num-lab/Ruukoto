import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, defineTask, SessionFailed, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, PersonalFormatDoc, PERSONAL_PROMPT, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { parsePersonalModel, personalProvider, recordedModels, type PersonalModelConfig, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { lockPersonalProfile, PERSONAL_FORMAT, personalDirectory } from "../apps/ruukoto/src/personal-profile.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;

function directory(t: TestContext) {
  const value = fs.mkdtempSync(path.join(tmpdir(), "ruukoto-durable-test-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

async function fixture(t: TestContext, respond: Responder = () => ({ kind: "text", text: "已收到" })) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ruukoto-durable-test-"));
  const server = new MockModelServer(respond);
  const baseUrl = await server.start();
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl, modelId: "mock-model", apiKeyEnv: "RUUKOTO_DURABLE_TEST_KEY", contextWindow: 128000, maxTokens: 1024 };
  const previous = process.env[config.apiKeyEnv];
  process.env[config.apiKeyEnv] = "test-only";
  let current: PersonalHarness | undefined;
  t.after(async () => {
    await current?.close();
    await server.close();
    if (previous === undefined) delete process.env[config.apiKeyEnv];
    else process.env[config.apiKeyEnv] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const options = { directory: dir, provider: personalProvider(config), modelId: config.modelId };
  return { dir, server, config, options, open: async () => current = await openPersonalHarness(options) };
}

const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "等待持久输入或模型请求超时");
    await delay(5);
  }
}

test("durable：个人与 Coding 分别解析 Pi 1.3.0 / 0.85.1", () => {
  for (const [app, expected] of [["ruukoto", "1.3.0"], ["ruukoto-code", "0.85.1"]] as const) {
    const version = execFileSync(process.execPath, ["--input-type=module", "--eval", 'import {readFileSync} from "node:fs"; const entry = import.meta.resolve("@earendil-works/pi-ai"); process.stdout.write(JSON.parse(readFileSync(new URL("../package.json", entry), "utf8")).version);'], { cwd: new URL(`../apps/${app}`, import.meta.url), encoding: "utf8" });
    assert.equal(version, expected);
  }
  assert.equal(JSON.parse(fs.readFileSync(new URL("../node_modules/@earendil-works/pi-durable/package.json", import.meta.url), "utf8")).version, "1.3.0");
  assert.equal(JSON.parse(fs.readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version, "0.85.1");
});

test("durable：拒绝旧资料目录和链接，不修改原文件", t => {
  const dir = directory(t);
  const original = Buffer.from("旧档案保持原样");
  fs.writeFileSync(path.join(dir, "ruukoto.sqlite"), original);
  assert.throws(() => lockPersonalProfile(dir), code("profile_unrecognized"));
  assert.deepEqual(fs.readdirSync(dir), ["ruukoto.sqlite"]);
  assert.deepEqual(fs.readFileSync(path.join(dir, "ruukoto.sqlite")), original);
  const linked = directory(t);
  fs.symlinkSync(path.join(dir, "ruukoto.sqlite"), path.join(linked, "personal.sqlite"));
  assert.throws(() => lockPersonalProfile(linked), code("profile_unrecognized"));
  assert.deepEqual(fs.readFileSync(path.join(dir, "ruukoto.sqlite")), original);
});

test("durable：实例锁真实互斥，释放后可重开，档案仅拥有者可读", t => {
  const dir = directory(t);
  const first = lockPersonalProfile(dir);
  try {
    assert.throws(() => lockPersonalProfile(dir), code("profile_busy"));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, "profile.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, "owner.sqlite")).mode & 0o777, 0o600);
  } finally { first.release(); }
  lockPersonalProfile(dir).release();
});

test("durable：档案格式或 Pi 版本不符时拒绝，拒绝后不遗留锁", t => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ ...PERSONAL_FORMAT, pi: "9.0.0" }));
  assert.throws(() => lockPersonalProfile(dir), code("profile_version"));
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(PERSONAL_FORMAT));
  lockPersonalProfile(dir).release();
});

test("durable：输入与回答落盘，同键重投去重，重开后保留历史和请求证据", async t => {
  const f = await fixture(t);
  const first = await f.open();
  assert.equal(await first.answer("记住测试信息", "input-1"), "已收到");
  const submission = await first.submit("记住测试信息", "input-1");
  assert.equal((await submission.status(context)).status, "done");
  assert.equal(f.server.calls.length, 1);
  const conversationId = first.main.id;
  await first.close();
  const next = await f.open();
  assert.equal(next.main.id, conversationId);
  assert.equal(await next.answer("继续测试", "input-2"), "已收到");
  assert.equal(f.server.calls.length, 2);
  assert.match(JSON.stringify(f.server.calls[1].messages), /记住测试信息/);
  assert.match(JSON.stringify(f.server.calls[1].messages), /已收到/);
  const entries = (await next.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  const evidence = entries.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data as RequestEvidence);
  assert.equal(evidence.length, 4);
  for (let i = 0; i < f.server.calls.length; i++) {
    assert.equal(evidence[i * 2].requestId, evidence[i * 2 + 1].requestId);
    assert.deepEqual(evidence[i * 2 + 1].payload, f.server.calls[i].raw);
  }
  assert.match(JSON.stringify(evidence[0].input), new RegExp(PERSONAL_PROMPT));
  assert.equal(fs.statSync(path.join(f.dir, "personal.sqlite")).mode & 0o777, 0o600);
});

test("durable：缺扩展时在任何恢复请求前拒绝", async t => {
  const f = await fixture(t);
  const personal = await f.open();
  await personal.harness.commit(async tx => { (await tx.doc(AgentDoc, personal.main.id)).extensions = ["missing-extension"]; }, context);
  await personal.close();
  await assert.rejects(f.open(), code("extension_missing"));
  assert.equal(f.server.calls.length, 0);
  lockPersonalProfile(f.dir).release();
});

test("durable：业务扩展版本不符时拒绝恢复", async t => {
  const f = await fixture(t);
  const personal = await f.open();
  await personal.harness.commit(async tx => { Object.assign(await tx.doc(PersonalFormatDoc), { extensions: { personal: 3 } }); }, context);
  await personal.close();
  await assert.rejects(f.open(), code("extension_version"));
  assert.equal(f.server.calls.length, 0);
});

test("durable：业务 document 定义版本不符时拒绝恢复", async t => {
  const f = await fixture(t);
  const personal = await f.open();
  await personal.close();
  const storage = await openNodeSqliteStorage(path.join(f.dir, "personal.sqlite"));
  const record = await storage.findDocument({ kind: PersonalFormatDoc.definition.kind, scope: { kind: "session" } }, "current", context);
  await storage.commit([{ type: "document.change", id: record!.id, content: { kind: "base", version: 2, value: { ...PERSONAL_FORMAT } } }], context);
  await storage.close(context);
  await assert.rejects(f.open(), code("extension_version"));
  assert.equal(f.server.calls.length, 0);
});

test("durable：缺失或不支持的任务定义不启动恢复", async t => {
  for (const [name, version] of [["missing-task", 1], ["pi.generation", 2]] as const) await t.test(`${name} / ${version}`, async t => {
    const f = await fixture(t);
    const personal = await f.open();
    const unknown = defineTask({ name, version, initial: () => ({ phase: "wait" }), phases: {}, abort: async () => {} });
    await personal.main.commit(tx => tx.createTask(unknown, null, { ownership: { kind: "conversation" } }), context);
    await personal.close();
    await assert.rejects(f.open(), code("task_version"));
    assert.equal(f.server.calls.length, 0);
  });
});

test("durable：空闲主会话显式切换模型", async t => {
  const f = await fixture(t);
  const personal = await f.open();
  await personal.close();
  f.options.modelId = "another-model";
  f.options.provider = personalProvider({ ...f.config, modelId: f.options.modelId });
  const next = await f.open();
  assert.equal((await next.main.agent(context)).model?.modelId, "another-model");
});

// Note: 见 .agents/notes/implemented/testing/2026-10-11-await-observed-async-phases.md
test("durable：模型流中途强杀后恢复原输入，进程锁释放且不重复受理", { timeout: 15000 }, async t => {
  const cleanupChildren: (() => Promise<unknown>)[] = [];
  t.after(async () => { for (const close of cleanupChildren) await close(); });
  const f = await fixture(t, (_request, index) => index === 0 ? { kind: "text", text: "未完成流".repeat(50), chunkDelayMs: 30 } : { kind: "text", text: "恢复完成" });
  function launch(script: string) {
    t.signal.throwIfAborted();
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_DURABLE_TEST_OPTIONS: JSON.stringify({ directory: f.dir, config: f.config }) }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "", failure: Error | undefined;
    child.stderr!.on("data", data => { stderr = (stderr + String(data)).slice(-2048); });
    child.stderr!.pipe(process.stderr);
    child.on("error", error => { failure = error; });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once("close", (code, signal) => resolve([code, signal])));
    const phase = (expected: string, timeout: number) => new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.off("message", message); child.off("error", failed); child.off("exit", exited);
        if (error) reject(error); else resolve();
      };
      const message = (value: unknown) => { if (value === expected) finish(); };
      const failed = (error: Error) => finish(new Error(`子进程在 ${expected} 前启动失败：${error.message} ${stderr}`, { cause: error }));
      const exited = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`子进程在 ${expected} 前退出：${code ?? signal} ${stderr}`));
      const timer = setTimeout(() => finish(new Error(`子进程等待 ${expected} 超时：${stderr}`)), timeout);
      child.on("message", message); child.once("error", failed); child.once("exit", exited);
      if (failure) failed(failure);
      else if (child.exitCode !== null || child.signalCode !== null) exited(child.exitCode, child.signalCode);
    });
    const close = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      return await closed;
    };
    cleanupChildren.push(close);
    return { child, phase, close, errors: () => stderr };
  }
  const early = launch('process.stderr.write("fixture-exit"); process.exit(23);');
  try { await assert.rejects(early.phase("ready", 5000), /ready 前退出：23/); } finally { await early.close(); }
  assert.match(early.errors(), /fixture-exit/);
  const silent = launch('process.send("probe-started"); setInterval(() => {}, 1000);');
  try {
    await silent.phase("probe-started", 5000);
    await assert.rejects(silent.phase("ready", 25), /等待 ready 超时/);
  } finally { await silent.close(); }
  const script = `
    import { openPersonalHarness } from "./apps/ruukoto/src/personal-harness.ts";
    import { personalProvider } from "./apps/ruukoto/src/personal-model.ts";
    import { LiveDoc } from "@earendil-works/pi-durable";
    import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
    const start = new Promise(resolve => process.once("message", message => {
      if (message !== "start") throw new Error("崩溃夹具收到未知启动信号");
      resolve();
    }));
    process.send("ready");
    await start;
    const { directory, config } = JSON.parse(process.env.RUUKOTO_DURABLE_TEST_OPTIONS);
    const personal = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId });
    await personal.submit("崩溃前输入", "crash-input");
    for (;;) {
      const live = await personal.harness.snapshot(LiveDoc, personal.main.id, BACKGROUND_CONTEXT);
      if (live?.generation?.message?.content?.some(part => part.type === "text" && part.text.length > 0)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    process.send("persisted-partial");
    setInterval(() => {}, 1000);
  `;
  const running = launch(script);
  try {
    await running.phase("ready", 10_000);
    const partial = running.phase("persisted-partial", 5000);
    const sent = new Promise<void>((resolve, reject) => running.child.send("start", error => error ? reject(error) : resolve()));
    await Promise.all([partial, sent]);
    assert.equal(f.server.calls.length, 1);
    await assert.rejects(f.open(), code("profile_busy"));
    assert.deepEqual(await running.close(), [null, "SIGKILL"]);
    const restored = await f.open();
    assert.equal(await restored.answer("崩溃前输入", "crash-input"), "恢复完成");
    assert.equal(f.server.calls.length, 2);
    const entries = (await restored.main.entries({}, 256, undefined, context)).items;
    assert.equal(entries.filter(entry => entry.kind === "pi.user").length, 1);
    assert.equal(entries.filter(entry => entry.kind === "pi.assistant" && entry.model?.some(message => message.role === "assistant" && message.stopReason === "stop")).length, 1);
    assert.ok(entries.some(entry => entry.kind === "pi.assistant" && entry.model?.some(message => message.role === "assistant" && message.stopReason === "aborted" && message.content.some(part => part.type === "text" && part.text.length > 0))));
  } finally { await running.close(); }
});

test("durable：未完成输入仍引用旧模型时拒绝换模型恢复", async t => {
  const f = await fixture(t, () => ({ kind: "text", text: "尚未完整返回".repeat(30), chunkDelayMs: 30 }));
  const personal = await f.open();
  await personal.submit("等待回复", "pending-model");
  await waitFor(() => f.server.calls.length === 1);
  await personal.close();
  f.options.modelId = "another-model";
  f.options.provider = personalProvider({ ...f.config, modelId: f.options.modelId });
  await assert.rejects(f.open(), code("model_changed_pending"));
  assert.equal(f.server.calls.length, 1);
});

test("durable：三种 API 的输入或实际 payload 记录失败时 HTTP 请求为零", async t => {
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    for (const failAt of [1, 2]) await t.test(`${api} / 记录 ${failAt}`, async t => {
      const f = await fixture(t);
      let count = 0;
      const models = recordedModels(personalProvider({ ...f.config, api }), async () => {
        if (++count === failAt) throw new Error("evidence-write-failed");
      });
      const message = await models.streamSimple(models.getModel("personal", f.config.modelId)!, { messages: [{ role: "user", content: "测试", timestamp: 1 }] }, { sessionId: "test-session" }).result();
      assert.equal(message.stopReason, "error");
      assert.match(message.errorMessage!, /evidence-write-failed/);
      assert.equal(count, failAt);
      assert.equal(f.server.calls.length, 0);
    });
  }
});

test("durable：保留 onPayload 改写且记录真正发出的内容", async t => {
  const f = await fixture(t);
  const evidence: RequestEvidence[] = [];
  const models = recordedModels(f.options.provider, async value => { evidence.push(value); });
  const result = await models.streamSimple(models.getModel("personal", f.config.modelId)!, { messages: [{ role: "user", content: "测试", timestamp: 1 }] }, {
    sessionId: "test-session", onPayload: payload => ({ ...payload as object, temperature: 0.25 }),
  }).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(f.server.calls[0].raw.temperature, 0.25);
  assert.deepEqual(evidence[1].payload, f.server.calls[0].raw);
});

test("durable：初始化拒绝且存储关闭失败，原错误可见并释放锁", async t => {
  const f = await fixture(t);
  const initial = await f.open();
  await initial.harness.commit(async tx => { Object.assign(await tx.doc(PersonalFormatDoc), { extensions: { personal: 3 } }); }, context);
  await initial.close();
  const openStorage = async (filename: string): Promise<Storage> => {
    const storage = await openNodeSqliteStorage(filename);
    return new Proxy(storage, { get(target, property) {
      if (property === "close") return async () => { await target.close(context); throw new Error("storage-close-failed"); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  await assert.rejects(openPersonalHarness({ ...f.options, openStorage }), code("extension_version"));
  lockPersonalProfile(f.dir).release();
});

test("durable：真实持久记录写失败关闭 Harness，阻止 HTTP 且释放实例锁", async t => {
  for (const failAt of [1, 2]) await t.test(`记录 ${failAt}`, async t => {
    const f = await fixture(t);
    const cause = new Error("storage-evidence-failed");
    let count = 0;
    const openStorage = async (filename: string) => {
      const storage = await openNodeSqliteStorage(filename);
      const commit = storage.commit.bind(storage);
      storage.commit = (writes, context) => {
        if (writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.model-request") && ++count === failAt) return Promise.reject(cause);
        return commit(writes, context);
      };
      return storage;
    };
    const personal = await openPersonalHarness({ ...f.options, openStorage });
    await assert.rejects(personal.answer("停止请求", "failed-evidence"), error => error === cause || error instanceof SessionFailed);
    assert.equal((await personal.harness.closed).reason, "failed");
    assert.equal(count, failAt);
    assert.equal(f.server.calls.length, 0);
    lockPersonalProfile(f.dir).release();
  });
});

test("durable：模型配置验证不接受带凭据 URL、非法 API 与过量输出", () => {
  const valid = { api: "openai-completions", baseUrl: "https://example.com/v1", modelId: "test", apiKeyEnv: "MODEL_KEY", contextWindow: 64000, maxTokens: 1024 };
  assert.deepEqual(parsePersonalModel(valid), valid);
  for (const changed of [{ api: {} }, { baseUrl: "http://example.com" }, { baseUrl: "https://user:secret@example.com" }, { maxTokens: 64000 }, { apiKeyEnv: "key-value" }]) {
    assert.throws(() => parsePersonalModel({ ...valid, ...changed }), code("model_config_invalid"));
  }
  assert.notEqual(personalDirectory(), path.resolve(process.env.RUUKOTO_DATA_DIR ?? ".ruukoto"));
});
