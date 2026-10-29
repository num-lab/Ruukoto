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

export const SCHEMA_VERSION = 56;

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
  -- 工作区根目录身份（agent-direction issue 05）：四列同空即旧项目
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
  kind TEXT NOT NULL DEFAULT 'dev' CHECK (kind IN ('dev','qq_group')),
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
  -- 工作区组织归属（agent-direction issue 07）：仅展示归属；资料身份仍是 project_id
  workspace_project_id TEXT REFERENCES projects(id),
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
  agent_id TEXT CHECK (agent_id IS NULL OR agent_id IN ('main','coding','chat')),
  parent_task_id TEXT,
  source_permission_version INTEGER,
  source_event_id TEXT,
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
  standing_permission_version INTEGER,
  standing_permission_id TEXT,
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

-- v4 曾新增 GitHub 集成三表（github_repo_bindings / github_drafts /
-- github_publish_ops，issue 06）；v9（issue 17）起专用模块退役，新库不再创建。
-- 旧库的表保留为只读归档（不 DROP），退役迁移由 Runtime 启动时按表存在性执行
-- （packages/channels/src/github-retirement.ts），不依赖建表 SQL。

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

-- v10：QQ 群聊入口（issue 07，NapCat OneBot v11 正向 WebSocket）。
-- qq_config 单行配置：端点、凭据绑定名（秘密值只在 CredentialStore）、预期
-- 登录账号、群允许列表、启停与运行保护参数；config_version 随任何变化递增。
CREATE TABLE IF NOT EXISTS qq_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  endpoint TEXT NOT NULL,
  credential_name TEXT,
  self_id TEXT NOT NULL,
  owner_user_id TEXT,
  groups TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0,
  max_reply_chars INTEGER NOT NULL DEFAULT 1500,
  queue_ttl_ms INTEGER NOT NULL DEFAULT 300000, -- 群聊退役后无读取方（issue 23），列保留不迁移
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 登录账号+群 → 独立会话/项目/专用工作目录的映射（不同群相互隔离）。
CREATE TABLE IF NOT EXISTS qq_sessions (
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  work_dir TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account, group_id)
);
-- 收件登记：先持久化再入队；dedup_key = account:group:message_id。
-- status：registered（已登记未入队）→ queued → done / reply_failed /
-- reply_unknown / skipped（过期/停用/越权）；recalled 独立标记撤回。
CREATE TABLE IF NOT EXISTS qq_inbox (
  dedup_key TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  text TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('registered','queued','done','reply_failed','reply_unknown','skipped')),
  recalled INTEGER NOT NULL DEFAULT 0,
  recalled_at TEXT,
  reply_to_message_id TEXT,
  config_version INTEGER,
  message_time TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qq_inbox_task ON qq_inbox (task_id);
CREATE INDEX IF NOT EXISTS idx_qq_inbox_session ON qq_inbox (session_id);
-- 发送记录：先保存固定目标/正文/本地操作 id 再发送；结果区分
-- sent / failed / unknown（effect_unknown，不自动重发）/ canceled（撤回/停用）。
CREATE TABLE IF NOT EXISTS qq_outbox (
  op_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  account TEXT NOT NULL,
  group_id TEXT NOT NULL,
  reply_to_message_id TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','unknown','canceled')),
  sent_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qq_outbox_task ON qq_outbox (task_id);

-- v11：角色、入站事件与子任务编排（issue 01 日常助手）。
-- agent_roles：宿主管理的角色配置——每个角色绑定独立项目/会话/工作目录/
-- 模型与工具白名单（按注册来源类别）；只能由编排器引导写入，模型与输入
-- 正文不能修改。
CREATE TABLE IF NOT EXISTS agent_roles (
  id TEXT PRIMARY KEY CHECK (id IN ('main','coding','chat')),
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  work_dir TEXT NOT NULL,
  model_selection TEXT,
  tools TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- 入站事件：先持久化再建任务；(source, external_id) 唯一即幂等键。
-- status：registered（已登记未建任务）→ queued → done / failed。
-- event_kind（宿主写定）：task = 普通任务入站；im_approval = IM 审批控制消息
-- （不派发模型任务，同步事务内直接到终态）。
CREATE TABLE IF NOT EXISTS inbound_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  actor TEXT,
  target_role TEXT NOT NULL CHECK (target_role IN ('main','coding','chat')),
  body TEXT NOT NULL,
  artifact_refs TEXT NOT NULL DEFAULT '[]',
  reply_target TEXT,
  received_at TEXT NOT NULL,
  event_kind TEXT NOT NULL DEFAULT 'task' CHECK (event_kind IN ('task','im_approval','im_workflow')),
  status TEXT NOT NULL CHECK (status IN ('registered','queued','done','failed')),
  task_id TEXT,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_events_status ON inbound_events (status);

-- v31：入站图片下载账本与安全消息信封；暂存尚不属于任务产物。
CREATE TABLE IF NOT EXISTS inbound_media_messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  actor TEXT,
  body TEXT NOT NULL,
  reply_target TEXT,
  received_at TEXT NOT NULL,
  media_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging','ready','bound','rejected','expired')),
  reason TEXT,
  event_id TEXT REFERENCES inbound_events(id),
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, external_id)
);
CREATE TABLE IF NOT EXISTS inbound_media (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES inbound_media_messages(id),
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  media_index INTEGER NOT NULL,
  declared_mime TEXT,
  mime_type TEXT CHECK (mime_type IS NULL OR mime_type IN ('image/jpeg','image/png','image/webp')),
  byte_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','downloading','ready','promoted','rejected','expired')),
  reason TEXT,
  event_id TEXT REFERENCES inbound_events(id),
  task_id TEXT REFERENCES tasks(id),
  artifact_id TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, external_id, media_index)
);
CREATE INDEX IF NOT EXISTS idx_inbound_media_status ON inbound_media (status, created_at);

