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
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, "等待隔离 helper 超时"); await delay(5); }
}
function fixture(t: TestContext) {
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
  fs.writeFileSync(helper, source, { mode: 0o700 });
  const prefix = `#!${process.execPath}\nimport * as fs from "node:fs"; const state = ${JSON.stringify(state)}; const wait = () => { while (!fs.existsSync(state + "/release")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); };\n`;
  fs.writeFileSync(path.join(directory, "systemctl.mjs"), prefix + `const args = process.argv.slice(2); if (args[1] === "stop") { fs.rmSync(state + "/unit-present", { force: true }); process.exit(0); } const unit = args[2]; if (unit.startsWith("ruukoto-service-op-")) { process.stdout.write(fs.existsSync(state + "/unit-present") ? "LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=1\\nControlPID=0\\n" : "LoadState=not-found\\n"); process.exit(0); } if (fs.existsSync(state + "/hold-show")) { fs.writeFileSync(state + "/ready", "show"); wait(); } process.stdout.write(${JSON.stringify(`Id=${UNIT}\nFragmentPath=${path.join(directory, "example.service")}\nDropInPaths=\nNeedDaemonReload=no\n`)});`, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, "systemd-run.mjs"), prefix + `if (fs.existsSync(state + "/hold-run")) { fs.writeFileSync(state + "/ready", String(process.pid)); wait(); } fs.appendFileSync(state + "/dispatches", "dispatch\\n");`, { mode: 0o755 });
  const children: ChildProcess[] = [];
  t.after(async () => {
    fs.writeFileSync(path.join(state, "release"), "release");
    for (const child of children) {
      try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      if (child.exitCode === null && child.signalCode === null) await once(child, "close");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const stop = () => {
    const result = spawnSync(process.execPath, [helper, "stop-op", OP], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stderr.split("\n").find(line => line.startsWith("RUUKOTO_SERVICE_REPLY "));
    assert.ok(line, result.stderr);
    return JSON.parse(line.slice("RUUKOTO_SERVICE_REPLY ".length)) as { launcherExited: boolean; exited: boolean };
  };
  return { directory, state, stop,
    start: () => {
      const revision = sha(JSON.stringify({ files: [{ path: path.join(directory, "example.service"), sha256: sha("isolated unit") }], needDaemonReload: "no" }));
      const child = spawn(process.execPath, [helper, "restart", OP, sha(policy), revision, UNIT], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
      children.push(child);
      return child;
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
