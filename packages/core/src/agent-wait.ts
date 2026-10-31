/** 等待阶段、结果消费与报告认领；所有写入由调用方 Store.withTx 包住。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md
 */
import { isDeepStrictEqual } from "node:util";
import type { Store } from "./store.ts";
import type { SubAgentRoleCatalogSnapshot } from "./subagent-definition.ts";
import { isTerminalTaskStatus } from "./types.ts";
import { getWorkflowRunNumber, listWorkflowExecutions, requireWorkflowRun, workflowTerminal, type WorkflowSource } from "./workflow.ts";
import { getCodeScheduledTaskSource } from "./code-scheduler.ts";

export type AgentWaitTarget = { kind: "task"; taskId: string } | { kind: "workflow"; runId: string };
export type AgentReportTarget = { kind: "task"; taskId: string } | { kind: "workflow"; runId: string; terminalVersion: number };
export type AgentWaitPhase = "releasing" | "waiting" | "conversation" | "reacquiring" | "ended";
export interface AgentWaitView {
  id: string;
  phase: AgentWaitPhase;
  reason: string | null;
  deadline: string | null;
  targets: { kind: AgentWaitTarget["kind"]; id: string; label: string; status: string }[];
}

/** 正文钉在保护库内，内部对话阶段不得重新读取工作目录中的指令或技能。 */
export interface AgentReferenceSnapshot {
  taskId: string;
  permissionVersion: number;
  selectionRecordId: string | null;
  promptArtifactId: string | null;
  instructions: { text: string; version: string; problems: string[] } | null;
  skills: { skills: { name: string; description: string; disableModelInvocation: boolean; dir: string; body: string; version: string; id?: string; source?: "external" | "managed"; readOnly?: boolean; contentRevision?: string }[]; diagnostics: string[]; version: string } | null;
  roles?: SubAgentRoleCatalogSnapshot | null;
}
export type AgentWaitSnapshot = AgentReferenceSnapshot;

export interface AgentWait {
  id: string;
  sdkCallId: string;
  deadline: string | null;
  taskId: string;
  sessionId: string;
  targets: AgentWaitTarget[];
  source: WorkflowSource;
  sourceEventId: string | null;
  snapshot: AgentReferenceSnapshot;
  phase: AgentWaitPhase;
  reason: string | null;
  createdAt: string;
  endedAt: string | null;
}
export interface AgentReport {
  key: string;
  target: AgentReportTarget;
  source: WorkflowSource;
  sourceEventId: string | null;
  parentSessionId: string;
  dependencyTaskIds: string[];
  claimTaskId: string | null;
  fallbackTaskId: string | null;
  parkedFallbackTaskIds: string[];
  fallbackState: "queued" | "parked" | "running" | "completed" | null;
  consumption: { taskId: string; entryId: string; consumedAt: string } | null;
  proof: { taskId: string; entryId: string | null; outboxOpId: string | null } | null;
  status: "pending" | "reported" | "undelivered";
  reason: string | null;
}
export class AgentWaitError extends Error {
  constructor(readonly code: string) { super(`等待 ${code}：保留结果与原报告键，请核实后继续`); }
}

