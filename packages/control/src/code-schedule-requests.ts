import type { CodeScheduleReceipt } from "@ruukoto/core/code-scheduler.ts";
import { ControlClientError, requestOutcome } from "./client.ts";
import type { ControlConnection } from "./connection.ts";
import type { OpParams } from "./ops.ts";
import { validCodeScheduleParams, type PendingRequest, type PendingRequestStore } from "./pending-requests.ts";

export type CodeScheduleWriteOp = "code_schedule_save" | "code_schedule_control";
export type CodeScheduleWriteOutcome =
  | { kind: "accepted"; requestId: string; receipt: CodeScheduleReceipt }
  | { kind: "pending_verification"; requestId: string; reason: string }
  | { kind: "rejected"; requestId: string; code: string; reason: string }
  | { kind: "pending_existing"; record: PendingRequest };
export type CodeScheduleReconcileOutcome =
  | { kind: "linked"; requestId: string; receipt: CodeScheduleReceipt }
  | { kind: "kept"; requestId: string; reason: string }
  | { kind: "foreign_instance"; requestId: string }
  | { kind: "rejected"; requestId: string; code: string; reason: string };

// Note: 见 .agents/notes/implemented/feature/2026-10-25-code-scheduled.md
export class CodeScheduleRequestGuard {
  constructor(private readonly store: PendingRequestStore, private readonly connection: Pick<ControlConnection, "request" | "instanceId">) {}
  async write(op: CodeScheduleWriteOp, params: OpParams<CodeScheduleWriteOp>): Promise<CodeScheduleWriteOutcome> {
    const instanceId = this.connection.instanceId;
    if (!instanceId) throw new ControlClientError("connection_unavailable", "请等待连接恢复后再保存计划。", "not_sent");
    let valid: boolean;
    try { valid = validCodeScheduleParams(op, params, params.request_id); }
    catch { throw new ControlClientError("invalid_params", "计划参数无效，请核对配置后保存。", "not_sent"); }
    if (!valid) throw new ControlClientError("invalid_params", "计划参数无效，请核对配置后保存。", "not_sent");
    const existing = this.store.list(true).records.find(record => record.instanceId === instanceId && (record.op === "code_schedule_save" || record.op === "code_schedule_control"));
    if (existing) return { kind: "pending_existing", record: existing };
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(params.request_id)) throw new ControlClientError("invalid_params", "计划请求标识无效，请重新保存。", "not_sent");
    if (this.store.read(params.request_id).kind !== "absent") throw new ControlClientError("request_conflict", "原请求记录仍保留，请先核实。", "not_sent");
    const record: PendingRequest = { op, requestId: params.request_id, params, instanceId, createdAt: new Date().toISOString() };
    this.store.save(record);
    try {
      const receipt = await this.connection.request(op, params);
      this.store.clear(record.requestId);
      return { kind: "accepted", requestId: record.requestId, receipt };
    } catch (error) {
      if (requestOutcome(error) === "rejected" || requestOutcome(error) === "not_sent") {
        this.store.clear(record.requestId);
        return { kind: "rejected", requestId: record.requestId, code: error instanceof ControlClientError ? error.code : "request_failed", reason: (error as Error).message };
      }
      return { kind: "pending_verification", requestId: record.requestId, reason: "保存结果待核实；原请求与草稿已保留。" };
    }
  }
  async reconcile(record: PendingRequest): Promise<CodeScheduleReconcileOutcome> {
    if (record.instanceId !== this.connection.instanceId) return { kind: "foreign_instance", requestId: record.requestId };
    if (record.op !== "code_schedule_save" && record.op !== "code_schedule_control") return { kind: "kept", requestId: record.requestId, reason: "请从原操作入口核实。" };
    try {
      await this.connection.request("code_schedule_receipt", { request_id: record.requestId });
      // 查过原回执后才按原参数核实摘要；不存在时同键接纳，存在时只返回原结果。
      const receipt = await this.connection.request(record.op, record.params as OpParams<CodeScheduleWriteOp>);
      this.store.clear(record.requestId);
      return { kind: "linked", requestId: record.requestId, receipt };
    } catch (error) {
      if (requestOutcome(error) === "rejected") {
        this.store.clear(record.requestId);
        return { kind: "rejected", requestId: record.requestId, code: error instanceof ControlClientError ? error.code : "request_failed", reason: (error as Error).message };
      }
      return { kind: "kept", requestId: record.requestId, reason: "原保存结果尚未核实，请恢复连接后查看。" };
    }
  }
}
