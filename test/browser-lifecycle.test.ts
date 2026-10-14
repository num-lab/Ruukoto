import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { processIdentity } from "@ruukoto/core/process-identity.ts";
import { BrowserError, BrowserManager, parseBrowserCommand, resolveBrowserEndpoint, runBrowserCommand, type BrowserBinding, type BrowserProcess } from "@ruukoto/agent/browser-manager.ts";

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("子进程未在预算内完成"); await new Promise(resolve => setTimeout(resolve, 20)); }
}

function error(code: string, effectUnknown: boolean) {
  return (value: unknown) => value instanceof BrowserError && value.code === code && value.effectUnknown === effectUnknown;
}

function wire(args: string[], fields: Record<string, unknown>) { return JSON.stringify([{ command: args, success: true, result: {}, ...fields }]); }

test("浏览器 wire 按结构化 code 判定，读取应答丢失不声称外部写入，标签关闭不重建", () => {
  const write = ["click", "#pay"];
  assert.throws(() => parseBrowserCommand(wire(write, { success: false, error: "任意诊断" }), write, 1), error("outcome_unknown", true));
  assert.throws(() => parseBrowserCommand(wire(write, { success: false, code: "new_code" }), write, 1), error("outcome_unknown", true));
  assert.throws(() => parseBrowserCommand(wire(write, { code: "new_code" }), write, 0), error("outcome_unknown", true));
  assert.throws(() => parseBrowserCommand(wire(write, { success: false, code: "tab_gone" }), write, 1), error("tab_gone", false));
  for (const read of [["snapshot"], ["screenshot", "out.png"], ["tab", "list"]]) {
    assert.throws(() => parseBrowserCommand("", read, 0), error("outcome_unknown", false));
    assert.throws(() => parseBrowserCommand(wire(read, { success: false, code: "outcome_unknown" }), read, 1), error("outcome_unknown", false));
    assert.throws(() => parseBrowserCommand(wire(read, { success: false }), read, 1), error("browser_action_failed", false));
  }
  assert.throws(() => parseBrowserCommand(wire(["click", "#other"], {}), write, 0), error("outcome_unknown", true));
  assert.throws(() => parseBrowserCommand(wire(write, {}), write, 1), error("outcome_unknown", true));
});

function cliFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-browser-cli-"));
  const script = path.join(root, "cli.mjs"), log = path.join(root, "calls.jsonl");
  fs.writeFileSync(script, `import fs from 'node:fs';let text='';for await(const chunk of process.stdin)text+=chunk;const batch=JSON.parse(text);fs.appendFileSync(process.env.CALL_LOG,JSON.stringify({argv:process.argv.slice(2),batch,pid:process.pid})+'\\n');if(process.env.MODE==='hang')setInterval(()=>{},1000);else if(process.env.MODE==='empty')process.exit(1);else if(process.env.MODE==='bad')process.stdout.write('{');else process.stdout.write(JSON.stringify([{command:batch[0],success:true,result:{text:'密钥'}}]));`);
  return { root, script, log, env: { ...process.env, CALL_LOG: log }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("单动作使用 stdin batch 保留 flag 形文本，EOF 与坏应答从不重发", async () => {
  const f = cliFixture(), args = ["fill", "#name", "--config"];
  try {
    assert.deepEqual(await runBrowserCommand(process.execPath, [f.script], args, { cwd: f.root, env: f.env }), { data: { text: "密钥" } });
    for (const mode of ["empty", "bad"]) await assert.rejects(runBrowserCommand(process.execPath, [f.script], args, { cwd: f.root, env: { ...f.env, MODE: mode } }), error("outcome_unknown", true));
    const calls = fs.readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.length, 3);
    for (const call of calls) { assert.deepEqual(call.argv, ["batch", "--bail"]); assert.deepEqual(call.batch, [args]); }
  } finally { f.cleanup(); }
});

test("取消在途命令只停止本次 CLI 子进程，写入结果未知且不重发", async () => {
  const f = cliFixture(), controller = new AbortController();
  const pending = runBrowserCommand(process.execPath, [f.script], ["click", "#submit"], { cwd: f.root, env: { ...f.env, MODE: "hang" }, signal: controller.signal });
  const assertion = assert.rejects(pending, error("outcome_unknown", true));
  try {
    await waitFor(() => fs.existsSync(f.log));
    const call = JSON.parse(fs.readFileSync(f.log, "utf8").trim());
    controller.abort(); await assertion;
    await waitFor(() => processIdentity(call.pid) === null);
    assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, 1);
  } finally { controller.abort(); await assertion; f.cleanup(); }
});

