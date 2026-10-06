/**
 * 旧实例个人资料迁入全新 ruukoto 实例（agent-direction issue 22，ADR 0023）：
 * issue 21 跨实例导入的镜像方向。拥有者把旧 main 会话、应用数据、调度、平台
 * 绑定与必要凭据迁入独立的 Personal Agent，旧 coding/chat 档案与发送事实保留
 * 为可核查的只读归档。
 *
 * 本模块只做方向判断与转换；快照、目标副本、表登记核对、账本、逐行插入等
 * 方向无关机制复用 ./legacy-import.ts 的导出。CLI（ruukoto legacy-import）只
 * 做离线接线，不走控制面。边界：
 * - 源与目标同为 ruukoto 产品（或均未登记），不同数据目录：目标为全新实例
 *   （无自有角色行，或仅有同源此前导入）；源或目标后台存活、源与目标同路径
 *   或同实例 ID 都拒绝。
 * - 导入单位 = 角色会话（main/coding/chat，含一层 SubAgent）与 QQ 群会话及
 *   其项目；普通 dev 会话一律排除（经 issue 21 迁入 Coding Agent）。行 ID
 *   原样保留，app_audit、记忆 sourceRefs、发送钉版与审批关联不断链。
 * - 不重放：任务/审批收尾与 21 同口径；未关闭调度运行置 closed_at；发送账本
 *   pending→canceled（已知未发送，不当作新请求重发）、sending→effect_unknown；
 *   入站 registered/queued→failed；SubAgent 按关闭状态登记。main 会话的访问
 *   模式原样保留（同产品延续，不做降级）。
 * - 交接：平台配置（qq/telegram，含 config_version 与 telegram last_update_id）
 *   与活动调度原样接管，旧实例不得再启动消费同一入站或同一批通知（见运行
 *   文档）；长期授权原样导入（身份链在目标逐次核实，不符即 fail-closed）。
 * - 必要凭据：平台配置引用的绑定与 purpose=github_webhook 的绑定从源
 *   credentials.json 合并进目标（同名同值跳过、异值冲突拒绝）；报告只记
 *   sha256。MCP/Jev 凭据不复制，缺绑定停用导入（规则与 21 相同）。
 * - 源全程只读、幂等续跑、账本回退与 21 相同；调度运行/发送/入站/群与
 *   GitHub 归档按报告 manifest（id + 逐行 sha256）续跑去重与回退核对，
 *   目标启动后的自有活动（含对导入行的运行时改写）是回退阻挡项。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db, SCHEMA_VERSION } from "../core/db.ts";
import { PRODUCT_META_KEY } from "../core/product.ts";
import { randomId, type Session } from "../core/types.ts";
import type { CredentialBinding } from "../agent/execution/credentials.ts";
import { canonicalJson, historyStatusOf, sha256 } from "./workspace-migration.ts";
import {
  fail,
  type TablePolicy,
  type LedgerKind,
  type Row,
  allRows,
  rowsIn,
  columnNames,
  sha256File,
  checkTablePolicy,
  type SourceSnapshot,
  openSourceSnapshot,
  readMetaValue,
  type TargetView,
  openTargetReadonlyCopy,
  strictDirOk,
  memoryRefsInScope,
  readLedger,
  insertRows,
  escapeSqlPath,
  type FilePlanItem,
  type TaskClosing,
  type LegacyImportDeps,
  type LegacyImportApplyResult,
  type LegacyImportRevertResult,
  listLegacyImports,
} from "./legacy-import.ts";

export { listLegacyImports };
export { LegacyImportError } from "./legacy-import.ts";

// ---------- 表级策略：个人方向的登记（allow-list，未登记即拒绝） ----------

const TABLE_POLICY: TablePolicy = {
  projects: { policy: "import" },
  sessions: { policy: "import" },
  tasks: { policy: "import" },
  tool_ops: { policy: "import" },
  confirmations: { policy: "import" },
  artifacts: { policy: "import" },
  events: { policy: "import" },
  selection_records: { policy: "import" },
  context_checkpoints: { policy: "import" },
  memories: { policy: "import" },
  memory_versions: { policy: "import" },
  data_grants: { policy: "import" },
  mcp_services: { policy: "import" },
  sub_agents: { policy: "import" },
  work_delegations: { policy: "import" },
  // 工作内消息（agent-direction issue 13）：随所属工作的账本条目折叠（不设新
  // 账本类别——行只属其工作，工作的续跑跳过与回退删除同时覆盖它）
  subagent_messages: { policy: "import" },
  meta: { policy: "import" }, // 仅 app_data.main_instance_id / github_retirement_done / jev.project.<导入项目> 键
  agent_roles: { policy: "import" },
  inbound_events: { policy: "import" },
  chat_result_acceptances: { policy: "import" },
  schedules: { policy: "import" },
  schedule_runs: { policy: "import" },
  notification_ops: { policy: "import" },
  standing_permissions: { policy: "import" },
  qq_config: { policy: "import" },
  qq_sessions: { policy: "import" },
  qq_inbox: { policy: "import" },
  qq_outbox: { policy: "import" },
  telegram_config: { policy: "import" },
  github_repo_bindings: { policy: "import" },
  github_drafts: { policy: "import" },
  github_publish_ops: { policy: "import" },
  history_index: { policy: "exclude", reason: "可重建的派生索引，目标启动时重建" },
  history_index_state: { policy: "exclude", reason: "可重建的派生索引状态" },
  occupancy: { policy: "exclude", reason: "运行时目录占用，不属于资料" },
  instance_imports: { policy: "exclude", reason: "导入账本属目标实例自身，不从源复制" },
  instance_import_items: { policy: "exclude", reason: "导入账本属目标实例自身，不从源复制" },
};

/** 随导入的 meta 键（instance_id / schema_version / product.type / ws-mig 回执等一律不迁）。 */
const IMPORT_META_KEYS = ["app_data.main_instance_id", "github_retirement_done"];

// ---------- 计划与快照 ----------

/** 拥有者在计划文件中的显式选择（个人方向：仅项目改名；personal 记忆同产品延续，不需选中）。 */
export interface PersonalImportPlan {
  renames?: Record<string, string>;
}

interface AppDataSnapshot {
  /** 快照目录内的副本路径（main.db；WAL 一并复制在旁）。 */
  file: string | null;
  walFile: string | null;
  sourceFile: string | null;
  bytes: number;
  sha256: string | null;
  walSha256: string | null;
  present: boolean;
  corrupt: boolean;
  tables: number;
  auditRows: number;
  /** app_meta 的 instance_id / revision（绑定核对与预览展示用）。 */
  appMeta: Record<string, string>;
}

interface PersonalSnapshot extends SourceSnapshot {
  appData: AppDataSnapshot;
  /** 源 credentials.json 路径与按名的绑定视图（只在本进程内持有秘密值）。 */
  credentialsFile: string | null;
  credentials: Map<string, CredentialBinding>;
  agentDirNames: string[];
}

function readCredentialsFile(file: string): Map<string, CredentialBinding> {
  const out = new Map<string, CredentialBinding>();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { bindings?: CredentialBinding[] };
    for (const b of raw.bindings ?? []) out.set(String(b.name), b);
  } catch {
    // 无凭据文件或损坏：按无绑定处理，平台配置导入后如实列出缺口
  }
  return out;
}

/** 源快照 + 应用数据副本 + 源凭据视图（都在同一临时目录复制，源目录零接触）。 */
function openPersonalSnapshot(from: string): PersonalSnapshot {
  const snap = openSourceSnapshot(from);
  try {
    const appDir = path.join(snap.dataDir, "agent-data");
    const srcDb = path.join(appDir, "main.db");
    const appData: AppDataSnapshot = {
      file: null,
      walFile: null,
      sourceFile: fs.existsSync(srcDb) ? srcDb : null,
      bytes: 0,
      sha256: null,
      walSha256: null,
      present: false,
      corrupt: false,
      tables: 0,
      auditRows: 0,
      appMeta: {},
    };
    if (appData.sourceFile !== null) {
      appData.present = true;
      appData.file = path.join(snap.dir, "agent-data-main.db");
      fs.copyFileSync(srcDb, appData.file);
      appData.bytes = fs.statSync(srcDb).size;
      appData.sha256 = sha256File(srcDb);
      const srcWal = srcDb + "-wal";
      if (fs.existsSync(srcWal)) {
        appData.walFile = appData.file + "-wal";
        fs.copyFileSync(srcWal, appData.walFile);
        appData.walSha256 = sha256File(srcWal);
      }
      try {
        const raw = new DatabaseSync(appData.file);
        try {
          for (const r of raw.prepare("SELECT key, value FROM app_meta").all() as unknown as Array<{ key: string; value: string }>) {
            appData.appMeta[String(r.key)] = String(r.value);
          }
          appData.tables = Number((raw.prepare("SELECT count(*) c FROM app_tables").get() as { c: number }).c);
          appData.auditRows = Number((raw.prepare("SELECT count(*) c FROM app_audit").get() as { c: number }).c);
        } finally {
          raw.close();
        }
      } catch {
        appData.corrupt = true;
      }
    }
    const sourceAgentDir = path.join(path.dirname(snap.dataDir), "agent");
    const credentialsFile = path.join(sourceAgentDir, "credentials.json");
    let agentDirNames: string[] = [];
    try {
      agentDirNames = fs.readdirSync(sourceAgentDir).sort();
    } catch {
      agentDirNames = [];
    }
    return {
      ...snap,
      appData,
      credentialsFile: fs.existsSync(credentialsFile) ? credentialsFile : null,
      credentials: readCredentialsFile(credentialsFile),
      agentDirNames,
    };
  } catch (err) {
    snap.cleanup();
    throw err;
  }
}

// ---------- 目标产品 / 自我迁入防护 ----------

function checkTargetProduct(product: string | null, schemaVersion: number | null, exists: boolean): void {
  if (product !== null && product !== "ruukoto") {
    fail("product_mismatch", `目标数据目录已登记为产品 ${product}，legacy-import（个人方向）只能迁入 ruukoto 档案`);
  }
  if (exists && schemaVersion !== SCHEMA_VERSION) {
    fail(
      "target_schema",
      `目标库 schema 版本为 ${schemaVersion}（当前程序 ${SCHEMA_VERSION}）；请先启动一次 ruukoto 后台完成迁移，再执行导入`,
    );
  }
}

function checkNotSelf(snap: SourceSnapshot, deps: LegacyImportDeps, target?: TargetView): void {
  if (path.resolve(deps.targetDataDir) === snap.dataDir) {
    fail("invalid_params", "源与目标是同一数据目录；个人迁入要求目标为另一目录的全新实例");
  }
  if (target?.exists && target.instanceId !== null && target.instanceId === snap.instanceId) {
    fail("invalid_params", "源与目标的数据实例 ID 相同（同一实例或其副本）；个人迁入要求目标为全新实例");
  }
}

// ---------- 导入集合与各项决策 ----------

interface CredentialPlanItem {
  name: string;
  purpose: string | null;
  /** 源 credentials.json 中是否有该绑定。 */
  presentInSource: boolean;
  /** 绑定整行规范化 sha256（含秘密值哈希，只进报告与回退核对，不落秘密）。 */
  sha256: string | null;
  /** apply 填：copy / skip_same / conflict（目标同名异值）。 */
  action?: "copy" | "skip_same" | "conflict";
  /** 内部持有：apply 写入目标；序列化报告时剔除。 */
  binding?: CredentialBinding;
}

/** 报告 manifest 行：易变表的导入行快照（续跑去重与回退核对共用）。 */
interface ManifestRow {
  table: string;
  id: string;
  sha: string;
}

interface OpSettle {
  id: string;
  from: string;
  to: "canceled" | "effect_unknown" | "failed" | "closed";
}

interface PersonalImportSet {
  roles: Row[];
  projects: Row[];
  sessions: Row[];
  subAgents: Row[];
  workDelegations: Row[];
  subagentMessages: Row[];
  tasks: Row[];
  toolOps: Row[];
  confirmations: Row[];
  artifacts: Row[];
  selectionRecords: Row[];
  checkpoints: Row[];
  events: Row[];
  memoriesImport: Row[];
  memoryVersions: Row[];
  grantsImport: Row[];
  mcps: Row[];
  metas: Row[];
  schedules: Row[];
  scheduleRuns: Row[];
  notificationOps: Row[];
  inboundEvents: Row[];
  standingPermissions: Row[];
  qqConfig: Row | null;
  telegramConfig: Row | null;
  qqSessions: Row[];
  qqInbox: Row[];
  qqOutbox: Row[];
  chatResultAcceptances: Row[];
  githubRepoBindings: Row[];
  githubDrafts: Row[];
  githubPublishOps: Row[];
  files: FilePlanItem[];
  credentials: CredentialPlanItem[];
  /** 收尾决策（apply 转换与报告共用）。 */
  closings: TaskClosing[];
  staleConfirmations: string[];
  effectUnknownTasks: string[];
  effectUnknownOps: string[];
  runClosings: string[]; // 未关闭调度运行 → closed_at
  opSettles: OpSettle[]; // 发送账本 pending→canceled / sending→effect_unknown
  eventSettles: string[]; // 入站 registered/queued → failed
  fullAccessKept: string[]; // 保留 full_access 的会话（同产品延续，不降级）
  memoryPending: Array<{ id: string; scope: string; reason: string }>;
  grantsCrossInstance: Row[];
  excludedProjects: Array<{ id: string; name: string; reason: string }>;
  excludedSessions: Array<{ id: string; project_id: string; reason: string }>;
  missingFiles: Array<{ item: string; path: string }>;
  appDataBinding: { metaPresent: boolean; matches: boolean; note: string };
}

function nullableTable(db: Db, table: string): Row[] {
  try {
    return allRows(db, `SELECT * FROM ${table}`);
  } catch {
    return []; // v9 起新库没有 github_* 三表
  }
}

