import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { DesktopHost } from "../apps/desktop/src/main/host.ts";
import { adoptEnvironment, DesktopError, readLoginEnvironment, selectEnvironment, type DesktopEnvironment } from "../apps/desktop/src/main/environment.ts";
import type { DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { startTestRuntime, waitFor } from "./helpers/testkit.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";

test("宿主在订阅前预热，重复订阅共用环境且只安装一次正式快照", async () => {
  const t = await startTestRuntime("host-warm", () => ({ kind: "text", text: "unused" }), { config: { product: product.runtime } });
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "rhw-"));
  const previous = { ...process.env };
  fs.symlinkSync(t.runtime.socketPath(), path.join(control, "control.sock"));
  fs.symlinkSync(path.join(t.runtime.controlDir(), "owner.token"), path.join(control, "owner.token"));
  const source: DesktopEnvironment = { node: process.execPath, env: { ...previous, RUUKOTO_DESKTOP_MANAGED: "0", RUUKOTO_CODE_CONTROL_DIR: control, RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir } };
  delete source.env.RUUKOTO_OWNER_TOKEN;
  delete source.env.RUUKOTO_OWNER_TOKEN_FILE;
  let finish!: (source: DesktopEnvironment) => void;
  const reading = new Promise<DesktopEnvironment>(resolve => { finish = resolve; });
  let reads = 0;
  let snapshots = 0;
  const original = t.runtime.snapshot.bind(t.runtime);
  t.runtime.snapshot = () => { snapshots++; return original(); };
  const updates: DesktopUpdate[] = [];
  const host = new DesktopHost(path.resolve(import.meta.dirname, ".."), path.join(t.dirs.root, "user"), { publish: (_target, update) => { updates.push(update); }, focused: () => true, notice() {}, badge() {} }, () => { reads++; return reading; });
  try {
    assert.equal(reads, 1, "构造时开始，不等订阅");
    await setImmediate();
    assert.equal(snapshots, 0, "预热不能提前连接后台");
    assert.equal(updates.length, 0);
    host.subscribe("code");
    host.subscribe("code");
    finish(source);
    await waitFor("正式连接在线", () => updates.some(update => update.type === "state" && update.state === "online"));
    assert.equal(reads, 1);
    assert.equal(snapshots, 1, "就绪探测不生成快照");
    assert.equal(updates.filter(update => update.type === "snapshot").length, 1);
    assert.equal(process.env.RUUKOTO_CODE_CONTROL_DIR, control, "采用预热结果再解析路径与令牌");
  } finally {
    await host.close();
    adoptEnvironment(previous);
    await t.shutdown();
    fs.rmSync(control, { recursive: true, force: true });
  }
});

test("订阅前的预热失败可见，显式重新连接可重试环境读取", async () => {
  let reads = 0;
  const failure = new DesktopError("shell_environment", "请修复登录 shell 后重新连接。");
  const updates: DesktopUpdate[] = [];
  const host = new DesktopHost(import.meta.dirname, os.tmpdir(), { publish: (_target, update) => { updates.push(update); }, focused: () => true, notice() {}, badge() {} }, async () => { reads++; throw failure; });
  try {
    await setImmediate();
    assert.equal(reads, 1);
    assert.equal(updates.length, 0);
    host.subscribe("code");
    await waitFor("连接报告环境失败", () => updates.some(update => update.type === "state" && update.state === "failed"));
    assert.equal(reads, 1, "首次连接消费预热错误，不偷偷重试");
    const failed = updates.find(update => update.type === "state" && update.state === "failed");
    assert.ok(failed?.type === "state");
    assert.equal(failed.error?.code, failure.code);
    await host.request("code", "reconnect", {});
    assert.equal(reads, 2);
  } finally { await host.close(); }
});

test("关闭取消预热并等待结束，迟到环境不被采用也不创建连接", async () => {
  let finish!: (source: DesktopEnvironment) => void;
  let signal!: AbortSignal;
  const reading = new Promise<DesktopEnvironment>(resolve => { finish = resolve; });
  const updates: DesktopUpdate[] = [];
  const host = new DesktopHost(import.meta.dirname, os.tmpdir(), { publish: (_target, update) => { updates.push(update); }, focused: () => true, notice() {}, badge() {} }, supplied => { signal = supplied; return reading; });
  host.subscribe("code");
  const closing = host.close();
  let closed = false;
  void closing.then(() => { closed = true; });
  await setImmediate();
  assert.equal(signal.aborted, true);
  assert.equal(closed, false);
  finish({ node: process.execPath, env: { ...process.env, RUUKOTO_STARTUP_LATE: "must-not-adopt" } });
  await closing;
  assert.equal(process.env.RUUKOTO_STARTUP_LATE, undefined);
  assert.equal(updates.some(update => update.type === "snapshot" || update.type === "state" && update.state === "failed"), false);
  assert.equal(host.close(), closing);
});

test("取消登录 shell 或受管 Node 探测会实际回收忽略 SIGTERM 的直接子进程", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhe-"));
  const shell = path.join(dir, "probe");
  const pidFile = path.join(dir, "pid");
  fs.writeFileSync(shell, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.PROBE_PID, String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`, { mode: 0o700 });
  fs.symlinkSync(shell, path.join(dir, "node"));
  try {
    for (const managed of [false, true]) {
      const abort = new AbortController();
      const env = { ...process.env, SHELL: shell, PROBE_PID: pidFile, PATH: dir, RUUKOTO_DESKTOP_MANAGED: managed ? "1" : "0" };
      const reading = managed ? selectEnvironment(env, undefined, abort.signal) : readLoginEnvironment(env, abort.signal);
      const rejected = assert.rejects(reading, (error: unknown) => error instanceof DesktopError && error.code === (managed ? "node_unavailable" : "shell_environment"));
      await waitFor("环境读取进程开始", () => fs.existsSync(pidFile));
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      abort.abort();
      await rejected;
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "拒绝返回时直接子进程必须已经退出");
      fs.rmSync(pidFile);
    }
    await assert.rejects(readLoginEnvironment({ SHELL: "bad\0shell" }), { code: "shell_environment" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
