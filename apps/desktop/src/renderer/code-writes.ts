import type { ModelSelection, Session, SessionDefaultMode } from "@ruukoto/core/types.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import type { PendingRequest } from "@ruukoto/control/pending-requests.ts";
import { formatTaskStatus, type ViewState } from "@ruukoto/view/state.ts";
import type { DesktopAttachment, DesktopBridge, DesktopSubmitResult, DesktopTarget, DesktopUpdate, PendingInput } from "../shared/bridge.ts";

export interface Draft { text: string; taskId?: string; attachments?: DesktopAttachment[]; attaching?: boolean }
export type QueueDecision = { kind: "select_model" } | { kind: "confirm"; count: number; selection: ModelSelection } | { kind: "send"; params: OpParams<"resume_queue"> };
export function queueDecision(view: ViewState, session: Session, confirmed = false): QueueDecision {
  const count = view.queuedTasksFor(session.id).filter(task => !task.modelSelection).length;
  if (!count) return { kind: "send", params: { session_id: session.id } };
  if (!session.modelSelection) return { kind: "select_model" };
  if (!confirmed) return { kind: "confirm", count, selection: session.modelSelection };
  return { kind: "send", params: { session_id: session.id, model_selection: session.modelSelection } };
}
export class WriteFailure extends Error {
  constructor(readonly failure: { code: string; outcome: string; message: string }) { super(failure.message); }
}
interface HeldInput { requestId: string; draft: Draft; input: Draft; settled: boolean }
interface UnknownControl { op: "interrupt" | "cancel" | "resume_queue" | "settings"; sessionId: string; taskId?: string; instanceId: string | null }

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class CodeWrites {
  entries = new Map<string, PendingInput>();
  corrupt: string[] = [];
  pendingDir = "";
  models: OpResult<"list_models">["models"] = [];
  message: string | null = null;
  readonly busy = new Set<string>();
  readonly unknown = new Map<string, UnknownControl>();
  private readonly savingSettings = new Set<string>();
  private readonly drafts = new Map<string, Draft>();
  private readonly restored = new Set<string>();
  private readonly notices = new Set<string>();
  private queueRevision = 0;
  modelGeneration = 0;
  private modelRead = 0;
  private readonly submitting = new Map<string, HeldInput>();
  private readonly held = new Map<string, HeldInput>();
  private readonly restoring = new Set<string>();
  private readonly stopping = new Map<string, { sessionId: string; instanceId: string | null }>();
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly view: ViewState, private readonly online: () => boolean, private readonly changed: () => void, private readonly target: DesktopTarget) {}
  private key(sessionId: string): string { return `${this.view.instanceId}:${sessionId}`; }
  draft(sessionId: string): Draft {
    const key = this.key(sessionId);
    let draft = this.drafts.get(key);
    if (!draft) { draft = { text: "" }; this.drafts.set(key, draft); }
    return draft;
  }
  edit(sessionId: string, text: string): void { this.draft(sessionId).text = text; this.changed(); }
  defer(): void { this.report("原记录仍保留；可稍后恢复输入，发送仍禁用。"); }
  blocked(sessionId: string): boolean {
    return !this.online() || !!this.draft(sessionId).attaching || this.busy.has(sessionId) || this.checking(sessionId) || [...this.entries.values()].some(({ record }) => record.instanceId === this.view.instanceId && record.params.session_id === sessionId);
  }
  checking(sessionId: string): boolean {
    return this.submitting.has(this.key(sessionId)) || [...this.held.values()].some(held => !held.settled && held.draft === this.draft(sessionId)) || [...this.entries.values()].some(({ record, result }) => record.instanceId === this.view.instanceId && record.params.session_id === sessionId && result?.kind !== "needs_resubmit" && result?.kind !== "rejected");
  }
  settingsPending(sessionId: string): boolean {
    const unknown = this.unknown.get(sessionId);
    return this.savingSettings.has(this.key(sessionId)) || unknown?.op === "settings" && unknown.instanceId === this.view.instanceId;
  }
  private hold(record: PendingRequest): HeldInput | undefined {
    if (record.instanceId !== this.view.instanceId || typeof record.params.session_id !== "string" || typeof record.params.input !== "string") return;
    const existing = this.held.get(record.requestId);
    if (existing) return existing;
    // 恢复记录来自主进程校验过的持久 JSON，保留原附件引用，不重新读取本机文件。
    const attachments = Array.isArray(record.params.attachments) ? record.params.attachments as DesktopAttachment[] : undefined;
    const input: Draft = { text: record.params.input, attachments, ...(record.op === "continue" && typeof record.params.task_id === "string" ? { taskId: record.params.task_id } : {}) };
    const active = this.submitting.get(this.key(record.params.session_id));
    const held = active?.requestId === record.requestId ? active : { requestId: record.requestId, draft: this.draft(record.params.session_id), input, settled: false };
    this.held.set(record.requestId, held);
    if (input.text && held.draft.text !== input.text && !held.draft.text.startsWith(`${input.text}\n\n`)) held.draft.text = held.draft.text ? `${input.text}\n\n${held.draft.text}` : input.text;
    if (input.taskId) held.draft.taskId = input.taskId;
    if (attachments) held.draft.attachments = [...attachments, ...(held.draft.attachments ?? []).filter(item => !attachments.some(original => original.id === item.id))];
    return held;
  }
  private settle(held: HeldInput, accepted: boolean): void {
    if (held.settled) return;
    held.settled = true;
    const { draft, input } = held;
    if (accepted) {
      if (draft.text === input.text) draft.text = "";
      else if (input.text && draft.text.startsWith(`${input.text}\n\n`)) draft.text = draft.text.slice(input.text.length + 2);
      if (draft.taskId === input.taskId) delete draft.taskId;
      const sentIds = new Set(input.attachments?.map(item => item.id));
      if (draft.attachments) draft.attachments = draft.attachments.filter(item => !sentIds.has(item.id));
    } else {
      if (input.text && draft.text !== input.text && !draft.text.startsWith(`${input.text}\n\n`)) draft.text = draft.text ? `${input.text}\n\n${draft.text}` : input.text;
      if (input.taskId) draft.taskId = input.taskId;
      if (input.attachments) draft.attachments = [...input.attachments, ...(draft.attachments ?? []).filter(item => !input.attachments!.some(original => original.id === item.id))];
    }
  }
  async preparePending(sessionId: string): Promise<void> {
    for (const { record, result } of this.entries.values()) {
      if (record.instanceId !== this.view.instanceId || record.params.session_id !== sessionId) continue;
      this.hold(record);
      if ((result?.kind === "needs_resubmit" || result?.kind === "rejected") && !this.restoring.has(record.requestId)) {
        this.restoring.add(record.requestId);
        await this.restore(record.requestId);
        this.restoring.delete(record.requestId);
      }
    }
    this.changed();
  }
  private stopped(): void {
    for (const [id, source] of this.stopping) {
      if (source.instanceId !== this.view.instanceId) continue;
      const task = this.view.getTask(id);
      if (task?.status === "interrupted") { this.continueTask(source.sessionId, id); this.stopping.delete(id); }
      else if (task?.endedAt) this.stopping.delete(id);
    }
  }
  private report(message: string): void { this.message = message; this.changed(); }
  private async request<T>(op: string, params: Record<string, unknown>): Promise<T> {
    const result = await this.bridge.request(this.target, op, params);
    if (!result.ok) throw new WriteFailure(result.error);
    return result.value as T;
  }
  private merge(record: PendingRequest): void {
    if (record.instanceId !== this.view.instanceId || this.restored.has(record.requestId)) return;
    const sessionId = record.params.session_id;
    const input = record.params.input;
    if (typeof sessionId !== "string" || typeof input !== "string") return;
    const draft = this.draft(sessionId);
    if (input && draft.text !== input && !draft.text.startsWith(`${input}\n\n`)) draft.text = draft.text ? `${input}\n\n${draft.text}` : input;
    if (Array.isArray(record.params.attachments)) {
      const attachments = record.params.attachments as DesktopAttachment[];
      draft.attachments = [...attachments, ...(draft.attachments ?? []).filter(item => !attachments.some(original => original.id === item.id))];
    }
    if (record.op === "continue" && typeof record.params.task_id === "string") draft.taskId = record.params.task_id;
    this.restored.add(record.requestId);
    this.changed();
  }
  update(update: DesktopUpdate): void {
    if (update.type === "snapshot" || (update.type === "state" && update.state !== "online")) {
      ++this.modelGeneration;
      this.models = [];
    }
    if (update.type === "snapshot" || (update.type === "event" && update.kind === "live" && (update.event.body.type === "session.queue_paused" || update.event.body.type === "session.queue_resumed"))) ++this.queueRevision;
    if (update.type === "pending") {
      this.entries = new Map(update.entries.filter(entry => entry.record.op === "submit" || entry.record.op === "continue").map(entry => [entry.record.requestId, entry]));
      this.corrupt = update.corrupt;
      this.pendingDir = update.dir;
    } else if (update.type === "submission" && (update.record.op === "submit" || update.record.op === "continue")) {
      const { record, result } = update;
      if (result.kind === "linked" || result.kind === "resent" || result.kind === "rejected") {
        this.entries.delete(record.requestId);
        if (!this.notices.has(record.requestId)) {
          this.notices.add(record.requestId);
          const active = this.submitting.get(`${record.instanceId}:${record.params.session_id}`);
          const held = this.held.get(record.requestId) ?? (active?.requestId === record.requestId ? active : undefined);
          if (held) this.settle(held, result.kind !== "rejected");
          this.held.delete(record.requestId);
          if (result.kind === "rejected") { this.merge(record); this.report(`原请求被拒绝，输入已恢复：${result.reason}`); }
          else this.report("已关联原任务，输入没有重复提交。");
        }
      } else this.entries.set(record.requestId, { record, result });
    } else if (update.type === "snapshot") {
      for (const [key, control] of this.unknown) {
        if (control.instanceId !== this.view.instanceId) continue;
        const task = control.taskId ? this.view.getTask(control.taskId) : undefined;
        const session = this.view.sessions.find(item => item.id === control.sessionId);
        if (control.taskId ? !!task : !!session) {
          this.unknown.delete(key);
          this.report(control.taskId ? `已核实任务状态：${formatTaskStatus(task!.status)}` : control.op === "resume_queue" ? `已核实队列：${session!.queueState === "paused" ? "仍暂停" : "可运行"}` : "已按后台实际值刷新会话设置。");
        }
      }
    }
    this.stopped();
  }
  async restore(requestId: string): Promise<void> {
    try {
      // 已交付过的输入只重试清理确认，避免应答丢失后重复拼接。
      if (!this.restored.has(requestId)) this.merge(await this.request<PendingRequest>("desktop_pending_read", { request_id: requestId }));
      if (!this.restored.has(requestId)) { this.report("输入尚未交付，请连回原数据实例后重试。"); return; }
      await this.request("desktop_pending_clear", { request_id: requestId });
      this.entries.delete(requestId);
      this.held.delete(requestId);
      this.report("输入已恢复，请选择模型后发送。");
    } catch (error) { this.report(error instanceof Error ? error.message : "恢复输入失败；原记录仍保留，请重试。"); }
  }
  async send(sessionId: string): Promise<void> {
    const session = this.view.sessions.find(item => item.id === sessionId);
    const draft = this.draft(sessionId);
    if (!session || (!draft.text.trim() && !draft.attachments?.length) || this.blocked(sessionId)) return;
    if (!session.modelSelection) { this.report("请先选择模型。"); return; }
    const input = { ...draft, attachments: draft.attachments ? [...draft.attachments] : undefined };
    const instanceId = this.view.instanceId;
    const key = this.key(sessionId);
    const held: HeldInput = { requestId: crypto.randomUUID(), draft, input, settled: false };
    this.submitting.set(key, held);
    this.busy.add(sessionId);
    this.changed();
    try {
      const result = await this.request<DesktopSubmitResult>(input.taskId ? "continue" : "submit", { session_id: sessionId, request_id: held.requestId, ...(input.taskId ? { task_id: input.taskId } : {}), input: input.text, model_selection: session.modelSelection, ...(input.attachments?.length ? { attachments: input.attachments } : {}) });
      if (result.kind === "accepted") {
        this.settle(held, true);
        this.notices.add(result.requestId);
        this.entries.delete(result.requestId);
        this.held.delete(result.requestId);
        if (instanceId === this.view.instanceId) this.view.upsertTask(result.task);
      } else if (result.kind === "not_sent" || result.kind === "rejected" || result.kind === "conflict") {
        this.settle(held, false);
        this.restored.add(result.requestId);
        this.notices.add(result.requestId);
        if (instanceId === this.view.instanceId) this.report(result.message);
      } else if (result.kind === "pending_existing") {
        if (!this.notices.has(result.record.requestId)) this.entries.set(result.record.requestId, { record: result.record });
      } else if (!this.notices.has(result.requestId)) this.held.set(result.requestId, held);
    } catch (error) {
      this.settle(held, false);
      if (instanceId === this.view.instanceId) this.report(error instanceof Error ? error.message : "发送失败，输入仍保留。");
    } finally { this.submitting.delete(key); this.busy.delete(sessionId); this.changed(); }
  }
  continueTask(sessionId: string, taskId: string): void {
    const task = this.view.getTask(taskId);
    if (task?.sessionId !== sessionId || task.status !== "interrupted") return;
    this.draft(sessionId).taskId = taskId;
    this.changed();
  }
  async loadModels(): Promise<void> {
    if (!this.online() || !this.view.instanceId) return;
    const instanceId = this.view.instanceId;
    const generation = this.modelGeneration;
    const read = ++this.modelRead;
    const owns = () => instanceId === this.view.instanceId && generation === this.modelGeneration && read === this.modelRead && this.online();
    try {
      const models: typeof this.models = [];
      let offset: number | null = 0;
      do {
        const page: OpResult<"list_models"> = await this.request("list_models", { offset, limit: 100 });
        if (!owns()) return;
        models.push(...page.models);
        offset = page.nextOffset;
      } while (offset !== null);
      this.models = models;
      if (!models.length) this.report("后台未配置模型，请先配置模型目录。");
      this.changed();
    } catch (error) { if (owns()) { this.models = []; this.report(`模型目录读取失败：${error instanceof Error ? error.message : "请重试。"}`); } }
  }
  private applySession(session: Session): void {
    this.view.applySessionModel(session.id, session.modelSelection, session.modelSelectionVersion);
    this.view.applySessionDefaultMode(session.id, session.defaultAccessMode, session.defaultAccessModeVersion);
  }
  private applyQueue(session: Session, revision: number): void {
    if (revision !== this.queueRevision) return;
    const current = this.view.sessions.find(item => item.id === session.id);
    if (current) { current.queueState = session.queueState; current.queuePauseReason = session.queuePauseReason; }
    const view = this.view.sessionViews.get(session.id);
    if (view) { view.queueState = session.queueState; view.queuePauseReason = session.queuePauseReason; }
  }
  private async write<K extends TuiOp>(op: K, params: OpParams<K>, control: UnknownControl): Promise<OpResult<K> | undefined> {
    if (!this.online() || this.busy.has(control.sessionId)) return;
    this.busy.add(control.sessionId);
    const settingsKey = `${control.instanceId}:${control.sessionId}`;
    if (control.op === "settings") this.savingSettings.add(settingsKey);
    this.changed();
    const key = control.taskId ?? control.sessionId;
    try {
      const result = await this.request<OpResult<K>>(op, params);
      if (control.instanceId !== this.view.instanceId) return;
      this.unknown.delete(key);
      return result;
    } catch (error) {
      if (control.instanceId !== this.view.instanceId) return;
      if (error instanceof WriteFailure && (error.failure.outcome === "unknown" || error.failure.outcome === "disconnected" || error.failure.code === "model_selection_conflict" || error.failure.code === "default_mode_conflict")) {
        this.unknown.set(key, control);
        this.report("操作结果未知；等待核实后台实际状态。");
        if (error.failure.outcome !== "disconnected") {
          try {
            if (control.taskId) {
              const detail = await this.request<OpResult<"get_task">>("get_task", { task_id: control.taskId });
              if (control.instanceId !== this.view.instanceId) return;
              this.view.installTaskDetail(detail.task, detail.toolOps, detail.outputPreview, detail.seq);
              this.report(`已核实任务状态：${formatTaskStatus(this.view.getTask(detail.task.id)!.status)}`);
            } else {
              const revision = this.queueRevision;
              const session = await this.request<Session>("get_session", { session_id: control.sessionId });
              if (control.instanceId !== this.view.instanceId) return;
              this.applySession(session);
              if (control.op === "resume_queue") this.applyQueue(session, revision);
              const current = this.view.sessions.find(item => item.id === session.id);
              this.report(control.op === "settings" ? "已按后台实际值刷新设置，请确认后再操作。" : `已核实队列：${current?.queueState === "paused" ? "仍暂停" : "可运行"}`);
            }
            this.unknown.delete(key);
          } catch { this.report("结果未知：状态查询失败，请重新连接后核实。"); }
        }
      } else this.report(`操作未完成：${error instanceof Error ? error.message : "请重试。"}`);
    } finally { this.busy.delete(control.sessionId); this.savingSettings.delete(settingsKey); this.changed(); }
  }
  async setModel(session: Session, selection: ModelSelection): Promise<void> {
    const saved = await this.write("set_session_model", { session_id: session.id, expected_version: session.modelSelectionVersion, model_selection: selection }, { op: "settings", sessionId: session.id, instanceId: this.view.instanceId });
    if (saved) { this.applySession(saved); this.changed(); }
  }
  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const saved = await this.write("set_session_archived", { session_id: sessionId, archived }, { op: "settings", sessionId, instanceId: this.view.instanceId });
    if (!saved) return;
    const session = this.view.sessions.find(item => item.id === saved.id);
    if (session) session.archivedAt = saved.archivedAt;
    this.changed();
  }
  async setMode(session: Session, mode: SessionDefaultMode): Promise<void> {
    const saved = await this.write("set_session_mode", { session_id: session.id, expected_version: session.defaultAccessModeVersion, mode }, { op: "settings", sessionId: session.id, instanceId: this.view.instanceId });
    if (saved) { this.applySession(saved); this.changed(); }
  }
  async control(op: "interrupt" | "cancel", sessionId: string, taskId: string): Promise<void> {
    if (op === "interrupt") this.stopping.set(taskId, { sessionId, instanceId: this.view.instanceId });
    await this.write(op, { task_id: taskId }, { op, sessionId, taskId, instanceId: this.view.instanceId });
    this.stopped();
  }
  async resume(session: Session, confirmed = false): Promise<void> {
    if (this.settingsPending(session.id)) { this.report("会话设置仍在保存或等待核实，请重新连接确认后台实际设置后再恢复队列。"); return; }
    const decision = queueDecision(this.view, session, confirmed);
    if (decision.kind !== "send") return;
    const revision = this.queueRevision;
    const saved = await this.write("resume_queue", decision.params, { op: "resume_queue", sessionId: session.id, instanceId: this.view.instanceId });
    if (saved) { this.applyQueue(saved, revision); this.changed(); }
  }
}
