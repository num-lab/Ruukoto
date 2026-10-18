import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { CodeController } from "../apps/desktop/src/main/controller.ts";
import { CONTROL_PROTOCOL_VERSION } from "@ruukoto/control/protocol.ts";
import { PersonalController } from "../apps/desktop/src/main/personal-controller.ts";
import { loadPersonalConfig, savePersonalConfig, validatePersonalConfig } from "../apps/desktop/src/main/personal-config.ts";
import { tokenCommand, tokenArgs, forwardArgs, tokenFailure, SshProcess } from "../apps/desktop/src/main/personal-ssh.ts";
import { handleRequest } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { fakeSnapshot } from "./helpers/fake-control.ts";
import { waitFor, startTestRuntime } from "./helpers/testkit.ts";
import { product as personalProduct } from "./helpers/legacy-product.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const config = { host: "test-host", controlDir: "/var/lib/ruukoto/control" };
function temp() { return fs.mkdtempSync("/tmp/rk-ssh-"); }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

test("Personal 保存前验证 SSH 别名、远端及本地 socket 路径，落盘仅有两项配置", () => {
  const dir = temp();
  try {
    assert.equal(loadPersonalConfig(dir), null);
    assert.deepEqual(savePersonalConfig(dir, { host: "test-host", token: "never-save" }), config);
    for (const host of ["-oProxyCommand=x", "", "host name", "host\nname"]) assert.throws(() => savePersonalConfig(dir, { ...config, host }), { code: "invalid_ssh_host" });
    for (const controlDir of ["relative", "/a b", "/a'b", "/a;b", "/a$(b)", "/a`b`", "/a:b", "/a\nb"]) assert.throws(() => savePersonalConfig(dir, { ...config, controlDir }), { code: "invalid_control_dir" });
    assert.throws(() => savePersonalConfig(dir, { ...config, controlDir: "/" + "a".repeat(100) }), { code: "socket_path_too_long" });
    assert.throws(() => validatePersonalConfig(config, "/" + "界".repeat(40)), { code: "socket_path_too_long" });
    assert.deepEqual(loadPersonalConfig(dir), config);
    assert.equal(fs.readFileSync(path.join(dir, "personal.json"), "utf8"), JSON.stringify(config) + "\n");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("SSH 预检经真实 shell 区分目录、socket 与 FIFO，路径转义不执行附加命令", async () => {
  const dir = temp(), control = path.join(dir, "control");
  const conf = { ...config, controlDir: control };
  const run = () => spawnSync("/bin/sh", ["-c", tokenCommand(conf)], { encoding: "utf8", timeout: 2000 });
  const server = net.createServer();
  try {
    assert.equal(run().status, 10);
    fs.mkdirSync(control);
    assert.equal(run().status, 12);
    server.listen(path.join(control, "control.sock")); await once(server, "listening");
    fs.chmodSync(control, 0o600); assert.equal(run().status, 11); fs.chmodSync(control, 0o700);
    fs.chmodSync(path.join(control, "control.sock"), 0o400); assert.equal(run().status, 13); fs.chmodSync(path.join(control, "control.sock"), 0o600);
    assert.equal(run().status, 14);
    assert.equal(spawnSync("mkfifo", [path.join(control, "owner.token")]).status, 0);
    assert.equal(run().status, 14);
    fs.unlinkSync(path.join(control, "owner.token")); fs.writeFileSync(path.join(control, "owner.token"), "original-token\n");
    assert.equal(run().stdout, "original-token\n");
    const marker = path.join(dir, "injected");
    const malicious = { ...config, controlDir: `${control}'; touch ${marker}; #` };
    assert.equal(spawnSync("/bin/sh", ["-c", tokenCommand(malicious)], { timeout: 2000 }).status, 10);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.chmodSync(control, 0o700); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("两条 SSH 命令显式覆盖复用、后台化与远端命令配置", () => {
  const dir = temp();
  try {
    const file = path.join(dir, "config");
    fs.writeFileSync(file, "Host *\n ControlMaster auto\n ControlPath /tmp/reused-master\n ControlPersist yes\n ForkAfterAuthentication yes\n RemoteCommand echo wrong\n RequestTTY force\n LocalForward 12345 localhost:22\n");
    for (const [read, args] of [[true, tokenArgs(config)], [false, forwardArgs(config, path.join(dir, "personal.sock"))]] as const) {
      assert.equal(args[args.indexOf("--") + 1], config.host);
      const result = spawnSync("ssh", ["-F", file, "-G", ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      for (const line of ["batchmode yes", "controlmaster false", "controlpersist no", "forkafterauthentication no", "connecttimeout 10"]) assert.ok(result.stdout.includes(line), line);
      assert.ok(!/^controlpath /m.test(result.stdout)); assert.ok(!/^remotecommand /m.test(result.stdout));
      if (read) { assert.match(result.stdout, /clearallforwardings yes/); assert.match(result.stdout, /requesttty false/); assert.ok(!/^localforward /m.test(result.stdout)); }
      else { assert.match(result.stdout, /exitonforwardfailure yes/); assert.match(result.stdout, /streamlocalbindunlink yes/); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

interface Scenario { token: string; readCode?: number; stderr?: string; hang?: boolean; ignoreTerm?: boolean; forwardCode?: number; product?: "ruukoto" | "ruukoto-code"; unauthorized?: boolean; version?: number }
async function harness(initial: Partial<Scenario> = {}, observe?: (controller: PersonalController, update: DesktopUpdate) => void) {
  const dir = temp(), userData = path.join(dir, "app"), scenarioFile = path.join(dir, "scenario.json"), log = path.join(dir, "children.jsonl");
  let scenario: Scenario = { token: "secret-first-token", ...initial };
  const write = (patch: Partial<Scenario>) => { scenario = { ...scenario, ...patch }; fs.writeFileSync(scenarioFile, JSON.stringify(scenario)); };
  write({});
  const executable = path.join(dir, "ssh");
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs'), net = require('node:net');
const args = process.argv.slice(2), read = !args.includes('-N');
const scenario = () => JSON.parse(fs.readFileSync(process.env.SCENARIO, 'utf8'));
fs.appendFileSync(process.env.LOG, JSON.stringify({pid:process.pid,read,locale:process.env.LC_ALL,started:Date.now()})+'\\n');
const s = scenario();
if (read) {
  if (s.hang) { if(s.ignoreTerm) process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
  else { process.stdout.write(s.readCode ? '' : s.token); process.stderr.write(s.stderr || ''); process.exit(s.readCode || 0); }
} else {
  const local = args[args.indexOf('-L')+1].split(':')[0];
  fs.rmSync(local,{force:true});
  net.createServer(client => {
    const remote = net.connect(process.env.REMOTE);
    client.pipe(remote); remote.pipe(client);
    remote.on('error',()=>client.destroy()); client.on('error',()=>remote.destroy());
    client.on('close',()=>remote.destroy()); remote.on('close',()=>client.destroy());
  }).listen(local);
  setInterval(()=>{ const next=scenario(); if(next.forwardCode !== undefined) { process.stderr.write(next.stderr || ''); process.exit(next.forwardCode); } },20);
}
`, { mode: 0o755 });
  const sockets = new Set<net.Socket>(), authTokens: string[] = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => { /* 客户端关闭时允许连接复位。 */ });
    let input = "";
    socket.on("data", data => {
      input += data.toString();
      while (input.includes("\n")) {
        const index = input.indexOf("\n"), request = JSON.parse(input.slice(0, index)); input = input.slice(index + 1);
        if (request.op === "auth") authTokens.push(request.params.token);
        const failure = scenario.version !== undefined ? "protocol_version" : scenario.unauthorized || (request.op === "auth" && request.params.token !== scenario.token) ? "unauthorized" : null;
        const result = request.op === "auth" ? { authenticated: true } : { seq: 0, replay: [], snapshot: fakeSnapshot({ product: scenario.product ?? "ruukoto" }) };
        socket.write(JSON.stringify({ v: scenario.version ?? CONTROL_PROTOCOL_VERSION, id: request.id, ok: !failure, ...(failure ? { error: { code: failure, message: "明确拒绝" } } : { result }) }) + "\n");
      }
    });
  });
  const remote = path.join(dir, "remote.sock"); server.listen(remote); await once(server, "listening");
  const updates: DesktopUpdate[] = [];
  const env = { ...process.env, SCENARIO: scenarioFile, LOG: log, REMOTE: remote };
  const controller = new PersonalController(config, userData, update => { updates.push(update); observe?.(controller, update); }, env, { ssh: executable });
  const children = (): { pid: number; read: boolean; locale: string; started: number }[] => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { dir, userData, executable, env, controller, updates, authTokens, write, children, drop: () => { for (const socket of sockets) socket.destroy(); }, async close() {
    await controller.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(children().every(child => !alive(child.pid)), "所有 SSH 子进程已回收"); fs.rmSync(dir, { recursive: true, force: true });
  } };
}

test("替身 SSH 的所有预检退出与网络文本只在外部边界分类", async () => {
  const h = await harness();
  try {
    const networks = ["Connection timed out", "Connection refused", "Network is unreachable", "No route to host", "Could not resolve hostname", "Connection closed by 127.0.0.1", "Connection to host closed by remote host.", "Connection reset", "client_loop: send disconnect: Broken pipe", "Timeout, server host not responding."];
    for (const stderr of [...networks, "Permission denied (publickey)", "Host key verification failed.", "Bad configuration option", "unknown error"]) {
      h.write({ readCode: 255, stderr });
      const process = new SshProcess(h.executable, tokenArgs(config), h.env, true);
      const result = await process.done, error = tokenFailure(result.code, result.stderr);
      assert.equal(error.outcome, networks.includes(stderr) ? "not_sent" : "rejected", stderr);
      assert.equal(error.code, networks.includes(stderr) ? "ssh_network" : "ssh_rejected");
    }
    for (const code of [1, 10, 11, 12, 13, 14]) {
      h.write({ readCode: code, stderr: "" });
      const result = await new SshProcess(h.executable, tokenArgs(config), h.env, true).done;
      const error = tokenFailure(result.code, result.stderr);
      assert.equal(error.outcome, code === 12 ? "not_sent" : "rejected");
      assert.equal(error.code, code === 12 ? "remote_socket_missing" : "remote_control_unavailable");
    }
    assert.ok(h.children().every(child => child.locale === "C"));
  } finally { await h.close(); }
});

for (const fault of ["Timeout, server host not responding.", "Connection to host closed by remote host.", "client_loop: send disconnect: Broken pipe", "zero", "signal"]) {
  test(`转发在线后 ${fault}，退避重启并重新认证同步`, async () => {
    const h = await harness();
    try {
      await h.controller.reconnect(); await waitFor("首次在线", () => h.controller.status.state === "online");
      assert.equal(fs.statSync(path.dirname(h.controller.socketPath)).mode & 0o777, 0o700);
      const forward = h.children().find(child => !child.read)!;
      if (fault === "signal") process.kill(forward.pid, "SIGTERM");
      else h.write({ forwardCode: fault === "zero" ? 0 : 255, stderr: fault });
      await waitFor("转发退出", () => !alive(forward.pid));
      h.write({ forwardCode: undefined, stderr: "" });
      await waitFor("转发恢复并安装快照", () => h.updates.filter(update => update.type === "snapshot").length >= 2 && h.controller.status.state === "online");
      assert.ok(h.children().filter(child => !child.read).length >= 2);
      assert.ok(h.authTokens.length >= 2);
      await h.controller.close();
      const count = h.children().length; await sleep(600); assert.equal(h.children().length, count);
      assert.equal(fs.existsSync(h.controller.socketPath), false);
      assert.ok(!JSON.stringify(h.updates).includes("secret-first-token"));
      assert.deepEqual(fs.readdirSync(h.userData), ["ssh"]);
    } finally { await h.close(); }
  });
}

test("转发存活时后台轮换令牌，下次控制面建连读取新值", async () => {
  const h = await harness();
  try {
    await h.controller.reconnect(); await waitFor("首次在线", () => h.controller.status.state === "online");
    h.write({ token: "secret-rotated-token" }); h.drop();
    await waitFor("新令牌认证", () => h.authTokens.includes("secret-rotated-token") && h.controller.status.state === "online");
    assert.deepEqual(h.authTokens, ["secret-first-token", "secret-rotated-token"]);
    assert.equal(h.children().filter(child => !child.read).length, 1);
    assert.ok(!JSON.stringify(h.updates).includes("secret-"));
  } finally { await h.close(); }
});

for (const failure of [{ readCode: 12 }, { readCode: 255, stderr: "Connection refused" }]) {
  test(`预检可重试失败 ${JSON.stringify(failure)} 恢复后自动在线`, async () => {
    const h = await harness(failure);
    try {
      await h.controller.reconnect(); assert.equal(h.controller.status.state, "reconnecting");
      h.write({ readCode: 0, stderr: "" });
      await waitFor("恢复在线", () => h.controller.status.state === "online");
    } finally { await h.close(); }
  });
}

for (const [scenario, code] of [
  [{ forwardCode: 255, stderr: "bind [127.0.0.1]:12345: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 12345\nCould not request local forwarding." }, "forward_setup_failed"],
  [{ readCode: 255, forwardCode: 255, stderr: "Permission denied (publickey)" }, "ssh_rejected"],
  [{ unauthorized: true }, "unauthorized"],
  [{ version: CONTROL_PROTOCOL_VERSION - 1 }, "protocol_version"],
  [{ product: "ruukoto-code" }, "product_mismatch"],
] as const) {
  test(`终止失败 ${code} 回收 SSH，不自动重试，明确重连才再启动`, async () => {
    const h = await harness(scenario);
    try {
      await h.controller.reconnect(); await waitFor("终止失败", () => h.controller.status.state === "failed");
      assert.equal(h.controller.status.error?.code, code);
      await waitFor("子进程回收", () => h.children().every(child => !alive(child.pid)));
      const count = h.children().length; await sleep(650); assert.equal(h.children().length, count);
      if (code === "forward_setup_failed") assert.match(h.controller.status.error!.message, /LocalForward/);
      if (code === "product_mismatch") assert.ok(!h.updates.some(update => update.type === "snapshot"));
      h.write({ forwardCode: undefined, readCode: 0, stderr: "", unauthorized: false, version: undefined, product: "ruukoto" });
      await h.controller.reconnect(); await waitFor("手动重连恢复", () => h.controller.status.state === "online");
    } finally { await h.close(); }
  });
}

test("读取达到 15 秒期限后 TERM/KILL 回收，关闭与改配置取消读取且不留迟到结果", async () => {
  const h = await harness({ hang: true, ignoreTerm: true });
  try {
    const started = Date.now();
    await h.controller.reconnect();
    assert.ok(Date.now() - started >= 15000);
    assert.equal(h.controller.status.state, "reconnecting");
    assert.match(h.controller.status.detail!, /超时/);
    assert.ok(h.children().filter(child => child.read).every(child => !alive(child.pid)));
    h.write({ hang: false });
    await waitFor("超时后恢复", () => h.controller.status.state === "online");
    h.write({ hang: true }); h.drop();
    await waitFor("新读取阻塞", () => h.children().some(child => child.read && alive(child.pid)));
    await h.controller.close();
    assert.equal(h.controller.status.state, "closed");
    assert.ok(h.children().every(child => !alive(child.pid)));
    const count = h.children().length; await sleep(600); assert.equal(h.children().length, count);
  } finally { await h.close(); }
});

test("读取中替换目标前等待旧进程退出，旧代次保持关闭", async () => {
  const h = await harness({ hang: true, ignoreTerm: true });
  let next: PersonalController | null = null;
  try {
    const start = h.controller.reconnect();
    await waitFor("读取已启动", () => h.children().some(child => child.read));
    await h.controller.close(); await start;
    assert.ok(h.children().every(child => !alive(child.pid)));
    h.write({ hang: false });
    next = new PersonalController({ ...config, host: "new-host" }, h.userData, () => {}, h.env, { ssh: h.executable });
    await next.reconnect(); await waitFor("替换目标在线", () => next!.status.state === "online");
    assert.equal(h.controller.status.state, "closed");
  } finally { await next?.close(); await h.close(); }
});

test("Personal 配置经现有 request 桥接，配置与 Code 操作不串目标", async () => {
  const dir = temp(); let reconnected = 0, forwarded = 0;
  const request = (target: string, op: string, params: unknown) => handleRequest(target, op, params, async () => { reconnected++; }, async () => { forwarded++; }, undefined, (name, values) => name === "desktop_personal_config_read" ? loadPersonalConfig(dir) : savePersonalConfig(dir, values));
  try {
    assert.deepEqual(await request("personal", "desktop_personal_config_save", config), { ok: true, value: config });
    assert.deepEqual(await request("personal", "desktop_personal_config_read", {}), { ok: true, value: config });
    assert.equal((await request("code", "desktop_personal_config_save", config)).ok, false);
    assert.equal((await request("personal", "auth", {})).ok, false);
    assert.equal((await request("personal", "reconnect", {})).ok, true);
    assert.equal(reconnected, 1); assert.equal(forwarded, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const product of [personalProduct, codeProduct]) {
  test(`真实控制面握手产品来自 Runtime：${product.runtime.type}`, async () => {
    const t = await startTestRuntime("product-snapshot", async () => ({ kind: "text", text: "ok" }), { config: { product: product.runtime } });
    try { assert.equal((await t.client.handshake()).snapshot.product, t.runtime.productType); }
    finally { await t.shutdown(); }
  });
}


test("Code 与 Personal 同时在线，Personal 失败及关闭不影响 Code", async () => {
  const t = await startTestRuntime("code-personal", async () => ({ kind: "text", text: "ok" }), { config: { product: codeProduct.runtime } });
  const h = await harness();
  const updates: DesktopUpdate[] = [];
  const code = new CodeController({ product: "ruukoto-code", managed: true, dataDir: t.dirs.dataDir, agentDir: t.dirs.agentDir, controlDir: t.runtime.controlDir(), socketPath: t.runtime.socketPath() }, update => updates.push(update));
  try {
    await Promise.all([code.reconnect(), h.controller.reconnect()]);
    await waitFor("双目标在线", () => code.status.state === "online" && h.controller.status.state === "online");
    const count = updates.length;
    h.write({ readCode: 255, stderr: "Permission denied (publickey)" }); h.drop();
    await waitFor("Personal 终止失败", () => h.controller.status.state === "failed");
    await h.controller.close();
    assert.equal(code.status.state, "online"); assert.equal(updates.length, count);
    assert.deepEqual(await code.request("list_models", {}), await t.client.request("list_models", {}));
  } finally { code.close(); await h.close(); await t.shutdown(); }
});


test("转发连续失败按指数退避；每次恢复在线后下一轮退避归零", async () => {
  const h = await harness({ hang: true, forwardCode: 0 });
  try {
    const start = h.controller.reconnect();
    await waitFor("连续转发四次", () => h.children().filter(child => !child.read).length >= 4);
    await h.controller.close(); await start;
    const times = h.children().filter(child => !child.read).map(child => child.started);
    for (let i = 1; i < 4; i++) assert.ok(times[i] - times[i - 1] >= 500 * 2 ** (i - 1) - 20);
  } finally { await h.close(); }
  const restored = await harness();
  try {
    await restored.controller.reconnect();
    await waitFor("首次在线", () => restored.controller.status.state === "online");
    for (let i = 0; i < 3; i++) {
      const forwards = restored.children().filter(child => !child.read), started = Date.now();
      process.kill(forwards.at(-1)!.pid, "SIGTERM");
      await waitFor("新转发启动", () => restored.children().filter(child => !child.read).length > forwards.length);
      const elapsed = restored.children().filter(child => !child.read).at(-1)!.started - started;
      assert.ok(elapsed >= 480 && elapsed < 1500, `恢复在线后重新从 500ms 起步，实际 ${elapsed}ms`);
      await waitFor("恢复在线", () => restored.controller.status.state === "online");
    }
  } finally { await restored.close(); }
});


test("Personal 快照回调同步窗口允许通知 get_task 核实，仍拒绝审批写入", async () => {
  const reads: Promise<unknown>[] = [], writes: Promise<unknown>[] = [];
  const h = await harness({}, (controller, update) => {
    if (update.type !== "snapshot") return;
    assert.notEqual(controller.status.state, "online");
    reads.push(controller.request("get_task", { task_id: "observed" }));
    writes.push(assert.rejects(controller.request("respond_confirmation", { confirmation_id: "approval", decision: "approve", permission_version: 1 }), { code: "connection_unavailable", outcome: "not_sent" }));
  });
  try {
    await h.controller.reconnect(); await Promise.all([...reads, ...writes]);
    assert.equal(reads.length, 1); assert.equal(writes.length, 1);
  } finally { await h.close(); }
});
