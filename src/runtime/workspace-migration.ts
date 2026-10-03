/**
 * 旧开发会话/资料 → 工作区的组织迁移（agent-direction issue 07 步骤 2/3）。
 *
 * 唯一实现处：预览（preview_workspace_migration）与应用（apply_workspace_migration）
 * 的全部推断都集中在本模块；Runtime 只做接线，CLI 经已认证控制面调用，两边不
 * 各自推断。边界（与步骤 1 相同）：组织归属只决定普通列表与工作区的展示归属；
 * 历史、产物、记忆、授权与凭据继续按原 projectId/会话 ID/文件路径定位，组织
 * 映射不复制、不合并旧配置，也不改变运行中任务身份。
 *
 * - 预览零写入：只读 store 与文件系统，不产生事件；按源项目查询并限制载荷，
 *   截断如实报告，截断结果不得用于认领或应用。
 * - 应用单事务：先查成功回执（同键同规范请求返回原成果，同键异参
 *   request_conflict），再核对预览修订并同事务提交创建/认领/条件更新/事件/回执；
 *   任一步失败整体回滚。事务内做最后一次同步目录身份核查——SQLite 与文件系统
 *   没有跨系统事务，目录此后仍可能被替换，后续任务按既有规则重新验证。
 * - 回退只恢复显式会话组织映射（按回执核对当前值）；已认领的根目录身份与迁移
 *   后产生的执行事实保留。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Store } from "../core/store.ts";
import type { AgentRole, Project, Session, SessionKind } from "../core/types.ts";
import { distinctDirIdentities, resolveDirIdentitySync, sameDirIdentity, type DirIdentity } from "../core/dir-identity.ts";
import { assertGrantNotProtected } from "../agent/execution/approved-ops.ts";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

// ---------- 线上形状（snake_case；CLI 计划文件与 op 参数共用） ----------

/** map_sessions 的单个会话分配目标。 */
export type MigrationTargetChoice =
  | { kind: "existing_workspace"; project_id: string }
  | { kind: "new_workspace"; root: string };

/** 迁移计划（owner 显式选择；preview --plan 与 apply --plan 的线上形状）。 */
export interface MigrationPlanInput {
  action: "map_sessions" | "claim_source" | "revert";
  /** claim_source：认领的根目录（必须是唯一的真实会话目录本身）。 */
  root?: string;
  /** map_sessions：明确选中的会话分配；缺省的会话保持现状（含未映射）。 */
  assignments?: Record<string, MigrationTargetChoice>;
  /** revert：回退哪一次成功应用的回执（原 request_id）。 */
  revert_request_id?: string;
}

export interface MigrationPreviewInput {
  projectId: string;
  plan?: unknown;
  limit?: number;
}

export interface MigrationApplyInput {
  projectId: string;
  instanceId: string;
  requestId: string;
  plan: unknown;
  expectedRevision?: string;
}

export type DirGroupStatus = "valid" | "missing" | "replaced" | "unverifiable";

export interface MigrationPreview {
  instance_id: string;
  source: {
    project_id: string;
    name: string;
    root_dir: { cwd: string; cwdReal: string; dev: number; ino: number } | null;
    settings_version: number;
    /** 实际配置来源：恒为源项目本身；组织映射不改变配置与资料来源。 */
    config_source_project_id: string;
  };
  dir_groups: Array<{
    identity: DirIdentity;
    status: DirGroupStatus;
    reason: string | null;
    session_ids: string[];
    existing_workspace_id: string | null;
    is_worktree: boolean;
  }>;
  sessions: Array<{
    session_id: string;
    cwd: string;
    cwd_real: string;
    kind: SessionKind;
    role_bound: boolean;
    excluded: "role" | "group_chat" | null;
    workspace_project_id: string | null;
    /** 项目指令实际使用的基准目录（rootDir?.cwdReal ?? session.cwdReal，issue 06 规则）。 */
    instruction_base_dir: string;
    /** 历史文件状态：缺失/未落盘/损坏单独报告，不显示为「没有历史」。 */
    history: "ok" | "not_flushed" | "missing" | "unreadable";
    history_reason: string | null;
  }>;
  findings: Array<{ kind: string; message: string; session_ids?: string[]; project_ids?: string[] }>;
  workspaces: Array<{ project_id: string; name: string; root_real: string }>;
  workspaces_truncated: boolean;
  safe_claim: { eligible: boolean; reasons: string[]; root: DirIdentity | null };
  suggested: MigrationPlanInput | null;
  /** 带 plan 重新预览时的规范化选择与修订；choices 非法时 revision 为 null 且 plan_errors 非空。 */
  plan: MigrationPlanInput | null;
  plan_errors: string[];
  revision: string | null;
  truncated: boolean;
  scanned_sessions: number;
  total_sessions: number;
}

export interface MigrationApplyResult {
  ok: true;
  /** true = 同键重放返回原成果，未再次执行。 */
  replayed: boolean;
  action: "map_sessions" | "claim_source" | "revert";
  source_project_id: string;
  claimed_root: DirIdentity | null;
  created_workspaces: Array<{ project_id: string; name: string; root_real: string }>;
  /** 组织字段变更（from = 应用前值，to = 应用后值）；能回退的只有这部分。 */
  mappings: Array<{ session_id: string; from: string | null; to: string | null }>;
  /** revert 专用：被回退的原请求 ID。 */
  reverted_request_id?: string;
  receipt_request_id: string;
}

