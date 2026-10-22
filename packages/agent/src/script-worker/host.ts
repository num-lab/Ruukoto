/** 固定 QuickJS 编排入口；步骤能力仅经注入回调提供，停止结果由调用方归档。 */
// Note: 见 .agents/notes/implemented/architecture/2026-10-13-workflow-script-isolation.md
// Note: 见 .agents/notes/implemented/bug-fix/2026-10-22-workflow-host-idle-dispatch.md
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ExecutionError, type LaunchedUnit } from "../execution/launchers.ts";
import { killProcessGroup, type ManagedEntry } from "../managed-processes.ts";
import { SCRIPT_LIMITS, ScriptExecutionError, ScriptCallError, ScriptWriter, frame, readScriptFrames, isRecord, isScriptCall, type ScriptCall, type ScriptRequest } from "./protocol.ts";

export function launchScriptProcess(label: string): Promise<LaunchedUnit> {
  const entry = fileURLToPath(new URL("../../../../worker/workflow-script.mjs", import.meta.url));
  if (!fs.existsSync(entry)) return Promise.reject(new ScriptExecutionError("script_entry_missing"));
  const child = spawn(process.execPath, ["--max-old-space-size=64", entry], {
    cwd: fileURLToPath(new URL("../../../../worker/", import.meta.url)), env: { LANG: "C.UTF-8" }, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new ScriptExecutionError("script_launch_failed")));
    child.once("spawn", () => {
      const pid = child.pid!;
      resolve({ entry: { kind: "process_group", id: String(pid), label,
        stop: () => killProcessGroup(pid, { termGraceMs: 100, killGraceMs: 1000 }) },
        stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!,
        exit: new Promise(done => child.once("close", (code, signal) => done({ code, signal }))),
      });
    });
  });
}

