/** 会话后台在任务终态后继续持有目录；未核实停止时保留原执行和现场。
 * Note: 见 .agents/notes/implemented/feature/2026-10-21-coding-background-processes.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, type Hash } from "node:crypto";
import type { Store } from "@ruukoto/core/store.ts";
import type { HostToolContext } from "@ruukoto/agent/host-tool-families.ts";
import { BackgroundExecution, backgroundExecutionRef, prepareBackgroundExecution, stopBackgroundExecution } from "@ruukoto/agent/execution/background.ts";
import { ExecutionError, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import { BackgroundProcessError, backgroundProcessToView, claimBackgroundLaunch, closeSessionBackgroundBarrier, findBackgroundProcessByOp, finishBackgroundStop,
  getBackgroundProcess, handoffBackgroundProcess, listActiveBackgroundProcesses, registerBackgroundProcess, requestBackgroundStop, updateBackgroundObserved,
  type BackgroundProcess, type BackgroundProcessView } from "@ruukoto/core/background-processes.ts";
import type { AgentReferenceSnapshot } from "@ruukoto/core/agent-wait.ts";

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const PAGE_BYTES = 32 * 1024;
interface BackgroundDeps {
  store: Store;
  dataDir: string;
  handoff(taskId: string, transfer: (snapshot: AgentReferenceSnapshot) => void): Promise<boolean>;
  restore(taskId: string): Promise<boolean>;
  sourceProblem(process: BackgroundProcess): string | null;
  released(): void;
}
interface Capture { stdout: number; stderr: number; hashes: { stdout: Hash; stderr: Hash } }

export class RuntimeBackgroundProcesses {
  private readonly directory: string;
  private readonly logs: string;
  private readonly units = new Map<string, BackgroundExecution>();
  private readonly starts = new Map<string, Promise<BackgroundProcessView>>();
  private readonly stops = new Map<string, Promise<void>>();
  private readonly captures = new Map<string, Capture>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  constructor(private readonly deps: BackgroundDeps) {
    const dataDir = fs.realpathSync(deps.dataDir);
    this.directory = path.join(dataDir, "background-executions");
    this.logs = path.join(dataDir, "background-logs");
    for (const directory of [this.directory, this.logs]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.privateObject(directory, true);
    }
  }

  private privateObject(target: string, directory: boolean): fs.Stats {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new BackgroundProcessError("background_evidence_invalid", "后台证据归属无法核实；保留占用并检查原档案。");
    return stat;
  }

  private require(id: string, sessionId?: string): BackgroundProcess {
    const record = getBackgroundProcess(this.deps.store, id);
    if (!record || (sessionId !== undefined && record.sessionId !== sessionId)) throw new BackgroundProcessError("background_not_found", "本会话没有该后台执行；先查询本会话后台清单。");
    return record;
  }

  private capture(record: BackgroundProcess): Capture {
    const directory = path.join(this.logs, record.id);
    fs.mkdirSync(directory, { mode: 0o700 });
    this.privateObject(directory, true);
    const capture: Capture = { stdout: -1, stderr: -1, hashes: { stdout: createHash("sha256"), stderr: createHash("sha256") } };
    try {
      for (const stream of ["stdout", "stderr"] as const) capture[stream] = fs.openSync(path.join(directory, stream), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      for (const fd of [capture.stdout, capture.stderr]) if (fd >= 0) fs.closeSync(fd);
      throw error;
    }
    const evidence = (stream: "stdout" | "stderr") => {
      const stat = fs.fstatSync(capture[stream]);
      return { dev: stat.dev, ino: stat.ino, sha256: capture.hashes[stream].copy().digest("hex") };
    };
    this.captures.set(record.id, capture);
    this.deps.store.withTx(() => updateBackgroundObserved(this.deps.store, { processId: record.id, logEvidence: { stdout: evidence("stdout"), stderr: evidence("stderr") } }));
    return capture;
  }

  private output(id: string, stream: "stdout" | "stderr", bytes: Buffer): void {
    const record = this.require(id), capture = this.captures.get(id);
    if (!capture || record.state === "stopped") return;
    const available = Math.max(0, OUTPUT_LIMIT - record.stdoutBytes - record.stderrBytes);
    const keep = bytes.subarray(0, available);
    let written = 0;
    let failed = false;
    try {
      while (written < keep.length) {
        const count = fs.writeSync(capture[stream], keep, written, keep.length - written);
        if (count <= 0) throw new ExecutionError("background_log_failed", "后台日志写入未取得进展");
        written += count;
      }
    } catch { failed = true; } // 已写部分保留，失败必须停止原执行，不重放输出或命令。
    const capped = available <= bytes.length;
    capture.hashes[stream].update(keep.subarray(0, written));
    const logEvidence = record.logEvidence && { ...record.logEvidence, [stream]: { ...record.logEvidence[stream], sha256: capture.hashes[stream].copy().digest("hex") } };
    this.deps.store.withTx(() => updateBackgroundObserved(this.deps.store, { processId: id,
      ...(logEvidence ? { logEvidence } : {}),
      ...(stream === "stdout" ? { stdoutBytes: record.stdoutBytes + written } : { stderrBytes: record.stderrBytes + written }),
      ...(failed || capped ? { partial: true, reason: failed ? "log_write_failed" : "output_limit" } : {}) }));
    if (failed || capped) this.requestStop(id, failed ? "log_write_failed" : "output_limit");
  }

  async start(ctx: HostToolContext, command: string, signal?: AbortSignal): Promise<BackgroundProcessView> {
    const existing = findBackgroundProcessByOp(this.deps.store, ctx.hostOpId);
    if (existing) return this.starts.get(existing.id) ?? backgroundProcessToView(existing);
    if (this.stopping || signal?.aborted) throw new BackgroundProcessError("background_start_canceled", "后台启动尚未接纳；结束本轮并向拥有者说明。");
    const session = this.deps.store.getSession(ctx.sessionId);
    if (!session || session.projectId !== ctx.projectId) throw new BackgroundProcessError("background_source_invalid", "后台启动来源失效；结束本轮并向拥有者说明。");
    const held = this.deps.store.listAllOccupancy().find(occupancy => occupancy.taskId === ctx.taskId && occupancy.cwdReal === session.cwdReal);
    if (!held) throw new BackgroundProcessError("background_occupied", "当前任务没有目录占用；核实原后台停止后再启动。");
    try {
      const actual = fs.statSync(session.cwdReal);
      if (fs.realpathSync(session.cwdReal) !== session.cwdReal || actual.dev !== held.cwdDev || actual.ino !== held.cwdIno) throw new BackgroundProcessError("background_directory_changed", "后台启动目录身份变化；未启动命令，请核实目录。");
    } catch (error) {
      if (error instanceof BackgroundProcessError) throw error;
      throw new BackgroundProcessError("background_directory_changed", "后台启动目录身份无法核实；未启动命令，请核实目录。");
    }
    const workspace = { path: session.cwdReal, dev: held.cwdDev, ino: held.cwdIno };
    const record = this.deps.store.withTx(() => registerBackgroundProcess(this.deps.store, { ...ctx, workspace, ref: backgroundExecutionRef() }));
    if (command !== record.command) throw new BackgroundProcessError("request_conflict", "后台命令与已记录操作不符；保留记录并核实原请求。");
    const operation = this.startOnce(record, signal);
    this.starts.set(record.id, operation);
    try { return await operation; }
    finally { this.starts.delete(record.id); }
  }

  private async startOnce(record: BackgroundProcess, signal?: AbortSignal): Promise<BackgroundProcessView> {
    const store = this.deps.store;
    try {
      this.capture(record);
      if (signal?.aborted || this.stopping) throw new BackgroundProcessError("background_start_canceled", "后台尚未交接，启动已取消。");
      const moved = await this.deps.handoff(record.taskId, snapshot => {
        if (signal?.aborted || this.stopping) throw new BackgroundProcessError("background_start_canceled", "后台尚未交接，启动已取消。");
        store.withTx(() => handoffBackgroundProcess(store, { processId: record.id, snapshot, workspace: record.workspace }));
      });
      if (!moved) throw new BackgroundProcessError("background_handoff_unverified", "当前工具工作进程停止未核实，后台命令未启动；保留原任务占用并报告拥有者。");
      const spec: LaunchSpec = { taskId: record.taskId, mode: "full_access", workspace: record.workspace.path, workspaceIdentity: { dev: record.workspace.dev, ino: record.workspace.ino }, grantedPaths: record.source.grantedPaths };
      const prepared = prepareBackgroundExecution(this.directory, record.ref, spec);
      const claimed = store.withTx(() => claimBackgroundLaunch(store, record.id, prepared.fingerprint));
      if (!claimed) return backgroundProcessToView(this.require(record.id));
      const unit = await BackgroundExecution.launch(prepared, record.command, record.hostOpId, {
        data: (stream, bytes) => this.output(record.id, stream, bytes),
        exit: exit => {
          store.withTx(() => updateBackgroundObserved(store, { processId: record.id, exit }));
        },
        failed: error => {
          store.withTx(() => updateBackgroundObserved(store, { processId: record.id, partial: true, reason: error.code }));
          this.requestStop(record.id, error.code);
        },
      });
      this.units.set(record.id, unit);
      store.withTx(() => updateBackgroundObserved(store, { processId: record.id, state: "running" }));
      this.watch();
      return backgroundProcessToView(this.require(record.id));
    } catch (error) {
      const current = this.require(record.id);
      const reason = error instanceof BackgroundProcessError || error instanceof ExecutionError ? error.code : "background_start_failed";
      if (!current.launchClaimed) {
        store.withTx(() => finishBackgroundStop(store, { processId: record.id, verified: true, reason }));
        this.closeCapture(record.id);
        this.deps.released();
        if (current.handedOff) await this.deps.restore(record.taskId);
      } else this.requestStop(record.id, reason);
      if (error instanceof BackgroundProcessError || error instanceof ExecutionError) throw error;
      throw new BackgroundProcessError("background_start_failed", "后台启动未完成；已保留记录，请查询停止核实，勿重放原命令。");
    }
  }

  private watch(): void {
    this.timer ??= setInterval(() => {
      for (const record of listActiveBackgroundProcesses(this.deps.store)) {
        if (record.state === "stop_unverified") continue;
        const problem = this.deps.sourceProblem(record);
        if (problem) this.requestStop(record.id, problem);
      }
    }, 500);
    this.timer.unref();
  }

  requestStop(id: string, reason = "owner_requested"): BackgroundProcessView {
    const record = this.deps.store.withTx(() => requestBackgroundStop(this.deps.store, id, reason));
    if (record.state !== "stopped" && !this.stops.has(id)) {
      const operation = Promise.resolve().then(() => this.stopOnce(id));
      this.stops.set(id, operation);
      void operation.catch(error => {
        process.stderr.write(`[ruukoto:background] 停止核实失败：${error instanceof Error && "code" in error ? String(error.code) : "background_stop_failed"}；保留占用与现场\n`);
      }).finally(() => { this.stops.delete(id); });
    }
    return backgroundProcessToView(record);
  }

  private async stopOnce(id: string): Promise<void> {
    await this.starts.get(id)?.catch(() => undefined);
    const record = this.require(id);
    let verified = !record.launchClaimed;
    let reason = record.reason ?? "stop_requested";
    try {
      const unit = this.units.get(id);
      if (record.launchClaimed && record.launchFingerprint !== null) {
        const result = unit ? await unit.stop() : await stopBackgroundExecution(this.directory, record.ref, record.launchFingerprint);
        verified = result.exited;
        if (result.outputComplete === false || !unit) this.deps.store.withTx(() => updateBackgroundObserved(this.deps.store, { processId: id, partial: true }));
      } else if (record.launchClaimed) verified = false;
    } catch (error) {
      verified = false;
      reason = error instanceof ExecutionError ? error.code : "background_stop_failed";
    }
    this.closeCapture(id);
    this.deps.store.withTx(() => {
      if (!verified) updateBackgroundObserved(this.deps.store, { processId: id, partial: true });
      finishBackgroundStop(this.deps.store, { processId: id, verified, reason });
    });
    if (verified) {
      this.units.delete(id);
      this.deps.released();
    }
    if (!listActiveBackgroundProcesses(this.deps.store).length && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private closeCapture(id: string): void {
    const capture = this.captures.get(id);
    if (!capture) return;
    this.captures.delete(id);
    for (const fd of [capture.stdout, capture.stderr]) fs.closeSync(fd);
  }

  get(sessionId: string, processId: string): BackgroundProcessView {
    return backgroundProcessToView(this.require(processId, sessionId));
  }

  read(input: { sessionId: string; processId: string; stream: "stdout" | "stderr"; offset?: number }): { text: string; base64: string; offset: number; nextOffset: number; totalBytes: number; partial: boolean } {
    try { return this.readOutput(input); }
    catch (error) {
      if (error instanceof BackgroundProcessError) throw error;
      throw new BackgroundProcessError("background_evidence_invalid", "后台日志证据无法读取；保留占用和现场，请核实原档案后继续。");
    }
  }

  private readOutput(input: { sessionId: string; processId: string; stream: "stdout" | "stderr"; offset?: number }): { text: string; base64: string; offset: number; nextOffset: number; totalBytes: number; partial: boolean } {
    const record = this.require(input.processId, input.sessionId), offset = input.offset ?? 0;
    if (!["stdout", "stderr"].includes(input.stream) || !Number.isSafeInteger(offset) || offset < 0) throw new BackgroundProcessError("invalid_params", "选择 stdout 或 stderr，offset 使用非负字节位置。");
    const directory = path.join(this.logs, record.id);
    this.privateObject(directory, true);
    const file = path.join(directory, input.stream);
    const expectedFile = this.privateObject(file, false);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes: Buffer;
    let totalBytes: number;
    try {
      totalBytes = fs.fstatSync(fd).size;
      const expected = input.stream === "stdout" ? record.stdoutBytes : record.stderrBytes;
      const actualFile = fs.fstatSync(fd), evidence = record.logEvidence?.[input.stream];
      const digest = createHash("sha256");
      const check = Buffer.alloc(64 * 1024);
      for (let at = 0; at < totalBytes;) {
        const count = fs.readSync(fd, check, 0, Math.min(check.length, totalBytes - at), at);
        if (count <= 0) throw new BackgroundProcessError("background_evidence_invalid");
        digest.update(check.subarray(0, count)); at += count;
      }
      if (!evidence || actualFile.dev !== expectedFile.dev || actualFile.ino !== expectedFile.ino || actualFile.dev !== evidence.dev || actualFile.ino !== evidence.ino || totalBytes !== expected || totalBytes > OUTPUT_LIMIT || digest.digest("hex") !== evidence.sha256) throw new BackgroundProcessError("background_evidence_invalid", "后台日志身份、大小或校验与原记录不符；保留现场并核实档案。");
      bytes = Buffer.alloc(Math.min(PAGE_BYTES, Math.max(0, totalBytes - offset)));
      const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
      bytes = bytes.subarray(0, count);
    } finally { fs.closeSync(fd); }
    return { text: bytes.toString("utf8"), base64: bytes.toString("base64"), offset, nextOffset: offset + bytes.length, totalBytes, partial: record.partial };
  }

  async closeSession(sessionId: string, requestKey: string): Promise<{ processes: BackgroundProcessView[]; stopVerified: boolean }> {
    const closure = this.deps.store.withTx(() => closeSessionBackgroundBarrier(this.deps.store, { sessionId, requestKey }));
    for (const id of closure.processIds) this.requestStop(id, "session_background_end");
    await Promise.all(closure.processIds.map(id => this.stops.get(id)));
    const processes = closure.processIds.map(id => this.get(sessionId, id));
    return { processes, stopVerified: processes.every(record => record.stopVerified) };
  }

  async recover(): Promise<void> {
    for (const record of listActiveBackgroundProcesses(this.deps.store)) this.requestStop(record.id, "backend_restart");
    await Promise.all(this.stops.values());
    if (listActiveBackgroundProcesses(this.deps.store).length) this.watch();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const record of listActiveBackgroundProcesses(this.deps.store)) this.requestStop(record.id, "backend_stop");
    await Promise.all(this.stops.values());
    await Promise.allSettled(this.starts.values());
  }
}
