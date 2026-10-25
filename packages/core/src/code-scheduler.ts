/** Code 调度的配置、来源与事务内存储；调用方持有 Store.withTx，时间计算由 runtime 完成。
 * Note: 见 .agents/notes/implemented/feature/2026-10-25-code-scheduled.md
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Store } from "./store.ts";
import type { DirIdentity } from "./dir-identity.ts";
import { parseModelSelection } from "./model-selection.ts";
import { randomId, type AccessMode, type ModelSelection, type Task } from "./types.ts";
import { invalidateAgentReports, listAgentReports } from "./agent-wait.ts";
import { cancelOwnerQuestion, getOwnerQuestion } from "./owner-questions.ts";
import { getWorkflowQuestion, listWorkflowExecutions, listWorkflowRuns, listWorkflowSteps, saveWorkflowQuestion, updateWorkflowRun, workflowTerminal } from "./workflow.ts";
import { workCopyHostFor } from "./work-copy-host.ts";

export type CodeScheduleRule =
  | { kind: "once"; at: string; timeZone: string; disambiguation: "compatible" }
  | { kind: "daily"; time: string; timeZone: string; disambiguation: "compatible" }
  | { kind: "weekly"; time: string; weekdays: number[]; timeZone: string; disambiguation: "compatible" };
export interface CodeScheduleConfig { title: string; instructions: string; workspaceId: string; permission: AccessMode; modelSelection: ModelSelection; rule: CodeScheduleRule }
export interface CodeSchedulePlan {
  id: string; config: CodeScheduleConfig; workspace: DirIdentity; version: number;
  status: "active" | "paused" | "canceled" | "completed";
  nextDueAt: string | null; reason: string | null; createdAt: string; updatedAt: string;
}
export interface CodeScheduleRun {
  id: string; scheduleId: string; planVersion: number; snapshot: CodeScheduleConfig; workspace: DirIdentity;
  sessionId: string; rootTaskId: string; scheduledAt: string; coalescedFrom: string; coalescedThrough: string;
  status: "active" | "completed" | "failed" | "canceled" | "interrupted";
  cancelRequested: boolean; reason: string | null; version: number; createdAt: string; closedAt: string | null;
}
export interface CodeScheduleReceipt {
  requestId: string; digest: string; operation: "create" | "update" | "pause" | "resume" | "cancel" | "acknowledge";
  plan: CodeSchedulePlan; run?: CodeScheduleRun;
}
export interface CodeScheduledTaskSource {
  kind: "coding-schedule"; runId: string; scheduleId: string; planVersion: number;
  snapshot: CodeScheduleConfig; workspace: DirIdentity; rootTaskId: string; sessionId: string; taskId: string;
}
export type CodingTaskOrigin = { kind: "coding-owner" } | { kind: "coding-schedule"; runId: string; scheduleId: string; planVersion: number };
export function isCodingTaskOrigin(value: unknown): value is CodingTaskOrigin {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  return value.kind === "coding-owner" || (value.kind === "coding-schedule" && "runId" in value && typeof value.runId === "string" && !!value.runId && "scheduleId" in value && typeof value.scheduleId === "string" && !!value.scheduleId && "planVersion" in value && Number.isSafeInteger(value.planVersion) && Number(value.planVersion) > 0);
}
export function getCodingTaskOrigin(store: Store, taskId: string): CodingTaskOrigin {
  const source = getCodeScheduledTaskSource(store, taskId);
  return source ? { kind: source.kind, runId: source.runId, scheduleId: source.scheduleId, planVersion: source.planVersion } : { kind: "coding-owner" };
}
export class CodeScheduleError extends Error {
  constructor(readonly code: string, message = `定时计划操作未接纳（${code}）；刷新计划与运行记录后继续。`) { super(message); this.name = "CodeScheduleError"; }
}

type PlanRow = { id: string; status: string; version: number; next_due_at: string | null; payload: string };
type RunRow = { id: string; schedule_id: string; plan_version: number; scheduled_at: string; session_id: string; status: string; closed_at: string | null; payload: string };
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const fields = (value: unknown, allowed: string[]): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

export function parseCodeScheduleConfig(value: unknown): CodeScheduleConfig {
  if (!fields(value, ["title", "instructions", "workspaceId", "permission", "modelSelection", "rule"]) ||
      typeof value.title !== "string" || !value.title.trim() || value.title.length > 120 || /[\u0000-\u001f\u007f]/u.test(value.title) ||
      typeof value.instructions !== "string" || !value.instructions.trim() || Buffer.byteLength(value.instructions) > 64 * 1024 || Buffer.byteLength(JSON.stringify(value.instructions)) > 128 * 1024 || value.instructions.includes("\0") ||
      typeof value.workspaceId !== "string" || !value.workspaceId || value.workspaceId.length > 256 || !["confirm", "auto-review", "full_access"].includes(String(value.permission)) ||
      !fields(value.modelSelection, ["provider", "modelId", "thinkingLevel"]) || typeof value.modelSelection.provider !== "string" || value.modelSelection.provider.length > 256 || typeof value.modelSelection.modelId !== "string" || value.modelSelection.modelId.length > 256 || !fields(value.rule, ["kind", "at", "time", "weekdays", "timeZone", "disambiguation"])) throw new CodeScheduleError("invalid_params");
  const raw = value.rule;
  if (typeof raw.timeZone !== "string" || !raw.timeZone || raw.timeZone.length > 128 || /^[+-]/.test(raw.timeZone) || raw.disambiguation !== "compatible") throw new CodeScheduleError("invalid_schedule_rule");
  try { new Intl.DateTimeFormat("en", { timeZone: raw.timeZone }); }
  catch { throw new CodeScheduleError("invalid_schedule_rule"); }
  const base = { timeZone: raw.timeZone, disambiguation: "compatible" as const };
  let rule: CodeScheduleRule;
  if (raw.kind === "once") {
    if (Object.keys(raw).some(key => !["kind", "at", "timeZone", "disambiguation"].includes(key)) || !instant(raw.at)) throw new CodeScheduleError("invalid_schedule_rule");
    rule = { kind: "once", at: raw.at, ...base };
  } else {
    if (typeof raw.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time) || raw.at !== undefined) throw new CodeScheduleError("invalid_schedule_rule");
    if (raw.kind === "daily" && raw.weekdays === undefined) rule = { kind: "daily", time: raw.time, ...base };
    else if (raw.kind === "weekly" && Array.isArray(raw.weekdays) && raw.weekdays.length > 0 && raw.weekdays.length <= 7 && raw.weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7) && new Set(raw.weekdays).size === raw.weekdays.length) rule = { kind: "weekly", time: raw.time, weekdays: [...raw.weekdays].sort((a, b) => a - b), ...base };
    else throw new CodeScheduleError("invalid_schedule_rule");
  }
  let modelSelection: ModelSelection;
  try { modelSelection = parseModelSelection(value.modelSelection); }
  catch { throw new CodeScheduleError("invalid_params"); }
  return { title: value.title.trim(), instructions: value.instructions, workspaceId: value.workspaceId, permission: value.permission as AccessMode, modelSelection, rule };
}

export function codeScheduleDigest(value: unknown): string {
  const stable = (input: unknown): unknown => Array.isArray(input) ? input.map(stable) : input !== null && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : input;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
function workspaceValid(value: DirIdentity): boolean { return Boolean(value && typeof value.cwd === "string" && typeof value.cwdReal === "string" && Number.isSafeInteger(value.dev) && value.dev >= 0 && Number.isSafeInteger(value.ino) && value.ino >= 0); }
function planFromRow(row: PlanRow | undefined): CodeSchedulePlan | null {
  if (!row) return null;
  let plan: CodeSchedulePlan;
  try { plan = JSON.parse(row.payload) as CodeSchedulePlan; }
  catch { throw new CodeScheduleError("schedule_corrupt"); }
  if (!plan || plan.id !== row.id || plan.status !== row.status || plan.version !== row.version || plan.nextDueAt !== row.next_due_at || !positive(plan.version) || !["active", "paused", "canceled", "completed"].includes(plan.status) || !workspaceValid(plan.workspace) || !instant(plan.createdAt) || !instant(plan.updatedAt) || (plan.nextDueAt !== null && !instant(plan.nextDueAt))) throw new CodeScheduleError("schedule_corrupt");
  try { parseCodeScheduleConfig(plan.config); }
  catch { throw new CodeScheduleError("schedule_corrupt"); }
  return plan;
}
function runFromRow(row: RunRow | undefined): CodeScheduleRun | null {
  if (!row) return null;
  let run: CodeScheduleRun;
  try { run = JSON.parse(row.payload) as CodeScheduleRun; }
  catch { throw new CodeScheduleError("schedule_corrupt"); }
  if (!run || run.id !== row.id || run.scheduleId !== row.schedule_id || run.planVersion !== row.plan_version || run.scheduledAt !== row.scheduled_at || run.sessionId !== row.session_id || run.status !== row.status || run.closedAt !== row.closed_at || !positive(run.planVersion) || !positive(run.version) || !workspaceValid(run.workspace) || !["active", "completed", "failed", "canceled", "interrupted"].includes(run.status) || (run.status === "active") !== (run.closedAt === null) || typeof run.rootTaskId !== "string" || typeof run.cancelRequested !== "boolean" || !instant(run.scheduledAt) || !instant(run.coalescedFrom) || !instant(run.coalescedThrough) || !instant(run.createdAt) || (run.closedAt !== null && !instant(run.closedAt))) throw new CodeScheduleError("schedule_corrupt");
  try { parseCodeScheduleConfig(run.snapshot); }
  catch { throw new CodeScheduleError("schedule_corrupt"); }
  return run;
}
export function getCodeSchedule(store: Store, planId: string): CodeSchedulePlan | null { return planFromRow(store.db.prepare("SELECT * FROM code_schedules WHERE id = ?").get(planId) as PlanRow | undefined); }
export function getCodeScheduleRun(store: Store, runId: string): CodeScheduleRun | null { return runFromRow(store.db.prepare("SELECT * FROM code_schedule_runs WHERE id = ?").get(runId) as RunRow | undefined); }
function requirePlan(store: Store, planId: string): CodeSchedulePlan { const plan = getCodeSchedule(store, planId); if (!plan) throw new CodeScheduleError("schedule_not_found"); return plan; }
function requireRun(store: Store, runId: string): CodeScheduleRun { const run = getCodeScheduleRun(store, runId); if (!run) throw new CodeScheduleError("schedule_run_not_found"); return run; }
function page(offset = 0, limit = 20): void { if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new CodeScheduleError("invalid_params"); }
export function listCodeSchedules(store: Store, input: { offset?: number; limit?: number; scope?: "current" | "history" | "all" } = {}): { plans: CodeSchedulePlan[]; nextOffset: number | null } {
  const { offset = 0, limit = 20 } = input; page(offset, limit);
  if (input.scope !== undefined && !["current", "history", "all"].includes(input.scope)) throw new CodeScheduleError("invalid_params");
  const rows = store.db.prepare("SELECT * FROM code_schedules WHERE (? = 'all' OR (? = 'history' AND status IN ('canceled','completed')) OR (? = 'current' AND status NOT IN ('canceled','completed'))) ORDER BY rowid DESC LIMIT ? OFFSET ?").all(input.scope ?? "all", input.scope ?? "all", input.scope ?? "all", limit + 1, offset) as PlanRow[];
  const plans: CodeSchedulePlan[] = [];
  for (const row of rows.slice(0, limit)) {
    const plan = planFromRow(row)!;
    if (plans.length && Buffer.byteLength(JSON.stringify([...plans, plan])) > 256 * 1024) break;
    plans.push(plan);
  }
  return { plans, nextOffset: rows.length > plans.length ? offset + plans.length : null };
}
export function listCodeScheduleRuns(store: Store, input: { planId: string; offset?: number; limit?: number }): { runs: CodeScheduleRun[]; nextOffset: number | null } {
  const { offset = 0, limit = 20 } = input; page(offset, limit);
  const rows = store.db.prepare("SELECT * FROM code_schedule_runs WHERE schedule_id = ? ORDER BY rowid DESC LIMIT ? OFFSET ?").all(input.planId, limit + 1, offset) as RunRow[];
  const runs: CodeScheduleRun[] = [];
  for (const row of rows.slice(0, limit)) {
    const run = runFromRow(row)!;
    if (runs.length && Buffer.byteLength(JSON.stringify([...runs, run])) > 256 * 1024) break;
    runs.push(run);
  }
  return { runs, nextOffset: rows.length > runs.length ? offset + runs.length : null };
}
export function listDueCodeSchedules(store: Store, now: string): CodeSchedulePlan[] { return (store.db.prepare("SELECT * FROM code_schedules WHERE status = 'active' AND next_due_at <= ? ORDER BY next_due_at, rowid").all(now) as PlanRow[]).map(row => planFromRow(row)!); }
export function listOpenCodeScheduleRuns(store: Store): CodeScheduleRun[] { return (store.db.prepare("SELECT * FROM code_schedule_runs WHERE closed_at IS NULL ORDER BY rowid").all() as RunRow[]).map(row => runFromRow(row)!); }
export function getOpenCodeScheduleRunForSession(store: Store, sessionId: string): CodeScheduleRun | null { return runFromRow(store.db.prepare("SELECT * FROM code_schedule_runs WHERE session_id = ? AND closed_at IS NULL").get(sessionId) as RunRow | undefined); }
export function getCodeScheduleRunForSession(store: Store, sessionId: string): CodeScheduleRun | null { return runFromRow(store.db.prepare("SELECT * FROM code_schedule_runs WHERE session_id = ?").get(sessionId) as RunRow | undefined); }
export function getOpenCodeScheduleRunForPlan(store: Store, planId: string): CodeScheduleRun | null { return runFromRow(store.db.prepare("SELECT * FROM code_schedule_runs WHERE schedule_id = ? AND closed_at IS NULL").get(planId) as RunRow | undefined); }
export function getCodeScheduleRunForTask(store: Store, taskId: string): CodeScheduleRun | null {
  const link = store.db.prepare("SELECT run_id FROM code_schedule_tasks WHERE task_id = ?").get(taskId) as { run_id: string } | undefined;
  if (!link) return null;
  const run = getCodeScheduleRun(store, link.run_id);
  if (!run) throw new CodeScheduleError("schedule_corrupt");
  return run;
}
export function listCodeScheduleRunTasks(store: Store, runId: string): Task[] { return (store.db.prepare("SELECT task_id FROM code_schedule_tasks WHERE run_id = ? ORDER BY rowid").all(runId) as { task_id: string }[]).map(row => { const task = store.getTask(row.task_id); if (!task) throw new CodeScheduleError("schedule_corrupt"); return task; }); }
function savePlan(store: Store, plan: CodeSchedulePlan): CodeSchedulePlan {
  store.db.prepare("UPDATE code_schedules SET status = ?, version = ?, next_due_at = ?, payload = ? WHERE id = ?").run(plan.status, plan.version, plan.nextDueAt, JSON.stringify(plan), plan.id);
  store.appendEvent({ type: "code_schedule.changed", plan }); return plan;
}
function saveRun(store: Store, run: CodeScheduleRun): CodeScheduleRun {
  store.db.prepare("UPDATE code_schedule_runs SET status = ?, closed_at = ?, payload = ? WHERE id = ?").run(run.status, run.closedAt, JSON.stringify(run), run.id);
  store.appendEvent({ type: "code_schedule.run_changed", run }, { sessionId: run.sessionId, taskId: run.rootTaskId }); return run;
}
export function findCodeScheduleReceipt(store: Store, requestId: string): CodeScheduleReceipt | null {
  const row = store.db.prepare("SELECT payload FROM code_schedule_receipts WHERE request_id = ?").get(requestId) as { payload: string } | undefined;
  if (!row) return null;
  let value: CodeScheduleReceipt;
  try { value = JSON.parse(row.payload) as CodeScheduleReceipt; }
  catch { throw new CodeScheduleError("schedule_corrupt"); }
  if (!value || value.requestId !== requestId || typeof value.digest !== "string" || !value.plan || !["create", "update", "pause", "resume", "cancel", "acknowledge"].includes(value.operation)) throw new CodeScheduleError("schedule_corrupt");
  return value;
}
function originalReceipt(store: Store, requestId: string, digest: string): CodeScheduleReceipt | null {
  if (!requestId || requestId.length > 256) throw new CodeScheduleError("invalid_params");
  const receipt = findCodeScheduleReceipt(store, requestId);
  if (receipt && receipt.digest !== digest) throw new CodeScheduleError("request_conflict"); return receipt;
}
function receipt(store: Store, value: CodeScheduleReceipt): CodeScheduleReceipt { store.db.prepare("INSERT INTO code_schedule_receipts (request_id, digest, payload) VALUES (?, ?, ?)").run(value.requestId, value.digest, JSON.stringify(value)); return value; }
export function saveCodeSchedule(store: Store, input: { requestId: string; planId?: string; expectedVersion?: number; config: CodeScheduleConfig; workspace: DirIdentity; nextDueAt: string; now?: string }): CodeScheduleReceipt {
  const config = parseCodeScheduleConfig(input.config), now = input.now ?? new Date().toISOString();
  const digest = codeScheduleDigest({ operation: input.planId ? "update" : "create", planId: input.planId ?? null, expectedVersion: input.expectedVersion ?? null, config });
  const original = originalReceipt(store, input.requestId, digest); if (original) return original;
  if (!workspaceValid(input.workspace) || !instant(input.nextDueAt) || !instant(now) || input.nextDueAt <= now) throw new CodeScheduleError("invalid_params");
  const project = store.getProject(config.workspaceId);
  if (!project?.rootDir || !isDeepStrictEqual(project.rootDir, input.workspace)) throw new CodeScheduleError("schedule_workspace_invalid");
  let plan: CodeSchedulePlan;
  if (input.planId) {
    const previous = requirePlan(store, input.planId);
    if (previous.version !== input.expectedVersion) throw new CodeScheduleError("schedule_version_conflict");
    if (previous.status === "canceled") throw new CodeScheduleError("schedule_canceled");
    if (previous.config.rule.timeZone !== config.rule.timeZone) throw new CodeScheduleError("schedule_timezone_fixed", "计划沿用创建时区；请按该时区编辑时间。");
    plan = { ...previous, config, workspace: structuredClone(input.workspace), version: previous.version + 1, status: previous.status === "paused" ? "paused" : "active", nextDueAt: previous.status === "paused" ? null : input.nextDueAt, reason: null, updatedAt: now };
    savePlan(store, plan);
  } else {
    if (input.expectedVersion !== undefined) throw new CodeScheduleError("invalid_params");
    plan = { id: randomId("code_schedule"), config, workspace: structuredClone(input.workspace), version: 1, status: "active", nextDueAt: input.nextDueAt, reason: null, createdAt: now, updatedAt: now };
    store.db.prepare("INSERT INTO code_schedules (id, status, version, next_due_at, payload) VALUES (?, ?, ?, ?, ?)").run(plan.id, plan.status, plan.version, plan.nextDueAt, JSON.stringify(plan));
    store.appendEvent({ type: "code_schedule.changed", plan });
  }
  return receipt(store, { requestId: input.requestId, digest, operation: input.planId ? "update" : "create", plan });
}
export function controlCodeSchedule(store: Store, input: { requestId: string; planId: string; expectedVersion: number; control: "pause" | "resume" | "cancel"; nextDueAt?: string | null; acknowledgeRunId?: string; expectedRunVersion?: number; now?: string }): CodeScheduleReceipt {
  const digest = codeScheduleDigest({ operation: input.control, planId: input.planId, expectedVersion: input.expectedVersion, acknowledgeRunId: input.acknowledgeRunId ?? null, expectedRunVersion: input.expectedRunVersion ?? null });
  const original = originalReceipt(store, input.requestId, digest); if (original) return original;
  const plan = requirePlan(store, input.planId), now = input.now ?? new Date().toISOString();
  if (plan.version !== input.expectedVersion) throw new CodeScheduleError("schedule_version_conflict");
  if (plan.status === "canceled") throw new CodeScheduleError("schedule_canceled");
  if (!instant(now)) throw new CodeScheduleError("invalid_params");
  let run = getOpenCodeScheduleRunForPlan(store, plan.id);
  if (input.acknowledgeRunId) {
    if (input.control !== "resume" || plan.status !== "paused" || run?.id !== input.acknowledgeRunId || run.cancelRequested || run.version !== input.expectedRunVersion || run.reason !== "effect_unknown") throw new CodeScheduleError("schedule_source_invalid");
    if (!codeScheduleRunStopped(store, run.id)) throw new CodeScheduleError("schedule_stop_unverified");
    run = closeCodeScheduleRun(store, { runId: run.id, status: "interrupted", reason: "effect_unknown_acknowledged", now });
  } else if (input.expectedRunVersion !== undefined) throw new CodeScheduleError("invalid_params");
  if (input.acknowledgeRunId && plan.config.rule.kind === "once") {
    const updated = savePlan(store, { ...plan, version: plan.version + 1, status: "completed", nextDueAt: null, reason: "effect_unknown_acknowledged", updatedAt: now });
    return receipt(store, { requestId: input.requestId, digest, operation: "acknowledge", plan: updated, run: run! });
  }
  if (input.control === "resume" && run && !run.closedAt && (run.reason === "effect_unknown" || run.reason === "stop_unverified")) throw new CodeScheduleError("schedule_recovery_required");
  if (input.control === "resume" && plan.config.rule.kind === "once" && (!input.nextDueAt || input.nextDueAt <= now)) throw new CodeScheduleError("schedule_date_elapsed", "一次性计划的日期已过，请调整日期后保存。");
  const nextDueAt = input.control === "resume" ? input.nextDueAt ?? null : null;
  if (input.control === "resume" && (!instant(nextDueAt) || nextDueAt <= now)) throw new CodeScheduleError("invalid_params");
  if (input.control === "cancel" && run && !run.closedAt) run = saveRun(store, { ...run, cancelRequested: true, version: run.version + 1, reason: "schedule_canceled" });
  const updated = savePlan(store, { ...plan, version: plan.version + 1, status: input.control === "pause" ? "paused" : input.control === "cancel" ? "canceled" : "active", nextDueAt, reason: null, updatedAt: now });
  return receipt(store, { requestId: input.requestId, digest, operation: input.acknowledgeRunId ? "acknowledge" : input.control, plan: updated, ...(run ? { run } : {}) });
}
/** 恢复未知结果前核实执行已停止；未送达报告由拥有者确认后保留为终态。 */
export function codeScheduleRunStopped(store: Store, runId: string): boolean {
  if (listCodeScheduleRunTasks(store, runId).some(task => ["queued", "running", "awaiting_confirmation"].includes(task.status))) return false;
  if (store.db.prepare("SELECT 1 FROM occupancy o WHERE o.task_id IN (SELECT task_id FROM code_schedule_tasks WHERE run_id = ?) OR o.process_id IN (SELECT p.id FROM background_processes p JOIN code_schedule_tasks t ON t.task_id = p.task_id WHERE t.run_id = ?)").get(runId, runId)) return false;
  if (store.db.prepare("SELECT 1 FROM background_processes p JOIN code_schedule_tasks t ON t.task_id = p.task_id WHERE t.run_id = ? AND p.state != 'stopped'").get(runId)) return false;
  if (listCodeScheduleRunTasks(store, runId).some(task => { const host = workCopyHostFor(task); return host && host.units.length > 0 && host.stopVerified !== true; })) return false;
  if (listWorkflowRuns(store).filter(workflow => workflow.source.codeScheduledRunId === runId).some(workflow => !workflowTerminal(workflow.status) || (workflow.scriptUnits.length > 0 && workflow.scriptStopVerified !== true) || listWorkflowExecutions(store, workflow.id).some(execution => {
    const task = store.getTask(execution.taskId);
    return !task || (execution.status === "queued" ? task.startedAt !== null : execution.stopVerified !== true);
  }))) return false;
  return true;
}
export function pauseCodeSchedule(store: Store, input: { planId: string; reason: string; now?: string }): CodeSchedulePlan {
  const plan = requirePlan(store, input.planId); if (plan.status === "canceled" || (plan.status === "paused" && plan.reason === input.reason)) return plan;
  return savePlan(store, { ...plan, status: "paused", nextDueAt: null, reason: input.reason, version: plan.version + 1, updatedAt: input.now ?? new Date().toISOString() });
}
export function registerCodeScheduleRun(store: Store, input: { scheduleId: string; expectedVersion: number; sessionId: string; rootTaskId: string; scheduledAt: string; coalescedFrom: string; coalescedThrough: string; nextDueAt: string | null; now?: string }): CodeScheduleRun {
  const plan = requirePlan(store, input.scheduleId), now = input.now ?? new Date().toISOString();
  const existing = store.db.prepare("SELECT * FROM code_schedule_runs WHERE schedule_id = ? AND plan_version = ? AND scheduled_at = ?").get(plan.id, input.expectedVersion, input.scheduledAt) as RunRow | undefined;
  if (existing) {
    const original = runFromRow(existing)!;
    if (original.sessionId !== input.sessionId || original.rootTaskId !== input.rootTaskId) throw new CodeScheduleError("request_conflict");
    return original;
  }
  if (plan.version !== input.expectedVersion || plan.status !== "active" || !plan.nextDueAt || plan.nextDueAt > now || getOpenCodeScheduleRunForPlan(store, plan.id)) throw new CodeScheduleError("schedule_admission_conflict");
  const task = store.getTask(input.rootTaskId), session = store.getSession(input.sessionId);
  if (!task || !session || task.sessionId !== session.id || session.projectId !== plan.config.workspaceId || store.getSessionIdentity(session.id)?.kind !== "dev" || task.parentTaskId || task.sourceEventId || task.workId || task.subAgentId || task.planMode || task.accessMode !== plan.config.permission || task.input !== plan.config.instructions || !isDeepStrictEqual(task.modelSelection, plan.config.modelSelection) || session.cwdReal !== plan.workspace.cwdReal || session.cwdDev !== plan.workspace.dev || session.cwdIno !== plan.workspace.ino || task.status !== "queued") throw new CodeScheduleError("schedule_source_invalid");
  if (![input.scheduledAt, input.coalescedFrom, input.coalescedThrough, now].every(instant) || input.coalescedFrom > input.scheduledAt || input.scheduledAt > input.coalescedThrough || input.coalescedThrough > now || (input.nextDueAt !== null && (!instant(input.nextDueAt) || input.nextDueAt <= now))) throw new CodeScheduleError("invalid_params");
  const run: CodeScheduleRun = { id: randomId("code_run"), scheduleId: plan.id, planVersion: plan.version, snapshot: structuredClone(plan.config), workspace: structuredClone(plan.workspace), sessionId: session.id, rootTaskId: task.id, scheduledAt: input.scheduledAt, coalescedFrom: input.coalescedFrom, coalescedThrough: input.coalescedThrough, status: "active", cancelRequested: false, reason: null, version: 1, createdAt: now, closedAt: null };
  store.db.prepare("INSERT INTO code_schedule_runs (id, schedule_id, plan_version, scheduled_at, session_id, status, closed_at, payload) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)").run(run.id, plan.id, plan.version, run.scheduledAt, session.id, run.status, JSON.stringify(run));
  store.db.prepare("INSERT INTO code_schedule_tasks (task_id, run_id, source_task_id) VALUES (?, ?, NULL)").run(task.id, run.id);
  store.appendEvent({ type: "code_schedule.task_bound", taskId: task.id, runId: run.id, sessionId: task.sessionId }, { sessionId: task.sessionId, taskId: task.id });
  savePlan(store, { ...plan, nextDueAt: input.nextDueAt, updatedAt: now });
  store.appendEvent({ type: "code_schedule.run_changed", run }, { sessionId: run.sessionId, taskId: run.rootTaskId }); return run;
}
export function getCodeScheduledTaskSource(store: Store, taskId: string): CodeScheduledTaskSource | null {
  const run = getCodeScheduleRunForTask(store, taskId);
  if (!run) {
    const task = store.getTask(taskId), sessionRun = task ? getCodeScheduleRunForSession(store, task.sessionId) : null;
    if (task && ((sessionRun && (!sessionRun.closedAt || sessionRun.rootTaskId === task.id)) || (task.parentTaskId && getCodeScheduleRunForTask(store, task.parentTaskId)))) throw new CodeScheduleError("schedule_source_invalid");
    return null;
  }
  const plan = getCodeSchedule(store, run.scheduleId), task = store.getTask(taskId), root = store.getTask(run.rootTaskId), session = store.getSession(run.sessionId);
  const rootLink = store.db.prepare("SELECT run_id, source_task_id FROM code_schedule_tasks WHERE task_id = ?").get(run.rootTaskId) as { run_id: string; source_task_id: string | null } | undefined;
  if (!plan || !task || !root || !session || run.closedAt || run.cancelRequested || plan.status === "canceled" || run.planVersion > plan.version || !rootLink || rootLink.run_id !== run.id || rootLink.source_task_id !== null || root.sessionId !== run.sessionId || root.parentTaskId || root.sourceEventId || root.sourcePermissionVersion !== null || root.agentId || root.workId || root.subAgentId || session.projectId !== run.snapshot.workspaceId || root.input !== run.snapshot.instructions || root.planMode || root.accessMode !== run.snapshot.permission || !isDeepStrictEqual(root.modelSelection, run.snapshot.modelSelection) || session.cwdReal !== run.workspace.cwdReal || session.cwdDev !== run.workspace.dev || session.cwdIno !== run.workspace.ino || store.getSessionIdentity(run.sessionId)?.kind !== "dev") throw new CodeScheduleError("schedule_source_invalid");
  let cursor = taskId; const seen = new Set<string>();
  while (cursor !== run.rootTaskId) {
    if (seen.has(cursor)) throw new CodeScheduleError("schedule_source_invalid"); seen.add(cursor);
    const link = store.db.prepare("SELECT source_task_id FROM code_schedule_tasks WHERE task_id = ? AND run_id = ?").get(cursor, run.id) as { source_task_id: string | null } | undefined;
    const child = store.getTask(cursor), parent = link?.source_task_id ? store.getTask(link.source_task_id) : null;
    if (!child || !parent || child.parentTaskId !== parent.id || child.sourcePermissionVersion !== parent.permissionVersion) throw new CodeScheduleError("schedule_source_invalid");
    cursor = parent.id;
  }
  return { kind: "coding-schedule", runId: run.id, scheduleId: run.scheduleId, planVersion: run.planVersion, snapshot: structuredClone(run.snapshot), workspace: structuredClone(run.workspace), rootTaskId: run.rootTaskId, sessionId: run.sessionId, taskId };
}
export function bindCodeScheduleTask(store: Store, input: { runId: string; taskId: string; sourceTaskId: string }): void {
  const source = getCodeScheduledTaskSource(store, input.sourceTaskId), task = store.getTask(input.taskId), parent = store.getTask(input.sourceTaskId);
  if (!source || source.runId !== input.runId || !task || !parent || task.parentTaskId !== parent.id || task.sourcePermissionVersion !== parent.permissionVersion || task.status !== "queued") throw new CodeScheduleError("schedule_source_invalid");
  const run = requireRun(store, input.runId);
  if (["effect_unknown", "stop_unverified"].includes(run.reason ?? "") || listCodeScheduleRunTasks(store, run.id).some(task => task.effectUnknown) || store.db.prepare("SELECT 1 FROM tool_ops o JOIN code_schedule_tasks t ON t.task_id = o.task_id WHERE t.run_id = ? AND o.effect_unknown = 1 LIMIT 1").get(run.id)) throw new CodeScheduleError("schedule_recovery_required");
  const existing = getCodeScheduleRunForTask(store, task.id); if (existing) { if (existing.id !== input.runId) throw new CodeScheduleError("schedule_source_invalid"); return; }
  store.db.prepare("INSERT INTO code_schedule_tasks (task_id, run_id, source_task_id) VALUES (?, ?, ?)").run(task.id, input.runId, parent.id);
  store.appendEvent({ type: "code_schedule.task_bound", taskId: task.id, runId: input.runId, sessionId: task.sessionId }, { sessionId: task.sessionId, taskId: task.id });
}
export function coalesceCodeScheduleRun(store: Store, input: { runId: string; through: string; nextDueAt: string | null; expectedVersion?: number; now?: string }): CodeScheduleRun {
  const run = requireRun(store, input.runId), plan = requirePlan(store, run.scheduleId), now = input.now ?? new Date().toISOString();
  if (run.closedAt || run.cancelRequested || plan.status !== "active" || (input.expectedVersion !== undefined && plan.version !== input.expectedVersion)) throw new CodeScheduleError("schedule_admission_conflict");
  if (!instant(input.through) || input.through < run.coalescedThrough || input.through > now || (input.nextDueAt !== null && (!instant(input.nextDueAt) || input.nextDueAt <= now))) throw new CodeScheduleError("invalid_params");
  savePlan(store, { ...plan, nextDueAt: input.nextDueAt, updatedAt: now });
  return input.through === run.coalescedThrough ? run : saveRun(store, { ...run, coalescedThrough: input.through, version: run.version + 1 });
}
export function updateCodeScheduleRun(store: Store, input: { runId: string; reason: string | null; now?: string }): CodeScheduleRun { const run = requireRun(store, input.runId); return run.reason === input.reason ? run : saveRun(store, { ...run, reason: input.reason, version: run.version + 1 }); }
export function closeCodeScheduleRun(store: Store, input: { runId: string; status: Exclude<CodeScheduleRun["status"], "active">; reason?: string | null; now?: string }): CodeScheduleRun {
  const run = requireRun(store, input.runId); if (run.closedAt) return run;
  const now = input.now ?? new Date().toISOString(); if (!instant(now)) throw new CodeScheduleError("invalid_params");
  for (const message of store.listPendingSubAgentMessages(run.sessionId)) {
    const reason = input.reason ?? "schedule_run_closed";
    if (getCodeScheduleRunForTask(store, message.fromTaskId)?.id === run.id && store.markSubAgentMessageUndelivered(message.id, reason)) store.appendEvent({ type: "subagent_message.dropped", messageId: message.id, workId: message.workId, parentSessionId: message.parentSessionId, toSubAgentId: message.toSubAgentId, reason }, { sessionId: message.parentSessionId });
  }
  const pending = store.db.prepare("SELECT q.id FROM owner_questions q JOIN code_schedule_tasks t ON t.task_id = q.task_id WHERE t.run_id = ? AND q.status = 'pending'").all(run.id) as { id: string }[];
  for (const row of pending) {
    const question = getOwnerQuestion(store, row.id)!;
    cancelOwnerQuestion(store, { questionId: question.id, sessionId: question.sessionId, version: question.version, status: "stale" });
  }
  invalidateAgentReports(store, listAgentReports(store).filter(report => report.source.codeScheduledRunId === run.id && report.status === "pending").map(report => report.key), input.reason ?? "schedule_run_closed");
  for (const workflow of listWorkflowRuns(store).filter(workflow => workflow.source.codeScheduledRunId === run.id)) {
    for (const step of listWorkflowSteps(store, workflow.id)) {
      const question = getWorkflowQuestion(store, workflow.id, step.key);
      if (question?.status === "pending") saveWorkflowQuestion(store, { ...question, version: question.version + 1, status: "canceled" });
    }
    if (workflow.delivery && ["pending", "queued"].includes(workflow.delivery.status)) updateWorkflowRun(store, { ...workflow, delivery: { ...workflow.delivery, status: "undelivered", reason: input.reason ?? "schedule_run_closed" } });
  }
  const closed = saveRun(store, { ...run, status: input.status, reason: input.reason ?? null, closedAt: now, version: run.version + 1 });
  const plan = requirePlan(store, run.scheduleId);
  if (plan.status === "active" && !plan.nextDueAt && plan.config.rule.kind === "once") savePlan(store, { ...plan, status: "completed", version: plan.version + 1, updatedAt: now });
  return closed;
}
