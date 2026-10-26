import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";
import { McpClient, McpError, McpAbortError, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { observeMcpResponse, ResponseObservationError } from "./p0-http-observer.mjs";

const failureMessage = "MCP response stream failed: stream ended without a response";

async function fixture(mode, onResponse) {
  const sent = [];
  const gets = [];
  const bindings = new Map();
  const accepted = Promise.withResolvers();
  const server = http.createServer(async (request, response) => {
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET") {
      gets.push(request.headers["last-event-id"]);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: sent[0].id, result: { content: [{ type: "text", text: "resumed" }] } })}\n\n`);
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "isolated" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }));
      return;
    }
    if (message.method.startsWith("notifications/")) {
      response.writeHead(202).end();
      return;
    }
    assert.equal(message.method, "tools/call");
    sent.push(message);
    if (mode === "held") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } })}`, () => accepted.resolve(response));
      return;
    }
    if (mode === "success") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "done" }] } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    // 两边HTTP元数据相同；只有真实远端一边发送终结报文。
    response.end(mode === "remote" ? `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: failureMessage } })}\n\n` : mode === "resume" ? "id: resume\nretry: 1\n\n" : "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const transport = new StreamableHttpTransport({ url: `http://127.0.0.1:${server.address().port}/mcp`, openGetStream: false,
    ...(onResponse ? { fetch: async (url, init) => {
      const request = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      const binding = request?.method === "tools/call" ? bindings.get(request.id) : undefined;
      const response = await fetch(url, init);
      return observeMcpResponse(response, async message => {
        const original = bindings.get(message.id);
        if (!original || original.signal?.aborted) return;
        await onResponse(message);
      }, undefined, () => binding ? bindings.get(request.id) === binding && !binding.signal?.aborted : bindings.size > 0);
    } } : {}),
  });
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if (message.method === "tools/call") {
      const binding = { signal: options?.signal };
      bindings.set(message.id, binding);
      options?.signal?.addEventListener("abort", () => { if (bindings.get(message.id) === binding) bindings.delete(message.id); }, { once: true });
    }
    return send(message, options);
  };
  const client = new McpClient({ name: "p0", version: "1", requestTimeoutMs: 2000 });
  return { transport, client, sent, gets, bindings, accepted: accepted.promise, async close() { await client.close(); bindings.clear(); await new Promise(resolve => server.close(resolve)); } };
}

async function errorCase(mode, onResponse) {
  const current = await fixture(mode, onResponse);
  const messages = [];
  const transportErrors = [];
  current.transport.onMessage(message => { if ("error" in message) messages.push(message); });
  current.transport.onError(error => transportErrors.push(error));
  try {
    await current.client.connect(current.transport);
    let caught;
    await assert.rejects(current.client.callTool("write", { value: 1 }), error => {
      assert.ok(error instanceof McpError);
      caught = { constructor: error.constructor.name, name: error.name, code: error.code, message: error.message, data: error.data, keys: Object.keys(error).sort() };
      return true;
    });
    assert.equal(current.sent.length, 1);
    return { messages, transportErrors, caught };
  } finally {
    await current.close();
  }
}

test("P0反例：真实远端错误与已接纳SSE丢答在公开接口上不可区分", async () => {
  const remote = await errorCase("remote");
  const synthetic = await errorCase("lost");
  assert.deepEqual(remote, synthetic);
  assert.equal(remote.messages[0].error.code, -32603);
  assert.equal(remote.transportErrors.length, 0);
});

function wrapSend(transport, send) {
  return {
    start: () => transport.start(), close: () => transport.close(),
    onMessage: listener => transport.onMessage(listener), onError: listener => transport.onError(listener), onClose: listener => transport.onClose(listener),
    setProtocolVersion: version => transport.setProtocolVersion(version), send,
  };
}

test("P0：异步持久门等待期间取消，释放后零业务POST", async () => {
  const current = await fixture("success");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const wrapped = wrapSend(current.transport, async (message, options) => {
    if (message.method !== "tools/call") return current.transport.send(message, options);
    entered.resolve();
    await release.promise;
    try {
      if (options.signal.aborted) throw new McpAbortError();
      await current.transport.send(message, options);
    } finally {
      finished.resolve();
    }
  });
  try {
    await current.client.connect(wrapped);
    const abort = new AbortController();
    const result = current.client.callTool("write", { value: 1 }, { signal: abort.signal }).catch(error => error);
    await entered.promise;
    abort.abort();
    assert.ok(await result instanceof McpAbortError);
    release.resolve();
    await finished.promise;
    assert.equal(current.sent.length, 0);
  } finally {
    release.resolve();
    await current.close();
  }
});

