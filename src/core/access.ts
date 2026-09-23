/**
 * 资料访问范围判定（issue 05 §1）。
 *
 * - Agent 身份（项目/会话/任务）由宿主注入，不能从工具参数取得权限；
 * - 默认范围：当前项目的历史、产物与生效记忆；个人共享记忆对全部项目可读；
 * - 跨项目读取只来自拥有者在可信入口创建的 data_grants 授权；模型工具、
 *   grantedPaths 与完全访问模式都不隐含扩大资料 API 范围；
 * - 撤销从后续查询与上下文注入起生效；不承诺撤回已发送给模型的内容；
 * - QQ 群聊入口（issue 07）与资料受限角色（issue 01 的 chat）使用受限身份：
 *   仅限本项目，不查 data_grants（拥有者误配置授权也不生效），owner_note
 *   来源不自动可读；个人共享记忆由调用方（上下文注入/记忆工具）按身份排除。
 */

import type { Db } from "./db.ts";
import {
  DATA_CATEGORIES,
  randomId,
  type DataCategory,
  type DataGrant,
  type MemorySourceRef,
} from "./types.ts";

export class AccessDeniedError extends Error {
  readonly code = "access_denied";
  constructor(message: string) {
    super(message);
  }
}

/**
 * 资料读取方的身份（宿主注入；owner = 已认证控制面连接）。
 * qq_group：QQ 群聊入口的受宿主约束资料身份（issue 07 §3）——只读本项目，
 * 不适用跨项目授权与 owner_note 默认放行。
 * role_restricted：资料范围受约束的逻辑角色（issue 01，如 chat）——约束口径
 * 与 qq_group 相同。
 */
export type Accessor =
  | { kind: "owner" }
  | { kind: "agent"; projectId: string }
  | { kind: "qq_group"; projectId: string }
  | { kind: "role_restricted"; projectId: string };

export class AccessScope {
  constructor(private readonly db: Db) {}

  // ---------- 授权管理（拥有者入口；调用方负责鉴权） ----------

  createGrant(input: {
    fromProjectId: string;
    toProjectId: string;
    category: DataCategory;
    purpose?: string;
  }): DataGrant {
    if (input.fromProjectId === input.toProjectId) {
      throw new AccessDeniedError("同项目不需要跨项目授权（默认可读）");
    }
    if (!DATA_CATEGORIES.includes(input.category)) {
      throw new AccessDeniedError(`资料类别无效：${input.category}`);
    }
    for (const id of [input.fromProjectId, input.toProjectId]) {
      const row = this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id);
      if (!row) throw new AccessDeniedError(`项目不存在：${id}`);
    }
    const grant: DataGrant = {
      id: randomId("grant"),
      fromProjectId: input.fromProjectId,
      toProjectId: input.toProjectId,
      category: input.category,
      purpose: input.purpose ?? "",
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO data_grants (id, from_project_id, to_project_id, category, purpose, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(grant.id, grant.fromProjectId, grant.toProjectId, grant.category, grant.purpose, grant.createdAt);
    return grant;
  }

  /** 撤销授权（条件更新；重复撤销返回 false）。 */
  revokeGrant(grantId: string): DataGrant | null {
    const info = this.db
      .prepare("UPDATE data_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), grantId);
    if (Number(info.changes) !== 1) return null;
    return this.getGrant(grantId);
  }

  getGrant(grantId: string): DataGrant | null {
    const row = this.db.prepare("SELECT * FROM data_grants WHERE id = ?").get(grantId) as any;
    return row ? rowToGrant(row) : null;
  }

  listGrants(opts: { includeRevoked?: boolean } = {}): DataGrant[] {
    const rows = (
      opts.includeRevoked
        ? this.db.prepare("SELECT * FROM data_grants ORDER BY created_at, id").all()
        : this.db.prepare("SELECT * FROM data_grants WHERE revoked_at IS NULL ORDER BY created_at, id").all()
    ) as any[];
    return rows.map(rowToGrant);
  }

  // ---------- 范围判定 ----------

  /**
   * 判定 accessor 是否可读取 projectId 项目的 category 资料。
   * owner 始终可读（控制面可信入口）；agent 可读本项目或有效授权覆盖的项目；
   * 受限身份（qq_group / role_restricted）只读本项目，不查授权表（授权不能
   * 扩大到群聊入口与受限角色）。
   */
  canAccess(accessor: Accessor, projectId: string, category: DataCategory): boolean {
    if (accessor.kind === "owner") return true;
    if (accessor.projectId === projectId) return true;
    if (accessor.kind !== "agent") return false;
    const row = this.db
      .prepare(
        `SELECT 1 FROM data_grants
         WHERE from_project_id = ? AND to_project_id = ? AND category = ? AND revoked_at IS NULL LIMIT 1`,
      )
      .get(projectId, accessor.projectId, category);
    return row !== undefined;
  }

  /** 判定失败即抛 AccessDeniedError（工具与查询入口的统一拒绝点）。 */
  assertAccess(accessor: Accessor, projectId: string, category: DataCategory, what: string): void {
    if (!this.canAccess(accessor, projectId, category)) {
      throw new AccessDeniedError(`无权读取该${what}（项目 ${projectId} 的 ${category} 资料未向当前范围开放）`);
    }
  }

  /** agent 可读取的项目集合（本项目 + 有效授权的来源项目）；受限身份仅本项目。 */
  accessibleProjects(accessor: Accessor, category: DataCategory): string[] {
    if (accessor.kind === "owner") {
      const rows = this.db.prepare("SELECT id FROM projects").all() as any[];
      return rows.map((r) => r.id as string);
    }
    if (accessor.kind !== "agent") return [accessor.projectId];
    const rows = this.db
      .prepare(
        `SELECT from_project_id FROM data_grants
         WHERE to_project_id = ? AND category = ? AND revoked_at IS NULL`,
      )
      .all(accessor.projectId, category) as any[];
    return [accessor.projectId, ...rows.map((r) => r.from_project_id as string)];
  }

  /**
   * 记忆来源引用的当前可访问性（§5：引用受限来源的派生记忆，后续读取与
   * 注入时仍检查来源范围；撤销授权后不再可读/注入）。owner_note 是拥有者
   * 可信操作的记录，不依赖资料范围。
   */
  sourceRefAccessible(accessor: Accessor, ref: MemorySourceRef): boolean {
    if (accessor.kind === "owner") return true;
    // owner_note 是拥有者可信操作的记录，对开发 agent 不依赖资料范围；
    // 受限身份（qq_group / role_restricted）不享受该默认放行
    // （群聊与受限角色上下文不得自动带入拥有者笔记）
    if (ref.kind === "owner_note") return accessor.kind === "agent";
    if (ref.kind === "history_entry") {
      const row = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(ref.sessionId) as any;
      if (!row) return false;
      return this.canAccess(accessor, row.project_id as string, "history");
    }
    const artifact = this.db.prepare("SELECT session_id FROM artifacts WHERE id = ?").get(ref.artifactId) as any;
    if (!artifact) return false;
    const session = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(artifact.session_id) as any;
    if (!session) return false;
    return this.canAccess(accessor, session.project_id as string, "artifact");
  }
}

function rowToGrant(row: any): DataGrant {
  return {
    id: row.id,
    fromProjectId: row.from_project_id,
    toProjectId: row.to_project_id,
    category: row.category as DataCategory,
    purpose: row.purpose,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}
