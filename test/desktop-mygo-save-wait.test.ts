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
    builder.onResolve({ filter: /^(\.\/personal-credential-pipe\.ts|\.\.\/main\/(host|ipc|environment)\.ts|@ruukoto\/control\/client\.ts|node:readline)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => {
      if (args.path === "node:readline") return { contents: "export const createInterface = () => globalThis.fixtureInput;", loader: "js" };
      if (args.path.includes("personal-credential-pipe")) return { contents: "export class PersonalCredentialPipe { receive() { return false; } close() {} }", loader: "js" };
      if (args.path.includes("/environment")) return { contents: "export class DesktopError extends Error { constructor(code,message) { super(message); this.code=code; } }", loader: "js" };
      if (args.path.includes("/client")) return { contents: "export class ControlClientError extends Error { constructor(code,message,outcome) { super(message); this.code=code; this.outcome=outcome; } }", loader: "js" };
      if (args.path.includes("/ipc")) return { contents: "export async function ipcResult(action) { try { return {ok:true,value:await action()}; } catch(error) { return {ok:false,error:{code:error.code,message:error.message,outcome:error.outcome??'not_sent'}}; } }", loader: "js" };
      return { contents: "export class DesktopHost { constructor(_repo,_data,platform,_env,_other,browser) { this.platform=platform; this.browser=browser; globalThis.fixtureHost=this; } request(_target,op) { globalThis.fixtureHostCalls.push(op); if(op==='desktop_personal_output_save') return this.platform.pickOutput('final.txt').then(value=>({ok:true,value:{state:value===null?'canceled':'saved'}}),error=>({ok:false,error:{code:error.code,outcome:error.outcome??'not_sent'}})); if(op==='browser') return this.browser.command('status',{}); if(op==='desktop_personal_output_preview') return this.platform.previewOutput('/tmp/ruukoto-output-fixture/final.txt','final.txt').then(close=>{this.previewClose=close;return {ok:true,value:{state:'previewed'}};}); return Promise.resolve({ok:true,value:null}); } async close() { globalThis.fixtureCloseHost(); if(this.previewClose) await this.previewClose(); } }", loader: "js" };
    });
  } }], define: { __RUUKOTO_REPOSITORY__: JSON.stringify(directory) } });
  const output = bundled.outputFiles?.[0]; assert.ok(output);
  const input = { on(event: string, listener: Listener) { inputListeners.set(event, listener); }, close() { inputListeners.get("close")?.(); } };
  const sandbox = { globalThis: {} as Record<string, unknown>, fixtureInput: input, fixtureHostCalls: hostCalls, fixtureCloseHost: () => { closedHost = true; }, Buffer, Map, Promise, process: { argv: ["node", "sidecar", directory], stdin: { destroy() {} }, stdout: { write(text: string, callback: () => void) { frames.push(JSON.parse(text) as Frame); if (blockWrites) writes.push(callback); else callback(); }, on() {} }, stderr: { write() {} }, on() {}, exitCode: 0 }, setTimeout(callback: () => void, milliseconds: number) { const timer = { callback, cleared: false, milliseconds }; timers.push(timer); return timer; }, clearTimeout(timer: Timer) { timer.cleared = true; } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output.text, sandbox);
  return { frames, timers, hostCalls, get closedHost() { return closedHost; }, get exitCode() { return sandbox.process.exitCode; }, receive(value: object) { inputListeners.get("line")?.(JSON.stringify(value)); }, eof() { input.close(); }, block() { blockWrites = true; }, releaseWrites() { blockWrites = false; for (const write of writes.splice(0)) write(); }, expire() { for (const timer of timers) if (!timer.cleared) { timer.cleared = true; timer.callback(); } } };
}

