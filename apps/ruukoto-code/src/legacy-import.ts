import { verifyImportedBranchSources, verifyImportedAgentWaitReferences, archiveImportedAgentWaits, verifyImportedSubAgentDefinitions, verifyImportedSubAgentExecutions, verifyImportedWorkCopySnapshots, verifyImportedWorkCopyHosts } from "@ruukoto/core/import-support.ts";
/**
 * 旧实例开发资料迁入 Coding Agent（agent-direction issue 21）。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-04-legacy-instance-import.md
 *
 * 本方向的唯一实现处：预览（preview）、应用（apply）、回退（revert）与列表的
 * 全部判断都集中在本模块；CLI（ruukoto-code legacy-import）只做离线接线，不走
 * 控制面。镜像方向（个人资料迁入全新 ruukoto 实例，issue 22）在
 * core/import-support.ts 的快照、账本与行工具；个人 durable 不导入旧实例。
 * 边界：
 * Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-03-legacy-workspace-org-attribution.md
 * - 源实例全程只读：不建锁、不改写、不修复源目录任何文件；快照 = 把 ruukoto.db
 *   （及 WAL 侧车文件）复制到临时目录后校验当前 schema，源目录逐文件
 *   sha 不变。源后台存活（或身份无法核实）时拒绝。
 * - 目标侧离线：要求目标后台已停止，CLI 持目标实例锁执行；预览对目标零写入
 *   （目标库也经副本只读读取），应用先备份目标库再文件复制、最后一个事务入库。
 * - 导入单位 = 源项目内的普通 dev 会话（含其 SubAgent 一层）；角色绑定会话、
 *   QQ 群会话与 main 资料一律排除。行 ID 原样保留，历史的 JSONL / 产物正文 /
 *   记忆 sourceRefs / resultRef 都不重写。
 * - 不重放：未终态任务收尾为 canceled / interrupted（原因 migration），未消费
 *   审批一律 stale，full_access 会话默认降为 confirm，会话不在目标入队。
 * - 幂等与回退：instance_imports 回执（请求键幂等：同键同参返回原成果，同键
 *   异参 request_conflict）+ instance_import_items 账本；回退按账本删除行、
 *   事件区间与经 sha256 核对的复制文件，导入后目标的自有活动是回退阻挡项。
 *   任何路径都不删除或修改源资料。
 */

