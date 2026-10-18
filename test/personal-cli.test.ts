import { managePersonalAppData } from "../apps/ruukoto/src/personal-app-data-controls.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { personalDevDirectory, readPersonalConfig, savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { LocalInputDoc, parsePersonalInput, personalControl, readPersonalToken, startPersonalServer, type PersonalInputStatus, type PersonalMessage, type PersonalStatus } from "../apps/ruukoto/src/personal-control.ts";
import { checkPersonalInput, configurePersonalServices, managePersonalInspections, managePersonalServices, managePersonalCommands, launchPersonalServer, pendingPersonalInputs, personalChildEnv, personalMenu, preparePersonalInput } from "../apps/ruukoto/src/personal-cli.ts";
import { parsePersonalServices, readPersonalServices, savePersonalServices } from "../apps/ruukoto/src/personal-service-config.ts";
import { PersonalServiceDoc } from "../apps/ruukoto/src/personal-services.ts";
import { PersonalServiceGrantsDoc, PersonalServiceOperationsDoc } from "../apps/ruukoto/src/personal-service-operations.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const directory = (t: TestContext) => {
  // Darwin 的 os.tmpdir 可能使 Unix socket 路径超过内核上限。
  const dir = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await check())) { assert.ok(Date.now() < deadline, "等待隔离后台超时"); await delay(20); }
}
async function fixture(t: TestContext, respond: Responder = () => ({ kind: "text", text: "隔离回答" })) {
  const dir = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-cli-"));
  const model = new MockModelServer(respond);
  const baseUrl = await model.start();
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl, modelId: "mock-model", apiKeyEnv: "RUUKOTO_DURABLE_CLI_KEY", contextWindow: 128000, maxTokens: 1024 };
  const old = process.env[config.apiKeyEnv];
  process.env[config.apiKeyEnv] = "test-only";
  savePersonalConfig(dir, config);
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  t.after(async () => {
    await server?.stop();
    if (!server && fs.existsSync(path.join(dir, "control.sock"))) {
      await personalControl(dir, "POST", "/stop");
      await until(() => { try { const lock = lockPersonalProfile(dir); lock.release(); return true; } catch (error) { if (code("profile_busy")(error)) return false; throw error; } });
    }
    await model.close();
    if (old === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, config, model, start: async () => server = await startPersonalServer(dir) };
}

async function raw(directory: string, method: string, route: string, body?: string, token = "wrong") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ socketPath: path.join(directory, "control.sock"), method, path: route, headers: { authorization: `Bearer ${token}` } }, res => {
      let result = "";
      res.on("data", chunk => { result += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: result }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("personal CLI：独立开发档案按真实检出隔离，子进程不继承旧产品配置", t => {
  const dir = directory(t);
  const linked = path.join(dir, "alias");
  fs.symlinkSync(process.cwd(), linked);
  assert.equal(personalDevDirectory(linked, dir), personalDevDirectory(process.cwd(), dir));
  assert.notEqual(personalDevDirectory(dir, dir), personalDevDirectory(process.cwd(), dir));
  assert.match(personalDevDirectory(dir, dir), /\.ruukoto-durable-dev/);
  const env = personalChildEnv(dir, "RUUKOTO_DURABLE_CLI_KEY", { RUUKOTO_DATA_DIR: "old", RUUKOTO_OWNER_TOKEN: "secret", RUUKOTO_SERVICE_HELPER: "old-helper", RUUKOTO_CODE_DATA_DIR: "code", RUUKOTO_DESKTOP_TARGET: "old", RUUKOTO_DURABLE_CLI_KEY: "model-key", PATH: "path" });
  assert.deepEqual(env, { RUUKOTO_DURABLE_CLI_KEY: "model-key", RUUKOTO_PERSONAL_DIR: dir, PATH: "path" });
});

test("personal CLI：配置持锁、拒绝在线修改，非法配置不覆盖原文件", async t => {
  const f = await fixture(t);
  const original = fs.readFileSync(path.join(f.dir, "model.json"));
  assert.throws(() => savePersonalConfig(f.dir, { ...f.config, baseUrl: "http://unsafe.invalid" }), code("model_config_invalid"));
  assert.deepEqual(fs.readFileSync(path.join(f.dir, "model.json")), original);
  const profile = lockPersonalProfile(f.dir);
  assert.deepEqual(readPersonalConfig(profile), f.config);
  profile.release();
  await f.start();
  assert.throws(() => savePersonalConfig(f.dir, f.config), code("profile_busy"));
  assert.deepEqual(fs.readFileSync(path.join(f.dir, "model.json")), original);
  assert.equal(fs.statSync(path.join(f.dir, "model.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.dir, "control.sock")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.dir, "control.token")).mode & 0o777, 0o600);
});

test("personal CLI：前台与 detached 均拒绝用内部环境变量充当模型凭据", async t => {
  const f = await fixture(t);
  for (const apiKeyEnv of ["RUUKOTO_OWNER_TOKEN", "RUUKOTO_OWNER_TOKEN_FILE", "RUUKOTO_SERVICE_HELPER", "RUUKOTO_PERSONAL_DIR", "RUUKOTO_CODE_DATA_DIR", "RUUKOTO_DESKTOP_TARGET", "RUUKOTO_PRODUCT"]) {
    const invalid = { ...f.config, apiKeyEnv };
    assert.throws(() => savePersonalConfig(f.dir, invalid), code("model_credentials_invalid"));
    fs.writeFileSync(path.join(f.dir, "model.json"), JSON.stringify(invalid));
    await assert.rejects(startPersonalServer(f.dir), code("model_credentials_invalid"));
    await assert.rejects(launchPersonalServer(f.dir), code("model_credentials_invalid"));
    lockPersonalProfile(f.dir).release();
  }
  assert.equal(f.model.calls.length, 0);
});

test("personal CLI：认证前不读状态或提交，非法及超限请求无副作用", async t => {
  const f = await fixture(t);
  await f.start();
  for (const route of ["/status", "/messages", "/inputs", "/stop", "/services", "/service?service=1", "/service/resolve?service=1", "/service/stop?service=1", "/service/decide?service=1", "/commands", "/command?command=1", "/command/resolve?command=1", "/command/stop?command=1"]) {
    const result = await raw(f.dir, route === "/inputs" || route === "/stop" || route.startsWith("/service/") ? "POST" : "GET", route, JSON.stringify({ requestId: randomUUID(), input: "不要执行" }));
    assert.equal(JSON.parse(result.body).code, "control_unauthorized");
    assert.doesNotMatch(result.body, /mock-model|test-only/);
  }
  const token = readPersonalToken(f.dir);
  assert.equal(JSON.parse((await raw(f.dir, "POST", "/inputs", "not-json", token)).body).code, "control_request_invalid");
  assert.equal(JSON.parse((await raw(f.dir, "POST", "/inputs", "x".repeat(130 * 1024), token)).body).code, "control_request_large");
  assert.equal((await personalControl<PersonalStatus>(f.dir, "GET", "/status")).inputs, 0);
  assert.equal(f.model.calls.length, 0);
  assert.throws(() => parsePersonalInput({ requestId: randomUUID(), input: "x".repeat(16385) }), code("input_invalid"));
});

test("personal CLI：同键去重与异参拒绝，断开后完成并可重开查询", async t => {
  const f = await fixture(t);
  const first = await f.start();
  const input = preparePersonalInput(f.dir, "记住此消息");
  await personalControl(f.dir, "POST", "/inputs", input);
  await personalControl(f.dir, "POST", "/inputs", input);
  await assert.rejects(personalControl(f.dir, "POST", "/inputs", { ...input, input: "不同正文" }), code("input_conflict"));
  const surrogate = preparePersonalInput(f.dir, "\ud800");
  await personalControl(f.dir, "POST", "/inputs", surrogate);
  await assert.rejects(personalControl(f.dir, "POST", "/inputs", { ...surrogate, input: "\ud801" }), code("input_conflict"));
  await until(async () => (await personalControl<PersonalInputStatus>(f.dir, "GET", `/input?requestId=${input.requestId}`)).status === "done");
  await until(async () => (await personalControl<PersonalInputStatus>(f.dir, "GET", `/input?requestId=${surrogate.requestId}`)).status === "done");
  assert.equal(f.model.calls.length, 2);
  await checkPersonalInput(f.dir, surrogate);
  await first.stop();
  await f.start();
  const result = await checkPersonalInput(f.dir, input);
  assert.equal(result.answer, "隔离回答");
  assert.equal(pendingPersonalInputs(f.dir).length, 0);
  const history = await personalControl<PersonalMessage[]>(f.dir, "GET", "/messages");
  assert.deepEqual(history.map(message => message.text), ["记住此消息", "隔离回答", "\ud800", "隔离回答"]);
});

test("personal CLI：多向导逐键保留请求，未受理只核实且指纹提前提交可恢复", async t => {
  const f = await fixture(t);
  const one = preparePersonalInput(f.dir, "第一条");
  const two = preparePersonalInput(f.dir, "第二条");
  const personal = await openPersonalHarness({ directory: f.dir, provider: personalProvider(f.config), modelId: f.config.modelId });
  await personal.harness.commit(tx => tx.doc(LocalInputDoc, one.requestId, createHash("sha256").update(JSON.stringify(one.input)).digest("hex")), context);
  await personal.close();
  savePersonalConfig(f.dir, f.config);
  await f.start();
  assert.equal((await checkPersonalInput(f.dir, one)).status, "missing");
  assert.equal(f.model.calls.length, 0);
  assert.equal(pendingPersonalInputs(f.dir).length, 2);
  await assert.rejects(personalControl(f.dir, "POST", "/inputs", { ...one, input: "替换正文" }), code("input_conflict"));
  await personalControl(f.dir, "POST", "/inputs", one);
  await checkPersonalInput(f.dir, one);
  assert.deepEqual(pendingPersonalInputs(f.dir), [two]);
});

test("personal CLI：提交后应答丢失保留原键，核实后不重发", async t => {
  const f = await fixture(t);
  await f.start();
  const input = preparePersonalInput(f.dir, "丢失应答的消息");
  const proxyDir = directory(t);
  fs.writeFileSync(path.join(proxyDir, "control.token"), "a".repeat(64));
  const proxy = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    await personalControl(f.dir, "POST", "/inputs", input);
    res.destroy();
  });
  proxy.listen(path.join(proxyDir, "control.sock"));
  await once(proxy, "listening");
  try {
    await assert.rejects(personalControl(proxyDir, "POST", "/inputs", input), code("control_response_lost"));
    assert.deepEqual(pendingPersonalInputs(f.dir), [input]);
    assert.notEqual((await checkPersonalInput(f.dir, input)).status, "missing");
    await until(async () => (await personalControl<PersonalInputStatus>(f.dir, "GET", `/input?requestId=${input.requestId}`)).status === "done");
    assert.equal(f.model.calls.length, 1);
    assert.deepEqual(pendingPersonalInputs(f.dir), []);
  } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

test("personal CLI：存储故障先关闭 listener 再放锁，旧清理不会删除新实例 socket", async t => {
  const f = await fixture(t);
  const first = await f.start();
  const db = new DatabaseSync(path.join(f.dir, "personal.sqlite"));
  db.exec("CREATE TRIGGER reject_evidence BEFORE INSERT ON entries WHEN json_extract(NEW.record, '$.kind') = 'ruukoto.model-request' BEGIN SELECT RAISE(FAIL, 'private-sentinel'); END");
  const input = preparePersonalInput(f.dir, "存储失败");
  try {
    try { await personalControl(f.dir, "POST", "/inputs", input); } catch (error) {
      assert.ok(error instanceof PersonalError);
      assert.doesNotMatch(error.message, /private-sentinel/);
    }
    assert.equal((await first.closed).reason, "failed");
    await until(() => { try { const lock = lockPersonalProfile(f.dir); lock.release(); return true; } catch (error) { if (code("profile_busy")(error)) return false; throw error; } });
    assert.equal(f.model.calls.length, 0);
    assert.equal(fs.existsSync(path.join(f.dir, "control.sock")), false);
    db.exec("DROP TRIGGER reject_evidence");
    await f.start();
    const inode = fs.statSync(path.join(f.dir, "control.sock")).ino;
    await first.stop();
    assert.equal(fs.statSync(path.join(f.dir, "control.sock")).ino, inode);
    assert.equal((await personalControl<PersonalStatus>(f.dir, "GET", "/status")).model, "mock-model");
  } finally { db.close(); }
});

test("personal CLI：坏配置、坏令牌、链接文件及旧目录拒绝，失败后可重新持锁", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dir, "control.token"), "bad-token");
  await assert.rejects(f.start(), code("control_token_invalid"));
  assert.equal(fs.readFileSync(path.join(f.dir, "control.token"), "utf8"), "bad-token");
  lockPersonalProfile(f.dir).release();
  fs.rmSync(path.join(f.dir, "control.token"));
  fs.writeFileSync(path.join(f.dir, "model.json"), "broken");
  await assert.rejects(f.start(), code("model_config_unavailable"));
  lockPersonalProfile(f.dir).release();
  fs.rmSync(path.join(f.dir, "model.json"));
  fs.symlinkSync(path.join(f.dir, "profile.json"), path.join(f.dir, "model.json"));
  assert.throws(() => savePersonalConfig(f.dir, f.config), code("profile_unrecognized"));
  const old = directory(t);
  fs.writeFileSync(path.join(old, "ruukoto.sqlite"), "old");
  await assert.rejects(startPersonalServer(old), code("profile_unrecognized"));
  assert.deepEqual(fs.readdirSync(old), ["ruukoto.sqlite"]);
  const alias = path.join(directory(t), "alias");
  fs.symlinkSync(f.dir, alias);
  assert.throws(() => lockPersonalProfile(alias), code("profile_unrecognized"));
  assert.equal(f.model.calls.length, 0);
});

test("personal CLI：真实后台进程退出客户端仍继续，重复启动不删原 socket，停止后可重启", async t => {
  const f = await fixture(t);
  await launchPersonalServer(f.dir);
  const socket = fs.statSync(path.join(f.dir, "control.sock")).ino;
  await assert.rejects(launchPersonalServer(f.dir), code("profile_busy"));
  assert.equal(fs.statSync(path.join(f.dir, "control.sock")).ino, socket);
  const input = preparePersonalInput(f.dir, "客户端离开后继续");
  // 真实客户端只等 admission，随即退出；后台不依赖客户端进程维持。
  const source = `import { personalControl } from './apps/ruukoto/src/personal-control.ts'; await personalControl(process.env.RUUKOTO_PERSONAL_DIR, 'POST', '/inputs', JSON.parse(process.env.RK_TEST_INPUT));`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { env: { ...process.env, RUUKOTO_PERSONAL_DIR: f.dir, RK_TEST_INPUT: JSON.stringify(input) }, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal((await once(child, "exit"))[0], 0);
  await until(async () => (await checkPersonalInput(f.dir, input)).status === "done");
  assert.equal(f.model.calls.length, 1);
  await personalControl(f.dir, "POST", "/stop");
  await until(() => { try { const lock = lockPersonalProfile(f.dir); lock.release(); return true; } catch (error) { if (code("profile_busy")(error)) return false; throw error; } });
  await launchPersonalServer(f.dir);
  assert.equal((await personalControl<PersonalMessage[]>(f.dir, "GET", "/messages")).at(-1)?.text, "隔离回答");
});

test("personal CLI：socket 已断开仍被后台持锁时，配置和第二实例均拒绝", async t => {
  const f = await fixture(t, () => new Promise(() => {}));
  const server = await f.start();
  const input = preparePersonalInput(f.dir, "等待中");
  await personalControl(f.dir, "POST", "/inputs", input);
  await until(() => f.model.calls.length === 1);
  fs.rmSync(path.join(f.dir, "control.sock"));
  await assert.rejects(personalControl(f.dir, "GET", "/status"), code("control_response_lost"));
  assert.throws(() => savePersonalConfig(f.dir, f.config), code("profile_busy"));
  await assert.rejects(f.start(), code("profile_busy"));
  await server.stop();
  lockPersonalProfile(f.dir).release();
});

test("personal CLI：向导逐步配置、返回与退出，不要求用户提供内部键", async t => {
  const dir = directory(t);
  const answers = ["0", "1", "1", "https://model.example/v1", "chosen-model", "MODEL_TEST_KEY", "", "", "1", "10"];
  let output = "";
  await personalMenu(dir, { question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: value => { output += value; } });
  assert.match(output, /请输入列出的选项/);
  assert.match(output, /模型配置已保存/);
  const lock = lockPersonalProfile(dir);
  const config = readPersonalConfig(lock);
  lock.release();
  assert.equal(config.modelId, "chosen-model");
  assert.equal(config.apiKeyEnv, "MODEL_TEST_KEY");
  assert.equal(config.contextWindow, 128000);
  assert.doesNotMatch(output, /requestId|submission|UUID/);
});

test("personal CLI：关闭清理完成才释放锁，初始化失败接管并释放已有锁", async t => {
  const f = await fixture(t);
  let finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const personal = await openPersonalHarness({ directory: f.dir, provider: personalProvider(f.config), modelId: f.config.modelId, beforeUnlock: () => barrier });
  const closing = personal.close();
  await personal.harness.closed;
  assert.throws(() => lockPersonalProfile(f.dir), code("profile_busy"));
  finish();
  await closing;
  const lock = lockPersonalProfile(f.dir);
  await assert.rejects(openPersonalHarness({ profile: lock, provider: personalProvider(f.config), modelId: "missing" }), code("model_unavailable"));
  lockPersonalProfile(f.dir).release();
});

const serviceConfig = { version: 1, helperPath: "/usr/local/libexec/ruukoto/ruukoto-service", policyPath: "/etc/ruukoto/services.json", sudoPath: "/usr/bin/sudo" } as const;

test("personal 服务配置：严格解析、固定内容与文件权限，非法输入不覆盖原配置", async t => {
  const dir = directory(t);
  assert.deepEqual(parsePersonalServices(serviceConfig), serviceConfig);
  for (const invalid of [null, [], { ...serviceConfig, version: 2 }, { ...serviceConfig, useSudo: false }, { ...serviceConfig, timeouts: {} }, { ...serviceConfig, helperPath: "relative" }, { ...serviceConfig, sudoPath: "/usr/bin/sudo\n" }, { ...serviceConfig, policyPath: 4 }, { ...serviceConfig, helperPath: "/" + "x".repeat(4096) }]) {
    assert.throws(() => parsePersonalServices(invalid), code("service_config_invalid"));
  }
  await savePersonalServices(dir, serviceConfig);
  const filename = path.join(dir, "service.json");
  const original = fs.readFileSync(filename);
  const inode = fs.statSync(filename).ino;
  await savePersonalServices(dir, serviceConfig);
  assert.equal(fs.statSync(filename).ino, inode);
  await assert.rejects(savePersonalServices(dir, { ...serviceConfig, helperPath: "/other-helper" }), code("service_config_changed"));
  await assert.rejects(savePersonalServices(dir, { ...serviceConfig, useSudo: false }), code("service_config_invalid"));
  assert.deepEqual(fs.readFileSync(filename), original);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(filename + ".tmp"), false);
  const profile = lockPersonalProfile(dir);
  assert.deepEqual(readPersonalServices(profile), serviceConfig);
  await assert.rejects(savePersonalServices(dir, serviceConfig), code("profile_busy"));
  profile.release();
});

test("personal 服务配置：坏文件、未知版本和链接拒绝，启动前不请求模型", async t => {
  const f = await fixture(t);
  const filename = path.join(f.dir, "service.json");
  for (const content of ["broken", JSON.stringify({ ...serviceConfig, version: 2 }), JSON.stringify({ ...serviceConfig, useSudo: false })]) {
    fs.writeFileSync(filename, content);
    await assert.rejects(f.start(), code("service_config_invalid"));
    await assert.rejects(launchPersonalServer(f.dir), code("service_config_invalid"));
    await assert.rejects(savePersonalServices(f.dir, serviceConfig), code("service_config_invalid"));
    assert.equal(fs.readFileSync(filename, "utf8"), content);
    lockPersonalProfile(f.dir).release();
  }
  fs.rmSync(filename);
  fs.symlinkSync(path.join(f.dir, "model.json"), filename);
  await assert.rejects(f.start(), code("profile_unrecognized"));
  assert.equal(f.model.calls.length, 0);
  fs.rmSync(filename);
  await savePersonalServices(f.dir, serviceConfig);
  let shown = "";
  await configurePersonalServices({ question: async () => assert.fail("查看原配置不询问新路径"), write: value => { shown += value; } }, f.dir);
  assert.match(shown, /服务配置已固定/);
  if (process.platform !== "linux") {
    await assert.rejects(f.start(), code("service_config_invalid"));
    await assert.rejects(launchPersonalServer(f.dir), code("service_config_invalid"));
  }
});

test("personal 服务配置：向导保留旧菜单序号、返回不写，非 Linux 保存前拒绝", async t => {
  const dir = directory(t);
  const answers = process.platform === "linux" ? ["11", "/back", "10"] : ["11", "10"];
  let output = "";
  await personalMenu(dir, { question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: value => { output += value; } });
  assert.equal(fs.existsSync(path.join(dir, "service.json")), false);
  assert.doesNotMatch(output, /requestId|submission|UUID/);
  if (process.platform !== "linux") assert.match(output, /service_platform_unsupported/);
  else {
    const cancel = ["", "", "", "1"];
    await configurePersonalServices({ question: async () => cancel.shift()!, write: () => {} }, dir);
    assert.equal(fs.existsSync(path.join(dir, "service.json")), false);
    const defaults = ["", "", "", "2"];
    await configurePersonalServices({ question: async () => defaults.shift()!, write: () => {} }, dir);
    const profile = lockPersonalProfile(dir);
    assert.deepEqual(readPersonalServices(profile), serviceConfig);
    profile.release();
  }
});

test("personal 服务配置：未决输入阻止固化文件和授权，原空工具仍能重启完成后启用", async t => {
  let blocked = true;
  const f = await fixture(t, () => blocked ? new Promise(() => {}) : { kind: "text", text: "恢复完成" });
  const first = await f.start();
  const input = preparePersonalInput(f.dir, "未完成输入");
  await personalControl(f.dir, "POST", "/inputs", input);
  await until(() => f.model.calls.length === 1);
  await assert.rejects(savePersonalServices(f.dir, serviceConfig), code("profile_busy"));
  await first.stop();
  await assert.rejects(savePersonalServices(f.dir, serviceConfig), code("service_config_pending"));
  assert.equal(fs.existsSync(path.join(f.dir, "service.json")), false);
  await assert.rejects(openPersonalHarness({ directory: f.dir, provider: personalProvider(f.config), modelId: f.config.modelId, service: { ...serviceConfig, useSudo: false }, serviceOperations: true }), code("service_config_pending"));
  const storage = await openNodeSqliteStorage(path.join(f.dir, "personal.sqlite"));
  for (const token of [PersonalServiceDoc, PersonalServiceGrantsDoc, PersonalServiceOperationsDoc]) assert.equal(await storage.findDocument({ kind: token.definition.kind, scope: { kind: "session" } }, "current", context), undefined);
  await storage.close(context);
  blocked = false;
  const restored = await f.start();
  await until(async () => (await checkPersonalInput(f.dir, input)).status === "done");
  assert.equal((await checkPersonalInput(f.dir, input)).answer, "恢复完成");
  await restored.stop();
  await savePersonalServices(f.dir, serviceConfig);
  assert.equal(fs.existsSync(path.join(f.dir, "service.json")), true);
});

test("personal 服务配置：无法核实业务格式不保存，原文件和锁保留", async t => {
  const dir = directory(t);
  lockPersonalProfile(dir).release();
  fs.writeFileSync(path.join(dir, "personal.sqlite"), "broken sqlite");
  const before = fs.readFileSync(path.join(dir, "personal.sqlite"));
  await assert.rejects(savePersonalServices(dir, serviceConfig), code("service_config_check_failed"));
  assert.equal(fs.existsSync(path.join(dir, "service.json")), false);
  assert.deepEqual(fs.readFileSync(path.join(dir, "personal.sqlite")), before);
  lockPersonalProfile(dir).release();
});

test("personal 服务配置：只读档案有未决输入时不能半启用操作，原检查配置仍可重开", async t => {
  const f = await fixture(t, () => new Promise(() => {}));
  const options = { directory: f.dir, provider: personalProvider(f.config), modelId: f.config.modelId, service: { ...serviceConfig, useSudo: false } };
  const first = await openPersonalHarness(options);
  await first.submit("保留只读输入", "read-only-pending");
  await until(() => f.model.calls.length === 1);
  await first.close();
  await assert.rejects(openPersonalHarness({ ...options, serviceOperations: true }), code("service_config_pending"));
  const original = await openPersonalHarness(options);
  assert.equal(original.service, undefined);
  assert.deepEqual((await original.main.agent(context)).tools.map(tool => tool.name), ["app_data_define_table", "app_data_migrate", "app_data_query", "app_data_insert", "app_data_update", "app_data_delete", "memory", "history_search", "history_read", "skill", "read_artifact", "service_inspect", "read_service_inspection", "background_work", "schedule_create", "schedule_query", "schedule_cancel"]);
  await original.close();
});

test("personal 服务配置：生产 sudo 后台接线和恢复（Linux），其他平台安全拒绝", async t => {
  const unit = "ruukoto-service-test.service";
  const f = await fixture(t, (_request, index) => index % 2 === 0 ? { kind: "tool_calls", calls: [{ id: `inspect-${index}`, name: "service_inspect", arguments: { unit } }] } : { kind: "text", text: "服务检查完成" });
  if (process.platform !== "linux") {
    await savePersonalServices(f.dir, serviceConfig);
    await assert.rejects(f.start(), code("service_config_invalid"));
    assert.equal(f.model.calls.length, 0);
    return;
  }
  const helper = directory(t);
  const configured = { version: 1, helperPath: path.join(helper, "helper.mjs"), policyPath: path.join(helper, "services.json"), sudoPath: path.join(helper, "sudo.mjs") };
  fs.copyFileSync(new URL("./helpers/fake-service-helper.mjs", import.meta.url), configured.helperPath);
  // 固定 sudo 命令桩，仍走生产 useSudo:true 的 argv/清空环境与真实子进程。
  fs.writeFileSync(configured.sudoPath, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nif (process.argv[2] !== '-n') process.exit(3);\nconst result = spawnSync(process.execPath, process.argv.slice(3), { stdio: 'inherit' });\nprocess.exit(result.status ?? 4);\n`, { mode: 0o700 });
  fs.writeFileSync(configured.policyPath, JSON.stringify({ machineId: "test-machine", inspectUid: 1, inspectGid: 1, services: { [unit]: { actions: ["restart"] } } }));
  fs.mkdirSync(path.join(helper, "units"));
  fs.writeFileSync(path.join(helper, "units", unit), "[Service]\nExecStart=/usr/bin/true\n");
  fs.writeFileSync(path.join(helper, "state.json"), JSON.stringify({ [unit]: { loadState: "loaded", activeState: "active", subState: "running", mainPid: 1234, invocationId: "test", result: "success", activeEnterTimestamp: "2026-10-17T00:00:00Z" } }));
  const answers = [configured.helperPath, configured.policyPath, configured.sudoPath, "2"];
  await configurePersonalServices({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: () => {} }, f.dir);
  const stop = async () => {
    await personalControl(f.dir, "POST", "/stop");
    await until(() => { try { lockPersonalProfile(f.dir).release(); return true; } catch (error) { if (code("profile_busy")(error)) return false; throw error; } });
  };
  for (let run = 0; run < 2; run++) {
    await launchPersonalServer(f.dir);
    assert.equal((await personalControl<PersonalStatus>(f.dir, "GET", "/status")).services, true);
    const input = preparePersonalInput(f.dir, "检查测试服务");
    await personalControl(f.dir, "POST", "/inputs", input);
    await until(async () => (await checkPersonalInput(f.dir, input)).status === "done");
    assert.equal((await checkPersonalInput(f.dir, input)).answer, "服务检查完成");
    await stop();
  }
  const calls = fs.readFileSync(path.join(helper, "calls.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call[0]), ["inspect-op", "stop-inspect", "inspect-op", "stop-inspect"]);
  for (const index of [0, 2]) { assert.deepEqual(calls[index].slice(2), ["test-machine", unit]); assert.deepEqual(calls[index + 1].slice(1), [calls[index][1], "test-machine"]); }
  assert.deepEqual(f.model.calls[0].tools?.map(tool => (tool.function as { name: string }).name), ["app_data_define_table", "app_data_migrate", "app_data_query", "app_data_insert", "app_data_update", "app_data_delete", "memory", "history_search", "history_read", "skill", "read_artifact", "service_inspect", "read_service_inspection", "background_work", "schedule_create", "schedule_query", "schedule_cancel"]);
  const storage = await openNodeSqliteStorage(path.join(f.dir, "personal.sqlite"));
  for (const token of [PersonalServiceDoc, PersonalServiceGrantsDoc, PersonalServiceOperationsDoc]) assert.ok(await storage.findDocument({ kind: token.definition.kind, scope: { kind: "session" } }, "current", context));
  const entries = (await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256, undefined, context)).items;
  assert.equal(entries.filter(entry => entry.kind === "ruukoto.service-inspection").length, 2);
  assert.ok(entries.some(entry => entry.kind === "ruukoto.model-request" && JSON.stringify(entry.data).includes("service_inspect")));
  await storage.close(context);
  fs.writeFileSync(path.join(helper, "inspection-stop-fails"), "");
  await launchPersonalServer(f.dir);
  const input = preparePersonalInput(f.dir, "待重核的检查"); await personalControl(f.dir, "POST", "/inputs", input);
  await until(async () => (await checkPersonalInput(f.dir, input)).status === "done");
  type Page = { items: { ref: { taskId: number; admission: number }; canRecheck: boolean }[] };
  const page = await personalControl<Page>(f.dir, "GET", "/inspections"); assert.equal(page.items.length, 1); assert.ok(page.items[0].canRecheck);
  for (const route of ["/inspections?offset=-1", "/inspection/stop?inspection=1&admission=-1"]) await assert.rejects(personalControl(f.dir, route.startsWith("/inspection/stop") ? "POST" : "GET", route), code("work_input_invalid"));
  const ref = page.items[0].ref;
  await assert.rejects(personalControl(f.dir, "POST", `/inspection/stop?inspection=${ref.taskId}&admission=${ref.admission + 10000}`), code("inspection_menu_stale"));
  const entered = path.join(helper, "stop-entered"); const release = path.join(helper, "stop-release");
  fs.writeFileSync(configured.helperPath, fs.readFileSync(configured.helperPath, "utf8").replace('function cmdStopInspect(inspectionId, expectedMachineId) {', `function cmdStopInspect(inspectionId, expectedMachineId) { fs.writeFileSync(${JSON.stringify(entered)}, ""); while (!fs.existsSync(${JSON.stringify(release)})) sleepMs(10);`));
  try {
    const answers = ["1", "2", "3"]; let output = "";
    await managePersonalInspections({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: value => { output += value; } }, f.dir);
    await until(() => fs.existsSync(entered)); assert.match(output, /已登记/); assert.equal(fs.existsSync(release), false);
    assert.equal((await personalControl<Page>(f.dir, "GET", "/inspections")).items.length, 1);
    fs.rmSync(path.join(helper, "inspection-stop-fails")); fs.writeFileSync(release, "");
    await until(async () => (await personalControl<Page>(f.dir, "GET", "/inspections")).items.length === 0);
    assert.equal(fs.readFileSync(path.join(helper, "calls.log"), "utf8").trim().split("\n").filter(line => JSON.parse(line)[0] === "inspect-op").length, 3);
  } finally { fs.writeFileSync(release, ""); await stop(); }
  const callsBeforeRefusal = fs.readFileSync(path.join(helper, "calls.log"), "utf8");
  const modelCallsBeforeRefusal = f.model.calls.length;
  const filename = path.join(f.dir, "service.json");
  fs.rmSync(filename);
  await assert.rejects(f.start(), code("service_config_changed"));
  await assert.rejects(savePersonalServices(f.dir, { ...configured, helperPath: configured.helperPath + ".other" }), code("service_config_changed"));
  assert.equal(fs.existsSync(filename), false);
  await savePersonalServices(f.dir, configured);
  fs.writeFileSync(filename, JSON.stringify({ ...configured, policyPath: configured.policyPath + ".other" }));
  await assert.rejects(f.start(), code("service_config_changed"));
  fs.writeFileSync(filename, JSON.stringify(configured));
  assert.equal(f.model.calls.length, modelCallsBeforeRefusal);
  assert.equal(fs.readFileSync(path.join(helper, "calls.log"), "utf8"), callsBeforeRefusal);
});


test("检查重核向导：分页固定原接纳，选择登记且刷新不重投", async t => {
  const dir = directory(t); const token = "a".repeat(64); fs.writeFileSync(path.join(dir, "control.token"), token + "\n");
  const routes: string[] = []; let requested = false;
  const item = { ref: { taskId: 12, admission: 34 }, unit: "example.service", scope: "后台分析的固定检查", canRecheck: true };
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`); routes.push(`${req.method} ${req.url}`);
    let result;
    if (req.method === "POST") { assert.equal(req.url, "/inspection/stop?inspection=12&admission=34"); requested = true; result = { requested: true }; }
    else result = requested ? { items: [] } : req.url === "/inspections?offset=0" ? { items: Array(8).fill(item), nextOffset: 8 } : { items: [item] };
    res.end(JSON.stringify({ v: 1, ok: true, result }));
  });
  server.listen(path.join(dir, "control.sock")); await once(server, "listening"); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const answers = ["9", "1", "2", "2"]; let output = "";
  await managePersonalInspections({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: value => { output += value; } }, dir);
  assert.deepEqual(routes, ["GET /inspections?offset=0", "GET /inspections?offset=8", "POST /inspection/stop?inspection=12&admission=34", "GET /inspections?offset=0"]);
  assert.match(output, /登记不表示已停止/); assert.doesNotMatch(output, /taskId|admission|UUID/);
});

test("服务核实向导：分页选择、保存效果证据、分页原说明及独立停止登记", async t => {
  const dir = directory(t); const token = "a".repeat(64); fs.writeFileSync(path.join(dir, "control.token"), token + "\n");
  const routes: string[] = []; let saved = false; let stopped = false; const evidence = "独立核实服务实际效果；".repeat(130);
  const item = { ref: { taskId: 12, requestId: "private-request" }, unit: "example.service", status: "效果未知", canResolve: true, canRecheck: true };
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`); routes.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let result;
    if (req.url === "/service/resolve?service=12") { assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { effect: "applied", evidence }); saved = true; result = { saved: true }; }
    else if (req.url === "/service/stop?service=12") { stopped = true; result = { requested: true }; }
    else if (req.url?.startsWith("/service?")) { const offset = Number(new URL(req.url, "http://localhost").searchParams.get("offset")); result = { summary: { ...item, canResolve: !saved, canRecheck: !stopped }, evidence: saved ? evidence.slice(offset, offset + 1200) : "尚未保存", ...(saved && offset === 0 ? { nextOffset: 1200 } : {}) }; }
    else result = stopped ? { items: [] } : req.url === "/services?offset=0" ? { items: Array(8).fill(item), nextOffset: 8 } : { items: [item] };
    res.end(JSON.stringify({ v: 1, ok: true, result }));
  });
  server.listen(path.join(dir, "control.sock")); await once(server, "listening"); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const answers = ["9", "1", "2", evidence, "3", "2", "3", "1"]; let output = "";
  await managePersonalServices({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: value => { output += value; } }, dir);
  assert.deepEqual(routes, ["GET /services?offset=0", "GET /services?offset=8", "GET /service?service=12&offset=0", "POST /service/resolve?service=12", "GET /service?service=12&offset=0", "GET /service?service=12&offset=1200", "POST /service/stop?service=12", "GET /service?service=12&offset=0", "GET /services?offset=0"]);
  assert.match(output, /登记不表示已停止/); assert.doesNotMatch(output, /private-request|taskId|UUID/); assert.equal(answers.length, 0);
});

test("服务核实 HTTP：Linux sudo 接线、原状态刷新及慢停止不阻塞独立聊天", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t); const helper = directory(t); const unit = "recovery-test.service";
  const configured = { version: 1, helperPath: path.join(helper, "helper.mjs"), policyPath: path.join(helper, "services.json"), sudoPath: path.join(helper, "sudo.mjs") };
  fs.copyFileSync(new URL("./helpers/fake-service-helper.mjs", import.meta.url), configured.helperPath);
  fs.writeFileSync(configured.sudoPath, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process'; if(process.argv[2]!=='-n')process.exit(3);const r=spawnSync(process.execPath,process.argv.slice(3),{stdio:'inherit'});process.exit(r.status??4);\n`, { mode: 0o700 });
  fs.mkdirSync(path.join(helper, "units")); fs.mkdirSync(path.join(helper, "ops"));
  fs.writeFileSync(path.join(helper, "units", unit), "[Service]\nExecStart=/usr/bin/true\n");
  fs.writeFileSync(configured.policyPath, JSON.stringify({ machineId: "test-machine", inspectUid: 1, inspectGid: 1, services: { [unit]: { actions: ["restart"] } } }));
  fs.writeFileSync(path.join(helper, "state.json"), JSON.stringify({ [unit]: { starts: 0, loadState: "loaded", activeState: "active", subState: "running", mainPid: 123, invocationId: "before", result: "success", activeEnterTimestamp: "2026-10-17T00:00:00Z" } }));
  fs.writeFileSync(path.join(helper, "fail-after-launch"), ""); fs.writeFileSync(path.join(helper, "stop-query-fails"), "");
  await savePersonalServices(f.dir, configured);
  let p = await openPersonalHarness({ directory: f.dir, provider: personalProvider(f.config), modelId: f.config.modelId, service: { ...configured, useSudo: true }, serviceOperations: true });
  await p.answer("服务工作", "owner"); const approval = await p.service!.request({ requestId: "approval", sourceRequestId: "owner", unit });
  await until(async () => !!(await p.service!.status(approval)).operation.snapshot); await p.close(); const backend = await f.start();
  const approvalRoute = `/service/decide?service=${approval.taskId}`;
  const token = fs.readFileSync(path.join(f.dir, "control.token"), "utf8").trim();
  assert.equal((await raw(f.dir, "POST", approvalRoute, JSON.stringify({ decision: "approved", extra: true }), token)).status, 400);
  assert.equal((await personalControl<{ summary: { canDecide: boolean } }>(f.dir, "GET", `/service?service=${approval.taskId}`)).summary.canDecide, true);
  await personalControl(f.dir, "POST", approvalRoute, { decision: "rejected" });
  await until(async () => !(await personalControl<{ summary: { canDecide: boolean } }>(f.dir, "GET", `/service?service=${approval.taskId}`)).summary.canDecide);
  await backend.stop(); p = await openPersonalHarness({ directory: f.dir, provider: personalProvider(f.config), modelId: f.config.modelId, service: { ...configured, useSudo: true }, serviceOperations: true });
  await p.harness.waitForTask(approval.taskId, context);
  const ref = await p.service!.request({ requestId: "operation", sourceRequestId: "owner", unit, mode: "full_access" });
  await until(async () => (await p.service!.status(ref)).operation.result?.code === "result_unverified"); await p.close();
  await f.start();
  type Detail = { summary: { canResolve: boolean; canRecheck: boolean; stop?: string }; evidence: string };
  const listed = await personalControl<{ items: { ref: { taskId: number } }[] }>(f.dir, "GET", "/services");
  assert.deepEqual(listed.items.map(item => item.ref.taskId).sort((a, b) => a - b), [approval.taskId, ref.taskId].sort((a, b) => a - b));
  const route = `/service?service=${ref.taskId}`;
  await assert.rejects(personalControl(f.dir, "POST", `/service/resolve?service=${ref.taskId}`, { effect: "applied", evidence: " " }), code("service_resolution_invalid"));
  await personalControl(f.dir, "POST", `/service/resolve?service=${ref.taskId}`, { effect: "applied", evidence: "独立核实启动计数" });
  assert.equal((await personalControl<Detail>(f.dir, "GET", route)).summary.canResolve, false);
  await assert.rejects(personalControl(f.dir, "POST", `/service/resolve?service=${ref.taskId}`, { effect: "not_applied", evidence: "不能覆盖" }), code("service_resolution_invalid"));
  const entered = path.join(helper, "stop-entered"); const release = path.join(helper, "stop-release");
  fs.writeFileSync(configured.helperPath, fs.readFileSync(configured.helperPath, "utf8").replace('function cmdStopOp(hostOpId) {', `function cmdStopOp(hostOpId) { fs.writeFileSync(${JSON.stringify(entered)}, ""); while(!fs.existsSync(${JSON.stringify(release)}))sleepMs(10);`));
  try {
    await personalControl(f.dir, "POST", `/service/stop?service=${ref.taskId}`); await until(() => fs.existsSync(entered));
    assert.equal(fs.existsSync(release), false); assert.equal((await personalControl<Detail>(f.dir, "GET", route)).summary.canRecheck, true);
    const input = preparePersonalInput(f.dir, "停止重核期间独立聊天"); await personalControl(f.dir, "POST", "/inputs", input); await until(async () => (await checkPersonalInput(f.dir, input)).status === "done");
    fs.rmSync(path.join(helper, "stop-query-fails")); fs.writeFileSync(release, "");
    await until(async () => (await personalControl<Detail>(f.dir, "GET", route)).summary.stop === "stopped");
    assert.equal((await personalControl<Detail>(f.dir, "GET", route)).summary.canRecheck, false);
    assert.equal(fs.readFileSync(path.join(helper, "calls.log"), "utf8").trim().split("\n").filter(line => JSON.parse(line)[0] === "restart").length, 1);
  } finally { fs.writeFileSync(release, ""); }
});

