import { isDeepStrictEqual } from "node:util";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, defineEntry, defineExtension, defineTask, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, type Cursor, type DocumentObserver, type EntryId, type EntryRecord, type Harness, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { PersonalAnalysisAdmission, PersonalDelegationDoc, personalDelegation, personalDelegationBlocker, requirePersonalDelegationActive, requirePersonalDelegationInput, type PersonalDelegationRef, type PersonalWorkSource } from "./personal-delegation.ts";
import { PersonalWorkDoc, PersonalWorkNoteAdmission, personalWorkStatus, type PersonalWorkRef } from "./personal-work.ts";
import { personalSource, personalSourceImReceipt } from "./personal-source.ts";
import { PersonalCoordinationDoc, personalUnparkMode, type PersonalMainAdmission } from "./personal-coordination.ts";
import { LocalInputDoc, LocalInputAdmission } from "./personal-local-records.ts";
import { PersonalMediaMessageDoc } from "./personal-media.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc, personalEntryConfig } from "./personal-telegram-records.ts";
import { telegramSourceActive } from "./personal-permissions.ts";
import { PersonalImApiError, withPersonalImEntry, type PersonalImAccess, type PersonalImSender } from "./personal-im-api.ts";
import { personalTelegramApi } from "./personal-telegram-api.ts";
import { telegramToken } from "./personal-telegram-config.ts";
import { toolOperations } from "./personal-tools.ts";
import { personalFileIoJobs } from "./personal-file-io.ts";
import { PersonalServiceOperationDoc, personalWorkServices } from "./personal-service-operations.ts";
import { CommandAdmission, personalWorkCommands } from "./personal-command-work.ts";
import { McpAdmission, mcpOperations } from "./personal-mcp.ts";
import { AppDataAdmission, appDataOperations } from "./personal-app-data.ts";
import { BrowserAdmission, browserOperations } from "./personal-browser.ts";
import { ToolAdmission } from "./personal-tools.ts";
import { ServiceInspectionAdmission } from "./personal-service-inspection.ts";
import { authorizeLegacyPersonalReportDelivery, legacyPersonalReportRequest, legacyPersonalReportResult, personalReportMultipart, personalReportReplyText, settlePersonalReportDelivery, verifyLegacyPersonalReports, type LegacyPersonalReportFacts } from "./personal-report-legacy.ts";
import { PERSONAL_OUTPUT_LIMIT, personalOutputIntent, personalOutputMetadata, personalWorkOutputs } from "./personal-outputs.ts";
import type { PersonalDesktopOutput } from "@ruukoto/view/personal-protocol.ts";
import { personalImDeliveryRecord, personalImDeliveryResult, personalImDeliveryTextReceipt, settlePersonalImDelivery, type PersonalImDeliveryInput, type PersonalImDeliveryRef } from "./personal-im-delivery.ts";

type Delivery = LegacyPersonalReportFacts["delivery"];
type CoveredMember = { ref: PersonalWorkRef; admission?: EntryId; notes: { admission: EntryId; requestId: string; submissionId?: SubmissionId; status: string; answer?: EntryId }[]; submissionId?: SubmissionId; answer?: EntryId; outcome: JsonValue; facts: JsonValue; outputs?: EntryId[] };
export type PersonalReportCoverage = { version: 2; delegation: PersonalDelegationRef; goal: string; sources: PersonalWorkSource[]; members: CoveredMember[] };
type ReportAttempt = { coverage: EntryId; content: string; submissionId?: SubmissionId; answer?: EntryId; superseded?: EntryId; pause?: EntryId };
type V2Facts = LegacyPersonalReportFacts & { version: 2; trigger: EntryId; triggers: EntryId[]; attempts: ReportAttempt[]; publication?: EntryId; supersessions: EntryId[]; sendCanceled?: EntryId; failure?: EntryId; failureOutcome?: JsonValue };
export type PersonalReportFacts = (LegacyPersonalReportFacts & { version?: 1 }) | V2Facts;
type ReportInput = { version: 2; delegation: PersonalDelegationRef; source: PersonalWorkSource; modelCall: TaskId; content: string; trigger: EntryId };
type ReportState = { phase: "wait" } | { phase: "summarize"; attempt: number } | { phase: "publish"; attempt: number } | { phase: "send"; retryAt?: number } | { phase: "verify" } | { phase: "deliver" };
const INPUT_KIND = "ruukoto.delegation-report";
const ReportAdmission = defineEntry<ReportInput & { taskId: TaskId }>("ruukoto.report-host-admission");
const ReportRequest = defineEntry<{ version: 2; delegation: PersonalDelegationRef; source: PersonalWorkSource; modelCall: TaskId }>("ruukoto.report-request");
export const PersonalReportCoverageEntry = defineEntry<{ version: 2; taskId: TaskId; attempt: number; coverage: PersonalReportCoverage }>("ruukoto.report-coverage");
const ReportSupersession = defineEntry<{ version: 2; taskId: TaskId; attempt: number; coverage: EntryId; reason: "requirements_changed" | "source_paused"; current?: PersonalReportCoverage; blocker?: JsonValue }>("ruukoto.report-supersession");
export const PersonalReportPublication = defineEntry<{ version: 2; delegation: PersonalDelegationRef; taskId: TaskId; attempt: number; coverage: EntryId; answer: EntryId; outputs?: EntryId[] }>("ruukoto.report-publication");
const ReportSendCanceled = defineEntry<{ version: 2; taskId: TaskId; publication: EntryId; reason: "requirements_changed" | "canceled" | "source_inactive" }>("ruukoto.report-send-canceled");
const ReportFailure = defineEntry<{ version: 2; taskId: TaskId; delivery: Delivery; outcome: JsonValue }>("ruukoto.report-failure");
const keyFor = (taskId: TaskId, attempt: number) => `personal-report:${taskId}:${attempt}`;
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const invalid = () => new PersonalError("report_record_invalid", "报告来源、覆盖要求或发布记录无法核实，已停止；请保留档案并查询原委托。");
const inputData = (ref: PersonalDelegationRef, report: V2Facts, attempt: number) => ({ version: 2, delegation: ref.entryId, taskId: report.taskId, attempt, coverage: report.attempts[attempt].coverage });

export function personalReportsFor(value: { report?: PersonalReportFacts; reports?: PersonalReportFacts[] }): PersonalReportFacts[] {
  return [...(value.reports ?? []), ...(value.report ? [value.report] : [])];
}
async function reportFacts(tx: Tx, ref: PersonalDelegationRef, taskId?: TaskId) {
  const value = await personalDelegation(tx, ref);
  const report = taskId === undefined ? value.report : personalReportsFor(value).find(report => report.taskId === taskId);
  if (!report || report.version !== 2) throw invalid();
  return { value, report };
}

async function verifyTrigger(tx: Tx, ref: PersonalDelegationRef, trigger: EntryId, source: PersonalWorkSource, modelCall: TaskId) {
  if (!isDeepStrictEqual((await personalSource(tx, source.requestId)).source, source)) throw invalid();
  const entry = await tx.entry(trigger), value = await personalDelegation(tx, ref);
  if (!entry || !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data) || entry.conversationId !== ROOT_CONVERSATION_ID) throw invalid();
  if (PersonalAnalysisAdmission.is(entry)) {
    const member = value.members.find(member => isDeepStrictEqual(member, entry.data.work));
    const work = member && await tx.doc(PersonalWorkDoc, member.requestId, null);
    if (!member || !work || work.delegationAdmission !== trigger || !isDeepStrictEqual(entry.data.delegation, ref) || !isDeepStrictEqual(entry.data.source, source) || entry.data.modelCall !== modelCall || !isDeepStrictEqual(work.instructionSource, source) || work.modelCall !== modelCall) throw invalid();
  } else if (PersonalWorkNoteAdmission.is(entry)) {
    const member = value.members.find(member => isDeepStrictEqual(member, entry.data.ref));
    const work = member && await tx.doc(PersonalWorkDoc, member.requestId, null);
    const note = work?.notes?.find(note => note.admission === trigger);
    if (!note || !isDeepStrictEqual(entry.data, { ref: member, requestId: note.requestId, content: note.content, source: note.source, ...(note.attachments === undefined ? {} : { attachments: note.attachments }) })) throw invalid();
    const actor = note.source.kind === "input" ? { requestId: note.source.requestId, submissionId: note.source.submissionId, entryId: note.source.entryId } : value.source;
    if (!isDeepStrictEqual(source, actor) || note.source.kind === "input" && note.source.modelCall !== undefined && note.source.modelCall !== modelCall) throw invalid();
  } else if (ReportRequest.is(entry)) {
    if (!isDeepStrictEqual(entry.data, { version: 2, delegation: ref, source, modelCall })) throw invalid();
    const call = await tx.task(modelCall), input = call?.input;
    const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
    const part = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.id === (input && typeof input === "object" && !Array.isArray(input) ? input.callId : undefined));
    if (call?.kind !== "pi.tool" || call.conversationId !== ROOT_CONVERSATION_ID || assistant?.byTaskId !== call.owner || assistant!.id <= source.entryId || trigger <= assistant!.id || part?.type !== "toolCall" || part.name !== "background_work" || !isDeepStrictEqual(part.arguments, { action: "report", delegation: ref.entryId })) throw invalid();
  } else throw invalid();
}

