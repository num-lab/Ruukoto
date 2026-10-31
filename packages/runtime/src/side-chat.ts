/** 侧聊创建/重开与恢复：父会话唯一绑定，固定首次安全快照，准备回执跨重启保留。
 *
 * 与分支共用同一套快照核实与文件发布机制，但产物不是新分支：侧聊会话的
 * branchSource 是冻结清单（number 固定 0，不占分支编号），身份由 side_chats
 * 绑定判定，无独立模型配置（任务固定父会话受理时的选择）。空父会话（尚无
 * 落盘历史）用独立空 JSONL 起步；登记过历史但文件缺失按损坏处理，不静默
 * 降级为空白侧聊。
 * Note: 见 .agents/notes/implemented/feature/2026-10-29-coding-side-chat.md
 * Note: 见 .agents/notes/implemented/feature/2026-10-11-branch-session-snapshot.md
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkpointFingerprint } from "@ruukoto/agent/compaction.ts";
import { effectiveBranchHistoryBytes, emptyHistoryBytes, prepareSessionHistoryFile } from "@ruukoto/agent/session-factory.ts";
import { parseTodos } from "@ruukoto/agent/todo.ts";
import type { AccessScope } from "@ruukoto/core/access.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { HistoryReadError, historyTodoParams, readHistoryPrefix, snapshotSessionHistory } from "@ruukoto/core/history.ts";
import {
  getSideChatByParent,
  getSideChatByRequest,
  markSideChatFailed,
  markSideChatPublished,
  reserveSideChat,
  type SideChatBinding,
  type SideChatReceipt,
} from "@ruukoto/core/side-chat.ts";
import { StoreConflictError, type Store } from "@ruukoto/core/store.ts";
import { randomId, type Session, type SessionBranchSource } from "@ruukoto/core/types.ts";
import { snapshotSources } from "./branch-session.ts";

export interface SideChatDeps {
  store: Store;
  access: AccessScope;
  sessionsDir: string;
  enabled: boolean;
  validate(session: Session): Promise<void>;
}

function publish(deps: SideChatDeps, binding: SideChatBinding): Session {
  const receipt = binding.receipt;
  prepareSessionHistoryFile(receipt);
  return deps.store.withTx(() => {
    const session = receipt.session;
    const created = deps.store.createSession({ ...session, branchSession: session });
    if (receipt.checkpoint) deps.store.insertCheckpoint(receipt.checkpoint);
    markSideChatPublished(deps.store, binding.parentSessionId);
    deps.store.appendEvent(
      { type: "side_chat.bound", parentSessionId: binding.parentSessionId, sideSessionId: created.id },
      { sessionId: binding.parentSessionId },
    );
    return created;
  });
}

function publishedSession(deps: SideChatDeps, binding: SideChatBinding): Session {
  const session = deps.store.getSession(binding.sideSessionId);
  if (!session?.sessionFile || !fs.existsSync(session.sessionFile)) {
    throw new RuntimeApiError("history_corrupt", "已发布侧聊的历史文件缺失，请恢复历史");
  }
  return session;
}

function buildReceipt(deps: SideChatDeps, source: Session, snapshot: ReturnType<typeof snapshotSessionHistory> | null, requestId: string): SideChatReceipt {
  const now = new Date().toISOString();
  const title = source.name ?? `未命名会话 · ${source.id.slice(0, 14)}…`;
  const branchSource: SessionBranchSource = snapshot
    ? snapshotSources(deps, source, snapshot, 0)
    : { sessionId: source.id, number: 0, entryId: "", messageCount: 0, excluded: [], taskIds: [], artifacts: [], results: [] };
  const session: Session = {
    ...source,
    id: randomId("sess"),
    piSessionId: randomUUID(),
    name: `${title} · 侧聊`,
    branchSource,
    // 侧聊没有独立模型与模式配置；任务固定父会话受理时的选择（R12）
    modelSelection: null,
    modelSelectionVersion: 0,
    defaultAccessModeVersion: 0,
    createRequestId: requestId,
    queueState: "active",
    queuePauseReason: null,
    queueRevision: 0,
    archivedAt: null,
    createdAt: now,
  };
  session.sessionFile = path.join(deps.sessionsDir, `${now.replace(/[:.]/g, "-")}_${session.piSessionId}.jsonl`);
  const prefix = snapshot
    ? { file: snapshot.file, dev: snapshot.dev, ino: snapshot.ino, byteLimit: snapshot.byteLimit, fingerprint: snapshot.fingerprint, cutEntryId: snapshot.cutEntryId }
    : { file: null, dev: 0, ino: 0, byteLimit: 0, fingerprint: "", cutEntryId: null };
  const bytes = snapshot ? effectiveBranchHistoryBytes(session, readHistoryPrefix(source.sessionFile!, prefix), snapshot.cutEntryId) : emptyHistoryBytes(session);
  const messages = snapshot ? snapshot.entries.filter(e => e.type === "message").map(e => e.message) : [];
  const cp = deps.store.getActiveCheckpoint(source.id);
  const ids = new Set(snapshot?.entries.map(entry => entry.id) ?? []);
  const checkpoint = snapshot && cp && Number.isSafeInteger(cp.summarizedCount) && Number.isSafeInteger(cp.clearedCount) && cp.summarizedCount >= 0 && cp.summarizedCount <= cp.clearedCount && cp.clearedCount <= messages.length &&
    Object.values(cp.clearedRefs).every(id => id === null || ids.has(id)) && cp.fingerprint === checkpointFingerprint(messages, cp.clearedCount)
    ? { ...cp, id: randomId("ckpt"), sessionId: session.id } : null;
  return { session, prefix, fileHash: createHash("sha256").update(bytes).digest("hex"), fileBytes: bytes.length, checkpoint };
}

/**
 * 打开侧聊（创建或重开）：每个父会话只冻结一次安全快照，重复打开（同键
 * 或新键）一律返回原绑定；prepared/failed 由同一回执继续驱动，不重新取
 * 父会话最新历史。
 */
