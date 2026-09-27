/**
 * 工具可用性（架构工单 03）：这个会话、这个任务允许哪些工具，被拒的原因是什么。
 *
 * - 会话类别 → 工具类别：一张静态表，唯一来源。新工具族默认对所有会话不可见，
 *   写进哪份清单才出现；「仅 main」即只有 main 的清单含这些类别；
 * - 本任务允许的工具 = 已装配的工具减去任务收窄（计划模式、宿主按任务收窄）与
 *   关闭的 Web Search。装配、激活、发送前与调用门都用同一结论；
 * - 不管分派（怎么执行）、获批后的复核与资料范围。
 */

import type { AgentRoleId, SessionKind, ToolCategory } from "../core/types.ts";
import type { McpToolEffect } from "./mcp/store.ts";
import { PLAN_TOOL_NAMES } from "./plan-mode.ts";
import { WEB_SEARCH_TOOL_NAMES } from "./web-search.ts";

/** dev = 普通开发会话；chat = chat 角色与 QQ 群会话（ADR 0014 共用一份策略）。 */
export type SessionToolClass = "dev" | "main" | "coding" | "chat";

const SESSION_TOOL_CATEGORIES: Record<SessionToolClass, readonly ToolCategory[]> = {
  dev: ["coding", "host_data", "web_search", "mcp", "skills"],
  // main：日常对话/信息整理/编排，不持有编码工具
  main: ["host_data", "web_search", "app_data", "scheduler", "delegation", "chat_results", "skills"],
  // coding：仓库/测试/PR 分析
  coding: ["coding", "host_data", "web_search", "mcp", "skills"],
  // chat：群聊，空工具集合
  chat: [],
};

/** QQ 群按会话 kind 归入 chat（不依赖角色绑定）；角色会话按宿主绑定；其余为普通开发会话。 */
export function sessionToolClass(kind: SessionKind, roleId: AgentRoleId | null): SessionToolClass {
  if (kind === "qq_group") return "chat";
  return roleId ?? "dev";
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