export async function refreshPersonalReportState(tx: Tx, ref: PersonalDelegationRef) {
  const report = (await personalDelegation(tx, ref)).report;
  if (!report || report.version !== 2) return;
  const task = await tx.task(report.taskId);
  if (!task) throw invalid();
  if (task.state.status !== "terminal" || !["faulted", "orphaned"].includes(task.state.outcome.status)) return;
  if (report.multipart) await settlePersonalReportDelivery(tx, report);
  else report.delivery = report.delivery === "sending" ? "effect_unknown" : report.publication === undefined ? "unanswered" : "canceled";
  if (report.failure !== undefined) return;
  report.failure = undefined;
  report.failureOutcome = json(task.state.outcome);
}

export async function registerPersonalReportForAdmission(tx: Tx, ref: PersonalDelegationRef, trigger: EntryId) {
  const value = await personalDelegation(tx, ref);
  for (const member of value.members) {
    const work = await tx.doc(PersonalWorkDoc, member.requestId, null);
    if (work.delegationAdmission === trigger) {
      if (!work.instructionSource || work.modelCall === undefined) throw invalid();
      return registerPersonalReport(tx, ref, work.instructionSource.requestId, work.modelCall, trigger);
    }
    const note = work.notes?.find(note => note.admission === trigger);
    if (!note) continue;
    const source = note.source.kind === "input" ? note.source.requestId : value.source.requestId;
    const modelCall = note.source.kind === "input" ? note.source.modelCall : undefined;
    const original = value.members[0] && await tx.doc(PersonalWorkDoc, value.members[0].requestId, null);
    if (modelCall === undefined && original?.modelCall === undefined) throw invalid();
    return registerPersonalReport(tx, ref, source, modelCall ?? original!.modelCall!, trigger);
  }
  throw invalid();
}

// Work admission already wrote tables; derive the host intent from those adopted document facts.
// Full immutable-entry/source verification runs before the report task creates its first attempt.
// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-report-publication.md
export async function registerPersonalReport(tx: Tx, ref: PersonalDelegationRef, sourceRequestId: string, modelCall: TaskId, trigger: EntryId, actor?: PersonalWorkSource) {
  const value = await personalDelegation(tx, ref);
  const duplicate = personalReportsFor(value).find(report => report.version === 2 && report.triggers.includes(trigger));
  if (duplicate) return duplicate.taskId;
  if (value.cancelRequested) throw new PersonalError("delegation_canceled", "原委托已取消，未登记新报告；请查询原结果。");
  let source: PersonalWorkSource | undefined = actor;
  if (value.source.requestId === sourceRequestId) source = { ...value.source };
  for (const member of value.members) {
    const work = await tx.doc(PersonalWorkDoc, member.requestId, null);
    if (work.instructionSource?.requestId === sourceRequestId) source = { ...work.instructionSource };
    const note = work.notes?.find(note => note.admission === trigger);
    if (note?.source.kind === "input" && note.source.requestId === sourceRequestId) source = { requestId: note.source.requestId, submissionId: note.source.submissionId, entryId: note.source.entryId };
  }
  if (!source) throw invalid();
  const existing = value.report;
  if (existing?.version === 2 && existing.failureOutcome !== undefined && existing.failure === undefined) {
    existing.failure = (await tx.appendEntry(ReportFailure, ROOT_CONVERSATION_ID, { data: { version: 2, taskId: existing.taskId, delivery: existing.delivery, outcome: existing.failureOutcome } })).id;
    delete existing.failureOutcome;
  }
  if (existing && existing.version !== 2) throw new PersonalError("report_legacy_sealed", "原版本报告已固定，未接纳新报告；请查询原报告，新要求另行提交。");
  if (existing && !existing.publication && existing.delivery === "waiting") { existing.triggers.push(trigger); return existing.taskId; }
  if (existing) { value.reports ??= []; value.reports.push(copyJson(existing) as V2Facts); }
  const content = "宿主已登记本委托的自动最终汇总；等待相关主输入与后台工作完成后生成当前结果。";
  const taskInput: ReportInput = { version: 2, delegation: ref, source, modelCall, content, trigger };
  const taskId = await tx.createTask(PersonalReportTask, taskInput, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
  const admission = (await tx.appendEntry(ReportAdmission, ROOT_CONVERSATION_ID, { data: { ...taskInput, taskId } })).id;
  value.report = { version: 2, taskId, admission, source, modelCall, content, trigger, triggers: [trigger], attempt: 0, pauses: [], attempts: [], supersessions: [], delivery: "waiting" };
  return taskId;
}

export async function requestPersonalReport(tx: Tx, ref: PersonalDelegationRef, sourceRequestId: string, modelCall: TaskId) {
  const value = await personalDelegation(tx, ref);
  await requirePersonalDelegationInput(tx, ref, sourceRequestId);
  if (value.report) return value.report.taskId;
  const source = (await personalSource(tx, sourceRequestId, { active: true })).source;
  const trigger = (await tx.appendEntry(ReportRequest, ROOT_CONVERSATION_ID, { data: { version: 2, delegation: ref, source, modelCall } })).id;
  return registerPersonalReport(tx, ref, sourceRequestId, modelCall, trigger, { ...source });
}

async function acceptedInputPending(tx: Tx, after: EntryId): Promise<boolean> {
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId: after, order: "ascending" }, 256, cursor);
    for (const entry of page.items) {
      if (entry.id <= after) continue;
      let requestId: string | undefined;
      if (LocalInputAdmission.is(entry)) {
        const local = await tx.doc(LocalInputDoc, entry.data.requestId, "");
        if (local.accepted !== entry.id || local.digest !== entry.data.digest) throw invalid();
        if (local.work === undefined) requestId = entry.data.requestId;
      } else if (entry.kind === "ruukoto.telegram-received" || entry.kind === "ruukoto.qq-received") {
        const data = entry.data;
        if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.requestId !== "string") throw invalid();
        const receipt = (await tx.doc(PersonalTelegramReceiptDoc, data.requestId, null)).receipt;
        if (!receipt || receipt.accepted !== entry.id) throw invalid();
        if (!receipt.control && !receipt.mediaRejected && !["canceled", "unanswered"].includes(receipt.delivery)) requestId = receipt.requestId;
      } else if (entry.kind === "ruukoto.media-received") {
        const data = entry.data;
        if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.key !== "string") throw invalid();
        const message = (await tx.doc(PersonalMediaMessageDoc, data.key, null)).message;
        if (!message || message.accepted !== entry.id) throw invalid();
        if (!["rejected", "expired"].includes(message.state)) requestId = message.key;
      }
      if (requestId !== undefined) {
        const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId);
        if (!submission || submission.status === "queued" || submission.status === "placed") return true;
        const cutoff = (await tx.doc(PersonalCoordinationDoc, requestId, null)).cutoff;
        if (cutoff && (cutoff.cancelled === undefined || cutoff.marker === undefined)) return true;
      }
    }
    cursor = page.next;
  } while (cursor);
  const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID), live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
  if (inbox.items.some(item => item.mode !== "write" && item.entry?.kind !== INPUT_KIND)) return true;
  for (const id of live.run?.inputs ?? []) if (!await personalReportInput(tx, id)) return true;
  return false;
}

