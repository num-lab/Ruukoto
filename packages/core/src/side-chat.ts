/** 侧聊的持久绑定与准备回执；消息正文仍只存在 JSONL。
 *
 * 父会话 ↔ 侧聊是一对一宿主绑定：parent_session_id 是主键，准备阶段即占用
 * 绑定，两个客户端并发打开不能各自冻结不同的快照。payload 是准备回执
 * （会话元数据 + 冻结历史清单 + 文件哈希 + 压缩点），SQLite 与文件系统不
 * 假定原子：发布中断后恢复只按回执与来源前缀重建，绝不取父会话最新历史。
 * Note: 见 .agents/notes/implemented/feature/2026-10-11-branch-session-snapshot.md
 */
import { StoreConflictError, type Store } from "./store.ts";
import type { ContextCheckpoint, Session } from "./types.ts";

/** side_chats.payload：发布前已准备好的侧聊事实。 */
export interface SideChatReceipt {
  session: Session;
  /** 来源前缀；file = null 表示父会话尚无落盘历史，目标文件只有独立 header。 */
  prefix: { file: string | null; dev: number; ino: number; byteLimit: number; fingerprint: string; cutEntryId: string | null };
  fileHash: string;
  fileBytes: number;
  checkpoint: ContextCheckpoint | null;
}

export type SideChatStatus = "prepared" | "published" | "failed";

export interface SideChatBinding {
  parentSessionId: string;
  sideSessionId: string;
  requestId: string;
  paramsDigest: string;
  receipt: SideChatReceipt;
  status: SideChatStatus;
  error: string | null;
  createdAt: string;
}

interface SideChatRow {
  parent_session_id: string;
  side_session_id: string;
  request_id: string;
  params_digest: string;
  payload: string;
  status: SideChatStatus;
  error: string | null;
  created_at: string;
}

function rowToBinding(row: SideChatRow): SideChatBinding {
  return {
    parentSessionId: row.parent_session_id,
    sideSessionId: row.side_session_id,
    requestId: row.request_id,
    paramsDigest: row.params_digest,
    receipt: JSON.parse(row.payload) as SideChatReceipt,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

export function getSideChatByParent(store: Store, parentSessionId: string): SideChatBinding | null {
  const row = store.db.prepare("SELECT * FROM side_chats WHERE parent_session_id = ?").get(parentSessionId) as SideChatRow | undefined;
  return row ? rowToBinding(row) : null;
}

export function getSideChatBySideSession(store: Store, sideSessionId: string): SideChatBinding | null {
  const row = store.db.prepare("SELECT * FROM side_chats WHERE side_session_id = ?").get(sideSessionId) as SideChatRow | undefined;
  return row ? rowToBinding(row) : null;
}

export function getSideChatByRequest(store: Store, requestId: string): SideChatBinding | null {
  const row = store.db.prepare("SELECT * FROM side_chats WHERE request_id = ?").get(requestId) as SideChatRow | undefined;
  return row ? rowToBinding(row) : null;
}

export function listSideChats(store: Store): SideChatBinding[] {
  const rows = store.db.prepare("SELECT * FROM side_chats ORDER BY created_at, side_session_id").all() as unknown as SideChatRow[];
  return rows.map(rowToBinding);
}

/**
 * 占用父会话的侧聊绑定并写入准备回执；调用方须在事务内调用。
 * 已建立绑定（任何状态）一律返回原绑定：重复打开复用同一冻结快照，
 * prepared/failed 由调用方继续驱动同一回执完成发布。
 */
export function reserveSideChat(store: Store, input: { parentSessionId: string; requestId: string; paramsDigest: string }, build: () => SideChatReceipt): SideChatBinding {
  const existing = getSideChatByParent(store, input.parentSessionId);
  if (existing) {
    if (existing.requestId === input.requestId && existing.paramsDigest !== input.paramsDigest) {
      throw new StoreConflictError("侧聊请求键已用于不同参数", "request_conflict");
    }
    return existing;
  }
  if (getSideChatByRequest(store, input.requestId)) throw new StoreConflictError("请求键已用于其他侧聊绑定", "request_conflict");
  if (store.findSessionByCreateRequestId(input.requestId)) throw new StoreConflictError("请求键已用于其他会话创建", "request_conflict");
  const receipt = build();
  store.db
    .prepare("INSERT INTO side_chats (parent_session_id, side_session_id, request_id, params_digest, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'prepared', ?)")
    .run(input.parentSessionId, receipt.session.id, input.requestId, input.paramsDigest, JSON.stringify(receipt), new Date().toISOString());
  return getSideChatByParent(store, input.parentSessionId)!;
}

/** 发布回执落盘（与会话行同一事务）；重复标记为 no-op。 */
export function markSideChatPublished(store: Store, parentSessionId: string): void {
  store.db.prepare("UPDATE side_chats SET status = 'published', error = NULL WHERE parent_session_id = ?").run(parentSessionId);
}

/** 准备或发布失败时保留回执供核实，error 记录失败原因。 */
export function markSideChatFailed(store: Store, parentSessionId: string, error: string): void {
  store.db.prepare("UPDATE side_chats SET status = 'failed', error = ? WHERE parent_session_id = ?").run(error, parentSessionId);
}
