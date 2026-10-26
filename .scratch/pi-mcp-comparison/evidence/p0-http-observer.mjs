import { isJsonRpcResponse, parseJsonRpcMessage } from "@earendil-works/pi-mcp";
import { createParser } from "eventsource-parser";

export class ResponseObservationError extends Error {
  code = "response_observation_failed";
  constructor() { super("MCP真实应答无法观察；保留结果未知，不能重发原操作。"); }
}

// 每个transport使用自己的回调闭包；来源归属不使用跨客户端的裸请求ID。
export function observeMcpResponse(response, onResponse, maxMessageBytes = 16 * 1024 * 1024, isActive = () => true) {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || !response.body || !["application/json", "text/event-stream"].includes(type)) return response;
  const decoder = new TextDecoder();
  let json = "";
  let jsonBytes = 0;
  let pending = [];
  const collect = raw => {
    if (Buffer.byteLength(raw) > maxMessageBytes) throw new ResponseObservationError();
    let value;
    try { value = JSON.parse(raw); } catch { throw new ResponseObservationError(); }
    for (const item of Array.isArray(value) ? value : [value]) {
      let message;
      try { message = parseJsonRpcMessage(item); } catch { throw new ResponseObservationError(); }
      if (isJsonRpcResponse(message)) pending.push(message);
    }
  };
  const parser = type === "text/event-stream" && createParser({
    maxBufferSize: maxMessageBytes,
    onEvent: event => { if ((!event.event || event.event === "message") && event.data.trim()) collect(event.data); },
    onError: error => {
      if (error.type === "max-buffer-size-exceeded") throw new ResponseObservationError();
      // 非法retry和未知字段不影响来源；Pi仍按原字节解释这些非应答字段。
    },
  });
  const flushResponses = async () => {
    const current = pending;
    pending = [];
    for (const message of current) if (isActive()) await onResponse(message);
  };
  const parseAndSave = async parse => {
    let failure;
    try { parse(); } catch (error) { failure = error; }
    // 同一块后续坏事件不能抹掉已收集的完整答复。
    await flushResponses();
    if (failure) throw failure;
  };
  const body = response.body.pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      await parseAndSave(() => {
        const text = decoder.decode(chunk, { stream: true });
        if (parser) parser.feed(text);
        else {
          jsonBytes += chunk.byteLength;
          if (jsonBytes > maxMessageBytes) throw new ResponseObservationError();
          json += text;
        }
      });
      controller.enqueue(chunk);
    },
    async flush() {
      // 只有正常EOF执行flush；虚拟空行只进入观察parser，原响应字节不变。
      if (isActive()) await parseAndSave(() => {
        if (parser) parser.feed(`${decoder.decode()}\n\n`);
        else collect(json + decoder.decode());
      });
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
