import { ControlClientError } from "@ruukoto/control/client.ts";
import type { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore, type PendingRequest } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard, type ReconcileOutcome } from "@ruukoto/control/submission.ts";
import type { DesktopSubmitResult, DesktopUpdate, PendingOp } from "../shared/bridge.ts";
import { DesktopError } from "./environment.ts";

type Connection = Pick<ControlConnection, "request"> & { instanceId?: string | null };

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class DesktopSubmissions {
  private readonly results = new Map<string, ReconcileOutcome>();
  private readonly announced = new Set<string>();
  private readonly sending = new Set<string>();
  private running: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  constructor(readonly store: PendingRequestStore, private readonly connection: () => Connection | null, private readonly publish: (update: DesktopUpdate) => void, private readonly request: ControlConnection["request"]) {}

  private guard(): SubmissionGuard {
    const connection = this.connection();
    const instanceId = connection?.instanceId ?? null;
    return new SubmissionGuard(this.store, { instanceId, request: (op, params) => {
      // 核实跨过 await 后也必须留在原连接与实例，不能把旧输入重发到新数据库。
      if (!connection || this.stopped || this.connection() !== connection || connection.instanceId !== instanceId) throw new ControlClientError("connection_changed", "连接已变化；等待原数据实例核实。", "not_sent");
      return this.request(op, params);
    } });
  }
  refresh(): void {
    if (this.stopped) return;
    const { records, corrupt } = this.store.list();
    this.publish({ type: "pending", entries: records.map(record => ({ record, result: this.results.get(record.requestId) })), corrupt, dir: this.store.dir });
  }
  async submit(op: "submit" | "continue", params: Record<string, unknown>): Promise<DesktopSubmitResult> {
    if (typeof params.session_id !== "string" || typeof params.input !== "string" || (op === "continue" && typeof params.task_id !== "string")) throw new DesktopError("invalid_params", "请选择会话与继续来源后再发送。");
    const existing = this.store.list().records.find(record => record.op === op && (op === "continue" ? record.params.task_id === params.task_id : record.params.session_id === params.session_id));
    if (existing) return { kind: "pending_existing", record: existing };
    const requestId = params.request_id;
    if (requestId !== undefined && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId))) throw new DesktopError("invalid_params", "输入请求标识无效，请重新发送。");
    if (typeof requestId === "string") {
      let previous: ReturnType<PendingRequestStore["read"]>;
      try { previous = this.store.read(requestId); }
      catch { throw new DesktopError("pending_read_failed", "无法核对原输入记录，本次没有发送；请恢复应用数据目录权限后重试。"); }
      if (previous.kind !== "absent") throw new DesktopError("request_conflict", "输入请求标识已被占用，本次没有发送；原记录仍保留。");
    }
    const guard = this.guard();
    const pending = guard.submit(op, params, typeof requestId === "string" ? { requestId } : {});
    const record = this.store.list().records.find(record => record.op === op && (op === "continue" ? record.params.task_id === params.task_id : record.params.session_id === params.session_id));
    if (record) this.sending.add(record.requestId);
    this.refresh();
    let result: DesktopSubmitResult;
    try { result = await pending; }
    finally { if (record) this.sending.delete(record.requestId); this.refresh(); }
    if (result.kind === "pending_verification" && result.outcome === "unknown") void this.reconcile();
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
        this.results.delete(record.requestId);
        const result = await guard.reconcile(record);
        if (this.stopped || this.connection() !== connection || connection?.instanceId !== instanceId) break;
        this.results.set(record.requestId, result);
        if (!this.announced.has(record.requestId)) this.publish({ type: "submission", record, result });
        if (result.kind === "linked" || result.kind === "resent" || result.kind === "rejected") this.announced.add(record.requestId);
      }
      this.refresh();
    }
  }
  local(op: PendingOp, params: Record<string, unknown>): PendingRequest | undefined {
    const requestId = params.request_id;
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]+$/.test(requestId)) throw new DesktopError("not_restorable", "此输入不可恢复；请等待核实或连回原数据实例。");
    let entry: ReturnType<PendingRequestStore["read"]>;
    try { entry = this.store.read(requestId); }
    catch { throw new DesktopError(op === "desktop_pending_read" ? "pending_read_failed" : "pending_clear_failed", "原记录无法读取，发送仍禁用；请检查应用数据目录后重试。"); }
    if (entry.kind === "absent" && op === "desktop_pending_clear") { this.refresh(); return; }
    if (entry.kind !== "record" || (entry.record.op !== "submit" && entry.record.op !== "continue") || entry.record.instanceId !== this.connection()?.instanceId || this.results.get(requestId)?.kind !== "needs_resubmit") throw new DesktopError("not_restorable", "此输入不可恢复；请等待核实或连回原数据实例。");
    if (op === "desktop_pending_read") return entry.record;
    try { this.store.remove(requestId); }
    catch { throw new DesktopError("pending_clear_failed", "原记录未能清除，发送仍禁用；请检查应用数据目录后重试。"); }
    this.results.delete(requestId);
    this.refresh();
  }
  close(): void { this.stopped = true; }
}