function buildImportSet(snap: PersonalSnapshot, deps: LegacyImportDeps): PersonalImportSet {
  const db = snap.db;
  const projects = allRows(db, "SELECT * FROM projects");
  const sessions = allRows(db, "SELECT * FROM sessions");
  const roles = allRows(db, "SELECT * FROM agent_roles");
  const roleBySession = new Map(roles.map((r) => [String(r.session_id), r]));
  const qqBindRows = allRows(db, "SELECT * FROM qq_sessions");
  const qqSessionIds = new Set(qqBindRows.map((r) => String(r.session_id)));
  const subAgents = allRows(db, "SELECT * FROM sub_agents");
  const subAgentBySession = new Map(subAgents.map((r) => [String(r.session_id), r]));

  // 导入单位：角色绑定会话（main/coding/chat）+ QQ 群会话 + 父会话导入的 SubAgent 子会话
  const baseSessions = sessions.filter((s) => roleBySession.has(String(s.id)) || qqSessionIds.has(String(s.id)));
  const baseIds = new Set(baseSessions.map((s) => String(s.id)));
  const includedSessions = sessions.filter((s) => {
    if (baseIds.has(String(s.id))) return true;
    const sub = subAgentBySession.get(String(s.id));
    return sub !== undefined && baseIds.has(String(sub.parent_session_id));
  });
  const sessionIds = new Set(includedSessions.map((s) => String(s.id)));

  const excludedSessions: PersonalImportSet["excludedSessions"] = [];
  for (const s of sessions) {
    if (sessionIds.has(String(s.id))) continue;
    const reason = subAgentBySession.has(String(s.id))
      ? "SubAgent 子会话的父会话为 dev 会话，随父留在源实例（经 issue 21 迁入 Coding Agent）"
      : "普通 dev 会话，经 issue 21 迁入 Coding Agent（ruukoto-dev legacy-import）";
    excludedSessions.push({ id: String(s.id), project_id: String(s.project_id), reason });
  }

  const includedProjects = projects.filter((p) => includedSessions.some((s) => String(s.project_id) === String(p.id)));
  const projectIds = new Set(includedProjects.map((p) => String(p.id)));
  const excludedProjects: PersonalImportSet["excludedProjects"] = [];
  for (const p of projects) {
    if (!projectIds.has(String(p.id))) {
      excludedProjects.push({ id: String(p.id), name: String(p.name), reason: "普通 dev 项目（经 issue 21 迁入 Coding Agent）或没有可导入会话" });
    }
  }

  const sessionIdList = [...sessionIds];
  const tasks = rowsIn(db, "tasks", "session_id", sessionIdList);
  const taskIds = new Set(tasks.map((t) => String(t.id)));
  const toolOps = rowsIn(db, "tool_ops", "task_id", [...taskIds]);
  const confirmations = rowsIn(db, "confirmations", "session_id", sessionIdList);
  const artifacts = rowsIn(db, "artifacts", "session_id", sessionIdList);
  const selectionRecords = rowsIn(db, "selection_records", "session_id", sessionIdList);
  const checkpoints = rowsIn(db, "context_checkpoints", "session_id", sessionIdList);
  const events = allRows(
    db,
    `SELECT * FROM events WHERE (session_id IS NOT NULL AND session_id IN (${sessionIdList.map(() => "?").join(",") || "''"}))
       OR (task_id IS NOT NULL AND task_id IN (${[...taskIds].map(() => "?").join(",") || "''"})) ORDER BY seq`,
    [...sessionIdList, ...taskIds],
  );

  // 不重放收尾：任务/审批口径与运行时恢复一致（同 21）
  const closings: TaskClosing[] = [];
  const staleConfirmations: string[] = [];
  const effectUnknownTasks: string[] = [];
  const unconsumedApprovalOpIds = new Set(
    confirmations.filter((c) => c.consumed_at === null && (c.status === "pending" || c.status === "approved")).map((c) => String(c.tool_op_id)),
  );
  const effectUnknownOpIds = new Set<string>();
  for (const t of tasks) {
    const status = String(t.status);
    if (status === "queued") {
      closings.push({ task_id: String(t.id), from: status, to: "canceled" });
    } else if (status === "running" || status === "awaiting_confirmation") {
      closings.push({ task_id: String(t.id), from: status, to: "interrupted" });
      let hasUnknown = false;
      for (const op of toolOps) {
        if (String(op.task_id) !== String(t.id)) continue;
        if (op.result_summary !== null || unconsumedApprovalOpIds.has(String(op.id))) continue;
        effectUnknownOpIds.add(String(op.id));
        hasUnknown = true;
      }
      if (hasUnknown) effectUnknownTasks.push(String(t.id));
    }
  }
  for (const c of confirmations) {
    const status = String(c.status);
    if (status === "pending" || (status === "approved" && c.consumed_at === null)) staleConfirmations.push(String(c.id));
  }
  const fullAccessKept = includedSessions.filter((s) => s.default_access_mode === "full_access").map((s) => String(s.id));

  const schedules = allRows(db, "SELECT * FROM schedules");
  const scheduleRuns = allRows(db, "SELECT * FROM schedule_runs");
  const runClosings = scheduleRuns.filter((r) => r.closed_at === null).map((r) => String(r.id));
  const notificationOps = allRows(db, "SELECT * FROM notification_ops");
  const opSettles: OpSettle[] = [];
  for (const op of notificationOps) {
    const status = String(op.status);
    if (status === "pending") opSettles.push({ id: String(op.id), from: status, to: "canceled" });
    else if (status === "sending") opSettles.push({ id: String(op.id), from: status, to: "effect_unknown" });
  }
  const inboundEvents = allRows(db, "SELECT * FROM inbound_events");
  const eventSettles = inboundEvents.filter((e) => e.status === "registered" || e.status === "queued").map((e) => String(e.id));

  // 记忆：项目记忆与 personal 记忆都只受来源规则约束（同产品延续，personal 不需计划选中）
  const artifactSession = new Map(artifacts.map((a) => [String(a.id), String(a.session_id)]));
  const allMemories = allRows(db, "SELECT * FROM memories");
  const allVersions = allRows(db, "SELECT * FROM memory_versions");
  const versionsByMemory = new Map<string, Row[]>();
  for (const v of allVersions) {
    const key = String(v.memory_id);
    if (!versionsByMemory.has(key)) versionsByMemory.set(key, []);
    versionsByMemory.get(key)!.push(v);
  }
  const memoriesImport: Row[] = [];
  const memoryVersions: Row[] = [];
  const memoryPending: PersonalImportSet["memoryPending"] = [];
  for (const m of allMemories) {
    const pid = m.project_id === null ? null : String(m.project_id);
    const versions = versionsByMemory.get(String(m.id)) ?? [];
    if (pid !== null && !projectIds.has(pid)) {
      memoryPending.push({ id: String(m.id), scope: String(m.scope), reason: "所属项目未导入（dev 项目经 issue 21 迁移；来源留在另一实例）" });
      continue;
    }
    const check = memoryRefsInScope(versions, sessionIds, artifactSession);
    if (check.ok) {
      memoriesImport.push(m);
      memoryVersions.push(...versions);
    } else {
      memoryPending.push({ id: String(m.id), scope: String(m.scope), reason: check.reason! });
    }
  }

  // 资料授权：两端项目都导入才原样导入；否则只在回执记录（跨实例，不生效）
  const allGrants = allRows(db, "SELECT * FROM data_grants");
  const grantsImport = allGrants.filter((g) => projectIds.has(String(g.from_project_id)) && projectIds.has(String(g.to_project_id)));
  const grantsCrossInstance = allGrants.filter(
    (g) => !(projectIds.has(String(g.from_project_id)) && projectIds.has(String(g.to_project_id))),
  );

  const mcps = rowsIn(db, "mcp_services", "project_id", [...projectIds]);
  const metas = [
    ...allRows(db, "SELECT * FROM meta WHERE key LIKE 'jev.project.%'").filter((m) =>
      projectIds.has(String(m.key).slice("jev.project.".length)),
    ),
    ...IMPORT_META_KEYS.map((key) => db.prepare("SELECT * FROM meta WHERE key = ?").get(key) as Row | undefined).filter((m) => m !== undefined),
  ];

  // 应用数据绑定核对：核心 meta ↔ app_meta.instance_id
  const bindingMeta = readMetaValue(db, "app_data.main_instance_id");
  const appDataBinding =
    bindingMeta === null && !snap.appData.present
      ? { metaPresent: false, matches: true, note: "源无应用数据" }
      : bindingMeta === null
        ? { metaPresent: false, matches: false, note: "源有 main.db 但核心 meta 无绑定记录（如实导入，目标启动按既有绑定核查处理）" }
        : !snap.appData.present
          ? { metaPresent: true, matches: false, note: "核心 meta 有绑定记录但 main.db 缺失（如实导入，目标启动按既有绑定核查处理）" }
          : snap.appData.appMeta.instance_id === bindingMeta
            ? { metaPresent: true, matches: true, note: "绑定一致" }
            : { metaPresent: true, matches: false, note: `绑定不符（meta=${bindingMeta}，app_meta=${snap.appData.appMeta.instance_id ?? "缺失"}），如实导入，目标启动按既有绑定核查停用应用数据` };

  // 必要凭据：平台配置引用的绑定 + purpose=github_webhook 的绑定（webhook 启动参数
  // 由拥有者在目标重新给出，凭据绑定随配置迁入）
  const qqConfig = (db.prepare("SELECT * FROM qq_config WHERE id = 1").get() as Row | undefined) ?? null;
  const telegramConfig = (db.prepare("SELECT * FROM telegram_config WHERE id = 1").get() as Row | undefined) ?? null;
  const credentialNames = new Set<string>();
  if (qqConfig?.credential_name != null) credentialNames.add(String(qqConfig.credential_name));
  if (telegramConfig?.credential_name != null) credentialNames.add(String(telegramConfig.credential_name));
  for (const b of snap.credentials.values()) {
    if (b.purpose === "github_webhook") credentialNames.add(String(b.name));
  }
  const credentials: CredentialPlanItem[] = [...credentialNames].sort().map((name) => {
    const binding = snap.credentials.get(name);
    return {
      name,
      purpose: binding?.purpose ?? null,
      presentInSource: binding !== undefined,
      sha256: binding ? sha256(canonicalJson(binding)) : null,
      binding,
    };
  });

  // 文件复制计划：会话 JSONL、产物正文、agent-data/main.db（+WAL）、GitHub 归档 manifest
  const files: FilePlanItem[] = [];
  const missingFiles: PersonalImportSet["missingFiles"] = [];
  for (const s of includedSessions) {
    if (s.session_file === null) continue;
    const src = String(s.session_file);
    if (!fs.existsSync(src)) {
      missingFiles.push({ item: `session ${String(s.id)}`, path: src });
      continue;
    }
    files.push({
      itemId: `sessions/${path.basename(src)}`,
      kind: "session",
      ownerId: String(s.id),
      src,
      dest: path.join(deps.targetDataDir, "sessions", path.basename(src)),
      name: path.basename(src),
      bytes: fs.statSync(src).size,
      sha256: sha256File(src),
    });
  }
  for (const a of artifacts) {
    const src = path.join(snap.dataDir, "artifacts", `${String(a.id)}.bin`);
    if (!fs.existsSync(src)) {
      missingFiles.push({ item: `artifact ${String(a.id)}`, path: src });
      continue;
    }
    const stat = fs.statSync(src);
    files.push({
      itemId: `artifacts/${String(a.id)}.bin`,
      kind: "artifact",
      ownerId: String(a.id),
      src,
      dest: path.join(deps.targetDataDir, "artifacts", `${String(a.id)}.bin`),
      name: `${String(a.id)}.bin`,
      bytes: stat.size,
      sha256: sha256File(src),
    });
    if (Number(a.byte_count) !== stat.size) {
      missingFiles.push({ item: `artifact ${String(a.id)} 登记字节数 ${Number(a.byte_count)} ≠ 实际 ${stat.size}`, path: src });
    }
  }
  if (snap.appData.sourceFile !== null && snap.appData.sha256 !== null) {
    files.push({
      itemId: "agent-data/main.db",
      kind: "app_data",
      ownerId: "main",
      src: snap.appData.sourceFile,
      dest: path.join(deps.targetDataDir, "agent-data", "main.db"),
      name: "main.db",
      bytes: snap.appData.bytes,
      sha256: snap.appData.sha256,
    });
    const srcWal = snap.appData.sourceFile + "-wal";
    if (fs.existsSync(srcWal)) {
      const stat = fs.statSync(srcWal);
      files.push({
        itemId: "agent-data/main.db-wal",
        kind: "app_data",
        ownerId: "main",
        src: srcWal,
        dest: path.join(deps.targetDataDir, "agent-data", "main.db-wal"),
        name: "main.db-wal",
        bytes: stat.size,
        sha256: snap.appData.walSha256!,
      });
    }
  }
  const manifestSrc = path.join(snap.dataDir, "github-archive-manifest.json");
  if (fs.existsSync(manifestSrc)) {
    files.push({
      itemId: "github-archive-manifest.json",
      kind: "manifest",
      ownerId: "github",
      src: manifestSrc,
      dest: path.join(deps.targetDataDir, "github-archive-manifest.json"),
      name: "github-archive-manifest.json",
      bytes: fs.statSync(manifestSrc).size,
      sha256: sha256File(manifestSrc),
    });
  }

  const worksIncluded = allRows(db, "SELECT * FROM work_delegations").filter((r) => sessionIds.has(String(r.parent_session_id)));
  return {
    roles,
    projects: includedProjects,
    sessions: includedSessions,
    subAgents: subAgents.filter((r) => sessionIds.has(String(r.session_id))),
    // 工作内消息（agent-direction issue 13）：随纳入的工作折叠收集（不设新账本
    // 类别——工作行的续跑跳过与回退删除同时覆盖它）
    subagentMessages: allRows(db, "SELECT * FROM subagent_messages").filter((r) =>
      worksIncluded.some((w) => String(w.id) === String(r.work_id)),
    ),
    workDelegations: worksIncluded,
    tasks,
    toolOps,
    confirmations,
    artifacts,
    selectionRecords,
    checkpoints,
    events,
    memoriesImport,
    memoryVersions,
    grantsImport,
    mcps,
    metas,
    schedules,
    scheduleRuns,
    notificationOps,
    inboundEvents,
    standingPermissions: allRows(db, "SELECT * FROM standing_permissions"),
    qqConfig,
    telegramConfig,
    qqSessions: qqBindRows,
    qqInbox: nullableTable(db, "qq_inbox"),
    qqOutbox: nullableTable(db, "qq_outbox"),
    chatResultAcceptances: nullableTable(db, "chat_result_acceptances"),
    githubRepoBindings: nullableTable(db, "github_repo_bindings"),
    githubDrafts: nullableTable(db, "github_drafts"),
    githubPublishOps: nullableTable(db, "github_publish_ops"),
    files,
    credentials,
    closings,
    staleConfirmations,
    effectUnknownTasks,
    effectUnknownOps: [...effectUnknownOpIds],
    runClosings,
    opSettles,
    eventSettles,
    fullAccessKept,
    memoryPending,
    grantsCrossInstance,
    excludedProjects,
    excludedSessions,
    missingFiles,
    appDataBinding,
  };
}

