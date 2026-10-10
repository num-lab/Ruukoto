import type { Store } from "@ruukoto/core/store.ts";

/** 工作内每次执行的请求键（与 (session_id, request_id) 唯一约束配合）。 */
export function subAgentTaskRequestId(workId: string, key: string): string {
  return `sdelegate:${workId}:${key}`;
}

/** 工具操作账本族核实：委派按工作/Agent/会话/任务关联核实；关闭按 closed_at 核实；取消按 canceled_at 核实；汇总按 work_delegation.integrated 事件核实。 */
export function subagentOpCheck(coreStore: Store): {
  verify(op: { taskId: string; toolName?: string; params: Record<string, unknown> }): "committed" | "not_committed" | "unverifiable";
  committed(when: string): string;
  notCommitted(when: string): string;
} {
  return {
    verify: (op) => {
      if (op.toolName === "subagent_close") {
        const agent = typeof op.params.sub_agent_id === "string" ? coreStore.getSubAgent(op.params.sub_agent_id) : null;
        if (!agent) return "not_committed";
        return agent.closedAt !== null ? "committed" : "not_committed";
      }
      if (op.toolName === "subagent_cancel") {
        const work = typeof op.params.work_id === "string" ? coreStore.getWorkDelegation(op.params.work_id) : null;
        if (!work) return "not_committed";
        return work.canceledAt !== null ? "committed" : "not_committed";
      }
      // 工作内消息（issue 13）：按（工作, 发送方, 键）的消息行核实；
      // 发送方由发起任务的 SubAgent 关联推出（null = 主 Agent），与登记口径一致
      if (op.toolName === "subagent_message") {
        const task = coreStore.getTask(op.taskId);
        const workId = typeof op.params.work_id === "string" ? op.params.work_id : null;
        if (!task || !workId) return "not_committed";
        const msg = coreStore.findSubAgentMessage(workId, task.subAgentId ?? null, String(op.params.key ?? ""));
        return msg !== null ? "committed" : "not_committed";
      }
      if (op.toolName === "subagent_integrate") {
        // 改动汇总（issue 17）：套用与事件登记分两步，缺事件时不能说「未生效」
        // （可能 apply 已落字节、登记前崩溃）——如实报无法核实
        const work = typeof op.params.work_id === "string" ? coreStore.getWorkDelegation(op.params.work_id) : null;
        if (!work) return "unverifiable";
        return coreStore.hasIntegratedEvent(work.id) ? "committed" : "unverifiable";
      }
      const task = coreStore.getTask(op.taskId);
      if (!task) return "not_committed";
      const work = typeof op.params.work_id === "string" && op.params.work_id
        ? coreStore.getWorkDelegation(op.params.work_id)
        : coreStore.findWorkDelegation(task.sessionId, String(op.params.key ?? ""));
      if (!work) return "not_committed";
      const agent = coreStore.getSubAgent(work.subAgentId);
      if (!agent || coreStore.getSession(agent.sessionId) === null) return "not_committed";
      const child = coreStore.findTaskByRequest(agent.sessionId, subAgentTaskRequestId(work.id, String(op.params.key ?? work.requestKey)));
      return child !== null ? "committed" : "not_committed";
    },
    committed: (when) => `已提交：SubAgent 操作已登记（${when}已生效）`,
    notCommitted: (when) => `已知未提交：不存在对应的 SubAgent 记录（${when}未生效）`,
  };
}
