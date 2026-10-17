import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";

const UNIT = "example.service";
const OP = "op_0123456789abcdef01234567";
const INSPECTION = "inspect_0123456789abcdef01234567";
const MACHINE = "isolated-machine";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, "等待隔离 helper 超时"); await delay(5); }
}
function fixture(t: TestContext, patch: (source: string, directory: string) => string = source => source) {
  const root = process.getuid!() === 0;
  const directory = fs.mkdtempSync(path.join(root ? "/opt" : tmpdir(), "rk-helper-stop-"));
  fs.chmodSync(directory, 0o755);
  const state = path.join(directory, "state");
  fs.mkdirSync(state, { mode: 0o777 });
  fs.chmodSync(state, 0o777);
  fs.mkdirSync(path.join(directory, "ops"), { mode: 0o700 });
  const helper = path.join(directory, "helper.mjs");
  const policy = JSON.stringify({ machineId: "isolated-machine", inspectUid: root ? 1000 : process.getuid!(), inspectGid: root ? 1000 : process.getgid!(), services: { [UNIT]: { actions: ["restart"] } } });
  fs.writeFileSync(path.join(directory, "policy.json"), policy);
  fs.writeFileSync(path.join(directory, "machine-id"), "isolated-machine");
  fs.writeFileSync(path.join(directory, "example.service"), "isolated unit");
  let source = fs.readFileSync(new URL("../deploy/systemd/ruukoto-service.mjs", import.meta.url), "utf8");
  for (const [name, value] of Object.entries({ POLICY_PATH: path.join(directory, "policy.json"), OPS_DIR: path.join(directory, "ops"), MACHINE_ID_PATH: path.join(directory, "machine-id"), SYSTEMCTL: path.join(directory, "systemctl.mjs"), SYSTEMD_RUN: path.join(directory, "systemd-run.mjs") })) {
    source = source.replace(new RegExp(`const ${name} = "[^"]+";`), `const ${name} = ${JSON.stringify(value)};`);
  }
  source = source.replace("const STOP_TIMEOUT_MS = 8000;", "const STOP_TIMEOUT_MS = 150;").replace("const STOP_POLL_MS = 200;", "const STOP_POLL_MS = 5;");
  if (!root) {
    // 非 root CI 只验证进程竞态；root Linux 运行同一用例时保留全部部署信任校验。
    for (const line of ["  assertTrustedPath(POLICY_PATH, \"策略\");\n", "  assertTrustedPath(OPS_DIR, \"操作标记目录\");\n", "  assertTrustedPath(fs.realpathSync(process.argv[1]), \"helper 自身\");\n"]) source = source.replace(line, "");
    source = source.replace("if (process.getuid?.() !== 0)", "if (false)");
  }
  fs.writeFileSync(helper, patch(source, directory), { mode: 0o700 });
  const prefix = `#!${process.execPath}\nimport * as fs from "node:fs"; const state = ${JSON.stringify(state)}; const wait = () => { while (!fs.existsSync(state + "/release")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); };\n`;
  fs.writeFileSync(path.join(directory, "systemctl.mjs"), prefix + `const args = process.argv.slice(2); if (args[1] === "stop") { fs.rmSync(state + "/unit-present", { force: true }); process.exit(0); } const unit = args[2]; if (unit.startsWith("ruukoto-service-op-")) { process.stdout.write(fs.existsSync(state + "/unit-present") ? "LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=1\\nControlPID=0\\n" : "LoadState=not-found\\n"); process.exit(0); } if (fs.existsSync(state + "/hold-show")) { fs.writeFileSync(state + "/ready", "show"); wait(); } process.stdout.write(${JSON.stringify(`Id=${UNIT}\nFragmentPath=${path.join(directory, "example.service")}\nDropInPaths=\nNeedDaemonReload=no\n`)});`, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, "systemd-run.mjs"), prefix + `if (fs.existsSync(state + "/hold-run")) { fs.writeFileSync(state + "/ready", String(process.pid)); wait(); } fs.appendFileSync(state + "/dispatches", "dispatch\\n");`, { mode: 0o755 });
  const children: ChildProcess[] = [];
  t.after(async () => {
    fs.writeFileSync(path.join(state, "release"), "release");
    for (const child of children) {
      try { child.kill("SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      // 只有本夹具创建的独立组才可回收；非首领反例继承测试进程的组。
      try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      if (child.exitCode === null && child.signalCode === null) await once(child, "close");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const invoke = (args: string[], detached = true) => {
    const bootstrap = 'import { spawn } from "node:child_process"; const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "inherit" }); child.on("error", error => { process.stderr.write(error.message); process.exitCode = 1; }); child.on("exit", code => { process.exitCode = code ?? 1; });';
    const result = spawnSync(process.execPath, [...(detached ? ["--input-type=module", "--eval", bootstrap] : []), helper, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined);
    const line = result.stderr.split("\n").find(line => line.startsWith("RUUKOTO_SERVICE_REPLY "));
    assert.ok(line, result.stderr);
    return { ...result, reply: JSON.parse(line.slice("RUUKOTO_SERVICE_REPLY ".length)) as { v: number; verb: string; ok: boolean; machineId: string; inspectionId: string; unit: string; launcherExited: boolean; exited: boolean; reasonCode?: string } };
  };
  const start = (args: string[], detached = true) => {
    const child = spawn(process.execPath, [helper, ...args], { detached, stdio: ["ignore", "ignore", "pipe"] });
    children.push(child);
    return child;
  };
  const stop = () => { const result = invoke(["stop-op", OP]); assert.equal(result.status, 0, result.stderr); return result.reply; };
  return { directory, state, helper, children, invoke, startHelper: start, stop,
    inspect: () => start(["inspect-op", INSPECTION, MACHINE, UNIT]),
    stopInspection: () => { const result = invoke(["stop-inspect", INSPECTION, MACHINE]); assert.equal(result.status, 0, result.stderr); assert.equal(result.reply.machineId, MACHINE); assert.equal(result.reply.inspectionId, INSPECTION); return result.reply; },
    start: () => {
      const revision = sha(JSON.stringify({ files: [{ path: path.join(directory, "example.service"), sha256: sha("isolated unit") }], needDaemonReload: "no" }));
      return start(["restart", OP, sha(policy), revision, UNIT]);
    },
  };
}

test("helper 停止：检查停止标记后尚未派发的启动器不能被 not-found 误判为停止", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, "hold-show"), "hold");
  const child = f.start();
  const closed = once(child, "close");
  await until(() => fs.existsSync(path.join(f.state, "ready")));
  const stopping = f.stop();
  assert.equal(stopping.launcherExited, false);
  assert.equal(stopping.exited, false);
  assert.equal(fs.existsSync(path.join(f.state, "dispatches")), false);
  fs.writeFileSync(path.join(f.state, "release"), "release");
  assert.equal((await closed)[0], 0);
  assert.equal(fs.readFileSync(path.join(f.state, "dispatches"), "utf8"), "dispatch\n");
  assert.equal(f.stop().launcherExited, true);
  assert.equal(f.stop().exited, true);
});

test("helper 检查身份：真实后台强杀后旧 detached 检查仍占用，退出后才可核实", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, "hold-show"), "hold");
  const backend = spawn(process.execPath, ["--input-type=module", "--eval", `import { spawn } from "node:child_process"; spawn(process.execPath, ${JSON.stringify([f.helper, "inspect-op", INSPECTION, MACHINE, UNIT])}, { detached: true, stdio: "ignore" }); setInterval(() => {}, 1000);`], { stdio: "ignore" });
  f.children.push(backend);
  const claimFile = path.join(f.directory, "ops", INSPECTION, "claim.json");
  await until(() => fs.existsSync(path.join(f.state, "ready")));
  const claim = JSON.parse(fs.readFileSync(claimFile, "utf8"));
  t.after(() => { try { process.kill(-claim.launcher.processGroup, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } });
  const closed = once(backend, "close");
  backend.kill("SIGKILL");
  await closed;
  assert.equal(process.kill(claim.launcher.pid, 0), true);
  assert.equal(f.stopInspection().exited, false);
  fs.writeFileSync(claimFile, JSON.stringify({ ...claim, launcher: { ...claim.launcher, startTime: "0" } }));
  assert.equal(f.stopInspection().exited, false, "PID 身份已不同仍须观察原组，复用只能保守保留");
  fs.writeFileSync(claimFile, JSON.stringify(claim));
  assert.equal(f.invoke(["inspect-op", INSPECTION, MACHINE, UNIT]).reply.reasonCode, "already_claimed");
  fs.writeFileSync(path.join(f.state, "release"), "release");
  await until(() => f.stopInspection().exited);
  assert.equal(f.stopInspection().exited, true, "后续核实仍沿原持久身份");
});

