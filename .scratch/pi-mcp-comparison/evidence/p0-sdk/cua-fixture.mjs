import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const record = process.argv[2];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB8sAAAAASUVORK5CYII=";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(record, `${JSON.stringify({ pid: process.pid, ...message })}\n`);
  if (!("id" in message)) continue;
  let result;
  if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "isolated-cua", version: "1" } };
  else if (message.method === "tools/list") result = { tools: ["screenshot", "click"].map(name => ({ name, inputSchema: { type: "object", properties: { fail: { type: "boolean" } } } })) };
  else if (message.method === "tools/call") {
    if (message.params.name === "click" && message.params.arguments.fail) process.exit(1);
    result = message.params.name === "screenshot" ? { content: [{ type: "image", mimeType: "image/png", data: png }] } : { content: [{ type: "text", text: JSON.stringify({ pid: process.pid }) }] };
  } else throw new Error("unsupported fixture method");
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