export function sameAgentReportSource(a: WorkflowSource, b: WorkflowSource): boolean {
  return a.taskId === b.taskId && a.sessionId === b.sessionId && a.projectId === b.projectId &&
    a.scheduledRunId === b.scheduledRunId && a.codeScheduledRunId === b.codeScheduledRunId && isDeepStrictEqual(a.replyTarget, b.replyTarget);
}
export function agentReportKey(target: AgentReportTarget): string {
  return target.kind === "task" ? `task:${target.taskId}` : `workflow:${target.runId}:${target.terminalVersion}`;
}
function sourceEventId(store: Store, source: WorkflowSource): string | null {
  const task = store.getTask(source.taskId);
  if (!task || task.sessionId !== source.sessionId || store.getSession(source.sessionId)?.projectId !== source.projectId) throw new AgentWaitError("source_invalid");
  const scheduled = getCodeScheduledTaskSource(store, task.id);
  if (source.codeScheduledRunId !== scheduled?.runId) throw new AgentWaitError("source_invalid");
  const event = task.sourceEventId ? store.getInboundEvent(task.sourceEventId) : null;
  if (task.sourceEventId && !event) throw new AgentWaitError("source_invalid");
  if (!source.scheduledRunId && !isDeepStrictEqual(event?.replyTarget ?? null, source.replyTarget)) throw new AgentWaitError("source_invalid");
  return task.sourceEventId;
}
function targetSource(store: Store, target: AgentWaitTarget): { sourceTaskId: string; parentSessionId: string } {
  if (target.kind === "workflow") {
    const run = requireWorkflowRun(store, target.runId);
    return { sourceTaskId: run.source.taskId, parentSessionId: run.source.sessionId };
  }
  const task = store.getTask(target.taskId);
  const work = task?.workId ? store.getWorkDelegation(task.workId) : null;
  if (!task?.subAgentId || !work) throw new AgentWaitError("target_invalid");
  return { sourceTaskId: work.originTaskId, parentSessionId: work.parentSessionId };
}
function checkTargets(store: Store, targets: AgentWaitTarget[], sessionId: string, source: WorkflowSource): void {
  if (!targets.length || targets.length > 20 || new Set(targets.map(target => target.kind === "task" ? `task:${target.taskId}` : `workflow:${target.runId}`)).size !== targets.length) throw new AgentWaitError("targets_invalid");
  for (const target of targets) {
    const origin = targetSource(store, target);
    if (origin.sourceTaskId !== source.taskId || origin.parentSessionId !== sessionId) throw new AgentWaitError("source_mismatch");
    if (target.kind === "workflow" && !sameAgentReportSource(requireWorkflowRun(store, target.runId).source, source)) throw new AgentWaitError("source_mismatch");
  }
}
function checkTaskSource(store: Store, taskId: string, source: WorkflowSource): void {
  const waits = listAgentWaits(store, { taskId });
  if (waits.some(wait => !sameAgentReportSource(wait.source, source))) throw new AgentWaitError("source_mismatch");
}
function waitEvent(store: Store, wait: AgentWait): void {
  store.appendEvent({ type: "agent_wait.changed", waitId: wait.id, taskId: wait.taskId, phase: wait.phase, reason: wait.reason, wait: agentWaitView(store, wait) }, { taskId: wait.taskId, sessionId: wait.sessionId });
}
export function agentWaitView(store: Store, wait: AgentWait): AgentWaitView {
  return { id: wait.id, phase: wait.phase, reason: wait.reason, deadline: wait.deadline,
    targets: wait.targets.map(target => {
      if (target.kind === "workflow") {
        const run = requireWorkflowRun(store, target.runId);
        return { kind: target.kind, id: target.runId, label: `工作流 · ${run.displayName ?? "未命名工作流"} · 第 ${getWorkflowRunNumber(store, run.id)} 项 · ${run.createdAt}`, status: run.status };
      }
      const task = store.getTask(target.taskId);
      return { kind: target.kind, id: target.taskId, label: `SubAgent 任务 · ${task?.createdAt ?? "目标缺失"}`, status: task?.status ?? "missing" };
    }) };
}
function reportEvent(store: Store, report: AgentReport): void {
  store.appendEvent({ type: "agent_report.changed", key: report.key, taskId: report.claimTaskId ?? report.fallbackTaskId, status: report.status, reason: report.reason,
    fallbackTaskId: report.fallbackTaskId, fallbackState: report.fallbackState, parkedFallbackTaskIds: report.parkedFallbackTaskIds }, { taskId: report.claimTaskId ?? report.fallbackTaskId, sessionId: report.parentSessionId });
}
function saveWait(store: Store, wait: AgentWait): AgentWait {
  store.db.prepare("UPDATE agent_waits SET payload = ? WHERE id = ?").run(JSON.stringify(wait), wait.id);
  waitEvent(store, wait);
  return wait;
}
function saveReport(store: Store, report: AgentReport): AgentReport {
  store.db.prepare("UPDATE agent_reports SET payload = ? WHERE report_key = ?").run(JSON.stringify(report), report.key);
  reportEvent(store, report);
  return report;
}
export function getAgentWait(store: Store, id: string): AgentWait | null {
  const row = store.db.prepare("SELECT payload FROM agent_waits WHERE id = ?").get(id) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as AgentWait : null;
}
export function listAgentWaits(store: Store, input: { taskId?: string; sessionId?: string } = {}): AgentWait[] {
  const rows = store.db.prepare("SELECT payload FROM agent_waits WHERE (? IS NULL OR task_id = ?) AND (? IS NULL OR session_id = ?) ORDER BY rowid")
    .all(input.taskId ?? null, input.taskId ?? null, input.sessionId ?? null, input.sessionId ?? null) as { payload: string }[];
  return rows.map(row => JSON.parse(row.payload) as AgentWait);
}
export function latestAgentReferenceSnapshot(store: Store, sessionId: string): AgentReferenceSnapshot | null {
  return listAgentWaits(store, { sessionId }).at(-1)?.snapshot ?? null;
}
export function agentWaitCovers(store: Store, target: AgentWaitTarget, sessionId: string): boolean {
  return listAgentWaits(store, { sessionId }).some(wait => wait.targets.some(candidate => isDeepStrictEqual(candidate, target)));
}
export function registerAgentWait(store: Store, input: Omit<AgentWait, "phase" | "reason" | "createdAt" | "endedAt" | "sourceEventId">): AgentWait {
  const existing = getAgentWait(store, input.id);
  if (existing) {
    const { phase: _phase, reason: _reason, createdAt: _createdAt, endedAt: _endedAt, sourceEventId: _sourceEventId, ...registered } = existing;
    if (!isDeepStrictEqual(registered, input)) throw new AgentWaitError("request_conflict");
    return existing;
  }
  const task = store.getTask(input.taskId);
  if (!task || task.sessionId !== input.sessionId || !["running", "awaiting_confirmation"].includes(task.status) || task.cancelRequested || input.snapshot.taskId !== task.id || input.snapshot.permissionVersion !== task.permissionVersion) throw new AgentWaitError("task_inactive");
  if (!input.sdkCallId || (input.deadline !== null && !Number.isFinite(Date.parse(input.deadline))) || input.targets.some(target => target.kind === "task" && target.taskId === task.id)) throw new AgentWaitError("targets_invalid");
  if (listAgentWaits(store, { taskId: input.taskId }).some(wait => wait.phase !== "ended")) throw new AgentWaitError("already_waiting");
  checkTargets(store, input.targets, input.sessionId, input.source);
  checkTaskSource(store, input.taskId, input.source);
  const wait: AgentWait = { ...input, sourceEventId: sourceEventId(store, input.source), phase: "releasing", reason: null, createdAt: new Date().toISOString(), endedAt: null };
  store.db.prepare("INSERT INTO agent_waits (id, task_id, session_id, payload) VALUES (?, ?, ?, ?)").run(wait.id, wait.taskId, wait.sessionId, JSON.stringify(wait));
  waitEvent(store, wait);
  return wait;
}
export function setAgentWaitPhase(store: Store, id: string, phase: Exclude<AgentWaitPhase, "ended">): AgentWait {
  const wait = getAgentWait(store, id);
  if (!wait) throw new AgentWaitError("wait_missing");
  if (wait.phase === "ended") throw new AgentWaitError("wait_ended");
  return wait.phase === phase ? wait : saveWait(store, { ...wait, phase });
}
export function endAgentWait(store: Store, id: string, reason: string): AgentWait {
  const wait = getAgentWait(store, id);
  if (!wait) throw new AgentWaitError("wait_missing");
  return wait.phase === "ended" ? wait : saveWait(store, { ...wait, phase: "ended", reason, endedAt: new Date().toISOString() });
}
export function getAgentReport(store: Store, key: string): AgentReport | null {
  const row = store.db.prepare("SELECT payload FROM agent_reports WHERE report_key = ?").get(key) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as AgentReport : null;
}
export function listAgentReports(store: Store, input: { parentSessionId?: string; taskId?: string } = {}): AgentReport[] {
  const rows = store.db.prepare("SELECT payload FROM agent_reports WHERE (? IS NULL OR parent_session_id = ?) ORDER BY rowid").all(input.parentSessionId ?? null, input.parentSessionId ?? null) as { payload: string }[];
  const reports = rows.map(row => JSON.parse(row.payload) as AgentReport);
  return input.taskId ? reports.filter(report => report.claimTaskId === input.taskId || report.fallbackTaskId === input.taskId || report.parkedFallbackTaskIds.includes(input.taskId!) || report.consumption?.taskId === input.taskId || report.proof?.taskId === input.taskId) : reports;
}
export function registerAgentReport(store: Store, input: Pick<AgentReport, "target" | "source" | "parentSessionId">): AgentReport {
  const key = agentReportKey(input.target), existing = getAgentReport(store, key);
  if (existing) {
    if (existing.parentSessionId !== input.parentSessionId || !isDeepStrictEqual(existing.target, input.target) || !sameAgentReportSource(existing.source, input.source)) throw new AgentWaitError("source_mismatch");
    return existing;
  }
  checkTargets(store, [input.target.kind === "task" ? input.target : { kind: "workflow", runId: input.target.runId }], input.parentSessionId, input.source);
  if (input.target.kind === "task") {
    const task = store.getTask(input.target.taskId)!;
    if (!isTerminalTaskStatus(task.status) || task.resultSummary === null) throw new AgentWaitError("result_pending");
  } else {
    const run = requireWorkflowRun(store, input.target.runId);
    if (!workflowTerminal(run.status) || run.terminalVersion !== input.target.terminalVersion) throw new AgentWaitError("result_pending");
  }
  const dependencyTaskIds = input.target.kind === "workflow" ? listWorkflowExecutions(store, input.target.runId).map(execution => execution.taskId)
    : (store.db.prepare("SELECT id FROM tasks WHERE session_id = (SELECT session_id FROM tasks WHERE id = ?) AND rowid <= (SELECT rowid FROM tasks WHERE id = ?) ORDER BY rowid")
      .all(input.target.taskId, input.target.taskId) as { id: string }[]).map(task => task.id);
  const report: AgentReport = { ...input, key, dependencyTaskIds, sourceEventId: sourceEventId(store, input.source), claimTaskId: null, fallbackTaskId: null, parkedFallbackTaskIds: [], fallbackState: null, consumption: null, proof: null, status: "pending", reason: null };
  store.db.prepare("INSERT INTO agent_reports (report_key, parent_session_id, payload) VALUES (?, ?, ?)").run(key, input.parentSessionId, JSON.stringify(report));
  reportEvent(store, report);
  return report;
}

