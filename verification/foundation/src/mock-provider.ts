/**
 * 本地 OpenAI Chat Completions 兼容 mock 服务。
 *
 * 用途：不依赖真实模型、不联网，即可驱动 pi coding-agent SDK 完成确定性验证。
 * 服务端记录每次请求收到的完整 messages（即"模型本轮实际输入"），并按
 * responder 脚本返回文本或工具调用。SSE 分块格式对齐 pi-ai openai-completions
 * 的解析器（需要 finish_reason 分块与 usage 分块，最后 [DONE]）。
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>> | undefined;
  system: string | null;
  raw: any;
}

export interface TextResponse {
  kind: "text";
  text: string;
}

export interface ToolCallResponse {
  kind: "tool_calls";
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export type MockResponse = TextResponse | ToolCallResponse;

export type Responder = (req: RecordedRequest, callIndex: number) => MockResponse | Promise<MockResponse>;

const CHUNK_ID = "chatcmpl-mock";
const CREATED = 1700000000;

function chunk(model: string, delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id: CHUNK_ID,
    object: "chat.completion.chunk",
    created: CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function usageChunk(model: string, promptTokens: number, completionTokens: number) {
  return {
    id: CHUNK_ID,
    object: "chat.completion.chunk",
    created: CREATED,
    model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/** 从请求体提取 system 与 messages（对齐 openai-completions 的转换结果）。 */
function extract(body: any): RecordedRequest {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages.find((m: any) => m.role === "system" || m.role === "developer") ?? null;
  const rest = messages.filter((m: any) => m !== system);
  return {
    messages: rest,
    tools: Array.isArray(body?.tools) ? body.tools : undefined,
    system: system ? (system.content ?? null) : null,
    raw: body,
  };
}

function sseBody(responses: string[]): string {
  return responses.map((r) => `data: ${r}\n\n`).join("") + "data: [DONE]\n\n";
}

export class MockModelServer {
  private server: http.Server;
  private respond: Responder;
  private counter = 0;
  /** 每次模型调用收到的一份输入（按调用顺序）。 */
  readonly calls: RecordedRequest[] = [];

  constructor(responder: Responder) {
    this.respond = responder;
    this.server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const recorded = extract(body);
          this.calls.push(recorded);
          const scripted = await this.respond(recorded, this.counter++);

          const out: string[] = [];
          out.push(JSON.stringify(chunk("mock-model", { role: "assistant", content: "" }, null)));

          if (scripted.kind === "text") {
            for (const piece of scripted.text.match(/.{1,16}/gs) ?? []) {
              out.push(JSON.stringify(chunk("mock-model", { content: piece }, null)));
            }
            out.push(JSON.stringify(chunk("mock-model", {}, "stop")));
          } else {
            for (const call of scripted.calls) {
              const delta = {
                tool_calls: [
                  {
                    index: 0,
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  },
                ],
              };
              out.push(JSON.stringify(chunk("mock-model", delta, null)));
            }
            out.push(JSON.stringify(chunk("mock-model", {}, "tool_calls")));
          }
          out.push(JSON.stringify(usageChunk("mock-model", 100, 10)));

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.end(sseBody(out));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: String(err) } }));
        }
      });
    });
  }

  /** 返回 provider baseUrl（http://127.0.0.1:<port>/v1）。 */
  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const port = (this.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}/v1`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
