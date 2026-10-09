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

export const SCHEMA_VERSION = 32;

const SCHEMA_SQL = `
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
  web_search TEXT NOT NULL DEFAULT 'enabled' CHECK (web_search IN ('enabled','disabled')),
  settings_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
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
  -- 工作区组织归属（agent-direction issue 07）：仅展示归属；资料身份仍是 project_id
  workspace_project_id TEXT REFERENCES projects(id),
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
  source_event_id TEXT,
  deadline TEXT,
  result_summary TEXT,
  result_ref TEXT,
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

-- issue 30：上下文压缩点（ADR 0016）。每个会话至多一个 active（部分唯一索引），
-- 新建时旧行改为 superseded；指纹不符时改为 invalidated。会话历史不受影响。
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
  task_id TEXT NOT NULL,
  call_index INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_checkpoints_active ON context_checkpoints (session_id) WHERE status = 'active';

-- v4 曾新增 GitHub 集成三表（github_repo_bindings / github_drafts /
-- github_publish_ops，issue 06）；v9（issue 17）起专用模块退役，新库不再创建。
-- 旧库的表保留为只读归档（不 DROP），退役迁移由 Runtime 启动时按表存在性执行
-- （src/runtime/github-retirement.ts），不依赖建表 SQL。

-- v8：MCP 服务配置（issue 16）——拥有者按项目管理的 MCP 服务；秘密值仍在
-- CredentialStore，本表只存凭据绑定名。config_version 随任何变化递增，
-- 任务开始钉版工具清单，调用前重读核对。
CREATE TABLE IF NOT EXISTS mcp_services (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  credential TEXT,
  tool_allowlist TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
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
  event_kind TEXT NOT NULL DEFAULT 'task' CHECK (event_kind IN ('task','im_approval')),
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
-- schedules：计划（时间规则 + 固定动作 + 来源快照；通知计划另固定目标与批准）。
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  owner_role TEXT NOT NULL DEFAULT 'main' CHECK (owner_role IN ('main')),
  create_key TEXT NOT NULL UNIQUE,
  params_digest TEXT NOT NULL,
  create_task_id TEXT,
  create_op_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('wake_main','notify','news')),
  rule TEXT NOT NULL,
  payload TEXT NOT NULL,
  target TEXT,
  approval_id TEXT,
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
  news_result TEXT,
  UNIQUE (schedule_id, schedule_version, scheduled_for)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_runs_open ON schedule_runs (schedule_id) WHERE closed_at IS NULL;
-- notification_ops：发送操作账本；(source_kind, source_key) 唯一即逻辑发送键。
-- 目标/正文/操作 id 发送前固定；pending（未领取）→ sending（已领取，可能已发出）
-- → sent / failed / effect_unknown（不自动重发）/ canceled。
CREATE TABLE IF NOT EXISTS notification_ops (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('schedule_run','confirmation','owner_reply','inbound_event')),
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

-- v24（agent-direction issue 11，ADR 0020）：工作委托 / SubAgent / 每次执行三个
-- 领域对象分开保存，与旧固定角色（agent_roles / tasks.agent_id）兼容共存；
-- 动态 ID 走新关联列，不改旧角色 CHECK，旧任务关联列恒为 NULL。
CREATE TABLE IF NOT EXISTS sub_agents (
  id TEXT PRIMARY KEY,
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
  to_sub_agent_id TEXT REFERENCES sub_agents(id),
  request_key TEXT NOT NULL,
  params_digest TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_task_id TEXT,
  delivered_at TEXT,
  undelivered_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_smsg_work ON subagent_messages (work_id);
CREATE INDEX IF NOT EXISTS idx_smsg_pending ON subagent_messages (parent_session_id, delivered_at);
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
      // 会话模式与新闻动作的 CHECK 需重建被引用的表；FK pragma 在事务内无效，
      // 必须在事务外关闭，提交前校验外键，结束后恢复。
      const rebuildModeChecks = row !== undefined && version < 6;
      const rebuildTables = row !== undefined && version < SCHEMA_VERSION;
      if (rebuildTables) this.db.exec("PRAGMA foreign_keys = OFF;");
      // 全新库或旧版本库都在一个事务里完成：建表 + 迁移 + 版本号，要么全成要么全不动
      try {
        this.db.exec("BEGIN IMMEDIATE");
        this.db.exec(SCHEMA_SQL);
        if (row && version < SCHEMA_VERSION) {
          this.migrateFrom(version);
        }
        this.ensureColumns();
        if (rebuildModeChecks) {
          this.rebuildModeCheckedTables();
        }
        if (rebuildTables) this.rebuildSessionModeCheck();
        if (rebuildTables && this.db.prepare("PRAGMA foreign_key_check").get()) {
          throw new Error("重建表后外键检查失败");
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
        if (rebuildTables) this.db.exec("PRAGMA foreign_keys = ON;");
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
    } else if (version >= 2 && version <= 31) {
      // v2 → v3：新增授权/记忆/历史索引/选择记录表；v3 → v4：新增 GitHub 表；
      // v4 → v5：模型选择补列；v6 → v7：projects.web_search 补列；
      // v7 → v8：新增 MCP 服务配置表；v8 → v9：无表结构变更（github_* 建表 SQL
      // 移除，旧库的表原样保留；退役迁移由 Runtime 启动时按表存在性执行）；
      // v9 → v10：新增 QQ 入口四表 + sessions.kind 补列（ensureColumns）；
      // v10 → v11：新增 agent_roles / inbound_events 两表 + tasks 编排补列
      // （ensureColumns）；
      // v11 → v12：projects/sessions 补 create_request_id 列 + 部分唯一索引
      // （ensureColumns，issue 21 创建幂等键）；
      // v12 → v13：新增 schedules / schedule_runs / notification_ops 三表（issue 03）；
      // v13 → v14：新增 telegram_config 表 + notification_ops.not_before 补列（issue 04）。
      // v14 → v15：qq_config.owner_user_id 与 inbound_events.reply_target（issue 06）。
      // v16 → v17：群结果接收记录与群收件的撤回时间、引用、配置版本。
      // v17 → v18：新闻采集快照补列；计划动作 CHECK 由下方重建处理。
      // v18 → v19：projects 补工作区根目录身份四列 + 部分唯一索引
      // （ensureColumns，agent-direction issue 05）。
      // v19 → v20：projects 补 settings_version 列（ensureColumns，agent-direction
      // issue 06），只保护指令列表与 Web Search；旧项目按列默认值取初始版本 1。
      // v20 → v21：sessions 补 workspace_project_id 组织归属列（ensureColumns，
      // agent-direction issue 07）；旧会话默认 NULL，不扫描目录、不迁移业务记录。
      // v21 → v22：inbound_events 补 event_kind 宿主类别列（ensureColumns，
      // agent-direction issue 08）；旧记录默认 task，历史入站与回执关系保留。
      // v22 → v23：新增 standing_permissions 表 + confirmations 补长期授权关联
      // 两列（ensureColumns，agent-direction issue 10）；迁移不产生任何授权、
      // 不改旧批准事实（旧记录关联列恒为 NULL）。
      // v23 → v24：新增 sub_agents / work_delegations 两表 + tasks 补四个关联
      // 列（ensureColumns，agent-direction issue 11）；旧角色、会话、任务、审批、
      // 长期授权、历史及产物原样保留，旧任务关联列为空。
      // v24 → v25：sub_agents 补 closed_at / closed_by 两列（ensureColumns，
      // agent-direction issue 12）；旧 Agent 两列为空（未关闭），state 语义不变。
      // v25 → v26：work_delegations 补 canceled_at / canceled_by / cancel_reason
      // 三列（ensureColumns，agent-direction issue 14）；旧工作三列为空（未取消）。
      // v26 → v27：work_delegations 补 write_target 列（ensureColumns，
      // agent-direction issue 16）；旧工作恒为 NULL（只读分析工作，不扫描、
      // 不改写旧记录）。
      // v27 → v28：新增 instance_imports / instance_import_items 两表
      // （SCHEMA_SQL 幂等建表，agent-direction issue 21 跨实例导入账本）；
      // 旧库两表为空，不扫描、不回填。
      // v28 → v29：新增 subagent_messages 表（SCHEMA_SQL 幂等建表，
      // agent-direction issue 13 工作内协作消息）；旧库表为空，不回填。
      // v29 → v30：instance_import_items 的类别 CHECK 扩五类（agent-direction
      // issue 22 个人方向导入）；CHECK 变更由下方重建处理，账本行原样保留。
      // v30 → v31：新增入站图片暂存两表，artifacts 补 MIME/hash；旧产物两列为空。
      // v31 → v32：tasks 补 plan_mode（默认 false）；会话默认 CHECK 加入 plan，
      // 由统一重建步骤处理，不从旧任务输入推导计划状态。
      // 均为 SCHEMA_SQL 幂等建表覆盖 + 补列；v5 → v6 的 CHECK 变更由重建步骤
      // 统一处理；旧撤回记录的时间在 ensureColumns 中保守回填。
      this.ensureColumns();
    } else {
      throw new Error(`不支持从 schema v${version} 迁移`);
    }
    // v16：允许宿主为入站事件登记通知；旧发送账本的状态与逻辑键原样保留。
    if (version >= 13 && version <= 15) this.rebuildNotificationSourceCheck();
    // v18：新闻计划复用调度运行与通知 outbox，保留旧计划和运行的引用关系。
    if (version >= 13 && version <= 17) this.rebuildScheduleActionCheck();
    // v30：条目账本类别扩五类；既有回执与账本行逐行复制保留。
    // v28 起的库既有表带着旧 CHECK（v29 的 subagent_messages 不动本表），都重建。
    if (version >= 28 && version <= 29) this.rebuildImportItemsKindCheck();
  }

  /** v30：重建条目账本类别 CHECK；调用前外键已在事务外关闭。 */
  private rebuildImportItemsKindCheck(): void {
    this.db.exec(`