/** 整批认领先核实所有目标；排队后备只停车，不改变任务及其原幂等键。 */
export function claimAgentReports(store: Store, input: { taskId: string; keys: string[] }): AgentReport[] {
  const task = store.getTask(input.taskId);
  if (!task || !["running", "awaiting_confirmation"].includes(task.status) || task.cancelRequested) throw new AgentWaitError("task_inactive");
  const reports = input.keys.map(key => {
    const report = getAgentReport(store, key);
    if (!report) throw new AgentWaitError("report_missing");
    if (report.status !== "pending" || report.parentSessionId !== task.sessionId || (report.claimTaskId && report.claimTaskId !== task.id) || report.fallbackState === "running" || report.fallbackState === "completed") throw new AgentWaitError("report_owned");
    if (report.consumption && report.consumption.taskId !== task.id) {
      const consumer = store.getTask(report.consumption.taskId);
      if (!consumer || !isTerminalTaskStatus(consumer.status)) throw new AgentWaitError("result_consumed");
    }
    if (report.fallbackTaskId && store.getTask(report.fallbackTaskId)?.status !== "queued") throw new AgentWaitError("report_owned");
    checkTargets(store, [report.target.kind === "task" ? report.target : { kind: "workflow", runId: report.target.runId }], task.sessionId, report.source);
    if (store.getSessionIdentity(task.sessionId)?.kind !== "dev") checkTaskSource(store, task.id, report.source);
    return report;
  });
  if (!reports.length || new Set(input.keys).size !== input.keys.length) throw new AgentWaitError("source_mismatch");
  const requested = new Set(input.keys), pending = listAgentReports(store).filter(report => report.status === "pending");
  if (reports.some(report => report.fallbackTaskId && pending.some(candidate => candidate.fallbackTaskId === report.fallbackTaskId && !requested.has(candidate.key)))) throw new AgentWaitError("report_group_partial");
  return reports.map(report => report.claimTaskId === task.id ? report : saveReport(store, { ...report, claimTaskId: task.id, fallbackState: report.fallbackTaskId ? "parked" : null, reason: null }));
}

