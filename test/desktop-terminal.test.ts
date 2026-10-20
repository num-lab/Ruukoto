import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { resolveDirIdentitySync } from "@ruukoto/core/dir-identity.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { TerminalManager, type TerminalPty, type PtyFactory } from "../apps/desktop/src/main/terminal.ts";
import { DesktopError } from "../apps/desktop/src/main/environment.ts";
import { handleRequest } from "../apps/desktop/src/main/ipc.ts";
import { DesktopInspector } from "../apps/desktop/src/renderer/inspector.ts";
import type { DesktopTerminalUpdate, DesktopResult } from "../apps/desktop/src/shared/bridge.ts";
import { vendorTerminal } from "../apps/desktop/build/terminal.mjs";
import { fakeSnapshot } from "./helpers/fake-control.ts";
import { waitFor } from "./helpers/testkit.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-terminal-"));
  return { root, identity: resolveDirIdentitySync(root), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function fakePty(pid: number) {
  let output: (data: string) => void = () => {};
  let exit: (event: { exitCode: number; signal?: number }) => void = () => {};
  const writes: string[] = [], sizes: number[][] = [];
  let paused = false;
  const pty: TerminalPty = { pid, write: data => { writes.push(typeof data === "string" ? data : data.toString()); }, resize: (cols, rows) => { sizes.push([cols, rows]); }, pause: () => { paused = true; }, resume: () => { paused = false; }, onData: listener => { output = listener; return { dispose() {} }; }, onExit: listener => { exit = listener; return { dispose() {} }; } };
  return { pty, writes, sizes, paused: () => paused, output: (data: string) => output(data), exit: () => exit({ exitCode: 0 }) };
}
const code = (expected: string) => (error: unknown) => error instanceof DesktopError && error.code === expected;

test("终端按真实工作区启动，输入/尺寸、参数拒绝、重复引用与8个上限", async () => {
  const f = fixture(), children = Array.from({ length: 8 }, (_, i) => fakePty(i + 10));
  let opened = 0;
  const stopped: number[] = [];
  const manager = new TerminalManager((shell, args, options) => { assert.equal(shell, "/bin/sh"); assert.deepEqual(args, ["-l"]); assert.equal(options.cwd, f.identity.cwdReal); assert.equal(options.env?.TERM, "xterm-256color"); return children[opened++].pty; }, () => {}, async pid => { stopped.push(pid); });
  try {
    const id = randomUUID();
    manager.open(id, f.identity, 80, 24, { SHELL: "/bin/sh" });
    manager.input(id, "中文\r"); manager.resize(id, 120, 32);
    assert.deepEqual(children[0].writes, ["中文\r"]); assert.deepEqual(children[0].sizes, [[120, 32]]);
    assert.throws(() => manager.open(id, f.identity, 80, 24, {}), code("terminal_exists"));
    for (const [cols, rows] of [[0, 1], [501, 24], [80, 301], [2.5, 24]]) assert.throws(() => manager.resize(id, cols, rows), code("invalid_params"));
    assert.throws(() => manager.input(id, "a".repeat(65537)), code("invalid_params"));
    for (let i = 1; i < 8; i++) manager.open(randomUUID(), f.identity, 80, 24, { SHELL: "/bin/sh" });
    assert.throws(() => manager.open(randomUUID(), f.identity, 80, 24, {}), code("terminal_limit"));
    await manager.kill(id); await manager.kill(id); assert.deepEqual(stopped, [10]);
    await manager.close(); assert.equal(stopped.length, 8);
    assert.throws(() => manager.open(randomUUID(), f.identity, 80, 24, {}), code("terminal_closed"));
  } finally { await manager.close(); f.cleanup(); }
});

test("终端拒绝同路径目录被替换，不启动PTY", async () => {
  const f = fixture();
  const manager = new TerminalManager(() => { throw new Error("不得启动"); }, () => {}, async () => {});
  try {
    fs.renameSync(f.root, `${f.root}-old`); fs.mkdirSync(f.root);
    assert.throws(() => manager.open(randomUUID(), f.identity, 80, 24, {}), code("terminal_workspace_changed"));
  } finally { await manager.close(); f.cleanup(); fs.rmSync(`${f.root}-old`, { recursive: true, force: true }); }
});

test("终端合并输出、中文跨64KiB帧保留字节、退出尾帧先于exit，阻塞发送暂停PTY", async () => {
  const f = fixture(), child = fakePty(10), updates: DesktopTerminalUpdate[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const manager = new TerminalManager(() => child.pty, async update => { updates.push(update); if (updates.length === 1) await blocked; }, async () => {});
  try {
    const id = randomUUID(); manager.open(id, f.identity, 80, 24, {});
    const text = "a".repeat(65535) + "中文";
    child.output(text); assert.equal(child.paused(), true); child.exit();
    await waitFor("首帧", () => updates.length === 1); assert.equal(updates[0].kind, "output");
    release(); await waitFor("退出帧", () => updates.at(-1)?.kind === "exit");
    const chunks = updates.filter((update): update is Extract<DesktopTerminalUpdate, { kind: "output" }> => update.kind === "output").map(update => Buffer.from(update.data, "base64"));
    assert.ok(chunks.every(chunk => chunk.length <= 65536)); assert.equal(Buffer.concat(chunks).toString(), text);
  } finally { release(); await manager.close(); f.cleanup(); }
});

test("终端op只向Code本机入口开放，不转发控制面或接受未知前缀", async () => {
  const locals: string[] = [];
  for (const op of ["desktop_terminal_open", "desktop_terminal_input", "desktop_terminal_resize", "desktop_terminal_kill"]) {
    const result = await handleRequest("code", op, {}, async () => {}, async () => { throw new Error("不得转发"); }, local => { locals.push(local); });
    assert.equal(result.ok, true);
    const rejected = await handleRequest("personal", op, {}, async () => {}, async () => {}, () => { throw new Error("不得放行"); });
    assert.equal(rejected.ok, false);
  }
  assert.equal(locals.length, 4);
  assert.equal((await handleRequest("code", "desktop_terminal_arbitrary", {}, async () => {}, async () => {})).ok, false);
});

test("终端标签跨父会话保留、输出不重绘、关闭与迟到open回收", async () => {
  const f = fixture(), view = new ViewState();
  view.instanceId = "inst-1";
  view.projects = ["w1", "w2"].map(id => ({ id, name: id, rootDir: f.identity, createRequestId: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: "" }));
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  let changed = 0, release!: (result: DesktopResult<unknown>) => void;
  const inspector = new DesktopInspector({ request: async (_target, op, params) => { calls.push({ op, params }); if (op === "desktop_terminal_open") return new Promise(resolve => { release = resolve; }); return { ok: true, value: null }; } }, view, async () => {}, () => { changed++; });
  try {
    inspector.parentSessionId = "a"; inspector.openTerminal("w1"); inspector.openTerminal("w2");
    const [first, second] = inspector.terminalTabs();
    assert.equal(first.workspaceId, "w1"); assert.equal(second.workspaceId, "w2");
    inspector.parentSessionId = "b"; inspector.openTerminal("w1");
    assert.equal(inspector.terminalTabs().length, 3); assert.equal(calls.length, 0);
    const frames: DesktopTerminalUpdate[] = []; inspector.listenTerminal(first.id, update => frames.push(update));
    const before = changed; inspector.update({ type: "terminal", id: first.id, kind: "output", data: Buffer.from("中文").toString("base64") }); assert.equal(changed, before); assert.equal(frames.length, 1);
    const starting = inspector.startTerminal(first, 80, 24);
    inspector.parentSessionId = "a"; inspector.closeTab(first.id); release({ ok: true, value: { id: first.id, cwd: f.root } });
    assert.equal(await starting, false); assert.ok(calls.filter(call => call.op === "desktop_terminal_kill").every(call => call.params.id === first.id));
    inspector.closeParent("b"); assert.equal(inspector.terminalTabs().length, 1);
    inspector.update({ type: "snapshot", instanceChanged: true, result: { seq: 0, replay: [], snapshot: fakeSnapshot() } }); assert.equal(inspector.terminalTabs().length, 0);
    const personal = new DesktopInspector({ request: async () => { throw new Error("不得请求"); } }, view, async () => {}, () => {}, "personal"); personal.openTerminal("w1"); assert.equal(personal.terminalTabs().length, 0);
  } finally { f.cleanup(); }
});

test("终端按钮打开当前会话归属的工作区，未归属或无根目录不开", () => {
  const f = fixture(), view = new ViewState();
  view.instanceId = "inst-1";
  view.projects = ["w1", "w2"].map(id => ({ id, name: id, rootDir: id === "w2" ? null : f.identity, createRequestId: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: "" }));
  view.sessions = [{ id: "a", projectId: "w1", workspaceProjectId: null, kind: "dev", name: null, branchSource: null, cwd: "/work/w1", cwdReal: "/work/w1", cwdDev: 1, cwdIno: 1, piSessionId: "a", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, archivedAt: null, createdAt: "" }];
  const inspector = new DesktopInspector({ request: async () => { throw new Error("打开前不应请求"); } }, view, async () => {}, () => {});
  try {
    inspector.parentSessionId = "a"; inspector.openTerminal();
    const [tab] = inspector.terminalTabs();
    assert.equal(tab.workspaceId, "w1"); assert.equal(tab.cwd, f.identity.cwdReal); assert.equal(tab.instanceId, "inst-1");
    // 无当前会话时按 w2 显式调用，但 w2 没有登记根目录，按钮禁用路径同样不开终端。
    inspector.parentSessionId = null; inspector.openTerminal("w2"); assert.equal(inspector.terminalTabs().length, 1);
  } finally { f.cleanup(); }
});

function realFactory(root: string): PtyFactory {
  vendorTerminal(root);
  // 隔离副本验证 runtime JS、native 与 helper，禁止回退到仓库 node_modules。
  return createRequire(import.meta.url)(path.join(root, "vendor/node-pty/lib/index.js")).spawn;
}

test("真实PTY：中文、cwd、stty resize与大输出完整，native缺失不跳过", async () => {
  const f = fixture(), updates: DesktopTerminalUpdate[] = [];
  const manager = new TerminalManager(realFactory(f.root), update => { updates.push(update); });
  const id = randomUUID();
  const output = () => Buffer.concat(updates.filter((update): update is Extract<DesktopTerminalUpdate, { kind: "output" }> => update.kind === "output").map(update => Buffer.from(update.data, "base64"))).toString();
  try {
    manager.open(id, f.identity, 80, 24, { ...process.env, SHELL: "/bin/bash" });
    manager.resize(id, 100, 30);
    manager.input(id, "printf '中文'; pwd; stty size\r");
    await waitFor("真实终端尺寸", () => /30 100/.test(output())); assert.ok(output().includes(f.identity.cwdReal)); assert.ok(output().includes("中文"));
    manager.input(id, "python3 -c 'print(\"x\"*200000)' ; printf '\\nDONE\\n'\r");
    await waitFor("大输出尾部", () => output().includes("\r\nDONE\r\n")); assert.ok(output().includes("x".repeat(200000)));
  } finally { await manager.close(); f.cleanup(); }
});

test("真实交互前台进程组忽略TERM/HUP，shell提前退出仍升级回收", async () => {
  const f = fixture();
  const factory = realFactory(f.root);
  let shellPid = 0, text = "";
  const manager = new TerminalManager((...args) => { const pty = factory(...args); shellPid = pty.pid; return pty; }, update => { if (update.kind === "output") text += Buffer.from(update.data, "base64").toString(); });
  const id = randomUUID();
  let childPid = 0;
  try {
    manager.open(id, f.identity, 80, 24, { ...process.env, SHELL: "/bin/bash" });
    manager.input(id, `python3 -c 'import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); signal.signal(signal.SIGHUP,signal.SIG_IGN); print("CHILD="+str(os.getpid()),flush=True); time.sleep(60)'\r`);
    await waitFor("前台进程已启动", () => /CHILD=(\d+)/.test(text)); childPid = Number(/CHILD=(\d+)/.exec(text)![1]);
    assert.notEqual(childPid, shellPid); await manager.kill(id);
    await waitFor("前台进程已回收", () => { try { process.kill(childPid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } });
  } finally {
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); } }
    await manager.close(); f.cleanup();
  }
});

