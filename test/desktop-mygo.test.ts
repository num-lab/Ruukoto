import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vm from "node:vm";
import { test } from "node:test";
import type { DesktopBridge, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";

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
  f.send("personal", { type: "state", state: "closed" });
  f.send("code", { type: "state", state: "online" });
  assert.deepEqual(updates, [{ type: "state", state: "online" }]);
  unsubscribe();
  assert.equal(f.removed(), true);
  await f.window.ruukoto!.request("code", "read_history", { session_id: "s" });
  assert.deepEqual(f.calls[1], { method: "Desktop.Request", args: ["code", "read_history", { session_id: "s" }] });
  await f.window.ruukoto!.pickAttachments("code-session");
  await f.window.ruukoto!.pickAttachments("main-session", "personal");
  assert.deepEqual(f.calls.slice(2), [{ method: "Desktop.PickAttachments", args: ["code-session", "code"] }, { method: "Desktop.PickAttachments", args: ["main-session", "personal"] }]);
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

test("共用 DesktopHost 经真实控制面订阅和限制操作，选择器期间的旧实例不读取附件", async () => {
  const { startTestRuntime, waitFor } = await import("./helpers/testkit.ts");
  const { product } = await import("../apps/ruukoto-code/src/product.ts");
  const { DesktopHost } = await import("../apps/desktop/src/main/host.ts");
  const { adoptEnvironment } = await import("../apps/desktop/src/main/environment.ts");
  const os = await import("node:os");
  const path = await import("node:path");
  const t = await startTestRuntime("mygo-host", async () => ({ kind: "text", text: "ready" }), { config: { product: product.runtime } });
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "rmg-c-"));
  const previous = { ...process.env };
  fs.symlinkSync(path.join(t.runtime.controlDir(), "owner.token"), path.join(control, "owner.token"));
  fs.symlinkSync(t.runtime.socketPath(), path.join(control, "control.sock"));
  Object.assign(process.env, { RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_CODE_CONTROL_DIR: control, RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir });
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
    fs.rmSync(control, { recursive: true, force: true });
  }
});
