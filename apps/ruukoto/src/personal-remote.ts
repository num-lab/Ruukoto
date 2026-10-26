import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { PersonalError } from "./personal-error.ts";
import { personalControl, readPersonalToken } from "./personal-control.ts";
import { PersonalRemoteAuth, personalRemoteDirectory, type PersonalRemoteBinding } from "./personal-remote-auth.ts";
import { readPersonalRemoteFile, writePersonalRemoteFile } from "./personal-remote-storage.ts";
import { PersonalRemoteMaintenance, PERSONAL_REMOTE_SETTINGS_READ } from "./personal-remote-maintenance.ts";
import { executePersonalSettings, parsePersonalSettingsRequest, personalSettingsDirectoryIdentity } from "./personal-settings.ts";
import { personalProfileFormatSupported } from "./personal-profile.ts";
import { parsePersonalImPairingRequest } from "./personal-im-pairing.ts";

const MAX_REQUEST = 128 * 1024, MAX_RESPONSE = 256 * 1024;
const READ_ROUTES = new Set(["/status", "/timeline", "/history/entry", "/questions", "/question", "/question/receipt", "/works", "/work", "/input", "/permissions", "/tools/operations", "/tools/operation", "/mcp/operations", "/mcp/operation", "/services", "/service", "/app-data/operations", "/app-data/operation"]);
const WRITE_ROUTES = new Set(["/inputs", "/question/answer", "/question/cancel", "/permissions", "/tools/decide", "/mcp/decide", "/mcp/end", "/service/decide", "/app-data/decide", "/work/cancel"]);
const OFFLINE_SETTINGS = new Set(["settings.read", "lifecycle.status", "skills.list", "skills.get", "skills.select-directory", "skills.preview-import", "mcp.get", "mcp.operations", "mcp.operation", "mcp.end"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export type PersonalRemoteConfig = { v: 1; origin: string; owner: string; profile: PersonalRemoteBinding["profile"] };
type Backend = <T = unknown>(method: "GET" | "POST", route: string, body?: unknown) => Promise<T>;
const invalid = () => new PersonalError("remote_config_invalid", "远程配置无法核实，请在服务器检查固定拥有者、HTTPS地址与原档案；入口保持关闭。");
function existingProfile(directory: string): void {
  const filename = path.join(directory, "profile.json"), stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 4096) throw invalid();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { if (!personalProfileFormatSupported(JSON.parse(fs.readFileSync(fd, "utf8")))) throw invalid(); }
  catch (error) { if (error instanceof PersonalError) throw error; throw invalid(); }
  finally { fs.closeSync(fd); }
}

export function parsePersonalRemoteConfig(value: unknown): PersonalRemoteConfig {
  if (!object(value) || Object.keys(value).sort().join(",") !== "origin,owner,profile,v" || value.v !== 1 || typeof value.origin !== "string" || typeof value.owner !== "string" || !value.owner || value.owner.length > 320 || /[\x00-\x20\x7f]/.test(value.owner) || !object(value.profile) || Object.keys(value.profile).sort().join(",") !== "directory,id" || typeof value.profile.directory !== "string" || !path.isAbsolute(value.profile.directory) || path.resolve(value.profile.directory) !== value.profile.directory || /[\x00-\x1f\x7f]/.test(value.profile.directory) || typeof value.profile.id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.profile.id)) throw invalid();
  let origin: URL;
  try { origin = new URL(value.origin); } catch { throw invalid(); }
  if (origin.protocol !== "https:" || origin.origin !== value.origin || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw invalid();
  return value as PersonalRemoteConfig;
}
export function readPersonalRemoteConfig(home?: () => string): PersonalRemoteConfig {
  let value: unknown;
  try { value = JSON.parse(readPersonalRemoteFile(personalRemoteDirectory(home), "remote.json")); }
  catch (error) { throw new PersonalError("remote_config_invalid", "远程配置缺失或无法读取，请保留原状态并在服务器初始化或恢复；未建空配置。", { cause: error }); }
  return parsePersonalRemoteConfig(value);
}
export async function initializePersonalRemote(config: PersonalRemoteConfig, home?: () => string): Promise<void> {
  config = parsePersonalRemoteConfig(config);
  if (!isDeepStrictEqual(personalSettingsDirectoryIdentity(config.profile.directory), config.profile)) throw invalid();
  existingProfile(config.profile.directory);
  const auth = new PersonalRemoteAuth({ origin: config.origin, owner: config.owner, profile: config.profile }, { initialize: true, home });
  try {
    const maintenance = new PersonalRemoteMaintenance(auth.directory, config.profile, { initialize: true });
    await maintenance.close();
    writePersonalRemoteFile(auth.directory, "remote.json", JSON.stringify(config) + "\n");
    auth.confirmBinding();
  } finally { auth.close(); }
}

async function readJSON(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST) throw new PersonalError("remote_request_large", "请求过大，请缩小本次输入或配置。");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) { throw new PersonalError("remote_request_invalid", "请求格式无效，请更新客户端并读取原操作状态。", { cause: error }); }
}
function respond(response: http.ServerResponse, result: unknown, status = 200): void {
  if (response.destroyed) return;
  const body = JSON.stringify({ v: 1, product: "ruukoto", ok: true, result });
  if (Buffer.byteLength(body) > MAX_RESPONSE) throw new PersonalError("remote_response_large", "查询结果过大，请缩小分页后读取。");
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" }).end(body);
}
function reject(response: http.ServerResponse, failure: unknown): void {
  if (response.destroyed) return;
  const code = failure instanceof PersonalError ? failure.code : "remote_unavailable";
  const message = failure instanceof PersonalError ? failure.message : "远程结果无法核实，请读取原请求与服务器状态；未自动重试。";
  const status = code === "remote_source_rejected" ? 403 : code.startsWith("remote_credential") ? 401 : code === "remote_route_unavailable" ? 404 : 409;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" }).end(JSON.stringify({ v: 1, product: "ruukoto", ok: false, code, message }));
}
function route(request: http.IncomingMessage): URL {
  if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw new PersonalError("remote_route_unavailable", "此远程路由不受支持。");
  return new URL(request.url, "http://localhost");
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export async function startPersonalRemote(options: { home?: () => string; backend?: Backend; maintenance?: PersonalRemoteMaintenance } = {}) {
  let config = readPersonalRemoteConfig(options.home);
  const binding = () => ({ origin: config.origin, owner: config.owner, profile: personalSettingsDirectoryIdentity(config.profile.directory) });
  const auth = new PersonalRemoteAuth(binding(), { home: options.home });
  const socketPath = path.join(auth.directory, "remote.sock"), adminPath = path.join(auth.directory, "admin.sock");
  if (Buffer.byteLength(socketPath) > 100) { auth.close(); throw new PersonalError("remote_path_long", "远程入口私有socket路径过长，请使用较短的服务器账户目录。"); }
  const backend: Backend = options.backend ?? ((method, target, body) => personalControl(config.profile.directory, method, target, body as Parameters<typeof personalControl>[3]));
  const server = http.createServer(), admin = http.createServer();
  const sockets = new Map<Socket, string>();
  const active = new Set<Promise<void>>();
  const ownedSockets = new Map<string, { dev: number; ino: number }>();
  const streams = new Set<WebSocket>();
  const relays = new Set<{ downstream: WebSocket; upstream: WebSocket; credential: string; close(): void }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 });
  let stopping = false, unavailable: PersonalError | undefined, shutdown: Promise<void> | undefined;
  const fatal = () => {
    unavailable = new PersonalError("remote_state_unavailable", "远程状态提交未核实，业务入口已关闭；请在服务器保留记录并检查后重启。");
    for (const relay of relays) relay.close();
    for (const socket of sockets.keys()) socket.destroy();
  };
  let maintenance: PersonalRemoteMaintenance;
  try { maintenance = options.maintenance ?? new PersonalRemoteMaintenance(auth.directory, config.profile, { failed: fatal }); }
  catch (error) { auth.close(); throw error; }
  const reconcile = () => {
    try {
      const next = readPersonalRemoteConfig(options.home), previous = auth.identity();
      config = next;
      const current = binding();
      if (!isDeepStrictEqual(previous.binding, current)) {
        for (const relay of relays) relay.close();
        for (const socket of sockets.keys()) socket.destroy();
        auth.updateBinding(current);
      }
    } catch (error) { fatal(); throw error; }
  };
  const authorize = (request: http.IncomingMessage, bound = true) => {
    if (stopping || unavailable) throw unavailable ?? new PersonalError("remote_stopping", "远程入口正在停止，请保留原请求并稍后查询。");
    if (request.headers.origin !== undefined || request.method === "OPTIONS") throw new PersonalError("remote_source_rejected", "此入口仅供已配对桌面使用。");
    reconcile();
    let receipt: ReturnType<PersonalRemoteAuth["authenticate"]>;
    try { receipt = auth.authenticate(request.headers["tailscale-user-login"] as string | undefined, request.headers.authorization); }
    catch (error) {
      if (error instanceof PersonalError && ["remote_auth_closed", "remote_auth_state_changed", "remote_auth_write_failed", "remote_auth_state_invalid"].includes(error.code)) fatal();
      throw error;
    }
    const identity = auth.identity();
    if (bound && (request.headers["x-ruukoto-remote-id"] !== identity.remoteId || request.headers["x-ruukoto-profile-id"] !== identity.binding.profile.id)) throw new PersonalError("remote_profile_changed", "远程实例或档案身份不符，请保留原请求并重新核实配对目标。");
    const socket = request.socket;
    sockets.set(socket, receipt.id);
    socket.once("close", () => sockets.delete(socket));
    return receipt;
  };
  const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    try {
      const url = route(request);
      if (request.method === "POST" && url.pathname === "/pair") {
        if (stopping || unavailable || request.headers.origin !== undefined || request.headers["tailscale-user-login"] !== config.owner) throw new PersonalError("remote_source_rejected", "此配对来源不受支持，请使用原拥有者的桌面。");
        const body = await readJSON(request);
        if (!object(body) || Object.keys(body).sort().join(",") !== "code,label,v" || body.v !== 1 || typeof body.code !== "string" || typeof body.label !== "string") throw new PersonalError("remote_request_invalid", "配对请求无效，请使用原候选记录重试。");
        reconcile();
        let receipt: ReturnType<PersonalRemoteAuth["pair"]>;
        try { receipt = auth.pair(request.headers["tailscale-user-login"] as string | undefined, request.headers.authorization, { v: 1, code: body.code, label: body.label }); }
        catch (error) { if (error instanceof PersonalError && ["remote_auth_write_failed", "remote_auth_state_changed", "remote_auth_closed"].includes(error.code)) fatal(); throw error; }
        respond(response, receipt); return;
      }
      authorize(request, url.pathname !== "/handshake");
      const body = request.method === "POST" ? await readJSON(request) : undefined;
      authorize(request, url.pathname !== "/handshake");
      if (request.method === "GET" && url.pathname === "/handshake") {
        let online = false, runId: string | undefined;
        try {
          const identity = await backend<{ v: number; product: string; profile: PersonalRemoteBinding["profile"]; runId: string }>("GET", "/desktop/identity");
          if (identity.v !== 1 || identity.product !== "ruukoto" || !isDeepStrictEqual(identity.profile, auth.identity().binding.profile) || typeof identity.runId !== "string") throw new PersonalError("remote_backend_identity", "个人后台产品、档案或协议不符，请在服务器核实原部署。");
          online = true; runId = identity.runId;
        } catch (error) { if (!(error instanceof PersonalError) || !["control_unavailable", "control_response_lost", "control_starting", "control_stopping"].includes(error.code)) throw error; }
        authorize(request, false);
        const identity = auth.identity();
        respond(response, { v: 1, product: "ruukoto", remoteId: identity.remoteId, origin: identity.binding.origin, profile: identity.binding.profile, online, ...(runId ? { runId } : {}) });
      } else if (request.method === "GET" && url.pathname === "/management") {
        const result = await maintenance.view(); authorize(request); respond(response, result);
      } else if (request.method === "GET" && url.pathname === "/maintenance") {
        const result = await maintenance.querySettings(url.searchParams.get("id") ?? ""); authorize(request); respond(response, result);
      } else if (request.method === "POST" && ["/maintenance", "/maintenance/restore", "/maintenance/finish"].includes(url.pathname)) {
        if (!object(body) || ![1, 2].includes(Number(body.v)) || body.v === 2 && url.pathname !== "/maintenance" || typeof body.id !== "string" || Object.keys(body).some(key => !["v", "id", ...(url.pathname === "/maintenance" ? ["request"] : [])].includes(key))) throw new PersonalError("remote_request_invalid", "维护请求无效，请读取原操作；请求标识由程序管理。");
        const permit = () => { authorize(request); };
        const result = url.pathname === "/maintenance" ? body.v === 2 ? await maintenance.admitSettings(body.id, body.request, permit) : await maintenance.admit(body.id, body.request, permit) : url.pathname.endsWith("restore") ? await maintenance.restore(body.id, permit) : await maintenance.finish(body.id, permit);
        respond(response, result, "stage" in result ? result.stage === "complete" ? 200 : 202 : result.status === "active" ? 200 : 202);
      } else if (request.method === "POST" && url.pathname === "/settings") {
        const settings = object(body) && typeof body.op === "string" && body.op.startsWith("im.pair-") ? parsePersonalImPairingRequest(body) : parsePersonalSettingsRequest(body);
        if (!PERSONAL_REMOTE_SETTINGS_READ.includes(settings.op)) throw new PersonalError("settings_upgrade_required", "配置写入需要 v2 保存入口，请更新客户端后读取原设置。");
        if ("profile" in settings && !isDeepStrictEqual(settings.profile, auth.identity().binding.profile)) throw new PersonalError("remote_profile_changed", "设置请求档案不同，请重新读取原目标。");
        authorize(request);
        const result = OFFLINE_SETTINGS.has(settings.op) ? await executePersonalSettings(config.profile.directory, settings) : await backend("POST", "/settings", settings);
        authorize(request); respond(response, result);
      } else if (request.method === "GET" && READ_ROUTES.has(url.pathname) || request.method === "POST" && WRITE_ROUTES.has(url.pathname)) {
        authorize(request);
        const result = await backend(request.method as "GET" | "POST", url.pathname + url.search, body);
        authorize(request); respond(response, result);
      } else throw new PersonalError("remote_route_unavailable", "此远程操作不受支持，请更新桌面；未调用其他本机入口。");
    } catch (error) { reject(response, error); }
  };
  const handleAdmin = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    try {
      const url = route(request), body = request.method === "POST" ? await readJSON(request) : undefined;
      if (stopping) throw new PersonalError("remote_stopping", "远程入口正在退出，请稍后重试管理操作。");
      if (request.method === "GET" && url.pathname === "/diagnostic") { respond(response, { identity: auth.identity(), unavailable: unavailable?.code, pending: maintenance.pending() }); return; }
      if (unavailable) throw unavailable;
      reconcile();
      if (request.method === "POST" && url.pathname === "/pair/open") respond(response, auth.openPairing());
      else if (request.method === "POST" && url.pathname === "/pair/cancel") { auth.cancelPairing(); respond(response, { cancelled: true }); }
      else if (request.method === "GET" && url.pathname === "/credentials") respond(response, auth.list());
      else if (request.method === "POST" && url.pathname === "/credentials/revoke") {
        if (!object(body) || Object.keys(body).join(",") !== "id" || typeof body.id !== "string") throw new PersonalError("remote_request_invalid", "请选择原配对桌面后撤销。");
        let receipt: ReturnType<PersonalRemoteAuth["revoke"]>;
        try { receipt = auth.revoke(body.id); } catch (error) { fatal(); throw error; }
        for (const relay of relays) if (relay.credential === body.id) relay.close();
        for (const [socket, id] of sockets) if (id === body.id) socket.destroy();
        respond(response, receipt);
      } else if (request.method === "POST" && url.pathname === "/binding/confirm") {
        const identity = auth.identity();
        existingProfile(identity.binding.profile.directory);
        const pending = maintenance.pending();
        if (pending && !isDeepStrictEqual(pending.profile, identity.binding.profile)) throw new PersonalError("remote_maintenance_pending", "原档案仍有维护待核实，请先恢复原绑定并处理；未确认新档案。");
        await maintenance.close();
        maintenance = new PersonalRemoteMaintenance(auth.directory, identity.binding.profile, { failed: fatal });
        writePersonalRemoteFile(auth.directory, "remote.json", JSON.stringify({ v: 1, ...identity.binding }) + "\n");
        auth.confirmBinding(); respond(response, auth.identity());
      } else throw new PersonalError("remote_route_unavailable", "此本机管理操作不受支持。");
    } catch (error) { if (error instanceof PersonalError && ["remote_auth_write_failed", "remote_auth_state_changed", "remote_auth_closed"].includes(error.code)) fatal(); reject(response, error); }
  };
  const track = (handler: typeof handle) => (request: http.IncomingMessage, response: http.ServerResponse) => {
    const work = handler(request, response); active.add(work); void work.finally(() => active.delete(work));
  };
  server.on("request", track(handle)); admin.on("request", track(handleAdmin));
  server.on("upgrade", (request, socket, head) => {
    let upstream: WebSocket | undefined;
    try {
      if (route(request).pathname !== "/events") throw new PersonalError("remote_route_unavailable", "此观察路由不受支持。");
      const receipt = authorize(request);
      const token = readPersonalToken(config.profile.directory);
      upstream = new WebSocket(`ws+unix:${path.join(config.profile.directory, "control.sock")}:/events`, { headers: { authorization: `Bearer ${token}` }, maxPayload: MAX_RESPONSE, handshakeTimeout: 10_000 });
      const source = upstream;
      streams.add(source);
      source.once("close", () => streams.delete(source));
      source.on("error", () => socket.destroy());
      source.once("open", () => {
        try { authorize(request); } catch { source.terminate(); socket.destroy(); return; }
        wss.handleUpgrade(request, socket, head, downstream => {
          streams.add(downstream);
          downstream.once("close", () => streams.delete(downstream));
          const close = () => { downstream.terminate(); source.terminate(); };
          const relay = { downstream, upstream: source, credential: receipt.id, close };
          relays.add(relay);
          const expiry = setTimeout(close, 5 * 60_000);
          let pongTimeout: ReturnType<typeof setTimeout> | undefined;
          const heartbeat = setInterval(() => { pongTimeout = setTimeout(close, 10_000); downstream.ping(); }, 30_000);
          downstream.on("pong", () => clearTimeout(pongTimeout));
          downstream.on("message", close);
          downstream.on("error", close);
          source.on("message", (data, binary) => {
            const bytes = Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.byteLength, 0) : data.byteLength;
            if (binary || bytes > MAX_RESPONSE || downstream.bufferedAmount + bytes > 1024 * 1024) { downstream.close(1013, "resync_required"); source.terminate(); return; }
            downstream.send(data, { binary: false });
          });
          const cleanup = () => { clearTimeout(expiry); clearTimeout(pongTimeout); clearInterval(heartbeat); relays.delete(relay); close(); };
          downstream.once("close", cleanup); source.once("close", cleanup);
        });
      });
      socket.once("close", () => source.terminate());
    } catch { upstream?.terminate(); socket.end("HTTP/1.1 403 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); }
  });
  for (const endpoint of [server, admin]) { endpoint.requestTimeout = 10_000; endpoint.headersTimeout = 10_000; endpoint.timeout = 45_000; }
  const timer = setInterval(() => { if (!stopping && !unavailable) { try { reconcile(); } catch { /* reconcile已关闭业务连接，诊断保留在本机管理入口。 */ } } }, 1000);
  const stop = () => shutdown ??= (async () => {
    stopping = true; clearInterval(timer);
    const closed = [...streams].map(stream => stream.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise<void>(resolve => stream.once("close", () => resolve())));
    for (const stream of streams) stream.terminate();
    for (const relay of relays) relay.close();
    for (const socket of sockets.keys()) socket.destroy();
    await Promise.all(closed);
    await Promise.all([server, admin].map(endpoint => endpoint.listening ? new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve())) : Promise.resolve()));
    await Promise.allSettled([...active]);
    try { await maintenance.close(); }
    finally {
      await new Promise<void>(resolve => wss.close(() => resolve()));
      try {
        for (const [target, owned] of ownedSockets) {
          const current = fs.lstatSync(target, { throwIfNoEntry: false });
          if (current?.isSocket() && current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(target);
        }
      } finally { auth.close(); }
    }
  })();
  try {
    for (const [endpoint, target] of [[server, socketPath], [admin, adminPath]] as const) {
      const existing = fs.lstatSync(target, { throwIfNoEntry: false });
      if (existing && (!existing.isSocket() || existing.uid !== process.getuid?.())) throw invalid();
      if (existing) fs.unlinkSync(target);
      endpoint.listen(target); await once(endpoint, "listening"); fs.chmodSync(target, 0o600);
      const stat = fs.lstatSync(target); ownedSockets.set(target, { dev: stat.dev, ino: stat.ino });
    }
  } catch (error) { await stop(); throw error; }
  return { socketPath, adminPath, stop };
}
