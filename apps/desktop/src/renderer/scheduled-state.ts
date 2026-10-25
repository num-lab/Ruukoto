import { Temporal } from "@js-temporal/polyfill";
import type { CodeScheduleConfig, CodeSchedulePlan, CodeScheduleRun } from "@ruukoto/core/code-scheduler.ts";
import type { AccessMode, ModelSelection } from "@ruukoto/core/types.ts";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { CodeScheduleWriteOp, CodeScheduleWriteOutcome } from "@ruukoto/control/code-schedule-requests.ts";
import type { DesktopBridge, DesktopUpdate, PendingInput } from "../shared/bridge.ts";
import type { CodeState } from "./code-state.ts";
import { WriteFailure } from "./code-writes.ts";

export interface ScheduleDraft {
  title: string; instructions: string; workspaceId: string; permission: AccessMode; modelSelection: ModelSelection | null;
  repeat: "once" | "daily" | "weekly"; date: string; time: string; weekdays: number[]; timeZone: string;
}
export function newScheduleDraft(selection: ModelSelection | null = null, now = Date.now()): ScheduleDraft {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).toPlainDate().toString();
  return { title: "", instructions: "", workspaceId: "", permission: "confirm", modelSelection: selection, repeat: "daily", date, time: "09:00", weekdays: [1], timeZone };
}
export function draftForSchedule(config: CodeScheduleConfig): ScheduleDraft {
  const rule = config.rule, once = rule.kind === "once" ? Temporal.Instant.from(rule.at).toZonedDateTimeISO(rule.timeZone) : null;
  return { ...newScheduleDraft(), title: config.title, instructions: config.instructions, workspaceId: config.workspaceId, permission: config.permission, modelSelection: config.modelSelection,
    repeat: rule.kind, date: once?.toPlainDate().toString() ?? "", time: once?.toPlainTime().toString({ smallestUnit: "minute" }) ?? (rule.kind === "once" ? "" : rule.time), weekdays: rule.kind === "weekly" ? [...rule.weekdays] : [1], timeZone: rule.timeZone };
}
export function configForSchedule(draft: ScheduleDraft, now = Date.now()): { config: CodeScheduleConfig } | { error: string } {
  if (!draft.title.trim()) return { error: "请填写 Title。" };
  if (!draft.instructions.trim()) return { error: "请填写 Instructions。" };
  if (new TextEncoder().encode(draft.instructions).byteLength > 64 * 1024) return { error: "Instructions 过长，请缩短后保存（最多 64 KiB）。" };
  if (!draft.workspaceId) return { error: "请选择工作区。" };
  if (!draft.modelSelection) return { error: "请选择可用模型与 Effort。" };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return { error: "请选择有效时间。" };
  const base = { timeZone: draft.timeZone, disambiguation: "compatible" as const };
  let rule: CodeScheduleConfig["rule"];
  if (draft.repeat === "once") {
    let at: Temporal.ZonedDateTime;
    try { at = Temporal.PlainDateTime.from(`${draft.date}T${draft.time}`).toZonedDateTime(draft.timeZone, { disambiguation: "compatible" }); }
    catch { return { error: "请选择有效日期与时间。" }; }
    if (at.epochMilliseconds <= now) return { error: "一次性计划须选择未来时间。" };
    rule = { kind: "once", at: new Date(at.epochMilliseconds).toISOString(), ...base };
  } else if (draft.repeat === "weekly") {
    if (!draft.weekdays.length) return { error: "请至少选择一个星期。" };
    rule = { kind: "weekly", time: draft.time, weekdays: [...draft.weekdays].sort((a, b) => a - b), ...base };
  } else rule = { kind: "daily", time: draft.time, ...base };
  return { config: { title: draft.title.trim(), instructions: draft.instructions, workspaceId: draft.workspaceId, permission: draft.permission, modelSelection: draft.modelSelection, rule } };
}
export function scheduleTime(instant: string | null, timeZone: string): string {
  return instant ? new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(instant)) : "—";
}
export function scheduleSummary(config: CodeScheduleConfig): string {
  const rule = config.rule;
  return rule.kind === "once" ? `一次性 · ${scheduleTime(rule.at, rule.timeZone)}` : rule.kind === "daily" ? `每天 ${rule.time}` : `每周 ${rule.weekdays.map(day => "一二三四五六日"[day - 1]).join("、")} · ${rule.time}`;
}
export function runStatus(run: CodeScheduleRun): string {
  if (run.reason === "effect_unknown") return run.closedAt ? "结果未知，已结束" : "结果未知，已暂停";
  return ({ active: "运行中", completed: "已完成", failed: "失败", canceled: "已取消", interrupted: "已中断" })[run.status];
}
export function scheduleReason(reason: string | null): string {
  if (!reason) return "";
  return ({ running: "运行中", waiting_workspace: "等待工作区", queue_paused: "队列暂停，等待恢复", awaiting_confirmation: "等待审批", awaiting_answer: "等待回答", background_running: "后台进程尚未结束", awaiting_workflow: "工作流尚未结束", awaiting_report: "等待工作报告", awaiting_result: "等待派生工作结果", effect_unknown: "结果未知，已暂停；请检查原运行记录后恢复", stop_unverified: "停止尚未核实；请先在原会话核实停止", schedule_canceled: "计划已取消", workflow_failed: "工作流失败，请查看运行记录", schedule_workspace_invalid: "工作区不可用或已被替换，请核对目录后保存计划", model_unavailable: "模型不可用，请检查模型配置", model_auth_missing: "模型认证不可用，请检查模型配置", model_not_found: "模型已不在目录中，请重新选择", thinking_level_invalid: "Effort 不可用，请重新选择" } as Record<string, string>)[reason] ?? "计划需要处理，请核对配置与原运行记录。";
}

