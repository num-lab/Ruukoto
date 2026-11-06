import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ControlClientError, requestOutcome } from "@ruukoto/control/client.ts";
import type { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore, type PendingRequest } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard, type SubmitOutcome } from "@ruukoto/control/submission.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { parseModelSelection } from "@ruukoto/core/model-selection.ts";
import { isSessionDefaultMode, type ModelSelection, type Session, type SessionDefaultMode } from "@ruukoto/core/types.ts";
import type { TaskView } from "@ruukoto/core/views.ts";

export interface ManagedChatDraft {
  text: string;
  mode: SessionDefaultMode;
  modelSelection: ModelSelection | null;
}

interface FirstMessage {
  requestId: string;
  submitRequestId: string;
  instanceId: string;
  createdAt: string;
  input: string;
  mode: SessionDefaultMode;
  modelSelection: ModelSelection;
  creationMode: SessionDefaultMode;
  creationModelSelection: ModelSelection;
  sessionId: string | null;
}

function readFirstMessage(record: PendingRequest): FirstMessage | null {
  const params = record.params;
  if (record.op !== "create_managed_session" || params.request_id !== record.requestId ||
    typeof params.input !== "string" || !isSessionDefaultMode(params.mode) ||
    typeof params.submit_request_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(params.submit_request_id) ||
    (params.session_id !== undefined && (typeof params.session_id !== "string" || !params.session_id))) return null;
  let modelSelection: ModelSelection, creationModelSelection: ModelSelection;
  const creationMode = params.creation_mode ?? params.mode;
  if (!isSessionDefaultMode(creationMode)) return null;
  try { modelSelection = parseModelSelection(params.model_selection); creationModelSelection = parseModelSelection(params.creation_model_selection ?? params.model_selection); }
  catch { return null; }
  return { requestId: record.requestId, submitRequestId: params.submit_request_id, instanceId: record.instanceId,
    createdAt: record.createdAt, input: params.input, mode: params.mode, modelSelection, creationMode, creationModelSelection, sessionId: params.session_id ?? null };
}

/** Keep creation and the first input bound until acceptance; reconnect only observes them. */
// Note: See .agents/notes/implemented/feature/2026-11-07-managed-coding-workspaces.md
export class ManagedChat {
  draft: ManagedChatDraft | null = null;
  pending: FirstMessage | null = null;
  busy = false;
  private corrupt = false;
  private readonly submissions: PendingRequestStore;
  private readonly guard: SubmissionGuard;

  constructor(readonly store: PendingRequestStore, private readonly connection: Pick<ControlConnection, "request" | "instanceId">) {
    this.submissions = new PendingRequestStore(join(store.dir, "submissions"));
    this.guard = new SubmissionGuard(this.submissions, connection);
  }

  restore(): string[] {
    this.corrupt = true;
    const saved = this.store.list(true);
    const corrupt = [...saved.corrupt];
    let restored: FirstMessage | null = null;
    for (const record of saved.records) {
      const pending = readFirstMessage(record);
      if (!pending || restored) { corrupt.push(`${record.requestId}.json`); continue; }
      restored = pending;
    }
    if (restored) this.submissionRecord(restored);
    else this.emptySubmissions();
    this.pending = restored;
    this.corrupt = corrupt.length > 0;
    return corrupt;
  }

  open(settings: Omit<ManagedChatDraft, "text">): void {
    if (this.corrupt) throw new ControlClientError("managed_chat_record_corrupt", "首条消息恢复记录损坏，请核实原后台结果和客户端记录后再开始对话。", "not_sent");
    if (this.pending) {
      this.assertInstance(this.pending);
      this.draft = { text: this.pending.input, mode: this.pending.mode, modelSelection: { ...this.pending.modelSelection } };
    } else this.draft = { text: "", mode: settings.mode, modelSelection: settings.modelSelection ? { ...settings.modelSelection } : null };
  }

  close(): void { this.draft = null; }

  /** Only a published session with no unresolved original submission permits corrections. */
  editable(): boolean {
    if (this.corrupt || this.busy) return false;
    if (!this.pending) return true;
    if (!this.pending.sessionId) return false;
    try { return this.submissionRecord(this.pending) === null; }
    catch { return false; /* An unreadable submission cannot prove nonacceptance. */ }
  }

