import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { personalControl, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { executePersonalMaintenance, parsePersonalMaintenanceRequest, runPersonalMaintenanceMachine, validatePersonalMaintenanceUnit } from "../apps/ruukoto/src/personal-maintenance.ts";

const program = fileURLToPath(new URL("../apps/ruukoto/bin/ruukoto.mjs", import.meta.url));
const code = (value: string) => (error: unknown) => error instanceof PersonalError && error.code === value;
async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-maint-"))), directory = path.join(root, "personal");
  const config = { api: "openai-completions", baseUrl: "https://example.com/v1", modelId: "model", apiKeyEnv: `MAINT_${randomUUID().replaceAll("-", "_").toUpperCase()}`, contextWindow: 4096, maxTokens: 32 };
  await savePersonalConfig(directory, config);
  process.env[config.apiKeyEnv] = "original-shell-is-not-service-environment";
  t.after(() => { delete process.env[config.apiKeyEnv]; fs.rmSync(root, { recursive: true, force: true }); });
  const request = { v: 1, op: "inspect", lifecycle: "cli", program } as const;
  return { root, directory, config, request };
}

async function machine(directory: string, value: unknown) {
  let output = "";
  const status = await runPersonalMaintenanceMachine(directory, (async function* () { yield JSON.stringify(value); })(), value => { output += value; });
  return { status, output, body: JSON.parse(output) };
}

function unit(directory: string): Record<string, string> {
  return { Id: "ruukoto-backend.service", LoadState: "loaded", ActiveState: "inactive", SubState: "dead", MainPID: "0", User: os.userInfo().username, ExecStart: `{ path=${fs.realpathSync(process.execPath)} ; argv[]=${fs.realpathSync(process.execPath)} ${program} serve --directory ${directory} ; ignore_errors=no ; start_time=[n/a] ; }`, SendSIGKILL: "no", KillMode: "control-group", KillSignal: "15", TimeoutStopFailureMode: "terminate", NeedDaemonReload: "no", Type: "simple", RefuseManualStart: "no", RefuseManualStop: "no", ExecStop: "", ExecStopPost: "" };
}

function fakeSystemd(t: TestContext, properties: Record<string, string>, rejected = "", action?: (args: string[]) => Promise<"hold" | number>) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  const calls: { file: string; args: string[] }[] = [], signals: (NodeJS.Signals | number | undefined)[] = [];
  t.mock.method(childProcess, "spawn", (file: string, args: string[]) => {
    calls.push({ file, args });
    const child = new childProcess.ChildProcess(), stdout = new PassThrough();
    Object.defineProperty(child, "stdout", { value: stdout });
    child.kill = signal => { signals.push(signal); queueMicrotask(() => child.emit("close", null)); return true; };
    queueMicrotask(async () => {
      let result = args.includes(rejected) ? 1 : 0;
      if (file === "/usr/bin/sudo" && !args.includes("-l") && action) { const effect = await action(args); if (effect === "hold") return; result = effect; }
      if (file === "/usr/bin/systemctl") stdout.write(Object.entries(properties).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
      stdout.end(); child.emit("close", result);
    });
    return child;
  });
  t.after(() => { t.mock.restoreAll(); Object.defineProperty(process, "platform", platform); });
  return { calls, signals };
}

test("维护机器入口拒绝未知操作、版本、自由单元与参数注入，不创建不存在的档案", async t => {
  const f = await fixture(t);
  for (const request of [{ ...f.request, v: 7 }, { ...f.request, op: "exec", command: "secret" }, { ...f.request, unit: "other.service" }, { ...f.request, program: "/bin/tool\nsecret" }, { ...f.request, lifecycle: "shell" }, { ...f.request, op: "stop" }]) {
    const result = await machine(f.directory, request); assert.equal(result.status, 1); assert.equal(result.body.code, "maintenance_request_invalid"); assert.ok(!result.output.includes("secret"));
  }
  const missing = path.join(f.root, "missing");
  assert.equal((await machine(missing, f.request)).body.code, "maintenance_profile_missing"); assert.equal(fs.existsSync(missing), false);
  assert.throws(() => parsePersonalMaintenanceRequest({ ...f.request, profile: { directory: f.directory, id: "arbitrary" } }), code("maintenance_request_invalid"));
  let output = "";
  assert.equal(await runPersonalMaintenanceMachine(f.directory, (async function* () { yield "x".repeat(128 * 1024 + 1); })(), value => { output += value; }), 1); assert.equal(JSON.parse(output).code, "maintenance_request_large");
});

