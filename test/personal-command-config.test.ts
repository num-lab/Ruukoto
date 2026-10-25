import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import nodeOs from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parsePersonalCommands, readPersonalCommands, savePersonalCommands, verifyPersonalCommandConfig, personalCommandEnvironment, personalProtectedRoots } from "../apps/ruukoto/src/personal-command-config.ts";
import { personalReadPath } from "../apps/ruukoto/src/personal-tools-config.ts";
import { preparePersonalFile, executePersonalFile } from "../apps/ruukoto/src/personal-tool-io.ts";
import { assertGrantNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { configurePersonalCommands, launchPersonalServer, personalMenu } from "../apps/ruukoto/src/personal-cli.ts";
import { startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalMockModelServer as MockModelServer } from "./helpers/mock-provider.ts";
import { setTimeout as delay } from "node:timers/promises";

const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const machineId = "a".repeat(32);
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-command-config-")));
  const directory = path.join(root, "profile"), workspace = path.join(root, "files");
  fs.mkdirSync(workspace);
  lockPersonalProfile(directory).release();
  const stat = fs.statSync(workspace);
  const config = { version: 1, workspace, identity: { dev: stat.dev, ino: stat.ino }, machineId, tmpdir: fs.realpathSync(tmpdir()) } as const;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  const readFile = nodeFs.readFileSync;
  t.mock.method(nodeFs, "readFileSync", (target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => target === "/etc/machine-id" ? machineId + "\n" : readFile(target, options));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", platform); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, workspace, config };
}

test("个人命令配置：拒绝额外授权、相对路径及无效身份", t => {
  const f = fixture(t);
  assert.deepEqual(parsePersonalCommands(f.config), f.config);
  for (const invalid of [null, [], { ...f.config, version: 2 }, { ...f.config, workspace: "relative" }, { ...f.config, tmpdir: "/tmp\n" }, { ...f.config, machineId: "invalid" }, { ...f.config, identity: { dev: 1, ino: 0 } }, { ...f.config, identity: { ...f.config.identity, extra: true } }, { ...f.config, grantedPaths: [] }, { ...f.config, workerPath: "/other-worker" }]) assert.throws(() => parsePersonalCommands(invalid), code("command_config_invalid"));
});

test("个人命令配置：持锁私有保存与同机换目录，固定 worker 与空依赖", async t => {
  const f = fixture(t);
  await savePersonalCommands(f.directory, f.config);
  assert.equal(fs.statSync(path.join(f.directory, "command.json")).mode & 0o777, 0o600);
  const profile = lockPersonalProfile(f.directory);
  try {
    assert.deepEqual(readPersonalCommands(profile), f.config);
    await savePersonalCommands(profile, f.config);
    await assert.rejects(savePersonalCommands(f.directory, f.config), code("profile_busy"));
    const other = path.join(f.root, "other"); fs.mkdirSync(other); const stat = fs.statSync(other);
    const next = { ...f.config, workspace: other, identity: { dev: stat.dev, ino: stat.ino } };
    await savePersonalCommands(profile, next);
    assert.deepEqual(readPersonalCommands(profile), next);
    const environment = personalCommandEnvironment(f.directory, f.config);
    assert.equal(environment.directory, path.join(f.directory, "commands"));
    assert.equal(environment.native.workerPath, fileURLToPath(new URL("../worker/personal-command-worker.mjs", import.meta.url)));
    assert.deepEqual(environment.native.dependencyRoots, []);
    assert.ok(environment.native.protectedRoots.includes(f.directory));
    assert.ok(environment.native.protectedRoots.some(root => path.basename(root) === ".ruukoto"));
  } finally { profile.release(); }
});

test("个人命令配置：保护原档案、源码及其祖先，拒绝旧机器和目录替换", async t => {
  const f = fixture(t);
  for (const workspace of [f.directory, f.root, fs.realpathSync(process.cwd())]) {
    const { dev, ino } = fs.statSync(workspace);
    assert.throws(() => verifyPersonalCommandConfig({ ...f.config, workspace, identity: { dev, ino } }, f.directory), code("command_config_invalid"));
  }
  assert.throws(() => verifyPersonalCommandConfig({ ...f.config, machineId: "b".repeat(32) }, f.directory), code("command_config_changed"));
  assert.throws(() => verifyPersonalCommandConfig({ ...f.config, tmpdir: f.root }, f.directory), code("command_config_changed"));
  await savePersonalCommands(f.directory, f.config);
  fs.renameSync(f.workspace, f.workspace + "-old"); fs.mkdirSync(f.workspace);
  const profile = lockPersonalProfile(f.directory);
  try { assert.throws(() => readPersonalCommands(profile), code("command_config_changed")); }
  finally { profile.release(); }
});

test("个人权限：remote 根受现有 .config 保护，完全访问保留同账户例外", t => {
  const f = fixture(t), home = path.join(f.root, "home"), remote = path.join(home, ".config", "ruukoto-remote");
  fs.mkdirSync(remote, { recursive: true, mode: 0o700 });
  const filename = path.join(remote, "fixture.json"); fs.writeFileSync(filename, "fixture-only", { mode: 0o600 });
  t.mock.method(nodeOs, "homedir", () => home); syncBuiltinESMExports();
  const protectedRoots = personalProtectedRoots(f.directory), { dev, ino } = fs.statSync(remote);
  assert.ok(personalCommandEnvironment(f.directory, f.config).native.protectedRoots.includes(path.join(home, ".config")));
  for (const mode of ["confirm", "auto-review"] as const) {
    assert.throws(() => verifyPersonalCommandConfig({ ...f.config, workspace: remote, identity: { dev, ino } }, f.directory, mode), code("command_config_invalid"));
    assert.throws(() => personalReadPath(f.directory, remote, mode), code("tools_config_invalid"));
  }
  assert.throws(() => assertGrantNotProtected(remote, protectedRoots));
  assert.throws(() => preparePersonalFile({ path: filename, access: "read", protectedRoots }), PersonalError);
  verifyPersonalCommandConfig({ ...f.config, workspace: remote, identity: { dev, ino } }, f.directory, "full_access");
  assert.equal(personalReadPath(f.directory, remote, "full_access").path, remote);
  assert.equal(executePersonalFile(preparePersonalFile({ path: filename, access: "read", protectedRoots: [] })).bytes.toString(), "fixture-only");
});

test("个人命令配置：损坏和链接配置拒绝读取，不作为未配置继续", async t => {
  const f = fixture(t); const profile = lockPersonalProfile(f.directory);
  try {
    const filename = path.join(f.directory, "command.json");
    assert.equal(readPersonalCommands(profile), undefined);
    fs.writeFileSync(filename, "broken", { mode: 0o600 });
    assert.throws(() => readPersonalCommands(profile), code("command_config_invalid"));
    fs.rmSync(filename); fs.symlinkSync(path.join(f.root, "missing"), filename);
    assert.throws(() => readPersonalCommands(profile), code("command_config_invalid"));
    await assert.rejects(savePersonalCommands(profile, f.config), code("settings_history_invalid"));
  } finally { profile.release(); }
});

test("个人命令配置：完全访问不扫描保护树，仍核实目录机器和临时目录", t => {
  const f = fixture(t), readdir = nodeFs.readdirSync;
  let scans = 0;
  t.mock.method(nodeFs, "readdirSync", (...args: Parameters<typeof nodeFs.readdirSync>) => {
    if (String(args[0]) === f.directory) { scans++; throw new Error("保护树不可读"); }
    return Reflect.apply(readdir, nodeFs, args);
  }); syncBuiltinESMExports();
  verifyPersonalCommandConfig(f.config, f.directory, "full_access"); assert.equal(scans, 0);
  for (const mode of ["confirm", "auto-review"] as const) assert.throws(() => verifyPersonalCommandConfig(f.config, f.directory, mode), code("command_config_invalid"));
  assert.equal(scans, 2);
  for (const changed of [{ ...f.config, machineId: "b".repeat(32) }, { ...f.config, tmpdir: f.root }]) assert.throws(() => verifyPersonalCommandConfig(changed, f.directory, "full_access"), code("command_config_changed"));
  fs.renameSync(f.workspace, f.workspace + "-original"); fs.mkdirSync(f.workspace);
  assert.throws(() => verifyPersonalCommandConfig(f.config, f.directory, "full_access"), code("command_config_changed"));
});

test("个人档案：命令证据目录保留私有目录权限，拒绝链接与开放权限", t => {
  const f = fixture(t); const directory = path.join(f.directory, "commands");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "evidence"), "original", { mode: 0o600 });
  lockPersonalProfile(f.directory).release();
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(directory, "evidence"), "utf8"), "original");
  fs.chmodSync(directory, 0o755);
  assert.throws(() => lockPersonalProfile(f.directory), code("profile_unrecognized"));
  assert.throws(() => personalCommandEnvironment(f.directory, f.config), code("command_config_invalid"));
  fs.chmodSync(directory, 0o700); fs.renameSync(directory, directory + "-old"); fs.symlinkSync(directory + "-old", directory);
  assert.throws(() => lockPersonalProfile(f.directory), code("profile_unrecognized"));
  assert.throws(() => personalCommandEnvironment(f.directory, f.config), code("command_config_invalid"));
});

