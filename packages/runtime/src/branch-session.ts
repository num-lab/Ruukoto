/** 固定快照、准备独立文件后发布会话；请求回执跨后台重启保留。
 * Note: 见 .agents/notes/implemented/feature/2026-10-11-branch-session-snapshot.md
 * Note: 见 .agents/notes/implemented/feature/2026-10-28-desktop-message-actions.md
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkpointFingerprint } from "@ruukoto/agent/compaction.ts";
import { branchHistoryBytes, prepareBranchHistory } from "@ruukoto/agent/session-factory.ts";
import { parseTodos } from "@ruukoto/agent/todo.ts";
import type { AccessScope } from "@ruukoto/core/access.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { getBranchRequest, reserveBranchRequest, sourceArtifact, sourceResultTasks, type BranchRequest } from "@ruukoto/core/branch.ts";
import { HistoryReadError, historyTodoParams, readHistoryPrefix, snapshotSessionHistory, type HistorySnapshot } from "@ruukoto/core/history.ts";
import { StoreConflictError, type Store } from "@ruukoto/core/store.ts";
import { randomId, TASK_START_MARKER, type Artifact, type PersistentEventBody, type Session, type SessionBranchSource } from "@ruukoto/core/types.ts";
import { canonicalJson } from "@ruukoto/core/import-files.ts";

export interface BranchSessionDeps {
  store: Store;
  access: AccessScope;
  sessionsDir: string;
  enabled: boolean;
  validate(session: Session): Promise<void>;
}

export function snapshotSources(deps: BranchSessionDeps, source: Session, snapshot: HistorySnapshot, number: number): SessionBranchSource {
  const { store, access } = deps;
  const tasks = new Set<string>();
  const artifacts = new Map<string, Artifact>();
  let calls = new Map<string, { name: string; params: unknown; at: number }>();
  let taskOps: ReturnType<Store["listToolOpsByTask"]> = [];
  let taskId: string | null = null;
  const addArtifact = (id: string, owner?: string) => {
    const artifact = store.getArtifact(id);
    if (!artifact || (owner && artifact.taskId !== owner) || artifact.name.startsWith("prompt-snapshot:")) return;
    const session = store.getSession(artifact.sessionId);
    if (!session || !access.canAccess({ kind: "agent", projectId: source.projectId }, session.projectId, "artifact")) return;
    const inherited = source.branchSource?.artifacts.find(a => a.id === id);
    artifacts.set(id, inherited ? sourceArtifact(store, access, source.id, id)! : { ...artifact });
  };
  for (const entry of snapshot.entries) {
    if (entry.type === "custom" && entry.customType === TASK_START_MARKER) {
      taskId = (entry.data as { taskId: string }).taskId;
      const task = store.getTask(taskId);
      if (!task || (task.sessionId !== source.id && !source.branchSource?.taskIds.includes(taskId))) {
        throw new RuntimeApiError("history_corrupt", "分支历史任务不属于已核实的来源");
      }
      tasks.add(taskId);
      taskOps = store.listToolOpsByTask(taskId);
      calls.clear();
    }
    if (entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role === "assistant") {
      calls = new Map(Array.isArray(message.content) ? message.content.filter(p => p?.type === "toolCall").map(p => [p.id, { name: p.name, params: p.arguments, at: Number(message.timestamp) }]) : []);
    }
    if (message.role === "toolResult" && taskId && typeof message.toolCallId === "string") {
      const call = calls.get(message.toolCallId);
      const matching = call ? taskOps.filter(op => op.sdkCallId === message.toolCallId && op.toolName === call.name &&
        canonicalJson(op.params) === canonicalJson(call.params) && Date.parse(op.intentRecordedAt) >= call.at && op.recordedResultAt && Date.parse(op.recordedResultAt) <= Number(message.timestamp)) : [];
      if (matching.length > 1) throw new RuntimeApiError("history_corrupt", "无法核实重复调用 ID 对应的宿主产物来源");
      const op = matching[0];
      if (op) {
        const row = store.db.prepare("SELECT body FROM events WHERE task_id = ? AND json_extract(body, '$.type') = 'task.tool_result' AND json_extract(body, '$.toolOpId') = ? LIMIT 1").get(taskId, op.id) as { body: string } | undefined;
        const event = row ? JSON.parse(row.body) as Extract<PersistentEventBody, { type: "task.tool_result" }> : null;
        for (const id of event?.artifactIds ?? []) addArtifact(id, taskId);
        if (op.toolName === "read_artifact" && op.isError === false && typeof op.params.artifact_id === "string") addArtifact(op.params.artifact_id);
      }
      calls.delete(message.toolCallId);
    }
    // 引导输入的附件/图片绑定源 Task（无本分支 start marker）：按 joined 路由核实——
    // 消息携带的源 ID 必须等于产物归属任务、路由已 joined 到本历史条且目标在分支任务内。
    const guidanceVerified = (taskIdOfRef: string, entryId: string): boolean => {
      if (message.ruukotoSourceTaskId !== taskIdOfRef) return false;
      const route = store.getTaskGuidance(taskIdOfRef);
      return route !== null && route.state === "joined" && route.entryId === entryId && tasks.has(route.targetTaskId);
    };
    if (message.ruukotoAttachmentRefs !== undefined) {
      if (message.role !== "user" || !Array.isArray(message.ruukotoAttachmentRefs)) throw new RuntimeApiError("history_corrupt", "历史附件引用格式无效");
      for (const ref of message.ruukotoAttachmentRefs as import("@ruukoto/core/attachments.ts").AttachmentReference[]) {
        const artifact = store.getArtifact(ref.id);
        const inherited = source.branchSource?.artifacts.some(item => item.id === ref.id);
        const recorded = store.taskAttachments(ref.taskId).some(item => canonicalJson(item) === canonicalJson(ref));
        if (!recorded || !artifact || artifact.taskId !== ref.taskId || artifact.sessionId !== ref.sessionId || artifact.name !== ref.name || artifact.contentHash !== ref.contentHash || artifact.byteCount !== ref.size || artifact.status !== "complete" || (!inherited && !tasks.has(ref.taskId) && !guidanceVerified(ref.taskId, entry.id))) throw new RuntimeApiError("attachment_reference_invalid", "历史附件缺少宿主核实的来源");
        addArtifact(ref.id, ref.taskId);
        if (!artifacts.has(ref.id)) throw new RuntimeApiError("access_denied", "历史附件的资料读取范围已失效");
      }
    }
    if (message.ruukotoMediaRefs !== undefined) {
      if (message.role !== "user" || !Array.isArray(message.ruukotoMediaRefs)) throw new RuntimeApiError("history_corrupt", "历史图片引用格式无效");
      for (const raw of message.ruukotoMediaRefs as Array<Record<string, unknown>>) {
        const artifact = typeof raw?.artifactId === "string" ? store.getArtifact(raw.artifactId) : null;
        const task = artifact && store.getTask(artifact.taskId);
        const inbound = task?.sourceEventId ? store.getInboundEvent(task.sourceEventId) : null;
        const inherited = artifact && source.branchSource?.artifacts.find(a => a.id === artifact.id);
        const attachment = artifact && store.taskAttachments(artifact.taskId).some(ref => ref.id === artifact.id && ref.contentHash === artifact.contentHash);
        if (!artifact || artifact.sessionId !== raw.sessionId || artifact.taskId !== raw.taskId || artifact.mimeType !== raw.mimeType ||
            artifact.byteCount !== raw.byteCount || artifact.contentHash !== raw.contentHash || artifact.status !== "complete" ||
            (!inherited && !tasks.has(artifact.taskId) && !guidanceVerified(artifact.taskId, entry.id) && (!attachment && (inbound?.taskId !== artifact.taskId || !inbound.artifactRefs.includes(artifact.id))))) {
          throw new RuntimeApiError("image_reference_invalid", "历史图片缺少宿主核实的来源");
        }
        addArtifact(artifact.id, artifact.taskId);
        if (!artifacts.has(artifact.id)) throw new RuntimeApiError("access_denied", "历史图片的资料读取范围已失效");
      }
    }
  }
  const lastEntry = snapshot.entries.at(-1)!;
  const lastMessage = snapshot.entries.findLast(entry => entry.type === "message");
  const entryTime = typeof lastEntry.timestamp === "number" ? lastEntry.timestamp : Date.parse(String(lastEntry.timestamp));
  const message = lastMessage?.message as { timestamp?: unknown } | undefined;
  const messageTime = message && typeof message.timestamp === "number" ? message.timestamp : lastMessage ? Date.parse(String(lastMessage.timestamp)) : Number.NaN;
  const until = Number.isFinite(entryTime) ? entryTime : messageTime;
  if (!Number.isFinite(until)) throw new RuntimeApiError("history_corrupt", "分支时间戳无法核实");
  // 祖先范围只继承原清单，不查询祖先的新增资料。
  for (const frozen of source.branchSource?.artifacts ?? []) if (tasks.has(frozen.taskId)) addArtifact(frozen.id);
  const results = new Map<string, string[]>();
  for (const old of source.branchSource?.results ?? []) {
    const work = store.getWorkDelegation(old.workId);
    if (!work || !tasks.has(work.originTaskId)) continue;
    const available = new Set(old.taskIds.filter(id => {
      const task = store.getTask(id);
      return task?.status === "completed" && task.endedAt !== null && Date.parse(task.endedAt) <= until;
    }));
    const validated = (sourceResultTasks(store, access, source.id, old.workId) ?? []).filter(id => available.has(id));
    if (!validated.length) continue;
    results.set(old.workId, validated);
    for (const artifact of source.branchSource!.artifacts) if (validated.includes(artifact.taskId)) addArtifact(artifact.id, artifact.taskId);
  }
  for (const work of store.listWorkDelegationsBySession(source.id)) {
    if (!tasks.has(work.originTaskId)) continue;
    const completed = store.listTasksByWork(work.id).filter(task => task.status === "completed" && task.endedAt && Date.parse(task.endedAt) <= until);
    if (!completed.length) continue;
    results.set(work.id, completed.map(task => task.id));
    for (const task of completed) for (const artifact of store.listArtifactsByTask(task.id)) addArtifact(artifact.id, task.id);
  }
  return { sessionId: source.id, number, entryId: snapshot.entryId, messageCount: snapshot.messageCount, excluded: snapshot.excluded,
    taskIds: [...tasks], artifacts: [...artifacts.values()], results: [...results].map(([workId, taskIds]) => ({ workId, taskIds })) };
}

function publish(deps: BranchSessionDeps, request: BranchRequest): Session {
  prepareBranchHistory(request);
  return deps.store.withTx(() => {
    const session = request.session;
    const created = deps.store.createSession({ ...session, branchSession: session });
    if (request.checkpoint) deps.store.insertCheckpoint(request.checkpoint);
    deps.store.db.prepare("UPDATE branch_requests SET status = 'published', error = NULL WHERE request_id = ?").run(request.requestId);
    return created;
  });
}

function publishedSession(deps: BranchSessionDeps, request: BranchRequest): Session {
  const session = deps.store.getSession(request.session.id);
  if (!session?.sessionFile || !fs.existsSync(session.sessionFile)) throw new RuntimeApiError("history_corrupt", "已创建分支的历史文件缺失，请恢复历史");
  return session;
}

export async function branchSession(deps: BranchSessionDeps, input: { sessionId: string; name?: string; taskId?: string; requestId: string }): Promise<Session> {
  if (!deps.enabled) throw new RuntimeApiError("unavailable", "当前产品不提供会话分支");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || (input.name !== undefined && (!input.name.trim() || input.name.length > 512))) {
    throw new RuntimeApiError("invalid_params", "分支请求键或名称无效（名称最多 512 字符）");
  }
  // 未带 task_id 时沿用旧参数形状，升级后仍能核实原请求键。
  const digest = createHash("sha256").update(JSON.stringify(input.taskId === undefined ? [input.sessionId, input.name ?? null] : [input.sessionId, input.name ?? null, input.taskId])).digest("hex");
  let request = getBranchRequest(deps.store, input.requestId);
  if (request && request.paramsDigest !== digest) throw new RuntimeApiError("request_conflict", "分支请求键已用于不同参数");
  if (request?.status === "published") {
    return publishedSession(deps, request);
  }
  const source = deps.store.getSession(input.sessionId);
  if (!source) throw new RuntimeApiError("not_found", "来源会话不存在");
  if (input.taskId !== undefined) {
    const task = deps.store.getTask(input.taskId);
    if (!task || (task.sessionId !== source.id && !source.branchSource?.taskIds.includes(input.taskId))) {
      throw new RuntimeApiError("invalid_params", "分支任务不属于来源会话");
    }
    if (task.status !== "completed") throw new RuntimeApiError("invalid_params", "只有已完成任务可以建立分支");
  }
  await deps.validate(source);
  try {
    const fresh = deps.store.getSession(input.sessionId);
    if (!fresh || deps.store.getSessionIdentity(fresh.id)?.kind !== "dev" || fresh.workspaceProjectId !== source.workspaceProjectId || fresh.projectId !== source.projectId) {
      throw new RuntimeApiError("source_changed", "来源身份或工作区映射已改变，请核实后再分支");
    }
    const snapshotSource = fresh;
    // 目录核实会让出执行权，同键请求可能已经完成发布。
    request = getBranchRequest(deps.store, input.requestId);
    if (request && request.paramsDigest !== digest) throw new RuntimeApiError("request_conflict", "分支请求键已用于不同参数");
    if (request?.status === "published") return publishedSession(deps, request);
    if (!request) {
      if (!snapshotSource.sessionFile || !fs.existsSync(snapshotSource.sessionFile)) {
        if (snapshotSource.branchSource) throw new RuntimeApiError("history_corrupt", "来源分支的历史文件缺失，请恢复历史后再分支");
        throw new RuntimeApiError("history_empty", "尚无可复制的已落盘消息，请等待落盘或使用 /new");
      }
      const snapshot = snapshotSessionHistory(snapshotSource.sessionFile, id => deps.store.getTask(id)?.status ?? null, { throughTaskId: input.taskId });
      if (snapshot.entries[0]!.id !== snapshotSource.piSessionId) throw new RuntimeApiError("history_corrupt", "来源历史 header 与登记的 pi 会话身份不符");
      const todos = historyTodoParams(snapshot.entries);
      if (todos !== null) {
        try { parseTodos(todos); }
        catch { throw new RuntimeApiError("history_corrupt", "来源工作清单参数损坏，无法建立分支"); }
      }
      request = deps.store.withTx(() => reserveBranchRequest(deps.store, input.requestId, snapshotSource.id, digest, branchNumber => {
        const title = deps.store.listSessionSummaries(snapshotSource.projectId).find(row => row.sessionId === snapshotSource.id)?.name ?? `未命名会话 · ${snapshotSource.id.slice(0, 14)}…`;
        const now = new Date().toISOString();
        const session: Session = { ...snapshotSource, id: randomId("sess"), piSessionId: randomUUID(), name: input.name ?? `${title} · 分支 ${branchNumber}`,
          branchSource: snapshotSources(deps, snapshotSource, snapshot, branchNumber), modelSelectionVersion: snapshotSource.modelSelection ? 1 : 0, defaultAccessModeVersion: 0,
          createRequestId: input.requestId, queueState: "active", queuePauseReason: null, createdAt: now };
        session.sessionFile = path.join(deps.sessionsDir, `${now.replace(/[:.]/g, "-")}_${session.piSessionId}.jsonl`);
        const { entries: _entries, entryId: _id, messageCount: _count, excluded: _excluded, ...prefix } = snapshot;
        const sourceBytes = readHistoryPrefix(snapshotSource.sessionFile!, prefix);
        const bytes = branchHistoryBytes(session, sourceBytes);
        const messages = snapshot.entries.filter(e => e.type === "message").map(e => e.message);
        const cp = deps.store.getActiveCheckpoint(snapshotSource.id);
        const ids = new Set(snapshot.entries.map(entry => entry.id));
        // 手动来源标识随点复制；操作回执与取消资格只属于原实例、原会话。
        const checkpoint = cp && Number.isSafeInteger(cp.summarizedCount) && Number.isSafeInteger(cp.clearedCount) && cp.summarizedCount >= 0 && cp.summarizedCount <= cp.clearedCount && cp.clearedCount <= messages.length &&
          Object.values(cp.clearedRefs).every(id => id === null || ids.has(id)) && cp.fingerprint === checkpointFingerprint(messages, cp.clearedCount)
          ? { ...cp, id: randomId("ckpt"), sessionId: session.id } : null;
        return { requestId: input.requestId, paramsDigest: digest, branchNumber, session, prefix,
          fileHash: createHash("sha256").update(bytes).digest("hex"), fileBytes: bytes.length, checkpoint, status: "prepared", error: null };
      }));
    }
    return publish(deps, request);
  } catch (error) {
    const committed = getBranchRequest(deps.store, input.requestId);
    if (committed?.status === "published") return publishedSession(deps, committed);
    if (error instanceof HistoryReadError || error instanceof StoreConflictError) throw new RuntimeApiError(error.code, error.message);
    if (error instanceof RuntimeApiError) throw error;
    process.stderr.write(`[ruukoto:branch] 请求 ${input.requestId} 准备失败：${(error as Error).message}\n`);
    throw new RuntimeApiError("branch_prepare_failed", "分支尚未发布；请按原请求键核实或重试");
  }
}

/** 恢复使用原回执和前缀，失败保留可查询原因，不发布缺历史的会话。 */
export async function recoverBranchSessions(deps: BranchSessionDeps): Promise<void> {
  const rows = deps.store.db.prepare("SELECT request_id FROM branch_requests WHERE status = 'prepared'").all() as Array<{ request_id: string }>;
  for (const row of rows) {
    const request = getBranchRequest(deps.store, row.request_id)!;
    try {
      const source = deps.store.getSession(request.session.branchSource!.sessionId);
      if (!deps.enabled || !source) throw new RuntimeApiError("unavailable", "分支来源或产品能力不可用");
      await deps.validate(source);
      publish(deps, request);
    } catch (error) {
      const reason = error instanceof RuntimeApiError || error instanceof HistoryReadError ? error.message : "分支文件准备或元数据登记失败";
      deps.store.withTx(() => deps.store.db.prepare("UPDATE branch_requests SET status = 'failed', error = ? WHERE request_id = ?").run(reason, row.request_id));
    }
  }
}
