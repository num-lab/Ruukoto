/** Code 实例 MCP 装配；个人端使用独立档案与凭据。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-17-mcp-transport-reuse.md
 * Note: 见 .agents/notes/implemented/simplification/2026-10-24-code-instance-mcp.md
 */
import { createHash } from "node:crypto";
import type { CredentialBinding, CredentialStore } from "../execution/credentials.ts";
import type { McpServiceConfig } from "./store.ts";
import { connectMcpEndpoint, McpError, parseMcpEndpoint, type McpConnection, type McpTimeouts } from "./transport.ts";

export { MCP_LIMITS, McpError, parseMcpEndpoint, type McpTimeouts, type McpConnection, type McpRemoteTool, type CallToolResult } from "./transport.ts";

export const MCP_CREDENTIAL_PURPOSE = "mcp";

export interface McpConnectOptions extends McpTimeouts {
  credentials: CredentialStore;
}

export function isMcpCredential(binding: CredentialBinding | null, host?: string): binding is CredentialBinding {
  return binding !== null && !!binding.secret && binding.purpose === MCP_CREDENTIAL_PURPOSE && binding.header.toLowerCase() === "authorization" &&
    binding.scope?.projectId === undefined && binding.scope?.repoId === undefined && binding.scope?.repoId === undefined && binding.scope?.operations?.length === 1 &&
    binding.scope.operations[0] === MCP_CREDENTIAL_PURPOSE && (host === undefined || binding.host === host);
}

/** 每请求重读凭据；不把项目受限或通用绑定转换成实例 MCP 授权。 */
export async function connectMcpService(service: McpServiceConfig, opts: McpConnectOptions): Promise<McpConnection> {
  if (service.cua) throw new McpError("cua_manager_required", "电脑服务须由产品的持续连接管理器打开；普通 MCP 连接入口不能启动电脑程序。");
  const endpoint = parseMcpEndpoint(service.endpoint!);
  const credName = service.credential;
  return connectMcpEndpoint({ serviceId: service.id, endpoint: service.endpoint! }, {
    connectTimeoutMs: opts.connectTimeoutMs,
    listTimeoutMs: opts.listTimeoutMs,
    callTimeoutMs: opts.callTimeoutMs,
    resolveToken: credName ? async () => {
      const binding = opts.credentials.get(credName);
      if (!isMcpCredential(binding, endpoint.host)) {
        throw new McpError("auth_failed", "MCP 凭据已撤销或用途、主机、认证头、操作范围不匹配；未发送请求，请停止本次调用并报告拥有者检查凭据配置。");
      }
      return binding.secret;
    } : undefined,
  });
}

/** 摘要只绑定实际认证选择；同令牌的空白变化不更换账户授权。 */
export function mcpCredentialDigest(binding: CredentialBinding | null): string | null {
  return binding ? createHash("sha256").update(JSON.stringify([binding.host, binding.header.toLowerCase(), binding.purpose, [binding.scope?.projectId ?? null, binding.scope?.repoId ?? null, binding.scope?.operations ?? null], binding.secret.trim()])).digest("hex") : null;
}
