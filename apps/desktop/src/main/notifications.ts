import { ViewState, formatTaskStatus } from "@ruukoto/view/state.ts";
import { TERMINAL_TASK_STATUSES } from "@ruukoto/core/task-status.ts";
import type { TaskStatus } from "@ruukoto/core/types.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import type { DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";

export interface DesktopNotice { target: DesktopTarget; instanceId: string; sessionId: string; taskId: string; title: string; body: string }
interface Observation {
  view: ViewState;
  generation: number;
  silentThrough: number;
  approvals: Set<string>;
  terminals: Set<string>;
  watching: Set<string>;
}

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class DesktopNotifications {
  private readonly targets = new Map<DesktopTarget, Observation>();
  constructor(private readonly focused: () => boolean, private readonly show: (notice: DesktopNotice) => void, private readonly badge: (count: number) => void, private readonly query: (target: DesktopTarget, taskId: string) => Promise<OpResult<"get_task">>) {}
  update(target: DesktopTarget, update: DesktopUpdate): void {
    if (update.type !== "snapshot" && update.type !== "event") return;
    let observation = this.targets.get(target);
    if (update.type === "snapshot") {
      const fresh = !observation || observation.view.instanceId !== update.result.snapshot.instanceId;
      if (fresh) {
        observation = { view: new ViewState(), generation: 0, silentThrough: update.result.seq, approvals: new Set(), terminals: new Set(), watching: new Set() };
        this.targets.set(target, observation);
      }
      const current = observation!;
      ++current.generation;
      current.view.applySnapshot(update.result, fresh);
      this.scan(target, current, fresh);
      if (!fresh) void this.recover(target, current, current.generation);
    } else if (observation) {
      observation.view.applyEvent(update.event, update.kind);
      const silent = update.kind === "replay" && update.event.seq <= observation.silentThrough;
      const body = update.event.body;
      const status = body.type === "task.completed" ? "completed" : body.type === "task.failed" ? "failed" : body.type === "task.canceled" ? "canceled" : body.type === "task.interrupted" || body.type === "task.mode_switch_failed" ? "interrupted" : null;
      if (status && update.event.taskId) {
        const task = observation.view.getTask(update.event.taskId);
        const sessionId = task?.sessionId ?? update.event.sessionId;
        if (sessionId) this.terminal(target, observation, update.event.taskId, sessionId, task && TERMINAL_TASK_STATUSES.includes(task.status) ? task.status : status, silent, body.type === "task.mode_switch_failed" ? body.reason : undefined);
      }
      this.scan(target, observation, silent);
    }
    this.badge([...this.targets.values()].reduce((count, item) => count + item.view.pendingApprovals().length, 0));
  }
  private notice(target: DesktopTarget, observation: Observation, sessionId: string, taskId: string, title: string, body: string, silent: boolean): void {
    if (silent || this.focused()) return;
    try { this.show({ target, instanceId: observation.view.instanceId!, sessionId, taskId, title: `${target === "code" ? "Code" : "Personal"} · ${title}`, body }); }
    catch { process.stderr.write("[ruukoto:desktop] 系统通知未送达；请检查系统通知设置。\n"); }
  }
  private terminal(target: DesktopTarget, observation: Observation, taskId: string, sessionId: string, status: TaskStatus, silent: boolean, reason?: string): void {
    observation.watching.delete(taskId);
    if (observation.terminals.has(taskId)) return;
    observation.terminals.add(taskId);
    if (status !== "canceled") this.notice(target, observation, sessionId, taskId, `任务${formatTaskStatus(status)}`, reason ? `模式切换失败：${reason}` : "点击查看对应会话。", silent);
  }
  private scan(target: DesktopTarget, observation: Observation, silent: boolean): void {
    for (const approval of observation.view.pendingApprovals()) {
      if (observation.approvals.has(approval.id)) continue;
      observation.approvals.add(approval.id);
      this.notice(target, observation, approval.sessionId, approval.taskId, "待处理审批", approval.toolName, silent);
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
      catch { continue; } // 查询失败保留观察记录，下一次同实例快照再核实。
      if (this.targets.get(target) !== observation || observation.generation !== generation) return;
      observation.view.installTaskDetail(detail.task, detail.toolOps, detail.outputPreview, detail.seq);
      this.scan(target, observation, false);
    }
  }
}