async function currentCoverage(tx: Tx, ref: PersonalDelegationRef, at?: EntryId): Promise<PersonalReportCoverage | undefined> {
  const value = await personalDelegation(tx, ref);
  const sources = new Map<string, PersonalWorkSource>([[value.source.requestId, value.source]]);
  const members: CoveredMember[] = [];
  const before = (entry: EntryId | undefined) => entry !== undefined && (at === undefined || entry < at);
  const tools = (await toolOperations(tx)).filter(op => before(op.admission)), jobs = (await personalFileIoJobs(tx)).filter(job => before(job.admission)), mcp = (await mcpOperations(tx)).filter(op => before(op.admission)), data = (await appDataOperations(tx)).filter(op => before(op.admission)), browsers = (await browserOperations(tx)).filter(op => before(op.admission));
  for (const member of value.members) {
    const work = await tx.doc(PersonalWorkDoc, member.requestId, null), status = await personalWorkStatus(tx, member);
    if (!isDeepStrictEqual(work.ref, member) || work.delegation?.entryId !== ref.entryId || !work.instructionSource) throw invalid();
    if (at !== undefined && (!work.delegationAdmission || work.delegationAdmission >= at)) continue;
    sources.set(work.instructionSource.requestId, work.instructionSource);
    const notes: CoveredMember["notes"] = [];
    for (const note of work.notes ?? []) {
      if (note.admission === undefined) throw invalid();
      if (!before(note.admission)) continue;
      if (note.source.kind === "input") sources.set(note.source.requestId, { requestId: note.source.requestId, submissionId: note.source.submissionId, entryId: note.source.entryId });
      const submission = await tx.submissionByRequest(member.agentId, `personal-work:${member.taskId}:note:${note.requestId}`);
      notes.push({ admission: note.admission, requestId: note.requestId, ...(submission ? { submissionId: submission.id } : {}), status: submission?.status ?? "not_submitted", ...(submission?.answer === undefined ? {} : { answer: submission.answer }) });
    }
    if (!status.stopVerified || status.task.state.status !== "terminal") return undefined;
    const services = (await personalWorkServices(tx, member.taskId)).filter(op => before(op.work?.admission)), commands = (await personalWorkCommands(tx, member.taskId)).filter(op => before(op.admission));
    const facts = json({
      tools: tools.filter(op => op.origin.work?.ref.taskId === member.taskId).map(op => ({ operation: op.operation, admission: op.admission, started: op.started, stopped: op.stopped, effect: op.effect, code: op.code, observation: op.observation ?? null, decision: op.decisionEntry ?? null, resolution: before(op.resolution?.entry) ? op.resolution! : null, stop: before(op.stopEvidence?.entry) ? op.stopEvidence! : null, superseded: before(op.superseded?.entry) ? op.superseded! : null, artifact: op.artifact ?? null })),
      fileJobs: jobs.filter(job => job.origin?.work?.ref.taskId === member.taskId).map(job => ({ id: job.id, admission: job.admission, events: job.events.filter(before), settle: before(job.settle?.entry) ? job.settle! : null })),
      services: services.map(op => ({ ref: op.ref, admission: op.work!.admission, result: op.result ?? null, stopped: op.launcherStopped, resolution: op.resolution ?? null })),
      commands: commands.map(op => ({ ref: op.ref, admission: op.admission, result: op.result ?? null, stopped: op.stopped, observation: op.observation ?? null, resolution: before(op.resolution?.entry) ? op.resolution! : null })),
      mcp: mcp.filter(op => op.origin.work?.ref.taskId === member.taskId).map(op => ({ operation: op.operation, admission: op.admission, effect: op.effect, code: op.code, ended: before(op.ended?.entry) ? op.ended! : null, observation: op.observation ?? null, remoteEnded: op.remoteEnded, resolution: before(op.resolution?.entry) ? op.resolution! : null, recovery: op.cua?.recovery ?? null })),
      appData: data.filter(op => op.origin.work?.ref.taskId === member.taskId).map(op => ({ operation: op.operation, admission: op.admission, result: op.result ?? null, observation: op.observation ?? null })),
      browser: browsers.filter(op => op.origin.work?.ref.taskId === member.taskId).map(op => ({ operation: op.operation, admission: op.admission, effect: op.effect, code: op.code, stopped: op.stopped, observation: op.observation ?? null, resolution: before(op.resolution?.entry) ? op.resolution! : null, stopEvidence: op.stopEvidence ?? null })),
    });
    const outputs = await personalWorkOutputs(tx, member, at);
    members.push({ ref: { ...member }, ...(work.delegationAdmission === undefined ? {} : { admission: work.delegationAdmission }), notes, ...(status.submission ? { submissionId: status.submission.id } : {}), ...(status.submission?.answer === undefined ? {} : { answer: status.submission.answer }), outcome: json(status.task.state.outcome), facts, ...(outputs.length ? { outputs } : {}) });
  }
  for (const source of sources.values()) {
    const original = await personalSource(tx, source.requestId);
    if (!isDeepStrictEqual(original.source, source)) throw invalid();
    if (original.submission.status === "placed") return undefined;
    const cutoff = (await tx.doc(PersonalCoordinationDoc, source.requestId, null)).cutoff;
    if (cutoff && (cutoff.cancelled === undefined || cutoff.marker === undefined)) return undefined;
  }
  const goalEntry = await tx.entry(value.source.entryId), goalMessage = goalEntry?.model?.[0];
  if (goalMessage?.role !== "user") throw invalid();
  const goal = typeof goalMessage.content === "string" ? goalMessage.content : goalMessage.content.filter(part => part.type === "text").map(part => part.text).join("");
  return { version: 2, delegation: { ...ref }, goal, sources: [...sources.values()], members };
}

async function requirementsChanged(tx: Tx, ref: PersonalDelegationRef, coverage: PersonalReportCoverage) {
  const value = await personalDelegation(tx, ref);
  if (!isDeepStrictEqual(value.members, coverage.members.map(member => member.ref))) return true;
  for (const member of coverage.members) {
    const work = await tx.doc(PersonalWorkDoc, member.ref.requestId, null);
    if (!isDeepStrictEqual((work.notes ?? []).map(note => note.admission), member.notes.map(note => note.admission))) return true;
  }
  return false;
}

async function readiness(tx: Tx, ref: PersonalDelegationRef) {
  const value = await personalDelegation(tx, ref);
  if (value.cancelRequested) return { canceled: true as const };
  if (value.telegram && !await telegramSourceActive(tx, value.telegram)) return { inactive: true as const };
  if (await acceptedInputPending(tx, value.source.entryId)) return { intake: true as const };
  const blocker = await personalDelegationBlocker(tx, value, true);
  if (blocker) return { blocker: json(blocker) };
  const coverage = await currentCoverage(tx, ref);
  if (!coverage) {
    const members = await Promise.all(value.members.map(member => personalWorkStatus(tx, member)));
    if (members.every(member => member.task.state.status === "terminal") && members.some(member => !member.stopVerified)) return { stopped: false as const };
    return { pending: true as const };
  }
  return { coverage };
}

async function verifyAttempt(tx: Tx, ref: PersonalDelegationRef, report: V2Facts, index: number) {
  const attempt = report.attempts[index];
  if (!attempt) throw invalid();
  const coverage = await tx.entry(PersonalReportCoverageEntry, attempt.coverage);
  if (!coverage || !coverage.data || typeof coverage.data !== "object" || !coverage.data.coverage || typeof coverage.data.coverage !== "object" || !Array.isArray(coverage.data.coverage.members) || !Array.isArray(coverage.data.coverage.sources) || typeof coverage.data.coverage.goal !== "string") throw invalid();
  if (coverage.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(coverage.data, { version: 2, taskId: report.taskId, attempt: index, coverage: coverage.data.coverage }) || coverage.data.coverage.version !== 2 || !isDeepStrictEqual(coverage.data.coverage.delegation, ref)) throw invalid();
  const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, keyFor(report.taskId, index));
  if (submission) {
    if (submission.type !== "input" || attempt.submissionId !== undefined && attempt.submissionId !== submission.id) throw invalid();
    if (submission.entry !== undefined) {
      const entry = await tx.entry(submission.entry);
      if (!entry || entry.kind !== INPUT_KIND || entry.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(entry.data, inputData(ref, report, index)) || entry.model?.[0]?.role !== "user" || entry.model[0].content !== attempt.content || entry.id <= attempt.coverage) throw invalid();
    } else if (submission.status === "queued") {
      const item = (await tx.doc(InboxDoc, ROOT_CONVERSATION_ID)).items.find(item => item.id === submission.id);
      if (!item || item.mode === "write" || personalUnparkMode(item.mode) !== "followUp" || item.content !== attempt.content || !isDeepStrictEqual(item.entry, { kind: INPUT_KIND, data: inputData(ref, report, index) })) throw invalid();
    }
    if (attempt.answer !== undefined && (submission.status !== "done" || submission.answer !== attempt.answer)) throw invalid();
  } else if (attempt.submissionId !== undefined || attempt.answer !== undefined) throw invalid();
  return { attempt, coverage: coverage.data.coverage, submission };
}

async function supersede(tx: Tx, report: V2Facts, index: number, reason: "requirements_changed" | "source_paused", current?: PersonalReportCoverage, blocker?: JsonValue) {
  const attempt = report.attempts[index];
  if (attempt.superseded !== undefined) return;
  const entry = (await tx.appendEntry(ReportSupersession, ROOT_CONVERSATION_ID, { data: { version: 2, taskId: report.taskId, attempt: index, coverage: attempt.coverage, reason, ...(current ? { current } : {}), ...(blocker === undefined ? {} : { blocker }) } })).id;
  attempt.superseded = entry;
  report.supersessions.push(entry);
  if (reason === "source_paused") { attempt.pause = entry; report.pauses[index] = entry; }
}

async function verifyPauseBlocker(tx: Tx, ref: PersonalDelegationRef, at: EntryId, blocker: JsonValue | undefined) {
  const value = await personalDelegation(tx, ref), sources = new Set([value.source.requestId]);
  for (const report of personalReportsFor(value)) if (report.admission < at) sources.add(report.source.requestId);
  for (const member of value.members) {
    const work = await tx.doc(PersonalWorkDoc, member.requestId, null);
    if (work.delegationAdmission === undefined || work.delegationAdmission >= at) continue;
    if (work.instructionSource) sources.add(work.instructionSource.requestId);
    if (work.source) sources.add(work.source.requestId);
    for (const note of work.notes ?? []) if (note.admission !== undefined && note.admission < at && note.source.kind === "input") sources.add(note.source.requestId);
  }
  if (typeof blocker === "string") {
    const operation = (await tx.doc(PersonalServiceOperationDoc, blocker, null)).operation;
    if (!operation || operation.ref.requestId !== blocker || operation.source.entryId >= at || !sources.has(operation.source.requestId)) throw invalid();
    return;
  }
  if (!blocker || typeof blocker !== "object" || Array.isArray(blocker) || typeof blocker.admission !== "number" || !Number.isSafeInteger(blocker.admission) || blocker.admission >= at) throw invalid();
  const admission = await tx.entry(blocker.admission as EntryId);
  if (!admission) throw invalid();
  if (typeof blocker.appData === "string" && isDeepStrictEqual(blocker, { appData: blocker.appData, admission: admission.id }) && AppDataAdmission.is(admission) && String(admission.data.operation) === blocker.appData && sources.has(admission.data.origin.source.requestId)) return;
  if (typeof blocker.tool === "string" && isDeepStrictEqual(blocker, { tool: blocker.tool, admission: admission.id }) && ToolAdmission.is(admission) && String(admission.data.operation) === blocker.tool && sources.has(admission.data.origin.source.requestId)) return;
  if (typeof blocker.browser === "string" && BrowserAdmission.is(admission) && String(admission.data.operation) === blocker.browser && sources.has(admission.data.origin.source.requestId)) {
    if (!isDeepStrictEqual(blocker, { browser: blocker.browser, admission: admission.id, ...(blocker.session === true ? { session: true } : {}), ...(blocker.pause === undefined ? {} : { pause: blocker.pause }) })) throw invalid();
    if (blocker.pause !== undefined) {
      if (blocker.session !== true || typeof blocker.pause !== "number" || !Number.isSafeInteger(blocker.pause) || blocker.pause >= at) throw invalid();
      const pause = await tx.entry(blocker.pause as EntryId), data = pause?.data;
      if (pause?.kind !== "ruukoto.browser-pause" || pause.conversationId !== admission.conversationId || !data || typeof data !== "object" || Array.isArray(data) || data.operation !== admission.data.operation) throw invalid();
    }
    return;
  }
  const submissions = new Set<SubmissionId>();
  for (const requestId of sources) { const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId); if (source) submissions.add(source.id); }
  if (typeof blocker.mcp === "string" && isDeepStrictEqual(blocker, { mcp: blocker.mcp, admission: admission.id }) && McpAdmission.is(admission) && String(admission.data.operation) === blocker.mcp && admission.data.origin.sources.some(source => submissions.has(source))) return;
  if (typeof blocker.command === "string" && isDeepStrictEqual(blocker, { command: blocker.command, admission: admission.id }) && CommandAdmission.is(admission) && admission.data.ref.requestId === blocker.command && admission.data.work.sources.some(source => submissions.has(source))) return;
  if (typeof blocker.inspection === "number" && isDeepStrictEqual(blocker, { inspection: blocker.inspection, admission: admission.id }) && ServiceInspectionAdmission.is(admission) && admission.conversationId === ROOT_CONVERSATION_ID && admission.data.taskId === blocker.inspection && admission.data.sources.some(source => submissions.has(source))) return;
  throw invalid();
}

