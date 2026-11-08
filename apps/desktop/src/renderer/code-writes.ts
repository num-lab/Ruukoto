import type { PublicMessageRecall, ModelSelection, Session, SessionDefaultMode } from "@ruukoto/core/types.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import type { PendingRequest } from "@ruukoto/control/pending-requests.ts";
import { formatTaskStatus, type ViewState } from "@ruukoto/view/state.ts";
import type { DesktopAttachment, DesktopBridge, DesktopSubmitResult, DesktopTarget, DesktopUpdate, PendingInput } from "../shared/bridge.ts";

export interface Draft { text: string; attachments?: DesktopAttachment[]; attaching?: boolean }

/** task_queue receipts (coding-message-control): order/revision/eligibility are server-authoritative. */
export type QueueDetail = OpResult<"task_queue">;
export type QueueDecision = { kind: "select_model" } | { kind: "confirm"; count: number; selection: ModelSelection } | { kind: "send"; params: OpParams<"resume_queue"> };
export function queueDecision(view: ViewState, session: Session, confirmed = false): QueueDecision {
  const count = view.queuedTasksFor(session.id).filter(task => !task.modelSelection).length;
  if (!count) return { kind: "send", params: { session_id: session.id } };
  if (!session.modelSelection) return { kind: "select_model" };
  if (!confirmed) return { kind: "confirm", count, selection: session.modelSelection };
  return { kind: "send", params: { session_id: session.id, model_selection: session.modelSelection } };
}
/** Reorder eligible items only; the server preserves ineligible items at their original positions. */
export function queueOrderAfterMove(order: readonly string[], taskId: string, targetId: string, placement: "before" | "after"): string[] | null {
  if (taskId === targetId || !order.includes(taskId) || !order.includes(targetId)) return null;
  const next = order.filter(id => id !== taskId);
  let target = next.indexOf(targetId);
  if (placement === "after") ++target;
  next.splice(target, 0, taskId);
  return next.every((id, index) => id === order[index]) ? null : next;
}
export class WriteFailure extends Error {
  constructor(readonly failure: { code: string; outcome: string; message: string }) { super(failure.message); }
}
interface HeldInput { requestId: string; draft: Draft; input: Draft; settled: boolean }
interface UnknownControl { op: "interrupt" | "cancel" | "resume_queue" | "settings"; sessionId: string; taskId?: string; instanceId: string | null }
/** Recall state: candidate, pending request, edit window and receipt. */
export type RecallState = OpResult<"message_recall_state">;
/** The initiating client retains the request key and completion revision to restore its draft. */
interface HeldRecall { requestId: string; params?: OpParams<"message_recall">; installed?: boolean }