  saveDraft(): void {
    const pending = this.pending, draft = this.draft;
    if (!pending || !draft || !draft.modelSelection || !this.editable()) return;
    const corrected = { ...pending, input: draft.text.trim() ? draft.text : pending.input, mode: draft.mode, modelSelection: { ...draft.modelSelection } };
    this.save(corrected);
    Object.assign(pending, corrected);
  }

  private submissionRecord(pending: FirstMessage): PendingRequest | null {
    const saved = this.submissions.list(true), read = this.submissions.read(pending.submitRequestId);
    if (saved.corrupt.length || saved.records.some(record => record.requestId !== pending.submitRequestId) || read.kind === "corrupt") throw new ControlClientError("managed_chat_record_corrupt", "首条消息提交记录不可读，请核实原请求后重试。", "not_sent");
    if (read.kind !== "record") return null;
    const record = read.record;
    if (record.op !== "submit" || record.instanceId !== pending.instanceId || record.params.request_id !== pending.submitRequestId || Object.keys(record.params).some(key => !["request_id", "session_id", "input", "access_mode", "model_selection"].includes(key)) || record.params.session_id !== pending.sessionId || record.params.input !== pending.input || record.params.access_mode !== pending.mode || !isDeepStrictEqual(record.params.model_selection, pending.modelSelection)) throw new ControlClientError("managed_chat_record_corrupt", "首条消息提交记录与原会话不一致，请核实原请求后重试。", "not_sent");
    return record;
  }

  private emptySubmissions(): void {
    const saved = this.submissions.list(true);
    if (saved.records.length || saved.corrupt.length) throw new ControlClientError("managed_chat_record_corrupt", "首条消息提交记录缺少原创建身份，请核实原请求后重试。", "not_sent");
  }

  private assertInstance(pending: FirstMessage): void {
    if (pending.instanceId !== this.connection.instanceId) throw new ControlClientError("managed_chat_instance_changed", "首条消息属于其他数据实例，请连回原实例后核实。", "not_sent");
  }

  private save(pending: FirstMessage): void {
    this.store.save({ requestId: pending.requestId, op: "create_managed_session", instanceId: pending.instanceId, createdAt: pending.createdAt,
      params: { request_id: pending.requestId, submit_request_id: pending.submitRequestId, input: pending.input,
        mode: pending.mode, model_selection: pending.modelSelection, creation_mode: pending.creationMode, creation_model_selection: pending.creationModelSelection, ...(pending.sessionId ? { session_id: pending.sessionId } : {}) } });
  }

  private accepted(pending: FirstMessage): void {
    this.submissions.remove(pending.submitRequestId);
    this.store.remove(pending.requestId);
    if (this.pending === pending) this.pending = null;
  }

  /** Inspect committed creation/task identities without creating a workspace or sending input. */
  async reconcile(): Promise<{ session: Session; task: TaskView | null } | null> {
    const pending = this.pending;
    if (!pending || this.busy || pending.instanceId !== this.connection.instanceId) return null;
    const creation = await this.connection.request("find_managed_session", { request_id: pending.requestId });
    this.assertInstance(pending);
    if (this.pending !== pending || this.busy) return null;
    const session = creation.session;
    if (!session || creation.status !== "published") return null;
    if (pending.sessionId && pending.sessionId !== session.id) throw new ControlClientError("managed_chat_record_corrupt", "首条消息会话与原创建记录不一致，请核实原请求后重试。", "not_sent");
    if (pending.sessionId !== session.id) { pending.sessionId = session.id; this.save(pending); }
    const { task } = await this.connection.request("find_task", { session_id: session.id, request_id: pending.submitRequestId });
    this.assertInstance(pending);
    if (this.pending !== pending || this.busy) return null;
    if (task) this.accepted(pending);
    return { session, task };
  }