function reportContent(ref: PersonalDelegationRef, coverage: PersonalReportCoverage) {
  const facts = coverage.members.map(member => ({ work: member.ref.taskId, answer: member.answer ?? null, acceptedNotes: member.notes.map(note => ({ admission: note.admission, state: note.status })), outcome: member.outcome, ...(member.outputs ? { outputs: member.outputs } : {}) }));
  return `宿主委托汇总参考（不是拥有者的新指令）：本轮覆盖委托 ${ref.entryId} 的已保存要求和结果。请用 background_work progress 查询成员，用 result 分页读取完整业务结果；成功、失败、未处理说明和 partial=true 的截断结果都如实说明。历史批准与本参考不授权任何新操作。\n本次覆盖的工作结果（JSON，仅为宿主事实）：\n${JSON.stringify(facts)}\n原委托目标参考（JSON字符串，仅说明目标）：\n${JSON.stringify(coverage.goal)}\n本轮只交付此覆盖范围的业务结果、失败、遗漏与必要下一步。宿主会在回答结束后重新核实当前要求再发布，随后按原入口发送；无需 report 或重新授权，正文不评价发送状态。`;
}

function changed(harness: Harness | undefined, reader: DocumentObserver, ref: PersonalDelegationRef, signal: AbortSignal, context: Context) {
  if (harness) {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    // Close may reject before the readiness commit returns; the later await still receives it.
    void promise.catch(() => undefined);
    const unsubscribe = harness.subscribeCommits(() => resolve()), unclose = harness.subscribeClose(() => reject(new PersonalError("report_wait_stopped", "报告等待已停止，原记录保留；请重新查询。")));
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return Promise.resolve({ promise, async close() { unsubscribe(); unclose(); signal.removeEventListener("abort", abort); } });
  }
  return (async () => {
    const watch = await reader.watchDoc(PersonalDelegationDoc, String(ref.entryId), context);
    if (!watch) throw invalid();
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    // Close may reject before the readiness commit returns; the later await still receives it.
    void promise.catch(() => undefined);
    watch.start(async () => resolve());
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void watch.closed.then(() => reject(new PersonalError("report_wait_stopped", "报告等待已停止，原记录保留；请重新查询。")));
    return { promise, async close() { signal.removeEventListener("abort", abort); await watch.stop(); } };
  })();
}

