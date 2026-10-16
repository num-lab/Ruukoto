/** 宿主操作的执行登记与收尾，不创建模型会话。 */
// Note: 见 .agents/notes/implemented/architecture/2026-10-13-workflow-runtime-and-store.md
// Note: 见 .agents/notes/implemented/architecture/2026-10-16-task-ending-protocol.md
import type { Store } from "@ruukoto/core/store.ts";
import { isTerminalTaskStatus } from "@ruukoto/core/types.ts";
import { getWorkflowExecution, getWorkflowRun, updateWorkflowExecution } from "@ruukoto/core/workflow.ts";
import { workCopyHostFor } from "@ruukoto/core/work-copy-host.ts";
import { grantCoversPath } from "@ruukoto/core/worktree.ts";
import { verifyDirIdentitySync } from "@ruukoto/core/dir-identity.ts";
import { ExecutionError } from "@ruukoto/agent/execution/launchers.ts";
import type { ManagedEntry } from "@ruukoto/agent/managed-processes.ts";
import type { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { endTaskExecution, type TaskEndingContext } from "@ruukoto/agent/task-ending.ts";

interface HostExecution {
  permissionVersion: number;
  entries: ManagedEntry[];
  ending: boolean;
  context: TaskEndingContext;
  stop?: Promise<boolean>;
}

export class HostExecutionManager {
  private executions = new Map<string, HostExecution>();

  constructor(private deps: { store: Store; ledger: ToolOpLedger; onReleased?: () => void }) {}

  has(taskId: string): boolean { return this.executions.has(taskId); }

  /** 任务与目录占用先落盘，再登记执行归属；原发起任务可以已结束。 */
  attach(taskId: string): void {
    if (this.executions.has(taskId)) throw new ExecutionError("task_mismatch", "宿主任务已登记执行");
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new ExecutionError("task_mismatch", "宿主任务不存在");
    this.executions.set(taskId, { permissionVersion: task.permissionVersion, entries: [], ending: false, context: { taskId, stopSnapshot: null } });
    try { this.assertActive(taskId); }
    catch (error) { this.executions.delete(taskId); throw error; }
  }

  assertActive(taskId: string): void {
    const state = this.executions.get(taskId);
    const task = this.deps.store.getTask(taskId);
    if (task) {
      const copy = workCopyHostFor(task);
      if (copy) {
        const parent = this.deps.store.getTask(copy.parentTaskId);
        if (!state || state.ending || task.status !== "running" || task.cancelRequested ||
            task.permissionVersion !== state.permissionVersion || task.parentTaskId !== copy.parentTaskId ||
            !parent || parent.sessionId !== task.sessionId || !["running", "awaiting_confirmation"].includes(parent.status) || parent.cancelRequested ||
            task.sourcePermissionVersion !== parent.permissionVersion || task.accessMode !== parent.accessMode ||
            !this.deps.store.listAllOccupancy().some(held => held.taskId === parent.id && grantCoversPath(held.cwdReal, copy.source.path)) ||
            !this.deps.store.listAllOccupancy().some(held => held.taskId === taskId)) {
          throw new ExecutionError("task_ending", "工作副本宿主任务或来源已停止，保留现场，不再执行操作");
        }
        try { verifyDirIdentitySync({ cwd: copy.source.path, cwdReal: copy.source.path, dev: copy.source.dev, ino: copy.source.ino }); }
        catch (error) { throw new ExecutionError("source_invalid", "工作副本来源目录身份已变化，保留现场，请核实原目标", undefined, undefined, { cause: error }); }
        return;
      }
    }
    const execution = getWorkflowExecution(this.deps.store, taskId);
    const run = execution ? getWorkflowRun(this.deps.store, execution.runId) : null;
    if (!state || state.ending || !task || task.status !== "running" || task.cancelRequested ||
        task.permissionVersion !== state.permissionVersion || !execution || execution.kind !== "host" ||
        execution.status !== "running" || !run || run.status !== "running" ||
        task.sourcePermissionVersion !== run.source.permissionVersion || task.accessMode !== run.source.accessMode ||
        !this.deps.store.listAllOccupancy().some(held => held.taskId === taskId)) {
      throw new ExecutionError("task_ending", "工作流宿主任务已停止或授权失效，保留现场，不再执行操作");
    }
  }

  register(taskId: string, entry: ManagedEntry): void {
    this.assertActive(taskId);
    const state = this.executions.get(taskId)!;
    state.entries.push(entry);
    this.persistUnits(taskId, state);
  }

  /** 启动完成后即使取消已到达，也保存实际身份供停止核实。 */
  updateIdentity(taskId: string, entry: ManagedEntry): void {
    const state = this.executions.get(taskId);
    if (!state || !state.entries.includes(entry)) throw new ExecutionError("task_mismatch", "执行单元不属于宿主任务");
    this.persistUnits(taskId, state);
  }

  private persistUnits(taskId: string, state: HostExecution): void {
    const units = state.entries.map(({ kind, id, label }) => ({ kind, id, label }));
    this.deps.store.withTx(() => {
      const task = this.deps.store.getTask(taskId)!;
      const copy = workCopyHostFor(task);
      if (copy) this.deps.store.db.prepare("UPDATE tasks SET read_scope = ? WHERE id = ?")
        .run(JSON.stringify({ ...task.readScope, workCopyHost: { ...copy, units } }), taskId);
      else updateWorkflowExecution(this.deps.store, taskId, { units });
    });
  }

  /** 停止前快照操作；停止未核实保留全部目录占用和执行身份。 */
  stop(taskId: string, terminal: "completed" | "failed" | "canceled" | "interrupted", reason: string): Promise<boolean> {
    const state = this.executions.get(taskId);
    if (!state) {
      const task = this.deps.store.getTask(taskId);
      return Promise.resolve((task ? workCopyHostFor(task)?.stopVerified : null) === true || getWorkflowExecution(this.deps.store, taskId)?.stopVerified === true);
    }
    if (state.stop) {
      if (state.context.stopSnapshot === null && !isTerminalTaskStatus(this.deps.store.getTask(taskId)!.status) && (terminal === "canceled" || terminal === "interrupted")) {
        return this.stopInner(taskId, state, terminal, reason, state.stop);
      }
      return state.stop;
    }
    state.ending = true;
    state.stop = this.stopInner(taskId, state, terminal, reason);
    return state.stop;
  }

  private async stopInner(taskId: string, state: HostExecution,
    terminal: "completed" | "failed" | "canceled" | "interrupted", reason: string, stopping?: Promise<boolean>): Promise<boolean> {
    const task = this.deps.store.getTask(taskId)!;
    const result = await endTaskExecution(this.deps, task, state.context, {
      terminal, reason, abort: terminal === "canceled" || terminal === "interrupted" ? true : undefined,
      unreapedReason: "tool_process_unreaped",
      halt: async () => {
        if (stopping) return stopping;
        const results = await Promise.all(state.entries.map(async entry => {
          try { return await entry.stop(); }
          catch (error) {
            const code = error instanceof ExecutionError ? error.code : "stop_failed";
            process.stderr.write(`[ruukoto:host-execution] 执行单元停止未核实（${code}），保留目录占用待拥有者核实\n`);
            return false;
          }
        }));
        return results.every(result => result);
      },
      inTx: ({ reaped }) => {
        const task = this.deps.store.getTask(taskId)!;
        const copy = workCopyHostFor(task);
        if (copy && task.resultSummary === null) this.deps.store.setTaskResult(taskId,
          JSON.stringify({ isError: terminal !== "completed", content: "", errorMessage: reason }), JSON.stringify({ parentTaskId: copy.parentTaskId, workId: copy.workId, operation: copy.operation }));
        if (copy) this.deps.store.db.prepare("UPDATE tasks SET read_scope = ? WHERE id = ?")
          .run(JSON.stringify({ ...task.readScope, workCopyHost: { ...copy, stopVerified: reaped } }), taskId);
        else updateWorkflowExecution(this.deps.store, taskId, { status: "finished", stopVerified: reaped });
      },
    });
    return result.reaped;
  }

  async shutdown(reason: string): Promise<void> {
    await Promise.all([...this.executions.keys()].map(taskId => this.stop(taskId, "interrupted", reason)));
  }
}
