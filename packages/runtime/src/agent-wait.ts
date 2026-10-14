/** 等待只让出当前父轮资源；结果路由和后台工作仍由原有编排器持有。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md
 */
import type { Store } from "@ruukoto/core/store.ts";
import type { PersistentEvent, Task } from "@ruukoto/core/types.ts";
import { isTerminalTaskStatus } from "@ruukoto/core/types.ts";
import { AgentWaitError, agentReportKey, claimAgentReports, endAgentWait, getAgentReport, getAgentWait, listAgentReports, listAgentWaits,
  registerAgentReport, registerAgentWait, sameAgentReportSource, setAgentWaitPhase, bindAgentReportFallback,
  type AgentReport, type AgentWaitSnapshot, type AgentWaitTarget } from "@ruukoto/core/agent-wait.ts";
import { getWorkflowQuestion, listWorkflowExecutions, listWorkflowSteps, requireWorkflowRun, workflowTerminal, type WorkflowSource } from "@ruukoto/core/workflow.ts";
import type { AgentWaitResult, AgentWaitTargetState } from "@ruukoto/agent/agent-wait-tools.ts";
import type { HostToolContext } from "@ruukoto/agent/host-tool-families.ts";

interface WaitDeps {
  store: Store;
  source(target: AgentWaitTarget, parent: Task): WorkflowSource;
  verify(source: WorkflowSource, target: AgentWaitTarget): boolean;
  snapshot(task: Task): AgentWaitSnapshot;
  yieldWorkspace(task: Task): Promise<boolean>;
  kick(): void;
  subscribe(listener: (events: PersistentEvent[]) => void): void;
  unsubscribe(listener: (events: PersistentEvent[]) => void): void;
}

export function agentWaitGroupTargets(store: Store, taskId: string): AgentWaitTarget[] {
  return [...new Map(listAgentWaits(store, { taskId }).flatMap(wait => wait.targets)
    .map(target => [target.kind === "task" ? `task:${target.taskId}` : `workflow:${target.runId}`, target])).values()];
}

export function agentWaitTargetsReady(store: Store, targets: AgentWaitTarget[]): boolean {
  return targets.every(target => {
    if (target.kind === "task") {
      const task = store.getTask(target.taskId);
      return Boolean(task && isTerminalTaskStatus(task.status) && task.resultSummary !== null);
    }
    const run = requireWorkflowRun(store, target.runId);
    return workflowTerminal(run.status) && !(run.scriptUnits.length > 0 && run.scriptStopVerified === null) &&
      listWorkflowExecutions(store, run.id).every(execution => {
        const task = store.getTask(execution.taskId);
        return Boolean(task && !["running", "awaiting_confirmation"].includes(task.status));
      });
  });
}

export class RuntimeAgentWait {
  private readonly active = new Map<string, () => void>();
  constructor(private readonly deps: WaitDeps) {}

  /** 在既有终态路由的事务内先预留；已开始的独立汇总保持原报告权。 */
  reserve(report: AgentReport): AgentReport[] {
    if (report.status !== "pending" || report.claimTaskId || report.fallbackState === "running" || report.fallbackState === "completed") return [];
    const target: AgentWaitTarget = report.target.kind === "task" ? report.target : { kind: "workflow", runId: report.target.runId };
    const wait = listAgentWaits(this.deps.store, { sessionId: report.parentSessionId }).find(candidate => candidate.phase !== "ended" &&
      candidate.targets.some(item => item.kind === target.kind && (item.kind === "task" && target.kind === "task" ? item.taskId === target.taskId : item.kind === "workflow" && target.kind === "workflow" && item.runId === target.runId)));
    if (!wait || !sameAgentReportSource(wait.source, report.source)) return [];
    const parent = this.deps.store.getTask(wait.taskId);
    if (!parent || parent.cancelRequested || !["running", "awaiting_confirmation"].includes(parent.status) ||
        parent.permissionVersion !== wait.snapshot.permissionVersion || !this.deps.verify(report.source, target)) return [];
    const first = listAgentWaits(this.deps.store, { sessionId: report.parentSessionId }).find(candidate => candidate.targets.some(item => item.kind === target.kind &&
      (item.kind === "task" && target.kind === "task" ? item.taskId === target.taskId : item.kind === "workflow" && target.kind === "workflow" && item.runId === target.runId)));
    const original = first ? this.deps.store.getTask(first.taskId) : null;
    // 终态预留不能把旧父组拆给新主轮；整组接管及其实际输入只在等待工具返回时完成。
    if (first && original && first.taskId !== parent.id && isTerminalTaskStatus(original.status)) return [];
    const group = report.fallbackTaskId ? listAgentReports(this.deps.store).filter(item => item.fallbackTaskId === report.fallbackTaskId && item.status === "pending") : [report];
    if (group.some(item => item.consumption && item.consumption.taskId !== parent.id)) return [];
    if (group.some(item => !wait.targets.some(candidate => candidate.kind === item.target.kind &&
      (candidate.kind === "task" && item.target.kind === "task" ? candidate.taskId === item.target.taskId : candidate.kind === "workflow" && item.target.kind === "workflow" && candidate.runId === item.target.runId)) ||
      !this.deps.verify(item.source, item.target))) return [];
    return claimAgentReports(this.deps.store, { taskId: parent.id, keys: group.map(item => item.key) });
  }

