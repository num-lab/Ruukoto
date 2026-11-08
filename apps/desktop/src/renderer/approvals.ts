import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { ConfirmationRequestView } from "@ruukoto/core/views.ts";
import type { ViewState } from "@ruukoto/view/state.ts";
import { utf8ByteLength } from "@ruukoto/view/utf8.ts";
import type { DesktopBridge, DesktopFailure, DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";

interface ApprovalDetail { version: number; text: string; complete: boolean; loading: boolean; error?: string }
interface Decision { instanceId: string; taskId: string; version: number }
class ApprovalFailure extends Error {
  constructor(readonly failure: DesktopFailure) { super(failure.message); }
}

// Note: See .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class DesktopApprovals {
  readonly details = new Map<string, ApprovalDetail>();
  readonly decisions = new Map<string, Decision>();
  message: string | null = null;
  private generation = 0;
  private seq = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly view: ViewState, private readonly changed: () => void, readonly target: DesktopTarget) {}
  private async request<K extends "get_confirmation_params" | "respond_confirmation" | "get_task">(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    const result = await this.bridge.request(this.target, op, params);
    if (!result.ok) throw new ApprovalFailure(result.error);
    return result.value as OpResult<K>;
  }
  private report(message: string): void { this.message = message; this.changed(); }
  private remove(id: string): void { this.view.confirmations = this.view.confirmations.filter(item => item.id !== id); this.details.delete(id); }
  update(update: DesktopUpdate): void {
    if (update.type === "event" && update.kind === "live") {
      this.seq = Math.max(this.seq, update.event.seq);
      for (const id of this.decisions.keys()) if (!this.view.pendingApprovals().some(item => item.id === id)) this.decisions.delete(id);
    }
    for (const [id, detail] of this.details) {
      const approval = this.view.pendingApprovals().find(item => item.id === id);
      if (!approval || approval.permissionVersion !== detail.version) this.details.delete(id);
    }
    if (update.type !== "snapshot") return;
    ++this.generation;
    this.seq = update.result.seq;
    this.details.clear();
    for (const [id, decision] of this.decisions) {
      this.decisions.delete(id);
      if (decision.instanceId !== this.view.instanceId) this.report("The approval target changed; the old outcome was discarded. Check the original target.");
      else this.report(this.view.pendingApprovals().some(item => item.id === id) ? "Outcome unknown; the approval is still pending. Review it again before acting." : "Verified by the new snapshot: the original approval was handled or expired.");
    }
  }
  async refresh(): Promise<void> {
    let result;
    try { result = await this.bridge.request(this.target, "reconnect", {}); }
    catch { this.report("Couldn't refresh the approval status. Reopen the app to verify."); return; }
    if (!result.ok) this.report(`Couldn't refresh the approval status: ${result.error.message}`);
  }
  async load(id: string): Promise<void> {
    if (!this.view.pendingApprovals().some(item => item.id === id) || this.details.get(id)?.loading) return;
    const generation = this.generation;
    const version = this.view.pendingApprovals().find(item => item.id === id)!.permissionVersion;
    const detail: ApprovalDetail = { version, text: "", complete: false, loading: true };
    this.details.set(id, detail);
    this.changed();
    let offset = 0;
    let total: number | undefined;
    try {
      do {
        const page = await this.request("get_confirmation_params", { confirmation_id: id, offset, length: 64 * 1024 });
        if (generation !== this.generation || !this.view.pendingApprovals().some(item => item.id === id && item.permissionVersion === version)) return;
        if (page.confirmation.status !== "pending") { this.remove(id); this.report(`Approval ${page.confirmation.status === "approved" ? "approved" : page.confirmation.status === "rejected" ? "denied" : "expired"}.`); return; }
        if (page.confirmation.permissionVersion !== version) { detail.error = "The permission version changed. Reconnect to refresh the approval before deciding."; return; }
        if (page.params.offset !== offset || (total !== undefined && total !== page.params.totalBytes) || (!page.params.text && offset < page.params.totalBytes)) {
          detail.error = "Parameter pages are discontinuous; the current content is incomplete. Read it again.";
          return;
        }
        total = page.params.totalBytes;
        detail.text += page.params.text;
        offset = page.params.offset + utf8ByteLength(page.params.text);
        this.changed();
      } while (offset < total);
      detail.complete = true;
    } catch (error) {
      if (generation !== this.generation) return;
      detail.error = `Couldn't read the parameters; the current content is incomplete: ${error instanceof Error ? error.message : "Try again."}`;
    } finally { detail.loading = false; this.changed(); }
  }
  async respond(approval: ConfirmationRequestView, decision: "approve" | "reject"): Promise<void> {
    const current = this.view.pendingApprovals().find(item => item.id === approval.id);
    if (!current || current.permissionVersion !== approval.permissionVersion || this.decisions.has(approval.id) || !this.details.get(approval.id)?.complete || this.details.get(approval.id)?.version !== approval.permissionVersion) return;
    const generation = this.generation;
    const bound: Decision = { instanceId: this.view.instanceId!, taskId: approval.taskId, version: approval.permissionVersion };
    this.decisions.set(approval.id, bound);
    this.changed();
    try {
      await this.request("respond_confirmation", { confirmation_id: approval.id, permission_version: bound.version, decision });
      if (generation === this.generation) { this.remove(approval.id); this.decisions.delete(approval.id); this.changed(); }
    } catch (error) {
      if (generation !== this.generation) return;
      const failure = error instanceof ApprovalFailure ? error.failure : { code: "ipc_failed", outcome: "unknown", message: "Approval response not received" };
      if (failure.outcome === "disconnected") { this.report("Outcome unknown; wait for a new snapshot from the same instance to verify. Don't repeat the action."); return; }
      this.decisions.delete(approval.id);
      if (failure.outcome === "rejected" && (failure.code === "stale_confirmation" || failure.code === "not_found")) { this.remove(approval.id); this.report(`The approval already expired: ${failure.message}`); }
      else if (failure.outcome === "rejected" && failure.code === "permission_version_mismatch") {
        this.report("Permission version mismatch; refreshing details. Review the new version before deciding again.");
        await this.verify(approval.id, bound, generation);
        if (generation === this.generation) { this.details.delete(approval.id); await this.load(approval.id); }
      } else if (failure.outcome === "unknown") {
        this.decisions.set(approval.id, bound);
        this.report("Outcome unknown; querying the original approval status.");
        await this.verify(approval.id, bound, generation);
      } else this.report(failure.outcome === "not_sent" ? `The request wasn't sent: ${failure.message} You can act again.` : `Approval denied: ${failure.message}`);
    }
  }
  private async verify(id: string, bound: Decision, generation: number): Promise<void> {
    let detail: OpResult<"get_task">;
    try { detail = await this.request("get_task", { task_id: bound.taskId }); }
    catch {
      if (generation === this.generation) this.report("Outcome unknown: the query failed. Wait for a new snapshot or reconnect to refresh.");
      return;
    }
    if (generation !== this.generation || bound.instanceId !== this.view.instanceId) return;
    if (detail.seq < this.seq) { this.report("Outcome unknown: the query predates the latest event. Wait for a new snapshot or reconnect to refresh."); return; }
    this.view.installTaskDetail(detail.task, detail.toolOps, detail.outputPreview, detail.seq);
    this.view.confirmations = this.view.confirmations.filter(item => item.taskId !== bound.taskId).concat(detail.confirmations);
    this.decisions.delete(id);
    const approval = detail.confirmations.find(item => item.id === id);
    if (approval && approval.permissionVersion !== bound.version) this.details.delete(id);
    if (this.view.pendingApprovals().some(item => item.id === id)) this.report(approval!.permissionVersion !== bound.version ? "The permission version refreshed. Review the new version before deciding again." : "Outcome unknown; the approval is still pending. It's your call whether to act again.");
    else { this.details.delete(id); this.report(`Verified: approval ${approval?.status === "approved" ? "approved" : approval?.status === "rejected" ? "denied" : "expired"}.`); }
  }
}
