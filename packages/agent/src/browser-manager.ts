import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { processIdentity, validProcessIdentity } from "@ruukoto/core/process-identity.ts";
import type { Store } from "@ruukoto/core/store.ts";

export const BROWSER_META_KEY = "browser_bindings_v1";
const RELEASE = "0.39.1";
const RELEASE_HASHES: Record<string, readonly string[]> = {
  "darwin-arm64": ["cc18fac41d9dc9821918340a136e643286ea05544c4dd35671b796f1a874cdef"],
  "darwin-x64": ["339cb9aa6dfd404856cf938df34cd3b4779c61dfd57fc257be11b14fd1a885f9"],
  "linux-arm64": ["9d8fdc586056df65747927ae166157c83af91b52cea287175e5544afd2591d33", "c4959f3e193c5bc8f333613363f25f2eaceecafe25a0821843b271906474a20f"],
  "linux-x64": ["6906d3a2a67b05809932a93d99e53d1132373f0a52a617b2d6032dbb954df6fc", "74507cdab98aa91bdc14346c545aff974640a225e43f8c3d6c23164f8c0f9bb9"],
};

export class BrowserError extends Error {
  constructor(readonly code: string, message: string, readonly effectUnknown = false) { super(message); }
}

export interface BrowserProcess {
  pid: number;
  pgid: number;
  processIdentity: string;
}

export interface BrowserBinding {
  sessionId: string;
  generation: string;
  kind: "owned" | "attached";
  state: "starting" | "ready" | "paused" | "unavailable" | "closed";
  profileDir: string | null;
  socketDir: string;
  cliSession: string;
  cdpUrl: string | null;
  targetId: string | null;
  chrome: BrowserProcess | null;
  daemon: BrowserProcess | null;
  dashboard: BrowserProcess | null;
  chromePending: boolean;
  daemonPending: boolean;
  dashboardPending: boolean;
  lockDir: string | null;
  pauseTaskId: string | null;
  pauseAfterSeq: number | null;
  outcomeUnknown: boolean;
  failureCode: string | null;
  dashboardUrl: string | null;
  headed: boolean;
}

export interface BrowserManagerOptions {
  dataDir: string;
  binaryPath?: string;
  chromePath?: string;
  headed?: boolean;
  noSandbox?: boolean;
  store?: Pick<Store, "getMetaValue">;
  initialState?: string | null;
  persist(stateJson: string, binding: BrowserBinding): void | Promise<void>;
}

export interface BrowserCommandResult {
  data: Record<string, unknown> | null;
  code?: string;
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errno(error: unknown): string | undefined { return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined; }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function processState(unit: BrowserProcess): "alive" | "gone" | "unknown" {
  try { process.kill(unit.pid, 0); }
  catch (error) { return errno(error) === "ESRCH" ? "gone" : "unknown"; }
  const actual = processIdentity(unit.pid);
  if (!actual) {
    try { process.kill(unit.pid, 0); }
    catch (error) { return errno(error) === "ESRCH" ? "gone" : "unknown"; }
    return "unknown";
  }
  if (actual !== unit.processIdentity) return "unknown";
  try {
    const state = execFileSync("ps", ["-p", String(unit.pid), "-o", "stat=,pgid="], { encoding: "utf8", timeout: 3000 }).trim().split(/\s+/);
    if (Number(state[1]) !== unit.pgid) return "unknown";
    return state[0]?.startsWith("Z") ? "gone" : "alive";
  } catch {
    try { process.kill(unit.pid, 0); }
    catch (error) { return errno(error) === "ESRCH" ? "gone" : "unknown"; }
    return "unknown";
  }
}

function captureProcess(pid: number): BrowserProcess {
  const identity = processIdentity(pid);
  if (!identity) throw new BrowserError("browser_identity_unverified", "无法核实浏览器进程启动标识，请检查原进程后再继续");
  let pgid: number;
  try { pgid = Number(execFileSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8", timeout: 3000 }).trim()); }
  catch { throw new BrowserError("browser_identity_unverified", "无法核实浏览器进程组，请检查原进程后再继续"); }
  if (!Number.isSafeInteger(pgid) || pgid <= 0) throw new BrowserError("browser_identity_unverified", "浏览器进程组不合法");
  return { pid, pgid, processIdentity: identity };
}

function validProcess(value: unknown): value is BrowserProcess | null {
  return value === null || (object(value) && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && Number.isSafeInteger(value.pgid) && Number(value.pgid) > 0 && validProcessIdentity(value.processIdentity));
}

function isReadOnly(args: string[]): boolean {
  return args[0] === "snapshot" || args[0] === "screenshot" || (args[0] === "tab" && (args.length === 1 || args[1] === "list")) || (args[0] === "get" && ["url", "title"].includes(args[1]));
}

function responseError(value: Record<string, unknown>, args: string[]): BrowserError {
  const code = typeof value.code === "string" ? value.code : null;
  if (code === "tab_gone") return new BrowserError(code, "浏览器标签已关闭，请先查看标签列表或显式新建标签");
  const unknown = code !== null || !isReadOnly(args);
  return new BrowserError(unknown ? "outcome_unknown" : "browser_action_failed", unknown ? "浏览器动作结果未知；已暂停自动化，请核实当前页面，不能重复旧动作" : "浏览器读取失败，请核实当前浏览器连接", unknown && !isReadOnly(args));
}

/** 单动作 batch 的 wire 解析；未知错误码与可能写入的失败都保留结果未知。 */
export function parseBrowserCommand(stdout: string, args: string[], exitCode: number | null): BrowserCommandResult {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); }
  catch { throw new BrowserError("outcome_unknown", "浏览器应答不完整，已暂停自动化，请核实当前页面", !isReadOnly(args)); }
  if (object(parsed) && parsed.success === false) throw responseError(parsed, args);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !object(parsed[0])) throw new BrowserError("outcome_unknown", "浏览器 batch 应答不合法，请核实当前页面", !isReadOnly(args));
  const row = parsed[0];
  if (!Array.isArray(row.command) || row.command.length !== args.length || row.command.some((value, index) => value !== args[index]) || typeof row.success !== "boolean" || (row.result !== null && !object(row.result)) || (row.code !== undefined && typeof row.code !== "string")) {
    throw new BrowserError("outcome_unknown", "浏览器应答与当前动作不匹配，请核实当前页面", !isReadOnly(args));
  }
  if (!row.success) throw responseError(row, args);
  if (row.code !== undefined) throw new BrowserError("outcome_unknown", "浏览器成功应答含未知状态码，请核实当前页面", !isReadOnly(args));
  if (exitCode !== 0) throw new BrowserError("outcome_unknown", "浏览器进程退出与应答不一致，请核实当前页面", !isReadOnly(args));
  return { data: row.result, ...(typeof row.code === "string" ? { code: row.code } : {}) };
}

