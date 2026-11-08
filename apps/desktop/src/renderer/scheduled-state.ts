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
  if (!draft.title.trim()) return { error: "Enter a title." };
  if (!draft.instructions.trim()) return { error: "Enter instructions." };
  if (new TextEncoder().encode(draft.instructions).byteLength > 64 * 1024) return { error: "Instructions are too long; shorten before saving (64 KiB max)." };
  if (!draft.workspaceId) return { error: "Select a workspace." };
  if (!draft.modelSelection) return { error: "Select an available model and effort." };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return { error: "Enter a valid time." };
  const base = { timeZone: draft.timeZone, disambiguation: "compatible" as const };
  let rule: CodeScheduleConfig["rule"];
  if (draft.repeat === "once") {
    let at: Temporal.ZonedDateTime;
    try { at = Temporal.PlainDateTime.from(`${draft.date}T${draft.time}`).toZonedDateTime(draft.timeZone, { disambiguation: "compatible" }); }
    catch { return { error: "Enter a valid date and time." }; }
    if (at.epochMilliseconds <= now) return { error: "A one-time schedule needs a future time." };
    rule = { kind: "once", at: new Date(at.epochMilliseconds).toISOString(), ...base };
  } else if (draft.repeat === "weekly") {
    if (!draft.weekdays.length) return { error: "Select at least one weekday." };
    rule = { kind: "weekly", time: draft.time, weekdays: [...draft.weekdays].sort((a, b) => a - b), ...base };
  } else rule = { kind: "daily", time: draft.time, ...base };
  return { config: { title: draft.title.trim(), instructions: draft.instructions, workspaceId: draft.workspaceId, permission: draft.permission, modelSelection: draft.modelSelection, rule } };
}
export function scheduleTime(instant: string | null, timeZone: string): string {
  return instant ? new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(instant)) : "—";
}
export function scheduleSummary(config: CodeScheduleConfig): string {
  const rule = config.rule;
  return rule.kind === "once" ? `Once · ${scheduleTime(rule.at, rule.timeZone)}` : rule.kind === "daily" ? `Daily ${rule.time}` : `Weekly ${rule.weekdays.map(day => "MTWTFSS"[day - 1]).join("")} · ${rule.time}`;
}
export function runStatus(run: CodeScheduleRun): string {
  if (run.reason === "effect_unknown") return run.closedAt ? "Outcome unknown, ended" : "Outcome unknown, paused";
  return ({ active: "Running", completed: "Completed", failed: "Failed", canceled: "Canceled", interrupted: "Interrupted" })[run.status];
}
export function scheduleReason(reason: string | null): string {
  if (!reason) return "";
  return ({ running: "Running", waiting_workspace: "Waiting for workspace", queue_paused: "Queue paused, waiting to resume", awaiting_confirmation: "Awaiting approval", awaiting_answer: "Awaiting answer", background_running: "Background process still running", awaiting_workflow: "Workflow still running", awaiting_report: "Awaiting work report", awaiting_result: "Awaiting derived work result", effect_unknown: "Outcome unknown, paused; check the run record before resuming", stop_unverified: "Stop unverified; verify the stop in the original chat first", schedule_canceled: "Schedule canceled", workflow_failed: "Workflow failed; check the run record", schedule_workspace_invalid: "The workspace is unavailable or was replaced; check the directory and save the schedule", model_unavailable: "Model unavailable; check the model configuration", model_auth_missing: "Model auth unavailable; check the model configuration", model_not_found: "The model is no longer in the catalog; select again", thinking_level_invalid: "Effort unavailable; select again" } as Record<string, string>)[reason] ?? "The schedule needs attention; check the configuration and the original run record.";
}