// Note: 见 .agents/notes/implemented/feature/2026-10-25-code-scheduled.md
export class DesktopScheduled {
  plans: CodeSchedulePlan[] = [];
  readonly latestRuns = new Map<string, CodeScheduleRun>();
  detail: OpResult<"code_schedule"> | null = null;
  selectedId: string | null = null;
  draft: ScheduleDraft | null = null;
  draftVersion: number | null = null;
  needsReview = false;
  message: string | null = null;
  entries: PendingInput[] = [];
  busy = false;
  loading = false;
  history = false;
  nextOffset: number | null = null;
  private generation = 0;
  private reading = 0;
  private detailRead = 0;
  private instanceId: string | null = null;
  private readonly drafts = new Map<string, { selectedId: string | null; draft: ScheduleDraft; version: number | null; needsReview: boolean }>();
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly model: CodeState, private readonly changed: () => void) {}
  get blocked(): boolean { return this.busy || this.model.status.state !== "online" || this.entries.some(item => item.record.instanceId === this.model.view.instanceId); }
  private async request<K extends "code_schedules" | "code_schedule">(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    const response = await this.bridge.request("code", op, params);
    if (!response.ok) throw new WriteFailure(response.error);
    return response.value as OpResult<K>;
  }
  update(update: DesktopUpdate): void {
    if (update.type === "snapshot") {
      if (this.instanceId !== this.model.view.instanceId) {
        if (this.instanceId && this.draft) this.drafts.set(this.instanceId, { selectedId: this.selectedId, draft: this.draft, version: this.draftVersion, needsReview: this.needsReview });
        this.instanceId = this.model.view.instanceId; ++this.generation; this.plans = []; this.latestRuns.clear(); this.detail = null; this.busy = false; this.loading = false;
        const saved = this.instanceId ? this.drafts.get(this.instanceId) : undefined;
        this.selectedId = saved?.selectedId ?? null; this.draft = saved?.draft ?? null; this.draftVersion = saved?.version ?? null; this.needsReview = saved?.needsReview ?? false;
      }
      for (const run of update.result.snapshot.codeScheduleRuns ?? []) this.acceptRun(run);
      void this.load();
      if (this.selectedId) void this.open(this.selectedId, true);
    } else if (update.type === "event" && (update.event.body.type === "code_schedule.changed" || update.event.body.type === "code_schedule.run_changed")) {
      if (update.event.body.type === "code_schedule.run_changed") this.acceptRun(update.event.body.run);
      void this.load(); if (this.selectedId) void this.open(this.selectedId, true);
    } else if (update.type === "pending") {
      this.entries = update.entries.filter(item => item.record.op === "code_schedule_save" || item.record.op === "code_schedule_control");
      const pending = this.entries.find(item => item.record.instanceId === this.model.view.instanceId && item.record.op === "code_schedule_save");
      if (pending && !this.draft) { this.draft = draftForSchedule(pending.record.params.config as CodeScheduleConfig); this.selectedId = typeof pending.record.params.plan_id === "string" ? pending.record.params.plan_id : null; this.draftVersion = typeof pending.record.params.expected_version === "number" ? pending.record.params.expected_version : null; }
    } else if (update.type === "schedule_submission") {
      if (update.record.instanceId !== this.model.view.instanceId) return;
      const result = update.result;
      if (result.kind === "linked") { this.selectedId = result.receipt.plan.id; this.draft = null; this.entries = this.entries.filter(item => item.record.requestId !== result.requestId); this.message = "已核实原保存结果。"; void this.load(); void this.open(result.receipt.plan.id); }
      else { this.message = result.kind === "foreign_instance" ? "原保存属于其他实例，请连回原实例核实。" : result.reason; if (result.kind === "rejected") { this.entries = this.entries.filter(item => item.record.requestId !== result.requestId); this.reviewConflict(result.code); } }
    }
  }
  async load(more = false): Promise<void> {
    if (this.model.status.state !== "online" || !this.instanceId) return;
    const generation = this.generation, reading = ++this.reading, offset = more ? this.nextOffset : 0;
    if (offset === null) return;
    this.loading = true; this.changed();
    try {
      const page = await this.request("code_schedules", { offset, limit: 30, scope: this.history ? "history" : "current" });
      if (generation !== this.generation || reading !== this.reading) return;
      this.plans = more ? [...this.plans, ...page.plans.filter(plan => !this.plans.some(item => item.id === plan.id))] : page.plans;
      for (const run of page.latestRuns ?? []) this.acceptRun(run);
      this.nextOffset = page.nextOffset;
    } catch (error) { if (generation === this.generation && reading === this.reading) this.message = `计划读取失败：${(error as Error).message}`; }
    finally { if (generation === this.generation && reading === this.reading) { this.loading = false; this.changed(); } }
  }
  private acceptRun(run: CodeScheduleRun): void {
    const previous = this.latestRuns.get(run.scheduleId);
    if (!previous || previous.createdAt < run.createdAt || previous.id === run.id && previous.version <= run.version) this.latestRuns.set(run.scheduleId, run);
  }
  create(): void { if (this.blocked) return; this.selectedId = null; this.detail = null; this.draft = newScheduleDraft(this.model.newChatSelection(null)); this.draftVersion = null; this.needsReview = false; this.message = null; this.changed(); }
  edit(): void { if (this.detail && !this.blocked) { this.draft = draftForSchedule(this.detail.plan.config); this.draftVersion = this.detail.plan.version; this.needsReview = false; this.changed(); } }
  private reviewConflict(code: string): void {
    if (code === "schedule_version_conflict" && this.draft && this.selectedId) { this.needsReview = true; this.detail = null; this.message = "计划已被其他操作修改；草稿仍保留，请核对当前已保存配置后继续。"; void this.open(this.selectedId, true); }
  }
  reviewed(): void { if (this.detail && this.draft && this.detail.plan.id === this.selectedId) { this.draftVersion = this.detail.plan.version; this.needsReview = false; this.message = null; this.changed(); } }
  async open(id: string, preserveDraft = false, more = false): Promise<void> {
    if (this.selectedId !== id) this.detail = null;
    this.selectedId = id; if (!preserveDraft) this.draft = null;
    const generation = this.generation, reading = ++this.detailRead, offset = more ? this.detail?.nextRunOffset : 0;
    if (offset === null || offset === undefined) return;
    try {
      const detail = await this.request("code_schedule", { plan_id: id, run_offset: offset });
      if (generation !== this.generation || reading !== this.detailRead || this.selectedId !== id) return;
      this.detail = more && this.detail ? { ...detail, runs: [...this.detail.runs, ...detail.runs] } : detail;
    } catch (error) { if (generation === this.generation && reading === this.detailRead) this.message = `计划详情读取失败：${(error as Error).message}`; }
    this.changed();
  }
  async save(): Promise<void> {
    if (!this.draft || this.blocked || this.needsReview) return;
    const config = configForSchedule(this.draft);
    if ("error" in config) { this.message = config.error; this.changed(); return; }
    const plan = this.selectedId ? this.detail?.plan : null;
    if (this.selectedId && plan?.id !== this.selectedId) { this.message = "请先重新读取当前计划。"; this.changed(); return; }
    await this.write("code_schedule_save", { request_id: crypto.randomUUID(), ...(plan ? { plan_id: plan.id, expected_version: this.draftVersion ?? plan.version } : {}), config: config.config });
  }
  async control(control: "pause" | "resume" | "cancel", acknowledgeRun?: CodeScheduleRun): Promise<void> {
    const plan = this.detail?.plan;
    if (!plan || this.blocked) return;
    await this.write("code_schedule_control", { request_id: crypto.randomUUID(), plan_id: plan.id, expected_version: plan.version, control, ...(acknowledgeRun ? { acknowledge_run_id: acknowledgeRun.id, expected_run_version: acknowledgeRun.version } : {}) });
  }
  private async write(op: CodeScheduleWriteOp, params: OpParams<CodeScheduleWriteOp>): Promise<void> {
    const generation = this.generation;
    this.busy = true; this.message = null; this.changed();
    try {
      const response = await this.bridge.request("code", op, params);
      if (generation !== this.generation) return;
      if (!response.ok) { this.message = response.error.message; return; }
      const result = response.value as CodeScheduleWriteOutcome;
      if (result.kind === "accepted") { this.selectedId = result.receipt.plan.id; this.draft = null; this.message = "计划已保存。"; await this.load(); await this.open(result.receipt.plan.id); }
      else { this.message = result.kind === "pending_existing" ? "原保存结果待核实，草稿仍保留。" : result.reason; if (result.kind === "rejected") this.reviewConflict(result.code); }
    } catch { if (generation === this.generation) this.message = "保存结果待核实；请恢复连接后查看原请求，草稿仍保留。"; }
    finally { if (generation === this.generation) { this.busy = false; this.changed(); } }
  }
}
