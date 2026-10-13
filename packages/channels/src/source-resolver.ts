/** 通知与 SubAgent 资料的来源快照及发送前授权复核。 */
import type { AppDataStore } from "@ruukoto/agent/app-data/store.ts";
import type { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import type { AccessScope } from "@ruukoto/core/access.ts";
import type { Store } from "@ruukoto/core/store.ts";
import type { Task } from "@ruukoto/core/types.ts";
import { resolveAcceptedChatResult } from "./chat-results.ts";
import { QqStore } from "./qq/store.ts";
import { sha256,type SourceRef } from "./scheduler/store.ts";

export const NOTIFY_LIMITS = {
  textChars: 2000,
  textBytes: 8 * 1024,
  noteBytes: 4 * 1024,
  sources: 8,
  paramsBytes: 32 * 1024,
  reasonBytes: 1024,
  createKeyChars: 128,
};

// ---------- 来源快照 ----------

export interface SourceResolverDeps {
  store: Store;
  access: AccessScope;
  artifacts: ArtifactStore;
  appData(): AppDataStore | null;
}

/** main 读取资料的范围：本项目、main 委派的子任务，或有效资料授权覆盖的项目。 */
function mainCanRead(deps: SourceResolverDeps, mainProjectId: string, projectId: string, category: "history" | "artifact"): boolean {
  return deps.access.canAccess({ kind: "agent", projectId: mainProjectId }, projectId, category);
}

function taskReadable(deps: SourceResolverDeps, mainProjectId: string, task: Task): boolean {
  const project = deps.store.getSession(task.sessionId)?.projectId;
  // 父子关系只开放结果传递，不能把原始群资料变成 main 可读资料。
  if (!project || deps.access.isQqGroupProject(project)) return false;
  if (mainCanRead(deps, mainProjectId, project, "history")) return true;
  const parent = task.parentTaskId ? deps.store.getTask(task.parentTaskId) : null;
  return parent !== null && deps.store.getSession(parent.sessionId)?.projectId === mainProjectId;
}

export function createSourceResolver(deps: SourceResolverDeps) {
  const qq = new QqStore(deps.store.db);
  const resolveOne = (mainProjectId: string, raw: Record<string, unknown>): { text: string; ref: SourceRef } => {
    const kind = raw.kind;
    if (kind === "text") {
      if (typeof raw.text !== "string") throw new Error("text 来源必须提供 text");
      return { text: raw.text, ref: { kind: "text", ref: "text", version: "", sha256: sha256(raw.text) } };
    }
    if (kind === "task_result") {
      const task = typeof raw.task_id === "string" ? deps.store.getTask(raw.task_id) : null;
      if (!task || !taskReadable(deps, mainProjectId, task)) throw new Error("任务不存在或不在 main 可读范围");
      if (task.status !== "completed" || task.resultSummary === null) throw new Error("只能引用已完成且已记录结果的任务（不从会话最新回复推断）");
      return { text: task.resultSummary, ref: { kind, ref: `task:${task.id}`, version: task.endedAt ?? "", sha256: sha256(task.resultSummary) } };
    }
    if (kind === "chat_result") {
      if (typeof raw.task_id !== "string") throw new Error("群结果来源必须提供 task_id");
      const accepted = resolveAcceptedChatResult(deps.store, qq, mainProjectId, raw.task_id);
      return { text: accepted.summary, ref: { kind, ref: `chat_result:${accepted.taskId}`, version: accepted.acceptedAt, sha256: sha256(accepted.summary) } };
    }
    if (kind === "artifact") {
      const artifact = typeof raw.artifact_id === "string" ? deps.store.getArtifact(raw.artifact_id) : null;
      const project = artifact ? deps.store.getSession(artifact.sessionId)?.projectId : null;
      if (!artifact || !project || !mainCanRead(deps, mainProjectId, project, "artifact")) throw new Error("产物不存在或不在 main 可读范围");
      if (artifact.status !== "complete") throw new Error("产物尚未定稿，不能引用");
      const offset = Number(raw.offset ?? 0);
      const length = Number(raw.length ?? NOTIFY_LIMITS.textBytes);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > NOTIFY_LIMITS.textBytes) {
        throw new Error(`产物片段 offset/length 非法（length ≤ ${NOTIFY_LIMITS.textBytes}）`);
      }
      const buf = deps.artifacts.read(artifact.id, offset, length);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        throw new Error("产物片段不是合法 UTF-8 文本（或截断在多字节字符中间），拒绝引用");
      }
      if (text.includes("\u0000")) throw new Error("产物片段含二进制内容，拒绝引用");
      return { text, ref: { kind, ref: `artifact:${artifact.id}@${offset}+${buf.length}`, version: String(artifact.byteCount), sha256: sha256(text) } };
    }
    if (kind === "app_data") {
      const store = deps.appData();
      if (!store) throw new Error("应用数据能力不可用，不能生成快照");
      const table = typeof raw.table === "string" ? store.getTable(raw.table) : null;
      const rowId = Number(raw.row_id);
      const field = String(raw.field ?? "");
      if (!table || !Number.isSafeInteger(rowId) || !table.fields.some((f) => f.name === field)) throw new Error("应用数据表/行/字段不存在");
      const row = store.getRow(table, rowId);
      if (!row) throw new Error(`行 ${rowId} 不存在`);
      const value = row[field];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error("字段值为空或不是标量，不能作为正文");
      const text = String(value);
      const versions = store.getVersions();
      return {
        text,
        ref: {
          kind,
          ref: `app_data:${store.getInstanceId()}/${table.name}#${rowId}.${field}`,
          version: `row v${row._version} schema v${versions.schemaVersion}`,
          sha256: sha256(text),
        },
      };
    }
    throw new Error("来源 kind 只能是 text / task_result / artifact / app_data / chat_result");
  };

  return {
    /** 解析为最终正文（多个来源按顺序换行拼接）。 */
    resolve(mainProjectId: string, content: unknown): { text: string; refs: SourceRef[] } {
      if (!Array.isArray(content) || content.length === 0 || content.length > NOTIFY_LIMITS.sources) {
        throw new Error(`content 必须是 1–${NOTIFY_LIMITS.sources} 个来源`);
      }
      const parts = content.map((c) => resolveOne(mainProjectId, (c ?? {}) as Record<string, unknown>));
      return { text: parts.map((p) => p.text).join("\n"), refs: parts.map((p) => p.ref) };
    },
    /** 发送前复核可撤销的资料授权（快照正文不变；授权撤销后不得继续外发）。 */
    verify(mainProjectId: string, refs: SourceRef[]): string | null {
      for (const r of refs) {
        if (r.kind === "chat_result") {
          try {
            const accepted = resolveAcceptedChatResult(deps.store, qq, mainProjectId, r.ref.slice("chat_result:".length));
            if (accepted.acceptedAt !== r.version || sha256(accepted.summary) !== r.sha256) return "群结果接收快照不匹配";
          } catch (err) {
            return (err as Error).message;
          }
        } else if (r.kind === "task_result") {
          const task = deps.store.getTask(r.ref.slice("task:".length));
          if (!task || !taskReadable(deps, mainProjectId, task)) return `来源 ${r.ref} 的资料授权已撤销或任务不可读`;
        } else if (r.kind === "artifact") {
          const id = r.ref.slice("artifact:".length).split("@")[0]!;
          const artifact = deps.store.getArtifact(id);
          const project = artifact ? deps.store.getSession(artifact.sessionId)?.projectId : null;
          if (!project || !mainCanRead(deps, mainProjectId, project, "artifact")) return `来源 ${r.ref} 的资料授权已撤销或产物不可读`;
        }
      }
      return null;
    },
  };
}

export type SourceResolver = ReturnType<typeof createSourceResolver>;