-- v17：main 显式接收的固定群聊结果；来源仍需在读取与外发前复核撤回状态。
CREATE TABLE IF NOT EXISTS chat_result_acceptances (
  main_project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  accepted_by_task_id TEXT NOT NULL REFERENCES tasks(id),
  accepted_by_op_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (main_project_id, task_id)
);

-- v13：调度器与通知 outbox（daily-agent issue 03）。运行时基础设施，不是
-- main 的业务表；模型经 scheduler 宿主工具间接读写，应用数据工具不可达。
-- schedules：时间规则与自足说明；创建模式、资料项目与最终回报目标固定。
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  owner_role TEXT NOT NULL DEFAULT 'main' CHECK (owner_role IN ('main')),
  create_key TEXT NOT NULL UNIQUE,
  params_digest TEXT NOT NULL,
  create_task_id TEXT,
  create_op_id TEXT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  create_permission_version INTEGER NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('confirm','full_access','auto-review')),
  rule TEXT NOT NULL,
  instruction TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','completed','canceled')),
  next_due_at TEXT,
  current_run_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  tz_data TEXT NOT NULL,
  reason TEXT NOT NULL,
  cancel_reason TEXT,
  cancel_op_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (status, next_due_at);
-- schedule_runs：一次到期登记；(计划, 版本, 原定时刻) 唯一，每计划最多一个未关闭运行。
CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  schedule_version INTEGER NOT NULL,
  scheduled_for TEXT NOT NULL,
  local_time TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  delay_ms INTEGER NOT NULL,
  coalesced_from TEXT,
  coalesced_to TEXT,
  inbound_event_id TEXT,
  notification_op_id TEXT,
  closed_at TEXT,
  session_id TEXT UNIQUE REFERENCES sessions(id),
  root_task_id TEXT UNIQUE REFERENCES tasks(id),
  result_status TEXT CHECK (result_status IS NULL OR result_status IN ('completed','failed','canceled','interrupted')),
  result_text TEXT,
  UNIQUE (schedule_id, schedule_version, scheduled_for)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_runs_open ON schedule_runs (schedule_id) WHERE closed_at IS NULL;
-- notification_ops：发送操作账本；(source_kind, source_key) 唯一即逻辑发送键。
-- 目标/正文/操作 id 发送前固定；pending（未领取）→ sending（已领取，可能已发出）
-- → sent / failed / effect_unknown（不自动重发）/ canceled。
CREATE TABLE IF NOT EXISTS notification_ops (
  not_before TEXT,
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('schedule_run','tool','confirmation','owner_reply','inbound_event','workflow_question')),
  source_key TEXT NOT NULL,
  task_id TEXT,
  host_op_id TEXT,
  target TEXT NOT NULL,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','effect_unknown','canceled')),
  wait_reason TEXT,
  error_kind TEXT,
  error_message TEXT,
  platform_message_id TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  cancel_op_id TEXT,
  late_receipt TEXT,
  created_at TEXT NOT NULL,
  sending_at TEXT,
  settled_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (source_kind, source_key)
);
CREATE INDEX IF NOT EXISTS idx_notification_ops_status ON notification_ops (status, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_ops_task ON notification_ops (task_id);

-- v14：Telegram owner 入口（daily-agent issue 04）。单行配置：API 地址、凭据绑定名
-- （bot token 只在 CredentialStore）、固定 owner user_id + chat_id、启停；
-- config_version 随配置变化递增；last_update_id 是 long polling 偏移（入站事件
-- 持久化之后才推进，不递增配置版本）。
CREATE TABLE IF NOT EXISTS telegram_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_base TEXT NOT NULL,
  credential_name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_chat_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_version INTEGER NOT NULL DEFAULT 1,
  last_update_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- v23：长期操作授权（agent-direction issue 10）。不可变限定范围 + 版本化撤销/失效；
-- 同一 main 会话、同一入口(ch/account/chat/actor)与同一目标（机器/单元/动作）最多
-- 一条未撤销授权（部分唯一索引）；来源审批唯一（approval_id），持久保留删除记录不删行。
-- pinned_target/channel/account/chat_id/actor 不参与唯一键的修订指纹（policy/unit revision
-- 与配置代次只在使用资格核实中比对，不进唯一键）。
CREATE TABLE IF NOT EXISTS standing_permissions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('restart')),
  policy_revision TEXT NOT NULL,
  unit_revision TEXT NOT NULL,
  channel TEXT NOT NULL,
  account TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  pinned_target TEXT NOT NULL,
  approval_id TEXT NOT NULL UNIQUE,
  created_by_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_standing_permissions_active ON standing_permissions
  (session_id, channel, account, chat_id, actor, machine_id, unit, action) WHERE revoked_at IS NULL;

