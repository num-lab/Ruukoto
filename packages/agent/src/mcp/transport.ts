/**
 * MCP Streamable HTTP 传输，不持有项目、凭据存储或任务状态。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-17-mcp-transport-reuse.md
 *
 * - 首版仅 Streamable HTTP 传输；stdio、OAuth 登录、resources/prompts、
 *   sampling/elicitation 等客户端代执行能力不启用（不声明对应 capability）；
 * - 端点校验：生产固定 https，http 仅限回环（模拟服务）；拒绝 userinfo；
 *   自定义 fetch 钉住源（拒绝跨源重定向，不向非配置目标转发认证）；
 * - 凭据由宿主逐请求核实并提供，传输只向固定端点注入 Bearer；
 * - 有界：初始化/发现/调用各自超时，工具数量、分页页数、描述与 schema 大小
 *   均有上限；连接失效可由下一任务重新初始化，不自动重放已发出的调用。
 */

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  isCallToolResult,
  type CallToolResult,
  type Tool as McpRemoteTool,
} from "@modelcontextprotocol/client";

export const MCP_LIMITS = {
  maxToolsPerService: 64,
  maxListPages: 16,
  maxToolDescriptionChars: 4000,
  maxToolSchemaBytes: 16 * 1024,
  connectTimeoutMs: 15_000,
  listTimeoutMs: 15_000,
  callTimeoutMs: 60_000,
  /** 结果内联上限：超过则正文入 ArtifactStore，模型只收预览与引用。 */
  resultInlineCapChars: 32 * 1024,
  /** 产物正文硬上限：超过截断并明确标记。 */
  resultHardCapBytes: 1024 * 1024,
} as const;

export class McpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 解析并校验服务端点：https，或 http+回环（模拟服务）；拒绝 userinfo 与非法 URL。 */
export function parseMcpEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new McpError("invalid_endpoint", `MCP 端点无法解析：${endpoint}`);
  }
  if (url.username || url.password) {
    throw new McpError("invalid_endpoint", "MCP 端点不得携带 userinfo（凭据由宿主提供）");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new McpError("invalid_endpoint", `MCP 端点必须是 https（http 仅限回环模拟服务）：${url.protocol}//${url.host}`);
  }
  return url;
}

/** 各环节超时（毫秒）；缺省取 MCP_LIMITS。 */
export interface McpTimeouts {
  connectTimeoutMs?: number;
  listTimeoutMs?: number;
  callTimeoutMs?: number;
}

/** 钉住源的 fetch：只连配置端点（同源同路径）；拒绝一切重定向（不向非配置目标转发认证）。 */
function pinnedFetch(endpoint: URL, beforeCall?: (request: string) => Promise<void>, resolveToken?: () => Promise<string>, onlyGet = false): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname) {
      throw new McpError("invalid_endpoint", `拒绝向非配置目标发起请求：${url.origin}${url.pathname}（配置 ${endpoint.origin}${endpoint.pathname}）`);
    }
    if (onlyGet && (init?.method ?? "GET") !== "GET") throw new McpError("resume_invalid", "原 MCP 请求核实只允许读取原事件流，未重新调用工具。");
    if (beforeCall && typeof init?.body === "string") {
      const body: unknown = JSON.parse(init.body);
      if (body && typeof body === "object" && "method" in body && body.method === "tools/call") {
        await beforeCall(init.body);
        if (init.signal?.aborted) throw new McpError("canceled", "MCP 请求在记录期间已取消，未发送该请求；请查询原操作。");
        if (resolveToken) {
          const headers = new Headers(init.headers);
          headers.set("authorization", `Bearer ${await resolveToken()}`);
          init = { ...init, headers };
        }
        if (init.signal?.aborted) throw new McpError("canceled", "MCP 请求在凭据核实期间已取消，未发送该请求；请查询原操作。");
      }
    }
    try {
      return await fetch(url, { ...init, redirect: "error" });
    } catch (err) {
      if (err instanceof McpError) throw err;
      if ((err as Error).name === "AbortError") throw err;
      throw new McpError("connect_failed", `连接 MCP 服务失败：${(err as Error).message}`);
    }
  };
}

