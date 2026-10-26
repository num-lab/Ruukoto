/** Pi MCP 的受管传输、逐请求凭据与原应答观察；不持有产品任务或配置。
 * Note: 见 .agents/notes/implemented/simplification/2026-10-26-mcp-host-responsibilities.md
 */
import {
  McpClient, StreamableHttpTransport, StdioTransport, McpAbortError, McpTimeoutError,
  McpConnectionClosedError, McpAuthRequiredError, McpHttpError, McpSessionExpiredError, McpError as PiMcpError,
  isJsonRpcRequest, isJsonRpcResponse, parseJsonRpcMessage,
  type McpTransport, type McpTransportSendOptions, type JsonRpcId, type JsonRpcRequest,
  type JsonRpcMessage, type JsonRpcResponse, type CallToolResult, type Tool as McpRemoteTool,
} from "@earendil-works/pi-mcp";
import { observeMcpResponse } from "./response-observer.ts";
export type { CallToolResult, McpRemoteTool };

export const MCP_LIMITS = {
  connectTimeoutMs: 15_000, listTimeoutMs: 15_000, callTimeoutMs: 60_000,
  stdioMessageBytes: 48 * 1024 * 1024,
  resultInlineCapChars: 32 * 1024, resultHardCapBytes: 1024 * 1024,
} as const;

export class McpError extends Error {
  constructor(readonly code: string, message: string, readonly requestSent?: boolean, readonly remoteRejected?: boolean) { super(message); }
}

export function parseMcpEndpoint(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new McpError("invalid_endpoint", "MCP 端点无法解析；请检查服务地址。"); }
  if (url.username || url.password) throw new McpError("invalid_endpoint", "MCP 端点不得携带认证信息；请使用独立凭据绑定。");
  const loopback = ["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new McpError("invalid_endpoint", "MCP 端点必须为 HTTPS；HTTP 仅用于回环测试服务。");
  return url;
}

export interface McpTimeouts { connectTimeoutMs?: number; listTimeoutMs?: number; callTimeoutMs?: number }
export interface McpEndpoint { serviceId: string; endpoint: string }
export interface McpStdioProgram { command: string; args: string[]; env: Record<string, string>; cwd?: string }
/** 新操作只使用 request/response；其余字段仅供旧历史只读校验。 */
export interface McpCallEvidence { request?: string; response?: string; sessionId?: string; protocolVersion?: string; resumptionToken?: string }
export interface McpCallHooks {
  recordCallRequest?: (request: string) => Promise<void>;
  beforeDispatch?: () => void;
  recordCallProgress?: (evidence: Readonly<McpCallEvidence>) => Promise<void>;
}
export interface McpEndpointConnectOptions extends McpTimeouts, McpCallHooks { resolveToken?: () => Promise<string> }
export interface McpConnection {
  readonly serviceId: string; readonly endpoint: string;
  readonly serverInfo: { name?: string; version?: string } | null; readonly protocolVersion: string | null;
  readonly pid?: number | null; readonly closed?: boolean; readonly callEvidence?: McpCallEvidence;
  listTools(signal?: AbortSignal): Promise<McpRemoteTool[]>;
  callTool(tool: { name: string; inputSchema: Record<string, unknown> }, args: Record<string, unknown>, signal?: AbortSignal, hooks?: McpCallHooks): Promise<CallToolResult>;
  close(): Promise<void>;
}
export interface McpCallBinding { evidence: McpCallEvidence; hooks: McpCallHooks; active(): boolean }
export interface ManagedMcpTransport extends McpTransport { readonly pid?: number | null; readonly closed: boolean }
type BindCall = (request: JsonRpcRequest, signal?: AbortSignal) => McpCallBinding;
interface PendingCall { binding: McpCallBinding; signal?: AbortSignal; request: JsonRpcRequest; saving?: Promise<void> }

export function mcpResponseEnded(raw: string): boolean {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return false; }
  let message: JsonRpcMessage;
  try { message = parseJsonRpcMessage(value); } catch { return false; }
  if (!isJsonRpcResponse(message)) return false;
  if ("error" in message) return true;
  const result = message.result;
  return !!result && typeof result === "object" && !Array.isArray(result) && !("task" in result) &&
    (!("resultType" in result) || result.resultType === "complete") &&
    (("content" in result && Array.isArray(result.content)) || "structuredContent" in result);
}