export interface MigrationDeps {
  store: Store;
  instanceId: string;
  protectedRoots: string[];
}

/** 预览会话核查上限（默认与硬上限）；超出即截断，截断结果不得用于认领/应用。 */
export const PREVIEW_DEFAULT_LIMIT = 500;
export const PREVIEW_MAX_LIMIT = 5000;
const WORKSPACES_LIST_LIMIT = 500;

// ---------- 规范化与哈希 ----------

/** 规范化 JSON：对象键递归排序（数组保序），同一语义内容产出同一字符串。 */
function canonicalJson(value: unknown): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortValue((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sortValue(value));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 修订与回执里的目录身份只取判定字段（cwd 是展示用的路径变体，不参与身份）。 */
function normDir(identity: DirIdentity | null | undefined): { cwdReal: string; dev: number; ino: number } | null {
  return identity ? { cwdReal: identity.cwdReal, dev: identity.dev, ino: identity.ino } : null;
}

// ---------- 目录与历史核查 ----------

type DirCheck = { status: DirGroupStatus; reason: string | null };

/**
 * 核实登记的目录身份仍成立（realpath + dev + ino），区分失效/被替换/无权核实。
 * 被替换时如实报告——当前同路径的新目录不当作旧目录。
 */
function checkRegisteredDir(identity: DirIdentity): DirCheck {
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(identity.cwdReal);
    stat = fs.statSync(real);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "missing", reason: `目录已不存在：${identity.cwdReal}` };
    }
    return { status: "unverifiable", reason: `无法核实目录：${identity.cwdReal}（${(err as Error).message}）` };
  }
  if (!stat.isDirectory()) {
    return { status: "replaced", reason: `目录位置已被非目录替换：${identity.cwdReal}` };
  }
  if (real !== identity.cwdReal || stat.dev !== identity.dev || stat.ino !== identity.ino) {
    return {
      status: "replaced",
      reason: `目录身份已变化：登记 ${identity.cwdReal} (dev=${identity.dev},ino=${identity.ino})，当前 ${real} (dev=${stat.dev},ino=${stat.ino})`,
    };
  }
  return { status: "valid", reason: null };
}

/** sessionReal 是否等于 rootReal 或位于其内（两个都是 realpath 规范化路径）。 */
function insideOrEqual(rootReal: string, sessionReal: string): boolean {
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return sessionReal === rootReal || sessionReal.startsWith(prefix);
}

/** Git worktree 的已知信号：.git 是文件（gitdir 指针）而非目录。 */
function isWorktreeDir(dirReal: string): boolean {
  try {
    const stat = fs.statSync(path.join(dirReal, ".git"));
    return !stat.isDirectory();
  } catch {
    return false;
  }
}

/** 历史文件状态：缺失/未落盘/损坏单独报告，不显示为「没有历史」（空文件是 ok）。
 * 校验样本内每一条完整 JSONL 行——样本上限 64 KiB，截断的最后一段（未读满的
 * 尾部行）按不完整处理不作损坏判定，之后的行无法核实（样本外不做静默结论）。 */