function occurrenceOn(rule: CodeScheduleConfig["rule"], date: Temporal.PlainDate): number | null {
  if (rule.kind !== "weekly" && rule.kind !== "daily" || rule.kind === "weekly" && !rule.weekdays.includes(date.dayOfWeek)) return null;
  return Temporal.PlainDateTime.from(`${date.toString()}T${rule.time}:00`).toZonedDateTime(rule.timeZone, { disambiguation: rule.disambiguation }).toInstant().epochMilliseconds;
}
// Note: See .agents/notes/implemented/feature/2026-11-01-desktop-scheduled-interface.md
export function scheduleProgress(plan: CodeSchedulePlan, now = Date.now()): number | null {
  if (plan.status !== "active" || !plan.nextDueAt) return null;
  const next = Date.parse(plan.nextDueAt), rule = plan.config.rule;
  if (!Number.isFinite(next)) return null;
  if (now >= next) return 100;
  let previous: number | null = null;
  if (rule.kind === "once") previous = Date.parse(plan.createdAt);
  else {
    const date = Temporal.Instant.fromEpochMilliseconds(next).toZonedDateTimeISO(rule.timeZone).toPlainDate();
    for (let index = 0; index < 10 && previous === null; index++) {
      const candidate = occurrenceOn(rule, date.subtract({ days: index }));
      if (candidate !== null && candidate < next) previous = candidate;
    }
  }
  if (previous === null || !Number.isFinite(previous) || previous >= next) return null;
  return Math.min(100, Math.max(0, Math.round((now - previous) / (next - previous) * 100)));
}

// Note: See .agents/notes/implemented/feature/2026-10-25-code-scheduled.md
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
      if (result.kind === "linked") { this.selectedId = result.receipt.plan.id; this.draft = null; this.entries = this.entries.filter(item => item.record.requestId !== result.requestId); this.message = "Original save verified."; void this.load(); void this.open(result.receipt.plan.id); }
      else { this.message = result.kind === "foreign_instance" ? "The original save belongs to another instance. Reconnect to that instance to verify." : result.reason; if (result.kind === "rejected") { this.entries = this.entries.filter(item => item.record.requestId !== result.requestId); this.reviewConflict(result.code); } }
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
    } catch (error) { if (generation === this.generation && reading === this.reading) this.message = `Couldn't load schedules: ${(error as Error).message}`; }
    finally { if (generation === this.generation && reading === this.reading) { this.loading = false; this.changed(); } }
  }
  private acceptRun(run: CodeScheduleRun): void {
    const previous = this.latestRuns.get(run.scheduleId);
    if (!previous || previous.createdAt < run.createdAt || previous.id === run.id && previous.version <= run.version) this.latestRuns.set(run.scheduleId, run);
  }
  create(): void { if (this.blocked) return; this.selectedId = null; this.detail = null; this.draft = newScheduleDraft(this.model.newChatSelection(null)); this.draftVersion = null; this.needsReview = false; this.message = null; this.changed(); }
  edit(): void { if (this.detail && !this.blocked) { this.draft = draftForSchedule(this.detail.plan.config); this.draftVersion = this.detail.plan.version; this.needsReview = false; this.changed(); } }
  private reviewConflict(code: string): void {
    if (code === "schedule_version_conflict" && this.draft && this.selectedId) { this.needsReview = true; this.detail = null; this.message = "The schedule was changed by another operation; your draft is kept. Check the saved configuration before continuing."; void this.open(this.selectedId, true); }
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
    } catch (error) { if (generation === this.generation && reading === this.detailRead) this.message = `Couldn't load the schedule details: ${(error as Error).message}`; }
    this.changed();
  }
  async save(): Promise<void> {
    if (!this.draft || this.blocked || this.needsReview) return;
    const config = configForSchedule(this.draft);
    if ("error" in config) { this.message = config.error; this.changed(); return; }
    const plan = this.selectedId ? this.detail?.plan : null;
    if (this.selectedId && plan?.id !== this.selectedId) { this.message = "Read the current schedule again first."; this.changed(); return; }
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
      if (result.kind === "accepted") { this.selectedId = result.receipt.plan.id; this.draft = null; this.message = null; await this.load(); await this.open(result.receipt.plan.id); }
      else { this.message = result.kind === "pending_existing" ? "Original save outcome unverified; your draft is kept." : result.reason; if (result.kind === "rejected") this.reviewConflict(result.code); }
    } catch { if (generation === this.generation) this.message = "Save outcome unverified; check the original request after the connection recovers. Your draft is kept."; }
    finally { if (generation === this.generation) { this.busy = false; this.changed(); } }
  }
}
