import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { McpClient, type JsonRpcId } from "@earendil-works/pi-mcp";
import { connectMcpEndpoint, createMcpHttpTransport, McpError, parseMcpEndpoint, mcpResponseEnded, type McpCallEvidence } from "@ruukoto/agent/mcp/transport.ts";
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

for (const fail of [false, true]) test(`MCP 传输：重复 ID 等待原答复持久化${fail ? "失败后保持未知" : "完成后才交付"}`, async () => {
  const saving = deferred(), release = deferred();
  let calls = 0, secondId: JsonRpcId, saved = false;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body) as { id: JsonRpcId; method: string };
      const reply = (id: JsonRpcId, result: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      if (request.method === "initialize") reply(request.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "duplicate", version: "1" } });
      else if (request.method === "tools/call") {
        if (++calls === 1) void saving.promise.then(() => reply(secondId, { content: [{ type: "text", text: "duplicate" }] }));
        else { secondId = request.id; reply(request.id, { content: [{ type: "text", text: "original" }] }); }
      } else res.writeHead(202).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/mcp`;
  const evidence: McpCallEvidence[] = [];
  const transport = createMcpHttpTransport(endpoint, undefined, () => {
    const current = {}; evidence.push(current);
    return { evidence: current, active: () => true, hooks: { async recordCallProgress() {
      saving.resolve(); await release.promise;
      if (fail) throw new Error("disk failed");
      saved = true;
    } } };
  });
  const client = new McpClient({ name: "duplicate", version: "1", requestTimeoutMs: 1000 });
  try {
    await client.connect(transport);
    const first = client.callTool("first", {}).catch(error => error);
    const second = client.callTool("second", {}).then(result => ({ result }), error => ({ error }));
    await saving.promise;
    assert.equal(await Promise.race([second.then(() => true), delay(50).then(() => false)]), false);
    assert.equal(saved, false);
    release.resolve();
    const outcome = await second;
    if (fail) { assert.ok("error" in outcome); assert.equal(evidence[1].response, undefined); }
    else { assert.ok("result" in outcome); assert.equal(saved, true); assert.ok(evidence[1].response); }
    await first;
  } finally { release.resolve(); await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("MCP 传输：取消后迟到的持久回调不能覆盖同连接新调用证据", async () => {
  const saving = deferred(), release = deferred();
  let saves = 0;
  const mcp = await startMockMcp({ tools: [{ name: "read" }] });
  const connection = await connectMcpEndpoint(target(mcp.url), { async recordCallProgress() {
    if (++saves === 1) { saving.resolve(); await release.promise; }
  } });
  try {
    const controller = new AbortController();
    const rejected = assert.rejects(connection.callTool(tool, { old: true }, controller.signal), code("canceled"));
    await saving.promise; controller.abort(); await rejected;
    await connection.callTool(tool, { current: true });
    const current = { ...connection.callEvidence };
    release.resolve(); await delay(20);
    assert.deepEqual(connection.callEvidence, current);
    assert.deepEqual(JSON.parse(current.request!).params.arguments, { current: true });
    assert.equal(JSON.parse(current.response!).id, JSON.parse(current.request!).id);
  } finally { release.resolve(); await connection.close(); await mcp.close(); }
});

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
    assert.deepEqual(connection.callEvidence, {}, "后一次未发送调用不继承前一次答复");
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

for (const callback of ["recordCallRequest", "recordCallProgress"] as const) test(`MCP 传输：${callback} 写入失败按发送阶段记证，不泄露持久回调异常`, async () => {
  const mcp = await startMockMcp({ tools: [{ name: "read" }] });
  const connection = await connectMcpEndpoint(target(mcp.url), { [callback]: async () => { throw new Error(MOCK_MCP_SECRET); } });
  try {
    await assert.rejects(connection.callTool(tool, {}), error => {
      assert.ok(error instanceof McpError);
      assert.equal(error.code, "evidence_failed");
      assert.ok(!error.message.includes(MOCK_MCP_SECRET));
      return true;
    });
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, callback === "recordCallRequest" ? 0 : 1);
  } finally { await connection.close(); await mcp.close(); }
});

test("MCP 传输：只承认完整终结应答，交互中间结果和异步任务不解除远端占用", () => {
  const response = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 7, result });
  assert.equal(mcpResponseEnded(response({ content: [] })), true);
  assert.equal(mcpResponseEnded(response({ content: [], resultType: "complete", isError: true })), true);
  assert.equal(mcpResponseEnded(JSON.stringify({ jsonrpc: "2.0", id: "7", error: { code: -1, message: "错误", data: { original: true } } })), true);
  for (const raw of ["invalid", "{}", response({}), response({ content: [], resultType: "input_required", requestState: "state" }), response({ content: [], resultType: "future" }), response({ content: [], task: { taskId: "remote" } }), JSON.stringify({ jsonrpc: "2.0", id: null, result: { content: [] } })]) assert.equal(mcpResponseEnded(raw), false, raw);
});

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
    await assert.rejects(connection.callTool({ ...tool, name: "rpc" }, {}), code("protocol_error"));
    assert.ok(mcp.hits.every(hit => !hit.hasAuth));
  } finally { await connection.close(); await mcp.close(); }
});

test("MCP 传输：由 Pi 分页发现超过旧页数与工具数上限的清单", async () => {
  const mcp = await startMockMcp({ pageSize: 1, tools: Array.from({ length: 65 }, (_, index) => ({ name: `tool_${index}` })) });
  const connection = await connectMcpEndpoint(target(mcp.url));
  try {
    assert.equal((await connection.listTools()).length, 65);
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/list").length, 65);
  } finally { await connection.close(); await mcp.close(); }
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

for (const actual of [false, true]) test(`MCP 传输：同文案的${actual ? "原远端" : "Pi 合成"} SSE 错误按原流来源区分`, async () => {
  let calls = 0;
  const server = await startServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.method === "initialize") response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "provenance", version: "1" } } }));
      else if (message.method === "tools/call") {
        calls++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(actual ? `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "MCP response stream failed: stream ended without a response" } })}\n\n` : ": no reply\n\n");
      } else response.writeHead(202).end();
    });
  });
  const connection = await connectMcpEndpoint(target(server.url));
  try {
    await assert.rejects(connection.callTool(tool, {}), code("protocol_error"));
    assert.equal(!!connection.callEvidence?.response, actual);
    assert.equal(calls, 1);
  } finally { await connection.close(); await server.close(); }
});

test("MCP 传输：Pi 会话内 GET 续流的真实答复保留原调用归属", { timeout: 5000 }, async () => {
  let originalId: number | undefined, calls = 0, gets = 0;
  const server = await startServer((request, response) => {
    if (request.method !== "POST" && request.method !== "GET") { response.writeHead(202).end(); return; }
    if (request.method === "GET") {
      gets++;
      assert.equal(request.headers["last-event-id"], "priming");
      response.writeHead(200, { "content-type": "text/event-stream" }).end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: originalId, result: { content: [{ type: "text", text: "GET 原答复" }] } })}\n\n`);
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.method === "initialize") response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "incarnation" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "get", version: "1" } } }));
      else if (message.method === "tools/call") {
        calls++; originalId = message.id;
        response.writeHead(200, { "content-type": "text/event-stream" }).end("retry: 1\nid: priming\n\n");
      } else response.writeHead(202).end();
    });
  });
  const connection = await connectMcpEndpoint(target(server.url), { callTimeoutMs: 4000 });
  try {
    assert.equal((await connection.callTool(tool, {})).content[0].type, "text");
    assert.equal(JSON.parse(connection.callEvidence!.response!).id, originalId);
    assert.equal(calls, 1); assert.equal(gets, 1);
    assert.equal(connection.callEvidence!.resumptionToken, undefined, "不保存跨重启游标");
  } finally { await connection.close(); await server.close(); }
});