test("Actual MyGo sidecar keeps a delivered save chooser pending beyond the ordinary deadline and handles another request", async t => {
  const f = await fixture(t);
  f.receive({ id: 1, method: "request", args: ["personal", "desktop_personal_output_save", {}] }); await settle();
  const chooser = f.frames.find(frame => frame.kind === "request" && frame.method === "output_choose"); assert.ok(chooser);
  assert.equal(f.timers[0].milliseconds, 60_000); assert.equal(f.timers[0].cleared, true);
  f.expire(); await settle(); assert.equal(f.frames.some(frame => frame.kind === "result" && frame.id === 1), false);
  f.receive({ id: 2, method: "focus", args: [true] }); await settle();
  assert.ok(f.frames.some(frame => frame.kind === "result" && frame.id === 2)); assert.equal(f.closedHost, false);
  f.receive({ kind: "response", id: chooser.id, result: { ok: true, value: "/private/chosen.txt" } }); await settle();
  assert.deepEqual(f.frames.find(frame => frame.kind === "result" && frame.id === 1)?.result, { ok: true, value: { state: "saved" } });
  assert.deepEqual(f.hostCalls, ["desktop_personal_output_save"]);
  f.eof(); await settle(); assert.equal(f.closedHost, true);
});

test("Actual MyGo sidecar retains the chooser pipe-write deadline and ordinary native response deadlines", async t => {
  const blocked = await fixture(t); blocked.block();
  blocked.receive({ id: 1, method: "request", args: ["personal", "desktop_personal_output_save", {}] }); await settle();
  assert.equal(blocked.timers[0].cleared, false); blocked.expire(); await settle(); blocked.releaseWrites(); await settle();
  assert.deepEqual(blocked.frames.find(frame => frame.kind === "result" && frame.id === 1)?.result, { ok: false, error: { code: "bridge_timeout", outcome: "unknown" } });
  for (const op of ["browser", "desktop_personal_output_preview"]) {
    const f = await fixture(t); f.receive({ id: 1, method: "request", args: ["personal", op, {}] }); await settle();
    assert.equal(f.timers[0].milliseconds, 60_000); assert.equal(f.timers[0].cleared, false); f.expire(); await settle();
    const result = f.frames.find(frame => frame.kind === "result" && frame.id === 1)?.result as { ok: boolean; error: { code: string } };
    assert.equal(result.ok, false); assert.equal(result.error.code, "bridge_timeout"); f.eof(); await settle();
  }
  blocked.eof(); await settle();
});

test("Actual MyGo sidecar rejects an open chooser on EOF or close before awaiting host shutdown", async t => {
  for (const eof of [false, true]) {
    const f = await fixture(t); f.receive({ id: 1, method: "request", args: ["personal", "desktop_personal_output_save", {}] }); await settle();
    if (eof) f.eof(); else f.receive({ id: 2, method: "close", args: [] });
    await settle(); assert.equal(f.closedHost, true);
    assert.deepEqual(f.frames.find(frame => frame.kind === "result" && frame.id === 1)?.result, { ok: false, error: { code: "bridge_disconnected", outcome: "disconnected" } });
    assert.deepEqual(f.hostCalls, ["desktop_personal_output_save"]);
  }
});

test("Actual MyGo sidecar completes preview shutdown replies and flushes late cleanup on EOF", async t => {
  for (const eof of [false, true]) {
    const f = await fixture(t); f.receive({ id: 1, method: "request", args: ["personal", "desktop_personal_output_preview", {}] }); await settle();
    const opened = f.frames.find(frame => frame.method === "output_preview"); assert.ok(opened);
    f.receive({ kind: "response", id: opened.id, result: { ok: true, value: 1 } }); await settle();
    f.receive({ id: 2, method: "close", args: [] }); await settle();
    const closing = f.frames.find(frame => frame.method === "output_close_preview"); assert.ok(closing);
    assert.equal(f.closedHost, true); assert.equal(f.frames.some(frame => frame.kind === "result" && frame.id === 2), false);
    if (eof) f.eof(); else f.receive({ kind: "response", id: closing.id, result: { ok: true, value: null } });
    await settle();
    const result = f.frames.find(frame => frame.kind === "result" && frame.id === 2)?.result as { ok: boolean };
    assert.ok(result, "shutdown left its newly admitted preview callback pending");
    assert.equal(result.ok, true); assert.equal(f.exitCode, eof ? 1 : 0);
  }
});
