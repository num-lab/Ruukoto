import type { Writable } from "node:stream";

export const SCRIPT_LIMITS = {
  scriptBytes: 128 * 1024,
  frameBytes: 1024 * 1024,
  queuedBytes: 4 * 1024 * 1024,
  pendingCalls: 32,
  progressCalls: 256,
  progressBytes: 256 * 1024,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  cpuMs: 10_000,
} as const;

export type ScriptPrimitive = "agent" | "ask" | "integrate" | "progress";
export interface ScriptCall { id: number; method: ScriptPrimitive; key: string; params: unknown }
export type ScriptRequest =
  | { type: "start"; seq: number; script: string; input: unknown; cpuMs: number }
  | { type: "reply"; seq: number; id: number; value: unknown; error?: { code: string; message: string } };
export type ScriptMessage =
  | { type: "ready" }
  | { type: "call"; call: ScriptCall }
  | { type: "idle"; seq: number }
  | { type: "done"; value: unknown }
  | { type: "fatal"; code: string };

export class ScriptExecutionError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(`工作流脚本执行失败：${code}`, options); }
}

/** 仅用于可交给脚本处理的步骤拒绝；授权或协议错误须终止运行。 */
export class ScriptCallError extends Error {
  constructor(readonly code: string) { super(`工作流步骤拒绝：${code}`); }
}

export function frame(value: unknown): Buffer {
  let json: string | undefined;
  let bytes = 0;
  try {
    json = JSON.stringify(value, (key, item: unknown) => {
      if (key.length > SCRIPT_LIMITS.frameBytes || (typeof item === "string" && item.length > SCRIPT_LIMITS.frameBytes)) throw new ScriptExecutionError("script_frame_limit");
      bytes += Buffer.byteLength(key) + (typeof item === "string" ? Buffer.byteLength(item) : 1);
      if (bytes > SCRIPT_LIMITS.frameBytes) throw new ScriptExecutionError("script_frame_limit");
      return item;
    });
  } catch (error) {
    throw error instanceof ScriptExecutionError ? error : new ScriptExecutionError("script_value_invalid", {cause:error});
  }
  if (json === undefined || Buffer.byteLength(json) > SCRIPT_LIMITS.frameBytes) throw new ScriptExecutionError("script_frame_limit");
  return Buffer.from(json + "\n");
}

// 背压之外限制排队总字节，不能无限保留尚未写入的帧。
export class ScriptWriter {
  private chain = Promise.resolve();
  private bytes = 0;
  constructor(private output: Writable) {}
  send(value: unknown): Promise<void> {
    const data = frame(value);
    if (this.bytes + data.length > SCRIPT_LIMITS.queuedBytes) throw new ScriptExecutionError("script_queue_limit");
    this.bytes += data.length;
    const write = this.chain.then(() => new Promise<void>((resolve, reject) => {
      this.output.write(data, error => error ? reject(error) : resolve());
    }));
    this.chain = write.finally(() => { this.bytes -= data.length; });
    return this.chain;
  }
}

export function readScriptFrames(input: NodeJS.ReadableStream, receive: (value: unknown) => void, fail: (error: unknown) => void): void {
  let buffer = Buffer.alloc(0);
  let failed = false;
  input.on("data", (chunk: Buffer) => {
    if (failed) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const part = chunk.subarray(offset, end === -1 ? chunk.length : end);
        if (buffer.length + part.length > SCRIPT_LIMITS.frameBytes) throw new ScriptExecutionError("script_frame_limit");
        buffer = Buffer.concat([buffer, part]);
        if (end === -1) break;
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
        catch { throw new ScriptExecutionError("script_protocol"); }
        buffer = Buffer.alloc(0);
        receive(value);
        offset = end + 1;
      }
    } catch (error) { failed = true; fail(error); }
  });
  input.on("error", fail);
  input.on("end", () => fail(new ScriptExecutionError(buffer.length ? "script_protocol" : "script_channel_closed")));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isScriptCall(value: unknown): value is ScriptCall {
  return isRecord(value) && Number.isSafeInteger(value.id) && Number(value.id) > 0 &&
    typeof value.method === "string" && ["agent", "ask", "integrate", "progress"].includes(value.method) &&
    typeof value.key === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.key) && "params" in value;
}