function historyStatusOf(session: Session): { history: "ok" | "not_flushed" | "missing" | "unreadable"; reason: string | null } {
  if (session.sessionFile === null) {
    return { history: "not_flushed", reason: "历史尚未落盘：未登记会话文件" };
  }
  let fd: number;
  try {
    fd = fs.openSync(session.sessionFile, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { history: "missing", reason: `登记的会话文件缺失：${session.sessionFile}` };
    }
    return { history: "unreadable", reason: `会话文件不可读：${session.sessionFile}（${(err as Error).message}）` };
  }
  try {
    const fileSize = fs.fstatSync(fd).size;
    const sample = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, sample, 0, sample.length, 0);
    if (bytes === 0) return { history: "ok", reason: null };
    const text = sample.subarray(0, bytes).toString("utf8");
    const lines = text.split("\n");
    // 样本未覆盖整个文件且结尾没有换行：最后一段是截断行（读满的末行仍判定）
    if (bytes < fileSize && !text.endsWith("\n")) lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === "") continue; // 空行（如末尾换行后的串尾）不算条目
      try {
        JSON.parse(line);
      } catch {
        return { history: "unreadable", reason: `会话文件已损坏（第 ${i + 1} 行不是合法 JSONL）：${session.sessionFile}` };
      }
    }
    return { history: "ok", reason: null };
  } catch (err) {
    return { history: "unreadable", reason: `会话文件不可读：${session.sessionFile}（${(err as Error).message}）` };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- 源项目扫描（预览与应用共用） ----------

interface SourceScan {
  project: Project;
  roles: AgentRole[];
  roleSessionIds: Set<string>;
  projects: Project[];
  /** 源项目的全部会话（created_at, id 序）中的受核查部分。 */
  scanned: Session[];
  plain: Session[];
  excluded: Session[];
  groups: Array<{
    identity: DirIdentity;
    status: DirGroupStatus;
    reason: string | null;
    sessionIds: string[];
    existingWorkspaceId: string | null;
    isWorktree: boolean;
  }>;
  truncated: boolean;
  total: number;
}

function scanSourceProject(deps: MigrationDeps, projectId: string, limit: number): SourceScan {
  const store = deps.store;
  const project = store.getProject(projectId);
  if (!project) fail("not_found", `项目不存在：${projectId}`);
  const roles = store.listAgentRoles();
  // SubAgent 的内部工作会话（issue 11）与固定角色会话一样不参与迁移扫描与组织映射
  const roleSessionIds = new Set([...roles.map((r) => r.sessionId), ...store.listSubAgents().map((a) => a.sessionId)]);
  const projects = store.listProjects();
  const allOfProject = store.listSessions().filter((s) => s.projectId === projectId);
  const truncated = allOfProject.length > limit;
  const scanned = allOfProject.slice(0, limit);
  const plain = scanned.filter((s) => s.kind === "dev" && !roleSessionIds.has(s.id));
  const excluded = scanned.filter((s) => s.kind !== "dev" || roleSessionIds.has(s.id));
  const groups = distinctDirIdentities(plain).map((identity) => {
    const check = checkRegisteredDir(identity);
    const holder = projects.find((p) => p.rootDir !== null && sameDirIdentity(p.rootDir, identity));
    return {
      identity,
      status: check.status,
      reason: check.reason,
      sessionIds: plain.filter((s) => sameDirIdentity(identity, { cwd: s.cwd, cwdReal: s.cwdReal, dev: s.cwdDev, ino: s.cwdIno })).map((s) => s.id),
      existingWorkspaceId: holder?.id ?? null,
      isWorktree: check.status === "valid" && isWorktreeDir(identity.cwdReal),
    };
  });
  return { project, roles, roleSessionIds, projects, scanned, plain, excluded, groups, truncated, total: allOfProject.length };
}

// ---------- 安全认领（claim_source）条件 ----------

interface SafeClaim {
  eligible: boolean;
  reasons: string[];
  root: DirIdentity | null;
}

/**
 * 安全认领原 ID 的全部条件（步骤 2）：
 * 来源项目尚无根目录；会话集合非空且完整集合均为非角色的普通 dev（未被截断）；
 * 所有目录仍有效且为同一真实目录；没有其他项目占用该根；没有已映射的会话。
 * 共同祖先、部分会话与混合项目一律不可走此路径。
 * 与目录入口认领（dir-identity.ts 的 legacyProjectClaimableFromDir）形状不同是
 * 刻意分层：本函数多了「目录仍有效、无占用、无已映射」的组织迁移条件；
 * 入口收紧以 legacyProjectClaimableFromDir 为准，本函数不反向引用它。
 */
function computeSafeClaim(scan: SourceScan): SafeClaim {
  const reasons: string[] = [];
  if (scan.truncated) reasons.push("会话集合已截断，未核查完整项目");
  if (scan.project.rootDir !== null) reasons.push("项目已有根目录归属");
  if (scan.plain.length === 0) reasons.push("项目没有可迁移的普通 dev 会话");
  if (scan.excluded.length > 0) reasons.push("项目含角色绑定或群聊会话（混合项目不可认领）");
  let root: DirIdentity | null = null;
  const invalid = scan.groups.filter((g) => g.status !== "valid");
  if (scan.groups.length > 0 && invalid.length > 0) {
    reasons.push(`存在失效或被替换的目录：${invalid.map((g) => g.identity.cwdReal).join("，")}；目录恢复后可重新预览`);
  } else if (scan.groups.length > 1) {
    reasons.push("会话分布在多个真实目录：认领目标必须是目录本身，共同祖先或部分会话均不可认领");
  } else if (scan.groups.length === 1) {
    const candidate = scan.groups[0]!.identity;
    const holder = scan.projects.find((p) => p.id !== scan.project.id && p.rootDir !== null && sameDirIdentity(p.rootDir, candidate));
    if (holder) {
      reasons.push(`目录已被其他工作区占用：${holder.name}（${holder.id}）`);
    } else {
      root = candidate;
      const mapped = scan.plain.filter((s) => s.workspaceProjectId !== null);
      if (mapped.length > 0) {
        reasons.push(`存在已映射到其他工作区的会话：${mapped.map((s) => s.id).join("，")}`);
        root = null;
      }
    }
  }
  return { eligible: reasons.length === 0 && root !== null, reasons, root };
}

// ---------- 计划解析与校验 ----------

type ResolvedTarget =
  | { key: string; kind: "existing_workspace"; projectId: string; identity: DirIdentity }
  | { key: string; kind: "new_workspace"; identity: DirIdentity };

interface ResolvedPlan {
  action: "map_sessions" | "claim_source";
  /** claim_source 的认领目标身份。 */
  root: DirIdentity | null;
  assignments: Array<{ sessionId: string; target: ResolvedTarget }>;
  targets: ResolvedTarget[];
  /** 修订哈希输入中的规范化计划（身份而非路径字符串）。 */
  normalized: Record<string, unknown>;
}

function parsePlan(raw: unknown): MigrationPlanInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_params", "plan 必须是对象");
  const plan = raw as Record<string, unknown>;
  if (plan["action"] !== "map_sessions" && plan["action"] !== "claim_source" && plan["action"] !== "revert") {
    fail("invalid_params", "plan.action 必须是 map_sessions / claim_source / revert");
  }
  if (plan["root"] !== undefined && typeof plan["root"] !== "string") fail("invalid_params", "plan.root 必须是字符串");
  if (plan["revert_request_id"] !== undefined && typeof plan["revert_request_id"] !== "string") fail("invalid_params", "plan.revert_request_id 必须是字符串");
  const assignments = plan["assignments"];
  if (assignments !== undefined) {
    if (assignments === null || typeof assignments !== "object" || Array.isArray(assignments)) fail("invalid_params", "plan.assignments 必须是对象（sessionId → 目标）");
    for (const [sessionId, choice] of Object.entries(assignments as Record<string, unknown>)) {
      const c = choice as Record<string, unknown> | null;
      if (c === null || typeof c !== "object") fail("invalid_params", `assignments.${sessionId} 必须是对象`);
      if (c["kind"] === "existing_workspace") {
        if (typeof c["project_id"] !== "string" || !c["project_id"]) fail("invalid_params", `assignments.${sessionId}.project_id 必填`);
      } else if (c["kind"] === "new_workspace") {
        if (typeof c["root"] !== "string" || !c["root"]) fail("invalid_params", `assignments.${sessionId}.root 必填`);
      } else {
        fail("invalid_params", `assignments.${sessionId}.kind 必须是 existing_workspace / new_workspace`);
      }
    }
  }
  return plan as unknown as MigrationPlanInput;
}