test("P0：持久门失败零业务POST", async () => {
  const current = await fixture("success");
  const failure = new Error("fixture persistence failed");
  const wrapped = wrapSend(current.transport, async (message, options) => {
    if (message.method === "tools/call") throw failure;
    return current.transport.send(message, options);
  });
  try {
    await current.client.connect(wrapped);
    await assert.rejects(current.client.callTool("write", { value: 1 }), error => error === failure);
    assert.equal(current.sent.length, 0);
  } finally {
    await current.close();
  }
});

test("P0：并发同名同参调用可由AsyncLocalStorage绑定各自身份", async () => {
  const current = await fixture("success");
  const calls = new AsyncLocalStorage();
  const correlated = [];
  const wrapped = wrapSend(current.transport, async (message, options) => {
    if (message.method === "tools/call") {
      await new Promise(resolve => setImmediate(resolve));
      correlated.push({ call: calls.getStore(), id: message.id });
    }
    return current.transport.send(message, options);
  });
  try {
    await current.client.connect(wrapped);
    await Promise.all(["first", "second"].map(call => calls.run(call, () => current.client.callTool("write", { value: 1 }))));
    assert.deepEqual(correlated.map(entry => entry.call).sort(), ["first", "second"]);
    assert.equal(new Set(correlated.map(entry => entry.id)).size, 2);
    assert.equal(current.sent.length, 2);
  } finally {
    await current.close();
  }
});

test("P0修订：只读观察区分同码同文本的真实和合成错误，重复ID按连接隔离", async () => {
  const observed = { remote: [], lost: [] };
  const [remote, lost] = await Promise.all(["remote", "lost"].map(mode => errorCase(mode, message => observed[mode].push(message))));
  assert.deepEqual(remote, lost);
  assert.equal(observed.remote.length, 1);
  assert.equal(observed.lost.length, 0);
  assert.deepEqual(observed.remote[0], remote.messages[0]);
  assert.equal(remote.messages[0].id, lost.messages[0].id);
});

function chunkedResponse(parts, type = "text/event-stream", fail = false) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index < parts.length) controller.enqueue(parts[index++]);
      else if (fail) controller.error(new Error("fixture stream failed"));
      else controller.close();
    },
  }), { headers: { "content-type": type } });
}

test("P0修订：分块UTF-8、多行data与正常EOF末事件，原字节不变", async () => {
  const text = 'data: {"jsonrpc":"2.0",\ndata: "id":2,"result":{"content":[{"type":"text","text":"原图"}]}}';
  const bytes = Buffer.from(text);
  const observed = [];
  const response = observeMcpResponse(chunkedResponse([...bytes].map(byte => Uint8Array.of(byte))), message => observed.push(message));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].result.content[0].text, "原图");
});

test("P0修订：JSON批量应答、通知与非message事件不串来源", async () => {
  const notification = { jsonrpc: "2.0", method: "notifications/progress", params: {} };
  const reply = { jsonrpc: "2.0", id: 2, result: { content: [] } };
  const observed = [];
  const json = JSON.stringify([notification, reply]);
  const response = observeMcpResponse(chunkedResponse([Buffer.from(json)], "application/json"), message => observed.push(message));
  assert.equal(await response.text(), json);
  const other = `event: other\ndata: ${JSON.stringify(reply)}\n\ndata: ${JSON.stringify(notification)}\n\n`;
  assert.equal(await observeMcpResponse(chunkedResponse([Buffer.from(other)]), message => observed.push(message)).text(), other);
  assert.deepEqual(observed, [reply]);
});

test("P0修订：终结字节须等待持久门，失败阻止Pi收到该应答", async () => {
  const text = 'data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}\n\n';
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const response = observeMcpResponse(chunkedResponse([Buffer.from(text)]), async () => { entered.resolve(); await release.promise; });
  let finished = false;
  const read = response.text().then(value => { finished = true; return value; });
  await entered.promise;
  assert.equal(finished, false);
  release.resolve();
  assert.equal(await read, text);
  const failure = new Error("fixture persistence failed");
  const rejected = observeMcpResponse(chunkedResponse([Buffer.from(text)]), async () => { throw failure; });
  await assert.rejects(rejected.text(), error => error === failure);
});

test("P0修订：断流不把缺终止空行的残片冒充完整应答", async () => {
  const text = 'data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}';
  const observed = [];
  const response = observeMcpResponse(chunkedResponse([Buffer.from(text)], "text/event-stream", true), message => observed.push(message));
  await assert.rejects(response.text());
  assert.deepEqual(observed, []);
});

