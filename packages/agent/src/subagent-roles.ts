/** 角色正文补充宿主指令，身份与授权仍由宿主持有。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-14-subagent-role-snapshots.md
 */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { canonicalJson } from "@ruukoto/core/import-files.ts";
import { validateSubAgentDefinition, type SubAgentDefinitionSnapshot, type SubAgentRoleCatalogSnapshot } from "@ruukoto/core/subagent-definition.ts";
import type { ReferenceBlock } from "./context-selector.ts";

export type SubAgentRoleLibrary = SubAgentRoleCatalogSnapshot;
export const SUBAGENT_ROLE_FILE_BYTES = 64 * 1024;
export const SUBAGENT_ROLE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class SubAgentRoleError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options); }
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new SubAgentRoleError("role_unknown_field", "角色含未知字段；仅使用 description、tools、permissions 与正文。");
}

export function parseSubAgentRole(name: string, raw: string, kind: SubAgentDefinitionSnapshot["kind"] = "role"): SubAgentDefinitionSnapshot {
  if (!SUBAGENT_ROLE_NAME.test(name)) throw new SubAgentRoleError("role_invalid_name", "角色文件名须为小写 kebab-case；修正文件名后重新创建子代理。");
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const closing = normalized.indexOf("\n---", 3);
  if (Buffer.byteLength(raw) > SUBAGENT_ROLE_FILE_BYTES || raw.includes("\0") || !/^---\n[\s\S]*?\n---(?:\n|$)/.test(normalized) || (normalized[closing + 4] !== undefined && normalized[closing + 4] !== "\n")) {
    throw new SubAgentRoleError("role_invalid_frontmatter", "角色须为不超过 64 KiB 的 UTF-8 Markdown，使用完整 YAML frontmatter。");
  }
  let parsed: ReturnType<typeof parseFrontmatter>;
  try { parsed = parseFrontmatter(raw); }
  catch (cause) { throw new SubAgentRoleError("role_invalid_frontmatter", "角色 YAML 无效；修正 frontmatter 后重新创建子代理。", { cause }); }
  const data = parsed.frontmatter;
  if (!object(data)) throw new SubAgentRoleError("role_invalid_frontmatter", "角色 frontmatter 须为字段映射。");
  fields(data, ["description", "tools", "permissions"]);
  if (typeof data.description !== "string" || !data.description.trim()) throw new SubAgentRoleError("role_invalid_description", "角色 description 须为非空文本。");
  if (!parsed.body.trim()) throw new SubAgentRoleError("role_invalid_body", "角色正文须说明子代理的职责。");
  let tools: string[] | null = null;
  if (data.tools !== undefined) {
    if (!Array.isArray(data.tools) || data.tools.some(tool => typeof tool !== "string" || !tool.trim() || tool !== tool.trim()) || new Set(data.tools).size !== data.tools.length) {
      throw new SubAgentRoleError("role_invalid_tools", "角色 tools 须为不重复的工具名称列表；省略时继承可委派工具。");
    }
    tools = [...data.tools];
  }
  const policy = data.permissions === undefined ? {} : data.permissions;
  if (!object(policy)) throw new SubAgentRoleError("role_invalid_permissions", "角色 permissions 须为 mode 与 protect_source 的映射。");
  fields(policy, ["mode", "protect_source"]);
  const mode = policy.mode === undefined ? "inherit" : policy.mode;
  if (mode !== "inherit" && mode !== "confirm" && mode !== "auto-review" && mode !== "full_access") throw new SubAgentRoleError("role_invalid_permissions", "角色 permissions.mode 须为 inherit、confirm、auto-review 或 full_access。");
  const protectSource = policy.protect_source === undefined ? false : policy.protect_source;
  if (typeof protectSource !== "boolean" || (protectSource && mode === "full_access")) throw new SubAgentRoleError("role_invalid_permissions", "来源保护须为布尔值，且不能与 full_access 同时使用。");
  const content: Omit<SubAgentDefinitionSnapshot, "digest"> = { kind, name, raw, description: data.description.trim(), tools, permissions: { mode, protectSource }, body: parsed.body.trim() };
  return { ...content, digest: createHash("sha256").update(canonicalJson(content)).digest("hex") };
}

