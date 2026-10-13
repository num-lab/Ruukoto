/** 工作流宿主操作的执行登记与收尾，不创建模型会话。 */
// Note: 见 .agents/notes/implemented/architecture/2026-10-13-workflow-runtime-and-store.md
import type { Store } from "@ruukoto/core/store.ts";
import { getWorkflowExecution, getWorkflowRun, updateWorkflowExecution } from "@ruukoto/core/workflow.ts";
import { ExecutionError } from "@ruukoto/agent/execution/launchers.ts";
import type { ManagedEntry } from "@ruukoto/agent/managed-processes.ts";
import type { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";

interface HostExecution {
  permissionVersion: number;
  entries: ManagedEntry[];
  ending: boolean;
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
    this.executions.set(taskId, { permissionVersion: task.permissionVersion, entries: [], ending: false });
    try { this.assertActive(taskId); }
    catch (error) { this.executions.delete(taskId); throw error; }
  }

  assertActive(taskId: string): void {
    const state = this.executions.get(taskId);
    const task = this.deps.store.getTask(taskId);
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
    this.deps.store.withTx(() => updateWorkflowExecution(this.deps.store, taskId, {
      units: state.entries.map(({ kind, id, label }) => ({ kind, id, label })),
    }));
  }

  /** 停止前快照操作；停止未核实保留全部目录占用和执行身份。 */
  stop(taskId: string, terminal: "completed" | "failed" | "canceled" | "interrupted", reason: string): Promise<boolean> {
    const state = this.executions.get(taskId);
    if (!state) return Promise.resolve(getWorkflowExecution(this.deps.store, taskId)?.stopVerified === true);
    if (state.stop) return state.stop;
    state.ending = true;
    this.deps.store.withTx(() => {
      if (terminal === "canceled") this.deps.store.setCancelRequested(taskId, true);
    });
    const snapshot = this.deps.ledger.beginStop(taskId);
    state.stop = this.stopInner(taskId, state, snapshot, terminal, reason);
    return state.stop;
  }

  private async stopInner(taskId: string, state: HostExecution, snapshot: string[],
    terminal: "completed" | "failed" | "canceled" | "interrupted", reason: string): Promise<boolean> {
    const results = await Promise.all(state.entries.map(async entry => {
      try { return await entry.stop(); }
      catch (error) {
        const code = error instanceof ExecutionError ? error.code : "stop_failed";
        process.stderr.write(`[ruukoto:host-execution] 执行单元停止未核实（${code}），保留目录占用待拥有者核实\n`);
        return false;
      }
    }));
    const reaped = results.every(result => result);
    this.deps.store.withTx(() => {
      const task = this.deps.store.getTask(taskId)!;
      this.deps.store.endTask(taskId, ["running", "awaiting_confirmation"], terminal, {
        interruptReason: terminal === "interrupted" || terminal === "canceled" ? reason : undefined,
        errorMessage: terminal === "failed" ? reason : undefined,
        keepOccupancy: !reaped,
        occupancyIssueReason: reaped ? null : "tool_process_unreaped",
        onChanged: () => {
          for (const opId of this.deps.ledger.settleTask(task, snapshot)) this.deps.ledger.markEffectUnknown(task, opId);
        },
      });
      updateWorkflowExecution(this.deps.store, taskId, { status: "finished", stopVerified: reaped });
    });
    if (reaped) this.deps.onReleased?.();
    return reaped;
  }

  async shutdown(reason: string): Promise<void> {
    await Promise.all([...this.executions.keys()].map(taskId => this.stop(taskId, "interrupted", reason)));
  }
}