for (const action of ["kill", "reset", "close"] as const) test(`宿主打开期间${action}阻止迟到PTY创建`, async () => {
  const { DesktopHost } = await import("../apps/desktop/src/main/host.ts");
  const f = fixture();
  let release!: (value: { env: NodeJS.ProcessEnv; node: string }) => void;
  const reading = new Promise<{ env: NodeJS.ProcessEnv; node: string }>(resolve => { release = resolve; });
  let spawns = 0;
  const host = new DesktopHost(f.root, path.join(f.root, "user"), { publish() {}, focused: () => true, notice() {}, badge() {} }, () => reading, () => { spawns++; return fakePty(10).pty; });
  // 本用例固定可信快照输入，不伪造renderer可直接注入宿主快照的入口。
  const publish = Reflect.get(host, "publish").bind(host) as (target: "code", update: import("../apps/desktop/src/shared/bridge.ts").DesktopUpdate) => void;
  publish("code", { type: "snapshot", instanceChanged: false, result: { seq: 0, replay: [], snapshot: fakeSnapshot({ projects: [{ id: "workspace", name: "工作区", rootDir: f.identity, createRequestId: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: "" }] }) } });
  try {
    const id = randomUUID();
    assert.equal((await host.request("code", "desktop_terminal_open", { id, workspace_id: "workspace", instance_id: "old", cols: 80, rows: 24 })).ok, false);
    const opening = host.request("code", "desktop_terminal_open", { id, workspace_id: "workspace", instance_id: "inst-1", cols: 80, rows: 24 });
    if (action === "kill") await host.request("code", "desktop_terminal_kill", { id });
    else if (action === "reset") host.resetTerminals();
    else void host.close();
    release({ env: { ...process.env }, node: process.execPath });
    assert.equal((await opening).ok, false); assert.equal(spawns, 0);
  } finally { release({ env: { ...process.env }, node: process.execPath }); await host.close(); f.cleanup(); }
});

