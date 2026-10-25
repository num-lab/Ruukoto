/** Code 计划的时间推进与接纳；timer 只唤醒，所有执行归属由 SQLite 仲裁。
 * Note: 见 .agents/notes/implemented/feature/2026-10-25-code-scheduled.md
 */
import { isDeepStrictEqual } from "node:util";
import { CodeScheduleError, closeCodeScheduleRun, codeScheduleDigest, coalesceCodeScheduleRun, controlCodeSchedule, findCodeScheduleReceipt, getCodeSchedule, getOpenCodeScheduleRunForPlan, listCodeScheduleRuns, listCodeSchedules, listDueCodeSchedules, listOpenCodeScheduleRuns, parseCodeScheduleConfig, pauseCodeSchedule, registerCodeScheduleRun, saveCodeSchedule, updateCodeScheduleRun, type CodeScheduleConfig, type CodeSchedulePlan, type CodeScheduleRun } from "@ruukoto/core/code-scheduler.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { DirIdentityError, verifyDirIdentitySync, type DirIdentity } from "@ruukoto/core/dir-identity.ts";
import type { Store } from "@ruukoto/core/store.ts";
import { randomId } from "@ruukoto/core/types.ts";
import { frameBytes } from "@ruukoto/core/views.ts";
import { firstDue, latestAtOrBefore, nextAfter, parseRule, RuleError } from "@ruukoto/channels/scheduler/time.ts";
import { ModelSelectionError } from "@ruukoto/agent/model-selection.ts";
import { ExecutionError } from "@ruukoto/agent/execution/launchers.ts";

export interface CodeScheduleOutcome {
  status?: Exclude<CodeScheduleRun["status"], "active">;
  reason: string | null;
  recovery?: "effect_unknown" | "stop_unverified";
  canAcknowledge?: boolean;
}
interface Deps {
  store: Store;
  prepare(config: CodeScheduleConfig, workspace: DirIdentity): Promise<() => void>;
  outcome(run: CodeScheduleRun): CodeScheduleOutcome;
  cancel(run: CodeScheduleRun): Promise<void>;
  kick(sessionId: string): void;
  now?: () => number;
  tickMs?: number;
}