CREATE TABLE instance_import_items_new (
  kind TEXT NOT NULL CHECK (kind IN
    ('project','session','sub_agent','work_delegation','memory','grant','mcp','meta','file',
     'agent_role','schedule','platform_config','standing_permission','credential')),
  item_id TEXT NOT NULL,
  import_id TEXT NOT NULL REFERENCES instance_imports(id),
  PRIMARY KEY (kind, item_id)
);
INSERT INTO instance_import_items_new (kind, item_id, import_id)
SELECT kind, item_id, import_id FROM instance_import_items;
DROP TABLE instance_import_items;
ALTER TABLE instance_import_items_new RENAME TO instance_import_items;
CREATE INDEX idx_instance_import_items_import ON instance_import_items (import_id);
`);
  }

  /** v18：重建计划动作 CHECK；调用前外键已在事务外关闭。 */
  private rebuildScheduleActionCheck(): void {
    this.db.exec(`
CREATE TABLE schedules_new (
  id TEXT PRIMARY KEY,
  owner_role TEXT NOT NULL DEFAULT 'main' CHECK (owner_role IN ('main')),
  create_key TEXT NOT NULL UNIQUE,
  params_digest TEXT NOT NULL,
  create_task_id TEXT,
  create_op_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('wake_main','notify','news')),
  rule TEXT NOT NULL,
  payload TEXT NOT NULL,
  target TEXT,
  approval_id TEXT,
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
INSERT INTO schedules_new (id, owner_role, create_key, params_digest, create_task_id, create_op_id,
  action, rule, payload, target, approval_id, status, next_due_at, current_run_id, version,
  tz_data, reason, cancel_reason, cancel_op_id, created_at, updated_at)