async function runProcess(binary: string, argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal; timeout?: number }): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (options.signal?.aborted) throw new BrowserError("browser_not_sent", "动作已取消，尚未启动浏览器命令");
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, argv, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", failed: BrowserError | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (error: BrowserError) => {
      failed ??= error;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1000);
    };
    const abort = () => stop(new BrowserError("outcome_unknown", "浏览器命令已取消，应答未核实"));
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new BrowserError("outcome_unknown", "浏览器命令超时，应答未核实")), options.timeout ?? 120000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (failed) return; stdout += chunk; if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) stop(new BrowserError("outcome_unknown", "浏览器应答超过上限，应答未核实")); });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 65536) stderr += chunk; });
    child.on("error", () => { failed = new BrowserError("browser_not_sent", "无法启动浏览器程序，请核实可执行文件与权限"); });
    child.stdin.on("error", () => stop(new BrowserError("outcome_unknown", "浏览器命令输入未确认")));
    child.on("close", code => {
      clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener("abort", abort);
      if (failed) reject(failed); else resolve({ stdout, stderr, code });
    });
    child.stdin.end(options.input);
    if (options.signal?.aborted) abort();
  });
}

/** 只发送一次单动作 stdin batch；固定版本校验由 BrowserManager 在调用前持有。 */
export async function runBrowserCommand(binary: string, argv: string[], args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<BrowserCommandResult> {
  if (args.length === 0 || args.some(arg => typeof arg !== "string")) throw new BrowserError("browser_invalid_action", "浏览器动作参数不合法");
  let result: Awaited<ReturnType<typeof runProcess>>;
  try { result = await runProcess(binary, [...argv, "batch", "--bail"], { ...options, input: JSON.stringify([args]) }); }
  catch (error) {
    if (error instanceof BrowserError && error.code === "browser_not_sent") throw error;
    throw new BrowserError("outcome_unknown", "浏览器命令应答丢失，已暂停自动化，请核实当前页面", !isReadOnly(args));
  }
  return parseBrowserCommand(result.stdout, args, result.code);
}

function loopback(address: string): boolean { return address === "::1" || (net.isIP(address) === 4 && address.startsWith("127.")); }

async function pinLoopback(input: string): Promise<URL> {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new BrowserError("browser_invalid_target", "附接需要显式本机 loopback HTTP 或 WebSocket CDP 地址"); }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash || url.search || !url.port) throw new BrowserError("browser_invalid_target", "CDP 地址协议、端口或授权字段不合法");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let address = host;
  if (host === "localhost") {
    let addresses: LookupAddress[];
    try { addresses = await lookup(host, { all: true }); }
    catch { throw new BrowserError("browser_invalid_target", "无法核实 localhost 的本机地址"); }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(entry => !loopback(entry.address))) throw new BrowserError("browser_invalid_target", "localhost 解析包含非 loopback 地址，拒绝附接");
    address = addresses.find(entry => entry.family === 4)?.address ?? addresses[0].address;
  }
  if (!loopback(address)) throw new BrowserError("browser_invalid_target", "首版只允许本机 loopback CDP，不能控制远程浏览器");
  url.hostname = address.includes(":") ? `[${address}]` : address;
  return url;
}

function readVersion(url: URL, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const get = url.protocol === "https:" ? https.get : http.get;
    const request = get({ hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port, path: "/json/version", signal }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new BrowserError("browser_invalid_target", "CDP discovery 返回非成功应答；不跟随重定向")); return; }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; if (body.length > 65536) request.destroy(); });
      response.on("error", () => reject(new BrowserError("browser_invalid_target", "CDP discovery 应答中断")));
      response.on("end", () => { let parsed: unknown; try { parsed = JSON.parse(body); } catch { reject(new BrowserError("browser_invalid_target", "CDP discovery 应答不合法")); return; } resolve(parsed); });
    });
    request.on("error", () => reject(signal.aborted ? signal.reason : new BrowserError("browser_invalid_target", "无法连接本机 CDP discovery")));
  });
}

/** 将 loopback discovery 或 WebSocket 别名钉到 literal IP 与浏览器 UUID，不跟随重定向。 */
export async function resolveBrowserEndpoint(input: string, signal?: AbortSignal): Promise<{ url: string; targetId: string }> {
  const controller = new AbortController();
  const abort = () => controller.abort(new BrowserError("browser_not_sent", "CDP discovery 已取消，本次附接未发送"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new BrowserError("browser_invalid_target", "CDP discovery 超过总期限")), 3000);
  let rejectAbort!: () => void;
  const canceled = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try { return await Promise.race([resolveEndpoint(input, controller.signal), canceled]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", rejectAbort); }
}

async function resolveEndpoint(input: string, signal: AbortSignal): Promise<{ url: string; targetId: string }> {
  if (signal.aborted) throw signal.reason;
  let url = await pinLoopback(input);
  if (signal.aborted) throw signal.reason;
  if (url.protocol === "http:" || url.protocol === "https:") {
    const version = await readVersion(url, signal);
    if (!object(version) || typeof version.webSocketDebuggerUrl !== "string") throw new BrowserError("browser_invalid_target", "CDP discovery 缺少浏览器 WebSocket 地址");
    const ws = await pinLoopback(version.webSocketDebuggerUrl);
    if (ws.port !== url.port || ws.hostname !== url.hostname) throw new BrowserError("browser_invalid_target", "CDP discovery 指向不同目标，拒绝附接");
    url = ws;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new BrowserError("browser_invalid_target", "CDP discovery 未返回 WebSocket 地址");
  const match = /^\/devtools\/browser\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(url.pathname);
  if (!match) throw new BrowserError("browser_invalid_target", "CDP 地址必须指向带 UUID 的浏览器端点");
  const targetId = match[1].toLowerCase();
  url.pathname = `/devtools/browser/${targetId}`;
  return { url: url.toString(), targetId };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  return await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new BrowserError("browser_unavailable", "无法分配本机 dashboard 端口")); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function browserClose(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new BrowserError("browser_stop_unverified", "浏览器关闭应答超时")); }, 3000);
    const finish = () => { clearTimeout(timer); ws.close(); resolve(); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    ws.onmessage = event => {
      let value: unknown;
      try { value = JSON.parse(String(event.data)); }
      catch { return; }
      if (object(value) && value.id === 1 && !value.error) finish();
    };
    // Browser.close 后 Node 24 可能报 socket error；真正的停止结论由进程检查给出。
    ws.onclose = finish;
    ws.onerror = finish;
  });
}

