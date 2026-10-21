/** 后台执行复用平台持久身份；会话归属和目录交接由 Runtime 持有。
 * Note: 见 .agents/notes/implemented/feature/2026-10-21-coding-background-processes.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BackgroundExecutionRef } from "@ruukoto/core/background-processes.ts";
import { MAX_FRAME_BYTES, type WorkerMessage } from "../tool-worker/protocol.ts";
import { ExecutionError, type LaunchSpec, type LaunchedUnit } from "./launchers.ts";
import { launchLinuxExecution, stopLinuxExecution } from "./native-linux-identity.ts";
import { launchMacosExecution, stopMacosExecution } from "./native-macos-identity.ts";
import type { PreparedNativeLaunch } from "./native.ts";

export interface PreparedBackgroundExecution {
  directory: string;
  ref: BackgroundExecutionRef;
  input: PreparedNativeLaunch;
  spec: LaunchSpec;
  fingerprint: string;
}

export function backgroundExecutionRef(): BackgroundExecutionRef {
  const executionId = `native_${randomBytes(12).toString("hex")}`;
  if (process.platform === "linux") return { platform: "linux", executionId, machineId: fs.readFileSync("/etc/machine-id", "utf8").trim() };
  if (process.platform === "darwin") return { platform: "darwin", executionId };
  throw new ExecutionError("execution_unavailable", "后台执行只支持已核实的 macOS 或 Linux 平台；请向拥有者报告。");
}

export function prepareBackgroundExecution(directory: string, ref: BackgroundExecutionRef, spec: LaunchSpec): PreparedBackgroundExecution {
  if (spec.mode !== "full_access" || !spec.workspaceIdentity) throw new ExecutionError("background_source_invalid", "后台启动授权或目录身份无效；结束本轮并向拥有者说明。");
  const workerPath = fileURLToPath(new URL("../../../../worker/background-worker.mjs", import.meta.url));
  if (!fs.existsSync(workerPath)) throw new ExecutionError("execution_unavailable", "后台工作进程未构建；请运行 npm run build:worker 后再启动新执行。");
  const tempRoot = `${directory}-work`;
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const tempDir = fs.mkdtempSync(path.join(tempRoot, `${ref.executionId}-`));
  const input: PreparedNativeLaunch = { workspace: spec.workspace, nodePath: fs.realpathSync(process.execPath), workerPath: fs.realpathSync(workerPath), tempDir,
    mounts: [], runtimeReadRoots: [], toolAliases: [], env: {} };
  return { directory, ref, input, spec, fingerprint: createHash("sha256").update(JSON.stringify({ input, spec })).digest("hex") };
}

export async function stopBackgroundExecution(directory: string, ref: BackgroundExecutionRef, fingerprint: string): Promise<{ exited: boolean; outputComplete?: boolean }> {
  if (ref.platform === "linux" && ref.machineId) return stopLinuxExecution(directory, { executionId: ref.executionId, machineId: ref.machineId }, fingerprint);
  if (ref.platform === "darwin") return stopMacosExecution(directory, { executionId: ref.executionId }, fingerprint);
  throw new ExecutionError("execution_identity_invalid", "后台执行身份缺失；保留占用并核实原档案。");
}

export interface BackgroundExecutionObserver {
  data(stream: "stdout" | "stderr", bytes: Buffer): void;
  exit(value: { code: number | null; signal: string | null }): void;
  failed(error: ExecutionError): void;
}

export class BackgroundExecution {
  private buffer = "";
  private stopping = false;
  private stopPromise: Promise<{ exited: boolean; outputComplete?: boolean }> | null = null;
  private stdoutEnded = false;
  private stderrEnded = false;
  private failed = false;
  private outputComplete = false;
  private constructor(readonly prepared: PreparedBackgroundExecution, private readonly unit: LaunchedUnit) {}

  static async launch(prepared: PreparedBackgroundExecution, command: string, opId: string, observer: BackgroundExecutionObserver): Promise<BackgroundExecution> {
    const { directory, ref, input, spec } = prepared;
    const unit = ref.platform === "linux" && ref.machineId
      ? await launchLinuxExecution(directory, { executionId: ref.executionId, machineId: ref.machineId }, input, spec)
      : await launchMacosExecution(directory, { executionId: ref.executionId }, input, spec);
    const execution = new BackgroundExecution(prepared, unit);
    let resolveStart!: () => void;
    let rejectStart!: (error: ExecutionError) => void;
    const started = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    const failure = (error: unknown): void => {
      if (execution.failed || execution.stopping) return;
      execution.failed = true;
      const typed = error instanceof ExecutionError ? error : new ExecutionError("background_worker_failed", "后台执行通道异常；保留日志并核实停止。", undefined, undefined, { cause: error });
      rejectStart(typed);
      observer.failed(typed);
    };
    const timer = setTimeout(() => failure(new ExecutionError("background_start_timeout", "后台命令启动核实超时；保留记录并查询停止状态。")), 10_000);
    unit.stdin.on("error", failure);
    unit.stdout.setEncoding("utf8");
    unit.stdout.on("data", (chunk: string) => {
      execution.buffer += chunk;
      if (Buffer.byteLength(execution.buffer) > MAX_FRAME_BYTES * 2) { failure(new ExecutionError("background_frame_invalid", "后台输出帧超限；已请求停止。")); return; }
      for (;;) {
        const end = execution.buffer.indexOf("\n");
        if (end < 0) break;
        const line = execution.buffer.slice(0, end);
        execution.buffer = execution.buffer.slice(end + 1);
        try {
          if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new ExecutionError("background_frame_invalid", "后台输出帧超限；已请求停止。");
          const message = JSON.parse(line) as WorkerMessage;
          if (message.type === "ready") {
            unit.stdin.write(JSON.stringify({ type: "init", cwd: spec.workspace, label: spec.taskId, workspace: { path: spec.workspace, ...spec.workspaceIdentity } }) + "\n" +
              JSON.stringify({ type: "tool_call", opId, sdkCallId: opId, name: "process_start", params: { command } }) + "\n");
          } else if (message.type === "process_started" && message.opId === opId) resolveStart();
          else if (message.type === "process_output_complete" && message.opId === opId) execution.outputComplete = true;
          else if (message.type === "data" && message.opId === opId && (message.stream === "stdout" || message.stream === "stderr") && typeof message.chunk === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.chunk)) {
            observer.data(message.stream, Buffer.from(message.chunk, "base64"));
          } else if (message.type === "result" && message.opId === opId) {
            const exit = message.details as { code?: unknown; signal?: unknown } | undefined;
            if (!message.ok || !exit || (exit.code !== null && !Number.isInteger(exit.code)) || (exit.signal !== null && typeof exit.signal !== "string")) throw new ExecutionError("background_command_failed", "后台命令未取得退出观察；查询停止核实并向拥有者报告。");
            observer.exit({ code: exit.code as number | null, signal: exit.signal as string | null });
          } else throw new ExecutionError("background_frame_invalid", "后台输出协议无法核实；已请求停止。");
        } catch (error) { failure(error); }
      }
    });
    unit.stderr.on("data", (bytes: Buffer) => { try { observer.data("stderr", Buffer.from(bytes)); } catch (error) { failure(error); } });
    unit.stdout.once("end", () => { execution.stdoutEnded = true; });
    unit.stderr.once("end", () => { execution.stderrEnded = true; });
    unit.stdout.once("error", failure);
    unit.stderr.once("error", failure);
    void unit.exit.then(() => { if (!execution.stopping) failure(new ExecutionError("background_worker_exited", "后台执行入口已退出；正在核实整个执行单元停止。")); }, failure);
    try { await started; return execution; }
    catch (error) {
      execution.stopping = true;
      await unit.entry.stop();
      throw error;
    } finally { clearTimeout(timer); }
  }

  stop(): Promise<{ exited: boolean; outputComplete?: boolean }> {
    if (this.stopPromise) return this.stopPromise;
    const operation = (async () => {
      this.stopping = true;
      const stopped = await this.unit.entry.stop();
      const deadline = Date.now() + 3000;
      while (stopped && (!this.stdoutEnded || !this.stderrEnded) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      const proof = await stopBackgroundExecution(this.prepared.directory, this.prepared.ref, this.prepared.fingerprint);
      return { ...proof, exited: stopped && proof.exited && this.stdoutEnded && this.stderrEnded, outputComplete: proof.outputComplete !== false && this.outputComplete && this.buffer.length === 0 && !this.failed };
    })();
    this.stopPromise = operation;
    void operation.then(result => { if (!result.exited && this.stopPromise === operation) this.stopPromise = null; }, () => { if (this.stopPromise === operation) this.stopPromise = null; });
    return operation;
  }
}
