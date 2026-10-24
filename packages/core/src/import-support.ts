/** 旧实例导入的共用快照、表校验、文件与回执；产品策略由各 app 持有。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db, SCHEMA_VERSION } from "./db.ts";
import { probeLockHolder } from "./instance-lock.ts";
import { PRODUCT_META_KEY } from "./product.ts";
import type { SessionBranchSource } from "./types.ts";
import type { AgentReport, AgentWait } from "./agent-wait.ts";
import { SubAgentDefinitionError, subAgentDefinitionFromJson, validateSubAgentRoleCatalog } from "./subagent-definition.ts";
import { requireSubAgentExecutionScope, SubAgentExecutionError, type SubAgentExecutionSnapshot } from "./subagent-execution.ts";
import { WorkCopyHostError, workCopyHostFor, type WorkCopyHostSnapshot } from "./work-copy-host.ts";
import type { SubAgentReadScope } from "./types.ts";
import { parseWorkWriteTarget } from "./types.ts";
import { WorkspaceSnapshotError } from "./workspace-snapshot.ts";

/** 工作副本原址保留；导入只核实已保存的基线，不补造私有对象或 HEAD 基线。 */
export function verifyImportedWorkCopySnapshots(works: Row[]): void {
  for (const work of works) {
    if (work.write_target === null || work.write_target === undefined) continue;
    try { parseWorkWriteTarget(String(work.write_target)); }
    catch (error) {
      if (error instanceof WorkspaceSnapshotError) fail(error.code, "工作副本基线记录缺失或损坏，请保留源档案并使用匹配版本核实，不自动重建");
      throw error;
    }
  }
}

export class LegacyImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new LegacyImportError(code, message);
}

export interface LegacyImportDeps {
  targetDataDir: string;
  targetAgentDir: string;
  /** 测试故障注入钩（生产路径不传）：文件复制后 / 导入事务内各一次。 */
  __testHooks?: { afterFilesCopied?: () => void; insideImportTx?: () => void };
}

// ---------- 表级策略：旧库的每张表都必须登记为“导入”或“排除 + 理由” ----------

/**
 * 导入 / 排除登记（allow-list）。导入前核对源快照与目标库的全部表都已登记——
 * 新表未登记时拒绝导入，避免新表默认被漏判或被复制。列集合在导入表上两库
 * 必须一致（快照已迁到当前 schema，理应恒等）。
 */
/** 表级策略条目的形状；两个导入方向各自登记一份（allow-list，未登记即拒绝）。 */
export type TablePolicy = Record<string, { policy: "import" } | { policy: "exclude"; reason: string }>;

/** 工作流的执行绑定不能随普通资料丢弃，也不能跨实例复制来源授权。 */
export function rejectWorkflowImport(db: Db): void {
  for (const table of ["workflow_runs", "workflow_steps", "workflow_executions", "workflow_questions", "workflow_controls"]) {
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) fail("workflow_import_unavailable", "源实例含工作流执行记录：请保留原档案查阅，当前导入不迁移工作流执行与授权绑定");
  }
}

/** 账本条目类别与插入表的对照（v30 全集；各方向只用其中子集）。 */
export type LedgerKind =
  | "project"
  | "session"
  | "sub_agent"
  | "work_delegation"
  | "memory"
  | "grant"
  | "meta"
  | "file"
  | "agent_role"
  | "schedule"
  | "platform_config"
  | "standing_permission"
  | "credential";

export type Row = Record<string, unknown>;

/** 内联定义随身份归档；导入不得把坏快照变成可运行的默认角色。 */
export function verifyImportedSubAgentDefinitions(agents: Row[]): void {
  for (const agent of agents) {
    try { subAgentDefinitionFromJson(agent.definition); }
    catch (error) {
      if (!(error instanceof SubAgentDefinitionError)) throw error;
      fail(error.code, "源实例的子代理定义快照缺失或损坏：导入已拒绝，请保留源档案核实");
    }
  }
}

