import { SelectList, Text, matchesKey, type Component, type SelectItem } from "@earendil-works/pi-tui";
import { BackgroundEndGuard } from "@ruukoto/control/background-end.ts";
import type { ControlConnection } from "@ruukoto/control/connection.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import type { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import type { BackgroundProcessView } from "@ruukoto/core/background-processes.ts";
import { backgroundProcessStatus } from "@ruukoto/view/background-processes.ts";
import { sanitizeForDisplay } from "./sanitize.ts";

interface Deps {
  request: ControlConnection["request"];
  pending: PendingRequestStore;
  sessionId: () => string | null;
  instanceId: () => string | null;
  online: () => boolean;
  render: () => void;
  close: () => void;
}
export class BackgroundProcesses implements Component {
  private processes: BackgroundProcessView[] = [];
  private selected: BackgroundProcessView | null = null;
  private output: OpResult<"background_process_output"> | null = null;
  private stream: "stdout" | "stderr" | null = null;
  private offset = 0;
  private nextOffset: number | null = null;
  private previous: number[] = [];
  private previousPages: number[] = [];
  private raw = false;
  private screen: "list" | "process" | "output" | "end" = "list";
  private list: SelectList | null = null;
  private sessionId: string | null = null;
  private instanceId: string | null = null;
  private generation = 0;
  private outputRead = 0;
  private busy = false;
  private message = "";
  private queryMessage = "";
  constructor(private readonly deps: Deps) {}
  invalidate(): void {}
  private current(sessionId: string | null, instanceId: string | null, generation?: number): boolean {
    return sessionId === this.deps.sessionId() && instanceId === this.deps.instanceId() && (generation === undefined || generation === this.generation);
  }
  async refresh(offset = this.offset): Promise<void> {
    const sessionId = this.deps.sessionId(), instanceId = this.deps.instanceId();
    if (sessionId !== this.sessionId || instanceId !== this.instanceId) {
      ++this.outputRead;
      this.sessionId = sessionId; this.instanceId = instanceId; this.screen = "list"; this.selected = null; this.stream = null; this.output = null; this.processes = []; this.offset = 0; this.nextOffset = null; this.previous = []; this.previousPages = []; this.busy = false; this.message = ""; this.queryMessage = ""; offset = 0;
    }
    const generation = ++this.generation;
    if (!sessionId || !this.deps.online()) { this.queryMessage = "请选择会话并等待连接恢复，再查询后台。"; this.build(); return; }
    try {
      const result = await this.deps.request("background_processes", { session_id: sessionId, offset });
      if (!this.current(sessionId, instanceId, generation)) return;
      this.processes = result.processes; this.offset = offset; this.nextOffset = result.nextOffset; this.queryMessage = "";
      if (this.selected) this.selected = result.processes.find(process => process.id === this.selected!.id) ?? this.selected;
    } catch (error) { if (this.current(sessionId, instanceId, generation)) this.queryMessage = `后台状态查询失败：${(error as Error).message}；按 r 重查。`; }
    if (this.current(sessionId, instanceId, generation)) this.build();
  }
  private choices(items: (SelectItem & { pick: () => void })[]): void {
    const list = new SelectList(items.map(item => ({ ...item, label: sanitizeForDisplay(item.label).replace(/\s+/g, " ") })), 9, { selectedPrefix: text => `\x1b[36m${text}\x1b[0m`, selectedText: text => text, description: text => text, scrollInfo: text => text, noMatch: text => text });
    list.onSelect = item => items.find(choice => choice.value === item.value)?.pick();
    list.onCancel = () => this.back(); this.list = list;
  }
  private build(): void {
    const pending = this.deps.pending.list().records.find(record => record.op === "session_background_end" && record.instanceId === this.instanceId && record.params.session_id === this.sessionId);
    const refresh = { value: "$refresh", label: "刷新后台状态", pick: () => void this.refresh() };
    const back = { value: "$back", label: "返回", pick: () => this.back() };
    if (this.screen === "list") this.choices([
      ...this.processes.map(process => ({ value: process.id, label: `${backgroundProcessStatus(process)} · ${process.command}`, pick: () => { this.selected = process; this.screen = "process"; this.message = ""; this.build(); } })),
      ...(this.previousPages.length ? [{ value: "$previous", label: "上一页", pick: () => void this.refresh(this.previousPages.pop()!) }] : []),
      ...(this.nextOffset !== null ? [{ value: "$next", label: "下一页", pick: () => { this.previousPages.push(this.offset); void this.refresh(this.nextOffset!); } }] : []), refresh,
      { value: "$end", label: pending ? "重核原结束请求" : "结束本会话后台", pick: () => { this.screen = "end"; this.build(); } },
      { value: "$close", label: "返回聊天", pick: () => this.deps.close() },
    ]);
    else if (this.screen === "end") this.choices([
      { value: "$confirm", label: pending ? "确认按原请求核实" : "确认结束本会话后台", pick: () => void this.end(pending?.requestId) }, back,
    ]);
    else if (this.screen === "process" && this.selected) this.choices([
      { value: "$stdout", label: "查看 stdout", pick: () => { this.stream = "stdout"; this.previous = []; this.raw = false; void this.read(0); } },
      { value: "$stderr", label: "查看 stderr", pick: () => { this.stream = "stderr"; this.previous = []; this.raw = false; void this.read(0); } },
      ...(!this.selected.stopVerified ? [{ value: "$stop", label: "请求停止", pick: () => void this.stop() }] : []), refresh, back,
    ]);
    else this.choices([
      ...(this.previous.length ? [{ value: "$previous", label: "上一页日志", pick: () => void this.read(this.previous.pop()!) }] : []),
      ...(this.output && this.output.nextOffset < this.output.totalBytes ? [{ value: "$next", label: "下一页日志", pick: () => { this.previous.push(this.output!.offset); void this.read(this.output!.nextOffset); } }] : []),
      { value: "$raw", label: this.raw ? "显示文本" : "查看原始字节（base64）", pick: () => { this.raw = !this.raw; this.build(); } },
      { value: "$reload", label: "刷新本页日志", pick: () => void this.read(this.output?.offset ?? 0) }, back,
    ]);
    this.deps.render();
  }
  private async read(offset: number): Promise<void> {
    const sessionId = this.sessionId, instanceId = this.instanceId, selected = this.selected, stream = this.stream, read = ++this.outputRead;
    if (!sessionId || !selected || !stream || this.busy) return;
    this.busy = true; this.message = "正在读取日志…"; this.build();
    try {
      const result = await this.deps.request("background_process_output", { session_id: sessionId, process_id: selected.id, stream, offset });
      if (read !== this.outputRead || sessionId !== this.deps.sessionId() || instanceId !== this.deps.instanceId() || this.selected?.id !== selected.id || this.stream !== stream) return;
      this.output = result; this.screen = "output"; this.message = "";
    } catch (error) { if (read === this.outputRead) this.message = `日志读取失败：${(error as Error).message}；请刷新状态后重试。`; }
    finally { if (read === this.outputRead) { this.busy = false; this.build(); } }
  }
  private async stop(): Promise<void> {
    const sessionId = this.sessionId, instanceId = this.instanceId, process = this.selected;
    if (!sessionId || !process || this.busy || !this.deps.online()) return;
    this.busy = true; this.message = "正在登记停止…"; this.build();
    try {
      const result = await this.deps.request("background_process_stop", { session_id: sessionId, process_id: process.id });
      if (!this.current(sessionId, instanceId)) return;
      this.message = result.stopVerified ? "已核实停止。" : "停止请求已接纳；请刷新状态核实。";
    } catch { if (this.current(sessionId, instanceId)) this.message = "停止结果尚未核实；请刷新后台状态，不把请求接纳当作已停止。"; }
    finally { if (this.current(sessionId, instanceId)) { this.busy = false; await this.refresh(); } }
  }
  private async end(retryRequestId?: string): Promise<void> {
    const sessionId = this.sessionId, instanceId = this.instanceId;
    if (!sessionId || this.busy || !this.deps.online()) return;
    this.busy = true;
    try {
      const result = await new BackgroundEndGuard(this.deps.pending, { instanceId, request: (op, params) => this.deps.request(op, params) }).end(sessionId, retryRequestId);
      if (!this.current(sessionId, instanceId)) return;
      this.message = result.kind === "pending" ? result.message : result.result.stopVerified ? "本次结束请求涉及的后台已核实停止。" : "结束请求已接纳；仍有后台停止待核实，请刷新状态。";
    } catch (error) { if (this.current(sessionId, instanceId)) this.message = `结束后台未完成：${(error as Error).message}；请刷新状态核实。`; }
    finally { if (this.current(sessionId, instanceId)) { this.busy = false; this.screen = "list"; await this.refresh(); } }
  }
  private back(): void {
    if (this.screen === "list") this.deps.close();
    else { this.screen = this.screen === "output" ? "process" : "list"; this.build(); }
  }
  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, "escape")) { this.back(); return; }
    if (data === "r") { void this.refresh(); return; }
    this.list?.handleInput(data); this.deps.render();
  }
  render(width: number): string[] {
    const process = this.selected;
    const text = ["本会话后台", ...(process && this.screen !== "list" && this.screen !== "end" ? [process.command, backgroundProcessStatus(process), `stdout ${process.stdoutBytes} B · stderr ${process.stderrBytes} B${process.partial ? " · 日志不完整" : ""}`, ...(process.exit ? [`退出观察：${process.exit.code ?? process.exit.signal ?? "未知"}；停止核实单独显示`] : []), ...(process.reason ? [process.reason] : [])] : []),
      ...(this.screen === "end" ? ["停止并核实本次结束请求涉及的后台；保留会话和历史。"] : []),
      ...(this.screen === "output" && this.output ? [`${this.stream} · 字节 ${this.output.offset}–${this.output.nextOffset}/${this.output.totalBytes}${this.output.partial ? " · 日志不完整" : ""}`, this.raw ? this.output.base64 : this.output.text || "（本页无输出）"] : []), this.queryMessage, this.message, "Esc 返回 · r 刷新状态"].filter(Boolean).join("\n");
    return [...new Text(sanitizeForDisplay(text), 0, 0).render(width), ...(this.list?.render(width) ?? [])];
  }
}