test("个人命令配置：前台与 detached 启动先拒绝坏版本，零模型请求", async t => {
  const f = fixture(t); const server = new MockModelServer(() => ({ kind: "text", text: "不应请求" }));
  const baseUrl = await server.start(); t.after(() => server.close());
  const key = "RUUKOTO_COMMAND_START_TEST_KEY", before = process.env[key]; process.env[key] = "test-only";
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  fs.writeFileSync(path.join(f.directory, "model.json"), JSON.stringify({ api: "openai-completions", baseUrl, modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 1024 }) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, "command.json"), JSON.stringify({ ...f.config, version: 2 }), { mode: 0o600 });
  await assert.rejects(startPersonalServer(f.directory), code("command_config_invalid"));
  await assert.rejects(launchPersonalServer(f.directory), code("command_config_invalid"));
  assert.equal(fs.existsSync(path.join(f.directory, "control.sock")), false);
  assert.equal(server.calls.length, 0);
  lockPersonalProfile(f.directory).release();
});

test("个人命令配置：离线保存不依赖无关未决输入，也不调用模型或启动后台", async t => {
  const f = fixture(t); let blocked = true;
  const server = new MockModelServer(() => blocked ? new Promise(() => {}) : { kind: "text", text: "完成" });
  const baseUrl = await server.start();
  t.after(() => server.close());
  const key = "RUUKOTO_COMMAND_CONFIG_TEST_KEY"; const before = process.env[key]; process.env[key] = "test-only";
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  const provider = personalProvider({ api: "openai-completions", baseUrl, modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 1024 });
  const personal = await openPersonalHarness({ directory: f.directory, provider, modelId: "mock-model" });
  try {
    await personal.submit("待处理", "owner");
    const deadline = Date.now() + 10000;
    while (!server.calls.length) { assert.ok(Date.now() < deadline, "等待原模型请求超时"); await delay(10); }
  } finally { await personal.close(); }
  const requests = server.calls.length;
  await savePersonalCommands(f.directory, f.config);
  assert.equal(fs.existsSync(path.join(f.directory, "command.json")), true);
  assert.equal(fs.existsSync(path.join(f.directory, "control.sock")), false);
  assert.equal(server.calls.length, requests);
  blocked = false;
  const resumed = await openPersonalHarness({ directory: f.directory, provider, modelId: "mock-model" });
  try { await resumed.answer("处理完成", "next"); }
  finally { await resumed.close(); }
  await savePersonalCommands(f.directory, f.config);
  assert.equal(fs.existsSync(path.join(f.directory, "command.json")), true);
});

test("个人命令配置向导：分组入口返回不写，选择目录后固定保存", async t => {
  const f = fixture(t); let output = ""; const answers = ["5", "5", "2", "/back", "7"];
  await personalMenu(f.directory, { question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: value => { output += value; } });
  assert.equal(fs.existsSync(path.join(f.directory, "command.json")), false);
  assert.match(output, /5\. 配置或查看命令目录/);
  assert.match(output, /7\. 退出向导/);
  const selected = ["2", f.workspace, "2"];
  await configurePersonalCommands({ question: async () => selected.shift()!, write: value => { output += value; } }, f.directory);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, "command.json"), "utf8")), f.config);
  await configurePersonalCommands({ question: async () => "1", write: value => { output += value; } }, f.directory);
  assert.match(output, /当前命令目录/);
});