export interface McpConnection {
  readonly serviceId: string;
  readonly endpoint: string;
  /** 初始化握手返回的服务信息（可能为空）。 */
  readonly serverInfo: { name?: string; version?: string } | null;
  readonly protocolVersion: string | null;
  /** 本连接最近一次调用的完整 JSON-RPC 请求与应答；本地关闭不生成应答。 */
  readonly callEvidence?: McpCallEvidence;
  /** 分页发现工具（有界：页数与总数上限；游标来自远端，按外部数据处理）。 */
  listTools(signal?: AbortSignal): Promise<McpRemoteTool[]>;
  /** 调用远端工具（任务钉版的定义）；传输错误抛 McpError，工具执行错误（isError）由调用方区分。 */
  callTool(tool: { name: string; inputSchema: Record<string, unknown> }, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface McpEndpoint {
  serviceId: string;
  endpoint: string;
}

export interface McpEndpointConnectOptions extends McpTimeouts {
  /** tools/call 真正发送前持久化原请求并核实授权；拒绝时不发该请求。不得在回调内重发。 */
  recordCallRequest?: (request: string) => Promise<void>;
  /** 同一事件的恢复游标与原应答一起保存；回调串行执行，调用返回前等待。失败停止本地等待，不证明远端结束。 */
  recordCallProgress?: (evidence: Readonly<McpCallEvidence>) => Promise<void>;
  /** 省略表示匿名；宿主每请求核实原凭据的目标、用途与来源范围，返回非空 token。
   * 普通异常和空 token 在发送前转为 auth_failed；自定义 McpError 必须不含秘密值。
   */
  resolveToken?: () => Promise<string>;
}

export interface McpCallEvidence {
  request?: string;
  response?: string;
  sessionId?: string;
  protocolVersion?: string;
  resumptionToken?: string;
}

function rpcObject(raw: string): Record<string, unknown> | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 完整工具应答或 JSON-RPC 错误才证明原请求结束；交互中间结果、异步任务和无效响应均不证明。 */
export function mcpResponseEnded(raw: string): boolean {
  const response = rpcObject(raw);
  if (!response || response.jsonrpc !== "2.0" || !["number", "string"].includes(typeof response.id)) return false;
  if ("error" in response) {
    const error = response.error;
    return !("result" in response) && !!error && typeof error === "object" && !Array.isArray(error) && "code" in error && typeof error.code === "number" && "message" in error && typeof error.message === "string";
  }
  const result = response.result;
  return !!result && typeof result === "object" && !Array.isArray(result) && (!("resultType" in result) || result.resultType === "complete") && !("task" in result) && isCallToolResult(result);
}

function tokenResolver(resolveToken: (() => Promise<string>) | undefined) {
  return resolveToken && (async () => {
    let token: string;
    try { token = await resolveToken(); } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError("auth_failed", "MCP 凭据无法核实，未发送该请求；停止本次调用并报告拥有者检查凭据配置。");
    }
    if (!token) throw new McpError("auth_failed", "MCP 凭据为空，未发送该请求；停止本次调用并报告拥有者检查凭据配置。");
    return token;
  });
}

function callProgress(evidence: McpCallEvidence, record: McpEndpointConnectOptions["recordCallProgress"], close: () => Promise<void>) {
  let pending = Promise.resolve(), failure: McpError | undefined;
  return {
    save() {
      // SDK 先报告 event id 再同步交付应答；排队后才取快照，避免只提交终结游标而丢掉同一事件的应答。
      pending = pending.then(async () => {
        if (failure || !record) return;
        try { await record({ ...evidence }); } catch {
          failure = new McpError("evidence_failed", "MCP 原请求进展无法保存，已停止本地等待；保留原操作并报告拥有者检查存储，不能重发。");
          await close();
        }
      });
    },
    async drain() { await pending; },
    async flush() { await pending; if (failure) throw failure; },
  };
}

class SdkMcpConnection implements McpConnection {
  constructor(
    readonly serviceId: string,
    readonly endpoint: string,
    readonly serverInfo: { name?: string; version?: string } | null,
    readonly protocolVersion: string | null,
    private readonly client: Client,
    private readonly listTimeoutMs: number,
    private readonly callTimeoutMs: number,
    readonly callEvidence: McpCallEvidence,
    private readonly progress: ReturnType<typeof callProgress>,
  ) {}

