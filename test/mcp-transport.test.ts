import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { connectMcpEndpoint, McpError, parseMcpEndpoint, mcpResponseEnded, resumeMcpCall, type McpCallEvidence } from "@ruukoto/agent/mcp/transport.ts";
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

test("MCP 传输：持久钩子完成后才发调用，第二次钩子拒绝时保留原请求与完整应答", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "read", result: { content: [{ type: "text", text: "完整原文" }], structuredContent: { nested: [1, 2] } } }] });
  const recorded = deferred(), release = deferred();
  let attempts = 0;
  const connection = await connectMcpEndpoint(target(mcp.url), { recordCallRequest: async request => {
    assert.equal(JSON.parse(request).method, "tools/call");
    if (++attempts > 1) throw new McpError("already_recorded", "原请求已登记。");
    recorded.resolve(); await release.promise;
  } });
  try {
    const pending = connection.callTool(tool, { original: true });
    await recorded.promise;
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
    release.resolve();
    const result = await pending;
    const evidence = { ...connection.callEvidence };
    assert.deepEqual(JSON.parse(evidence.request!).params.arguments, { original: true });
    assert.deepEqual(JSON.parse(evidence.response!).result, result);
    assert.equal(JSON.parse(evidence.request!).id, JSON.parse(evidence.response!).id);
    assert.equal(mcpResponseEnded(evidence.response!), true);
    await assert.rejects(connection.callTool(tool, { changed: true }), code("already_recorded"));
    assert.deepEqual(connection.callEvidence, evidence);
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 1);
  } finally { release.resolve(); await connection.close(); await mcp.close(); }
});

for (const interrupted of ["cancel", "revoke"] as const) {
  test(`MCP 传输：记录期间 ${interrupted} 在真正发送前复核，零工具外调`, async () => {
    const mcp = await startMockMcp({ requireAuth: true, tools: [{ name: "read" }] });
    const recorded = deferred(), release = deferred();
    const controller = new AbortController();
    let token = MOCK_MCP_SECRET;
    const connection = await connectMcpEndpoint(target(mcp.url), {
      resolveToken: async () => token,
      recordCallRequest: async () => { recorded.resolve(); await release.promise; },
    });
    try {
      const rejected = assert.rejects(connection.callTool(tool, {}, controller.signal), code(interrupted === "cancel" ? "canceled" : "auth_failed"));
      await recorded.promise;
      if (interrupted === "cancel") controller.abort(); else token = "";
      release.resolve();
      await rejected;
      assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
    } finally { release.resolve(); await connection.close(); await mcp.close(); }
  });
}

for (const callback of ["recordCallRequest", "recordCallProgress"] as const) test(`MCP 传输：${callback} 写入失败不发送工具，不泄露持久回调异常`, async () => {
  const mcp = await startMockMcp({ tools: [{ name: "read" }] });
  const connection = await connectMcpEndpoint(target(mcp.url), { [callback]: async () => { throw new Error(MOCK_MCP_SECRET); } });
  try {
    await assert.rejects(connection.callTool(tool, {}), error => {
      assert.ok(error instanceof McpError);
      assert.equal(error.code, "evidence_failed");
      assert.ok(!error.message.includes(MOCK_MCP_SECRET));
      return true;
    });
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
  } finally { await connection.close(); await mcp.close(); }
});

test("MCP 传输：只承认完整终结应答，交互中间结果和异步任务不解除远端占用", () => {
  const response = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 7, result });
  assert.equal(mcpResponseEnded(response({ content: [] })), true);
  assert.equal(mcpResponseEnded(response({ content: [], resultType: "complete", isError: true })), true);
  assert.equal(mcpResponseEnded(JSON.stringify({ jsonrpc: "2.0", id: "7", error: { code: -1, message: "错误", data: { original: true } } })), true);
  for (const raw of ["invalid", "{}", response({}), response({ content: [], resultType: "input_required", requestState: "state" }), response({ content: [], resultType: "future" }), response({ content: [], task: { taskId: "remote" } }), JSON.stringify({ jsonrpc: "2.0", id: null, result: { content: [] } })]) assert.equal(mcpResponseEnded(raw), false, raw);
});