import { Db,SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import { canonicalJson,historyStatusOf,sha256 } from "@ruukoto/core/import-files.ts";
import { LegacyImportError,allRows,checkTablePolicy,rejectWorkflowImport,escapeSqlPath,fail,insertRows,memoryRefsInScope,openSourceSnapshot,openTargetReadonlyCopy,readLedger,readMetaValue,rowsIn,sha256File,strictDirOk,type FilePlanItem,type LedgerKind,type LegacyImportApplyResult,type LegacyImportDeps,type LegacyImportRevertResult,type Row,type SourceSnapshot,type TablePolicy,type TargetView,type TaskClosing } from "@ruukoto/core/import-support.ts";
import { PRODUCT_META_KEY } from "@ruukoto/core/product.ts";
import { randomId,type Session } from "@ruukoto/core/types.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------- 计划与依赖的线上形状（snake_case；CLI 计划文件与参数共用） ----------

/** 拥有者在计划文件中的显式选择；from / source_instance_id / revision 为绑定字段。 */
export interface LegacyImportPlan {
  /** 源项目 id → 目标侧项目名（仅重名时需要）。 */
  renames?: Record<string, string>;
  /** 显式选中发布的 personal 记忆 id（其余 personal 记忆不复制，列为待处理）。 */
  personal_memories?: string[];
}

const TABLE_POLICY: TablePolicy = {
  code_schedules: { policy: "exclude", reason: "Coding 定时计划只属于原实例，非空源库明确拒绝" },
  code_schedule_runs: { policy: "exclude", reason: "Coding 调度运行与快照不能跨实例复制" },
  code_schedule_tasks: { policy: "exclude", reason: "Coding 定时来源归属不得丢弃或改为拥有者输入" },
  code_schedule_receipts: { policy: "exclude", reason: "Coding 计划写入回执只属于原实例" },
  owner_questions: { policy: "exclude", reason: "问题与答案续接绑定原实例，非空源库明确拒绝" },
  owner_question_receipts: { policy: "exclude", reason: "回答与取消回执只属于原实例" },
  background_processes: { policy: "exclude", reason: "后台执行与目录占用只属于原实例，非空源库明确拒绝" },
  background_process_closures: { policy: "exclude", reason: "会话后台关闭屏障只属于原实例" },
  agent_waits: { policy: "import" },
  agent_reports: { policy: "import" },
  workflow_definitions: { policy: "exclude", reason: "工作流定义保留在来源实例，不随普通资料导入" },
  workflow_definition_refs: { policy: "exclude", reason: "命名版本与保存回执保留在来源实例" },
  workflow_runs: { policy: "exclude", reason: "运行授权与执行绑定不能跨实例，非空源库明确拒绝" },
  workflow_steps: { policy: "exclude", reason: "步骤与其运行归属保留在来源实例" },
  workflow_executions: { policy: "exclude", reason: "真实任务执行绑定不能丢弃或跨实例恢复" },
  workflow_questions: { policy: "exclude", reason: "问题与回答绑定原运行和入口" },
  workflow_controls: { policy: "exclude", reason: "控制请求只属于原实例" },
  branch_requests: { policy: "exclude", reason: "分支准备回执只属于原实例；已发布来源随会话保留" },
  compaction_requests: { policy: "exclude", reason: "手动压缩回执只属于原实例；压缩点的来源标识随资料保留" },
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
  mcp_services: { policy: "exclude", reason: "MCP 服务与凭据只属于本实例，不随资料导入" },
  sub_agents: { policy: "import" },
  work_delegations: { policy: "import" },
  // 工作内消息（agent-direction issue 13）：随所属工作的账本条目折叠（不设新
  // 账本类别——行只属其工作，工作的续跑跳过与回退删除同时覆盖它）
  subagent_messages: { policy: "import" },
  meta: { policy: "import" }, // 仅 jev.project.<id> 键随项目导入
  history_index: { policy: "exclude", reason: "可重建的派生索引，目标启动时重建" },
  history_index_state: { policy: "exclude", reason: "可重建的派生索引状态" },
  occupancy: { policy: "exclude", reason: "运行时目录占用，不属于资料" },
  agent_roles: { policy: "exclude", reason: "角色绑定会话与 main 资料不迁入开发产品" },
  inbound_events: { policy: "exclude", reason: "个人平台入站不属于开发资料" },
  inbound_media_messages: { policy: "exclude", reason: "图片暂存与拒绝账本绑定原实例和平台入口，不跨实例恢复" },
  inbound_media: { policy: "exclude", reason: "未提升的图片文件不属于任务产物，不跨实例导入" },
  chat_result_acceptances: { policy: "exclude", reason: "群聊结果接收，属 chat 外挂边界" },
  schedules: { policy: "exclude", reason: "main 的调度计划不迁入" },
  schedule_runs: { policy: "exclude", reason: "main 的调度运行不迁入" },
  notification_ops: { policy: "exclude", reason: "IM 发送账本不迁入（不重放外发）" },
  standing_permissions: { policy: "exclude", reason: "长期操作授权绑定机器与 IM 入口，不跨实例" },
  qq_config: { policy: "exclude", reason: "平台配置不迁入" },
  qq_sessions: { policy: "exclude", reason: "QQ 群会话不迁入" },
  qq_inbox: { policy: "exclude", reason: "QQ 群收件不迁入" },
  qq_outbox: { policy: "exclude", reason: "QQ 群待发不迁入" },
  telegram_config: { policy: "exclude", reason: "平台配置不迁入" },
  github_repo_bindings: { policy: "exclude", reason: "GitHub 归档表（v4 历史），不迁入" },
  github_drafts: { policy: "exclude", reason: "GitHub 归档表（v4 历史），不迁入" },
  github_publish_ops: { policy: "exclude", reason: "GitHub 归档表（v4 历史），不迁入" },
  instance_imports: { policy: "exclude", reason: "导入账本属目标实例自身，不从源复制" },
  instance_import_items: { policy: "exclude", reason: "导入账本属目标实例自身，不从源复制" },
};

function checkTargetProduct(product: string | null, schemaVersion: number | null, exists: boolean): void {
  if (product !== null && product !== "ruukoto-code") {
    fail("product_mismatch", `目标数据目录已登记为产品 ${product}，legacy-import 只能迁入 ruukoto-code 档案`);
  }
  if (exists && schemaVersion !== SCHEMA_VERSION) {
    fail(
      "target_schema",
      `目标库 schema 版本为 ${schemaVersion}（当前程序 ${SCHEMA_VERSION}）；源与目标须使用当前存储格式，不转换旧授权`,
    );
  }
}

interface ImportSet {
  projects: Row[];
  sessions: Row[];
  subAgents: Row[];
  workDelegations: Row[];
  /** 工作内消息（issue 13）：随所属工作折叠的行集。 */
  subagentMessages: Row[];
  agentWaits: Row[];
  agentReports: Row[];
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
  metas: Row[]; // jev.project.<id>
  files: FilePlanItem[];
  memoryPending: Array<{ id: string; scope: string; reason: string }>;
  grantsCrossInstance: Row[];
  excludedProjects: Array<{ id: string; name: string; reason: string }>;
  excludedSessions: Array<{ id: string; project_id: string; reason: string }>;
  closings: TaskClosing[];
  staleConfirmations: string[];
  downgrades: string[];
  /** 其工具操作结果未登记、置 effect_unknown 的 task id。 */
  effectUnknownTasks: string[];
  /** 置 effect_unknown 的单个工具操作 id（未被未消费审批挡住、结果未登记）。 */
  effectUnknownOps: string[];
  missingFiles: Array<{ item: string; path: string }>;
  /** 未在本机核实出目录身份的会话 id（仅可查阅，继续由既有身份检查拒绝执行）。 */
  readonlySessions: string[];
}

/**
 * 构建完整导入集合与逐表决策（预览与应用共用；只依赖快照与计划选择，
 * 不含目标冲突状态——那部分由 analyze 合并）。
 */
function buildImportSet(
  snap: SourceSnapshot,
  plan: { renames: Record<string, string>; personalMemories: string[] },
  deps: LegacyImportDeps,
): ImportSet {
  const db = snap.db;
  const projects = allRows(db, "SELECT * FROM projects");
  const sessions = allRows(db, "SELECT * FROM sessions");
  const roleSessionIds = new Set(allRows(db, "SELECT session_id FROM agent_roles").map((r) => String(r.session_id)));
  const qqSessionIds = new Set(allRows(db, "SELECT session_id FROM qq_sessions").map((r) => String(r.session_id)));
  const subAgents = allRows(db, "SELECT * FROM sub_agents");
  const subAgentBySession = new Map(subAgents.map((r) => [String(r.session_id), r]));

  // 普通 dev 会话（排除角色绑定与 QQ 群）；SubAgent 子会话要求父会话一并纳入
  const plain = sessions.filter((s) => s.kind === "dev" && !roleSessionIds.has(String(s.id)) && !qqSessionIds.has(String(s.id)));
  const plainUserIds = new Set(plain.filter((s) => !subAgentBySession.has(String(s.id))).map((s) => String(s.id)));
  const includedSessions = plain.filter((s) => {
    const sub = subAgentBySession.get(String(s.id));
    return !sub || plainUserIds.has(String(sub.parent_session_id));
  });
  const sessionIds = new Set(includedSessions.map((s) => String(s.id)));

  const excludedSessions: ImportSet["excludedSessions"] = [];
  for (const s of sessions) {
    if (sessionIds.has(String(s.id))) continue;
    let reason: string;
    if (roleSessionIds.has(String(s.id))) reason = "角色绑定会话（main/coding/chat），不迁入开发产品";
    else if (s.kind === "qq_group" || qqSessionIds.has(String(s.id))) reason = "QQ 群会话，不迁入开发产品";
    else if (subAgentBySession.has(String(s.id))) reason = "SubAgent 子会话的父会话未导入（main 资料边界）";
    else reason = "非 dev 类别会话";
    excludedSessions.push({ id: String(s.id), project_id: String(s.project_id), reason });
  }

  const includedProjects = projects.filter((p) => includedSessions.some((s) => String(s.project_id) === String(p.id)));
  const projectIds = new Set(includedProjects.map((p) => String(p.id)));
  const excludedProjects: ImportSet["excludedProjects"] = [];
  for (const p of projects) {
    if (!projectIds.has(String(p.id))) {
      excludedProjects.push({ id: String(p.id), name: String(p.name), reason: "没有可导入的普通 dev 会话（main/角色/群资料）" });
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

  const closings: TaskClosing[] = [];
  const staleConfirmations: string[] = [];
  const downgrades: string[] = [];
  const effectUnknownTasks: string[] = [];
  // 未终态任务收尾（不重放）：queued → canceled；running / awaiting_confirmation →
  // interrupted（原因 migration）。effect_unknown 口径与运行时恢复一致：结果未登记
  // 且可能已开始执行（没有被未消费审批挡住 = 已知未执行）的工具操作与任务置 1。
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
        if (op.result_summary !== null || unconsumedApprovalOpIds.has(String(op.id)) || ["wait", "agent_wait"].includes(String(op.tool_name))) continue;
        effectUnknownOpIds.add(String(op.id));
        hasUnknown = true;
      }
      if (hasUnknown) effectUnknownTasks.push(String(t.id));
    }
  }
  const effectUnknownOps = [...effectUnknownOpIds];
  for (const c of confirmations) {
    const status = String(c.status);
    if (status === "pending" || (status === "approved" && c.consumed_at === null)) {
      staleConfirmations.push(String(c.id));
    }
  }
  for (const s of includedSessions) {
    if (s.default_access_mode === "full_access") downgrades.push(String(s.id));
  }

  const artifactSession = new Map(artifacts.map((a) => [String(a.id), String(a.session_id)]));

  // 记忆：项目记忆要求全部版本来源落在导入范围内或为 owner_note；personal 记忆
  // 只导入计划中显式选中（拥有者确认的发布），同样受来源规则约束
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
  const memoryPending: ImportSet["memoryPending"] = [];
  const selectedPersonal = new Set(plan.personalMemories);
  for (const m of allMemories) {
    const pid = m.project_id === null ? null : String(m.project_id);
    const versions = versionsByMemory.get(String(m.id)) ?? [];
    const scope = String(m.scope);
    if (pid !== null && projectIds.has(pid)) {
      const check = memoryRefsInScope(versions, sessionIds, artifactSession);
      if (check.ok) {
        memoriesImport.push(m);
        memoryVersions.push(...versions);
      } else {
        memoryPending.push({ id: String(m.id), scope, reason: check.reason! });
      }
    } else if (scope === "personal") {
      if (!selectedPersonal.has(String(m.id))) {
        memoryPending.push({ id: String(m.id), scope, reason: "未在计划中显式选中发布（不自动注入跨实例个人记忆）" });
        continue;
      }
      const check = memoryRefsInScope(versions, sessionIds, artifactSession);
      if (check.ok) {
        memoriesImport.push(m);
        memoryVersions.push(...versions);
      } else {
        memoryPending.push({ id: String(m.id), scope, reason: check.reason! });
      }
    } else {
      memoryPending.push({ id: String(m.id), scope, reason: "所属项目未导入（来源留在旧实例）" });
    }
  }

  // 资料授权：两端项目都导入时原样导入（含撤销状态）；一端留在源实例时只在
  // 回执记录（跨实例，不生效），不进 data_grants
  const allGrants = allRows(db, "SELECT * FROM data_grants");
  const grantsImport = allGrants.filter((g) => projectIds.has(String(g.from_project_id)) && projectIds.has(String(g.to_project_id)));
  const grantsCrossInstance = allGrants.filter(
    (g) => !(projectIds.has(String(g.from_project_id)) && projectIds.has(String(g.to_project_id))),
  );

  const metas = allRows(db, "SELECT * FROM meta WHERE key LIKE 'jev.project.%'").filter((m) =>
    projectIds.has(String(m.key).slice("jev.project.".length)),
  );

  // 文件复制计划：JSONL 改写为目标 sessions/ 下同名文件；产物正文按 id 复制。
  // 源文件缺失或损坏如实列出，照样导入记录，不生成空历史
  const files: FilePlanItem[] = [];
  const missingFiles: ImportSet["missingFiles"] = [];
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

  const readonlySessions: string[] = [];
  for (const s of includedSessions) {
    if (!strictDirOk(String(s.cwd_real), Number(s.cwd_dev), Number(s.cwd_ino))) readonlySessions.push(String(s.id));
  }

  const includedWorks = allRows(db, "SELECT * FROM work_delegations").filter((r) => sessionIds.has(String(r.parent_session_id)));
  verifyImportedBranchSources(includedSessions, tasks, artifacts, includedWorks);
  verifyImportedWorkCopySnapshots(includedWorks);
  const includedAgents = subAgents.filter(row => sessionIds.has(String(row.session_id)));
  verifyImportedSubAgentDefinitions(includedAgents);
  verifyImportedSubAgentExecutions(tasks, includedSessions, includedAgents, memoriesImport);
  verifyImportedWorkCopyHosts(tasks, includedSessions);
  const agentWaits = rowsIn(db, "agent_waits", "session_id", sessionIdList), agentReports = rowsIn(db, "agent_reports", "parent_session_id", sessionIdList);
  verifyImportedAgentWaitReferences(agentWaits, agentReports, { projects: includedProjects, sessions: includedSessions, tasks, works: includedWorks, subAgents: includedAgents,
    artifacts, selections: selectionRecords, inboundEvents: [], scheduleRuns: [], notificationOps: [], toolOps, chatResults: [], memories: memoriesImport, appDataInstanceId: null });
  return {
    projects: includedProjects,
    sessions: includedSessions,
    subAgents: includedAgents,
    agentWaits,
    agentReports,
    workDelegations: includedWorks,
    // 工作内消息（issue 13）：随纳入的工作折叠收集
    subagentMessages: allRows(db, "SELECT * FROM subagent_messages").filter((r) => includedWorks.some((w) => String(w.id) === String(r.work_id))),
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
    metas,
    files,
    memoryPending,
    grantsCrossInstance,
    excludedProjects,
    excludedSessions,
    closings,
    staleConfirmations,
    downgrades,
    effectUnknownTasks,
    effectUnknownOps,
    missingFiles,
    readonlySessions,
  };
}

