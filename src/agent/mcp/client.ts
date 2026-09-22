/**
 * MCP 客户端适配层（issue 16 §3）：官方 TypeScript 客户端 + Streamable HTTP。
 *
 * - 首版仅 Streamable HTTP 传输；stdio、OAuth 登录、resources/prompts、
 *   sampling/elicitation 等客户端代执行能力不启用（不声明对应 capability）；
 * - 端点校验：生产固定 https，http 仅限回环（模拟服务）；拒绝 userinfo；
 *   自定义 fetch 钉住源（拒绝跨源重定向，不向非配置目标转发认证）；
 * - 凭据经 authProvider 每次请求新鲜解析（getForUse 核对项目/操作范围与
 *   host），秘密值只进入 Authorization 头，不进入日志、事件或错误文本；
 * - 有界：初始化/发现/调用各自超时，工具数量、分页页数、描述与 schema 大小
 *   均有上限；连接失效可由下一任务重新初始化，不自动重放已发出的调用。
 */

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  type CallToolResult,
  type Tool as McpRemoteTool,
} from "@modelcontextprotocol/client";
import type { CredentialStore } from "../execution/credentials.ts";
import type { McpServiceConfig } from "./store.ts";

export const MCP_CREDENTIAL_PURPOSE = "mcp";

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
    throw new McpError("invalid_endpoint", "MCP 端点不得携带 userinfo（凭据走 CredentialStore）");
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
  /** 调用远端工具；传输错误抛 McpError，工具执行错误（isError）由调用方区分。 */
  callTool(remoteName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface McpConnectOptions extends McpTimeouts {
  credentials: CredentialStore;
  /** 凭据使用范围绑定到该项目（getForUse 核对）。 */
  projectId: string;
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
    const tools: McpRemoteTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_LIMITS.maxListPages; page++) {
      let res: { tools: McpRemoteTool[]; nextCursor?: string };
      try {
        res = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: this.listTimeoutMs, signal });
      } catch (err) {
        throw classifyMcpError(err, this.listTimeoutMs, signal);
      }
      tools.push(...(res.tools ?? []));
      if (tools.length > MCP_LIMITS.maxToolsPerService) {
        throw new McpError("too_many_tools", `MCP 服务工具数超过上限 ${MCP_LIMITS.maxToolsPerService}（拒绝接入，请收缩服务范围）`);
      }
      if (!res.nextCursor) return tools;
      cursor = res.nextCursor;
    }
    throw new McpError("too_many_pages", `MCP 工具分页超过 ${MCP_LIMITS.maxListPages} 页（疑似异常服务，拒绝接入）`);
  }

  async callTool(remoteName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    try {
      return await this.client.callTool(
        { name: remoteName, arguments: args },
        { signal, timeout: this.callTimeoutMs, maxTotalTimeout: this.callTimeoutMs },
      );
    } catch (err) {
      throw classifyMcpError(err, this.callTimeoutMs, signal);
    }
  }

  async close(): Promise<void> {
    // 关闭只表示本地停止等待；不承诺远端操作已停止，迟到结果由 SDK 丢弃
    await this.client.close().catch(() => {});
  }
}

function classifyMcpError(err: unknown, timeoutMs: number, signal?: AbortSignal): McpError {
  if (err instanceof McpError) return err;
  // 先判任务取消：取消语义决定"不重复发送"的恢复叙述
  if (signal?.aborted || (err as Error).name === "AbortError") {
    return new McpError("canceled", "任务已停止，MCP 调用已中止（本地停止等待，不承诺远端操作已停止）");
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

/** 连接并完成初始化握手；不声明任何客户端代执行能力。 */
export async function connectMcpService(service: McpServiceConfig, opts: McpConnectOptions): Promise<McpConnection> {
  const endpoint = parseMcpEndpoint(service.endpoint);
  const connectTimeoutMs = opts.connectTimeoutMs ?? MCP_LIMITS.connectTimeoutMs;
  let authProvider: { token: () => Promise<string> } | undefined;
  if (service.credential) {
    const credName = service.credential;
    authProvider = {
      // 每次请求新鲜解析：撤销/范围变化立即生效；秘密值只进入 Authorization 头
      token: async () => {
        const binding = opts.credentials.getForUse(credName, { projectId: opts.projectId, operation: MCP_CREDENTIAL_PURPOSE });
        if (!binding?.secret) {
          throw new McpError("auth_failed", `凭据 ${credName} 不存在、秘密值为空或使用范围（项目/操作）不匹配`);
        }
        if (binding.host !== endpoint.host) {
          throw new McpError("auth_failed", `凭据 ${credName} 的 host（${binding.host}）与服务端点（${endpoint.host}）不一致`);
        }
        return binding.secret;
      },
    };
  }
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider,
    fetch: pinnedFetch(endpoint),
  });
  const client = new Client({ name: "ruukoto", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: connectTimeoutMs });
  } catch (err) {
    await client.close().catch(() => {});
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
    service.id,
    service.endpoint,
    serverInfo,
    protocolVersion,
    client,
    opts.listTimeoutMs ?? MCP_LIMITS.listTimeoutMs,
    opts.callTimeoutMs ?? MCP_LIMITS.callTimeoutMs,
  );
}

export type { McpRemoteTool, CallToolResult };
