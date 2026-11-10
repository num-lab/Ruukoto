/**
 * Host-bound data access uses workspace identity and explicit owner grants.
 * File grants and full access never broaden data API access. Revocation applies
 * to subsequent queries and context assembly, not content already delivered.
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

export type Accessor =
  | { kind: "owner" }
  | { kind: "agent"; projectId: string; grantIds?: readonly string[] };

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

  /** The authenticated owner can read all data; agents need local ownership or an active grant. */
  canAccess(accessor: Accessor, projectId: string, category: DataCategory): boolean {
    if (accessor.kind === "owner") return true;
    if (accessor.projectId === projectId) return true;
    const rows = this.db
      .prepare(
        `SELECT id FROM data_grants
         WHERE from_project_id = ? AND to_project_id = ? AND category = ? AND revoked_at IS NULL`,
      )
      .all(projectId, accessor.projectId, category) as { id: string }[];
    return rows.some(row => accessor.grantIds === undefined || accessor.grantIds.includes(row.id));
  }

  /** 判定失败即抛 AccessDeniedError（工具与查询入口的统一拒绝点）。 */
  assertAccess(accessor: Accessor, projectId: string, category: DataCategory, what: string): void {
    if (!this.canAccess(accessor, projectId, category)) {
      throw new AccessDeniedError(`无权读取该${what}（项目 ${projectId} 的 ${category} 资料未向当前范围开放）`);
    }
  }

  /** The current workspace and explicitly granted source workspaces. */
  accessibleProjects(accessor: Accessor, category: DataCategory): string[] {
    if (accessor.kind === "owner") {
      const rows = this.db.prepare("SELECT id FROM projects").all() as any[];
      return rows.map((r) => r.id as string);
    }
    const rows = this.db
      .prepare(
        `SELECT from_project_id FROM data_grants
         WHERE to_project_id = ? AND category = ? AND revoked_at IS NULL`,
      )
      .all(accessor.projectId, category) as any[];
    return [accessor.projectId, ...rows.map((r) => r.from_project_id as string)]
      .filter((projectId) => this.canAccess(accessor, projectId, category));
  }

  /** 侧聊会话（宿主绑定判定）：侧聊历史与产物只对拥有者侧聊入口开放。 */
  isSideSession(sessionId: string): boolean {
    return this.db.prepare("SELECT 1 FROM side_chats WHERE side_session_id = ?").get(sessionId) !== undefined;
  }

  /**
   * 记忆来源引用的当前可访问性（§5：引用受限来源的派生记忆，后续读取与
   * 注入时仍检查来源范围；撤销授权后不再可读/注入）。owner_note 是拥有者
   * 可信操作的记录，不依赖资料范围。侧聊会话的历史与产物不属于普通
   * 会话资料，agent 一律不可读（含本项目内读取与跨项目授权）。
   */
  sourceRefAccessible(accessor: Accessor, ref: MemorySourceRef): boolean {
    if (accessor.kind === "owner") return true;
    if (ref.kind === "owner_note") return true;
    if (ref.kind === "history_entry") {
      const row = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(ref.sessionId) as any;
      if (!row || this.isSideSession(ref.sessionId)) return false;
      return this.canAccess(accessor, row.project_id as string, "history");
    }
    const artifact = this.db.prepare("SELECT session_id FROM artifacts WHERE id = ?").get(ref.artifactId) as any;
    if (!artifact) return false;
    const session = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(artifact.session_id) as any;
    if (!session || this.isSideSession(artifact.session_id as string)) return false;
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
