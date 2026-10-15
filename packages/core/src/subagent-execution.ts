/** 子代理每次执行的来源与有效能力；配置文件不作为执行授权。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-15-subagent-source-capabilities.md
 */
import { canonicalJson, sha256 } from "./import-files.ts";
import type { AccessMode, SubAgentReadScope } from "./types.ts";
import type { WorkflowSource } from "./workflow.ts";

export interface SubAgentExecutionSnapshot {
  source: WorkflowSource;
  roleDigest: string;
  accessMode: AccessMode;
  protectSource: boolean;
  tools: string[];
  mcpSignature: string;
  digest: string;
}

export interface SubAgentExecutionScope extends SubAgentReadScope {
  execution: SubAgentExecutionSnapshot;
  readMemories: string[];
}

export function requireSubAgentExecutionScope(value: unknown): SubAgentExecutionScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SubAgentExecutionError("execution_corrupt");
  const scope = value as SubAgentExecutionScope;
  requireSubAgentExecution(scope.execution);
  if (!Array.isArray(scope.paths) || !Array.isArray(scope.sourceRefs) || !Array.isArray(scope.readMemories) ||
      scope.readMemories.some(id => typeof id !== "string" || !id) || new Set(scope.readMemories).size !== scope.readMemories.length) throw new SubAgentExecutionError("execution_corrupt");
  return scope;
}

export class SubAgentExecutionError extends Error {
  constructor(readonly code: string, message = "子代理来源能力记录缺失、损坏或失效；保留已有结果并报告拥有者", options?: ErrorOptions) {
    super(message, options);
  }
}

export function snapshotSubAgentExecution(value: Omit<SubAgentExecutionSnapshot, "digest">): SubAgentExecutionSnapshot {
  const { source, roleDigest, accessMode, protectSource, tools, mcpSignature } = value;
  const content = { source, roleDigest, accessMode, protectSource, tools, mcpSignature };
  return { ...content, digest: sha256(canonicalJson(content)) };
}

export function requireSubAgentExecution(value: unknown): SubAgentExecutionSnapshot {
  if (!value) throw new SubAgentExecutionError("execution_missing");
  if (typeof value !== "object" || Array.isArray(value)) throw new SubAgentExecutionError("execution_corrupt");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 7 || typeof row.roleDigest !== "string" || !["confirm", "auto-review", "full_access"].includes(String(row.accessMode)) ||
      typeof row.protectSource !== "boolean" || !Array.isArray(row.tools) || row.tools.some(name => typeof name !== "string" || !name) ||
      new Set(row.tools).size !== row.tools.length || typeof row.mcpSignature !== "string" || typeof row.digest !== "string" ||
      !row.source || typeof row.source !== "object" || Array.isArray(row.source)) throw new SubAgentExecutionError("execution_corrupt");
  const record = value as SubAgentExecutionSnapshot;
  const { digest, ...content } = record;
  const source = record.source, authority = source.authority;
  if (digest !== sha256(canonicalJson(content)) || !["ruukoto", "ruukoto-code"].includes(source.product) ||
      ![source.projectId, source.sessionId, source.taskId].every(value => typeof value === "string" && value.length > 0) ||
      !Number.isSafeInteger(source.permissionVersion) || !["confirm", "auto-review", "full_access"].includes(source.accessMode) ||
      !Array.isArray(source.grantedPaths) || !Array.isArray(source.references) || !Array.isArray(source.capabilities) ||
      !authority || !["dev", "main"].includes(authority.toolClass ?? "") || typeof authority.configuration !== "string" ||
      !Array.isArray(authority.categories) || authority.categories.some(value => typeof value !== "string") ||
      !Array.isArray(authority.grantIds) || authority.grantIds.some(value => typeof value !== "string") ||
      !authority.workspace || typeof authority.workspace.path !== "string" || !Number.isSafeInteger(authority.workspace.dev) || !Number.isSafeInteger(authority.workspace.ino)) throw new SubAgentExecutionError("execution_corrupt");
  return record;
}