interface ProjectDecision {
  id: string;
  name: string;
  targetName: string;
  /** keep = 保留根四列；clear = 清空成为旧来源项目；none = 源项目本无根。 */
  rootDecision: "keep" | "clear" | "none";
  rootReason: string | null;
  /** 根被目标已有工作区占用时的占用方项目 id。 */
  targetOccupant: string | null;
  /** 已在本源此前导入中（本次跳过）。 */
  alreadyImported: boolean;
}

interface SessionDecision {
  id: string;
  workspaceFrom: string | null;
  workspaceTo: string | null;
  workspaceReason: string | null;
  sessionFileTo: string | null;
  defaultAccessModeTo: string;
  alreadyImported: boolean;
}

interface ImportAnalysis {
  set: ImportSet;
  plan: { from: string; renames: Record<string, string>; personalMemories: string[] };
  projectDecisions: ProjectDecision[];
  sessionDecisions: SessionDecision[];
  /** 本次实际新导入的各类 id（已导入项剔除后）。 */
  ids: {
    projects: string[];
    sessions: string[];
    subAgents: string[];
    workDelegations: string[];
    memories: string[];
    grants: string[];
    metas: string[];
    files: string[];
  };
  /** 同 ID 但不属于本源此前导入的冲突（硬拒绝，逐项列出）。 */
  idConflicts: Array<{ kind: LedgerKind | "agent_wait" | "agent_report"; id: string }>;
  agentWaitInsert: { waits: Row[]; reports: Row[] };
  fileConflicts: Array<{ itemId: string; dest: string; reason: string }>;
  jevDisabled: Array<{ key: string; credential: string }>;
  /** 已在目标且属于本源此前导入、本次跳过的条目说明。 */
  skippedAlreadyImported: string[];
  /** 凭据绑定缺失、以停用状态导入的 jev 键（apply 的 transformMeta 用）。 */
  jevMissingKeys: Set<string>;
  /** 本次新导入的事件行（跳过已导入会话的事件）。 */
  newEvents: Row[];
  planErrors: string[];
  revision: string;
}