// ---------- 目标状态合并（冲突、改名、角色工作目录、凭据、manifest、修订） ----------

interface ProjectDecision {
  id: string;
  name: string;
  targetName: string;
  rootDecision: "keep" | "clear" | "none";
  rootReason: string | null;
  targetOccupant: string | null;
  alreadyImported: boolean;
}

interface SessionDecision {
  id: string;
  roleId: string | null;
  workspaceFrom: string | null;
  workspaceTo: string | null;
  workspaceReason: string | null;
  sessionFileTo: string | null;
  alreadyImported: boolean;
}

interface PersonalAnalysis {
  set: PersonalImportSet;
  plan: { from: string; renames: Record<string, string> };
  projectDecisions: ProjectDecision[];
  sessionDecisions: SessionDecision[];
  ids: {
    roles: string[];
    projects: string[];
    sessions: string[];
    subAgents: string[];
    workDelegations: string[];
    memories: string[];
    grants: string[];
    mcps: string[];
    metas: string[];
    schedules: string[];
    standingPermissions: string[];
    platformConfigs: string[];
    credentials: string[];
    files: string[];
  };
  /** manifest 表本次实际插入的行（剔除同源已导入）。 */
  manifestInsert: Record<string, string[]>;
  manifest: ManifestRow[];
  idConflicts: Array<{ kind: LedgerKind; id: string }>;
  manifestConflicts: Array<{ table: string; id: string }>;
  credentialConflicts: string[];
  fileConflicts: Array<{ itemId: string; dest: string; reason: string }>;
  mcpDisabled: Array<{ project_id: string; name: string; credential: string }>;
  jevDisabled: Array<{ key: string; credential: string }>;
  jevMissingKeys: Set<string>;
  skippedAlreadyImported: string[];
  newEvents: Row[];
  planErrors: string[];
  revision: string;
}

/** 易变表的 id 列名（qq_inbox 以 dedup_key 为主键，其余取表里第一个 TEXT PRIMARY KEY）。 */
const MANIFEST_ID_COLUMNS: Record<string, string> = {
  schedules: "id",
  schedule_runs: "id",
  notification_ops: "id",
  inbound_events: "id",
  standing_permissions: "id",
  qq_sessions: "__qq_session_key__", // 组合键 account:group_id
  qq_inbox: "dedup_key",
  qq_outbox: "op_id",
  chat_result_acceptances: "__acceptance_key__", // 组合键 main_project_id:task_id
  github_repo_bindings: "id",
  github_drafts: "id",
  github_publish_ops: "id",
};

function manifestIdOf(table: string, row: Row): string {
  const col = MANIFEST_ID_COLUMNS[table];
  if (col === "__qq_session_key__") return `${String(row.account)}:${String(row.group_id)}`;
  if (col === "__acceptance_key__") return `${String(row.main_project_id)}:${String(row.task_id)}`;
  return String(row[col]);
}

function manifestOf(tables: Record<string, Row[]>): ManifestRow[] {
  const out: ManifestRow[] = [];
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) out.push({ table, id: manifestIdOf(table, row), sha: sha256(canonicalJson(row)) });
  }
  return out;
}

function analyze(
  snap: PersonalSnapshot,
  target: TargetView,
  plan: { from: string; renames: Record<string, string> },
  deps: LegacyImportDeps,
): PersonalAnalysis {
  const tdb = target.db;
  checkTablePolicy(snap.db, tdb, TABLE_POLICY);
  const set = buildImportSet(snap, deps);
  const planErrors: string[] = [];

  const sourceProjectIds = new Set(allRows(snap.db, "SELECT id FROM projects").map((p) => String(p.id)));
  for (const id of Object.keys(plan.renames)) {
    if (!sourceProjectIds.has(id)) planErrors.push(`renames 指向不存在的源项目：${id}`);
    else if (!set.projects.some((p) => String(p.id) === id)) planErrors.push(`renames 指向不在导入范围的项目（dev 项目经 issue 21 迁移）：${id}`);
  }

  const ledger = readLedger(tdb);
  const sourceImportIds = new Set(ledger.imports.filter((i) => i.source_instance_id === snap.instanceId).map((i) => i.id));
  const fromSameSource = (kind: LedgerKind, id: string): boolean => {
    const owner = ledger.items.get(kind)?.get(id);
    return owner !== undefined && sourceImportIds.has(owner);
  };

  // 目标必须未初始化自有角色（全新实例，或仅有同源此前导入）
  if (tdb) {
    for (const r of allRows(tdb, "SELECT id FROM agent_roles")) {
      const id = String(r.id);
      if (!fromSameSource("agent_role", id)) {
        planErrors.push(
          `目标实例已有自有角色 ${id}（后台已初始化）；个人迁入要求目标为全新实例——请换新目录，或先回退同源此前导入`,
        );
      }
    }
  }

  const idConflicts: PersonalAnalysis["idConflicts"] = [];
  const skipped = new Set<string>(); // kind:id，本次跳过（已在本源此前导入）
  const checkItem = (kind: LedgerKind, id: string, existsInTarget: boolean): boolean => {
    if (!existsInTarget) return true;
    if (fromSameSource(kind, id)) {
      skipped.add(`${kind}:${id}`);
      return false;
    }
    idConflicts.push({ kind, id });
    return false;
  };

  const targetProjects = tdb ? allRows(tdb, "SELECT id, name, root_real FROM projects") : [];
  const targetNames = new Set(targetProjects.map((p) => String(p.name)));
  const targetRootOwners = new Map(targetProjects.filter((p) => p.root_real !== null).map((p) => [String(p.root_real), String(p.id)]));
  const targetExisting = (table: string, ids: string[]): Set<string> =>
    new Set(tdb && ids.length > 0 ? rowsIn(tdb, table, "id", ids).map((r) => String(r.id)) : []);

  // 项目：根目录核实 + 重名改名（角色项目通常无根；旧实例路径按规则清空）
  const projectDecisions: ProjectDecision[] = [];
  for (const p of set.projects) {
    const id = String(p.id);
    const exists = targetExisting("projects", [id]).has(id);
    const alreadyImported = !checkItem("project", id, exists);
    let rootDecision: ProjectDecision["rootDecision"] = "none";
    let rootReason: string | null = null;
    let targetOccupant: string | null = null;
    if (p.root_real !== null) {
      const occupant = targetRootOwners.get(String(p.root_real));
      if (!strictDirOk(String(p.root_real), Number(p.root_dev), Number(p.root_ino))) {
        rootDecision = "clear";
        rootReason = "根目录在本机无法核实身份（跨机器或已失效），原值记入回执";
      } else if (occupant !== undefined && occupant !== id) {
        rootDecision = "clear";
        targetOccupant = occupant;
        rootReason = `根目录已被目标工作区占用：${occupant}`;
      } else {
        rootDecision = "keep";
      }
    }
    const renamed = plan.renames[id];
    projectDecisions.push({
      id,
      name: String(p.name),
      targetName: renamed ?? String(p.name),
      rootDecision,
      rootReason,
      targetOccupant,
      alreadyImported,
    });
  }
  const newProjects = projectDecisions.filter((d) => !d.alreadyImported);
  const nameSeen = new Map<string, string>();
  for (const d of newProjects) {
    if (targetNames.has(d.targetName)) {
      planErrors.push(`项目重名且未在计划中改名：${d.name}（${d.id}）；在计划 renames 中为其指定新名`);
    }
    const other = nameSeen.get(d.targetName);
    if (other !== undefined) planErrors.push(`两个源项目改后同名：${other} 与 ${d.id} 都叫 ${d.targetName}`);
    nameSeen.set(d.targetName, d.id);
  }

  // 会话：角色会话工作目录改写为目标 agent-work；组织映射规则与 21 相同
  const projectDecisionById = new Map(projectDecisions.map((d) => [d.id, d]));
  const roleBySession = new Map(set.roles.map((r) => [String(r.session_id), String(r.id)]));
  const sessionDecisions: SessionDecision[] = [];
  const existingSessions = targetExisting(
    "sessions",
    set.sessions.map((s) => String(s.id)),
  );
  for (const s of set.sessions) {
    const id = String(s.id);
    const alreadyImported = !checkItem("session", id, existingSessions.has(id));
    const from = s.workspace_project_id === null ? null : String(s.workspace_project_id);
    let to: string | null = null;
    let reason: string | null = null;
    if (from !== null) {
      const wd = projectDecisionById.get(from);
      if (!wd) {
        reason = "源组织映射目标未随导入（资料身份不变）";
      } else if (wd.rootDecision === "keep") {
        to = wd.id;
      } else if (wd.targetOccupant !== null) {
        to = wd.targetOccupant;
        reason = `源工作区根与目标工作区 ${to} 同根，组织归属指向目标工作区`;
      } else {
        reason = "源工作区根在本机无法核实，组织归属置空";
      }
    }
    const file = set.files.find((f) => f.kind === "session" && f.ownerId === id);
    sessionDecisions.push({
      id,
      roleId: roleBySession.get(id) ?? null,
      workspaceFrom: from,
      workspaceTo: to,
      workspaceReason: reason,
      sessionFileTo: file ? file.dest : null,
      alreadyImported,
    });
  }

  // 其余账本类别的 ID 冲突核对
  const roleIds = set.roles.map((r) => String(r.id));
  const existingRoles = tdb && roleIds.length > 0 ? new Set(rowsIn(tdb, "agent_roles", "id", roleIds).map((r) => String(r.id))) : new Set<string>();
  for (const id of roleIds) checkItem("agent_role", id, existingRoles.has(id));
  const simpleChecks: Array<{ kind: LedgerKind; table: string; ids: string[] }> = [
    { kind: "sub_agent", table: "sub_agents", ids: set.subAgents.map((r) => String(r.id)) },
    { kind: "work_delegation", table: "work_delegations", ids: set.workDelegations.map((r) => String(r.id)) },
    { kind: "memory", table: "memories", ids: set.memoriesImport.map((r) => String(r.id)) },
    { kind: "grant", table: "data_grants", ids: set.grantsImport.map((r) => String(r.id)) },
    { kind: "mcp", table: "mcp_services", ids: set.mcps.map((r) => String(r.id)) },
    { kind: "schedule", table: "schedules", ids: set.schedules.map((r) => String(r.id)) },
    { kind: "standing_permission", table: "standing_permissions", ids: set.standingPermissions.map((r) => String(r.id)) },
  ];
  for (const { kind, table, ids } of simpleChecks) {
    const existing = targetExisting(table, ids);
    for (const id of ids) checkItem(kind, id, existing.has(id));
  }
  for (const m of set.metas) {
    const key = String(m.key);
    const exists = tdb ? readMetaValue(tdb, key) !== null : false;
    checkItem("meta", key, exists);
  }
  // 平台配置：qq/telegram 单行 + qq_sessions 组合键
  const platformItems: Array<{ itemId: string; table: string; exists: boolean }> = [];
  if (set.qqConfig) platformItems.push({ itemId: "qq_config", table: "qq_config", exists: tdb ? tdb.prepare("SELECT 1 FROM qq_config WHERE id = 1").get() !== undefined : false });
  if (set.telegramConfig)
    platformItems.push({ itemId: "telegram_config", table: "telegram_config", exists: tdb ? tdb.prepare("SELECT 1 FROM telegram_config WHERE id = 1").get() !== undefined : false });
  for (const q of set.qqSessions) {
    const itemId = `qq_sessions:${String(q.account)}:${String(q.group_id)}`;
    const exists = tdb
      ? tdb.prepare("SELECT 1 FROM qq_sessions WHERE account = ? AND group_id = ?").get(String(q.account), String(q.group_id)) !== undefined
      : false;
    platformItems.push({ itemId, table: "qq_sessions", exists });
  }
  for (const p of platformItems) checkItem("platform_config", p.itemId, p.exists);

  // manifest 易变表：同键同 sha = 同源已导入跳过；同键异 sha = 冲突
  // 易变/归档表清单与 manifestTablesRows 共用同一映射（此处先取源行，不回读目标）
  const manifestTables = manifestTablesRows(set);
  const manifest = manifestOf(manifestTables);
  // 同源此前（applied 状态）回执 manifest：`${table}:${id}` → 其时插入行的整行 sha。
  // 导入行的收尾转换带时间戳（closed_at/settled_at），目标行与源快照行 sha 不再
  // 相等；唯一能证明"目标行是本源某次导入所写"的证据就是此前回执的 manifest
  const sameSourceManifest = new Map<string, string>();
  if (tdb) {
    for (const imp of ledger.imports) {
      if (imp.source_instance_id !== snap.instanceId || imp.status !== "applied") continue;
      const row = tdb.prepare("SELECT report FROM instance_imports WHERE id = ?").get(imp.id) as { report: string } | undefined;
      if (!row) continue;
      try {
        const report = JSON.parse(row.report) as { direction?: string; manifest?: Array<{ table: string; id: string; sha: string }> };
        if (report.direction !== "personal-into-ruukoto") continue;
        for (const m of report.manifest ?? []) sameSourceManifest.set(`${m.table}:${m.id}`, m.sha);
      } catch {
        // 旧形状回执（无 manifest）：不回填视同非同源，冲突按 id_conflict 如实列出
      }
    }
  }
  const manifestConflicts: PersonalAnalysis["manifestConflicts"] = [];
  const manifestInsert: Record<string, string[]> = {};
  for (const [table, rows] of Object.entries(manifestTables)) {
    const insertIds: string[] = [];
    for (const row of rows) {
      const id = manifestIdOf(table, row);
      const col = MANIFEST_ID_COLUMNS[table];
      let existing: Row | undefined;
      if (tdb) {
        try {
          if (col === "__qq_session_key__") {
            existing = tdb.prepare("SELECT * FROM qq_sessions WHERE account = ? AND group_id = ?").get(String(row.account), String(row.group_id)) as
              | Row
              | undefined;
          } else if (col === "__acceptance_key__") {
            existing = tdb
              .prepare("SELECT * FROM chat_result_acceptances WHERE main_project_id = ? AND task_id = ?")
              .get(String(row.main_project_id), String(row.task_id)) as Row | undefined;
          } else {
            existing = tdb.prepare(`SELECT * FROM ${table} WHERE ${col} = ?`).get(id) as Row | undefined;
          }
        } catch {
          existing = undefined; // 目标库可能还没有这些表（全新实例由建表事务补齐前不存在 github_*）
        }
      }
      if (existing === undefined) {
        insertIds.push(id);
        continue;
      }
      const existingSha = sha256(canonicalJson(existing));
      // 列集合差异（目标列更全）按导入可比列核对：目标行只取源行已有的键
      const projected = Object.fromEntries(Object.entries(existing).filter(([k]) => k in row));
      const projectedSha = sha256(canonicalJson(projected));
      const importedSha = sameSourceManifest.get(`${table}:${id}`);
      if (importedSha !== undefined && (existingSha === importedSha || projectedSha === importedSha)) {
        skipped.add(`manifest:${table}:${id}`);
        continue;
      }
      manifestConflicts.push({ table, id });
    }
    manifestInsert[table] = insertIds;
  }

  // 文件：与 21 同规则（目标已有同 sha 跳过，异 sha 拒绝；归属会话跳过时其文件跳过）
  const artifactOwnerSession = new Map(set.artifacts.map((a) => [String(a.id), String(a.session_id)]));
  const fileConflicts: PersonalAnalysis["fileConflicts"] = [];
  for (const f of set.files) {
    if (f.kind === "session" || f.kind === "artifact") {
      const ownerSession = f.kind === "session" ? f.ownerId : (artifactOwnerSession.get(f.ownerId) ?? "");
      if (skipped.has(`session:${ownerSession}`)) continue;
    }
    if (!fs.existsSync(f.dest)) {
      f.action = "copied";
      continue;
    }
    const destSha = sha256File(f.dest);
    if (destSha === f.sha256) f.action = "skipped_same_sha";
    else fileConflicts.push({ itemId: f.itemId, dest: f.dest, reason: "目标已存在同名文件且内容不同" });
  }

  // 凭据：目标同名同值跳过、异值冲突；plan 之外的环境状态，受害者只有目标
  const targetCredentials = readCredentialsFile(path.join(deps.targetAgentDir, "credentials.json"));
  const credentialConflicts: string[] = [];
  for (const c of set.credentials) {
    if (!c.presentInSource) continue; // 源缺失：配置如实导入，平台启动按既有核查失败关闭
    const targetBinding = targetCredentials.get(c.name);
    if (!targetBinding) {
      c.action = "copy";
      continue;
    }
    if (sha256(canonicalJson(targetBinding)) === c.sha256) c.action = "skip_same";
    else {
      c.action = "conflict";
      credentialConflicts.push(c.name);
    }
  }

  // MCP / Jev：目标缺少凭据绑定时以停用状态导入（规则同 21）
  const mcpDisabled: PersonalAnalysis["mcpDisabled"] = [];
  for (const m of set.mcps) {
    if (skipped.has(`mcp:${String(m.id)}`)) continue;
    const credential = m.credential === null ? null : String(m.credential);
    if (credential !== null && !targetCredentials.has(credential)) {
      mcpDisabled.push({ project_id: String(m.project_id), name: String(m.name), credential });
    }
  }
  const jevDisabled: PersonalAnalysis["jevDisabled"] = [];
  const jevMissingKeys = new Set<string>();
  for (const m of set.metas) {
    const key = String(m.key);
    if (skipped.has(`meta:${key}`) || !key.startsWith("jev.project.")) continue;
    let cfg: { enabled?: boolean; credential?: string | null } | null = null;
    try {
      cfg = JSON.parse(String(m.value));
    } catch {
      cfg = null;
    }
    if (cfg && cfg.enabled === true && typeof cfg.credential === "string" && !targetCredentials.has(cfg.credential)) {
      jevDisabled.push({ key, credential: cfg.credential });
      jevMissingKeys.add(key);
    }
  }

  const skippedAlreadyImported = [...skipped].sort();
  const skippedSessions = new Set([...skipped].filter((k) => k.startsWith("session:")).map((k) => k.slice("session:".length)));
  const newSessionTasks = new Set(set.tasks.filter((t) => !skippedSessions.has(String(t.session_id))).map((t) => String(t.id)));
  const newEvents = set.events.filter((e) => {
    const sid = e.session_id === null ? null : String(e.session_id);
    const tid = e.task_id === null ? null : String(e.task_id);
    if (sid !== null) return !skippedSessions.has(sid);
    return tid !== null && newSessionTasks.has(tid);
  });

  // 修订：导入集合（每行整行规范化哈希 + 文件与凭据 sha256）+ 目标冲突状态
  const rowDigests = (rows: Row[], idCol = "id") =>
    rows.map((r) => ({ id: String(r[idCol]), sha: sha256(canonicalJson(r)) })).sort((a, b) => a.id.localeCompare(b.id));
  const revision = `r1.${sha256(
    canonicalJson({
      v: 1,
      direction: "personal-into-ruukoto",
      source: { instanceId: snap.instanceId, product: snap.product, schema: snap.originalSchemaVersion },
      plan: { renames: plan.renames },
      roles: rowDigests(set.roles),
      projects: projectDecisions
        .map((d) => ({ id: d.id, name: d.targetName, root: d.rootDecision, skip: d.alreadyImported }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      projectRows: rowDigests(set.projects),
      sessions: sessionDecisions
        .map((d) => ({ id: d.id, role: d.roleId, to: d.workspaceTo, file: d.sessionFileTo !== null, skip: d.alreadyImported }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      sessionRows: rowDigests(set.sessions),
      tasks: rowDigests(set.tasks),
      toolOps: rowDigests(set.toolOps),
      confirmations: rowDigests(set.confirmations),
      artifacts: rowDigests(set.artifacts),
      selectionRecords: rowDigests(set.selectionRecords),
      checkpoints: rowDigests(set.checkpoints),
      subAgents: rowDigests(set.subAgents),
      works: rowDigests(set.workDelegations),
      memories: rowDigests(set.memoriesImport),
      memoryVersions: set.memoryVersions
        .map((v) => ({ id: `${String(v.memory_id)}:${Number(v.version)}`, sha: sha256(canonicalJson(v)) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      grants: rowDigests(set.grantsImport),
      mcps: rowDigests(set.mcps),
      metas: rowDigests(set.metas, "key"),
      manifest: manifest.map((m) => `${m.table}:${m.id}:${m.sha}`).sort(),
      settles: {
        closings: set.closings,
        stale: [...set.staleConfirmations].sort(),
        runClosings: [...set.runClosings].sort(),
        opSettles: set.opSettles,
        eventSettles: [...set.eventSettles].sort(),
      },
      events: { count: set.events.length, sha: sha256(set.events.map((e) => `${String(e.seq)}:${sha256(canonicalJson(e))}`).join(",")) },
      files: set.files.map((f) => ({ item: f.itemId, sha: f.sha256 })).sort((a, b) => a.item.localeCompare(b.item)),
      credentials: set.credentials.map((c) => ({ name: c.name, present: c.presentInSource, sha: c.sha256 })),
      target: {
        names: [...targetNames].sort(),
        roots: [...targetRootOwners.keys()].sort(),
        sameSourceItems: skippedAlreadyImported,
        // 凭据动作不进入修订：复制/合并/合并失败前的同一次尝试已把目标凭据置为
        // skip_same，含动作会让续跑永远撞 revision_conflict（冲突在应用期仍生效）
      },
    }),
  )}`;

  return {
    set,
    plan,
    projectDecisions,
    sessionDecisions,
    ids: {
      roles: roleIds.filter((id) => !skipped.has(`agent_role:${id}`)),
      projects: newProjects.map((d) => d.id),
      sessions: sessionDecisions.filter((d) => !d.alreadyImported).map((d) => d.id),
      subAgents: set.subAgents.filter((r) => !skipped.has(`sub_agent:${String(r.id)}`)).map((r) => String(r.id)),
      workDelegations: set.workDelegations.filter((r) => !skipped.has(`work_delegation:${String(r.id)}`)).map((r) => String(r.id)),
      memories: set.memoriesImport.filter((r) => !skipped.has(`memory:${String(r.id)}`)).map((r) => String(r.id)),
      grants: set.grantsImport.filter((r) => !skipped.has(`grant:${String(r.id)}`)).map((r) => String(r.id)),
      mcps: set.mcps.filter((r) => !skipped.has(`mcp:${String(r.id)}`)).map((r) => String(r.id)),
      metas: set.metas.filter((r) => !skipped.has(`meta:${String(r.key)}`)).map((r) => String(r.key)),
      schedules: set.schedules.filter((r) => !skipped.has(`schedule:${String(r.id)}`)).map((r) => String(r.id)),
      standingPermissions: set.standingPermissions.filter((r) => !skipped.has(`standing_permission:${String(r.id)}`)).map((r) => String(r.id)),
      platformConfigs: platformItems.filter((p) => !skipped.has(`platform_config:${p.itemId}`)).map((p) => p.itemId),
      credentials: set.credentials.filter((c) => c.action === "copy").map((c) => c.name),
      files: set.files.filter((f) => f.action === "copied").map((f) => f.itemId),
    },
    manifestInsert,
    manifest,
    idConflicts,
    manifestConflicts,
    credentialConflicts,
    fileConflicts,
    mcpDisabled,
    jevDisabled,
    jevMissingKeys,
    skippedAlreadyImported,
    newEvents,
    planErrors,
    revision,
  };
}

