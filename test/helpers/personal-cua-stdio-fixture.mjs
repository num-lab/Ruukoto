import * as fs from "node:fs";
import { createInterface } from "node:readline";
const [record, definitions] = process.argv.slice(2);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  fs.appendFileSync(record, JSON.stringify({ pid: process.pid, ...message }) + "\n");
  if (message.id === undefined) continue;
  let result;
  if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "personal-cua-fixture", version: "1" } };
  else if (message.method === "tools/list") result = { tools: JSON.parse(fs.readFileSync(definitions, "utf8")) };
  else if (message.method === "tools/call") {
    if (message.params.arguments.hang) continue;
    const mode = message.params.arguments.bad ?? (fs.existsSync(record + ".mode") ? fs.readFileSync(record + ".mode", "utf8") : "");
    result = message.params.name === "computer_screenshot" ? { content: mode === "empty" ? [{ type: "text", text: "无图" }] : [{ type: "image", data: mode === "invalid" ? "aGVsbG8=" : png, mimeType: "image/png" }], ...(mode === "error" ? { isError: true } : {}) } : { content: [{ type: "text", text: "操作已返回" }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
}
