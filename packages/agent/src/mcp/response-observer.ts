/** 只观察 Pi 消费的原 HTTP 答复；连接、请求与恢复仍由 Pi 持有。
 * Note: 见 .agents/notes/implemented/simplification/2026-10-26-mcp-host-responsibilities.md
 */
import { isJsonRpcResponse, parseJsonRpcMessage, type JsonRpcResponse } from "@earendil-works/pi-mcp";
import { createParser } from "eventsource-parser";
import { McpError } from "./transport.ts";

export function observeMcpResponse(response: Response, onResponse: (message: JsonRpcResponse) => Promise<void>, isActive: () => boolean, maxMessageBytes: number): Response {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || !response.body || !["application/json", "text/event-stream"].includes(type ?? "")) return response;
  const decoder = new TextDecoder();
  let json = "", jsonBytes = 0;
  let pending: JsonRpcResponse[] = [];
  const invalid = () => new McpError("evidence_failed", "MCP 原应答无法核实或保存；保留结果未知，不能重发原操作。");
  const collect = (raw: string) => {
    if (Buffer.byteLength(raw) > maxMessageBytes) throw invalid();
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw invalid(); }
    for (const item of Array.isArray(value) ? value : [value]) {
      let message;
      try { message = parseJsonRpcMessage(item); } catch { throw invalid(); }
      if (isJsonRpcResponse(message)) pending.push(message);
    }
  };
  const parser = type === "text/event-stream" ? createParser({
    maxBufferSize: maxMessageBytes,
    onEvent: event => { if ((!event.event || event.event === "message") && event.data.trim()) collect(event.data); },
    onError: error => {
      if (error.type === "max-buffer-size-exceeded") throw invalid();
      // 非法 retry 和未知字段不提供答复；原字节仍由 Pi 解释。
    },
  }) : undefined;
  const parseAndSave = async (parse: () => void) => {
    let failure: unknown;
    try { parse(); } catch (error) { failure = error; }
    const current = pending;
    pending = [];
    // 同块后续坏事件不能抹掉此前已收到的完整答复。
    for (const message of current) if (isActive()) await onResponse(message);
    if (failure) throw failure;
  };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await parseAndSave(() => {
        const text = decoder.decode(chunk, { stream: true });
        if (parser) parser.feed(text);
        else {
          jsonBytes += chunk.byteLength;
          if (jsonBytes > maxMessageBytes) throw invalid();
          json += text;
        }
      });
      controller.enqueue(chunk);
    },
    async flush() {
      // 虚拟空行只在正常 EOF 进入观察器；取消和断流不补远端答复。
      if (isActive()) await parseAndSave(() => {
        if (parser) parser.feed(`${decoder.decode()}\n\n`);
        else collect(json + decoder.decode());
      });
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
