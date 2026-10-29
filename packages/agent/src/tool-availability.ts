/**
 * 工具可用性（架构工单 03）：这个会话、这个任务允许哪些工具，被拒的原因是什么。
 *
 * - 会话类别 → 工具类别：一张静态表，唯一来源。新工具族默认对所有会话不可见，
 *   写进哪份清单才出现；独立定时会话复用 main 的个人业务类别；
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

/**
 * 工具类别按会话身份选择；独立定时会话复用 main，已退役归档不运行任务。
 */
export type SessionToolClass = Exclude<SessionIdentity["kind"], "retired" | "scheduled">;

const SESSION_TOOL_CATEGORIES: Record<SessionToolClass, readonly ToolCategory[]> = {
  dev: ["coding", "host_data", "web_search", "browser", "mcp", "skills", "subagent", "workflow", "owner_question", "background_process"],
  // main：日常对话/信息整理/编排，不持有编码工具；service 仅装配另要求
  // 产品 ruukoto + Linux + 显式部署配置（agent-direction issue 09）
  main: ["host_data", "web_search", "browser", "app_data", "scheduler", "delegation", "chat_results", "service", "skills", "subagent", "workflow"],
  // subagent（agent-direction issue 11）：工具按执行画像的 SubAgent 工具集单独装配
  // （不走注册来源类别），子身份不能再委派下级；宿主评审任务（issue 19）的只读
  // MCP 由画像按任务另开，不在本静态清单
  subagent: [],
  // 侧聊（coding-side-chat）：纯文本、无工具；历史里的工具调用只是复制的正文
  side: [],
};

/**
 * SubAgent 任务的静态只读工具白名单（装配、发送前与调用门同一结论；伪造调用
 * 与未知工具默认拒绝）。宿主评审任务（issue 19）在此之外另开 effect=read
 * 的 MCP（收窄规则见 Driver 的任务工具集）。
 */
export const SUBAGENT_READONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "list_files", "search_files", "read_artifact"]);

/**
 * SubAgent 任务的写入工具白名单（agent-direction issue 16，工作有写入目标
 * 时的完整集合）：编码、文件检索与产物读取。无 request_file_access、
 * http_request、MCP 或委派工件——受限模式的工作区写入由原生边界约束，不逐次审批。
 */
export const SUBAGENT_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "list_files", "search_files", "edit", "write", "bash", "read_artifact"]);

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
  toolClass: "dev" | "main";
  sourceProjectId: string;
  categories: ToolCategory[];
  grantIds?: string[];
  tools?: string[];
  verifyTarget?: boolean;
  collaboration?: boolean;
  hostVerify?: boolean;
}

export function sourceAllows(profile: WorkflowExecutionProfile, name: string): boolean {
  return !name.startsWith("process_") && name !== "ask_user" && name !== "present" && !(profile.toolClass === "main" && name === "todo_write") && name !== "coding_delegate" && name !== "browser" &&
    (!profile.hostVerify || SUBAGENT_WRITE_TOOL_NAMES.has(name)) &&
    !name.startsWith("workflow_") && (!name.startsWith("subagent_") || (name === "subagent_message" && profile.collaboration === true)) &&
    (!profile.tools || profile.tools.includes(name));
}

export function workflowAllows(profile: WorkflowExecutionProfile, name: string): boolean {
  return !name.startsWith("process_") && name !== "ask_user" && name !== "present" && !(profile.toolClass === "main" && name === "todo_write") && !name.startsWith("subagent_") && !name.startsWith("workflow_") && name !== "coding_delegate" && name !== "browser" &&
    (profile.verifyTarget === true || !["edit", "write", "bash", "request_file_access"].includes(name)) &&
    (!profile.tools || profile.tools.includes(name));
}

