import type { Store } from "@ruukoto/core/store.ts";
import type { SubAgentMessage } from "@ruukoto/core/types.ts";

/**
 * 消息现状（subagent_message 回报与 subagent_result 共用）。投递登记一次写入不改；
 * 发给主 Agent 的消息，承载唤醒被放行判定截住（工作已取消）时读取补标未送达。
 */
export function messageStateText(store: Store, m: SubAgentMessage): string {
  if (m.deliveredTaskId) {
    const carrier = m.toSubAgentId === null ? store.getTask(m.deliveredTaskId) : null;
    const held = carrier?.status === "canceled" && carrier.errorMessage === "work_canceled";
    return `已投递（任务 ${m.deliveredTaskId}）${held ? "（工作已取消，未送达）" : ""}`;
  }
  return m.deliveredAt
    ? "已随主会话模型调用注入送达"
    : m.undeliveredReason
      ? `未投递（${m.undeliveredReason}）`
      : "待投递（接收方忙/名额满或待注入，宿主机会在任务终态等时机冲刷）";
}
