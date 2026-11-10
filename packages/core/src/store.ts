/**
 * 元数据访问层：在 node:sqlite 之上的类型化读写与条件状态转换。
 *
 * 不变量在事务内成立（withTx）：
 * - 任务状态转换用条件更新（WHERE status IN ...），取消与自然完成竞争时
 *   只有一个终态生效。
 * - 目录占用以 dev+ino 为主碰撞键（覆盖符号链接与挂载别名），路径仅作记录。
 * - 持久事件与引发它的状态变更同事务写入；事务提交成功后才对外广播。
 */

import type { AttachmentReference } from "./attachments.ts";
import type { Db } from "./db.ts";
import { classifySession, type SessionIdentity } from "./session-identity.ts";
import { invalidateOwnerQuestionsForTask, ownerQuestionTaskEligible } from "./owner-questions.ts";
import { SubAgentDefinitionError, requireSubAgentDefinition, subAgentDefinitionFromJson } from "./subagent-definition.ts";
import {
  ACTIVE_TASK_STATUSES,
  isTerminalTaskStatus,
  type AccessMode,
  type ApprovalScope,
  type Artifact,
  type ConfirmationRequest,
  type ConfirmationStatus,
  type ContextCheckpoint,
  type GrantedPath,
  type ImageMimeType,
  type ModelSelection,
  type PersistentEvent,
  type PersistentEventBody,
  type Project,
  type SelectionRecord,
  type Session,
  type SessionDefaultMode,
  type SessionKind,
  type SubAgent,
  type SubAgentMessage,
  type SubAgentReadScope,
  type SubAgentState,
  type Task,
  type TaskGuidance,
  type TaskQueue,
  type TaskStatus,
  type ToolOp,
  type ToolAuthorization,
  type WorkCanceledBy,
  type WorkDelegation,
  randomId,
} from "./types.ts";

import { tailTextByBytes } from "./history.ts";
import { FRAGMENT_TEXT_CAP } from "./views.ts";
import type { DirIdentity } from "./dir-identity.ts";
import { parseWorkWriteTarget, writeTargetToJson } from "./types.ts";
import * as path from "node:path";
import { getManagedWorkspaceRequest, managedWorkspaceKey } from "./managed-workspaces.ts";

/** 实例级 Web Search 开关在 meta 表的键（值形如 {"version":1,"state":"enabled"}）。 */
const WEB_SEARCH_META_KEY = "web_search";

/**
 * 占用冲突判定（agent-direction issue 16，模块级纯函数，占用取/放与
 * subagent_result 提示共用）：dev+ino 相等（同一目录的符号链接/挂载别名都
 * 会命中）、realpath 相等，或按分隔符边界互为前缀（祖先/子孙）。
 */
export function occupancyConflict(
  a: { cwdReal: string; cwdDev: number; cwdIno: number },
  b: { cwdReal: string; cwdDev: number; cwdIno: number },
): boolean {
  for (const [x, y] of [
    [a, b] as const,
    [b, a] as const,
  ]) {
    if (x.cwdDev === y.cwdDev && x.cwdIno === y.cwdIno) return true;
    if (x.cwdReal === y.cwdReal) return true;
  }
  return grantPrefixOf(a.cwdReal, b.cwdReal) || grantPrefixOf(b.cwdReal, a.cwdReal);
}

/** realpath 前缀（按分隔符边界；/a/b 与 /a/bc 互不为前缀）。 */
function grantPrefixOf(parent: string, candidate: string): boolean {
  return candidate.startsWith(parent + path.sep);
}

export type OccupancyHolder = { taskId: string; processId?: never } | { taskId: null; processId: string };
export type Occupancy = OccupancyHolder & { sessionId: string; cwdReal: string; cwdDev: number; cwdIno: number };

export class Store {
  /** 内部数据库句柄（含测试故障注入点 faultNextWrite）。 */
  readonly db: Db;
  private pending: PersistentEvent[] = [];
  /** 事务提交成功后的回调（控制面广播）。运行期由 Runtime 设置。 */
  onCommitted: ((events: PersistentEvent[]) => void) | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  /** 事务包装：提交成功后投递事务内产生的事件；回滚则丢弃。 */
  withTx<T>(fn: () => T): T {
    try {
      const result = this.db.tx(fn);
      const pending = this.pending;
      this.pending = [];
      if (pending.length > 0) this.onCommitted?.(pending);
      return result;
    } catch (err) {
      this.pending = [];
      throw err;
    }
  }

  // ---------- 持久事件 ----------

  appendEvent(
    body: PersistentEventBody,
    refs: { taskId?: string | null; sessionId?: string | null } = {},
  ): number {
    const info = this.db
      .prepare("INSERT INTO events (task_id, session_id, body, created_at) VALUES (?, ?, ?, ?)")
      .run(
        refs.taskId ?? null,
        refs.sessionId ?? null,
        JSON.stringify(body),
        new Date().toISOString(),
      );
    this.pending.push({
      seq: Number(info.lastInsertRowid),
      taskId: refs.taskId ?? null,
      sessionId: refs.sessionId ?? null,
      body,
      createdAt: new Date().toISOString(),
    });
    return Number(info.lastInsertRowid);
  }

  // ---------- 项目 ----------

  /**
   * With a creation key, the same name returns the existing project without another event; a changed name rejects with request_conflict.
   * The caller owns the transaction. Unique-index conflicts reread and verify the original project.
   */
  createProject(name: string, createRequestId?: string | null, rootDir?: DirIdentity | null, managed?: { id: string }): Project {
    const reservation = createRequestId ? getManagedWorkspaceRequest(this, createRequestId) : null;
    if (reservation || managed) {
      if (!reservation || managed?.id !== reservation.projectId || rootDir?.cwdReal !== reservation.root || rootDir.ino !== reservation.stage?.ino) {
        throw new StoreConflictError("请求键已用于自动工作区创建", "request_conflict");
      }
    }
    if (createRequestId) {
      const existing = this.findProjectByCreateRequestId(createRequestId);
      if (existing) {
        if (existing.name !== name) {
          throw new StoreConflictError(`request_id 已存在且项目名不同：project=${existing.id}`, "request_conflict");
        }
        return existing;
      }
    }
    if (this.findProjectByName(name)) {
      throw new StoreConflictError(`项目已存在：${name}`, "duplicate");
    }
    if (rootDir && this.findProjectByRoot(rootDir)) {
      throw new StoreConflictError(`工作区已存在：${rootDir.cwdReal}`, "duplicate");
    }
    const project: Project = { id: managed?.id ?? randomId("proj"), name, createRequestId: createRequestId ?? null, rootDir: rootDir ?? null, ...(managed ? { managed: true } : {}), instructionFiles: [], settingsVersion: 1, createdAt: new Date().toISOString() };
    try {
      this.db
        .prepare("INSERT INTO projects (id, name, create_request_id, root_cwd, root_real, root_dev, root_ino, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          project.id,
          project.name,
          project.createRequestId,
          project.rootDir?.cwd ?? null,
          project.rootDir?.cwdReal ?? null,
          project.rootDir?.dev ?? null,
          project.rootDir?.ino ?? null,
          project.createdAt,
        );
    } catch (err) {
      if (createRequestId && isCreateRequestIdClash(err, "projects")) {
        const existing = this.findProjectByCreateRequestId(createRequestId);
        if (existing) {
          if (existing.name !== name) {
            throw new StoreConflictError(`request_id 已存在且项目名不同：project=${existing.id}`, "request_conflict");
          }
          return existing;
        }
      }
      // The root's partial unique index covers only registered directories.
      if (isRootDirClash(err)) {
        throw new StoreConflictError(`工作区已存在：${rootDir?.cwdReal}`, "duplicate");
      }
      throw err;
    }
    if (managed) this.setMetaValue(managedWorkspaceKey(project.id), "true");
    this.appendEvent({ type: "project.created", projectId: project.id, name: project.name, createRequestId: project.createRequestId, rootDir: project.rootDir, ...(managed ? { managed: true } : {}) });
    return project;
  }

