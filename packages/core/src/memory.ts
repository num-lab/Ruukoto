/**
 * 长期记忆存储（issue 05 §5）。
 *
 * - 当前版本 + 追加式修订记录（不删除旧版本，不回退审计）；
 * - 类别限于个人偏好、项目约定、已确认决策、经验；每条关联来源；
 * - 修改使用预期版本号条件更新：并发冲突明确返回，不静默覆盖；
 * - 撤销 = 当前状态标停用；恢复旧版本 = 创建一条新修订；
 * - 默认留在当前项目；个人共享由拥有者明确设置，不自动包括 QQ；
 * - 记忆不能改变执行身份、权限模式或审批规则（注入时作为参考内容）。
 */

import type { Db } from "./db.ts";
import {
  MEMORY_CATEGORIES,
  randomId,
  type Memory,
  type MemoryCategory,
  type MemorySourceRef,
  type MemoryVersion,
} from "./types.ts";

export class MemoryConflictError extends Error {
  readonly code = "memory_conflict";
  constructor(message: string) {
    super(message);
  }
}

export class MemoryNotFoundError extends Error {
  readonly code = "memory_not_found";
  constructor(message: string) {
    super(message);
  }
}

export class MemoryValidationError extends Error {
  readonly code = "invalid_params";
  constructor(message: string) {
    super(message);
  }
}

/** 单条记忆正文的字节上限（防御超大注入）。 */
export const MEMORY_CONTENT_MAX_BYTES = 32 * 1024;
export const MEMORY_SOURCE_REFS_MAX = 8;

export interface MemoryWithContent extends Memory {
  content: string;
  sourceRefs: MemorySourceRef[];
}

export class MemoryStore {
  constructor(private readonly db: Db) {}

  // ---------- 读取 ----------

