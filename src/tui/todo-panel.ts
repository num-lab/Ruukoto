import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeForDisplay } from "./sanitize.ts";

/** 工具记录里的原始参数项（已由 todo_write 校验，这里不收窄状态类型）。 */
interface Todo {
  content: string;
  status: string;
}

const MAX_LINES = 8;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const MARKERS: Record<string, string> = { in_progress: "▶", pending: "☐", completed: "☑" };

/** 当前清单（issue 25）= 已加载工具记录中最近一次成功 todo_write 的参数；没有则为 null。 */
// ponytail: 只看已加载的工具记录，最后一次 todo_write 早于已加载历史时面板隐藏；
// 需要时由快照下发会话当前清单
export function latestTodos(tools: ReadonlyArray<{ name: string; status: string; params: Record<string, unknown> }>): Todo[] | null {
  // 参数未补齐的历史行（params 为空）跳过，等工具记录到达后再覆盖
  const last = tools.findLast((t) => t.name === "todo_write" && t.status === "done" && Array.isArray(t.params.todos));
  return last ? (last.params.todos as Todo[]) : null;
}

/** 事件流与状态栏之间的常驻清单面板；无清单、空清单或全部完成时不占行。 */
export class TodoPanel implements Component {
  private todos: Todo[] | null = null;

  set(todos: Todo[] | null): void {
    this.todos = todos;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const all = this.todos ?? [];
    if (all.every((t) => t.status === "completed")) return [];
    // 超出时先省略已完成项，仍超出则截取；留一行给「…另 N 项」
    const shown = all.length > MAX_LINES ? all.filter((t) => t.status !== "completed").slice(0, MAX_LINES - 1) : all;
    const lines = shown.map((t) => {
      const line = `${MARKERS[t.status] ?? "☐"} ${sanitizeForDisplay(String(t.content)).replace(/\s+/g, " ").trim()}`;
      return t.status === "completed" ? dim(line) : line;
    });
    if (shown.length < all.length) lines.push(dim(`…另 ${all.length - shown.length} 项`));
    return lines.map((line) => truncateToWidth(` ${line}`, width, "…"));
  }
}
