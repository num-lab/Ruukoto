/**
 * 父级送达（架构工单 09）：父级会收到这项工作的什么、何时收到。
 *
 * 送达 = 进入主 Agent 的一次模型调用（CONTEXT.md「送达」）：main 在承载它的唤醒
 * 任务开始运行时，普通开发会话在下一次任务开始时的注入。此前只是待送达——所属
 * 工作被取消即截住，内容仍作为事实保存可查（ADR 0020 issue 14 补充段）。
 */

import type { Store } from "../core/store.ts";
import type { SubAgentMessage, Task } from "../core/types.ts";

export interface ParentDeliveryDeps {
  store: Store;
}

export class ParentDelivery {
  private readonly store: Store;

  constructor(deps: ParentDeliveryDeps) {
    this.store = deps.store;
  }

  /** 唤醒任务承载的工作（wake:<子任务> 取子任务的工作，smsg:<消息> 取消息的工作）；不是唤醒为 null。 */
  private wakeWorkId(task: Task): string | null {
    if (task.requestId.startsWith("wake:")) return this.store.getTask(task.requestId.slice("wake:".length))?.workId ?? null;
    if (task.requestId.startsWith("smsg:")) return this.store.getSubAgentMessage(task.requestId.slice("smsg:".length))?.workId ?? null;
    return null;
  }

  /**
   * 入口 4：唤醒任务即将运行（队列循环，所有唤醒都经过它）。所属工作已取消即
   * 不放行——取消前已排队、取消后才插入与启动补建的唤醒都在这里截住。
   */
  wakeAdmitted(task: Task): boolean {
    const workId = this.wakeWorkId(task);
    return !workId || !this.store.getWorkDelegation(workId)?.canceledAt;
  }
}

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
