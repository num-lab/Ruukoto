import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopBridge, DesktopResult } from "../apps/desktop/src/shared/bridge.ts";
import { PersonalConnectionState, type PersonalPermissionMode } from "../apps/desktop/src/renderer/personal-connection-state.ts";

const config = { v: 1 as const, origin: "https://pa.example", binding: { remoteId: "00000000-0000-4000-8000-000000000001", profile: { id: "sha256:" + "a".repeat(64), directory: "/test/profile" } } };
const ok = (value: unknown): DesktopResult<unknown> => ({ ok: true, value });
const lost = (): DesktopResult<unknown> => ({ ok: false, error: { code: "connection_lost", message: "原权限保存应答丢失，请重新读取。", outcome: "unknown" } });
function fixture() {
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const modes: { default: { mode: PersonalPermissionMode }; qq: { mode: PersonalPermissionMode } } = { default: { mode: "confirm" }, qq: { mode: "auto-review" } };
  let current = structuredClone(config), failRead = false, dropWrite = false;
  let hold: (() => Promise<DesktopResult<unknown>>) | undefined;
  const bridge: Pick<DesktopBridge, "request"> = { request: async (_target, op, params) => {
    calls.push({ op, params: structuredClone(params) });
    if (op === "desktop_personal_config_read") return ok(current);
    if (op === "desktop_personal_legacy_read") return ok({ paths: [] });
    assert.equal(op, "desktop_personal_request"); assert.equal(params.path, "/permissions");
    if (params.method === "GET") return failRead ? lost() : ok(structuredClone(modes));
    if (hold) return hold();
    const body = params.body as { mode: PersonalPermissionMode; scope?: "qq" };
    modes[body.scope ?? "default"].mode = body.mode;
    return dropWrite ? lost() : ok({ saved: true });
  } };
  return { state: new PersonalConnectionState(bridge, () => {}), calls, modes, setReadFailure(value: boolean) { failRead = value; }, setDroppedWrite() { dropWrite = true; }, setHold(value: typeof hold) { hold = value; }, switchProfile() { current = { ...current, binding: { ...current.binding, profile: { ...current.binding.profile, id: "sha256:" + "b".repeat(64) } } }; }, posts: () => calls.filter(call => call.params.method === "POST") };
}

test("Personal permission settings read actual shared and QQ defaults and bind every save to the paired profile", async () => {
  const f = fixture(); await f.state.read();
  assert.equal(f.state.permissions?.default.mode, "confirm"); assert.equal(f.state.permissions?.qq.mode, "auto-review");
  await f.state.selectPermission("qq", "confirm");
  assert.deepEqual(f.posts()[0].params, { method: "POST", path: "/permissions", body: { mode: "confirm", scope: "qq" }, connection: config });
  assert.equal(f.state.permissions?.default.mode, "confirm"); assert.equal(f.state.permissions?.qq.mode, "confirm");
  await f.state.selectPermission("default", "auto-review");
  assert.deepEqual(f.posts()[1].params.body, { mode: "auto-review" });
  assert.equal(f.state.permissions?.default.mode, "auto-review");
});

test("Personal full access needs an explicit settings confirmation and cancel sends nothing", async () => {
  const f = fixture(); await f.state.read(); await f.state.selectPermission("default", "full_access");
  assert.equal(f.state.confirming, true); assert.equal(f.posts().length, 0);
  f.state.cancelPermission(); assert.equal(f.state.confirming, false); assert.equal(f.posts().length, 0);
  await f.state.selectPermission("qq", "full_access"); await f.state.confirmPermission();
  assert.equal(f.state.permissions?.qq.mode, "full_access"); assert.deepEqual(f.posts()[0].params.body, { mode: "full_access", scope: "qq" });
});

test("Personal lost permission save is inspected once without resending and failed inspection locks controls", async () => {
  const f = fixture(); await f.state.read(); f.setDroppedWrite(); f.setReadFailure(true);
  await f.state.selectPermission("default", "auto-review");
  assert.equal(f.posts().length, 1); assert.equal(f.state.permissionsDisabled, true); assert.equal(f.state.permissions, null);
  await f.state.selectPermission("default", "confirm"); assert.equal(f.posts().length, 1);
  f.setReadFailure(false); await f.state.readPermissions();
  assert.deepEqual(f.state.permissions, { default: { mode: "auto-review" }, qq: { mode: "auto-review" } }); assert.equal(f.state.permissionsDisabled, false); assert.equal(f.posts().length, 1);
});

test("Personal permission responses cannot overwrite a newly selected profile", async () => {
  const f = fixture(); await f.state.read();
  let release!: (value: DesktopResult<unknown>) => void;
  f.setHold(() => new Promise(done => { release = done; }));
  const saving = f.state.selectPermission("qq", "confirm"); assert.equal(f.state.permissionsReading, true);
  f.state.invalidate(); f.switchProfile(); await f.state.read();
  const reads = f.calls.length; release(ok({ saved: true })); await saving;
  assert.equal(f.calls.length, reads); assert.equal(f.state.permissions?.qq.mode, "auto-review"); assert.equal(f.posts().length, 1);
});

test("Personal permissions SSR identifies actual scope and preserves the granted-range choice", async t => {
  const { createElement } = await import("react"), { renderToStaticMarkup } = await import("react-dom/server");
  const { createServer } = await import("./helpers/vite.ts"), { default: react } = await import("@vitejs/plugin-react"), { fileURLToPath } = await import("node:url");
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { PersonalPermissionSettings } = await server.ssrLoadModule("/personal-connection-settings.tsx"), f = fixture(); await f.state.read();
  const html = renderToStaticMarkup(createElement(PersonalPermissionSettings, { state: f.state }));
  assert.match(html, /Desktop, local and Telegram/); assert.match(html, /QQ \(independent default\)/); assert.match(html, /Authorized scope/); assert.match(html, /request approval/);
  assert.doesNotMatch(html, /ask me everything/i);
});
