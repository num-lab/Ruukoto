import type { BackgroundEndOutcome } from "@ruukoto/control/background-end.ts";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { PendingRequest } from "@ruukoto/control/pending-requests.ts";
import type { BackgroundProcessView } from "@ruukoto/core/background-processes.ts";
import type { ViewState } from "@ruukoto/view/state.ts";
import type { DesktopBridge, DesktopFailure, DesktopUpdate } from "../shared/bridge.ts";

class BackgroundRequestError extends Error {
  readonly code: string;
  constructor(readonly failure: DesktopFailure) { super(failure.message); this.code = failure.code; }
}
type BackgroundOp = "background_processes" | "background_process_output" | "background_process_stop";
export class DesktopBackgroundProcesses {
  sessionId: string | null = null;
  processes: BackgroundProcessView[] = [];
  totalCount = 0;
  offset = 0;
  nextOffset: number | null = null;
  selected: BackgroundProcessView | null = null;
  stream: "stdout" | "stderr" = "stdout";
  output: OpResult<"background_process_output"> | null = null;
  previousOffsets: number[] = [];
  previousPages: number[] = [];
  raw = false;
  reading = false;
  busy = false;
  endConfirm = false;
  message: string | null = null;
  private generation = 0;
  private outputRead = 0;
  private pending: PendingRequest[] = [];
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly view: ViewState, readonly online: () => boolean, private readonly changed: () => void) {}
  get pendingEnd(): PendingRequest | undefined {
    return this.pending.find(record => record.instanceId === this.view.instanceId && record.params.session_id === this.sessionId);
  }
  private async request<K extends BackgroundOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    const response = await this.bridge.request("code", op, params);
    if (!response.ok) throw new BackgroundRequestError(response.error);
    return response.value as OpResult<K>;
  }
  update(update: DesktopUpdate): void {
    if (update.type === "pending") this.pending = update.entries.filter(entry => entry.record.op === "session_background_end").map(entry => entry.record);
    if (update.type === "snapshot") {
      if (update.instanceChanged) this.close();
      else if (this.sessionId) void this.load();
    }
    if (update.type === "event" && update.kind === "live" && update.event.body.type === "background_process.changed" && update.event.body.process.sessionId === this.sessionId) {
      const process = update.event.body.process;
      this.processes = this.processes.map(item => item.id === process.id && item.version <= process.version ? process : item);
      if (this.selected?.id === process.id && this.selected.version <= process.version) this.selected = process;
    }
  }
  open(sessionId: string, end = false): void {
    ++this.outputRead; this.sessionId = sessionId; this.selected = null; this.output = null; this.processes = []; this.totalCount = 0; this.nextOffset = null; this.reading = false; this.endConfirm = end; this.message = null; this.offset = 0; this.previousOffsets = []; this.previousPages = []; this.changed(); void this.load(0);
  }
  close(): void { ++this.generation; ++this.outputRead; this.sessionId = null; this.selected = null; this.output = null; this.endConfirm = false; this.changed(); }
  async load(offset = this.offset): Promise<void> {
    const sessionId = this.sessionId, instanceId = this.view.instanceId, generation = ++this.generation;
    if (!sessionId || !this.online()) return;
    this.reading = true; this.changed();
    try {
      const result = await this.request("background_processes", { session_id: sessionId, offset });
      if (generation !== this.generation || sessionId !== this.sessionId || instanceId !== this.view.instanceId) return;
      this.processes = result.processes.map(process => { const known = this.view.backgroundProcesses.find(item => item.id === process.id); return known && known.version > process.version ? known : process; });
      this.offset = offset; this.nextOffset = result.nextOffset; this.totalCount = result.totalCount;
      if (this.selected) this.selected = this.processes.find(process => process.id === this.selected!.id) ?? this.selected;
    } catch { if (generation === this.generation) this.message = "后台状态读取失败；请恢复连接后刷新。"; }
    finally { if (generation === this.generation) { this.reading = false; this.changed(); } }
  }
  select(process: BackgroundProcessView): void { this.selected = process; this.previousOffsets = []; this.stream = "stdout"; this.raw = false; this.output = null; this.changed(); void this.read(0); }
  async read(offset = 0, stream = this.stream): Promise<void> {
    const sessionId = this.sessionId, processId = this.selected?.id, instanceId = this.view.instanceId, read = ++this.outputRead;
    if (!sessionId || !processId || !this.online()) return;
    if (stream !== this.stream) { this.output = null; this.previousOffsets = []; this.raw = false; }
    this.stream = stream; this.reading = true; this.changed();
    try {
      const output = await this.request("background_process_output", { session_id: sessionId, process_id: processId, stream, offset });
      if (read !== this.outputRead || sessionId !== this.sessionId || processId !== this.selected?.id || instanceId !== this.view.instanceId) return;
      this.output = output;
    } catch { if (read === this.outputRead) this.message = "后台日志读取失败；请刷新状态后重试。"; }
    finally { if (read === this.outputRead) { this.reading = false; this.changed(); } }
  }
  nextOutput(): void { if (this.output) { this.previousOffsets.push(this.output.offset); void this.read(this.output.nextOffset); } }
  nextPage(): void { if (this.nextOffset !== null) { this.previousPages.push(this.offset); void this.load(this.nextOffset); } }
  previousPage(): void { const offset = this.previousPages.pop(); if (offset !== undefined) void this.load(offset); }
  previousOutput(): void { const offset = this.previousOffsets.pop(); if (offset !== undefined) void this.read(offset); }
  async stop(process: BackgroundProcessView): Promise<void> {
    const sessionId = this.sessionId, instanceId = this.view.instanceId;
    if (!sessionId || !this.online() || this.busy) return;
    this.busy = true; this.changed();
    try {
      const result = await this.request("background_process_stop", { session_id: sessionId, process_id: process.id });
      if (sessionId === this.sessionId && instanceId === this.view.instanceId) this.message = result.stopVerified ? "已核实停止。" : "停止请求已接纳；请刷新状态核实。";
    } catch { if (sessionId === this.sessionId && instanceId === this.view.instanceId) this.message = "停止结果尚未核实；请刷新后台状态。"; }
    finally { this.busy = false; if (sessionId === this.sessionId && instanceId === this.view.instanceId) await this.load(); this.changed(); }
  }
  async end(): Promise<void> {
    const sessionId = this.sessionId, instanceId = this.view.instanceId, pending = this.pendingEnd;
    if (!sessionId || !this.online() || this.busy) return;
    this.busy = true; this.changed();
    try {
      const response = await this.bridge.request("code", "session_background_end", { session_id: sessionId, ...(pending ? { request_id: pending.requestId } : {}) });
      if (sessionId !== this.sessionId || instanceId !== this.view.instanceId) return;
      if (!response.ok) { this.message = "结束后台未完成；请刷新状态核实。"; return; }
      const outcome = response.value as BackgroundEndOutcome;
      if (outcome.kind === "pending") { this.pending = [...this.pending.filter(record => record.requestId !== outcome.record.requestId), outcome.record]; this.message = outcome.message; }
      else { this.pending = this.pending.filter(record => record.params.session_id !== sessionId || record.instanceId !== instanceId); this.message = outcome.result.stopVerified ? "本次结束请求涉及的后台已核实停止。" : "结束请求已接纳；仍有后台停止待核实，请刷新状态。"; }
    } catch { if (sessionId === this.sessionId && instanceId === this.view.instanceId) this.message = "结束后台应答尚未核实；原请求保留，请刷新状态后重核原结束请求。"; }
    finally { this.busy = false; this.endConfirm = false; if (sessionId === this.sessionId && instanceId === this.view.instanceId) await this.load(); this.changed(); }
  }
}