// ---------- 预览 ----------

export interface PersonalImportPreview {
  direction: "personal-into-ruukoto";
  source: {
    dir: string;
    instance_id: string;
    product: string | null;
    schema_version_original: number | null;
    schema_version_current: number;
  };
  target: {
    dir: string;
    exists: boolean;
    instance_id: string | null;
    product: string | null;
    project_count: number;
    previous_imports: number;
  };
  /** 交接清单：平台连接与调度的执行归属在导入后移到目标，旧实例不得再消费。 */
  handover: {
    platforms: Array<{
      kind: "qq" | "telegram";
      enabled: boolean;
      endpoint: string;
      credential_name: string | null;
      credential: "copy" | "skip_same" | "conflict" | "missing_in_source";
      config_version: number;
      last_update_id?: number;
    }>;
    webhook_credentials: Array<{ name: string; action: string }>;
    schedules: { active: number; completed: number; canceled: number; open_runs: number };
    standing_permissions: { active: number; revoked: number };
    note: string;
  };
  roles: Array<{ id: string; session_id: string; project_id: string; decision: "import" | "already_imported" }>;
  sessions: Array<{
    id: string;
    role: string | null;
    group: boolean;
    sub_agent: boolean;
    project_id: string;
    history: string;
    history_reason: string | null;
    session_file: "copy" | "missing" | "none";
    unfinished: Array<{ task_id: string; from: string; to: string }>;
    pending_approvals: number;
    full_access_kept: boolean;
    workspace: { from: string | null; to: string | null; reason: string | null };
  }>;
  excluded_sessions: Array<{ id: string; project_id: string; reason: string }>;
  excluded_projects: Array<{ id: string; name: string; reason: string }>;
  app_data: {
    present: boolean;
    bytes: number;
    tables: number;
    audit_rows: number;
    corrupt: boolean;
    binding: { meta_present: boolean; matches: boolean; note: string };
    wal_present: boolean;
  };
  schedules: Array<{ id: string; action: string; status: string; next_due_at: string | null }>;
  schedule_settles: { open_runs_closed: number };
  outbox: { total: number; canceled_pending: number; effect_unknown_sending: number; terminal_kept: number };
  inbound: { total: number; settled_failed: number; terminal_kept: number };
  standing_permissions: Array<{ id: string; machine_id: string; unit: string; action: string; revoked: boolean }>;
  archives: {
    qq_inbox: number;
    qq_outbox: number;
    chat_result_acceptances: number;
    github_repo_bindings: number;
    github_drafts: number;
    github_publish_ops: number;
    github_manifest_file: boolean;
  };
  memories: { import: string[]; pending: Array<{ id: string; scope: string; reason: string }> };
  grants: { import: string[]; cross_instance: Array<{ id: string; from: string; to: string; category: string; note: string }> };
  mcp: Array<{ project_id: string; name: string; disabled: boolean; reason: string | null }>;
  jev: Array<{ key: string; disabled: boolean; credential: string | null }>;
  credentials: Array<{ name: string; purpose: string | null; action: string }>;
  events: number;
  files: { copy: number; bytes: number; missing: Array<{ item: string; path: string }>; skipped_same_sha: number };
  sub_agents: number;
  work_delegations: number;
  closings: { canceled: number; interrupted: number; stale_confirmations: number; effect_unknown_tasks: number; full_access_kept: number };
  agent_dir_names: string[];
  source_new_since_last_import: { count: number; note: string };
  conflicts: {
    ids: Array<{ kind: string; id: string }>;
    files: Array<{ itemId: string; dest: string; reason: string }>;
    manifest: Array<{ table: string; id: string }>;
    credentials: string[];
  };
  plan: { from: string; renames: Record<string, string> };
  plan_errors: string[];
  revision: string | null;
}

function normalizePlan(from: string, plan?: PersonalImportPlan): {
  from: string;
  renames: Record<string, string>;
  planErrors: string[];
} {
  const planErrors: string[] = [];
  const renames: Record<string, string> = {};
  for (const [id, name] of Object.entries(plan?.renames ?? {})) {
    if (typeof name !== "string" || name.trim() === "") {
      planErrors.push(`renames[${id}] 不是有效项目名`);
      continue;
    }
    renames[id] = name;
  }
  const unknownKeys = Object.keys(plan ?? {}).filter((k) => k !== "renames");
  // apply 的计划文件带有 preview 写回的绑定字段，不算未知
  for (const k of unknownKeys) {
    if (!["from", "source_instance_id", "revision"].includes(k)) planErrors.push(`计划包含未知字段：${k}`);
  }
  return { from: path.resolve(from), renames, planErrors };
}

