import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vm from "node:vm";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { test, type TestContext } from "node:test";

type Frame = { kind: string; id?: number; method?: string; args?: unknown[]; result?: unknown };
type Timer = { callback: () => void; cleared: boolean; milliseconds: number };
type Listener = (value?: string) => void;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "rk-mygo-wait-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const frames: Frame[] = [], timers: Timer[] = [], writes: (() => void)[] = [];
  const inputListeners = new Map<string, Listener>(), hostCalls: string[] = [];
  let blockWrites = false, closedHost = false;
  const source = fs.readFileSync(new URL("../apps/desktop/src/mygo/sidecar.ts", import.meta.url), "utf8");
  const bundled = await build({ stdin: { contents: source, resolveDir: path.resolve(import.meta.dirname, "../apps/desktop/src/mygo"), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", plugins: [{ name: "native-wait-fixture", setup(builder) {
    builder.onResolve({ filter: /^(\.\.\/main\/(host|ipc|environment)\.ts|@ruukoto\/control\/client\.ts|node:readline)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => {
      if (args.path === "node:readline") return { contents: "export const createInterface = () => globalThis.fixtureInput;", loader: "js" };
      if (args.path.includes("/environment")) return { contents: "export class DesktopError extends Error { constructor(code,message) { super(message); this.code=code; } }", loader: "js" };
      if (args.path.includes("/client")) return { contents: "export class ControlClientError extends Error { constructor(code,message,outcome) { super(message); this.code=code; this.outcome=outcome; } }", loader: "js" };
      if (args.path.includes("/ipc")) return { contents: "export async function ipcResult(action) { try { return {ok:true,value:await action()}; } catch(error) { return {ok:false,error:{code:error.code,message:error.message,outcome:error.outcome??'not_sent'}}; } }", loader: "js" };
      return { contents: "export class DesktopHost { constructor(_repo,_data,_platform,_env,_other,browser) { this.browser=browser; } request(_target,op) { globalThis.fixtureHostCalls.push(op); return this.browser.command('status',{}); } async close() { globalThis.fixtureCloseHost(); } }", loader: "js" };
    });
  } }], define: { __RUUKOTO_REPOSITORY__: JSON.stringify(directory) } });
  const output = bundled.outputFiles?.[0]; assert.ok(output);
  const input = { on(event: string, listener: Listener) { inputListeners.set(event, listener); }, close() { inputListeners.get("close")?.(); } };
  const sandbox = { globalThis: {} as Record<string, unknown>, fixtureInput: input, fixtureHostCalls: hostCalls, fixtureCloseHost: () => { closedHost = true; }, Buffer, Map, Promise, process: { argv: ["node", "sidecar", directory], stdin: { destroy() {} }, stdout: { write(text: string, callback: () => void) { frames.push(JSON.parse(text) as Frame); if (blockWrites) writes.push(callback); else callback(); }, on() {} }, stderr: { write() {} }, on() {}, exitCode: 0 }, setTimeout(callback: () => void, milliseconds: number) { const timer = { callback, cleared: false, milliseconds }; timers.push(timer); return timer; }, clearTimeout(timer: Timer) { timer.cleared = true; } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output.text, sandbox);
  return { frames, timers, hostCalls, get closedHost() { return closedHost; }, get exitCode() { return sandbox.process.exitCode; }, receive(value: object) { inputListeners.get("line")?.(JSON.stringify(value)); }, eof() { input.close(); }, block() { blockWrites = true; }, releaseWrites() { blockWrites = false; for (const write of writes.splice(0)) write(); }, expire() { for (const timer of timers) if (!timer.cleared) { timer.cleared = true; timer.callback(); } } };
}

test("Actual sidecar correlates private browser replies and retains timeout outcomes", async t => {
  const f = await fixture(t);
  f.receive({ id: 1, method: "request", args: ["code", "browser", {}] }); await settle();
  const request = f.frames.find(frame => frame.kind === "request" && frame.method === "browser_command"); assert.ok(request);
  f.receive({ kind: "response", id: request.id, result: { ok: true, value: { generation: 3 } } }); await settle();
  assert.deepEqual(f.frames.find(frame => frame.kind === "result" && frame.id === 1)?.result, { ok: true, value: { generation: 3 } });
  f.receive({ id: 2, method: "request", args: ["code", "browser", {}] }); await settle();
  f.expire(); await settle();
  const result = f.frames.find(frame => frame.kind === "result" && frame.id === 2)?.result as { ok: boolean; error: { code: string; outcome: string } };
  assert.equal(result.ok, false); assert.equal(result.error.code, "bridge_timeout"); assert.equal(result.error.outcome, "unknown");
  f.eof(); await settle(); assert.equal(f.closedHost, true);
});