test("CLI 原启动环境未知保持只读，SSH shell 存在凭据也不证明可恢复；错档案与争锁拒绝", async t => {
  const f = await fixture(t), before = fs.readFileSync(path.join(f.directory, "model.json"), "utf8");
  const state = await executePersonalMaintenance(f.directory, f.request);
  assert.equal(state.online, false); assert.equal(state.writable, false); assert.equal(state.lifecycle.originalEnvironment, "unverified"); assert.equal(state.code, "maintenance_environment_unverified");
  await assert.rejects(executePersonalMaintenance(f.directory, { ...f.request, op: "stop", profile: state.profile }), code("maintenance_environment_unverified"));
  await assert.rejects(executePersonalMaintenance(f.directory, { ...f.request, profile: { ...state.profile, id: `sha256:${"0".repeat(64)}` } }), code("maintenance_profile_changed"));
  const lock = lockPersonalProfile(f.directory);
  try { await assert.rejects(executePersonalMaintenance(f.directory, f.request), code("profile_busy")); } finally { lock.release(); }
  assert.equal(fs.readFileSync(path.join(f.directory, "model.json"), "utf8"), before); assert.ok(!JSON.stringify(state).includes(process.env[f.config.apiKeyEnv]!));
});

test("实际后台标记开发受管时拒绝 systemd 接管，退出后仍可重新持锁", async t => {
  const f = await fixture(t), server = await startPersonalServer(f.directory, { development: true });
  try {
    const state = await executePersonalMaintenance(f.directory, { ...f.request, lifecycle: "systemd" });
    assert.equal(state.online, true); assert.equal(state.writable, false); assert.equal(state.lifecycle.managedDevelopment, true); assert.equal(state.code, "maintenance_development_readonly");
    await assert.rejects(executePersonalMaintenance(f.directory, { ...f.request, op: "stop", lifecycle: "systemd", profile: state.profile }), code("maintenance_development_readonly"));
  } finally { await server.stop(); }
  const lock = lockPersonalProfile(f.directory); lock.release();
});

test("部署检查拒绝默认超时强杀、停止脚本、错账户、旧入口与错档案，接受同目标程序链接", async t => {
  const f = await fixture(t), properties = unit(f.directory), expected = { program, directory: f.directory, node: fs.realpathSync(process.execPath), user: os.userInfo().username, uid: process.getuid!() };
  validatePersonalMaintenanceUnit(properties, expected);
  const invalid: Record<string, string>[] = [{ SendSIGKILL: "yes" }, { TimeoutStopFailureMode: "abort" }, { TimeoutStopFailureMode: "kill" }, { KillSignal: "9" }, { ExecStop: "/bin/kill -9" }, { User: "someone-else" }, { NeedDaemonReload: "yes" }, { ExecStart: properties.ExecStart.replace(" serve --directory " + f.directory, " serve") }, { ExecStart: properties.ExecStart.replace(f.directory, f.root) }, { Id: "alias.service" }];
  for (const changes of invalid) assert.throws(() => validatePersonalMaintenanceUnit({ ...properties, ...changes }, expected), PersonalError);
  const link = path.join(f.root, "ruukoto-link"); fs.symlinkSync(program, link);
  validatePersonalMaintenanceUnit(properties, { ...expected, program: link });
  const template = fs.readFileSync(new URL("../deploy/systemd/ruukoto-backend.service", import.meta.url), "utf8");
  assert.match(template, /^SendSIGKILL=no$/m); assert.match(template, /^TimeoutStopFailureMode=terminate$/m); assert.match(template, /serve --directory \/var\/lib\/ruukoto\/personal-durable/);
  const sudoers = fs.readFileSync(new URL("../deploy/systemd/sudoers.d.ruukoto-settings", import.meta.url), "utf8");
  assert.match(sudoers, /\/usr\/bin\/systemctl start ruukoto-backend\.service, \/usr\/bin\/systemctl stop ruukoto-backend\.service/); assert.ok(!sudoers.includes("*"));
});