async function token(resolve: (() => Promise<string>) | undefined): Promise<string | undefined> {
  if (!resolve) return undefined;
  let value: string;
  try { value = await resolve(); } catch (error) {
    if (error instanceof McpError) throw new McpError(error.code, error.message, false);
    throw new McpError("auth_failed", "MCP 凭据无法核实；该请求未发送，请检查原凭据绑定。", false);
  }
  if (!value) throw new McpError("auth_failed", "MCP 凭据为空；该请求未发送，请检查原凭据绑定。", false);
  return value;
}

function callActive(call: PendingCall | undefined): call is PendingCall { return !!call && !call.signal?.aborted && call.binding.active(); }
async function beforeSend(call: PendingCall): Promise<void> {
  if (!callActive(call)) throw new McpError("canceled", "MCP 原调用已结束；该请求未发送，不能重发原操作。", false);
  const request = JSON.stringify(call.request);
  try { await call.binding.hooks.recordCallRequest?.(request); }
  catch (error) { throw error instanceof McpError ? new McpError(error.code, error.message, false) : new McpError("evidence_failed", "MCP 原请求无法保存；该请求未发送。", false); }
  if (!callActive(call)) throw new McpError("canceled", "MCP 原调用在记录期间已取消；该请求未发送。", false);
}
async function receive(call: PendingCall, message: JsonRpcResponse): Promise<void> {
  // 重复 ID 共用保存顺序；未提交或保存失败的答复不能提前交给 Pi。
  call.saving = (call.saving ?? Promise.resolve()).then(async () => {
    if (!callActive(call) || call.binding.evidence.response && mcpResponseEnded(call.binding.evidence.response)) return;
    const response = JSON.stringify(message);
    try { await call.binding.hooks.recordCallProgress?.({ ...call.binding.evidence, response }); }
    catch (error) { throw error instanceof McpError ? error : new McpError("evidence_failed", "MCP 原应答无法保存；保留原操作，不能重发。", true); }
    if (callActive(call)) call.binding.evidence.response = response;
  });
  await call.saving;
}

/** 每个 transport 的 ID 映射独立；发送信号结束后丢弃迟到答复。 */
function manage(transport: McpTransport, bind: BindCall, pending: Map<JsonRpcId, PendingCall>, http: boolean, pid?: () => number | null | undefined): ManagedMcpTransport {
  let closed = false;
  const closers = new Set<() => void>();
  const closeWaiting = () => { if (closed) return; closed = true; pending.clear(); for (const listener of closers) listener(); };
  const messages = new Set<(message: JsonRpcMessage) => void>();
  const errors = new Set<(error: Error) => void>();
  transport.onError(error => { for (const listener of errors) listener(error); closeWaiting(); });
  transport.onClose(closeWaiting);
  transport.onMessage(message => {
    const call = "id" in message ? pending.get(message.id) : undefined;
    const deliver = () => { for (const listener of messages) listener(message); };
    if (!http && isJsonRpcResponse(message) && callActive(call)) {
      void receive(call, message).then(deliver, error => {
        const failure = error instanceof McpError ? error : new McpError("evidence_failed", "MCP 原应答无法保存；保留结果未知，不能重发原操作。");
        for (const listener of errors) listener(failure);
        closeWaiting();
      });
    } else deliver();
  });
  return {
    get pid() { return pid?.(); }, get closed() { return closed; },
    start: () => transport.start(),
    async close() { closeWaiting(); await transport.close(); },
    onMessage(listener) { messages.add(listener); return () => { messages.delete(listener); }; },
    onError(listener) { errors.add(listener); return () => { errors.delete(listener); }; },
    onClose(listener) { closers.add(listener); return () => { closers.delete(listener); }; }, setProtocolVersion: version => transport.setProtocolVersion?.(version),
    async send(originalMessage, options) {
      const message = parseJsonRpcMessage(JSON.parse(JSON.stringify(originalMessage)));
      if (closed) throw new McpError("canceled", "MCP 连接已停止；该请求未发送。", false);
      if (isJsonRpcRequest(message) && ["resources/read", "resources/list", "resources/templates/list"].includes(message.method)) throw new McpError("resource_denied", "当前 MCP 入口不开放资源读取或枚举。");
      if (isJsonRpcRequest(message) && message.method === "tools/call") {
        const call = { binding: bind(message, options?.signal), signal: options?.signal, request: message };
        pending.set(message.id, call);
        options?.signal?.addEventListener("abort", () => { if (pending.get(message.id) === call) pending.delete(message.id); }, { once: true });
        if (!http) {
          await beforeSend(call);
          try { call.binding.hooks.beforeDispatch?.(); } catch (error) { throw error instanceof McpError ? new McpError(error.code, error.message, false) : new McpError("authorization_invalid", "MCP 原授权已失效；该请求未发送。", false); }
          if (!callActive(call)) throw new McpError("canceled", "MCP 原调用已停止；该请求未发送。", false);
          call.binding.evidence.request = JSON.stringify(message);
        }
      }
      await transport.send(message, options);
    },
  };
}

