/** SubAgent results, parent delivery, deadline cancellation and restart recovery. */
// Note: See .agents/notes/implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md

import type { Store } from "@ruukoto/core/store.ts";
import { getOpenCodeScheduleRunForSession } from "@ruukoto/core/code-scheduler.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import {
  isTerminalTaskStatus,
  type AccessMode,
  type GrantedPath,
  type ModelSelection,
  type PersistentEvent,
  type Task,
  type WorkDelegation,
} from "@ruukoto/core/types.ts";
import type { SubAgentManager } from "@ruukoto/runtime/subagents.ts";
import type { ParentDelivery } from "@ruukoto/runtime/parent-delivery.ts";
import { getWorkflowDeliveryRun } from "@ruukoto/core/workflow.ts";
import { WorkspaceSnapshotError } from "@ruukoto/core/workspace-snapshot.ts";
import { WorkCopyError } from "./work-copy.ts";

/** 编排器需要的 Runtime 窄接口（宿主注入；除此之外的能力编排器不可见）。 */
export interface OrchestratorBridge {
  submit(input: {
    sessionId: string;
    requestId: string;
    input: string;
    accessMode?: AccessMode;
    grantedPaths?: GrantedPath[];
    modelSelection: ModelSelection;
    parentTaskId?: string | null;
    sourcePermissionVersion?: number | null;
    deadline?: string | null;
    workflowRunId?: string;
    reportKey?: string;
  }): Promise<Task>;
  cancelTask(taskId: string, reason?: string): Promise<Task>;
  /** 指定任务的最终 assistant 文本（按任务关联的历史条目，不取会话最新一条）。 */
  readTaskReply(taskId: string, offset: number, length: number): HistoryEntryView | null;
  resumeQueue(sessionId: string): Promise<unknown>;
  kickSession(sessionId: string): void;
  defaultModelSelection(): ModelSelection;
}

export interface OrchestratorDeps {
  store: Store;
  bridge: OrchestratorBridge;
  deadlineCheckMs?: number;
  parentDelivery: Pick<ParentDelivery, "resultRecorded" | "wakeTerminal" | "sweep"> & Partial<Pick<ParentDelivery, "needsResult" | "reserveResult">>;
  subagents?: Pick<SubAgentManager, "resultRecorded" | "verifyWorkspace" | "start"> & { flushPending: SubAgentManager["flushPendingMessages"] };
}


/** 子任务结果摘要上限（写入任务记录与唤醒输入）。 */
const RESULT_SUMMARY_CAP = 1000;
/** 超时取消的持久化原因（canceled 事件与启动巡检据此判定 timeout，重启后不丢）。 */
const DEADLINE_REASON = "deadline_exceeded";


/** 子任务终态口径（completed/failed/timeout/unknown），事件、摘要与唤醒共用。 */
export type ChildOutcome = "completed" | "failed" | "timeout" | "unknown";

export const OUTCOME_TEXT: Record<ChildOutcome, string> = {
  completed: "已完成",
  failed: "失败",
  timeout: "超时",
  unknown: "结果未知",
};

/** 超时取消的判定：取消原因在取消时持久化（errorMessage/interruptReason），重启后仍可核对。 */
function isDeadlineCancel(task: Task): boolean {
  return task.errorMessage === DEADLINE_REASON || task.interruptReason === DEADLINE_REASON;
}

/** 由任务持久状态推导终态口径（启动巡检与补建唤醒共用）。 */
export function childOutcome(task: Task): ChildOutcome {
  if (task.status === "completed") return "completed";
  if (task.status === "interrupted") return "unknown";
  if (task.status === "canceled" && isDeadlineCancel(task)) return "timeout";
  return "failed";
}