/** entryId 是已写历史的输入证明；调用者只在模型实际接受内容后登记，恢复按该标记补记。 */
export function consumeAgentReport(store: Store, key: string, input: { taskId: string; entryId: string }): boolean {
  const report = getAgentReport(store, key);
  if (!report) throw new AgentWaitError("report_missing");
  if (report.consumption) return report.consumption.taskId === input.taskId && report.consumption.entryId === input.entryId;
  if (!input.entryId || report.status !== "pending" || (report.claimTaskId !== input.taskId && !(report.fallbackTaskId === input.taskId && report.fallbackState === "running"))) throw new AgentWaitError("report_unclaimed");
  saveReport(store, { ...report, consumption: { ...input, consumedAt: new Date().toISOString() } });
  if (report.target.kind === "task") store.markSubAgentResultsDelivered([report.target.taskId], new Date().toISOString());
  return true;
}
export function releaseAgentReports(store: Store, taskId: string, reason: string): AgentReport[] {
  return listAgentReports(store).filter(report => report.claimTaskId === taskId && report.status === "pending").map(report => saveReport(store, {
    ...report, claimTaskId: null, fallbackState: report.fallbackState === "parked" ? "queued" : report.fallbackState, reason,
  }));
}
/** 来源失效时保留消费与已知报告证明；排队后备继续停车，不能换模型重建报告。 */
export function invalidateAgentReports(store: Store, keys: string[], reason: string): AgentReport[] {
  const selected = keys.map(key => {
    const report = getAgentReport(store, key);
    if (!report) throw new AgentWaitError("report_missing");
    return report;
  });
  const fallbacks = new Set(selected.map(report => report.fallbackTaskId).filter(id => id !== null));
  const reports = listAgentReports(store).filter(report => keys.includes(report.key) || (report.fallbackTaskId !== null && fallbacks.has(report.fallbackTaskId)));
  return reports.map(report => report.status !== "pending" ? report : saveReport(store, { ...report, status: "undelivered", reason,
    claimTaskId: null, fallbackState: report.fallbackTaskId && (report.fallbackState === "queued" || report.fallbackState === "parked") ? "parked" : report.fallbackState }));
}
export interface AgentReportCompletion {
  status: "reported" | "undelivered";
  reason?: string | null;
  entryId?: string | null;
  outboxOpId?: string | null;
  reportInput?: { entryId: string; keys: string[] };
}
/** 共享后备须整组接受事实，否则释放；接管旧消费须由宿主核实本轮 JSONL 输入证明。 */
export function completeAgentReports(store: Store, taskId: string, input: AgentReportCompletion, keys?: string[]): AgentReport[] {
  const pending = listAgentReports(store).filter(report => report.status === "pending");
  const claimed = pending.filter(report => report.claimTaskId === taskId && (!keys || keys.includes(report.key))), deferred: AgentReport[] = [];
  const accepted = (report: AgentReport) => Boolean(report.consumption && (report.consumption.taskId === taskId ||
    input.reportInput?.entryId && input.reportInput.keys.includes(report.key)));
  for (const fallbackTaskId of new Set(claimed.map(report => report.fallbackTaskId).filter(id => id !== null))) {
    const group = pending.filter(report => report.fallbackTaskId === fallbackTaskId);
    if (group.length > 1 && group.some(report => report.claimTaskId !== taskId || !accepted(report))) {
      if (group.some(report => report.claimTaskId && report.claimTaskId !== taskId)) throw new AgentWaitError("report_group_partial");
      deferred.push(...group);
    }
  }
  const deferredKeys = new Set(deferred.map(report => report.key));
  const reports = claimed.filter(report => !deferredKeys.has(report.key));
  for (const report of deferred) saveReport(store, { ...report, claimTaskId: null, fallbackState: "queued", reason: "report_group_not_consumed" });
  const completed = reports.filter(accepted).map(report => saveReport(store, { ...report,
    status: input.status, reason: input.reason ?? null, proof: { taskId, entryId: input.entryId ?? null, outboxOpId: input.outboxOpId ?? null } }));
  for (const report of reports.filter(report => !accepted(report))) saveReport(store, { ...report,
    claimTaskId: null, fallbackState: report.fallbackState === "parked" ? "queued" : report.fallbackState, reason: "parent_result_not_consumed" });
  return completed;
}
export function bindAgentReportFallback(store: Store, key: string, taskId: string): AgentReport {
  const report = getAgentReport(store, key), task = store.getTask(taskId);
  if (!report || !task || task.sessionId !== report.parentSessionId) throw new AgentWaitError("fallback_invalid");
  if (report.fallbackTaskId) {
    if (report.fallbackTaskId !== taskId) throw new AgentWaitError("report_owned");
    return report;
  }
  if (report.status !== "pending") throw new AgentWaitError("report_owned");
  const workflow = report.target.kind === "workflow" ? requireWorkflowRun(store, report.target.runId) : null;
  const ordinary = report.target.kind === "task" && task.requestId === `wake:${report.target.taskId}` && task.parentTaskId === report.target.taskId;
  if (task.status !== "queued" && workflow?.delivery?.taskId !== task.id && !ordinary) throw new AgentWaitError("fallback_invalid");
  const fallbackState = task.status === "queued" ? report.claimTaskId ? "parked" : "queued" : isTerminalTaskStatus(task.status) ? "completed" : "running";
  if (report.claimTaskId && fallbackState !== "parked") throw new AgentWaitError("report_owned");
  return saveReport(store, { ...report, fallbackTaskId: taskId, fallbackState });
}
/** 只把尚未运行的后备并到其中一个原任务；被替代任务及原键保留为停车身份。 */
export function transferAgentReportFallbacks(store: Store, keys: string[], canonicalTaskId: string): AgentReport[] {
  const reports = keys.map(key => {
    const report = getAgentReport(store, key);
    if (!report) throw new AgentWaitError("report_missing");
    return report;
  });
  const canonical = store.getTask(canonicalTaskId);
  if (!reports.length || new Set(keys).size !== keys.length || !canonical || canonical.status !== "queued" || !reports.some(report => report.fallbackTaskId === canonicalTaskId)) throw new AgentWaitError("fallback_invalid");
  if (reports.some(report => report.status !== "pending" || report.claimTaskId || report.parentSessionId !== canonical.sessionId || !sameAgentReportSource(report.source, reports[0].source) ||
      (report.fallbackTaskId && (!["queued", "parked"].includes(report.fallbackState ?? "") || store.getTask(report.fallbackTaskId)?.status !== "queued")))) throw new AgentWaitError("report_owned");
  if (listAgentReports(store).some(report => report.status === "pending" && report.fallbackTaskId && reports.some(item => item.fallbackTaskId === report.fallbackTaskId) && !keys.includes(report.key))) throw new AgentWaitError("report_group_partial");
  return reports.map(report => {
    if (report.fallbackTaskId === canonicalTaskId && report.fallbackState === "queued") return report;
    const parkedFallbackTaskIds = [...new Set([...report.parkedFallbackTaskIds, ...(report.fallbackTaskId && report.fallbackTaskId !== canonicalTaskId ? [report.fallbackTaskId] : [])])];
    return saveReport(store, { ...report, fallbackTaskId: canonicalTaskId, fallbackState: "queued", parkedFallbackTaskIds });
  });
}
export function isAgentReportFallback(store: Store, taskId: string): boolean { return listAgentReports(store).some(report => report.fallbackTaskId === taskId || report.parkedFallbackTaskIds.includes(taskId)); }
/** 旧后备也要等同父轮其余目标收尾；停车保留原键，最后一项结果到达后整组归并。 */
export function parkAgentReportFallback(store: Store, taskId: string, reason: string): void {
  const task = store.getTask(taskId), reports = listAgentReports(store).filter(report => report.fallbackTaskId === taskId && report.status === "pending");
  if (!task || task.status !== "queued" || reports.some(report => report.claimTaskId || !["queued", "parked"].includes(report.fallbackState ?? ""))) throw new AgentWaitError("report_owned");
  for (const report of reports) if (report.fallbackState !== "parked" || report.reason !== reason) saveReport(store, { ...report, fallbackState: "parked", reason });
}
export function isAgentReportParked(store: Store, taskId: string): boolean { return listAgentReports(store).some(report => report.parkedFallbackTaskIds.includes(taskId) || (report.fallbackTaskId === taskId && report.fallbackState === "parked")); }
export function startAgentReportFallback(store: Store, taskId: string): AgentReport[] {
  const reports = listAgentReports(store).filter(report => report.fallbackTaskId === taskId);
  if (!reports.length || reports.some(report => report.status !== "pending" || report.claimTaskId || report.fallbackState !== "queued")) throw new AgentWaitError("report_owned");
  return reports.map(report => saveReport(store, { ...report, fallbackState: "running" }));
}
export function finishAgentReportFallback(store: Store, taskId: string, input: AgentReportCompletion): AgentReport[] {
  const reports = listAgentReports(store).filter(report => report.fallbackTaskId === taskId && report.status === "pending");
  const task = store.getTask(taskId);
  const endedBeforeStart = input.status === "undelivered" && task && isTerminalTaskStatus(task.status);
  if (reports.some(report => report.fallbackState !== "running" && !(endedBeforeStart && ["queued", "parked"].includes(report.fallbackState ?? "") && !report.claimTaskId))) throw new AgentWaitError("report_owned");
  return reports.map(report => saveReport(store, { ...report, status: input.status, fallbackState: "completed", reason: input.reason ?? null,
    proof: { taskId, entryId: input.entryId ?? null, outboxOpId: input.outboxOpId ?? null } }));
}
/** 重启只结束旧等待；报告认领由宿主先核实 JSONL 与发送证明再仲裁。 */
export function recoverAgentWaits(store: Store): void {
  for (const wait of listAgentWaits(store)) if (wait.phase !== "ended") endAgentWait(store, wait.id, "backend_restart");
}