test("CDP discovery 固定 literal loopback 和同一浏览器 UUID，拒绝重定向及远程目标", async () => {
  const targetId = randomUUID(); let mode = "ok";
  const server = createServer((_request, response) => {
    if (mode === "redirect") { response.writeHead(302, { Location: "http://example.com/json/version" }); response.end(); return; }
    const address = server.address(); assert.ok(address && typeof address === "object");
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://${mode === "remote" ? "example.com" : "localhost"}:${address.port}/devtools/browser/${targetId}` }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    const expected = { url: `ws://127.0.0.1:${address.port}/devtools/browser/${targetId}`, targetId };
    assert.deepEqual(await resolveBrowserEndpoint(`http://localhost:${address.port}`), expected);
    assert.deepEqual(await resolveBrowserEndpoint(`ws://127.0.0.1:${address.port}/devtools/browser/${targetId.toUpperCase()}`), expected);
    mode = "redirect"; await assert.rejects(resolveBrowserEndpoint(`http://127.0.0.1:${address.port}`), error("browser_invalid_target", false));
    mode = "remote"; await assert.rejects(resolveBrowserEndpoint(`http://localhost:${address.port}`), error("browser_invalid_target", false));
    for (const url of ["ws://example.com:9222/devtools/browser/" + targetId, "ws://127.0.0.1:9222/devtools/page/" + targetId, "ws://user@localhost:9222/devtools/browser/" + targetId]) await assert.rejects(resolveBrowserEndpoint(url), error("browser_invalid_target", false));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

async function childUnit(): Promise<{ child: ChildProcess; unit: BrowserProcess; exited: Promise<unknown> }> {
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const exited = once(child, "exit"); await once(child.stdout!, "data"); assert.ok(child.pid);
  const identity = processIdentity(child.pid); assert.ok(identity);
  return { child, exited, unit: { pid: child.pid, pgid: Number(execFileSync("ps", ["-p", String(child.pid), "-o", "pgid="], { encoding: "utf8" }).trim()), processIdentity: identity } };
}

function persistedFixture(unit: BrowserProcess | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-browser-state-")), dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const sessionId = "session", generation = randomUUID(), targetId = randomUUID();
  const id = createHash("sha256").update(`${dataDir}\0${sessionId}`).digest("hex").slice(0, 24);
  const socketDir = `/tmp/ruukoto-browser-${process.getuid?.() ?? "unknown"}-${id}`;
  const lockDir = `/tmp/ruukoto-browser-locks-${process.getuid?.() ?? "unknown"}/${createHash("sha256").update(targetId).digest("hex")}`;
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const binding: BrowserBinding = { sessionId, generation, kind: "attached", state: "ready", profileDir: null, socketDir, cliSession: `rk-${id}`, cdpUrl: `ws://127.0.0.1:9222/devtools/browser/${targetId}`, targetId, chrome: null, daemon: unit, dashboard: null, chromePending: false, daemonPending: false, dashboardPending: false, lockDir, pauseTaskId: null, pauseAfterSeq: null, outcomeUnknown: false, failureCode: null, dashboardUrl: null, headed: false };
  const ownerFile = path.join(lockDir, "owner.json");
  fs.writeFileSync(ownerFile, JSON.stringify({ dataDir, sessionId, generation, daemon: unit }));
  if (unit) fs.writeFileSync(path.join(socketDir, `${binding.cliSession}.pid`), String(unit.pid));
  fs.writeFileSync(path.join(socketDir, "config.json"), "{}\n");
  fs.writeFileSync(path.join(socketDir, `${binding.cliSession}.config`), "0123456789abcdef");
  fs.writeFileSync(path.join(socketDir, `${binding.cliSession}.version`), "0.39.1");
  let state = JSON.stringify({ version: 1, bindings: [binding], fingerprints: { [sessionId]: { config: "0123456789abcdef", version: "0.39.1" } } });
  const make = (beforePersist?: () => void) => new BrowserManager({ dataDir, binaryPath: process.execPath, store: { getMetaValue: () => state }, persist: value => { beforePersist?.(); state = value; } });
  return { root, binding, ownerFile, make, setState: (value: BrowserBinding) => { state = JSON.stringify({ version: 1, bindings: [value] }); }, cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(socketDir, { recursive: true, force: true }); fs.rmSync(lockDir, { recursive: true, force: true }); } };
}

test("冷恢复停止已知附接 daemon，释放锁但不触碰用户 Chrome CDP", async () => {
  const c = await childUnit(), f = persistedFixture(c.unit), manager = f.make();
  try {
    await manager.recover(); await c.exited;
    assert.equal(manager.status("session")?.state, "closed"); assert.equal(fs.existsSync(f.ownerFile), false);
    assert.equal(await manager.close("session"), true);
  } finally { await manager.shutdown(); if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill(); await c.exited; f.cleanup(); }
});

test("进程启动身份不匹配不发信号、不放锁、不允许新开；结果未知只登记人工等待", async () => {
  const c = await childUnit(), f = persistedFixture(c.unit);
  f.binding.daemon = { ...c.unit, processIdentity: process.platform === "linux" ? c.unit.processIdentity.replace(/:\d+$/, ":0") : "darwin:Thu Jan  1 00:00:00 1970" };
  f.binding.state = "unavailable"; f.binding.outcomeUnknown = true; f.setState(f.binding);
  const manager = f.make();
  try {
    for (const args of [["snapshot"], ["click", "@e1"]]) await assert.rejects(manager.command("session", args), error("browser_not_ready", false));
    assert.equal(manager.status("session")?.outcomeUnknown, true);
    assert.equal(await manager.close("session"), false); assert.equal(processIdentity(c.unit.pid), c.unit.processIdentity); assert.equal(fs.existsSync(f.ownerFile), true);
    manager.pause("session", "old"); assert.equal(manager.status("session")?.state, "unavailable");
    await assert.rejects(manager.resume("session", "old"), error("browser_paused", false));
    await assert.rejects(manager.resume("session", "new"), error("browser_identity_unverified", false));
    await assert.rejects(manager.start("session"), BrowserError); assert.equal(processIdentity(c.unit.pid), c.unit.processIdentity);
  } finally { await manager.shutdown(); c.child.kill(); await c.exited; f.cleanup(); }
});

test("他人的 UUID 锁和未登记 PID sidecar 不被覆盖、停止或清除", async () => {
  const c = await childUnit(), f = persistedFixture(c.unit), manager = f.make();
  try {
    const foreign = JSON.stringify({ dataDir: "/other", sessionId: "other", generation: randomUUID() }); fs.writeFileSync(f.ownerFile, foreign);
    assert.equal(await manager.close("session"), false); assert.equal(fs.readFileSync(f.ownerFile, "utf8"), foreign); assert.equal(processIdentity(c.unit.pid), c.unit.processIdentity);
  } finally { await manager.shutdown(); c.child.kill(); await c.exited; f.cleanup(); }
  const c2 = await childUnit(), f2 = persistedFixture(c2.unit), manager2 = f2.make();
  try {
    fs.writeFileSync(path.join(f2.binding.socketDir, "unknown.pid"), String(c2.unit.pid));
    assert.equal(await manager2.close("session"), false); assert.equal(fs.existsSync(path.join(f2.binding.socketDir, "unknown.pid")), true); assert.equal(processIdentity(c2.unit.pid), c2.unit.processIdentity);
  } finally { await manager2.shutdown(); c2.child.kill(); await c2.exited; f2.cleanup(); }
});

test("首次发送窗口缺身份时保留 unavailable 与锁；缺版本或 fingerprint 变化先拒绝 CLI", async () => {
  const f = persistedFixture(null); f.binding.daemonPending = true; f.setState(f.binding); const manager = f.make();
  try { assert.equal(await manager.close("session"), false); assert.equal(fs.existsSync(f.ownerFile), true); }
  finally { await manager.shutdown(); f.cleanup(); }
  for (const mode of ["missing", "changed"]) {
    const c = await childUnit(), current = persistedFixture(c.unit), m = current.make();
    try {
      const file = path.join(current.binding.socketDir, `${current.binding.cliSession}.${mode === "missing" ? "version" : "config"}`);
      if (mode === "missing") fs.rmSync(file); else fs.writeFileSync(file, "ffffffffffffffff");
      await assert.rejects(m.command("session", ["click", "#submit"]), error("browser_identity_unverified", false));
      assert.equal(m.status("session")?.state, "unavailable"); assert.equal(processIdentity(c.unit.pid), c.unit.processIdentity);
      assert.equal(await m.close("session"), true); await c.exited;
    } finally { await m.shutdown(); if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill(); await c.exited; current.cleanup(); }
  }
});

test("宿主未准备固定官方程序时不创建 profile 或新实例", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-browser-prepare-")), binary = path.join(root, "fake"); fs.writeFileSync(binary, "fake");
  const manager = new BrowserManager({ dataDir: root, binaryPath: binary, store: { getMetaValue: () => null }, persist: () => assert.fail("拒绝程序时不得登记绑定") });
  try { await assert.rejects(manager.start("session"), error("browser_unavailable", false)); assert.equal(manager.status("session"), null); assert.equal(fs.existsSync(path.join(root, "browser")), false); }
  finally { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const pending of [false, true]) test(`浏览器关闭持久化失败仍停止${pending ? "启动窗口中" : "已登记"}的本次 daemon，保留未核实结论`, async () => {
  const c = await childUnit(), f = persistedFixture(c.unit);
  if (pending) { f.binding.daemonPending = true; f.binding.daemon = null; f.setState(f.binding); }
  let fail = true;
  const manager = f.make(() => { if (fail) throw new Error("测试存储失败"); });
  try {
    assert.equal(await manager.close("session"), false);
    await waitFor(() => processIdentity(c.unit.pid) === null); await c.exited;
    assert.equal(manager.status("session")?.state, "unavailable"); assert.equal(fs.existsSync(f.ownerFile), true);
  } finally { fail = false; await manager.shutdown(); if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill(); await c.exited; f.cleanup(); }
});

for (const failedWire of [false, true]) test(`浏览器${failedWire ? "已丢响应" : "成功写入后"}持久化失败保留本次未知效果`, async () => {
  const c = await childUnit(), f = persistedFixture(c.unit), cli = cliFixture();
  let failPersist = false, writes = 0;
  const manager = f.make(() => { if (failPersist) throw new Error("测试存储失败"); });
  const server = createServer((_req, response) => { writes++; failPersist = true; response.end("ok"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  fs.writeFileSync(cli.script, `let input='';for await(const part of process.stdin)input+=part;const [command]=JSON.parse(input);await fetch(process.env.POST_URL,{method:'POST'});process.stdout.write(JSON.stringify([{command,success:${!failedWire},result:${failedWire ? "null" : "{}"}${failedWire ? ",code:'outcome_unknown'" : ""}}]));process.exit(${failedWire ? 1 : 0});`);
  // 替身只覆盖固定程序准备和 wire；execute、进程身份、保存失败与收尾仍用真实管理器。
  Object.assign(manager, { prepare: async () => {}, argv: () => [cli.script], envFor: () => ({ ...process.env, POST_URL: `http://127.0.0.1:${address.port}/` }) });
  try {
    await assert.rejects(manager.command("session", ["click", "@e1"]), error("outcome_unknown", true));
    assert.equal(writes, 1); assert.equal(manager.status("session")?.outcomeUnknown, true); assert.equal(manager.status("session")?.state, "unavailable");
  } finally { failPersist = false; await manager.shutdown(); if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill(); await c.exited; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup(); cli.cleanup(); }
});

for (const canceled of [true, false]) test(`CDP discovery 持续慢流仍响应${canceled ? "取消" : "总期限"}`, async () => {
  let ready!: () => void;
  const seen = new Promise<void>(resolve => { ready = resolve; });
  const server = createServer((_req, response) => {
    response.writeHead(200); response.write(" "); ready();
    const timer = setInterval(() => response.write(" "), 20); response.on("close", () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const controller = new AbortController(), start = Date.now();
  const pending = resolveBrowserEndpoint(`http://127.0.0.1:${address.port}`, controller.signal);
  const assertion = assert.rejects(pending, error(canceled ? "browser_not_sent" : "browser_invalid_target", false));
  let deadline: NodeJS.Timeout | undefined;
  try {
    await seen; if (canceled) controller.abort();
    await Promise.race([assertion, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("discovery 未在总预算内结束")), 5000); })]);
    assert.ok(Date.now() - start < (canceled ? 1000 : 4500));
  } finally { clearTimeout(deadline); controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await assertion; }
});
