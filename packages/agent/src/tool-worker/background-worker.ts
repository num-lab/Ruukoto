/** 独立命令只接纳一次；整个执行的停止与恢复由平台监督器核实。
 * Note: 见 .agents/notes/implemented/feature/2026-10-21-coding-background-processes.md
 */
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { DATA_CHUNK_BYTES, MAX_FRAME_BYTES, type WorkerMessage, type WorkerRequest } from "./protocol.ts";

let writes = Promise.resolve();
let initialized = false;
let dispatched = false;
let buffer = "";
let shutdownRequested = false;
let outputComplete = false;

function shutdown(): void {
  shutdownRequested = true;
  if (!dispatched || outputComplete) void writes.then(() => process.exit(0), fail);
}

function send(message: WorkerMessage): Promise<void> {
  writes = writes.then(() => new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(message) + "\n", error => error ? reject(error) : resolve());
  }));
  void writes.catch(fail);
  return writes;
}

function fail(error: unknown): void {
  process.stderr.write(`[ruukoto:background-worker] 执行通道失败：${error instanceof Error ? error.message : "未知错误"}\n`);
  process.exit(125);
}

function handle(request: WorkerRequest): void {
  if (request.type === "shutdown" || request.type === "abort") { shutdown(); return; }
  if (request.type === "init") {
    if (initialized || !request.workspace || request.cwd !== request.workspace.path || process.cwd() !== request.cwd) throw new Error("后台工作目录输入无效");
    const current = fs.statSync(".");
    const target = fs.statSync(fs.realpathSync(request.cwd));
    if (!current.isDirectory() || !target.isDirectory() || fs.realpathSync(request.cwd) !== request.cwd || current.dev !== request.workspace.dev || current.ino !== request.workspace.ino || target.dev !== current.dev || target.ino !== current.ino) throw new Error("后台工作目录身份已变化，未启动命令");
    initialized = true;
    return;
  }
  if (request.type !== "tool_call" || request.name !== "process_start" || !initialized || dispatched || typeof request.opId !== "string" || !request.opId || typeof request.params.command !== "string" || !request.params.command.trim() || request.params.command.length > 16384 || request.params.command.includes("\0")) throw new Error("后台命令输入无效或已经派发");
  dispatched = true;
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", request.params.command], { stdio: ["ignore", "pipe", "pipe"] });
  child.once("spawn", () => { void send({ type: "process_started", opId: request.opId }); });
  child.once("error", error => { void send({ type: "result", opId: request.opId, ok: false, content: [], isError: true, errorMessage: error.message }); });
  for (const [stream, pipe] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
    pipe.on("data", (bytes: Buffer) => {
      pipe.pause();
      for (let offset = 0; offset < bytes.length; offset += DATA_CHUNK_BYTES) {
        void send({ type: "data", opId: request.opId, stream, chunk: bytes.subarray(offset, offset + DATA_CHUNK_BYTES).toString("base64") });
      }
      void writes.then(() => pipe.resume(), fail);
    });
    pipe.once("error", fail);
  }
  // 主命令退出只是一项观察；平台仍须回收继承管道的后代。
  child.once("exit", (code, signal) => { void send({ type: "result", opId: request.opId, ok: true, content: [], details: { code, signal } }); });
  child.once("close", () => {
    void send({ type: "process_output_complete", opId: request.opId }).then(() => {
      outputComplete = true;
      if (shutdownRequested) shutdown();
    });
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { fail(new Error("后台请求帧超限")); return; }
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try { handle(JSON.parse(line) as WorkerRequest); }
    catch (error) { fail(error); }
  }
});
process.stdin.once("end", shutdown);
process.stdin.once("error", fail);
process.stdout.once("error", fail);
process.on("SIGTERM", shutdown);
void send({ type: "ready", pid: process.pid });