test("服务审批向导：选择原目标批准或拒绝，不询问内部键", async t => {
  for (const decision of ["approved", "rejected"] as const) await t.test(decision, async t => {
    const dir = directory(t); const token = "a".repeat(64); fs.writeFileSync(path.join(dir, "control.token"), token + "\n");
    let saved = false; const item = { ref: { taskId: 12, requestId: "private-request" }, unit: "example.service", status: "等待批准：在机器 test-machine 重启 example.service", canDecide: true, canResolve: false, canRecheck: false };
    const server = http.createServer(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      let result;
      if (req.method === "POST") {
        assert.equal(req.url, "/service/decide?service=12"); const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { decision }); saved = true; result = { saved: true };
      } else result = req.url?.startsWith("/service?") ? { summary: { ...item, canDecide: !saved }, evidence: "尚无核实说明" } : { items: [item] };
      res.end(JSON.stringify({ v: 1, ok: true, result }));
    });
    server.listen(path.join(dir, "control.sock")); await once(server, "listening"); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const answers = ["1", decision === "approved" ? "2" : "3", "2", "2"]; let output = "";
    await managePersonalServices({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: value => { output += value; } }, dir);
    assert.equal(saved, true); assert.equal(answers.length, 0); assert.match(output, /test-machine/); assert.doesNotMatch(output, /private-request|taskId|UUID/);
  });
});