test("helper 检查身份：原 helper 已死但同组 systemctl 仍活，不能释放", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, "hold-show"), "hold");
  const child = f.inspect();
  const closed = once(child, "close");
  await until(() => fs.existsSync(path.join(f.state, "ready")));
  child.kill("SIGKILL");
  await closed;
  assert.equal(f.stopInspection().exited, false);
  fs.writeFileSync(path.join(f.state, "release"), "release");
  await until(() => f.stopInspection().exited);
});

test("helper 检查身份：停止先手和已结束检查均禁止同键重启，机器与旧协议不能混用", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  const claimDir = path.join(f.directory, "ops", INSPECTION);
  for (const args of [
    ["inspect-op", INSPECTION, "other-machine", UNIT], ["stop-inspect", INSPECTION, "other-machine"],
    ["inspect-op", OP, MACHINE, UNIT], ["stop-inspect", OP, MACHINE],
    ["inspect-op", INSPECTION, MACHINE], ["stop-inspect", INSPECTION, MACHINE, UNIT],
  ]) assert.equal(f.invoke(args).reply.ok, false);
  assert.equal(fs.existsSync(claimDir), false, "身份拒绝必须先于认领");
  assert.equal(f.stopInspection().exited, true);
  assert.equal(f.invoke(["inspect-op", INSPECTION, MACHINE, UNIT]).reply.reasonCode, "already_claimed");
  assert.equal(fs.existsSync(path.join(f.state, "ready")), false);
  assert.equal(f.invoke(["stop-op", INSPECTION]).reply.reasonCode, "op_invalid");
  fs.rmSync(claimDir, { recursive: true });
  const result = f.invoke(["inspect-op", INSPECTION, MACHINE, UNIT], false);
  assert.equal(result.reply.ok, true, "sudo 可能保留同组监护进程，helper 不必是组首领");
  assert.equal(f.stopInspection().exited, false, "继承的组仍有调用者，不能仅凭 helper 已退出判停");
  fs.rmSync(claimDir, { recursive: true });
  const child = f.inspect();
  const stderr: Buffer[] = [];
  child.stderr!.on("data", chunk => stderr.push(chunk));
  assert.equal((await once(child, "close"))[0], 0);
  const response = JSON.parse(Buffer.concat(stderr).toString().split("RUUKOTO_SERVICE_REPLY ")[1]);
  assert.equal(response.inspectionId, INSPECTION);
  assert.equal(response.machineId, MACHINE);
  assert.equal(response.unit, UNIT);
  assert.equal(response.verb, "inspect-op");
  assert.equal(f.stopInspection().exited, true);
  assert.equal(f.invoke(["inspect-op", INSPECTION, MACHINE, UNIT]).reply.reasonCode, "already_claimed");
});