/**
 * 校验选择并解析目标身份（预览 --plan 与应用共用）：
 * - 会话必须是源项目内已核查的普通 dev（角色/群聊/截断外一律拒绝）；
 * - 会话目录有效且位于所选根内（父目录作多仓库工作区时逐会话核对）；
 * - existing 目标必须带根目录归属且根仍有效；new 目标须通过目录与保护根校验，
 *   同一真实目录已有工作区时必须复用其 ID（不按显示名称决定归属）。
 */
function validatePlan(deps: MigrationDeps, scan: SourceScan, plan: MigrationPlanInput): { errors: string[]; resolved: ResolvedPlan | null } {
  const errors: string[] = [];
  const plainIds = new Set(scan.plain.map((s) => s.id));
  const excludedIds = new Map(scan.excluded.map((s) => [s.id, s]));
  if (plan.action === "revert") {
    errors.push("回退不需要预览修订：直接用 project migration-apply --plan <含 action=revert 的文件>");
    return { errors, resolved: null };
  }
  if (scan.truncated) errors.push("会话集合已截断，不能据此生成修订；请先完整核查");

  const resolveTarget = (choice: MigrationTargetChoice, sessionId: string, session: Session): ResolvedTarget | null => {
    if (choice.kind === "existing_workspace") {
      const target = deps.store.getProject(choice.project_id);
      if (!target) {
        errors.push(`会话 ${sessionId}：目标项目不存在：${choice.project_id}`);
        return null;
      }
      if (target.rootDir === null) {
        errors.push(`会话 ${sessionId}：目标 ${choice.project_id} 不是带根目录归属的工作区`);
        return null;
      }
      const check = checkRegisteredDir(target.rootDir);
      if (check.status !== "valid") {
        errors.push(`会话 ${sessionId}：目标工作区根目录已失效或被替换：${target.rootDir.cwdReal}（${check.reason}）`);
        return null;
      }
      if (!insideOrEqual(target.rootDir.cwdReal, session.cwdReal)) {
        errors.push(`会话 ${sessionId}：真实目录 ${session.cwdReal} 不在目标工作区根目录 ${target.rootDir.cwdReal} 内`);
        return null;
      }
      return { key: `existing:${target.id}`, kind: "existing_workspace", projectId: target.id, identity: target.rootDir };
    }
    let identity: DirIdentity;
    try {
      identity = resolveDirIdentitySync(choice.root);
    } catch (err) {
      errors.push(`会话 ${sessionId}：新工作区根目录不可用：${choice.root}（${(err as Error).message}）`);
      return null;
    }
    try {
      assertGrantNotProtected(identity.cwdReal, deps.protectedRoots);
    } catch (err) {
      errors.push(`会话 ${sessionId}：${(err as Error).message}`);
      return null;
    }
    const holder = scan.projects.find((p) => p.rootDir !== null && sameDirIdentity(p.rootDir, identity));
    if (holder) {
      errors.push(`会话 ${sessionId}：目录已有工作区 ${holder.name}（${holder.id}），请改用 existing_workspace 复用其 ID`);
      return null;
    }
    if (!insideOrEqual(identity.cwdReal, session.cwdReal)) {
      errors.push(`会话 ${sessionId}：真实目录 ${session.cwdReal} 不在所选根目录 ${identity.cwdReal} 内`);
      return null;
    }
    return { key: `new:${identity.cwdReal}:${identity.dev}:${identity.ino}`, kind: "new_workspace", identity };
  };

  if (plan.action === "claim_source") {
    if (typeof plan.root !== "string" || !plan.root) return { errors: [...errors, "claim_source 需要 root（认领的根目录）"], resolved: null };
    const safe = computeSafeClaim(scan);
    if (!safe.eligible || safe.root === null) return { errors: [...errors, `安全认领条件不成立：${safe.reasons.join("；")}`], resolved: null };
    let identity: DirIdentity;
    try {
      identity = resolveDirIdentitySync(plan.root);
    } catch (err) {
      return { errors: [...errors, `认领根目录不可用：${plan.root}（${(err as Error).message}）`], resolved: null };
    }
    if (!sameDirIdentity(identity, safe.root)) {
      return { errors: [...errors, `认领目标必须是目录本身：${safe.root.cwdReal}（共同祖先或父目录不可认领）`], resolved: null };
    }
    return {
      errors,
      resolved: errors.length > 0 ? null : {
        action: "claim_source",
        root: safe.root,
        assignments: [],
        targets: [],
        normalized: { action: "claim_source", rootDir: normDir(safe.root) },
      },
    };
  }

  // map_sessions
  const rawAssignments = Object.entries(plan.assignments ?? {});
  if (rawAssignments.length === 0) return { errors: [...errors, "map_sessions 需要至少一条 assignments（不分配的会话保持现状）"], resolved: null };
  const assignments: Array<{ sessionId: string; target: ResolvedTarget }> = [];
  const targetsByKey = new Map<string, ResolvedTarget>();
  for (const [sessionId, choice] of rawAssignments.sort(([a], [b]) => a.localeCompare(b))) {
    if (!plainIds.has(sessionId)) {
      const excluded = excludedIds.get(sessionId);
      errors.push(
        excluded !== undefined
          ? `会话 ${sessionId} 属于角色绑定或群聊会话，明确排除在迁移之外`
          : `会话 ${sessionId} 不是源项目内已核查的普通 dev 会话（不存在、属于其他项目或在截断之外）`,
      );
      continue;
    }
    const session = scan.plain.find((s) => s.id === sessionId)!;
    const group = scan.groups.find((g) => g.sessionIds.includes(sessionId));
    if (group && group.status !== "valid") {
      errors.push(`会话 ${sessionId}：目录失效或被替换（${group.reason}），恢复后重新预览；不把新目录当作旧目录`);
      continue;
    }
    const target = resolveTarget(choice, sessionId, session);
    if (!target) continue;
    targetsByKey.set(target.key, target);
    assignments.push({ sessionId, target });
  }
  if (errors.length > 0) return { errors, resolved: null };
  return {
    errors,
    resolved: {
      action: "map_sessions",
      root: null,
      assignments,
      targets: [...targetsByKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
      normalized: {
        action: "map_sessions",
        assignments: assignments.map((a) => ({ sessionId: a.sessionId, target: a.target.key })),
      },
    },
  };
}

/**
 * 预览修订 = 相关元数据的规范化内容哈希（步骤 3 列表）：
 * 来源根目录与设置版本、完整源会话集合（类别/角色绑定/登记目录身份/现有组织
 * 映射）及目标根身份，加上显式选择本身。无关任务输出不在哈希输入里，
 * 不使用全局事件 seq。
 */
function revisionOf(scan: SourceScan, resolved: ResolvedPlan): string {
  return `r1.${sha256(canonicalJson({
    v: 1,
    source: { projectId: scan.project.id, rootDir: normDir(scan.project.rootDir), settingsVersion: scan.project.settingsVersion },
    sessions: scan.scanned.map((s) => ({
      id: s.id,
      kind: s.kind,
      roleBound: scan.roleSessionIds.has(s.id),
      workspaceProjectId: s.workspaceProjectId,
      dir: { cwdReal: s.cwdReal, dev: s.cwdDev, ino: s.cwdIno },
    })),
    roles: scan.roles.map((r) => ({ id: r.id, projectId: r.projectId, sessionId: r.sessionId })).sort((a, b) => a.id.localeCompare(b.id) || a.projectId.localeCompare(b.projectId)),
    targets: resolved.targets.map((t) => ({
      key: t.key,
      projectId: t.kind === "existing_workspace" ? t.projectId : null,
      dir: normDir(t.identity),
    })),
    plan: resolved.normalized,
  }))}`;
}

// ---------- 预览（零写入） ----------

function buildFindings(scan: SourceScan, allSessions: Session[]): MigrationPreview["findings"] {
  const findings: MigrationPreview["findings"] = [];
  const { project, plain, excluded, groups } = scan;
  if (scan.truncated) {
    findings.push({ kind: "scan_truncated", message: `会话集合 ${scan.total} 超过核查上限，预览不完整；不能据以认领或应用` });
  }
  if (excluded.length > 0) {
    findings.push({
      kind: "mixed_project",
      message: `项目含 ${excluded.length} 个角色绑定或群聊会话（已明确排除）：普通会话可映射，整个项目不可认领`,
      session_ids: excluded.map((s) => s.id),
    });
  }
  if (project.rootDir !== null) {
    const rootCheck = checkRegisteredDir(project.rootDir);
    if (rootCheck.status !== "valid") {
      findings.push({ kind: "root_invalid", message: `项目已认领的根目录已失效或被替换：${project.rootDir.cwdReal}（${rootCheck.reason}）` });
    }
    const outside = plain.filter((s) => !insideOrEqual(project.rootDir!.cwdReal, s.cwdReal));
    if (outside.length > 0) {
      findings.push({
        kind: "claimed_outside_root",
        message: `${outside.length} 个会话的真实目录在已认领根目录之外，仅列异常；目录有效时可显式组织映射，其配置来源仍是原项目`,
        session_ids: outside.map((s) => s.id),
      });
    }
  } else if (groups.length > 1) {
    findings.push({ kind: "multi_dir_project", message: `旧项目会话分布在 ${groups.length} 个登记目录：分别归属，不推断共同祖先或 Git 根` });
  }
  for (const group of groups) {
    const others = [
      ...new Set(
        allSessions
          .filter((s) => s.projectId !== project.id && sameDirIdentity(group.identity, { cwd: s.cwd, cwdReal: s.cwdReal, dev: s.cwdDev, ino: s.cwdIno }))
          .map((s) => s.projectId),
      ),
    ].filter((id) => !scan.projects.find((p) => p.id === id)?.rootDir);
    if (others.length > 0) {
      findings.push({
        kind: "same_dir_multiple_projects",
        message: `目录 ${group.identity.cwdReal} 下还有其他旧项目的会话（${others.join("，")}）：归属由拥有者选择，不因合并展示获得新的读取权限`,
        project_ids: others,
      });
    }
    if (group.status !== "valid") {
      findings.push({
        kind: "dir_invalid",
        message: `目录${group.status === "missing" ? "已失效" : group.status === "replaced" ? "已被替换" : "无权核实"}：${group.identity.cwdReal}（${group.reason}）；保留原记录，目录恢复后可重新预览`,
        session_ids: group.sessionIds,
      });
    }
    if (group.isWorktree) {
      findings.push({ kind: "known_worktree", message: `${group.identity.cwdReal} 是 Git worktree（.git 为文件）：列出但不自动推断其所属工作区`, session_ids: group.sessionIds });
    }
  }
  const validReals = groups.filter((g) => g.status === "valid").map((g) => g.identity.cwdReal);
  const nested: string[] = [];
  for (const a of validReals) for (const b of validReals) if (a !== b && insideOrEqual(a, b)) nested.push(`${b} 位于 ${a} 内`);
  for (const line of nested) findings.push({ kind: "nested_roots", message: `嵌套目录对应多个根：${line}；归属由拥有者选择` });
  return findings;
}

function buildSuggested(scan: SourceScan, safe: SafeClaim): MigrationPlanInput | null {
  if (safe.eligible && safe.root !== null) return { action: "claim_source", root: safe.root.cwdReal };
  const assignments: Record<string, MigrationTargetChoice> = {};
  for (const group of scan.groups) {
    if (group.status !== "valid") continue;
    const target: MigrationTargetChoice = group.existingWorkspaceId !== null
      ? { kind: "existing_workspace", project_id: group.existingWorkspaceId }
      : { kind: "new_workspace", root: group.identity.cwdReal };
    for (const sessionId of group.sessionIds) {
      const session = scan.plain.find((s) => s.id === sessionId)!;
      if (session.workspaceProjectId !== null) continue; // 已映射的会话不重复建议
      assignments[sessionId] = target;
    }
  }
  return Object.keys(assignments).length > 0 ? { action: "map_sessions", assignments } : null;
}

/** 只读预览：列出可映射项、歧义与异常；带 plan 时校验选择并生成绑定修订。 */
export function previewWorkspaceMigration(deps: MigrationDeps, input: MigrationPreviewInput): MigrationPreview {
  const limit = Math.max(1, Math.min(PREVIEW_MAX_LIMIT, Math.floor(input.limit ?? PREVIEW_DEFAULT_LIMIT)));
  const scan = scanSourceProject(deps, input.projectId, limit);
  const allSessions = deps.store.listSessions();
  const safe = computeSafeClaim(scan);
  const findings = buildFindings(scan, allSessions);

  let plan: MigrationPlanInput | null = null;
  let planErrors: string[] = [];
  let revision: string | null = null;
  if (input.plan !== undefined) {
    const parsed = parsePlan(input.plan);
    const validation = validatePlan(deps, scan, parsed);
    plan = parsed;
    if (validation.errors.length > 0) {
      planErrors = validation.errors;
    } else if (validation.resolved) {
      revision = revisionOf(scan, validation.resolved);
    }
  }

  const workspacesAll = scan.projects.filter((p) => p.rootDir !== null);
  return {
    instance_id: deps.instanceId,
    source: {
      project_id: scan.project.id,
      name: scan.project.name,
      root_dir: scan.project.rootDir,
      settings_version: scan.project.settingsVersion,
      config_source_project_id: scan.project.id,
    },
    dir_groups: scan.groups.map((g) => ({
      identity: g.identity,
      status: g.status,
      reason: g.reason,
      session_ids: g.sessionIds,
      existing_workspace_id: g.existingWorkspaceId,
      is_worktree: g.isWorktree,
    })),
    sessions: scan.scanned.map((s) => {
      const roleBound = scan.roleSessionIds.has(s.id);
      const history = historyStatusOf(s);
      return {
        session_id: s.id,
        cwd: s.cwd,
        cwd_real: s.cwdReal,
        kind: s.kind,
        role_bound: roleBound,
        excluded: roleBound ? ("role" as const) : s.kind !== "dev" ? ("group_chat" as const) : null,
        workspace_project_id: s.workspaceProjectId,
        instruction_base_dir: scan.project.rootDir?.cwdReal ?? s.cwdReal,
        history: history.history,
        history_reason: history.reason,
      };
    }),
    findings,
    workspaces: workspacesAll.slice(0, WORKSPACES_LIST_LIMIT).map((p) => ({ project_id: p.id, name: p.name, root_real: p.rootDir!.cwdReal })),
    workspaces_truncated: workspacesAll.length > WORKSPACES_LIST_LIMIT,
    safe_claim: safe,
    suggested: buildSuggested(scan, safe),
    plan,
    plan_errors: planErrors,
    revision,
    truncated: scan.truncated,
    scanned_sessions: scan.scanned.length,
    total_sessions: scan.total,
  };
}

// ---------- 回执 ----------

const RECEIPT_PREFIX = "migration_receipt:";

interface MigrationReceipt {
  version: 1;
  /** 同键同规范请求的规范化内容哈希；异参即 request_conflict。 */
  requestDigest: string;
  action: "map_sessions" | "claim_source" | "revert";
  sourceProjectId: string;
  /** claim_source：认领的根目录身份（回退保留，不回滚）。 */
  claim: { projectId: string; rootReal: string } | null;
  /** 组织字段的原值与新值：回退只恢复这部分（按当前值校验）。 */
  mappings: Array<{ sessionId: string; from: string | null; to: string | null }>;
  /** 新建的工作区（保留，不随回退删除）。 */
  createdWorkspaces: Array<{ project_id: string; name: string; root_real: string }>;
  /** revert：被回退的原请求 ID。 */
  revertedRequestId: string | null;
  result: MigrationApplyResult;
  createdAt: string;
}

function digestOfRequest(projectId: string, instanceId: string, plan: unknown, expectedRevision: string | undefined): string {
  return sha256(canonicalJson({ projectId, instanceId, plan: plan ?? null, expectedRevision: expectedRevision ?? null }));
}

function readReceipt(store: Store, requestId: string): MigrationReceipt | null {
  const raw = store.getMetaValue(RECEIPT_PREFIX + requestId);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as MigrationReceipt;
  } catch {
    fail("internal_error", `迁移回执损坏：${requestId}（不覆盖、不重发，请人工核实）`);
  }
}

