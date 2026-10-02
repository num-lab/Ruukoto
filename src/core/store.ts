/**
 * 元数据访问层：在 node:sqlite 之上的类型化读写与条件状态转换。
 *
 * 不变量在事务内成立（withTx）：
 * - 任务状态转换用条件更新（WHERE status IN ...），取消与自然完成竞争时
 *   只有一个终态生效。
 * - 目录占用以 dev+ino 为主碰撞键（覆盖符号链接与挂载别名），路径仅作记录。
 * - 持久事件与引发它的状态变更同事务写入；事务提交成功后才对外广播。
 */

import type { Db } from "./db.ts";
import {
  ACTIVE_TASK_STATUSES,
  isTerminalTaskStatus,
  type AccessMode,
  type AcceptedChatResult,
  type AgentRole,
  type AgentRoleId,
  type ApprovalScope,
  type Artifact,
  type ConfirmationRequest,
  type ConfirmationStatus,
  type ContextCheckpoint,
  type GrantedPath,
  type InboundEvent,
  type InboundEventStatus,
  type ModelSelection,
  type NotifyTarget,
  type PersistentEvent,
  type PersistentEventBody,
  type Project,
  type SelectionRecord,
  type Session,
  type SessionDefaultMode,
  type SessionKind,
  type Task,
  type TaskStatus,
  type ToolCategory,
  type ToolOp,
  randomId,
} from "./types.ts";

