/** 工作流的固定输入、持久状态与事务内仲裁；调用方持有 Store.withTx。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-13-workflow-runtime-and-store.md
 */
import { createHash } from "node:crypto";
import { StoreConflictError, type Store } from "./store.ts";
import { randomId, type AccessMode, type GrantedPath, type ModelSelection, type NotifyTarget, type SubAgentReadScope, type Task, type ToolCategory } from "./types.ts";
import type { ProductType } from "./product.ts";

export const WORKFLOW_LIMITS = { attempts: 100, durationMs: 3_600_000, concurrency: 3, retries: 2, valueBytes: 512 * 1024, scriptBytes: 128 * 1024 } as const;
export type WorkflowStatus = "queued" | "running" | "waiting" | "paused" | "succeeded" | "partial" | "failed" | "canceled";
export interface WorkflowSource {
  product: ProductType;
  projectId: string;
  sessionId: string;
  taskId: string;
  permissionVersion: number;
  accessMode: AccessMode;
  grantedPaths: GrantedPath[];
  capabilities: string[];
  references: SubAgentReadScope["sourceRefs"];
  replyTarget: NotifyTarget | null;
  scheduledRunId: string | null;
  /** 真实装配在启动时固定；旧库层替身可省略，真实 Driver 拒绝缺少快照的绑定。 */
  authority?: { categories: ToolCategory[]; grantIds: string[]; configuration: string; workspace: { path: string; dev: number; ino: number } };
}
export interface WorkflowDefinition { id: string; digest: string; script: string; createdAt: string }
export interface WorkflowLaunch {
  name?: string;
  script?: string;
  input: unknown;
  maxAttempts?: number;
  durationMs?: number;
}
export function workflowName(name: string): string {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new WorkflowError("invalid_definition_name");
  return name;
}
export function workflowLaunchDigest(input: WorkflowLaunch): string {
  if ((input.name === undefined) === (input.script === undefined)) throw new WorkflowError("invalid_params");
  if (input.name !== undefined) workflowName(input.name);
  if (input.script !== undefined && typeof input.script !== "string") throw new WorkflowError("invalid_script");
  return workflowDigest({ name: input.name ?? null, script: input.script ?? null, input: input.input,
    maxAttempts: input.maxAttempts ?? WORKFLOW_LIMITS.attempts, durationMs: input.durationMs ?? WORKFLOW_LIMITS.durationMs });
}
export interface WorkflowRun {
  id: string;
  requestKey: string;
  paramsDigest: string;
  definitionId: string;
  scriptDigest: string;
  input: unknown;
  inputDigest: string;
  source: WorkflowSource;
  modelSelection: ModelSelection;
  status: WorkflowStatus;
  version: number;
  reason: string | null;
  attempts: number;
  maxAttempts: number;
  durationMs: number;
  usedMs: number;
  clockStartedAt: number | null;
  clockVerified: boolean;
  scriptUnits: WorkflowExecution["units"];
  scriptStopVerified: boolean | null;
  result: unknown;
  resultRecorded: boolean;
  createdAt: string;
  endedAt: string | null;
  terminalVersion?: number;
  delivery?: { version: number; facts: string; text: string; taskId: string | null; status: "pending" | "queued" | "reported" | "undelivered"; reason: string | null };
}
export interface WorkflowStep {
  runId: string;
  key: string;
  ordinal: number;
  kind: "agent" | "ask" | "integrate" | "progress";
  params: unknown;
  digest: string;
  dependsOn: string[];
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "skipped" | "canceled";
  result: unknown;
  rawOutput: string | null;
  outputArtifact: { id: string; hash: string; bytes: number } | null;
  resultRecorded: boolean;
  delivery: number | null;
  attempts: number;
  frozen?: { workId: string; taskId: string; baseCommit: string; artifactId: string; digest: string; bytes: number };
  verification?: { stepKey: string; taskId: string; artifactId: string; digest: string; baseCommit: string; passed: boolean };
  readMemories?: string[];
}
export interface WorkflowExecution {
  id: string;
  runId: string;
  stepKey: string;
  kind: "agent" | "host";
  taskId: string;
  number: number;
  status: "queued" | "running" | "finished";
  units: { kind: "starting" | "process_group" | "systemd_unit"; id: string; label: string }[];
  stopVerified: boolean | null;
}
export interface WorkflowQuestion {
  runId: string;
  stepKey: string;
  version: number;
  /** 问题建立时固定的运行代次；其他分支进度不使待答命令过期。 */
  runVersion: number;
  prompt: unknown;
  source: WorkflowSource;
  status: "pending" | "answered" | "canceled";
  answer: unknown;
}
export class WorkflowError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(`工作流 ${code}：保留运行记录，请核实后继续`, options); }
}