  private state(target: AgentWaitTarget): AgentWaitTargetState {
    const store = this.deps.store;
    if (target.kind === "task") {
      const task = store.getTask(target.taskId);
      if (!task) throw new AgentWaitError("target_missing");
      const held = store.listAllOccupancy().some(occupancy => occupancy.taskId === task.id);
      const artifacts = store.listArtifactsByTask(task.id);
      return { ...target, status: task.status, resultSummary: isTerminalTaskStatus(task.status) ? task.resultSummary : null,
        stopVerified: isTerminalTaskStatus(task.status) ? !held : null, effectUnknown: task.effectUnknown,
        artifactIds: artifacts.slice(0, 100).map(artifact => artifact.id), artifactCount: artifacts.length,
        ...(task.status === "awaiting_confirmation" ? { attention: "tool_approval" } : held && isTerminalTaskStatus(task.status) ? { attention: "stop_unverified" } : {}) };
    }
    const run = requireWorkflowRun(store, target.runId), executions = listWorkflowExecutions(store, run.id), steps = listWorkflowSteps(store, run.id);
    const artifacts = steps.flatMap(step => step.outputArtifact ? [step.outputArtifact.id] : []);
    const unsettled = executions.some(execution => {
      const task = store.getTask(execution.taskId);
      return !task || ["running", "awaiting_confirmation"].includes(task.status);
    }) || (run.scriptUnits.length > 0 && run.scriptStopVerified === null);
    const attention = run.status === "paused" ? "paused" : steps.some(step => getWorkflowQuestion(store, run.id, step.key)?.status === "pending") ? "owner_question"
      : executions.some(execution => store.getTask(execution.taskId)?.status === "awaiting_confirmation") ? "tool_approval"
      : run.scriptStopVerified === false || executions.some(execution => execution.stopVerified === false) ? "stop_unverified" : null;
    return { ...target, status: run.status, ...(run.terminalVersion !== undefined ? { terminalVersion: run.terminalVersion } : {}),
      resultSummary: workflowTerminal(run.status) && !unsettled ? JSON.stringify({ status: run.status, reason: run.reason, result: run.result,
        steps: steps.map(step => ({ key: step.key, status: step.status, result: step.result, artifact: step.outputArtifact })) }).slice(0, 16 * 1024) : null,
      stopVerified: run.scriptStopVerified === true && executions.every(execution => execution.status === "queued" || execution.stopVerified === true),
      effectUnknown: executions.some(execution => store.getTask(execution.taskId)?.effectUnknown),
      artifactIds: artifacts.slice(0, 100), artifactCount: artifacts.length, ...(attention ? { attention } : {}) };
  }

  private result(task: Task, targets: AgentWaitTarget[], source: WorkflowSource): AgentWaitResult | null {
    const states = targets.map(target => {
      if (!this.deps.verify(source, target)) throw new AgentWaitError("source_invalid");
      return this.state(target);
    });
    const ready = states.filter(state => state.resultSummary !== null && state.resultSummary !== undefined);
    const reportTargets = new Map<string, AgentWaitTargetState>();
    let pendingOwner = false;
    if (ready.length) this.deps.store.withTx(() => {
      const continued = new Map<string, AgentReport>();
      for (const state of ready) {
        const target = state.kind === "task" ? { kind: "task" as const, taskId: state.taskId }
          : { kind: "workflow" as const, runId: state.runId, terminalVersion: state.terminalVersion! };
        const report = registerAgentReport(this.deps.store, { target, source, parentSessionId: task.sessionId });
        const previous = target.kind === "workflow" ? requireWorkflowRun(this.deps.store, target.runId).delivery?.taskId
          : this.deps.store.findTaskByRequest(task.sessionId, `wake:${target.taskId}`)?.id;
        if (previous && !report.fallbackTaskId) bindAgentReportFallback(this.deps.store, report.key, previous);
        this.reserve(listAgentReports(this.deps.store).find(item => item.key === report.key)!);
        const first = listAgentWaits(this.deps.store, { sessionId: task.sessionId }).find(wait => wait.targets.some(item => item.kind === target.kind &&
          (item.kind === "task" && target.kind === "task" ? item.taskId === target.taskId : item.kind === "workflow" && target.kind === "workflow" && item.runId === target.runId)));
        const original = first ? this.deps.store.getTask(first.taskId) : null;
        if (first && original && first.taskId !== task.id && isTerminalTaskStatus(original.status) && report.status === "pending") {
          const groupTargets = agentWaitGroupTargets(this.deps.store, first.taskId);
          if (agentWaitTargetsReady(this.deps.store, groupTargets)) for (const member of groupTargets) {
            if (!this.deps.verify(source, member)) throw new AgentWaitError("source_invalid");
            const item = registerAgentReport(this.deps.store, { parentSessionId: task.sessionId, source,
              target: member.kind === "task" ? member : { ...member, terminalVersion: requireWorkflowRun(this.deps.store, member.runId).terminalVersion! } });
            if (item.status === "pending") continued.set(item.key, item);
          }
        }
      }
      if (continued.size) {
        for (const item of listAgentReports(this.deps.store, { taskId: task.id }).filter(item => item.status === "pending" && item.claimTaskId === task.id)) continued.set(item.key, item);
        if (continued.size > 20) throw new AgentWaitError("report_group_limit");
        pendingOwner = [...continued.values()].some(item => item.claimTaskId && item.claimTaskId !== task.id || item.fallbackState === "running" || item.fallbackState === "completed");
        if (!pendingOwner) {
          const claimed = claimAgentReports(this.deps.store, { taskId: task.id, keys: [...continued.keys()] });
          for (const member of claimed) reportTargets.set(member.key, { ...this.state(member.target), reportOwnerTaskId: task.id });
        }
      }
      for (const state of ready) {
        const current = getAgentReport(this.deps.store, agentReportKey(state.kind === "task" ? state : { ...state, terminalVersion: state.terminalVersion! }))!;
        state.reportOwnerTaskId = current.claimTaskId ?? current.fallbackTaskId ?? current.consumption?.taskId ?? current.proof?.taskId ?? null;
      }
    });
    if (pendingOwner) return null;
    return ready.length ? { reason: "result", targets: states, ...(reportTargets.size ? { reportTargets: [...reportTargets.values()] } : {}) }
      : states.some(state => state.attention) ? { reason: "attention", targets: states } : null;
  }