test("MCP 传输：超时发生于持久等待时明确未发送，释放等待后仍零调用", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "read" }] });
  const entered = deferred(), release = deferred();
  const connection = await connectMcpEndpoint(target(mcp.url), { callTimeoutMs: 50, recordCallRequest: async () => { entered.resolve(); await release.promise; } });
  try {
    const call = connection.callTool(tool, {});
    const rejected = assert.rejects(call, error => error instanceof McpError && error.code === "timeout" && error.requestSent === false);
    await entered.promise;
    await rejected;
    release.resolve(); await delay(20);
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
    assert.equal(connection.callEvidence!.request, undefined);
  } finally { release.resolve(); await connection.close(); await mcp.close(); }
});

test("MCP 传输：原session的HTTP404明确未接纳，保持实际发送事实且不自动重试", async () => {
  let calls = 0;
  const server = await startServer((request, response) => {
    if (request.method !== "POST") { response.writeHead(202).end(); return; }
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.method === "initialize") response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "original" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "reject", version: "1" } } }));
      else if (message.method === "tools/call") { calls++; response.writeHead(404).end(); }
      else response.writeHead(202).end();
    });
  });
  const connection = await connectMcpEndpoint(target(server.url));
  try {
    await assert.rejects(connection.callTool(tool, {}), error => error instanceof McpError && error.code === "session_expired" && error.requestSent === true && error.remoteRejected === true);
    assert.equal(calls, 1);
    assert.ok(connection.callEvidence?.request);
    assert.equal(connection.callEvidence?.response, undefined);
  } finally { await connection.close(); await server.close(); }
});