async function startResumableCall(opts: { error?: boolean; incomplete?: boolean; wrongId?: boolean; holdResume?: boolean } = {}) {
  const hits: Array<{ method: string; rpc?: string; token?: string; session?: string; protocol?: string }> = [];
  const canceled = deferred();
  let originalId = 0;
  const server = await startServer((request, response) => {
    const headers = { session: request.headers["mcp-session-id"] as string | undefined, protocol: request.headers["mcp-protocol-version"] as string | undefined };
    if (request.method === "GET") {
      const token = request.headers["last-event-id"] as string | undefined;
      hits.push({ method: "GET", token, ...headers });
      if (!token) { response.writeHead(405).end(); return; }
      if (opts.holdResume) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const id = opts.wrongId ? originalId + 100 : originalId;
      const message = opts.error ? { jsonrpc: "2.0", id, error: { code: -32602, message: "原错误", data: { nested: ["完整错误数据"] } } } : { jsonrpc: "2.0", id, result: opts.incomplete ? { resultType: "input_required", requestState: "state", content: [] } : { content: [{ type: "text", text: "迟到完整结果" }] } };
      response.end(`id: terminal\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string; id: number };
      hits.push({ method: request.method!, rpc: message.method, ...headers });
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "original-session" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "resumable", version: "1" } } }));
      } else if (message.method === "tools/call") {
        originalId = message.id;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`id: priming\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: message.id, progress: 0 } })}\n\n`);
      } else { response.writeHead(202).end(); if (message.method === "notifications/cancelled") canceled.resolve(); }
    });
  });
  return { ...server, hits, canceled: canceled.promise };
}

for (const error of [false, true]) {
  test(`MCP 传输：标准 SSE 恢复原 ${error ? "错误" : "结果"}，不握手或重发原工具`, { timeout: 5000 }, async () => {
    const server = await startResumableCall({ error });
    const progress: McpCallEvidence[] = [];
    const connection = await connectMcpEndpoint(target(server.url), { callTimeoutMs: 100, recordCallProgress: async value => { progress.push({ ...value }); } });
    try {
      await assert.rejects(connection.callTool(tool, {}), code("timeout"));
      assert.equal(connection.callEvidence?.sessionId, "original-session");
      assert.equal(connection.callEvidence?.protocolVersion, "2025-06-18");
      assert.equal(connection.callEvidence?.resumptionToken, "priming");
      assert.equal(connection.callEvidence?.response, undefined);
      await server.canceled;
      await connection.close();
      const before = server.hits.length;
      const evidence = await resumeMcpCall(target(server.url), connection.callEvidence!, { callTimeoutMs: 1000, recordCallProgress: async value => { progress.push({ ...value }); } });
      assert.equal(mcpResponseEnded(evidence.response!), true);
      assert.equal(evidence.resumptionToken, "terminal");
      assert.ok(progress.some(value => value.resumptionToken === "priming"));
      assert.ok(progress.filter(value => value.resumptionToken === "terminal").every(value => value.response === evidence.response));
      assert.deepEqual(server.hits.slice(before), [{ method: "GET", token: "priming", session: "original-session", protocol: "2025-06-18" }]);
      assert.equal(server.hits.filter(hit => hit.rpc === "tools/call").length, 1);
      if (error) assert.deepEqual(JSON.parse(evidence.response!).error.data, { nested: ["完整错误数据"] });
      else assert.equal(JSON.parse(evidence.response!).result.content[0].text, "迟到完整结果");
    } finally { await connection.close(); await server.close(); }
  });
}

test("MCP 传输：缺原恢复身份或已取消时不联网", async () => {
  const server = await startResumableCall();
  const original = { request: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }), sessionId: "session", protocolVersion: "2025-06-18", resumptionToken: "event" };
  try {
    for (const key of ["request", "sessionId", "protocolVersion", "resumptionToken"] as const) await assert.rejects(resumeMcpCall(target(server.url), { ...original, [key]: undefined }), code("resume_unavailable"));
    await assert.rejects(resumeMcpCall(target(server.url), original, { signal: AbortSignal.abort() }), code("canceled"));
    await assert.rejects(resumeMcpCall(target(server.url), original, { resolveToken: async () => "" }), code("auth_failed"));
    assert.equal(server.hits.length, 0);
  } finally { await server.close(); }
});

for (const failure of ["incomplete", "wrongId", "holdResume", "write"] as const) {
  test(`MCP 传输：恢复 ${failure} 不生成远端结束证明或重发工具`, { timeout: 5000 }, async () => {
    const server = await startResumableCall({ [failure]: true });
    const connection = await connectMcpEndpoint(target(server.url), { callTimeoutMs: 100 });
    try {
      await assert.rejects(connection.callTool(tool, {}), code("timeout"));
      await server.canceled;
      await connection.close();
      let latest: McpCallEvidence | undefined;
      const controller = new AbortController();
      const before = server.hits.length;
      const resumed = resumeMcpCall(target(server.url), connection.callEvidence!, { callTimeoutMs: 150, signal: controller.signal, recordCallProgress: async value => {
        latest = { ...value };
        if (failure === "write") throw new Error(MOCK_MCP_SECRET);
      } });
      const rejected = assert.rejects(resumed, error => {
        assert.ok(error instanceof McpError);
        assert.equal(error.code, { incomplete: "remote_incomplete", wrongId: "timeout", holdResume: "canceled", write: "evidence_failed" }[failure]);
        assert.ok(!error.message.includes(MOCK_MCP_SECRET));
        return true;
      });
      if (failure === "holdResume") { await delay(30); controller.abort(); }
      await rejected;
      if (failure === "incomplete") assert.equal(mcpResponseEnded(latest!.response!), false);
      if (failure === "wrongId" || failure === "holdResume") assert.equal(latest?.response, undefined);
      assert.ok(server.hits.slice(before).every(hit => hit.method === "GET"));
      assert.equal(server.hits.filter(hit => hit.rpc === "tools/call").length, 1);
    } finally { await connection.close(); await server.close(); }
  });
}

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