SELECT id, owner_role, create_key, params_digest, create_task_id, create_op_id,
  action, rule, payload, target, approval_id, status, next_due_at, current_run_id, version,
  tz_data, reason, cancel_reason, cancel_op_id, created_at, updated_at
FROM schedules;
DROP TABLE schedules;
ALTER TABLE schedules_new RENAME TO schedules;
CREATE INDEX idx_schedules_due ON schedules (status, next_due_at);
`);
  }

  /** SQLite 的 CHECK 变更需要重建表；限流时间与所有发送事实均显式复制。 */
  private rebuildNotificationSourceCheck(): void {
    this.db.exec(`
CREATE TABLE notification_ops_new (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('schedule_run','confirmation','owner_reply','inbound_event')),
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
  not_before TEXT,
  UNIQUE (source_kind, source_key)
);
INSERT INTO notification_ops_new (id, source_kind, source_key, task_id, host_op_id, target, text,
  text_sha256, source_refs, status, wait_reason, error_kind, error_message, platform_message_id,
  cancel_requested, cancel_op_id, late_receipt, created_at, sending_at, settled_at, updated_at, not_before)
SELECT id, source_kind, source_key, task_id, host_op_id, target, text,
  text_sha256, source_refs, status, wait_reason, error_kind, error_message, platform_message_id,
  cancel_requested, cancel_op_id, late_receipt, created_at, sending_at, settled_at, updated_at, not_before
