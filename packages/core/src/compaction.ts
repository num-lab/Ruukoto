/** 手动压缩请求的接收与唯一终态；消息历史仍由 Runtime 只读核实。
 * Note: 见 .agents/notes/implemented/feature/2026-10-11-manual-context-compaction.md
 */
import { StoreConflictError, type Store } from "./store.ts";
import type { ContextCheckpoint, SessionCompactionRequest } from "./types.ts";

export function getCompactionRequest(store: Store, requestId: string): SessionCompactionRequest | null {
  const row = store.db.prepare("SELECT payload, status FROM compaction_requests WHERE request_id = ?").get(requestId) as
    { payload: string; status: SessionCompactionRequest["status"] } | undefined;
  return row ? { ...JSON.parse(row.payload) as SessionCompactionRequest, status: row.status } : null;
}

export function getLatestSessionCompaction(store: Store, sessionId: string): SessionCompactionRequest | null {
  const row = store.db.prepare("SELECT request_id FROM compaction_requests WHERE session_id = ? ORDER BY rowid DESC LIMIT 1").get(sessionId) as
    { request_id: string } | undefined;
  return row ? getCompactionRequest(store, row.request_id) : null;
}

/** 调用方在事务内接收；同键同参复用，活动任务与在途压缩不能共享会话。 */
export function reserveCompactionRequest(store: Store, request: SessionCompactionRequest): SessionCompactionRequest {
  const existing = getCompactionRequest(store, request.requestId);
  if (existing) {
    if (existing.paramsDigest !== request.paramsDigest || existing.sessionId !== request.sessionId) {
      throw new StoreConflictError("压缩请求键已用于不同参数", "request_conflict");
    }
    return existing;
  }
  if (store.db.prepare("SELECT 1 FROM tasks WHERE session_id = ? AND status IN ('queued','running','awaiting_confirmation') LIMIT 1").get(request.sessionId) ||
      store.db.prepare("SELECT 1 FROM compaction_requests WHERE session_id = ? AND status = 'running'").get(request.sessionId)) {
    throw new StoreConflictError("会话正由任务或压缩占用，请等待完成或先中断", "session_busy");
  }
  store.db.prepare("INSERT INTO compaction_requests (request_id, session_id, params_digest, payload, status) VALUES (?, ?, ?, ?, 'running')")
    .run(request.requestId, request.sessionId, request.paramsDigest, JSON.stringify(request));
  store.appendEvent({ type: "session.context_compaction", requestId: request.requestId, sessionId: request.sessionId, status: "running" }, { sessionId: request.sessionId });
  return request;
}

/** 首次准备后固定来源；取消或终态先成立时不修改操作记录。调用方在事务内。 */
export function updateCompactionSource(store: Store, requestId: string, source: SessionCompactionRequest["source"], expectedCheckpointId: string | null): SessionCompactionRequest {
  const request = requireCompactionRequest(store, requestId);
  if (request.status !== "running") return request;
  if (request.source !== null) throw new StoreConflictError("压缩来源已固定", "request_conflict");
  const updated = { ...request, source, expectedCheckpointId };
  store.db.prepare("UPDATE compaction_requests SET payload = ? WHERE request_id = ? AND status = 'running'").run(JSON.stringify(updated), requestId);
  return updated;
}

export type CompactionResult = Partial<Pick<SessionCompactionRequest, "summarizedCount" | "estimateBefore" | "estimateAfter" | "errorCode" | "errorMessage">> & {
  status: Exclude<SessionCompactionRequest["status"], "running">;
};

/** 调用方在同一事务内核实源历史；成功同时写点、结果和事件，取消先成立则原样返回。 */
export function finishCompactionRequest(store: Store, requestId: string, result: CompactionResult, checkpoint?: Omit<ContextCheckpoint, "status">): SessionCompactionRequest {
  const request = requireCompactionRequest(store, requestId);
  if (request.status !== "running") return request;
  if (result.status === "succeeded") {
    if (!checkpoint || checkpoint.sessionId !== request.sessionId || checkpoint.manualRequestId !== requestId || checkpoint.taskId !== null || checkpoint.callIndex !== null) {
      throw new StoreConflictError("压缩点来源与手动请求不匹配", "checkpoint_conflict");
    }
    if ((store.getActiveCheckpoint(request.sessionId)?.id ?? null) !== request.expectedCheckpointId) {
      throw new StoreConflictError("原压缩点已改变，请核实会话后重新压缩", "checkpoint_conflict");
    }
    store.insertCheckpoint(checkpoint);
  }
  const finished: SessionCompactionRequest = { ...request, ...result, checkpointId: result.status === "succeeded" ? checkpoint!.id : null,
    endedAt: new Date().toISOString() };
  store.db.prepare("UPDATE compaction_requests SET payload = ?, status = ? WHERE request_id = ? AND status = 'running'")
    .run(JSON.stringify(finished), finished.status, requestId);
  store.appendEvent({ type: "session.context_compaction", requestId, sessionId: request.sessionId, status: finished.status }, { sessionId: request.sessionId });
  return finished;
}

/** 启动时在事务内收尾遗留操作；已提交的成功不变，也不重发摘要调用。 */
export function recoverCompactionRequests(store: Store): SessionCompactionRequest[] {
  const rows = store.db.prepare("SELECT request_id FROM compaction_requests WHERE status = 'running'").all() as Array<{ request_id: string }>;
  return rows.map(row => finishCompactionRequest(store, row.request_id, { status: "interrupted", errorCode: "backend_interrupted",
    errorMessage: "后台重启中断了压缩，原压缩点未替换；可重新执行 /compact" }));
}

function requireCompactionRequest(store: Store, requestId: string): SessionCompactionRequest {
  const request = getCompactionRequest(store, requestId);
  if (!request) throw new StoreConflictError("压缩请求不存在，请核实原会话与请求", "not_found");
  return request;
}
