/**
 * SQLite 元数据存储（node:sqlite，Node ≥22.5）。
 *
 * 宿主元数据：项目、会话、任务、确认请求、目录占用、幂等键、持久事件。
 * pi JSONL 会话文件是消息历史的唯一权威副本，这里不重复存消息正文。
 *
 * 事务保证：任务状态、目录占用与对应事件在同一事务内提交；提交成功后才
 * 应答客户端与广播。SQLite 与 JSONL 没有跨文件事务，实现不得声称两者原子。
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

export const SCHEMA_VERSION = 6;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  instruction_files TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  cwd TEXT NOT NULL,
  cwd_real TEXT NOT NULL,
  cwd_dev INTEGER NOT NULL,
  cwd_ino INTEGER NOT NULL,
  pi_session_id TEXT NOT NULL,
  session_file TEXT,
  confirm_tools TEXT NOT NULL DEFAULT '[]',
  queue_state TEXT NOT NULL DEFAULT 'active' CHECK (queue_state IN ('active','paused')),
  queue_pause_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('queued','running','awaiting_confirmation','completed','failed','canceled','interrupted')),
  access_mode TEXT NOT NULL DEFAULT 'confirm' CHECK (access_mode IN ('confirm','full_access','auto-review')),
  permission_version INTEGER NOT NULL DEFAULT 1,
  granted_paths TEXT NOT NULL DEFAULT '[]',
  pending_access_mode TEXT CHECK (pending_access_mode IS NULL OR pending_access_mode IN ('confirm','full_access','auto-review')),
  interrupt_reason TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  effect_unknown INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  history_entry_ids TEXT NOT NULL DEFAULT '[]',
  resumes_task_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (session_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_session_created ON tasks (session_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE TABLE IF NOT EXISTS occupancy (
  cwd_real TEXT PRIMARY KEY,
  cwd_dev INTEGER NOT NULL,
  cwd_ino INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS confirmations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  session_id TEXT NOT NULL,
  tool_op_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  params TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '{"kind":"tool","workspaceOnly":true}',
  cwd_dev INTEGER NOT NULL DEFAULT 0,
  cwd_ino INTEGER NOT NULL DEFAULT 0,
  permission_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','stale')),
  created_at TEXT NOT NULL,
  responded_at TEXT,
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS tool_ops (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  tool_name TEXT NOT NULL,
  sdk_call_id TEXT,
  params TEXT NOT NULL,
  intent_recorded_at TEXT NOT NULL,
  result_summary TEXT,
  is_error INTEGER,
  effect_unknown INTEGER NOT NULL DEFAULT 0,
  recorded_result_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_ops_task ON tool_ops (task_id);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  byte_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'partial' CHECK (status IN ('partial','complete')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts (task_id);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  session_id TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS data_grants (
  id TEXT PRIMARY KEY,
  from_project_id TEXT NOT NULL REFERENCES projects(id),
  to_project_id TEXT NOT NULL REFERENCES projects(id),
  category TEXT NOT NULL CHECK (category IN ('history','artifact','memory')),
  purpose TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_data_grants_to ON data_grants (to_project_id, category, revoked_at);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  scope TEXT NOT NULL CHECK (scope IN ('project','personal')),
  category TEXT NOT NULL CHECK (category IN ('preference','convention','decision','experience')),
  current_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories (project_id, status);
CREATE TABLE IF NOT EXISTS memory_versions (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('agent','owner')),
  tool_op_id TEXT,
  task_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, version)
);
CREATE TABLE IF NOT EXISTS history_index (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT,
  entry_type TEXT NOT NULL,
  timestamp TEXT,
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  PRIMARY KEY (session_id, entry_id)
);
CREATE TABLE IF NOT EXISTS history_index_state (
  session_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  file_dev INTEGER NOT NULL,
  file_ino INTEGER NOT NULL,
  processed_bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS selection_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  call_index INTEGER NOT NULL,
  strategy TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  total_messages INTEGER NOT NULL,
  included_indices TEXT NOT NULL,
  excluded TEXT NOT NULL,
  included_memories TEXT NOT NULL,
  excluded_memories TEXT NOT NULL,
  instruction_version TEXT NOT NULL DEFAULT '',
  capped_tool_results TEXT NOT NULL DEFAULT '[]',
  estimates TEXT NOT NULL,
  budget INTEGER NOT NULL,
  estimated_total INTEGER NOT NULL,
  usage TEXT,
  window_snapshot TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_selection_records_task ON selection_records (task_id, call_index);

-- v4：GitHub 集成（issue 06）——仓库绑定、草稿与发布操作
CREATE TABLE IF NOT EXISTS github_repo_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  api_host TEXT NOT NULL,
  scheme TEXT NOT NULL DEFAULT 'https',
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  repo_id INTEGER,
  read_credential TEXT,
  publish_credential TEXT,
  read_scopes TEXT NOT NULL,
  allow_fork_content INTEGER NOT NULL DEFAULT 0,
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, api_host, owner, repo)
);
CREATE TABLE IF NOT EXISTS github_drafts (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  revisions TEXT NOT NULL,
  evidence_artifact_ids TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  stale_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS idx_github_drafts_task ON github_drafts (task_id);
CREATE TABLE IF NOT EXISTS github_publish_ops (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL,
  binding_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  revisions TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  permission_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  remote_id INTEGER,
  remote_url TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_publish_ops_draft ON github_publish_ops (draft_id, draft_version);
`;

/**
 * v1 → v2 迁移（单事务）：任务补访问模式与权限版本（旧任务默认请求确认）、
 * 工具操作补 SDK 调用 id 列（宿主操作 id 不再复用模型调用 id）、确认请求补
 * 权限范围/版本/消费时间，旧未决审批一律失效；新增产物表。历史、任务与事件
 * 全部保留。
 */