/*
 * v24（agent-direction issue 11）：工作委托 / SubAgent / 每次执行三个
 * 领域对象分开保存，与旧固定角色（agent_roles / tasks.agent_id）兼容共存；
 * 动态 ID 走新关联列，不改旧角色 CHECK，旧任务关联列恒为 NULL。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-03-work-delegation-subagent-task.md
 */
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

-- v28（agent-direction issue 21）：跨实例导入的回执与条目账本。旧实例开发资料
-- 经目标侧离线 legacy-import 迁入 Coding Agent（issue 22 增加镜像方向：个人资料
-- 迁入全新 ruukoto 实例，共用本两表）；回执持久保存（applied/reverted），
-- 供续跑幂等核实、回退与整库恢复定位；条目账本标识各项资料属于哪次导入，主键
-- (kind, item_id) 让同一资料至多归属一次导入。
-- v30（agent-direction issue 22）：条目类别扩五类（agent_role / schedule /
-- platform_config / standing_permission / credential），v28 / v29 库经重建迁移。
CREATE TABLE IF NOT EXISTS instance_imports (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  source_instance_id TEXT NOT NULL,
  source_product TEXT,
  source_schema_version INTEGER,
  source_dir TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  target_backup_path TEXT NOT NULL,
  target_backup_sha256 TEXT NOT NULL,
  event_seq_from INTEGER,
  event_seq_to INTEGER,
  report TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied','reverted')),
  created_at TEXT NOT NULL,
  reverted_at TEXT
);
CREATE TABLE IF NOT EXISTS instance_import_items (
  kind TEXT NOT NULL CHECK (kind IN
    ('project','session','sub_agent','work_delegation','memory','grant','mcp','meta','file',
     'agent_role','schedule','platform_config','standing_permission','credential')),
  item_id TEXT NOT NULL,
  import_id TEXT NOT NULL REFERENCES instance_imports(id),
  PRIMARY KEY (kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_instance_import_items_import ON instance_import_items (import_id);

-- v29（agent-direction issue 13）：工作内协作消息。同一项工作的参与者
--（主 Agent 与当前承接本工作的各 SubAgent）之间有来源的消息；幂等键按
--（工作, 发送方, 键）核实（from_sub_agent_id 为空 = 主 Agent，单独一段键空间）；
-- 投递为接收方的一次执行任务或父会话注入/唤醒任务，待投递行由宿主机在
-- 终态/启动/取消/关闭时冲刷，资格已失记 undelivered_reason。
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
/*
 * v56（mygo-agent-browser）：MyGo 桌面浏览器绑定。任务经已登记浏览器能力的
 * 桌面控制连接提交时，与任务同事务记录连接身份；连接断开绑定即失效，
 * 新连接不能继承旧句柄，绑定行不随实例导入迁移。
 */
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

export class Db {
  readonly file: string;
  private readonly db: DatabaseSync;
  /** 测试专用故障注入：下一次写入抛错（生产代码路径不设置）。 */
  faultNextWrite: Error | null = null;

  constructor(dataDir: string, file = "ruukoto.db") {
    this.file = path.join(dataDir, file);
    this.db = new DatabaseSync(this.file);
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
    // Note: 见 .agents/notes/implemented/simplification/2026-10-24-code-instance-mcp.md
    // Note: 见 .agents/notes/implemented/feature/2026-10-12-full-access-current-account.md
    if (row && version !== SCHEMA_VERSION) {
      this.db.close();
      throw new SchemaVersionError(version > SCHEMA_VERSION
        ? `schema 版本过新：文件 ${row.value}，程序 ${SCHEMA_VERSION}（需升级程序）`
        : `不支持旧 schema：文件 ${row.value}，程序 ${SCHEMA_VERSION}；请保留原库并使用新的数据目录，不回填执行授权`);
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.tx(() => {
      this.db.exec(SCHEMA_SQL);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING")
        .run(String(SCHEMA_VERSION));
    });
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
