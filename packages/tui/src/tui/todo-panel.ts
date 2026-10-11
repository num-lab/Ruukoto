import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeForDisplay } from "./sanitize.ts";

/** 工具记录里的原始参数项（已由 todo_write 校验，这里不收窄状态类型）。 */
export interface Todo {
  content: string;
  status: string;
}

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const MARKERS: Record<string, string> = { in_progress: "▶", pending: "⏸", completed: "✓" };

/** 当前清单（issue 25）= 已加载工具记录中最近一次成功 todo_write 的参数；没有则为 null。 */
// ponytail: 只看已加载的工具记录，最后一次 todo_write 早于已加载历史时面板隐藏；
// 需要时由快照下发会话当前清单
export function latestTodos(tools: ReadonlyArray<{ name: string; status: string; params: Record<string, unknown> }>): Todo[] | null {
  // 参数未补齐的历史行（params 为空）跳过，等工具记录到达后再覆盖
  const last = tools.findLast((t) => t.name === "todo_write" && t.status === "done" && Array.isArray(t.params.todos));
  return last ? (last.params.todos as Todo[]) : null;
}

/** /todo 悬浮层中的完整清单，保留已完成项，长任务名按单行截断。 */
export class TodoPanel implements Component {
  private todos: Todo[] | null = null;

  set(todos: Todo[] | null): void {
    this.todos = todos;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const all = this.todos ?? [];
    if (!all.length) return [dim("暂无工作清单")];
    return all.map((t) => {
      const line = `${MARKERS[t.status] ?? "☐"} ${sanitizeForDisplay(String(t.content)).replace(/\s+/g, " ").trim()}`;
      return truncateToWidth(t.status === "completed" ? dim(` ${line}`) : ` ${line}`, Math.max(1, width), "…");
    });
  }
}
