/**
 * 工具工作进程宿主侧：启动、调用、中止、停止与数据流的对接。
 *
 * - 每次工具调用一个 opId；data 帧转发给调用方的产物回调；
 * - 单帧上限与调用超时；写入侧背压（drain 后再发下一帧）；
 * - stop() 停止整个执行单元（进程组/容器）并核实退出——这是"停止并核实
 *   旧执行单元及其后代进程已退出"的实现点。
 */

import {
  MAX_FRAME_BYTES,
  type DataStream,
  type WorkerMessage,
  type WorkerRequest,
} from "./protocol.ts";
import {
  ExecutionError,
  type LaunchSpec,
  type LaunchedUnit,
  type WorkerLauncher,
} from "../execution/launchers.ts";

export interface WorkerCallOptions {
  opId: string;
  sdkCallId: string;
  name: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  /** 原始数据回调（在后台落产物；这里不关心模型视图）。 */
  onData?: (stream: DataStream, chunk: Buffer) => void;
  signal?: AbortSignal;
}

export interface WorkerCallResult {
  ok: boolean;
  content: unknown[];
  details?: unknown;
  isError: boolean;
  errorMessage?: string;
}

export class ToolWorkerHost {
  private unit: LaunchedUnit | null = null;
  private buffer = "";
  private pending = new Map<
    string,
    { resolve: (r: WorkerCallResult) => void; reject: (e: Error) => void; onData?: WorkerCallOptions["onData"] }
  >();
  private readyPromise: Promise<void>;
  private readyListeners: Array<(msg: WorkerMessage) => void> = [];
  private stopped = false;
  private writeChain: Promise<void> = Promise.resolve();
  readonly mode: LaunchSpec["mode"];

