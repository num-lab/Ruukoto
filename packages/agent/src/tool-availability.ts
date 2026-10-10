/**
 * 工具可用性（架构工单 03）：这个会话、这个任务允许哪些工具，被拒的原因是什么。
 *
 * - 会话类别 → 工具类别：一张静态表，唯一来源。新工具族默认对所有会话不可见，
 *   写进哪份清单才出现；「仅 main」即只有 main 的清单含这些类别；
 * - 本任务允许的工具 = 已装配的工具减去任务收窄（计划模式、宿主按任务收窄）与
 *   关闭的 Web Search。装配、激活、发送前与调用门都用同一结论；
 * - 执行画像（架构工单 08）：按会话身份与任务算出的工具集、MCP 规划、资料范围、
 *   计划资格与系统提示键，任务开始算一次；
 * - 不管分派（怎么执行）与获批后的复核。
 */

import type { ToolCategory } from "@ruukoto/core/types.ts";
import type { SessionIdentity } from "@ruukoto/core/session-identity.ts";
import type { McpToolEffect } from "./mcp/store.ts";
import { PLAN_TOOL_NAMES } from "./plan-mode.ts";
import { WEB_SEARCH_TOOL_NAMES } from "./web-search.ts";

/**
 * 会话类别即会话身份（core/session-identity）：已退役归档不运行任务、不归任何类别。
 */
export type SessionToolClass = Exclude<SessionIdentity["kind"], "retired">;

const SESSION_TOOL_CATEGORIES: Record<SessionToolClass, readonly ToolCategory[]> = {
  dev: ["coding", "host_data", "web_search", "mcp", "skills", "subagent"],
  // main：日常对话/信息整理/编排，不持有编码工具；service 仅装配另要求
  // 产品 ruukoto + Linux + 显式部署配置（agent-direction issue 09）
  main: ["host_data", "web_search", "app_data", "scheduler", "delegation", "chat_results", "service", "skills", "subagent"],
  // subagent（agent-direction issue 11）：工具按执行画像的 SubAgent 工具集单独装配
  // （不走注册来源类别），子身份不能再委派下级；宿主评审任务（issue 19）的只读
  // MCP 由画像按任务另开，不在本静态清单
  subagent: [],
};

/**
 * SubAgent 任务的静态只读工具白名单（装配、发送前与调用门同一结论；伪造调用
 * 与未知工具默认拒绝）。宿主评审任务（issue 19）在此之外另开 effect=read
 * 的 MCP（收窄规则见 Driver 的任务工具集）。
 */
export const SUBAGENT_READONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "read_artifact"]);

/**
 * SubAgent 任务的写入工具白名单（agent-direction issue 16，工作有写入目标
 * 时的完整集合）：read/edit/write/bash/read_artifact。无 request_file_access、
 * http_request、MCP 或委派工件——工作区写入由容器边界约束，不逐次审批。
 */
export const SUBAGENT_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "edit", "write", "bash", "read_artifact"]);

/** SubAgent 本任务的工具集：写入目标决定只读或写入集合；宿主评审另开只读 MCP、关 subagent_message。 */
export interface SubAgentToolSet {
  write: boolean;
  review: boolean;
}

/** SubAgent 工具集是否含该工具（装配过滤与任务收窄同一结论）。 */
export function subAgentAllows(set: SubAgentToolSet, name: string, effect?: McpToolEffect): boolean {
  // 工作内协作消息（issue 13）；宿主评审任务（issue 19 固定单 Agent 流程）不开放
  if (name === "subagent_message") return !set.review;
  // 写入目标在哪，工具集就在哪：修改工作为写入集合，只读工作为只读分析集合
  return (set.write ? SUBAGENT_WRITE_TOOL_NAMES : SUBAGENT_READONLY_TOOL_NAMES).has(name) || (set.review && effect === "read");
}

/**
 * 执行画像（架构工单 08）：由会话身份、任务所属工作与是否宿主评审算出，任务开始
 * 算一次、钉到任务结束。装配、MCP 规划、资料范围、计划模式与系统提示都只读它。
 */