test("systemd 离线检查要求精确启停授权与实际固定单元，不读取 EnvironmentFile", async t => {
  const f = await fixture(t), properties = unit(f.directory), { calls } = fakeSystemd(t, properties);
  const state = await executePersonalMaintenance(f.directory, { ...f.request, lifecycle: "systemd" });
  assert.equal(state.online, false); assert.equal(state.writable, true); assert.equal(state.lifecycle.originalEnvironment, "unverified");
  assert.deepEqual(calls.filter(call => call.file === "/usr/bin/sudo").map(call => call.args), [["-n", "-l", "/usr/bin/systemctl", "start", "ruukoto-backend.service"], ["-n", "-l", "/usr/bin/systemctl", "stop", "ruukoto-backend.service"]]);
  assert.ok(!calls.some(call => call.args.join(" ").includes("Environment")));
  await assert.rejects(executePersonalMaintenance(f.directory, { ...f.request, lifecycle: "systemd", op: "stop", profile: state.profile }), code("maintenance_already_stopped"));
  assert.ok(!calls.some(call => call.file === "/usr/bin/sudo" && !call.args.includes("-l")));
});

test("缺精确 stop 授权只读且不能启动，原档案保持", async t => {
  const f = await fixture(t), { calls } = fakeSystemd(t, unit(f.directory), "stop");
  const state = await executePersonalMaintenance(f.directory, { ...f.request, lifecycle: "systemd" });
  assert.equal(state.writable, false); assert.equal(state.code, "maintenance_authorization_missing");
  await assert.rejects(executePersonalMaintenance(f.directory, { ...f.request, lifecycle: "systemd", op: "start", profile: state.profile }), code("maintenance_authorization_missing"));
  assert.ok(!calls.some(call => !call.args.includes("-l") && call.file === "/usr/bin/sudo"));
});

