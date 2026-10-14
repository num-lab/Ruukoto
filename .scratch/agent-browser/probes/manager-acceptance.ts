import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import type { Socket } from "node:net";
import { BrowserManager, BrowserError, type BrowserBinding } from "@ruukoto/agent/browser-manager.ts";
import { processIdentity } from "@ruukoto/core/process-identity.ts";

const binary = process.env.RUUKOTO_BROWSER_BINARY;
const chrome = process.env.RUUKOTO_BROWSER_CHROME;
assert.ok(binary && chrome, "请设置 RUUKOTO_BROWSER_BINARY 与 RUUKOTO_BROWSER_CHROME 为固定官方程序及 Chromium 绝对路径");
const noSandbox = process.env.RUUKOTO_BROWSER_NO_SANDBOX === "1";
const ownerKeys = ["RUUKOTO_OWNER_TOKEN", "RUUKOTO_OWNER_TOKEN_FILE", "RUUKOTO_CONTROL_DIR", "RUUKOTO_CODE_CONTROL_DIR"];
for (const key of ownerKeys) process.env[key] = `probe-synthetic-${key}`;
const moduleUrl = process.env.RUUKOTO_BROWSER_MANAGER_MODULE ?? import.meta.resolve("@ruukoto/agent/browser-manager.ts");
const root = process.env.RUUKOTO_BROWSER_PROBE_DIR ? path.resolve(process.env.RUUKOTO_BROWSER_PROBE_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), "rk-manager-accept-"));
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
const jsonPath = path.join(root, "results.json");
const steps: Array<{ name: string; passed: boolean; evidence?: unknown }> = [];
const result: Record<string, unknown> = { status: "running", node: process.version, platform: process.platform, arch: process.arch, binary, binarySha256: createHash("sha256").update(fs.readFileSync(binary)).digest("hex"), chrome, noSandbox, root, jsonPath, steps };
function step(name: string, evidence?: unknown): void { steps.push({ name, passed: true, ...(evidence === undefined ? {} : { evidence }) }); fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 }); }
async function waitFor(condition: () => boolean, timeout = 15000): Promise<void> { const deadline = Date.now() + timeout; while (!condition()) { if (Date.now() > deadline) throw new Error("进程或端点未在预算内完成"); await new Promise(resolve => setTimeout(resolve, 50)); } }
async function child(code: string): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => { const unit = spawn(process.execPath, [...(moduleUrl.endsWith(".ts") ? ["--import", "tsx"] : []), "--input-type=module", "-e", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; unit.stdout.on("data", data => { stdout += data; }); unit.stderr.on("data", data => { stderr += data; }); unit.on("error", reject); unit.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
}
async function cdp(url: string, method: string): Promise<unknown> {
  return await new Promise((resolve, reject) => { const ws = new WebSocket(url); let answered = false; const timer = setTimeout(() => { ws.close(); reject(new Error("CDP 应答超时")); }, 5000); ws.onopen = () => ws.send(JSON.stringify({ id: 1, method })); ws.onmessage = event => { const value: unknown = JSON.parse(String(event.data)); if (typeof value === "object" && value !== null && "id" in value && value.id === 1) { answered = true; clearTimeout(timer); ws.close(); resolve(value); } }; ws.onerror = () => { if (!answered) { clearTimeout(timer); reject(new Error("CDP 连接中断")); } }; });
}
function noGroup(pid: number, profileDir: string): boolean { return !execFileSync("ps", ["-axo", "pid=,pgid=,stat=,command="], { encoding: "utf8" }).split("\n").some(line => { const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line); return row && !row[3].startsWith("Z") && (Number(row[2]) === pid || row[4].includes(`--user-data-dir=${profileDir}`)); }); }
let state: string | null = null, hangHits = 0, seenCookie = "", aborter: AbortController | null = null;
const sockets = new Set<Socket>();
const server = createServer((request, response) => { if (request.url === "/hang") { hangHits++; aborter?.abort(); return; } seenCookie = request.headers.cookie ?? ""; response.setHeader("Content-Type", "text/html"); response.end('<h1>Manager</h1><input id="name"><button id="login" onclick="document.cookie=\'login=present; Max-Age=86400; path=/\'">Login</button>'); });
server.on("connection", socket => { sockets.add(socket); socket.on("close", () => { sockets.delete(socket); }); });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address === "object"); const origin = `http://127.0.0.1:${address.port}`;
const manager = new BrowserManager({ dataDir: path.join(root, "data"), binaryPath: binary, chromePath: chrome, headed: false, noSandbox, store: { getMetaValue: () => state }, persist: (value, binding) => { state = value; fs.writeFileSync(path.join(root, "state.json"), value, { mode: 0o600 }); fs.appendFileSync(path.join(root, "bindings.jsonl"), JSON.stringify(binding) + "\n", { mode: 0o600 }); } });
let external: { pid: number; profileDir: string; cdpUrl: string } | null = null;
let attached: BrowserManager | null = null;
try {
  const first = await manager.start("owned", { headed: false });
  const environmentChecks = Object.fromEntries([first.chrome!, first.daemon!, first.dashboard!].map((unit, index) => {
    const environment = process.platform === "linux" ? fs.readFileSync(`/proc/${unit.pid}/environ`, "utf8") : execFileSync("ps", ["eww", "-p", String(unit.pid), "-o", "command="], { encoding: "utf8" });
    const removed = ownerKeys.every(key => !environment.includes(`${key}=`)); assert.ok(removed); return [["chrome", "daemon", "dashboard"][index], removed];
  }));
  step("host_control_credentials_not_in_owned_units", environmentChecks);
  await manager.command("owned", ["open", origin]); await manager.command("owned", ["fill", "#name", "--config"]);
  assert.match(String((await manager.command("owned", ["snapshot"])).data?.snapshot), /--config/);
  const shot = path.join(root, "shot.png"); await manager.command("owned", ["screenshot", shot]); assert.ok(fs.statSync(shot).size > 100);
  step("official_stdin_batch_flags_and_screenshot", { binding: first, screenshot: shot });
  manager.pause("owned", "old"); await assert.rejects(manager.command("owned", ["snapshot"])); await assert.rejects(manager.resume("owned", "old")); await manager.resume("owned", "new"); assert.notEqual(manager.status("owned")?.generation, first.generation);
  step("pause_requires_new_task_and_readonly_resume_invalidates_refs");
  const other = path.join(root, "other"); fs.mkdirSync(other, { mode: 0o700 });
  const competing = await child(`import {BrowserManager} from ${JSON.stringify(moduleUrl)};const m=new BrowserManager({dataDir:${JSON.stringify(other)},binaryPath:${JSON.stringify(binary)},store:{getMetaValue:()=>null},persist:()=>{}});try{await m.attach('alias',${JSON.stringify(first.cdpUrl!.replace("127.0.0.1", "localhost"))});process.exitCode=7}catch(e){console.log(e.code);if(e.code!=='browser_target_in_use')process.exitCode=8}finally{await m.shutdown()}`);
  assert.equal(competing.code, 0, competing.stderr); assert.match(competing.stdout, /browser_target_in_use/); await manager.command("owned", ["snapshot"]);
  step("shared_uuid_lock_blocks_other_process_and_loopback_alias", competing);
  await manager.command("owned", ["click", "#login"]); assert.equal(await manager.close("owned"), true); assert.equal(fs.existsSync(first.lockDir!), false); assert.ok(noGroup(first.chrome!.pgid, first.profileDir!));
  await manager.start("owned", { headed: false }); await manager.command("owned", ["open", origin]); assert.match(seenCookie, /login=present/);
  step("owned_close_entire_pgid_and_persistent_cookie_reopen", { cookieHeader: seenCookie });
  aborter = new AbortController(); await assert.rejects(manager.command("owned", ["open", origin + "/hang"], aborter.signal), (error: unknown) => error instanceof BrowserError && error.code === "outcome_unknown" && error.effectUnknown);
  assert.equal(hangHits, 1); manager.pause("owned", "interrupted"); assert.equal(manager.status("owned")?.state, "unavailable"); const interrupted = manager.status("owned")!; assert.equal(await manager.close("owned"), true); assert.equal(hangHits, 1); assert.ok(noGroup(interrupted.chrome!.pgid, interrupted.profileDir!));
  step("cancel_navigation_once_and_stop_lock_waiting_daemon", { hangHits, interrupted });
  const cold = path.join(root, "cold"); fs.mkdirSync(cold, { mode: 0o700 }); const coldState = path.join(root, "cold-state.json");
  const spawned = await child(`import fs from 'node:fs';import {BrowserManager} from ${JSON.stringify(moduleUrl)};const m=new BrowserManager({dataDir:${JSON.stringify(cold)},binaryPath:${JSON.stringify(binary)},chromePath:${JSON.stringify(chrome)},headed:false,noSandbox:${noSandbox},store:{getMetaValue:()=>null},persist:s=>fs.writeFileSync(${JSON.stringify(coldState)},s,{mode:0o600})});await m.start('cold');process.kill(process.pid,'SIGKILL')`);
  assert.equal(spawned.signal, "SIGKILL", spawned.stderr); let coldRaw = fs.readFileSync(coldState, "utf8"); const before = (JSON.parse(coldRaw) as { bindings: BrowserBinding[] }).bindings[0];
  const recovering = new BrowserManager({ dataDir: cold, binaryPath: binary, store: { getMetaValue: () => coldRaw }, persist: value => { coldRaw = value; fs.writeFileSync(coldState, value, { mode: 0o600 }); } });
  await recovering.recover(); assert.equal(recovering.status("cold")?.state, "closed"); assert.ok(noGroup(before.chrome!.pgid, before.profileDir!)); await recovering.shutdown();
  step("backend_sigkill_cold_recovery_without_page_replay", { spawned, before, state: coldState });
  const profileDir = path.join(root, "external-profile"); fs.mkdirSync(profileDir, { mode: 0o700 });
  const foreign = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, ...(noSandbox ? ["--no-sandbox"] : []), "about:blank"], { detached: true, stdio: "ignore" });
  let spawnError: Error | null = null; foreign.on("error", error => { spawnError = error; }); foreign.unref();
  await waitFor(() => !!spawnError || fs.existsSync(path.join(profileDir, "DevToolsActivePort"))); if (spawnError) throw spawnError; assert.ok(foreign.pid);
  const [port, target] = fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").trim().split("\n"); external = { pid: foreign.pid, profileDir, cdpUrl: `ws://127.0.0.1:${port}${target}` }; const identity = processIdentity(external.pid); assert.ok(identity);
  fs.writeFileSync(path.join(root, "external.json"), JSON.stringify({ ...external, identity }), { mode: 0o600 });
  const attachedDir = path.join(root, "attached"); fs.mkdirSync(attachedDir, { mode: 0o700 }); let attachedState: string | null = null;
  attached = new BrowserManager({ dataDir: attachedDir, binaryPath: binary, store: { getMetaValue: () => attachedState }, persist: value => { attachedState = value; fs.writeFileSync(path.join(root, "attached-state.json"), value, { mode: 0o600 }); } });
  const binding = await attached.attach("attached", `http://localhost:${port}`); assert.equal(binding.kind, "attached"); assert.equal(binding.chrome, null); await attached.command("attached", ["snapshot"]); assert.equal(await attached.close("attached"), true); assert.equal(processIdentity(external.pid), identity); await cdp(external.cdpUrl, "Browser.getVersion");
  step("attached_close_disconnects_only_and_preserves_user_chrome", { external, binding });
  await cdp(external.cdpUrl, "Browser.close"); await waitFor(() => noGroup(external!.pid, external!.profileDir)); external = null;
  result.status = "passed";
} catch (error) {
  result.status = "failed"; result.error = { code: error instanceof BrowserError ? error.code : null, message: error instanceof Error ? error.message : String(error) }; throw error;
} finally {
  await manager.shutdown(); await attached?.shutdown();
  if (external) { try { await cdp(external.cdpUrl, "Browser.close"); await waitFor(() => noGroup(external!.pid, external!.profileDir)); } catch (error) { result.externalCleanupError = error instanceof Error ? error.message : String(error); } }
  for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 }); process.stdout.write(JSON.stringify({ status: result.status, jsonPath }) + "\n");
}
