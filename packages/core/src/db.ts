/**
 * SQLite 元数据存储（node:sqlite）。
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
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { ProfileError } from "./profile-files.ts";
import { PRODUCT, PRODUCT_META_KEY } from "./product.ts";

export const SCHEMA_VERSION = 59;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS code_schedules (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active','paused','canceled','completed')),
  version INTEGER NOT NULL CHECK (version > 0),
  next_due_at TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS code_schedules_due ON code_schedules(status, next_due_at);
CREATE TABLE IF NOT EXISTS code_schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES code_schedules(id),
  plan_version INTEGER NOT NULL,
  scheduled_at TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  status TEXT NOT NULL CHECK (status IN ('active','completed','failed','canceled','interrupted')),
  closed_at TEXT,
  payload TEXT NOT NULL,
  UNIQUE(schedule_id, plan_version, scheduled_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS code_schedule_runs_open ON code_schedule_runs(schedule_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS code_schedule_tasks (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES code_schedule_runs(id),
  source_task_id TEXT REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS code_schedule_tasks_run ON code_schedule_tasks(run_id);
CREATE TABLE IF NOT EXISTS code_schedule_receipts (
  request_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS background_processes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  host_op_id TEXT NOT NULL UNIQUE REFERENCES tool_ops(id),
  state TEXT NOT NULL CHECK (state IN ('starting','running','stop_requested','stopped','stop_unverified')),
  payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_background_processes_active ON background_processes(session_id) WHERE state != 'stopped';
CREATE INDEX IF NOT EXISTS idx_background_processes_session ON background_processes(session_id);
CREATE TABLE IF NOT EXISTS background_process_closures (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_key TEXT NOT NULL,
  through_input_seq INTEGER NOT NULL CHECK (through_input_seq >= 0),
  payload TEXT NOT NULL,
  PRIMARY KEY(session_id, request_key)
);
CREATE TABLE IF NOT EXISTS owner_questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  host_op_id TEXT NOT NULL UNIQUE REFERENCES tool_ops(id),
  status TEXT NOT NULL CHECK (status IN ('pending','answered','canceled','stale')),
  payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_questions_pending ON owner_questions(session_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_owner_questions_session ON owner_questions(session_id);
CREATE INDEX IF NOT EXISTS idx_owner_questions_task ON owner_questions(task_id);
CREATE TABLE IF NOT EXISTS owner_question_receipts (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_key TEXT NOT NULL,
  question_id TEXT NOT NULL REFERENCES owner_questions(id),
  digest TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('owner_question_answer','owner_question_cancel')),
  payload TEXT NOT NULL,
  PRIMARY KEY(session_id, request_key)
);
CREATE TABLE IF NOT EXISTS agent_waits (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_reports (
  report_key TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL REFERENCES sessions(id),
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_definition_refs (
  ref_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition_id TEXT NOT NULL REFERENCES workflow_definitions(id),
  request_digest TEXT
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL REFERENCES sessions(id),
  request_key TEXT NOT NULL,
  params_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','paused','succeeded','partial','failed','canceled')),
  payload TEXT NOT NULL,
  UNIQUE(source_session_id, request_key)
);
CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(run_id, key),
  UNIQUE(run_id, ordinal)
);
CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent','host')),
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  number INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(run_id, step_key, kind, number)
);
CREATE TABLE IF NOT EXISTS workflow_questions (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(run_id, step_key)
);
CREATE TABLE IF NOT EXISTS workflow_controls (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  request_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(run_id, request_key)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  create_request_id TEXT,
  -- Workspace directory identity, pinned by realpath and device/inode.
  root_cwd TEXT,
  root_real TEXT,
  root_dev INTEGER,
  root_ino INTEGER,
  instruction_files TEXT NOT NULL DEFAULT '[]',
  settings_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  default_access_mode_version INTEGER NOT NULL DEFAULT 0,
  default_access_mode TEXT NOT NULL DEFAULT 'confirm' CHECK (default_access_mode IN ('confirm','full_access','auto-review','plan')),
  model_selection_version INTEGER NOT NULL DEFAULT 0,
  model_selection TEXT,
  id TEXT PRIMARY KEY,
  name TEXT,
  branch_source TEXT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'dev' CHECK (kind = 'dev'),
  cwd TEXT NOT NULL,
  cwd_real TEXT NOT NULL,
  cwd_dev INTEGER NOT NULL,
  cwd_ino INTEGER NOT NULL,
  pi_session_id TEXT NOT NULL,
  session_file TEXT,
  confirm_tools TEXT NOT NULL DEFAULT '[]',
  create_request_id TEXT,
  queue_state TEXT NOT NULL DEFAULT 'active' CHECK (queue_state IN ('active','paused')),
  queue_pause_reason TEXT,
  queue_revision INTEGER NOT NULL DEFAULT 0 CHECK (queue_revision >= 0),
  -- 拥有者存档：非空即从工作区会话列表隐藏，仅设置页列出；只影响列表可见性
  archived_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branch_requests (
  request_id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  branch_number INTEGER NOT NULL,
  params_digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','published','failed')),
  error TEXT,
  UNIQUE(source_session_id, branch_number)
);
-- 侧聊绑定（coding-side-chat）：父会话唯一一条，prepare 阶段即占用绑定，
-- 两个客户端并发打开也不能各自冻结不同的快照。payload 存准备回执
-- （SideChatReceipt：会话元数据 + 冻结历史清单 + 文件哈希 + 压缩点）。
CREATE TABLE IF NOT EXISTS side_chats (
  parent_session_id TEXT PRIMARY KEY,
  side_session_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  params_digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','published','failed')),
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compaction_requests (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  params_digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','noop','failed','cancelled','interrupted'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_compaction_requests_running ON compaction_requests (session_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_compaction_requests_session ON compaction_requests (session_id, request_id);
CREATE TABLE IF NOT EXISTS tasks (
  result_delivered_at TEXT,
  read_scope TEXT,
  sub_agent_id TEXT,
  work_id TEXT,
  submission_digest TEXT,
  model_selection TEXT,
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id TEXT NOT NULL,
  input TEXT NOT NULL,
  queue_order INTEGER NOT NULL CHECK (queue_order > 0),
  status TEXT NOT NULL CHECK (status IN
    ('queued','running','awaiting_confirmation','completed','failed','canceled','interrupted')),
  access_mode TEXT NOT NULL DEFAULT 'confirm' CHECK (access_mode IN ('confirm','full_access','auto-review')),
  plan_mode INTEGER NOT NULL DEFAULT 0 CHECK (plan_mode IN (0,1)),
  permission_version INTEGER NOT NULL DEFAULT 1,
  granted_paths TEXT NOT NULL DEFAULT '[]',
  pending_access_mode TEXT CHECK (pending_access_mode IS NULL OR pending_access_mode IN ('confirm','full_access','auto-review')),
  interrupt_reason TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  effect_unknown INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  history_entry_ids TEXT NOT NULL DEFAULT '[]',
  resumes_task_id TEXT,
  parent_task_id TEXT,
  source_permission_version INTEGER,
  deadline TEXT,
  result_summary TEXT,
  result_ref TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (session_id, request_id),
  UNIQUE (id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_session_created ON tasks (session_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks (session_id, status, queue_order);
CREATE TABLE IF NOT EXISTS message_recalls (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('queued','historical')),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id TEXT NOT NULL,
  params_digest TEXT NOT NULL,
  target_task_id TEXT NOT NULL REFERENCES tasks(id),
  input_seq INTEGER NOT NULL,
  expected_revision INTEGER NOT NULL,
  exec_task_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('accepted','stopping','blocked','applying','completed','rejected')),
  stop_task_ids TEXT NOT NULL DEFAULT '[]',
  sealed_task_ids TEXT NOT NULL DEFAULT '[]',
  omitted_entry_ids TEXT,
  history_fingerprint TEXT,
  original_input TEXT NOT NULL,
  original_attachments TEXT NOT NULL DEFAULT '[]',
  draft_attachments TEXT,
  completion_revision INTEGER,
  next_candidate_task_id TEXT,
  edit_open INTEGER NOT NULL DEFAULT 0,
  saved_queue_state TEXT,
  saved_queue_reason TEXT,
  error_code TEXT,
  error_message TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_recalls_open ON message_recalls(session_id) WHERE phase IN ('accepted','stopping','blocked','applying');
CREATE INDEX IF NOT EXISTS idx_message_recalls_session ON message_recalls(session_id, created_at);
CREATE TABLE IF NOT EXISTS task_guidance (
  source_task_id TEXT PRIMARY KEY,
  target_task_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  accepted_seq INTEGER NOT NULL CHECK (accepted_seq > 0),
  state TEXT NOT NULL CHECK (state IN ('pending','joined','fallback','canceled')),
  entry_id TEXT,
  CHECK (source_task_id != target_task_id),
  CHECK ((state = 'joined' AND entry_id IS NOT NULL AND entry_id != '') OR (state != 'joined' AND entry_id IS NULL)),
  UNIQUE (session_id, accepted_seq),
  FOREIGN KEY (source_task_id, session_id) REFERENCES tasks(id, session_id),
  FOREIGN KEY (target_task_id, session_id) REFERENCES tasks(id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_task_guidance_target ON task_guidance (target_task_id, state, accepted_seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_guidance_entry ON task_guidance (target_task_id, entry_id) WHERE state = 'joined';
CREATE TABLE IF NOT EXISTS occupancy (
  cwd_real TEXT PRIMARY KEY,
  cwd_dev INTEGER NOT NULL,
  cwd_ino INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT,
  process_id TEXT REFERENCES background_processes(id),
  acquired_at TEXT NOT NULL,
  CHECK ((task_id IS NOT NULL AND process_id IS NULL) OR (task_id IS NULL AND process_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS confirmations (
  decision_source TEXT,
  review_policy_version TEXT,
  review_model TEXT,
  review_reason TEXT,
  review_decision TEXT,
  review_status TEXT,
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
  authorization TEXT,
  mcp TEXT,
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
  mime_type TEXT CHECK (mime_type IS NULL OR mime_type IN ('image/jpeg','image/png','image/webp')),
  content_hash TEXT,
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
  prompt_artifact TEXT,
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
  skill_version TEXT NOT NULL DEFAULT '',
  capped_tool_results TEXT NOT NULL DEFAULT '[]',
  estimates TEXT NOT NULL,
  budget INTEGER NOT NULL,
  estimated_total INTEGER NOT NULL,
  usage TEXT,
  experiment TEXT,
  window_snapshot TEXT,
  checkpoint_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_selection_records_task ON selection_records (task_id, call_index);

/*
 * issue 30：上下文压缩点。每个会话至多一个 active（部分唯一索引），
 * 新建时旧行改为 superseded；指纹不符时改为 invalidated。会话历史不受影响。
 * Note: 见 .agents/notes/implemented/architecture/2026-09-26-lossy-context-compaction.md
 */