export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private started = false;
  private deadlineTimer: NodeJS.Timeout | undefined;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  private get store(): Store {
    return this.deps.store;
  }

  private log(message: string): void {
    // 后台诊断输出（不含消息正文与秘密）
    process.stderr.write(`[ruukoto:orchestrator] ${message}\n`);
  }

  async start(): Promise<void> {
    this.started = true;
    await this.sweepPendingResults();
    await this.deps.subagents?.start();
    for (const session of this.store.listSessions()) {
      if (this.store.getSessionIdentity(session.id)?.kind === "dev" && !getOpenCodeScheduleRunForSession(this.store, session.id) && this.store.listQueuedTasksFifo(session.id).length > 0 &&
          this.store.listQueuedTasksFifo(session.id).every(task => getWorkflowDeliveryRun(this.store, task.id) || this.deps.parentDelivery.needsResult?.(task))) {
        await this.resumeRestartPausedQueue(session.id, "内部最终汇总");
      }
    }
    this.deadlineTimer = setInterval(() => void this.checkDeadlines(), this.deps.deadlineCheckMs ?? 1_000);
    this.deadlineTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    clearInterval(this.deadlineTimer);
    this.deadlineTimer = undefined;
  }



  /**
   * backend_restart 暂停的会话队列在启动时自动恢复。两层门禁：occupancy_unverified
   * 保持暂停；会话另持有遗留占用时也不自动恢复（resumeQueue 会一并释放占用——
   * 那是拥有者核实后的动作，不能自动发生；恢复事务本已按 occupancy_unverified
   * 拦截，这里再挡住人工暂停叠加遗留占用的形态）。
   */
  private async resumeRestartPausedQueue(sessionId: string, label: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session || session.queueState !== "paused" || session.queuePauseReason !== "backend_restart") return;
    if (this.store.listAllOccupancy().some((o) => o.sessionId === session.id)) return;
    await this.deps.bridge
      .resumeQueue(session.id)
      .catch((err) => this.log(`恢复${label} 队列失败：${(err as Error).message}`));
  }

  // ---------- 角色引导 ----------


  // ---------- 入站事件 ----------






  // ---------- 结果回传与唤醒 ----------

  /** Runtime 事件监听：角色任务到达终态时记录结果、发子任务事件、唤醒父任务。 */
  onRuntimeEvents(events: PersistentEvent[]): void {
    if (!this.started) return;
    for (const event of events) {
      const body = event.body;
      if (
        body.type !== "task.completed" &&
        body.type !== "task.failed" &&
        body.type !== "task.canceled" &&
        body.type !== "task.interrupted"
      ) {
        continue;
      }
      const task = this.store.getTask(body.taskId);
      if (!task || (!task.subAgentId && !getWorkflowDeliveryRun(this.store, task.id) && !this.deps.parentDelivery.needsResult?.(task))) continue;
      const outcome: ChildOutcome =
        body.type === "task.completed"
          ? "completed"
          : body.type === "task.interrupted"
            ? "unknown"
            : isDeadlineCancel(task)
              ? "timeout"
              : "failed";
      void this.handleTerminal(task, outcome).catch((err) => this.log(`结果回传失败：${(err as Error).message}`));
    }
  }

  /** Recover terminal results and delivery bookkeeping without replaying model requests. */
  private async sweepPendingResults(): Promise<void> {
    // Recovery may clear claims before this sweep; historical ownership selects bookkeeping, not queue admission.
    const reportTasks = new Set((this.store.db.prepare(
      "SELECT DISTINCT task_id FROM events WHERE task_id IS NOT NULL AND json_extract(body, '$.type') = 'agent_report.changed'").all() as { task_id: string }[]).map(row => row.task_id));
    const pending = new Map<string, Task>();
    for (const task of this.store.listTasksByStatus(["completed", "failed", "canceled", "interrupted"])) {
      if (task.resultSummary === null && (task.subAgentId || reportTasks.has(task.id) || this.deps.parentDelivery.needsResult?.(task))) pending.set(task.id, task);
    }
    for (const task of pending.values()) {
      await this.handleTerminal(task, childOutcome(task));
    }
    await this.deps.parentDelivery.sweep();
  }


  private async handleTerminal(task: Task, outcome: ChildOutcome): Promise<void> {
    if (this.store.db.prepare("SELECT 1 FROM workflow_executions WHERE task_id = ?").get(task.id)) return;
    if (this.store.getTask(task.id)?.resultSummary != null) return;
    if (task.subAgentId) { await this.handleSubAgentTerminal(task, outcome); return; }
    const reply = outcome === "completed" ? this.deps.bridge.readTaskReply(task.id, 0, 4096)?.text.trim() || null : null;
    const summary = this.resultSummary(task, outcome, reply);
    const resultRef = JSON.stringify({ sessionId: task.sessionId, taskId: task.id, outcome });
    const recorded = this.store.withTx(() => {
      if (!this.store.setTaskResult(task.id, summary, resultRef)) return false;
      this.deps.parentDelivery.wakeTerminal(task, outcome);
      return true;
    });
    if (recorded) {
      await this.deps.parentDelivery.resultRecorded(task, outcome, summary);
      if (this.deps.parentDelivery.needsResult?.(task)) await this.deps.parentDelivery.sweep();
    }
  }

  /**
   * SubAgent 执行任务终态（agent-direction issue 11）：结果与空闲状态在同一
   * 事务登记——正常退出且占用已核实回收入 idle；执行单元尚未确认退出
   * （keepOccupancy）记 unverified。重复终态通知或补记只产生一份逻辑结果。
   * 不自动重试；后台异常沿用 interrupted/占用保留路径。
   */
  private async handleSubAgentTerminal(task: Task, outcome: ChildOutcome): Promise<void> {
    let work: WorkDelegation | null = null;
    let snapshotError: WorkspaceSnapshotError | WorkCopyError | null = null;
    try {
      work = task.workId ? this.store.getWorkDelegation(task.workId) : null;
      if (work) this.deps.subagents?.verifyWorkspace?.(work);
    }
    catch (error) {
      if (!(error instanceof WorkspaceSnapshotError || error instanceof WorkCopyError) ||
          !["target_corrupt", "snapshot_missing", "snapshot_corrupt", "snapshot_invalid", "snapshot_changed", "worktree_gone"].includes(error.code)) throw error;
      snapshotError = error;
      outcome = "failed";
    }
    const agent = this.store.getSubAgent(task.subAgentId!);
    if ((!work && !snapshotError) || !agent) {
      this.log(`SubAgent 任务 ${task.id} 缺少工作/身份记录，跳过结果登记`);
      return;
    }
    const workId = work?.id ?? task.workId!;
    const parentSessionId = work?.parentSessionId ?? agent.parentSessionId;
    const replyPage = outcome === "completed" ? this.deps.bridge.readTaskReply(task.id, 0, 4096) : null;
    const reply = replyPage?.text.trim() || null;
    // Note: 见 .agents/notes/implemented/architecture/2026-10-15-current-workspace-snapshots.md
    const summary = snapshotError ? `子任务结果不可核实：${snapshotError.code}；工作记录与副本已保留，请向拥有者报告并停止该项工作，未自动重放` : this.resultSummary(task, outcome, reply);
    // 宿主评审（issue 19）：定稿产物与 review 引用先落盘（补记重入时复用已定稿
    // 产物）；artifactIds 在其后计算，结果清单才包含刚定稿的评审产物
    // 结果引用：工作/身份/本次执行/原直接父任务/所属父会话分别核实
    const resultRef = JSON.stringify({
      sessionId: task.sessionId,
      taskId: task.id,
      workId,
      subAgentId: agent.id,
      parentSessionId,
      parentTaskId: task.parentTaskId,
      outcome,
      artifactIds: this.store
        .listArtifactsByTask(task.id)
        .filter((a) => !a.name.startsWith("prompt-snapshot:"))
        .map((a) => a.id),
      failure: snapshotError?.code ?? (outcome === "completed" ? null : (task.errorMessage ?? task.interruptReason ?? OUTCOME_TEXT[outcome])),
    });
    const recorded = this.store.withTx(() => {
      if (!this.store.setTaskResult(task.id, summary, resultRef)) return false;
      this.deps.parentDelivery.reserveResult?.(this.store.getTask(task.id)!);
      // 宿主评审任务带来源事件：与角色路径同一处回写入站终态并登记通知（issue 19）
      this.deps.subagents?.resultRecorded(task);
      const refs = { taskId: task.id, sessionId: parentSessionId };
      switch (outcome) {
        case "completed":
          this.store.appendEvent(
            {
              type: "subagent_task.completed",
              workId,
              subAgentId: agent.id,
              taskId: task.id,
              parentSessionId,
              parentTaskId: task.parentTaskId!,
              summary,
              resultRef,
            },
            refs,
          );
          break;
        case "failed":
          this.store.appendEvent(
            {
              type: "subagent_task.failed",
              workId,
              subAgentId: agent.id,
              taskId: task.id,
              parentSessionId,
              parentTaskId: task.parentTaskId!,
              errorMessage: snapshotError?.code ?? task.errorMessage ?? "已取消或失败",
            },
            refs,
          );
          break;
        case "timeout":
          this.store.appendEvent(
            {
              type: "subagent_task.timeout",
              workId,
              subAgentId: agent.id,
              taskId: task.id,
              parentSessionId,
              parentTaskId: task.parentTaskId!,
              deadline: task.deadline ?? "",
            },
            refs,
          );
          break;
        case "unknown":
          this.store.appendEvent(
            {
              type: "subagent_task.result_unknown",
              workId,
              subAgentId: agent.id,
              taskId: task.id,
              parentSessionId,
              parentTaskId: task.parentTaskId!,
              reason: task.interruptReason ?? "interrupted",
            },
            refs,
          );
          break;
      }
      return true;
    });
    if (!recorded) return;
    // 终态登记后冲刷待投递消息；异步准备后在事务内重核当前工作与活动执行。
    await this.deps.subagents?.flushPending(parentSessionId);
    await this.deps.parentDelivery.resultRecorded(task, outcome, summary);
  }

  private resultSummary(task: Task, outcome: ChildOutcome, reply: string | null): string {
    const cap = (s: string) => {
      const chars = [...s], suffix = "…（截断）";
      return chars.length > RESULT_SUMMARY_CAP ? chars.slice(0, RESULT_SUMMARY_CAP - suffix.length).join("") + suffix : s;
    };
    switch (outcome) {
      case "completed":
        return cap(reply || "（无文本输出）");
      case "failed":
        return cap(`子任务失败：${task.errorMessage ?? "已取消"}`);
      case "timeout":
        return `子任务超过截止时间 ${task.deadline ?? "?"}，已取消`;
      case "unknown":
        return "子任务被后台重启/中断，结果未知（未自动重放任何外部副作用）";
    }
  }

  // ---------- 超时巡检 ----------

  private async checkDeadlines(): Promise<void> {
    if (!this.started) return;
    const now = new Date().toISOString();
    for (const task of this.store.listOverdueTasks(now)) {
      try {
        // 取消原因持久化（deadline_exceeded）：canceled 事件与启动巡检据此判定 timeout
        await this.deps.bridge.cancelTask(task.id, DEADLINE_REASON);
      } catch {
        // 已到终态等竞争路径，交还给事件/巡检
      }
    }
  }
}
