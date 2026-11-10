import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vm from "node:vm";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { sidecarBuildOptions } from "../apps/desktop/scripts/mygo.mjs";
import { vendorTerminal } from "../apps/desktop/build/terminal.mjs";
import { test } from "node:test";
import type { DesktopBridge, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { profileChildEnv, selectProfile } from "@ruukoto/core/profile.ts";

const preload = fs.readFileSync(new URL("../apps/desktop/mygo/preload.js", import.meta.url), "utf8");
function fixture(main = true, href = "mygo://localhost/") {
  const calls: { method: string; args: unknown[] }[] = [];
  let listener: (payload: { target: string; update: DesktopUpdate }) => void = () => {};
  let subscribed = false;
  let removed = false;
  let reject = false;
  const window: { top?: object; ruukoto?: DesktopBridge; mygo: object } = { mygo: {
    call: async (method: string, ...args: unknown[]) => { assert.equal(subscribed, true, "必须先监听再订阅"); calls.push({ method, args }); if (reject) throw new Error("lost response"); return { ok: true, value: null }; },
    on: (event: string, receive: typeof listener) => { assert.equal(event, "desktop:update"); subscribed = true; listener = receive; return () => { removed = true; }; },
  } };
  window.top = main ? window : {};
  vm.runInNewContext(preload, { window, location: { href }, document: { addEventListener() {} } });
  return { window, calls, send: (target: string, update: DesktopUpdate) => listener({ target, update }), removed: () => removed, reject: () => { reject = true; } };
}

test("MyGo 只在固定顶层文档安装 bridge，监听先于订阅且支持取消", async () => {
  for (const f of [fixture(false), fixture(true, "file:///tmp/index.html"), fixture(true, "mygo://localhost/other"), fixture(true, "https://example.com/")]) assert.equal(f.window.ruukoto, undefined);
  const f = fixture();
  const updates: DesktopUpdate[] = [];
  const unsubscribe = f.window.ruukoto!.subscribe("code", update => updates.push(update));
  assert.equal(f.calls[0].method, "Desktop.Subscribe");
  f.send("unknown", { type: "state", state: "closed" });
  f.send("code", { type: "state", state: "online" });
  assert.deepEqual(updates, [{ type: "state", state: "online" }]);
  unsubscribe();
  assert.equal(f.removed(), true);
  const params = {};
  await f.window.ruukoto!.request("code", "get_model_config", params);
  assert.deepEqual(f.calls[1], { method: "Desktop.Request", args: ["code", "get_model_config", params] });
  await f.window.ruukoto!.pickAttachments("code-session");
  await f.window.ruukoto!.pickDraftAttachments();
  await f.window.ruukoto!.uploadDraftAttachments("code-session", ["draft_1"]);
  assert.deepEqual(f.calls.slice(2), [{ method: "Desktop.PickAttachments", args: ["code-session", "code"] }, { method: "Desktop.PickDraftAttachments", args: [] }, { method: "Desktop.UploadDraftAttachments", args: ["code-session", ["draft_1"], "code"] }]);
});

test("MyGo 传输拒绝保留 disconnected，不能变成未发送或自动重放", async () => {
  const f = fixture();
  f.window.ruukoto!.subscribe("code", () => {});
  f.reject();
  const result = await f.window.ruukoto!.request("code", "respond_confirmation", { confirmation_id: "c" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.outcome, "disconnected");
  assert.equal(f.calls.filter(call => call.method === "Desktop.Request").length, 1);
});

test("MyGo 不暴露技能目录选择桥", () => {
  const f = fixture();
  assert.equal(Object.hasOwn(f.window.ruukoto!, "pickSkillFolder"), false);
});

test("MyGo终端四方法复用本机Request并按ID透传输出", async () => {
  const f = fixture(), updates: DesktopUpdate[] = [];
  f.window.ruukoto!.subscribe("code", update => updates.push(update));
  await f.window.ruukoto!.openTerminal("terminal", "workspace", "instance", 80, 24);
  await f.window.ruukoto!.inputTerminal("terminal", "中文\r");
  await f.window.ruukoto!.resizeTerminal("terminal", 100, 30);
  await f.window.ruukoto!.killTerminal("terminal");
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.slice(1))), [
    { method: "Desktop.Request", args: ["code", "desktop_terminal_open", { id: "terminal", workspace_id: "workspace", instance_id: "instance", cols: 80, rows: 24 }] },
    { method: "Desktop.Request", args: ["code", "desktop_terminal_input", { id: "terminal", data: "中文\r" }] },
    { method: "Desktop.Request", args: ["code", "desktop_terminal_resize", { id: "terminal", cols: 100, rows: 30 }] },
    { method: "Desktop.Request", args: ["code", "desktop_terminal_kill", { id: "terminal" }] },
  ]);
  f.send("code", { type: "terminal", id: "terminal", kind: "output", data: "eA==" });
  assert.equal(updates.at(-1)?.type, "terminal");
});