export function previewPersonalImport(deps: LegacyImportDeps, input: { from: string; plan?: PersonalImportPlan }): PersonalImportPreview {
  const normalized = normalizePlan(input.from, input.plan);
  const snap = openPersonalSnapshot(normalized.from);
  let target: TargetView | null = null;
  try {
    target = openTargetReadonlyCopy(deps);
    checkTargetProduct(target.product, target.schemaVersion, target.exists);
    checkNotSelf(snap, deps, target);
    const analysis = analyze(snap, target, normalized, deps);
    const sessionDecisionById = new Map(analysis.sessionDecisions.map((d) => [d.id, d]));
    const roleBySession = new Map(analysis.set.roles.map((r) => [String(r.session_id), String(r.id)]));
    const subSessionIds = new Set(analysis.set.subAgents.map((r) => String(r.session_id)));
    const qqSessionIds = new Set(analysis.set.qqSessions.map((r) => String(r.session_id)));
    const ledger = readLedger(target.db);
    const previousImports = ledger.imports.filter((i) => i.source_instance_id === snap.instanceId).length;
    const newItemCount = Object.values(analysis.ids).reduce((n, list) => n + list.length, 0);

    const closingsBySession = new Map<string, TaskClosing[]>();
    for (const c of analysis.set.closings) {
      const t = analysis.set.tasks.find((x) => String(x.id) === c.task_id)!;
      const sid = String(t.session_id);
      if (!closingsBySession.has(sid)) closingsBySession.set(sid, []);
      closingsBySession.get(sid)!.push(c);
    }
    const pendingBySession = new Map<string, number>();
    for (const c of analysis.set.confirmations) {
      if (String(c.status) === "pending" || (String(c.status) === "approved" && c.consumed_at === null)) {
        const sid = String(c.session_id);
        pendingBySession.set(sid, (pendingBySession.get(sid) ?? 0) + 1);
      }
    }

    const credentialAction = (name: string | null): { name: string | null; action: "copy" | "skip_same" | "conflict" | "missing_in_source" } => {
      if (name === null) return { name: null, action: "missing_in_source" };
      const c = analysis.set.credentials.find((x) => x.name === name);
      if (!c || !c.presentInSource) return { name, action: "missing_in_source" };
      return { name, action: c.action ?? "copy" };
    };
    const platforms: PersonalImportPreview["handover"]["platforms"] = [];
    if (analysis.set.qqConfig) {
      const q = analysis.set.qqConfig;
      const cred = credentialAction(q.credential_name === null ? null : String(q.credential_name));
      platforms.push({
        kind: "qq",
        enabled: Number(q.enabled) === 1,
        endpoint: String(q.endpoint),
        credential_name: cred.name,
        credential: cred.action,
        config_version: Number(q.config_version),
      });
    }
    if (analysis.set.telegramConfig) {
      const t = analysis.set.telegramConfig;
      const cred = credentialAction(String(t.credential_name));
      platforms.push({
        kind: "telegram",
        enabled: Number(t.enabled) === 1,
        endpoint: String(t.api_base),
        credential_name: cred.name,
        credential: cred.action,
        config_version: Number(t.config_version),
        last_update_id: Number(t.last_update_id),
      });
    }
    const platformCredentialNames = new Set(platforms.map((p) => p.credential_name).filter((n) => n !== null));
    const webhookCredentials = analysis.set.credentials
      .filter((c) => !platformCredentialNames.has(c.name))
      .map((c) => ({ name: c.name, action: c.presentInSource ? (c.action ?? "copy") : "missing_in_source" }));

    const settlingOps = new Map(analysis.set.opSettles.map((o) => [o.id, o.to]));
    return {
      direction: "personal-into-ruukoto",
      source: {
        dir: snap.dataDir,
        instance_id: snap.instanceId,
        product: snap.product,
        schema_version_original: snap.originalSchemaVersion,
        schema_version_current: SCHEMA_VERSION,
      },
      target: {
        dir: deps.targetDataDir,
        exists: target.exists,
        instance_id: target.instanceId,
        product: target.product,
        project_count: target.db ? (target.db.prepare("SELECT count(*) c FROM projects").get() as { c: number }).c : 0,
        previous_imports: previousImports,
      },
      handover: {
        platforms,
        webhook_credentials: webhookCredentials,
        schedules: {
          active: analysis.set.schedules.filter((s) => s.status === "active").length,
          completed: analysis.set.schedules.filter((s) => s.status === "completed").length,
          canceled: analysis.set.schedules.filter((s) => s.status === "canceled").length,
          open_runs: analysis.set.runClosings.length,
        },
        standing_permissions: {
          active: analysis.set.standingPermissions.filter((p) => p.revoked_at === null).length,
          revoked: analysis.set.standingPermissions.filter((p) => p.revoked_at !== null).length,
        },
        note: "导入完成后平台连接与调度的执行归属移到目标；旧实例不得再启动消费同一入站或同一批通知（见运行文档）",
      },
      roles: analysis.set.roles.map((r) => ({
        id: String(r.id),
        session_id: String(r.session_id),
        project_id: String(r.project_id),
        decision: analysis.ids.roles.includes(String(r.id)) ? "import" : "already_imported",
      })),
      sessions: analysis.set.sessions.map((s) => {
        const id = String(s.id);
        const d = sessionDecisionById.get(id)!;
        const hist = historyStatusOf({ sessionFile: s.session_file === null ? null : String(s.session_file) } as Session);
        return {
          id,
          role: roleBySession.get(id) ?? null,
          group: qqSessionIds.has(id),
          sub_agent: subSessionIds.has(id),
          project_id: String(s.project_id),
          history: hist.history,
          history_reason: hist.reason,
          session_file: s.session_file === null ? "none" : analysis.set.files.some((f) => f.kind === "session" && f.ownerId === id) ? "copy" : "missing",
          unfinished: (closingsBySession.get(id) ?? []).map((c) => ({ task_id: c.task_id, from: c.from, to: c.to })),
          pending_approvals: pendingBySession.get(id) ?? 0,
          full_access_kept: s.default_access_mode === "full_access",
          workspace: { from: d.workspaceFrom, to: d.workspaceTo, reason: d.workspaceReason },
        };
      }),
      excluded_sessions: analysis.set.excludedSessions,
      excluded_projects: analysis.set.excludedProjects,
      app_data: {
        present: snap.appData.present,
        bytes: snap.appData.bytes,
        tables: snap.appData.tables,
        audit_rows: snap.appData.auditRows,
        corrupt: snap.appData.corrupt,
        binding: {
          meta_present: analysis.set.appDataBinding.metaPresent,
          matches: analysis.set.appDataBinding.matches,
          note: analysis.set.appDataBinding.note,
        },
        wal_present: snap.appData.walFile !== null,
      },
      schedules: analysis.set.schedules.map((s) => ({
        id: String(s.id),
        action: String(s.action),
        status: String(s.status),
        next_due_at: s.next_due_at === null ? null : String(s.next_due_at),
      })),
      schedule_settles: { open_runs_closed: analysis.set.runClosings.length },
      outbox: {
        total: analysis.set.notificationOps.length,
        canceled_pending: analysis.set.opSettles.filter((o) => o.to === "canceled").length,
        effect_unknown_sending: analysis.set.opSettles.filter((o) => o.to === "effect_unknown").length,
        terminal_kept: analysis.set.notificationOps.filter((o) => !settlingOps.has(String(o.id))).length,
      },
      inbound: {
        total: analysis.set.inboundEvents.length,
        settled_failed: analysis.set.eventSettles.length,
        terminal_kept: analysis.set.inboundEvents.length - analysis.set.eventSettles.length,
      },
      standing_permissions: analysis.set.standingPermissions.map((p) => ({
        id: String(p.id),
        machine_id: String(p.machine_id),
        unit: String(p.unit),
        action: String(p.action),
        revoked: p.revoked_at !== null,
      })),
      archives: {
        qq_inbox: analysis.set.qqInbox.length,
        qq_outbox: analysis.set.qqOutbox.length,
        chat_result_acceptances: analysis.set.chatResultAcceptances.length,
        github_repo_bindings: analysis.set.githubRepoBindings.length,
        github_drafts: analysis.set.githubDrafts.length,
        github_publish_ops: analysis.set.githubPublishOps.length,
        github_manifest_file: analysis.set.files.some((f) => f.kind === "manifest"),
      },
      memories: { import: analysis.ids.memories, pending: analysis.set.memoryPending },
      grants: {
        import: analysis.ids.grants,
        cross_instance: analysis.set.grantsCrossInstance.map((g) => ({
          id: String(g.id),
          from: String(g.from_project_id),
          to: String(g.to_project_id),
          category: String(g.category),
          note: "跨实例，不生效（授权仍以来源实例为准）",
        })),
      },
      mcp: analysis.set.mcps.map((m) => {
        const disabled = analysis.mcpDisabled.some((x) => x.name === String(m.name) && x.project_id === String(m.project_id));
        return {
          project_id: String(m.project_id),
          name: String(m.name),
          disabled,
          reason: disabled ? "目标缺少同名凭据绑定，以停用状态导入；重新绑定后启用" : null,
        };
      }),
      jev: analysis.set.metas
        .filter((m) => String(m.key).startsWith("jev.project."))
        .map((m) => {
          const dis = analysis.jevDisabled.find((x) => x.key === String(m.key));
          return { key: String(m.key), disabled: dis !== undefined, credential: dis?.credential ?? null };
        }),
      credentials: analysis.set.credentials.map((c) => ({
        name: c.name,
        purpose: c.purpose,
        action: c.presentInSource ? (c.action ?? "copy") : "missing_in_source",
      })),
      events: analysis.newEvents.length,
      files: {
        copy: analysis.set.files.filter((f) => f.action !== "skipped_same_sha").length,
        bytes: analysis.set.files.filter((f) => f.action !== "skipped_same_sha").reduce((n, f) => n + f.bytes, 0),
        missing: analysis.set.missingFiles,
        skipped_same_sha: analysis.set.files.filter((f) => f.action === "skipped_same_sha").length,
      },
      sub_agents: analysis.ids.subAgents.length,
      work_delegations: analysis.ids.workDelegations.length,
      closings: {
        canceled: analysis.set.closings.filter((c) => c.to === "canceled").length,
        interrupted: analysis.set.closings.filter((c) => c.to === "interrupted").length,
        stale_confirmations: analysis.set.staleConfirmations.length,
        effect_unknown_tasks: analysis.set.effectUnknownTasks.length,
        full_access_kept: analysis.set.fullAccessKept.length,
      },
      agent_dir_names: snap.agentDirNames,
      source_new_since_last_import: {
        count: previousImports > 0 ? newItemCount : 0,
        note: previousImports > 0 ? "自本源上次导入后源侧新增的条目数；导入不做增量同步，仅在报告列出" : "本源此前无导入",
      },
      conflicts: {
        ids: analysis.idConflicts.map((c) => ({ kind: c.kind, id: c.id })),
        files: analysis.fileConflicts,
        manifest: analysis.manifestConflicts,
        credentials: analysis.credentialConflicts,
      },
      plan: { from: normalized.from, renames: normalized.renames },
      plan_errors: [...normalized.planErrors, ...analysis.planErrors],
      revision: analysis.revision,
    };
  } finally {
    target?.cleanup();
    snap.cleanup();
  }
}

// ---------- 应用 ----------

function planDigestOf(input: { from: string; renames: Record<string, string>; sourceInstanceId: string; revision: string }): string {
  return sha256(
    canonicalJson({
      direction: "personal-into-ruukoto",
      from: input.from,
      renames: input.renames,
      source_instance_id: input.sourceInstanceId,
      revision: input.revision,
    }),
  );
}