  async listTools(signal?: AbortSignal): Promise<McpRemoteTool[]> {
    let res: { tools: McpRemoteTool[] };
    try {
      res = await this.client.listTools(undefined, { timeout: this.listTimeoutMs, signal });
    } catch (err) {
      if (err instanceof SdkError && err.code === SdkErrorCode.ListPaginationExceeded) {
        throw new McpError("too_many_pages", `MCP 工具分页超过 ${MCP_LIMITS.maxListPages} 页（疑似异常服务，拒绝接入）`);
      }
      throw classifyMcpError(err, this.listTimeoutMs, signal);
    }
    if (res.tools.length > MCP_LIMITS.maxToolsPerService) {
      throw new McpError("too_many_tools", `MCP 服务工具数超过上限 ${MCP_LIMITS.maxToolsPerService}（拒绝接入，请收缩服务范围）`);
    }
    return res.tools;
  }

  async callTool(tool: { name: string; inputSchema: Record<string, unknown> }, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    await this.progress.flush();
    try {
      // 传钉版定义（不带 outputSchema）：SDK 不做本地输出校验（校验失败与远端错误应答
      // 同为 ProtocolError、分不开，而前者远端已执行），也不在 header 不符时刷新清单后
      // 自动重发；结构化结果由路由器按钉版 outputSchema 校验
      const result = await this.client.callTool(
        { name: tool.name, arguments: args },
        {
          signal,
          timeout: this.callTimeoutMs,
          maxTotalTimeout: this.callTimeoutMs,
          toolDefinition: { name: tool.name, inputSchema: tool.inputSchema as McpRemoteTool["inputSchema"] },
          onresumptiontoken: token => { this.callEvidence.resumptionToken = token; this.progress.save(); },
        },
      );
      await this.progress.flush();
      return result;
    } catch (err) {
      await this.progress.flush();
      throw classifyMcpError(err, this.callTimeoutMs, signal);
    }
  }