// Note: See .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class CodeWrites {
  entries = new Map<string, PendingInput>();
  corrupt: string[] = [];
  pendingDir = "";
  models: OpResult<"list_models">["models"] = [];
  message: string | null = null;
  readonly busy = new Set<string>();
  readonly stopConfirmations = new Set<string>();
  readonly unknown = new Map<string, UnknownControl>();
  private readonly savingSettings = new Set<string>();
  private readonly drafts = new Map<string, Draft>();
  private readonly firstChats = new Map<string, { requestId: string; creationRequestId: string; mode: SessionDefaultMode; modelSelection: ModelSelection; attempted: boolean }>();
  private readonly restored = new Set<string>();
  private readonly notices = new Set<string>();
  private queueRevision = 0;
  modelGeneration = 0;
  private modelRead = 0;
  private readonly submitting = new Map<string, HeldInput>();
  private readonly held = new Map<string, HeldInput>();
  private readonly restoring = new Set<string>();
  private readonly queues = new Map<string, QueueDetail>();
  queueDetail(sessionId: string): QueueDetail | undefined { return this.queues.get(`${this.view.instanceId}:${sessionId}`); }
  private readonly recallStates = new Map<string, RecallState>();
  /** This client retains at most one request key per conversation until its edit window closes. */
  private readonly heldRecall = new Map<string, HeldRecall>();
  /** Recall state determines which panel and message actions are visible. */
  recallState(sessionId: string): RecallState | undefined { return this.recallStates.get(this.key(sessionId)); }
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly view: ViewState, private readonly online: () => boolean, private readonly changed: () => void, private readonly target: DesktopTarget) {}
  private key(sessionId: string): string { return `${this.view.instanceId}:${sessionId}`; }
  draft(sessionId: string): Draft {
    const key = this.key(sessionId);
    let draft = this.drafts.get(key);
    if (!draft) { draft = { text: "" }; this.drafts.set(key, draft); }
    return draft;
  }
  edit(sessionId: string, text: string): void {
    if (this.recallPending(sessionId)) return;
    const held = this.heldRecall.get(this.key(sessionId));
    if (held?.installed) this.forgetRecall(sessionId);
    this.draft(sessionId).text = text; this.changed();
  }
  installFirstChat(sessionId: string, text: string, attachments: DesktopAttachment[], requestId: string, creationRequestId: string, mode: SessionDefaultMode, modelSelection: ModelSelection, restored = false): void {
    if (restored && this.firstChats.has(this.key(sessionId))) return;
    const draft = this.draft(sessionId);
    draft.text = text;
    draft.attachments = attachments;
    this.firstChats.set(this.key(sessionId), { requestId, creationRequestId, mode, modelSelection, attempted: restored });
    this.changed();
  }
  recallPending(sessionId: string): boolean {
    const held = this.heldRecall.get(this.key(sessionId));
    return !!held && !held.installed;
  }
  defer(): void { this.report("The original record is kept; you can restore input later. Sending stays disabled."); }
  blocked(sessionId: string): boolean {
    return !this.online() || this.recallPending(sessionId) || !!this.draft(sessionId).attaching || this.busy.has(sessionId) || this.checking(sessionId) || [...this.entries.values()].some(({ record }) => record.instanceId === this.view.instanceId && record.params.session_id === sessionId);
  }
  checking(sessionId: string): boolean {
    return this.recallPending(sessionId) || this.submitting.has(this.key(sessionId)) || [...this.held.values()].some(held => !held.settled && held.draft === this.draft(sessionId)) || [...this.entries.values()].some(({ record, result }) => record.instanceId === this.view.instanceId && record.params.session_id === sessionId && result?.kind !== "needs_resubmit" && result?.kind !== "rejected");
  }
  settingsPending(sessionId: string): boolean {
    const unknown = this.unknown.get(sessionId);
    return this.savingSettings.has(this.key(sessionId)) || unknown?.op === "settings" && unknown.instanceId === this.view.instanceId;
  }
  private hold(record: PendingRequest): HeldInput | undefined {
    if (record.op !== "submit" || record.instanceId !== this.view.instanceId || typeof record.params.session_id !== "string" || typeof record.params.input !== "string") return;
    const existing = this.held.get(record.requestId);
    if (existing) return existing;
    // Restored records come from main-process-validated persisted JSON; original attachment references are kept and local files aren't re-read.
    const attachments = Array.isArray(record.params.attachments) ? record.params.attachments as DesktopAttachment[] : undefined;
    const input: Draft = { text: record.params.input, attachments };
    const active = this.submitting.get(this.key(record.params.session_id));
    const held = active?.requestId === record.requestId ? active : { requestId: record.requestId, draft: this.draft(record.params.session_id), input, settled: false };
    this.held.set(record.requestId, held);
    if (input.text && held.draft.text !== input.text && !held.draft.text.startsWith(`${input.text}\n\n`)) held.draft.text = held.draft.text ? `${input.text}\n\n${held.draft.text}` : input.text;
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
      const sentIds = new Set(input.attachments?.map(item => item.id));
      if (draft.attachments) draft.attachments = draft.attachments.filter(item => !sentIds.has(item.id));
    } else {
      if (input.text && draft.text !== input.text && !draft.text.startsWith(`${input.text}\n\n`)) draft.text = draft.text ? `${input.text}\n\n${draft.text}` : input.text;
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
  private report(message: string): void { this.message = message; this.changed(); }
  private async request<T>(op: string, params: Record<string, unknown>): Promise<T> {
    const result = await this.bridge.request(this.target, op, params);
    if (!result.ok) throw new WriteFailure(result.error);
    return result.value as T;
  }
  private merge(record: PendingRequest): void {
    if (record.op !== "submit" || record.instanceId !== this.view.instanceId || this.restored.has(record.requestId)) return;
    const sessionId = record.params.session_id;
    const input = record.params.input;
    if (typeof sessionId !== "string" || typeof input !== "string") return;
    const draft = this.draft(sessionId);
    if (input && draft.text !== input && !draft.text.startsWith(`${input}\n\n`)) draft.text = draft.text ? `${input}\n\n${draft.text}` : input;
    if (Array.isArray(record.params.attachments)) {
      const attachments = record.params.attachments as DesktopAttachment[];
      draft.attachments = [...attachments, ...(draft.attachments ?? []).filter(item => !attachments.some(original => original.id === item.id))];
    }
    this.restored.add(record.requestId);
    this.changed();
  }
  update(update: DesktopUpdate): void {
    const modelChanged = update.type === "event" && update.event.body.type === "model.config_changed";
    if (update.type === "snapshot" || modelChanged || (update.type === "state" && update.state !== "online")) {
      ++this.modelGeneration;
      this.models = [];
    }
    if (modelChanged) void this.loadModels();
    if (update.type === "snapshot" || (update.type === "event" && update.kind === "live" && (update.event.body.type === "session.queue_paused" || update.event.body.type === "session.queue_resumed"))) ++this.queueRevision;
    // Lazily refresh the panel cache after queue/guidance events (the panel triggers loadQueue via the queueRevision dependency)
    if (update.type === "event" && update.kind === "live") {
      const body = update.event.body;
      if (body.type === "session.queue_changed" || body.type === "task.guidance") {
        const sessionId = "sessionId" in body ? body.sessionId : undefined;
        if (sessionId) void this.loadQueue(sessionId);
      }
      if (body.type === "message_recall.changed") {
        const sessionId = body.sessionId;
        void this.loadRecallState(sessionId, this.heldRecall.get(this.key(sessionId))?.requestId);
      }
      // Accepting new input may change the recall candidate.
      if (body.type === "task.queued") {
        const sessionId = "sessionId" in body ? body.sessionId : undefined;
        if (sessionId) void this.loadRecallState(sessionId);
      }
    }
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
          if (result.kind === "rejected") { this.merge(record); this.report(`The original request was rejected; input restored: ${result.reason}`); }
          else this.report("Linked to the original task; the input wasn't resubmitted.");
        }
        if (result.kind !== "rejected" && typeof record.params.session_id === "string") this.finishFirstChat(record.params.session_id);
      } else this.entries.set(record.requestId, { record, result });
    } else if (update.type === "snapshot") {
      // After a cold start, verify the saved request key still owns the edit window before restoring its draft.
      for (const session of this.view.sessions) {
        let stored: string | null = null;
        try { stored = localStorage.getItem(this.storageKey(session.id)); } catch { stored = null; }
        if (!stored) continue;
        let held: HeldRecall;
        try { held = JSON.parse(stored) as HeldRecall; } catch { held = { requestId: stored }; }
        if (!held || typeof held.requestId !== "string") continue;
        if (!this.heldRecall.get(this.key(session.id))?.installed) this.heldRecall.set(this.key(session.id), held);
        void this.loadRecallState(session.id, held.requestId);
      }
      for (const [key, control] of this.unknown) {
        if (control.instanceId !== this.view.instanceId) continue;
        const task = control.taskId ? this.view.getTask(control.taskId) : undefined;
        const session = this.view.sessions.find(item => item.id === control.sessionId);
        if (control.taskId ? !!task : !!session) {
          this.unknown.delete(key);
          this.report(control.taskId ? `Task state verified: ${formatTaskStatus(task!.status)}` : control.op === "resume_queue" ? `Queue verified: ${session!.queueState === "paused" ? "still paused" : "runnable"}` : "Chat settings refreshed from backend values.");
        }
      }
    }
  }
  async restore(requestId: string): Promise<void> {
    try {
      // Delivered input only retries the cleanup confirmation, to avoid re-sending after a lost response.
      if (!this.restored.has(requestId)) this.merge(await this.request<PendingRequest>("desktop_pending_read", { request_id: requestId }));
      if (!this.restored.has(requestId)) { this.report("The input wasn't delivered. Reconnect to the original data instance and retry."); return; }
      await this.request("desktop_pending_clear", { request_id: requestId });
      this.entries.delete(requestId);
      this.held.delete(requestId);
      this.report("Input restored. Select a model and send.");
    } catch (error) { this.report(error instanceof Error ? error.message : "Couldn't restore input; the original record is kept. Try again."); }
  }
  /** Queue detail cache (refreshed when the panel opens or on events); keys self-isolate on instance switch. */
  async loadQueue(sessionId: string): Promise<void> {
    if (!this.online() || !this.view.instanceId) return;
    const instanceId = this.view.instanceId;
    try {
      const detail = await this.request<QueueDetail>("task_queue", { session_id: sessionId });
      if (instanceId !== this.view.instanceId) return;
      this.queues.set(this.key(sessionId), detail);
      this.changed();
    } catch (error) { void error; /* Swallow task_queue request failures (offline or remote rejection): the panel shows an empty state without interrupting the main flow */ }
  }

  private async submitQueueOrder(sessionId: string, detail: QueueDetail, order: string[]): Promise<void> {
    try {
      const result = await this.request<QueueDetail["queue"]>("queue_reorder", { session_id: sessionId, task_ids: order, expected_revision: detail.queue.revision });
      this.queues.set(this.key(sessionId), { ...detail, queue: result });
      this.changed();
    } catch (error) {
      this.report(error instanceof Error ? error.message : "Reorder failed. Refresh the queue.");
      await this.loadQueue(sessionId);
    }
  }

  /** Keyboard movement submits the complete reorder list with its optimistic revision. */
  async moveQueued(sessionId: string, taskId: string, delta: -1 | 1): Promise<void> {
    const detail = this.queueDetail(sessionId);
    if (!detail) { await this.loadQueue(sessionId); return; }
    const current = [...detail.reorderableTaskIds];
    const index = current.indexOf(taskId), targetId = current[index + delta];
    const order = targetId ? queueOrderAfterMove(current, taskId, targetId, delta < 0 ? "before" : "after") : null;
    if (order) await this.submitQueueOrder(sessionId, detail, order);
  }

  /** Drag reordering uses eligibility and revision from the latest task_queue receipt. */
  async reorderQueued(sessionId: string, taskId: string, targetId: string, placement: "before" | "after"): Promise<void> {
    const detail = this.queueDetail(sessionId);
    if (!detail) { await this.loadQueue(sessionId); return; }
    const order = queueOrderAfterMove(detail.reorderableTaskIds, taskId, targetId, placement);
    if (order) await this.submitQueueOrder(sessionId, detail, order);
  }

  /** Turn queued input into guidance for the current task; a missed target returns to the queue head (handled server-side). */
  async steerQueued(sessionId: string, taskId: string): Promise<void> {
    const revision = this.queueDetail(sessionId)?.queue.revision;
    try {
      await this.request("steer_task", { task_id: taskId, ...(revision !== undefined ? { expected_queue_revision: revision } : {}) });
    } catch (error) {
      this.report(error instanceof Error ? error.message : "Sending as guidance failed. Try again.");
    }
    await this.loadQueue(sessionId);
  }

  // Message recall

  /** Read authoritative recall state; discard stale results after switching instances. */
  async loadRecallState(sessionId: string, requestId?: string): Promise<void> {
    if (!this.online() || !this.view.instanceId) return;
    const instanceId = this.view.instanceId;
    try {
      const state = await this.request<RecallState>("message_recall_state", { session_id: sessionId, ...(requestId ? { request_id: requestId } : {}) });
      if (instanceId !== this.view.instanceId) return;
      this.recallStates.set(this.key(sessionId), state);
      this.applyRecallDraft(sessionId, state);
      this.changed();
    } catch (error) { void error; /* Retain the last state when offline or rejected remotely. */ }
  }

  /** Persist the initiating request key so a cold start can verify edit-window ownership and restore the draft. */
  private storageKey(sessionId: string): string { return `ruukoto.recallDraft:${this.key(sessionId)}`; }
  private rememberRecall(sessionId: string, held: HeldRecall): void {
    this.heldRecall.set(this.key(sessionId), held);
    try { localStorage.setItem(this.storageKey(sessionId), JSON.stringify({ requestId: held.requestId, ...(held.params ? { params: held.params } : {}) })); }
    catch { this.heldRecall.delete(this.key(sessionId)); throw new Error("Couldn't save the original recall request; nothing was sent. Restore app storage and retry."); }
  }
  private forgetRecall(sessionId: string): void {
    this.heldRecall.delete(this.key(sessionId));
    try { localStorage.removeItem(this.storageKey(sessionId)); } catch { /* Memory state is already cleared if storage is unavailable. */ }
  }

  /** Restore a completed draft once, only on the client holding its original request key. */
  private applyRecallDraft(sessionId: string, state: RecallState): void {
    const held = this.heldRecall.get(this.key(sessionId));
    const edit = state.edit;
    if (held?.installed) return;
    if (!held || !edit || state.receipt?.id !== edit.recallId || state.receipt.requestId !== held.requestId || state.receipt.phase !== "completed") {
      // A terminal request that no longer owns the edit window invalidates the key without restoring a draft.
      if (held && state.receipt?.requestId === held.requestId && (state.receipt.phase === "rejected" || (state.receipt.phase === "completed" && state.receipt.id !== edit?.recallId))) this.forgetRecall(sessionId);
      return;
    }
    const draft = this.draft(sessionId);
    draft.text = edit.input;
    draft.attachments = edit.attachments.length ? edit.attachments.map(item => ({ id: item.id, name: item.name, size: item.size })) : undefined;
    this.rememberRecall(sessionId, { ...held, installed: true });
    this.report("Input recalled; edit and send again.");
  }

  async retryRecall(sessionId: string): Promise<void> {
    const held = this.heldRecall.get(this.key(sessionId));
    if (held?.params) await this.recall(sessionId, held.params.task_id, held.params.purpose);
    else if (held) await this.loadRecallState(sessionId, held.requestId);
  }

  /** The server arbitrates concurrent recalls; this client tracks only its own request key. */
  async recall(sessionId: string, taskId: string, purpose: "queued" | "historical" = "historical"): Promise<void> {
    if (this.busy.has(sessionId)) return;
    const instanceId = this.view.instanceId;
    const current = this.heldRecall.get(this.key(sessionId));
    const existing = current?.installed ? undefined : current;
    if (existing && !existing.params) { await this.loadRecallState(sessionId, existing.requestId); return; }
    const candidate = this.recallState(sessionId)?.candidate;
    const queue = this.queueDetail(sessionId)?.queue;
    const revision = purpose === "queued" ? queue?.revision : candidate?.inputSeq;
    if (!existing && (revision === undefined || (purpose === "queued" ? !queue?.retrievableTaskIds.includes(taskId) : candidate?.kind !== "task" || candidate.taskId !== taskId))) { await Promise.all([this.loadRecallState(sessionId), this.loadQueue(sessionId)]); return; }
    const requestId = existing?.requestId ?? crypto.randomUUID();
    const params: OpParams<"message_recall"> = existing?.params ?? { session_id: sessionId, task_id: taskId, request_id: requestId, expected_revision: revision!, purpose };
    this.busy.add(sessionId);
    this.changed();
    try {
      this.rememberRecall(sessionId, { requestId, params });
      const receipt = await this.request<PublicMessageRecall>("message_recall", params);
      if (instanceId !== this.view.instanceId) return;
      // The saved key also recovers completion when the mutation response is lost.
      if (receipt.phase === "rejected") {
        this.report(`Recall rejected: ${receipt.error?.message ?? "target changed"}`);
        this.forgetRecall(sessionId);
      }
    } catch (error) {
      this.report(error instanceof Error ? error.message : "Recall failed. Try again.");
    } finally { this.busy.delete(sessionId); this.changed(); }
    if (instanceId === this.view.instanceId) await this.loadRecallState(sessionId, requestId);
  }

  /** Retry stop verification with the original request key and parameters. */
  async verifyRecall(sessionId: string): Promise<void> {
    const open = this.recallState(sessionId)?.open;
    if (!open || open.phase !== "blocked") return;
    this.busy.add(sessionId);
    this.changed();
    try {
      const receipt = await this.request<PublicMessageRecall>("message_recall_verify", { session_id: sessionId, request_id: open.requestId });
      if (receipt.phase === "blocked") this.report("Stop still unverified; verify again later");
    } catch (error) {
      this.report(error instanceof Error ? error.message : "Verification failed. Try again.");
    } finally { this.busy.delete(sessionId); this.changed(); }
    await this.loadRecallState(sessionId, open.requestId);
  }

  async send(sessionId: string, opts: { guidance?: boolean } = {}): Promise<void> {
    const session = this.view.sessions.find(item => item.id === sessionId);
    const draft = this.draft(sessionId);
    if (session?.codeScheduleActive) { this.report("During a timed run, view and handle this round in Scheduled; ordinary messages can be sent afterwards."); return; }
    if (!session || (!draft.text.trim() && !draft.attachments?.length) || this.blocked(sessionId)) return;
    if (!session.modelSelection) { this.report("Select a model first."); return; }
    if (this.heldRecall.get(this.key(sessionId))?.installed) this.forgetRecall(sessionId);
    const input = { ...draft, attachments: draft.attachments ? [...draft.attachments] : undefined };
    const instanceId = this.view.instanceId;
    const key = this.key(sessionId);
    const firstChat = this.firstChats.get(key);
    if (firstChat) { this.notices.delete(firstChat.requestId); this.restored.delete(firstChat.requestId); }
    const held: HeldInput = { requestId: firstChat?.requestId ?? crypto.randomUUID(), draft, input, settled: false };
    this.submitting.set(key, held);
    this.busy.add(sessionId);
    this.changed();
    try {
      const mode = firstChat?.attempted ? session.defaultAccessMode : firstChat?.mode;
      const modelSelection = firstChat?.attempted ? session.modelSelection : firstChat?.modelSelection ?? session.modelSelection;
      const params = { session_id: sessionId, request_id: held.requestId, input: input.text, model_selection: modelSelection, ...(mode ? { access_mode: mode } : {}), ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(opts.guidance ? { guidance: true } : {}) };
      if (firstChat) {
        const prepared = await this.request<{ accepted: boolean }>("desktop_chat_prepare_submission", { ...params, creation_request_id: firstChat.creationRequestId });
        if (instanceId !== this.view.instanceId) { this.settle(held, false); return; }
        if (prepared?.accepted) { this.settle(held, true); this.firstChats.delete(key); return; }
        firstChat.attempted = true;
      }
      const result = await this.request<DesktopSubmitResult>("submit", params);
      if (result.kind === "accepted") {
        this.settle(held, true);
        this.notices.add(result.requestId);
        this.entries.delete(result.requestId);
        this.held.delete(result.requestId);
        if (instanceId === this.view.instanceId && "task" in result) this.view.upsertTask(result.task);
        this.finishFirstChat(sessionId);
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
      if (instanceId === this.view.instanceId) this.report(error instanceof Error ? error.message : "Send failed; your input is kept.");
    } finally { this.submitting.delete(key); this.busy.delete(sessionId); this.changed(); }
  }
  private finishFirstChat(sessionId: string): void {
    const key = this.key(sessionId), first = this.firstChats.get(key);
    if (!first) return;
    this.firstChats.delete(key);
    void this.request("desktop_chat_finish", { request_id: first.creationRequestId }).catch(() => { /* The native journal rechecks the accepted task on reconnect. */ });
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
      if (!models.length) this.report("No model configured on the backend. Configure the model catalog first.");
      this.changed();
    } catch (error) { if (owns()) { this.models = []; this.report(`Couldn't load the model catalog: ${error instanceof Error ? error.message : "Try again."}`); } }
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
      if (op === "resume_queue") this.stopConfirmations.delete(this.key(control.sessionId));
      return result;
    } catch (error) {
      if (control.instanceId !== this.view.instanceId) return;
      if (op === "resume_queue" && error instanceof WriteFailure && error.failure.code === "stop_unverified") this.stopConfirmations.add(this.key(control.sessionId));
      if (error instanceof WriteFailure && (error.failure.outcome === "unknown" || error.failure.outcome === "disconnected" || error.failure.code === "model_selection_conflict" || error.failure.code === "default_mode_conflict")) {
        this.unknown.set(key, control);
        this.report("Outcome unknown; waiting to verify the actual backend state.");
        if (error.failure.outcome !== "disconnected") {
          try {
            if (control.taskId) {
              const detail = await this.request<OpResult<"get_task">>("get_task", { task_id: control.taskId });
              if (control.instanceId !== this.view.instanceId) return;
              this.view.installTaskDetail(detail.task, detail.toolOps, detail.outputPreview, detail.seq);
              this.report(`Task state verified: ${formatTaskStatus(this.view.getTask(detail.task.id)!.status)}`);
            } else {
              const revision = this.queueRevision;
              const session = await this.request<Session>("get_session", { session_id: control.sessionId });
              if (control.instanceId !== this.view.instanceId) return;
              this.applySession(session);
              if (control.op === "resume_queue") this.applyQueue(session, revision);
              const current = this.view.sessions.find(item => item.id === session.id);
              this.report(control.op === "settings" ? "Settings refreshed from backend values. Confirm before acting." : `Queue verified: ${current?.queueState === "paused" ? "still paused" : "runnable"}`);
            }
            this.unknown.delete(key);
          } catch { this.report("Outcome unknown: the state query failed. Reconnect and verify."); }
        }
      } else this.report(`Operation unfinished: ${error instanceof Error ? error.message : "Try again."}`);
    } finally { this.busy.delete(control.sessionId); this.savingSettings.delete(settingsKey); this.changed(); }
  }
  async setModel(session: Session, selection: ModelSelection): Promise<void> {
    if (session.codeScheduleActive) { this.report("This round's model is fixed by the schedule. Edit the schedule to change future runs."); return; }
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
    if (session.codeScheduleActive) { this.report("This round's permission is fixed by the schedule. Edit the schedule to change future runs."); return; }
    const saved = await this.write("set_session_mode", { session_id: session.id, expected_version: session.defaultAccessModeVersion, mode }, { op: "settings", sessionId: session.id, instanceId: this.view.instanceId });
    if (saved) { this.applySession(saved); this.changed(); }
  }
  async control(op: "interrupt" | "cancel", sessionId: string, taskId: string): Promise<void> {
    await this.write(op, { task_id: taskId }, { op, sessionId, taskId, instanceId: this.view.instanceId });
  }
  stopConfirmationNeeded(sessionId: string): boolean { return this.stopConfirmations.has(this.key(sessionId)); }
  async resume(session: Session, confirmed = false, stopConfirmed = false): Promise<void> {
    if (this.settingsPending(session.id)) { this.report("Chat settings are still saving or unverified. Reconnect to confirm the actual backend settings before resuming the queue."); return; }
    const decision = queueDecision(this.view, session, confirmed);
    if (decision.kind !== "send") return;
    const revision = this.queueRevision;
    const saved = await this.write("resume_queue", { ...decision.params, ...(stopConfirmed ? { stop_confirmed: true } : {}) }, { op: "resume_queue", sessionId: session.id, instanceId: this.view.instanceId });
    if (saved) { this.applyQueue(saved, revision); this.changed(); }
  }
}
