import { randomId } from "@ruukoto/core/types.ts";
import type { OwnerQuestionView } from "@ruukoto/core/owner-questions.ts";
import { ControlClientError, requestOutcome } from "./client.ts";
import type { ControlConnection } from "./connection.ts";
import type { OpParams } from "./ops.ts";
import type { PendingRequest, PendingRequestStore } from "./pending-requests.ts";
import type { ReconcileOutcome, SubmitOutcome } from "./submission.ts";

export type OwnerQuestionCancelOutcome = Exclude<SubmitOutcome, { kind: "accepted" }> |
  { kind: "accepted"; requestId: string; question: OwnerQuestionView };
export type OwnerQuestionCancelReconcileOutcome = Exclude<ReconcileOutcome, { kind: "linked" | "resent" | "needs_resubmit" }> |
  { kind: "linked" | "resent"; requestId: string; question: OwnerQuestionView };

// Note: 见 .agents/notes/implemented/feature/2026-10-21-coding-owner-questions.md
export class OwnerQuestionCancelGuard {
  constructor(private readonly store: PendingRequestStore, private readonly connection: Pick<ControlConnection, "request" | "instanceId">) {}

  async cancel(params: Record<string, unknown>): Promise<OwnerQuestionCancelOutcome> {
    const instanceId = this.connection.instanceId;
    if (!instanceId) throw new ControlClientError("connection_unavailable", "尚未连接后台，本次没有取消问题。", "not_sent");
    const requestId = typeof params.request_id === "string" ? params.request_id : randomId("req");
    const fullParams = { ...params, request_id: requestId };
    this.store.save({ requestId, op: "owner_question_cancel", params: fullParams, instanceId, createdAt: new Date().toISOString() });
    try {
      const question = await this.connection.request("owner_question_cancel", fullParams as OpParams<"owner_question_cancel">);
      this.store.clear(requestId);
      return { kind: "accepted", requestId, question };
    } catch (error) {
      const outcome = requestOutcome(error), message = (error as Error).message;
      if (outcome === "rejected" && error instanceof ControlClientError && error.code === "request_conflict") return { kind: "conflict", requestId, message };
      if (outcome === "rejected" || outcome === "not_sent") {
        this.store.clear(requestId);
        return { kind: outcome, requestId, message };
      }
      return { kind: "pending_verification", requestId, reason: message, outcome };
    }
  }

  async reconcile(record: PendingRequest): Promise<OwnerQuestionCancelReconcileOutcome> {
    if (record.op !== "owner_question_cancel") return { kind: "kept", requestId: record.requestId, reason: "该请求由所属操作入口核实。" };
    if (record.instanceId !== this.connection.instanceId) return { kind: "foreign_instance", requestId: record.requestId };
    try {
      const { receipt } = await this.connection.request("owner_question_receipt", { session_id: String(record.params.session_id), request_id: record.requestId, operation: "owner_question_cancel" });
      if (receipt) {
        const question = await this.connection.request("owner_question_cancel", record.params as OpParams<"owner_question_cancel">);
        if (question.id !== receipt.questionId) return { kind: "kept", requestId: record.requestId, reason: "取消回执与原问题不一致，请保留记录并检查后台。" };
        this.store.clear(record.requestId);
        return { kind: "linked", requestId: record.requestId, question: receipt.question };
      }
    } catch (error) {
      return { kind: "kept", requestId: record.requestId, reason: `取消结果尚未核实：${(error as Error).message}` };
    }
    try {
      const question = await this.connection.request("owner_question_cancel", record.params as OpParams<"owner_question_cancel">);
      this.store.clear(record.requestId);
      return { kind: "resent", requestId: record.requestId, question };
    } catch (error) {
      if (requestOutcome(error) === "rejected" && !(error instanceof ControlClientError && error.code === "request_conflict")) {
        this.store.clear(record.requestId);
        return { kind: "rejected", requestId: record.requestId, params: record.params, reason: (error as Error).message };
      }
      return { kind: "kept", requestId: record.requestId, reason: (error as Error).message };
    }
  }
}