/** 保存来源快照，但不能将缺少原来源的归档导成可运行身份。 */
export function verifyImportedSubAgentExecutions(tasks: Row[], sessions: Row[], agents: Row[], memories: Row[] = []): void {
  for (const task of tasks) {
    if (!task.read_scope) continue;
    let raw: unknown;
    try { raw = JSON.parse(String(task.read_scope)); }
    catch { fail("execution_corrupt", "源实例的子代理能力记录损坏，导入已拒绝"); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("execution_corrupt", "源实例的子代理能力记录须为对象，导入已拒绝");
    const scope = raw as { execution?: unknown; readMemories?: unknown };
    if (scope.execution === undefined) continue;
    if (scope.readMemories !== undefined && (!Array.isArray(scope.readMemories) || scope.readMemories.some(id => typeof id !== "string" || !memories.some(memory => memory.id === id)))) fail("execution_source_missing", "导入集合缺少子代理已读记忆记录，请保留原实例核实");
    let execution: SubAgentExecutionSnapshot;
    try { execution = requireSubAgentExecutionScope(scope).execution; }
    catch (error) {
      if (!(error instanceof SubAgentExecutionError)) throw error;
      fail(error.code, "源实例的子代理来源快照损坏，导入已拒绝");
    }
    const source = tasks.find(row => row.id === execution.source.taskId);
    const sourceSession = sessions.find(row => row.id === execution.source.sessionId);
    const agent = agents.find(row => row.id === task.sub_agent_id);
    if (!source || source.session_id !== execution.source.sessionId || !sourceSession || sourceSession.project_id !== execution.source.projectId ||
        !agent || agent.session_id !== task.session_id || agent.parent_session_id !== execution.source.sessionId ||
        subAgentDefinitionFromJson(agent.definition).digest !== execution.roleDigest) fail("execution_source_missing", "导入集合缺少子代理快照的完整来源，请保留原实例核实");
  }
}

/** 宿主账本随来源任务归档；副本准备失败允许尚无工作行。 */
export function verifyImportedWorkCopyHosts(tasks: Row[], sessions: Row[]): void {
  for (const task of tasks) {
    let scope: SubAgentReadScope | null = null;
    if (task.read_scope) {
      try { scope = JSON.parse(String(task.read_scope)) as SubAgentReadScope; }
      catch { fail("work_copy_host_corrupt", "源实例的宿主资料记录不是合法 JSON，导入已拒绝"); }
    }
    let host: WorkCopyHostSnapshot | null;
    try { host = workCopyHostFor({ requestId: String(task.request_id ?? ""), readScope: scope }); }
    catch (error) {
      if (!(error instanceof WorkCopyHostError)) throw error;
      fail(error.code, "源实例的工作副本宿主记录缺失或损坏，导入已拒绝");
    }
    if (!host) continue;
    const source = tasks.find(row => row.id === host.parentTaskId);
    const version = Number(task.source_permission_version);
    const sourceVersion = Number(source?.permission_version);
    if (!source || source.id === task.id || source.session_id !== task.session_id || task.parent_task_id !== host.parentTaskId ||
        !sessions.some(row => row.id === task.session_id) || task.sub_agent_id != null || task.work_id != null || task.agent_id != null ||
        (task.model_selection != null && task.model_selection !== "null") ||
        !Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(sourceVersion) || version > sourceVersion) {
      fail("work_copy_host_source_missing", "导入集合缺少工作副本宿主操作的完整来源，请保留原实例核实");
    }
  }
}

export interface AgentWaitImportScope {
  projects: Row[];
  sessions: Row[];
  tasks: Row[];
  works: Row[];
  subAgents: Row[];
  artifacts: Row[];
  selections: Row[];
  inboundEvents: Row[];
  scheduleRuns: Row[];
  notificationOps: Row[];
  toolOps: Row[];
  chatResults: Row[];
  memories: Row[];
  appDataInstanceId: string | null;
}

function parseAgentWaitImport<T>(row: Row): T {
  try { return JSON.parse(String(row.payload)) as T; }
  catch { fail("source_corrupt", "等待或报告记录不是合法 JSON，请保留源实例核实"); }
}

/** UUID 原样保留；选入等待与报告的全部身份必须仍在导入集合内。 */
export function verifyImportedAgentWaitReferences(waits: Row[], reports: Row[], scope: AgentWaitImportScope): void {
  const has = (rows: Row[], id: string | null) => typeof id === "string" && rows.some(row => row.id === id);
  const requireTask = (id: string | null) => {
    if (!has(scope.tasks, id)) fail("agent_wait_import_reference_missing", "等待或报告引用的任务未随父会话导入，请核实完整来源");
    return scope.tasks.find(row => row.id === id)!;
  };
  const verifyRefs = (refs: unknown[], projectId: string) => {
    if (!Array.isArray(refs)) fail("source_corrupt", "等待或报告的来源引用不是数组");
    for (const raw of refs) {
      const ref = raw as { kind?: string; ref?: string };
      if (!ref || typeof ref.ref !== "string" || !["text", "task_result", "artifact", "app_data", "chat_result"].includes(ref.kind ?? "")) fail("source_corrupt", "等待或报告的来源引用格式损坏");
      if (ref.kind === "task_result") requireTask(ref.ref.slice("task:".length));
      if (ref.kind === "artifact" && !has(scope.artifacts, ref.ref.slice("artifact:".length).split("@")[0])) fail("agent_wait_import_reference_missing", "等待或报告引用的产物未随父会话导入");
      if (ref.kind === "app_data") {
        const match = /^app_data:([^/]+)\/([^#]+)#(\d+)\.(.+)$/.exec(ref.ref);
        if (!match) fail("source_corrupt", "等待或报告的应用数据来源格式损坏");
        if (match[1] !== scope.appDataInstanceId) fail("agent_wait_import_reference_missing", "等待或报告引用的应用数据实例快照未随父会话导入");
      }
      if (ref.kind === "chat_result" && !scope.chatResults.some(row => row.main_project_id === projectId && row.task_id === ref.ref!.slice("chat_result:".length))) fail("agent_wait_import_reference_missing", "等待或报告引用的群结果接收记录未随父会话导入");
    }
  };
  const verifyTaskRefs = (task: Row, projectId: string) => {
    if (task.read_scope) {
      let readScope: { sourceRefs: unknown[] };
      try { readScope = JSON.parse(String(task.read_scope)) as { sourceRefs: unknown[] }; }
      catch { fail("source_corrupt", "等待目标的限定资料记录损坏"); }
      verifyRefs(readScope.sourceRefs, projectId);
    }
    for (const op of scope.toolOps.filter(row => row.task_id === task.id)) {
      let params: { source_refs?: unknown[]; memory_id?: unknown };
      try { params = JSON.parse(String(op.params)) as { source_refs?: unknown[]; memory_id?: unknown }; }
      catch { fail("source_corrupt", "等待目标的工具参数记录损坏"); }
      if (params.source_refs !== undefined) verifyRefs(params.source_refs, projectId);
      if (op.tool_name === "memory_read" && typeof params.memory_id === "string" && !has(scope.memories, params.memory_id)) fail("agent_wait_import_reference_missing", "等待或报告引用的记忆未随父会话导入，请核实记忆选择与来源范围");
    }
  };
  const verifySource = (source: AgentWait["source"], parentSessionId: string, eventId: string | null) => {
    if (!source || !has(scope.projects, source.projectId) || !has(scope.sessions, source.sessionId) || source.sessionId !== parentSessionId ||
        scope.sessions.find(row => row.id === source.sessionId)?.project_id !== source.projectId || requireTask(source.taskId).session_id !== source.sessionId ||
        (eventId !== null && !has(scope.inboundEvents, eventId)) || requireTask(source.taskId).source_event_id !== eventId ||
        (source.scheduledRunId !== null && !has(scope.scheduleRuns, source.scheduledRunId))) {
      fail("agent_wait_import_reference_missing", "等待或报告的原来源、入口或调度身份未随父会话导入");
    }
    verifyRefs(source.references, source.projectId);
  };
  const verifyTarget = (target: AgentWait["targets"][number], source: AgentWait["source"], parentSessionId: string) => {
    if (!target || target.kind !== "task") fail("agent_wait_import_reference_missing", "工作流执行绑定不随普通等待资料导入，请保留源档案查阅");
    const task = requireTask(target.taskId), work = scope.works.find(row => row.id === task.work_id);
    const agent = scope.subAgents.find(row => row.id === task.sub_agent_id);
    if (!agent || agent.session_id !== task.session_id || agent.parent_session_id !== parentSessionId || !has(scope.sessions, String(task.session_id)) || !work || work.sub_agent_id !== agent.id || work.parent_session_id !== parentSessionId || work.origin_task_id !== source.taskId) fail("agent_wait_import_reference_missing", "等待目标的工作、SubAgent 或父会话身份未完整导入");
    verifyTaskRefs(task, source.projectId);
  };
  for (const row of waits) {
    const wait = parseAgentWaitImport<AgentWait>(row);
    if (!wait || wait.id !== row.id || wait.taskId !== row.task_id || wait.sessionId !== row.session_id || requireTask(wait.taskId).session_id !== wait.sessionId ||
        !Array.isArray(wait.targets) || !wait.targets.length || !wait.snapshot || wait.snapshot.taskId !== wait.taskId) fail("source_corrupt", "等待记录的任务与父会话绑定损坏");
    if (wait.snapshot.instructions && typeof wait.snapshot.instructions.version !== "string") fail("source_corrupt", "等待参考快照的项目指令版本损坏");
    if (wait.snapshot.roles !== undefined && wait.snapshot.roles !== null) {
      try { validateSubAgentRoleCatalog(wait.snapshot.roles); }
      catch (error) {
        if (!(error instanceof SubAgentDefinitionError)) throw error;
        fail(error.code, "等待参考快照的角色目录损坏：导入已拒绝，请保留源档案核实");
      }
    }
    verifySource(wait.source, wait.sessionId, wait.sourceEventId);
    for (const target of wait.targets) verifyTarget(target, wait.source, wait.sessionId);
    if (wait.snapshot.selectionRecordId && !scope.selections.some(row => row.id === wait.snapshot.selectionRecordId && row.task_id === wait.taskId && row.session_id === wait.sessionId)) fail("agent_wait_import_reference_missing", "等待参考快照的选择记录未随原任务导入");
    if (wait.snapshot.promptArtifactId && !scope.artifacts.some(row => row.id === wait.snapshot.promptArtifactId && row.task_id === wait.taskId && row.session_id === wait.sessionId)) fail("agent_wait_import_reference_missing", "等待参考快照的请求产物未随原任务导入");
    const instructions = wait.snapshot.instructions?.version.split(";artifact:")[1];
    if (instructions && !has(scope.artifacts, instructions)) fail("agent_wait_import_reference_missing", "等待参考快照的项目指令产物未随父会话导入");
  }
  for (const row of reports) {
    const report = parseAgentWaitImport<AgentReport>(row);
    if (!report || report.key !== row.report_key || report.parentSessionId !== row.parent_session_id || !Array.isArray(report.dependencyTaskIds) || !Array.isArray(report.parkedFallbackTaskIds)) fail("source_corrupt", "报告记录的键、父会话或依赖身份损坏");
    verifySource(report.source, report.parentSessionId, report.sourceEventId);
    verifyTarget(report.target, report.source, report.parentSessionId);
    const target = requireTask(report.target.kind === "task" ? report.target.taskId : null);
    for (const id of report.dependencyTaskIds) {
      const dependency = requireTask(id);
      if (dependency.session_id !== target.session_id) fail("agent_wait_import_reference_missing", "报告依赖任务不属于原 SubAgent 会话");
      verifyTaskRefs(dependency, report.source.projectId);
    }
    for (const id of [report.claimTaskId, report.fallbackTaskId, ...report.parkedFallbackTaskIds, report.consumption?.taskId ?? null, report.proof?.taskId ?? null]) {
      if (id !== null && requireTask(id).session_id !== report.parentSessionId) fail("agent_wait_import_reference_missing", "报告的消费、认领或后备任务不在原父会话内");
    }
    if (report.proof?.outboxOpId && !scope.notificationOps.some(row => row.id === report.proof!.outboxOpId && row.task_id === report.proof!.taskId)) fail("agent_wait_import_reference_missing", "报告的已登记发送证明未随原任务导入，不能丢弃后重发");
  }
}

/** 导入只保留事实和展示身份；不恢复等待、旧报告认领或模型汇总。 */
export function archiveImportedAgentWaits(waits: Row[], reports: Row[], now: string): { waits: Row[]; reports: Row[] } {
  return {
    waits: waits.map(row => {
      const wait = parseAgentWaitImport<AgentWait>(row);
      return { ...row, payload: JSON.stringify({ ...wait, phase: "ended", reason: "instance_imported", endedAt: wait.endedAt ?? now }) };
    }),
    reports: reports.map(row => {
      const report = parseAgentWaitImport<AgentReport>(row);
      return { ...row, payload: JSON.stringify({ ...report, status: report.status === "pending" ? "undelivered" : report.status,
        reason: report.status === "pending" ? "instance_imported" : report.reason, claimTaskId: null, fallbackState: report.fallbackTaskId ? "parked" : report.fallbackState }) };
    }),
  };
}

/** 名称与来源随会话行保留；限定来源缺对象时拒绝导入，不能删字段后扩大范围。 */
export function verifyImportedBranchSources(sessions: Row[], tasks: Row[], artifacts: Row[], works: Row[]): void {
  for (const session of sessions) {
    if (!session.branch_source) continue;
    let source: SessionBranchSource;
    try { source = JSON.parse(String(session.branch_source)) as SessionBranchSource; }
    catch { fail("source_corrupt", "分支来源记录不是合法 JSON"); }
    if (!source || typeof source.sessionId !== "string" || typeof source.entryId !== "string" || !Number.isSafeInteger(source.number) || source.number < 1 || !Number.isSafeInteger(source.messageCount) || source.messageCount < 1 || !Array.isArray(source.excluded) || source.excluded.some(value => typeof value !== "string") ||
        !Array.isArray(source.taskIds) || !Array.isArray(source.artifacts) || !Array.isArray(source.results) ||
        !sessions.some(s => s.id === source.sessionId) || source.taskIds.some(id => !tasks.some(t => t.id === id)) ||
        source.artifacts.some(a => !a || !Number.isSafeInteger(a.byteCount) || a.byteCount < 0 || (a.status !== "complete" && a.status !== "partial") || !artifacts.some(r => r.id === a.id && r.task_id === a.taskId && r.session_id === a.sessionId && Number(r.byte_count) >= a.byteCount && r.mime_type === a.mimeType && r.content_hash === a.contentHash)) ||
        source.results.some(r => !r || !Array.isArray(r.taskIds) || !works.some(w => w.id === r.workId) || r.taskIds.some(id => !tasks.some(t => t.id === id && t.work_id === r.workId && t.status === "completed")))) {
      fail("source_scope_unavailable", "分支的限定来源对象缺失或不在本次导入范围，请先核实完整来源");
    }
  }
}

export function allRows(db: Db, sql: string, params: unknown[] = []): Row[] {
  return db.prepare(sql).all(...(params as any[])) as unknown as Row[];
}

/** 分块 IN 查询（避免超大参数列表）。 */
export function rowsIn(db: Db, table: string, column: string, ids: string[]): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const marks = chunk.map(() => "?").join(",");
    out.push(...(allRows(db, `SELECT * FROM ${table} WHERE ${column} IN (${marks})`, chunk) as Row[]));
  }
  return out;
}

export function tableNames(db: Db): string[] {
  return allRows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(
    (r) => String(r.name),
  );
}

export function columnNames(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((c) => c.name);
}

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** 目标/源表登记核对：两库全部表都已登记，导入表的列集合一致。 */
export function checkTablePolicy(snapDb: Db, targetDb: Db | null, policy: TablePolicy): void {
  const checkCoverage = (names: string[], side: string) => {
    for (const name of names) {
      if (!policy[name]) fail("table_policy", `${side}存在未登记表 ${name}：请先在 TABLE_POLICY 登记导入或排除`);
    }
  };
  checkCoverage(tableNames(snapDb), "源库");
  if (targetDb) checkCoverage(tableNames(targetDb), "目标库");
  const targetTableNames = targetDb ? tableNames(targetDb) : [];
  for (const [name, entry] of Object.entries(policy)) {
    if (entry.policy !== "import") continue;
    if (!tableNames(snapDb).includes(name)) continue; // 源侧可能缺少本版本新增的账本类表
    // 目标全新目录可能尚无 v9 起不再创建的遗留表（github_*）：由 apply 按快照
    // DDL 重建后插入，列一致性在那时由同一份 DDL 保证；目标已有该表才比对
    if (targetDb && !targetTableNames.includes(name)) continue;
    const snapCols = columnNames(snapDb, name).sort().join(",");
    const targetCols = targetDb ? columnNames(targetDb, name).sort().join(",") : null;
    if (targetCols !== null && snapCols !== targetCols) {
      fail("table_policy", `导入表 ${name} 两库列集合不一致：源 ${snapCols}，目标 ${targetCols}`);
    }
  }
}

// ---------- 源与目标的读取 ----------

export interface SourceSnapshot {
  dir: string; // 快照临时目录（ruukoto.db 副本所在）
  dataDir: string; // 源数据目录（规范化绝对路径）
  db: Db;
  cleanup(): void;
  instanceId: string;
  product: string | null;
  /** 原始 schema 版本（复制后、迁移前读取）。 */
  originalSchemaVersion: number | null;
}

export function readMetaValue(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/**
 * 源快照：实例目录逐文件复制到 mkdtemp（0700），在副本上核实当前 schema，不转换旧格式。
 * 不用 sqlite 读连接/VACUUM 直读源目录——读 WAL 库会在源目录生成 -shm/-wal
 * 侧车文件；复制是唯一逐字节零接触的方式（源后台必须已停止，先经探测拒绝）。
 */
export function openSourceSnapshot(from: string): SourceSnapshot {
  const dataDir = path.resolve(from);
  const dbFile = path.join(dataDir, "ruukoto.db");
  if (!fs.existsSync(dbFile)) {
    fail("invalid_params", `源数据目录没有 ruukoto.db：${dataDir}`);
  }
  const probe = probeLockHolder(path.join(dataDir, "runtime.lock"));
  if (probe.held) {
    fail(
      probe.unverifiable ? "source_unverifiable" : "source_active",
      `源实例后台未停止或无法核实（${probe.detail}）；请先停止源后台，或改用它的副本目录`,
    );
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-import-"));
  fs.chmodSync(tmp, 0o700);
  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不阻断；系统会回收
    }
  };
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = dbFile + suffix;
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(tmp, "ruukoto.db" + suffix));
    }
    // 原始 schema 版本只在副本读取，不转换旧格式
    let originalSchemaVersion: number | null = null;
    {
      const raw = new DatabaseSync(path.join(tmp, "ruukoto.db"));
      try {
        const row = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
        originalSchemaVersion = row ? Number(row.value) : null;
      } catch {
        originalSchemaVersion = null;
      } finally {
        raw.close();
      }
    }
    if (originalSchemaVersion !== SCHEMA_VERSION) {
      fail("source_schema", `源库 schema 为 ${originalSchemaVersion ?? "缺失"}，当前程序为 ${SCHEMA_VERSION}；不转换旧任务或计划授权`);
    }
    const db = new Db(tmp);
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
    if (!integrity || integrity.integrity_check !== "ok") {
      fail("source_corrupt", `源库快照完整性检查失败：${integrity?.integrity_check ?? "无结果"}`);
    }
    const product = readMetaValue(db, PRODUCT_META_KEY);
    if (product !== null && product !== "ruukoto") {
      fail("product_mismatch", `源数据目录已登记为产品 ${product}，不能作为旧 ruukoto 实例导入`);
    }
    return { dir: tmp, dataDir, db, cleanup, instanceId: db.getInstanceId(), product, originalSchemaVersion };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** 目标视图：预览时以副本只读打开（零写入），应用时打开真实目录。 */