export class CodeScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private pending = false;
  private stopped = false;
  private readonly now: () => number;
  constructor(private readonly deps: Deps) { this.now = deps.now ?? Date.now; }
  start(): void {
    this.timer = setInterval(() => this.kick(), this.deps.tickMs ?? 1000);
    this.timer.unref();
    this.kick();
  }
  kick(): void {
    if (this.stopped || this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (this.stopped || this.running) return;
      void this.scan().catch(error => {
        process.stderr.write(`[ruukoto:code-scheduler] 调度推进失败，原接纳事实保留；检查存储与运行记录后恢复：${error instanceof CodeScheduleError || error instanceof RuntimeApiError ? error.code : "store_failed"}\n`);
      });
    });
  }
  async scan(): Promise<void> {
    if (this.stopped) return;
    if (this.running) { await this.running; return this.scan(); }
    const operation = this.scanOnce();
    this.running = operation;
    try { await operation; }
    finally { this.running = null; }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => {
      // 扫描失败已由唤醒入口报告；停止只等待在途事务，不重试接纳。
    });
  }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private workspace(config: CodeScheduleConfig): DirIdentity {
    const registered = this.deps.store.getProject(config.workspaceId)?.rootDir;
    if (!registered) throw new CodeScheduleError("schedule_workspace_invalid", "工作区未登记根目录；请重新选择工作区。");
    try { verifyDirIdentitySync(registered); }
    catch (error) {
      if (!(error instanceof DirIdentityError)) throw error;
      throw new CodeScheduleError("schedule_workspace_invalid", "工作区目录已失效；请检查原目录后重新选择工作区。");
    }
    return registered;
  }
  private rule(config: CodeScheduleConfig): CodeScheduleConfig {
    const parsed = parseCodeScheduleConfig(config);
    try { return { ...parsed, rule: parseRule(parsed.rule) }; }
    catch (error) {
      if (!(error instanceof RuleError)) throw error;
      throw new CodeScheduleError("invalid_schedule_rule", "时间规则无效；请核对日期、时间、星期与时区。");
    }
  }
  private original(requestId: string, digest: string) {
    const original = findCodeScheduleReceipt(this.deps.store, requestId);
    if (original && original.digest !== digest) throw new CodeScheduleError("request_conflict");
    return original;
  }
  async save(input: { requestId: string; planId?: string; expectedVersion?: number; config: CodeScheduleConfig }) {
    const config = this.rule(input.config);
    const original = this.original(input.requestId, codeScheduleDigest({ operation: input.planId ? "update" : "create", planId: input.planId ?? null, expectedVersion: input.expectedVersion ?? null, config }));
    if (original) return original;
    const workspace = this.workspace(config), check = await this.deps.prepare(config, workspace);
    return this.deps.store.withTx(() => {
      if (this.stopped) throw new RuntimeApiError("stopping", "后台正在停止，计划未保存。");
      check();
      if (!isDeepStrictEqual(this.workspace(config), workspace)) throw new CodeScheduleError("schedule_workspace_invalid");
      const now = this.iso(), nextDueAt = firstDue(config.rule, Date.parse(now));
      if (nextDueAt <= now) throw new CodeScheduleError("schedule_date_elapsed", "一次性时间必须在未来；请调整日期后保存。");
      return saveCodeSchedule(this.deps.store, { ...input, config, workspace, nextDueAt, now });
    });
  }
  list(input: { offset?: number; limit?: number; scope?: "current" | "history" } = {}) {
    const result = listCodeSchedules(this.deps.store, input), plans: CodeSchedulePlan[] = [], latestRuns: CodeScheduleRun[] = [];
    let bytes = 128;
    for (const plan of result.plans) {
      const latest = listCodeScheduleRuns(this.deps.store, { planId: plan.id, limit: 1 }).runs[0];
      const size = frameBytes(plan) + (latest ? frameBytes(latest) : 0);
      if (bytes + size > 384 * 1024) break;
      plans.push(plan); bytes += size;
      if (latest) latestRuns.push(latest);
    }
    return { plans, latestRuns, nextOffset: plans.length < result.plans.length ? (input.offset ?? 0) + plans.length : result.nextOffset };
  }
  get(input: { planId: string; runOffset?: number }) {
    const plan = getCodeSchedule(this.deps.store, input.planId);
    if (!plan) throw new CodeScheduleError("schedule_not_found");
    const result = listCodeScheduleRuns(this.deps.store, { planId: plan.id, offset: input.runOffset, limit: 20 }), runs: CodeScheduleRun[] = [];
    let bytes = frameBytes(plan) + 128;
    for (const run of result.runs) {
      const size = frameBytes(run);
      if (bytes + size > 512 * 1024) break;
      runs.push(run); bytes += size;
    }
    return { plan, runs, nextRunOffset: runs.length < result.runs.length ? (input.runOffset ?? 0) + runs.length : result.nextOffset, activeRun: getOpenCodeScheduleRunForPlan(this.deps.store, plan.id) };
  }
  find(input: { requestId: string }) { return { receipt: findCodeScheduleReceipt(this.deps.store, input.requestId) }; }
  async control(input: { requestId: string; planId: string; expectedVersion: number; control: "pause" | "resume" | "cancel"; acknowledgeRunId?: string; expectedRunVersion?: number }) {
    const original = this.original(input.requestId, codeScheduleDigest({ operation: input.control, planId: input.planId, expectedVersion: input.expectedVersion, acknowledgeRunId: input.acknowledgeRunId ?? null, expectedRunVersion: input.expectedRunVersion ?? null }));
    if (original) {
      if (original.operation === "cancel" && original.run && !original.run.closedAt) await this.deps.cancel(original.run);
      return original;
    }
    const plan = getCodeSchedule(this.deps.store, input.planId);
    if (!plan) throw new CodeScheduleError("schedule_not_found");
    const check = input.control === "resume" && !(input.acknowledgeRunId && plan.config.rule.kind === "once") ? await this.deps.prepare(plan.config, this.workspace(plan.config)) : null;
    const result = this.deps.store.withTx(() => {
      if (this.stopped) throw new RuntimeApiError("stopping", "后台正在停止，计划操作未接纳。");
      check?.();
      if (check && !isDeepStrictEqual(this.workspace(plan.config), plan.workspace)) throw new CodeScheduleError("schedule_workspace_invalid");
      const run = getOpenCodeScheduleRunForPlan(this.deps.store, plan.id);
      if (input.acknowledgeRunId && (!run || run.id !== input.acknowledgeRunId || !this.deps.outcome(run).canAcknowledge)) throw new CodeScheduleError("schedule_stop_unverified", "本轮仍有活动或停止未核实；先停止并核实本轮，再确认仅开放未来周期。");
      return controlCodeSchedule(this.deps.store, { ...input, nextDueAt: nextAfter(plan.config.rule, this.now()), now: this.iso() });
    });
    if (input.control === "cancel" && result.run && !result.run.closedAt) await this.deps.cancel(result.run);
    this.kick();
    return result;
  }
  private async scanOnce(): Promise<void> {
    const { store } = this.deps;
    for (const run of listOpenCodeScheduleRuns(store)) {
      if (this.stopped) return;
      if (run.cancelRequested) await this.deps.cancel(run);
      const result = this.deps.outcome(run);
      store.withTx(() => {
        if (result.recovery) {
          updateCodeScheduleRun(store, { runId: run.id, reason: result.recovery });
          pauseCodeSchedule(store, { planId: run.scheduleId, reason: result.recovery, now: this.iso() });
        } else if (result.status) closeCodeScheduleRun(store, { runId: run.id, status: result.status, reason: result.reason, now: this.iso() });
        else updateCodeScheduleRun(store, { runId: run.id, reason: result.reason });
      });
    }
    for (const plan of listDueCodeSchedules(store, this.iso())) {
      if (this.stopped) return;
      const open = getOpenCodeScheduleRunForPlan(store, plan.id);
      if (open) {
        store.withTx(() => coalesceCodeScheduleRun(store, { runId: open.id, through: latestAtOrBefore(plan.config.rule, this.now())!, nextDueAt: nextAfter(plan.config.rule, this.now()), expectedVersion: plan.version, now: this.iso() }));
        continue;
      }
      let check: () => void;
      try {
        const workspace = this.workspace(plan.config);
        if (!isDeepStrictEqual(workspace, plan.workspace)) throw new CodeScheduleError("schedule_workspace_invalid");
        check = await this.deps.prepare(plan.config, workspace);
      } catch (error) {
        if (error instanceof RuntimeApiError && ["model_config_busy", "stopping"].includes(error.code)) continue;
        if (!(error instanceof CodeScheduleError) && !(error instanceof DirIdentityError) && !(error instanceof ModelSelectionError) && !(error instanceof ExecutionError) && !(error instanceof RuntimeApiError)) throw error;
        const reason = error instanceof DirIdentityError ? "schedule_workspace_invalid" : error.code;
        store.withTx(() => {
          const current = getCodeSchedule(store, plan.id);
          if (!current || current.version !== plan.version || current.status !== "active") return;
          const run = this.admit(plan);
          store.endTask(run.rootTaskId, ["queued"], "failed", { errorMessage: reason });
          pauseCodeSchedule(store, { planId: plan.id, reason, now: this.iso() });
          closeCodeScheduleRun(store, { runId: run.id, status: "failed", reason, now: this.iso() });
        });
        continue;
      }
      const run = store.withTx(() => {
        const current = getCodeSchedule(store, plan.id);
        if (this.stopped || !current || current.version !== plan.version || current.status !== "active" || getOpenCodeScheduleRunForPlan(store, plan.id)) return null;
        check();
        if (!isDeepStrictEqual(this.workspace(plan.config), plan.workspace)) throw new CodeScheduleError("schedule_workspace_invalid");
        return this.admit(plan);
      });
      if (run) this.deps.kick(run.sessionId);
    }
  }
  private admit(plan: CodeSchedulePlan): CodeScheduleRun {
    const { store } = this.deps, now = this.iso(), scheduledAt = latestAtOrBefore(plan.config.rule, Date.parse(now))!;
    const session = store.createSession({ projectId: plan.config.workspaceId, name: plan.config.title, kind: "dev", cwd: plan.workspace.cwdReal, cwdReal: plan.workspace.cwdReal, cwdDev: plan.workspace.dev, cwdIno: plan.workspace.ino, piSessionId: randomId("pi"), confirmTools: [], modelSelection: plan.config.modelSelection, defaultAccessMode: plan.config.permission });
    const { task } = store.insertQueuedTask({ sessionId: session.id, requestId: `code-schedule:${plan.id}:${plan.version}:${scheduledAt}`, input: plan.config.instructions, accessMode: plan.config.permission, planMode: false, modelSelection: plan.config.modelSelection, submissionDigest: codeScheduleDigest([plan.id, plan.version, scheduledAt]) });
    return registerCodeScheduleRun(store, { scheduleId: plan.id, expectedVersion: plan.version, sessionId: session.id, rootTaskId: task.id, scheduledAt, coalescedFrom: plan.nextDueAt!, coalescedThrough: scheduledAt, nextDueAt: nextAfter(plan.config.rule, Date.parse(now)), now });
  }
}
