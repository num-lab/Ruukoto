/**
 * 工具可用性（架构工单 03）：这个会话、这个任务允许哪些工具，被拒的原因是什么。
 *
 * - Conversation identity selects one static category list; new families are unavailable until listed.
 * - 本任务允许的工具 = 已装配的工具减去任务收窄（计划模式、宿主按任务收窄）与
 *   关闭的 Web Search。装配、激活、发送前与调用门都用同一结论；
 * - 执行画像（架构工单 08）：按会话身份与任务算出的工具集、MCP 规划、资料范围、
 *   计划资格与系统提示键，任务开始算一次；
 * - 不管分派（怎么执行）与获批后的复核。
 */

import type { ToolCategory } from "@ruukoto/core/types.ts";
import type { SessionIdentity } from "@ruukoto/core/session-identity.ts";
import { WorkflowError } from "@ruukoto/core/workflow.ts";
import type { McpToolEffect } from "./mcp/store.ts";
import { PLAN_TOOL_NAMES } from "./plan-mode.ts";
import { WEB_SEARCH_TOOL_NAMES } from "./web-search.ts";

/** Host-bound conversation identity selects the tool category list. */
export type SessionToolClass = SessionIdentity["kind"];

const SESSION_TOOL_CATEGORIES: Record<SessionToolClass, readonly ToolCategory[]> = {
  dev: ["coding", "host_data", "web_search", "browser", "desktop_browser", "mcp", "skills", "subagent", "workflow", "owner_question", "background_process"],
  // SubAgents use their frozen execution profile and cannot delegate another level.
  subagent: [],
  // 侧聊（coding-side-chat）：纯文本、无工具；历史里的工具调用只是复制的正文
  side: [],
};

/** Default-deny read-only SubAgent tools, shared by assembly and execution checks. */
export const SUBAGENT_READONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "list_files", "search_files", "read_artifact"]);

/**
 * SubAgent 任务的写入工具白名单（agent-direction issue 16，工作有写入目标
 * 时的完整集合）：编码、文件检索与产物读取。无 request_file_access、
 * http_request、MCP 或委派工件——受限模式的工作区写入由原生边界约束，不逐次审批。
 */
export const SUBAGENT_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "list_files", "search_files", "edit", "write", "bash", "read_artifact"]);

/** The work's write target selects the SubAgent tool set. */
export interface SubAgentToolSet {
  write: boolean;
}

/** SubAgent 工具集是否含该工具（装配过滤与任务收窄同一结论）。 */
export function subAgentAllows(set: SubAgentToolSet, name: string): boolean {
  if (name === "subagent_message") return true;
  return (set.write ? SUBAGENT_WRITE_TOOL_NAMES : SUBAGENT_READONLY_TOOL_NAMES).has(name);
}

/** Identity and work authority are pinned for the task and shared by every tool gate. */
export interface ExecutionProfile {
  /** 会话类别：工具类别表与系统提示键。 */
  toolClass: SessionToolClass;
  /** SubAgent 本任务工具集；非 SubAgent 为 null（按类别表与宿主按任务收窄）。 */
  subAgentTools: SubAgentToolSet | null;
  /** Plan MCP only when the frozen category list includes it. */
  planMcp: boolean;
  /**
   * 资料受限（SubAgent）：不自动注入记忆、父聊天或展开 /skill；项目指令、技能及
   * 资料沿持久来源装配，排除 prompt 快照并在发送前复核资料来源。
   */
  restricted: boolean;
  /** 以计划模式运行（只普通开发会话）。 */
  plan: boolean;
  /** 工具集签名：并入 SDK 会话签名，变化即重建会话（装配过滤只能收窄、不能补回）。 */
  toolSignature: string;
  workflow?: WorkflowExecutionProfile;
  source?: WorkflowExecutionProfile;
}

/** 宿主解析的步骤能力；来源身份不改变步骤的独立上下文。 */
export interface WorkflowExecutionProfile {
  toolClass: "dev";
  sourceProjectId: string;
  categories: ToolCategory[];
  grantIds?: string[];
  tools?: string[];
  verifyTarget?: boolean;
  collaboration?: boolean;
  hostVerify?: boolean;
}

export function sourceAllows(profile: WorkflowExecutionProfile, name: string): boolean {
  return !name.startsWith("process_") && name !== "ask_user" && name !== "present" && name !== "browser" && name !== "desktop_browser" &&
    (!profile.hostVerify || SUBAGENT_WRITE_TOOL_NAMES.has(name)) &&
    !name.startsWith("workflow_") && (!name.startsWith("subagent_") || (name === "subagent_message" && profile.collaboration === true)) &&
    (!profile.tools || profile.tools.includes(name));
}

export function workflowAllows(profile: WorkflowExecutionProfile, name: string): boolean {
  return !name.startsWith("process_") && name !== "ask_user" && name !== "present" && !name.startsWith("subagent_") && !name.startsWith("workflow_") && name !== "browser" && name !== "desktop_browser" &&
    (profile.verifyTarget === true || !["edit", "write", "bash", "request_file_access"].includes(name)) &&
    (!profile.tools || profile.tools.includes(name));
}

