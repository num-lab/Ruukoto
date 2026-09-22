/**
 * MCP 服务配置的持久化（issue 16 §2）：拥有者按项目管理的 MCP 服务。
 *
 * - 每项目一表多服务：服务 ID、名称、HTTPS 端点、凭据绑定名（秘密值仍在
 *   CredentialStore）、工具允许列表、启用状态与可比较配置版本；
 * - 任何配置变化递增 config_version：任务开始钉版工具清单，调用前重读核对，
 *   禁用/撤销/版本变化立即阻止后续请求；新增工具与扩大范围只在下一任务生效；
 * - 变更采用期望版本校验（拥有者入口乐观并发），不产生无事件的配置洞。
 */

import type { Db } from "../../core/db.ts";
import { randomId } from "../../core/types.ts";

export interface McpServiceConfig {
  id: string;
  projectId: string;
  /** 拥有者命名的服务标识（项目内唯一，小写 slug；用于工具名命名空间）。 */
  name: string;
  /** Streamable HTTP 端点（生产 https；http 仅限回环模拟服务）。 */
  endpoint: string;
  /** 凭据绑定名（CredentialStore；值不进入本表；null = 无认证）。 */
  credential: string | null;
  /** 允许暴露的远端工具名（精确匹配；首版仅只读工具）。 */
  toolAllowlist: string[];
  enabled: boolean;
  /** 可比较版本：任何字段变化递增；调用前核对。 */
  configVersion: number;
  createdAt: string;
  updatedAt: string;
}

export class McpVersionConflictError extends Error {
  readonly code = "version_conflict";
  constructor(expected: number, current: number) {
    super(`MCP 服务配置版本冲突：期望 v${expected}，当前 v${current}（请刷新后重试）`);
  }
}

export class McpStore {
  constructor(private readonly db: Db) {}

  upsertService(input: {
    projectId: string;
    name: string;
    endpoint: string;
    credential?: string | null;
    toolAllowlist: string[];
    enabled?: boolean;
    expectedVersion?: number;
  }): McpServiceConfig {
    const existing = this.getServiceByName(input.projectId, input.name);
    if (input.expectedVersion !== undefined) {
      const current = existing?.configVersion ?? 0;
      if (input.expectedVersion !== current) throw new McpVersionConflictError(input.expectedVersion, current);
    }
    const now = new Date().toISOString();
    if (existing) {
      const next: McpServiceConfig = {
        ...existing,
        endpoint: input.endpoint,
        credential: input.credential !== undefined ? input.credential : existing.credential,
        toolAllowlist: input.toolAllowlist,
        enabled: input.enabled ?? existing.enabled,
        configVersion: existing.configVersion + 1,
        updatedAt: now,
      };
      this.db
        .prepare("UPDATE mcp_services SET endpoint = ?, credential = ?, tool_allowlist = ?, enabled = ?, config_version = ?, updated_at = ? WHERE id = ?")
        .run(next.endpoint, next.credential, JSON.stringify(next.toolAllowlist), next.enabled ? 1 : 0, next.configVersion, now, existing.id);
      return next;
    }
    const service: McpServiceConfig = {
      id: randomId("mcps"),
      projectId: input.projectId,
      name: input.name,
      endpoint: input.endpoint,
      credential: input.credential ?? null,
      toolAllowlist: input.toolAllowlist,
      enabled: input.enabled ?? true,
      configVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO mcp_services (id, project_id, name, endpoint, credential, tool_allowlist, enabled, config_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        service.id,
        service.projectId,
        service.name,
        service.endpoint,
        service.credential,
        JSON.stringify(service.toolAllowlist),
        service.enabled ? 1 : 0,
        service.configVersion,
        service.createdAt,
        service.updatedAt,
      );
    return service;
  }

  getService(id: string): McpServiceConfig | null {
    const row = this.db.prepare("SELECT * FROM mcp_services WHERE id = ?").get(id) as any;
    return row ? rowToService(row) : null;
  }

  getServiceByName(projectId: string, name: string): McpServiceConfig | null {
    const row = this.db.prepare("SELECT * FROM mcp_services WHERE project_id = ? AND name = ?").get(projectId, name) as any;
    return row ? rowToService(row) : null;
  }

  listServices(projectId?: string): McpServiceConfig[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT * FROM mcp_services WHERE project_id = ? ORDER BY created_at, id").all(projectId)
        : this.db.prepare("SELECT * FROM mcp_services ORDER BY created_at, id").all()
    ) as any[];
    return rows.map(rowToService);
  }

  setEnabled(id: string, enabled: boolean, expectedVersion?: number): McpServiceConfig | null {
    const existing = this.getService(id);
    if (!existing) return null;
    if (expectedVersion !== undefined && expectedVersion !== existing.configVersion) {
      throw new McpVersionConflictError(expectedVersion, existing.configVersion);
    }
    if (existing.enabled === enabled) return existing;
    const next = { ...existing, enabled, configVersion: existing.configVersion + 1, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE mcp_services SET enabled = ?, config_version = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, next.configVersion, next.updatedAt, id);
    return next;
  }

  /** 撤销服务（删除行；进行中的调用在下一次版本核对时失败）。 */
  removeService(id: string): boolean {
    const info = this.db.prepare("DELETE FROM mcp_services WHERE id = ?").run(id);
    return Number(info.changes) === 1;
  }
}

function rowToService(row: any): McpServiceConfig {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    endpoint: row.endpoint,
    credential: row.credential,
    toolAllowlist: JSON.parse(row.tool_allowlist) as string[],
    enabled: Number(row.enabled) === 1,
    configVersion: Number(row.config_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