import { tailTextByBytes } from "./history.ts";
import { FRAGMENT_TEXT_CAP } from "./views.ts";
import { sameDirIdentity, type DirIdentity } from "./dir-identity.ts";

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
  ): void {
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
  }

  // ---------- 项目 ----------

  /**
   * 创建项目（可选幂等，issue 21）。携带 createRequestId 时：同键同名返回
   * 已存在项目（不重复插入、不产生事件）；同键异名抛 request_conflict。
   * 查找与插入由调用方事务包住（node:sqlite 同步、单进程），唯一索引作兜底：
   * 插入冲突时按幂等键重取核实，核实不过按冲突处理。
   */
  createProject(name: string, createRequestId?: string | null, rootDir?: DirIdentity | null): Project {
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
    const project: Project = { id: randomId("proj"), name, createRequestId: createRequestId ?? null, rootDir: rootDir ?? null, instructionFiles: [], webSearch: "enabled", createdAt: new Date().toISOString() };
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
      // 根目录部分唯一索引兜底（idx_projects_root_real 只含非 NULL 行）
      if (isRootDirClash(err)) {
        throw new StoreConflictError(`工作区已存在：${rootDir?.cwdReal}`, "duplicate");
      }
      throw err;
    }
    this.appendEvent({ type: "project.created", projectId: project.id, name: project.name, createRequestId: project.createRequestId, rootDir: project.rootDir });
    return project;
  }

  /** 按根目录身份找已归属的工作区（realpath 或 dev+ino 相同；issue 05）。 */
  findProjectByRoot(identity: DirIdentity): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE root_real = ? OR (root_dev = ? AND root_ino = ?) ORDER BY created_at, rowid LIMIT 1")
      .get(identity.cwdReal, identity.dev, identity.ino) as any;
    return row ? this.rowToProject(row) : null;
  }

  /**
   * 旧项目认领工作区根目录（issue 05）：仅当项目尚无归属时落库并发
   * project.root_attached 事件；已有相同归属幂等返回，已有不同归属报冲突。
   */
  attachProjectRoot(projectId: string, identity: DirIdentity): void {
    try {
      const info = this.db
        .prepare("UPDATE projects SET root_cwd = ?, root_real = ?, root_dev = ?, root_ino = ? WHERE id = ? AND root_real IS NULL")
        .run(identity.cwd, identity.cwdReal, identity.dev, identity.ino, projectId);
      if (Number(info.changes) > 0) {
        this.appendEvent({ type: "project.root_attached", projectId, rootDir: identity });
        return;
      }
    } catch (err) {
      if (isRootDirClash(err)) {
        throw new StoreConflictError(`工作区已存在：${identity.cwdReal}`, "duplicate");
      }
      throw err;
    }
    const existing = this.getProject(projectId);
    if (!existing) throw new StoreConflictError(`项目不存在：${projectId}`, "not_found");
    if (existing.rootDir && sameDirIdentity(existing.rootDir, identity)) return;
    throw new StoreConflictError(`项目已归属其他工作区目录：${existing.rootDir?.cwdReal ?? projectId}`, "duplicate");
  }

  /** 按创建幂等键查询项目（issue 21 去重与重连核实共用）。 */
  findProjectByCreateRequestId(requestId: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE create_request_id = ?").get(requestId) as any;
    return row ? this.rowToProject(row) : null;
  }

  /** 设置项目指令文件列表（工作区相对路径；拥有者入口，调用方负责校验）。 */
  setProjectInstructionFiles(projectId: string, files: string[]): void {
    this.db
      .prepare("UPDATE projects SET instruction_files = ? WHERE id = ?")
      .run(JSON.stringify(files), projectId);
  }

  /** 按项目启用/禁用 Web Search（issue 20；拥有者入口，调用方负责校验）。 */
  setProjectWebSearch(projectId: string, value: "enabled" | "disabled"): void {
    this.db.prepare("UPDATE projects SET web_search = ? WHERE id = ?").run(value, projectId);
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
      instructionFiles: JSON.parse(row.instruction_files ?? "[]") as string[],
      webSearch: row.web_search === "disabled" ? "disabled" : "enabled",
      createdAt: row.created_at,
    };
  }

  // ---------- 会话 ----------

  /**
   * 创建会话（可选幂等，issue 21）。携带 createRequestId 时：同键同参
   * （项目 + cwdReal + confirmTools）返回已存在会话；同键异参抛
   * request_conflict。唯一索引作兜底（冲突时重取核实）。
   */
  createSession(input: {
    projectId: string;
    kind?: SessionKind;
    cwd: string;
    cwdReal: string;
    cwdDev: number;
    cwdIno: number;
    piSessionId: string;
    sessionFile?: string | null;
    confirmTools: string[];
    modelSelection?: ModelSelection | null;
    /** 创建幂等键（issue 21；null/缺省 = 不去重，每次插入新会话）。 */
    createRequestId?: string | null;
  }): Session {
    if (input.createRequestId) {
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
    const session: Session = {
      id: randomId("sess"),
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
      defaultAccessMode: "confirm",
      defaultAccessModeVersion: 0,
      queueState: "active",
      queuePauseReason: null,
      createdAt: new Date().toISOString(),
    };
    try {
      this.db
        .prepare(
          `INSERT INTO sessions (id, project_id, kind, cwd, cwd_real, cwd_dev, cwd_ino, pi_session_id,
           session_file, confirm_tools, create_request_id, queue_state, queue_pause_reason, created_at, model_selection, model_selection_version,
           default_access_mode, default_access_mode_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, 'confirm', 0)`,
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
      { type: "session.created", sessionId: session.id, projectId: session.projectId, kind: session.kind, cwd: session.cwd, modelSelection: session.modelSelection, modelSelectionVersion: session.modelSelectionVersion, createRequestId: session.createRequestId },
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
    return this.db.prepare(`
      WITH event_activity AS (
        SELECT t.session_id, MAX(e.created_at) AS last_at
        FROM events e JOIN tasks t ON t.id = e.task_id
        JOIN sessions s ON s.id = t.session_id
        WHERE s.project_id = ? GROUP BY t.session_id
      )
      SELECT s.id AS sessionId,
        (SELECT substr(t.input, 1, 512) FROM tasks t
         WHERE t.session_id = s.id AND t.parent_task_id IS NULL
         ORDER BY t.created_at, t.rowid LIMIT 1) AS name,
        MAX(s.created_at, COALESCE(e.last_at, s.created_at),
          COALESCE((SELECT MAX(MAX(t.created_at, COALESCE(t.started_at, t.created_at),
            COALESCE(t.ended_at, t.created_at))) FROM tasks t WHERE t.session_id = s.id), s.created_at)) AS lastActiveAt
      FROM sessions s LEFT JOIN event_activity e ON e.session_id = s.id
      WHERE s.project_id = ? ORDER BY s.created_at, s.rowid
    `).all(projectId, projectId) as Array<{ sessionId: string; name: string | null; lastActiveAt: string }>;
  }

  setSessionFile(id: string, file: string): void {
    this.db.prepare("UPDATE sessions SET session_file = ? WHERE id = ?").run(file, id);
  }

  setSessionQueueState(id: string, state: "active" | "paused", reason: string | null): void {
    this.db
      .prepare("UPDATE sessions SET queue_state = ?, queue_pause_reason = ? WHERE id = ?")
      .run(state, reason, id);
  }

  /** 调用方在事务中执行；启动默认值仅初始化没有记录的旧会话。 */
  initializeSessionModelSelections(selection: ModelSelection): void {
    for (const session of this.listSessions()) {
      if (session.modelSelection === null) this.setSessionModel(session.id, selection, session.modelSelectionVersion);
    }
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

  countLegacyQueuedTasks(sessionId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE session_id = ? AND status = 'queued' AND model_selection IS NULL").get(sessionId) as { n: number };
    return Number(row.n);
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

  /** 与占用检查和恢复队列共享调用方事务；旧任务摘要仍为空，不伪造原始权限。 */
  fillLegacyQueuedModelSelections(sessionId: string, selection: ModelSelection): void {
    const rows = this.db.prepare("SELECT id FROM tasks WHERE session_id = ? AND status = 'queued' AND model_selection IS NULL ORDER BY created_at, id").all(sessionId) as Array<{ id: string }>;
    const encoded = JSON.stringify(selection);
    let taskIds: string[] = [];
    let bytes = Buffer.byteLength(encoded) + Buffer.byteLength(sessionId) + 256;
    const flush = (): void => {
      if (taskIds.length) this.appendEvent({ type: "tasks.model_selection_recorded", sessionId, taskIds, modelSelection: selection }, { sessionId });
      taskIds = [];
      bytes = Buffer.byteLength(encoded) + Buffer.byteLength(sessionId) + 256;
    };
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(row.id)) + 1;
      if (bytes + size > 32 * 1024) flush();
      this.db.prepare("UPDATE tasks SET model_selection = ? WHERE id = ? AND model_selection IS NULL").run(encoded, row.id);
      taskIds.push(row.id);
      bytes += size;
    }
    flush();
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      projectId: row.project_id,
      kind: row.kind === "qq_group" ? "qq_group" : "dev",
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
    grantedPaths?: GrantedPath[];
    resumesTaskId?: string | null;
    modelSelection: ModelSelection;
    submissionDigest: string;
    /** 旧格式摘要（升级兼容；见 findMatchingSubmission）。 */
    legacyDigest?: string;
    /** 编排字段（issue 01）：仅编排器提交时携带；控制面提交恒为 null。 */
    agentId?: AgentRoleId | null;
    parentTaskId?: string | null;
    sourceEventId?: string | null;
    deadline?: string | null;
  }): { task: Task; duplicate: boolean } {
    const accessMode = input.accessMode ?? "confirm";
    const grantedPaths = input.grantedPaths ?? [];
    const existing = this.findMatchingSubmission(input);
    if (existing) return { task: existing, duplicate: true };
    const task: Task = {
      id: randomId("task"),
      sessionId: input.sessionId,
      requestId: input.requestId,
      input: input.input,
      modelSelection: input.modelSelection,
      submissionDigest: input.submissionDigest,
      status: "queued",
      accessMode,
      permissionVersion: 1,
      grantedPaths,
      pendingAccessMode: null,
      interruptReason: null,
      cancelRequested: false,
      effectUnknown: false,
      errorMessage: null,
      historyEntryIds: [],
      resumesTaskId: input.resumesTaskId ?? null,
      agentId: input.agentId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      sourceEventId: input.sourceEventId ?? null,
      deadline: input.deadline ?? null,
      resultSummary: null,
      resultRef: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, session_id, request_id, input, status, access_mode, permission_version,
         granted_paths, pending_access_mode, interrupt_reason,
         cancel_requested, effect_unknown, error_message, history_entry_ids, resumes_task_id,
         created_at, started_at, ended_at, model_selection, submission_digest,
         agent_id, parent_task_id, source_event_id, deadline, result_summary, result_ref)
         VALUES (?, ?, ?, ?, 'queued', ?, 1, ?, NULL, NULL, 0, 0, NULL, '[]', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        task.id,
        task.sessionId,
        task.requestId,
        task.input,
        task.accessMode,
        JSON.stringify(task.grantedPaths),
        task.resumesTaskId,
        task.createdAt,
        JSON.stringify(task.modelSelection),
        task.submissionDigest,
        task.agentId,
        task.parentTaskId,
        task.sourceEventId,
        task.deadline,
      );
    this.appendEvent(
      {
        type: "task.queued",
        taskId: task.id,
        sessionId: task.sessionId,
        requestId: task.requestId,
        accessMode: task.accessMode,
        modelSelection: input.modelSelection,
      },
      { taskId: task.id, sessionId: task.sessionId },
    );
    if (task.resumesTaskId) {
      this.appendEvent(
        { type: "task.continued", taskId: task.id, sessionId: task.sessionId, resumesTaskId: task.resumesTaskId },
        { taskId: task.id, sessionId: task.sessionId },
      );
    }
    return { task, duplicate: false };
  }

  /** 在异步模型检查之前核实；同一检查也在入队事务内重复，仲裁并发提交。 */
  findMatchingSubmission(input: {
    sessionId: string;
    requestId: string;
    submissionDigest: string;
    /** 升级前的旧格式摘要（schema v11 前，无编排字段）；仅全空编排字段的提交提供。 */
    legacyDigest?: string;
  }): Task | null {
    const task = this.findTaskByRequest(input.sessionId, input.requestId);
    if (!task) return null;
    const matched =
      task.submissionDigest === input.submissionDigest ||
      (input.legacyDigest !== undefined && task.submissionDigest === input.legacyDigest);
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
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND status = 'queued' ORDER BY created_at, rowid")
      .all(sessionId) as any[];
    return rows.map((r) => this.rowToTask(r));
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
    if (changed && isTerminalTaskStatus(to)) {
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
      accessMode: (row.access_mode ?? "confirm") as AccessMode,
      permissionVersion: Number(row.permission_version ?? 1),
      grantedPaths: JSON.parse(row.granted_paths ?? "[]") as GrantedPath[],
      pendingAccessMode: (row.pending_access_mode ?? null) as AccessMode | null,
      interruptReason: row.interrupt_reason,
      cancelRequested: Number(row.cancel_requested) === 1,
      effectUnknown: Number(row.effect_unknown) === 1,
      errorMessage: row.error_message,
      historyEntryIds: JSON.parse(row.history_entry_ids) as string[],
      resumesTaskId: row.resumes_task_id,
      agentId: (row.agent_id ?? null) as AgentRoleId | null,
      parentTaskId: row.parent_task_id ?? null,
      sourceEventId: row.source_event_id ?? null,
      deadline: row.deadline ?? null,
      resultSummary: row.result_summary ?? null,
      resultRef: row.result_ref ?? null,
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

  /** 父任务已发起的委派数（issue 05 委派上限；自动重试 `:retry` 不计入）。 */
  countDelegations(parentTaskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ? AND request_id LIKE 'deleg:%' AND request_id NOT LIKE '%:retry'")
      .get(parentTaskId) as any;
    return Number(row.n);
  }

  /** 已到终态但结果尚未记录的角色任务（启动巡检补记结果与事件）。 */
  listRoleTasksPendingResult(): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE agent_id IS NOT NULL AND result_summary IS NULL AND status IN ('completed','failed','canceled','interrupted') ORDER BY created_at, id",
      )
      .all() as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * 终态、结果已记录、但父会话中尚无对应唤醒任务的角色子任务（唤醒投递的
   * 持久核对）：唤醒任务的请求键 wake:<childId> 即投递记录——结果已落库而
   * 唤醒缺失（提交失败或崩溃窗口）时，启动巡检按原幂等键补发。
   */
  listRoleTasksPendingWake(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t JOIN tasks p ON p.id = t.parent_task_id
         WHERE t.agent_id IS NOT NULL AND t.parent_task_id IS NOT NULL AND t.result_summary IS NOT NULL
           AND t.status IN ('completed','failed','canceled','interrupted')
           AND NOT EXISTS (SELECT 1 FROM tasks w WHERE w.session_id = p.session_id AND w.request_id = 'wake:' || t.id)
           AND NOT EXISTS (SELECT 1 FROM tasks r WHERE r.parent_task_id = t.parent_task_id AND r.request_id = t.request_id || ':retry')
         ORDER BY t.created_at, t.id`,
      )
      .all() as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  // ---------- 逻辑角色（issue 01；宿主管理） ----------

  /** 登记角色配置（编排器引导时调用；同 id 已存在即冲突，不覆盖）。 */
  insertAgentRole(role: AgentRole): void {
    this.db
      .prepare(
        `INSERT INTO agent_roles (id, project_id, session_id, work_dir, model_selection, tools, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        role.id,
        role.projectId,
        role.sessionId,
        role.workDir,
        role.modelSelection ? JSON.stringify(role.modelSelection) : null,
        JSON.stringify(role.tools),
        role.createdAt,
      );
  }

  getAgentRole(id: AgentRoleId): AgentRole | null {
    const row = this.db.prepare("SELECT * FROM agent_roles WHERE id = ?").get(id) as any;
    return row ? this.rowToAgentRole(row) : null;
  }

  /** 按会话反查角色（Driver 工具白名单判定；非角色会话返回 null）。 */
  getAgentRoleBySession(sessionId: string): AgentRole | null {
    // chat 的群绑定复用宿主 qq_sessions；角色定义仍只有一份，不共享群历史。
    const row = this.db.prepare("SELECT * FROM agent_roles WHERE session_id = ?").get(sessionId) ?? this.db.prepare(
      `SELECT r.id, q.project_id, q.session_id, q.work_dir, s.model_selection, r.tools, q.created_at
       FROM qq_sessions q JOIN sessions s ON s.id = q.session_id AND s.kind = 'qq_group'
       JOIN agent_roles r ON r.id = 'chat' WHERE q.session_id = ?`,
    ).get(sessionId);
    return row ? this.rowToAgentRole(row) : null;
  }

  listAgentRoles(): AgentRole[] {
    const rows = this.db.prepare("SELECT * FROM agent_roles ORDER BY created_at, id").all() as any[];
    return rows.map((r) => this.rowToAgentRole(r));
  }

  private rowToAgentRole(row: any): AgentRole {
    return {
      id: row.id as AgentRoleId,
      projectId: row.project_id,
      sessionId: row.session_id,
      workDir: row.work_dir,
      modelSelection: row.model_selection ? (JSON.parse(row.model_selection) as ModelSelection) : null,
      tools: JSON.parse(row.tools) as ToolCategory[],
      createdAt: row.created_at,
    };
  }

  /**
   * 提供方引用计数（删除 provider 前的悬空检查，issue 21 §4）：
   * 统计 model_selection JSON 中引用该 provider 的会话与逻辑角色数。
   */
  countProviderReferences(provider: string, modelId?: string): { sessions: number; roles: number } {
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
    const roleRows = this.db.prepare("SELECT model_selection FROM agent_roles WHERE model_selection IS NOT NULL").all() as Array<{ model_selection: string }>;
    return {
      sessions: sessionRows.filter((r) => matches(r.model_selection)).length,
      roles: roleRows.filter((r) => matches(r.model_selection)).length,
    };
  }

  // ---------- 元数据键值（应用数据实例绑定等宿主登记） ----------

  getMetaValue(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMetaValue(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // ---------- 群聊结果接收（issue 09） ----------

  getAcceptedChatResult(mainProjectId: string, taskId: string): AcceptedChatResult | null {
    const row = this.db.prepare("SELECT * FROM chat_result_acceptances WHERE main_project_id = ? AND task_id = ?").get(mainProjectId, taskId) as any;
    return row ? {
      taskId: row.task_id, mainProjectId: row.main_project_id, acceptedByTaskId: row.accepted_by_task_id,
      acceptedByOpId: row.accepted_by_op_id, reason: row.reason, summary: row.summary, acceptedAt: row.accepted_at,
    } : null;
  }

  /** 调用方在事务内核实 main 身份与来源后写入；首次快照固定，重复接收不改写。 */
  acceptChatResult(input: Omit<AcceptedChatResult, "acceptedAt">): AcceptedChatResult {
    const acceptedAt = new Date().toISOString();
    const inserted = this.db.prepare(
      `INSERT INTO chat_result_acceptances (main_project_id, task_id, accepted_by_task_id, accepted_by_op_id, reason, summary, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (main_project_id, task_id) DO NOTHING`,
    ).run(input.mainProjectId, input.taskId, input.acceptedByTaskId, input.acceptedByOpId, input.reason, input.summary, acceptedAt);
    if (Number(inserted.changes) === 1) this.appendEvent({
      type: "chat_result.accepted", taskId: input.taskId, acceptedByTaskId: input.acceptedByTaskId, acceptedByOpId: input.acceptedByOpId,
    }, { taskId: input.acceptedByTaskId });
    return this.getAcceptedChatResult(input.mainProjectId, input.taskId)!;
  }

  chatResultOpCommitted(opId: string): boolean {
    // 重复接收沿用首次记录；停止/恢复时也能核实“已接收”的只读重复调用。
    return this.db.prepare(
      `SELECT 1 FROM chat_result_acceptances WHERE accepted_by_op_id = ?1
       UNION ALL SELECT 1 FROM tool_ops o JOIN tasks owner_task ON owner_task.id = o.task_id
       JOIN sessions s ON s.id = owner_task.session_id
       JOIN chat_result_acceptances a ON a.main_project_id = s.project_id AND a.task_id = json_extract(o.params, '$.task_id')
       WHERE o.id = ?1 AND o.tool_name = 'chat_result_accept' LIMIT 1`,
    ).get(opId) !== undefined;
  }

  // ---------- 入站事件（issue 01；先持久化再建任务） ----------

  /**
   * 登记入站事件（幂等）：(source, externalId) 唯一；重复登记返回已存在
   * 事件（created=false），不产生新事件、不新建任务。
   */
  registerInboundEvent(input: {
    source: string;
    externalId: string;
    actor: string | null;
    targetRole: AgentRoleId;
    body: string;
    artifactRefs?: string[];
    replyTarget?: NotifyTarget | null;
    receivedAt?: string;
  }): { event: InboundEvent; created: boolean } {
    const event: InboundEvent = {
      id: randomId("evt"),
      source: input.source,
      externalId: input.externalId,
      actor: input.actor,
      targetRole: input.targetRole,
      body: input.body,
      artifactRefs: input.artifactRefs ?? [],
      replyTarget: input.replyTarget ?? null,
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      status: "registered",
      taskId: null,
    };
    const info = this.db
      .prepare(
        `INSERT INTO inbound_events (id, source, external_id, actor, target_role, body, artifact_refs, reply_target, received_at, status, task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', NULL)
         ON CONFLICT (source, external_id) DO NOTHING`,
      )
      .run(
        event.id,
        event.source,
        event.externalId,
        event.actor,
        event.targetRole,
        event.body,
        JSON.stringify(event.artifactRefs),
        event.replyTarget ? JSON.stringify(event.replyTarget) : null,
        event.receivedAt,
      );
    if (Number(info.changes) !== 1) {
      return { event: this.findInboundEvent(input.source, input.externalId)!, created: false };
    }
    this.appendEvent({
      type: "inbound.registered",
      eventId: event.id,
      source: event.source,
      externalId: event.externalId,
      targetRole: event.targetRole,
      actor: event.actor,
    });
    return { event, created: true };
  }

  getInboundEvent(id: string): InboundEvent | null {
    const row = this.db.prepare("SELECT * FROM inbound_events WHERE id = ?").get(id) as any;
    return row ? this.rowToInboundEvent(row) : null;
  }

  findInboundEvent(source: string, externalId: string): InboundEvent | null {
    const row = this.db
      .prepare("SELECT * FROM inbound_events WHERE source = ? AND external_id = ?")
      .get(source, externalId) as any;
    return row ? this.rowToInboundEvent(row) : null;
  }

  listInboundByStatus(statuses: InboundEventStatus[]): InboundEvent[] {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM inbound_events WHERE status IN (${placeholders}) ORDER BY received_at, rowid`)
      .all(...statuses) as any[];
    return rows.map((r) => this.rowToInboundEvent(r));
  }

  /** 事件已建任务（registered → queued 条件转换；重复处理不覆盖原任务）。 */
  markInboundQueued(eventId: string, taskId: string): boolean {
    const info = this.db
      .prepare("UPDATE inbound_events SET status = 'queued', task_id = ? WHERE id = ? AND status = 'registered'")
      .run(taskId, eventId);
    if (Number(info.changes) !== 1) return false;
    const event = this.getInboundEvent(eventId)!;
    this.appendEvent(
      { type: "inbound.queued", eventId, taskId, targetRole: event.targetRole },
      { taskId, sessionId: null },
    );
    return true;
  }

  /** 已登记未建任务的事件作废（registered → failed；issue 03 取消计划：恢复与派发都不再建任务）。 */
  failRegisteredInbound(eventId: string): boolean {
    const info = this.db.prepare("UPDATE inbound_events SET status = 'failed' WHERE id = ? AND status = 'registered'").run(eventId);
    return Number(info.changes) === 1;
  }

  /** 事件处理终态（queued → done / failed；不覆盖已定的终态）。 */
  setInboundTerminal(eventId: string, status: "done" | "failed"): boolean {
    const info = this.db
      .prepare("UPDATE inbound_events SET status = ? WHERE id = ? AND status = 'queued'")
      .run(status, eventId);
    return Number(info.changes) === 1;
  }

  private rowToInboundEvent(row: any): InboundEvent {
    return {
      id: row.id,
      source: row.source,
      externalId: row.external_id,
      actor: row.actor ?? null,
      targetRole: row.target_role as AgentRoleId,
      body: row.body,
      artifactRefs: JSON.parse(row.artifact_refs ?? "[]") as string[],
      replyTarget: row.reply_target ? JSON.parse(row.reply_target) as NotifyTarget : null,
      receivedAt: row.received_at,
      status: row.status as InboundEventStatus,
      taskId: row.task_id ?? null,
    };
  }

  // ---------- 访问模式与权限版本 ----------

  /** 请求模式切换（记录待生效模式；不改变当前模式）。 */
  requestModeSwitch(taskId: string, to: AccessMode): boolean {
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

  /** 任务中断/取消时，其未决确认请求标记 stale（失效批准不得再执行）；进行中的自动审查一并标记 superseded（后台重启后不再有审查结果到达，不能永远显示"审查中"）。 */
  stalePendingConfirmations(taskId: string): void {
    this.db
      .prepare(
        `UPDATE confirmations SET status = 'stale', responded_at = ?,
           review_status = CASE WHEN review_status = 'in_progress' THEN 'superseded' ELSE review_status END
         WHERE task_id = ? AND status = 'pending'`,
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

  getToolOp(id: string): ToolOp | null {
    const row = this.db.prepare("SELECT * FROM tool_ops WHERE id = ?").get(id) as any;
    return row ? Store.rowToToolOp(row) : null;
  }

  private static rowToToolOp(row: any): ToolOp {
    return {
      id: row.id,
      taskId: row.task_id,
      toolName: row.tool_name,
      sdkCallId: row.sdk_call_id ?? row.id,
      params: JSON.parse(row.params) as Record<string, unknown>,
      intentRecordedAt: row.intent_recorded_at,
      resultSummary: row.result_summary,
      isError: row.is_error === null ? null : Number(row.is_error) === 1,
      effectUnknown: Number(row.effect_unknown) === 1,
      recordedResultAt: row.recorded_result_at,
    };
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
      createdAt: row.created_at,
    };
  }

  // ---------- 目录占用 ----------

  /**
   * 尝试占用目录。碰撞键：dev+ino（同一目录的符号链接、挂载别名都会命中），
   * cwd_real 作为附加一致性检查。被占用时返回 null。
   */
  tryAcquireOccupancy(input: {
    cwdReal: string;
    cwdDev: number;
    cwdIno: number;
    sessionId: string;
    taskId: string;
  }): boolean {
    const clash = this.db
      .prepare("SELECT cwd_real FROM occupancy WHERE (cwd_dev = ? AND cwd_ino = ?) OR cwd_real = ?")
      .get(input.cwdDev, input.cwdIno, input.cwdReal) as { cwd_real: string } | undefined;
    if (clash) return false;
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

  releaseOccupancy(cwdReal: string, taskId: string): boolean {
    const info = this.db
      .prepare("DELETE FROM occupancy WHERE cwd_real = ? AND task_id = ?")
      .run(cwdReal, taskId);
    return Number(info.changes) === 1;
  }

  getOccupancyByDir(cwdReal: string): { taskId: string; sessionId: string } | null {
    const row = this.db
      .prepare("SELECT task_id, session_id FROM occupancy WHERE cwd_real = ?")
      .get(cwdReal) as any;
    return row ? { taskId: row.task_id, sessionId: row.session_id } : null;
  }

  /** 全部占用（崩溃恢复时核对：旧执行是否确认停止，未确认前保留）。 */
  listAllOccupancy(): Array<{ cwdReal: string; cwdDev: number; cwdIno: number; taskId: string; sessionId: string }> {
    const rows = this.db.prepare("SELECT * FROM occupancy").all() as any[];
    return rows.map((row) => ({
      cwdReal: row.cwd_real,
      cwdDev: Number(row.cwd_dev),
      cwdIno: Number(row.cwd_ino),
      taskId: row.task_id,
      sessionId: row.session_id,
    }));
  }

  // ---------- 事件读取（快照与补发） ----------

  getMaxSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS max FROM events").get() as {
      max: number;
    };
    return Number(row.max);
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
          estimate_after, task_id, call_index, created_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cp.id, cp.sessionId, cp.summarizedCount, cp.clearedCount, cp.fingerprint, cp.summary, cp.summaryUntil,
        JSON.stringify(cp.clearedRefs), cp.clearedResults, cp.summaryModel, cp.summaryStatus, cp.summaryError,
        cp.promptVersion, cp.usage ? JSON.stringify(cp.usage) : null, cp.estimateBefore, cp.estimateAfter,
        cp.taskId, cp.callIndex, cp.createdAt,
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
    taskId: row.task_id,
    callIndex: Number(row.call_index),
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

/** 工作区根目录部分唯一索引冲突（issue 05 兜底路径；node:sqlite 报索引名）。 */
function isRootDirClash(err: unknown): boolean {
  return err instanceof Error && err.message.includes("idx_projects_root_real");
}
