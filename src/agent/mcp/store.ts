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

/**
 * 本地副作用类别（issue 18；远端 readOnly 等注解不可信，不作权限依据）：
 * - read：拥有者声明的只读工具，各模式直接执行（issue 16 行为）；
 * - write：拥有者声明的有副作用工具，confirm/auto-review 逐次审批；
 * - unknown：副作用不明，默认与 write 同样逐次审批。
 */
export type McpToolEffect = "read" | "write" | "unknown";

/** 允许列表条目：字符串 = 拥有者声明的只读工具（issue 16 兼容）；对象显式给出类别。 */
export type McpAllowlistEntry = string | { name: string; effect: McpToolEffect };

export const MCP_TOOL_EFFECTS: readonly McpToolEffect[] = ["read", "write", "unknown"];

/** 归一化条目 → 远端工具名 + 副作用类别（字符串条目为 read）。 */
export function normalizeAllowlistEntry(entry: McpAllowlistEntry): { name: string; effect: McpToolEffect } {
  return typeof entry === "string" ? { name: entry, effect: "read" } : entry;
}

/** 工具在允许列表中的副作用类别；不在列表返回 null（未允许，直接拒绝）。 */
export function allowlistEffectFor(list: McpAllowlistEntry[], remoteName: string): McpToolEffect | null {
  for (const entry of list) {
    const normalized = normalizeAllowlistEntry(entry);
    if (normalized.name === remoteName) return normalized.effect;
  }
  return null;
}

/**
 * 拥有者输入的允许列表 → 规范条目：字符串/对象两种形态，名称去重（同名的
 * 副作用类别冲突 = 拥有者意图不明，拒绝）；条目形态保留（字符串仍是字符串）。
 */
export function normalizeToolAllowlist(input: unknown[]): { entries: McpAllowlistEntry[] } | { error: string } {
  const byName = new Map<string, McpAllowlistEntry>();
  for (const raw of input) {
    let entry: McpAllowlistEntry;
    if (typeof raw === "string") {
      entry = raw.trim();
    } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (typeof obj["name"] !== "string" || !obj["name"].trim()) {
        return { error: "tool_allowlist 对象条目必须含非空 name" };
      }
      if (typeof obj["effect"] !== "string" || !(MCP_TOOL_EFFECTS as readonly string[]).includes(obj["effect"])) {
        return { error: `tool_allowlist 条目 effect 必须是 ${MCP_TOOL_EFFECTS.join(" | ")}` };
      }
      entry = { name: obj["name"].trim(), effect: obj["effect"] as McpToolEffect };
    } else {
      return { error: "tool_allowlist 条目必须是工具名字符串或 { name, effect } 对象" };
    }
    const name = normalizeAllowlistEntry(entry).name;
    if (!name || name.length > 128) return { error: `tool_allowlist 工具名须为 1–128 字符：${name || "（空）"}` };
    const existing = byName.get(name);
    if (existing) {
      if (normalizeAllowlistEntry(existing).effect !== normalizeAllowlistEntry(entry).effect) {
        return { error: `工具 ${name} 的副作用类别冲突（同一工具只能声明一种类别）` };
      }
      continue;
    }
    byName.set(name, entry);
  }
  const entries = [...byName.values()];
  if (entries.length > 128) return { error: "tool_allowlist 最多 128 项" };
  return { entries };
}

export interface McpServiceConfig {
  id: string;
  projectId: string;
  /** 拥有者命名的服务标识（项目内唯一，小写 slug；用于工具名命名空间）。 */
  name: string;
  /** Streamable HTTP 端点（生产 https；http 仅限回环模拟服务）。 */
  endpoint: string;
  /** 凭据绑定名（CredentialStore；值不进入本表；null = 无认证）。 */
  credential: string | null;
  /** 允许暴露的远端工具及本地副作用类别（精确匹配；未允许的工具不注册）。 */
  toolAllowlist: McpAllowlistEntry[];
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
    toolAllowlist: McpAllowlistEntry[];
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

  /** 撤销服务（删除行；进行中的调用在下一次版本核对时失败）。携带期望版本且不符时抛冲突。 */
  removeService(id: string, expectedVersion?: number): boolean {
    const existing = this.getService(id);
    if (!existing) return false;
    if (expectedVersion !== undefined && expectedVersion !== existing.configVersion) {
      throw new McpVersionConflictError(expectedVersion, existing.configVersion);
    }
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
    toolAllowlist: JSON.parse(row.tool_allowlist) as McpAllowlistEntry[],
    enabled: Number(row.enabled) === 1,
    configVersion: Number(row.config_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