  /** 按根目录身份找已归属的工作区（realpath 或 dev+ino 相同；issue 05）。 */
  findProjectByRoot(identity: DirIdentity): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE root_real = ? OR (root_dev = ? AND root_ino = ?) ORDER BY created_at, rowid LIMIT 1")
      .get(identity.cwdReal, identity.dev, identity.ino) as any;
    return row ? this.rowToProject(row) : null;
  }

  /** 按创建幂等键查询项目（issue 21 去重与重连核实共用）。 */
  findProjectByCreateRequestId(requestId: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE create_request_id = ?").get(requestId) as any;
    return row ? this.rowToProject(row) : null;
  }

  /**
   * 更新项目设置（agent-direction issue 06；拥有者入口，调用方负责校验路径与
   * 版本形状）。settings_version 只保护指令列表：
   * - 携带 expectedVersion 时核对当前版本，不符抛 version_conflict，
   *   不修改配置、不产生事件；
   * - 省略版本 = 旧入口兼容写入：同样更新同一行、递增同一版本并追加同一
   *   project.settings_changed 事件，有版本客户端的后续保存会因版本变化
   *   冲突，旧入口不能绕过冲突检测；
   * - 同值保存幂等：不递增版本、不产生事件（对齐 MCP 启停语义）。
   * 调用方须以 withTx 包住（校验、更新与事件单一事务）。
   */
  updateProjectSettings(input: {
    projectId: string;
    instructionFiles?: string[];
    expectedVersion?: number;
  }): Project {
    const current = this.getProject(input.projectId);
    if (!current) throw new StoreConflictError(`项目不存在：${input.projectId}`, "not_found");
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.settingsVersion) {
      throw new StoreConflictError(
        `项目设置版本冲突：期望 v${input.expectedVersion}，当前 v${current.settingsVersion}（请刷新后重试）`,
        "version_conflict",
      );
    }
    const files = input.instructionFiles ?? current.instructionFiles;
    if (JSON.stringify(files) === JSON.stringify(current.instructionFiles)) {
      return current;
    }
    if (current.settingsVersion >= Number.MAX_SAFE_INTEGER) {
      throw new StoreConflictError("项目设置版本已达上限", "invalid_params");
    }
    const nextVersion = current.settingsVersion + 1;
    this.db
      .prepare("UPDATE projects SET instruction_files = ?, settings_version = ? WHERE id = ?")
      .run(JSON.stringify(files), nextVersion, input.projectId);
    const updated = this.getProject(input.projectId)!;
    this.appendEvent({
      type: "project.settings_changed",
      projectId: input.projectId,
      settingsVersion: nextVersion,
      instructionFiles: updated.instructionFiles,
    });
    return updated;
  }

  /** 实例级 Web Search 开关（全实例共用）：缺省启用，版本从 1 起。 */
  getWebSearch(): { state: "enabled" | "disabled"; version: number } {
    const raw = this.getMetaValue(WEB_SEARCH_META_KEY);
    if (raw === null) return { state: "enabled", version: 1 };
    const parsed = JSON.parse(raw) as { state?: unknown; version?: unknown };
    return { state: parsed.state === "disabled" ? "disabled" : "enabled", version: Number.isSafeInteger(parsed.version) && (parsed.version as number) >= 1 ? (parsed.version as number) : 1 };
  }

  /**
   * 保存实例级 Web Search 开关：期望版本冲突抛 version_conflict；同值保存幂等
   * （不递增版本、不产生事件）。调用方须以 withTx 包住（更新与事件单一事务）。
   */
  setWebSearch(input: { state: "enabled" | "disabled"; expectedVersion?: number }): { state: "enabled" | "disabled"; version: number } {
    const current = this.getWebSearch();
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new StoreConflictError(`Web Search 版本冲突：期望 v${input.expectedVersion}，当前 v${current.version}（请刷新后重试）`, "version_conflict");
    }
    if (input.state === current.state) return current;
    const next: { state: "enabled" | "disabled"; version: number } = { state: input.state, version: current.version + 1 };
    this.setMetaValue(WEB_SEARCH_META_KEY, JSON.stringify(next));
    this.appendEvent({ type: "web_search.changed", version: next.version, state: next.state });
    return next;
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    return row ? this.rowToProject(row) : null;
  }

  findProjectByName(name: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as any;
    return row ? this.rowToProject(row) : null;
  }

  listProjects(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at, rowid").all() as any[];
    return rows.map((r) => this.rowToProject(r));
  }

  private rowToProject(row: any): Project {
    return {
      id: row.id,
      name: row.name,
      createRequestId: row.create_request_id ?? null,
      rootDir: row.root_real
        ? { cwd: row.root_cwd, cwdReal: row.root_real, dev: row.root_dev, ino: row.root_ino }
        : null,
      ...(this.getMetaValue(managedWorkspaceKey(row.id)) === "true" ? { managed: true } : {}),
      instructionFiles: JSON.parse(row.instruction_files ?? "[]") as string[],
      settingsVersion: Number(row.settings_version ?? 1),
      createdAt: row.created_at,
    };
  }

  // ---------- 会话 ----------

  /**
   * A creation key reuses the session only when project, canonical directory and confirmation tools match; changed parameters reject with request_conflict.
   * Unique-index conflicts reread and verify the original session.
   */
  createSession(input: {
    projectId: string;
    name?: string | null;
    kind?: SessionKind;
    cwd: string;
    cwdReal: string;
    cwdDev: number;
    cwdIno: number;
    piSessionId: string;
    sessionFile?: string | null;
    confirmTools: string[];
    modelSelection?: ModelSelection | null;
    defaultAccessMode?: SessionDefaultMode;
    /** Without a creation key, each call inserts a new session. */
    createRequestId?: string | null;
    /** Branch publication accepts only complete metadata fixed by the host. */
    branchSession?: Session;
    /** Publication of the workspace fixed by a managed creation reservation. */
    managedWorkspace?: boolean;
  }): Session {
    const reservation = input.createRequestId ? getManagedWorkspaceRequest(this, input.createRequestId) : null;
    if (reservation || input.managedWorkspace) {
      if (!reservation || !input.managedWorkspace || input.branchSession || input.projectId !== reservation.projectId || input.cwdReal !== reservation.root || input.cwdIno !== reservation.stage?.ino) {
        throw new StoreConflictError("请求键已用于自动工作区创建", "request_conflict");
      }
    }
    if (input.createRequestId && !input.branchSession && (
      this.db.prepare("SELECT 1 FROM branch_requests WHERE request_id = ?").get(input.createRequestId) ||
      this.db.prepare("SELECT 1 FROM side_chats WHERE request_id = ?").get(input.createRequestId)
    )) {
      throw new StoreConflictError("请求键已用于会话分支或侧聊绑定", "request_conflict");
    }
    if (input.createRequestId) {
      const existing = this.findSessionByCreateRequestId(input.createRequestId);
      if (existing) {
        if (
          (input.branchSession && existing.id !== input.branchSession.id) ||
          existing.projectId !== input.projectId ||
          existing.cwdReal !== input.cwdReal ||
          JSON.stringify(existing.confirmTools) !== JSON.stringify(input.confirmTools)
        ) {
          throw new StoreConflictError(`request_id 已存在且会话参数不同：session=${existing.id}`, "request_conflict");
        }
        return existing;
      }
    }
    // Branches retain their source's archive state rather than reappear as new work.
    const archivedAt = input.branchSession ? input.branchSession.archivedAt ?? null : null;
    const session: Session = input.branchSession ?? {
      id: randomId("sess"),
      name: input.name ?? null,
      branchSource: null,
      projectId: input.projectId,
      kind: input.kind ?? "dev",
      cwd: input.cwd,
      cwdReal: input.cwdReal,
      cwdDev: input.cwdDev,
      cwdIno: input.cwdIno,
      piSessionId: input.piSessionId,
      sessionFile: input.sessionFile ?? null,
      confirmTools: input.confirmTools,
      createRequestId: input.createRequestId ?? null,
      modelSelection: input.modelSelection ?? null,
      modelSelectionVersion: input.modelSelection ? 1 : 0,
      defaultAccessMode: input.defaultAccessMode ?? "confirm",
      defaultAccessModeVersion: 0,
      queueState: "active",
      queuePauseReason: null,
      queueRevision: 0,
      archivedAt,
      createdAt: new Date().toISOString(),
    };
    try {
      this.db
        .prepare(
          `INSERT INTO sessions (id, project_id, kind, cwd, cwd_real, cwd_dev, cwd_ino, pi_session_id,
           session_file, confirm_tools, create_request_id, queue_state, queue_pause_reason, created_at, model_selection, model_selection_version,
           default_access_mode, default_access_mode_version, name, branch_source, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.projectId,
          session.kind,
          session.cwd,
          session.cwdReal,
          session.cwdDev,
          session.cwdIno,
          session.piSessionId,
          session.sessionFile,
          JSON.stringify(session.confirmTools),
          session.createRequestId,
          session.createdAt,
          session.modelSelection ? JSON.stringify(session.modelSelection) : null,
          session.modelSelectionVersion,
          session.defaultAccessMode,
          session.defaultAccessModeVersion,
          session.name,
          session.branchSource ? JSON.stringify(session.branchSource) : null,
          session.archivedAt,
        );
    } catch (err) {
      if (input.createRequestId && isCreateRequestIdClash(err, "sessions")) {
        const existing = this.findSessionByCreateRequestId(input.createRequestId);
        if (existing) {
          if (
            existing.projectId !== input.projectId ||
            existing.cwdReal !== input.cwdReal ||
            JSON.stringify(existing.confirmTools) !== JSON.stringify(input.confirmTools)
          ) {
            throw new StoreConflictError(`request_id 已存在且会话参数不同：session=${existing.id}`, "request_conflict");
          }
          return existing;
        }
      }
      throw err;
    }
    this.appendEvent(
      { type: "session.created", sessionId: session.id, projectId: session.projectId, kind: session.kind, cwd: session.cwd, modelSelection: session.modelSelection, modelSelectionVersion: session.modelSelectionVersion, createRequestId: session.createRequestId, session },
      { sessionId: session.id },
    );
    return session;
  }

  /** 按创建幂等键查询会话（issue 21 去重与重连核实共用）。 */
  findSessionByCreateRequestId(requestId: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE create_request_id = ?").get(requestId) as any;
    return row ? this.rowToSession(row) : null;
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    return row ? this.rowToSession(row) : null;
  }

  listSessions(): Session[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at, rowid").all() as any[];
    return rows.map((r) => this.rowToSession(r));
  }

  /** 会话选择列表只查元数据，不扫描消息历史；设置变化不算任务活跃。 */
  listSessionSummaries(projectId: string): Array<{ sessionId: string; name: string | null; lastActiveAt: string }> {
    return this.sessionSummaries("s.project_id = ?", projectId);
  }

  listAllSessionSummaries(): Array<{ sessionId: string; name: string | null; lastActiveAt: string }> {
    return this.sessionSummaries("1 = 1");
  }

  // ponytail: affiliation 是 SQL 片段插值而非参数——仅在本类内传入固定常量，
  // 同一 SQL 正文供 prepare 复用；若开放为公共接口须改回参数化条件。
  private sessionSummaries(affiliation: string, id?: string): Array<{ sessionId: string; name: string | null; lastActiveAt: string }> {
    return this.db.prepare(`
      WITH event_activity AS (
        SELECT t.session_id, MAX(e.created_at) AS last_at
        FROM events e JOIN tasks t ON t.id = e.task_id
        JOIN sessions s ON s.id = t.session_id
        WHERE ${affiliation} GROUP BY t.session_id
      )
      SELECT s.id AS sessionId,
        COALESCE(s.name, (SELECT substr(t.input, 1, 512) FROM tasks t
         WHERE t.session_id = s.id AND t.parent_task_id IS NULL
         ORDER BY t.created_at, t.rowid LIMIT 1)) AS name,
        MAX(s.created_at, COALESCE(e.last_at, s.created_at),
          COALESCE((SELECT MAX(MAX(t.created_at, COALESCE(t.started_at, t.created_at),
            COALESCE(t.ended_at, t.created_at))) FROM tasks t WHERE t.session_id = s.id), s.created_at)) AS lastActiveAt
      FROM sessions s LEFT JOIN event_activity e ON e.session_id = s.id
      WHERE ${affiliation} ORDER BY s.created_at, s.rowid
    `).all(...(id === undefined ? [] : [id, id])) as Array<{ sessionId: string; name: string | null; lastActiveAt: string }>;
  }

  setSessionFile(id: string, file: string): void {
    this.db.prepare("UPDATE sessions SET session_file = ? WHERE id = ?").run(file, id);
  }

  setSessionQueueState(id: string, state: "active" | "paused", reason: string | null): void {
    this.db
      .prepare("UPDATE sessions SET queue_state = ?, queue_pause_reason = ? WHERE id = ?")
      .run(state, reason, id);
  }

  /** 调用方在事务中执行版本检查、整组更新及事件写入。 */
  setSessionModel(sessionId: string, selection: ModelSelection, expectedVersion: number): Session {
    const session = this.getSession(sessionId);
    if (!session) throw new StoreConflictError(`会话不存在：${sessionId}`, "not_found");
    if (session.modelSelectionVersion !== expectedVersion) {
      throw new StoreConflictError("会话模型选择已被其他客户端修改，请刷新后重试", "model_selection_conflict");
    }
    if (session.modelSelection?.provider === selection.provider && session.modelSelection.modelId === selection.modelId && session.modelSelection.thinkingLevel === selection.thinkingLevel) return session;
    const modelSelectionVersion = expectedVersion + 1;
    this.db.prepare("UPDATE sessions SET model_selection = ?, model_selection_version = ? WHERE id = ?")
      .run(JSON.stringify(selection), modelSelectionVersion, sessionId);
    this.appendEvent({ type: "session.model_selection_changed", sessionId, modelSelection: selection, modelSelectionVersion }, { sessionId });
    return this.getSession(sessionId)!;
  }

  /** 调用方在事务内执行版本检查、更新及事件写入；同值不递增版本、不发事件。 */
  setSessionDefaultMode(sessionId: string, mode: SessionDefaultMode, expectedVersion: number): Session {
    const session = this.getSession(sessionId);
    if (!session) throw new StoreConflictError(`会话不存在：${sessionId}`, "not_found");
    if (session.defaultAccessModeVersion !== expectedVersion) {
      throw new StoreConflictError("会话默认模式已被其他客户端修改，请刷新后重试", "default_mode_conflict");
    }
    if (session.defaultAccessMode === mode) return session;
    const defaultAccessModeVersion = expectedVersion + 1;
    this.db.prepare("UPDATE sessions SET default_access_mode = ?, default_access_mode_version = ? WHERE id = ?")
      .run(mode, defaultAccessModeVersion, sessionId);
    this.appendEvent({ type: "session.default_mode_changed", sessionId, defaultAccessMode: mode, defaultAccessModeVersion }, { sessionId });
    return this.getSession(sessionId)!;
  }

  /**
   * 拥有者存档或取消存档：只改列表可见性，不动资料身份、历史、任务归属或排队
   * 状态。同值幂等（不产生事件）。调用方须以 withTx 包住。
   */
  setSessionArchived(sessionId: string, archived: boolean): Session {
    const session = this.getSession(sessionId);
    if (!session) throw new StoreConflictError(`会话不存在：${sessionId}`, "not_found");
    const archivedAt = archived ? session.archivedAt ?? new Date().toISOString() : null;
    if (session.archivedAt === archivedAt) return session;
    this.db.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?").run(archivedAt, sessionId);
    this.appendEvent({ type: "session.archive_changed", sessionId, archivedAt }, { sessionId });
    return this.getSession(sessionId)!;
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      name: row.name ?? null,
      branchSource: row.branch_source ? JSON.parse(row.branch_source) as Session["branchSource"] : null,
      projectId: row.project_id,
      kind: row.kind as SessionKind,
      cwd: row.cwd,
      cwdReal: row.cwd_real,
      cwdDev: Number(row.cwd_dev),
      cwdIno: Number(row.cwd_ino),
      piSessionId: row.pi_session_id,
      sessionFile: row.session_file,
      confirmTools: JSON.parse(row.confirm_tools) as string[],
      createRequestId: row.create_request_id ?? null,
      modelSelection: row.model_selection ? JSON.parse(row.model_selection) as ModelSelection : null,
      modelSelectionVersion: Number(row.model_selection_version),
      defaultAccessMode: (row.default_access_mode ?? "confirm") as SessionDefaultMode,
      defaultAccessModeVersion: Number(row.default_access_mode_version ?? 0),
      queueState: row.queue_state as "active" | "paused",
      queuePauseReason: row.queue_pause_reason,
      queueRevision: Number(row.queue_revision),
      archivedAt: row.archived_at ?? null,
      createdAt: row.created_at,
    };
  }

  // ---------- 任务 ----------

  /**
   * 提交新任务（幂等）。同 (session_id, request_id)：
   * - 相同输入与权限参数（模式、授予路径）→ 返回已存在任务（duplicate=false 不新建）；
   * - 输入或任一权限参数不同 → 抛 ConflictError（复用幂等键修改模式必须冲突）。
   * 只有本函数在调用方事务内成功返回，提交才算接收成功。
   */
  insertQueuedTask(input: {
    sessionId: string;
    requestId: string;
    input: string;
    accessMode?: AccessMode;
    planMode?: boolean;
    grantedPaths?: GrantedPath[];
    resumesTaskId?: string | null;
    modelSelection: ModelSelection | null;
    submissionDigest: string;
    /** Host-derived task provenance; owner submissions leave it null. */
    parentTaskId?: string | null;
    sourcePermissionVersion?: number | null;
    deadline?: string | null;
    /** SubAgent 执行关联（agent-direction issue 11）：仅集中委派登记时携带。 */
    workId?: string | null;
    subAgentId?: string | null;
    readScope?: SubAgentReadScope | null;
    inputPurpose?: import("./views.ts").InputPurpose;
  }): { task: Task; duplicate: boolean } {
    const planMode = input.planMode ?? false;
    const accessMode = input.accessMode ?? (planMode ? "auto-review" : "confirm");
    if (typeof planMode !== "boolean" || (planMode && accessMode !== "auto-review")) {
      throw new StoreConflictError("Plan 任务必须使用 auto-review 访问策略", "invalid_params");
    }
    const grantedPaths = input.grantedPaths ?? [];
    const existing = this.findMatchingSubmission(input);
    if (existing) return { task: existing, duplicate: true };
    const queueOrder = Number(this.db.prepare("SELECT COALESCE(MAX(queue_order), 0) + 1 AS next FROM tasks WHERE session_id = ? AND status = 'queued'").get(input.sessionId)!.next);
    const task: Task = {
      id: randomId("task"),
      sessionId: input.sessionId,
      requestId: input.requestId,
      input: input.input,
      modelSelection: input.modelSelection,
      submissionDigest: input.submissionDigest,
      status: "queued",
      queueOrder,
      accessMode,
      planMode,
      permissionVersion: 1,
      grantedPaths,
      pendingAccessMode: null,
      interruptReason: null,
      cancelRequested: false,
      effectUnknown: false,
      errorMessage: null,
      historyEntryIds: [],
      resumesTaskId: input.resumesTaskId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      sourcePermissionVersion: input.sourcePermissionVersion ?? null,
      deadline: input.deadline ?? null,
      resultSummary: null,
      resultRef: null,
      workId: input.workId ?? null,
      subAgentId: input.subAgentId ?? null,
      readScope: input.readScope ?? null,
      resultDeliveredAt: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, session_id, request_id, input, status, access_mode, plan_mode, permission_version,
         granted_paths, pending_access_mode, interrupt_reason,
         cancel_requested, effect_unknown, error_message, history_entry_ids, resumes_task_id,
         created_at, started_at, ended_at, model_selection, submission_digest,
         parent_task_id, source_permission_version, deadline, result_summary, result_ref,
         work_id, sub_agent_id, read_scope, result_delivered_at, queue_order)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, 1, ?, NULL, NULL, 0, 0, NULL, '[]', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?)`,
      )
      .run(
        task.id,
        task.sessionId,
        task.requestId,
        task.input,
        task.accessMode,
        task.planMode ? 1 : 0,
        JSON.stringify(task.grantedPaths),
        task.resumesTaskId,
        task.createdAt,
        JSON.stringify(task.modelSelection),
        task.submissionDigest,
        task.parentTaskId,
        task.sourcePermissionVersion,
        task.deadline,
        task.workId,
        task.subAgentId,
        task.readScope ? JSON.stringify(task.readScope) : null,
        task.queueOrder,
      );
    this.appendEvent(
      {
        type: "task.queued",
        inputPurpose: input.inputPurpose ?? (this.ordinaryCodeTask(task) ? "user" : undefined),
        taskId: task.id,
        sessionId: task.sessionId,
        requestId: task.requestId,
        accessMode: task.accessMode,
        parentTaskId: task.parentTaskId,
        sourcePermissionVersion: task.sourcePermissionVersion,
        planMode: task.planMode,
        modelSelection: input.modelSelection,
        queueOrder: task.queueOrder,
      },
      { taskId: task.id, sessionId: task.sessionId },
    );
    if (task.resumesTaskId) {
      this.appendEvent(
        { type: "task.continued", taskId: task.id, sessionId: task.sessionId, resumesTaskId: task.resumesTaskId },
        { taskId: task.id, sessionId: task.sessionId },
      );
    }
    this.publishQueue(task.sessionId);
    return { task, duplicate: false };
  }

  /** 在异步模型检查之前核实；同一检查也在入队事务内重复，仲裁并发提交。 */
  findMatchingSubmission(input: {
    sessionId: string;
    requestId: string;
    submissionDigest: string;
  }): Task | null {
    const task = this.findTaskByRequest(input.sessionId, input.requestId);
    if (!task) return null;
    const matched = task.submissionDigest === input.submissionDigest;
    if (!task.submissionDigest || !matched) {
      throw new StoreConflictError(
        task.submissionDigest ? `request_id 已存在且提交参数不同：task=${task.id}` : `旧任务未记录原始提交参数，请通过 find_task 核实：task=${task.id}`,
        "request_conflict",
      );
    }
    return task;
  }

  /** 按父任务与请求键查子任务（委派幂等键在父任务范围内的唯一性核实）。 */
  findChildTask(parentTaskId: string, requestId: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE parent_task_id = ? AND request_id = ?")
      .get(parentTaskId, requestId) as any;
    return row ? this.rowToTask(row) : null;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    return row ? this.rowToTask(row) : null;
  }

  /**
   * MyGo 桌面浏览器绑定：经已登记浏览器能力的控制连接提交时，与任务同事务写入；
   * 连接断开即失效，新连接不能继承旧页面句柄。
   */
  bindTaskBrowser(taskId: string, connectionId: string): void {
    this.db.prepare("INSERT INTO task_browser_bindings (task_id, connection_id, created_at) VALUES (?, ?, ?)").run(taskId, connectionId, new Date().toISOString());
  }

  getTaskBrowserBinding(taskId: string): { connectionId: string } | null {
    const row = this.db.prepare("SELECT connection_id FROM task_browser_bindings WHERE task_id = ?").get(taskId) as { connection_id: string } | undefined;
    return row ? { connectionId: row.connection_id } : null;
  }

  listTasksBySession(sessionId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at, id")
      .all(sessionId) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  listTasksByStatus(statuses: TaskStatus[]): Task[] {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at, id`)
      .all(...statuses) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * 使用指定提供方的活动任务数（模型配置应用门闩，issue 21 §4）。
   * model_selection 是 JSON 文本列；活动任务数量小，解析在 JS 侧完成。
   */
  countActiveTasksByProviders(providers: string[]): number {
    const wanted = new Set(providers);
    if (wanted.size === 0) return 0;
    return this.listTasksByStatus([...ACTIVE_TASK_STATUSES])
      .filter((task) => task.modelSelection !== null && wanted.has(task.modelSelection.provider))
      .length;
  }

  listQueuedTasksFifo(sessionId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND status = 'queued' AND json_type(read_scope, '$.workCopyHost') IS NULL AND request_id NOT LIKE 'work-copy-host:%' AND NOT EXISTS (SELECT 1 FROM workflow_executions e WHERE e.task_id = tasks.id) AND NOT EXISTS (SELECT 1 FROM task_guidance g WHERE g.source_task_id = tasks.id AND g.state = 'pending') ORDER BY queue_order, rowid")
      .all(sessionId) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  getTaskQueue(sessionId: string): TaskQueue {
    const session = this.getSession(sessionId);
    if (!session) throw new StoreConflictError("会话不存在，请刷新后选择会话", "not_found");
    const tasks = this.listReorderableTasks(sessionId).filter(task => this.taskInputPurpose(task.id) === "user");
    return { revision: session.queueRevision, tasks: tasks.map(task => ({ taskId: task.id, queueOrder: task.queueOrder })), retrievableTaskIds: tasks.filter(task => task.startedAt === null && task.historyEntryIds.length === 0).map(task => task.id) };
  }

  taskInputPurpose(taskId: string): import("./views.ts").InputPurpose | undefined {
    const row = this.db.prepare("SELECT json_extract(body, '$.inputPurpose') AS purpose FROM events WHERE task_id = ? AND json_extract(body, '$.type') = 'task.queued' ORDER BY seq LIMIT 1").get(taskId);
    return row?.purpose === "user" || row?.purpose === "internal_report" ? row.purpose : undefined;
  }

  private publishQueue(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET queue_revision = queue_revision + 1 WHERE id = ?").run(sessionId);
    this.appendEvent({ type: "session.queue_changed", sessionId, queue: this.getTaskQueue(sessionId) }, { sessionId });
  }

  /** Historical answer Tasks remain identifiable for read-only provenance and recall rejection. */
  hasOwnerQuestionContinuation(taskId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM owner_questions WHERE json_extract(payload, '$.continuationTaskId') = ?").get(taskId);
  }

  ordinaryCodeTask(task: Task): boolean {
    return ownerQuestionTaskEligible(this, task) && this.taskInputPurpose(task.id) !== "internal_report" && !task.readScope?.workCopyHost && !task.requestId.startsWith("work-copy-host:")
      && !this.db.prepare("SELECT 1 FROM code_schedule_tasks WHERE task_id = ?").get(task.id);
  }

  listReorderableTasks(sessionId: string): Task[] {
    return this.listQueuedTasksFifo(sessionId).filter(task => this.ordinaryCodeTask(task) && this.taskInputPurpose(task.id) === "user");
  }

  /** The caller holds a transaction; reorder only ordinary user-input slots. */
  reorderTaskQueue(sessionId: string, taskIds: string[], expectedRevision: number): TaskQueue {
    const queue = this.getTaskQueue(sessionId);
    if (queue.revision !== expectedRevision) throw new StoreConflictError("队列已改变，请刷新实际顺序后重新选择", "queue_conflict");
    const tasks = this.listReorderableTasks(sessionId), byId = new Map(tasks.map(task => [task.id, task]));
    if (taskIds.length !== tasks.length || new Set(taskIds).size !== taskIds.length || taskIds.some(id => !byId.has(id))) {
      throw new StoreConflictError("待执行输入已改变，请刷新队列", "queue_conflict");
    }
    if (taskIds.every((id, index) => id === tasks[index].id)) return queue;
    const update = this.db.prepare("UPDATE tasks SET queue_order = ? WHERE id = ? AND status = 'queued'");
    for (const [index, id] of taskIds.entries()) update.run(tasks[index].queueOrder, id);
    this.publishQueue(sessionId);
    return this.getTaskQueue(sessionId);
  }

  getTaskGuidance(sourceTaskId: string): TaskGuidance | null {
    const row = this.db.prepare("SELECT * FROM task_guidance WHERE source_task_id = ?").get(sourceTaskId);
    return row ? {
      sourceTaskId: String(row.source_task_id), targetTaskId: String(row.target_task_id), sessionId: String(row.session_id),
      acceptedSeq: Number(row.accepted_seq), state: row.state as TaskGuidance["state"], entryId: row.entry_id === null ? null : String(row.entry_id),
    } : null;
  }

  listTaskGuidance(targetTaskId: string): TaskGuidance[] {
    return this.db.prepare("SELECT source_task_id FROM task_guidance WHERE target_task_id = ? ORDER BY accepted_seq").all(targetTaskId)
      .map(row => this.getTaskGuidance(String(row.source_task_id))!);
  }

  /** 控制面快照/重连用：会话内全部引导路由（含已接入与回退），按接纳次序。 */
  listSessionGuidance(sessionId: string): TaskGuidance[] {
    return this.db.prepare("SELECT source_task_id FROM task_guidance WHERE session_id = ? ORDER BY accepted_seq").all(sessionId)
      .map(row => this.getTaskGuidance(String(row.source_task_id))!);
  }

  /** 恢复核实（重启）与扫描用：所有仍待接入的引导路由，按接纳次序。 */
  listPendingGuidance(sessionId?: string): TaskGuidance[] {
    const rows = (sessionId === undefined
      ? this.db.prepare("SELECT source_task_id FROM task_guidance WHERE state = 'pending' ORDER BY accepted_seq").all()
      : this.db.prepare("SELECT source_task_id FROM task_guidance WHERE state = 'pending' AND session_id = ? ORDER BY accepted_seq").all(sessionId)) as any[];
    return rows.map(row => this.getTaskGuidance(String(row.source_task_id))!);
  }

  private writeGuidance(guidance: TaskGuidance): void {
    this.db.prepare(`INSERT INTO task_guidance (source_task_id, target_task_id, session_id, accepted_seq, state, entry_id)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_task_id) DO UPDATE SET
      target_task_id = excluded.target_task_id, accepted_seq = excluded.accepted_seq, state = excluded.state, entry_id = excluded.entry_id`)
      .run(guidance.sourceTaskId, guidance.targetTaskId, guidance.sessionId, guidance.acceptedSeq, guidance.state, guidance.entryId);
    this.appendEvent({ type: "task.guidance", taskId: guidance.sourceTaskId, sessionId: guidance.sessionId, guidance }, { taskId: guidance.sourceTaskId, sessionId: guidance.sessionId });
  }

  /** 新提交与转换共用源 Task；目标已结束时保存同一回执并回到队首。 */
  acceptTaskGuidance(sourceTaskId: string, targetTaskId: string, targetAccepting: boolean, expectedRevision?: number): TaskGuidance {
    const existing = this.getTaskGuidance(sourceTaskId);
    if (existing?.targetTaskId === targetTaskId) return existing;
    if (existing && existing.state !== "fallback") throw new StoreConflictError("该输入的引导目标已固定，请核实原任务现状", "request_conflict");
    const source = this.getTask(sourceTaskId), target = this.getTask(targetTaskId);
    if (!source || !target) throw new StoreConflictError("输入或目标任务不存在，请刷新会话", "not_found");
    if (source.status !== "queued") throw new StoreConflictError("输入已开始执行，不能转换为引导", "already_started");
    if (source.id === target.id || source.sessionId !== target.sessionId || !this.ordinaryCodeTask(source) || !this.ordinaryCodeTask(target) || source.resumesTaskId ||
      this.hasOwnerQuestionContinuation(source.id)) {
      throw new StoreConflictError("此会话或输入来源不允许转为引导", "guidance_not_allowed");
    }
    if (expectedRevision !== undefined && this.getTaskQueue(source.sessionId).revision !== expectedRevision) throw new StoreConflictError("队列已改变，请刷新后重新选择", "queue_conflict");
    const acceptedSeq = Number(this.db.prepare("SELECT COALESCE(MAX(accepted_seq), 0) + 1 AS next FROM task_guidance WHERE session_id = ?").get(source.sessionId)!.next);
    const accepting = targetAccepting && ["running", "awaiting_confirmation"].includes(target.status) && !target.cancelRequested;
    const guidance: TaskGuidance = { sourceTaskId, targetTaskId, sessionId: source.sessionId, acceptedSeq, state: accepting ? "pending" : "fallback", entryId: null };
    this.writeGuidance(guidance);
    if (!accepting) this.placeFallbackQueue(source.sessionId);
    else this.publishQueue(source.sessionId);
    return this.getTaskGuidance(sourceTaskId)!;
  }

  recordTaskGuidanceEntry(sourceTaskId: string, targetTaskId: string, entryId: string): TaskGuidance {
    const guidance = this.getTaskGuidance(sourceTaskId);
    if (!guidance || guidance.targetTaskId !== targetTaskId) throw new StoreConflictError("引导历史缺少可信路由，保留会话并核实记录", "guidance_unverified");
    if (guidance.state === "joined" && guidance.entryId === entryId) return guidance;
    if (guidance.state !== "pending" || !entryId) throw new StoreConflictError("引导历史与路由状态冲突，保留会话并核实记录", "guidance_unverified");
    const joined: TaskGuidance = { ...guidance, state: "joined", entryId };
    this.writeGuidance(joined);
    if (!this.endTask(sourceTaskId, ["queued"], "canceled", { interruptReason: "converted_to_guidance", endedAt: new Date().toISOString() })) {
      throw new StoreConflictError("引导源已独立执行，保留会话并核实记录", "guidance_unverified");
    }
    return joined;
  }

  fallbackTaskGuidance(targetTaskId: string): void {
    const pending = this.listTaskGuidance(targetTaskId).filter(guidance => guidance.state === "pending");
    if (pending.length === 0) return;
    const sessionId = pending[0].sessionId;
    for (const guidance of pending) this.writeGuidance({ ...guidance, state: "fallback" });
    this.placeFallbackQueue(sessionId);
  }

  private placeFallbackQueue(sessionId: string): void {
    const queue = this.getTaskQueue(sessionId).tasks;
    const prior = queue.filter(item => this.getTaskGuidance(item.taskId)?.state === "fallback");
    const front = prior.sort((a, b) => this.getTaskGuidance(a.taskId)!.acceptedSeq - this.getTaskGuidance(b.taskId)!.acceptedSeq);
    const ids = new Set(front.map(item => item.taskId));
    const ordered = [...front, ...queue.filter(item => !ids.has(item.taskId))];
    const update = this.db.prepare("UPDATE tasks SET queue_order = ? WHERE id = ? AND status = 'queued'");
    for (const [index, item] of ordered.entries()) update.run(index + 1, item.taskId);
    this.publishQueue(sessionId);
  }

  /**
   * 条件状态转换：仅当当前状态在 from 内才更新，返回是否生效。
   * 终态校验交给调用方的 from 列表；这是取消/完成竞争下唯一终态的保证点。
   */
  transitionTask(
    taskId: string,
    from: TaskStatus[],
    to: TaskStatus,
    extra: Partial<Pick<Task, "interruptReason" | "errorMessage" | "startedAt" | "endedAt" | "cancelRequested">> = {},
  ): boolean {
    const previous = this.getTask(taskId);
    if (previous && from.includes(previous.status) && previous.status === "queued" && to !== "queued") {
      const guidance = this.getTaskGuidance(taskId);
      if (guidance?.state === "pending") {
        if (to !== "canceled") throw new StoreConflictError("输入已用于引导，不能独立执行或收尾", "guidance_pending");
        this.writeGuidance({ ...guidance, state: "canceled" });
      }
    }
    const sets: string[] = ["status = ?"];
    const values: unknown[] = [to];
    if (extra.interruptReason !== undefined) {
      sets.push("interrupt_reason = ?");
      values.push(extra.interruptReason);
    }
    if (extra.errorMessage !== undefined) {
      sets.push("error_message = ?");
      values.push(extra.errorMessage);
    }
    if (extra.startedAt !== undefined) {
      sets.push("started_at = ?");
      values.push(extra.startedAt);
    }
    if (extra.endedAt !== undefined) {
      sets.push("ended_at = ?");
      values.push(extra.endedAt);
    }
    if (extra.cancelRequested !== undefined) {
      sets.push("cancel_requested = ?");
      values.push(extra.cancelRequested ? 1 : 0);
    }
    const placeholders = from.map(() => "?").join(",");
    values.push(taskId, ...from);
    const info = this.db
      .prepare(
        `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(...(values as any[]));
    const changed = Number(info.changes) === 1;
    if (changed && previous?.status === "queued" && to !== "queued") this.publishQueue(previous.sessionId);
    if (changed && isTerminalTaskStatus(to)) {
      invalidateOwnerQuestionsForTask(this, taskId);
      // 后台重启等没有存活 Driver 的终态路径也收束已持久化的思考阶段。
      const open = this.db.prepare(`SELECT body FROM events WHERE seq IN (
        SELECT MAX(seq) FROM events WHERE task_id = ? AND json_extract(body, '$.type') = 'task.thinking'
        GROUP BY json_extract(body, '$.thinkingId')
      )`).all(taskId) as Array<{ body: string }>;
      for (const row of open) {
        const body = JSON.parse(row.body) as Extract<PersistentEventBody, { type: "task.thinking" }>;
        if (body.endedAt === null) this.appendEvent({ ...body, endedAt: extra.endedAt ?? new Date().toISOString() }, { taskId, sessionId: body.sessionId });
      }
    }
    return changed;
  }

  /**
   * 终态收尾：调用方须以 withTx 包住。条件更新成功后，在同一事务内清理
   * 审批与待生效模式、写 task.* 事件并释放占用；keepOccupancy 用于旧执行单元
   * 尚未核实退出的路径。onChanged 供工具账本在终态事件前补记效果未知；
   * modeSwitchFailure 保留模式切换未核实路径的专用事件。
   */
  endTask(
    taskId: string,
    from: TaskStatus[],
    to: Extract<TaskStatus, "completed" | "failed" | "canceled" | "interrupted">,
    extra: Partial<Pick<Task, "interruptReason" | "errorMessage" | "endedAt">> & {
      keepOccupancy?: boolean;
      occupancyIssueReason?: string | null;
      onChanged?: (task: Task) => void;
      modeSwitchFailure?: { to: AccessMode; reason: string };
    } = {},
  ): boolean {
    const changed = this.transitionTask(taskId, from.filter((status) => ACTIVE_TASK_STATUSES.includes(status)), to, {
      interruptReason: extra.interruptReason,
      errorMessage: extra.errorMessage,
      endedAt: extra.endedAt ?? new Date().toISOString(),
    });
    if (!changed) return false;

    extra.onChanged?.(this.getTask(taskId)!);
    this.stalePendingConfirmations(taskId);
    this.clearPendingModeSwitch(taskId);

    const task = this.getTask(taskId)!;
    const refs = { taskId, sessionId: task.sessionId };
    if (to === "interrupted" && extra.modeSwitchFailure) {
      this.appendEvent({ type: "task.mode_switch_failed", ...refs, ...extra.modeSwitchFailure }, refs);
    } else switch (to) {
      case "completed":
        this.appendEvent({ type: "task.completed", taskId, sessionId: task.sessionId }, refs);
        break;
      case "failed":
        this.appendEvent({ type: "task.failed", taskId, sessionId: task.sessionId, errorMessage: extra.errorMessage ?? task.errorMessage ?? "" }, refs);
        break;
      case "canceled":
        this.appendEvent({ type: "task.canceled", taskId, sessionId: task.sessionId }, refs);
        break;
      case "interrupted":
        this.appendEvent(
          {
            type: "task.interrupted",
            taskId,
            sessionId: task.sessionId,
            reason: task.interruptReason ?? "unknown",
            cancelRequested: task.cancelRequested,
            effectUnknown: task.effectUnknown,
          },
          refs,
        );
        break;
    }
    if (extra.keepOccupancy) {
      if (extra.occupancyIssueReason) {
        this.appendEvent(
          { type: "task.tool_process_unreaped", taskId, sessionId: task.sessionId, reason: extra.occupancyIssueReason },
          refs,
        );
      }
    } else {
      this.releaseOccupancy(taskId);
    }
    return true;
  }

  /** 提交停止意图（不改变状态；中断原因与取消意图分开记录）。 */
  setCancelRequested(taskId: string, cancelIntent: boolean): void {
    this.db
      .prepare("UPDATE tasks SET cancel_requested = ? WHERE id = ?")
      .run(cancelIntent ? 1 : 0, taskId);
  }

  addHistoryEntryIds(taskId: string, entryIds: string[]): void {
    const task = this.getTask(taskId);
    if (!task) return;
    const merged = Array.from(new Set([...task.historyEntryIds, ...entryIds]));
    this.db.prepare("UPDATE tasks SET history_entry_ids = ? WHERE id = ?").run(JSON.stringify(merged), taskId);
  }

  setEffectUnknown(taskId: string): void {
    this.db.prepare("UPDATE tasks SET effect_unknown = 1 WHERE id = ?").run(taskId);
  }

  private rowToTask(row: any): Task {
    return {
      id: row.id,
      sessionId: row.session_id,
      requestId: row.request_id,
      input: row.input,
      modelSelection: row.model_selection ? JSON.parse(row.model_selection) as ModelSelection : null,
      submissionDigest: row.submission_digest ?? null,
      status: row.status as TaskStatus,
      queueOrder: Number(row.queue_order),
      accessMode: (row.access_mode ?? "confirm") as AccessMode,
      planMode: Number(row.plan_mode ?? 0) === 1,
      permissionVersion: Number(row.permission_version ?? 1),
      grantedPaths: JSON.parse(row.granted_paths ?? "[]") as GrantedPath[],
      pendingAccessMode: (row.pending_access_mode ?? null) as AccessMode | null,
      interruptReason: row.interrupt_reason,
      cancelRequested: Number(row.cancel_requested) === 1,
      effectUnknown: Number(row.effect_unknown) === 1,
      errorMessage: row.error_message,
      historyEntryIds: JSON.parse(row.history_entry_ids) as string[],
      resumesTaskId: row.resumes_task_id,
      parentTaskId: row.parent_task_id ?? null,
      sourcePermissionVersion: row.source_permission_version === null ? null : Number(row.source_permission_version),
      deadline: row.deadline ?? null,
      resultSummary: row.result_summary ?? null,
      resultRef: row.result_ref ?? null,
      workId: row.work_id ?? null,
      subAgentId: row.sub_agent_id ?? null,
      readScope: row.read_scope ? (JSON.parse(row.read_scope) as SubAgentReadScope) : null,
      resultDeliveredAt: row.result_delivered_at ?? null,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }

  /**
   * 记录任务结构化结果（issue 01；编排器在终态后调用）。一次写入：
   * 已记录结果的重复回传（事件监听与启动巡检竞争）只有第一个生效。
   */
  setTaskResult(taskId: string, summary: string, resultRef: string): boolean {
    const info = this.db
      .prepare("UPDATE tasks SET result_summary = ?, result_ref = ? WHERE id = ? AND result_summary IS NULL")
      .run(summary, resultRef, taskId);
    return Number(info.changes) === 1;
  }

  /** 截止时间在 now 之前的活动任务（编排器超时巡检）。 */
  listOverdueTasks(nowIso: string): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE deadline IS NOT NULL AND deadline < ? AND status IN ('queued','running','awaiting_confirmation') ORDER BY created_at, id",
      )
      .all(nowIso) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  /** Unstarted child tasks become interrupted on restart; workflow recovery owns its executions. */
  listQueuedSubAgentTasks(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE sub_agent_id IS NOT NULL AND status = 'queued'
         AND NOT EXISTS (SELECT 1 FROM workflow_executions e WHERE e.task_id = tasks.id)
         ORDER BY created_at, id`,
      )
      .all() as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  // ---------- SubAgent 与工作委托（agent-direction issue 11；宿主管理） ----------

  insertSubAgent(agent: SubAgent): void {
    const definition = requireSubAgentDefinition(agent);
    this.db
      .prepare(
        `INSERT INTO sub_agents (id, definition, parent_session_id, session_id, work_dir, active_work_id, current_task_id, state, closed_at, closed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agent.id, JSON.stringify(definition), agent.parentSessionId, agent.sessionId, agent.workDir, agent.activeWorkId, agent.currentTaskId, agent.state, agent.closedAt, agent.closedBy, agent.createdAt);
  }

  getSubAgent(id: string): SubAgent | null {
    const row = this.db.prepare("SELECT * FROM sub_agents WHERE id = ?").get(id) as any;
    return row ? this.rowToSubAgent(row) : null;
  }

  /** Host-bound conversation identity, or null when the conversation does not exist. */
  getSessionIdentity(sessionId: string): SessionIdentity | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const workflow = this.db.prepare(`SELECT e.run_id, e.step_key, r.source_session_id
      FROM workflow_executions e JOIN workflow_runs r ON r.id = e.run_id JOIN tasks t ON t.id = e.task_id
      WHERE t.session_id = ? AND e.kind = 'agent' ORDER BY e.rowid DESC LIMIT 1`).get(sessionId) as
      { run_id: string; step_key: string; source_session_id: string } | undefined;
    const agent = this.getSubAgentBySession(sessionId);
    if (workflow && (!agent || agent.parentSessionId !== workflow.source_session_id)) throw new StoreConflictError("工作流步骤的来源与 SubAgent 绑定不一致", "workflow_binding_invalid");
    return classifySession(agent, workflow ? { runId: workflow.run_id, stepKey: workflow.step_key, sourceSessionId: workflow.source_session_id } : null, this.sideParentId(sessionId));
  }

  /** 侧聊绑定反查（宿主身份的唯一依据；无绑定时 null，含未发布绑定）。 */
  sideParentId(sessionId: string): string | null {
    const row = this.db.prepare("SELECT parent_session_id FROM side_chats WHERE side_session_id = ?").get(sessionId) as { parent_session_id: string } | undefined;
    return row?.parent_session_id ?? null;
  }

  /** 按独立子会话反查 SubAgent 绑定（宿主识别动态身份的唯一依据）。 */
  getSubAgentBySession(sessionId: string): SubAgent | null {
    const row = this.db.prepare("SELECT * FROM sub_agents WHERE session_id = ?").get(sessionId) as any;
    return row ? this.rowToSubAgent(row) : null;
  }

  listSubAgents(): SubAgent[] {
    const rows = this.db.prepare("SELECT * FROM sub_agents ORDER BY created_at, id").all() as any[];
    return rows.map((r) => this.rowToSubAgent(r));
  }

  /** 指定父用户会话名下的全部 SubAgent（复用总览与关闭归属核实）。 */
  listSubAgentsBySession(parentSessionId: string): SubAgent[] {
    const rows = this.db.prepare("SELECT * FROM sub_agents WHERE parent_session_id = ? ORDER BY created_at, id").all(parentSessionId) as any[];
    return rows.map((r) => this.rowToSubAgent(r));
  }

  /** 更新运行/空闲状态与当前工作/任务指针（与结果登记同一事务；终态竞争由 setTaskResult 的一次写入仲裁）。 */
  setSubAgentState(id: string, state: SubAgentState, current: { activeWorkId?: string | null; currentTaskId?: string | null }): void {
    if (current.activeWorkId !== undefined && current.currentTaskId !== undefined) {
      this.db
        .prepare("UPDATE sub_agents SET state = ?, active_work_id = ?, current_task_id = ? WHERE id = ?")
        .run(state, current.activeWorkId, current.currentTaskId, id);
    } else if (current.currentTaskId !== undefined) {
      this.db.prepare("UPDATE sub_agents SET state = ?, current_task_id = ? WHERE id = ?").run(state, current.currentTaskId, id);
    } else {
      this.db.prepare("UPDATE sub_agents SET state = ? WHERE id = ?").run(state, id);
    }
  }

  /**
   * 显式关闭（issue 12）：一次条件写入（未关闭才生效），与委派的事务内可用性
   * 复核配合保证「先关闭则委派报已关闭，先委派则关闭报有活动任务」二选一。
   */
  closeSubAgent(id: string, at: string, by: SubAgent["closedBy"]): boolean {
    const res = this.db
      .prepare("UPDATE sub_agents SET closed_at = ?, closed_by = ? WHERE id = ? AND closed_at IS NULL")
      .run(at, by, id);
    return Number(res.changes) > 0;
  }

  /**
   * 修改工作的 SubAgent 会话 cwd 对齐（agent-direction issue 16）：首次修改
   * 委派钉定 writeTarget 后，该 Agent 的子会话 cwd 从独立宿主目录切换到
   * writeTarget.path（后续所有任务经 taskWorkspace 复用同一键）。
   */
  setSubAgentCwd(subAgentId: string, cwd: string, real: string, dev: number, ino: number): void {
    this.db
      .prepare("UPDATE sub_agents SET work_dir = ? WHERE id = ?")
      .run(cwd, subAgentId);
    const id = this.db
      .prepare("SELECT session_id FROM sub_agents WHERE id = ?")
      .get(subAgentId) as { session_id: string } | undefined;
    if (id) {
      this.db
        .prepare("UPDATE sessions SET cwd = ?, cwd_real = ?, cwd_dev = ?, cwd_ino = ? WHERE id = ?")
        .run(cwd, real, dev, ino, id.session_id);
    }
  }

  /** 该 SubAgent 名下的活动执行任务（queued/running/awaiting_confirmation）。 */
  findActiveSubAgentTask(subAgentId: string): Task | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks WHERE sub_agent_id = ? AND status IN ('queued','running','awaiting_confirmation')
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(subAgentId) as any;
    return row ? this.rowToTask(row) : null;
  }

  private rowToSubAgent(row: any): SubAgent {
    let definition: SubAgent["definition"] = null;
    let definitionError: string | undefined;
    try { definition = subAgentDefinitionFromJson(row.definition); }
    catch (error) {
      if (!(error instanceof SubAgentDefinitionError)) throw error;
      definitionError = error.code;
    }
    return {
      id: row.id,
      definition,
      ...(definitionError ? { definitionError } : {}),
      parentSessionId: row.parent_session_id,
      sessionId: row.session_id,
      workDir: row.work_dir,
      activeWorkId: row.active_work_id ?? null,
      currentTaskId: row.current_task_id ?? null,
      state: row.state as SubAgentState,
      closedAt: row.closed_at ?? null,
      closedBy: row.closed_by ?? null,
      createdAt: row.created_at,
    };
  }

  insertWorkDelegation(work: WorkDelegation): void {
    this.db
      .prepare(
        `INSERT INTO work_delegations (id, parent_session_id, origin_task_id, sub_agent_id, request_key, params_digest, canceled_at, canceled_by, cancel_reason, write_target, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(work.id, work.parentSessionId, work.originTaskId, work.subAgentId, work.requestKey, work.paramsDigest, work.canceledAt, work.canceledBy, work.cancelReason, writeTargetToJson(work.writeTarget), work.createdAt);
  }

  getWorkDelegation(id: string): WorkDelegation | null {
    const row = this.db.prepare("SELECT * FROM work_delegations WHERE id = ?").get(id) as any;
    return row ? this.rowToWorkDelegation(row) : null;
  }

  /** 按父会话与首次委派键查既有工作（跨对话轮次的重复委派核实）。 */
  findWorkDelegation(parentSessionId: string, requestKey: string): WorkDelegation | null {
    const row = this.db
      .prepare("SELECT * FROM work_delegations WHERE parent_session_id = ? AND request_key = ?")
      .get(parentSessionId, requestKey) as any;
    return row ? this.rowToWorkDelegation(row) : null;
  }

  listWorkDelegationsBySession(parentSessionId: string): WorkDelegation[] {
    const rows = this.db
      .prepare("SELECT * FROM work_delegations WHERE parent_session_id = ? ORDER BY created_at, id")
      .all(parentSessionId) as any[];
    return rows.map((r) => this.rowToWorkDelegation(r));
  }

  listWorkDelegations(): WorkDelegation[] {
    const rows = this.db.prepare("SELECT * FROM work_delegations ORDER BY created_at, id").all() as any[];
    return rows.map((r) => this.rowToWorkDelegation(r));
  }

  private rowToWorkDelegation(row: any): WorkDelegation {
    return {
      id: row.id,
      parentSessionId: row.parent_session_id,
      originTaskId: row.origin_task_id,
      subAgentId: row.sub_agent_id,
      requestKey: row.request_key,
      paramsDigest: row.params_digest,
      canceledAt: row.canceled_at ?? null,
      canceledBy: row.canceled_by ?? null,
      cancelReason: row.cancel_reason ?? null,
      writeTarget: parseWorkWriteTarget(row.write_target ?? null),
      createdAt: row.created_at,
    };
  }

  /**
   * 整项取消（issue 14）：一次条件写入（未取消才生效），与委派登记在同一
   * 同步事务内定胜负——先登记的任务必然在取消清单内，后登记的必然被拒。
   */
  cancelWorkDelegation(id: string, at: string, by: WorkCanceledBy, reason: string | null): boolean {
    const res = this.db
      .prepare("UPDATE work_delegations SET canceled_at = ?, canceled_by = ?, cancel_reason = ? WHERE id = ? AND canceled_at IS NULL")
      .run(at, by, reason, id);
    return Number(res.changes) > 0;
  }

  /** 属一项工作委托的全部执行任务（按创建序）。 */
  listTasksByWork(workId: string): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE work_id = ? ORDER BY created_at, id").all(workId) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  /** 属一项工作委托的活动执行任务（queued/running/awaiting_confirmation；整项取消的目标集）。 */
  listActiveTasksByWork(workId: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE work_id = ? AND status IN ('queued','running','awaiting_confirmation') ORDER BY created_at, id`,
      )
      .all(workId) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  /** Active delegated tasks, including unverified occupancy, count toward the parent's limit. */
  countActiveSubAgentTasks(parentSessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t JOIN work_delegations w ON w.id = t.work_id
         WHERE w.parent_session_id = ?
           AND (t.status IN ('running','awaiting_confirmation') OR
             (t.status = 'queued' AND NOT EXISTS (SELECT 1 FROM workflow_executions e WHERE e.task_id = t.id)) OR
             EXISTS (SELECT 1 FROM occupancy o WHERE o.task_id = t.id))`,
      )
      .get(parentSessionId) as any;
    return Number(row.n);
  }

  /** 该工作是否已登记过改动汇总（agent-direction issue 17：幂等命中/账本核实）。 */
  hasIntegratedEvent(workId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS x FROM events WHERE json_extract(body, '$.type') = 'work_delegation.integrated' AND json_extract(body, '$.workId') = ? LIMIT 1",
      )
      .get(workId) as any;
    return row !== undefined;
  }

  /**
   * dev 父会话待注入的 SubAgent 结果：终态、结果已记录、尚未注入开发模型
   * 上下文的执行任务（result_delivered_at 为 null）。注入时按 id 标记者在
   * 同一事务内；崩溃窗口丢失注入不丢失结果（持久事件与 subagent_result 可查）。
   * 已取消的工作（issue 14）不再注入任何父模型——用一条规则排除主 Agent
   * 据此重启工作；需要时由主 Agent 主动 subagent_result 读取。
   */
  listUndeliveredSubAgentResults(parentSessionId: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t JOIN work_delegations w ON w.id = t.work_id
         WHERE w.parent_session_id = ? AND t.sub_agent_id IS NOT NULL AND w.canceled_at IS NULL
           AND t.result_summary IS NOT NULL AND t.result_delivered_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM workflow_executions e WHERE e.task_id = t.id)
           AND t.status IN ('completed','failed','canceled','interrupted')
         ORDER BY t.created_at, t.id`,
      )
      .all(parentSessionId) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  markSubAgentResultsDelivered(taskIds: string[], deliveredAt: string): void {
    for (const id of taskIds) {
      this.db.prepare("UPDATE tasks SET result_delivered_at = ? WHERE id = ? AND result_delivered_at IS NULL").run(deliveredAt, id);
    }
  }

  // ---------- 工作内协作消息（agent-direction issue 13；宿主管理） ----------

  insertSubAgentMessage(msg: SubAgentMessage): void {
    this.db
      .prepare(
        `INSERT INTO subagent_messages (id, work_id, parent_session_id, from_sub_agent_id, from_task_id,
         access_mode, source_permission_version, to_sub_agent_id, request_key, params_digest, body, created_at, delivered_task_id, delivered_at, undelivered_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.workId,
        msg.parentSessionId,
        msg.fromSubAgentId,
        msg.fromTaskId,
        msg.accessMode,
        msg.sourcePermissionVersion,
        msg.toSubAgentId,
        msg.requestKey,
        msg.paramsDigest,
        msg.body,
        msg.createdAt,
        msg.deliveredTaskId,
        msg.deliveredAt,
        msg.undeliveredReason,
      );
  }

  getSubAgentMessage(id: string): SubAgentMessage | null {
    const row = this.db.prepare("SELECT * FROM subagent_messages WHERE id = ?").get(id) as any;
    return row ? this.rowToSubAgentMessage(row) : null;
  }

  /** 按（工作, 发送方, 键）查既有消息——发送方的 null（主 Agent）与会话复用键空间分开。 */
  findSubAgentMessage(workId: string, fromSubAgentId: string | null, requestKey: string): SubAgentMessage | null {
    const row = (
      fromSubAgentId === null
        ? this.db.prepare("SELECT * FROM subagent_messages WHERE work_id = ? AND request_key = ? AND from_sub_agent_id IS NULL")
        : this.db.prepare("SELECT * FROM subagent_messages WHERE work_id = ? AND request_key = ? AND from_sub_agent_id = ?")
    ).get(...(fromSubAgentId === null ? [workId, requestKey] : [workId, requestKey, fromSubAgentId])) as any;
    return row ? this.rowToSubAgentMessage(row) : null;
  }

  /** 一项工作的全部消息（按创建序；subagent_result 与 work_get 的来源追溯）。 */
  listSubAgentMessagesByWork(workId: string): SubAgentMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM subagent_messages WHERE work_id = ? ORDER BY created_at, id")
      .all(workId) as any[];
    return rows.map((r) => this.rowToSubAgentMessage(r));
  }

  /**
   * 待投递/判定的消息（delivered 与 undelivered_reason 均为空），按创建序；
   * parentSessionId 省略时跨会话全部（启动冲刷）。
   */
  listPendingSubAgentMessages(parentSessionId?: string): SubAgentMessage[] {
    const rows = (
      parentSessionId === undefined
        ? this.db.prepare("SELECT * FROM subagent_messages WHERE delivered_at IS NULL AND undelivered_reason IS NULL ORDER BY created_at, id")
        : this.db.prepare(
            "SELECT * FROM subagent_messages WHERE delivered_at IS NULL AND undelivered_reason IS NULL AND parent_session_id = ? ORDER BY created_at, id",
          )
    ).all(...(parentSessionId === undefined ? [] : [parentSessionId])) as any[];
    return rows.map((r) => this.rowToSubAgentMessage(r));
  }

  /**
   * dev 父会话待注入的工作内消息（发给主 Agent、尚未注入、工作未取消）——
   * 与待注入结果同一口径：取消的工作不再注入任何父模型。
   */
  listUndeliveredParentSubAgentMessages(parentSessionId: string): SubAgentMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM subagent_messages m JOIN work_delegations w ON w.id = m.work_id
         WHERE m.parent_session_id = ? AND m.to_sub_agent_id IS NULL AND m.delivered_at IS NULL
           AND m.undelivered_reason IS NULL AND w.canceled_at IS NULL
         ORDER BY m.created_at, m.id`,
      )
      .all(parentSessionId) as any[];
    return rows.map((r) => this.rowToSubAgentMessage(r));
  }

  /** 投递登记（一次写入；dev 注入无任务时 taskId 为 null）。 */
  markSubAgentMessageDelivered(id: string, taskId: string | null, deliveredAt: string): boolean {
    const res = this.db
      .prepare("UPDATE subagent_messages SET delivered_task_id = ?, delivered_at = ? WHERE id = ? AND delivered_at IS NULL AND undelivered_reason IS NULL")
      .run(taskId, deliveredAt, id);
    return Number(res.changes) > 0;
  }

  /** 无法投递的明确结果（一次写入；与投递登记互斥）。 */
  markSubAgentMessageUndelivered(id: string, reason: string): boolean {
    const res = this.db
      .prepare("UPDATE subagent_messages SET undelivered_reason = ? WHERE id = ? AND delivered_at IS NULL AND undelivered_reason IS NULL")
      .run(reason, id);
    return Number(res.changes) > 0;
  }

  private rowToSubAgentMessage(row: any): SubAgentMessage {
    return {
      id: row.id,
      workId: row.work_id,
      parentSessionId: row.parent_session_id,
      fromSubAgentId: row.from_sub_agent_id ?? null,
      fromTaskId: row.from_task_id,
      accessMode: row.access_mode as AccessMode,
      sourcePermissionVersion: Number(row.source_permission_version),
      toSubAgentId: row.to_sub_agent_id ?? null,
      requestKey: row.request_key,
      paramsDigest: row.params_digest,
      body: row.body,
      createdAt: row.created_at,
      deliveredTaskId: row.delivered_task_id ?? null,
      deliveredAt: row.delivered_at ?? null,
      undeliveredReason: row.undelivered_reason ?? null,
    };
  }

  /** Current conversation model references prevent removal of an in-use provider or model. */
  countProviderReferences(provider: string, modelId?: string): { sessions: number } {
    const matches = (json: string | null): boolean => {
      if (!json) return false;
      try {
        const sel = JSON.parse(json) as ModelSelection;
        return sel.provider === provider && (modelId === undefined || sel.modelId === modelId);
      } catch {
        return false;
      }
    };
    const sessionRows = this.db.prepare("SELECT model_selection FROM sessions WHERE model_selection IS NOT NULL").all() as Array<{ model_selection: string }>;
    return {
      sessions: sessionRows.filter((r) => matches(r.model_selection)).length,
    };
  }

  // ---------- Host metadata ----------

  getMetaValue(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMetaValue(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // ---------- 访问模式与权限版本 ----------

  /** 请求模式切换（记录待生效模式；不改变当前模式）。 */
  requestModeSwitch(taskId: string, to: AccessMode): boolean {
    if (this.getTask(taskId)?.planMode) {
      throw new StoreConflictError("Plan 任务不能切换模式，请中断后按所选模式继续", "invalid_params");
    }
    const info = this.db
      .prepare("UPDATE tasks SET pending_access_mode = ? WHERE id = ? AND status IN ('queued','running','awaiting_confirmation')")
      .run(to, taskId);
    return Number(info.changes) === 1;
  }

  /** 清除待生效模式标记（任务到达终态或切换已应用时）。 */
  clearPendingModeSwitch(taskId: string): void {
    this.db.prepare("UPDATE tasks SET pending_access_mode = NULL WHERE id = ?").run(taskId);
  }

  /**
   * 应用模式切换（工具边界处调用）：切换模式、递增权限版本、清除待生效
   * 标记、失效本任务未决审批（不自动执行旧待批准操作）。返回新权限版本。
   */
  applyModeSwitch(taskId: string, to: AccessMode): number {
    const task = this.getTask(taskId);
    if (!task) throw new StoreConflictError(`任务不存在：${taskId}`, "not_found");
    if (task.planMode) {
      throw new StoreConflictError("Plan 任务不能切换模式，请中断后按所选模式继续", "invalid_params");
    }
    const newVersion = task.permissionVersion + 1;
    this.db
      .prepare(
        "UPDATE tasks SET access_mode = ?, pending_access_mode = NULL, permission_version = ? WHERE id = ?",
      )
      .run(to, newVersion, taskId);
    this.stalePendingConfirmations(taskId);
    return newVersion;
  }

  /** 更新任务的授予路径并递增权限版本（旧审批随之失效）。 */
  updateGrantedPaths(taskId: string, paths: GrantedPath[]): number {
    const task = this.getTask(taskId);
    if (!task) throw new StoreConflictError(`任务不存在：${taskId}`, "not_found");
    const newVersion = task.permissionVersion + 1;
    this.db
      .prepare("UPDATE tasks SET granted_paths = ?, permission_version = ? WHERE id = ?")
      .run(JSON.stringify(paths), newVersion, taskId);
    this.stalePendingConfirmations(taskId);
    return newVersion;
  }

  // ---------- 确认请求 ----------

  createConfirmation(input: {
    taskId: string;
    sessionId: string;
    toolOpId: string;
    toolName: string;
    params: Record<string, unknown>;
    scope: ApprovalScope;
    permissionVersion: number;
    /** 自动审查初始标记（issue 15）：给出时记录进入"审查中"。 */
    review?: { model: string; policyVersion: string };
  }): ConfirmationRequest {
    const session = this.getSession(input.sessionId);
    const confirmation: ConfirmationRequest = {
      id: randomId("conf"),
      taskId: input.taskId,
      sessionId: input.sessionId,
      toolOpId: input.toolOpId,
      toolName: input.toolName,
      params: input.params,
      scope: input.scope,
      cwdDev: session?.cwdDev ?? 0,
      cwdIno: session?.cwdIno ?? 0,
      permissionVersion: input.permissionVersion,
      status: "pending",
      createdAt: new Date().toISOString(),
      respondedAt: null,
      consumedAt: null,
      reviewStatus: input.review ? "in_progress" : null,
      reviewDecision: null,
      reviewReason: null,
      reviewModel: input.review?.model ?? null,
      reviewPolicyVersion: input.review?.policyVersion ?? null,
      decisionSource: null,
    };
    this.db
      .prepare(
        `INSERT INTO confirmations (id, task_id, session_id, tool_op_id, tool_name, params, scope, cwd_dev, cwd_ino, permission_version, status, created_at, responded_at, consumed_at,
         review_status, review_model, review_policy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        confirmation.id,
        confirmation.taskId,
        confirmation.sessionId,
        confirmation.toolOpId,
        confirmation.toolName,
        JSON.stringify(confirmation.params),
        JSON.stringify(confirmation.scope),
        confirmation.cwdDev,
        confirmation.cwdIno,
        confirmation.permissionVersion,
        confirmation.createdAt,
        confirmation.reviewStatus,
        confirmation.reviewModel,
        confirmation.reviewPolicyVersion,
      );
    this.appendEvent(
      {
        type: "task.awaiting_confirmation",
        taskId: confirmation.taskId,
        confirmationId: confirmation.id,
        toolOpId: confirmation.toolOpId,
        toolName: confirmation.toolName,
        params: confirmation.params,
        scope: confirmation.scope,
        permissionVersion: confirmation.permissionVersion,
        // 新建审批的审查状态只会是 in_progress（自动审查）或 null（纯人工）
        reviewStatus: confirmation.reviewStatus as "in_progress" | null,
        reviewModel: confirmation.reviewModel,
        reviewPolicyVersion: confirmation.reviewPolicyVersion,
      },
      { taskId: confirmation.taskId, sessionId: confirmation.sessionId },
    );
    return confirmation;
  }

  getConfirmation(id: string): ConfirmationRequest | null {
    const row = this.db.prepare("SELECT * FROM confirmations WHERE id = ?").get(id) as any;
    return row ? this.rowToConfirmation(row) : null;
  }

  listConfirmationsByStatus(status: ConfirmationStatus): ConfirmationRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM confirmations WHERE status = ? ORDER BY created_at, id")
      .all(status) as any[];
    return rows.map((r) => this.rowToConfirmation(r));
  }

  listConfirmationsByTask(taskId: string): ConfirmationRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM confirmations WHERE task_id = ? ORDER BY created_at, id")
      .all(taskId) as any[];
    return rows.map((r) => this.rowToConfirmation(r));
  }

  /**
   * 条件应答：仅 pending 生效；重复批准、失效批准在此被拒绝。
   * - 人工路径（source 'owner'，默认）：记录决定来源；进行中的自动审查标记
   *   superseded（人工抢先，迟到的审查结果不得再落盘）。
   * - 自动审查路径（source 'auto_review'）：额外要求权限版本仍匹配且任务仍
   *   活动（审查期间的模式切换/任务结束使结果失效），并写入审查结论与理由。
   */
  respondConfirmation(
    id: string,
    decision: "approved" | "rejected",
    opts: {
      source?: "owner" | "auto_review";
      expectedPermissionVersion?: number;
      reviewDecision?: string;
      reviewReason?: string;
    } = {},
  ): boolean {
    const now = new Date().toISOString();
    if (opts.source === "auto_review") {
      const info = this.db
        .prepare(
          `UPDATE confirmations SET status = ?, responded_at = ?, decision_source = 'auto_review',
             review_status = 'done', review_decision = ?, review_reason = ?
           WHERE id = ? AND status = 'pending' AND permission_version = ?
             AND task_id IN (SELECT id FROM tasks WHERE status IN ('running','awaiting_confirmation'))`,
        )
        .run(decision, now, opts.reviewDecision ?? null, opts.reviewReason ?? null, id, opts.expectedPermissionVersion ?? -1);
      return Number(info.changes) === 1;
    }
    const info = this.db
      .prepare(
        `UPDATE confirmations SET status = ?, responded_at = ?, decision_source = 'owner',
           review_status = CASE WHEN review_status = 'in_progress' THEN 'superseded' ELSE review_status END
         WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, now, id);
    return Number(info.changes) === 1;
  }

  /** 自动审查转人工（条件：仍 pending；人工已抢先时不覆盖其决定）。 */
  markConfirmationAskedOwner(id: string, reason: string): boolean {
    const info = this.db
      .prepare(
        "UPDATE confirmations SET review_status = 'asked_owner', review_decision = 'ask_owner', review_reason = ? WHERE id = ? AND status = 'pending'",
      )
      .run(reason, id);
    return Number(info.changes) === 1;
  }

  /** 审查结果被取代（人工抢先/取消/模式切换）：仅"审查中"可转，不动审批状态。 */
  markConfirmationReviewSuperseded(id: string): boolean {
    const info = this.db
      .prepare("UPDATE confirmations SET review_status = 'superseded' WHERE id = ? AND review_status = 'in_progress'")
      .run(id);
    return Number(info.changes) === 1;
  }

  /**
   * 单次消费批准（条件更新原子完成资格校验与消费登记）：
   * 仅当批准未消费、权限版本仍匹配、任务仍活动时生效；返回是否消费成功。
   * 真正启动执行前由调用方在同一事务内记录执行开始（consumed_at 即执行开始）。
   *
   * 权限版本核对两处（issue 06 §5）：批准记录保存的版本 = 请求方传入的期望版本，
   * 且任务的当前权限版本 = 期望版本——覆盖异步复核期间任务被取消/切换模式
   * （permission_version 递增）后旧批准被误消费的场景。
   */
  consumeApproval(input: {
    confirmationId: string;
    expectedPermissionVersion: number;
    activeStatuses: TaskStatus[];
  }): boolean {
    const placeholders = input.activeStatuses.map(() => "?").join(",");
    const info = this.db
      .prepare(
        `UPDATE confirmations SET consumed_at = ?
         WHERE id = ? AND status = 'approved' AND consumed_at IS NULL AND permission_version = ?
           AND task_id IN (SELECT id FROM tasks WHERE status IN (${placeholders}) AND permission_version = ?)`,
      )
      .run(
        new Date().toISOString(),
        input.confirmationId,
        input.expectedPermissionVersion,
        ...input.activeStatuses,
        input.expectedPermissionVersion,
      );
    return Number(info.changes) === 1;
  }

  /**
   * 任务到达任何终态，或权限范围变化时，其未决与"已批准未消费"的确认请求标记 stale
   * （失效批准不得再执行，旧 waiter 不重建；consumed_at 即执行开始，已消费不动）；
   * 进行中的自动审查一并标记 superseded（后台重启后不再有审查结果到达，不能永远显示"审查中"）。
   */
  stalePendingConfirmations(taskId: string): void {
    this.db
      .prepare(
        `UPDATE confirmations SET status = 'stale', responded_at = ?,
           review_status = CASE WHEN review_status = 'in_progress' THEN 'superseded' ELSE review_status END
         WHERE task_id = ? AND consumed_at IS NULL AND status IN ('pending', 'approved')`,
      )
      .run(new Date().toISOString(), taskId);
  }

  /**
   * 单条审批失效（架构工单 04）：未消费的 pending/approved → stale。等待前信号已中止、
   * 获批后复核或消费失败时用；已消费的批准不动（消费即执行开始）。
   */
  invalidateConfirmation(id: string): void {
    this.db
      .prepare(
        `UPDATE confirmations SET status = 'stale', responded_at = COALESCE(responded_at, ?),
           review_status = CASE WHEN review_status = 'in_progress' THEN 'superseded' ELSE review_status END
         WHERE id = ? AND consumed_at IS NULL AND status IN ('pending', 'approved')`,
      )
      .run(new Date().toISOString(), id);
  }

  private rowToConfirmation(row: any): ConfirmationRequest {
    return {
      id: row.id,
      taskId: row.task_id,
      sessionId: row.session_id,
      toolOpId: row.tool_op_id,
      toolName: row.tool_name,
      params: JSON.parse(row.params) as Record<string, unknown>,
      scope: JSON.parse(row.scope ?? '{"kind":"tool","workspaceOnly":true}') as ApprovalScope,
      cwdDev: Number(row.cwd_dev ?? 0),
      cwdIno: Number(row.cwd_ino ?? 0),
      permissionVersion: Number(row.permission_version ?? 1),
      status: row.status as ConfirmationStatus,
      createdAt: row.created_at,
      respondedAt: row.responded_at,
      consumedAt: row.consumed_at,
      reviewStatus: (row.review_status ?? null) as ConfirmationRequest["reviewStatus"],
      reviewDecision: (row.review_decision ?? null) as ConfirmationRequest["reviewDecision"],
      reviewReason: row.review_reason ?? null,
      reviewModel: row.review_model ?? null,
      reviewPolicyVersion: row.review_policy_version ?? null,
      decisionSource: (row.decision_source ?? null) as ConfirmationRequest["decisionSource"],
    };
  }

  // ---------- 工具操作（执行意图 / 已知结果） ----------

  recordToolIntent(input: {
    id: string;
    taskId: string;
    sessionId: string;
    toolName: string;
    sdkCallId?: string | null;
    params: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tool_ops (id, task_id, tool_name, sdk_call_id, params, intent_recorded_at, result_summary, is_error, effect_unknown, recorded_result_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL)`,
      )
      .run(input.id, input.taskId, input.toolName, input.sdkCallId ?? null, JSON.stringify(input.params), new Date().toISOString());
    this.appendEvent(
      {
        type: "task.tool_intent",
        taskId: input.taskId,
        toolOpId: input.id,
        sdkCallId: input.sdkCallId ?? null,
        toolName: input.toolName,
        params: input.params,
      },
      { taskId: input.taskId, sessionId: input.sessionId },
    );
  }

  recordToolResult(toolOpId: string, summary: string, isError: boolean): boolean {
    const info = this.db
      .prepare(
        "UPDATE tool_ops SET result_summary = ?, is_error = ?, recorded_result_at = ? WHERE id = ? AND result_summary IS NULL",
      )
      .run(summary, isError ? 1 : 0, new Date().toISOString(), toolOpId);
    return Number(info.changes) === 1;
  }

  /** 在执行事务内单次登记授权，与授权事件一起提交；失败不得开始操作。 */
  authorizeToolOp(toolOpId: string, sessionId: string, authorization: ToolAuthorization): boolean {
    const info = this.db.prepare(
      "UPDATE tool_ops SET authorization = ? WHERE id = ? AND task_id = ? AND authorization IS NULL AND result_summary IS NULL AND effect_unknown = 0",
    ).run(JSON.stringify(authorization), toolOpId, authorization.taskId);
    if (Number(info.changes) !== 1) return false;
    this.appendEvent({ type: "task.tool_authorized", taskId: authorization.taskId, toolOpId, authorization },
      { taskId: authorization.taskId, sessionId });
    return true;
  }

  getToolOp(id: string): ToolOp | null {
    const row = this.db.prepare("SELECT * FROM tool_ops WHERE id = ?").get(id) as any;
    return row ? Store.rowToToolOp(row) : null;
  }

  private static rowToToolOp(row: any): ToolOp {
    return {
      id: row.id,
      taskId: row.task_id,
      ...(row.mcp ? { mcp: JSON.parse(row.mcp) as import("./types.ts").McpOperation } : {}),
      toolName: row.tool_name,
      sdkCallId: row.sdk_call_id ?? row.id,
      params: JSON.parse(row.params) as Record<string, unknown>,
      intentRecordedAt: row.intent_recorded_at,
      authorization: row.authorization === null ? null : JSON.parse(row.authorization) as ToolAuthorization,
      resultSummary: row.result_summary,
      isError: row.is_error === null ? null : Number(row.is_error) === 1,
      effectUnknown: Number(row.effect_unknown) === 1,
      recordedResultAt: row.recorded_result_at,
    };
  }

  saveMcpOperation(opId: string, value: import("./types.ts").McpOperation): void {
    const op = this.getToolOp(opId), task = op && this.getTask(op.taskId);
    if (!op || !task) throw new Error("MCP 原操作不存在");
    this.db.prepare("UPDATE tool_ops SET mcp = ? WHERE id = ?").run(JSON.stringify(value), opId);
    this.appendEvent({ type: "task.mcp_operation_changed", taskId: task.id, toolOpId: opId, state: value.state }, { taskId: task.id, sessionId: task.sessionId });
  }

  listOpenMcpOperations(includeExecutionId?: string): ToolOp[] {
    return (this.db.prepare(`SELECT op.id, op.task_id, op.tool_name, op.sdk_call_id, op.params, op.intent_recorded_at, op.authorization,
      op.result_summary, op.is_error, op.effect_unknown, op.recorded_result_at, json_remove(op.mcp, '$.request', '$.response') AS mcp
      FROM tool_ops op WHERE op.rowid IN (SELECT MAX(rowid) FROM tool_ops WHERE json_extract(mcp, '$.execution.executionId') IS NOT NULL GROUP BY json_extract(mcp, '$.execution.executionId'))
      AND (json_extract(op.mcp, '$.state') NOT IN ('closed', 'recovered') OR json_extract(op.mcp, '$.execution.executionId') = ?) ORDER BY op.rowid`)
      .all(includeExecutionId ?? null) as any[]).map(Store.rowToToolOp);
  }

  listToolOpsByTask(taskId: string): ToolOp[] {
    const rows = this.db
      .prepare("SELECT * FROM tool_ops WHERE task_id = ? ORDER BY intent_recorded_at, id")
      .all(taskId) as any[];
    return rows.map(Store.rowToToolOp);
  }

  /** 结果缺失且尚未标记的操作；用于中断与重启恢复时计算 effect_unknown。 */
  listUnresolvedToolOps(taskId: string): ToolOp[] {
    return this.listToolOpsByTask(taskId).filter((op) => op.resultSummary === null && !op.effectUnknown);
  }

  /** 全部任务（含终态）中结果缺失且未标记未知效果的操作（重启补记用，架构工单 05）。 */
  listAllUnresolvedToolOps(): ToolOp[] {
    const rows = this.db
      .prepare("SELECT * FROM tool_ops WHERE result_summary IS NULL AND effect_unknown = 0 ORDER BY intent_recorded_at, id")
      .all() as any[];
    return rows.map(Store.rowToToolOp);
  }

  markToolOpEffectUnknown(toolOpId: string): void {
    this.db.prepare("UPDATE tool_ops SET effect_unknown = 1 WHERE id = ?").run(toolOpId);
  }

  /** 指定工具的效果未知操作（issue 10：创建长期授权时提示拥有者先核实的对象；有界）。 */
  listEffectUnknownToolOps(toolName: string, limit = 20): ToolOp[] {
    const rows = this.db
      .prepare("SELECT * FROM tool_ops WHERE tool_name = ? AND effect_unknown = 1 ORDER BY intent_recorded_at, id LIMIT ?")
      .all(toolName, Math.min(Math.max(1, limit), 100)) as any[];
    return rows.map(Store.rowToToolOp);
  }

  // ---------- 工具正文产物 ----------

  createArtifact(input: { id: string; taskId: string; sessionId: string; name: string }): Artifact {
    const artifact: Artifact = {
      id: input.id,
      taskId: input.taskId,
      sessionId: input.sessionId,
      name: input.name,
      byteCount: 0,
      status: "partial",
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO artifacts (id, task_id, session_id, name, byte_count, status, created_at) VALUES (?, ?, ?, ?, 0, 'partial', ?)",
      )
      .run(artifact.id, artifact.taskId, artifact.sessionId, artifact.name, artifact.createdAt);
    return artifact;
  }

  createImageArtifact(input: { id: string; taskId: string; sessionId: string; name: string; mimeType: ImageMimeType; contentHash: string; byteCount: number }): Artifact {
    return this.createImmutableArtifact(input);
  }

  createImmutableArtifact(input: { id: string; taskId: string; sessionId: string; name: string; mimeType: ImageMimeType | null; contentHash: string; byteCount: number }): Artifact {
    this.db.prepare(`INSERT INTO artifacts (id, task_id, session_id, name, byte_count, status, mime_type, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?) ON CONFLICT (id) DO NOTHING`)
      .run(input.id, input.taskId, input.sessionId, input.name, input.byteCount, input.mimeType, input.contentHash, new Date().toISOString());
    const artifact = this.getArtifact(input.id)!;
    if (artifact.taskId !== input.taskId || artifact.sessionId !== input.sessionId || artifact.name !== input.name || artifact.contentHash !== input.contentHash || artifact.mimeType !== input.mimeType || artifact.byteCount !== input.byteCount) {
      throw new Error("不可变产物归属或内容不一致");
    }
    return artifact;
  }

  /** 追加捕获字节数（元数据；正文写在产物文件里，SQLite 不复制内容）。 */
  addArtifactBytes(id: string, bytes: number): void {
    this.db.prepare("UPDATE artifacts SET byte_count = byte_count + ? WHERE id = ?").run(bytes, id);
  }

  setArtifactStatus(id: string, status: "complete" | "partial"): void {
    this.db.prepare("UPDATE artifacts SET status = ? WHERE id = ?").run(status, id);
  }

  getArtifact(id: string): Artifact | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as any;
    return row ? this.rowToArtifact(row) : null;
  }

  listArtifactsByTask(taskId: string): Artifact[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at, id")
      .all(taskId) as any[];
    return rows.map(this.rowToArtifact);
  }

  private rowToArtifact(row: any): Artifact {
    return {
      id: row.id,
      taskId: row.task_id,
      sessionId: row.session_id,
      name: row.name,
      byteCount: Number(row.byte_count),
      status: row.status as "complete" | "partial",
      mimeType: row.mime_type ?? null,
      contentHash: row.content_hash ?? null,
      createdAt: row.created_at,
    };
  }

  // ---------- 目录占用 ----------

  /**
   * 尝试占用目录（agent-direction issue 16：冲突判定升级为祖先/子孙）。
   * 冲突 = dev+ino 相等（同一目录的符号链接、挂载别名都会命中）、realpath 相等，
   * 按分隔符边界互为前缀（祖先/子孙）。被占用时返回 false，不抛出。
   * ponytail：挂载别名（bind mount 后 realpath 不同但 dev/ino 相同的别名目录）
   * 的祖先/子孙关系识别不出——别名的父目录与本目录 dev/ino 不同，前缀也不含；
   * 这类拓扑下嵌套 cwd 仍可能并行，需要在边界层另补识别。
   */
  tryAcquireOccupancy(input: {
    cwdReal: string;
    cwdDev: number;
    cwdIno: number;
    sessionId: string;
    taskId: string;
  }): boolean {
    const rows = this.db.prepare("SELECT cwd_real, cwd_dev, cwd_ino FROM occupancy").all() as Array<{ cwd_real: string; cwd_dev: number | bigint; cwd_ino: number | bigint }>;
    const rowsTyped = rows.map((r) => ({ cwdReal: r.cwd_real, cwdDev: Number(r.cwd_dev), cwdIno: Number(r.cwd_ino) }));
    if (rowsTyped.some((r) => occupancyConflict(input, r))) return false;
    this.db
      .prepare(
        "INSERT INTO occupancy (cwd_real, cwd_dev, cwd_ino, session_id, task_id, acquired_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.cwdReal,
        input.cwdDev,
        input.cwdIno,
        input.sessionId,
        input.taskId,
        new Date().toISOString(),
      );
    return true;
  }

  /** 释放任务持有的全部目录占用；重复释放返回 false。 */
  releaseOccupancy(taskId: string): boolean {
    const info = this.db.prepare("DELETE FROM occupancy WHERE task_id = ?").run(taskId);
    return Number(info.changes) > 0;
  }

  /** 临时执行已核实退出后只释放副本；父目录及其他未核实副本仍由任务持有。 */
  // Note: 见 .agents/notes/implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md
  releaseOccupancyForDir(taskId: string, cwdReal: string): boolean {
    const info = this.db.prepare("DELETE FROM occupancy WHERE task_id = ? AND cwd_real = ?").run(taskId, cwdReal);
    return Number(info.changes) > 0;
  }

  /** 单条占用（写入目标键/父写入根的持有者查询；subagent_result 提示由它判定）。 */
  getOccupancyByDir(cwdReal: string): (OccupancyHolder & { sessionId: string }) | null {
    const row = this.db
      .prepare("SELECT task_id, process_id, session_id FROM occupancy WHERE cwd_real = ?")
      .get(cwdReal) as any;
    return row ? { ...this.occupancyHolder(row), sessionId: row.session_id } : null;
  }

  /**
   * 谁挡了目标目录（agent-direction issue 16，subagent_result 提示用）：
   * 与目前任何一条占用取/放同一冲突判定（dev/ino、realpath、分隔符前缀）。
   * 返回最早挡住它的持有者（cwd_real 是占用记录，不是请求匹配目录）。
   */
  findBlockingOccupancy(cwdReal: string, dev: number, ino: number): (OccupancyHolder & { sessionId: string; cwdReal: string }) | null {
    const rows = this.db.prepare("SELECT cwd_real, cwd_dev, cwd_ino, session_id, task_id, process_id FROM occupancy ORDER BY acquired_at, rowid LIMIT 1000").all() as Array<{ cwd_real: string; cwd_dev: number | bigint; cwd_ino: number | bigint; session_id: string; task_id: string | null; process_id: string | null }>;
    for (const row of rows) {
      const other = { cwdReal: row.cwd_real, cwdDev: Number(row.cwd_dev), cwdIno: Number(row.cwd_ino) };
      if (occupancyConflict({ cwdReal, cwdDev: dev, cwdIno: ino }, other)) {
        return { ...this.occupancyHolder(row), sessionId: row.session_id, cwdReal: row.cwd_real };
      }
    }
    return null;
  }

  /** 全部占用（崩溃恢复时核对：旧执行是否确认停止，未确认前保留）。 */
  listAllOccupancy(): Occupancy[] {
    const rows = this.db.prepare("SELECT * FROM occupancy").all() as any[];
    return rows.map((row) => ({
      cwdReal: row.cwd_real,
      cwdDev: Number(row.cwd_dev),
      cwdIno: Number(row.cwd_ino),
      ...this.occupancyHolder(row),
      sessionId: row.session_id,
    }));
  }

  private occupancyHolder(row: { task_id: string | null; process_id: string | null }): OccupancyHolder {
    return row.task_id === null ? { taskId: null, processId: row.process_id! } : { taskId: row.task_id };
  }

  // ---------- 事件读取（快照与补发） ----------

  getMaxSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS max FROM events").get() as {
      max: number;
    };
    return Number(row.max);
  }

  /** The original owner-input admission sequence, retained across derived execution. */
  getTaskInputSeq(task: Pick<Task, "id">): number | null {
    const row = this.db.prepare("SELECT MIN(seq) AS seq FROM events WHERE task_id = ? AND json_extract(body, '$.type') = 'task.queued'").get(task.id);
    const seq = (row as { seq: number | null }).seq;
    return seq === null ? null : Number(seq);
  }

  getEventsAfter(seq: number, limit = 1000): PersistentEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(seq, limit) as any[];
    return rows.map((row) => ({
      seq: Number(row.seq),
      taskId: row.task_id,
      sessionId: row.session_id,
      body: JSON.parse(row.body) as PersistentEventBody,
      createdAt: row.created_at,
    }));
  }

  /** 仅读取目标任务的事件；全局 seq 仍作为稳定的键集分页游标。 */
  getTaskEventsAfter(taskId: string, seq: number, limit: number): PersistentEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(taskId, seq, limit) as any[];
    return rows.map((row) => ({
      seq: Number(row.seq), taskId: row.task_id, sessionId: row.session_id,
      body: JSON.parse(row.body) as PersistentEventBody, createdAt: row.created_at,
    }));
  }

  taskAttachments(taskId: string): AttachmentReference[] {
    const rows = this.db.prepare("SELECT body FROM events WHERE task_id = ? AND json_extract(body, '$.type') = 'task.attachments' ORDER BY seq").all(taskId) as { body: string }[];
    if (rows.length > 1) throw new Error("附件来源事件重复");
    return rows.length ? (JSON.parse(rows[0].body) as Extract<PersistentEventBody, { type: "task.attachments" }>).attachments : [];
  }

  /** 任务最新一条输出片段事件（重连预览重建的持久来源）。 */
  getLatestOutputFragment(taskId: string): {
    seq: number;
    messageId: string;
    text: string;
    totalBytes: number;
    truncated: boolean;
  } | null {
    const row = this.db
      .prepare(
        `SELECT seq, body FROM events
         WHERE task_id = ? AND json_extract(body, '$.type') = 'task.output_fragment'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(taskId) as any;
    if (!row) return null;
    const body = JSON.parse(row.body) as Extract<PersistentEventBody, { type: "task.output_fragment" }>;
    let text = body.text;
    let totalBytes = body.totalBytes;
    if (body.offset !== undefined) {
      let expected = body.offset;
      let index = body.contentIndex ?? 0;
      if (body.contentIndex !== undefined) {
        const sum = this.db.prepare(`SELECT SUM(json_extract(body, '$.totalBytes')) AS total FROM events WHERE seq IN (
          SELECT MAX(seq) FROM events WHERE task_id = ? AND json_extract(body, '$.type') = 'task.output_fragment'
          AND json_extract(body, '$.messageId') = ? GROUP BY json_extract(body, '$.contentIndex')
        )`).get(taskId, body.messageId) as { total: number };
        totalBytes = Number(sum.total);
      }
      let bytes = Buffer.byteLength(text, "utf8");
      const previous = this.db.prepare(`SELECT body FROM events WHERE task_id = ? AND seq < ?
        AND json_extract(body, '$.type') = 'task.output_fragment'
        AND json_extract(body, '$.messageId') = ? ORDER BY seq DESC`).iterate(taskId, row.seq, body.messageId);
      for (const item of previous) {
        if (bytes >= FRAGMENT_TEXT_CAP || (expected === 0 && index === 0)) break;
        const part = JSON.parse((item as { body: string }).body) as Extract<PersistentEventBody, { type: "task.output_fragment" }>;
        const length = Buffer.byteLength(part.text, "utf8");
        if (part.offset === undefined) break;
        const previousIndex = part.contentIndex ?? 0;
        if (previousIndex === index) {
          if (part.offset + length !== expected) break;
        } else if (previousIndex !== index - 1 || expected !== 0) break;
        text = part.text + text;
        bytes += length;
        expected = part.offset;
        index = previousIndex;
      }
      text = tailTextByBytes(text, FRAGMENT_TEXT_CAP).text;
    }
    return {
      seq: Number(row.seq),
      messageId: body.messageId,
      text,
      totalBytes,
      truncated: body.truncated || Buffer.byteLength(text, "utf8") < totalBytes,
    };
  }

  /** 指定消息标识是否已有最终条目事件（预览是否已被正式条目取代）。 */
  hasOutputEntryForMessage(taskId: string, messageId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM events
         WHERE task_id = ? AND json_extract(body, '$.type') = 'task.output_entry'
           AND json_extract(body, '$.messageId') = ?
         LIMIT 1`,
      )
      .get(taskId, messageId);
    return row !== undefined;
  }

  /** 按 会话 + request_id 精确查询任务（重连幂等核实用；含已结束任务）。 */
  findTaskByRequest(sessionId: string, requestId: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND request_id = ?")
      .get(sessionId, requestId) as any;
    return row ? this.rowToTask(row) : null;
  }

  /**
   * 会话内任务的分页查询（新 → 旧，键集分页）。
   * before 为上一页最后一条任务的 id；返回 hasMore 表示还有更旧任务。
   */
  listTasksBySessionPaged(
    sessionId: string,
    opts: { before?: string; limit?: number } = {},
  ): { tasks: Task[]; hasMore: boolean } {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    let rows: any[];
    if (opts.before !== undefined) {
      const cursor = this.getTask(opts.before);
      if (!cursor || cursor.sessionId !== sessionId) {
        throw new StoreConflictError(`分页游标任务不存在：${opts.before}`, "invalid_cursor");
      }
      rows = this.db
        .prepare(
          `SELECT * FROM tasks WHERE session_id = ?
           AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(sessionId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1) as any[];
    } else {
      rows = this.db
        .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(sessionId, limit + 1) as any[];
    }
    const hasMore = rows.length > limit;
    return { tasks: rows.slice(0, limit).map((r) => this.rowToTask(r)), hasMore };
  }

  // ---------- 上下文选择记录（issue 05 §6） ----------

  insertSelectionRecord(record: Omit<SelectionRecord, "usage">): void {
    this.db
      .prepare(
        `INSERT INTO selection_records
         (id, task_id, session_id, call_index, strategy, config_version, model, total_messages,
          included_indices, excluded, included_memories, excluded_memories, instruction_version,
          skill_version, capped_tool_results, estimates, budget, estimated_total, usage, window_snapshot, experiment, checkpoint_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.taskId,
        record.sessionId,
        record.callIndex,
        record.strategy,
        record.configVersion,
        record.model,
        record.totalMessages,
        JSON.stringify(record.includedIndices),
        JSON.stringify(record.excluded),
        JSON.stringify(record.includedMemories),
        JSON.stringify(record.excludedMemories),
        record.instructionVersion,
        record.skillVersion ?? "",
        JSON.stringify(record.cappedToolResults),
        JSON.stringify(record.estimates),
        record.budget,
        record.estimatedTotal,
        record.windowSnapshot ? JSON.stringify(record.windowSnapshot) : null,
        record.experiment ? JSON.stringify(record.experiment) : null,
        record.checkpointId ?? null,
        record.createdAt,
      );
  }

  /** 发送后补记实际 provider usage（估算偏差分析用）。 */
  setSelectionRecordUsage(id: string, usage: NonNullable<SelectionRecord["usage"]>): void {
    const row = this.db.prepare("UPDATE selection_records SET usage = ? WHERE id = ? RETURNING session_id")
      .get(JSON.stringify(usage), id) as { session_id: string } | undefined;
    if (row) this.appendEvent({ type: "session.usage_updated", sessionId: row.session_id }, { sessionId: row.session_id });
  }

  /** 会话累计的实际 provider token 用量；未回传 usage 的调用不计入。 */
  getSessionUsage(sessionId: string): { input: number; output: number } {
    const row = this.db.prepare(`SELECT
      COALESCE(SUM(COALESCE(json_extract(usage, '$.input'), 0)
        + COALESCE(json_extract(usage, '$.cacheRead'), 0)
        + COALESCE(json_extract(usage, '$.cacheWrite'), 0)), 0) AS input,
      COALESCE(SUM(json_extract(usage, '$.output')), 0) AS output
      FROM selection_records WHERE session_id = ? AND usage IS NOT NULL`)
      .get(sessionId) as { input: number; output: number };
    return { input: Number(row.input), output: Number(row.output) };
  }

  /** 关联发送前捕获的输入快照产物（issue 13；与记录同事务写入）。 */
  setSelectionRecordPromptArtifact(id: string, artifactId: string | null): void {
    this.db.prepare("UPDATE selection_records SET prompt_artifact = ? WHERE id = ?").run(artifactId, id);
  }

  getSelectionRecord(id: string): SelectionRecord | null {
    const row = this.db.prepare("SELECT * FROM selection_records WHERE id = ?").get(id) as any;
    return row ? rowToSelectionRecord(row) : null;
  }

  listSelectionRecordsByTask(taskId: string, limit?: number): SelectionRecord[] {
    const cap = Math.min(Math.max(1, limit ?? 200), 1000);
    const rows = this.db
      .prepare("SELECT * FROM selection_records WHERE task_id = ? ORDER BY call_index LIMIT ?")
      .all(taskId, cap) as any[];
    return rows.map(rowToSelectionRecord);
  }

  /** 会话维度的选择记录（新 → 旧；审计入口分页）。 */
  listSelectionRecordsBySession(sessionId: string, limit?: number): SelectionRecord[] {
    const cap = Math.min(Math.max(1, limit ?? 100), 1000);
    const rows = this.db
      .prepare("SELECT * FROM selection_records WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(sessionId, cap) as any[];
    return rows.map(rowToSelectionRecord);
  }

  /** 会话维度游标分页（新 → 旧；游标 = 上一页最后一条的 createdAt/id）。 */
  listSelectionRecordsPage(
    sessionId: string,
    limit: number,
    cursor?: { createdAt: string; id: string },
  ): { records: SelectionRecord[]; hasMore: boolean } {
    const cap = Math.min(Math.max(1, limit), 200);
    const rows = (
      cursor
        ? this.db
            .prepare(
              `SELECT * FROM selection_records
               WHERE session_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
               ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .all(sessionId, cursor.createdAt, cursor.createdAt, cursor.id, cap + 1)
        : this.db
            .prepare(
              `SELECT * FROM selection_records WHERE session_id = ?
               ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .all(sessionId, cap + 1)
    ) as any[];
    return { records: rows.slice(0, cap).map(rowToSelectionRecord), hasMore: rows.length > cap };
  }

  /** 任务内已有的选择记录数（下一次调用的 callIndex = 数量 + 1）。 */
  countSelectionRecords(taskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM selection_records WHERE task_id = ?")
      .get(taskId) as any;
    return Number(row.n);
  }

  // ---------- 上下文压缩点（issue 30） ----------

  getActiveCheckpoint(sessionId: string): ContextCheckpoint | null {
    const row = this.db.prepare("SELECT * FROM context_checkpoints WHERE session_id = ? AND status = 'active'").get(sessionId) as any;
    return row ? rowToCheckpoint(row) : null;
  }

  getCheckpoint(id: string): ContextCheckpoint | null {
    const row = this.db.prepare("SELECT * FROM context_checkpoints WHERE id = ?").get(id) as any;
    return row ? rowToCheckpoint(row) : null;
  }

  /** 新建压缩点（调用方在事务内）：旧的 active 行先改为 superseded。 */
  insertCheckpoint(cp: Omit<ContextCheckpoint, "status">): void {
    this.db.prepare("UPDATE context_checkpoints SET status = 'superseded' WHERE session_id = ? AND status = 'active'").run(cp.sessionId);
    this.db
      .prepare(
        `INSERT INTO context_checkpoints
         (id, session_id, status, summarized_count, cleared_count, fingerprint, summary, summary_until, cleared_refs,
          cleared_results, summary_model, summary_status, summary_error, prompt_version, usage, estimate_before,
          estimate_after, task_id, call_index, manual_request_id, created_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cp.id, cp.sessionId, cp.summarizedCount, cp.clearedCount, cp.fingerprint, cp.summary, cp.summaryUntil,
        JSON.stringify(cp.clearedRefs), cp.clearedResults, cp.summaryModel, cp.summaryStatus, cp.summaryError,
        cp.promptVersion, cp.usage ? JSON.stringify(cp.usage) : null, cp.estimateBefore, cp.estimateAfter,
        cp.taskId, cp.callIndex, cp.manualRequestId ?? null, cp.createdAt,
      );
  }

  /** 指纹不符或消息不足：压缩点作废，按无压缩点处理。 */
  invalidateCheckpoint(id: string): void {
    this.db.prepare("UPDATE context_checkpoints SET status = 'invalidated' WHERE id = ? AND status = 'active'").run(id);
  }

}

function rowToSelectionRecord(row: any): SelectionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    callIndex: Number(row.call_index),
    strategy: row.strategy,
    configVersion: Number(row.config_version),
    model: row.model,
    totalMessages: Number(row.total_messages),
    includedIndices: JSON.parse(row.included_indices) as number[],
    excluded: JSON.parse(row.excluded) as Array<{ index: number; reason: string }>,
    includedMemories: JSON.parse(row.included_memories) as Array<{ memoryId: string; version: number }>,
    excludedMemories: JSON.parse(row.excluded_memories) as Array<{ memoryId: string; version: number; reason: string }>,
    instructionVersion: row.instruction_version ?? "",
    skillVersion: row.skill_version ?? "",
    cappedToolResults: JSON.parse(row.capped_tool_results ?? "[]") as Array<{
      index: number;
      originalChars: number;
      viewChars: number;
    }>,
    estimates: JSON.parse(row.estimates) as Record<string, number>,
    budget: Number(row.budget),
    estimatedTotal: Number(row.estimated_total),
    usage: row.usage ? (JSON.parse(row.usage) as SelectionRecord["usage"]) : null,
    experiment: row.experiment ? (JSON.parse(row.experiment) as SelectionRecord["experiment"]) : null,
    promptArtifactId: (row.prompt_artifact as string | null) ?? null,
    windowSnapshot: row.window_snapshot ? (JSON.parse(row.window_snapshot) as SelectionRecord["windowSnapshot"]) : null,
    checkpointId: (row.checkpoint_id as string | null) ?? null,
    createdAt: row.created_at,
  };
}

function rowToCheckpoint(row: any): ContextCheckpoint {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    summarizedCount: Number(row.summarized_count),
    clearedCount: Number(row.cleared_count),
    fingerprint: row.fingerprint,
    summary: row.summary ?? null,
    summaryUntil: row.summary_until ?? null,
    clearedRefs: JSON.parse(row.cleared_refs) as Record<string, string | null>,
    clearedResults: Number(row.cleared_results),
    summaryModel: row.summary_model ?? null,
    summaryStatus: row.summary_status,
    summaryError: row.summary_error ?? null,
    promptVersion: row.prompt_version,
    usage: row.usage ? (JSON.parse(row.usage) as Record<string, unknown>) : null,
    estimateBefore: Number(row.estimate_before),
    estimateAfter: Number(row.estimate_after),
    taskId: row.task_id ?? null,
    callIndex: row.call_index === null ? null : Number(row.call_index),
    manualRequestId: row.manual_request_id ?? null,
    createdAt: row.created_at,
  };
}

export class StoreConflictError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** 创建幂等键唯一索引冲突（issue 21 兜底路径；node:sqlite 报 <表>.<列>）。 */
function isCreateRequestIdClash(err: unknown, table: string): boolean {
  return err instanceof Error && err.message.includes(`UNIQUE constraint failed: ${table}.create_request_id`);
}

/** 工作区根目录部分唯一索引冲突（issue 05 兜底路径；node:sqlite 报 <表>.<列>）。 */
function isRootDirClash(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE constraint failed: projects.root_real");
}
