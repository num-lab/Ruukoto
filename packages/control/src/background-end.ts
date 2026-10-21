import { randomId } from "@ruukoto/core/types.ts";
import { ControlClientError, requestOutcome } from "./client.ts";
import type { ControlConnection } from "./connection.ts";
import type { OpResult } from "./ops.ts";
import type { PendingRequest, PendingRequestStore } from "./pending-requests.ts";

export type BackgroundEndOutcome =
  | { kind: "accepted"; result: OpResult<"session_background_end"> }
  | { kind: "pending"; record: PendingRequest; message: string };

/** 关闭键发送前落盘；未知结果只保留原键，重试须由拥有者显式选择。 */
export class BackgroundEndGuard {
  constructor(private readonly store: PendingRequestStore, private readonly connection: Pick<ControlConnection, "request" | "instanceId">) {}

  async end(sessionId: string, retryRequestId?: string): Promise<BackgroundEndOutcome> {
    const instanceId = this.connection.instanceId;
    if (!instanceId) throw new ControlClientError("connection_unavailable", "尚未连接后台，本次没有结束会话后台。", "not_sent");
    let saved;
    try { saved = this.store.list(true); }
    catch { throw new ControlClientError("pending_record_unavailable", "客户端原请求目录无法读取；请保留原记录并恢复访问后重核，本次没有发送新请求。", "not_sent"); }
    if (saved.corrupt.length) throw new ControlClientError("pending_record_invalid", "存在无法核实的客户端请求记录；请保留原文件并恢复记录后再结束后台。", "not_sent");
    const existing = saved.records.find(record => record.op === "session_background_end" && record.instanceId === instanceId && record.params.session_id === sessionId);
    if (existing && retryRequestId !== existing.requestId) return { kind: "pending", record: existing, message: "原结束请求待核实；先刷新状态，再选择重核原结束请求。" };
    if (!existing && retryRequestId) throw new ControlClientError("request_unavailable", "原结束请求记录不可用；请保留当前状态并重新连接核实。", "not_sent");
    const record: PendingRequest = existing ?? { requestId: randomId("req"), op: "session_background_end", instanceId, createdAt: new Date().toISOString(), params: { session_id: sessionId } };
    record.params.request_id = record.requestId;
    if (!existing) {
      try { this.store.save(record); }
      catch { throw new ControlClientError("pending_write_failed", "原结束请求无法保存，本次没有发送；请恢复客户端数据目录后重试。", "not_sent"); }
    }
    try {
      const result = await this.connection.request("session_background_end", { session_id: sessionId, request_id: record.requestId });
      this.store.clear(record.requestId);
      return { kind: "accepted", result };
    } catch (error) {
      const outcome = requestOutcome(error);
      if (!existing && (outcome === "rejected" || outcome === "not_sent") && !(error instanceof ControlClientError && error.code === "request_conflict")) {
        this.store.clear(record.requestId);
        throw error;
      }
      return { kind: "pending", record, message: "结束本会话后台的应答尚未核实；原请求已保留，请刷新状态后重核原结束请求。" };
    }
  }
}