  async close(): Promise<void> {
    // 关闭只表示本地停止等待；不承诺远端操作已停止，迟到结果由 SDK 丢弃
    await this.client.close().catch(() => {
      // 忽略 SDK 关闭错误：这里只结束本地等待，不据此宣称远端已停止。
    });
    await this.progress.drain();
  }
}

function classifyMcpError(err: unknown, timeoutMs: number, signal?: AbortSignal): McpError {
  if (err instanceof McpError) return err;
  // 先判任务取消：取消语义决定"不重复发送"的恢复叙述
  if (signal?.aborted || (err as Error).name === "AbortError") {
    return new McpError("canceled", "任务已停止，MCP 调用已中止（本地停止等待，不承诺远端操作已停止）");
  }
  // 远端的 JSON-RPC 错误应答：远端已应答，是已知结果
  // Note: 见 .agents/notes/implemented/feature/2026-09-23-mcp-write-tools-approval.md
  if (err instanceof ProtocolError) {
    return new McpError("remote_error", `MCP 服务返回错误（${err.code}）：${err.message}`);
  }
  if (err instanceof UnauthorizedError) {
    return new McpError("auth_failed", "MCP 服务认证失败：凭据无效、已撤销或权限不足，请拥有者检查 credentials 配置");
  }
  if (err instanceof SdkHttpError) {
    const status = (err as any).status ?? (err as any).data?.status;
    if (status === 401 || status === 403) {
      return new McpError("auth_failed", `MCP 服务认证失败（HTTP ${status}）：凭据无效、已撤销或权限不足`);
    }
    if (status === 429) return new McpError("rate_limited", "MCP 服务限流（HTTP 429）；本客户端不自动重试");
    if (typeof status === "number" && status >= 500) return new McpError("service_error", `MCP 服务内部错误（HTTP ${status}）`);
    return new McpError("unexpected_status", `MCP 服务返回非预期状态${typeof status === "number" ? ` HTTP ${status}` : ""}`);
  }
  if (err instanceof SdkError && (err as any).code === SdkErrorCode.RequestTimeout) {
    return new McpError("timeout", `MCP 请求超过 ${timeoutMs}ms 超时（未自动重试）`);
  }
  return new McpError("connect_failed", `MCP 连接/调用失败：${(err as Error).message}`);
}

/** 只连接宿主已授权的固定端点，不声明客户端代执行能力，不自动重发工具调用。
 * 初始化、发现和调用各自有界；连接由调用方关闭，关闭或取消不证明远端停止。
 * resolver 只提供 token，不提供 OAuth 刷新或自定义请求配置。
 */
export async function connectMcpEndpoint({ serviceId, endpoint: rawEndpoint }: McpEndpoint, opts: McpEndpointConnectOptions = {}): Promise<McpConnection> {
  const endpoint = parseMcpEndpoint(rawEndpoint);
  const connectTimeoutMs = opts.connectTimeoutMs ?? MCP_LIMITS.connectTimeoutMs;
  const resolveToken = tokenResolver(opts.resolveToken);
  const callEvidence: McpCallEvidence = {};
  let callId: unknown;
  const authProvider = resolveToken ? { token: resolveToken } : undefined;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider,
    fetch: pinnedFetch(endpoint, async request => {
      try { await opts.recordCallRequest?.(request); } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError("evidence_failed", "MCP 原请求无法记录或授权已失效，未发送该请求；请查询原操作并报告拥有者，不能换键重发。");
      }
      const parsed: unknown = JSON.parse(request);
      callId = parsed && typeof parsed === "object" && "id" in parsed ? parsed.id : undefined;
      callEvidence.request = request;
      delete callEvidence.response;
      delete callEvidence.resumptionToken;
      if (transport.sessionId) callEvidence.sessionId = transport.sessionId; else delete callEvidence.sessionId;
      if (transport.protocolVersion) callEvidence.protocolVersion = transport.protocolVersion; else delete callEvidence.protocolVersion;
      progress.save();
      await progress.flush();
    }, resolveToken),
  });
  const progress = callProgress(callEvidence, opts.recordCallProgress, () => transport.close());
  const client = new Client({ name: "ruukoto", version: "0.1.0" }, { capabilities: {}, listMaxPages: MCP_LIMITS.maxListPages });
  try {
    await client.connect(transport, { timeout: connectTimeoutMs });
  } catch (err) {
    await client.close().catch(() => {
      // 忽略初始化失败后的 SDK 关闭错误：保留原连接失败，不推断远端状态。
    });
    throw classifyMcpError(err, connectTimeoutMs);
  }
  const serverInfo = client.getServerVersion() ?? null;
  const receive = transport.onmessage;
  transport.onmessage = message => {
    if (callId !== undefined && "id" in message && message.id === callId && ("result" in message || "error" in message)) {
      callEvidence.response = JSON.stringify(message);
      progress.save();
    }
    receive?.(message);
  };
  let protocolVersion: string | null = null;
  try {
    protocolVersion = client.getNegotiatedProtocolVersion() ?? null;
  } catch {
    protocolVersion = null;
  }
  return new SdkMcpConnection(
    serviceId,
    rawEndpoint,
    serverInfo,
    protocolVersion,
    client,
    opts.listTimeoutMs ?? MCP_LIMITS.listTimeoutMs,
    opts.callTimeoutMs ?? MCP_LIMITS.callTimeoutMs,
    callEvidence,
    progress,
  );
}

