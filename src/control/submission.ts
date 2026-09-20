/**
 * 输入提交守护：保证同一输入只对应一个后台任务（issue 04 §3）。
 *
 * 流程：生成 request_id → 原子保存待确认记录 → 原封不动发送 → 收到任务
 * ID 后清除记录。应答丢失（断线/超时）时不生成新键、不盲目重发，保留
 * "接收结果待核实"；重连后按 session_id + request_id 精确查询核实：
 * 查到则关联原任务，明确未接收才以原键原参数重试，查询失败保留待核实。
 * 待确认记录绑定数据实例标识；实例不匹配时保留并要求拥有者处理。
 */

import { randomId } from "../core/types.ts";
import type { Task } from "../core/types.ts";
import { ControlClientError } from "./client.ts";
import type { ControlConnection } from "./connection.ts";
import type { PendingRequest, PendingRequestStore } from "./pending-requests.ts";

export type SubmitOutcome =
  | { kind: "accepted"; requestId: string; task: Task }
  | { kind: "pending_verification"; requestId: string; reason: string }
  | { kind: "conflict"; requestId: string; message: string };

export type ReconcileOutcome =
  | { kind: "linked"; requestId: string; taskId: string }
  | { kind: "resent"; requestId: string; taskId: string }
  | { kind: "kept"; requestId: string; reason: string }
  | { kind: "foreign_instance"; requestId: string };

export class SubmissionGuard {
  constructor(
    private readonly store: PendingRequestStore,
    private readonly connection: ControlConnection,
  ) {}

  /**
   * 提交输入（submit/continue）。完整参数含会话、原文、权限模式、授予范围
   * 以及 continue 的原 task_id；保存失败时不发送请求。
   */
  async submit(
    op: "submit" | "continue",
    params: Record<string, unknown>,
    opts: { requestId?: string } = {},
  ): Promise<SubmitOutcome> {
    const instanceId = this.connection.instanceId;
    if (!instanceId) {
      throw new ControlClientError("connection_unavailable", "尚未完成握手，无法保存待确认记录（缺少数据实例标识）");
    }
    const requestId = opts.requestId ?? randomId("req");
    const fullParams = { ...params, request_id: requestId };
    // 先落盘后发送：保存失败不得发出请求
    this.store.save({ requestId, op, params: fullParams, instanceId, createdAt: new Date().toISOString() });
    try {
      const task = await this.connection.request<Task>(op, fullParams);
      this.store.clear(requestId);
      return { kind: "accepted", requestId, task };
    } catch (err) {
      if (err instanceof ControlClientError && err.code === "request_conflict") {
        // 同键异参：不换新键，核实后展示冲突
        return { kind: "conflict", requestId, message: err.message };
      }
      return { kind: "pending_verification", requestId, reason: (err as Error).message };
    }
  }

  /**
   * 重连后核实单条待确认记录。
   * 注意：任务的模式可能已被切换——以 request_id 关联为准，不凭当前模式
   * 与原请求不同就当成另一任务。
   */
  async reconcile(record: PendingRequest): Promise<ReconcileOutcome> {
    if (record.instanceId !== this.connection.instanceId) {
      return { kind: "foreign_instance", requestId: record.requestId };
    }
    const sessionId = String(record.params["session_id"] ?? "");
    let found: Task | null;
    try {
      const result = await this.connection.request<{ task: Task | null }>("find_task", {
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
    // 明确未接收：以原键和原参数重试
    try {
      const task = await this.connection.request<Task>(record.op, record.params);
      this.store.clear(record.requestId);
      return { kind: "resent", requestId: record.requestId, taskId: task.id };
    } catch (err) {
      if (err instanceof ControlClientError && err.code === "request_conflict") {
        // 重试遇上同键记录：重新核实（竞态：原请求刚刚落盘）
        try {
          const again = await this.connection.request<{ task: Task | null }>("find_task", {
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
