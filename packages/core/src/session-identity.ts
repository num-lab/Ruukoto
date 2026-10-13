/**
 * 会话身份（架构工单 08）：「这个会话是什么」只在这里判定一次。
 *
 * 身份只由宿主绑定确定（sessions.kind、agent_roles、sub_agents），任务、工具参数
 * 与模型结果不能改变它。读取（Store.getSessionIdentity，三行一次读出）与分类
 * （本文件的纯函数）分开：分类器不依赖 store。
 */

import type { AgentRole, ModelSelection, Session, SubAgent } from "./types.ts";

/** 宿主在调度运行中绑定的独立执行身份，不占用 main 角色行。 */
export interface ScheduledSessionBinding {
  runId: string;
  scheduleId: string;
  rootTaskId: string;
  projectId: string;
  modelSelection: ModelSelection | null;
}

/** 工作流步骤仍是 SubAgent 上下文，运行授权与来源由宿主绑定提供。 */
export interface WorkflowSessionBinding { runId: string; stepKey: string; sourceSessionId: string }

/**
 * 退役原因（agent-direction issue 20 核心群聊、issue 23 固定 coding）：入站门卫弃、
 * 遗留排队任务取消、启动收尾与提交拒绝共用同一文本（前缀即持久化原因标识）。
 */
export const CORE_GROUP_CHAT_RETIRED = "core_group_chat_retired:核心群聊已退役（正式外挂后续交付）";
export const CODING_ROLE_RETIRED = "coding_role_retired:固定 coding 角色已退役（委派改用通用 SubAgent）";

/**
 * dev = 普通开发会话；main = 宿主为 main 绑定的会话；subagent = SubAgent 的独立
 * 工作会话（会话类别也是 dev）；retired = 已退役归档（QQ 群、chat/coding 角色），
 * 只读、不运行任务，reason 即入口拒绝与队列兜底取消的原因。
 */
export type SessionIdentity =
  | { kind: "dev" }
  | { kind: "main"; role: AgentRole }
  | ({ kind: "scheduled" } & ScheduledSessionBinding)
  | { kind: "subagent"; agent: SubAgent; workflow?: WorkflowSessionBinding }
  | { kind: "retired"; reason: string };

export function classifySession(session: Pick<Session, "kind">, role: AgentRole | null, agent: SubAgent | null, scheduled: ScheduledSessionBinding | null = null, workflow: WorkflowSessionBinding | null = null): SessionIdentity {
  if (scheduled) return { kind: "scheduled", ...scheduled };
  if (agent) return { kind: "subagent", agent, ...(workflow ? { workflow } : {}) };
  if (session.kind === "qq_group" || role?.id === "chat") return { kind: "retired", reason: CORE_GROUP_CHAT_RETIRED };
  if (role?.id === "coding") return { kind: "retired", reason: CODING_ROLE_RETIRED };
  if (role?.id === "main") return { kind: "main", role };
  return { kind: "dev" };
}
