/** 子代理定义的持久快照；执行不得用当前配置替代缺失或损坏的记录。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-14-subagent-role-snapshots.md
 */
import { canonicalJson, sha256 } from "./import-files.ts";

export interface SubAgentDefinitionSnapshot {
  kind: "role" | "host_review";
  name: string;
  raw: string;
  description: string;
  tools: string[] | null;
  permissions: { mode: "inherit" | "confirm" | "auto-review" | "full_access"; protectSource: boolean };
  body: string;
  digest: string;
}

export interface SubAgentRoleCatalogSnapshot {
  roles: SubAgentDefinitionSnapshot[];
  diagnostics: { name: string; code: string; message: string }[];
  digest: string;
}

export class SubAgentDefinitionError extends Error {
  constructor(readonly code: "definition_missing" | "definition_corrupt", options?: ErrorOptions) {
    super(`子代理定义快照${code === "definition_missing" ? "缺失" : "损坏"}：本次执行已拒绝，请保留记录并报告拥有者`, options);
  }
}

export function subAgentDefinitionDigest(definition: Omit<SubAgentDefinitionSnapshot, "digest">): string {
  return sha256(canonicalJson(definition));
}

/** JSON/wire 输入只接受完整字段与一致摘要；原文解析由角色加载器负责。 */
export function validateSubAgentDefinition(value: unknown): SubAgentDefinitionSnapshot {
  if (value === null || value === undefined) throw new SubAgentDefinitionError("definition_missing");
  if (typeof value !== "object" || Array.isArray(value)) throw new SubAgentDefinitionError("definition_corrupt");
  const row = value as Record<string, unknown>;
  const keys = ["kind", "name", "raw", "description", "tools", "permissions", "body", "digest"];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) ||
      (row.kind !== "role" && row.kind !== "host_review") || typeof row.name !== "string" || !row.name ||
      typeof row.raw !== "string" || typeof row.description !== "string" || typeof row.body !== "string" ||
      typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest) ||
      (row.tools !== null && (!Array.isArray(row.tools) || row.tools.some(tool => typeof tool !== "string" || !tool)))) {
    throw new SubAgentDefinitionError("definition_corrupt");
  }
  const permissions = row.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new SubAgentDefinitionError("definition_corrupt");
  const policy = permissions as Record<string, unknown>;
  if (Object.keys(policy).length !== 2 || !Object.hasOwn(policy, "mode") || !Object.hasOwn(policy, "protectSource") ||
      typeof policy.mode !== "string" || !["inherit", "confirm", "auto-review", "full_access"].includes(policy.mode) || typeof policy.protectSource !== "boolean") {
    throw new SubAgentDefinitionError("definition_corrupt");
  }
  const definition = value as SubAgentDefinitionSnapshot;
  const { digest, ...content } = definition;
  if (subAgentDefinitionDigest(content) !== digest) throw new SubAgentDefinitionError("definition_corrupt");
  return definition;
}

export function subAgentDefinitionFromJson(value: unknown): SubAgentDefinitionSnapshot {
  if (value === null || value === undefined) throw new SubAgentDefinitionError("definition_missing");
  if (typeof value !== "string") throw new SubAgentDefinitionError("definition_corrupt");
  let definition: unknown;
  try { definition = JSON.parse(value); }
  catch (cause) { throw new SubAgentDefinitionError("definition_corrupt", { cause }); }
  return validateSubAgentDefinition(definition);
}

/** 查询可保留坏记录的身份；执行调用方必须核实定义仍完整。 */
export function requireSubAgentDefinition(agent: { definition: SubAgentDefinitionSnapshot | null; definitionError?: string }): SubAgentDefinitionSnapshot {
  if (agent.definition === null) throw new SubAgentDefinitionError(agent.definitionError === "definition_corrupt" ? "definition_corrupt" : "definition_missing");
  return validateSubAgentDefinition(agent.definition);
}

export function validateSubAgentRoleCatalog(value: unknown): SubAgentRoleCatalogSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SubAgentDefinitionError("definition_corrupt");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || !Array.isArray(row.roles) || !Array.isArray(row.diagnostics) || typeof row.digest !== "string") throw new SubAgentDefinitionError("definition_corrupt");
  for (const role of row.roles) {
    if (validateSubAgentDefinition(role).kind !== "role") throw new SubAgentDefinitionError("definition_corrupt");
  }
  for (const diagnostic of row.diagnostics) {
    if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) throw new SubAgentDefinitionError("definition_corrupt");
    const entry = diagnostic as Record<string, unknown>;
    if (Object.keys(entry).length !== 3 || typeof entry.name !== "string" || typeof entry.code !== "string" || typeof entry.message !== "string") throw new SubAgentDefinitionError("definition_corrupt");
  }
  const catalog = value as SubAgentRoleCatalogSnapshot;
  if (sha256(canonicalJson({ roles: catalog.roles, diagnostics: catalog.diagnostics })) !== catalog.digest) throw new SubAgentDefinitionError("definition_corrupt");
  return catalog;
}