  /** 新可信拥有者消息已提交后调用；解除等待先于 SDK abort，后台执行不级联取消。 */
  interrupt(taskId: string, reason: string): boolean {
    const waits = listAgentWaits(this.deps.store, { taskId }).filter(wait => wait.phase !== "ended");
    if (!waits.length) return false;
    this.deps.store.withTx(() => { for (const wait of waits) endAgentWait(this.deps.store, wait.id, reason); });
    this.active.get(taskId)?.();
    return true;
  }

  async wait(ctx: HostToolContext, sdkCallId: string, targets: AgentWaitTarget[], timeoutMs: number, signal?: AbortSignal): Promise<AgentWaitResult> {
    const store = this.deps.store, task = store.getTask(ctx.taskId);
    if (!task || task.sessionId !== ctx.sessionId || task.cancelRequested || !["running", "awaiting_confirmation"].includes(task.status)) throw new AgentWaitError("task_inactive");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !targets.length || targets.length > 20) throw new AgentWaitError("targets_invalid");
    const source = this.deps.source(targets[0], task);
    if (targets.some(target => !sameAgentReportSource(source, this.deps.source(target, task)))) throw new AgentWaitError("source_mismatch");
    let notify!: () => void;
    let changed = new Promise<void>(resolve => { notify = resolve; });
    const listener = () => notify();
    this.deps.subscribe(listener);
    this.active.set(task.id, listener);
    const timer = setTimeout(() => { timedOut = true; notify(); }, timeoutMs);
    let timedOut = false;
    signal?.addEventListener("abort", listener, { once: true });
    try {
      store.withTx(() => registerAgentWait(store, { id: ctx.hostOpId, taskId: task.id, sessionId: task.sessionId, sdkCallId,
        deadline: new Date(Date.now() + timeoutMs).toISOString(), targets, source, snapshot: this.deps.snapshot(task) }));
      if (!await this.deps.yieldWorkspace(task)) {
        store.withTx(() => endAgentWait(store, ctx.hostOpId, "stop_unverified"));
        throw new AgentWaitError("stop_unverified");
      }
      store.withTx(() => {
        const current = getAgentWait(store, ctx.hostOpId)!;
        if (current.phase === "ended" || signal?.aborted) return;
        store.releaseOccupancy(task.id);
        setAgentWaitPhase(store, current.id, "waiting");
      });
      this.deps.kick();
      for (;;) {
        const current = store.getTask(task.id), wait = getAgentWait(store, ctx.hostOpId)!;
        if (!current || current.cancelRequested || current.permissionVersion !== task.permissionVersion || wait.phase === "ended" || signal?.aborted) {
          store.withTx(() => endAgentWait(store, ctx.hostOpId, wait.reason ?? "interrupted"));
          return { reason: "interrupted", targets: targets.map(target => this.state(target)) };
        }
        const result = this.result(current, targets, source);
        if (result || timedOut) {
          const answer = result ?? { reason: "timeout" as const, targets: targets.map(target => this.state(target)) };
          store.withTx(() => endAgentWait(store, ctx.hostOpId, answer.reason));
          return answer;
        }
        await changed;
        changed = new Promise<void>(resolve => { notify = resolve; });
      }
    } catch (error) {
      if (getAgentWait(store, ctx.hostOpId)) store.withTx(() => endAgentWait(store, ctx.hostOpId, error instanceof AgentWaitError ? error.code : "wait_failed"));
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", listener);
      this.deps.unsubscribe(listener);
      this.active.delete(task.id);
    }
  }
}
