/**
 * 工具工作进程宿主侧：启动、调用、中止、停止与数据流的对接。
 *
 * - 每次工具调用一个 opId；data 帧转发给调用方的产物回调；
 * - 单帧上限与调用超时；写入完成后再发下一帧；
 * - stop() 消费后端的整单元退出核实；local 只覆盖原进程组。
 * Note: 见 .agents/notes/implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md
 */

import * as fs from "node:fs";
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
import { assertNativeFileLinks } from "../execution/native.ts";

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

/** 兼容静态启动入口：失败仍交出持有停止结论的宿主记录。 */
export class WorkerStartError extends ExecutionError {
  constructor(readonly host: ToolWorkerHost, readonly cause: unknown) {
    super(cause instanceof ExecutionError ? cause.code : "worker_start_failed", cause instanceof Error ? cause.message : String(cause),
      undefined, cause instanceof ExecutionError ? cause.reason : undefined);
  }
}

export class ToolWorkerHost {
  private unit: LaunchedUnit | null = null;
  private launchPromise: Promise<LaunchedUnit> | null = null;
  private startPromise: Promise<ToolWorkerHost> | null = null;
  private stopPromise: Promise<boolean> | null = null;
  private buffer = "";
  private pending = new Map<
    string,
    { resolve: (r: WorkerCallResult) => void; reject: (e: Error) => void; onData?: WorkerCallOptions["onData"] }
  >();
  private readyListeners: Array<(msg: WorkerMessage) => void> = [];
  private rejectReady: ((error: ExecutionError) => void) | null = null;
  private stopped = false;
  private childrenReaped: boolean | null = null;
  private stopOutput: Promise<void> | null = null;
  private finishStopOutput: (() => void) | null = null;
  private nativeGrantIdentities: Array<{ path: string; dev: number; ino: number }> = [];
  private writeChain: Promise<void> = Promise.resolve();
  stopFailure: ExecutionError | null = null;
  readonly mode: LaunchSpec["mode"];

  private constructor(readonly launcher: WorkerLauncher, readonly spec: LaunchSpec) {
    this.mode = spec.mode;
  }

  /** 同步建立可停止记录；调用方须先登记，再调用 start。 */
  static create(launcher: WorkerLauncher, spec: LaunchSpec): ToolWorkerHost {
    return new ToolWorkerHost(launcher, spec);
  }

  /** 启动并等待 ready 与 init 发送；失败时 WorkerStartError 保留宿主记录。 */
  static async start(launcher: WorkerLauncher, spec: LaunchSpec): Promise<ToolWorkerHost> {
    const host = ToolWorkerHost.create(launcher, spec);
    try {
      return await host.start();
    } catch (error) {
      throw new WorkerStartError(host, error);
    }
  }

  /** 同一记录只启动一次；启动失败不丢弃单元身份或停止结论。 */
  start(): Promise<ToolWorkerHost> {
    this.startPromise ??= Promise.resolve().then(() => this.startUnit());
    return this.startPromise;
  }

