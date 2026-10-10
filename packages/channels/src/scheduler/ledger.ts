import type { HostToolLedger } from "@ruukoto/agent/host-tool-families.ts";
import type { FamilyCheck } from "@ruukoto/agent/tool-op-ledger.ts";
import type { SchedulerStore } from "./store.ts";


export const SCHEDULER_TOOL_NAMES = [
  "schedule_create",
  "schedule_query",
  "schedule_cancel",
  "notification_enqueue",
  "notification_query",
  "notification_cancel",
] as const;


export const SCHEDULER_LEDGER: HostToolLedger = {
  names: SCHEDULER_TOOL_NAMES,
  ruleFor: (name) => ["schedule_query", "notification_query"].includes(name) ? "no_effect" : { family: "scheduler" },
};


/** 工具操作账本的族核实（issue 03）：写工具按宿主操作 ID 核实是否已登记（同库，恒可核实）。 */
export function schedulerOpCheck(sched: SchedulerStore): FamilyCheck {
  return {
    verify: (op) => (sched.hostOpCommitted(op.id) ? "committed" : "not_committed"),
    committed: (when) => `已提交：调度账本存在该操作记录（${when}已登记）`,
    notCommitted: (when) => `已知未提交：调度账本无该操作记录（${when}未登记）`,
  };
}