export function executionProfile(input: {
  identity: SessionIdentity;
  /** 任务所属工作有写入目标。 */
  writeTarget: boolean;
  /** 宿主评审任务（issue 19）。 */
  review: boolean;
  /** 提交时固定到任务的 Plan 选择。 */
  planMode: boolean;
  workflow?: WorkflowExecutionProfile | null;
  source?: WorkflowExecutionProfile | null;
}): ExecutionProfile {
  const { identity } = input;
  if (identity.kind === "retired") throw new Error(`已退役的只读归档不运行任务（${identity.reason}）`);
  if (input.source) {
    if (identity.kind !== "subagent") throw new WorkflowError("workflow_binding_invalid");
    const source = input.source;
    return { toolClass: "subagent", subAgentTools: null, planMcp: source.categories.includes("mcp"), restricted: true, plan: false,
      toolSignature: `source:${JSON.stringify(source)}`, source, ...(input.workflow ? { workflow: input.workflow } : {}) };
  }
  if (input.workflow) {
    if (identity.kind !== "subagent" || !identity.workflow) throw new WorkflowError("workflow_binding_invalid");
    const workflow = { ...input.workflow, categories: input.workflow.categories.filter(category => !["subagent", "delegation", "workflow", "browser"].includes(category)) };
    return { toolClass: workflow.toolClass, subAgentTools: null, planMcp: workflow.categories.includes("mcp"), restricted: true,
      plan: false, toolSignature: `workflow:${JSON.stringify(workflow)}`, workflow };
  }
  const sub = identity.kind === "subagent" ? { write: input.writeTarget, review: input.review } : null;
  const toolClass = identity.kind === "scheduled" ? "main" : identity.kind;
  return {
    toolClass,
    subAgentTools: sub,
    planMcp: allowsCategory(toolClass, "mcp") || Boolean(sub?.review),
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

export type AgentResourcePhase = "execution" | "conversation";

/** 对话阶段只访问后台记录；未分类工具不能借只读名称取得工作目录。 */
export const CONVERSATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "wait", "present", "subagent_result", "workflow_query", "workflow_instructions", "history_search", "history_read", "read_artifact",
]);

export const OWNER_QUESTION_PENDING_TOOL_NAMES: ReadonlySet<string> = new Set(["subagent_result", "workflow_query", "workflow_instructions"]);
const BACKGROUND_OBSERVATION_TOOL_NAMES: ReadonlySet<string> = new Set(["process_status", "process_output", "process_stop", "wait", "ask_user", "browser", "present"]);

/** 本任务允许的工具（任务开始时算一次）：已装配的工具减去任务收窄与关闭的 Web Search。 */
export function taskToolSet(input: {
  /** 装配结果（含本任务 MCP 工具）。 */
  registered: readonly string[];
  /** 计划模式（issue 26）：只留 PLAN_TOOL_NAMES 与只读 MCP，今后新增的工具默认不可用。 */
  plan: boolean;
  webSearchEnabled: boolean;
  browserEnabled?: boolean;
  mcpEffect: (name: string) => McpToolEffect | undefined;
  /** 宿主按任务收窄（GitHub 评审等；已绑定任务）。 */
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
      input.ownerQuestionPending && !OWNER_QUESTION_PENDING_TOOL_NAMES.has(name) && name !== "process_status" && name !== "process_output" ? "问题已登记：结束本轮，回答将作为后续拥有者输入"
      : name.startsWith("process_") && !input.backgroundProcessesEnabled ? "本任务不是拥有者的普通开发输入"
      : name === "process_start" && !input.backgroundStartEnabled ? "后台启动只开放完全访问的拥有者输入；先停止原后台并核实目录占用"
      : name === "ask_user" && !input.ownerQuestionsEnabled ? "本任务不是拥有者的普通开发输入"
      : input.resourcePhase === "conversation" && input.backgroundObservation && !BACKGROUND_OBSERVATION_TOOL_NAMES.has(name) ? "会话后台持有目录：先 process_stop，再用 process_status 核实 stopped；停止未核实时报告拥有者"
      : input.resourcePhase === "conversation" && !input.backgroundObservation && !CONVERSATION_TOOL_NAMES.has(name) ? "执行资源未取得：当前仅处理对话与后台记录"
      : input.plan && !PLAN_TOOL_NAMES.has(name) && !["process_status", "process_output", "process_stop"].includes(name) && effect !== "read" ? "计划模式不开放"
      : name === "browser" && !input.browserEnabled ? "浏览器仅开放完全访问的拥有者会话"
      : input.narrow && !input.narrow(name, effect) ? "本任务由宿主收窄"
      : !input.webSearchEnabled && (WEB_SEARCH_TOOL_NAMES as readonly string[]).includes(name) ? "Web Search 已停用"
      : null;
    if (reason) rejected.set(name, reason);
    else allowed.add(name);
  }
  return { allowed, reasonFor: (name) => rejected.get(name) ?? (allowed.has(name) ? "" : "本会话不开放") };
}
