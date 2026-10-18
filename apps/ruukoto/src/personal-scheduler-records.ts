import { copyJson } from "@earendil-works/chord";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { AssistantEntry, defineDoc, defineDocFamily, defineEntry, ROOT_CONVERSATION_ID, type ConversationId, type EntryId, type SubmissionId, type TaskId, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { ScheduleRule } from "@ruukoto/channels/scheduler/time.ts";
import { PersonalError } from "./personal-error.ts";
import { telegramSourceActive, type PersonalTelegramSource } from "./personal-permissions.ts";
import type { TelegramControlInput } from "./personal-telegram-records.ts";
import { PersonalWorkDoc, type PersonalWorkRef } from "./personal-work.ts";
import type { PersonalWorkSource } from "./personal-delegation.ts";

export const PERSONAL_SCHEDULER = "personal-scheduler";
export const PERSONAL_SCHEDULED_WORK = "personal-scheduled-work";
export const SCHEDULE_SUPERVISOR_TASK = "ruukoto.schedule-supervisor";
export const SCHEDULE_RUN_TASK = "ruukoto.scheduled-run";
export const SCHEDULE_SEND_TASK = "ruukoto.schedule-send";
export const SCHEDULE_INPUT = "ruukoto.schedule-input";
export const SCHEDULE_SUMMARY_INPUT = "ruukoto.schedule-summary";
export function personalScheduleReportText(text: string) { return Array.from(text).length > 3900 ? Array.from(text).slice(0, 3900).join("") + "…（完整结果可从定时计划菜单读取）" : text; }
export const scheduleRequestId = (id: string) => `personal-schedule-run:${id}`;
export type PersonalScheduleScope = { tools: string[]; extensions: string[]; snapshot: JsonValue };
export type PersonalScheduleActor = { kind: "model"; conversationId: ConversationId; taskId: TaskId; requestId: string } | { kind: "local"; requestId: string } | { kind: "im"; input: TelegramControlInput; menuRequestId: string };
export type PersonalScheduleAuthority = { permission: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; source?: PersonalWorkSource; proof: JsonValue };
export type PersonalSchedule = { id: string; version: 1; requestId: string; label: string; instruction: string; rule: ScheduleRule; createdAt: string; createdBy: { actor: PersonalScheduleActor; authority: PersonalScheduleAuthority }; permission: PersonalScheduleAuthority["permission"]; telegram?: PersonalTelegramSource; scope: PersonalScheduleScope; admission: EntryId; nextDueAt: string | null; canceled: boolean; cancelEntry?: EntryId; activeRun?: string };
export type PersonalScheduleDelivery = { taskId: TaskId; admission: EntryId; text: string; claims: EntryId[]; observation?: EntryId; state: "pending" | "sending" | "sent" | "local" | "failed" | "effect_unknown" | "canceled"; platformMessageId?: string; code?: string };
export type PersonalScheduleRun = { id: string; planId: string; planVersion: 1; scheduledFor: string; mergedFrom: string; mergedThrough: string; admission: EntryId; taskId: TaskId; conversationId: ConversationId; requestId: string; submissionId?: SubmissionId; entryId?: EntryId; cancelRequested: boolean; cancelEntry?: EntryId; sealed: boolean; members: PersonalWorkRef[]; initialAnswer?: EntryId; summary?: { content: string; failed: boolean; admission: EntryId; submissionId?: SubmissionId; answer?: EntryId }; result?: { status: "completed" | "failed" | "canceled"; text: string; entry: EntryId; closedAt: string }; delivery?: PersonalScheduleDelivery };
export const PersonalSchedulesDoc = defineDoc<{ plans: string[]; runs: string[]; supervisor?: TaskId }>({ kind: "ruukoto.schedules", scope: "session", version: 1, initial: () => ({ plans: [], runs: [] }) });
export const PersonalScheduledConversationDoc = defineDocFamily<{ runId?: string }, null>({ kind: "ruukoto.scheduled-conversation", scope: "session", version: 1, family: true, initial: () => ({}) });
export const PersonalScheduleDoc = defineDocFamily<{ plan?: PersonalSchedule }, null>({ kind: "ruukoto.schedule", scope: "session", version: 1, family: true, initial: () => ({}) });
export const PersonalScheduleRunDoc = defineDocFamily<{ run?: PersonalScheduleRun }, null>({ kind: "ruukoto.schedule-run", scope: "session", version: 1, family: true, initial: () => ({}) });
type PlanAdmissionData = Omit<PersonalSchedule, "admission" | "nextDueAt" | "canceled" | "activeRun" | "cancelEntry">;
type RunAdmissionData = Pick<PersonalScheduleRun, "id" | "planId" | "planVersion" | "scheduledFor" | "conversationId" | "taskId" | "requestId">;
export const ScheduleAdmission = defineEntry<PlanAdmissionData>("ruukoto.schedule-admission");
export const ScheduleRunAdmission = defineEntry<RunAdmissionData>("ruukoto.schedule-run-admission");
export const ScheduleSummary = defineEntry<{ runId: string; content: string; failed: boolean }>("ruukoto.schedule-summary-admission");
export const ScheduleResult = defineEntry<{ runId: string; status: "completed" | "failed" | "canceled"; text: string }>("ruukoto.schedule-result");
export const ScheduleSendAdmission = defineEntry<{ runId: string; taskId: TaskId; text: string }>("ruukoto.schedule-send-admission");
export type PersonalScheduleCancellation = { planId: string; actor: PersonalScheduleActor; authority: PersonalScheduleAuthority; activeRun?: string };
export const ScheduleCancellation = defineEntry<PersonalScheduleCancellation>("ruukoto.schedule-cancellation");
export const ScheduleRunCancellation = defineEntry<{ runId: string; reason: "task" }>("ruukoto.schedule-run-cancellation");
export const ScheduledWorkAdmission = defineEntry<{ runId: string; work: PersonalWorkRef; modelCall: TaskId; content: string; label?: string }>("ruukoto.scheduled-work-admission");
export const ScheduleSendClaim = defineEntry<{ runId: string; taskId: TaskId; text: string; telegram: PersonalTelegramSource }>("ruukoto.schedule-send-claim");
export const ScheduleSendObservation = defineEntry<{ runId: string; state: PersonalScheduleDelivery["state"]; code?: string; platformMessageId?: string }>("ruukoto.schedule-send-observation");
const invalid = () => new PersonalError("schedule_record_invalid", "定时计划的来源、运行或执行记录无法核实，已停止；请保留档案并查询原计划。");
export function scheduleAdmissionData(plan: PersonalSchedule): PlanAdmissionData { const { admission: _admission, nextDueAt: _due, canceled: _canceled, activeRun: _run, cancelEntry: _cancelEntry, ...data } = plan; return data; }
export function scheduleRunAdmissionData(run: PersonalScheduleRun): RunAdmissionData { const { id, planId, planVersion, scheduledFor, conversationId, taskId, requestId } = run; return { id, planId, planVersion, scheduledFor, conversationId, taskId, requestId }; }
export async function personalSchedule(tx: Tx, id: string) { const plan = (await tx.doc(PersonalScheduleDoc, id, null)).plan; if (!plan || plan.id !== id) throw new PersonalError("schedule_missing", "找不到原定时计划，请刷新计划列表。"); return plan; }
export async function personalScheduleRun(tx: Tx, id: string) { const run = (await tx.doc(PersonalScheduleRunDoc, id, null)).run; if (!run || run.id !== id) throw new PersonalError("schedule_run_missing", "找不到原定时运行，请刷新原计划。"); return run; }

async function verifyPlan(tx: Tx, plan: PersonalSchedule) {
  const entry = await tx.entry(ScheduleAdmission, plan.admission);
  if (plan.version !== 1 || !entry || entry.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(entry.data, scheduleAdmissionData(plan)) || !["auto-review", "confirm", "full_access"].includes(plan.permission?.mode) || !Number.isSafeInteger(plan.permission.version) || plan.permission.version < 1 || !isDeepStrictEqual(plan.permission, plan.createdBy.authority.permission) || !isDeepStrictEqual(plan.telegram, plan.createdBy.authority.telegram) || !Array.isArray(plan.scope.tools) || !Array.isArray(plan.scope.extensions) || new Set(plan.scope.tools).size !== plan.scope.tools.length || new Set(plan.scope.extensions).size !== plan.scope.extensions.length || typeof plan.canceled !== "boolean" || plan.canceled !== (plan.cancelEntry !== undefined) || (plan.nextDueAt !== null && !Number.isFinite(Date.parse(plan.nextDueAt)))) throw invalid();
}
async function verifyRun(tx: Tx, run: PersonalScheduleRun, plan: PersonalSchedule) {
  const admission = await tx.entry(ScheduleRunAdmission, run.admission), task = await tx.task(run.taskId), conversation = await tx.conversation(run.conversationId), binding = await tx.doc(PersonalScheduledConversationDoc, String(run.conversationId), null);
  if (binding.runId !== run.id || !admission || admission.conversationId !== run.conversationId || !isDeepStrictEqual(admission.data, scheduleRunAdmissionData(run)) || run.planId !== plan.id || run.planVersion !== plan.version || run.requestId !== scheduleRequestId(run.id) || task?.kind !== SCHEDULE_RUN_TASK || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !isDeepStrictEqual(task.input, { runId: run.id }) || !conversation || conversation.id === ROOT_CONVERSATION_ID || typeof run.cancelRequested !== "boolean" || typeof run.sealed !== "boolean" || !Array.isArray(run.members) || new Set(run.members.map(member => member.taskId)).size !== run.members.length || ![run.scheduledFor, run.mergedFrom, run.mergedThrough].every(value => Number.isFinite(Date.parse(value))) || Date.parse(run.mergedFrom) > Date.parse(run.scheduledFor) || Date.parse(run.mergedThrough) < Date.parse(run.scheduledFor) || !run.result && plan.activeRun !== run.id || run.id !== createHash("sha256").update(JSON.stringify([plan.id, plan.version, run.scheduledFor])).digest("hex")) throw invalid();
  if (run.cancelRequested) {
    const canceled = run.cancelEntry && await tx.entry(run.cancelEntry);
    if (!canceled || !(ScheduleCancellation.is(canceled) && canceled.data.planId === plan.id && canceled.data.activeRun === run.id || ScheduleRunCancellation.is(canceled) && canceled.data.runId === run.id)) throw invalid();
  } else if (run.cancelEntry !== undefined) throw invalid();
  if (run.result) { const result = await tx.entry(ScheduleResult, run.result.entry); if (!result || result.conversationId !== run.conversationId || !isDeepStrictEqual(result.data, { runId: run.id, status: run.result.status, text: run.result.text }) || plan.activeRun === run.id || !run.sealed || !run.delivery) throw invalid(); }
}
export async function scheduledConversation(tx: Tx, conversationId: ConversationId) {
  if (conversationId === ROOT_CONVERSATION_ID) return;
  const binding = await tx.doc(PersonalScheduledConversationDoc, String(conversationId), null);
  if (!binding.runId) return;
  const run = await personalScheduleRun(tx, binding.runId), plan = await personalSchedule(tx, run.planId);
  if (run.conversationId !== conversationId) throw invalid();
  await verifyPlan(tx, plan); await verifyRun(tx, run, plan);
  return { plan, run };
}
export async function personalScheduledSource(tx: Tx, requestId: string) {
  if (!requestId.startsWith("personal-schedule-run:")) return;
  const id = requestId.slice("personal-schedule-run:".length), run = await personalScheduleRun(tx, id), plan = await personalSchedule(tx, run.planId), index = await tx.doc(PersonalSchedulesDoc);
  if (!index.plans.includes(plan.id) || !index.runs.includes(id)) throw invalid();
  await verifyPlan(tx, plan); await verifyRun(tx, run, plan);
  const submission = await tx.submissionByRequest(run.conversationId, requestId), entry = submission?.entry && await tx.entry(submission.entry), message = entry && entry.model?.[0];
  if (!submission || submission.type !== "input" || !entry || entry.kind !== SCHEDULE_INPUT || entry.conversationId !== run.conversationId || !isDeepStrictEqual(entry.data, { runId: id, admission: run.admission }) || message?.role !== "user" || message.content !== plan.instruction || (run.submissionId !== undefined && run.submissionId !== submission.id) || (run.entryId !== undefined && run.entryId !== entry.id)) throw invalid();
  return { plan, run, submission, entry, source: { requestId, submissionId: submission.id, entryId: entry.id }, permission: { ...plan.permission }, ...(plan.telegram ? { telegram: { ...plan.telegram } } : {}), scope: plan.scope };
}
export async function requireScheduledSourceReady(tx: Tx, requestId: string) {
  const source = await personalScheduledSource(tx, requestId); if (!source) return;
  const task = await tx.task(source.run.taskId);
  if (source.plan.canceled || source.run.cancelRequested || source.run.result || task?.abortRequested || task?.state.status === "terminal" || !["placed", "done"].includes(source.submission.status) || source.plan.telegram && !await telegramSourceActive(tx, source.plan.telegram)) throw new PersonalError("schedule_run_inactive", "原定时运行已取消、结束或入口失效，未继续执行；请查询原计划。");
}
export async function verifyScheduleSupervisor(tx: Tx) {
  const index = await tx.doc(PersonalSchedulesDoc); let latest: Awaited<ReturnType<Tx["task"]>>, active: TaskId | undefined, cursor;
  do { const page = await tx.scanTasks({ kind: SCHEDULE_SUPERVISOR_TASK, order: "ascending" }, 256, cursor); for (const task of page.items) { if (task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !isDeepStrictEqual(task.input, {})) throw invalid(); if (task.state.status !== "terminal") { if (active) throw invalid(); active = task.id; } latest = task; } cursor = page.next; } while (cursor);
  if (latest?.id !== index.supervisor || active !== undefined && active !== latest?.id) throw invalid();
  return latest ? { terminal: latest.state.status === "terminal" } : null;
}
async function verifyRunAnswers(tx: Tx, run: PersonalScheduleRun) {
  const initial = await tx.submissionByRequest(run.conversationId, run.requestId);
  if (run.initialAnswer !== undefined) { const entry = await tx.entry(AssistantEntry, run.initialAnswer); if (initial?.type !== "input" || initial.status !== "done" || initial.answer !== run.initialAnswer || entry?.conversationId !== run.conversationId || entry.model?.[0]?.role !== "assistant") throw invalid(); }
  const submission = await tx.submissionByRequest(run.conversationId, `personal-schedule-summary:${run.id}`);
  if (!run.summary) { if (submission || run.result?.status === "completed") throw invalid(); return; }
  const summary = run.summary, admission = await tx.entry(ScheduleSummary, summary.admission);
  if (!admission || admission.conversationId !== run.conversationId || !isDeepStrictEqual(admission.data, { runId: run.id, content: summary.content, failed: summary.failed }) || !run.sealed || run.initialAnswer === undefined || typeof summary.failed !== "boolean") throw invalid();
  if (summary.submissionId !== undefined && summary.submissionId !== submission?.id) throw invalid();
  if (submission) { const entry = submission.entry && await tx.entry(submission.entry), message = entry && entry.model?.[0]; if (submission.type !== "input" || submission.conversationId !== run.conversationId || !entry || entry.kind !== SCHEDULE_SUMMARY_INPUT || entry.conversationId !== run.conversationId || entry.id <= admission.id || !isDeepStrictEqual(entry.data, { runId: run.id, admission: summary.admission }) || message?.role !== "user" || message.content !== summary.content) throw invalid(); }
  if (summary.answer !== undefined) {
    const entry = await tx.entry(AssistantEntry, summary.answer), message = entry?.model?.[0];
    if (submission?.type !== "input" || submission.status !== "done" || submission.answer !== summary.answer || summary.submissionId !== submission.id || entry?.conversationId !== run.conversationId || message?.role !== "assistant") throw invalid();
    const text = message.content.filter(part => part.type === "text").map(part => part.text).join("") || "本次定时工作已收尾，但模型没有提供文字结果；请查询原运行。";
    if (run.result && (run.result.text !== text || run.result.status !== (summary.failed ? "failed" : "completed"))) throw invalid();
  } else if (run.result?.status === "completed" || run.result && run.result.status !== "canceled" && submission?.status === "done") throw invalid();
}
export async function verifySchedules(tx: Tx, planKeys: string[], runKeys: string[], enabled: boolean, verifyCreator?: (tx: Tx, plan: PersonalSchedule) => Promise<void>, verifyCancel?: (tx: Tx, plan: PersonalSchedule, cancellation: PersonalScheduleCancellation) => Promise<void>, scheduledWorkTool?: ToolRegistration) {
  const index = await tx.doc(PersonalSchedulesDoc);
  await verifyScheduleSupervisor(tx);
  if ((!enabled && (planKeys.length || runKeys.length)) || !isDeepStrictEqual([...index.plans].sort(), [...planKeys].sort()) || !isDeepStrictEqual([...index.runs].sort(), [...runKeys].sort()) || new Set(index.plans).size !== index.plans.length || new Set(index.runs).size !== index.runs.length) throw invalid();
  const conversations = new Set<ConversationId>(), requests = new Set<string>();
  for (const id of index.plans) { const plan = await personalSchedule(tx, id); await verifyPlan(tx, plan); await verifyCreator?.(tx, plan); if (plan.cancelEntry) { const cancellation = await tx.entry(ScheduleCancellation, plan.cancelEntry); if (!cancellation || cancellation.conversationId !== ROOT_CONVERSATION_ID || cancellation.data.planId !== plan.id || cancellation.id <= plan.admission) throw invalid(); await verifyCancel?.(tx, plan, cancellation.data); } if (requests.has(plan.requestId)) throw invalid(); requests.add(plan.requestId); if (plan.activeRun && !index.runs.includes(plan.activeRun)) throw invalid(); }
  for (const id of index.runs) {
    const run = await personalScheduleRun(tx, id), plan = await personalSchedule(tx, run.planId); await verifyRun(tx, run, plan); if (!index.plans.includes(run.planId) || conversations.has(run.conversationId)) throw invalid(); conversations.add(run.conversationId);
    const submission = await tx.submissionByRequest(run.conversationId, run.requestId); if (submission?.entry) await personalScheduledSource(tx, run.requestId); else if (run.entryId !== undefined || run.submissionId !== undefined && run.submissionId !== submission?.id) throw invalid();
    const workAdmissions: { id: EntryId; data: { runId: string; work: PersonalWorkRef; modelCall: TaskId; content: string; label?: string } }[] = [];
    let entryCursor; do { const page = await tx.scanEntries({ conversationId: run.conversationId }, 256, entryCursor); for (const entry of page.items) if (ScheduledWorkAdmission.is(entry)) workAdmissions.push(entry); entryCursor = page.next; } while (entryCursor);
    if (workAdmissions.length !== run.members.length || workAdmissions.some(entry => entry.data.runId !== run.id || !run.members.some(ref => isDeepStrictEqual(ref, entry.data.work)))) throw invalid();
    for (const ref of run.members) {
      const work = await tx.doc(PersonalWorkDoc, ref.requestId, null), task = work.modelCall && await tx.task(work.modelCall), input = task?.input;
      const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
      const call = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.id === (input && typeof input === "object" && !Array.isArray(input) ? input.callId : undefined));
      let normalized: { action: string; content?: string; label?: string } | undefined;
      if (call?.type === "toolCall" && scheduledWorkTool) { try { normalized = validateToolArguments(scheduledWorkTool, { ...call, arguments: copyJson(call.arguments) as Record<string, JsonValue> }) as typeof normalized; } catch { throw invalid(); } }
      const admissions = workAdmissions.filter(entry => entry.data.work.taskId === ref.taskId);
      const originalSource = await personalScheduledSource(tx, run.requestId);
      if (admissions.length !== 1 || !isDeepStrictEqual(work.ref, ref) || !isDeepStrictEqual(work.source, originalSource?.source) || !isDeepStrictEqual(work.permission, plan.permission) || !isDeepStrictEqual(work.telegram, plan.telegram) || task?.kind !== "pi.tool" || task.conversationId !== run.conversationId || !assistant || assistant.byTaskId !== task.owner || !originalSource || assistant.id <= originalSource.entry.id || call?.type !== "toolCall" || call.name !== "background_work" || !normalized || normalized.action !== "delegate" || Object.keys(normalized).some(key => !["action", "content", "label"].includes(key)) || !isDeepStrictEqual(admissions[0].data, { runId: run.id, work: ref, modelCall: work.modelCall, content: normalized.content, ...(normalized.label === undefined ? {} : { label: normalized.label }) }) || admissions[0].id <= assistant.id || ref.requestId !== `personal-tool:${work.modelCall}` || work.fingerprint !== createHash("sha256").update(JSON.stringify([normalized.content, run.requestId, null, normalized.label ?? null])).digest("hex")) throw invalid();
    }
    await verifyRunAnswers(tx, run);
    if (run.delivery) { const delivery = run.delivery, task = await tx.task(delivery.taskId), admission = await tx.entry(ScheduleSendAdmission, delivery.admission); if (!run.result || task?.kind !== SCHEDULE_SEND_TASK || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !isDeepStrictEqual(task.input, { runId: id }) || !admission || admission.conversationId !== run.conversationId || !isDeepStrictEqual(admission.data, { runId: id, taskId: delivery.taskId, text: delivery.text }) || delivery.text !== personalScheduleReportText(run.result.text) || !Array.isArray(delivery.claims) || new Set(delivery.claims).size !== delivery.claims.length || !["pending", "sending", "sent", "local", "failed", "effect_unknown", "canceled"].includes(delivery.state)) throw invalid();
      for (const [i, id] of delivery.claims.entries()) { const claim = await tx.entry(ScheduleSendClaim, id); if (!claim || claim.conversationId !== run.conversationId || id <= (delivery.claims[i - 1] ?? delivery.admission) || !isDeepStrictEqual(claim.data, { runId: run.id, taskId: delivery.taskId, text: delivery.text, telegram: plan.telegram })) throw invalid(); }
      if (["sending", "sent", "effect_unknown", "failed"].includes(delivery.state) && !delivery.claims.length) throw invalid();
      if (delivery.observation) { const observation = await tx.entry(ScheduleSendObservation, delivery.observation); if (!observation || observation.conversationId !== run.conversationId || observation.id <= (delivery.claims.at(-1) ?? delivery.admission) || !isDeepStrictEqual(observation.data, { runId: run.id, state: delivery.state, ...(delivery.code ? { code: delivery.code } : {}), ...(delivery.platformMessageId ? { platformMessageId: delivery.platformMessageId } : {}) })) throw invalid(); }
      if (["sent", "effect_unknown", "failed", "local"].includes(delivery.state) && !delivery.observation) throw invalid();
    }
  }
  let conversationCursor; do { const page = await tx.scanConversations({}, 256, conversationCursor); for (const conversation of page.items) {
    const binding = await tx.doc(PersonalScheduledConversationDoc, String(conversation.id), null); if (binding.runId && (!index.runs.includes(binding.runId) || (await personalScheduleRun(tx, binding.runId)).conversationId !== conversation.id)) throw invalid();
    let entryCursor; do { const entries = await tx.scanEntries({ conversationId: conversation.id }, 256, entryCursor); for (const entry of entries.items) {
      if (ScheduleAdmission.is(entry)) { if (conversation.id !== ROOT_CONVERSATION_ID || !index.plans.includes(entry.data.id) || (await personalSchedule(tx, entry.data.id)).admission !== entry.id) throw invalid(); }
      if (ScheduleCancellation.is(entry)) { if (conversation.id !== ROOT_CONVERSATION_ID || !index.plans.includes(entry.data.planId) || (await personalSchedule(tx, entry.data.planId)).cancelEntry !== entry.id) throw invalid(); if (entry.data.activeRun) { if (!index.runs.includes(entry.data.activeRun)) throw invalid(); const run = await personalScheduleRun(tx, entry.data.activeRun); if (!run.cancelRequested || run.cancelEntry !== entry.id || run.planId !== entry.data.planId) throw invalid(); } }
      const runId = ScheduleRunAdmission.is(entry) ? entry.data.id : ScheduleSummary.is(entry) || ScheduleResult.is(entry) || ScheduleSendAdmission.is(entry) || ScheduleSendClaim.is(entry) || ScheduleSendObservation.is(entry) || ScheduledWorkAdmission.is(entry) || ScheduleRunCancellation.is(entry) ? entry.data.runId : entry.kind === SCHEDULE_INPUT || entry.kind === SCHEDULE_SUMMARY_INPUT ? entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) && "runId" in entry.data ? entry.data.runId : undefined : undefined;
      const runEntry = [ScheduleRunAdmission.kind, ScheduleSummary.kind, ScheduleResult.kind, ScheduleSendAdmission.kind, ScheduleSendClaim.kind, ScheduleSendObservation.kind, ScheduledWorkAdmission.kind, ScheduleRunCancellation.kind, SCHEDULE_INPUT, SCHEDULE_SUMMARY_INPUT].includes(entry.kind);
      if (runId !== undefined || runEntry) {
        if (typeof runId !== "string" || !index.runs.includes(runId)) throw invalid();
        const run = await personalScheduleRun(tx, runId); if (run.conversationId !== conversation.id) throw invalid();
        if (ScheduleRunAdmission.is(entry) && run.admission !== entry.id || ScheduleSummary.is(entry) && run.summary?.admission !== entry.id || ScheduleResult.is(entry) && run.result?.entry !== entry.id || ScheduleSendAdmission.is(entry) && run.delivery?.admission !== entry.id || ScheduleSendClaim.is(entry) && !run.delivery?.claims.includes(entry.id) || ScheduleRunCancellation.is(entry) && run.cancelEntry !== entry.id || ScheduledWorkAdmission.is(entry) && !run.members.some(ref => isDeepStrictEqual(ref, entry.data.work))) throw invalid();
        if (entry.kind === SCHEDULE_INPUT && (await tx.submissionByRequest(run.conversationId, run.requestId))?.entry !== entry.id || entry.kind === SCHEDULE_SUMMARY_INPUT && (!run.summary || (await tx.submissionByRequest(run.conversationId, `personal-schedule-summary:${run.id}`))?.entry !== entry.id)) throw invalid();
        if (ScheduleSendObservation.is(entry) && (!run.delivery || entry.id !== run.delivery.observation && entry.data.state !== "pending")) throw invalid();
      } else if (entry.kind === SCHEDULE_INPUT || entry.kind === SCHEDULE_SUMMARY_INPUT) throw invalid();
    } entryCursor = entries.next; } while (entryCursor);
  } conversationCursor = page.next; } while (conversationCursor);
  for (const kind of [SCHEDULE_RUN_TASK, SCHEDULE_SEND_TASK]) { let cursor; do { const page = await tx.scanTasks({ kind }, 256, cursor); for (const task of page.items) { const id = task.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.runId; if (typeof id !== "string" || !index.runs.includes(id)) throw invalid(); const run = await personalScheduleRun(tx, id); if (task.id !== (kind === SCHEDULE_RUN_TASK ? run.taskId : run.delivery?.taskId)) throw invalid(); } cursor = page.next; } while (cursor); }
  let workCursor; do { const page = await tx.scanTasks({ kind: "ruukoto.background-work" }, 256, workCursor); for (const task of page.items) { const key = task.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.requestId; if (typeof key !== "string") continue; const work = await tx.doc(PersonalWorkDoc, key, null); if (work.source?.requestId.startsWith("personal-schedule-run:")) { const source = await personalScheduledSource(tx, work.source.requestId); if (!source?.run.members.some(ref => isDeepStrictEqual(ref, work.ref))) throw invalid(); } } workCursor = page.next; } while (workCursor);
}