test("helper 检查身份：半写、损坏、错绑及非法 launcher 均保留占用，跨 boot 也先验完整身份", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  const claimDir = path.join(f.directory, "ops", INSPECTION);
  fs.mkdirSync(claimDir);
  const base = { version: 1, claimedBy: "inspect-op", inspectionId: INSPECTION, machineId: MACHINE, unit: UNIT, launcher: { pid: 2147483646, processGroup: 2147483646, startTime: "1", bootId: "00000000-0000-0000-0000-000000000000" } };
  for (const claim of [undefined, "{", "null", JSON.stringify({ version: 2, claimedBy: "stop-op" }), ...[
    { ...base, inspectionId: INSPECTION + "0" }, { ...base, machineId: "other-machine" }, { ...base, unit: "../bad.service" },
    { ...base, claimedBy: "restart" }, { ...base, launcher: {} }, { ...base, launcher: { ...base.launcher, startTime: undefined } },
    { ...base, launcher: { ...base.launcher, processGroup: 0 } }, { ...base, launcher: { ...base.launcher, bootId: "invalid" } },
  ].map(value => JSON.stringify(value))]) {
    if (claim !== undefined) fs.writeFileSync(path.join(claimDir, "claim.json"), claim);
    assert.equal(f.stopInspection().exited, false);
  }
  fs.writeFileSync(path.join(claimDir, "claim.json"), JSON.stringify(base));
  assert.equal(f.stopInspection().exited, true, "完整原身份在其他 boot 已不可能运行");
});

test("helper 检查身份：认领到启动窗口收到停止标记时不执行 systemctl", { skip: process.platform !== "linux" }, async t => {
  // 只在夹具源码中暂停完整 claim 写入前，打开 mkdir 已完成的精确窗口。
  const f = fixture(t, (source, directory) => source.replace('    claimInspection(claimDir);', `    claimInspection(claimDir);\n    fs.writeFileSync(${JSON.stringify(path.join(directory, "state", "claimed"))}, "ready"); while (!fs.existsSync(${JSON.stringify(path.join(directory, "state", "release"))})) sleepMs(5);`));
  fs.writeFileSync(path.join(f.state, "hold-show"), "hold");
  const child = f.inspect();
  const stderr: Buffer[] = [];
  child.stderr!.on("data", chunk => stderr.push(chunk));
  const closed = once(child, "close");
  await until(() => fs.existsSync(path.join(f.state, "claimed")));
  assert.equal(f.stopInspection().exited, false, "半写 claim 不能作为停止证明");
  fs.writeFileSync(path.join(f.state, "release"), "release");
  assert.equal((await closed)[0], 64);
  assert.match(Buffer.concat(stderr).toString(), /stop_requested/);
  assert.equal(fs.existsSync(path.join(f.state, "ready")), false, "停止标记阻止实际 show");
  assert.equal(f.stopInspection().exited, true);
});

