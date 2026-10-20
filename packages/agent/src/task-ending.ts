import type { Store } from "@ruukoto/core/store.ts";
import type { AccessMode, Task } from "@ruukoto/core/types.ts";
import type { ToolOpLedger } from "./tool-op-ledger.ts";

export interface TaskEndingContext {
  readonly taskId: string;
  stopSnapshot: string[] | null;
}

/** 同一任务从启动起共享首次中止快照；停止 Promise 仍由执行归属持有，避免嵌套停止自锁。 */
// Note: 见 .agents/notes/implemented/architecture/2026-10-16-task-ending-protocol.md
export async function endTaskExecution(
  deps: { store: Store; ledger: ToolOpLedger; onReleased?: () => void },
  task: Pick<Task, "id" | "sessionId">,
  ending: TaskEndingContext,
  options: {
    terminal: "completed" | "failed" | "canceled" | "interrupted";
    reason?: string;
    abort?: true;
    halt?: () => Promise<boolean>;
    unreapedReason: string;
    modeSwitchFailure?: { to: AccessMode; reason: string };
    inTx?: (result: { changed: boolean; reaped: boolean }) => void;
  },
): Promise<{ changed: boolean; reaped: boolean }> {
  if (options.abort) {
    deps.store.withTx(() => deps.store.setCancelRequested(task.id, options.terminal === "canceled"));
    // 接管交接候选的内容，换引用使成功交接不能撤去已被中止路径采用的快照。
    ending.stopSnapshot = [...(ending.stopSnapshot ?? deps.ledger.beginStop(task.id))];
  }
  let reaped = false;
  if (options.halt) {
    try { reaped = await options.halt(); }
    catch {
      process.stderr.write(`[ruukoto:task-ending] 任务 ${task.id} 停止未核实，保留目录占用，请拥有者核实后恢复队列\n`);
    }
  }
  const changed = deps.store.withTx(() => {
    const unknown = ending.stopSnapshot === null ? [] : deps.ledger.settleTask(task, ending.stopSnapshot);
    const changed = deps.store.endTask(task.id, ["running", "awaiting_confirmation"], options.terminal, {
      errorMessage: options.terminal === "failed" ? options.reason : undefined,
      interruptReason: options.terminal === "canceled" || options.terminal === "interrupted" ? options.reason : undefined,
      keepOccupancy: !reaped,
      occupancyIssueReason: reaped ? null : options.unreapedReason,
      modeSwitchFailure: options.modeSwitchFailure,
      onChanged: () => { for (const opId of unknown) deps.ledger.markEffectUnknown(task, opId); },
    });
    // XXX 停止结论仍分存占用、工作副本宿主与工作流执行记录，统一存储时合并此钩子。
    options.inTx?.({ changed, reaped });
    return changed;
  });
  if (changed && reaped) deps.onReleased?.();
  return { changed, reaped };
}