export function executionProfile(input: {
  identity: SessionIdentity;
  /** 任务所属工作有写入目标。 */
  writeTarget: boolean;
  /** 提交时固定到任务的 Plan 选择。 */
  planMode: boolean;
  workflow?: WorkflowExecutionProfile | null;
  source?: WorkflowExecutionProfile | null;
}): ExecutionProfile {
  const { identity } = input;
  if (input.source) {
    if (identity.kind !== "subagent") throw new WorkflowError("workflow_binding_invalid");
    const source = input.source;
    return { toolClass: "subagent", subAgentTools: null, planMcp: source.categories.includes("mcp"), restricted: true, plan: false,
      toolSignature: `source:${JSON.stringify(source)}`, source, ...(input.workflow ? { workflow: input.workflow } : {}) };
  }
  if (input.workflow) {
    if (identity.kind !== "subagent" || !identity.workflow) throw new WorkflowError("workflow_binding_invalid");
    const workflow = { ...input.workflow, categories: input.workflow.categories.filter(category => !["subagent", "workflow", "browser", "desktop_browser"].includes(category)) };
    return { toolClass: workflow.toolClass, subAgentTools: null, planMcp: workflow.categories.includes("mcp"), restricted: true,
      plan: false, toolSignature: `workflow:${JSON.stringify(workflow)}`, workflow };
  }
  const sub = identity.kind === "subagent" ? { write: input.writeTarget } : null;
  const toolClass = identity.kind;
  return {
    toolClass,
    subAgentTools: sub,
    planMcp: allowsCategory(toolClass, "mcp"),
    restricted: sub !== null,
    plan: identity.kind === "dev" && input.planMode,
    toolSignature: sub ? `subagent:${sub.write ? "write" : "read"}` : identity.kind,
  };
}

export function allowsCategory(cls: SessionToolClass, category: ToolCategory): boolean {
  return SESSION_TOOL_CATEGORIES[cls].includes(category);
}

/** Copy the category list for a host-bound conversation identity. */
export function sessionToolCategories(cls: SessionToolClass): ToolCategory[] {
  return [...SESSION_TOOL_CATEGORIES[cls]];
}

export interface TaskToolSet {
  allowed: ReadonlySet<string>;
  /** 不在 allowed 中的工具的拒绝原因。 */
  reasonFor(name: string): string;
}

export type AgentResourcePhase = "execution" | "conversation";

/** 对话阶段只访问后台记录；未分类工具不能借只读名称取得工作目录。 */
export const CONVERSATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "wait", "present", "subagent_result", "workflow_query", "workflow_instructions", "history_search", "history_read", "read_artifact",
]);

export const OWNER_QUESTION_PENDING_TOOL_NAMES: ReadonlySet<string> = new Set(["subagent_result", "workflow_query", "workflow_instructions", "process_status", "process_output"]);
const BACKGROUND_OBSERVATION_TOOL_NAMES: ReadonlySet<string> = new Set(["process_status", "process_output", "process_stop", "wait", "ask_user", "browser", "present"]);

/** 本任务允许的工具（任务开始时算一次）：已装配的工具减去任务收窄与关闭的 Web Search。 */
export function taskToolSet(input: {
  /** 装配结果（含本任务 MCP 工具）。 */
  registered: readonly string[];
  /** 计划模式（issue 26）：只留 PLAN_TOOL_NAMES 与只读 MCP，今后新增的工具默认不可用。 */
  plan: boolean;
  webSearchEnabled: boolean;
  browserEnabled?: boolean;
  /** MyGo 绑定任务开放桌面浏览器；与旧 browser 工具互斥。 */
  desktopBrowserEnabled?: boolean;
  mcpEffect: (name: string) => McpToolEffect | undefined;
  /** Host-narrowed tools for the currently bound task. */
  narrow?: (name: string, mcpEffect?: McpToolEffect) => boolean;
  resourcePhase?: AgentResourcePhase;
  ownerQuestionsEnabled?: boolean;
  ownerQuestionPending?: boolean;
  backgroundProcessesEnabled?: boolean;
  backgroundStartEnabled?: boolean;
  backgroundObservation?: boolean;
}): TaskToolSet {
  const rejected = new Map<string, string>();
  const allowed = new Set<string>();
  for (const name of input.registered) {
    const effect = input.mcpEffect(name);
    const reason =
      input.ownerQuestionPending && !OWNER_QUESTION_PENDING_TOOL_NAMES.has(name) ? "等待本批问题结果进入下一次请求，再决定后续业务操作"
      : name.startsWith("process_") && !input.backgroundProcessesEnabled ? "本任务不是拥有者的普通开发输入"
      : name === "process_start" && !input.backgroundStartEnabled ? "后台启动只开放完全访问的拥有者输入；先停止原后台并核实目录占用"
      : name === "ask_user" && !input.ownerQuestionsEnabled ? "本任务不是拥有者的普通开发输入"
      : input.resourcePhase === "conversation" && input.backgroundObservation && !BACKGROUND_OBSERVATION_TOOL_NAMES.has(name) ? "会话后台持有目录：先 process_stop，再用 process_status 核实 stopped；停止未核实时报告拥有者"
      : input.resourcePhase === "conversation" && !input.backgroundObservation && !CONVERSATION_TOOL_NAMES.has(name) ? "执行资源未取得：当前仅处理对话与后台记录"
      : input.plan && !PLAN_TOOL_NAMES.has(name) && !["process_status", "process_output", "process_stop"].includes(name) && effect !== "read" ? "计划模式不开放"
      : name === "browser" && !input.browserEnabled ? "浏览器仅开放完全访问的拥有者会话"
      : name === "desktop_browser" && !input.desktopBrowserEnabled ? "桌面浏览器仅开放 MyGo 来源的完全访问 Coding 任务"
      : input.narrow && !input.narrow(name, effect) ? "本任务由宿主收窄"
      : !input.webSearchEnabled && (WEB_SEARCH_TOOL_NAMES as readonly string[]).includes(name) ? "Web Search 已停用"
      : null;
    if (reason) rejected.set(name, reason);
    else allowed.add(name);
  }
  return { allowed, reasonFor: (name) => rejected.get(name) ?? (allowed.has(name) ? "" : "本会话不开放") };
}