export function createMcpHttpTransport(endpoint: string, resolveToken: (() => Promise<string>) | undefined, bind: BindCall): ManagedMcpTransport {
  const target = parseMcpEndpoint(endpoint);
  const pending = new Map<JsonRpcId, PendingCall>();
  const transport = new StreamableHttpTransport({ url: target, openGetStream: false, fetch: async (input, init) => {
    const url = new URL(input);
    if (url.origin !== target.origin || url.pathname !== target.pathname || url.search !== target.search) throw new McpError("invalid_endpoint", "MCP 请求目标不符；该请求未发送。", false);
    const headers = new Headers(init?.headers);
    const secret = await token(resolveToken);
    if (secret) headers.set("authorization", `Bearer ${secret}`);
    let request: JsonRpcRequest | undefined;
    if (typeof init?.body === "string") {
      const message = parseJsonRpcMessage(JSON.parse(init.body));
      if (isJsonRpcRequest(message)) request = message;
    }
    const original = request?.method === "tools/call" ? pending.get(request.id) : undefined;
    if (request?.method === "tools/call") {
      if (!original) throw new McpError("call_unbound", "MCP 调用尚未绑定原操作；该请求未发送。", false);
      original.request = request;
      await beforeSend(original);
      const currentSecret = await token(resolveToken);
      if (currentSecret) headers.set("authorization", `Bearer ${currentSecret}`); else headers.delete("authorization");
      try { original.binding.hooks.beforeDispatch?.(); } catch (error) { throw error instanceof McpError ? new McpError(error.code, error.message, false) : new McpError("authorization_invalid", "MCP 原授权已失效；该请求未发送。", false); }
    }
    if (init?.signal?.aborted || original && !callActive(original)) throw new McpError("canceled", "MCP 请求已取消；该请求未发送。", false);
    if (original) original.binding.evidence.request = JSON.stringify(request);
    const response = await fetch(url, { ...init, headers, redirect: "error" });
    return observeMcpResponse(response, async message => {
      const call = pending.get(message.id);
      if (callActive(call)) await receive(call, message);
    }, () => original ? pending.get(original.request.id) === original && callActive(original) : [...pending.values()].some(callActive), MCP_LIMITS.stdioMessageBytes);
  } });
  return manage(transport, bind, pending, true);
}

export function createMcpStdioTransport(program: McpStdioProgram, bind: BindCall): ManagedMcpTransport {
  const transport = new StdioTransport({ ...program, inheritEnv: false, onStderr: () => undefined, maxStderrBytes: 0, maxMessageBytes: MCP_LIMITS.stdioMessageBytes });
  return manage(transport, bind, new Map(), false, () => transport.pid);
}