const MIGRATION_V2_SQL = `
ALTER TABLE tasks ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'confirm';
ALTER TABLE tasks ADD COLUMN permission_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN granted_paths TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN pending_access_mode TEXT;
ALTER TABLE tool_ops ADD COLUMN sdk_call_id TEXT;
UPDATE tool_ops SET sdk_call_id = id WHERE sdk_call_id IS NULL;
ALTER TABLE confirmations ADD COLUMN scope TEXT NOT NULL DEFAULT '{"kind":"tool","workspaceOnly":true}';
ALTER TABLE confirmations ADD COLUMN cwd_dev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE confirmations ADD COLUMN cwd_ino INTEGER NOT NULL DEFAULT 0;
ALTER TABLE confirmations ADD COLUMN permission_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE confirmations ADD COLUMN consumed_at TEXT;
`;

export class Db {
  readonly file: string;
  private readonly db: DatabaseSync;
  /** 测试专用故障注入：下一次写入抛错（生产代码路径不设置）。 */
  faultNextWrite: Error | null = null;

  constructor(dataDir: string, file = "ruukoto.db") {
    this.file = path.join(dataDir, file);
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    // 全新数据库尚无 meta 表：查询失败按"无版本记录"处理，进入建表事务
    let row: { value: string } | undefined;
    try {
      row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
    } catch {
      row = undefined;
    }
    const version = row ? Number(row.value) : SCHEMA_VERSION;
    if (row && version > SCHEMA_VERSION) {
      throw new Error(`schema 版本过新：文件 ${row.value}，程序 ${SCHEMA_VERSION}（需升级程序）`);
    }
    if (row && version === SCHEMA_VERSION) {
      // v2 及以后：仅补齐缺失对象（幂等）
      this.db.exec(SCHEMA_SQL);
      this.ensureColumns();
    } else {
      // v6 起旧库的 tasks/sessions 访问模式 CHECK 需重建表；FK pragma 在事务内
      // 无效，必须在事务外关闭（tasks 引用 sessions，重建期间不强制），结束后恢复。
      const rebuildModeChecks = row !== undefined && version < SCHEMA_VERSION;
      if (rebuildModeChecks) this.db.exec("PRAGMA foreign_keys = OFF;");
      // 全新库或旧版本库都在一个事务里完成：建表 + 迁移 + 版本号，要么全成要么全不动
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(SCHEMA_SQL);
        if (row && version < SCHEMA_VERSION) {
          this.migrateFrom(version);
        }
        this.ensureColumns();
        if (rebuildModeChecks) {
          this.rebuildModeCheckedTables();
        }
        this.db
          .prepare(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .run(String(SCHEMA_VERSION));
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // 事务可能已因错误自动回滚
        }
        throw new Error(`schema 迁移失败（v${version} → v${SCHEMA_VERSION}）：${(err as Error).message}`);
      } finally {
        if (rebuildModeChecks) this.db.exec("PRAGMA foreign_keys = ON;");
      }
    }
    // 数据实例标识：首次打开分配并持久化；重启保留，新数据库分配新标识。
    // 客户端待确认请求绑定该标识，换库后不会向空后台重发。
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('instance_id', ?) ON CONFLICT(key) DO NOTHING")
      .run(randomUUID());
  }

  /** 数据实例稳定标识（跨重启保留）。 */
  getInstanceId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get() as { value: string };
    return row.value;
  }

  private migrateFrom(version: number): void {
    if (version === 1) {
      this.db.exec(MIGRATION_V2_SQL);
      // 旧未决审批一律失效（批准不得跨 schema 版本消费）
      this.db
        .prepare("UPDATE confirmations SET status = 'stale', responded_at = ? WHERE status = 'pending'")
        .run(new Date().toISOString());
    } else if (version >= 2 && version <= 5) {
      // v2 → v3：新增授权/记忆/历史索引/选择记录表；v3 → v4：新增 GitHub 表；
      // v4 → v5：模型选择补列。均为 SCHEMA_SQL 幂等建表覆盖 + 补列；
      // v5 → v6 的 CHECK 变更由重建步骤统一处理，无既有数据需要改写。
      this.ensureColumns();
    } else {
      throw new Error(`不支持从 schema v${version} 迁移`);
    }
  }

  /**
   * v6：tasks/sessions 的访问模式 CHECK 加入 'auto-review'。SQLite 不能修改
   * CHECK 约束，按官方推荐流程重建表：显式列清单复制（保留原模式与权限版本
   * 等全部取值）→ 换名 → 重建索引。调用前外键已在事务外关闭。
   */
  private rebuildModeCheckedTables(): void {
    this.db.exec(`
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('queued','running','awaiting_confirmation','completed','failed','canceled','interrupted')),
  access_mode TEXT NOT NULL DEFAULT 'confirm' CHECK (access_mode IN ('confirm','full_access','auto-review')),
  permission_version INTEGER NOT NULL DEFAULT 1,
  granted_paths TEXT NOT NULL DEFAULT '[]',
  pending_access_mode TEXT CHECK (pending_access_mode IS NULL OR pending_access_mode IN ('confirm','full_access','auto-review')),
  interrupt_reason TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  effect_unknown INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  history_entry_ids TEXT NOT NULL DEFAULT '[]',
  resumes_task_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  model_selection TEXT,
  submission_digest TEXT,
  UNIQUE (session_id, request_id)
);
INSERT INTO tasks_new (id, session_id, request_id, input, status, access_mode, permission_version,
  granted_paths, pending_access_mode, interrupt_reason, cancel_requested, effect_unknown, error_message,
  history_entry_ids, resumes_task_id, created_at, started_at, ended_at, model_selection, submission_digest)
SELECT id, session_id, request_id, input, status, access_mode, permission_version,
  granted_paths, pending_access_mode, interrupt_reason, cancel_requested, effect_unknown, error_message,
  history_entry_ids, resumes_task_id, created_at, started_at, ended_at, model_selection, submission_digest
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX IF NOT EXISTS idx_tasks_session_created ON tasks (session_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  cwd TEXT NOT NULL,
  cwd_real TEXT NOT NULL,
  cwd_dev INTEGER NOT NULL,
  cwd_ino INTEGER NOT NULL,
  pi_session_id TEXT NOT NULL,
  session_file TEXT,
  confirm_tools TEXT NOT NULL DEFAULT '[]',
  queue_state TEXT NOT NULL DEFAULT 'active' CHECK (queue_state IN ('active','paused')),
  queue_pause_reason TEXT,
  created_at TEXT NOT NULL,
  model_selection TEXT,
  model_selection_version INTEGER NOT NULL DEFAULT 0,
  default_access_mode TEXT NOT NULL DEFAULT 'confirm' CHECK (default_access_mode IN ('confirm','full_access','auto-review')),
  default_access_mode_version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sessions_new (id, project_id, cwd, cwd_real, cwd_dev, cwd_ino, pi_session_id, session_file,
  confirm_tools, queue_state, queue_pause_reason, created_at, model_selection, model_selection_version,
  default_access_mode, default_access_mode_version)
SELECT id, project_id, cwd, cwd_real, cwd_dev, cwd_ino, pi_session_id, session_file,
  confirm_tools, queue_state, queue_pause_reason, created_at, model_selection, model_selection_version,
  default_access_mode, default_access_mode_version
FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
`);
  }

  /** 幂等补列（CREATE TABLE IF NOT EXISTS 不会给既有表加列）。 */
  private ensureColumns(): void {
    const add = (table: string, column: string, ddl: string): void => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      }
    };
    add("sessions", "model_selection", "model_selection TEXT");
    add("sessions", "model_selection_version", "model_selection_version INTEGER NOT NULL DEFAULT 0");
    add("sessions", "default_access_mode", "default_access_mode TEXT NOT NULL DEFAULT 'confirm' CHECK (default_access_mode IN ('confirm','full_access','auto-review'))");
    add("sessions", "default_access_mode_version", "default_access_mode_version INTEGER NOT NULL DEFAULT 0");
    add("tasks", "model_selection", "model_selection TEXT");
    add("tasks", "submission_digest", "submission_digest TEXT");
    add("projects", "instruction_files", "instruction_files TEXT NOT NULL DEFAULT '[]'");
    add("selection_records", "instruction_version", "instruction_version TEXT NOT NULL DEFAULT ''");
    add("selection_records", "capped_tool_results", "capped_tool_results TEXT NOT NULL DEFAULT '[]'");
    add("selection_records", "prompt_artifact", "prompt_artifact TEXT");
    add("selection_records", "window_snapshot", "window_snapshot TEXT");
    // v6（issue 15）：审批记录上的自动审查字段；可空，旧记录按历史人工审批展示
    add("confirmations", "review_status", "review_status TEXT");
    add("confirmations", "review_decision", "review_decision TEXT");
    add("confirmations", "review_reason", "review_reason TEXT");
    add("confirmations", "review_model", "review_model TEXT");
    add("confirmations", "review_policy_version", "review_policy_version TEXT");
    add("confirmations", "decision_source", "decision_source TEXT");
  }

  /** 在单个事务内执行；fn 抛错则整体回滚并向上抛出。 */
  tx<T>(fn: () => T): T {
    if (this.faultNextWrite) {
      const err = this.faultNextWrite;
      this.faultNextWrite = null;
      throw err;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务可能已因错误自动回滚
      }
      throw err;
    }
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** WAL checkpoint 并关闭连接（停止路径使用）。 */
  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      this.db.close();
    }
  }
}