export interface ExecutionProfile {
  /** 会话类别：工具类别表与系统提示键。 */
  toolClass: SessionToolClass;
  /** SubAgent 本任务工具集；非 SubAgent 为 null（按类别表与宿主按任务收窄）。 */
  subAgentTools: SubAgentToolSet | null;
  /** 规划 MCP：类别含 mcp，或 SubAgent 宿主评审任务。 */
  planMcp: boolean;
  /**
   * 资料受限（SubAgent）：上下文组装 restricted、技能不钉、/skill 不展开、产物只读
   * 本任务自产且排除 prompt 快照、发送前复核资料来源。
   */
  restricted: boolean;
  /** 以计划模式运行（只普通开发会话）。 */
  plan: boolean;
  /** 工具集签名：并入 SDK 会话签名，变化即重建会话（装配过滤只能收窄、不能补回）。 */
  toolSignature: string;
}

export function executionProfile(input: {
  identity: SessionIdentity;
  /** 任务所属工作有写入目标。 */
  writeTarget: boolean;
  /** 宿主评审任务（issue 19）。 */
  review: boolean;
  /** 提交时固定到任务的 Plan 选择。 */
  planMode: boolean;
}): ExecutionProfile {
  const { identity } = input;
  if (identity.kind === "retired") throw new Error(`已退役的只读归档不运行任务（${identity.reason}）`);
  const sub = identity.kind === "subagent" ? { write: input.writeTarget, review: input.review } : null;
  return {
    toolClass: identity.kind,
    subAgentTools: sub,
    planMcp: allowsCategory(identity.kind, "mcp") || Boolean(sub?.review),
    restricted: sub !== null,
    plan: identity.kind === "dev" && input.planMode,
    toolSignature: sub ? `subagent:${sub.write ? "write" : "read"}${sub.review ? "+review" : ""}` : identity.kind,
  };
}

export function allowsCategory(cls: SessionToolClass, category: ToolCategory): boolean {
  return SESSION_TOOL_CATEGORIES[cls].includes(category);
}

/** 会话类别的工具类别清单（新建角色记录时写入；运行时不读回，以本表为准）。 */
export function sessionToolCategories(cls: SessionToolClass): ToolCategory[] {
  return [...SESSION_TOOL_CATEGORIES[cls]];
}

export interface TaskToolSet {
  allowed: ReadonlySet<string>;
  /** 不在 allowed 中的工具的拒绝原因。 */
  reasonFor(name: string): string;
}

/** 本任务允许的工具（任务开始时算一次）：已装配的工具减去任务收窄与关闭的 Web Search。 */
export function taskToolSet(input: {
  /** 装配结果（含本任务 MCP 工具）。 */
  registered: readonly string[];
  /** 计划模式（issue 26）：只留 PLAN_TOOL_NAMES 与只读 MCP，今后新增的工具默认不可用。 */
  plan: boolean;
  webSearchEnabled: boolean;
  mcpEffect: (name: string) => McpToolEffect | undefined;
  /** 宿主按任务收窄（GitHub 评审等；已绑定任务）。 */
  narrow?: (name: string, mcpEffect?: McpToolEffect) => boolean;
}): TaskToolSet {
  const rejected = new Map<string, string>();
  const allowed = new Set<string>();
  for (const name of input.registered) {
    const effect = input.mcpEffect(name);
    const reason =
      input.plan && !PLAN_TOOL_NAMES.has(name) && effect !== "read" ? "计划模式不开放"
      : input.narrow && !input.narrow(name, effect) ? "本任务由宿主收窄"
      : !input.webSearchEnabled && (WEB_SEARCH_TOOL_NAMES as readonly string[]).includes(name) ? "项目已关闭 Web Search"
      : null;
    if (reason) rejected.set(name, reason);
    else allowed.add(name);
  }
  return { allowed, reasonFor: (name) => rejected.get(name) ?? (allowed.has(name) ? "" : "本会话不开放") };
}
