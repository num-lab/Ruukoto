/** 旧项目 MCP 装配；传输复用不要求个人端建立旧项目或凭据存储。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-17-mcp-transport-reuse.md
 */
import type { CredentialStore } from "../execution/credentials.ts";
import type { McpServiceConfig } from "./store.ts";
import { connectMcpEndpoint, McpError, parseMcpEndpoint, type McpConnection, type McpTimeouts } from "./transport.ts";

export { MCP_LIMITS, McpError, parseMcpEndpoint, type McpTimeouts, type McpConnection, type McpRemoteTool, type CallToolResult } from "./transport.ts";

export const MCP_CREDENTIAL_PURPOSE = "mcp";

export interface McpConnectOptions extends McpTimeouts {
  credentials: CredentialStore;
  /** 凭据使用范围绑定到该项目（getForUse 核对）。 */
  projectId: string;
}

/** 连接旧项目的服务；每请求重读凭据并核实项目、操作范围和目标主机。 */
export async function connectMcpService(service: McpServiceConfig, opts: McpConnectOptions): Promise<McpConnection> {
  if (service.cua) throw new McpError("cua_manager_required", "电脑服务须由产品的持续连接管理器打开；普通 MCP 连接入口不能启动电脑程序。");
  const endpoint = parseMcpEndpoint(service.endpoint!);
  const credName = service.credential;
  return connectMcpEndpoint({ serviceId: service.id, endpoint: service.endpoint! }, {
    connectTimeoutMs: opts.connectTimeoutMs,
    listTimeoutMs: opts.listTimeoutMs,
    callTimeoutMs: opts.callTimeoutMs,
    resolveToken: credName ? async () => {
      const binding = opts.credentials.getForUse(credName, { projectId: opts.projectId, operation: MCP_CREDENTIAL_PURPOSE });
      if (!binding?.secret) {
        throw new McpError("auth_failed", `凭据 ${credName} 不存在、秘密值为空或使用范围（项目/操作）不匹配`);
      }
      if (binding.host !== endpoint.host) {
        throw new McpError("auth_failed", `凭据 ${credName} 的 host（${binding.host}）与服务端点（${endpoint.host}）不一致`);
      }
      if (binding.purpose !== MCP_CREDENTIAL_PURPOSE || binding.header.toLowerCase() !== "authorization") {
        throw new McpError("auth_failed", "MCP 凭据的用途或认证头已改变，未发送请求；停止本次调用并报告拥有者检查凭据配置。");
      }
      return binding.secret;
    } : undefined,
  });
}