function analyze(
  snap: SourceSnapshot,
  target: TargetView,
  plan: { from: string; renames: Record<string, string>; personalMemories: string[] },
  deps: LegacyImportDeps,
): ImportAnalysis {
  const tdb = target.db;
  checkTablePolicy(snap.db, tdb, TABLE_POLICY);
  if (["code_schedules", "code_schedule_runs", "code_schedule_tasks", "code_schedule_receipts"].some(table => allRows(snap.db, `SELECT 1 FROM ${table} LIMIT 1`).length) || ["owner_questions", "background_processes", "agent_waits", "agent_reports", "workflow_runs"].some(table => allRows(snap.db, `SELECT 1 FROM ${table} WHERE json_extract(payload, '$.source.kind') = 'coding-schedule' OR json_extract(payload, '$.source.codeScheduledRunId') IS NOT NULL LIMIT 1`).length)) fail("code_schedules_import_unavailable", "源档案含 Coding 定时计划或来源记录，暂不支持跨实例导入；请保留原档案查阅。");
  if (["owner_questions", "owner_question_receipts"].some(table => allRows(snap.db, `SELECT 1 FROM ${table} LIMIT 1`).length)) fail("owner_questions_import_unavailable", "源档案含拥有者问题或回执，暂不支持跨实例导入；请保留原档案查阅。");
  if (["background_processes", "background_process_closures"].some(table => allRows(snap.db, `SELECT 1 FROM ${table} LIMIT 1`).length)) fail("background_processes_import_unavailable", "源档案含后台执行或关闭屏障，暂不支持跨实例导入；请保留原档案查阅。");
  rejectWorkflowImport(snap.db);
  const set = buildImportSet(snap, plan, deps);
  const planErrors: string[] = [];

  // 计划选择校验：personal 记忆 id 必须存在且确为 personal；改名键必须是被导入的源项目
  const allMemories = allRows(snap.db, "SELECT id, scope FROM memories");
  const scopeById = new Map(allMemories.map((m) => [String(m.id), String(m.scope)]));
  for (const id of plan.personalMemories) {
    const scope = scopeById.get(id);
    if (scope === undefined) planErrors.push(`计划选中的 personal 记忆不存在：${id}`);
    else if (scope !== "personal") planErrors.push(`计划选中的记忆不是 personal 范围：${id}`);
  }
  const sourceProjectIds = new Set(allRows(snap.db, "SELECT id FROM projects").map((p) => String(p.id)));
  for (const id of Object.keys(plan.renames)) {
    if (!sourceProjectIds.has(id)) planErrors.push(`renames 指向不存在的源项目：${id}`);
    else if (!set.projects.some((p) => String(p.id) === id)) planErrors.push(`renames 指向不在导入范围的项目（角色/群/main 资料）：${id}`);
  }

  const ledger = readLedger(tdb);
  const sourceImportIds = new Set(ledger.imports.filter((i) => i.source_instance_id === snap.instanceId).map((i) => i.id));
  const fromSameSource = (kind: LedgerKind, id: string): boolean => {
    const owner = ledger.items.get(kind)?.get(id);
    return owner !== undefined && sourceImportIds.has(owner);
  };

  const idConflicts: ImportAnalysis["idConflicts"] = [];
  const skipped = new Set<string>(); // kind:id，本次跳过（已在本源此前导入）
  const checkItem = (kind: LedgerKind, id: string, existsInTarget: boolean): boolean => {
    if (!existsInTarget) return true; // 新条目，正常导入
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
    new Set(tdb ? rowsIn(tdb, table, "id", ids).map((r) => String(r.id)) : []);

  // 项目：根目录严格核实 + 重名改名
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
    const targetName = renamed ?? String(p.name);
    projectDecisions.push({ id, name: String(p.name), targetName, rootDecision, rootReason, targetOccupant, alreadyImported });
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

  // 会话：组织映射决策（资料身份恒为原 project_id，映射只作展示）
  const sessionDecisions: SessionDecision[] = [];
  const projectDecisionById = new Map(projectDecisions.map((d) => [d.id, d]));
  const existingSessions = targetExisting("sessions", set.sessions.map((s) => String(s.id)));
  for (const s of set.sessions) {
    const id = String(s.id);
    const alreadyImported = !checkItem("session", id, existingSessions.has(id));
    const from = s.workspace_project_id === null ? null : String(s.workspace_project_id);
    let to: string | null = null;
    let reason: string | null = null;
    if (from !== null) {
      const wd = projectDecisionById.get(from);
      if (!wd) {
        reason = "源组织映射目标未随导入（资料身份不变）；导入后可用 project migration-preview 重新组织";
      } else if (wd.rootDecision === "keep") {
        to = wd.id;
      } else if (wd.targetOccupant !== null) {
        to = wd.targetOccupant;
        reason = `源工作区根与目标工作区 ${to} 同根，组织归属指向目标工作区（07 的组织映射）`;
      } else {
        reason = "源工作区根在本机无法核实；导入后可用 project migration-preview 重新组织";
      }
    }
    const file = set.files.find((f) => f.kind === "session" && f.ownerId === id);
    sessionDecisions.push({
      id,
      workspaceFrom: from,
      workspaceTo: to,
      workspaceReason: reason,
      sessionFileTo: file ? file.dest : null,
      defaultAccessModeTo: s.default_access_mode === "full_access" ? "confirm" : String(s.default_access_mode),
      alreadyImported,
    });
  }

  // 其余各类条目的 ID 冲突核对
  const simpleChecks: Array<{ kind: LedgerKind; table: string; ids: string[] }> = [
    { kind: "sub_agent", table: "sub_agents", ids: set.subAgents.map((r) => String(r.id)) },
    { kind: "work_delegation", table: "work_delegations", ids: set.workDelegations.map((r) => String(r.id)) },
    { kind: "memory", table: "memories", ids: set.memoriesImport.map((r) => String(r.id)) },
    { kind: "grant", table: "data_grants", ids: set.grantsImport.map((r) => String(r.id)) },
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

  // 文件：目标已有同 sha 文件则跳过，sha 不同则拒绝。文件归属会话：会话整体
  // 跳过时其文件也跳过（同会话产物与会话共存）
  const artifactOwnerSession = new Map(set.artifacts.map((a) => [String(a.id), String(a.session_id)]));
  const fileConflicts: ImportAnalysis["fileConflicts"] = [];
  for (const f of set.files) {
    const ownerSession = f.kind === "session" ? f.ownerId : (artifactOwnerSession.get(f.ownerId) ?? "");
    if (skipped.has(`session:${ownerSession}`)) continue;
    if (!fs.existsSync(f.dest)) {
      f.action = "copied";
      continue;
    }
    const destSha = sha256File(f.dest);
    if (destSha === f.sha256) {
      f.action = "skipped_same_sha";
    } else {
      fileConflicts.push({ itemId: f.itemId, dest: f.dest, reason: "目标已存在同名文件且内容不同" });
    }
  }

  // Jev：目标 agentDir 缺少对应凭据绑定时以停用状态导入（只读绑定名，不读值）
  const targetCredentialNames = new Set<string>();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(deps.targetAgentDir, "credentials.json"), "utf8")) as {
      bindings?: Array<{ name: string }>;
    };
    for (const b of raw.bindings ?? []) targetCredentialNames.add(String(b.name));
  } catch {
    // 无凭据文件或无绑定：全部按缺失处理
  }
  const jevDisabled: ImportAnalysis["jevDisabled"] = [];
  const jevMissingKeys = new Set<string>();
  for (const m of set.metas) {
    if (skipped.has(`meta:${String(m.key)}`)) continue;
    let cfg: { enabled?: boolean; credential?: string | null; configVersion?: number } | null = null;
    try {
      cfg = JSON.parse(String(m.value));
    } catch {
      cfg = null;
    }
    if (cfg && cfg.enabled === true && typeof cfg.credential === "string" && !targetCredentialNames.has(cfg.credential)) {
      jevDisabled.push({ key: String(m.key), credential: cfg.credential });
      jevMissingKeys.add(String(m.key));
    }
  }

  const skippedAlreadyImported = [...skipped].sort();
  const priorAgentManifest = new Map<string, { sha: string; sourceSha: string }>();
  for (const previous of ledger.imports.filter(item => item.source_instance_id === snap.instanceId && item.status === "applied")) {
    const receipt = tdb?.prepare("SELECT report FROM instance_imports WHERE id = ?").get(previous.id) as { report: string } | undefined;
    if (!receipt) continue;
    const body = JSON.parse(receipt.report) as { agent_wait_manifest?: Array<{ table: string; id: string; sha: string; sourceSha: string }> };
    for (const row of body.agent_wait_manifest ?? []) priorAgentManifest.set(`${row.table}:${row.id}`, row);
  }
  const agentWaitInsert: ImportAnalysis["agentWaitInsert"] = { waits: [], reports: [] };
  for (const [table, rows, column, kind, destination] of [["agent_waits", set.agentWaits, "id", "agent_wait", agentWaitInsert.waits], ["agent_reports", set.agentReports, "report_key", "agent_report", agentWaitInsert.reports]] as const) {
    for (const row of rows) {
      const id = String(row[column]), existing = tdb?.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).get(id) as Row | undefined;
      if (!existing) { destination.push(row); continue; }
      const proof = priorAgentManifest.get(`${table}:${id}`);
      if (proof && proof.sha === sha256(canonicalJson(existing)) && proof.sourceSha === sha256(canonicalJson(row))) continue;
      idConflicts.push({ kind, id });
    }
  }
  const skippedSessions = new Set([...skipped].filter((k) => k.startsWith("session:")).map((k) => k.slice("session:".length)));
  const available = (table: string, rows: Row[], sessionColumn: string) => [...(tdb ? allRows(tdb, `SELECT * FROM ${table}`) : []), ...rows.filter(row => !skippedSessions.has(String(row[sessionColumn])))];
  verifyImportedAgentWaitReferences(agentWaitInsert.waits, agentWaitInsert.reports, {
    projects: set.projects, sessions: set.sessions, tasks: available("tasks", set.tasks, "session_id"), works: [...(tdb ? allRows(tdb, "SELECT * FROM work_delegations") : []), ...set.workDelegations],
    subAgents: [...(tdb ? allRows(tdb, "SELECT * FROM sub_agents") : []), ...set.subAgents], artifacts: available("artifacts", set.artifacts, "session_id"),
    selections: available("selection_records", set.selectionRecords, "session_id"), inboundEvents: [], scheduleRuns: [], notificationOps: [],
    toolOps: [...(tdb ? allRows(tdb, "SELECT * FROM tool_ops") : []), ...set.toolOps], chatResults: [],
    memories: [...(tdb ? allRows(tdb, "SELECT * FROM memories") : []), ...set.memoriesImport.filter(row => !skipped.has(`memory:${String(row.id)}`))], appDataInstanceId: null,
  });
  // 新增会话的任务集（事件按新归属判定：属于新会话或其任务）
  const newSessionTasks = new Set(set.tasks.filter((t) => !skippedSessions.has(String(t.session_id))).map((t) => String(t.id)));
  const newEvents = set.events.filter((e) => {
    const sid = e.session_id === null ? null : String(e.session_id);
    const tid = e.task_id === null ? null : String(e.task_id);
    if (sid !== null) return !skippedSessions.has(sid);
    return tid !== null && newSessionTasks.has(tid);
  });

  // 修订：导入集合（每行整行规范化哈希 + 文件 sha256）+ 目标冲突状态的规范化
  // 哈希。源或目标在预览后的任何行内容变化，应用即报 revision_conflict
  const rowDigests = (rows: Row[], idCol = "id"): Array<{ id: string; sha: string }> =>
    rows.map((r) => ({ id: String(r[idCol]), sha: sha256(canonicalJson(r)) })).sort((a, b) => a.id.localeCompare(b.id));
  const revision = `r1.${sha256(
    canonicalJson({
      v: 1,
      source: { instanceId: snap.instanceId, product: snap.product, schema: snap.originalSchemaVersion },
      plan: { renames: plan.renames, personal: [...plan.personalMemories].sort() },
      projects: projectDecisions
        .map((d) => ({ id: d.id, name: d.targetName, root: d.rootDecision, skip: d.alreadyImported }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      projectRows: rowDigests(set.projects),
      sessions: sessionDecisions
        .map((d) => ({ id: d.id, to: d.workspaceTo, file: d.sessionFileTo !== null, mode: d.defaultAccessModeTo, skip: d.alreadyImported }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      sessionRows: rowDigests(set.sessions),
      tasks: rowDigests(set.tasks),
      agentWaits: rowDigests(set.agentWaits),
      agentReports: rowDigests(set.agentReports, "report_key"),
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
      metas: rowDigests(set.metas, "key"),
      events: { count: set.events.length, sha: sha256(set.events.map((e) => `${String(e.seq)}:${sha256(canonicalJson(e))}`).join(",")) },
      files: set.files
        .map((f) => ({ item: f.itemId, sha: f.sha256 }))
        .sort((a, b) => a.item.localeCompare(b.item)),
      target: {
        names: [...targetNames].sort(),
        roots: [...targetRootOwners.keys()].sort(),
        sameSourceItems: skippedAlreadyImported,
      },
    }),
  )}`;

  return {
    set,
    plan,
    projectDecisions,
    sessionDecisions,
    ids: {
      projects: newProjects.map((d) => d.id),
      sessions: sessionDecisions.filter((d) => !d.alreadyImported).map((d) => d.id),
      subAgents: set.subAgents.filter((r) => !skipped.has(`sub_agent:${String(r.id)}`)).map((r) => String(r.id)),
      workDelegations: set.workDelegations.filter((r) => !skipped.has(`work_delegation:${String(r.id)}`)).map((r) => String(r.id)),
      memories: set.memoriesImport.filter((r) => !skipped.has(`memory:${String(r.id)}`)).map((r) => String(r.id)),
      grants: set.grantsImport.filter((r) => !skipped.has(`grant:${String(r.id)}`)).map((r) => String(r.id)),
      metas: set.metas.filter((r) => !skipped.has(`meta:${String(r.key)}`)).map((r) => String(r.key)),
      files: set.files.filter((f) => f.action === "copied").map((f) => f.itemId),
    },
    idConflicts,
    agentWaitInsert,
    fileConflicts,
    jevDisabled,
    skippedAlreadyImported,
    planErrors,
    revision,
    jevMissingKeys,
    newEvents,
  };
}