/** JSON/wire 输入限制；摘要使用完整编码，原型字段与键顺序不会被丢弃。 */
export function workflowJson(value: unknown): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch (cause) { throw new WorkflowError("invalid_value", { cause }); }
  if (encoded === undefined || Buffer.byteLength(encoded) > WORKFLOW_LIMITS.valueBytes) throw new WorkflowError("value_limit");
  return encoded;
}
export function workflowDigest(value: unknown): string { return createHash("sha256").update(workflowJson(value)).digest("hex"); }
export function workflowTerminal(status: WorkflowStatus): boolean { return ["succeeded", "partial", "failed", "canceled"].includes(status); }

export function getWorkflowDefinition(store: Store, id: string): WorkflowDefinition | null {
  const row = store.db.prepare("SELECT payload FROM workflow_definitions WHERE id = ?").get(id) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as WorkflowDefinition : null;
}
export function saveWorkflowDefinition(store: Store, script: string): WorkflowDefinition {
  if (typeof script !== "string" || !script.trim() || Buffer.byteLength(script) > WORKFLOW_LIMITS.scriptBytes) throw new WorkflowError("invalid_script");
  const digest = workflowDigest(script);
  const row = store.db.prepare("SELECT payload FROM workflow_definitions WHERE digest = ?").get(digest) as { payload: string } | undefined;
  if (row) return JSON.parse(row.payload) as WorkflowDefinition;
  const definition = { id: randomId("wfdef"), digest, script, createdAt: new Date().toISOString() };
  store.db.prepare("INSERT INTO workflow_definitions (id, digest, payload) VALUES (?, ?, ?)").run(definition.id, digest, JSON.stringify(definition));
  return definition;
}
export function getWorkflowDefinitionRef(store: Store, key: string): { name: string; definitionId: string; requestDigest: string | null } | null {
  const row = store.db.prepare("SELECT name, definition_id, request_digest FROM workflow_definition_refs WHERE ref_key = ?").get(key) as
    { name: string; definition_id: string; request_digest: string | null } | undefined;
  return row ? { name: row.name, definitionId: row.definition_id, requestDigest: row.request_digest } : null;
}
/** 名称引用和保存回执不修改版本正文；调用方先核实文件字节。 */
export function rememberWorkflowDefinition(store: Store, name: string, definition: WorkflowDefinition, receipt?: { key: string; digest: string }): void {
  store.db.prepare("INSERT OR IGNORE INTO workflow_definition_refs (ref_key, name, definition_id) VALUES (?, ?, ?)")
    .run(`version:${name}:${definition.digest}`, name, definition.id);
  if (receipt) store.db.prepare("INSERT INTO workflow_definition_refs (ref_key, name, definition_id, request_digest) VALUES (?, ?, ?, ?)")
    .run(`save:${receipt.key}`, name, definition.id, receipt.digest);
  store.appendEvent({ type: "workflow.definition", name, definitionId: definition.id, digest: definition.digest });
}
export function listWorkflowDefinitionVersions(store: Store, name: string, offset = 0, limit = 100): Omit<WorkflowDefinition, "script">[] {
  const rows = store.db.prepare("SELECT DISTINCT d.payload FROM workflow_definition_refs r JOIN workflow_definitions d ON d.id = r.definition_id WHERE r.name = ? ORDER BY d.rowid DESC LIMIT ? OFFSET ?")
    .all(name, limit, offset) as { payload: string }[];
  return rows.map(row => { const { script: _script, ...version } = JSON.parse(row.payload) as WorkflowDefinition; return version; });
}
export function getWorkflowRun(store: Store, id: string): WorkflowRun | null {
  const row = store.db.prepare("SELECT payload FROM workflow_runs WHERE id = ?").get(id) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as WorkflowRun : null;
}
export function requireWorkflowRun(store: Store, id: string): WorkflowRun {
  const run = getWorkflowRun(store, id);
  if (!run) throw new WorkflowError("run_missing");
  return run;
}
export function listWorkflowRuns(store: Store, sessionId?: string): WorkflowRun[] {
  const rows = (sessionId === undefined ? store.db.prepare("SELECT payload FROM workflow_runs ORDER BY rowid").all() :
    store.db.prepare("SELECT payload FROM workflow_runs WHERE source_session_id = ? ORDER BY rowid").all(sessionId)) as { payload: string }[];
  return rows.map(row => JSON.parse(row.payload) as WorkflowRun);
}
/** 最终汇总的可信归属只由事务内登记的运行绑定确定，不能凭请求键前缀。 */
export function getWorkflowDeliveryRun(store: Store, taskId: string): WorkflowRun | null {
  const row = store.db.prepare("SELECT payload FROM workflow_runs WHERE json_extract(payload, '$.delivery.taskId') = ?").get(taskId) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as WorkflowRun : null;
}
export function workflowDeliveryKey(run: WorkflowRun): string { return `workflow-final:${run.id}:${run.terminalVersion}`; }
export function workflowQuestionKey(question: WorkflowQuestion): string { return `${question.runId}#${question.stepKey}#${question.version}`; }
export function findWorkflowRun(store: Store, sessionId: string, key: string): WorkflowRun | null {
  const row = store.db.prepare("SELECT payload FROM workflow_runs WHERE source_session_id = ? AND request_key = ?").get(sessionId, key) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as WorkflowRun : null;
}
export function createWorkflowRun(store: Store, run: WorkflowRun): WorkflowRun {
  const existing = findWorkflowRun(store, run.source.sessionId, run.requestKey);
  if (existing) {
    if (existing.paramsDigest !== run.paramsDigest) throw new StoreConflictError("工作流请求键已用于不同输入", "request_conflict");
    return existing;
  }
  const definition = getWorkflowDefinition(store, run.definitionId);
  if (!definition || definition.digest !== run.scriptDigest) throw new WorkflowError("definition_missing");
  store.db.prepare("INSERT INTO workflow_runs (id, source_session_id, request_key, params_digest, status, payload) VALUES (?, ?, ?, ?, ?, ?)")
    .run(run.id, run.source.sessionId, run.requestKey, run.paramsDigest, run.status, JSON.stringify(run));
  changed(store, run);
  return run;
}
function changed(store: Store, run: WorkflowRun): void {
  store.appendEvent({ type: "workflow.changed", runId: run.id, version: run.version, status: run.status, reason: run.reason }, { sessionId: run.source.sessionId });
}
export function updateWorkflowRun(store: Store, run: WorkflowRun): WorkflowRun {
  const updated = { ...run, version: run.version + 1 };
  const result = store.db.prepare("UPDATE workflow_runs SET status = ?, payload = ? WHERE id = ? AND json_extract(payload, '$.version') = ?")
    .run(updated.status, JSON.stringify(updated), run.id, run.version);
  if (Number(result.changes) !== 1) throw new WorkflowError("version_conflict");
  changed(store, updated);
  return updated;
}
export function chargeWorkflow(run: WorkflowRun, now: number): WorkflowRun {
  return { ...run, usedMs: run.usedMs + (run.clockStartedAt === null ? 0 : Math.max(0, now - run.clockStartedAt)),
    clockStartedAt: run.clockStartedAt === null ? null : now };
}
export function setWorkflowState(store: Store, id: string, status: WorkflowStatus, reason: string | null, now = Date.now()): WorkflowRun {
  const run = requireWorkflowRun(store, id);
  if (workflowTerminal(run.status)) return run;
  if (status === "paused" && run.status === "paused" && ["effect_unknown", "write_result_missing", "replay_diverged", "result_missing", "definition_missing", "source_invalid"].includes(run.reason ?? "")) return run;
  const charged = chargeWorkflow(run, now);
  return updateWorkflowRun(store, { ...charged, status, reason, clockStartedAt: status === "running" ? now : null,
    ...(workflowTerminal(status) ? { terminalVersion: run.version + 1 } : {}),
    endedAt: workflowTerminal(status) ? new Date(now).toISOString() : null });
}
export function getWorkflowStep(store: Store, runId: string, key: string): WorkflowStep | null {
  const row = store.db.prepare("SELECT payload FROM workflow_steps WHERE run_id = ? AND key = ?").get(runId, key) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as WorkflowStep : null;
}
export function listWorkflowSteps(store: Store, runId: string): WorkflowStep[] {
  const rows = store.db.prepare("SELECT payload FROM workflow_steps WHERE run_id = ? ORDER BY ordinal").all(runId) as { payload: string }[];
  return rows.map(row => JSON.parse(row.payload) as WorkflowStep);
}
export function updateWorkflowStep(store: Store, step: WorkflowStep): void {
  store.db.prepare("UPDATE workflow_steps SET payload = ? WHERE run_id = ? AND key = ?").run(JSON.stringify(step), step.runId, step.key);
  store.appendEvent({ type: "workflow.step", runId: step.runId, key: step.key, status: step.status, delivery: step.delivery }, { sessionId: requireWorkflowRun(store, step.runId).source.sessionId });
}
export function registerWorkflowStep(store: Store, input: Pick<WorkflowStep, "runId" | "key" | "ordinal" | "kind" | "params" | "dependsOn">): WorkflowStep {
  const digest = workflowDigest({ kind: input.kind, params: input.params, dependsOn: input.dependsOn });
  const existing = getWorkflowStep(store, input.runId, input.key);
  if (existing) {
    if (existing.digest !== digest || existing.ordinal !== input.ordinal || workflowDigest({ kind: existing.kind, params: existing.params, dependsOn: existing.dependsOn }) !== existing.digest) throw new WorkflowError("replay_diverged");
    return existing;
  }
  const run = requireWorkflowRun(store, input.runId);
  if (!["running", "waiting"].includes(run.status)) throw new WorkflowError("run_inactive");
  const steps = listWorkflowSteps(store, input.runId);
  if (input.ordinal !== steps.length + 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.key)) throw new WorkflowError("replay_diverged");
  if (input.dependsOn.some(key => !steps.some(step => step.key === key))) throw new WorkflowError("dependency_missing");
  const step: WorkflowStep = { ...input, digest, status: "queued", result: null, rawOutput: null, outputArtifact: null, resultRecorded: false, delivery: null, attempts: 0 };
  store.db.prepare("INSERT INTO workflow_steps (run_id, key, ordinal, payload) VALUES (?, ?, ?, ?)").run(step.runId, step.key, step.ordinal, JSON.stringify(step));
  store.appendEvent({ type: "workflow.step", runId: step.runId, key: step.key, status: step.status, delivery: null }, { sessionId: run.source.sessionId });
  return step;
}
export function finishWorkflowStep(store: Store, runId: string, key: string, status: "completed" | "failed" | "skipped" | "canceled", result: unknown, rawOutput: string | null = null): WorkflowStep {
  const step = getWorkflowStep(store, runId, key);
  if (!step) throw new WorkflowError("step_missing");
  if (step.resultRecorded) return step;
  workflowJson(result);
  if (rawOutput !== null) workflowJson(rawOutput);
  const finished = { ...step, status, result, rawOutput, resultRecorded: true };
  updateWorkflowStep(store, finished);
  return finished;
}
/** 返回给脚本之前记录交付序号；重放只按该顺序兑现 Promise。 */
export function deliverWorkflowStep(store: Store, runId: string, key: string): WorkflowStep {
  const step = getWorkflowStep(store, runId, key);
  if (!step?.resultRecorded) throw new WorkflowError("result_missing");
  if (step.delivery !== null) return step;
  const run = requireWorkflowRun(store, runId);
  if (!["running", "waiting"].includes(run.status)) throw new WorkflowError("run_inactive");
  const delivery = Math.max(0, ...listWorkflowSteps(store, runId).map(item => item.delivery ?? 0)) + 1;
  const delivered = { ...step, delivery };
  updateWorkflowStep(store, delivered);
  return delivered;
}
export function getWorkflowExecution(store: Store, taskId: string): WorkflowExecution | null {
  const row = store.db.prepare("SELECT payload FROM workflow_executions WHERE task_id = ?").get(taskId) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as WorkflowExecution : null;
}
export function listWorkflowExecutions(store: Store, runId: string): WorkflowExecution[] {
  const rows = store.db.prepare("SELECT payload FROM workflow_executions WHERE run_id = ? ORDER BY rowid").all(runId) as { payload: string }[];
  return rows.map(row => JSON.parse(row.payload) as WorkflowExecution);
}
export function updateWorkflowExecution(store: Store, taskId: string, patch: Partial<Pick<WorkflowExecution, "units" | "stopVerified" | "status">>): WorkflowExecution {
  const existing = getWorkflowExecution(store, taskId);
  if (!existing) throw new WorkflowError("execution_missing");
  const execution = { ...existing, ...patch };
  store.db.prepare("UPDATE workflow_executions SET payload = ? WHERE task_id = ?").run(JSON.stringify(execution), taskId);
  store.appendEvent({ type: "workflow.execution", runId: execution.runId, taskId, kind: execution.kind, status: execution.status, stopVerified: execution.stopVerified }, { taskId, sessionId: requireWorkflowRun(store, execution.runId).source.sessionId });
  return execution;
}
export function bindWorkflowExecution(store: Store, execution: WorkflowExecution): void {
  const run = requireWorkflowRun(store, execution.runId);
  if (!["running", "waiting"].includes(run.status) || !store.getTask(execution.taskId) || !getWorkflowStep(store, run.id, execution.stepKey)) throw new WorkflowError("run_inactive");
  store.db.prepare("INSERT INTO workflow_executions (id, run_id, step_key, kind, task_id, number, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(execution.id, execution.runId, execution.stepKey, execution.kind, execution.taskId, execution.number, JSON.stringify(execution));
  updateWorkflowExecution(store, execution.taskId, {});
}
/** 并发含未核实占用；普通委派与工作流在同一来源会话的启动事务内使用。 */
export function workflowSlotsUsed(store: Store, sourceSessionId: string): number {
  const row = store.db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM tasks t
    JOIN work_delegations w ON w.id = t.work_id
    WHERE w.parent_session_id = ? AND t.source_event_id IS NULL AND
    (t.status IN ('running','awaiting_confirmation') OR EXISTS (SELECT 1 FROM occupancy o WHERE o.task_id = t.id))`).get(sourceSessionId) as { n: number };
  return row.n;
}
/** 实际开始前预留尝试与预算；任务转 running 和占用须在调用方同一事务完成。 */
export function startWorkflowExecution(store: Store, taskId: string, now = Date.now()): boolean {
  const execution = getWorkflowExecution(store, taskId);
  if (!execution || execution.status !== "queued") return false;
  const run = chargeWorkflow(requireWorkflowRun(store, execution.runId), now);
  if (run.status !== "running") return false;
  if (run.usedMs >= run.durationMs || (execution.kind === "agent" && run.attempts >= run.maxAttempts)) {
    setWorkflowState(store, run.id, "paused", run.usedMs >= run.durationMs ? "duration_limit" : "attempt_limit", now);
    return false;
  }
  if (execution.kind === "agent" && workflowSlotsUsed(store, run.source.sessionId) >= WORKFLOW_LIMITS.concurrency) return false;
  updateWorkflowRun(store, { ...run, attempts: run.attempts + (execution.kind === "agent" ? 1 : 0), clockStartedAt: now });
  updateWorkflowExecution(store, taskId, { status: "running" });
  return true;
}
export function getWorkflowQuestion(store: Store, runId: string, key: string): WorkflowQuestion | null {
  const row = store.db.prepare("SELECT payload FROM workflow_questions WHERE run_id = ? AND step_key = ?").get(runId, key) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as WorkflowQuestion : null;
}
export function saveWorkflowQuestion(store: Store, question: WorkflowQuestion): void {
  store.db.prepare("INSERT INTO workflow_questions (run_id, step_key, payload) VALUES (?, ?, ?) ON CONFLICT(run_id, step_key) DO UPDATE SET payload = excluded.payload")
    .run(question.runId, question.stepKey, JSON.stringify(question));
  store.appendEvent({ type: "workflow.step", runId: question.runId, key: question.stepKey, status: question.status === "pending" ? "waiting" : question.status === "answered" ? "completed" : "canceled", delivery: null }, { sessionId: question.source.sessionId });
}
export type WorkflowControl = { action: "pause" | "cancel" } | { action: "resume"; clockConfirmed?: boolean; stopsConfirmed?: boolean } | { action: "budget"; maxAttempts: number; durationMs: number };
/** 控制面和 IM 的 JSON 边界；内部调用使用 WorkflowControl，不重复解析。 */
export function parseWorkflowControl(value: unknown): WorkflowControl {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorkflowError("invalid_params");
  const input = value as Record<string, unknown>;
  const keys = input.action === "budget" ? ["action", "maxAttempts", "durationMs"] : input.action === "resume" ? ["action", "clockConfirmed", "stopsConfirmed"] : ["action"];
  if (Object.keys(input).some(key => !keys.includes(key))) throw new WorkflowError("invalid_params");
  if (input.action === "pause" || input.action === "cancel") return { action: input.action };
  if (input.action === "resume") {
    if ([input.clockConfirmed, input.stopsConfirmed].some(item => item !== undefined && typeof item !== "boolean")) throw new WorkflowError("invalid_params");
    return { action: "resume", ...(input.clockConfirmed !== undefined ? { clockConfirmed: input.clockConfirmed as boolean } : {}),
      ...(input.stopsConfirmed !== undefined ? { stopsConfirmed: input.stopsConfirmed as boolean } : {}) };
  }
  if (input.action === "budget" && Number.isSafeInteger(input.maxAttempts) && Number(input.maxAttempts) > 0 && Number.isSafeInteger(input.durationMs) && Number(input.durationMs) > 0) {
    return { action: "budget", maxAttempts: input.maxAttempts as number, durationMs: input.durationMs as number };
  }
  throw new WorkflowError("invalid_params");
}
export function hasWorkflowControl(store: Store, runId: string, key: string): boolean {
  return store.db.prepare("SELECT 1 FROM workflow_controls WHERE run_id = ? AND request_key = ?").get(runId, key) !== undefined;
}
export function getWorkflowControlDigest(store: Store, runId: string, key: string): string | null {
  const row = store.db.prepare("SELECT digest FROM workflow_controls WHERE run_id = ? AND request_key = ?").get(runId, key) as { digest: string } | undefined;
  return row?.digest ?? null;
}
/** 可信宿主入口提供版本和稳定键；脚本不取得此函数。重放先于版本及状态检查。 */
export function controlWorkflow(store: Store, id: string, key: string, version: number, control: WorkflowControl, now = Date.now()): WorkflowRun {
  const digest = workflowDigest({ version, control });
  const row = store.db.prepare("SELECT digest, payload FROM workflow_controls WHERE run_id = ? AND request_key = ?").get(id, key) as { digest: string; payload: string } | undefined;
  if (row) {
    if (row.digest !== digest) throw new WorkflowError("request_conflict");
    return JSON.parse(row.payload) as WorkflowRun;
  }
  let run = requireWorkflowRun(store, id);
  if (run.version !== version) throw new WorkflowError("version_conflict");
  if (workflowTerminal(run.status)) throw new WorkflowError("run_terminal");
  if (control.action === "budget") {
    if (!Number.isSafeInteger(control.maxAttempts) || control.maxAttempts <= 0 || !Number.isSafeInteger(control.durationMs) || control.durationMs <= 0) throw new WorkflowError("invalid_budget");
    run = updateWorkflowRun(store, { ...chargeWorkflow(run, now), maxAttempts: control.maxAttempts, durationMs: control.durationMs });
  } else if (control.action === "resume") {
    if (control.clockConfirmed && !run.clockVerified) run = updateWorkflowRun(store, { ...run, clockVerified: true });
    if (control.stopsConfirmed && !listWorkflowExecutions(store, id).some(execution => {
      const task = store.getTask(execution.taskId);
      return !task || ["running", "awaiting_confirmation"].includes(task.status) || store.listAllOccupancy().some(held => held.taskId === execution.taskId);
    })) {
      for (const execution of listWorkflowExecutions(store, id)) {
        if (execution.status !== "queued") updateWorkflowExecution(store, execution.taskId, { status: "finished", stopVerified: true });
      }
      run = updateWorkflowRun(store, { ...run, scriptStopVerified: true });
    }
    if (run.status !== "paused" || ["effect_unknown", "write_result_missing", "replay_diverged", "result_missing", "definition_missing", "source_invalid"].includes(run.reason ?? "") ||
        !run.clockVerified || (run.scriptUnits.length > 0 && run.scriptStopVerified !== true) ||
        listWorkflowExecutions(store, id).some(execution => execution.status === "running" || execution.stopVerified === false || store.listAllOccupancy().some(held => held.taskId === execution.taskId))) throw new WorkflowError("verification_required");
    run = setWorkflowState(store, id, "running", null, now);
  } else {
    if (!(control.action === "pause" && run.status === "paused")) {
      run = setWorkflowState(store, id, control.action === "cancel" ? "canceled" : "paused", control.action === "cancel" ? "owner_cancel" : "owner_pause", now);
    }
    if (control.action === "cancel") {
      for (const step of listWorkflowSteps(store, id)) {
        if (!step.resultRecorded) finishWorkflowStep(store, id, step.key, "canceled", { status: "canceled", code: "owner_cancel" });
        const question = getWorkflowQuestion(store, id, step.key);
        if (question?.status === "pending") saveWorkflowQuestion(store, { ...question, version: question.version + 1, status: "canceled" });
      }
      for (const execution of listWorkflowExecutions(store, id)) {
        const task = store.getTask(execution.taskId)!;
        if (task.status === "queued") store.endTask(task.id, ["queued"], "canceled", { errorMessage: "workflow_canceled" });
        else if (["running", "awaiting_confirmation"].includes(task.status)) store.setCancelRequested(task.id, true);
      }
    }
  }
  store.db.prepare("INSERT INTO workflow_controls (run_id, request_key, digest, payload) VALUES (?, ?, ?, ?)").run(id, key, digest, JSON.stringify(run));
  return run;
}
/** 再核实执行与账本前只恢复未开始的登记；正在计时的崩溃不能自动补足预算。 */
export function recoverWorkflowRuns(store: Store, now = Date.now()): void {
  for (const run of listWorkflowRuns(store)) {
    if (workflowTerminal(run.status)) continue;
    if (run.clockStartedAt !== null) {
      updateWorkflowRun(store, { ...run, clockVerified: false });
      setWorkflowState(store, run.id, "paused", "clock_unverified", now);
    }
    else if (run.scriptUnits.length > 0 && run.scriptStopVerified !== true) setWorkflowState(store, run.id, "paused", "stop_unverified", now);
  }
}
export function workflowTaskSource(store: Store, task: Task): WorkflowSource | null {
  const execution = getWorkflowExecution(store, task.id);
  return execution ? requireWorkflowRun(store, execution.runId).source : null;
}
