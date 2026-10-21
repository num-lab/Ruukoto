import type { TaskView as Task } from "@ruukoto/core/views.ts";
/**
 * 输入提交守护：保证同一输入只对应一个后台任务（issue 04 §3）。
 *
 * 流程：生成 request_id → 原子保存待确认记录 → 原封不动发送 → 收到任务
 * ID 后清除记录。未发送或后台明确拒绝时清除记录；应答丢失（断线/超时等）
 * 时不生成新键、不盲目重发，保留"接收结果待核实"；按 session_id + request_id 精确查询核实：
 * 查到则关联原任务，明确未接收才以原键原参数重试，查询失败保留待核实。
 * 待确认记录绑定数据实例标识；实例不匹配时保留并要求拥有者处理。
 */

import { randomId } from "@ruukoto/core/types.ts";
import { ControlClientError, requestOutcome } from "./client.ts";
import type { ControlConnection } from "./connection.ts";
import type { OpParams } from "./ops.ts";
import type { PendingRequest, PendingRequestStore } from "./pending-requests.ts";

export type SubmitOutcome =
  | { kind: "accepted"; requestId: string; task: Task }
  /** 应答丢失：unknown = 连接仍在（可当场核实），disconnected = 等重连后核实。 */
  | { kind: "pending_verification"; requestId: string; reason: string; outcome: "unknown" | "disconnected" }
  | { kind: "rejected"; requestId: string; message: string }
  | { kind: "not_sent"; requestId: string; message: string }
  | { kind: "conflict"; requestId: string; message: string };

export type ReconcileOutcome =
  | { kind: "linked"; requestId: string; taskId: string }
  | { kind: "resent"; requestId: string; taskId: string }
  | { kind: "kept"; requestId: string; reason: string }
  | { kind: "rejected"; requestId: string; params: Record<string, unknown>; reason: string }
  | { kind: "needs_resubmit"; requestId: string; params: Record<string, unknown> }
  | { kind: "foreign_instance"; requestId: string };

export class SubmissionGuard {
  constructor(
    private readonly store: PendingRequestStore,
    private readonly connection: Pick<ControlConnection, "request" | "instanceId">,
  ) {}

  /**
   * 提交输入（submit/continue）。完整参数含会话、原文、权限模式、授予范围
   * 以及 continue 的原 task_id；保存失败时不发送请求。
   */
  async submit(
    op: "submit" | "continue" | "owner_question_answer",
    params: Record<string, unknown>,
    opts: { requestId?: string } = {},
  ): Promise<SubmitOutcome> {
    const instanceId = this.connection.instanceId;
    if (!instanceId) {
      throw new ControlClientError("connection_unavailable", "尚未完成握手，无法保存待确认记录（缺少数据实例标识）", "not_sent");
    }
    const requestId = opts.requestId ?? randomId("req");
    const fullParams = { ...params, request_id: requestId };
    // 先落盘后发送：保存失败不得发出请求
    this.store.save({ requestId, op, params: fullParams, instanceId, createdAt: new Date().toISOString() });
    try {
      const task = await this.connection.request(op, fullParams as OpParams<typeof op>);
      this.store.clear(requestId);
      return { kind: "accepted", requestId, task };
    } catch (err) {
      const outcome = requestOutcome(err);
      const message = (err as Error).message;
      if (outcome === "rejected" && (err as ControlClientError).code === "request_conflict") {
        // 同键异参：不换新键，核实后展示冲突
        return { kind: "conflict", requestId, message };
      }
      if (outcome === "rejected" || outcome === "not_sent") {
        this.store.clear(requestId);
        return { kind: outcome, requestId, message };
      }
      return { kind: "pending_verification", requestId, reason: message, outcome };
    }
  }

  /**
   * 重连后核实单条待确认记录。
   * 注意：任务的模式可能已被切换——以 request_id 关联为准，不凭当前模式
   * 与原请求不同就当成另一任务。
   */
  async reconcile(record: PendingRequest): Promise<ReconcileOutcome> {
    if (record.op !== "submit" && record.op !== "continue" && record.op !== "owner_question_answer") return { kind: "kept", requestId: record.requestId, reason: "该请求由所属操作入口核实" };
    if (record.instanceId !== this.connection.instanceId) {
      return { kind: "foreign_instance", requestId: record.requestId };
    }
    let sessionId = String(record.params["session_id"] ?? "");
    if (!sessionId && record.op === "continue") {
      try {
        const detail = await this.connection.request("get_task", { task_id: record.params["task_id"] as string });
        sessionId = detail.task.sessionId;
      } catch (err) {
        return { kind: "kept", requestId: record.requestId, reason: `无法读取继续来源：${(err as Error).message}` };
      }
    }
    let found: Task | null;
    try {
      if (record.op === "owner_question_answer") {
        const { receipt } = await this.connection.request("owner_question_receipt", { session_id: sessionId, request_id: record.requestId, operation: "owner_question_answer" });
        if (receipt?.taskId) {
          // 已提交回执只证明键存在；以原参数核实摘要，同键异参不能被误关联。
          const task = await this.connection.request("owner_question_answer", record.params as OpParams<"owner_question_answer">);
          if (task.id !== receipt.taskId) return { kind: "kept", requestId: record.requestId, reason: "回答回执与原任务不一致，请保留记录并检查后台。" };
          this.store.clear(record.requestId);
          return { kind: "linked", requestId: record.requestId, taskId: receipt.taskId };
        }
      }
      const result = record.op === "owner_question_answer" ? { task: null } : await this.connection.request("find_task", {
        session_id: sessionId,
        request_id: record.requestId,
      });
      found = result.task;
    } catch (err) {
      return { kind: "kept", requestId: record.requestId, reason: `核实查询失败：${(err as Error).message}` };
    }
    if (found) {
      this.store.clear(record.requestId);
      return { kind: "linked", requestId: record.requestId, taskId: found.id };
    }
    if (!record.params["model_selection"]) {
      return { kind: "needs_resubmit", requestId: record.requestId, params: { ...record.params, session_id: sessionId } };
    }
    // 明确未接收：以原键和原参数重试
    try {
      // 落盘记录的参数按原样重发（服务端逐项校验）
      const task = await this.connection.request(record.op, { ...record.params, session_id: sessionId } as OpParams<typeof record.op>);
      this.store.clear(record.requestId);
      return { kind: "resent", requestId: record.requestId, taskId: task.id };
    } catch (err) {
      if (record.op !== "owner_question_answer" && err instanceof ControlClientError && err.code === "request_conflict") {
        // 重试遇上同键记录：重新核实（竞态：原请求刚刚落盘）
        try {
          const again = await this.connection.request("find_task", {
            session_id: sessionId,
            request_id: record.requestId,
          });
          if (again.task) {
            this.store.clear(record.requestId);
            return { kind: "linked", requestId: record.requestId, taskId: again.task.id };
          }
        } catch {
          // 保留待核实
        }
      }
      if (requestOutcome(err) === "rejected" && (err as ControlClientError).code !== "request_conflict") {
        this.store.clear(record.requestId);
        return { kind: "rejected", requestId: record.requestId, params: record.params, reason: (err as Error).message };
      }
      return { kind: "kept", requestId: record.requestId, reason: (err as Error).message };
    }
  }

  /** 重连后核实全部待确认记录（按创建顺序）。 */
  async reconcileAll(): Promise<ReconcileOutcome[]> {
    const { records } = this.store.list();
    const outcomes: ReconcileOutcome[] = [];
    for (const record of records) {
      outcomes.push(await this.reconcile(record));
    }
    return outcomes;
  }
}
