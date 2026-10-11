/** 会话分支的准备回执与限定来源；消息正文仍只存在 JSONL。
 * Note: 见 .agents/notes/implemented/feature/2026-10-11-branch-session-snapshot.md
 */
import { AccessDeniedError, type AccessScope } from "./access.ts";
import type { HistorySnapshot } from "./history.ts";
import { StoreConflictError, type Store } from "./store.ts";
import type { Artifact, ContextCheckpoint, Session } from "./types.ts";

export interface BranchRequest {
  requestId: string;
  paramsDigest: string;
  branchNumber: number;
  session: Session;
  prefix: Omit<HistorySnapshot, "entries" | "entryId" | "messageCount" | "excluded">;
  fileHash: string;
  fileBytes: number;
  checkpoint: ContextCheckpoint | null;
  status: "prepared" | "published" | "failed";
  error: string | null;
}

export function getBranchRequest(store: Store, requestId: string): BranchRequest | null {
  const row = store.db.prepare("SELECT payload, status, error FROM branch_requests WHERE request_id = ?").get(requestId) as { payload: string; status: BranchRequest["status"]; error: string | null } | undefined;
  return row ? { ...JSON.parse(row.payload) as BranchRequest, status: row.status, error: row.error } : null;
}

/** 调用方在事务内分配编号及固定元数据，同键异参不覆盖准备回执。 */
export function reserveBranchRequest(store: Store, requestId: string, sourceId: string, digest: string, build: (number: number) => BranchRequest): BranchRequest {
  const existing = getBranchRequest(store, requestId);
  if (existing) {
    if (existing.paramsDigest !== digest) throw new StoreConflictError("分支请求键已用于不同参数", "request_conflict");
    return existing;
  }
  if (store.findSessionByCreateRequestId(requestId)) throw new StoreConflictError("请求键已用于其他会话创建", "request_conflict");
  const row = store.db.prepare(`SELECT MAX(
    COALESCE((SELECT MAX(branch_number) FROM branch_requests WHERE source_session_id = ?), 0),
    COALESCE((SELECT MAX(json_extract(branch_source, '$.number')) FROM sessions WHERE json_extract(branch_source, '$.sessionId') = ?), 0)) + 1 AS n`).get(sourceId, sourceId) as { n: number };
  const request = build(row.n);
  store.db.prepare("INSERT INTO branch_requests (request_id, source_session_id, branch_number, params_digest, payload, status) VALUES (?, ?, ?, ?, ?, 'prepared')")
    .run(requestId, sourceId, row.n, digest, JSON.stringify(request));
  return request;
}

export function sourceArtifact(store: Store, access: AccessScope, sessionId: string, artifactId: string): Artifact | null {
  const session = store.getSession(sessionId);
  const frozen = session?.branchSource?.artifacts.find(a => a.id === artifactId);
  if (!frozen || !session) return null;
  const current = store.getArtifact(artifactId);
  const source = store.getSession(frozen.sessionId);
  if (!current || !source || current.sessionId !== frozen.sessionId || current.taskId !== frozen.taskId ||
      current.byteCount < frozen.byteCount || current.mimeType !== frozen.mimeType || current.contentHash !== frozen.contentHash) {
    throw new AccessDeniedError("分支来源产物缺失或元数据已改变");
  }
  access.assertAccess({ kind: "agent", projectId: session.projectId }, source.projectId, "artifact", "分支来源产物");
  return frozen;
}

export function sourceResultTasks(store: Store, access: AccessScope, sessionId: string, workId: string): string[] | null {
  const session = store.getSession(sessionId);
  const result = session?.branchSource?.results.find(r => r.workId === workId);
  if (!result || !session) return null;
  for (const id of result.taskIds) {
    const task = store.getTask(id);
    const source = task && store.getSession(task.sessionId);
    if (!task || task.status !== "completed" || !source) throw new AccessDeniedError("分支来源结果缺失或不再可核实");
    access.assertAccess({ kind: "agent", projectId: session.projectId }, source.projectId, "history", "分支来源结果");
  }
  return result.taskIds;
}
