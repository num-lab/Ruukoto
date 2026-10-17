import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { connectMcpEndpoint, McpError, parseMcpEndpoint } from "@ruukoto/agent/mcp/transport.ts";
import { McpError as LegacyMcpError, parseMcpEndpoint as legacyParse } from "@ruukoto/agent/mcp/client.ts";
import { startMockMcp, MOCK_MCP_SECRET } from "./helpers/mock-mcp.ts";

const tool = { name: "read", inputSchema: { type: "object" } };
const target = (endpoint: string) => ({ serviceId: "test-service", endpoint });
const code = (expected: string) => (error: unknown) => error instanceof McpError && error.code === expected;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test("MCP 传输：无需旧项目或凭据对象，分页发现并保留参数、结构化结果与工具错误", async () => {
  const result = { content: [{ type: "text", text: "原文" }], structuredContent: { count: 3 } };
  const mcp = await startMockMcp({ pageSize: 1, tools: [
    { name: "read", result },
    { name: "bad", result: { isError: true, content: [{ type: "text", text: "工具执行失败" }] } },
    { name: "rpc", rpcError: { code: -32602, message: "原协议错误" } },
  ] });
  const connection = await connectMcpEndpoint(target(mcp.url));
  try {
    assert.equal(McpError, LegacyMcpError);
    assert.equal(parseMcpEndpoint, legacyParse);
    assert.equal(connection.serviceId, "test-service");
    assert.equal(connection.endpoint, mcp.url);
    assert.equal(connection.serverInfo?.name, "mock-mcp");
    assert.ok(connection.protocolVersion);
    assert.deepEqual((await connection.listTools()).map(value => value.name), ["read", "bad", "rpc"]);
    assert.deepEqual(await connection.callTool(tool, { value: "原参数" }), result);
    assert.deepEqual(mcp.hits.find(hit => hit.rpcMethod === "tools/call")?.args, { value: "原参数" });
    assert.equal((await connection.callTool({ ...tool, name: "bad" }, {})).isError, true);
    await assert.rejects(connection.callTool({ ...tool, name: "rpc" }, {}), code("remote_error"));
    assert.ok(mcp.hits.every(hit => !hit.hasAuth));
  } finally { await connection.close(); await mcp.close(); }
});

for (const pages of [16, 17]) {
  test(`MCP 传输：${pages} 页发现遵守 16 页上限`, async () => {
    const mcp = await startMockMcp({ pageSize: 1, tools: Array.from({ length: pages }, (_, index) => ({ name: `tool_${index}` })) });
    const connection = await connectMcpEndpoint(target(mcp.url));
    try {
      if (pages === 16) assert.equal((await connection.listTools()).length, 16);
      else await assert.rejects(connection.listTools(), code("too_many_pages"));
      assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/list").length, 16);
    } finally { await connection.close(); await mcp.close(); }
  });
}

test("MCP 传输：SDK 汇总后仍拒绝超过 64 个工具", async () => {
  const mcp = await startMockMcp({ tools: Array.from({ length: 65 }, (_, index) => ({ name: `tool_${index}` })) });
  const connection = await connectMcpEndpoint(target(mcp.url));
  try { await assert.rejects(connection.listTools(), code("too_many_tools")); }
  finally { await connection.close(); await mcp.close(); }
});

for (const failure of ["empty", "throw"] as const) {
  test(`MCP 传输：初始化凭据 ${failure} 不降级匿名或泄露异常，零外调`, async () => {
    const mcp = await startMockMcp({ tools: [{ name: "read" }] });
    try {
      await assert.rejects(connectMcpEndpoint(target(mcp.url), { resolveToken: async () => {
        if (failure === "throw") throw new Error(MOCK_MCP_SECRET);
        return "";
      } }), error => {
        assert.ok(error instanceof McpError);
        assert.equal(error.code, "auth_failed");
        assert.ok(!error.message.includes(MOCK_MCP_SECRET));
        return true;
      });
      assert.equal(mcp.hits.length, 0);
    } finally { await mcp.close(); }
  });

  test(`MCP 传输：每请求重读凭据，后续 ${failure} 在网络前停止且不重发`, async () => {
    const mcp = await startMockMcp({ requireAuth: true, tools: [{ name: "read" }] });
    let revoked = false, resolutions = 0;
    const connection = await connectMcpEndpoint(target(mcp.url), { resolveToken: async () => {
      resolutions++;
      if (revoked && failure === "throw") throw new Error(MOCK_MCP_SECRET);
      return revoked ? "" : MOCK_MCP_SECRET;
    } });
    try {
      await connection.listTools();
      const before = resolutions;
      await connection.callTool(tool, {});
      assert.ok(resolutions > before);
      const sent = mcp.hits.length;
      revoked = true;
      await assert.rejects(connection.callTool(tool, {}), error => {
        assert.ok(error instanceof McpError);
        assert.equal(error.code, "auth_failed");
        assert.ok(!error.message.includes(MOCK_MCP_SECRET));
        return true;
      });
      assert.equal(mcp.hits.length, sent);
      assert.ok(mcp.hits.every(hit => hit.hasAuth));
    } finally { await connection.close(); await mcp.close(); }
  });
}