/** 仅通过 GET 恢复原 SSE 会话并读取原调用应答，不握手或重发 tools/call；缺恢复身份、失败或取消都不证明远端结束。 */
export async function resumeMcpCall({ endpoint: rawEndpoint }: McpEndpoint, saved: Readonly<McpCallEvidence>, opts: McpEndpointConnectOptions & { signal?: AbortSignal } = {}): Promise<McpCallEvidence> {
  const endpoint = parseMcpEndpoint(rawEndpoint);
  const request = saved.request && rpcObject(saved.request);
  const headerValue = (value: string | undefined) => !!value && !/[\r\n]/.test(value);
  if (!request || request.jsonrpc !== "2.0" || request.method !== "tools/call" || !["string", "number"].includes(typeof request.id) || !headerValue(saved.sessionId) || !headerValue(saved.protocolVersion) || !headerValue(saved.resumptionToken)) throw new McpError("resume_unavailable", "原 MCP 调用缺少会话、协议或恢复游标，不能核实远端结束；保留原操作并独立查询服务，不能重发。");
  if (opts.signal?.aborted) throw new McpError("canceled", "原 MCP 事件流核实已取消，未发起查询；原操作仍保留。");
  const evidence: McpCallEvidence = { ...saved };
  const resolveToken = tokenResolver(opts.resolveToken);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    sessionId: saved.sessionId,
    protocolVersion: saved.protocolVersion,
    authProvider: resolveToken ? { token: resolveToken } : undefined,
    fetch: pinnedFetch(endpoint, undefined, undefined, true),
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
  });
  const progress = callProgress(evidence, opts.recordCallProgress, () => transport.close());
  let complete!: () => void, fail!: (error: unknown) => void;
  const result = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  transport.onmessage = message => {
    if (!("id" in message) || message.id !== request.id || !("result" in message || "error" in message)) return;
    evidence.response = JSON.stringify(message);
    progress.save();
    if (mcpResponseEnded(evidence.response)) complete();
    else fail(new McpError("remote_incomplete", "原 MCP 应答尚非完整终结结果，已保存证据；保留原占用并向拥有者报告，不能重发工具。"));
  };
  transport.onerror = error => fail(error);
  transport.onclose = () => fail(new McpError("resume_incomplete", "原 MCP 事件流已在本地关闭，尚未核实原请求结束；保留占用并查询原服务。"));
  const timeoutMs = opts.callTimeoutMs ?? MCP_LIMITS.callTimeoutMs;
  const timer = setTimeout(() => fail(new McpError("timeout", "核实原 MCP 事件流超时，尚未证明远端结束；保留原操作，不能重发工具。")), timeoutMs);
  const cancel = () => fail(new McpError("canceled", "原 MCP 事件流核实已取消，尚未证明远端结束；保留原操作。"));
  opts.signal?.addEventListener("abort", cancel, { once: true });
  let opening: Promise<void> | undefined;
  try {
    await transport.start();
    opening = transport.resumeStream(saved.resumptionToken!, { onresumptiontoken: token => { evidence.resumptionToken = token; progress.save(); } });
    void opening.catch(fail);
    await result;
    await progress.flush();
    return evidence;
  } catch (error) {
    await progress.flush();
    throw classifyMcpError(error, timeoutMs, opts.signal);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", cancel);
    await transport.close();
    await opening?.catch(() => {
      // 原打开失败已由 result 上报；关闭后收齐原 GET，不再建立连接。
    });
    await progress.flush();
  }
}

export type { McpRemoteTool, CallToolResult };
