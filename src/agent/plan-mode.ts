/**
 * 计划模式（issue 26）：拥有者以 `/plan <内容>` 提交的一次性任务——只调研、不修改，
 * 最终回答即计划。标记只看任务输入，不加会话状态；只收窄工具，访问模式不变。
 */

import type { Task } from "../core/types.ts";
import type { ReferenceBlock } from "./context-selector.ts";

type PlanTaskView = Pick<Task, "input" | "resumesTaskId">;

/** 计划说明：宿主写定的任务级参考块，紧邻当前任务输入。 */
export const PLAN_NOTICE: ReferenceBlock = {
  category: "planMode",
  placement: "task",
  text: [
    "[计划模式：拥有者以 /plan 提交本任务；宿主固定说明]",
    "只调研、不修改：不修改文件、长期记忆或外部状态，改动留到执行时再做。",
    "bash 只运行只读命令（如搜索、查看文件、git log），不运行会写入文件或产生其他副作用的命令。",
    "最终回答给出计划；拥有者的下一条消息即按计划执行。",
    "[/计划模式]",
  ].join("\n"),
};

/** 标记规则：任务输入以 `/plan` 加空白开头且其后有内容。 */
export function isPlanInput(input: string): boolean {
  return /^\/plan\s+\S/.test(input);
}

/** 以计划模式运行：输入带标记，或经 continue 逐级继续的原任务带标记（查不到的原任务按不带标记处理）。 */
export function runsInPlanMode(task: PlanTaskView, getTask: (id: string) => PlanTaskView | null): boolean {
  for (let t: PlanTaskView | null = task; t; t = t.resumesTaskId ? getTask(t.resumesTaskId) : null) {
    if (isPlanInput(t.input)) return true;
  }
  return false;
}

/**
 * 计划模式的工具白名单（另加类别为只读的 MCP 工具）：今后新增的工具默认不可用。
 * ponytail: bash 仍可能写入工作区，只靠计划说明约束；需要硬保证时改为容器只读挂载或去掉 bash。
 */
export const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read", "bash", "request_file_access", "http_request", "read_artifact",
  "history_search", "history_read", "memory_list", "memory_read", "web_search",
  "todo_write", "skill",
]);