CREATE TABLE IF NOT EXISTS context_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','invalidated')),
  summarized_count INTEGER NOT NULL,
  cleared_count INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  summary TEXT,
  summary_until TEXT,
  cleared_refs TEXT NOT NULL DEFAULT '{}',
  cleared_results INTEGER NOT NULL DEFAULT 0,
  summary_model TEXT,
  summary_status TEXT NOT NULL CHECK (summary_status IN ('ok','failed','none')),
  summary_error TEXT,
  prompt_version TEXT NOT NULL,
  usage TEXT,
  estimate_before INTEGER NOT NULL,
  estimate_after INTEGER NOT NULL,
  task_id TEXT,
  call_index INTEGER,
  manual_request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_checkpoints_active ON context_checkpoints (session_id) WHERE status = 'active';

-- v8：MCP 服务配置（issue 16）——拥有者按实例管理的 MCP 服务；秘密值仍在
-- CredentialStore，本表只存凭据绑定名。config_version 随任何变化递增，
-- 任务开始钉版工具清单，调用前重读核对。
CREATE TABLE IF NOT EXISTS mcp_services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  endpoint TEXT NOT NULL,
  cua_config TEXT,
  credential TEXT,
  tool_allowlist TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Delegated work, child identity and each execution have independent lifecycles.