test("共用 DesktopHost 经真实控制面订阅和限制操作，选择器期间的旧实例不读取附件", async () => {
  const { startTestRuntime, waitFor } = await import("./helpers/testkit.ts");
  const { DesktopHost } = await import("../apps/desktop/src/main/host.ts");
  const { adoptEnvironment } = await import("../apps/desktop/src/main/environment.ts");
  const path = await import("node:path");
  const t = await startTestRuntime("mygo-host", async () => ({ kind: "text", text: "ready" }), {});
  const previous = { ...process.env };
  Object.assign(process.env, profileChildEnv(t.runtime.config.profile.selection, { RUUKOTO_DESKTOP_MANAGED: "1" }));
  const updates: DesktopUpdate[] = [];
  const host = new DesktopHost(path.resolve(import.meta.dirname, ".."), path.join(t.dirs.root, "mygo-user-data"), { publish: (target, update) => { if (target === "code") updates.push(update); }, focused: () => true, notice() {}, badge() {} });
  try {
    const opened = await t.runtime.openWorkspace({ cwd: t.work[0] });
    host.subscribe("code");
    await waitFor("DesktopHost 安装真实快照", () => updates.some(update => update.type === "snapshot"));
    assert.equal((await host.request("code", "get_session", { session_id: opened.session.id })).ok, true);
    assert.equal((await host.request("code", "stop", {})).ok, false);
    assert.equal((await host.request("personal", "submit", {})).ok, false);
    assert.ok(host.attachmentInstance());
    let picked = false;
    assert.throws(() => host.pickAttachments(opened.session.id, async () => { picked = true; return ["/must-not-read"]; }, "previous-instance"), { code: "attachment_instance_changed" });
    assert.equal(picked, false);
    await host.close();
    await host.close();
  } finally {
    await host.close();
    adoptEnvironment(previous);
    await t.shutdown();
  }
});

test("Actual bundled MyGo sidecar answers the first private request without credential initialization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mygo-sidecar-bundle-"));
  const output = path.join(root, "out"), marker = path.join(root, "external-loaded");
  fs.mkdirSync(output);
  for (const name of ["bufferutil", "utf-8-validate"]) {
    const external = path.join(root, "node_modules", name);
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "package.json"), JSON.stringify({ name, main: "index.cjs" }));
    fs.writeFileSync(path.join(external, "index.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");`);
  }
  try {
    const repository = path.resolve(import.meta.dirname, "..");
    vendorTerminal(output);
    await build(sidecarBuildOptions(path.join(repository, "apps/desktop"), repository, output));
    const frames = [{ id: 1, method: "focus", args: [false] }];
    const result = spawnSync(process.execPath, ["--disable-sigusr1", "--no-global-search-paths", path.join(output, "sidecar.mjs"), path.join(root, "user-data")], {
      input: frames.map(frame => JSON.stringify(frame) + "\n").join(""), encoding: "utf8", timeout: 10_000,
      env: profileChildEnv(selectProfile({ dataDir: path.join(root, "data") }, {}), { ...process.env, RUUKOTO_DESKTOP_MANAGED: "1", PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` }),
    });
    assert.equal(result.status, 0, result.stderr);
    const replies: unknown[] = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(replies, [{ kind: "result", id: 1, result: { ok: true } }]);
    assert.equal(fs.existsSync(marker), false, "签名 sidecar 不能向外寻找可选依赖代码");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