FROM notification_ops;
DROP TABLE notification_ops;
ALTER TABLE notification_ops_new RENAME TO notification_ops;
CREATE INDEX idx_notification_ops_status ON notification_ops (status, created_at);
CREATE INDEX idx_notification_ops_task ON notification_ops (task_id);
`);
  }

  /**
   * v6：tasks 的访问模式 CHECK 加入 'auto-review'。SQLite 不能修改
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
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  model_selection TEXT,
  submission_digest TEXT,
  agent_id TEXT CHECK (agent_id IS NULL OR agent_id IN ('main','coding','chat')),
  parent_task_id TEXT,
  source_event_id TEXT,
  deadline TEXT,
  result_summary TEXT,
  result_ref TEXT,
  work_id TEXT,
  sub_agent_id TEXT,
  read_scope TEXT,
  result_delivered_at TEXT,
  UNIQUE (session_id, request_id)
);
INSERT INTO tasks_new (id, session_id, request_id, input, status, access_mode, plan_mode, permission_version,
  granted_paths, pending_access_mode, interrupt_reason, cancel_requested, effect_unknown, error_message,
  history_entry_ids, resumes_task_id, created_at, started_at, ended_at, model_selection, submission_digest,
  agent_id, parent_task_id, source_event_id, deadline, result_summary, result_ref,
  work_id, sub_agent_id, read_scope, result_delivered_at)
SELECT id, session_id, request_id, input, status, access_mode, plan_mode, permission_version,
  granted_paths, pending_access_mode, interrupt_reason, cancel_requested, effect_unknown, error_message,
  history_entry_ids, resumes_task_id, created_at, started_at, ended_at, model_selection, submission_digest,
  agent_id, parent_task_id, source_event_id, deadline, result_summary, result_ref,
  work_id, sub_agent_id, read_scope, result_delivered_at
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX IF NOT EXISTS idx_tasks_session_created ON tasks (session_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks (deadline);
CREATE INDEX IF NOT EXISTS idx_tasks_work ON tasks (work_id);
CREATE INDEX IF NOT EXISTS idx_tasks_sub_agent ON tasks (sub_agent_id);
`);
  }

  /** v32：会话默认 CHECK 加入 plan；全部既有字段与外键关系原样保留。 */
  private rebuildSessionModeCheck(): void {
    this.db.exec(`
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
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
  workspace_project_id TEXT REFERENCES projects(id),
  created_at TEXT NOT NULL,
  model_selection TEXT,
  model_selection_version INTEGER NOT NULL DEFAULT 0,
  default_access_mode TEXT NOT NULL DEFAULT 'confirm' CHECK (default_access_mode IN ('confirm','full_access','auto-review','plan')),
  default_access_mode_version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sessions_new (id, project_id, kind, cwd, cwd_real, cwd_dev, cwd_ino, pi_session_id, session_file,
  confirm_tools, create_request_id, queue_state, queue_pause_reason, created_at, model_selection, model_selection_version,
  default_access_mode, default_access_mode_version, workspace_project_id)
SELECT id, project_id, kind, cwd, cwd_real, cwd_dev, cwd_ino, pi_session_id, session_file,
  confirm_tools, create_request_id, queue_state, queue_pause_reason, created_at, model_selection, model_selection_version,
  default_access_mode, default_access_mode_version, workspace_project_id
FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_create_request ON sessions (create_request_id) WHERE create_request_id IS NOT NULL;
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
    add("artifacts", "mime_type", "mime_type TEXT CHECK (mime_type IS NULL OR mime_type IN ('image/jpeg','image/png','image/webp'))");
    add("artifacts", "content_hash", "content_hash TEXT");
    add("sessions", "model_selection", "model_selection TEXT");
    add("sessions", "model_selection_version", "model_selection_version INTEGER NOT NULL DEFAULT 0");
    add("sessions", "default_access_mode", "default_access_mode TEXT NOT NULL DEFAULT 'confirm' CHECK (default_access_mode IN ('confirm','full_access','auto-review','plan'))");
    add("sessions", "default_access_mode_version", "default_access_mode_version INTEGER NOT NULL DEFAULT 0");
    add("tasks", "model_selection", "model_selection TEXT");
    add("tasks", "submission_digest", "submission_digest TEXT");
    add("tasks", "plan_mode", "plan_mode INTEGER NOT NULL DEFAULT 0 CHECK (plan_mode IN (0,1))");
    add("projects", "instruction_files", "instruction_files TEXT NOT NULL DEFAULT '[]'");
    // v7（issue 20）：项目级 Web Search 开关，默认启用，拥有者可显式禁用
    add("projects", "web_search", "web_search TEXT NOT NULL DEFAULT 'enabled' CHECK (web_search IN ('enabled','disabled'))");
    add("selection_records", "instruction_version", "instruction_version TEXT NOT NULL DEFAULT ''");
    // issue 22：技能库钉版版本
    add("selection_records", "skill_version", "skill_version TEXT NOT NULL DEFAULT ''");
    add("selection_records", "capped_tool_results", "capped_tool_results TEXT NOT NULL DEFAULT '[]'");
    add("selection_records", "prompt_artifact", "prompt_artifact TEXT");
    add("selection_records", "window_snapshot", "window_snapshot TEXT");
    add("selection_records", "experiment", "experiment TEXT");
    // issue 30：本次视图使用的压缩点
    add("selection_records", "checkpoint_id", "checkpoint_id TEXT");
    // v10（issue 07）：会话入口类别（dev / qq_group）
    add("sessions", "kind", "kind TEXT NOT NULL DEFAULT 'dev' CHECK (kind IN ('dev','qq_group'))");
    // v11（issue 01）：任务编排字段（逻辑角色 / 父任务 / 来源事件 / 截止 / 结果）
    add("tasks", "agent_id", "agent_id TEXT CHECK (agent_id IS NULL OR agent_id IN ('main','coding','chat'))");
    add("tasks", "parent_task_id", "parent_task_id TEXT");
    add("tasks", "source_event_id", "source_event_id TEXT");
    add("tasks", "deadline", "deadline TEXT");
    add("tasks", "result_summary", "result_summary TEXT");
    add("tasks", "result_ref", "result_ref TEXT");
    // v14（issue 04）：限流退回的发送操作最早再次领取时间
    add("notification_ops", "not_before", "not_before TEXT");
    // v18（issue 07）：宿主持久化的有界新闻采集快照与状态，旧运行默认无快照。
    add("schedule_runs", "news_result", "news_result TEXT");
    // v15（issue 06）：私聊身份与入站时钉版的固定回复目标，旧群配置默认不开私聊
    add("qq_config", "owner_user_id", "owner_user_id TEXT");
    add("inbound_events", "reply_target", "reply_target TEXT");
    add("qq_inbox", "recalled_at", "recalled_at TEXT");
    add("qq_inbox", "reply_to_message_id", "reply_to_message_id TEXT");
    add("qq_inbox", "config_version", "config_version INTEGER");
    // 旧撤回记录的确切时刻不可恢复，保守地令既有摘要失效；原始历史保留。
    this.db.prepare("UPDATE qq_inbox SET recalled_at = ? WHERE recalled = 1 AND recalled_at IS NULL").run(new Date().toISOString());
    // 新列索引只能在补列之后创建（旧库先 ALTER 才有列；重建路径自带索引重建）
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks (deadline)");
    // v6（issue 15）：审批记录上的自动审查字段；可空，旧记录按历史人工审批展示
    add("confirmations", "review_status", "review_status TEXT");
    add("confirmations", "review_decision", "review_decision TEXT");
    add("confirmations", "review_reason", "review_reason TEXT");
    add("confirmations", "review_model", "review_model TEXT");
    add("confirmations", "review_policy_version", "review_policy_version TEXT");
    add("confirmations", "decision_source", "decision_source TEXT");
    // v12（issue 21）：create_project/create_session 的创建幂等键；部分唯一索引
    // （NULL 不参与）让无键创建的旧行为不受影响，索引只在补列后创建
    add("projects", "create_request_id", "create_request_id TEXT");
    add("sessions", "create_request_id", "create_request_id TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_create_request ON projects (create_request_id) WHERE create_request_id IS NOT NULL");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_create_request ON sessions (create_request_id) WHERE create_request_id IS NOT NULL");
    // v19（agent-direction issue 05）：工作区根目录身份；部分唯一索引让同一真实
    // 目录至多一个工作区（NULL 不参与，旧项目不受影响），索引只在补列后创建
    add("projects", "root_cwd", "root_cwd TEXT");
    add("projects", "root_real", "root_real TEXT");
    add("projects", "root_dev", "root_dev INTEGER");
    add("projects", "root_ino", "root_ino INTEGER");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_root_real ON projects (root_real) WHERE root_real IS NOT NULL");
    // v20（agent-direction issue 06）：指令列表与 Web Search 的乐观并发版本；
    // 列默认值 1 即旧项目初始版本，不复制旧字段
    add("projects", "settings_version", "settings_version INTEGER NOT NULL DEFAULT 1");
    // v21（agent-direction issue 07）：会话工作区组织归属（仅展示归属，资料身份
    // 仍是 project_id）；旧会话默认 NULL
    add("sessions", "workspace_project_id", "workspace_project_id TEXT REFERENCES projects(id)");
    // v22（agent-direction issue 08）：入站事件宿主类别（区分普通任务入站与 IM
    // 审批控制消息）；旧记录默认 task
    add("inbound_events", "event_kind", "event_kind TEXT NOT NULL DEFAULT 'task' CHECK (event_kind IN ('task','im_approval'))");
    // v23（agent-direction issue 10）：批准的长期授权关联（可空，旧批准恒为空；
    // 迁移不把历史单次批准转换成长期授权）
    add("confirmations", "standing_permission_id", "standing_permission_id TEXT");
    add("confirmations", "standing_permission_version", "standing_permission_version INTEGER");
    // v24（agent-direction issue 11）：任务关联工作委托与 SubAgent 身份、钉定
    // 只读范围与结果注入标记；旧任务所有新列恒为 NULL，不把旧 coding 身份或
    // 历史任务改造成新 Agent。
    add("tasks", "work_id", "work_id TEXT");
    add("tasks", "sub_agent_id", "sub_agent_id TEXT");
    add("tasks", "read_scope", "read_scope TEXT");
    add("tasks", "result_delivered_at", "result_delivered_at TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_work ON tasks (work_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_sub_agent ON tasks (sub_agent_id)");
    // v25（agent-direction issue 12）：显式关闭。关闭用独立列，不改 state CHECK；
    // 旧行两列为空（未关闭），不扫描、不改写旧记录。
    add("sub_agents", "closed_at", "closed_at TEXT");
    add("sub_agents", "closed_by", "closed_by TEXT");
    // v26（agent-direction issue 14）：整项工作取消。独立列、一次写入；
    // 旧行三列为空（未取消），不扫描、不改写旧记录。
    add("work_delegations", "canceled_at", "canceled_at TEXT");
    add("work_delegations", "canceled_by", "canceled_by TEXT");
    add("work_delegations", "cancel_reason", "cancel_reason TEXT");
    // v27（agent-direction issue 16）：工作的写入目标（WorkWriteTarget JSON）；
    // 独立列、首次委派钉定、继续沿用；旧行恒为空（只读分析工作，不升级）。
    add("work_delegations", "write_target", "write_target TEXT");
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
