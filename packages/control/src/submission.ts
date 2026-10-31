import type { TaskView as Task } from "@ruukoto/core/views.ts";
import type { OwnerQuestionReceipt } from "@ruukoto/core/owner-questions.ts";
import { randomId } from "@ruukoto/core/types.ts";
import { ControlClientError, requestOutcome } from "./client.ts";
import type { ControlConnection } from "./connection.ts";
import type { OpParams } from "./ops.ts";
import type { PendingRequest, PendingRequestStore } from "./pending-requests.ts";

type SubmissionFailure =
  | { kind: "pending_verification"; requestId: string; reason: string; outcome: "unknown" | "disconnected" }
  | { kind: "rejected"; requestId: string; message: string }
  | { kind: "not_sent"; requestId: string; message: string }
  | { kind: "conflict"; requestId: string; message: string };
export type SubmitOutcome = SubmissionFailure | { kind: "accepted"; requestId: string; task: Task };
export type OwnerQuestionAnswerOutcome = SubmissionFailure | { kind: "accepted"; requestId: string; receipt: OwnerQuestionReceipt };
export type ReconcileOutcome =
  | { kind: "linked"; requestId: string; taskId: string }
  | { kind: "resent"; requestId: string; taskId: string }
  | { kind: "kept"; requestId: string; reason: string }
  | { kind: "rejected"; requestId: string; params: Record<string, unknown>; reason: string }
  | { kind: "needs_resubmit"; requestId: string; params: Record<string, unknown> }
  | { kind: "foreign_instance"; requestId: string };

/** Persist the original instance, key and complete parameters before any write. */
export class SubmissionGuard {
  constructor(private readonly store: PendingRequestStore, private readonly connection: Pick<ControlConnection, "request" | "instanceId">) {}

  async submit(op: "submit", params: Record<string, unknown>, opts?: { requestId?: string }): Promise<SubmitOutcome>;
  async submit(op: "owner_question_answer", params: Record<string, unknown>, opts?: { requestId?: string }): Promise<OwnerQuestionAnswerOutcome>;
  async submit(op: "submit" | "owner_question_answer", params: Record<string, unknown>, opts?: { requestId?: string }): Promise<SubmitOutcome | OwnerQuestionAnswerOutcome>;
  async submit(op: "submit" | "owner_question_answer", params: Record<string, unknown>, opts: { requestId?: string } = {}): Promise<SubmitOutcome | OwnerQuestionAnswerOutcome> {
    const instanceId = this.connection.instanceId;
    if (!instanceId) throw new ControlClientError("connection_unavailable", "尚未完成握手，无法保存待确认记录（缺少数据实例标识）", "not_sent");
    const requestId = opts.requestId ?? randomId("req"), fullParams = { ...params, request_id: requestId };
    this.store.save({ requestId, op, params: fullParams, instanceId, createdAt: new Date().toISOString() });
    try {
      const result = op === "submit"
        ? { kind: "accepted" as const, requestId, task: await this.connection.request(op, fullParams as OpParams<"submit">) }
        : { kind: "accepted" as const, requestId, receipt: await this.connection.request(op, fullParams as OpParams<"owner_question_answer">) };
      this.store.clear(requestId);
      return result;
    } catch (error) {
      const outcome = requestOutcome(error), message = (error as Error).message;
      if (outcome === "rejected" && error instanceof ControlClientError && error.code === "request_conflict") return { kind: "conflict", requestId, message };
      if (outcome === "rejected" || outcome === "not_sent") { this.store.clear(requestId); return { kind: outcome, requestId, message }; }
      return { kind: "pending_verification", requestId, reason: message, outcome };
    }
  }