CREATE TABLE IF NOT EXISTS sub_agents (
  id TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  parent_session_id TEXT NOT NULL REFERENCES sessions(id),
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  work_dir TEXT NOT NULL,
  active_work_id TEXT,
  current_task_id TEXT,
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('running','idle','unverified')),
  closed_at TEXT,
  closed_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_agents_parent ON sub_agents (parent_session_id);
CREATE TABLE IF NOT EXISTS work_delegations (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL REFERENCES sessions(id),
  origin_task_id TEXT NOT NULL,
  sub_agent_id TEXT NOT NULL REFERENCES sub_agents(id),
  request_key TEXT NOT NULL,
  params_digest TEXT NOT NULL,
  -- v26（agent-direction issue 14）：整项工作取消（独立列，一次写入；旧行三列为空）
  canceled_at TEXT,
  canceled_by TEXT,
  cancel_reason TEXT,
  -- v27（agent-direction issue 16）：写入目标 JSON（WorkWriteTarget；旧行为空 = 只读分析工作）
  write_target TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (parent_session_id, request_key)
);

-- Work participants exchange idempotent messages; the host delivers child tasks
-- or injects parent context and records an explicit reason when delivery is lost.
CREATE TABLE IF NOT EXISTS subagent_messages (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES work_delegations(id),
  parent_session_id TEXT NOT NULL REFERENCES sessions(id),
  from_sub_agent_id TEXT REFERENCES sub_agents(id),
  from_task_id TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('confirm','full_access','auto-review')),
  source_permission_version INTEGER NOT NULL CHECK (source_permission_version > 0),
  to_sub_agent_id TEXT REFERENCES sub_agents(id),
  request_key TEXT NOT NULL,
  params_digest TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_task_id TEXT,
  delivered_at TEXT,
  undelivered_reason TEXT
);
-- Browser bindings belong to the submitting authenticated desktop connection;
-- reconnecting never transfers an existing handle to a new connection.
CREATE TABLE IF NOT EXISTS task_browser_bindings (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  connection_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_smsg_work ON subagent_messages (work_id);
CREATE INDEX IF NOT EXISTS idx_smsg_pending ON subagent_messages (parent_session_id, delivered_at);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks (deadline);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_create_request ON projects (create_request_id) WHERE create_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_create_request ON sessions (create_request_id) WHERE create_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_root_real ON projects (root_real) WHERE root_real IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_work ON tasks (work_id);
CREATE INDEX IF NOT EXISTS idx_tasks_sub_agent ON tasks (sub_agent_id);
`;

export class SchemaVersionError extends Error {
  readonly code = "schema_version_unsupported";
  constructor(message: string) { super(message); }
}

export interface DatabaseBinding {
  instanceId: string;
  layout: string;
  preparationId: string;
}

export class DatabaseIdentityError extends Error {
  readonly code = "database_identity_mismatch";
  constructor(message: string) { super(message); }
}

const PREPARE_DATABASE = Symbol("prepare database");

export class Db {
  readonly file: string;
  private readonly db: DatabaseSync;
  /** 测试专用故障注入：下一次写入抛错（生产代码路径不设置）。 */
  faultNextWrite: Error | null = null;

  /** Bootstrap alone creates a staged database with the preparation's reserved identity. */
  static createPrepared(dataDir: string, file: string, binding: DatabaseBinding): Db {
    return new Db(dataDir, file, binding, PREPARE_DATABASE);
  }

  // Note: See .agents/notes/implemented/architecture/2026-11-10-single-product-profile.md
  constructor(dataDir: string, file = "ruukoto.db", binding?: DatabaseBinding, preparation?: typeof PREPARE_DATABASE) {
    this.file = path.join(dataDir, file);
    const creating = preparation === PREPARE_DATABASE;
    if (creating) fs.closeSync(fs.openSync(this.file, "wx", 0o600));
    const existed = !creating && (binding !== undefined || fs.existsSync(this.file));
    // SQLite's URI mode removes CREATE at the open boundary, including after concurrent deletion.
    const location = pathToFileURL(this.file);
    location.searchParams.set("mode", binding || existed ? "rw" : "rwc");
    try { this.db = new DatabaseSync(location.href); }
    catch (cause) {
      if (binding && cause instanceof Error && "errcode" in cause && typeof cause.errcode === "number" && (cause.errcode & 0xff) === 14) {
        throw new ProfileError("profile_database_unavailable", `Cannot reopen required profile database: ${this.file}`, { cause });
      }
      throw cause;
    }
    let row: { value: string } | undefined;
    try {
      if (existed) {
        row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
        if (!row) throw new DatabaseIdentityError(`Unmarked database: ${this.file}`);
        const version = Number(row.value);
        if (version !== SCHEMA_VERSION) throw new SchemaVersionError(`Unsupported schema ${row.value}; this program requires ${SCHEMA_VERSION}. Preserve ${this.file}.`);
        if (binding) {
          const get = (key: string) => (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
          if (get("instance_id") !== binding.instanceId || get("profile.layout") !== binding.layout ||
              get("profile.preparation_id") !== binding.preparationId || get(PRODUCT_META_KEY) !== PRODUCT) {
            throw new DatabaseIdentityError(`Database/profile binding differs: ${this.file}`);
          }
        }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.tx(() => {
      this.db.exec(SCHEMA_SQL);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING")
        .run(String(SCHEMA_VERSION));
      const save = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING");
      save.run("instance_id", binding?.instanceId ?? randomUUID());
      save.run(PRODUCT_META_KEY, PRODUCT);
      if (binding) {
        save.run("profile.layout", binding.layout);
        save.run("profile.preparation_id", binding.preparationId);
      }
    });
  }

  /** 数据实例稳定标识（跨重启保留）。 */
  getInstanceId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get() as { value: string };
    return row.value;
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