export async function openSideChat(deps: SideChatDeps, input: { sessionId: string; requestId: string }): Promise<Session> {
  if (!deps.enabled) throw new RuntimeApiError("unavailable", "当前产品不提供侧聊");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) throw new RuntimeApiError("invalid_params", "侧聊请求键无效");
  const digest = createHash("sha256").update(JSON.stringify([input.sessionId])).digest("hex");
  const byKey = getSideChatByRequest(deps.store, input.requestId);
  if (byKey && byKey.parentSessionId !== input.sessionId) throw new RuntimeApiError("request_conflict", "侧聊请求键已用于其他父会话");
  let binding = getSideChatByParent(deps.store, input.sessionId);
  if (binding?.status === "published") return publishedSession(deps, binding);
  const source = deps.store.getSession(input.sessionId);
  if (!source) throw new RuntimeApiError("not_found", "父会话不存在");
  await deps.validate(source);
  try {
    const fresh = deps.store.getSession(input.sessionId);
    if (!fresh || deps.store.getSessionIdentity(fresh.id)?.kind !== "dev" || fresh.workspaceProjectId !== source.workspaceProjectId || fresh.projectId !== source.projectId) {
      throw new RuntimeApiError("source_changed", "父会话身份或工作区映射已改变，请核实后再打开侧聊");
    }
    const snapshotSource = fresh;
    // 目录核实会让出执行权，绑定可能已经被另一客户端占用并发布。
    binding = getSideChatByParent(deps.store, input.sessionId);
    if (binding && binding.requestId === input.requestId && binding.paramsDigest !== digest) throw new RuntimeApiError("request_conflict", "侧聊请求键已用于不同参数");
    if (binding?.status === "published") return publishedSession(deps, binding);
    if (!binding) {
      let snapshot: ReturnType<typeof snapshotSessionHistory> | null = null;
      if (snapshotSource.sessionFile) {
        if (!fs.existsSync(snapshotSource.sessionFile)) throw new RuntimeApiError("history_corrupt", "父会话已登记的历史文件缺失，无法核实侧聊起点");
        snapshot = snapshotSessionHistory(snapshotSource.sessionFile, id => deps.store.getTask(id)?.status ?? null, { allowEmpty: true });
        if (snapshot.entries[0]!.id !== snapshotSource.piSessionId) throw new RuntimeApiError("history_corrupt", "父会话历史 header 与登记的 pi 会话身份不符");
        const todos = historyTodoParams(snapshot.entries);
        if (todos !== null) {
          try { parseTodos(todos); }
          catch { throw new RuntimeApiError("history_corrupt", "父会话工作清单参数损坏，无法建立侧聊"); }
        }
      }
      binding = deps.store.withTx(() => reserveSideChat(deps.store, { parentSessionId: snapshotSource.id, requestId: input.requestId, paramsDigest: digest }, () => buildReceipt(deps, snapshotSource, snapshot, input.requestId)));
    }
    return publish(deps, binding);
  } catch (error) {
    const committed = getSideChatByParent(deps.store, input.sessionId);
    if (committed?.status === "published") return publishedSession(deps, committed);
    if (error instanceof HistoryReadError || error instanceof StoreConflictError) throw new RuntimeApiError(error.code, error.message);
    if (error instanceof RuntimeApiError) throw error;
    process.stderr.write(`[ruukoto:side-chat] 请求 ${input.requestId} 准备失败：${(error as Error).message}\n`);
    throw new RuntimeApiError("side_chat_prepare_failed", "侧聊尚未发布；请按原请求键核实或重试");
  }
}

/** 恢复使用原回执和前缀，失败保留可查询原因，不发布缺历史的会话。 */
export async function recoverSideChats(deps: SideChatDeps): Promise<void> {
  const rows = deps.store.db.prepare("SELECT parent_session_id FROM side_chats WHERE status = 'prepared'").all() as Array<{ parent_session_id: string }>;
  for (const row of rows) {
    const binding = getSideChatByParent(deps.store, row.parent_session_id)!;
    try {
      const source = deps.store.getSession(binding.parentSessionId);
      if (!deps.enabled || !source) throw new RuntimeApiError("unavailable", "侧聊来源或产品能力不可用");
      await deps.validate(source);
      publish(deps, binding);
    } catch (error) {
      const reason = error instanceof RuntimeApiError || error instanceof HistoryReadError ? error.message : "侧聊文件准备或元数据登记失败";
      deps.store.withTx(() => markSideChatFailed(deps.store, row.parent_session_id, reason));
    }
  }
}
