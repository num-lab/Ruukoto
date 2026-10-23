import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const record = process.argv[2];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(record, JSON.stringify(message) + "\n");
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "offline-cua", version: "1" } });
  if (message.method === "tools/list") reply(message.id, { tools: [{ name: "click", inputSchema: { type: "object", properties: {} } }] });
  if (message.method !== "tools/call") continue;
  const args = message.params.arguments;
  if (args.exit) process.exit(1);
  if (args.hang) continue;
  if (args.oversize) {
    process.stdout.write('{' + ' '.repeat(48 * 1024 * 1024 + 1));
    continue;
  }
  if (args.images) {
    const bytes = Buffer.alloc(8 * 1024 * 1024); Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
    reply(message.id, { content: Array.from({ length: 4 }, () => ({ type: "image", mimeType: "image/png", data: bytes.toString("base64") })) });
    continue;
  }
  reply(message.id, { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, args, inheritedSecret: process.env.RUUKOTO_CUA_TEST_SECRET ?? null }) }] });
  if (args.exitAfter) setTimeout(() => process.exit(0), 10);
}