// ---------- 预览 ----------

export interface LegacyImportPreview {
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
  projects: Array<{
    id: string;
    name: string;
    target_name: string;
    decision: "import" | "already_imported";
    root: { decision: string; reason: string | null; target_occupant: string | null };
  }>;
  excluded_projects: Array<{ id: string; name: string; reason: string }>;
  sessions: Array<{
    id: string;
    project_id: string;
    cwd: string;
    exec_usable: boolean;
    history: string;
    history_reason: string | null;
    session_file: "copy" | "missing" | "none";
    unfinished: Array<{ task_id: string; from: string; to: string }>;
    pending_approvals: number;
    full_access_downgrade: boolean;
    workspace: { from: string | null; to: string | null; reason: string | null };
  }>;
  excluded_sessions: Array<{ id: string; project_id: string; reason: string }>;
  memories: { import: string[]; pending: Array<{ id: string; scope: string; reason: string }> };
  grants: { import: string[]; cross_instance: Array<{ id: string; from: string; to: string; category: string; note: string }> };
  jev: Array<{ key: string; disabled: boolean; credential: string | null }>;
  events: number;
  files: { copy: number; bytes: number; missing: Array<{ item: string; path: string }>; skipped_same_sha: number };
  sub_agents: number;
  work_delegations: number;
  closings: { canceled: number; interrupted: number; stale_confirmations: number; full_access_downgrades: number; effect_unknown_tasks: number };
  agent_dir_names: string[];
  source_new_since_last_import: { count: number; note: string };
  conflicts: {
    ids: Array<{ kind: string; id: string }>;
    files: Array<{ itemId: string; dest: string; reason: string }>;
  };
  plan: { from: string; renames: Record<string, string>; personal_memories: string[] };
  plan_errors: string[];
  revision: string | null;
}

function normalizePlan(from: string, plan?: LegacyImportPlan): {
  from: string;
  renames: Record<string, string>;
  personalMemories: string[];
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
  const personal: string[] = [];
  for (const id of plan?.personal_memories ?? []) {
    if (typeof id !== "string" || id === "") {
      planErrors.push(`personal_memories 含无效条目：${String(id)}`);
      continue;
    }
    personal.push(id);
  }
  return { from: path.resolve(from), renames, personalMemories: [...new Set(personal)], planErrors };
}

export function previewLegacyImport(deps: LegacyImportDeps, input: { from: string; plan?: LegacyImportPlan }): LegacyImportPreview {
  const normalized = normalizePlan(input.from, input.plan);
  const snap = openSourceSnapshot(normalized.from);
  let target: TargetView | null = null;
  try {
    target = openTargetReadonlyCopy(deps);
    checkTargetProduct(target.product, target.schemaVersion, target.exists);
    const analysis = analyze(snap, target, normalized, deps);
    const sessionDecisionById = new Map(analysis.sessionDecisions.map((d) => [d.id, d]));
    const sourceAgentDir = path.join(path.dirname(snap.dataDir), "agent");
    let agentDirNames: string[] = [];
    try {
      agentDirNames = fs.readdirSync(sourceAgentDir).sort();
    } catch {
      agentDirNames = [];
    }
    const ledger = readLedger(target.db);
    const previousImports = ledger.imports.filter((i) => i.source_instance_id === snap.instanceId).length;
    const newItemCount =
      analysis.ids.projects.length +
      analysis.ids.sessions.length +
      analysis.ids.memories.length +
      analysis.ids.grants.length +
      analysis.ids.metas.length + analysis.agentWaitInsert.waits.length + analysis.agentWaitInsert.reports.length;

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

    const preview: LegacyImportPreview = {
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
      projects: analysis.projectDecisions.map((d) => ({
        id: d.id,
        name: d.name,
        target_name: d.targetName,
        decision: d.alreadyImported ? "already_imported" : "import",
        root: { decision: d.rootDecision, reason: d.rootReason, target_occupant: d.targetOccupant },
      })),
      excluded_projects: analysis.set.excludedProjects,
      sessions: analysis.set.sessions.map((s) => {
        const id = String(s.id);
        const d = sessionDecisionById.get(id)!;
        const hist = historyStatusOf({ sessionFile: s.session_file === null ? null : String(s.session_file) } as Session);
        return {
          id,
          project_id: String(s.project_id),
          cwd: String(s.cwd),
          exec_usable: !analysis.set.readonlySessions.includes(id),
          history: hist.history,
          history_reason: hist.reason,
          session_file: s.session_file === null ? "none" : analysis.set.files.some((f) => f.kind === "session" && f.ownerId === id) ? "copy" : "missing",
          unfinished: (closingsBySession.get(id) ?? []).map((c) => ({ task_id: c.task_id, from: c.from, to: c.to })),
          pending_approvals: pendingBySession.get(id) ?? 0,
          full_access_downgrade: s.default_access_mode === "full_access",
          workspace: { from: d.workspaceFrom, to: d.workspaceTo, reason: d.workspaceReason },
        };
      }),
      excluded_sessions: analysis.set.excludedSessions,
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
      jev: analysis.set.metas.map((m) => {
        const dis = analysis.jevDisabled.find((x) => x.key === String(m.key));
        return { key: String(m.key), disabled: dis !== undefined, credential: dis?.credential ?? null };
      }),
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
        full_access_downgrades: analysis.set.downgrades.length,
        effect_unknown_tasks: analysis.set.effectUnknownTasks.length,
      },
      agent_dir_names: agentDirNames,
      source_new_since_last_import: {
        count: previousImports > 0 ? newItemCount : 0,
        note: previousImports > 0 ? "自本源上次导入后源侧新增的条目数；导入不做增量同步，仅在报告列出" : "本源此前无导入",
      },
      conflicts: { ids: analysis.idConflicts.map((c) => ({ kind: c.kind, id: c.id })), files: analysis.fileConflicts },
      plan: { from: normalized.from, renames: normalized.renames, personal_memories: normalized.personalMemories },
      plan_errors: [...normalized.planErrors, ...analysis.planErrors],
      revision: analysis.revision,
    };
    return preview;
  } finally {
    target?.cleanup();
    snap.cleanup();
  }
}

