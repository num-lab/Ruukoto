import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { CodeState } from "../../../../apps/desktop/src/renderer/code-state.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
const server = await createServer({ configFile: false, root: new URL("../../../../apps/desktop/src/renderer", import.meta.url).pathname, plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { Conversation } = await server.ssrLoadModule("/conversation.tsx");
  const readsByCount: { count: number; reads: number }[] = [];
  for (const count of [50, 300]) {
    const model = new CodeState({ request: async () => ({ ok: false, error: { code: "unused", message: "不应发起请求" } }) }, () => {});
    const session = model.view.openSession("render-repro");
    const entries: HistoryEntryView[] = Array.from({ length: count }, (_, index) => ({ entryId: `entry-${index}`, role: index % 2 ? "assistant" : "user", text: `第 ${index} 条已加载的消息\n\n**已完成内容**，包含 \`file-${index}.ts\` 和普通说明。`, timestamp: new Date(1760000000000 + index * 1000).toISOString(), taskId: null, inputPurpose: "user", parentId: null, offset: 0, totalBytes: 100, truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: false, hasNonTextContent: false }));
    session.flow.installHistory(entries, true, count + 1);
    const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session.flow), "items")!.get!;
    let reads = 0;
    Object.defineProperty(session.flow, "items", { get() { reads++; return getter.call(this); } });
    const started = performance.now();
    const html = renderToStaticMarkup(createElement(Conversation, { model, sessionId: "render-repro" }));
    process.stdout.write(`${JSON.stringify({ count, reads, milliseconds: +(performance.now() - started).toFixed(2), bytes: html.length })}\n`);
    readsByCount.push({ count, reads });
  }
  assert.ok(readsByCount.every(item => item.reads <= 3), `已加载消息不应逐条重复排序整个flow：${JSON.stringify(readsByCount)}`);
} finally { await server.close(); }