test("personal CLI：命令菜单只用已选原命令，分别保存效果证据和登记停止重核", async t => {
  const dir = directory(t); fs.writeFileSync(path.join(dir, "control.token"), "c".repeat(64));
  const routes: string[] = [];
  let saved = false, stopped = false;
  const server = http.createServer(async (req, res) => {
    routes.push(`${req.method} ${req.url}`);
    let result: unknown;
    if (req.url === "/command/resolve?command=12") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { effect: "applied", evidence: "原计数只有一行" }); saved = true; result = { saved: true };
    } else if (req.url === "/command/stop?command=12") { stopped = true; result = { requested: true }; }
    else if (req.url?.startsWith("/command?")) result = { operation: 12, command: "原命令", result: { effect: "effect_unknown", code: "interrupted" }, stopped, canResolve: !saved, canRecheck: !stopped, ...(saved ? { resolution: { effect: "applied", evidence: "原计数只有一行" } } : {}), output: { data: Buffer.from("原输出").toString("base64"), bytes: 9, complete: false } };
    else result = { items: stopped ? [] : [{ ref: { taskId: 12, requestId: "host-key" }, command: "原命令" }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ v: 1, ok: true, result }));
  });
  server.listen(path.join(dir, "control.sock")); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const answers = ["1", "3", "原计数只有一行", "3", "3", "1"]; let output = "";
  await managePersonalCommands({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: value => { output += value; } }, dir);
  assert.equal(answers.length, 0); assert.equal(saved, true); assert.equal(stopped, true);
  assert.deepEqual(routes, ["GET /commands?offset=0", "GET /command?command=12&stream=stdout&offset=0", "POST /command/resolve?command=12", "GET /command?command=12&stream=stdout&offset=0", "POST /command/stop?command=12", "GET /command?command=12&stream=stdout&offset=0", "GET /commands?offset=0"]);
  assert.match(output, /原输出/); assert.match(output, /停止也核实后才解除暂停/); assert.match(output, /登记不表示已停止/);
});