function reportTask(im?: PersonalImAccess, admitInput?: PersonalMainAdmission, getHarness?: () => Harness) {
  return defineTask<ReportInput, ReportState, { delivery: Delivery }>({
    name: "ruukoto.delegation-report", version: 2, initial: () => ({ phase: "wait" }),
    phases: {
      async wait(current, runtime, context) {
        const ref = current.input.delegation;
        for (;;) {
          const wake = await changed(getHarness?.(), runtime, ref, runtime.signal, context);
          let wait = false;
          try {
            await runtime.commit(async tx => {
              const { report } = await reportFacts(tx, ref, current.id);
              await verifyTrigger(tx, ref, report.trigger, report.source, report.modelCall);
              const state = await readiness(tx, ref);
              if ("canceled" in state || "inactive" in state) { report.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; }
              if ("stopped" in state) { report.delivery = "blocked"; return { status: "terminal", outcome: { status: "failed", error: { message: "原工作停止尚未核实，未发布报告；请查询原操作。", detail: { code: "report_stop_unverified" } }, result: { delivery: "blocked" } } }; }
              if (!("coverage" in state) || !state.coverage) { wait = true; return undefined; }
              const index = report.attempts.length;
              const coverage = (await tx.appendEntry(PersonalReportCoverageEntry, ROOT_CONVERSATION_ID, { data: { version: 2, taskId: current.id, attempt: index, coverage: state.coverage } })).id;
              const content = reportContent(ref, state.coverage);
              report.attempt = index; report.attempts.push({ coverage, content }); report.delivery = "waiting";
              delete report.submissionId; delete report.answer; delete report.reply;
              return { status: "running", checkpoint: { phase: "summarize", attempt: index } };
            }, context);
            if (!wait) return;
            await wake.promise;
          } finally { await wake.close(); }
        }
      },
      async summarize(current, runtime, context) {
        const ref = current.input.delegation, index = current.state.checkpoint.attempt;
        const main = await runtime.conversation(ROOT_CONVERSATION_ID, context);
        if (!main) throw invalid();
        let saved!: V2Facts, stop = false;
        await runtime.commit(async tx => {
          const { report } = await reportFacts(tx, ref, current.id), original = await verifyAttempt(tx, ref, report, index), state = await readiness(tx, ref);
          saved = copyJson(report) as V2Facts;
          if ("canceled" in state || "inactive" in state) { stop = true; report.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; }
          if (!("intake" in state) && (!("coverage" in state) || !isDeepStrictEqual(original.coverage, state.coverage))) {
            stop = true;
            await supersede(tx, report, index, "blocker" in state ? "source_paused" : "requirements_changed", "coverage" in state ? state.coverage : undefined, "blocker" in state ? state.blocker : undefined);
            return { status: "running", checkpoint: { phase: "wait" } };
          }
          return undefined;
        }, context);
        if (stop) return;
        const attempt = saved.attempts[index];
        const submission = await withPersonalImEntry(im, (await runtime.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.telegram ?? {}, () => (admitInput ?? main.submit.bind(main))({ type: "input", requestId: keyFor(current.id, index), content: attempt.content, entry: { kind: INPUT_KIND, data: inputData(ref, saved, index) }, whenBusy: "followUp" }, context));
        await runtime.commit(async tx => {
          const { report } = await reportFacts(tx, ref, current.id);
          report.attempts[index].submissionId = submission.id; report.submissionId = submission.id;
          await verifyAttempt(tx, ref, report, index);
          return undefined;
        }, context);
        const settledWait = submission.wait(context);
        void settledWait.catch(() => undefined);
        let settled: Awaited<ReturnType<typeof submission.wait>> | undefined;
        for (;;) {
          const wake = await changed(getHarness?.(), runtime, ref, runtime.signal, context);
          try {
            let stopped = false;
            await runtime.commit(async tx => { const { value } = await reportFacts(tx, ref, current.id); stopped = value.cancelRequested || !!value.telegram && !await telegramSourceActive(tx, value.telegram); return undefined; }, context);
            if (stopped) { await submission.abort(context); break; }
            const result = await Promise.race([settledWait.then(value => ({ settled: value })), wake.promise.then(() => ({}))]);
            if ("settled" in result) { settled = result.settled; break; }
          } finally { await wake.close(); }
        }
        await runtime.commit(async tx => {
          const { report } = await reportFacts(tx, ref, current.id), original = await verifyAttempt(tx, ref, report, index), state = await readiness(tx, ref);
          if ("canceled" in state || "inactive" in state) { report.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; }
          if (settled?.status === "done" && settled.type === "input") report.attempts[index].answer = settled.answer;
          if (report.attempts[index].superseded !== undefined || !("intake" in state) && (!("coverage" in state) || !isDeepStrictEqual(original.coverage, state.coverage))) {
            await supersede(tx, report, index, "blocker" in state ? "source_paused" : "requirements_changed", "coverage" in state ? state.coverage : undefined, "blocker" in state ? state.blocker : undefined);
            return { status: "running", checkpoint: { phase: "wait" } };
          }
          if (settled?.status !== "done" || settled.type !== "input") { report.delivery = "unanswered"; return { status: "terminal", outcome: { status: "failed", error: { message: "主会话未完成本报告，未发布或外发；请查询原委托。" }, result: { delivery: "unanswered" } } }; }
          const answer = await tx.entry(AssistantEntry, settled.answer), message = answer?.model?.[0];
          if (message?.role !== "assistant") throw invalid();
          if (!message.content.some(part => part.type === "text" && part.text)) { report.delivery = "unanswered"; return { status: "terminal", outcome: { status: "failed", error: { message: "主会话未产出报告正文，未发布或外发；请查询原委托。" }, result: { delivery: "unanswered" } } }; }
          return { status: "running", checkpoint: { phase: "publish", attempt: index } };
        }, context);
      },
      async publish(current, runtime, context) {
        const ref = current.input.delegation, index = current.state.checkpoint.attempt;
        for (;;) {
          const wake = await changed(getHarness?.(), runtime, ref, runtime.signal, context);
          let wait = false;
          try {
        await runtime.commit(async tx => {
          const { value, report } = await reportFacts(tx, ref, current.id), original = await verifyAttempt(tx, ref, report, index), state = await readiness(tx, ref);
          if ("canceled" in state || "inactive" in state) { report.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; }
          if ("intake" in state) { wait = true; return undefined; }
          if (!("coverage" in state) || !isDeepStrictEqual(original.coverage, state.coverage)) { await supersede(tx, report, index, "blocker" in state ? "source_paused" : "requirements_changed", "coverage" in state ? state.coverage : undefined, "blocker" in state ? state.blocker : undefined); return { status: "running", checkpoint: { phase: "wait" } }; }
          const answer = original.attempt.answer;
          if (answer === undefined || original.attempt.superseded !== undefined) throw invalid();
          const entry = await tx.entry(AssistantEntry, answer), message = entry?.model?.[0];
          if (message?.role !== "assistant") throw invalid();
          const outputs = original.coverage.members.flatMap(member => member.outputs ?? []);
          if (outputs.length > PERSONAL_OUTPUT_LIMIT) throw invalid();
          report.publication = (await tx.appendEntry(PersonalReportPublication, ROOT_CONVERSATION_ID, { data: { version: 2, delegation: ref, taskId: current.id, attempt: index, coverage: original.attempt.coverage, answer, ...(outputs.length ? { outputs } : {}) } })).id;
          if (value.telegram && value.telegram.platform === undefined && im?.delivery) report.replyFormat = "complete";
          report.answer = answer; report.reply = personalReportReplyText(report, message.content.filter(part => part.type === "text").map(part => part.text).join("")); report.delivery = "pending";
          return { status: "running", checkpoint: { phase: "send" } };
        }, context);
            if (!wait) return;
            await wake.promise;
          } finally { await wake.close(); }
        }
      },
      async send(current, runtime, context) {
        if (current.state.checkpoint.retryAt) await runtime.sleep(current.state.checkpoint.retryAt, context);
        const ref = current.input.delegation, source = (await runtime.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.telegram;
        let owner = "", message = 0, reply = "", api: PersonalImSender | undefined;
        for (;;) {
          const wake = await changed(getHarness?.(), runtime, ref, runtime.signal, context);
          let wait = false;
          try {
            await withPersonalImEntry(im, source ?? {}, async () => {
              await runtime.commit(async tx => {
                const { value, report } = await reportFacts(tx, ref, current.id), original = await verifyAttempt(tx, ref, report, report.attempt), state = await readiness(tx, ref);
                if (report.multipart) return { status: "running", checkpoint: { phase: "deliver" } };
                const changedRequirements = await requirementsChanged(tx, ref, original.coverage);
                const reason = "canceled" in state ? "canceled" : "inactive" in state || source && im && !im.isActive(source) ? "source_inactive" : changedRequirements || "coverage" in state && !isDeepStrictEqual(state.coverage, original.coverage) ? "requirements_changed" : undefined;
                if (reason) {
                  report.sendCanceled = (await tx.appendEntry(ReportSendCanceled, ROOT_CONVERSATION_ID, { data: { version: 2, taskId: current.id, publication: report.publication!, reason } })).id;
                  report.delivery = "canceled";
                  return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } };
                }
                if (!("coverage" in state) || !state.coverage) { wait = true; return undefined; }
                await personalReportPublicationMessage(tx, (await tx.entry(report.publication!))!);
                if (!value.telegram) { report.delivery = "local"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "local" } } }; }
                const receipt = await personalSourceImReceipt(tx, value.source.requestId), config = personalEntryConfig(await tx.doc(PersonalTelegramDoc), value.telegram);
                if (!receipt || !report.reply || report.delivery !== "pending" || !config?.enabled || config.generation !== value.telegram.generation || config.botId !== value.telegram.botId || config.ownerId !== value.telegram.ownerId) throw invalid();
                owner = value.telegram.ownerId; message = receipt.messageId; reply = report.reply;
                if (value.telegram.platform === undefined && im?.delivery) {
                  const publication = await tx.entry(PersonalReportPublication, report.publication!);
                  if (!publication) throw invalid();
                  const text = (await personalReportPublicationMessage(tx, publication))!.content.filter(part => part.type === "text").map(part => part.text).join("");
                  const outputs = publication.data.outputs?.map(output => ({ publication: publication.id, output }));
                  report.multipart = await im.delivery.request(tx, { key: `report:${current.id}`, source: value.telegram, messageId: receipt.messageId, text, ...(outputs?.length ? { outputs } : {}) }, current.id);
                  report.delivery = "sending"; owner = "";
                  return { status: "running", checkpoint: { phase: "deliver" } };
                }
                if (!im) { if (!("apiBase" in config)) throw invalid(); api = personalTelegramApi(config.apiBase, telegramToken(config)); }
                report.delivery = "sending";
                const version = im?.configurationVersion(value.telegram); if (version) report.configurationVersion = version;
                return { status: "running", checkpoint: { phase: "verify" } };
              }, context);
              if (owner && im && source) api = im.sender(source);
            });
            if (!wait) break;
            await wake.promise;
          } finally { await wake.close(); }
        }
        if (!owner) return;
        let platformMessageId: string | undefined, failure: PersonalImApiError | undefined;
        try { if (!api) throw new PersonalImApiError("im_target_inactive", "原报告入口已失效，未发送；请查询原委托。", "not_sent"); platformMessageId = await api.send(owner, message, reply, runtime.signal); } catch (error) { if (!(error instanceof PersonalImApiError)) throw error; failure = error; }
        await runtime.commit(async tx => {
          const { report } = await reportFacts(tx, ref, current.id);
          if (failure?.retryAfterMs) { report.delivery = "pending"; return { status: "running", checkpoint: { phase: "send", retryAt: runtime.now() + failure.retryAfterMs } }; }
          report.delivery = platformMessageId ? "sent" : failure?.effect === "not_sent" ? "failed" : "effect_unknown";
          if (platformMessageId) report.platformMessageId = platformMessageId;
          return { status: "terminal", outcome: { status: "completed", result: { delivery: report.delivery } } };
        }, context);
      },
      async verify(current, runtime, context) { await runtime.commit(async tx => { const { report } = await reportFacts(tx, current.input.delegation, current.id); if (report.multipart) return { status: "running", checkpoint: { phase: "deliver" } }; report.delivery = "effect_unknown"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "effect_unknown" } } }; }, context); },
      async deliver(current, runtime, context) {
        const ref = current.input.delegation, saved = (await runtime.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!;
        const report = personalReportsFor(saved).find(report => report.taskId === current.id);
        if (!report?.multipart || !im?.delivery) throw invalid();
        await runtime.waitForTask(report.multipart.taskId, context);
        await runtime.commit(async tx => {
          const { report } = await reportFacts(tx, ref, current.id);
          await settlePersonalReportDelivery(tx, report);
          return { status: "terminal", outcome: { status: "completed", result: { delivery: report.delivery } } };
        }, context);
      },
    },
    async abort(current, runtime, context) {
      const ref = current.input.delegation, saved = (await runtime.snapshot(PersonalDelegationDoc, String(ref.entryId), context))?.delegation;
      const report = saved && personalReportsFor(saved).find(report => report.taskId === current.id);
      if (!report || report.version !== 2) throw invalid();
      if (report.multipart) { if (!im?.delivery) throw invalid(); await im.delivery.abort(report.multipart); }
      const attempt = report.attempts[report.attempt];
      if (attempt) {
        const main = await runtime.conversation(ROOT_CONVERSATION_ID, context);
        let admitted = false;
        await runtime.commit(async tx => { admitted = !!(await verifyAttempt(tx, ref, (await reportFacts(tx, ref, current.id)).report, report.attempt)).submission; return undefined; }, context);
        if (main && admitted) { const original = await (admitInput ?? main.submit.bind(main))({ type: "input", requestId: keyFor(current.id, report.attempt), content: attempt.content, entry: { kind: INPUT_KIND, data: inputData(ref, report, report.attempt) }, whenBusy: "followUp" }, context); await original.abort(context); }
      }
      await runtime.commit(async tx => { const { report } = await reportFacts(tx, ref, current.id); if (report.multipart) await settlePersonalReportDelivery(tx, report); else report.delivery = report.delivery === "sending" ? "effect_unknown" : "canceled"; return { status: "terminal", outcome: { status: "aborted", result: { delivery: report.delivery } } }; }, context);
    },
  });
}

export const PersonalReportTask = reportTask();
export const personalDelegationReports = defineExtension({ name: "personal-delegation-reports", tasks: [PersonalReportTask] });
export function personalReports(im: PersonalImAccess, admitInput?: PersonalMainAdmission, getHarness?: () => Harness) { return defineExtension({ name: "personal-delegation-reports", tasks: [reportTask(im, admitInput, getHarness)] }); }

