/**
 * 工作清单（issue 25）：todo_write 每次提交整张清单并整体替换。
 *
 * 清单跟随会话，不另存：会话历史与工具记录中最近一次成功调用的参数即当前
 * 清单（TUI 面板与上下文保底都按这一来源）。校验失败时报错，清单不变。
 * 无副作用：不产生审批，可安全重试。
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export const TODO_TOOL_NAMES = ["todo_write"] as const;
export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

// ponytail: 20 项 × 120 字符（且不许额外字段）让参数总在 PARAMS_INLINE_CAP（8 KiB）
// 以内原样下发；转义字符若撑过 8 KiB，previewValue 的上限（32 项、256 字符）也高于
// 这里，TUI 仍拿到完整清单。放宽上限前先核对这两处。
const MAX_ITEMS = 20;
const MAX_CONTENT_CHARS = 120;
const STATUSES: readonly string[] = ["pending", "in_progress", "completed"];

const invalid = (message: string): Error => new Error(`${message}；当前清单不变`);

/** 整表校验：不截断，任一项不合规即报错。 */
export function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) throw invalid("todos 必须是数组");
  if (value.length > MAX_ITEMS) throw invalid(`工作清单最多 ${MAX_ITEMS} 项（收到 ${value.length} 项）`);
  return value.map((item, i) => {
    const { content, status } = (item ?? {}) as Record<string, unknown>;
    if (typeof content !== "string") throw invalid(`第 ${i + 1} 项：content 必须是字符串`);
    const text = content.trim();
    if (!text) throw invalid(`第 ${i + 1} 项：content 不能为空`);
    // 按原文计长：清单状态是原始参数，首尾空白也占参数体积
    if (content.length > MAX_CONTENT_CHARS) throw invalid(`第 ${i + 1} 项：content 超过 ${MAX_CONTENT_CHARS} 字符（${content.length} 字符）`);
    if (typeof status !== "string" || !STATUSES.includes(status)) {
      throw invalid(`第 ${i + 1} 项：status 只能是 pending、in_progress 或 completed（收到 ${String(status)}）`);
    }
    return { content: text, status: status as TodoStatus };
  });
}

export function createTodoTools(deps: { bindCall?(sdkCallId: string): () => void }): ToolDefinition[] {
  const todoWrite = defineTool({
    name: "todo_write",
    label: "todo_write",
    description:
      "维护本会话的工作清单（步骤与状态），拥有者在界面上查看进度。3 步以上的工作才使用；" +
      "每次提交完整清单并整体替换，空数组清空。同一时间只标一项 in_progress；完成一项立即更新。" +
      `最多 ${MAX_ITEMS} 项，每项 content 不超过 ${MAX_CONTENT_CHARS} 字符。`,
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({ description: `步骤描述（1–${MAX_CONTENT_CHARS} 字符）` }),
          status: Type.String({ description: "pending | in_progress | completed" }),
        }, { additionalProperties: false }),
        { description: "完整清单（整体替换当前清单；空数组清空）" },
      ),
    }, { additionalProperties: false }),
    execute: async (sdkCallId: string, params: { todos: unknown }) => {
      const unbind = deps.bindCall?.(sdkCallId) ?? (() => {});
      try {
        // 错误以异常返回：pi 据此生成 isError=true 的 toolResult
        const list = parseTodos(params.todos);
        const done = list.filter((t) => t.status === "completed").length;
        const text = list.length === 0 ? "已清空" : `已更新：完成 ${done}/${list.length}`;
        return { content: [{ type: "text" as const, text }], details: undefined };
      } finally {
        unbind();
      }
    },
  } as any);
  return [todoWrite] as ToolDefinition[];
}