test("MyGo并发调度仍串行发送终端输入和尺寸，失败后不继续发送", async () => {
  const f = fixture(), view = new ViewState();
  view.instanceId = "inst-1"; view.projects = [{ id: "workspace", name: "工作区", rootDir: f.identity, createRequestId: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: "" }];
  const sent: string[] = [];
  let release!: (value: DesktopResult<unknown>) => void;
  const inspector = new DesktopInspector({ request: async (_target, op, params) => { sent.push(op === "desktop_terminal_input" ? String(params.data) : "resize"); if (sent.length === 1) return new Promise(resolve => { release = resolve; }); return { ok: true, value: null }; } }, view, async () => {}, () => {});
  try {
    inspector.openTerminal("workspace"); const tab = inspector.terminalTabs()[0];
    const a = inspector.sendTerminal(tab, "desktop_terminal_input", { data: "a" });
    const b = inspector.sendTerminal(tab, "desktop_terminal_input", { data: "b" });
    const resize = inspector.sendTerminal(tab, "desktop_terminal_resize", { cols: 100, rows: 30 });
    await Promise.resolve(); assert.deepEqual(sent, ["a"]);
    release({ ok: true, value: null }); await Promise.all([a, b, resize]); assert.deepEqual(sent, ["a", "b", "resize"]);
    tab.error = "输入结果无法核实";
    await inspector.sendTerminal(tab, "desktop_terminal_input", { data: "c" }); assert.equal(sent.length, 3);
  } finally { f.cleanup(); }
});

test("关闭标签的回收失败保持可见并能重试，成功才清除", async () => {
  const f = fixture(), view = new ViewState();
  view.instanceId = "inst-1"; view.projects = [{ id: "workspace", name: "工作区", rootDir: f.identity, createRequestId: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: "" }];
  let failed = true, changed = 0;
  const inspector = new DesktopInspector({ request: async () => failed ? { ok: false, error: { code: "terminal_stop_failed", outcome: "not_sent", message: "终端仍有进程运行" } } : { ok: true, value: null } }, view, async () => {}, () => { changed++; });
  try {
    inspector.openTerminal("workspace"); const id = inspector.terminalTabs()[0].id; inspector.closeTab(id);
    await waitFor("关闭失败可见状态", () => inspector.terminalStopFailures.has(id)); assert.equal(inspector.terminalStopFailures.get(id)?.message, "终端仍有进程运行"); assert.equal(inspector.terminalTabs().length, 0);
    failed = false; inspector.retryTerminalStop(id); await waitFor("重试后清除失败", () => !inspector.terminalStopFailures.has(id)); assert.ok(changed > 2);
  } finally { f.cleanup(); }
});
