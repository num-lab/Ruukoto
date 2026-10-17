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
function pinnedFetch(endpoint: URL): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname) {
      throw new McpError("invalid_endpoint", `拒绝向非配置目标发起请求：${url.origin}${url.pathname}（配置 ${endpoint.origin}${endpoint.pathname}）`);
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
  /** 省略表示匿名；宿主每请求核实原凭据的目标、用途与来源范围，返回非空 token。
   * 普通异常和空 token 在发送前转为 auth_failed；自定义 McpError 必须不含秘密值。
   */
  resolveToken?: () => Promise<string>;
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
    try {
      // 传钉版定义（不带 outputSchema）：SDK 不做本地输出校验（校验失败与远端错误应答
      // 同为 ProtocolError、分不开，而前者远端已执行），也不在 header 不符时刷新清单后
      // 自动重发；结构化结果由路由器按钉版 outputSchema 校验
      return await this.client.callTool(
        { name: tool.name, arguments: args },
        {
          signal,
          timeout: this.callTimeoutMs,
          maxTotalTimeout: this.callTimeoutMs,
          toolDefinition: { name: tool.name, inputSchema: tool.inputSchema as McpRemoteTool["inputSchema"] },
        },
      );
    } catch (err) {
      throw classifyMcpError(err, this.callTimeoutMs, signal);
    }
  }

  async close(): Promise<void> {
    // 关闭只表示本地停止等待；不承诺远端操作已停止，迟到结果由 SDK 丢弃
    await this.client.close().catch(() => {
      // 忽略 SDK 关闭错误：这里只结束本地等待，不据此宣称远端已停止。
    });
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
  const resolveToken = opts.resolveToken;
  const authProvider = resolveToken ? {
    token: async () => {
      let token: string;
      try { token = await resolveToken(); } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError("auth_failed", "MCP 凭据无法核实，未发送该请求；停止本次调用并报告拥有者检查凭据配置。");
      }
      if (!token) throw new McpError("auth_failed", "MCP 凭据为空，未发送该请求；停止本次调用并报告拥有者检查凭据配置。");
      return token;
    },
  } : undefined;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider,
    fetch: pinnedFetch(endpoint),
  });
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
  );
}

export type { McpRemoteTool, CallToolResult };