test("P0修订：未终止事件按消息预算有界，解析失败不伪造来源", async () => {
  const observed = [];
  const oversized = observeMcpResponse(chunkedResponse([Buffer.from(`data: ${"x".repeat(128)}`)]), message => observed.push(message), 64);
  await assert.rejects(oversized.text(), error => error instanceof ResponseObservationError);
  const invalid = observeMcpResponse(chunkedResponse([Buffer.from("data: invalid\n\n")]), message => observed.push(message));
  await assert.rejects(invalid.text(), error => error instanceof ResponseObservationError);
  assert.deepEqual(observed, []);
});

test("P0修订：由Pi恢复GET的真实答复归属原连接，业务POST不重发", async () => {
  const observed = [];
  const current = await fixture("resume", message => observed.push(message));
  try {
    await current.client.connect(current.transport);
    const result = await current.client.callTool("write", { value: 1 });
    assert.equal(result.content[0].text, "resumed");
    assert.equal(current.sent.length, 1);
    assert.deepEqual(current.gets, ["resume"]);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].id, current.sent[0].id);
    assert.deepEqual(observed[0].result, result);
  } finally {
    await current.close();
  }
});

test("P0修订：调用结算撤销观察资格，迟到正常EOF不追加原答复", async () => {
  const text = 'data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}';
  let input;
  let active = true;
  const observed = [];
  const entered = Promise.withResolvers();
  const original = new Response(new ReadableStream({ start(controller) { input = controller; } }), { headers: { "content-type": "text/event-stream" } });
  const response = observeMcpResponse(original, message => observed.push(message), undefined, () => active);
  const reader = response.body.getReader();
  const reading = reader.read().then(result => { entered.resolve(); return result; });
  input.enqueue(Buffer.from(text));
  await entered.promise;
  await reading;
  active = false;
  input.close();
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(observed, []);
});

test("P0修订：后续坏事件不会按网络分块改变完整答复存证", async () => {
  const reply = { jsonrpc: "2.0", id: 2, result: { content: [] } };
  const valid = `data: ${JSON.stringify(reply)}\n\n`;
  const invalid = "data: invalid\n\n";
  for (const parts of [[valid + invalid], [valid, invalid]]) {
    const observed = [];
    const response = observeMcpResponse(chunkedResponse(parts.map(part => Buffer.from(part))), message => observed.push(message));
    await assert.rejects(response.text(), error => error instanceof ResponseObservationError);
    assert.deepEqual(observed, [reply]);
  }
  const observed = [];
  const batch = JSON.stringify([reply, { invalid: true }]);
  const response = observeMcpResponse(chunkedResponse([Buffer.from(batch)], "application/json"), message => observed.push(message));
  await assert.rejects(response.text(), error => error instanceof ResponseObservationError);
  assert.deepEqual(observed, [reply]);
});

test("P0修订：实际Pi调用取消后，迟到EOF不保存且原连接映射已清理", async () => {
  const observed = [];
  const current = await fixture("held", message => observed.push(message));
  const late = Promise.withResolvers();
  current.transport.onMessage(message => { if (message.id === 2 && "result" in message) late.resolve(); });
  try {
    await current.client.connect(current.transport);
    const abort = new AbortController();
    const result = current.client.callTool("write", { value: 1 }, { signal: abort.signal }).catch(error => error);
    const response = await current.accepted;
    abort.abort();
    assert.ok(await result instanceof McpAbortError);
    response.end();
    await late.promise;
    assert.deepEqual(observed, []);
    assert.equal(current.sent.length, 1);
    assert.equal(current.bindings.size, 0);
  } finally {
    await current.close();
  }
});

test("P0修订：共享原流观察资格变化保留分块解码状态", async () => {
  const text = 'data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"原图"}]}}\n\n';
  const bytes = Buffer.from(text);
  const split = bytes.indexOf(Buffer.from("原")) + 1;
  let active = false;
  const observed = [];
  const response = observeMcpResponse(chunkedResponse([bytes.subarray(0, split), bytes.subarray(split)]), message => observed.push(message), undefined, () => active);
  const reader = response.body.getReader();
  assert.deepEqual(Buffer.from((await reader.read()).value), bytes.subarray(0, split));
  active = true;
  assert.deepEqual(Buffer.from((await reader.read()).value), bytes.subarray(split));
  assert.equal((await reader.read()).done, true);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].result.content[0].text, "原图");
});