test("MCP 传输：401 不刷新凭据或自动重发工具调用", async () => {
  const mcp = await startMockMcp({ requireAuth: true, tools: [{ name: "read" }] });
  let secret = MOCK_MCP_SECRET;
  const connection = await connectMcpEndpoint(target(mcp.url), { resolveToken: async () => secret });
  try {
    await connection.listTools();
    secret = "revoked-token";
    await assert.rejects(connection.callTool(tool, {}), code("auth_failed"));
    const calls = mcp.hits.filter(hit => hit.rpcMethod === "tools/call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hasAuth, false);
  } finally { await connection.close(); await mcp.close(); }
});

test("MCP 传输：已取消信号不发送工具调用", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "read" }] });
  const connection = await connectMcpEndpoint(target(mcp.url));
  try {
    await assert.rejects(connection.callTool(tool, {}, AbortSignal.abort()), code("canceled"));
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
  } finally { await connection.close(); await mcp.close(); }
});

test("MCP 传输：断线不重发原调用", async () => {
  const mcp = await startMockMcp({ dropOnCall: true, tools: [{ name: "read" }] });
  const connection = await connectMcpEndpoint(target(mcp.url));
  try {
    await assert.rejects(connection.callTool(tool, {}), code("connect_failed"));
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 1);
  } finally { await connection.close(); await mcp.close(); }
});

async function startServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/mcp`, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

for (const interruption of ["abort", "close", "timeout"] as const) {
  test(`MCP 传输：在途 ${interruption} 不重发，远端迟到完成不改变本地失败`, { timeout: 5000 }, async () => {
    const received = deferred(), release = deferred(), completed = deferred();
    let calls = 0;
    const server = await startServer((request, response) => {
      if (request.method !== "POST") { response.writeHead(405).end(); return; }
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const reply = (result: object) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        if (message.method === "initialize") { reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "held", version: "1" } }); return; }
        if (message.method !== "tools/call") { response.writeHead(202).end(); return; }
        calls++;
        received.resolve();
        void release.promise.then(() => { reply({ content: [{ type: "text", text: "远端完成" }] }); completed.resolve(); });
      });
    });
    const connection = await connectMcpEndpoint(target(server.url), { callTimeoutMs: interruption === "timeout" ? 100 : 3000 });
    const controller = new AbortController();
    try {
      const pending = connection.callTool(tool, {}, controller.signal);
      const rejected = assert.rejects(pending, error => {
        assert.ok(error instanceof McpError);
        if (interruption !== "close") assert.equal(error.code, interruption === "abort" ? "canceled" : "timeout");
        return true;
      });
      await received.promise;
      if (interruption === "abort") controller.abort();
      if (interruption === "close") await connection.close();
      await rejected;
      release.resolve();
      await completed.promise;
      await delay(20);
      await assert.rejects(pending, error => error instanceof McpError);
      assert.equal(calls, 1);
    } finally { release.resolve(); await connection.close(); await server.close(); }
  });
}

test("MCP 传输：拒绝非法端点，不解析凭据", async () => {
  let resolved = false;
  for (const endpoint of ["broken", "https://user:pass@example.test/mcp", "http://example.test/mcp"]) {
    await assert.rejects(connectMcpEndpoint(target(endpoint), { resolveToken: async () => { resolved = true; return MOCK_MCP_SECRET; } }), code("invalid_endpoint"));
  }
  assert.equal(resolved, false);
});

test("MCP 传输：重定向不跟随到同源其他路径或其他端点，不转发凭据", async () => {
  const forwarded: string[] = [];
  const destination = await startServer((request, response) => { forwarded.push(request.headers.authorization ?? "anonymous"); response.writeHead(500).end(); });
  let redirect = destination.url, initialRequests = 0;
  const server = await startServer((request, response) => {
    if (request.url !== "/mcp") { forwarded.push(request.headers.authorization ?? "anonymous"); response.writeHead(500).end(); return; }
    initialRequests++;
    response.writeHead(307, { location: redirect }).end();
  });
  try {
    for (const location of [destination.url, new URL("/other", server.url).href]) {
      redirect = location;
      await assert.rejects(connectMcpEndpoint(target(server.url), { resolveToken: async () => MOCK_MCP_SECRET }), code("connect_failed"));
    }
    assert.equal(initialRequests, 2);
    assert.deepEqual(forwarded, []);
  } finally { await server.close(); await destination.close(); }
});