function firstReceiptCheck(store: Store, requestId: string, requestDigest: string): MigrationApplyResult | null {
  const receipt = readReceipt(store, requestId);
  if (!receipt) return null;
  if (receipt.requestDigest !== requestDigest) {
    fail("request_conflict", `request_id 已用于不同的迁移请求：${requestId}（不自动重发，请以原请求 ID 核实）`);
  }
  return { ...receipt.result, replayed: true };
}

// ---------- 应用（单事务 + 幂等回执） ----------

/**
 * 应用迁移（步骤 3）：回执先行（先于修订检查，成功后的同键重放返回原成果，
 * 不会被自己的变更误判过期）；无回执时重读记录、核对修订并单事务提交。
 * 组织映射不改变运行中任务身份；不改写 JSONL、不移动产物、不重建会话、
 * 不恢复审批、不重放未完成任务；旧配置、授权与凭据不复制、不合并。
 */
export function applyWorkspaceMigration(deps: MigrationDeps, input: MigrationApplyInput): MigrationApplyResult {
  const store = deps.store;
  if (!input.instanceId || input.instanceId !== deps.instanceId) {
    fail("invalid_params", "实例标识不符：迁移只适用于当前连接实例");
  }
  if (!input.requestId) fail("invalid_params", "request_id 必填（稳定幂等键）");
  const plan = parsePlan(input.plan);
  const digest = digestOfRequest(input.projectId, input.instanceId, input.plan, input.expectedRevision);
  const replay = firstReceiptCheck(store, input.requestId, digest);
  if (replay) return replay;
  if (plan.action === "revert") return applyRevert(deps, input, plan, digest);

  if (typeof input.expectedRevision !== "string" || !input.expectedRevision) {
    fail("invalid_params", "expected_revision 必填（revert 除外：回退按原回执校验当前值）");
  }
  const scan = scanSourceProject(deps, input.projectId, PREVIEW_MAX_LIMIT);
  if (scan.truncated) fail("revision_conflict", `会话集合 ${scan.total} 超过核查上限，无法安全应用；请缩小范围后重新预览`);
  const validation = validatePlan(deps, scan, plan);
  if (validation.errors.length > 0 || !validation.resolved) fail("invalid_params", `迁移计划无效：${validation.errors.join("；")}`);
  const revision = revisionOf(scan, validation.resolved);
  if (revision !== input.expectedRevision) {
    fail("revision_conflict", "预览修订已过期或与当前选择不符（来源会话/角色绑定/组织映射/目标根已变化），请重新 migration-preview --plan");
  }

  if (validation.resolved.action === "claim_source") {
    const resolvedRoot = validation.resolved.root!;
    return store.withTx(() => {
      // 事务内重新核查完整安全认领条件（含最后一次同步目录身份核查）
      const again = computeSafeClaim(scanSourceProject(deps, input.projectId, PREVIEW_MAX_LIMIT));
      if (!again.eligible || again.root === null || !sameDirIdentity(again.root, resolvedRoot)) {
        fail("revision_conflict", `安全认领条件在应用时已不成立：${again.reasons.join("；") || "认领目标已变化"}，请重新预览`);
      }
      store.attachProjectRoot(scan.project.id, again.root);
      const result: MigrationApplyResult = {
        ok: true,
        replayed: false,
        action: "claim_source",
        source_project_id: scan.project.id,
        claimed_root: again.root,
        created_workspaces: [],
        mappings: [],
        receipt_request_id: input.requestId,
      };
      writeReceipt(store, input.requestId, {
        requestDigest: digest,
        action: "claim_source",
        sourceProjectId: scan.project.id,
        claim: { projectId: scan.project.id, rootReal: again.root.cwdReal },
        mappings: [],
        createdWorkspaces: [],
        revertedRequestId: null,
        result,
      });
      return result;
    });
  }

  const resolved = validation.resolved;
  return store.withTx(() => {
    const targetProjects = new Map<string, Project>();
    const created: MigrationApplyResult["created_workspaces"] = [];
    for (const target of resolved.targets) {
      if (target.kind === "existing_workspace") {
        const project = store.getProject(target.projectId)!;
        const check = checkRegisteredDir(project.rootDir!);
        if (check.status !== "valid") {
          fail("revision_conflict", `目标工作区根目录在应用时已失效或被替换：${project.rootDir!.cwdReal}（${check.reason}），请恢复后重新预览`);
        }
        targetProjects.set(target.key, project);
        continue;
      }
      // new_workspace：事务内最后一次同步目录身份与保护根核查
      const check = checkRegisteredDir(target.identity);
      if (check.status !== "valid") {
        fail("revision_conflict", `新工作区根目录在应用时已失效或被替换：${target.identity.cwdReal}（${check.reason}），请恢复后重新预览`);
      }
      try {
        assertGrantNotProtected(target.identity.cwdReal, deps.protectedRoots);
      } catch (err) {
        fail("invalid_params", `工作区不可用：${(err as Error).message}`);
      }
      // 同一真实目录已有工作区时复用其 ID（相同映射的新请求返回已有归属，不重复创建）
      const existing = store.findProjectByRoot(target.identity);
      if (existing) {
        targetProjects.set(target.key, existing);
        continue;
      }
      const base = path.basename(target.identity.cwdReal) || "workspace";
      for (let n = 1; ; n++) {
        const name = n === 1 ? base : `${base} (${n})`;
        if (!store.findProjectByName(name)) {
          const project = store.createProject(name, undefined, target.identity);
          targetProjects.set(target.key, project);
          created.push({ project_id: project.id, name, root_real: target.identity.cwdReal });
          break;
        }
      }
    }
    const mappings: MigrationReceipt["mappings"] = [];
    for (const { sessionId, target } of resolved.assignments) {
      const before = store.getSession(sessionId)!.workspaceProjectId;
      const to = targetProjects.get(target.key)!.id;
      store.mapSessionToWorkspace(sessionId, to);
      mappings.push({ sessionId, from: before, to });
    }
    const result: MigrationApplyResult = {
      ok: true,
      replayed: false,
      action: "map_sessions",
      source_project_id: scan.project.id,
      claimed_root: null,
      created_workspaces: created,
      mappings: mappings.map((m) => ({ session_id: m.sessionId, from: m.from, to: m.to })),
      receipt_request_id: input.requestId,
    };
    writeReceipt(store, input.requestId, {
      requestDigest: digest,
      action: "map_sessions",
      sourceProjectId: scan.project.id,
      claim: null,
      mappings,
      createdWorkspaces: created,
      revertedRequestId: null,
      result,
    });
    return result;
  });
}