export function classifyMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  if (error instanceof McpAbortError) return new McpError("canceled", "MCP 调用已取消；请查询原操作，不能重发未知效果的动作。");
  if (error instanceof McpTimeoutError) return new McpError("timeout", "MCP 调用超时；请查询原操作，不能重发未知效果的动作。");
  if (error instanceof McpSessionExpiredError) return new McpError("session_expired", "MCP 会话已被远端拒绝；原业务请求未被接纳。", undefined, true);
  if (error instanceof PiMcpError) return new McpError("protocol_error", `MCP 服务返回错误（${error.code}）：${error.message.slice(0, 2000)}`);
  if (error instanceof McpAuthRequiredError) return new McpError("auth_failed", "MCP 认证被拒绝；请核实原凭据绑定。");
  if (error instanceof McpHttpError || error instanceof McpConnectionClosedError) return new McpError("connect_failed", "MCP 连接或应答中断；请查询原操作，不能重发未知效果的动作。");
  return new McpError("connect_failed", "MCP 连接无法完成；请检查服务状态与原调用记录。");
}

class PiMcpConnection implements McpConnection {
  readonly callEvidence: McpCallEvidence = {};
  private current: McpCallBinding | undefined;
  private readonly client: McpClient;
  private transport!: ManagedMcpTransport;
  constructor(readonly serviceId: string, readonly endpoint: string, private readonly opts: McpEndpointConnectOptions) {
    this.client = new McpClient({ name: "ruukoto", version: "0.1.0", requestTimeoutMs: opts.connectTimeoutMs ?? MCP_LIMITS.connectTimeoutMs, capabilities: {} });
  }
  get serverInfo() { return this.client.serverInfo ?? null; }
  get protocolVersion() { return this.client.protocolVersion ?? null; }
  get pid() { return this.transport.pid; }
  get closed() { return this.transport.closed; }
  async open(program?: McpStdioProgram): Promise<void> {
    const bind: BindCall = () => {
      if (!this.current) throw new McpError("call_unbound", "MCP 调用尚未绑定原操作；该请求未发送。");
      return this.current;
    };
    this.transport = program ? createMcpStdioTransport(program, bind) : createMcpHttpTransport(this.endpoint, this.opts.resolveToken, bind);
    try { await this.client.connect(this.transport); } catch (error) { await this.client.close(); throw classifyMcpError(error); }
  }
  async listTools(signal?: AbortSignal): Promise<McpRemoteTool[]> {
    try { return await this.client.listTools({ signal, timeoutMs: this.opts.listTimeoutMs ?? MCP_LIMITS.listTimeoutMs }); } catch (error) { throw classifyMcpError(error); }
  }
  async callTool(tool: { name: string; inputSchema: Record<string, unknown> }, args: Record<string, unknown>, signal?: AbortSignal, hooks?: McpCallHooks): Promise<CallToolResult> {
    if (this.current) throw new McpError("call_active", "MCP 连接正由原调用使用；请等待其结束。");
    for (const key of Object.keys(this.callEvidence) as Array<keyof McpCallEvidence>) delete this.callEvidence[key];
    let active = true;
    this.current = { evidence: this.callEvidence, hooks: hooks ?? this.opts, active: () => active && !signal?.aborted };
    try { return await this.client.callTool(tool.name, args, { signal, timeoutMs: this.opts.callTimeoutMs ?? MCP_LIMITS.callTimeoutMs }); }
    catch (error) {
      const failure = classifyMcpError(error);
      throw failure.requestSent === undefined ? new McpError(failure.code, failure.message, !!this.callEvidence.request, failure.remoteRejected) : failure;
    }
    finally { active = false; this.current = undefined; }
  }
  async close(): Promise<void> { await this.client.close(); }
}

export async function connectMcpEndpoint(target: McpEndpoint, opts: McpEndpointConnectOptions = {}): Promise<McpConnection> {
  const connection = new PiMcpConnection(target.serviceId, target.endpoint, opts);
  await connection.open();
  return connection;
}
export async function connectMcpStdio(program: McpStdioProgram & { serviceId: string }, opts: McpTimeouts & McpCallHooks = {}): Promise<McpConnection> {
  const connection = new PiMcpConnection(program.serviceId, "", opts);
  await connection.open(program);
  return connection;
}