test("helper 检查身份：检查过停止标记但尚未 spawn 时，活启动器阻止提前判停", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t, (source, directory) => source.replace('  const props = systemctlShow(unit, inspectUid, inspectGid);', `  fs.writeFileSync(${JSON.stringify(path.join(directory, "state", "before-spawn"))}, "ready"); while (!fs.existsSync(${JSON.stringify(path.join(directory, "state", "release"))})) sleepMs(5);\n  const props = systemctlShow(unit, inspectUid, inspectGid);`));
  const child = f.inspect();
  const closed = once(child, "close");
  await until(() => fs.existsSync(path.join(f.state, "before-spawn")));
  assert.equal(f.stopInspection().exited, false);
  fs.writeFileSync(path.join(f.state, "release"), "release");
  assert.equal((await closed)[0], 0);
  assert.equal(f.stopInspection().exited, true);
});

test("helper 检查身份：原组或 proc 观察失败不能形成停止证明", { skip: process.platform !== "linux" }, async t => {
  for (const observation of ["group", "proc"] as const) await t.test(observation, async t => {
    const f = fixture(t, source => observation === "group"
      ? source.replace('process.kill(-id.processGroup, 0);', 'throw Object.assign(new Error("isolated observation denied"), { code: "EPERM" });')
      : source.replace('fields = fs.readFileSync(`/proc/${id.pid}/stat`, "utf8").split(/\\) /).at(-1).split(" ");', 'throw Object.assign(new Error("isolated proc denied"), { code: "EACCES" });'));
    const child = f.inspect();
    assert.equal((await once(child, "close"))[0], 0);
    assert.equal(f.stopInspection().exited, false);
  });
});

test("helper 停止：helper 已死但 systemd-run 后代仍可能派发时保留占用", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, "hold-run"), "hold");
  const child = f.start();
  const closed = once(child, "close");
  await until(() => fs.existsSync(path.join(f.state, "ready")));
  child.kill("SIGKILL");
  await closed;
  assert.equal(f.stop().launcherExited, false);
  assert.equal(f.stop().exited, false);
  fs.writeFileSync(path.join(f.state, "release"), "release");
  await until(() => fs.existsSync(path.join(f.state, "dispatches")));
  assert.equal(fs.readFileSync(path.join(f.state, "dispatches"), "utf8"), "dispatch\n");
});

test("helper 停止：旧、缺失或损坏认领不提供停止证明；先手停止认领阻止新启动", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  const claimDir = path.join(f.directory, "ops", OP);
  for (const claim of [undefined, "{", JSON.stringify({ unit: UNIT }), JSON.stringify({ version: 2, claimedBy: "restart", launcher: {} })]) {
    fs.mkdirSync(claimDir, { recursive: true, mode: 0o700 });
    if (claim !== undefined) fs.writeFileSync(path.join(claimDir, "claim.json"), claim);
    assert.equal(f.stop().launcherExited, false);
    assert.equal(f.stop().exited, false);
    fs.rmSync(claimDir, { recursive: true });
  }
  assert.equal(f.stop().launcherExited, true);
  assert.equal(f.stop().exited, true);
  const child = f.start();
  const chunks: Buffer[] = [];
  child.stderr!.on("data", chunk => chunks.push(chunk));
  assert.equal((await once(child, "close"))[0], 64);
  assert.match(Buffer.concat(chunks).toString("utf8"), /already_claimed/);
  assert.equal(fs.existsSync(path.join(f.state, "dispatches")), false);
});

test("helper 停止：进程组消失仍不能把尚未处理的跨连接创建请求当成已结束", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, "hold-run"), "hold");
  const child = f.start();
  const closed = once(child, "close");
  await until(() => fs.existsSync(path.join(f.state, "ready")));
  process.kill(-child.pid!, "SIGKILL");
  await closed;
  await until(() => f.stop().launcherExited);
  assert.equal(f.stop().exited, false, "请求可能留在外部队列，not-found 不能解除占用");
  const claimDir = path.join(f.directory, "ops", OP);
  const claim = JSON.parse(fs.readFileSync(path.join(claimDir, "claim.json"), "utf8"));
  for (const proof of ["{", JSON.stringify({ version: 1, hostOpId: OP, opUnit: `ruukoto-service-op-${OP}.service`, launcher: { ...claim.launcher, startTime: "0" } })]) {
    fs.writeFileSync(path.join(claimDir, "launcher-completed.json"), proof);
    assert.equal(f.stop().exited, false, "损坏或身份不匹配的完成证明无效");
  }
  fs.writeFileSync(path.join(f.state, "unit-present"), "迟到请求已创建单元");
  assert.equal(f.stop().exited, true, "实际观察过唯一原单元并核实停止后才能释放");
  assert.equal(f.stop().exited, true, "观察证明持久化，单元回收后仍可核实");
});