function planDigestOf(input: {
  from: string;
  renames: Record<string, string>;
  personalMemories: string[];
  sourceInstanceId: string;
  revision: string;
}): string {
  return sha256(
    canonicalJson({
      from: input.from,
      renames: input.renames,
      personal_memories: input.personalMemories,
      source_instance_id: input.sourceInstanceId,
      revision: input.revision,
    }),
  );
}

export function applyLegacyImport(
  deps: LegacyImportDeps,
  input: {
    plan: { from: string; renames?: Record<string, string>; personal_memories?: string[] };
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

  // 目标库：不存在则新建（当前 schema），存在则先核版本再打开
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
      fail("target_schema", `目标库 schema 版本为 ${version}（当前程序 ${SCHEMA_VERSION}）；源与目标须使用当前存储格式，不转换旧授权`);
    }
  }
  const tdb = new Db(deps.targetDataDir);
  const snap = openSourceSnapshot(normalized.from);
  try {
    const targetProduct = readMetaValue(tdb, PRODUCT_META_KEY);
    checkTargetProduct(targetProduct, SCHEMA_VERSION, true);
    if (snap.instanceId !== input.source_instance_id) {
      fail("invalid_params", `计划文件绑定的源实例 ${input.source_instance_id} 与当前来源 ${snap.instanceId} 不符；源侧已有变化时重新 preview`);
    }
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
    if (analysis.fileConflicts.length > 0) {
      fail(
        "file_conflict",
        `目标已存在同名文件且内容不同：${analysis.fileConflicts.map((c) => `${c.itemId}（${c.dest}）`).join("，")}`,
      );
    }

    const importId = randomId("imp");
    const nowIso = new Date().toISOString();
    const backupDir = path.join(deps.targetDataDir, "migration", importId);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(backupDir, "target-before.db");
    // “核对备份”：导入前对目标库的完整备份；整库恢复的手工路径（见 docs/usage.md）
    tdb.exec(`VACUUM INTO '${escapeSqlPath(backupPath)}'`);
    const backupSha = sha256File(backupPath);

    // 复制文件：先写临时名再 rename；目标已有同 sha 的文件则跳过（analyze 已定），
    // 复制前再核源 sha——快照之后源文件被改即中止（重跑同一计划可继续）
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
    deps.__testHooks?.afterFilesCopied?.();

    const set = analysis.set;
    const sessionDecisionById = new Map(analysis.sessionDecisions.map((d) => [d.id, d]));
    const projectDecisionById = new Map(analysis.projectDecisions.map((d) => [d.id, d]));
    const newSessionIds = new Set(analysis.ids.sessions);
    const newTasks = set.tasks.filter((t) => newSessionIds.has(String(t.session_id)));
    const newTaskIds = new Set(newTasks.map((t) => String(t.id)));
    const closingById = new Map(set.closings.map((c) => [c.task_id, c]));
    const effectUnknownTaskIds = new Set(set.effectUnknownTasks);
    const staleIds = new Set(set.staleConfirmations);

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
        return {
          ...s,
          session_file: d.sessionFileTo,
          workspace_project_id: d.workspaceTo,
          default_access_mode: d.defaultAccessModeTo,
          create_request_id: null,
        };
      });
    const subAgentsToInsert = set.subAgents
      .filter((r) => analysis.ids.subAgents.includes(String(r.id)))
      .map((r) => ({
        ...r,
        // 旧实例没有存活执行单元：按 issue 12 的独立列以关闭状态登记；原工作目录不迁移
        closed_at: r.closed_at === null ? nowIso : r.closed_at,
        closed_by: r.closed_by === null ? "owner" : r.closed_by,
        state: "idle",
      }));
    const worksToInsert = set.workDelegations.filter((r) => analysis.ids.workDelegations.includes(String(r.id)));
    // 工作内消息（issue 13）：随同一批工作折叠（工作的续跑跳过同批豁免）
    const messagesToInsert = set.subagentMessages.filter((r) => worksToInsert.some((w) => String(w.id) === String(r.work_id)));
    const agentWaitArchive = archiveImportedAgentWaits(analysis.agentWaitInsert.waits, analysis.agentWaitInsert.reports, nowIso);
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
      .map((op) => (set.effectUnknownOps.includes(String(op.id)) ? { ...op, effect_unknown: 1 } : op));
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

    const maxBefore = tdb.prepare("SELECT COALESCE(MAX(seq), 0) m FROM events").get() as { m: number };
    const ledgerItems: Array<{ kind: LedgerKind; item_id: string }> = [
      ...analysis.ids.projects.map((id) => ({ kind: "project" as const, item_id: id })),
      ...analysis.ids.sessions.map((id) => ({ kind: "session" as const, item_id: id })),
      ...analysis.ids.subAgents.map((id) => ({ kind: "sub_agent" as const, item_id: id })),
      ...analysis.ids.workDelegations.map((id) => ({ kind: "work_delegation" as const, item_id: id })),
      ...analysis.ids.memories.map((id) => ({ kind: "memory" as const, item_id: id })),
      ...analysis.ids.grants.map((id) => ({ kind: "grant" as const, item_id: id })),
      ...analysis.ids.metas.map((id) => ({ kind: "meta" as const, item_id: id })),
      // 文件归属按账本判定（含失败续跑：前一次故障已复制的文件本轮回执按 sha 相同
      // 跳过，但账本须归属本次导入，回退才能经核对后移除）；已被此前导入登记的
      // 文件不重复归属
      ...set.files
        .filter((f) => f.action === "copied" || f.action === "skipped_same_sha")
        .filter((f) => !tdb.prepare("SELECT 1 FROM instance_import_items WHERE kind = 'file' AND item_id = ?").get(f.itemId))
        .map((f) => ({ kind: "file" as const, item_id: f.itemId })),
    ];

    const counts: Record<string, number> = {
      projects: projectsToInsert.length,
      sessions: sessionsToInsert.length,
      sub_agents: subAgentsToInsert.length,
      work_delegations: worksToInsert.length,
      agent_waits: agentWaitArchive.waits.length,
      agent_reports: agentWaitArchive.reports.length,
      tasks: tasksToInsert.length,
      tool_ops: toolOpsToInsert.length,
      confirmations: confirmationsToInsert.length,
      artifacts: artifactsToInsert.length,
      selection_records: selectionsToInsert.length,
      context_checkpoints: checkpointsToInsert.length,
      memories: memoriesToInsert.length,
      memory_versions: versionsToInsert.length,
      data_grants: grantsToInsert.length,
      meta: metasToInsert.length,
      events: analysis.newEvents.length,
      files_copied: set.files.filter((f) => f.action === "copied").length,
      files_skipped_same_sha: set.files.filter((f) => f.action === "skipped_same_sha").length,
      tasks_canceled: set.closings.filter((c) => c.to === "canceled").length,
      tasks_interrupted: set.closings.filter((c) => c.to === "interrupted").length,
      confirmations_staled: set.staleConfirmations.length,
      full_access_downgrades: set.downgrades.length,
      effect_unknown_tasks: set.effectUnknownTasks.length,
    };
    const report: Record<string, unknown> = {
      version: 1,
      agent_wait_manifest: ([["agent_waits", agentWaitArchive.waits, analysis.agentWaitInsert.waits, "id"], ["agent_reports", agentWaitArchive.reports, analysis.agentWaitInsert.reports, "report_key"]] as const).flatMap(([table, rows, original, column]) =>
        rows.map(row => ({ table, id: String(row[column]), sha: sha256(canonicalJson(row)), sourceSha: sha256(canonicalJson(original.find(source => source[column] === row[column]))) }))),
      counts,
      source: {
        dir: snap.dataDir,
        instance_id: snap.instanceId,
        product: snap.product,
        schema_version_original: snap.originalSchemaVersion,
      },
      renames: normalized.renames,
      personal_memories_selected: normalized.personalMemories,
      root_decisions: analysis.projectDecisions.map((d) => ({
        project_id: d.id,
        decision: d.rootDecision,
        reason: d.rootReason,
        target_occupant: d.targetOccupant,
      })),
      workspace_mappings: analysis.sessionDecisions
        .filter((d) => d.workspaceFrom !== null || d.workspaceReason !== null)
        .map((d) => ({ session_id: d.id, from: d.workspaceFrom, to: d.workspaceTo, reason: d.workspaceReason })),
      closings: set.closings,
      stale_confirmations: set.staleConfirmations,
      full_access_downgrades: set.downgrades,
      effect_unknown_tasks: set.effectUnknownTasks,
      files: set.files.map((f) => ({ itemId: f.itemId, kind: f.kind, ownerId: f.ownerId, dest: f.dest, bytes: f.bytes, sha256: f.sha256, action: f.action })),
      missing_files: set.missingFiles,
      memory_pending: set.memoryPending,
      grants_cross_instance: set.grantsCrossInstance.map((g) => ({
        id: String(g.id),
        from_project_id: String(g.from_project_id),
        to_project_id: String(g.to_project_id),
        category: String(g.category),
        revoked: g.revoked_at !== null,
        note: "跨实例，不生效",
      })),
      jev_disabled: analysis.jevDisabled,
      excluded_projects: set.excludedProjects,
      excluded_sessions: set.excludedSessions,
      skipped_already_imported: analysis.skippedAlreadyImported,
      readonly_sessions: set.readonlySessions,
    };

    let seqFrom: number | null = null;
    let seqTo: number | null = null;
    tdb.tx(() => {
      // 产品归属：目标从未登记时补记为 ruukoto-code（已核 null 或 ruukoto-code）
      tdb.prepare(`INSERT INTO meta (key, value) VALUES ('${PRODUCT_META_KEY}', 'ruukoto-code') ON CONFLICT(key) DO NOTHING`).run();
      insertRows(tdb, "projects", projectsToInsert);
      deps.__testHooks?.insideImportTx?.();
      insertRows(tdb, "sessions", sessionsToInsert);
      insertRows(tdb, "sub_agents", subAgentsToInsert);
      insertRows(tdb, "work_delegations", worksToInsert);
      insertRows(tdb, "subagent_messages", messagesToInsert);
      insertRows(tdb, "tasks", tasksToInsert);
      insertRows(tdb, "agent_waits", agentWaitArchive.waits);
      insertRows(tdb, "agent_reports", agentWaitArchive.reports);
      insertRows(tdb, "tool_ops", toolOpsToInsert);
      insertRows(tdb, "confirmations", confirmationsToInsert);
      insertRows(tdb, "artifacts", artifactsToInsert);
      insertRows(tdb, "selection_records", selectionsToInsert);
      insertRows(tdb, "context_checkpoints", checkpointsToInsert);
      insertRows(tdb, "memories", memoriesToInsert);
      insertRows(tdb, "memory_versions", versionsToInsert);
      insertRows(tdb, "data_grants", grantsToInsert);
      insertRows(tdb, "meta", metasToInsert);
      insertRows(tdb, "events", analysis.newEvents, ["seq"]);
      const maxAfter = tdb.prepare("SELECT COALESCE(MAX(seq), 0) m FROM events").get() as { m: number };
      if (analysis.newEvents.length > 0) {
        if (maxAfter.m - maxBefore.m !== analysis.newEvents.length) {
          throw new LegacyImportError("internal_error", `事件导入数量不符：预期新增 ${analysis.newEvents.length}，实际 ${maxAfter.m - maxBefore.m}`);
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

export function revertLegacyImport(deps: LegacyImportDeps, importId: string): LegacyImportRevertResult {
  if (typeof importId !== "string" || importId === "") fail("invalid_params", "缺少导入 ID（legacy-import list 查看）");
  const targetDbFile = path.join(deps.targetDataDir, "ruukoto.db");
  if (!fs.existsSync(targetDbFile)) fail("not_found", `目标数据目录没有 ruukoto.db：${deps.targetDataDir}`);
  const tdb = new Db(deps.targetDataDir);
  try {
    const receipt = tdb.prepare("SELECT * FROM instance_imports WHERE id = ?").get(importId) as Row | undefined;
    if (!receipt) fail("not_found", `没有该导入回执：${importId}`);
    if (String(receipt.status) !== "applied") fail("invalid_params", `导入 ${importId} 已处于 ${String(receipt.status)} 状态`);
    const report = JSON.parse(String(receipt.report)) as {
      files?: Array<{ itemId: string; dest: string; sha256: string; action?: string }>;
      agent_wait_manifest?: Array<{ table: "agent_waits" | "agent_reports"; id: string; sha: string }>;
    };
    const items = allRows(tdb, "SELECT kind, item_id FROM instance_import_items WHERE import_id = ?", [importId]);
    const byKind = (kind: LedgerKind) => items.filter((i) => String(i.kind) === kind).map((i) => String(i.item_id));
    const projectIds = byKind("project");
    const sessionIds = byKind("session");
    const subAgentIds = byKind("sub_agent");
    const workIds = byKind("work_delegation");
    const memoryIds = byKind("memory");
    const grantIds = byKind("grant");
    const metaKeys = byKind("meta");
    const createdAt = String(receipt.created_at);
    const sessionTaskIds = new Set(rowsIn(tdb, "tasks", "session_id", sessionIds).map((t) => String(t.id)));

    // 阻挡项：导入后目标侧的自有活动是事实，不能抹掉（逐项列出）；时间比较用
    // >= 收口同一毫秒内的导入后创建，导入行保留源时刻不受影响
    const blockers: string[] = [];
    for (const row of report.agent_wait_manifest ?? []) {
      const column = row.table === "agent_waits" ? "id" : "report_key";
      const current = tdb.prepare(`SELECT * FROM ${row.table} WHERE ${column} = ?`).get(row.id) as Row | undefined;
      if (current && sha256(canonicalJson(current)) !== row.sha) blockers.push(`导入等待或报告在导入后被修改：${row.table}:${row.id}`);
    }
    for (const [table, column, sessionColumn] of [["agent_waits", "id", "session_id"], ["agent_reports", "report_key", "parent_session_id"]] as const) {
      const owned = new Set((report.agent_wait_manifest ?? []).filter(row => row.table === table).map(row => row.id));
      for (const row of rowsIn(tdb, table, sessionColumn, sessionIds)) if (!owned.has(String(row[column]))) blockers.push(`导入的父会话被其他等待或报告引用：${table}:${String(row[column])}`);
    }
    const newTasks = allRows(
      tdb,
      `SELECT id FROM tasks WHERE session_id IN (${sessionIds.map(() => "?").join(",") || "''"}) AND created_at >= ?`,
      [...sessionIds, createdAt],
    );
    for (const t of newTasks) blockers.push(`导入的会话在导入后有新任务：${String(t.id)}`);
    const newSessions = allRows(
      tdb,
      `SELECT id FROM sessions WHERE project_id IN (${projectIds.map(() => "?").join(",") || "''"}) AND created_at >= ?`,
      [...projectIds, createdAt],
    );
    for (const s of newSessions) blockers.push(`导入的项目在导入后有新会话：${String(s.id)}`);
    const newGrants = allRows(
      tdb,
      `SELECT id, created_at FROM data_grants WHERE (from_project_id IN (${projectIds.map(() => "?").join(",") || "''"})
        OR to_project_id IN (${projectIds.map(() => "?").join(",") || "''"})) AND created_at >= ?`,
      [...projectIds, ...projectIds, createdAt],
    );
    for (const g of newGrants) blockers.push(`导入的项目在导入后有新授权：${String(g.id)}`);
    const bound = allRows(
      tdb,
      `SELECT id FROM sessions WHERE workspace_project_id IN (${projectIds.map(() => "?").join(",") || "''"})
        AND id NOT IN (${sessionIds.map(() => "?").join(",") || "''"})`,
      [...projectIds, ...sessionIds],
    );
    for (const s of bound) blockers.push(`导入的项目被其他会话用作组织归属：${String(s.id)}`);
    const newVersions = allRows(
      tdb,
      `SELECT memory_id, version FROM memory_versions WHERE memory_id IN (${memoryIds.map(() => "?").join(",") || "''"}) AND created_at >= ?`,
      [...memoryIds, createdAt],
    );
    for (const v of newVersions) blockers.push(`导入的记忆在导入后有新版本：${String(v.memory_id)} v${Number(v.version)}`);
    const seqTo = receipt.event_seq_to === null ? null : Number(receipt.event_seq_to);
    const newEvents = allRows(
      tdb,
      `SELECT seq FROM events WHERE seq > ?
        AND ((session_id IS NOT NULL AND session_id IN (${sessionIds.map(() => "?").join(",") || "''"}))
         OR (task_id IS NOT NULL AND task_id IN (${[...sessionTaskIds].map(() => "?").join(",") || "''"})))`,
      [seqTo ?? -1, ...sessionIds, ...sessionTaskIds],
    );
    for (const e of newEvents) blockers.push(`导入的会话/任务在导入后有新事件：seq ${Number(e.seq)}`);
    // 复制文件经 sha256 核对才删除：按账本归属本次导入（含跳过同 sha 的续跑文件）；
    // 已被此前导入登记的文件保留；缺失记为已不在；内容不同 = 目标侧已有改动，拒绝
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
        blockers.push(`导入的文件在导入后被修改：${f.dest}`);
        continue;
      }
      filesToRemove.push({ itemId: f.itemId, dest: f.dest });
    }
    if (blockers.length > 0) {
      return { ok: false, import_id: importId, status: "applied", removed: {}, files_removed: [], files_kept: filesKept, blockers };
    }
    // 事件区间必须整段都属于本次导入（单事务追加到尾部，本来如此；核实再删）
    const seqFrom = receipt.event_seq_from === null ? null : Number(receipt.event_seq_from);
    if (seqFrom !== null && seqTo !== null) {
      const alien = tdb
        .prepare(
          `SELECT seq FROM events WHERE seq BETWEEN ? AND ?
            AND NOT ((session_id IS NOT NULL AND session_id IN (${sessionIds.map(() => "?").join(",") || "''"}))
              OR (task_id IS NOT NULL AND task_id IN (${[...sessionTaskIds].map(() => "?").join(",") || "''"}))) LIMIT 1`,
        )
        .get(seqFrom, seqTo, ...sessionIds, ...sessionTaskIds);
      if (alien) fail("internal_error", `事件区间含不属于本次导入的事件：seq ${Number((alien as Row).seq)}`);
    }

    const removed: Record<string, number> = {};
    tdb.tx(() => {
      const del = (sql: string, params: unknown[], key: string): void => {
        const r = tdb.prepare(sql).run(...(params as never[]));
        removed[key] = Number(r.changes);
      };
      if (seqFrom !== null && seqTo !== null) del("DELETE FROM events WHERE seq BETWEEN ? AND ?", [seqFrom, seqTo], "events");
      for (const t of ["history_index", "history_index_state", "context_checkpoints", "selection_records", "confirmations", "artifacts"]) {
        del(`DELETE FROM ${t} WHERE session_id IN (${sessionIds.map(() => "?").join(",") || "''"})`, sessionIds, t);
      }
      del(`DELETE FROM tool_ops WHERE task_id IN (${[...sessionTaskIds].map(() => "?").join(",") || "''"})`, [...sessionTaskIds], "tool_ops");
      for (const table of ["agent_waits", "agent_reports"] as const) {
        const column = table === "agent_waits" ? "id" : "report_key";
        const ids = (report.agent_wait_manifest ?? []).filter(row => row.table === table).map(row => row.id);
        del(`DELETE FROM ${table} WHERE ${column} IN (${ids.map(() => "?").join(",") || "''"})`, ids, table);
      }
      del(`DELETE FROM tasks WHERE session_id IN (${sessionIds.map(() => "?").join(",") || "''"})`, sessionIds, "tasks");
      // 工作内消息（issue 13）随工作折叠回退：先于所属工作删除
      del(`DELETE FROM subagent_messages WHERE work_id IN (${workIds.map(() => "?").join(",") || "''"})`, workIds, "subagent_messages");
      del(`DELETE FROM work_delegations WHERE id IN (${workIds.map(() => "?").join(",") || "''"})`, workIds, "work_delegations");
      del(`DELETE FROM sub_agents WHERE id IN (${subAgentIds.map(() => "?").join(",") || "''"})`, subAgentIds, "sub_agents");
      del(`DELETE FROM memory_versions WHERE memory_id IN (${memoryIds.map(() => "?").join(",") || "''"})`, memoryIds, "memory_versions");
      del(`DELETE FROM memories WHERE id IN (${memoryIds.map(() => "?").join(",") || "''"})`, memoryIds, "memories");
      del(`DELETE FROM data_grants WHERE id IN (${grantIds.map(() => "?").join(",") || "''"})`, grantIds, "data_grants");
      del(`DELETE FROM meta WHERE key IN (${metaKeys.map(() => "?").join(",") || "''"})`, metaKeys, "meta");
      del(`DELETE FROM sessions WHERE id IN (${sessionIds.map(() => "?").join(",") || "''"})`, sessionIds, "sessions");
      del(`DELETE FROM projects WHERE id IN (${projectIds.map(() => "?").join(",") || "''"})`, projectIds, "projects");
      del("DELETE FROM instance_import_items WHERE import_id = ?", [importId], "instance_import_items");
      tdb
        .prepare("UPDATE instance_imports SET status = 'reverted', reverted_at = ? WHERE id = ?")
        .run(new Date().toISOString(), importId);
    });
    // 事务提交后删除经核对的复制文件（失败不回头：行已删，残留文件不被任何记录引用）
    const filesRemoved: string[] = [];
    for (const f of filesToRemove) {
      try {
        fs.rmSync(f.dest, { force: true });
        filesRemoved.push(f.dest);
      } catch (err) {
        filesKept.push({ item: f.itemId, reason: `删除失败：${(err as Error).message}` });
      }
    }
    return { ok: true, import_id: importId, status: "reverted", removed, files_removed: filesRemoved, files_kept: filesKept };
  } finally {
    tdb.close();
  }
}