/** 目标凭据合并：copy 动作的绑定写入目标 credentials.json（同名同值跳过，异值已在 analyze 拒绝）。 */
function mergeCredentials(deps: LegacyImportDeps, items: CredentialPlanItem[]): void {
  const file = path.join(deps.targetAgentDir, "credentials.json");
  const toCopy = items.filter((c) => c.action === "copy" && c.binding !== undefined);
  if (toCopy.length === 0) return;
  let data: { bindings: CredentialBinding[] } = { bindings: [] };
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) as { bindings: CredentialBinding[] };
  } catch {
    data = { bindings: [] };
  }
  for (const c of toCopy) {
    const idx = data.bindings.findIndex((b) => b.name === c.name);
    if (idx >= 0) data.bindings[idx] = c.binding!;
    else data.bindings.push(c.binding!);
  }
  fs.mkdirSync(deps.targetAgentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function applyPersonalImport(
  deps: LegacyImportDeps,
  input: {
    plan: { from: string; renames?: Record<string, string> };
    source_instance_id: string;
    revision: string;
    request_id: string;
  },
): LegacyImportApplyResult {
  if (typeof input.source_instance_id !== "string" || input.source_instance_id === "") {
    fail("invalid_params", "计划文件缺少 source_instance_id（由 preview --plan 写入）");
  }
  if (typeof input.revision !== "string" || input.revision === "") {
    fail("invalid_params", "计划文件缺少 revision；请先用 legacy-import preview --plan 生成");
  }
  if (typeof input.request_id !== "string" || input.request_id === "") {
    fail("invalid_params", "缺少 request_id（CLI 由计划文件内容派生）");
  }
  const normalized = normalizePlan(input.plan.from, input.plan);
  if (normalized.planErrors.length > 0) fail("invalid_params", `计划无效：${normalized.planErrors.join("；")}`);

  fs.mkdirSync(deps.targetDataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(deps.targetAgentDir, { recursive: true, mode: 0o700 });
  const targetDbFile = path.join(deps.targetDataDir, "ruukoto.db");
  if (fs.existsSync(targetDbFile)) {
    let version: number | null = null;
    const raw = new DatabaseSync(targetDbFile);
    try {
      const row = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      version = row ? Number(row.value) : null;
    } finally {
      raw.close();
    }
    if (version !== SCHEMA_VERSION) {
      fail("target_schema", `目标库 schema 版本为 ${version}（当前程序 ${SCHEMA_VERSION}）；请先启动一次 ruukoto 后台完成迁移，再执行导入`);
    }
  }
  const tdb = new Db(deps.targetDataDir);
  const snap = openPersonalSnapshot(normalized.from);
  try {
    const targetProduct = readMetaValue(tdb, PRODUCT_META_KEY);
    checkTargetProduct(targetProduct, SCHEMA_VERSION, true);
    if (snap.instanceId !== input.source_instance_id) {
      fail("invalid_params", `计划文件绑定的源实例 ${input.source_instance_id} 与当前来源 ${snap.instanceId} 不符；源侧已有变化时重新 preview`);
    }
    checkNotSelf(snap, deps, {
      exists: true,
      db: tdb,
      cleanup: () => {},
      instanceId: tdb.getInstanceId(),
      product: targetProduct,
      schemaVersion: SCHEMA_VERSION,
    });
    const planDigest = planDigestOf({ ...normalized, sourceInstanceId: input.source_instance_id, revision: input.revision });

    // 先查回执（同键同参返回原成果；同键异参 request_conflict），再核对修订
    const existing = tdb.prepare("SELECT * FROM instance_imports WHERE request_key = ?").get(input.request_id) as Row | undefined;
    if (existing) {
      if (String(existing.plan_digest) !== planDigest) {
        fail("request_conflict", `request_id 已用于不同的导入请求：${input.request_id}（不自动重发，请以原请求键核实）`);
      }
      return {
        ok: true,
        replayed: true,
        import_id: String(existing.id),
        request_key: input.request_id,
        event_seq_from: existing.event_seq_from === null ? null : Number(existing.event_seq_from),
        event_seq_to: existing.event_seq_to === null ? null : Number(existing.event_seq_to),
        target_backup_path: String(existing.target_backup_path),
        target_backup_sha256: String(existing.target_backup_sha256),
        counts: (JSON.parse(String(existing.report)) as { counts: Record<string, number> }).counts,
        report: JSON.parse(String(existing.report)) as Record<string, unknown>,
        created_at: String(existing.created_at),
      };
    }

    const targetView: TargetView = {
      exists: true,
      db: tdb,
      cleanup: () => {},
      instanceId: tdb.getInstanceId(),
      product: targetProduct,
      schemaVersion: SCHEMA_VERSION,
    };
    const analysis = analyze(snap, targetView, normalized, deps);
    if (analysis.planErrors.length > 0) {
      fail("invalid_params", `计划存在未解决的问题：${analysis.planErrors.join("；")}（修订后重新 preview --plan）`);
    }
    if (analysis.revision !== input.revision) {
      fail("revision_conflict", "预览修订已过期（源或目标在预览后发生变化）；请重新 legacy-import preview --plan 再应用");
    }
    if (analysis.idConflicts.length > 0) {
      fail(
        "id_conflict",
        `目标已存在同 ID 资料且不属于本源此前导入（不覆盖未核实的目标数据）：${analysis.idConflicts
          .map((c) => `${c.kind}:${c.id}`)
          .join("，")}`,
      );
    }
    if (analysis.manifestConflicts.length > 0) {
      fail(
        "id_conflict",
        `目标已存在同键但内容不同的记录（不覆盖未核实的目标数据）：${analysis.manifestConflicts
          .map((c) => `${c.table}:${c.id}`)
          .join("，")}`,
      );
    }
    if (analysis.credentialConflicts.length > 0) {
      fail(
        "credential_conflict",
        `目标凭据库已有同名但内容不同的绑定（不覆盖未核实的目标凭据）：${analysis.credentialConflicts.join("，")}；请先核对或移除目标绑定`,
      );
    }
    if (analysis.fileConflicts.length > 0) {
      fail("file_conflict", `目标已存在同名文件且内容不同：${analysis.fileConflicts.map((c) => `${c.itemId}（${c.dest}）`).join("，")}`);
    }

    const importId = randomId("imp");
    const nowIso = new Date().toISOString();
    const backupDir = path.join(deps.targetDataDir, "migration", importId);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(backupDir, "target-before.db");

    // 凭据合并（幂等：重跑同名同值跳过）
    mergeCredentials(deps, analysis.set.credentials);

    // “核对备份”：导入前对目标库的完整备份；整库恢复的手工路径（见 docs/runtime.md）
    tdb.exec(`VACUUM INTO '${escapeSqlPath(backupPath)}'`);
    const backupSha = sha256File(backupPath);

    // 复制文件：先写临时名再 rename；复制前再核源 sha——快照之后源文件被改即中止
    for (const f of analysis.set.files) {
      if (f.action !== "copied") continue;
      if (sha256File(f.src) !== f.sha256) {
        fail("revision_conflict", `源文件在应用期间发生变化：${f.src}；请稳定后重跑同一计划`);
      }
      fs.mkdirSync(path.dirname(f.dest), { recursive: true, mode: 0o700 });
      const tmp = `${f.dest}.import-tmp`;
      fs.copyFileSync(f.src, tmp);
      fs.renameSync(tmp, f.dest);
    }

    // 角色工作目录在目标重建并取目标身份（ensureRoles 幂等跳过已有角色行，不会重建）
    const agentWorkBase = path.join(path.dirname(path.resolve(deps.targetDataDir)), "agent-work");
    const roleDirIdentity = new Map<string, { dir: string; real: string; dev: number; ino: number }>();
    for (const roleId of analysis.ids.roles) {
      const dir = path.join(agentWorkBase, roleId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const real = fs.realpathSync(dir);
      const stat = fs.statSync(real);
      roleDirIdentity.set(roleId, { dir, real, dev: stat.dev, ino: stat.ino });
    }
    deps.__testHooks?.afterFilesCopied?.();

    const set = analysis.set;
    const sessionDecisionById = new Map(analysis.sessionDecisions.map((d) => [d.id, d]));
    const projectDecisionById = new Map(analysis.projectDecisions.map((d) => [d.id, d]));
    const newSessionIds = new Set(analysis.ids.sessions);
    const newTasks = set.tasks.filter((t) => newSessionIds.has(String(t.session_id)));
    const newTaskIds = new Set(newTasks.map((t) => String(t.id)));
    const closingById = new Map(set.closings.map((c) => [c.task_id, c]));
    const effectUnknownTaskIds = new Set(set.effectUnknownTasks);
    const effectUnknownOpIds = new Set(set.effectUnknownOps);
    const staleIds = new Set(set.staleConfirmations);
    const runClosingIds = new Set(set.runClosings);
    const opSettleById = new Map(set.opSettles.map((o) => [o.id, o.to]));
    const eventSettleIds = new Set(set.eventSettles);

    const projectsToInsert = set.projects
      .filter((p) => analysis.ids.projects.includes(String(p.id)))
      .map((p) => {
        const d = projectDecisionById.get(String(p.id))!;
        return {
          ...p,
          name: d.targetName,
          create_request_id: null,
          root_cwd: d.rootDecision === "keep" ? p.root_cwd : null,
          root_real: d.rootDecision === "keep" ? p.root_real : null,
          root_dev: d.rootDecision === "keep" ? p.root_dev : null,
          root_ino: d.rootDecision === "keep" ? p.root_ino : null,
        };
      });
    const sessionsToInsert = set.sessions
      .filter((s) => newSessionIds.has(String(s.id)))
      .map((s) => {
        const d = sessionDecisionById.get(String(s.id))!;
        const base = { ...s, session_file: d.sessionFileTo, workspace_project_id: d.workspaceTo, create_request_id: null };
        // 角色会话：cwd 身份改写为目标 agent-work 目录（其他会话保留原值作归档）
        if (d.roleId !== null) {
          const idInfo = roleDirIdentity.get(d.roleId);
          if (idInfo) {
            return { ...base, cwd: idInfo.dir, cwd_real: idInfo.real, cwd_dev: idInfo.dev, cwd_ino: idInfo.ino };
          }
        }
        return base;
      });
    const rolesToInsert = set.roles
      .filter((r) => analysis.ids.roles.includes(String(r.id)))
      .map((r) => {
        const idInfo = roleDirIdentity.get(String(r.id));
        return idInfo ? { ...r, work_dir: idInfo.dir } : { ...r };
      });
    const subAgentsToInsert = set.subAgents
      .filter((r) => analysis.ids.subAgents.includes(String(r.id)))
      .map((r) => ({
        ...r,
        // 旧实例没有存活执行单元：按独立列以关闭状态登记；原工作目录不迁移
        closed_at: r.closed_at === null ? nowIso : r.closed_at,
        closed_by: r.closed_by === null ? "owner" : r.closed_by,
        state: "idle",
      }));
    const worksToInsert = set.workDelegations.filter((r) => analysis.ids.workDelegations.includes(String(r.id)));
    const messagesToInsert = set.subagentMessages.filter((r) => worksToInsert.some((w) => String(w.id) === String(r.work_id)));
    const tasksToInsert = newTasks.map((t) => {
      const closing = closingById.get(String(t.id));
      if (!closing) return t;
      if (closing.to === "canceled") {
        return { ...t, status: "canceled", error_message: "migration：导入不重放，排队任务已取消" };
      }
      return {
        ...t,
        status: "interrupted",
        interrupt_reason: "migration",
        effect_unknown: effectUnknownTaskIds.has(String(t.id)) ? 1 : t.effect_unknown,
      };
    });
    const toolOpsToInsert = set.toolOps
      .filter((op) => newTaskIds.has(String(op.task_id)))
      .map((op) => (effectUnknownOpIds.has(String(op.id)) ? { ...op, effect_unknown: 1 } : op));
    const confirmationsToInsert = set.confirmations
      .filter((c) => newSessionIds.has(String(c.session_id)))
      .map((c) => (staleIds.has(String(c.id)) ? { ...c, status: "stale" } : c));
    const artifactsToInsert = set.artifacts.filter((a) => newSessionIds.has(String(a.session_id)));
    const selectionsToInsert = set.selectionRecords.filter((r) => newSessionIds.has(String(r.session_id)));
    const checkpointsToInsert = set.checkpoints.filter((r) => newSessionIds.has(String(r.session_id)));
    const memoriesToInsert = set.memoriesImport.filter((m) => analysis.ids.memories.includes(String(m.id)));
    const memoryIdSet = new Set(memoriesToInsert.map((m) => String(m.id)));
    const versionsToInsert = set.memoryVersions.filter((v) => memoryIdSet.has(String(v.memory_id)));
    const grantsToInsert = set.grantsImport.filter((g) => analysis.ids.grants.includes(String(g.id)));
    const disabledMcpIds = new Set(
      set.mcps
        .filter((m) => analysis.mcpDisabled.some((d) => d.project_id === String(m.project_id) && d.name === String(m.name)))
        .map((m) => String(m.id)),
    );
    const mcpsToInsert = set.mcps
      .filter((m) => analysis.ids.mcps.includes(String(m.id)))
      .map((m) => (disabledMcpIds.has(String(m.id)) ? { ...m, enabled: 0 } : m));
    const metasToInsert = set.metas
      .filter((m) => analysis.ids.metas.includes(String(m.key)))
      .map((m) => {
        if (!analysis.jevMissingKeys.has(String(m.key))) return { key: m.key, value: m.value };
        try {
          const cfg = JSON.parse(String(m.value)) as Record<string, unknown>;
          return { key: m.key, value: JSON.stringify({ ...cfg, enabled: false }) };
        } catch {
          return { key: m.key, value: m.value };
        }
      });
    const schedulesToInsert = set.schedules.filter((s) => analysis.ids.schedules.includes(String(s.id)));
    const runsToInsert = set.scheduleRuns
      .filter((r) => analysis.manifestInsert.schedule_runs.includes(String(r.id)))
      .map((r) => (runClosingIds.has(String(r.id)) ? { ...r, closed_at: nowIso } : r));
    const eventsToInsert = set.inboundEvents
      .filter((e) => analysis.manifestInsert.inbound_events.includes(String(e.id)))
      .map((e) => (eventSettleIds.has(String(e.id)) ? { ...e, status: "failed" } : e));
    const opsToInsert = set.notificationOps
      .filter((o) => analysis.manifestInsert.notification_ops.includes(String(o.id)))
      .map((o) => {
        const to = opSettleById.get(String(o.id));
        if (to === "canceled") {
          return {
            ...o,
            status: "canceled",
            error_kind: "migration",
            error_message: "导入不重放：已知未发送的待发操作，交接后由目标侧调度按到期自然触发",
            settled_at: nowIso,
            updated_at: nowIso,
          };
        }
        if (to === "effect_unknown") {
          return {
            ...o,
            status: "effect_unknown",
            error_kind: "migration",
            error_message: "导入时处于发送中，效果未知（不自动重发，由拥有者核实）",
            settled_at: nowIso,
            updated_at: nowIso,
          };
        }
        return o;
      });
    const standingToInsert = set.standingPermissions.filter((p) => analysis.ids.standingPermissions.includes(String(p.id)));
    const byManifest = (table: string, rows: Row[]): Row[] => rows.filter((r) => analysis.manifestInsert[table].includes(manifestIdOf(table, r)));

    // 快照里 v9 前遗留表（github_*）在全新目标不存在：按快照 DDL 在导入事务内重建
    const legacyDdl: string[] = [];
    for (const table of ["github_repo_bindings", "github_drafts", "github_publish_ops"]) {
      if (manifestTablesRows(set)[table].length === 0) continue;
      const has = tdb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
      if (has) continue;
      const ddl = snap.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
      if (!ddl) continue;
      legacyDdl.push(ddl.sql);
      for (const idx of allRows(snap.db, "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL", [table])) {
        legacyDdl.push(String(idx.sql));
      }
    }

    const counts: Record<string, number> = {
      agent_roles: rolesToInsert.length,
      projects: projectsToInsert.length,
      sessions: sessionsToInsert.length,
      sub_agents: subAgentsToInsert.length,
      work_delegations: worksToInsert.length,
      subagent_messages: messagesToInsert.length,
      tasks: tasksToInsert.length,
      tool_ops: toolOpsToInsert.length,
      confirmations: confirmationsToInsert.length,
      artifacts: artifactsToInsert.length,
      selection_records: selectionsToInsert.length,
      context_checkpoints: checkpointsToInsert.length,
      memories: memoriesToInsert.length,
      memory_versions: versionsToInsert.length,
      data_grants: grantsToInsert.length,
      mcp_services: mcpsToInsert.length,
      meta: metasToInsert.length,
      schedules: schedulesToInsert.length,
      schedule_runs: runsToInsert.length,
      notification_ops: opsToInsert.length,
      inbound_events: eventsToInsert.length,
      standing_permissions: standingToInsert.length,
      qq_config: analysis.ids.platformConfigs.includes("qq_config") ? 1 : 0,
      telegram_config: analysis.ids.platformConfigs.includes("telegram_config") ? 1 : 0,
      qq_sessions: byManifest("qq_sessions", set.qqSessions).length,
      qq_inbox: byManifest("qq_inbox", set.qqInbox).length,
      qq_outbox: byManifest("qq_outbox", set.qqOutbox).length,
      chat_result_acceptances: byManifest("chat_result_acceptances", set.chatResultAcceptances).length,
      github_repo_bindings: byManifest("github_repo_bindings", set.githubRepoBindings).length,
      github_drafts: byManifest("github_drafts", set.githubDrafts).length,
      github_publish_ops: byManifest("github_publish_ops", set.githubPublishOps).length,
      events: analysis.newEvents.length,
      files_copied: set.files.filter((f) => f.action === "copied").length,
      files_skipped_same_sha: set.files.filter((f) => f.action === "skipped_same_sha").length,
      credentials_copied: set.credentials.filter((c) => c.action === "copy").length,
      tasks_canceled: set.closings.filter((c) => c.to === "canceled").length,
      tasks_interrupted: set.closings.filter((c) => c.to === "interrupted").length,
      confirmations_staled: set.staleConfirmations.length,
      effect_unknown_tasks: set.effectUnknownTasks.length,
      schedule_runs_closed: runClosingIds.size,
      ops_canceled_pending: set.opSettles.filter((o) => o.to === "canceled").length,
      ops_effect_unknown: set.opSettles.filter((o) => o.to === "effect_unknown").length,
      inbound_events_failed: eventSettleIds.size,
    };

    const report: Record<string, unknown> = {
      version: 1,
      direction: "personal-into-ruukoto",
      counts,
      source: {
        dir: snap.dataDir,
        instance_id: snap.instanceId,
        product: snap.product,
        schema_version_original: snap.originalSchemaVersion,
      },
      handover: {
        platforms: [set.qqConfig ? "qq" : null, set.telegramConfig ? "telegram" : null].filter((x) => x !== null),
        schedules_active: set.schedules.filter((s) => s.status === "active").length,
        standing_active: set.standingPermissions.filter((p) => p.revoked_at === null).length,
        note: "平台连接与调度的执行归属移到目标；旧实例不得再启动消费同一入站或同一批通知",
      },
      settles: {
        closings: set.closings,
        stale_confirmations: set.staleConfirmations,
        effect_unknown_tasks: set.effectUnknownTasks,
        full_access_kept: set.fullAccessKept,
        schedule_runs_closed: set.runClosings,
        op_settles: set.opSettles,
        inbound_events_failed: set.eventSettles,
      },
      /** 本事务插入的易变行整行 sha256，按写入目标的转换后行计算（回退时逐行核对，
       *  目标运行时改写即阻挡项；已在更早导入中的行归属各次回执，不在本回执 manifest）。 */
      manifest: [
        ...digestsOf("schedules", schedulesToInsert),
        ...digestsOf("schedule_runs", runsToInsert),
        ...digestsOf("notification_ops", opsToInsert),
        ...digestsOf("inbound_events", eventsToInsert),
        ...digestsOf("standing_permissions", standingToInsert),
        ...["qq_sessions", "qq_inbox", "qq_outbox", "chat_result_acceptances", "github_repo_bindings", "github_drafts", "github_publish_ops"].flatMap(
          (table) => digestsOf(table, byManifest(table, manifestTablesRows(set)[table])),
        ),
        ...(analysis.ids.platformConfigs.includes("qq_config") && set.qqConfig
          ? [{ table: "qq_config", id: "1", sha: sha256(canonicalJson(set.qqConfig)) }]
          : []),
        ...(analysis.ids.platformConfigs.includes("telegram_config") && set.telegramConfig
          ? [{ table: "telegram_config", id: "1", sha: sha256(canonicalJson(set.telegramConfig)) }]
          : []),
      ],
      root_decisions: analysis.projectDecisions.map((d) => ({
        project_id: d.id,
        decision: d.rootDecision,
        reason: d.rootReason,
        target_occupant: d.targetOccupant,
      })),
      workspace_mappings: analysis.sessionDecisions
        .filter((d) => d.workspaceFrom !== null || d.workspaceReason !== null)
        .map((d) => ({ session_id: d.id, from: d.workspaceFrom, to: d.workspaceTo, reason: d.workspaceReason })),
      app_data_binding: set.appDataBinding,
      files: set.files.map((f) => ({ itemId: f.itemId, kind: f.kind, ownerId: f.ownerId, dest: f.dest, bytes: f.bytes, sha256: f.sha256, action: f.action })),
      missing_files: set.missingFiles,
      credentials: set.credentials.map((c) => ({ name: c.name, purpose: c.purpose, action: c.action ?? "missing_in_source", sha256: c.sha256 })),
      mcp_disabled: analysis.mcpDisabled,
      jev_disabled: analysis.jevDisabled,
      memory_pending: set.memoryPending,
      grants_cross_instance: set.grantsCrossInstance.map((g) => ({
        id: String(g.id),
        from_project_id: String(g.from_project_id),
        to_project_id: String(g.to_project_id),
        category: String(g.category),
        revoked: g.revoked_at !== null,
        note: "跨实例，不生效",
      })),
      excluded_projects: set.excludedProjects,
      excluded_sessions: set.excludedSessions,
      skipped_already_imported: analysis.skippedAlreadyImported,
    };

    const maxBefore = tdb.prepare("SELECT COALESCE(MAX(seq), 0) m FROM events").get() as { m: number };
    const ledgerItems: Array<{ kind: LedgerKind; item_id: string }> = [
      ...analysis.ids.roles.map((id) => ({ kind: "agent_role" as const, item_id: id })),
      ...analysis.ids.projects.map((id) => ({ kind: "project" as const, item_id: id })),
      ...analysis.ids.sessions.map((id) => ({ kind: "session" as const, item_id: id })),
      ...analysis.ids.subAgents.map((id) => ({ kind: "sub_agent" as const, item_id: id })),
      ...analysis.ids.workDelegations.map((id) => ({ kind: "work_delegation" as const, item_id: id })),
      ...analysis.ids.memories.map((id) => ({ kind: "memory" as const, item_id: id })),
      ...analysis.ids.grants.map((id) => ({ kind: "grant" as const, item_id: id })),
      ...analysis.ids.mcps.map((id) => ({ kind: "mcp" as const, item_id: id })),
      ...analysis.ids.metas.map((id) => ({ kind: "meta" as const, item_id: id })),
      ...analysis.ids.schedules.map((id) => ({ kind: "schedule" as const, item_id: id })),
      ...analysis.ids.standingPermissions.map((id) => ({ kind: "standing_permission" as const, item_id: id })),
      ...analysis.ids.platformConfigs.map((id) => ({ kind: "platform_config" as const, item_id: id })),
      // 文件与凭据归属同 21 规则（含失败续跑：已复制/已合并但账本未提交时本轮归属本次）
      ...set.files
        .filter((f) => f.action === "copied" || f.action === "skipped_same_sha")
        .filter((f) => !tdb.prepare("SELECT 1 FROM instance_import_items WHERE kind = 'file' AND item_id = ?").get(f.itemId))
        .map((f) => ({ kind: "file" as const, item_id: f.itemId })),
      ...set.credentials
        .filter((c) => (c.action === "copy" || c.action === "skip_same") && c.presentInSource)
        .filter((c) => !tdb.prepare("SELECT 1 FROM instance_import_items WHERE kind = 'credential' AND item_id = ?").get(c.name))
        .map((c) => ({ kind: "credential" as const, item_id: c.name })),
    ];

    let seqFrom: number | null = null;
    let seqTo: number | null = null;
    tdb.tx(() => {
      // 产品归属：目标从未登记时补记为 ruukoto（已核 null 或 ruukoto）
      tdb.prepare(`INSERT INTO meta (key, value) VALUES ('${PRODUCT_META_KEY}', 'ruukoto') ON CONFLICT(key) DO NOTHING`).run();
      for (const sql of legacyDdl) tdb.exec(sql);
      insertRows(tdb, "projects", projectsToInsert);
      insertRows(tdb, "sessions", sessionsToInsert);
      deps.__testHooks?.insideImportTx?.();
      insertRows(tdb, "agent_roles", rolesToInsert);
      insertRows(tdb, "qq_sessions", byManifest("qq_sessions", set.qqSessions));
      insertRows(tdb, "sub_agents", subAgentsToInsert);
      insertRows(tdb, "work_delegations", worksToInsert);
      insertRows(tdb, "subagent_messages", messagesToInsert);
      insertRows(tdb, "tasks", tasksToInsert);
      insertRows(tdb, "tool_ops", toolOpsToInsert);
      insertRows(tdb, "confirmations", confirmationsToInsert);
      insertRows(tdb, "artifacts", artifactsToInsert);
      insertRows(tdb, "selection_records", selectionsToInsert);
      insertRows(tdb, "context_checkpoints", checkpointsToInsert);
      insertRows(tdb, "memories", memoriesToInsert);
      insertRows(tdb, "memory_versions", versionsToInsert);
      insertRows(tdb, "data_grants", grantsToInsert);
      insertRows(tdb, "mcp_services", mcpsToInsert);
      insertRows(tdb, "meta", metasToInsert);
      insertRows(tdb, "schedules", schedulesToInsert);
      insertRows(tdb, "schedule_runs", runsToInsert);
      insertRows(tdb, "inbound_events", eventsToInsert);
      insertRows(tdb, "notification_ops", opsToInsert);
      insertRows(tdb, "standing_permissions", standingToInsert);
      insertRows(tdb, "qq_inbox", byManifest("qq_inbox", set.qqInbox));
      insertRows(tdb, "qq_outbox", byManifest("qq_outbox", set.qqOutbox));
      insertRows(tdb, "chat_result_acceptances", byManifest("chat_result_acceptances", set.chatResultAcceptances));
      insertRows(tdb, "github_repo_bindings", byManifest("github_repo_bindings", set.githubRepoBindings));
      insertRows(tdb, "github_drafts", byManifest("github_drafts", set.githubDrafts));
      insertRows(tdb, "github_publish_ops", byManifest("github_publish_ops", set.githubPublishOps));
      if (set.qqConfig && analysis.ids.platformConfigs.includes("qq_config")) insertRows(tdb, "qq_config", [set.qqConfig]);
      if (set.telegramConfig && analysis.ids.platformConfigs.includes("telegram_config")) insertRows(tdb, "telegram_config", [set.telegramConfig]);
      insertRows(tdb, "events", analysis.newEvents, ["seq"]);
      const maxAfter = tdb.prepare("SELECT COALESCE(MAX(seq), 0) m FROM events").get() as { m: number };
      if (analysis.newEvents.length > 0) {
        if (maxAfter.m - maxBefore.m !== analysis.newEvents.length) {
          fail("internal_error", `事件导入数量不符：预期新增 ${analysis.newEvents.length}，实际 ${maxAfter.m - maxBefore.m}`);
        }
        seqFrom = maxBefore.m + 1;
        seqTo = maxAfter.m;
      }
      tdb
        .prepare(
          `INSERT INTO instance_imports
             (id, request_key, source_instance_id, source_product, source_schema_version, source_dir,
              plan_digest, target_backup_path, target_backup_sha256, event_seq_from, event_seq_to,
              report, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)`,
        )
        .run(
          importId,
          input.request_id,
          snap.instanceId,
          snap.product,
          snap.originalSchemaVersion,
          snap.dataDir,
          planDigest,
          backupPath,
          backupSha,
          seqFrom,
          seqTo,
          JSON.stringify(report),
          nowIso,
        );
      // 条目账本在回执之后入库（import_id 外键引用回执行）
      for (const item of ledgerItems) {
        tdb.prepare("INSERT INTO instance_import_items (kind, item_id, import_id) VALUES (?, ?, ?)").run(item.kind, item.item_id, importId);
      }
    });

    return {
      ok: true,
      replayed: false,
      import_id: importId,
      request_key: input.request_id,
      event_seq_from: seqFrom,
      event_seq_to: seqTo,
      target_backup_path: backupPath,
      target_backup_sha256: backupSha,
      counts,
      report,
      created_at: nowIso,
    };
  } finally {
    snap.cleanup();
    tdb.close();
  }
}

function manifestTablesRows(set: PersonalImportSet): Record<string, Row[]> {
  return {
    schedules: set.schedules,
    schedule_runs: set.scheduleRuns,
    notification_ops: set.notificationOps,
    inbound_events: set.inboundEvents,
    standing_permissions: set.standingPermissions,
    qq_sessions: set.qqSessions,
    qq_inbox: set.qqInbox,
    qq_outbox: set.qqOutbox,
    chat_result_acceptances: set.chatResultAcceptances,
    github_repo_bindings: set.githubRepoBindings,
    github_drafts: set.githubDrafts,
    github_publish_ops: set.githubPublishOps,
  };
}

function digestsOf(table: string, rows: Row[]): ManifestRow[] {
  return rows.map((row) => ({ table, id: manifestIdOf(table, row), sha: sha256(canonicalJson(row)) }));
}

// ---------- 回退 ----------

export function revertPersonalImport(deps: LegacyImportDeps, importId: string): LegacyImportRevertResult {
  if (typeof importId !== "string" || importId === "") fail("invalid_params", "缺少导入 ID（legacy-import list 查看）");
  const targetDbFile = path.join(deps.targetDataDir, "ruukoto.db");
  if (!fs.existsSync(targetDbFile)) fail("not_found", `目标数据目录没有 ruukoto.db：${deps.targetDataDir}`);
  const tdb = new Db(deps.targetDataDir);
  try {
    const receipt = tdb.prepare("SELECT * FROM instance_imports WHERE id = ?").get(importId) as Row | undefined;
    if (!receipt) fail("not_found", `没有该导入回执：${importId}`);
    if (String(receipt.status) !== "applied") fail("invalid_params", `导入 ${importId} 已处于 ${String(receipt.status)} 状态`);
    const report = JSON.parse(String(receipt.report)) as {
      direction?: string;
      files?: Array<{ itemId: string; dest: string; sha256: string; action?: string }>;
      manifest?: Array<{ table: string; id: string; sha: string }>;
      credentials?: Array<{ name: string; sha256: string | null }>;
    };
    if (report.direction !== "personal-into-ruukoto") {
      fail("invalid_params", `导入 ${importId} 不是个人方向的导入回执（ruukoto-dev 侧导入请用 ruukoto-dev legacy-import revert）`);
    }
    const items = allRows(tdb, "SELECT kind, item_id FROM instance_import_items WHERE import_id = ?", [importId]);
    const byKind = (kind: LedgerKind) => items.filter((i) => String(i.kind) === kind).map((i) => String(i.item_id));
    const projectIds = byKind("project");
    const sessionIds = byKind("session");
    const subAgentIds = byKind("sub_agent");
    const workIds = byKind("work_delegation");
    const memoryIds = byKind("memory");
    const grantIds = byKind("grant");
    const mcpIds = byKind("mcp");
    const metaKeys = byKind("meta");
    const roleIds = byKind("agent_role");
    const scheduleIds = byKind("schedule");
    const standingIds = byKind("standing_permission");
    const platformIds = byKind("platform_config");
    const credentialNames = byKind("credential");
    const createdAt = String(receipt.created_at);
    const inMarks = (ids: string[]) => ids.map(() => "?").join(",") || "''";

    // 阻挡项：导入后目标侧的自有活动是事实，不能抹掉（逐项列出）；时间比较用
    // >= 收口同一毫秒内的导入后创建。回退只保留切换期间新增的执行及发送事实
    const blockers: string[] = [];
    const sessionTaskIds = new Set(sessionIds.length > 0 ? rowsIn(tdb, "tasks", "session_id", sessionIds).map((t) => String(t.id)) : []);
    for (const t of allRows(tdb, `SELECT id FROM tasks WHERE session_id IN (${inMarks(sessionIds)}) AND created_at >= ?`, [...sessionIds, createdAt])) {
      blockers.push(`导入的会话在导入后有新任务：${String(t.id)}`);
    }
    for (const s of allRows(tdb, `SELECT id FROM sessions WHERE project_id IN (${inMarks(projectIds)}) AND created_at >= ?`, [...projectIds, createdAt])) {
      blockers.push(`导入的项目在导入后有新会话：${String(s.id)}`);
    }
    for (const g of allRows(
      tdb,
      `SELECT id FROM data_grants WHERE (from_project_id IN (${inMarks(projectIds)}) OR to_project_id IN (${inMarks(projectIds)})) AND created_at >= ?`,
      [...projectIds, ...projectIds, createdAt],
    )) {
      blockers.push(`导入的项目在导入后有新授权：${String(g.id)}`);
    }
    for (const s of allRows(
      tdb,
      `SELECT id FROM sessions WHERE workspace_project_id IN (${inMarks(projectIds)}) AND id NOT IN (${inMarks(sessionIds)})`,
      [...projectIds, ...sessionIds],
    )) {
      blockers.push(`导入的项目被其他会话用作组织归属：${String(s.id)}`);
    }
    for (const v of allRows(tdb, `SELECT memory_id, version FROM memory_versions WHERE memory_id IN (${inMarks(memoryIds)}) AND created_at >= ?`, [
      ...memoryIds,
      createdAt,
    ])) {
      blockers.push(`导入的记忆在导入后有新版本：${String(v.memory_id)} v${Number(v.version)}`);
    }
    // 个人方向特有：切换后的真实平台/调度活动（新入站、新发送、新调度、新运行、新授权）
    for (const e of allRows(tdb, "SELECT id FROM inbound_events WHERE received_at >= ?", [createdAt])) {
      blockers.push(`导入后有新入站事件（平台已在目标消费）：${String(e.id)}`);
    }
    for (const o of allRows(tdb, "SELECT id FROM notification_ops WHERE created_at >= ?", [createdAt])) {
      blockers.push(`导入后有新发送操作（发送事实不能抹掉）：${String(o.id)}`);
    }
    for (const s of allRows(tdb, "SELECT id FROM schedules WHERE created_at >= ?", [createdAt])) {
      blockers.push(`导入后有新调度计划：${String(s.id)}`);
    }
    for (const r of allRows(tdb, "SELECT id FROM schedule_runs WHERE registered_at >= ?", [createdAt])) {
      blockers.push(`导入后有新调度运行（目标已在执行调度）：${String(r.id)}`);
    }
    for (const p of allRows(tdb, "SELECT id FROM standing_permissions WHERE created_at >= ?", [createdAt])) {
      blockers.push(`导入后有新长期授权：${String(p.id)}`);
    }
    const seqTo = receipt.event_seq_to === null ? null : Number(receipt.event_seq_to);
    for (const e of allRows(
      tdb,
      `SELECT seq FROM events WHERE seq > ?
        AND ((session_id IS NOT NULL AND session_id IN (${inMarks(sessionIds)}))
         OR (task_id IS NOT NULL AND task_id IN (${inMarks([...sessionTaskIds])})))`,
      [seqTo ?? -1, ...sessionIds, ...sessionTaskIds],
    )) {
      blockers.push(`导入的会话/任务在导入后有新事件：seq ${Number(e.seq)}`);
    }
    const seqFrom = receipt.event_seq_from === null ? null : Number(receipt.event_seq_from);
    if (seqFrom !== null && seqTo !== null) {
      const alien = tdb
        .prepare(
          `SELECT seq FROM events WHERE seq BETWEEN ? AND ?
            AND NOT ((session_id IS NOT NULL AND session_id IN (${inMarks(sessionIds)}))
              OR (task_id IS NOT NULL AND task_id IN (${inMarks([...sessionTaskIds])}))) LIMIT 1`,
        )
        .get(seqFrom, seqTo, ...sessionIds, ...sessionTaskIds);
      if (alien) fail("internal_error", `事件区间含不属于本次导入的事件：seq ${Number((alien as Row).seq)}`);
    }
    // 易变行逐行 sha 核对：目标运行时的任何改写（已发送、已 advance、已消费
    // offset、撤回标记更新）都是事实，拒绝回退；行已不在则视为已被前次回退移除
    const manifestIdsByTable = new Map<string, string[]>();
    for (const m of report.manifest ?? []) {
      if (!manifestIdsByTable.has(m.table)) manifestIdsByTable.set(m.table, []);
      manifestIdsByTable.get(m.table)!.push(m.id);
      const col =
        m.table === "qq_sessions" ? null : m.table === "qq_inbox" ? "dedup_key" : m.table === "qq_outbox" ? "op_id" : m.table === "chat_result_acceptances" ? null : "id";
      let current: Row | undefined;
      try {
        if (m.table === "qq_sessions") {
          const [account, groupId] = m.id.split(":");
          current = tdb.prepare("SELECT * FROM qq_sessions WHERE account = ? AND group_id = ?").get(account, groupId) as Row | undefined;
        } else if (m.table === "chat_result_acceptances") {
          const idx = m.id.indexOf(":");
          current = tdb
            .prepare("SELECT * FROM chat_result_acceptances WHERE main_project_id = ? AND task_id = ?")
            .get(m.id.slice(0, idx), m.id.slice(idx + 1)) as Row | undefined;
        } else {
          current = tdb.prepare(`SELECT * FROM ${m.table} WHERE ${col} = ?`).get(m.id) as Row | undefined;
        }
      } catch {
        current = undefined; // 表已不在（如遗留表被前次回退留下的实例形态移除）：按缺失处理
      }
      if (current === undefined) continue;
      if (sha256(canonicalJson(current)) !== m.sha) {
        blockers.push(`导入行在导入后被目标运行时改写（事实不回退）：${m.table}:${m.id}`);
        continue;
      }
    }
    // 复制文件经 sha256 核对才删除（同 21：含 app-data 两文件与归档 manifest）
    const filesKept: LegacyImportRevertResult["files_kept"] = [];
    const filesToRemove: Array<{ itemId: string; dest: string }> = [];
    const fileLedger = new Set(byKind("file"));
    for (const f of report.files ?? []) {
      if (!fileLedger.has(f.itemId)) {
        filesKept.push({ item: f.itemId, reason: "不属于本次导入（已由此前导入登记，不重复归属）" });
        continue;
      }
      if (!fs.existsSync(f.dest)) {
        filesKept.push({ item: f.itemId, reason: "文件已不存在（不回退也不重建）" });
        continue;
      }
      if (sha256File(f.dest) !== f.sha256) {
        blockers.push(`导入的文件在导入后被修改（app 数据或历史的事实性变更）：${f.dest}`);
        continue;
      }
      filesToRemove.push({ itemId: f.itemId, dest: f.dest });
    }
    // 凭据：sha 不符 = 目标侧已轮换或改写，拒绝；已不在记为说明
    const credShaByName = new Map((report.credentials ?? []).map((c) => [c.name, c.sha256]));
    const targetCredentialsFile = path.join(deps.targetAgentDir, "credentials.json");
    const currentBindings = readCredentialsFile(targetCredentialsFile);
    const credentialsToRemove: string[] = [];
    for (const name of credentialNames) {
      const expected = credShaByName.get(name);
      const current = currentBindings.get(name);
      if (!current) {
        filesKept.push({ item: `credential ${name}`, reason: "绑定已不存在（不回退也不重建）" });
        continue;
      }
      if (expected !== undefined && expected !== null && sha256(canonicalJson(current)) !== expected) {
        blockers.push(`导入的凭据绑定在导入后被改写（轮换是目标侧事实）：${name}`);
        continue;
      }
      credentialsToRemove.push(name);
    }
    if (blockers.length > 0) {
      return { ok: false, import_id: importId, status: "applied", removed: {}, files_removed: [], files_kept: filesKept, blockers };
    }

    const removed: Record<string, number> = {};
    tdb.tx(() => {
      const del = (sql: string, params: unknown[], key: string): void => {
        const r = tdb.prepare(sql).run(...(params as never[]));
        removed[key] = Number(r.changes);
      };
      if (seqFrom !== null && seqTo !== null) del("DELETE FROM events WHERE seq BETWEEN ? AND ?", [seqFrom, seqTo], "events");
      // 易变 manifest 表按本次导入的 id 列表删除（archive 与交接两类的运行时改写已在上方拦住）
      const delManifest = (table: string, where: string): void => {
        const ids = manifestIdsByTable.get(table) ?? [];
        if (ids.length === 0) return;
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500);
          const r = tdb.prepare(`DELETE FROM ${table} WHERE ${where} IN (${chunk.map(() => "?").join(",")})`).run(...(chunk as never[]));
          removed[table] = (removed[table] ?? 0) + Number(r.changes);
        }
      };
      {
        const acceptanceIds = manifestIdsByTable.get("chat_result_acceptances") ?? [];
        if (acceptanceIds.length > 0) {
          del(
            `DELETE FROM chat_result_acceptances WHERE (main_project_id || ':' || task_id) IN (${acceptanceIds.map(() => "?").join(",")})`,
            acceptanceIds,
            "chat_result_acceptances",
          );
        }
      }
      delManifest("qq_inbox", "dedup_key");
      delManifest("qq_outbox", "op_id");
      delManifest("notification_ops", "id");
      delManifest("schedule_runs", "id");
      delManifest("inbound_events", "id");
      delManifest("github_repo_bindings", "id");
      delManifest("github_drafts", "id");
      delManifest("github_publish_ops", "id");
      del(`DELETE FROM standing_permissions WHERE id IN (${inMarks(standingIds)})`, standingIds, "standing_permissions");
      del(`DELETE FROM schedules WHERE id IN (${inMarks(scheduleIds)})`, scheduleIds, "schedules");
      if (platformIds.includes("qq_config")) del("DELETE FROM qq_config WHERE id = 1", [], "qq_config");
      if (platformIds.includes("telegram_config")) del("DELETE FROM telegram_config WHERE id = 1", [], "telegram_config");
      for (const itemId of platformIds.filter((x) => x.startsWith("qq_sessions:"))) {
        const [account, groupId] = itemId.slice("qq_sessions:".length).split(":");
        const r = tdb.prepare("DELETE FROM qq_sessions WHERE account = ? AND group_id = ?").run(account, groupId);
        removed.qq_sessions = (removed.qq_sessions ?? 0) + Number(r.changes);
      }
      del(`DELETE FROM agent_roles WHERE id IN (${inMarks(roleIds)})`, roleIds, "agent_roles");
      for (const t of ["history_index", "history_index_state", "context_checkpoints", "selection_records", "confirmations", "artifacts"]) {
        del(`DELETE FROM ${t} WHERE session_id IN (${inMarks(sessionIds)})`, sessionIds, t);
      }
      del(`DELETE FROM tool_ops WHERE task_id IN (${inMarks([...sessionTaskIds])})`, [...sessionTaskIds], "tool_ops");
      del(`DELETE FROM tasks WHERE session_id IN (${inMarks(sessionIds)})`, sessionIds, "tasks");
      // 工作内消息（issue 13）随工作折叠回退：先于所属工作删除
      del(`DELETE FROM subagent_messages WHERE work_id IN (${inMarks(workIds)})`, workIds, "subagent_messages");
      del(`DELETE FROM work_delegations WHERE id IN (${inMarks(workIds)})`, workIds, "work_delegations");
      del(`DELETE FROM sub_agents WHERE id IN (${inMarks(subAgentIds)})`, subAgentIds, "sub_agents");
      del(`DELETE FROM memory_versions WHERE memory_id IN (${inMarks(memoryIds)})`, memoryIds, "memory_versions");
      del(`DELETE FROM memories WHERE id IN (${inMarks(memoryIds)})`, memoryIds, "memories");
      del(`DELETE FROM data_grants WHERE id IN (${inMarks(grantIds)})`, grantIds, "data_grants");
      del(`DELETE FROM mcp_services WHERE id IN (${inMarks(mcpIds)})`, mcpIds, "mcp_services");
      del(`DELETE FROM meta WHERE key IN (${inMarks(metaKeys)})`, metaKeys, "meta");
      del(`DELETE FROM sessions WHERE id IN (${inMarks(sessionIds)})`, sessionIds, "sessions");
      del(`DELETE FROM projects WHERE id IN (${inMarks(projectIds)})`, projectIds, "projects");
      del("DELETE FROM instance_import_items WHERE import_id = ?", [importId], "instance_import_items");
      tdb.prepare("UPDATE instance_imports SET status = 'reverted', reverted_at = ? WHERE id = ?").run(new Date().toISOString(), importId);
    });
    // 事务提交后删除经核对的复制文件与凭据绑定（失败不回头：行已删，残留不被引用）
    const filesRemoved: string[] = [];
    for (const f of filesToRemove) {
      try {
        fs.rmSync(f.dest, { force: true });
        filesRemoved.push(f.dest);
      } catch (err) {
        filesKept.push({ item: f.itemId, reason: `删除失败：${(err as Error).message}` });
      }
    }
    if (credentialsToRemove.length > 0) {
      try {
        const data = JSON.parse(fs.readFileSync(targetCredentialsFile, "utf8")) as { bindings: Array<{ name: string }> };
        const drop = new Set(credentialsToRemove);
        fs.writeFileSync(
          targetCredentialsFile,
          JSON.stringify({ bindings: data.bindings.filter((b) => !drop.has(String(b.name))) }, null, 2),
          { mode: 0o600 },
        );
      } catch (err) {
        filesKept.push({ item: "credentials", reason: `凭据摘除失败：${(err as Error).message}` });
      }
    }
    return { ok: true, import_id: importId, status: "reverted", removed, files_removed: filesRemoved, files_kept: filesKept };
  } finally {
    tdb.close();
  }
}
