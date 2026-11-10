/** Frozen source text and revocable access checks for delegated work. */
import { createHash } from "node:crypto";
import type { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import type { AccessScope } from "@ruukoto/core/access.ts";
import type { Store } from "@ruukoto/core/store.ts";
import type { Task } from "@ruukoto/core/types.ts";
import { requireSubAgentExecution } from "@ruukoto/core/subagent-execution.ts";
import { getWorkflowExecution, getWorkflowStep, getWorkflowRun } from "@ruukoto/core/workflow.ts";

export interface SourceRef {
  kind: "text" | "task_result" | "artifact";
  /** Canonical task or artifact reference, including the artifact byte range. */
  ref: string;
  /** Task completion time or artifact byte count; empty for literal text. */
  version: string;
  sha256: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const SOURCE_LIMITS = {
  textBytes: 8 * 1024,
  sources: 8,
};


export interface SourceResolverDeps {
  store: Store;
  access: AccessScope;
  artifacts: ArtifactStore;
}

/** Access grants remain bounded by the originating task's frozen authority. */
function mainCanRead(deps: SourceResolverDeps, mainProjectId: string, projectId: string, category: "history" | "artifact", taskId?: string, grantIds?: readonly string[]): boolean {
  const execution = taskId ? getWorkflowExecution(deps.store, taskId) : null;
  const run = execution ? getWorkflowRun(deps.store, execution.runId) : null;
  const task = taskId ? deps.store.getTask(taskId) : null;
  const source = task?.subAgentId ? requireSubAgentExecution(task.readScope?.execution).source : run?.source;
  if (source && source.projectId !== mainProjectId) return false;
  const pinned = source?.authority?.grantIds;
  return deps.access.canAccess({ kind: "agent", projectId: mainProjectId,
    grantIds: grantIds && pinned ? grantIds.filter(id => pinned.includes(id)) : grantIds ?? pinned }, projectId, category);
}

function taskReadable(deps: SourceResolverDeps, mainProjectId: string, task: Task, taskId?: string, grantIds?: readonly string[]): boolean {
  const project = deps.store.getSession(task.sessionId)?.projectId;
  if (!project) return false;
  if (mainCanRead(deps, mainProjectId, project, "history", taskId, grantIds)) return true;
  const parent = task.parentTaskId ? deps.store.getTask(task.parentTaskId) : null;
  return parent !== null && deps.store.getSession(parent.sessionId)?.projectId === mainProjectId;
}

export function createSourceResolver(deps: SourceResolverDeps) {
  const workflowReadable = (taskId: string | undefined, sourceTaskId: string): boolean => {
    const source = getWorkflowExecution(deps.store, sourceTaskId);
    if (!source || !taskId) return true;
    const current = getWorkflowExecution(deps.store, taskId);
    const step = current ? getWorkflowStep(deps.store, current.runId, current.stepKey) : null;
    return Boolean(current && step && source.runId === current.runId && [step.key, ...step.dependsOn].includes(source.stepKey));
  };
  const resolveOne = (mainProjectId: string, raw: Record<string, unknown>, taskId?: string, grantIds?: readonly string[]): { text: string; ref: SourceRef } => {
    const kind = raw.kind;
    if (kind === "text") {
      if (typeof raw.text !== "string") throw new Error("text 来源必须提供 text");
      return { text: raw.text, ref: { kind: "text", ref: "text", version: "", sha256: sha256(raw.text) } };
    }
    if (kind === "task_result") {
      const task = typeof raw.task_id === "string" ? deps.store.getTask(raw.task_id) : null;
      if (!task || !taskReadable(deps, mainProjectId, task, taskId, grantIds) || !workflowReadable(taskId, task.id)) throw new Error("任务不存在或不在当前步骤可读范围");
      if (task.status !== "completed" || task.resultSummary === null) throw new Error("只能引用已完成且已记录结果的任务（不从会话最新回复推断）");
      return { text: task.resultSummary, ref: { kind, ref: `task:${task.id}`, version: task.endedAt ?? "", sha256: sha256(task.resultSummary) } };
    }
    if (kind === "artifact") {
      const artifact = typeof raw.artifact_id === "string" ? deps.store.getArtifact(raw.artifact_id) : null;
      const project = artifact ? deps.store.getSession(artifact.sessionId)?.projectId : null;
      if (!artifact || !project || !mainCanRead(deps, mainProjectId, project, "artifact", taskId, grantIds) || artifact.name.startsWith("prompt-snapshot:") || !workflowReadable(taskId, artifact.taskId)) throw new Error("产物不存在或不在当前步骤可读范围");
      if (artifact.status !== "complete") throw new Error("产物尚未定稿，不能引用");
      const offset = Number(raw.offset ?? 0);
      const length = Number(raw.length ?? SOURCE_LIMITS.textBytes);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > SOURCE_LIMITS.textBytes) {
        throw new Error(`产物片段 offset/length 非法（length ≤ ${SOURCE_LIMITS.textBytes}）`);
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
    throw new Error("来源 kind 只能是 text / task_result / artifact");
  };

  return {
    /** Capture granted source text; persisted executions also narrow access to their frozen grants. */
    resolve(mainProjectId: string, content: unknown, taskId?: string, grantIds?: readonly string[]): { text: string; refs: SourceRef[] } {
      if (!Array.isArray(content) || content.length === 0 || content.length > SOURCE_LIMITS.sources) {
        throw new Error(`content 必须是 1–${SOURCE_LIMITS.sources} 个来源`);
      }
      const parts = content.map((c) => resolveOne(mainProjectId, (c ?? {}) as Record<string, unknown>, taskId, grantIds));
      return { text: parts.map((p) => p.text).join("\n"), refs: parts.map((p) => p.ref) };
    },
    /** Recheck revocable grants and source integrity without replacing the frozen text. */
    verify(mainProjectId: string, refs: SourceRef[], taskId?: string, grantIds?: readonly string[]): string | null {
      if (!Array.isArray(refs)) return "来源引用记录损坏，请保留记录并报告拥有者";
      for (const r of refs) {
        if (!r || typeof r !== "object" || !["text", "task_result", "artifact"].includes(r.kind) ||
            typeof r.ref !== "string" || typeof r.version !== "string" || typeof r.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256)) return "来源引用记录损坏，请保留记录并报告拥有者";
        if (r.kind === "task_result") {
          const task = deps.store.getTask(r.ref.slice("task:".length));
          if (!task || !taskReadable(deps, mainProjectId, task, taskId, grantIds) || !workflowReadable(taskId, task.id) || task.status !== "completed" || task.resultSummary === null || (task.endedAt ?? "") !== r.version || sha256(task.resultSummary) !== r.sha256) return `来源 ${r.ref} 的资料授权已撤销或任务结果已变化`;
        } else if (r.kind === "artifact") {
          const id = r.ref.slice("artifact:".length).split("@")[0]!;
          const artifact = deps.store.getArtifact(id);
          const project = artifact ? deps.store.getSession(artifact.sessionId)?.projectId : null;
          if (!artifact || !project || !mainCanRead(deps, mainProjectId, project, "artifact", taskId, grantIds) || artifact.name.startsWith("prompt-snapshot:") || !workflowReadable(taskId, artifact.taskId) || artifact.status !== "complete" || String(artifact.byteCount) !== r.version) return `来源 ${r.ref} 的资料授权已撤销或产物不可读`;
          const range = /@(\d+)\+(\d+)$/.exec(r.ref);
          if (!range) return "产物来源片段缺失";
          try {
            if (sha256(deps.artifacts.read(id, Number(range[1]), Number(range[2])).toString("utf8")) !== r.sha256) return "产物来源字节已变化";
          } catch { return "产物来源不可读"; }
        }
      }
      return null;
    },
  };
}

export type SourceResolver = ReturnType<typeof createSourceResolver>;
