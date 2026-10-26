import * as https from "node:https";
import * as http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { WebSocket } from "ws";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { serializeFailure } from "./controller.ts";
import { DesktopError } from "./environment.ts";
import { savePersonalConfig, validatePersonalConfig, personalProfile, personalPendingFile, readPersonalRecord, writePersonalRecord, type PersonalTargetConfig } from "./personal-config.ts";
import type { PersonalCredentialStorage } from "./personal-credentials.ts";
import type { DesktopUpdate } from "../shared/bridge.ts";
import type { PersonalDesktopFrame, PersonalRemoteIdentity, PersonalPendingInput, PersonalInputReceipt } from "../shared/personal-desktop.ts";

type Secret = { id: string; secret: string; origin: string };
type Active = Secret & { remoteId: string; profile: PersonalRemoteIdentity["profile"] };
type Candidate = Secret & { request: { v: 1; code: string; label: string }; rejected?: true };
type Credentials = { v: 1; active?: Active; candidate?: Candidate };
type Pending = { v: 1; input: PersonalPendingInput | null; maintenance?: { id: string; requestDigest: string }; settings?: { id: string; requestDigest: string; target: string; scope: string }[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const failed = (code: string, message: string, outcome: "not_sent" | "unknown" | "rejected" = "not_sent") => new ControlClientError(code, message, outcome);
const bindingMatches = (identity: PersonalRemoteIdentity, binding: { remoteId: string; profile: PersonalRemoteIdentity["profile"] }) => identity.remoteId === binding.remoteId && isDeepStrictEqual(identity.profile, binding.profile);
const READ_PATHS = ["/status", "/timeline", "/history/entry", "/input", "/permissions", "/questions", "/question", "/question/receipt", "/works", "/work", "/tools/operations", "/tools/operation", "/mcp/operations", "/mcp/operation", "/app-data/operations", "/app-data/operation", "/services", "/service"];
const WRITE_PATHS = ["/permissions", "/question/answer", "/question/cancel", "/work/cancel", "/tools/decide", "/mcp/decide", "/mcp/end", "/app-data/decide", "/service/decide"];
const KNOWN_REJECTIONS = new Set(["remote_request_invalid", "remote_maintenance_request_invalid", "remote_maintenance_pending", "settings_pending", "settings_revision_changed", "settings_revision_conflict", "settings_target_pending", "settings_request_conflict", "settings_request_invalid", "settings_upgrade_required", "settings_profile_changed", "settings_file_unverified", "skills_revision_conflict", "settings_stop_required", "profile_busy", "maintenance_read_only", "model_environment_unverified", "input_invalid", "input_conflict", "mcp_end_unavailable", "mcp_end_invalid", "mcp_missing", "mcp_original_entry"]);
const authorization = (value: Secret) => `Bearer ${value.id}.${value.secret}`;
function parseCredentials(raw: string | null): Credentials {
  if (raw === null) return { v: 1 };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw failed("personal_credentials_invalid", "安全存储记录损坏，请保留原记录并在服务器核实原配对。"); }
  if (!object(value) || value.v !== 1 || Object.keys(value).some(key => !["v", "active", "candidate"].includes(key))) throw failed("personal_credentials_invalid", "安全存储记录版本无效，请保留原配对记录并检查客户端版本。");
  for (const key of ["active", "candidate"] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (!object(item) || typeof item.id !== "string" || !UUID.test(item.id) || typeof item.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(item.secret) || Buffer.from(item.secret, "base64url").toString("base64url") !== item.secret || typeof item.origin !== "string" || validatePersonalConfig({ origin: item.origin }).origin !== item.origin) throw failed("personal_credentials_invalid", "安全存储中的原凭据无法核实，请在服务器检查原配对。");
    if (key === "active" && (typeof item.remoteId !== "string" || !UUID.test(item.remoteId) || !personalProfile(item.profile)) || key === "candidate" && (item.rejected !== undefined && item.rejected !== true || !object(item.request) || item.request.v !== 1 || typeof item.request.code !== "string" || !/^[A-Z2-7]{12}$/.test(item.request.code) || typeof item.request.label !== "string" || !item.request.label.trim() || item.request.label.length > 80)) throw failed("personal_credentials_invalid", "安全存储中的原配对关联无效，请保留原记录并在服务器核实。");
  }
  return value as Credentials;
}
function parseIdentity(value: unknown, origin: string): PersonalRemoteIdentity {
  if (!object(value) || value.v !== 1 || value.product !== "ruukoto" || value.origin !== origin || typeof value.remoteId !== "string" || !UUID.test(value.remoteId) || !personalProfile(value.profile) || typeof value.online !== "boolean" || value.online && typeof value.runId !== "string" || value.runId !== undefined && (typeof value.runId !== "string" || !value.runId || value.runId.length > 128)) throw failed("personal_protocol", "远程入口产品、协议或归属不匹配，连接已停止；请核实地址与版本。");
  return value as PersonalRemoteIdentity;
}
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const desktopModel = (value: unknown) => object(value) && typeof value.provider === "string" && typeof value.modelId === "string";
function desktopBlock(value: unknown): boolean {
  return object(value) && typeof value.truncated === "boolean" && (["text", "thinking"].includes(String(value.type)) && typeof value.text === "string" || value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string" && typeof value.arguments === "string");
}
function desktopMessage(value: unknown): boolean {
  return object(value) && ["user", "assistant", "toolResult"].includes(String(value.role)) && typeof value.text === "string" && typeof value.partial === "boolean" && typeof value.truncated === "boolean" && timestamp(value.timestamp) && (value.thinking === undefined || typeof value.thinking === "string") && (value.toolCallId === undefined || typeof value.toolCallId === "string") && (value.toolName === undefined || typeof value.toolName === "string") && (value.isError === undefined || typeof value.isError === "boolean") && (value.blocks === undefined || Array.isArray(value.blocks) && value.blocks.every(block => object(block) && integer(block.index) && desktopBlock(block))) && (value.toolCalls === undefined || Array.isArray(value.toolCalls) && value.toolCalls.every(call => object(call) && typeof call.id === "string" && typeof call.name === "string" && typeof call.arguments === "string" && typeof call.truncated === "boolean"));
}
function desktopEntry(value: unknown): boolean { return object(value) && integer(value.entry) && integer(value.conversation) && typeof value.kind === "string" && desktopMessage(value); }
function desktopEvent(value: unknown): boolean {
  if (!object(value) || typeof value.type !== "string") return false;
  if (value.type === "message_start") return desktopMessage(value.message);
  if (value.type === "message_end" || value.type === "entry_appended") return desktopEntry(value.entry);
  if (value.type === "message_update") return Array.isArray(value.changes) && value.changes.every(change => {
    if (!object(change)) return false;
    if (change.type === "message") return desktopMessage(change.message);
    if (!integer(change.contentIndex)) return false;
    if (["text_start", "thinking_start", "toolcall_start", "block"].includes(String(change.type))) return desktopBlock(change.block);
    return ["text_delta", "thinking_delta", "toolcall_delta"].includes(String(change.type)) && typeof change.delta === "string" && typeof change.truncated === "boolean" && (change.type !== "toolcall_delta" || Array.isArray(change.path) && change.path.every(part => typeof part === "string" || integer(part)));
  });
  if (value.type === "run_start" || value.type === "run_end") return Array.isArray(value.inputs) && value.inputs.every(integer) && integer(value.total);
  if (value.type === "inbox_update") return Array.isArray(value.items) && value.items.every(item => object(item) && integer(item.id) && typeof item.mode === "string") && integer(value.total);
  if (value.type === "submission") return object(value.record) && integer(value.record.id) && typeof value.record.status === "string" && (value.record.entry === undefined || integer(value.record.entry)) && (value.record.answer === undefined || integer(value.record.answer));
  if (value.type.startsWith("tool_execution_")) {
    if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string" || value.taskId !== undefined && !integer(value.taskId) || value.parentToolCallId !== undefined && typeof value.parentToolCallId !== "string" || value.parentTaskId !== undefined && !integer(value.parentTaskId)) return false;
    if (value.type === "tool_execution_start") return typeof value.arguments === "string" && typeof value.truncated === "boolean";
    if (value.type === "tool_execution_update") return typeof value.truncated === "boolean" && (value.output === undefined || object(value.output) && (value.output.set === undefined || typeof value.output.set === "string") && (value.output.append === undefined || typeof value.output.append === "string") && (value.output.trimStart === undefined || integer(value.output.trimStart)));
    return value.type === "tool_execution_end" && (value.entry === undefined || desktopEntry(value.entry)) && (value.result === undefined || object(value.result) && typeof value.result.text === "string" && typeof value.result.truncated === "boolean" && typeof value.result.isError === "boolean");
  }
  if (value.type === "agent_changed") return value.model === undefined || desktopModel(value.model);
  if (value.type === "task_failed") return integer(value.taskId) && typeof value.message === "string" && typeof value.kind === "string";
  if (value.type === "auto_retry_start") return integer(value.attempt) && timestamp(value.at) && typeof value.errorMessage === "string";
  if (value.type === "auto_retry_end") return integer(value.attempt);
  if (value.type === "deferred_poll") return timestamp(value.pollAt);
  if (value.type === "compaction_start" || value.type === "compaction_end") return integer(value.taskId) && typeof value.reason === "string" && (value.type === "compaction_start" ? typeof value.blocking === "boolean" : value.error === undefined || typeof value.error === "string");
  return value.type === "turn_start" || value.type === "turn_end";
}
function desktopSnapshot(value: Record<string, unknown>): boolean {
  if (!object(value.timeline) || !integer(value.timeline.through) || !Array.isArray(value.timeline.items) || !value.timeline.items.every(desktopEntry) || value.timeline.nextCursor !== undefined && typeof value.timeline.nextCursor !== "string" || !object(value.live)) return false;
  const live = value.live;
  return Array.isArray(live.tools) && live.tools.every(tool => object(tool) && typeof tool.callId === "string" && typeof tool.name === "string" && ["pending", "running", "done"].includes(String(tool.status)) && typeof tool.truncated === "boolean" && (tool.output === undefined || typeof tool.output === "string") && (tool.taskId === undefined || integer(tool.taskId)) && (tool.entry === undefined || integer(tool.entry)) && (tool.parentCallId === undefined || typeof tool.parentCallId === "string") && (tool.parentTaskId === undefined || integer(tool.parentTaskId))) && integer(live.toolCount) && Array.isArray(live.inbox) && live.inbox.every(item => object(item) && integer(item.id) && typeof item.mode === "string") && integer(live.inboxCount) && (live.model === undefined || desktopModel(live.model)) && (live.run === undefined || object(live.run) && Array.isArray(live.run.inputs) && live.run.inputs.every(integer) && integer(live.run.total)) && (live.generation === undefined || object(live.generation) && integer(live.generation.attempt) && (live.generation.message === undefined || desktopMessage(live.generation.message)) && (live.generation.retry === undefined || object(live.generation.retry) && timestamp(live.generation.retry.at) && typeof live.generation.retry.error === "string") && (live.generation.deferred === undefined || object(live.generation.deferred) && timestamp(live.generation.deferred.pollAt)));
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export class PersonalController {
  config: PersonalTargetConfig;
  status: Extract<DesktopUpdate, { type: "state" }> = { type: "state", state: "closed", detail: "尚未连接" };
  private identity: PersonalRemoteIdentity | null = null;
  private credentials: Credentials = { v: 1 };
  private ws: WebSocket | null = null;
  private readonly requests = new Set<http.ClientRequest>();
  private generation = 0;
  private closed = false;
  private retry: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private pong: NodeJS.Timeout | null = null;
  private delay = 500;
  private connecting: Promise<void> | null = null;
  private credentialOperation: Promise<unknown> | null = null;
  private switching = false;
  private inputOperation = false;
  constructor(config: PersonalTargetConfig, private readonly userData: string, private readonly publish: (update: DesktopUpdate) => void, private readonly storage: PersonalCredentialStorage | undefined, private readonly deps: { agent?: https.Agent } = {}) { this.config = validatePersonalConfig(config); }
  private current(generation: number): boolean { return !this.closed && generation === this.generation; }
  private state(value: Extract<DesktopUpdate, { type: "state" }>): void { this.status = value; this.publish(value); }
  private stopObservation(): void {
    if (this.retry) clearTimeout(this.retry); if (this.heartbeat) clearInterval(this.heartbeat); if (this.pong) clearTimeout(this.pong);
    this.retry = null; this.heartbeat = null; this.pong = null;
    const ws = this.ws; this.ws = null; ws?.terminate();
  }
  private terminal(error: unknown): void {
    this.stopObservation(); ++this.generation;
    const failure = serializeFailure(error);
    for (const item of [this.credentials.active, this.credentials.candidate]) if (item) failure.message = failure.message.replaceAll(item.secret, "[凭据已隐藏]");
    this.state({ type: "state", state: "failed", error: failure, detail: failure.message });
  }
  private fatal(error: unknown): boolean {
    return error instanceof ControlClientError && (error.code.startsWith("remote_auth") || error.code.startsWith("remote_backend") || error.code.startsWith("remote_credential") || error.code.startsWith("remote_source") || error.code.startsWith("remote_binding") || error.code.startsWith("remote_profile") || error.code.startsWith("personal_protocol") || error.code.startsWith("personal_identity") || error.code.startsWith("personal_tls") || error.code === "personal_redirect");
  }
  private disconnected(generation: number): void {
    if (!this.current(generation)) return;
    ++this.generation; this.stopObservation();
    this.state({ type: "state", state: "reconnecting", detail: "连接已断开，后台工作继续；正在恢复观察。" });
    const delay = this.delay; this.delay = Math.min(delay * 2, 8000);
    this.retry = setTimeout(() => { this.retry = null; void this.reconnect(); }, Math.round(delay * (0.8 + Math.random() * 0.4)));
  }
  private async readCredentials(): Promise<Credentials> {
    if (!this.storage) throw failed("personal_credentials_unavailable", "此桌面没有可用的安全存储，请使用支持安全配对的应用构建。");
    let raw: string | null;
    try { raw = await this.storage.read(); } catch { throw failed("personal_credentials_unavailable", "安全存储暂不可读，请解锁或恢复应用授权后重新连接；原记录已保留。"); }
    return parseCredentials(raw);
  }
  private async saveCredentials(value: Credentials): Promise<void> {
    if (!this.storage) throw failed("personal_credentials_unavailable", "此桌面没有可用的安全存储，未发送配对请求。");
    const raw = JSON.stringify(value);
    try { await this.storage.write(raw); } catch { throw failed("personal_credentials_unavailable", "安全存储未能保存，请恢复授权后核实原配对；未发送新的配对请求。"); }
    let saved: string | null;
    try { saved = await this.storage.read(); } catch { throw failed("personal_credentials_unavailable", "安全存储读回未核实，请保留原记录并恢复授权；未发送新的配对请求。"); }
    if (saved !== raw) throw failed("personal_credentials_invalid", "安全存储读回与原记录不同，未发送配对请求；请在服务器核实原配对。");
    this.credentials = value;
  }
  private exchange(method: "GET" | "POST", route: string, body: unknown, secret: Secret, bound = true): Promise<unknown> {
    if (this.closed || secret.origin !== this.config.origin) return Promise.reject(failed("personal_identity_changed", "安全凭据不属于当前地址，未发送请求；请重新配对。"));
    const url = new URL(route, this.config.origin);
    if (!route.startsWith("/") || route.startsWith("//") || url.origin !== this.config.origin || url.hash) return Promise.reject(failed("op_not_allowed", "此远程路径未向桌面开放。"));
    const raw = body === undefined ? undefined : JSON.stringify(body);
    if (raw !== undefined && Buffer.byteLength(raw) > 128 * 1024) return Promise.reject(failed("personal_request_large", "请求超过上限，请缩小正文或配置。"));
    const identity = this.identity;
    if (bound && (!identity || !("remoteId" in secret) || !bindingMatches(identity, secret as Active))) return Promise.reject(failed("personal_identity_changed", "原档案尚未核实，未发送业务请求。"));
    return new Promise((resolve, reject) => {
      let sent = false;
      const req = https.request(url, { method, agent: this.deps.agent, headers: { authorization: authorization(secret), "content-type": "application/json", ...(bound && identity ? { "x-ruukoto-remote-id": identity.remoteId, "x-ruukoto-profile-id": identity.profile.id } : {}) } });
      this.requests.add(req);
      const fail = (error: ControlClientError) => { const safe = new ControlClientError(error.code, error.message.replaceAll(secret.secret, "[凭据已隐藏]"), error.outcome); reject(safe); if (this.fatal(safe)) this.terminal(safe); };
      req.once("finish", () => { sent = true; });
      req.once("close", () => this.requests.delete(req));
      req.setTimeout(method === "POST" ? 35_000 : 10_000, () => req.destroy(new Error("timeout")));
      req.once("error", (error: NodeJS.ErrnoException) => {
        const tls = /^(?:ERR_TLS|ERR_SSL|CERT_|DEPTH_|UNABLE_TO_|SELF_SIGNED)/.test(error.code ?? "");
        fail(failed(tls ? "personal_tls" : "personal_connection_lost", tls ? "TLS 证书核实失败，连接已停止；请核实地址与系统信任配置。" : "未取得远端应答，请核实原请求；不会自动重发。", tls || !sent ? "not_sent" : "unknown"));
      });
      req.on("response", res => {
        if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) { res.resume(); fail(failed("personal_redirect", "远程入口返回重定向，连接已停止；请填写最终 HTTPS 地址。", method === "POST" ? "unknown" : "not_sent")); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) { res.destroy(); fail(failed("personal_response_large", "远端应答超过上限，请核实原请求；不会自动重发。", method === "POST" ? "unknown" : "not_sent")); } else chunks.push(chunk); });
        res.once("error", () => fail(failed("personal_connection_lost", "远端应答中断，请核实原请求；不会自动重发。", method === "POST" ? "unknown" : "not_sent")));
        res.once("end", () => {
          let value: unknown;
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail(failed("personal_protocol", "远端应答无法解析，请核实原请求与版本。", method === "POST" ? "unknown" : "not_sent")); return; }
          if (!object(value) || value.v !== 1 || value.product !== "ruukoto" || typeof value.ok !== "boolean") { fail(failed("personal_protocol", "远端产品或协议不匹配，连接已停止；请核实原请求与版本。", method === "POST" ? "unknown" : "not_sent")); return; }
          if (value.ok === false && typeof value.code === "string" && typeof value.message === "string") { fail(failed(value.code, value.message, (res.statusCode ?? 0) >= 500 || method === "POST" && !KNOWN_REJECTIONS.has(value.code) || value.code.includes("unverified") || value.code.includes("response_lost") || value.code.includes("response_large") || value.code.includes("internal") ? "unknown" : "rejected")); return; }
          if (!value.ok || !Object.hasOwn(value, "result") || ![200, 202].includes(res.statusCode ?? 0)) { fail(failed("personal_protocol", "远端应答状态无效，请核实原请求。", method === "POST" ? "unknown" : "not_sent")); return; }
          resolve(value.result);
        });
      });
      req.end(raw);
    });
  }
  private checkIdentity(value: unknown, secret: Active | Candidate): PersonalRemoteIdentity {
    const identity = parseIdentity(value, this.config.origin);
    if ("remoteId" in secret && (!bindingMatches(identity, secret) || this.config.binding && !bindingMatches(identity, this.config.binding))) throw failed("personal_identity_changed", "远程实例或档案归属已变化，连接已停止；请在服务器核实并重新配对。");
    return identity;
  }
  private persistBinding(identity: PersonalRemoteIdentity): void {
    const binding = { remoteId: identity.remoteId, profile: identity.profile };
    if (isDeepStrictEqual(this.config.binding, binding)) return;
    if (this.config.binding && (this.pending().input || this.pending().maintenance || this.pending().settings?.length)) throw failed("personal_pending", "原档案仍有待核实请求，请先核实原输入与维护；未更改原绑定或凭据。");
    this.config = savePersonalConfig(this.userData, { v: 1, origin: this.config.origin, binding });
  }
  private adopt(identity: PersonalRemoteIdentity): void {
    this.persistBinding(identity);
    this.identity = identity;
    this.publish({ type: "personal_identity", identity });
  }
  reconnect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const generation = ++this.generation; this.stopObservation();
    this.state({ type: "state", state: "connecting" });
    this.connecting = (async () => {
      try {
        this.credentials = await this.readCredentials();
        const candidate = this.credentials.candidate;
        if (candidate?.origin === this.config.origin && !candidate.rejected) await this.credentialExclusive(() => this.completeCandidate(candidate));
        const active = this.credentials.active;
        if (!active || active.origin !== this.config.origin) throw failed(this.credentials.candidate?.origin === this.config.origin ? "personal_pairing_pending" : "personal_pairing_required", this.credentials.candidate?.origin === this.config.origin ? "原配对结果待核实，请核实原候选凭据；不会生成新凭据。" : "请在服务器开启配对窗口，然后输入配对码。");
        const identity = this.checkIdentity(await this.exchange("GET", "/handshake", undefined, active, false), active);
        if (!this.current(generation)) return;
        this.adopt(identity); this.delay = 500;
        this.state({ type: "state", state: "online", detail: identity.online ? "已连接个人 Agent" : "已连接远程入口，个人后台当前离线。" });
        if (identity.online) await this.reconcileInput();
        else this.publish({ type: "personal_pending", record: this.pending().input });
        if (!this.current(generation)) return;
        if (identity.online) this.observe(generation, active, identity);
        else this.retry = setTimeout(() => { this.retry = null; void this.reconnect(); }, 2000);
      } catch (error) {
        if (!this.current(generation)) return;
        if (error instanceof ControlClientError && error.code === "personal_connection_lost") this.disconnected(generation);
        else this.terminal(error);
      }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  private observe(generation: number, active: Active, identity: PersonalRemoteIdentity): void {
    const ws = new WebSocket(this.config.origin.replace(/^https:/, "wss:") + "/events", { agent: this.deps.agent, headers: { authorization: authorization(active), "x-ruukoto-remote-id": identity.remoteId, "x-ruukoto-profile-id": identity.profile.id }, handshakeTimeout: 10_000, maxPayload: 256 * 1024, followRedirects: false });
    this.ws = ws;
    let subscription: string | null = null, seq = -1;
    ws.on("error", (error: NodeJS.ErrnoException) => { if (this.current(generation) && /^(?:ERR_TLS|ERR_SSL|CERT_|DEPTH_|UNABLE_TO_|SELF_SIGNED)/.test(error.code ?? "")) this.terminal(failed("personal_tls", "TLS 证书核实失败，观察已停止；请核实地址与系统信任配置。")); });
    ws.on("unexpected-response", (_request, res) => { res.resume(); if (this.current(generation)) this.terminal(failed("personal_protocol", "远程观察握手被拒绝，连接已停止；请核实应用凭据与协议。")); });
    ws.on("open", () => {
      if (!this.current(generation)) { ws.terminate(); return; }
      this.heartbeat = setInterval(() => { if (ws.readyState !== WebSocket.OPEN) return; ws.ping(); this.pong = setTimeout(() => ws.terminate(), 10_000); }, 30_000);
    });
    ws.on("pong", () => { if (this.pong) clearTimeout(this.pong); this.pong = null; });
    ws.on("message", (data, binary) => {
      if (!this.current(generation) || this.ws !== ws) return;
      let value: unknown;
      try { value = JSON.parse(data.toString()); } catch { this.terminal(failed("personal_protocol", "远程观察帧无法解析，请核实版本后重新连接。")); return; }
      if (binary || !object(value) || value.v !== 1 || typeof value.runId !== "string" || typeof value.subscription !== "string" || !Number.isSafeInteger(value.seq) || Number(value.seq) < 0 || value.type !== "snapshot" && value.type !== "events" || value.type === "snapshot" && !desktopSnapshot(value) || value.type === "events" && (!Array.isArray(value.events) || !value.events.every(desktopEvent))) { this.terminal(failed("personal_protocol", "远程观察协议无效，请核实版本后重新连接。")); return; }
      if (value.runId !== identity.runId || subscription !== null && (value.subscription !== subscription || value.seq !== seq + 1) || subscription === null && value.type !== "snapshot") { this.disconnected(generation); return; }
      subscription = value.subscription; seq = Number(value.seq);
      this.publish({ type: "personal_frame", frame: value as PersonalDesktopFrame });
    });
    ws.on("close", () => { if (this.ws === ws) this.disconnected(generation); });
  }
  async request(method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> {
    if (!this.credentials.active || !this.identity || this.status.state !== "online") throw failed("connection_unavailable", "个人连接尚未核实，请先连接原入口。");
    const generation = this.generation, identity = this.identity;
    const result = await this.exchange(method, route, body, this.credentials.active);
    if (!this.current(generation) || this.identity !== identity) throw failed("personal_identity_changed", "连接或后台代次已变化，请核实原请求；未采用迟到结果。", method === "POST" ? "unknown" : "not_sent");
    return result;
  }
  async business(method: unknown, route: unknown, body?: unknown): Promise<unknown> {
    if ((method !== "GET" && method !== "POST") || typeof route !== "string") throw failed("op_not_allowed", "此个人操作尚未开放。");
    const url = new URL(route, this.config.origin);
    if (!route.startsWith("/") || route.startsWith("//") || url.origin !== this.config.origin || !(method === "GET" ? READ_PATHS : WRITE_PATHS).includes(url.pathname)) throw failed("op_not_allowed", "此个人操作尚未开放。");
    return this.request(method, route, body);
  }
  private credentialExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.switching || this.credentialOperation) return Promise.reject(failed("personal_pairing_busy", "个人连接已关闭、正在切换或配对，请等待后核实原结果。"));
    const result = operation(); this.credentialOperation = result;
    return result.finally(() => { this.credentialOperation = null; });
  }
  private async completeCandidate(candidate: Candidate): Promise<PersonalRemoteIdentity> {
    const identity = this.checkIdentity(await this.exchange("GET", "/handshake", undefined, candidate, false), candidate);
    const active: Active = { id: candidate.id, secret: candidate.secret, origin: candidate.origin, remoteId: identity.remoteId, profile: identity.profile };
    const unverified = (error: unknown) => failed(error instanceof ControlClientError ? error.code : "personal_pairing_pending", error instanceof ControlClientError ? error.message : "原配对已登记，本机绑定尚未核实；请检查应用数据目录后核实原候选凭据。", "unknown");
    try { this.persistBinding(identity); } catch (error) { throw unverified(error); }
    try { await this.saveCredentials({ v: 1, active }); } catch (error) { throw unverified(error); }
    this.adopt(identity);
    return identity;
  }
  private async redeemCandidate(candidate: Candidate): Promise<PersonalRemoteIdentity> {
    candidate = { ...candidate }; delete candidate.rejected;
    await this.saveCredentials({ ...this.credentials, candidate });
    try { await this.exchange("POST", "/pair", candidate.request, candidate, false); }
    catch (error) {
      if (error instanceof ControlClientError && ["remote_pairing_rejected", "remote_pairing_closed"].includes(error.code)) {
        await this.saveCredentials({ ...this.credentials, candidate: { ...candidate, rejected: true } });
        throw failed(error.code, error.message, "rejected");
      }
      throw error;
    }
    const identity = await this.completeCandidate(candidate);
    await this.reconnect();
    return identity;
  }
  pair(code: string, label: string): Promise<PersonalRemoteIdentity> {
    return this.credentialExclusive(async () => {
      if (!/^[A-Z2-7]{12}$/.test(code) || !label.trim() || label.trim() !== label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw failed("personal_pairing_invalid", "请输入服务器显示的配对码与桌面名称。");
      this.credentials = await this.readCredentials();
      let candidate = this.credentials.candidate;
      if (candidate && candidate.origin !== this.config.origin) throw failed("personal_pairing_pending", "仍有其他地址的原候选凭据待核实，请先查询原配对；未生成其他凭据。");
      if (candidate) {
        try { const identity = await this.completeCandidate(candidate); await this.reconnect(); return identity; }
        catch (error) {
          if (!(error instanceof ControlClientError) || !["remote_credential_invalid", "remote_credential_revoked"].includes(error.code)) throw error;
          if (error.code === "remote_credential_revoked") candidate = undefined;
        }
        if (candidate && !candidate.rejected && (candidate.request.code !== code || candidate.request.label !== label)) throw failed("personal_pairing_pending", "原兑换结果未知，不能更改配对参数；请先核实或显式恢复原请求。");
      }
      if (!candidate) {
        candidate = { id: randomUUID(), secret: randomBytes(32).toString("base64url"), origin: this.config.origin, request: { v: 1, code, label } };
      }
      return this.redeemCandidate({ ...candidate, request: { v: 1, code, label } });
    });
  }
  reconcilePairing(): Promise<PersonalRemoteIdentity> {
    return this.credentialExclusive(async () => {
      this.credentials = await this.readCredentials();
      const candidate = this.credentials.candidate;
      if (!candidate) throw failed("personal_pairing_missing", "没有待核实的原候选凭据，请从服务器开启配对。");
      const identity = await this.completeCandidate(candidate); await this.reconnect(); return identity;
    });
  }
  restorePairing(): Promise<PersonalRemoteIdentity> {
    return this.credentialExclusive(async () => {
      this.credentials = await this.readCredentials();
      const candidate = this.credentials.candidate;
      if (!candidate) throw failed("personal_pairing_missing", "没有待恢复的原候选凭据，请先核实原配对。");
      try { const identity = await this.completeCandidate(candidate); await this.reconnect(); return identity; }
      catch (error) { if (!(error instanceof ControlClientError) || error.code !== "remote_credential_invalid") throw error; }
      return this.redeemCandidate(candidate);
    });
  }
  private pending(): Pending {
    const value = readPersonalRecord(personalPendingFile(this.userData, this.config));
    if (value === null) return { v: 1, input: null };
    if (!object(value) || value.v !== 1 || value.input !== null && (!object(value.input) || value.input.v !== 1 || value.input.origin !== this.config.origin || value.input.remoteId !== this.config.binding?.remoteId || !isDeepStrictEqual(value.input.profile, this.config.binding?.profile) || typeof value.input.requestId !== "string" || !UUID.test(value.input.requestId) || typeof value.input.input !== "string" || Buffer.byteLength(value.input.input) > 16 * 1024) || value.maintenance !== undefined && (!object(value.maintenance) || typeof value.maintenance.id !== "string" || !UUID.test(value.maintenance.id) || typeof value.maintenance.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.maintenance.requestDigest))) throw new DesktopError("personal_pending_invalid", "原个人请求记录无法核实，发送已停止；请保留文件并检查原档案。");
    if (value.settings !== undefined && (!Array.isArray(value.settings) || value.settings.some(item => !object(item) || Object.keys(item).sort().join(",") !== "id,requestDigest,scope,target" || typeof item.id !== "string" || !UUID.test(item.id) || typeof item.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(item.requestDigest) || !["model", "skills", "mcp", "web-search", "telegram", "qq", "commands", "services"].includes(String(item.target)) || typeof item.scope !== "string" || !item.scope || item.scope.length > 128) || new Set(value.settings.map(item => item.id)).size !== value.settings.length)) throw new DesktopError("personal_pending_invalid", "原配置请求关联无法核实，请保留记录并查询原档案。");
    return value as Pending;
  }
  private record(value: Pending, result?: PersonalInputReceipt): void { writePersonalRecord(personalPendingFile(this.userData, this.config), value); this.publish({ type: "personal_pending", record: value.input, ...(result ? { result } : {}) }); }
  /** 成功后保留切换占用，调用方写入地址并关闭原连接后释放；检查失败自行释放。 */
  async assertSwitchable(): Promise<() => void> {
    if (this.closed || this.switching || this.credentialOperation) throw failed("personal_pending", "原连接已关闭、正在配对或切换，请等待后核实；未更改地址。");
    this.switching = true;
    try {
      const credentials = await this.readCredentials(), pending = this.config.binding ? this.pending() : null;
      if (pending?.input || pending?.maintenance || pending?.settings?.length || credentials.candidate) throw failed("personal_pending", "原连接仍有待核实请求，请先核实原输入、维护与配对；未切换地址。");
      return () => { this.switching = false; };
    } catch (error) { this.switching = false; throw error; }
  }
  maintenance(): Pending["maintenance"] { return this.pending().maintenance; }
  recordMaintenance(value: Pending["maintenance"]): void { if (this.closed || this.switching && value) throw failed("personal_pending", "个人连接已关闭或正在切换，未接纳新维护。"); const pending = this.pending(); if (value) pending.maintenance = value; else delete pending.maintenance; this.record(pending); }
  settingsOperations(): NonNullable<Pending["settings"]> { return this.pending().settings ?? []; }
  recordSettingsOperation(id: string, value?: NonNullable<Pending["settings"]>[number]): void {
    if (this.closed || this.switching && value) throw failed("personal_pending", "个人连接已关闭或正在切换，未接纳配置更改。");
    const pending = this.pending(), settings = (pending.settings ?? []).filter(item => item.id !== id);
    if (value) settings.push(value);
    if (settings.length) pending.settings = settings; else delete pending.settings;
    this.record(pending);
  }
  private inputReceipt(requestId: string, value: unknown): PersonalInputReceipt {
    if (!object(value) || !["queued", "placed", "done", "unanswered", "missing"].includes(String(value.status)) || value.answer !== undefined && typeof value.answer !== "string" || value.truncated !== undefined && typeof value.truncated !== "boolean") throw failed("personal_protocol", "原输入应答无法核实，请查询原请求；不会换键重发。", "unknown");
    return { kind: value.status === "missing" ? "missing" : "accepted", requestId, ...(value.status === "missing" ? {} : { status: value.status as "queued" | "placed" | "done" | "unanswered" }), ...(typeof value.answer === "string" ? { answer: value.answer } : {}), ...(typeof value.truncated === "boolean" ? { truncated: value.truncated } : {}) };
  }
  private async sendInput(record: PersonalPendingInput): Promise<PersonalInputReceipt> {
    try {
      const result = this.inputReceipt(record.requestId, await this.request("POST", "/inputs", { requestId: record.requestId, input: record.input }));
      const current = this.pending();
      if (result.kind === "accepted" && current.input?.requestId === record.requestId) this.record({ ...current, input: null }, result);
      return result;
    } catch (error) {
      if (error instanceof ControlClientError && (error.outcome === "unknown" || error.outcome === "disconnected")) return { kind: "pending", requestId: record.requestId };
      throw error;
    }
  }
  async submitInput(input: string): Promise<PersonalInputReceipt> {
    if (this.closed || this.switching) throw failed("personal_pending", "个人连接已关闭或正在切换，未发送新输入。");
    if (this.inputOperation) throw failed("personal_input_busy", "原输入仍在发送，请等待后核实原请求。");
    if (!input.trim() || Buffer.byteLength(input) > 16 * 1024 || !this.identity || !this.config.binding) throw failed("personal_input_invalid", "请连接个人 Agent 后输入非空文本，每条最多16 KiB。");
    const pending = this.pending();
    if (pending.input) return { kind: "pending", requestId: pending.input.requestId };
    const record: PersonalPendingInput = { v: 1, origin: this.config.origin, remoteId: this.identity.remoteId, profile: this.identity.profile, requestId: randomUUID(), input };
    this.record({ ...pending, input: record }); this.inputOperation = true;
    try { return await this.sendInput(record); } finally { this.inputOperation = false; }
  }
  async reconcileInput(): Promise<PersonalInputReceipt | null> {
    const pending = this.pending(); this.publish({ type: "personal_pending", record: pending.input });
    if (!pending.input || this.inputOperation) return null;
    const record = pending.input, result = this.inputReceipt(record.requestId, await this.request("GET", `/input?requestId=${encodeURIComponent(record.requestId)}`));
    const current = this.pending();
    if (current.input?.requestId !== record.requestId) return null;
    if (result.kind === "accepted") this.record({ ...current, input: null }, result);
    else this.publish({ type: "personal_pending", record, result });
    return result;
  }
  async restoreInput(): Promise<PersonalInputReceipt> {
    if (this.closed || this.switching) throw failed("personal_pending", "个人连接已关闭或正在切换，请等待后核实原输入。");
    if (this.inputOperation) throw failed("personal_input_busy", "原输入仍在核实，请等待后继续。");
    const previous = await this.reconcileInput();
    if (!previous || previous.kind !== "missing") throw failed("personal_input_not_restorable", "原输入已接纳或仍待核实，请查看原请求。");
    if (this.inputOperation) throw failed("personal_input_busy", "原输入仍在处理，请等待后核实。");
    const record = this.pending().input;
    if (!record || record.requestId !== previous.requestId) throw failed("personal_input_not_restorable", "原输入记录已变化，请重新读取。");
    this.inputOperation = true;
    try { return await this.sendInput(record); } finally { this.inputOperation = false; }
  }
  instanceId(): string | null { return this.identity?.remoteId ?? null; }
  async close(): Promise<void> {
    this.closed = true; ++this.generation; this.stopObservation();
    for (const request of this.requests) request.destroy();
    await Promise.allSettled([this.connecting, this.credentialOperation]);
    this.state({ type: "state", state: "closed", detail: "已断开个人连接，后台工作继续。" });
  }
}