function writeReceipt(store: Store, requestId: string, receipt: Omit<MigrationReceipt, "version" | "createdAt">): void {
  store.setMetaValue(
    RECEIPT_PREFIX + requestId,
    JSON.stringify({ version: 1, ...receipt, createdAt: new Date().toISOString() } satisfies MigrationReceipt),
  );
}

/**
 * 回退（revert，步骤 3）：只恢复显式会话组织映射，并按回执校验当前值——
 * 自应用后被其他操作改过的会话拒绝回退，由拥有者重新决定。已成功认领的根
 * 目录身份保留（claim_source 不可回退）；新建的工作区与迁移后产生的执行事实
 * 保留，不删除项目、不覆盖新任务或已发生的撤销。
 */
function applyRevert(deps: MigrationDeps, input: MigrationApplyInput, plan: MigrationPlanInput, digest: string): MigrationApplyResult {
  const store = deps.store;
  const originalId = plan.revert_request_id;
  if (!originalId) fail("invalid_params", "revert 需要 revert_request_id（原成功应用的 request_id）");
  const original = readReceipt(store, originalId);
  if (!original) fail("not_found", `原迁移回执不存在：${originalId}`);
  if (original.action === "claim_source") {
    fail("invalid_params", "已认领的根目录身份保留，claim_source 不可回退（回退仅恢复显式会话组织映射）");
  }
  if (original.action === "revert") fail("invalid_params", "不能回退一次回退");
  if (original.sourceProjectId !== input.projectId) {
    fail("invalid_params", `回执属于其他源项目：${original.sourceProjectId}`);
  }
  for (const m of original.mappings) {
    const session = store.getSession(m.sessionId);
    if (!session) fail("revision_conflict", `会话不存在：${m.sessionId}，恢复原映射前请人工核实`);
    if (session.workspaceProjectId !== m.to) {
      fail(
        "revision_conflict",
        `会话 ${m.sessionId} 的组织归属自应用后已被修改（当前 ${session.workspaceProjectId ?? "未映射"}，回退要求 ${m.to ?? "未映射"}）；请先核实再回退`,
      );
    }
  }
  return store.withTx(() => {
    const restored = original.mappings.map((m) => {
      store.mapSessionToWorkspace(m.sessionId, m.from);
      return { sessionId: m.sessionId, from: m.to, to: m.from };
    });
    const result: MigrationApplyResult = {
      ok: true,
      replayed: false,
      action: "revert",
      source_project_id: input.projectId,
      claimed_root: null,
      created_workspaces: [],
      mappings: restored.map((m) => ({ session_id: m.sessionId, from: m.from, to: m.to })),
      reverted_request_id: originalId,
      receipt_request_id: input.requestId,
    };
    writeReceipt(store, input.requestId, {
      requestDigest: digest,
      action: "revert",
      sourceProjectId: input.projectId,
      claim: null,
      mappings: restored,
      createdWorkspaces: [],
      revertedRequestId: originalId,
      result,
    });
    return result;
  });
}