test("本机应用数据：认证API批准原操作与CLI按列表查看，无需输入内部键", async t => {
  const calls = [
    { name: "app_data_define_table", arguments: { table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "记录" } },
    { name: "app_data_insert", arguments: { table: "todos", records: [{ title: "甲" }, { title: "乙" }], reason: "新增" } },
    { name: "app_data_delete", arguments: { table: "todos", rows: [{ id: 1, expected_version: 1 }, { id: 2, expected_version: 1 }], reason: "完成" } },
  ];
  const f = await fixture(t, (_request, index) => calls[index] ? { kind: "tool_calls", calls: [{ id: `app-data-${index}`, ...calls[index] }] } : { kind: "text", text: "业务已完成" });
  const server = await f.start();
  const input = preparePersonalInput(f.dir, "整理待办"); await personalControl(f.dir, "POST", "/inputs", input);
  let operation = 0;
  await until(async () => { const page = await personalControl<{ items: { operation: number; decision: string }[] }>(f.dir, "GET", "/app-data/operations"); operation = page.items.find(value => value.decision === "pending")?.operation ?? 0; return operation > 0; });
  const unauthorized = await raw(f.dir, "POST", `/app-data/decide?operation=${operation}`, JSON.stringify({ decision: "approved" })); assert.notEqual(unauthorized.status, 200);
  await personalControl(f.dir, "POST", `/app-data/decide?operation=${operation}`, { decision: "approved" });
  await until(async () => (await checkPersonalInput(f.dir, input)).status === "done");
  const page = await personalControl<{ items: { operation: number; effect: string }[] }>(f.dir, "GET", "/app-data/operations"); assert.equal(page.items[0].effect, "committed");
  await personalControl(f.dir, "POST", `/app-data/recheck?operation=${operation}`);
  const answers = ["1", "1", "4"], output: string[] = [];
  await managePersonalAppData({ question: async () => answers.shift()!, write: text => output.push(text) }, f.dir);
  assert.match(output.join(""), /app_data_delete/); assert.match(output.join(""), /committed/); assert.equal(answers.length, 0);
  await server.stop();
});
