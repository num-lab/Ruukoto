/**
 * 计划模式（issue 31）：由可信模式选择固定到任务，采用 Auto review 并收窄工具。
 * 会话持续选择 Plan，直到拥有者手动切换；任务输入与继续链不决定模式。
 */

import type { ReferenceBlock } from "./context-selector.ts";

/** 计划说明：宿主写定的任务级参考块，紧邻当前任务输入。 */
export const PLAN_NOTICE: ReferenceBlock = {
  category: "planMode",
  placement: "task",
  text: [
    "[计划模式：拥有者选择 Plan；宿主固定说明]",
    "只调研、不修改：不修改文件、长期记忆或外部状态，改动留到执行时再做。",
    "bash 只运行只读命令（如搜索、查看文件、git log），不运行会写入文件或产生其他副作用的命令。",
    "持续调研并完善计划，最终回答给出计划；生成计划后仍保持 Plan，直到拥有者手动切换模式。",
    "即使拥有者要求开始实现，也先提示拥有者切换模式，不自行退出 Plan。",
    "Plan 固定采用 Auto review；工具收窄与以上说明不提供严格只读保证，保留工具的获批操作仍可能写文件或产生外部副作用。",
    "[/计划模式]",
  ].join("\n"),
};

/**
 * 计划模式的工具白名单（另加类别为只读的 MCP 工具）：今后新增的工具默认不可用。
 * shortcut: bash 仍可能写入工作区，只靠计划说明约束；需要硬保证时改为原生只读策略或去掉 bash。
 */
export const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read", "bash", "request_file_access", "http_request", "read_artifact",
  "history_search", "history_read", "memory_list", "memory_read", "web_search",
  "todo_write", "skill",
]);
