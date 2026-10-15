/** 子代理的来源工具与权限收窄；角色配置不能提供额外授权。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-15-subagent-source-capabilities.md
 */
import type { AccessMode, ToolCategory } from "@ruukoto/core/types.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";
import type { SubAgentDefinitionSnapshot } from "@ruukoto/core/subagent-definition.ts";
import { SubAgentExecutionError } from "@ruukoto/core/subagent-execution.ts";
import type { WorkflowExecutionProfile } from "./tool-availability.ts";

export function subAgentAccessPolicy(sourceMode: AccessMode, definition: SubAgentDefinitionSnapshot, verify = false): { accessMode: AccessMode; protectSource: boolean } {
  const requested = definition.permissions.mode;
  const accessMode = requested === "inherit" ? sourceMode : requested;
  if ((accessMode === "full_access" && sourceMode !== "full_access") || (accessMode === "auto-review" && sourceMode === "confirm")) {
    throw new SubAgentExecutionError("permission_increase", "角色请求的访问模式超出来源授权；选择继承或更受限的角色后再派发。");
  }
  const result = { accessMode: verify ? "confirm" as const : accessMode, protectSource: verify || definition.permissions.protectSource };
  if (result.protectSource && result.accessMode === "full_access") throw new SubAgentExecutionError("source_protection_conflict", "来源保护需要受限执行；将角色访问模式改为 confirm 或 auto-review 后再派发。");
  return result;
}

export function subAgentSourceProfile(source: WorkflowSource, options: { tools?: string[]; verify?: boolean; workflow?: boolean } = {}): WorkflowExecutionProfile {
  const authority = source.authority;
  if (!authority?.toolClass) throw new SubAgentExecutionError("authority_missing");
  const categories = authority.categories.filter(category => !["subagent", "delegation", "workflow", "browser"].includes(category));
  if (authority.categories.includes("subagent") && !categories.includes("coding")) categories.push("coding");
  return { toolClass: authority.toolClass, sourceProjectId: source.projectId, categories: options.verify ? ["coding"] as ToolCategory[] : categories,
    grantIds: authority.grantIds, tools: options.tools, verifyTarget: true, hostVerify: options.verify,
    collaboration: !options.workflow && !options.verify && authority.categories.includes("subagent") };
}