export async function personalReportRequest(tx: Tx) {
  const legacy = await legacyPersonalReportRequest(tx);
  if (legacy) return legacy;
  const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
  if (!live.run) return;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: PersonalReportTask.definition.name }, 64, cursor);
    for (const task of page.items) {
      if (task.version !== 2) continue;
      const input = task.input;
      if (!input || typeof input !== "object" || Array.isArray(input) || !input.delegation || typeof input.delegation !== "object" || Array.isArray(input.delegation) || typeof input.delegation.entryId !== "number") throw invalid();
      const ref = { entryId: input.delegation.entryId as EntryId }, { report } = await reportFacts(tx, ref, task.id);
      for (const [index, attempt] of report.attempts.entries()) {
        const original = await verifyAttempt(tx, ref, report, index);
        if (!original.submission || !live.run.inputs.includes(original.submission.id)) continue;
        if (index !== report.attempt || attempt.superseded !== undefined || live.run.inputs.length !== 1 || task.abortRequested || task.state.status === "terminal") return new PersonalError("report_inactive", "原报告草稿已停止，未继续请求；请查询当前工作。");
        const state = await readiness(tx, ref);
        if ("intake" in state) continue;
        if (!("coverage" in state) || !isDeepStrictEqual(original.coverage, state.coverage)) {
          await supersede(tx, report, index, "blocker" in state ? "source_paused" : "requirements_changed", "coverage" in state ? state.coverage : undefined, "blocker" in state ? state.blocker : undefined);
          return new PersonalError("report_requirements_changed", "工作要求或状态正在更新，本次旧草稿未发布；宿主会在相关输入处理后重新核实。");
        }
      }
    }
    cursor = page.next;
  } while (cursor);
}

export type PersonalReportReference = { version: 2; taskId: TaskId; attempt: number; submissionId: SubmissionId; entryId: EntryId; coverage: EntryId };
// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-report-publication.md
export async function personalReportReference(tx: Tx): Promise<PersonalReportReference | undefined> {
  const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
  if (!live.run || live.run.inputs.length !== 1) return;
  for (const value of await reportAttempts(tx)) {
    const original = await verifyAttempt(tx, value.ref, value.report, value.index);
    if (original.submission?.id === live.run.inputs[0] && original.submission.entry !== undefined) return { version: 2, taskId: value.report.taskId, attempt: value.index, submissionId: original.submission.id, entryId: original.submission.entry, coverage: value.attempt.coverage };
  }
}

export async function personalReportInput(tx: Tx, submissionId: SubmissionId): Promise<boolean> {
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: PersonalReportTask.definition.name }, 64, cursor);
    for (const task of page.items) {
      if (task.version !== 2) continue;
      const input = task.input;
      if (!input || typeof input !== "object" || Array.isArray(input) || !input.delegation || typeof input.delegation !== "object" || Array.isArray(input.delegation) || typeof input.delegation.entryId !== "number") throw invalid();
      const ref = { entryId: input.delegation.entryId as EntryId }, { report } = await reportFacts(tx, ref, task.id);
      for (let index = 0; index < report.attempts.length; index++) {
        const original = await verifyAttempt(tx, ref, report, index);
        if (original.submission?.id === submissionId) return true;
      }
    }
    cursor = page.next;
  } while (cursor);
  return false;
}

async function reportSourceReference(tx: Tx, before: EntryId): Promise<PersonalReportReference | undefined> {
  let expected: PersonalReportReference | undefined, previous: EntryRecord | undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, maxEntryId: (before - 1) as EntryId, order: "descending" }, 256, cursor);
    previous = page.items.find(candidate => ["pi.user", "pi.reset", "ruukoto.question-answer", INPUT_KIND].includes(candidate.kind) && candidate.model?.some(message => message.role === "user"));
    cursor = page.next;
  } while (!previous && cursor);
  if (previous?.kind === INPUT_KIND && previous.data && typeof previous.data === "object" && !Array.isArray(previous.data) && previous.data.version === 2) {
    const match = (await reportAttempts(tx)).find(value => isDeepStrictEqual(previous!.data, inputData(value.ref, value.report, value.index)));
    const original = match && await verifyAttempt(tx, match.ref, match.report, match.index);
    if (!match || original?.submission?.entry !== previous.id) throw invalid();
    expected = { version: 2, taskId: match.report.taskId, attempt: match.index, submissionId: original.submission.id, entryId: previous.id, coverage: match.attempt.coverage };
  }
  return expected;
}

async function reportRequestReference(tx: Tx, entry: EntryRecord): Promise<PersonalReportReference | undefined> {
  if (entry.kind !== "ruukoto.model-request") return;
  if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) throw invalid();
  const rawRefs = entry.data.references, input = entry.data.input;
  const refs = rawRefs && typeof rawRefs === "object" && !Array.isArray(rawRefs) ? rawRefs : undefined;
  if (entry.conversationId !== ROOT_CONVERSATION_ID) { if (refs?.report !== undefined) throw invalid(); return; }
  const messages = input && typeof input === "object" && !Array.isArray(input) && Array.isArray(input.messages) ? input.messages : undefined;
  if (!messages?.length) throw invalid();
  const first = messages[0];
  const sections = first && typeof first === "object" && !Array.isArray(first) && first.sections && typeof first.sections === "object" && !Array.isArray(first.sections) ? first.sections : undefined;
  // Compaction produces no assistant response; native report responses independently require a product request below.
  if (sections?.personal === undefined) { if (refs?.report !== undefined) throw invalid(); return; }
  const expected = await reportSourceReference(tx, entry.id);
  if (!messages || !refs || typeof refs.generation !== "number" || !Number.isSafeInteger(refs.generation)) { if (expected !== undefined || refs?.report !== undefined) throw invalid(); return; }
  const generation = await tx.task(refs.generation as TaskId);
  if (!generation || generation.kind !== "pi.generation" || generation.conversationId !== ROOT_CONVERSATION_ID || expected !== undefined && refs.conversationId !== ROOT_CONVERSATION_ID) throw invalid();
  if (!isDeepStrictEqual(refs.report, expected)) throw invalid();
  if (expected !== undefined) {
    let finished = false;
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId: entry.id, order: "ascending" }, 256, cursor);
      for (const candidate of page.items) {
        if (candidate.id <= entry.id) continue;
        if (candidate.kind === AssistantEntry.kind) {
          if (candidate.byTaskId !== generation.id && !(candidate.byTaskId === undefined && generation.state.status === "terminal" && ["faulted", "orphaned", "aborted"].includes(generation.state.outcome.status) && candidate.model?.[0]?.role === "assistant" && candidate.model[0].stopReason === "aborted")) throw invalid();
          finished = true; break;
        }
        if (["pi.user", "pi.reset", "ruukoto.question-answer", INPUT_KIND].includes(candidate.kind)) { finished = true; break; }
        const data = candidate.data;
        if (candidate.kind !== "ruukoto.model-request" || !data || typeof data !== "object" || Array.isArray(data) || data.requestId === entry.data.requestId) continue;
        const request = data.input, first = request && typeof request === "object" && !Array.isArray(request) && Array.isArray(request.messages) ? request.messages[0] : undefined;
        if (first && typeof first === "object" && !Array.isArray(first) && first.sections && typeof first.sections === "object" && !Array.isArray(first.sections) && first.sections.personal !== undefined) { finished = true; break; }
      }
      cursor = page.next;
    } while (!finished && cursor);
    if (generation.state.status === "terminal" && generation.state.outcome.status === "completed") {
      const result = generation.state.outcome.result;
      if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.entryId !== "number" || result.entryId <= entry.id) throw invalid();
    }
  }
  return expected;
}

async function reportResponseReference(tx: Tx, entry: EntryRecord): Promise<PersonalReportReference | undefined> {
  if (entry.kind !== AssistantEntry.kind || entry.conversationId !== ROOT_CONVERSATION_ID) return;
  const expected = await reportSourceReference(tx, entry.id);
  if (expected === undefined) return;
  // Native generation owns assistant entries, independently of the request's mutable JSON fields.
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId: expected.entryId, maxEntryId: (entry.id - 1) as EntryId, order: "descending" }, 256, cursor);
    for (const request of page.items) {
      if (request.kind !== "ruukoto.model-request") continue;
      const reference = await reportRequestReference(tx, request), data = request.data;
      const refs = data && typeof data === "object" && !Array.isArray(data) && data.references && typeof data.references === "object" && !Array.isArray(data.references) ? data.references : undefined;
      if (!isDeepStrictEqual(reference, expected) || !refs || typeof refs.generation !== "number") continue;
      if (entry.byTaskId === refs.generation) return expected;
      if (entry.byTaskId === undefined) {
        const generation = await tx.task(refs.generation as TaskId);
        if (generation?.state.status === "terminal" && ["faulted", "orphaned", "aborted"].includes(generation.state.outcome.status) && entry.model?.[0]?.role === "assistant" && entry.model[0].stopReason === "aborted") return expected;
      }
    }
    cursor = page.next;
  } while (cursor);
  throw invalid();
}