  private async startUnit(): Promise<ToolWorkerHost> {
    if (this.stopped) throw new ExecutionError("worker_stopped", "工具工作进程已停止");
    try {
      if (this.launcher.kind === "native") {
        try {
          this.nativeGrantIdentities = this.spec.grantedPaths.map(grant => {
            const stat = fs.statSync(fs.realpathSync(grant.path));
            return { path: grant.path, dev: stat.dev, ino: stat.ino };
          });
        } catch {
          throw new ExecutionError("execution_unavailable", "原生执行的授权路径身份不可核实；检查目录后重新提交", undefined, "sandbox_rejected");
        }
      }
      try {
        this.launchPromise = this.launcher.launch(this.spec);
        this.unit = await this.launchPromise;
      } catch (error) {
        if (error instanceof ExecutionError && error.unit) this.unit = error.unit;
        throw error;
      }
      if (this.stopped) throw new ExecutionError("worker_stopped", "工具工作进程启动已取消");
      const unit = this.unit;
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new ExecutionError("worker_timeout", "工具工作进程启动超时")), 30_000);
        const finish = (error?: ExecutionError) => {
          clearTimeout(timer);
          this.readyListeners = [];
          this.rejectReady = null;
          if (error) reject(error);
          else resolve();
        };
        this.rejectReady = finish;
        this.readyListeners.push(msg => {
          if (msg.type === "ready") finish();
          else if (msg.type === "fatal") finish(new ExecutionError("worker_fatal", `工作进程启动失败：${msg.message}`));
        });
      });
      unit.stdout.setEncoding("utf8");
      this.stopOutput = new Promise(resolve => { this.finishStopOutput = resolve; });
      unit.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
      unit.stdout.once("end", this.finishStopOutput!);
      unit.stdout.once("close", this.finishStopOutput!);
      unit.stdout.once("error", error => { this.finishStopOutput?.(); this.channelFailed(error); });
      unit.stderr.setEncoding("utf8");
      unit.stderr.on("data", (chunk: string) => process.stderr.write(`[ruukoto:tool-worker ${this.spec.taskId}] ${chunk}`));
      unit.stdin.on("error", error => this.channelFailed(error));
      unit.exit.then(
        () => this.channelFailed(new ExecutionError("worker_exited", "工具工作进程已退出")),
        error => this.channelFailed(error),
      );
      await ready;
      await this.sendRequest({
        type: "init",
        cwd: this.spec.workspace,
        label: this.spec.taskId,
        ...(this.spec.readRoots ? { readRoots: this.spec.readRoots } : {}),
        ...(this.spec.workspaceIdentity ? { workspace: { path: this.spec.workspace, dev: this.spec.workspaceIdentity.dev, ino: this.spec.workspaceIdentity.ino } } : {}),
      });
      if (this.stopped) throw new ExecutionError("worker_stopped", "工具工作进程启动已取消");
      return this;
    } catch (error) {
      await this.stop();
      if (this.launcher.kind === "native" && error instanceof ExecutionError &&
          ["worker_timeout", "worker_fatal", "worker_exited", "worker_channel_failed"].includes(error.code)) {
        // Note: 见 .agents/notes/implemented/architecture/2026-10-12-personal-native-sandbox.md
        throw new ExecutionError("execution_unavailable", "原生边界已启动，但工具工作进程初始化失败；检查运行依赖与构建产物", this.unit ?? undefined, "worker_failed", { cause: error });
      }
      throw error;
    }
  }

  private channelFailed(error: unknown): void {
    const failure = error instanceof ExecutionError ? error : new ExecutionError("worker_channel_failed", error instanceof Error ? error.message : String(error));
    this.rejectReady?.(failure);
    this.failAllPending(failure);
    void this.stop();
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
      case "stopped":
        this.childrenReaped = msg.reaped === true;
        this.finishStopOutput?.();
        break;
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

  /** 发送请求帧；等待写入完成后才允许发送下一帧。 */
  private sendRequest(req: WorkerRequest): Promise<void> {
    if (!this.unit || (this.stopped && req.type !== "shutdown")) throw new ExecutionError("worker_stopped", "工具工作进程已停止");
    const unit = this.unit;
    const line = JSON.stringify(req);
    this.writeChain = this.writeChain.then(() => {
      if (unit.stdin.destroyed || (this.stopped && req.type !== "shutdown")) throw new ExecutionError("worker_stopped", "工具工作进程已停止");
      return new Promise<void>((resolve, reject) => {
        unit.stdin.write(`${line}\n`, error => error ? reject(error) : resolve());
      });
    });
    void this.writeChain.catch(error => this.channelFailed(error));
    return this.writeChain;
  }

  /** 执行一次工具调用；data 帧实时回调。 */
  async call(opts: WorkerCallOptions): Promise<WorkerCallResult> {
    await this.start();
    if (this.stopped) throw new ExecutionError("worker_stopped", "工具工作进程已停止");
    if (opts.signal?.aborted) throw new ExecutionError("tool_aborted", "工具调用已中止");
    if (this.launcher.kind === "native") {
      try {
        const roots = [{ path: this.spec.workspace, ...this.spec.workspaceIdentity }, ...(this.spec.readRoots ?? []), ...this.nativeGrantIdentities];
        for (const root of roots) {
          if (root.dev === undefined || root.ino === undefined) continue;
          const stat = fs.statSync(fs.realpathSync(root.path));
          if (stat.dev !== root.dev || stat.ino !== root.ino) throw new Error("目录身份变化");
        }
        assertNativeFileLinks([
          { path: this.spec.workspace, access: "read_write" },
          ...this.spec.grantedPaths,
          ...(this.spec.readRoots ?? []).map(root => ({ path: root.path, access: "read" as const })),
        ]);
      } catch {
        await this.stop();
        throw new ExecutionError("execution_unavailable", "原生执行的授权目录身份或文件别名已变化，旧单元已请求停止；核实目录后重新提交", undefined, "sandbox_rejected");
      }
    }
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
    try {
      await this.sendRequest({ type: "abort", opId });
    } catch (error) {
      this.channelFailed(error);
    }
  }

  /** 已产生单元的身份；尚未创建时为 null，停止后仍保留。 */
  identity(): { kind: import("../managed-processes.ts").ManagedUnitKind; id: string; label: string } | null {
    return this.unit ? { kind: this.unit.entry.kind, id: this.unit.entry.id, label: this.unit.entry.label } : null;
  }

  /** 并发与重复停止共享结论；false 或异常均保留未核实结果，调用方必须保留占用。 */
  stop(): Promise<boolean> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    const stopped = new ExecutionError("worker_stopped", "工具工作进程正在停止");
    this.rejectReady?.(stopped);
    this.failAllPending(stopped);
    this.stopPromise = this.stopUnit().catch(error => {
      this.stopFailure = error instanceof ExecutionError ? error : new ExecutionError("worker_stop_failed", error instanceof Error ? error.message : String(error));
      process.stderr.write(`[ruukoto:tool-worker] task=${this.spec.taskId} stop=${this.stopFailure.code}；退出未核实，保留占用\n`);
      return false;
    });
    return this.stopPromise;
  }

  private async stopUnit(): Promise<boolean> {
    if (!this.unit && this.launchPromise) {
      try {
        this.unit = await this.launchPromise;
      } catch (error) {
        if (error instanceof ExecutionError && error.unit) this.unit = error.unit;
        else return true;
      }
    }
    const unit = this.unit;
    if (!unit) return true;
    // 启动取消或 launcher 拒绝后的单元可能尚未安装通道监听。
    unit.stdin.on("error", error => this.channelFailed(error));
    try {
      void this.sendRequest({ type: "shutdown" });
    } catch {
      // shutdown 通道可能已经关闭；仍须用单元身份核实停止。
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceful = await Promise.race([
      unit.exit.then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 3000); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!graceful) unit.stdin.destroy();
    const unitReaped = await unit.entry.stop();
    // exit 可先于 stdout 尾帧；通道结束只结束等待，不能替代命令组回执。
    if (unitReaped && this.mode === "full_access" && this.launcher.kind === "local" && this.childrenReaped === null && this.stopOutput) {
      await Promise.race([this.stopOutput, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]);
      if (timer) clearTimeout(timer);
    }
    const reaped = unitReaped && (this.mode !== "full_access" || this.launcher.kind !== "local" || this.childrenReaped === true);
    if (!reaped) this.stopFailure = new ExecutionError("worker_stop_unverified", "无法核实工具执行单元已退出");
    return reaped;
  }
}