export function validateSubAgentRole(value: unknown): SubAgentDefinitionSnapshot {
  const snapshot = validateSubAgentDefinition(value);
  if (!isDeepStrictEqual(snapshot, parseSubAgentRole(snapshot.name, snapshot.raw, snapshot.kind))) throw new SubAgentRoleError("definition_corrupt", "角色原文与持久字段不一致；核实记录后再继续。");
  return snapshot;
}

export function subAgentRoleLibrary(roles: SubAgentDefinitionSnapshot[], diagnostics: SubAgentRoleLibrary["diagnostics"]): SubAgentRoleLibrary {
  const content = { roles, diagnostics };
  return { ...content, digest: createHash("sha256").update(canonicalJson(content)).digest("hex") };
}

export function validateSubAgentRoleLibrary(value: SubAgentRoleLibrary): SubAgentRoleLibrary {
  if (!object(value) || !Array.isArray(value.roles) || !Array.isArray(value.diagnostics) || typeof value.digest !== "string") throw new SubAgentRoleError("role_catalog_corrupt", "角色目录记录缺失或损坏；核实记录后再继续。");
  for (const role of value.roles) {
    validateSubAgentRole(role);
    if (role.kind !== "role") throw new SubAgentRoleError("role_catalog_corrupt", "用户角色目录不能包含宿主固定用途。");
  }
  if (new Set(value.roles.map(role => role.name)).size !== value.roles.length || value.diagnostics.some(d => !object(d) || typeof d.name !== "string" || typeof d.code !== "string" || typeof d.message !== "string") || subAgentRoleLibrary(value.roles, value.diagnostics).digest !== value.digest) {
    throw new SubAgentRoleError("role_catalog_corrupt", "角色目录摘要或条目无效；核实记录后再继续。");
  }
  return value;
}

export const BUILTIN_SUBAGENT_ROLES = [
  parseSubAgentRole("general", "---\ndescription: 完成委派任务，按来源许可使用工具并报告结果。\n---\n完成主 Agent 明确委派的工作；按实际工具与资料范围执行，报告结果、依据及未完成项。"),
  parseSubAgentRole("reviewer", "---\ndescription: 审查给定代码并运行必要检查，报告发现与验证依据。\ntools: [read, list_files, search_files, bash, read_artifact]\npermissions:\n  mode: confirm\n  protect_source: true\n---\n在宿主提供的审查副本中检查代码并运行必要测试。报告发现、证据与未验证项；保留检查产物，由主 Agent 处理后续修改与交付。"),
];

export const HOST_REVIEW_DEFINITION = parseSubAgentRole("github-review", "---\ndescription: 宿主固定的 GitHub PR 只读评审。\ntools: [read, list_files, search_files, read_artifact]\n---\n只使用 read、list_files、search_files、read_artifact 与宿主开放的只读 MCP 读取本目录和 PR 资料。读不到资料时说明能力范围；最终回答作为评审草稿交回主 Agent。不能修改文件、执行命令、写外部服务、委派下级或发送工作内消息。", "host_review");

export function roleCatalogBlock(library: SubAgentRoleLibrary): ReferenceBlock {
  return { category: "subagentRoles", placement: "prefix", text: ["[子代理角色目录]", "首次委派用 role 选择职责，省略为 general；继续或复用沿已固定角色，需要其他角色时新建子代理。能力以宿主实际工具和授权为准。", ...library.roles.map(role => `- ${role.name}：${role.description}`), ...library.diagnostics.map(d => `- ${d.name} 不可用（${d.code}）：${d.message}`), "[/子代理角色目录]"].join("\n") };
}