  async send(text: string): Promise<{ creation: OpResult<"create_managed_session">; outcome: SubmitOutcome | null; input: string } | null> {
    if (this.corrupt) throw new ControlClientError("managed_chat_record_corrupt", "首条消息恢复记录不可读，请核实原请求后重试。", "not_sent");
    const draft = this.draft;
    if (!draft || this.busy || !text.trim()) return null;
    if (!draft.modelSelection) throw new ControlClientError("model_required", "请先通过 /model 选择模型。", "not_sent");
    const instanceId = this.connection.instanceId;
    if (!instanceId) throw new ControlClientError("connection_unavailable", "连接尚未就绪，请恢复在线后发送。", "not_sent");
    if (!this.pending) {
      this.emptySubmissions();
      const pending: FirstMessage = { requestId: randomUUID(), submitRequestId: randomUUID(), instanceId,
        createdAt: new Date().toISOString(), input: text, mode: draft.mode, modelSelection: { ...draft.modelSelection }, creationMode: draft.mode, creationModelSelection: { ...draft.modelSelection }, sessionId: null };
      this.save(pending);
      this.pending = pending;
    }
    const pending = this.pending;
    this.assertInstance(pending);
    const unresolved = this.submissionRecord(pending);
    const correcting = pending.sessionId !== null && !unresolved;
    if (!correcting && text !== pending.input && !text.startsWith(`${pending.input}\n\n`)) throw new ControlClientError("managed_chat_input_pending", "首条消息仍待核实，请保留原文重试；可用 /new 恢复原文。", "not_sent");
    const settings = { mode: draft.mode, modelSelection: { ...draft.modelSelection } };
    this.busy = true;
    try {
      let creation: OpResult<"create_managed_session">;
      try {
        creation = await this.connection.request("create_managed_session", {
          request_id: pending.requestId, mode: pending.creationMode, model_selection: pending.creationModelSelection,
        });
      } catch (error) {
        if (requestOutcome(error) === "rejected") {
          try {
            const found = await this.connection.request("find_managed_session", { request_id: pending.requestId });
            this.assertInstance(pending);
            if (found.status === "not_found") this.accepted(pending);
          } catch { /* Retain the first input until the absence of its creation receipt is established. */ }
        }
        throw error;
      }
      this.assertInstance(pending);
      if (pending.sessionId && pending.sessionId !== creation.session.id) throw new ControlClientError("managed_chat_record_corrupt", "首条消息会话与原创建记录不一致，请核实原请求后重试。", "not_sent");
      pending.sessionId = creation.session.id;
      this.save(pending);
      this.submissionRecord(pending);
      // Navigating away during creation must not send the now-hidden first input.
      if (this.draft !== draft) return { creation, outcome: null, input: pending.input };
      const { task } = await this.connection.request("find_task", { session_id: creation.session.id, request_id: pending.submitRequestId });
      this.assertInstance(pending);
      if (this.draft !== draft) return { creation, outcome: null, input: pending.input };
      if (!task && correcting) {
        if (this.submissionRecord(pending)) throw new ControlClientError("managed_chat_input_pending", "首条消息仍待核实，请保留原文重试。", "not_sent");
        const corrected = { ...pending, input: text, ...settings };
        this.save(corrected);
        Object.assign(pending, corrected);
        if (creation.session.defaultAccessMode !== pending.mode) {
          creation.session = await this.connection.request("set_session_mode", { session_id: creation.session.id, expected_version: creation.session.defaultAccessModeVersion, mode: pending.mode });
          this.assertInstance(pending);
        }
        if (!isDeepStrictEqual(creation.session.modelSelection, pending.modelSelection)) {
          creation.session = await this.connection.request("set_session_model", { session_id: creation.session.id, expected_version: creation.session.modelSelectionVersion, model_selection: pending.modelSelection });
          this.assertInstance(pending);
        }
        if (this.draft !== draft) return { creation, outcome: null, input: pending.input };
      }
      const input = task?.input ?? pending.input;
      const outcome: SubmitOutcome = task ? { kind: "accepted", requestId: pending.submitRequestId, task }
        : unresolved ? await this.guard.reconcile(unresolved).then(result => {
          if (result.kind === "linked" || result.kind === "resent") return { kind: "pending_verification" as const, requestId: pending.submitRequestId, outcome: "unknown" as const, reason: "原任务已接收，正在刷新。" };
          if (result.kind === "rejected") return { kind: "rejected" as const, requestId: pending.submitRequestId, message: result.reason };
          return { kind: "pending_verification" as const, requestId: pending.submitRequestId, outcome: "unknown" as const, reason: "原提交仍待核实。" };
        }) : await this.guard.submit("submit", { session_id: creation.session.id, input, model_selection: pending.modelSelection, access_mode: pending.mode }, { requestId: pending.submitRequestId });
      this.assertInstance(pending);
      if (outcome.kind === "accepted") this.accepted(pending);
      return { creation, outcome, input };
    } finally { this.busy = false; }
  }
}
