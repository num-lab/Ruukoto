/**
 * 进程内模拟 Streamable HTTP MCP 服务（issue 16/24 提取，issue 18 复用）：
 * JSON 响应（非 SSE），支持分页、认证、延迟与断线注入；回环 http 仅此用途。
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { MockResponse, Responder } from "./mock-provider.ts";

/** 旧 MCP 场景在实际调用前走发现工具；原 responder 只计业务轮次，真实请求仍完整留证。 */
export function withMcpDiscovery(responder: Responder): Responder {
  let businessIndex = 0;
  const pending = new Map<string, { response: MockResponse; attempted: Set<string> }>();
  const searches = new Set<string>();
  return async request => {
    const previous = String(request.messages.at(-1)?.tool_call_id);
    let next = pending.get(previous);
    pending.delete(previous);
    if (!next) {
      const messages = request.messages.filter(message => !searches.has(String(message.tool_call_id)) &&
        !(Array.isArray(message.tool_calls) && message.tool_calls.every(call => searches.has(call.id))));
      next = { response: await responder({ ...request, messages }, businessIndex++), attempted: new Set() };
    }
    const { response, attempted } = next;
    const names = (request.tools ?? []).map(tool => (tool.function as { name: string } | undefined)?.name ?? tool.name);
    const missing = response.kind === "tool_calls" && names.includes("tool_search")
      ? response.calls.find(call => call.name.startsWith("mcp__") && !names.includes(call.name) && !attempted.has(call.name)) : undefined;
    if (missing) {
      const id = `discover-mcp-${searches.size}`;
      searches.add(id); attempted.add(missing.name);
      pending.set(id, next);
      return { kind: "tool_calls", calls: [{ id, name: "tool_search", arguments: { query: missing.name, limit: 1 } }] };
    }
    return response;
  };
}

/** 模拟服务默认认证期望值（与调用方配置的凭据秘密一致；脱敏断言共用）。 */
export const MOCK_MCP_SECRET = "mcp-test-secret-7f3a9b";

export interface MockMcpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  result?: { content?: unknown[]; structuredContent?: unknown; isError?: boolean };
  rpcError?: { code: number; message: string };
  delayMs?: number;
}

export interface MockMcpHit {
  rpcMethod: string | null;
  toolName: string | null;
  /** tools/call 的实际参数（断言执行参数来自批准快照）；其他方法为 null。 */
  args: unknown | null;
  hasAuth: boolean;
}

export interface MockMcp {
  url: string;
  host: string;
  hits: MockMcpHit[];
  close(): Promise<void>;
}

/** 进程内模拟 MCP 服务：JSON 响应（非 SSE），支持分页、认证、延迟与断线注入。 */
export async function startMockMcp(opts: {
  tools: MockMcpToolSpec[];
  requireAuth?: boolean;
  pageSize?: number;
  listDelayMs?: number;
  dropOnCall?: boolean;
  /** 认证期望值（与调用方配置的凭据秘密一致）。 */
  secret?: string;
}): Promise<MockMcp> {
  const secret = opts.secret ?? MOCK_MCP_SECRET;
  const hits: MockMcpHit[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method !== "POST" || u.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        let body: any;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400).end();
          return;
        }
        const rpcMethod = typeof body?.method === "string" ? body.method : null;
        const toolName = rpcMethod === "tools/call" ? String(body?.params?.name ?? "") : null;
        const hasAuth = req.headers.authorization === `Bearer ${secret}`;
        hits.push({ rpcMethod, toolName, args: rpcMethod === "tools/call" ? (body?.params?.arguments ?? null) : null, hasAuth });
        if (opts.requireAuth && !hasAuth) {
          res
            .writeHead(401, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32001, message: "unauthorized" } }));
          return;
        }
        const reply = (result: unknown) => {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? null, result }));
        };
        const replyError = (code: number, message: string) => {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? null, error: { code, message } }));
        };
        switch (rpcMethod) {
          case "initialize":
            reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-mcp", version: "1.0.0" } });
            return;
          case "ping":
            reply({});
            return;
          case "tools/list": {
            if (opts.listDelayMs) await new Promise(resolve => setTimeout(resolve, opts.listDelayMs));
            const pageSize = opts.pageSize ?? 100;
            const start = body?.params?.cursor ? Number(body.params.cursor) : 0;
            const page = opts.tools.slice(start, start + pageSize).map((t) => ({
              name: t.name,
              ...(t.description !== undefined ? { description: t.description } : {}),
              inputSchema: t.inputSchema ?? { type: "object", properties: {} },
              ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
              ...(t.annotations ? { annotations: t.annotations } : {}),
            }));
            const next = start + pageSize < opts.tools.length ? String(start + pageSize) : undefined;
            reply({ tools: page, ...(next ? { nextCursor: next } : {}) });
            return;
          }
          case "tools/call": {
            const tool = opts.tools.find((t) => t.name === toolName);
            if (!tool) {
              replyError(-32602, `unknown tool ${toolName}`);
              return;
            }
            if (opts.dropOnCall) {
              req.socket.destroy();
              return;
            }
            const send = () => {
              if (tool.rpcError) {
                replyError(tool.rpcError.code, tool.rpcError.message);
                return;
              }
              reply(tool.result ?? { content: [{ type: "text", text: `ok:${tool.name}` }] });
            };
            if (tool.delayMs) setTimeout(send, tool.delayMs);
            else send();
            return;
          }
          default:
            // 通知（如 notifications/initialized）：202 无正文
            if (body?.id === undefined) {
              res.writeHead(202).end();
              return;
            }
            replyError(-32601, `method not found: ${rpcMethod}`);
        }
      })().catch(() => {
        try {
          res.writeHead(500).end();
        } catch {
          // 连接可能已断开
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    host: `127.0.0.1:${port}`,
    hits,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
