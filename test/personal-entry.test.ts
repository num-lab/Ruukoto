import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { build } from "esbuild";
import { ControlClient } from "@ruukoto/control/client.ts";
import { personalDevDirectory, personalDevelopmentEnv, savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { personalControl, startPersonalServer, type PersonalStatus } from "../apps/ruukoto/src/personal-control.ts";
import { savePersonalTelegram } from "../apps/ruukoto/src/personal-telegram-config.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { authenticateClient, cleanupDirs, makeTestDirs, writeModelsJson } from "./helpers/testkit.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const bin = path.join(root, "apps/ruukoto/bin/ruukoto.mjs");
const execute = promisify(execFile);
const code = (value: string) => (error: unknown) => error instanceof PersonalError && error.code === value;
const temp = (t: TestContext) => {
  const dir = fs.mkdtempSync("/tmp/r38-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) { assert.ok(Date.now() < deadline, "入口未在期限内就绪或停止"); await delay(20); }
}
function child(t: TestContext, argv: string[], env: NodeJS.ProcessEnv) {
  const processChild = spawn(process.execPath, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  processChild.stdout!.on("data", value => { output += String(value); });
  processChild.stderr!.on("data", value => { output += String(value); });
  const closed = new Promise<number | null>((resolve, reject) => { processChild.once("error", reject); processChild.once("close", resolve); });
  t.after(async () => {
    if (processChild.exitCode === null && processChild.signalCode === null) {
      processChild.kill("SIGTERM");
      const timer = setTimeout(() => processChild.kill("SIGKILL"), 5000);
      try { await closed; } finally { clearTimeout(timer); }
    }
  });
  return { process: processChild, closed, output: () => output };
}
async function ready(directory: string, processChild: ChildProcess, output: () => string) {
  await until(async () => {
    assert.equal(processChild.exitCode, null, output());
    try { await personalControl(directory, "GET", "/status"); return true; } catch (error) {
      if (!(error instanceof PersonalError) || !["control_unavailable", "control_starting", "control_response_lost"].includes(error.code)) throw error;
      return false;
    }
  });
}
async function fixture(t: TestContext, directory = temp(t)) {
  const model = new MockModelServer(() => ({ kind: "text", text: "ENTRY_OK" }));
  const baseUrl = await model.start();
  t.after(() => model.close());
  await savePersonalConfig(directory, { api: "openai-completions", baseUrl, modelId: "mock-model", apiKeyEnv: "R38_MODEL_KEY", contextWindow: 128000, maxTokens: 1024 });
  return { directory, model, baseUrl, env: { RUUKOTO_PERSONAL_DIR: directory, R38_MODEL_KEY: "test-only" } };
}

test("个人正式与开发实际 import 图不加载旧运行装配，双 Pi 版本独立解析", async () => {
  for (const entry of ["main", "dev"]) {
    const result = await build({ entryPoints: [`apps/ruukoto/src/${entry}.ts`], bundle: true, platform: "node", format: "esm", write: false, metafile: true,
      plugins: [{ name: "workspace-only", setup(builder) { builder.onResolve({ filter: /^[^./]/ }, args => args.path.startsWith("@ruukoto/") ? undefined : { path: args.path, external: true }); } }] });
    const inputs = Object.keys(result.metafile!.inputs);
    assert.ok(inputs.some(file => file.endsWith("personal-harness.ts")));
    assert.equal(inputs.some(file => /packages\/(runtime|control|tui)\//.test(file) || /packages\/core\/src\/(db|store)\.ts$/.test(file) || /packages\/agent\/src\/driver\.ts$/.test(file)), false, inputs.join("\n"));
  }
  const resolve = async (directory: string) => {
    const result = await execute(process.execPath, ["--input-type=module", "--eval", 'import {readFileSync} from "node:fs";const module=import.meta.resolve("@earendil-works/pi-ai");process.stdout.write(JSON.stringify({module,version:JSON.parse(readFileSync(new URL("../package.json",module),"utf8")).version}));'], { cwd: path.join(root, directory) });
    return JSON.parse(result.stdout) as { module: string; version: string };
  };
  const personal = await resolve("apps/ruukoto"), coding = await resolve("packages/agent");
  assert.equal(personal.version, "1.3.0");
  assert.equal(coding.version, "0.85.1");
  assert.notEqual(personal.module, coding.module);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "apps/ruukoto/package.json"), "utf8"));
  assert.equal(manifest.dependencies["@earendil-works/pi-durable"], "1.3.0");
  for (const name of ["@earendil-works/pi-coding-agent", "@ruukoto/tui", "@ruukoto/runtime"]) assert.equal(manifest.dependencies[name], undefined);
});

test("正式 bin 默认新档案，忽略反向产品与旧目录；旧档案拒绝且原字节保持", async t => {
  const home = temp(t), old = temp(t);
  fs.writeFileSync(path.join(old, "ruukoto.db"), "archive-only\n");
  const digest = () => createHash("sha256").update(fs.readFileSync(path.join(old, "ruukoto.db"))).digest("hex");
  const before = digest();
  const fail = async (env: NodeJS.ProcessEnv) => {
    try { await execute(process.execPath, [bin, "serve"], { env: { ...process.env, HOME: home, RUUKOTO_PRODUCT: "ruukoto-code", RUUKOTO_DATA_DIR: old, RUUKOTO_PERSONAL_DIR: "", ...env } }); assert.fail("应拒绝启动"); }
    catch (error) { assert.ok(error instanceof Error && "stderr" in error); return String(error.stderr); }
  };
  // 空的显式变量沿用平台环境语义，不把当前检出当成个人档案。
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, RUUKOTO_PRODUCT: "ruukoto-code", RUUKOTO_DATA_DIR: old };
  delete env.RUUKOTO_PERSONAL_DIR;
  const started = child(t, [bin, "serve"], env);
  assert.equal(await started.closed, 1);
  assert.match(started.output(), /model_config_unavailable/);
  assert.ok(fs.existsSync(path.join(home, ".ruukoto-durable/profile.json")));
  assert.equal(fs.existsSync(path.join(home, ".ruukoto")), false);
  assert.match(await fail({}), /model_config_unavailable/);
  assert.match(await fail({ RUUKOTO_PERSONAL_DIR: old }), /profile_unrecognized.*保留原资料/);
  assert.deepEqual(fs.readdirSync(old), ["ruukoto.db"]);
  assert.equal(digest(), before);
});

test("正式 bin、根 start、兼容入口同档案重启，双进程拒绝且停止后释放锁", async t => {
  const f = await fixture(t);
  for (const argv of [[bin, "serve"], ["--import", "tsx", "scripts/start.ts", "serve"], ["--import", "tsx", "apps/ruukoto/src/personal-entry.ts", "serve"]]) {
    const backend = child(t, argv, f.env);
    await ready(f.directory, backend.process, backend.output);
    const duplicate = child(t, [bin, "serve"], f.env);
    assert.equal(await duplicate.closed, 1);
    assert.match(duplicate.output(), /profile_busy/);
    const status = await personalControl<PersonalStatus>(f.directory, "GET", "/status");
    assert.equal(status.model, "mock-model");
    await personalControl(f.directory, "POST", "/stop");
    assert.equal(await backend.closed, 0, backend.output());
    lockPersonalProfile(f.directory).release();
  }
  assert.equal(fs.existsSync(path.join(f.directory, "ruukoto.db")), false);
});

test("个人与 Coding 实际 bin 同时运行，停止个人不影响 Coding 的协议和 schema", async t => {
  const f = await fixture(t), { dirs } = await makeTestDirs("entry-code", 0);
  t.after(() => cleanupDirs(dirs));
  await writeModelsJson(dirs, f.baseUrl);
  const coding = child(t, [path.join(root, "apps/ruukoto-code/bin/ruukoto-code.mjs"), "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir, "--tools", "mock"], { RUUKOTO_PRODUCT: "ruukoto", RUUKOTO_CODE_CONTROL_DIR: path.join(dirs.root, "control") });
  let client: ControlClient | undefined;
  await until(async () => {
    assert.equal(coding.process.exitCode, null, coding.output());
    try { client = await ControlClient.connect(path.join(dirs.root, "control/control.sock"), 500); } catch { return false; } // 仅等待本轮后台创建 socket。
    return true;
  });
  await authenticateClient(client!, path.join(dirs.root, "control"));
  await client!.handshake();
  const schema = () => {
    const db = new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"), { readOnly: true });
    try { return JSON.stringify(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()); }
    finally { db.close(); }
  };
  const before = schema();
  const personal = child(t, [bin, "serve"], { ...f.env, RUUKOTO_PRODUCT: "ruukoto-code" });
  await ready(f.directory, personal.process, personal.output);
  await personalControl(f.directory, "POST", "/stop");
  assert.equal(await personal.closed, 0);
  const qq = await client!.request<{ disabledByConfig: boolean }>("qq_status");
  assert.equal(qq.disabledByConfig, true);
  assert.equal(schema(), before);
  await client!.request("stop"); client!.close();
  assert.equal(await coding.closed, 0, coding.output());
  assert.equal(fs.existsSync(path.join(dirs.dataDir, "personal.sqlite")), false);
});

test("serve 启动中的关闭意图及真实 SIGTERM/SIGHUP 均等待停止后释放原锁", async t => {
  const f = await fixture(t);
  const source = `import {runPersonalCli} from ${JSON.stringify(path.join(root, "apps/ruukoto/src/personal-cli.ts"))}; queueMicrotask(()=>process.emit("SIGTERM")); process.exitCode=await runPersonalCli(["serve"]);`;
  const starting = child(t, ["--import", "tsx", "--input-type=module", "--eval", source], f.env);
  assert.equal(await starting.closed, 0, starting.output());
  lockPersonalProfile(f.directory).release();
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    const backend = child(t, [bin, "serve"], f.env);
    await ready(f.directory, backend.process, backend.output);
    backend.process.kill(signal);
    assert.equal(await backend.closed, 0, backend.output());
    lockPersonalProfile(f.directory).release();
  }
});

test("开发环境固定档案并清洗双方生产配置，保留模型凭据；启用 IM 的档案零恢复零连接", async t => {
  const f = await fixture(t);
  const env = personalDevelopmentEnv(f.directory, { RUUKOTO_PERSONAL_DIR: "daily", RUUKOTO_DATA_DIR: "old", RUUKOTO_CODE_DATA_DIR: "code", RUUKOTO_OWNER_TOKEN: "secret", RUUKOTO_SERVICE_HELPER: "helper", RUUKOTO_RELOAD_STATE_FILE: "old-state", RUUKOTO_DURABLE_CLI_KEY: "model", PATH: "path" });
  assert.deepEqual(env, { RUUKOTO_PERSONAL_DIR: f.directory, RUUKOTO_DURABLE_CLI_KEY: "model", PATH: "path" });
  const profile = lockPersonalProfile(f.directory);
  try { savePersonalTelegram(profile, { version: 1, enabled: true, generation: randomUUID(), apiBase: "https://api.telegram.org", tokenEnv: "R38_BOT_TOKEN", tokenDigest: "a".repeat(64), botId: "1", ownerId: "42", boundary: 0 }); } finally { profile.release(); }
  const original = fs.readFileSync(path.join(f.directory, "telegram.json"));
  await assert.rejects(startPersonalServer(f.directory, { development: true }), code("development_im_enabled"));
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "telegram.json")), original);
  for (const name of ["personal.sqlite", "control.token", "control.sock"]) assert.equal(fs.existsSync(path.join(f.directory, name)), false);
  lockPersonalProfile(f.directory).release();
});