  getMemory(id: string): Memory | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
    return row ? rowToMemory(row) : null;
  }

  getVersion(memoryId: string, version: number): MemoryVersion | null {
    const row = this.db
      .prepare("SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?")
      .get(memoryId, version) as any;
    return row ? rowToVersion(row) : null;
  }

  /** 当前版本内容（含来源）。 */
  getCurrent(memoryId: string): MemoryWithContent | null {
    const memory = this.getMemory(memoryId);
    if (!memory) return null;
    const version = this.getVersion(memoryId, memory.currentVersion);
    if (!version) return null;
    return { ...memory, content: version.content, sourceRefs: version.sourceRefs };
  }

  listVersions(memoryId: string): MemoryVersion[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version")
      .all(memoryId) as any[];
    return rows.map(rowToVersion);
  }

  /**
   * 列出对 accessor 可见的生效记忆：当前项目 + 个人共享。
   * 排序稳定：项目优先，再按更新时间倒序与 id（选择器按序截取）。
   */
  listActiveFor(projectId: string): MemoryWithContent[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, v.content, v.source_refs FROM memories m
         JOIN memory_versions v ON v.memory_id = m.id AND v.version = m.current_version
         WHERE m.status = 'active' AND (m.project_id = ? OR m.scope = 'personal')
         ORDER BY (m.project_id = ?) DESC, m.updated_at DESC, m.id`,
      )
      .all(projectId, projectId) as any[];
    return rows.map((r) => ({ ...rowToMemory(r), content: r.content, sourceRefs: JSON.parse(r.source_refs) }));
  }

  /** 项目内全部记忆（含已撤销；管理界面用）。 */
  listByProject(projectId: string): Memory[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE project_id = ? ORDER BY updated_at DESC, id")
      .all(projectId) as any[];
    return rows.map(rowToMemory);
  }

  listPersonal(): Memory[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE scope = 'personal' ORDER BY updated_at DESC, id")
      .all() as any[];
    return rows.map(rowToMemory);
  }

  // ---------- 写入（条件更新；调用方负责来源校验与范围判定） ----------

  /**
   * 创建记忆（版本 1）。projectId=null 表示个人共享（仅拥有者可创建）。
   * 同事务写入当前版本与首条修订。
   */
  create(input: {
    projectId: string | null;
    category: MemoryCategory;
    content: string;
    sourceRefs: MemorySourceRef[];
    author: "agent" | "owner";
    toolOpId?: string | null;
    taskId?: string | null;
    reason?: string;
  }): MemoryWithContent {
    validateContent(input.content);
    validateCategory(input.category);
    validateSourceRefs(input.sourceRefs);
    const now = new Date().toISOString();
    const memory: Memory = {
      id: randomId("mem"),
      projectId: input.projectId,
      scope: input.projectId === null ? "personal" : "project",
      category: input.category,
      currentVersion: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO memories (id, project_id, scope, category, current_version, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'active', ?, ?)`,
      )
      .run(memory.id, memory.projectId, memory.scope, memory.category, now, now);
    this.insertVersion({
      memoryId: memory.id,
      version: 1,
      content: input.content,
      sourceRefs: input.sourceRefs,
      author: input.author,
      toolOpId: input.toolOpId ?? null,
      taskId: input.taskId ?? null,
      reason: input.reason ?? "",
      createdAt: now,
    });
    return { ...memory, content: input.content, sourceRefs: input.sourceRefs };
  }

  /**
   * 修订记忆（条件更新：expectedVersion 必须等于当前版本）。
   * 并发修改返回 MemoryConflictError，两边输入都保留（调用方可重新读取后决定）。
   */
  revise(input: {
    memoryId: string;
    expectedVersion: number;
    content: string;
    sourceRefs: MemorySourceRef[];
    author: "agent" | "owner";
    toolOpId?: string | null;
    taskId?: string | null;
    reason?: string;
  }): MemoryWithContent {
    validateContent(input.content);
    validateSourceRefs(input.sourceRefs);
    const memory = this.getMemory(input.memoryId);
    if (!memory) throw new MemoryNotFoundError(`记忆不存在：${input.memoryId}`);
    if (memory.status !== "active") {
      throw new MemoryConflictError(`记忆已停用（${input.memoryId}），不能修订；可先恢复旧版本`);
    }
    const now = new Date().toISOString();
    const newVersion = memory.currentVersion + 1;
    const info = this.db
      .prepare("UPDATE memories SET current_version = ?, updated_at = ? WHERE id = ? AND current_version = ? AND status = 'active'")
      .run(newVersion, now, input.memoryId, input.expectedVersion);
    if (Number(info.changes) !== 1) {
      throw new MemoryConflictError(
        `记忆版本冲突：期望 v${input.expectedVersion}，当前 v${memory.currentVersion}（请重新读取后修改）`,
      );
    }
    this.insertVersion({
      memoryId: input.memoryId,
      version: newVersion,
      content: input.content,
      sourceRefs: input.sourceRefs,
      author: input.author,
      toolOpId: input.toolOpId ?? null,
      taskId: input.taskId ?? null,
      reason: input.reason ?? "",
      createdAt: now,
    });
    return { ...memory, currentVersion: newVersion, updatedAt: now, content: input.content, sourceRefs: input.sourceRefs };
  }

  /** 撤销（当前状态标停用；旧版本保留可查）。 */
  revoke(input: {
    memoryId: string;
    expectedVersion: number;
    author: "agent" | "owner";
    toolOpId?: string | null;
    taskId?: string | null;
    reason?: string;
  }): Memory {
    const memory = this.getMemory(input.memoryId);
    if (!memory) throw new MemoryNotFoundError(`记忆不存在：${input.memoryId}`);
    const now = new Date().toISOString();
    const info = this.db
      .prepare("UPDATE memories SET status = 'revoked', updated_at = ? WHERE id = ? AND current_version = ? AND status = 'active'")
      .run(now, input.memoryId, input.expectedVersion);
    if (Number(info.changes) !== 1) {
      throw new MemoryConflictError(
        memory.status === "revoked"
          ? `记忆已停用：${input.memoryId}`
          : `记忆版本冲突：期望 v${input.expectedVersion}，当前 v${memory.currentVersion}`,
      );
    }
    return { ...memory, status: "revoked", updatedAt: now };
  }

  /**
   * 恢复旧版本：以旧版本内容创建一条新修订（不删除旧版本、不回退审计）。
   * 已停用的记忆恢复后重新生效。
   */
  restore(input: {
    memoryId: string;
    fromVersion: number;
    author: "agent" | "owner";
    toolOpId?: string | null;
    taskId?: string | null;
    reason?: string;
  }): MemoryWithContent {
    const memory = this.getMemory(input.memoryId);
    if (!memory) throw new MemoryNotFoundError(`记忆不存在：${input.memoryId}`);
    const old = this.getVersion(input.memoryId, input.fromVersion);
    if (!old) throw new MemoryNotFoundError(`记忆 ${input.memoryId} 没有版本 v${input.fromVersion}`);
    const now = new Date().toISOString();
    const newVersion = memory.currentVersion + 1;
    // 恢复不受 status 限制（停用记忆的恢复即重新生效），但仍需版本条件更新
    const info = this.db
      .prepare("UPDATE memories SET current_version = ?, status = 'active', updated_at = ? WHERE id = ? AND current_version = ?")
      .run(newVersion, now, input.memoryId, memory.currentVersion);
    if (Number(info.changes) !== 1) {
      throw new MemoryConflictError(`记忆版本冲突（恢复时）：${input.memoryId}`);
    }
    this.insertVersion({
      memoryId: input.memoryId,
      version: newVersion,
      content: old.content,
      sourceRefs: old.sourceRefs,
      author: input.author,
      toolOpId: input.toolOpId ?? null,
      taskId: input.taskId ?? null,
      reason: input.reason ?? `恢复自 v${input.fromVersion}`,
      createdAt: now,
    });
    return {
      ...memory,
      currentVersion: newVersion,
      status: "active",
      updatedAt: now,
      content: old.content,
      sourceRefs: old.sourceRefs,
    };
  }

  private insertVersion(v: MemoryVersion): void {
    this.db
      .prepare(
        `INSERT INTO memory_versions (memory_id, version, content, source_refs, author, tool_op_id, task_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.memoryId, v.version, v.content, JSON.stringify(v.sourceRefs), v.author, v.toolOpId, v.taskId, v.reason, v.createdAt);
  }
}

function validateContent(content: string): void {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new MemoryValidationError("记忆正文不能为空");
  }
  if (Buffer.byteLength(content, "utf8") > MEMORY_CONTENT_MAX_BYTES) {
    throw new MemoryValidationError(`记忆正文超过 ${MEMORY_CONTENT_MAX_BYTES} 字节上限`);
  }
}

function validateCategory(category: MemoryCategory): void {
  if (!MEMORY_CATEGORIES.includes(category)) {
    throw new MemoryValidationError(`记忆类别无效：${category}（preference | convention | decision | experience）`);
  }
}

function validateSourceRefs(refs: MemorySourceRef[]): void {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new MemoryValidationError("记忆必须关联至少一个来源");
  }
  if (refs.length > MEMORY_SOURCE_REFS_MAX) {
    throw new MemoryValidationError(`来源引用超过 ${MEMORY_SOURCE_REFS_MAX} 条上限`);
  }
  for (const ref of refs) {
    if (ref.kind === "history_entry") {
      if (!ref.sessionId || !ref.entryId) throw new MemoryValidationError("history_entry 来源必须含 sessionId 与 entryId");
    } else if (ref.kind === "artifact") {
      if (!ref.artifactId) throw new MemoryValidationError("artifact 来源必须含 artifactId");
    } else if (ref.kind === "owner_note") {
      if (!ref.note) throw new MemoryValidationError("owner_note 来源必须含说明");
    } else {
      throw new MemoryValidationError(`未知来源类型：${(ref as any).kind}`);
    }
  }
}

function rowToMemory(row: any): Memory {
  return {
    id: row.id,
    projectId: row.project_id,
    scope: row.scope as "project" | "personal",
    category: row.category as MemoryCategory,
    currentVersion: Number(row.current_version),
    status: row.status as "active" | "revoked",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row: any): MemoryVersion {
  return {
    memoryId: row.memory_id,
    version: Number(row.version),
    content: row.content,
    sourceRefs: JSON.parse(row.source_refs) as MemorySourceRef[],
    author: row.author as "agent" | "owner",
    toolOpId: row.tool_op_id,
    taskId: row.task_id,
    reason: row.reason,
    createdAt: row.created_at,
  };
}