function rows(): Array<{ pid: number; pgid: number; command: string; state: string }> {
  let output: string;
  try { output = execFileSync("ps", ["-axo", "pid=,pgid=,stat=,command="], { encoding: "utf8", timeout: 3000 }); }
  catch { throw new BrowserError("browser_stop_unverified", "无法核实浏览器相关进程是否退出"); }
  return output.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), state: match[3], command: match[4] }] : [];
  });
}

function secureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new BrowserError("browser_binding_invalid", "浏览器控制目录归属或权限不安全，请核实目录后继续");
}

/** Runtime 跨任务持有；profile 保留，恢复只停止旧执行，不恢复页面或重放动作。 */
// Note: 见 .agents/notes/implemented/feature/2026-10-14-agent-browser.md
export class BrowserManager {
  private readonly bindings = new Map<string, BrowserBinding>();
  private readonly fingerprints = new Map<string, { config: string; version: string }>();
  private readonly active = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  private readonly closing = new Map<string, Promise<boolean>>();
  private readonly dataDir: string;
  private readonly root: string;
  private readonly locks: string;
  private readonly env: NodeJS.ProcessEnv;
  private loadError: BrowserError | null = null;
  private shuttingDown = false;
  private supervising = false;
  private timer: NodeJS.Timeout;

