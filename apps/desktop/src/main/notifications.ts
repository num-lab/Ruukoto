import { ViewState, formatTaskStatus } from "@ruukoto/view/state.ts";
import { TERMINAL_TASK_STATUSES } from "@ruukoto/core/task-status.ts";
import type { TaskStatus } from "@ruukoto/core/types.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import type { CodeScheduleRun } from "@ruukoto/core/code-scheduler.ts";
import type { DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";

export interface DesktopNotice { target: DesktopTarget; instanceId: string; sessionId: string; taskId: string; title: string; body: string }
interface Observation {
  view: ViewState;
  generation: number;
  silentThrough: number;
  approvals: Set<string>;
  terminals: Set<string>;
  watching: Set<string>;
  runs: Map<string, CodeScheduleRun>;
  runTerminals: Set<string>;
}

// Note: See .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class DesktopNotifications {
  private readonly targets = new Map<DesktopTarget, Observation>();
  constructor(private readonly focused: () => boolean, private readonly show: (notice: DesktopNotice) => void, private readonly badge: (count: number) => void, private readonly query: (target: DesktopTarget, taskId: string) => Promise<OpResult<"get_task">>, private readonly querySchedule?: (planId: string, offset: number) => Promise<OpResult<"code_schedule">>) {}
  update(target: DesktopTarget, update: DesktopUpdate): void {
    if (update.type !== "snapshot" && update.type !== "event") return;
    let observation = this.targets.get(target);
    if (update.type === "snapshot") {
      const fresh = !observation || observation.view.instanceId !== update.result.snapshot.instanceId;
      if (fresh) {
        observation = { view: new ViewState(), generation: 0, silentThrough: update.result.seq, approvals: new Set(), terminals: new Set(), watching: new Set(), runs: new Map(), runTerminals: new Set() };
        this.targets.set(target, observation);
      }
      const current = observation!;
      ++current.generation;
      current.view.applySnapshot(update.result, fresh);
      for (const run of update.result.snapshot.codeScheduleRuns ?? []) this.acceptRun(target, current, run, fresh);
      this.scan(target, current, fresh);
      if (!fresh) void this.recover(target, current, current.generation);
    } else if (observation) {
      observation.view.applyEvent(update.event, update.kind);
      const silent = update.kind === "replay" && update.event.seq <= observation.silentThrough;
      const body = update.event.body;
      if (body.type === "code_schedule.run_changed") this.acceptRun(target, observation, body.run, silent);
      const status = body.type === "task.completed" ? "completed" : body.type === "task.failed" ? "failed" : body.type === "task.canceled" ? "canceled" : body.type === "task.interrupted" || body.type === "task.mode_switch_failed" ? "interrupted" : null;
      if (status && update.event.taskId) {
        const task = observation.view.getTask(update.event.taskId);
        const sessionId = task?.sessionId ?? update.event.sessionId;
        if (sessionId) this.terminal(target, observation, update.event.taskId, sessionId, task && TERMINAL_TASK_STATUSES.includes(task.status) ? task.status : status, silent, body.type === "task.mode_switch_failed" ? body.reason : undefined);
      }
      this.scan(target, observation, silent);
    }
    this.updateBadge();
  }
  private updateBadge(): void { this.badge([...this.targets.values()].reduce((count, item) => count + item.view.pendingApprovals().length, 0)); }
  private notice(target: DesktopTarget, observation: Observation, sessionId: string, taskId: string, title: string, body: string, silent: boolean): void {
    if (silent || this.focused()) return;
    try { this.show({ target, instanceId: observation.view.instanceId!, sessionId, taskId, title: `ruukoto · ${title}`, body }); }
    catch { process.stderr.write("[ruukoto:desktop] System notification not delivered; check system notification settings.\n"); }
  }
  private terminal(target: DesktopTarget, observation: Observation, taskId: string, sessionId: string, status: TaskStatus, silent: boolean, reason?: string): void {
    observation.watching.delete(taskId);
    if (observation.terminals.has(taskId)) return;
    observation.terminals.add(taskId);
    if (observation.view.getTask(taskId)?.codeScheduleRunId || [...observation.runs.values()].some(run => run.rootTaskId === taskId) || observation.view.sessions.some(session => session.id === sessionId && session.codeScheduleActive)) return;
    if (status !== "canceled") this.notice(target, observation, sessionId, taskId, `Task ${formatTaskStatus(status)}`, reason ? `Mode switch failed: ${reason}` : "Click to open the chat.", silent);
  }
  private scheduleTerminal(target: DesktopTarget, observation: Observation, run: CodeScheduleRun, silent: boolean): void {
    if (!run.closedAt || observation.runTerminals.has(run.id)) return;
    observation.runTerminals.add(run.id);
    if (run.status !== "canceled") this.notice(target, observation, run.sessionId, run.rootTaskId, `Scheduled run ${formatTaskStatus(run.status === "active" ? "interrupted" : run.status)}`, run.snapshot.title, silent);
  }
  private acceptRun(target: DesktopTarget, observation: Observation, run: CodeScheduleRun, silent: boolean): void {
    const known = observation.runs.get(run.id);
    if (known && known.version > run.version) return;
    observation.runs.set(run.id, run); this.scheduleTerminal(target, observation, run, silent);
  }
  private scan(target: DesktopTarget, observation: Observation, silent: boolean): void {
    for (const approval of observation.view.pendingApprovals()) {
      if (observation.approvals.has(approval.id)) continue;
      observation.approvals.add(approval.id);
      this.notice(target, observation, approval.sessionId, approval.taskId, "Pending approval", approval.toolName, silent);
    }
    for (const task of observation.view.tasks.values()) {
      if (TERMINAL_TASK_STATUSES.includes(task.status)) this.terminal(target, observation, task.id, task.sessionId, task.status, silent);
      else if (!observation.terminals.has(task.id)) observation.watching.add(task.id);
    }
  }
  private async recover(target: DesktopTarget, observation: Observation, generation: number): Promise<void> {
    const missing = [...observation.watching].filter(id => !observation.view.getTask(id));
    for (const id of missing) {
      let detail: OpResult<"get_task">;
      try { detail = await this.query(target, id); }
      catch { continue; } // A later same-instance snapshot rechecks retained observations.
      if (this.targets.get(target) !== observation || observation.generation !== generation) return;
      observation.view.installTaskDetail(detail.task, detail.toolOps, detail.outputPreview, detail.seq);
      this.scan(target, observation, false);
    }
    if (!this.querySchedule) return;
    for (const run of observation.runs.values()) {
      if (run.closedAt) continue;
      let offset: number | null = 0;
      do {
        let detail: OpResult<"code_schedule">;
        try { detail = await this.querySchedule(run.scheduleId, offset); }
        catch { break; } // Retain this run for the next same-instance snapshot.
        if (this.targets.get(target) !== observation || observation.generation !== generation) return;
        const current = detail.runs.find(item => item.id === run.id);
        if (current) { this.acceptRun(target, observation, current, false); break; }
        offset = detail.nextRunOffset;
      } while (offset !== null);
    }
  }
}