export interface TargetView {
  exists: boolean;
  db: Db | null;
  cleanup(): void;
  instanceId: string | null;
  product: string | null;
  schemaVersion: number | null;
}

export function copyDbFiles(dbFile: string, tmp: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = dbFile + suffix;
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(tmp, "ruukoto.db" + suffix));
  }
}

export function openTargetReadonlyCopy(deps: LegacyImportDeps): TargetView {
  const dbFile = path.join(deps.targetDataDir, "ruukoto.db");
  if (!fs.existsSync(dbFile)) {
    return { exists: false, db: null, cleanup: () => {}, instanceId: null, product: null, schemaVersion: null };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-import-target-"));
  fs.chmodSync(tmp, 0o700);
  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 同 openSourceSnapshot
    }
  };
  try {
    copyDbFiles(dbFile, tmp);
    const db = new Db(tmp);
    const product = readMetaValue(db, PRODUCT_META_KEY);
    const schemaVersion = Number(readMetaValue(db, "schema_version") ?? 0);
    return { exists: true, db, cleanup, instanceId: db.getInstanceId(), product, schemaVersion };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---------- 导入集合与各项决策 ----------

export interface FilePlanItem {
  /** 账本标识：sessions/<文件名>、artifacts/<id>.bin、agent-data/main.db[-wal] 或 github-archive-manifest.json。 */
  itemId: string;
  kind: "session" | "artifact" | "app_data" | "manifest";
  /** 关联的会话 / 产物行 id（报告用）。 */
  ownerId: string;
  src: string;
  dest: string;
  name: string;
  bytes: number;
  sha256: string;
  /** apply 后填：copied / skipped_same_sha。 */
  action?: "copied" | "skipped_same_sha";
}

export interface TaskClosing {
  task_id: string;
  from: string;
  to: "canceled" | "interrupted";
}

/** 严格核实登记的目录身份（realpath + dev + ino 三项都要一致）。 */
export function strictDirOk(cwdReal: string, dev: number, ino: number): boolean {
  try {
    const real = fs.realpathSync(cwdReal);
    const stat = fs.statSync(real);
    return stat.isDirectory() && real === cwdReal && stat.dev === Number(dev) && stat.ino === Number(ino);
  } catch {
    return false;
  }
}

/** 记忆来源引用是否全部落在导入范围内（owner_note 不依赖任何行）。 */
export function memoryRefsInScope(
  versions: Row[],
  sessionIds: Set<string>,
  artifactSession: Map<string, string>,
): { ok: boolean; reason: string | null } {
  for (const v of versions) {
    let refs: unknown;
    try {
      refs = JSON.parse(String(v.source_refs));
    } catch {
      return { ok: false, reason: `版本 ${v.version} 的 source_refs 不是合法 JSON` };
    }
    if (!Array.isArray(refs)) return { ok: false, reason: `版本 ${v.version} 的 source_refs 不是数组` };
    for (const ref of refs as Array<Record<string, unknown>>) {
      if (ref?.kind === "owner_note") continue;
      if (ref?.kind === "history_entry") {
        const sid = String(ref.sessionId ?? "");
        if (sessionIds.has(sid)) continue;
        return { ok: false, reason: `来源会话未导入：${sid}` };
      }
      if (ref?.kind === "artifact") {
        const aid = String(ref.artifactId ?? "");
        const owner = artifactSession.get(aid);
        if (owner && sessionIds.has(owner)) continue;
        return { ok: false, reason: `来源产物未导入：${aid}` };
      }
      return { ok: false, reason: `未知来源类别：${String(ref?.kind)}` };
    }
  }
  return { ok: true, reason: null };
}

// ---------- 目标状态合并（冲突、改名、根目录与组织映射决策、修订） ----------

export interface LedgerState {
  /** kind → itemId → 所属导入 id。 */
  items: Map<LedgerKind, Map<string, string>>;
  imports: Array<{ id: string; source_instance_id: string; status: string; created_at: string }>;
}

export function readLedger(db: Db | null): LedgerState {
  if (!db) return { items: new Map(), imports: [] };
  const imports = allRows(db, "SELECT id, source_instance_id, status, created_at FROM instance_imports ORDER BY created_at") as Array<{
    id: string;
    source_instance_id: string;
    status: string;
    created_at: string;
  }>;
  const items = new Map<LedgerKind, Map<string, string>>();
  for (const r of allRows(db, "SELECT kind, item_id, import_id FROM instance_import_items")) {
    const kind = String(r.kind) as LedgerKind;
    if (!items.has(kind)) items.set(kind, new Map());
    items.get(kind)!.set(String(r.item_id), String(r.import_id));
  }
  return { items, imports };
}

// ---------- 应用 ----------

export interface LegacyImportApplyResult {
  ok: true;
  /** true = 同键同参重放，返回原成果未再次执行。 */
  replayed: boolean;
  import_id: string;
  request_key: string;
  event_seq_from: number | null;
  event_seq_to: number | null;
  target_backup_path: string;
  target_backup_sha256: string;
  counts: Record<string, number>;
  report: Record<string, unknown>;
  created_at: string;
}

/** 逐行插入（列以目标表为准；行值为快照原值，保持逐字节忠实）。 */
export function insertRows(db: Db, table: string, rows: Row[], drop: string[] = []): void {
  if (rows.length === 0) return;
  const cols = columnNames(db, table).filter((c) => c in rows[0] && !drop.includes(c));
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const row of rows) {
    stmt.run(...cols.map((c) => (row[c] === undefined ? null : (row[c] as never))));
  }
}

