/**
 * 会话身份（架构工单 08）：「这个会话是什么」只在这里判定一次。
 *
 * 身份只由宿主绑定确定（sessions.kind、agent_roles、sub_agents），任务、工具参数
 * 与模型结果不能改变它。读取（Store.getSessionIdentity，三行一次读出）与分类
 * （本文件的纯函数）分开：分类器不依赖 store。
 */

import type { AgentRole, Session, SubAgent } from "./types.ts";

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
  | { kind: "subagent"; agent: SubAgent }
  | { kind: "retired"; reason: string };

export function classifySession(session: Pick<Session, "kind">, role: AgentRole | null, agent: SubAgent | null): SessionIdentity {
  if (agent) return { kind: "subagent", agent };
  if (session.kind === "qq_group" || role?.id === "chat") return { kind: "retired", reason: CORE_GROUP_CHAT_RETIRED };
  if (role?.id === "coding") return { kind: "retired", reason: CODING_ROLE_RETIRED };
  if (role?.id === "main") return { kind: "main", role };
  return { kind: "dev" };
}
