import assert from "node:assert/strict";
import { test } from "node:test";
import { observeMcpResponse } from "@ruukoto/agent/mcp/response-observer.ts";
import { McpError } from "@ruukoto/agent/mcp/transport.ts";

const reply = { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "完整原文😀" }] } };
function response(chunks: Uint8Array[], broken = false): Response {
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift()!);
      else if (broken) controller.error(new Error("断流"));
      else controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

test("MCP 应答观察：UTF8 分块、多行 data 与正常 EOF 保留原字节", async () => {
  const wire = Buffer.from(`data: ${JSON.stringify(reply).replace(',"result"', ',\ndata: "result"')}`);
  const saved: unknown[] = [];
  const observed = observeMcpResponse(response([...wire].map(byte => Uint8Array.of(byte))), async message => { saved.push(message); }, () => true, 4096);
  assert.equal(await observed.text(), wire.toString());
  assert.deepEqual(saved, [reply]);
});

test("MCP 应答观察：断流和已取消的 EOF 不补成远端答复", async () => {
  for (const broken of [true, false]) {
    const saved: unknown[] = [];
    const wire = Buffer.from(`data: ${JSON.stringify(reply)}`);
    const observed = observeMcpResponse(response([wire], broken), async message => { saved.push(message); }, () => broken, 4096);
    if (broken) await assert.rejects(observed.text()); else await observed.text();
    assert.deepEqual(saved, []);
  }
});

test("MCP 应答观察：同块后续坏事件保留先收到的完整答复", async () => {
  const saved: unknown[] = [];
  const observed = observeMcpResponse(response([Buffer.from(`data: ${JSON.stringify(reply)}\n\ndata: invalid\n\n`)]), async message => { saved.push(message); }, () => true, 4096);
  await assert.rejects(observed.text(), error => error instanceof McpError && error.code === "evidence_failed");
  assert.deepEqual(saved, [reply]);
});

test("MCP 应答观察：原块在必需持久化完成后才交给 Pi", async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const saving = new Promise<void>(resolve => { entered = resolve; });
  const wire = Buffer.from(`data: ${JSON.stringify(reply)}\n\n`);
  const observed = observeMcpResponse(response([wire]), async () => { entered(); await hold; }, () => true, 4096);
  const reader = observed.body!.getReader();
  let delivered = false;
  const pending = reader.read().then(result => { delivered = true; return result; });
  await saving;
  assert.equal(delivered, false);
  release();
  assert.deepEqual((await pending).value, wire);
  await reader.cancel();
});