  constructor(private readonly options: BrowserManagerOptions) {
    this.options = { ...options, binaryPath: options.binaryPath ? path.resolve(options.binaryPath) : undefined,
      chromePath: options.chromePath ? path.resolve(options.chromePath) : undefined };
    this.dataDir = path.resolve(options.dataDir);
    this.root = path.join(this.dataDir, "browser");
    this.locks = `/tmp/ruukoto-browser-locks-${process.getuid?.() ?? "unknown"}`;
    this.env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AGENT_BROWSER_") && !key.startsWith("AI_GATEWAY_") && !["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].includes(key.toUpperCase())));
    for (const key of ["RUUKOTO_OWNER_TOKEN", "RUUKOTO_OWNER_TOKEN_FILE", "RUUKOTO_CONTROL_DIR", "RUUKOTO_CODE_CONTROL_DIR"]) delete this.env[key];
    this.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = "3600000";
    const stored = options.initialState ?? options.store?.getMetaValue(BROWSER_META_KEY) ?? null;
    if (stored !== null) {
      try { this.load(stored); }
      catch { this.loadError = new BrowserError("browser_binding_invalid", "浏览器绑定记录不合法，保留原进程与资料，请人工核实"); }
    }
    this.timer = setInterval(() => { void this.supervise(); }, 2000);
    this.timer.unref();
  }

  private load(raw: string): void {
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bindings)) throw new Error("invalid browser state");
    const pending = new Map<string, BrowserBinding>();
    for (const value of parsed.bindings) {
      if (!object(value) || typeof value.sessionId !== "string" || typeof value.generation !== "string" || !["owned", "attached"].includes(String(value.kind)) || !["starting", "ready", "paused", "unavailable", "closed"].includes(String(value.state))) throw new Error("invalid binding");
      for (const key of ["socketDir", "cliSession"]) if (typeof value[key] !== "string") throw new Error("invalid paths");
      for (const key of ["profileDir", "cdpUrl", "targetId", "lockDir", "pauseTaskId", "failureCode", "dashboardUrl"]) if (value[key] !== null && typeof value[key] !== "string") throw new Error("invalid fields");
      for (const key of ["chromePending", "daemonPending", "dashboardPending", "outcomeUnknown", "headed"]) if (typeof value[key] !== "boolean") throw new Error("invalid flags");
      if (value.pauseAfterSeq === undefined) value.pauseAfterSeq = null;
      if (value.pauseAfterSeq !== null && (!Number.isSafeInteger(value.pauseAfterSeq) || Number(value.pauseAfterSeq) < 0)) throw new Error("invalid pause barrier");
      if (!validProcess(value.chrome) || !validProcess(value.daemon) || !validProcess(value.dashboard)) throw new Error("invalid process identity");
      const binding = value as unknown as BrowserBinding;
      const expected = this.paths(binding.sessionId);
      if (pending.has(binding.sessionId) || binding.socketDir !== expected.socketDir || binding.cliSession !== expected.cliSession || (binding.profileDir !== null && binding.profileDir !== expected.profileDir) || (binding.lockDir !== null && binding.lockDir !== path.join(this.locks, digest(binding.targetId ?? "")))) throw new Error("invalid binding ownership");
      pending.set(binding.sessionId, binding);
    }
    for (const [key, value] of pending) this.bindings.set(key, value);
    if (parsed.fingerprints !== undefined) {
      if (!object(parsed.fingerprints)) throw new Error("invalid fingerprints");
      for (const [key, value] of Object.entries(parsed.fingerprints)) {
        if (!pending.has(key) || !object(value) || typeof value.config !== "string" || value.version !== RELEASE || !/^[a-f0-9]{16}$/.test(value.config)) throw new Error("invalid fingerprint");
        this.fingerprints.set(key, { config: value.config, version: value.version });
      }
    }
  }

  private paths(sessionId: string): { socketDir: string; cliSession: string; profileDir: string } {
    const id = digest(`${this.dataDir}\0${sessionId}`).slice(0, 24);
    return { socketDir: `/tmp/ruukoto-browser-${process.getuid?.() ?? "unknown"}-${id}`, cliSession: `rk-${id}`, profileDir: path.join(this.root, id, "profile") };
  }

  private async save(binding: BrowserBinding, previousGeneration?: string): Promise<void> {
    try { await this.options.persist(JSON.stringify({ version: 1, bindings: [...this.bindings.values()], fingerprints: Object.fromEntries(this.fingerprints) }), structuredClone(binding)); }
    catch { this.loadError = new BrowserError("browser_state_unavailable", "浏览器状态无法持久化，已停止继续自动化，请核实原执行"); throw this.loadError; }
    if (binding.lockDir && binding.state !== "closed" && this.lockMatches(binding, previousGeneration)) {
      const file = path.join(binding.lockDir, "owner.json"), temporary = `${file}.${randomUUID()}`;
      try { fs.writeFileSync(temporary, JSON.stringify({ dataDir: this.dataDir, sessionId: binding.sessionId, generation: binding.generation, daemon: binding.daemon, daemonPending: binding.daemonPending }), { flag: "wx", mode: 0o600 }); }
      catch { this.loadError = new BrowserError("browser_state_unavailable", "浏览器占用记录无法写入，停止自动化并保留原进程"); throw this.loadError; }
      try { fs.renameSync(temporary, file); }
      catch { this.loadError = new BrowserError("browser_state_unavailable", "浏览器占用记录无法提交，停止自动化并保留原进程"); throw this.loadError; }
    }
  }

  private async unavailable(binding: BrowserBinding, error: BrowserError): Promise<void> {
    binding.state = "unavailable"; binding.failureCode = error.code; binding.outcomeUnknown ||= error.effectUnknown;
    await this.save(binding);
  }

  status(sessionId: string): BrowserBinding | null {
    const binding = this.bindings.get(sessionId);
    return binding ? structuredClone(binding) : null;
  }

  private require(sessionId: string): BrowserBinding {
    if (this.loadError) throw this.loadError;
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.state === "closed") throw new BrowserError("browser_not_ready", "浏览器尚未启动或已回收，请先显式启动或附接");
    return binding;
  }

  private async prepare(owned: boolean): Promise<void> {
    if (this.loadError) throw this.loadError;
    if (this.shuttingDown) throw new BrowserError("browser_unavailable", "后台正在停止，不能启动浏览器");
    {
      const binary = this.options.binaryPath;
      if (!binary || !RELEASE_HASHES[`${process.platform}-${process.arch}`]) throw new BrowserError("browser_unavailable", "请准备当前平台 agent-browser v0.39.1 官方原生程序并配置宿主路径");
      let hash: string;
      try { hash = createHash("sha256").update(fs.readFileSync(binary)).digest("hex"); }
      catch { throw new BrowserError("browser_unavailable", "无法读取 agent-browser 原生程序，请准备官方版本并核实权限"); }
      if (!RELEASE_HASHES[`${process.platform}-${process.arch}`].includes(hash)) throw new BrowserError("browser_unavailable", "agent-browser 程序校验值不属于固定官方 v0.39.1 release，请重新准备官方资产");
      const version = await runProcess(binary, ["--version"], { cwd: this.dataDir, env: this.env, timeout: 5000 });
      if (version.code !== 0 || version.stdout.trim() !== `agent-browser ${RELEASE}`) throw new BrowserError("browser_unavailable", "agent-browser 版本不满足固定 release 要求");
      secureDirectory(this.root); secureDirectory(this.locks);
    }
    if (owned) {
      if (!this.options.chromePath) throw new BrowserError("browser_unavailable", "请先准备 Chromium 并配置宿主可执行文件路径；模型任务不会自动安装或提权");
      try { fs.accessSync(this.options.chromePath, fs.constants.X_OK); }
      catch { throw new BrowserError("browser_unavailable", "Chromium 不可执行，请核实宿主准备步骤与权限"); }
    }
  }

  private async binding(sessionId: string, kind: BrowserBinding["kind"], headed: boolean): Promise<BrowserBinding> {
    const old = this.bindings.get(sessionId);
    if (old && old.state !== "closed") throw new BrowserError("browser_not_ready", "原浏览器未核实关闭，不能新开实例；请先查看状态并显式关闭");
    const paths = this.paths(sessionId);
    secureDirectory(paths.socketDir);
    if (fs.readdirSync(paths.socketDir).some(name => name.endsWith(".pid") || name.endsWith(".sock"))) throw new BrowserError("browser_stop_unverified", "浏览器控制目录残留执行记录，请核实原执行后再启动");
    fs.writeFileSync(path.join(paths.socketDir, "config.json"), "{}\n", { mode: 0o600 });
    const binding: BrowserBinding = { sessionId, generation: randomUUID(), kind, state: "starting", profileDir: kind === "owned" ? paths.profileDir : null, socketDir: paths.socketDir, cliSession: paths.cliSession, cdpUrl: null, targetId: null, chrome: null, daemon: null, dashboard: null, chromePending: false, daemonPending: false, dashboardPending: false, lockDir: null, pauseTaskId: null, pauseAfterSeq: null, outcomeUnknown: false, failureCode: null, dashboardUrl: null, headed };
    this.bindings.set(sessionId, binding); await this.save(binding);
    return binding;
  }

  private envFor(binding: BrowserBinding): NodeJS.ProcessEnv { return { ...this.env, AGENT_BROWSER_SOCKET_DIR: binding.socketDir }; }
  private argv(binding: BrowserBinding): string[] { return ["--config", path.join(binding.socketDir, "config.json"), "--session", binding.cliSession, "--cdp", binding.cdpUrl!, "--json"]; }

  private sidecar(binding: BrowserBinding, name: string): BrowserProcess | null {
    const file = path.join(binding.socketDir, `${name}.pid`);
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (error) { if (errno(error) === "ENOENT") return null; throw new BrowserError("browser_identity_unverified", "无法读取浏览器进程记录"); }
    const pid = Number(text.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new BrowserError("browser_identity_unverified", "浏览器进程记录不合法");
    const unit = captureProcess(pid);
    let command: string;
    try { command = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000 }).trim(); }
    catch { throw new BrowserError("browser_identity_unverified", "无法核实浏览器 daemon 程序归属"); }
    const binary = fs.realpathSync(this.options.binaryPath!);
    if (command !== binary && !command.startsWith(`${binary} `)) throw new BrowserError("browser_identity_unverified", "浏览器进程记录指向其他程序，拒绝控制");
    return unit;
  }

  private async captureDaemon(binding: BrowserBinding): Promise<void> {
    const daemon = this.sidecar(binding, binding.cliSession);
    if (!daemon) throw new BrowserError("browser_identity_unverified", "浏览器 daemon 未登记进程身份，保留不可用状态");
    if (binding.daemon && (binding.daemon.pid !== daemon.pid || binding.daemon.processIdentity !== daemon.processIdentity)) throw new BrowserError("browser_identity_unverified", "浏览器 daemon 已换代，原执行状态不能核实");
    const fingerprint = this.fingerprint(binding);
    const previous = this.fingerprints.get(binding.sessionId);
    if (previous && (previous.config !== fingerprint.config || previous.version !== fingerprint.version)) throw new BrowserError("browser_identity_unverified", "浏览器 daemon 配置已变化，拒绝继续自动化");
    this.fingerprints.set(binding.sessionId, fingerprint);
    binding.daemon = daemon; binding.daemonPending = false; await this.save(binding);
  }

  private fingerprint(binding: BrowserBinding): { config: string; version: string } {
    let config: string, version: string, source: string;
    try { config = fs.readFileSync(path.join(binding.socketDir, `${binding.cliSession}.config`), "utf8").trim(); version = fs.readFileSync(path.join(binding.socketDir, `${binding.cliSession}.version`), "utf8").trim(); source = fs.readFileSync(path.join(binding.socketDir, "config.json"), "utf8"); }
    catch { throw new BrowserError("browser_identity_unverified", "浏览器配置或版本记录缺失，拒绝隐式重启 daemon"); }
    if (!/^[a-f0-9]{16}$/.test(config) || version !== RELEASE || source !== "{}\n") throw new BrowserError("browser_identity_unverified", "浏览器配置或版本记录不符合固定宿主参数");
    return { config, version };
  }

  private async dashboard(binding: BrowserBinding, signal?: AbortSignal): Promise<void> {
    const port = await freePort();
    if (signal?.aborted) throw new BrowserError("browser_not_sent", "dashboard 启动已取消");
    binding.dashboardPending = true; await this.save(binding);
    if (signal?.aborted) { binding.dashboardPending = false; await this.save(binding); throw new BrowserError("browser_not_sent", "dashboard 启动已取消"); }
    const result = await runProcess(this.options.binaryPath!, ["--config", path.join(binding.socketDir, "config.json"), "--json", "dashboard", "start", "--port", String(port)], { cwd: binding.socketDir, env: this.envFor(binding), timeout: 10000, signal });
    let response: unknown;
    try { response = JSON.parse(result.stdout); }
    catch { throw new BrowserError("browser_identity_unverified", "dashboard 启动应答丢失，请核实原进程"); }
    if (result.code !== 0 || !object(response) || response.success !== true || !object(response.data) || response.data.port !== port) throw new BrowserError("browser_unavailable", "官方 dashboard 未能启动，请核实本机端口和进程");
    binding.dashboard = this.sidecar(binding, "dashboard");
    if (!binding.dashboard || binding.dashboard.pid !== response.data.pid) throw new BrowserError("browser_identity_unverified", "dashboard 进程归属不一致");
    binding.dashboardPending = false; binding.dashboardUrl = `http://127.0.0.1:${port}/?port=${this.streamPort(binding)}`;
    await this.save(binding);
  }

  private streamPort(binding: BrowserBinding): number {
    const port = Number(fs.readFileSync(path.join(binding.socketDir, `${binding.cliSession}.stream`), "utf8").trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BrowserError("browser_unavailable", "浏览器人工输入端口不合法");
    return port;
  }

  private async initialize(binding: BrowserBinding, signal?: AbortSignal): Promise<BrowserBinding> {
    if (signal?.aborted) throw new BrowserError("browser_not_sent", "浏览器连接已取消");
    binding.daemonPending = true; await this.save(binding);
    if (signal?.aborted) { binding.daemonPending = false; await this.save(binding); throw new BrowserError("browser_not_sent", "浏览器连接已取消"); }
    await runBrowserCommand(this.options.binaryPath!, this.argv(binding), ["snapshot"], { cwd: binding.socketDir, env: this.envFor(binding), signal });
    await this.captureDaemon(binding);
    await this.dashboard(binding, signal);
    if (signal?.aborted) throw new BrowserError("browser_not_sent", "浏览器启动已取消，请关闭已登记浏览器");
    binding.state = "ready"; await this.save(binding);
    return structuredClone(binding);
  }

  private async operation<T>(sessionId: string, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active.has(sessionId) || this.closing.has(sessionId)) throw new BrowserError("browser_busy", "同一浏览器一次只执行一个操作");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const done = Promise.resolve().then(() => action(controller.signal));
    this.active.set(sessionId, { controller, done });
    try { return await done; }
    finally { this.active.delete(sessionId); signal?.removeEventListener("abort", abort); }
  }

  async start(sessionId: string, options: { headed?: boolean } = {}, signal?: AbortSignal): Promise<BrowserBinding> {
    return await this.operation(sessionId, signal, current => this.startOwned(sessionId, options, current));
  }

  private async startOwned(sessionId: string, options: { headed?: boolean }, signal: AbortSignal): Promise<BrowserBinding> {
    const current = this.bindings.get(sessionId);
    if (current && (current.state === "ready" || current.state === "paused") && current.kind === "owned") return structuredClone(current);
    if (signal?.aborted) throw new BrowserError("browser_not_sent", "浏览器启动已取消");
    await this.prepare(true);
    if (signal.aborted) throw new BrowserError("browser_not_sent", "浏览器启动已取消");
    const binding = await this.binding(sessionId, "owned", options.headed ?? this.options.headed ?? process.platform === "darwin");
    try {
      if (signal.aborted) throw new BrowserError("browser_not_sent", "浏览器启动已取消");
      secureDirectory(binding.profileDir!);
      if (rows().some(row => row.command.includes(`--user-data-dir=${binding.profileDir}`) && !row.state.startsWith("Z"))) throw new BrowserError("browser_stop_unverified", "该资料目录仍有浏览器进程，拒绝新开实例");
      fs.rmSync(path.join(binding.profileDir!, "DevToolsActivePort"), { force: true });
      binding.chromePending = true; await this.save(binding);
      if (signal.aborted) { binding.chromePending = false; await this.save(binding); throw new BrowserError("browser_not_sent", "浏览器启动已取消"); }
      const args = ["--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${binding.profileDir}`, ...(binding.headed ? [] : ["--headless=new"]), ...(this.options.noSandbox ? ["--no-sandbox"] : []), "about:blank"];
      const child = spawn(this.options.chromePath!, args, { cwd: binding.profileDir!, env: this.env, detached: true, stdio: "ignore" });
      let spawnError: Error | null = null; child.on("error", error => { spawnError = error; }); child.unref();
      await delay(20);
      if (!child.pid || spawnError) { binding.chromePending = false; throw new BrowserError("browser_unavailable", "Chromium 启动失败，请核实沙箱与系统前提"); }
      binding.chrome = captureProcess(child.pid);
      if (binding.chrome.pgid !== binding.chrome.pid) throw new BrowserError("browser_identity_unverified", "Chromium 未取得独立进程组");
      binding.chromePending = false; await this.save(binding);
      const deadline = Date.now() + 15000;
      let endpoint: Awaited<ReturnType<typeof resolveBrowserEndpoint>> | null = null;
      while (!endpoint) {
        if (signal?.aborted) throw new BrowserError("browser_not_sent", "浏览器启动已取消，请关闭已登记浏览器");
        if (processState(binding.chrome) !== "alive" || Date.now() > deadline) throw new BrowserError("browser_unavailable", "Chromium 未提供可用 CDP；请核实系统沙箱与日志准备");
        let portText: string | null = null;
        try { portText = fs.readFileSync(path.join(binding.profileDir!, "DevToolsActivePort"), "utf8"); }
        catch (error) { if (errno(error) !== "ENOENT") throw error; }
        if (portText) {
          const [port, target] = portText.trim().split("\n");
          if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new BrowserError("browser_invalid_target", "Chromium CDP 端口记录不合法");
          endpoint = await resolveBrowserEndpoint(`ws://127.0.0.1:${port}${target}`, signal);
        } else await delay(50);
      }
      binding.cdpUrl = endpoint.url; binding.targetId = endpoint.targetId; await this.claim(binding);
      return await this.initialize(binding, signal);
    } catch (error) {
      await this.unavailable(binding, error instanceof BrowserError ? error : new BrowserError("browser_unavailable", "浏览器启动失败，请核实原进程和资料目录"));
      throw error instanceof BrowserError ? error : new BrowserError("browser_unavailable", "浏览器启动失败，请核实原进程和资料目录");
    }
  }

  async attach(sessionId: string, target: string, signal?: AbortSignal): Promise<BrowserBinding> {
    return await this.operation(sessionId, signal, current => this.attachTarget(sessionId, target, current));
  }

  private async claim(binding: BrowserBinding): Promise<void> {
    const lockDir = path.join(this.locks, digest(binding.targetId!));
    try { fs.mkdirSync(lockDir, { mode: 0o700 }); }
    catch (error) { if (errno(error) === "EEXIST") throw new BrowserError("browser_target_in_use", "该浏览器已被 Ruukoto 会话占用；未核实原自动化停止前不能接管"); throw error; }
    binding.lockDir = lockDir;
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ dataDir: this.dataDir, sessionId: binding.sessionId, generation: binding.generation, daemon: null, daemonPending: false }), { flag: "wx", mode: 0o600 });
    await this.save(binding);
  }

  private async attachTarget(sessionId: string, target: string, signal: AbortSignal): Promise<BrowserBinding> {
    if (signal?.aborted) throw new BrowserError("browser_not_sent", "浏览器附接已取消");
    await this.prepare(false);
    const endpoint = await resolveBrowserEndpoint(target, signal);
    const current = this.bindings.get(sessionId);
    if (current && (current.state === "ready" || current.state === "paused") && current.kind === "attached" && current.targetId === endpoint.targetId) return structuredClone(current);
    if (signal.aborted) throw new BrowserError("browser_not_sent", "浏览器附接已取消");
    const binding = await this.binding(sessionId, "attached", false);
    binding.cdpUrl = endpoint.url; binding.targetId = endpoint.targetId;
    try { await this.claim(binding); return await this.initialize(binding, signal); }
    catch (error) { const typed = error instanceof BrowserError ? error : new BrowserError("browser_unavailable", "附接失败，请核实原自动化连接"); await this.unavailable(binding, typed); throw typed; }
  }

  async pause(sessionId: string, taskId: string, afterSeq = 0): Promise<BrowserBinding> {
    const binding = this.require(sessionId);
    if (!["ready", "unavailable"].includes(binding.state) || this.active.has(sessionId)) throw new BrowserError("browser_busy", "请等待当前浏览器动作结束后进入人工操作");
    if (binding.state === "ready") binding.state = "paused";
    binding.pauseTaskId = taskId; binding.pauseAfterSeq = afterSeq; await this.save(binding);
    return structuredClone(binding);
  }

  async resume(sessionId: string, newTaskId: string): Promise<BrowserBinding> {
    return await this.operation(sessionId, undefined, async signal => {
      const binding = this.require(sessionId);
      if (!["paused", "unavailable"].includes(binding.state) || !binding.pauseTaskId || !newTaskId || newTaskId === binding.pauseTaskId) throw new BrowserError("browser_paused", "人工操作后需拥有者的新消息继续，不能由原任务自行恢复");
      if (!this.live(binding)) throw new BrowserError("browser_identity_unverified", "原浏览器身份或占用无法核实，不能恢复自动化");
      await this.prepare(false);
      try { await runBrowserCommand(this.options.binaryPath!, this.argv(binding), ["snapshot"], { cwd: binding.socketDir, env: this.envFor(binding), signal }); await this.captureDaemon(binding); }
      catch (error) { const typed = error instanceof BrowserError ? error : new BrowserError("outcome_unknown", "恢复时浏览器读取应答未核实"); await this.unavailable(binding, typed); throw typed; }
      const previousGeneration = binding.generation;
      binding.generation = randomUUID(); binding.state = "ready"; binding.pauseTaskId = null; binding.pauseAfterSeq = null; binding.failureCode = null; binding.outcomeUnknown = false; await this.save(binding, previousGeneration);
      return structuredClone(binding);
    });
  }

  async command(sessionId: string, args: string[], signal?: AbortSignal): Promise<BrowserCommandResult> {
    return await this.operation(sessionId, signal, current => this.execute(sessionId, args, current));
  }

  private async execute(sessionId: string, args: string[], signal: AbortSignal): Promise<BrowserCommandResult> {
    const binding = this.require(sessionId);
    if (binding.state === "paused") throw new BrowserError("browser_paused", "浏览器正在人工操作，等待拥有者的新消息继续");
    if (binding.state !== "ready") throw new BrowserError("browser_not_ready", "浏览器连接不可用，本次动作未发送；请先核实原执行并显式关闭");
    if (!this.live(binding)) {
      const error = new BrowserError("browser_identity_unverified", "浏览器进程已退出或身份变化，请先核实停止；不会自动重建实例"); await this.unavailable(binding, error); throw error;
    }
    if (!["open", "snapshot", "click", "fill", "select", "check", "uncheck", "press", "scroll", "wait", "tab", "screenshot", "get"].includes(args[0])) throw new BrowserError("browser_invalid_action", "宿主浏览器动作不在首版命令集内");
    await this.prepare(false);
    try { const result = await runBrowserCommand(this.options.binaryPath!, this.argv(binding), args, { cwd: binding.socketDir, env: this.envFor(binding), signal }); await this.captureDaemon(binding); return result; }
    catch (error) {
      const typed = error instanceof BrowserError && !["browser_identity_unverified", "browser_state_unavailable"].includes(error.code) ? error : new BrowserError("outcome_unknown", "浏览器动作应答或 daemon 状态未核实", !isReadOnly(args));
      if (!["tab_gone", "browser_action_failed", "browser_not_sent"].includes(typed.code)) {
        try { await this.unavailable(binding, typed); }
        catch { process.stderr.write("[ruukoto:browser] 浏览器失败状态无法保存；保留本次结果未知并停止自动化\n"); }
      }
      throw typed;
    }
  }

  private async stopUnit(unit: BrowserProcess | null): Promise<boolean> {
    if (!unit) return true;
    const state = processState(unit);
    if (state === "unknown") return false;
    if (state === "gone") return true;
    try { process.kill(unit.pid, "SIGTERM"); }
    catch (error) { return errno(error) === "ESRCH"; }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { const current = processState(unit); if (current === "gone") return true; if (current === "unknown") return false; await delay(50); }
    if (processState(unit) !== "alive") return false;
    try { process.kill(unit.pid, "SIGKILL"); }
    catch (error) { return errno(error) === "ESRCH"; }
    const hardDeadline = Date.now() + 3000;
    while (Date.now() < hardDeadline) { const current = processState(unit); if (current === "gone") return true; if (current === "unknown") return false; await delay(50); }
    return false;
  }

  private lockMatches(binding: BrowserBinding, generation = binding.generation): boolean {
    if (!binding.lockDir) return true;
    let owner: unknown;
    try { owner = JSON.parse(fs.readFileSync(path.join(binding.lockDir, "owner.json"), "utf8")); }
    catch { return false; }
    return object(owner) && owner.dataDir === this.dataDir && owner.sessionId === binding.sessionId && owner.generation === generation;
  }

  private sidecarsMatch(binding: BrowserBinding): boolean {
    for (const [name, unit] of [[binding.cliSession, binding.daemon], ["dashboard", binding.dashboard]] as const) {
      let pid: string;
      try { pid = fs.readFileSync(path.join(binding.socketDir, `${name}.pid`), "utf8"); }
      catch (error) { if (errno(error) === "ENOENT") continue; return false; }
      if (!unit || Number(pid.trim()) !== unit.pid) return false;
    }
    let names: string[];
    try { names = fs.readdirSync(binding.socketDir); }
    catch { return false; }
    return !names.some(name => name.endsWith(".pid") && ![`${binding.cliSession}.pid`, "dashboard.pid"].includes(name));
  }

  private live(binding: BrowserBinding): boolean {
    const previous = this.fingerprints.get(binding.sessionId);
    if (!previous) return false;
    let current: ReturnType<BrowserManager["fingerprint"]>;
    try { current = this.fingerprint(binding); }
    catch { return false; }
    return previous.config === current.config && previous.version === current.version && this.lockMatches(binding) && this.sidecarsMatch(binding) && !!binding.daemon && processState(binding.daemon) === "alive" && (!binding.chrome || processState(binding.chrome) === "alive") && (!binding.dashboard || processState(binding.dashboard) === "alive");
  }

  private async closeOwned(binding: BrowserBinding): Promise<boolean> {
    if (binding.chromePending && !binding.chrome) return false;
    if (!binding.chrome) return !binding.chromePending;
    const state = processState(binding.chrome);
    if (state === "unknown") return false;
    if (state === "alive") {
      if (binding.cdpUrl) {
        try { await browserClose(binding.cdpUrl); }
        catch { /* 关闭应答不能证明执行结束，继续核实实际进程。 */ }
      } else if (!await this.stopUnit(binding.chrome)) return false;
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (processState(binding.chrome) === "unknown") return false;
      const remaining = rows().filter(row => !row.state.startsWith("Z") && (row.pgid === binding.chrome!.pgid || row.command.includes(`--user-data-dir=${binding.profileDir}`)));
      if (remaining.length === 0 && processState(binding.chrome) === "gone") return true;
      await delay(100);
    }
    return false;
  }

  private async doClose(binding: BrowserBinding): Promise<boolean> {
    const active = this.active.get(binding.sessionId);
    active?.controller.abort();
    if (active) { try { await active.done; } catch { /* 在途命令的失败由 command 调用方报告；这里仍须核实 daemon。 */ } }
    try {
      if (!this.lockMatches(binding)) throw new BrowserError("browser_stop_unverified", "附接锁归属无法核实，保留占用");
      if (binding.daemonPending) {
        if (!binding.daemon) binding.daemon = this.sidecar(binding, binding.cliSession);
        if (!binding.daemon) throw new BrowserError("browser_stop_unverified", "daemon 启动窗口未记录身份，不能声称已停止");
        binding.daemonPending = false;
        try { await this.save(binding); }
        catch { process.stderr.write("[ruukoto:browser] daemon 身份无法保存；继续停止已核实的本次进程\n"); }
      }
      if (binding.dashboardPending) {
        if (!binding.dashboard) binding.dashboard = this.sidecar(binding, "dashboard");
        if (!binding.dashboard) throw new BrowserError("browser_stop_unverified", "dashboard 启动窗口未记录身份");
        binding.dashboardPending = false;
        try { await this.save(binding); }
        catch { process.stderr.write("[ruukoto:browser] dashboard 身份无法保存；继续停止已核实的本次进程\n"); }
      }
      if (!this.sidecarsMatch(binding)) throw new BrowserError("browser_stop_unverified", "控制目录出现未登记进程，保留原绑定与占用");
      const daemonStopped = await this.stopUnit(binding.daemon), dashboardStopped = await this.stopUnit(binding.dashboard);
      const chromeStopped = binding.kind === "owned" ? await this.closeOwned(binding) : true;
      if (!daemonStopped || !dashboardStopped || !chromeStopped) throw new BrowserError("browser_stop_unverified", "浏览器相关进程未核实停止，保留绑定与附接占用");
      if (!this.lockMatches(binding) || !this.sidecarsMatch(binding)) throw new BrowserError("browser_stop_unverified", "停止期间占用或进程记录变化，保留控制目录");
      binding.state = "closed"; binding.pauseTaskId = null; binding.pauseAfterSeq = null; binding.failureCode = null; await this.save(binding);
      if (binding.lockDir) fs.rmSync(binding.lockDir, { recursive: true });
      for (const name of fs.readdirSync(binding.socketDir)) if (/\.(pid|sock|stream|config|version|target)$/.test(name)) fs.rmSync(path.join(binding.socketDir, name), { force: true });
      return true;
    } catch (error) {
      const typed = error instanceof BrowserError ? error : new BrowserError("browser_stop_unverified", "浏览器停止核实失败，保留绑定与占用");
      try { await this.unavailable(binding, typed); }
      catch { process.stderr.write("[ruukoto:browser] 浏览器停止状态无法保存；保留绑定与占用待核实\n"); }
      process.stderr.write(`[ruukoto:browser] ${typed.message}\n`); return false;
    }
  }

  async close(sessionId: string): Promise<boolean> {
    const old = this.closing.get(sessionId); if (old) return await old;
    const pending = this.closeSession(sessionId); this.closing.set(sessionId, pending);
    try { return await pending; } finally { this.closing.delete(sessionId); }
  }

  private async closeSession(sessionId: string): Promise<boolean> {
    const active = this.active.get(sessionId); active?.controller.abort();
    let binding = this.bindings.get(sessionId);
    if (!binding && active) {
      try { await active.done; } catch { /* 尚未登记绑定的取消由启动调用方报告。 */ }
      binding = this.bindings.get(sessionId);
    }
    if (!binding || binding.state === "closed") return true;
    binding.state = "unavailable"; binding.failureCode = "browser_closing";
    let recorded = true;
    try { await this.save(binding); }
    catch { recorded = false; process.stderr.write("[ruukoto:browser] 关闭意图无法保存；继续回收已登记进程，停止结论保持待核实\n"); }
    return await this.doClose(binding) && recorded;
  }

  assertState(): void { if (this.loadError) throw this.loadError; }

  async recover(): Promise<void> {
    if (this.loadError) { process.stderr.write(`[ruukoto:browser] ${this.loadError.message}\n`); return; }
    for (const binding of this.bindings.values()) if (binding.state !== "closed") await this.close(binding.sessionId);
  }

  private async supervise(): Promise<void> {
    if (this.supervising || this.shuttingDown || this.loadError) return;
    this.supervising = true;
    try {
      for (const binding of this.bindings.values()) {
        if (!["ready", "paused"].includes(binding.state) || this.active.has(binding.sessionId) || this.closing.has(binding.sessionId)) continue;
        if (!this.lockMatches(binding)) { await this.unavailable(binding, new BrowserError("browser_identity_unverified", "附接占用记录变化，请核实原执行")); continue; }
        if (binding.daemon && processState(binding.daemon) === "gone") await this.close(binding.sessionId);
        else if ((binding.daemon && processState(binding.daemon) !== "alive") || (binding.chrome && processState(binding.chrome) !== "alive") || (binding.dashboard && processState(binding.dashboard) !== "alive")) await this.unavailable(binding, new BrowserError("browser_identity_unverified", "浏览器进程身份或存活状态无法核实"));
      }
    } catch (error) { process.stderr.write(`[ruukoto:browser] 生命周期监督失败：${error instanceof Error ? error.message : String(error)}\n`); }
    finally { this.supervising = false; }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true; clearInterval(this.timer);
    for (const sessionId of new Set([...this.bindings.keys(), ...this.active.keys()])) await this.close(sessionId);
  }
}