function runningProcess(t: TestContext, directory: string, alive: () => boolean) {
  const read = nodeFs.readFileSync, realpath = nodeFs.realpathSync, exists = nodeFs.existsSync;
  t.mock.method(nodeFs, "readFileSync", (target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (target === "/proc/sys/kernel/random/boot_id") return "12345678-1234-1234-1234-123456789abc";
    if (target === `/proc/${process.pid}/stat`) { if (!alive()) throw Object.assign(new Error("gone"), { code: "ENOENT" }); return `${process.pid} (node) ${["S", "1", String(process.pid), ...Array(16).fill("0"), "123"].join(" ")}`; }
    if (target === `/proc/${process.pid}/status`) return `Uid:\t${process.getuid!()} ${process.getuid!()} ${process.getuid!()} ${process.getuid!()}\n`;
    if (target === `/proc/${process.pid}/cmdline`) return [process.execPath, program, "serve", "--directory", directory, ""].join("\0");
    return read(target, options);
  });
  t.mock.method(nodeFs, "realpathSync", (target: fs.PathLike, options?: Parameters<typeof fs.realpathSync>[1]) => realpath(target === `/proc/${process.pid}/exe` ? process.execPath : target, options));
  t.mock.method(nodeFs, "existsSync", (target: fs.PathLike) => target === `/proc/${process.pid}/stat` ? alive() : exists(target));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("受控 systemd 停止原监督者，确认原进程退出与档案锁；随后按原服务显式启动", async t => {
  const f = await fixture(t); let server = await startPersonalServer(f.directory), alive = true;
  const properties = { ...unit(f.directory), ActiveState: "active", SubState: "running", MainPID: String(process.pid) };
  const { calls } = fakeSystemd(t, properties, "", async args => {
    assert.deepEqual(args, ["-n", "/usr/bin/systemctl", args[2], "ruukoto-backend.service"]);
    if (args[2] === "stop") { await server.stop(); alive = false; Object.assign(properties, { ActiveState: "inactive", SubState: "dead", MainPID: "0" }); }
    else { server = await startPersonalServer(f.directory); alive = true; Object.assign(properties, { ActiveState: "active", SubState: "running", MainPID: String(process.pid) }); }
    return 0;
  });
  runningProcess(t, f.directory, () => alive);
  try {
    const inspected = await executePersonalMaintenance(f.directory, { ...f.request, lifecycle: "systemd" }); assert.equal(inspected.writable, true);
    const request = { ...f.request, lifecycle: "systemd", profile: inspected.profile };
    const stopped = await executePersonalMaintenance(f.directory, { ...request, op: "stop" });
    assert.equal(stopped.lifecycle.state, "stopped"); assert.equal(stopped.code, "maintenance_stopped");
    const lock = lockPersonalProfile(f.directory); lock.release();
    const started = await executePersonalMaintenance(f.directory, { ...request, op: "start" });
    assert.equal(started.online, true); assert.equal(started.code, "maintenance_started");
    assert.equal(calls.filter(call => call.file === "/usr/bin/sudo" && !call.args.includes("-l")).length, 2);
  } finally { await server.stop(); }
});

test("停止命令超时只回收本次客户端，后台与原档案锁仍保留，不发送强杀服务命令", { timeout: 10_000 }, async t => {
  const f = await fixture(t), server = await startPersonalServer(f.directory), before = fs.readFileSync(path.join(f.directory, "model.json"), "utf8");
  let reached!: () => void; const stopRequested = new Promise<void>(resolve => { reached = resolve; });
  const properties = { ...unit(f.directory), ActiveState: "active", SubState: "running", MainPID: String(process.pid) };
  const { calls, signals } = fakeSystemd(t, properties, "", async () => { reached(); return "hold"; });
  runningProcess(t, f.directory, () => true);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const inspected = await executePersonalMaintenance(f.directory, { ...f.request, lifecycle: "systemd" });
    const pending = executePersonalMaintenance(f.directory, { ...f.request, lifecycle: "systemd", op: "stop", profile: inspected.profile });
    const rejected = assert.rejects(pending, code("maintenance_result_unverified"));
    await stopRequested; t.mock.timers.tick(40_000); await rejected;
    assert.deepEqual(signals, ["SIGTERM"]); assert.throws(() => lockPersonalProfile(f.directory), code("profile_busy"));
    assert.equal(fs.readFileSync(path.join(f.directory, "model.json"), "utf8"), before);
    assert.ok(!calls.some(call => call.args.some(arg => /kill|restart/.test(arg))));
  } finally { t.mock.timers.reset(); await server.stop(); }
});

test("serve --directory 使用固定档案而非 SSH shell 的目录环境，信号退出后释放锁", async t => {
  const f = await fixture(t), decoy = path.join(f.root, "shell-directory");
  const child = childProcess.spawn(process.execPath, [program, "serve", "--directory", f.directory], { env: { ...process.env, RUUKOTO_PERSONAL_DIR: decoy }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<number | null>(resolve => child.on("close", resolve));
  try {
    let online = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await personalControl(f.directory, "GET", "/status"); online = true; break; } catch { /* 仅等待本测试子进程完成启动，失败由下方断言报告。 */ }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(online, true, stderr); assert.equal(fs.existsSync(decoy), false);
    const state = await executePersonalMaintenance(f.directory, f.request); assert.equal(state.online, true); assert.equal(state.writable, false);
  } finally { child.kill("SIGTERM"); await closed; }
  assert.equal(child.exitCode, 0, stderr);
  const lock = lockPersonalProfile(f.directory); lock.release();
});