export class WorkflowScriptHost {
  private launchPromise: Promise<LaunchedUnit> | undefined;
  private unit: LaunchedUnit | undefined;
  private stopPromise: Promise<boolean> | undefined;
  private writer: ScriptWriter | undefined;
  private stopped = false;
  private started = false;
  private rejectRun: ((error: unknown) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activeSince: number | undefined;
  private onActivity: ((active: boolean) => void) | undefined;
  private usedMs = 0;
  private seq = 0;
  private cpuMs = SCRIPT_LIMITS.cpuMs as number;
  private controller = new AbortController();
  private calls = new Set<number>();
  private lastId = 0;
  private readonly startingId = randomUUID();
  private completed = false;
  stopFailure: ScriptExecutionError | undefined;
  output: unknown;

  constructor(readonly label: string, private launch: () => Promise<LaunchedUnit> = () => launchScriptProcess(label)) {}

  /** 先登记此占位，再运行；实际单元身份在停止后仍可查。 */
  entry(): ManagedEntry { return { kind: "starting", id: this.startingId, label: this.label, stop: () => this.stop() }; }
  identity(): ManagedEntry | undefined { return this.unit ? { ...this.unit.entry, stop: () => this.stop() } : undefined; }

  private fail(error: unknown) {
    if (this.completed && error instanceof ScriptExecutionError && error.code === "script_channel_closed") return;
    this.rejectRun?.(error);
    void this.stop();
  }

  private armTimer() {
    clearTimeout(this.timer);
    if (this.activeSince === undefined) {
      this.activeSince = performance.now();
      this.onActivity?.(true);
    }
    const remaining = this.cpuMs - this.usedMs - (performance.now() - this.activeSince);
    this.timer = setTimeout(() => this.fail(new ScriptExecutionError("script_cpu_limit")), Math.max(1, remaining));
  }

  private send(request: ScriptRequest) {
    if (this.stopped) return;
    this.armTimer();
    try { void this.writer!.send(request).catch(error => this.fail(error)); }
    catch (error) { this.fail(error); }
  }

  /** 成功须核实进程正常退出；失败仍保留 output、identity 与 stopFailure，调用方负责名下步骤的停止。 */
  async run(script: string, input: unknown, invoke: (call: ScriptCall, signal: AbortSignal) => Promise<unknown>,
    options: { signal?: AbortSignal; cpuMs?: number; onIdentity?: (entry: ManagedEntry) => void; onActivity?: (active: boolean) => void } = {}): Promise<{ value: unknown; reaped: boolean }> {
    if (this.started || this.stopped) throw new ScriptExecutionError("script_stopped");
    if (typeof script !== "string" || Buffer.byteLength(script) > SCRIPT_LIMITS.scriptBytes) throw new ScriptExecutionError("script_source_limit");
    this.cpuMs = options.cpuMs ?? SCRIPT_LIMITS.cpuMs;
    if (!Number.isInteger(this.cpuMs) || this.cpuMs <= 0 || this.cpuMs > SCRIPT_LIMITS.cpuMs) throw new ScriptExecutionError("script_invalid_limit");
    const start: ScriptRequest = { type: "start", seq: 1, script, input, cpuMs: this.cpuMs };
    frame(start);
    this.started = true;
    this.onActivity = options.onActivity;
    const onAbort = () => this.fail(new ScriptExecutionError("script_canceled"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let resolveRun!: (value: unknown) => void;
    const result = new Promise<unknown>((resolve, reject) => { resolveRun = resolve; this.rejectRun = reject; });
    // 启动 Promise 尚未结束时也接住取消；原错误仍由 run 消费。
    void result.catch(() => undefined);
    // ready 之前同样有父进程时限，覆盖加载 WASM 和启动期间取消。
    this.timer = setTimeout(() => this.fail(new ScriptExecutionError("script_start_timeout")), 10_000);
    if (options.signal?.aborted) onAbort();
    try {
      if (!this.stopped) {
        try {
          this.launchPromise = this.launch();
          this.unit = await this.launchPromise;
          options.onIdentity?.(this.identity()!);
        }
        catch (error) {
          if (error instanceof ExecutionError && error.unit) this.unit = error.unit;
          throw error;
        }
        if (!this.stopped) {
          this.writer = new ScriptWriter(this.unit.stdin);
          this.unit.stdin.on("error", error => this.fail(error));
          let stderrBytes = 0;
          this.unit.stderr.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > SCRIPT_LIMITS.progressBytes) this.fail(new ScriptExecutionError("script_stderr_limit"));
          });
          this.unit.exit.then(status => {
            if (this.completed && status.code === 0 && status.signal === null) resolveRun(this.output);
            else this.fail(new ScriptExecutionError("script_exited"));
          }, error => this.fail(error));
          let ready = false;
          const queuedCalls: ScriptCall[] = [];
          readScriptFrames(this.unit.stdout, value => {
            if (this.stopped) return;
            if (!isRecord(value)) throw new ScriptExecutionError("script_protocol");
            if (this.completed) throw new ScriptExecutionError("script_protocol");
            if (value.type === "ready" && !ready) {
              ready = true;
              this.seq = 1;
              this.send(start);
            } else if (value.type === "call" && ready && isScriptCall(value.call)) {
              const call = value.call;
              if (this.activeSince === undefined || call.id !== this.lastId + 1 || this.calls.size >= SCRIPT_LIMITS.pendingCalls) throw new ScriptExecutionError("script_protocol");
              this.lastId = call.id;
              this.calls.add(call.id);
              queuedCalls.push(call);
            } else if (value.type === "idle" && ready && Number.isSafeInteger(value.seq) && Number(value.seq) <= this.seq && Number(value.seq) > 0) {
              if (value.seq === this.seq && this.activeSince !== undefined) {
                if (this.calls.size === 0) throw new ScriptExecutionError("script_protocol");
                this.usedMs += performance.now() - this.activeSince;
                this.activeSince = undefined;
                clearTimeout(this.timer);
                this.onActivity?.(false);
                for (const call of queuedCalls.splice(0)) {
                  void Promise.resolve().then(() => {
                    if (this.stopped) return;
                    return invoke(call, this.controller.signal);
                  }).then(reply => {
                    if (this.stopped) return;
                    this.calls.delete(call.id);
                    this.send({ type: "reply", seq: ++this.seq, id: call.id, value: reply });
                  }, error => {
                    if (this.stopped) return;
                    this.calls.delete(call.id);
                    if (!(error instanceof ScriptCallError)) {
                      this.fail(error instanceof ScriptExecutionError ? error : new ScriptExecutionError("script_host_failed", {cause:error}));
                      return;
                    }
                    this.send({ type: "reply", seq: ++this.seq, id: call.id, value: null, error: { code: error.code, message: error.message } });
                  });
                }
              }
            } else if (value.type === "done" && ready && "value" in value && this.calls.size === 0) {
              this.output = value.value;
              this.completed = true;
              // 完成帧后仍计时，等通道排空和进程退出才接受结果。
              this.armTimer();
            } else if (value.type === "fatal" && typeof value.code === "string") throw new ScriptExecutionError(value.code);
            else throw new ScriptExecutionError("script_protocol");
          }, error => this.fail(error));
        }
      }
      const value = await result;
      const reaped = await this.stop();
      if (!reaped) throw this.stopFailure;
      return { value, reaped };
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      clearTimeout(this.timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.rejectRun = undefined;
      this.onActivity = undefined;
    }
  }

  /** 重复停止共享核实结果；false 保留单元身份与失败原因。 */
  stop(): Promise<boolean> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller.abort();
    this.rejectRun?.(new ScriptExecutionError("script_stopped"));
    this.stopPromise = (async () => {
      if (!this.unit && this.launchPromise) {
        try { this.unit = await this.launchPromise; }
        catch (error) {
          if (error instanceof ExecutionError && error.unit) this.unit = error.unit;
          else return true; // 启动器拒绝时尚未创建单元。
        }
      }
      if (!this.unit) return true;
      this.unit.stdin.destroy();
      const reaped = await this.unit.entry.stop();
      if (!reaped) this.stopFailure = new ScriptExecutionError("script_stop_unverified");
      return reaped;
    })().catch(error => {
      this.stopFailure = new ScriptExecutionError("script_stop_unverified", {cause:error});
      process.stderr.write(`[ruukoto:workflow-script] stop=script_stop_unverified；退出未核实，保留执行身份\n`);
      return false;
    });
    return this.stopPromise;
  }
}
