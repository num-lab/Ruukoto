import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { adoptEnvironment, codeTargetConfig, DesktopError, selectEnvironment } from "../apps/desktop/src/main/environment.ts";
import { CodeController, serializeFailure } from "../apps/desktop/src/main/controller.ts";
import { DESKTOP_OPS, handleRequest, ipcResult } from "../apps/desktop/src/main/ipc.ts";
import { cspFor, externalUrl, isRendererReload } from "../apps/desktop/src/main/security.ts";
import { socketLookupCommand, versionRecovery } from "../apps/desktop/src/main/recovery.ts";
import type { DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";

const root = path.resolve(import.meta.dirname, "..");
const unavailable = async (): Promise<never> => { throw new ControlClientError("connection_unavailable", "连接不可用", "not_sent"); };
const token = "desktop-owner-secret-".repeat(3);
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-desktop-"));
  const previous = { ...process.env };
  const env = { PATH: process.env.PATH, RUUKOTO_CODE_DATA_DIR: path.join(dir, "data"), RUUKOTO_CODE_CONTROL_DIR: path.join(dir, "explicit-control"), RUUKOTO_CODE_AGENT_DIR: path.join(dir, "agent"), RUUKOTO_OWNER_TOKEN: token };
  fs.mkdirSync(env.RUUKOTO_CODE_CONTROL_DIR);
  fs.writeFileSync(path.join(env.RUUKOTO_CODE_CONTROL_DIR, "owner.token"), token);
  return { dir, env, restore() { adoptEnvironment(previous); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("桌面日常路径、令牌与后台参数均采用登录 shell 环境", async () => {
  const f = fixture();
  try {
    let shells = 0;
    const source = await selectEnvironment({ ...process.env, RUUKOTO_CODE_DATA_DIR: "/wrong", RUUKOTO_OWNER_TOKEN: "wrong" }, async () => { shells++; return { env: f.env, node: process.execPath }; });
    adoptEnvironment(source.env);
    const config = codeTargetConfig(root, source);
    assert.equal(shells, 1);
    assert.equal(config.product, "ruukoto-code");
    assert.equal(config.dataDir, f.env.RUUKOTO_CODE_DATA_DIR);
    assert.equal(config.controlDir, f.env.RUUKOTO_CODE_CONTROL_DIR);
    assert.equal(config.spawnExecPath, process.execPath);
    assert.deepEqual(config.spawnArgv, [path.join(root, "apps/ruukoto-code/bin/ruukoto-code.mjs"), "server", "--data-dir", config.dataDir, "--agent-dir", f.env.RUUKOTO_CODE_AGENT_DIR]);
    assert.equal(config.env, source.env);
    let ensures = 0, starts = 0;
    const updates: DesktopUpdate[] = [];
    const controller = new CodeController(config, update => updates.push(update), { ensure: async options => { ensures++; assert.equal(options, config); return { ok: true, spawned: false }; }, connection: (connection, callbacks) => {
      assert.equal(connection.token, token);
      assert.equal(connection.socketPath, path.join(config.controlDir, "control.sock"));
      return { start: async () => { starts++; const error = new ControlClientError("protocol_version", "旧后台", "rejected", { client: 26, server: 25 }); callbacks.onState("failed", error.message, error); throw error; }, close() {}, request: unavailable };
    } });
    await controller.reconnect();
    assert.equal(starts, 1);
    assert.equal(ensures, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(starts, 1, "failed 不自动重试");
    const status = controller.status;
    assert.equal(status.state, "failed");
    assert.deepEqual(status.error?.versions, { client: 26, server: 25 });
    assert.ok(!JSON.stringify(updates).includes(token));
    await handleRequest("code", "reconnect", {}, () => controller.reconnect(), unavailable);
    assert.equal(ensures, 2);
    assert.equal(starts, 2);
    controller.close();
  } finally { f.restore(); }
});

test("受管桌面只用开发档案，不执行登录 shell 或 ensureBackend", async () => {
  const f = fixture();
  try {
    const inherited = { ...f.env, RUUKOTO_DESKTOP_MANAGED: "1" };
    delete (inherited as NodeJS.ProcessEnv).RUUKOTO_OWNER_TOKEN;
    let shells = 0, ensures = 0, starts = 0;
    const source = await selectEnvironment(inherited, async () => { shells++; return { env: { ...f.env, RUUKOTO_CODE_DATA_DIR: "/daily", RUUKOTO_OWNER_TOKEN: "daily" }, node: "/daily/node" }; });
    assert.deepEqual(source.env, inherited);
    adoptEnvironment(source.env);
    const config = codeTargetConfig(root, source);
    assert.equal(config.dataDir, f.env.RUUKOTO_CODE_DATA_DIR);
    const controller = new CodeController(config, () => {}, { ensure: async () => { ensures++; return { ok: true, spawned: false }; }, connection: (connection, callbacks) => {
      assert.equal(connection.token, token);
      return { start: async () => { starts++; callbacks.onState("failed", "不兼容", new ControlClientError("protocol_version", "不兼容", "rejected", { client: 26, server: 25 })); }, close() {}, request: unavailable };
    } });
    await controller.reconnect();
    assert.deepEqual(controller.status.recovery, ["开发后台版本较旧；请重启开发启动器。"]);
    await handleRequest("code", "reconnect", {}, () => controller.reconnect(), unavailable);
    assert.equal(starts, 2);
    assert.equal(shells, 0);
    assert.equal(ensures, 0);
    controller.close();
  } finally { f.restore(); }
});

test("主进程请求名单拒绝越界操作，IPC 错误保留分类与版本且隐藏令牌", async () => {
  let calls = 0;
  const reconnect = async () => { calls++; };
  for (const [target, op, params] of [["code", "stop", {}], ["code", "auth", { token }], ["personal", "reconnect", {}], ["code", "reconnect", { token }], ["code", "reconnect", []]]) {
    const result = await handleRequest(target, op, params, reconnect, unavailable);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(token));
  }
  assert.equal(calls, 0);
  assert.deepEqual(await handleRequest("code", "reconnect", {}, reconnect, unavailable), { ok: true, value: undefined });
  assert.equal(calls, 1);
  const forwarded: string[] = [];
  for (const op of DESKTOP_OPS) {
    assert.deepEqual(await handleRequest("code", op, { session_id: "session" }, reconnect, async (name, params) => {
      forwarded.push(name);
      assert.deepEqual(params, { session_id: "session" });
      return { source: name };
    }), { ok: true, value: { source: op } });
    assert.equal((await handleRequest("code", op, null, reconnect, unavailable)).ok, false);
  }
  assert.deepEqual(forwarded, [...DESKTOP_OPS]);
  const error = new ControlClientError("protocol_version", `拒绝 ${token}`, "rejected", { client: 25, server: 26 });
  assert.deepEqual(serializeFailure(error, token), { code: "protocol_version", outcome: "rejected", message: "拒绝 [令牌已隐藏]", versions: { client: 25, server: 26 } });
  const lost = await ipcResult(() => { throw new ControlClientError("request_timeout", "应答丢失", "unknown"); });
  assert.deepEqual(lost, { ok: false, error: { code: "request_timeout", outcome: "unknown", message: "应答丢失" } });
});

test("桌面开发 CSP 限定来源与 nonce，系统链接仅开放 HTTP(S)", () => {
  const policy = cspFor("http://localhost:5173/path", "nonce_1234567890abcd");
  assert.ok(policy.includes("http://localhost:5173"));
  assert.ok(policy.includes("ws://localhost:5173"));
  assert.ok(policy.includes("'nonce-nonce_1234567890abcd'"));
  assert.ok(!policy.includes("unsafe-inline"));
  assert.throws(() => cspFor("https://example.com", "nonce_1234567890abcd"));
  assert.throws(() => cspFor("http://localhost:5173", "bad'nonce"));
  assert.equal(externalUrl("javascript:alert(1)"), null);
  assert.equal(externalUrl("file:///tmp/file"), null);
  assert.equal(externalUrl("https://example.com"), "https://example.com/");
  assert.equal(isRendererReload("http://localhost:5173/", "http://localhost:5173"), true);
  for (const value of ["http://localhost:5173/other", "http://localhost:5173/?page=other", "http://localhost:5173.evil/", "https://example.com/", "javascript:alert(1)"]) assert.equal(isRendererReload(value, "http://localhost:5173/"), false);
  assert.equal(isRendererReload("file:///renderer/index.html", undefined), false);
  assert.equal(isRendererReload("file:///renderer/index.html", ""), false);
});

test("版本恢复方向使用结构化值，Code 指引按当前 socket 且正确转义路径", () => {
  const controlDir = "/tmp/控制目录 with 'quote'";
  for (const target of ["code", "personal"] as const) assert.match(versionRecovery(target, { client: 24, server: 25 }, false, controlDir).join("\n"), /重建应用/);
  assert.match(versionRecovery("personal", { client: 26, server: 25 }, false, controlDir).join("\n"), /服务器部署同一 commit/);
  const guide = versionRecovery("code", { client: 26, server: 25 }, false, controlDir).join("\n");
  assert.match(guide, /恰好只有一个 PID/);
  assert.match(guide, /ps -o user=,command=/);
  assert.match(guide, /kill -TERM <PID>/);
  assert.match(guide, /未查到监听进程/);
  assert.match(guide, /多个不同 PID/);
  assert.ok(!guide.includes("|"));
  const socket = path.join(controlDir, "control.sock");
  const command = socketLookupCommand(socket);
  const escaped = command.slice("lsof -nP -a -U -- ".length);
  assert.equal(execFileSync("/bin/sh", ["-c", `printf '%s' ${escaped}`], { encoding: "utf8" }), socket);
});

test("仓库缺失与 node 不可用显示可操作错误，关闭期间不再新建连接", async () => {
  assert.throws(() => codeTargetConfig("/missing-repository", { env: {}, node: process.execPath }), (error: unknown) => error instanceof DesktopError && error.code === "repository_missing" && error.message.includes("desktop:build"));
  await assert.rejects(selectEnvironment({ PATH: "/missing-node", RUUKOTO_DESKTOP_MANAGED: "1" }), (error: unknown) => error instanceof DesktopError && error.code === "node_unavailable" && error.message.includes("启动器"));
  const f = fixture();
  try {
    const oldNode = path.join(f.dir, "node");
    fs.writeFileSync(oldNode, `#!/bin/sh
printf '\\000RUUKOTO_DESKTOP\\000%s\\000END\\000' '{"env":{},"node":"/old/node","version":"20.0.0"}'
`, { mode: 0o755 });
    await assert.rejects(selectEnvironment({ PATH: f.dir, RUUKOTO_DESKTOP_MANAGED: "1" }), (error: unknown) => error instanceof DesktopError && error.code === "node_unavailable" && error.message.includes("版本过旧"));
    adoptEnvironment(f.env);
    let release!: (result: { ok: true; spawned: boolean }) => void;
    let starts = 0;
    const controller = new CodeController(codeTargetConfig(root, { env: f.env, node: process.execPath }), () => {}, { ensure: () => new Promise(resolve => { release = resolve; }), connection: () => { starts++; return { start: async () => {}, close() {}, request: unavailable }; } });
    const pending = controller.reconnect();
    controller.close();
    release({ ok: true, spawned: false });
    await pending;
    assert.equal(starts, 0);
  } finally { f.restore(); }
});