export function escapeSqlPath(p: string): string {
  return p.replaceAll("'", "''");
}

// ---------- 回退 ----------

export interface LegacyImportRevertResult {
  ok: boolean;
  import_id: string;
  status: "applied" | "reverted";
  removed: Record<string, number>;
  files_removed: string[];
  files_kept: Array<{ item: string; reason: string }>;
  /** ok=false 时逐项列出的阻挡项（拒绝回退）。 */
  blockers?: string[];
}

// ---------- 列表 ----------

export interface LegacyImportListItem {
  id: string;
  request_key: string;
  source_instance_id: string;
  source_product: string | null;
  source_schema_version: number | null;
  source_dir: string;
  event_seq_from: number | null;
  event_seq_to: number | null;
  status: string;
  item_count: number;
  created_at: string;
  reverted_at: string | null;
}

export function listLegacyImports(deps: LegacyImportDeps): LegacyImportListItem[] {
  const targetDbFile = path.join(deps.targetDataDir, "ruukoto.db");
  if (!fs.existsSync(targetDbFile)) return [];
  const tdb = new Db(deps.targetDataDir);
  try {
    return allRows(
      tdb,
      `SELECT i.id, i.request_key, i.source_instance_id, i.source_product, i.source_schema_version, i.source_dir,
        i.event_seq_from, i.event_seq_to, i.status, i.created_at, i.reverted_at,
        (SELECT count(*) FROM instance_import_items x WHERE x.import_id = i.id) item_count
       FROM instance_imports i ORDER BY i.created_at`,
    ).map((r) => ({
      id: String(r.id),
      request_key: String(r.request_key),
      source_instance_id: String(r.source_instance_id),
      source_product: r.source_product === null ? null : String(r.source_product),
      source_schema_version: r.source_schema_version === null ? null : Number(r.source_schema_version),
      source_dir: String(r.source_dir),
      event_seq_from: r.event_seq_from === null ? null : Number(r.event_seq_from),
      event_seq_to: r.event_seq_to === null ? null : Number(r.event_seq_to),
      status: String(r.status),
      item_count: Number(r.item_count),
      created_at: String(r.created_at),
      reverted_at: r.reverted_at === null ? null : String(r.reverted_at),
    }));
  } finally {
    tdb.close();
  }
}