  private constructor(
    readonly launcher: WorkerLauncher,
    readonly spec: LaunchSpec,
    private readonly unitResolved: LaunchedUnit,
    private readonly exitInfo: LaunchedUnit["exit"],
  ) {
    this.unit = unitResolved;
    this.mode = spec.mode;
    unitResolved.stdout.setEncoding("utf8");
    unitResolved.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    unitResolved.stderr.setEncoding("utf8");
    unitResolved.stderr.on("data", (chunk: string) => {
      // 工作进程诊断输出：仅记录到后台进程 stderr，不进入任务数据
      process.stderr.write(`[tool-worker ${spec.taskId}] ${chunk}`);
    });
    unitResolved.exit.then(() => {
      // 通道关闭：所有在途调用按失败收尾（结果缺失由调用方按效果未知处理）
      this.failAllPending(new ExecutionError("worker_exited", "工具工作进程已退出"));
    });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ExecutionError("worker_timeout", "工具工作进程启动超时")), 30_000);
      const onFrame = (msg: WorkerMessage) => {
        if (msg.type === "ready") {
          clearTimeout(timer);
          resolve();
        } else if (msg.type === "fatal") {
          clearTimeout(timer);
          reject(new ExecutionError("worker_fatal", `工作进程启动失败：${msg.message}`));
        }
      };
      this.readyListeners.push(onFrame);
    });
  }

  /** 启动并等待 ready。 */
  static async start(launcher: WorkerLauncher, spec: LaunchSpec): Promise<ToolWorkerHost> {
    const unit = await launcher.launch(spec);
    const host = new ToolWorkerHost(launcher, spec, unit, unit.exit);
    try {
      await host.readyPromise;
    } catch (err) {
      // ready 失败（超时/fatal）：回收执行单元后再抛错，不留孤儿容器/进程组
      host.stopped = true;
      host.unit = null;
      await unit.entry.stop().catch(() => false);
      throw err;
    }
    host.readyListeners = [];
    // 容器按宿主原路径挂载工作区，各启动器的工作目录都是工作区本身
    host.sendRequest({ type: "init", cwd: spec.workspace, label: spec.taskId });
    return host;
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        this.failAllPending(new ExecutionError("frame_too_large", "工作进程帧超限"));
        void this.stop();
        return;
      }
      this.handleFrame(line);
    }
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.failAllPending(new ExecutionError("frame_too_large", "工作进程帧缓冲超限"));
      void this.stop();
    }
  }

  private handleFrame(line: string): void {
    let msg: WorkerMessage;
    try {
      msg = JSON.parse(line) as WorkerMessage;
    } catch {
      return;
    }
    if (this.readyListeners.length > 0) {
      for (const listener of this.readyListeners) listener(msg);
    }
    switch (msg.type) {
      case "data": {
        const waiter = this.pending.get(msg.opId);
        waiter?.onData?.(msg.stream, Buffer.from(msg.chunk, "base64"));
        break;
      }
      case "result": {
        const waiter = this.pending.get(msg.opId);
        if (!waiter) break;
        this.pending.delete(msg.opId);
        waiter.resolve({
          ok: msg.ok,
          content: msg.content ?? [],
          details: msg.details,
          isError: Boolean(msg.isError),
          errorMessage: msg.errorMessage,
        });
        break;
      }
      case "fatal":
        this.failAllPending(new ExecutionError("worker_fatal", msg.message));
        void this.stop();
        break;
      default:
        break;
    }
  }

  private failAllPending(err: Error): void {
    for (const [, waiter] of this.pending) waiter.reject(err);
    this.pending.clear();
  }

  /** 发送请求帧；stdout 背压时排队等待 drain。 */
  private sendRequest(req: WorkerRequest): void {
    if (this.stopped || !this.unit) throw new ExecutionError("worker_stopped", "工具工作进程已停止");
    // 绑定时捕获 unit：排队期间 stop() 可能已置空，回调必须写原句柄并跳过已销毁的通道
    const unit = this.unit;
    const line = JSON.stringify(req);
    this.writeChain = this.writeChain.then(async () => {
      if (unit.stdin.destroyed) return;
      const ok = unit.stdin.write(`${line}\n`);
      if (!ok) {
        await new Promise<void>((resolve) => unit.stdin.once("drain", resolve));
      }
    });
  }

  /** 执行一次工具调用；data 帧实时回调。 */
  async call(opts: WorkerCallOptions): Promise<WorkerCallResult> {
    await this.readyPromise;
    if (this.stopped) throw new ExecutionError("worker_stopped", "工具工作进程已停止");
    return new Promise<WorkerCallResult>((resolve, reject) => {
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            this.pending.delete(opts.opId);
            void this.abort(opts.opId);
            reject(new ExecutionError("tool_timeout", `工具调用超时（${opts.timeoutMs}ms）`));
          }, opts.timeoutMs)
        : undefined;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        this.pending.delete(opts.opId);
        void this.abort(opts.opId);
        reject(new ExecutionError("tool_aborted", "工具调用已中止"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(opts.opId, {
        resolve: (r) => {
          if (timer) clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(r);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
        onData: opts.onData,
      });
      this.sendRequest({
        type: "tool_call",
        opId: opts.opId,
        sdkCallId: opts.sdkCallId,
        name: opts.name,
        params: opts.params,
        timeoutMs: opts.timeoutMs,
      });
    });
  }

  /** 中止一个在途调用（工具执行停止，但工作进程保留）。 */
  async abort(opId: string): Promise<void> {
    if (this.stopped || !this.unit) return;
    this.sendRequest({ type: "abort", opId });
  }

  /** 标识（容器名、systemd 单元或进程组 id），用于登记与诊断。 */
  identity(): { kind: import("../managed-processes.ts").ManagedUnitKind; id: string; label: string } {
    return { kind: this.unit!.entry.kind, id: this.unit!.entry.id, label: this.unit!.entry.label };
  }

  /** 停止整个执行单元并核实退出；返回 false 表示无法确认（调用方必须保留占用）。 */
  async stop(): Promise<boolean> {
    if (!this.unit) return true;
    const unit = this.unit;
    this.stopped = true;
    try {
      this.sendRequest({ type: "shutdown" });
    } catch {
      // 通道可能已断
    }
    this.unit = null;
    this.failAllPending(new ExecutionError("worker_stopped", "工具工作进程正在停止"));
    // 给工作进程一个优雅退出窗口，然后强制停止执行单元
    const graceful = await Promise.race([
      this.exitInfo.then(() => true as const),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    if (!graceful) {
      try {
        unit.stdin.destroy();
      } catch {
        // 已关闭
      }
    }
    const reaped = await unit.entry.stop();
    return reaped;
  }
}
