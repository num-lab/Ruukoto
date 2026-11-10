import { CodeScheduleRequestGuard, type CodeScheduleReconcileOutcome, type CodeScheduleWriteOp, type CodeScheduleWriteOutcome } from "@ruukoto/control/code-schedule-requests.ts";
import type { OpParams } from "@ruukoto/control/ops.ts";
import { BackgroundEndGuard, type BackgroundEndOutcome } from "@ruukoto/control/background-end.ts";
import { ControlClientError, requestOutcome } from "@ruukoto/control/client.ts";
import type { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore, type PendingRequest } from "@ruukoto/control/pending-requests.ts";
import { OwnerQuestionCancelGuard, type OwnerQuestionCancelReconcileOutcome } from "@ruukoto/control/owner-question-cancel.ts";
import { SubmissionGuard, type ReconcileOutcome } from "@ruukoto/control/submission.ts";
import type { DesktopCancelQuestionResult, DesktopCompactionResult, DesktopSubmitResult, DesktopUpdate } from "../shared/bridge.ts";
import { DesktopError } from "./environment.ts";

type Connection = Pick<ControlConnection, "request"> & { instanceId?: string | null };

// Note: See .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class DesktopSubmissions {
  private readonly results = new Map<string, ReconcileOutcome | OwnerQuestionCancelReconcileOutcome | CodeScheduleReconcileOutcome>();
  private readonly announced = new Set<string>();
  private readonly sending = new Set<string>();
  private running: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  constructor(readonly store: PendingRequestStore, private readonly connection: () => Connection | null, private readonly publish: (update: DesktopUpdate) => void, private readonly request: ControlConnection["request"]) {}

  private guardConnection(): Pick<ControlConnection, "request" | "instanceId"> {
    const connection = this.connection();
    const instanceId = connection?.instanceId ?? null;
    return { instanceId, request: (op, params) => {
      // Verification must stay on the original connection and instance across awaits — old input must never resend to a new database.
      if (!connection || this.stopped || this.connection() !== connection || connection.instanceId !== instanceId) throw new ControlClientError("connection_changed", "The connection changed; wait for the original data instance to verify.", "not_sent");
      return this.request(op, params);
    } };
  }
  private guard(): SubmissionGuard { return new SubmissionGuard(this.store, this.guardConnection()); }
  refresh(): void {
    if (this.stopped) return;
    const { records, corrupt } = this.store.list();
    this.publish({ type: "pending", entries: records.filter(record => record.op !== "desktop_start_chat" && record.op !== "create_managed_session").map(record => ({ record, result: this.results.get(record.requestId) })), corrupt, dir: this.store.dir });
  }
  // Note: See .agents/notes/implemented/feature/2026-11-08-desktop-slash-commands.md
  /** The host retains the original request until its terminal receipt is known. */
  async compact(params: OpParams<"compact_session">): Promise<DesktopCompactionResult> {
    if (typeof params.session_id !== "string" || !params.session_id.trim() || typeof params.request_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(params.request_id) || params.prompt !== undefined && typeof params.prompt !== "string") throw new DesktopError("invalid_params", "Select a chat and provide a valid compaction request.");
    const connection = this.guardConnection();
    if (!connection.instanceId) throw new DesktopError("connection_unavailable", "Wait for the connection to recover before compacting context.");
    const saved = this.store.list(true);
    if (saved.corrupt.length) throw new DesktopError("pending_corrupt", "The pending-verification records are corrupt; check the desktop app data directory first.");
    const existing = saved.records.find(record => record.op === "compact_session" && record.instanceId === connection.instanceId && record.params.session_id === params.session_id);
    if (existing) {
      if (this.sending.has(existing.requestId)) return this.compactionResult(existing, { kind: "pending_verification", message: "The original compaction request is sending; wait for verification." });
      const result = await this.reconcileCompaction(existing, existing.requestId === params.request_id);
      if (existing.requestId !== params.request_id) return { record: existing, outcome: { kind: "pending_verification", message: "The original compaction request was verified; review the outcome before submitting a new command." } };
      return result;
    }
    const previous = this.store.read(params.request_id);
    if (previous.kind !== "absent") throw new DesktopError("request_conflict", "The compaction request ID is taken; verify the original operation first.");
    const record: PendingRequest = { requestId: params.request_id, op: "compact_session", instanceId: connection.instanceId, params: { ...params }, createdAt: new Date().toISOString() };
    this.store.save(record);
    const result = await this.sendCompaction(record);
    if (result.outcome.kind !== "rejected") void this.reconcile();
    return result;
  }
  private compactionResult(record: PendingRequest, outcome: DesktopCompactionResult["outcome"]): DesktopCompactionResult {
    const result = { record, outcome };
    this.publish({ type: "compaction", result });
    return result;
  }
  private async sendCompaction(record: PendingRequest): Promise<DesktopCompactionResult> {
    const connection = this.guardConnection();
    if (record.instanceId !== connection.instanceId) return this.compactionResult(record, { kind: "foreign_instance" });
    this.sending.add(record.requestId); this.refresh();
    try {
      const request = await connection.request("compact_session", record.params as OpParams<"compact_session">);
      if (request.status !== "running") this.store.clear(record.requestId);
      return this.compactionResult(record, { kind: "accepted", request });
    } catch (error) {
      const outcome = requestOutcome(error);
      if (outcome === "rejected" || outcome === "not_sent") {
        this.store.clear(record.requestId);
        return this.compactionResult(record, { kind: "rejected", message: error instanceof Error ? error.message : "The compaction request wasn't accepted; try again." });
      }
      return this.compactionResult(record, { kind: "pending_verification", message: "Compaction outcome unverified; the original request will be queried once connected." });
    } finally { this.sending.delete(record.requestId); this.refresh(); }
  }
  private async reconcileCompaction(record: PendingRequest, retry = false): Promise<DesktopCompactionResult> {
    const connection = this.guardConnection();
    if (record.instanceId !== connection.instanceId) return this.compactionResult(record, { kind: "foreign_instance" });
    let request;
    try { request = await connection.request("get_session_compaction", { session_id: String(record.params.session_id), request_id: record.requestId }); }
    catch (error) { return this.compactionResult(record, { kind: "pending_verification", message: error instanceof Error ? error.message : "Couldn't verify the original compaction request; restore the connection and try again." }); }
    if (record.instanceId !== this.connection()?.instanceId) return this.compactionResult(record, { kind: "foreign_instance" });
    if (!request) return retry ? this.sendCompaction(record) : this.compactionResult(record, { kind: "pending_verification", message: "The original compaction request wasn't found; clicking verify retries with the original parameters." });
    if (request.status !== "running") this.store.clear(record.requestId);
    return this.compactionResult(record, { kind: "accepted", request });
  }
  async submit(op: "submit" | "owner_question_answer", params: Record<string, unknown>): Promise<DesktopSubmitResult> {
    if (typeof params.session_id !== "string" || (op !== "owner_question_answer" && typeof params.input !== "string") || (op === "owner_question_answer" && typeof params.question_id !== "string")) throw new DesktopError("invalid_params", "Select a chat before sending.");
    const existing = this.store.list().records.find(record => op === "owner_question_answer"
      ? (record.op === "owner_question_answer" || record.op === "owner_question_cancel") && record.params.question_id === params.question_id
      : record.op === op && record.params.session_id === params.session_id);
    if (existing) return { kind: "pending_existing", record: existing };
    const requestId = params.request_id;
    if (requestId !== undefined && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId))) throw new DesktopError("invalid_params", "The input request ID is invalid; send again.");
    if (typeof requestId === "string") {
      let previous: ReturnType<PendingRequestStore["read"]>;
      try { previous = this.store.read(requestId); }
      catch { throw new DesktopError("pending_read_failed", "Couldn't check the original input record and nothing was sent; restore app data directory permissions and try again."); }
      if (previous.kind !== "absent") throw new DesktopError("request_conflict", "The input request ID is taken and nothing was sent; the original record is kept.");
    }
    const guard = this.guard();
    const pending = guard.submit(op, params, typeof requestId === "string" ? { requestId } : {});
    const record = this.store.list().records.find(record => record.op === op && (op === "owner_question_answer" ? record.params.question_id === params.question_id : record.params.session_id === params.session_id));
    if (record) this.sending.add(record.requestId);
    this.refresh();
    let result: DesktopSubmitResult;
    try { result = await pending; }
    finally { if (record) this.sending.delete(record.requestId); this.refresh(); }
    if (result.kind === "pending_verification" && result.outcome === "unknown") void this.reconcile();
    return result;
  }
  async cancelQuestion(params: Record<string, unknown>): Promise<DesktopCancelQuestionResult> {
    const existing = this.store.list().records.find(record => record.params.session_id === params.session_id && (record.op === "owner_question_answer" || record.op === "owner_question_cancel"));
    if (existing) return { kind: "pending_existing", record: existing };
    const pending = new OwnerQuestionCancelGuard(this.store, this.guardConnection()).cancel(params);
    const record = this.store.list().records.find(item => item.op === "owner_question_cancel" && item.params.question_id === params.question_id);
    if (record) this.sending.add(record.requestId);
    this.refresh();
    let result: DesktopCancelQuestionResult;
    try { result = await pending; }
    finally { if (record) this.sending.delete(record.requestId); this.refresh(); }
    if (result.kind === "pending_verification" && result.outcome === "unknown") void this.reconcile();
    return result;
  }
  async schedule(op: CodeScheduleWriteOp, params: OpParams<CodeScheduleWriteOp>): Promise<CodeScheduleWriteOutcome> {
    const pending = new CodeScheduleRequestGuard(this.store, this.guardConnection()).write(op, params);
    this.sending.add(params.request_id); this.refresh();
    let result: CodeScheduleWriteOutcome;
    try { result = await pending; }
    finally { this.sending.delete(params.request_id); this.refresh(); }
    if (result.kind === "pending_verification") void this.reconcile();
    return result;
  }
  async endBackground(params: Record<string, unknown>): Promise<BackgroundEndOutcome> {
    if (typeof params.session_id !== "string" || !params.session_id.trim() || (params.request_id !== undefined && typeof params.request_id !== "string")) throw new DesktopError("invalid_params", "Select the chat whose background should end.");
    const result = await new BackgroundEndGuard(this.store, this.guardConnection()).end(params.session_id, params.request_id as string | undefined);
    this.refresh();
    return result;
  }
  reconcile(): Promise<void> {
    this.dirty = true;
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  private async drain(): Promise<void> {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      const connection = this.connection();
      const instanceId = connection?.instanceId;
      const guard = this.guard();
      for (const record of this.store.list().records) {
        if (this.stopped || this.connection() !== connection || connection?.instanceId !== instanceId) break;
        if (this.sending.has(record.requestId)) continue;
        if (record.op === "desktop_start_chat" || record.op === "create_managed_session") continue;
        if (record.op === "compact_session") { await this.reconcileCompaction(record); continue; }
        this.results.delete(record.requestId);
        let result: ReconcileOutcome | OwnerQuestionCancelReconcileOutcome | CodeScheduleReconcileOutcome;
        if (record.op === "code_schedule_save" || record.op === "code_schedule_control") {
          const scheduled = await new CodeScheduleRequestGuard(this.store, this.guardConnection()).reconcile(record);
          result = scheduled;
          if (!this.announced.has(record.requestId) && !this.stopped && this.connection() === connection && connection?.instanceId === instanceId) this.publish({ type: "schedule_submission", record, result: scheduled });
        } else if (record.op === "owner_question_cancel") {
          const canceled = await new OwnerQuestionCancelGuard(this.store, this.guardConnection()).reconcile(record);
          result = canceled;
          if (!this.announced.has(record.requestId) && !this.stopped && this.connection() === connection && connection?.instanceId === instanceId) this.publish({ type: "question_cancel", record, result: canceled });
        } else {
          const submitted = await guard.reconcile(record);
          result = submitted;
          if (!this.announced.has(record.requestId) && !this.stopped && this.connection() === connection && connection?.instanceId === instanceId) this.publish({ type: "submission", record, result: submitted });
        }
        if (this.stopped || this.connection() !== connection || connection?.instanceId !== instanceId) break;
        this.results.set(record.requestId, result);
        if (result.kind === "linked" || result.kind === "resent" || result.kind === "rejected") this.announced.add(record.requestId);
      }
      this.refresh();
    }
  }
  close(): void { this.stopped = true; }
}