  async reconcile(record: PendingRequest): Promise<ReconcileOutcome> {
    if (record.op !== "submit" && record.op !== "continue" && record.op !== "owner_question_answer") return { kind: "kept", requestId: record.requestId, reason: "该请求由所属操作入口核实" };
    if (record.instanceId !== this.connection.instanceId) return { kind: "foreign_instance", requestId: record.requestId };
    let sessionId = String(record.params.session_id ?? "");
    if (!sessionId && record.op === "continue") {
      try { sessionId = (await this.connection.request("get_task", { task_id: String(record.params.task_id) })).task.sessionId; }
      catch (error) { return { kind: "kept", requestId: record.requestId, reason: `无法核实原继续来源：${(error as Error).message}` }; }
      if (record.instanceId !== this.connection.instanceId) return { kind: "foreign_instance", requestId: record.requestId };
    }
    const legacyAnswer = record.op === "owner_question_answer" && ["model_selection", "access_mode", "granted_paths"].some(key => key in record.params);
    try {
      if (record.op === "owner_question_answer") {
        const { receipt } = await this.connection.request("owner_question_receipt", { session_id: sessionId, request_id: record.requestId, operation: record.op, ...(!legacyAnswer ? { question_id: String(record.params.question_id), question_version: Number(record.params.question_version), answers: record.params.answers as OpParams<"owner_question_answer">["answers"] } : {}) });
        if (record.instanceId !== this.connection.instanceId) return { kind: "foreign_instance", requestId: record.requestId };
        if (receipt) {
          if (receipt.questionId !== record.params.question_id) return { kind: "kept", requestId: record.requestId, reason: "回答回执与原问题不一致，请保留记录并检查后台。" };
          this.store.clear(record.requestId);
          return { kind: "linked", requestId: record.requestId, taskId: receipt.taskId ?? receipt.question.taskId };
        }
      } else {
        const { task } = await this.connection.request("find_task", { session_id: sessionId, request_id: record.requestId });
        if (record.instanceId !== this.connection.instanceId) return { kind: "foreign_instance", requestId: record.requestId };
        if (task) { this.store.clear(record.requestId); return { kind: "linked", requestId: record.requestId, taskId: task.id }; }
      }
    } catch (error) { return { kind: "kept", requestId: record.requestId, reason: `核实查询失败：${(error as Error).message}` }; }
    if (record.op === "owner_question_answer" && !legacyAnswer) return { kind: "kept", requestId: record.requestId, reason: "尚未找到原回答回执；保留原请求，仅查询接纳结果，不自动重发答案。" };
    if (record.op === "continue" || legacyAnswer) return { kind: "kept", requestId: record.requestId, reason: "旧版请求仅供原数据实例核实；未找到接收记录，原请求仍保留，不会重发或转为新消息。" };
    if (record.op === "submit" && !record.params.model_selection) return { kind: "needs_resubmit", requestId: record.requestId, params: { ...record.params, session_id: sessionId } };
    try {
      const taskId = (await this.connection.request("submit", { ...record.params, session_id: sessionId } as OpParams<"submit">)).id;
      if (record.instanceId !== this.connection.instanceId) return { kind: "foreign_instance", requestId: record.requestId };
      this.store.clear(record.requestId);
      return { kind: "resent", requestId: record.requestId, taskId };
    } catch (error) {
      if (record.instanceId !== this.connection.instanceId) return { kind: "foreign_instance", requestId: record.requestId };
      if (record.op === "submit" && error instanceof ControlClientError && error.code === "request_conflict") {
        try {
          const { task } = await this.connection.request("find_task", { session_id: sessionId, request_id: record.requestId });
          if (record.instanceId !== this.connection.instanceId) return { kind: "foreign_instance", requestId: record.requestId };
          if (task) { this.store.clear(record.requestId); return { kind: "linked", requestId: record.requestId, taskId: task.id }; }
        } catch { /* Retain the original request until its acceptance can be established. */ }
      }
      if (requestOutcome(error) === "rejected" && !(error instanceof ControlClientError && error.code === "request_conflict")) {
        this.store.clear(record.requestId);
        return { kind: "rejected", requestId: record.requestId, params: record.params, reason: (error as Error).message };
      }
      return { kind: "kept", requestId: record.requestId, reason: (error as Error).message };
    }
  }

  async reconcileAll(): Promise<ReconcileOutcome[]> {
    const outcomes: ReconcileOutcome[] = [];
    for (const record of this.store.list().records) outcomes.push(await this.reconcile(record));
    return outcomes;
  }
}