test("原生 watch 在源码重载前等待旧个人后台释放锁，忽略继承日常档案", async t => {
  const repo = temp(t), home = temp(t), daily = temp(t);
  fs.mkdirSync(path.join(repo, "apps/ruukoto"), { recursive: true });
  fs.cpSync(path.join(root, "apps/ruukoto/src"), path.join(repo, "apps/ruukoto/src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), '{"type":"module"}\n');
  fs.symlinkSync(path.join(root, "node_modules"), path.join(repo, "node_modules"));
  // Pi 1.3.0 随个人 app 单独解析，不从 Coding 的根版本取对象。
  fs.symlinkSync(path.join(root, "apps/ruukoto/node_modules"), path.join(repo, "apps/ruukoto/node_modules"));
  const directory = personalDevDirectory(repo, home), f = await fixture(t, directory);
  const watched = child(t, ["--import", "tsx", path.join(repo, "apps/ruukoto/src/dev.ts")], { ...f.env, HOME: home, RUUKOTO_PERSONAL_DIR: daily });
  await ready(directory, watched.process, watched.output);
  const token = fs.readFileSync(path.join(directory, "control.token"), "utf8");
  fs.appendFileSync(path.join(repo, "apps/ruukoto/src/dev.ts"), "\n// 重载验证。\n");
  await until(() => fs.readFileSync(path.join(directory, "control.token"), "utf8") !== token);
  await ready(directory, watched.process, watched.output);
  assert.doesNotMatch(watched.output(), /profile_busy|停止未核实/);
  assert.deepEqual(fs.readdirSync(daily), []);
  watched.process.kill("SIGTERM");
  await watched.closed;
  await until(() => { try { lockPersonalProfile(directory).release(); return true; } catch (error) { if (code("profile_busy")(error)) return false; throw error; } });
});