export async function personalReportTaskDraft(tx: Tx, taskId: TaskId): Promise<boolean> {
  const seen = new Set<TaskId>();
  let current: TaskId | undefined = taskId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const task = await tx.task(current);
    if (!task) return false;
    if (task.kind === PersonalReportTask.definition.name) return task.version === 2;
    if (task.kind === "pi.generation" && task.conversationId === ROOT_CONVERSATION_ID) {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 256, cursor);
        for (const entry of page.items) {
          if (entry.kind === AssistantEntry.kind && entry.byTaskId === task.id && await reportResponseReference(tx, entry)) return true;
          if (entry.kind !== "ruukoto.model-request") continue;
          const references = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data.references : undefined;
          if (!references || typeof references !== "object" || Array.isArray(references) || references.generation !== task.id) continue;
          const report = await reportRequestReference(tx, entry);
          if (report) return true;
        }
        cursor = page.next;
      } while (cursor);
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      if (live.run?.taskId === task.id) for (const id of live.run.inputs) if (await personalReportInput(tx, id)) return true;
    }
    current = task.owner;
  }
  return false;
}
async function reportAttempts(tx: Tx) {
  const items: { ref: PersonalDelegationRef; report: V2Facts; index: number; attempt: ReportAttempt }[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: PersonalReportTask.definition.name }, 64, cursor);
    for (const task of page.items) {
      if (task.version !== 2) continue;
      const input = task.input;
      if (!input || typeof input !== "object" || Array.isArray(input) || !input.delegation || typeof input.delegation !== "object" || Array.isArray(input.delegation) || typeof input.delegation.entryId !== "number") throw invalid();
      const ref = { entryId: input.delegation.entryId as EntryId }, { report } = await reportFacts(tx, ref, task.id);
      for (const [index, attempt] of report.attempts.entries()) items.push({ ref, report, index, attempt });
    }
    cursor = page.next;
  } while (cursor);
  return items;
}
// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-report-publication.md
export async function personalReportDraft(tx: Tx, entry: EntryRecord): Promise<boolean> {
  if (entry.kind === INPUT_KIND && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) && entry.data.version === 2) {
    const match = (await reportAttempts(tx)).find(({ ref, report, index }) => isDeepStrictEqual(entry.data, inputData(ref, report, index)));
    if (!match || (await verifyAttempt(tx, match.ref, match.report, match.index)).submission?.entry !== entry.id) throw invalid();
    return true;
  }
  if (entry.kind !== AssistantEntry.kind && entry.kind !== "pi.tool-result") return false;
  if (await reportResponseReference(tx, entry)) return true;
  return entry.byTaskId !== undefined && await personalReportTaskDraft(tx, entry.byTaskId);
}

// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-report-publication.md
export async function personalReportPublicationMessage(tx: Tx, entry: EntryRecord): Promise<AssistantMessage | undefined> {
  if (entry.kind !== PersonalReportPublication.kind) return;
  if (!PersonalReportPublication.is(entry)) throw invalid();
  const data = entry.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.delegation || typeof data.delegation !== "object" || !Number.isSafeInteger(data.delegation.entryId) || ![data.taskId, data.attempt, data.coverage, data.answer].every(Number.isSafeInteger)) throw invalid();
  if (data.version !== 2 || entry.conversationId !== ROOT_CONVERSATION_ID || entry.model !== undefined) throw invalid();
  const { report } = await reportFacts(tx, data.delegation, data.taskId), original = await verifyAttempt(tx, data.delegation, report, data.attempt);
  if (report.publication !== entry.id || report.answer !== data.answer || report.attempt !== data.attempt || original.attempt.answer !== data.answer || original.attempt.coverage !== data.coverage || original.attempt.superseded !== undefined || entry.id <= data.answer) throw invalid();
  const historical = await currentCoverage(tx, data.delegation, data.coverage);
  if (!historical || !isDeepStrictEqual(historical, original.coverage)) throw invalid();
  const outputs = original.coverage.members.flatMap(member => member.outputs ?? []);
  if (outputs.length > PERSONAL_OUTPUT_LIMIT || !isDeepStrictEqual(data.outputs, outputs.length ? outputs : undefined)) throw invalid();
  const answer = await tx.entry(AssistantEntry, data.answer), message = answer?.model?.[0];
  if (answer?.conversationId !== ROOT_CONVERSATION_ID || message?.role !== "assistant" || !message.content.some(part => part.type === "text" && part.text) || report.replyFormat !== undefined && report.replyFormat !== "complete" || report.reply !== personalReportReplyText(report, message.content.filter(part => part.type === "text").map(part => part.text).join(""))) throw invalid();
  return message;
}

export async function personalReportOutputs(tx: Tx, entry: EntryRecord): Promise<PersonalDesktopOutput[]> {
  if (!PersonalReportPublication.is(entry)) return [];
  await personalReportPublicationMessage(tx, entry);
  const outputs: PersonalDesktopOutput[] = [];
  for (const id of entry.data.outputs ?? []) outputs.push(personalOutputMetadata(entry.id, await personalOutputIntent(tx, id)));
  return outputs;
}

export async function personalPublishedOutput(tx: Tx, publication: EntryId, output: EntryId) {
  const entry = await tx.entry(publication);
  if (!entry || !(await personalReportOutputs(tx, entry)).some(value => value.output === output)) throw new PersonalError("output_unpublished", "此文件不属于原发布结果，未读取；请从原结果选择文件。");
  return personalOutputIntent(tx, output);
}

export async function authorizePersonalReportDelivery(tx: Tx, input: PersonalImDeliveryInput, parent: TaskId) {
  const task = await tx.task(parent);
  if (!task || task.kind !== PersonalReportTask.definition.name) throw invalid();
  if (task.version === 1) return authorizeLegacyPersonalReportDelivery(tx, input, parent);
  const data = task.input;
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.delegation || typeof data.delegation !== "object" || Array.isArray(data.delegation) || typeof data.delegation.entryId !== "number") throw invalid();
  const ref = { entryId: data.delegation.entryId as EntryId }, { value, report } = await reportFacts(tx, ref, parent);
  if (!value.telegram || value.telegram.platform !== undefined || !report.publication) throw invalid();
  const original = await verifyAttempt(tx, ref, report, report.attempt);
  if (value.cancelRequested || !await telegramSourceActive(tx, value.telegram) || await requirementsChanged(tx, ref, original.coverage)) return false;
  const publication = await tx.entry(PersonalReportPublication, report.publication), receipt = await personalSourceImReceipt(tx, value.source.requestId);
  if (!publication || !receipt) throw invalid();
  const text = (await personalReportPublicationMessage(tx, publication))!.content.filter(part => part.type === "text").map(part => part.text).join("");
  const outputs = publication.data.outputs?.map(output => ({ publication: publication.id, output }));
  await personalReportMultipart(tx, report, { key: `report:${parent}`, source: value.telegram, messageId: receipt.messageId, text, ...(outputs?.length ? { outputs } : {}) });
  if (!isDeepStrictEqual(input, (await personalImDeliveryRecord(tx, report.multipart!)).input)) throw invalid();
  const state = await readiness(tx, ref);
  if ("canceled" in state || "inactive" in state || await requirementsChanged(tx, ref, original.coverage)) return false;
  if (!("coverage" in state)) return "wait" as const;
  return !!state.coverage && isDeepStrictEqual(state.coverage, original.coverage);
}

export async function personalReportResult(tx: Tx, ref: PersonalDelegationRef, offset = 0, size = 4096): Promise<{ delivery: string; state?: string; text?: string; offset?: number; totalChars?: number; nextOffset?: number; multipart?: PersonalImDeliveryRef; outputDelivery?: string }> {
  const value = await personalDelegation(tx, ref);
  if (!value.report) return { delivery: "not_requested" };
  if (value.report.version !== 2) return legacyPersonalReportResult(tx, ref, offset, size);
  const report = value.report, task = await tx.task(report.taskId);
  if (!task) throw invalid();
  const state = task.state.status === "terminal" ? task.state.outcome.status : task.state.status;
  if (report.publication === undefined) return { delivery: report.delivery, state };
  const publication = await tx.entry(report.publication);
  if (!publication) throw invalid();
  const message = await personalReportPublicationMessage(tx, publication);
  if (!message) throw invalid();
  const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
  let end = Math.min(offset + size, text.length);
  if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1]) && /[\udc00-\udfff]/.test(text[end])) end--;
  const delivery = report.multipart && personalImDeliveryResult(await personalImDeliveryRecord(tx, report.multipart));
  return { delivery: delivery && delivery.textState !== "none" ? delivery.textState : report.delivery, state, text: text.slice(offset, end), offset, totalChars: text.length, ...(end < text.length ? { nextOffset: end } : {}), ...(delivery ? { multipart: { ...report.multipart! }, ...(delivery.outputState === "none" ? {} : { outputDelivery: delivery.outputState }) } : {}) };
}

// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-report-publication.md
export async function verifyPersonalReports(tx: Tx, keys: string[], enabled: boolean) {
  await verifyLegacyPersonalReports(tx, keys, enabled);
  const taskIds = new Set<TaskId>(), facts = new Set<EntryId>();
  for (const key of keys) {
    const value = await personalDelegation(tx, { entryId: Number(key) as EntryId });
    const reports = personalReportsFor(value);
    if (new Set(reports.map(report => report.taskId)).size !== reports.length) throw invalid();
    for (const report of reports) {
      if (report.version !== 2) continue;
      taskIds.add(report.taskId); facts.add(report.admission);
      const task = await tx.task(report.taskId), admission = await tx.entry(ReportAdmission, report.admission);
      const expected = { version: 2, delegation: value.ref, source: report.source, modelCall: report.modelCall, content: report.content, trigger: report.trigger };
      if (!enabled || task?.kind !== PersonalReportTask.definition.name || task.version !== 2 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !isDeepStrictEqual(task.input, expected) || !admission || admission.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(admission.data, { ...expected, taskId: report.taskId }) || !Array.isArray(report.triggers) || !report.triggers.includes(report.trigger) || new Set(report.triggers).size !== report.triggers.length || !Array.isArray(report.attempts) || !Number.isSafeInteger(report.attempt) || report.attempt < 0 || report.attempts.length && report.attempt !== report.attempts.length - 1 || !Array.isArray(report.supersessions) || !Array.isArray(report.pauses) || !["waiting", "local", "pending", "sending", "sent", "failed", "effect_unknown", "canceled", "blocked", "unanswered"].includes(report.delivery)) throw invalid();
      await verifyTrigger(tx, value.ref, report.trigger, report.source, report.modelCall);
      for (const trigger of report.triggers) {
        const entry = await tx.entry(trigger);
        if (entry?.kind === ReportRequest.kind) facts.add(trigger);
        if (!entry || entry.id >= report.admission && trigger === report.trigger) throw invalid();
        const source = PersonalAnalysisAdmission.is(entry) ? entry.data.source : PersonalWorkNoteAdmission.is(entry) && entry.data.source.kind === "input" ? { requestId: entry.data.source.requestId, submissionId: entry.data.source.submissionId, entryId: entry.data.source.entryId } : report.source;
        const call = PersonalAnalysisAdmission.is(entry) ? entry.data.modelCall : PersonalWorkNoteAdmission.is(entry) && entry.data.source.kind === "input" && entry.data.source.modelCall !== undefined ? entry.data.source.modelCall : report.modelCall;
        await verifyTrigger(tx, value.ref, trigger, source, call);
      }
      for (const [index, attempt] of report.attempts.entries()) {
        const original = await verifyAttempt(tx, value.ref, report, index); facts.add(attempt.coverage);
        if (attempt.coverage <= report.admission || attempt.content !== reportContent(value.ref, original.coverage)) throw invalid();
        const historical = await currentCoverage(tx, value.ref, attempt.coverage);
        if (!historical || !isDeepStrictEqual(historical, original.coverage)) throw invalid();
        for (const source of original.coverage.sources) if (!isDeepStrictEqual((await personalSource(tx, source.requestId)).source, source)) throw invalid();
        for (const member of original.coverage.members) {
          const work = await tx.doc(PersonalWorkDoc, member.ref.requestId, null), task = await tx.task(member.ref.taskId);
          if (!value.members.some(ref => isDeepStrictEqual(ref, member.ref)) || !isDeepStrictEqual(work.ref, member.ref) || task?.state.status !== "terminal" || !isDeepStrictEqual(member.outcome, task.state.outcome) || member.admission !== work.delegationAdmission) throw invalid();
          for (const note of member.notes) if (!work.notes?.some(saved => saved.admission === note.admission && saved.requestId === note.requestId)) throw invalid();
        }
        if (attempt.superseded !== undefined) {
          facts.add(attempt.superseded);
          const supersession = await tx.entry(ReportSupersession, attempt.superseded);
          if (!supersession || !supersession.data || typeof supersession.data !== "object" || Array.isArray(supersession.data) || supersession.conversationId !== ROOT_CONVERSATION_ID || supersession.id <= attempt.coverage || supersession.data.version !== 2 || supersession.data.taskId !== report.taskId || supersession.data.attempt !== index || supersession.data.coverage !== attempt.coverage || !report.supersessions.includes(attempt.superseded) || !["requirements_changed", "source_paused"].includes(supersession.data.reason)) throw invalid();
          if (supersession.data.reason === "source_paused") {
            if (attempt.pause !== attempt.superseded || report.pauses[index] !== attempt.pause || supersession.data.current !== undefined) throw invalid();
            await verifyPauseBlocker(tx, value.ref, supersession.id, supersession.data.blocker);
          } else {
            if (attempt.pause !== undefined || supersession.data.blocker !== undefined) throw invalid();
            if (supersession.data.current !== undefined) {
              const current = await currentCoverage(tx, value.ref, supersession.id);
              if (!current || !isDeepStrictEqual(current, supersession.data.current) || isDeepStrictEqual(current, original.coverage)) throw invalid();
            }
          }
        } else if (index < report.attempt) throw invalid();
      }
      const superseded = report.attempts.flatMap(attempt => attempt.superseded === undefined ? [] : [attempt.superseded]);
      if (!isDeepStrictEqual(report.supersessions, superseded) || report.pauses.length > report.attempts.length || report.pauses.some((pause, index) => (pause ?? null) !== (report.attempts[index]?.pause ?? null)) || report.submissionId !== report.attempts[report.attempt]?.submissionId) throw invalid();
      if (report.publication !== undefined) {
        facts.add(report.publication);
        const entry = await tx.entry(report.publication); if (!entry) throw invalid();
        await personalReportPublicationMessage(tx, entry);
        if (report.multipart) {
          const publication = await tx.entry(PersonalReportPublication, report.publication), receipt = await personalSourceImReceipt(tx, value.source.requestId);
          if (!publication || !receipt || !value.telegram || value.telegram.platform !== undefined) throw invalid();
          const message = await personalReportPublicationMessage(tx, publication), outputs = publication.data.outputs?.map(output => ({ publication: publication.id, output }));
          const delivery = await personalReportMultipart(tx, report, { key: `report:${report.taskId}`, source: value.telegram, messageId: receipt.messageId, text: message!.content.filter(part => part.type === "text").map(part => part.text).join(""), ...(outputs?.length ? { outputs } : {}) });
          if (task.state.status === "terminal" && ["faulted", "orphaned"].includes(task.state.outcome.status)) await settlePersonalReportDelivery(tx, report);
          if (task.state.status === "terminal" && !["faulted", "orphaned"].includes(task.state.outcome.status)) {
            const result = await settlePersonalImDelivery(tx, report.multipart);
            if (result.textState !== report.delivery || report.delivery === "sent" && delivery.parts.findLast(part => part.kind === "text" && part.state === "sent")?.platformMessageId !== report.platformMessageId) throw invalid();
          }
        }
      } else if (report.answer !== undefined || report.reply !== undefined || ["local", "pending", "sending", "sent", "failed", "effect_unknown"].includes(report.delivery)) throw invalid();
      if (report.sendCanceled !== undefined) { facts.add(report.sendCanceled); const canceled = await tx.entry(ReportSendCanceled, report.sendCanceled); if (!canceled || canceled.conversationId !== ROOT_CONVERSATION_ID || !["requirements_changed", "canceled", "source_inactive"].includes(canceled.data.reason) || canceled.data.taskId !== report.taskId || canceled.data.publication !== report.publication || canceled.data.version !== 2 || canceled.id <= report.publication! || report.delivery !== "canceled") throw invalid(); }
      if (report.failureOutcome !== undefined && (task.state.status !== "terminal" || !["faulted", "orphaned"].includes(task.state.outcome.status) || !isDeepStrictEqual(report.failureOutcome, task.state.outcome))) throw invalid();
      if (report.failure !== undefined) {
        facts.add(report.failure);
        const failure = await tx.entry(ReportFailure, report.failure);
        const historicalDelivery = report.multipart && failure ? (await personalImDeliveryTextReceipt(tx, report.multipart, failure.id)).state : report.delivery;
        if (!failure || failure.conversationId !== ROOT_CONVERSATION_ID || failure.data.version !== 2 || failure.data.taskId !== report.taskId || failure.data.delivery !== historicalDelivery || task.state.status !== "terminal" || !["faulted", "orphaned"].includes(task.state.outcome.status) || !isDeepStrictEqual(failure.data.outcome, task.state.outcome)) throw invalid();
      }
      if (report.platformMessageId !== undefined && (typeof report.platformMessageId !== "string" || !report.platformMessageId || report.delivery !== "sent") || report.delivery === "sent" && report.platformMessageId === undefined) throw invalid();
      if (task.state.status === "terminal") {
        const outcome = task.state.outcome.result;
        if (!["faulted", "orphaned"].includes(task.state.outcome.status) && (!outcome || typeof outcome !== "object" || Array.isArray(outcome) || outcome.delivery !== (report.delivery === "effect_unknown" && report.sendCanceled === undefined && outcome.delivery === "sending" ? "sending" : report.delivery))) throw invalid();
      }
      if (task.state.status !== "terminal") {
        const checkpoint = task.state.status !== "completing" && task.state.checkpoint;
        if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) || !["wait", "summarize", "publish", "send", "verify", "deliver"].includes(String(checkpoint.phase)) || ["summarize", "publish"].includes(String(checkpoint.phase)) && checkpoint.attempt !== report.attempt || checkpoint.phase === "send" && report.delivery !== "pending" || checkpoint.phase === "verify" && report.delivery !== "sending" || checkpoint.phase === "deliver" && (!report.multipart || report.delivery !== "sending")) throw invalid();
      } else if (report.delivery === "sending") { if (report.multipart) await settlePersonalReportDelivery(tx, report); else report.delivery = "effect_unknown"; }
    }
  }
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: PersonalReportTask.definition.name }, 64, cursor);
    for (const task of page.items) if (task.version === 2 && !taskIds.has(task.id) || ![1, 2].includes(task.version)) throw invalid();
    cursor = page.next;
  } while (cursor);
  do {
    const conversations = await tx.scanConversations({}, 256, cursor);
    for (const conversation of conversations.items) {
      let entries: Cursor | undefined;
      do {
        const page = await tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 256, entries);
        for (const entry of page.items) {
          if (entry.kind === "ruukoto.model-request") await reportRequestReference(tx, entry);
          if (entry.kind === AssistantEntry.kind) await reportResponseReference(tx, entry);
          if ([ReportAdmission.kind, ReportRequest.kind, PersonalReportCoverageEntry.kind, PersonalReportPublication.kind, ReportSupersession.kind, ReportSendCanceled.kind, ReportFailure.kind].includes(entry.kind) && (entry.conversationId !== ROOT_CONVERSATION_ID || !facts.has(entry.id))) throw invalid();
        }
        entries = page.next;
      } while (entries);
    }
    cursor = conversations.next;
  } while (cursor);
}
