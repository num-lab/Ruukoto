import { personalSource } from "./personal-source.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { defineDocFamily, defineEntry, defineExtension, ROOT_CONVERSATION_ID, type Cursor, type EntryId, type ModelRef, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { telegramSourceActive, type PersonalTelegramSource } from "./personal-permissions.ts";
import { samePersonalEntry, type PersonalEntryIdentity } from "./personal-telegram-records.ts";
import { personalServiceSourceBlocker, requirePersonalServiceSourceReady } from "./personal-service-operations.ts";
import { refreshPersonalReportState, type PersonalReportFacts } from "./personal-report.ts";
import { delegatePersonalWork, PersonalWorkDoc, PersonalWorkTask, PersonalWorkContinuation, personalWorkNoteSource, requirePersonalWorkContinuation, personalWorkRef, personalWorkStatus, personalWorkSummary, requestPersonalWorkCancel, type PersonalWorkRef } from "./personal-work.ts";
import type { ToolQueryIdentity } from "./personal-tools.ts";

export type PersonalDelegationRef = { entryId: EntryId };
export type PersonalWorkSource = { requestId: string; submissionId: SubmissionId; entryId: EntryId };
type Delegation = { ref: PersonalDelegationRef; source: PersonalWorkSource; permission: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; members: PersonalWorkRef[]; cancelRequested: boolean; report?: PersonalReportFacts; reports?: PersonalReportFacts[] };
export const PersonalDelegationDoc = defineDocFamily<{ delegation?: Delegation }, null>({ kind: "ruukoto.analysis-delegation", scope: "session", version: 1, family: true, initial: () => ({}) });
export const personalAnalysisDelegations = defineExtension({ name: "personal-analysis-delegations" });
export const PersonalAnalysisAdmission = defineEntry<{ work: PersonalWorkRef; delegation: PersonalDelegationRef; source: PersonalWorkSource; origin: PersonalWorkSource; permission: Delegation["permission"]; telegram?: PersonalTelegramSource; modelCall: TaskId }>("ruukoto.analysis-admission");

async function source(tx: Tx, requestId: string): Promise<PersonalWorkSource> {
  const value = await personalSource(tx, requestId, { invalidCode: "delegation_source_invalid" });
  if (value.scheduled) throw new PersonalError("delegation_source_invalid", "独立定时工作不能管理主聊天委托。");
  return { ...value.source };
}

export async function personalDelegation(tx: Tx, ref: PersonalDelegationRef) {
  const value = (await tx.doc(PersonalDelegationDoc, String(ref.entryId), null)).delegation;
  if (!value || value.ref.entryId !== ref.entryId) throw new PersonalError("delegation_missing", "找不到原分析委托，请查询委托列表；没有改变工作。");
  return value;
}

async function originalEntry(tx: Tx, value: Delegation, requestId: string) {
  const source = await personalSource(tx, requestId);
  if (source.scheduled || (value.telegram ? !samePersonalEntry(value.telegram, source.telegram) : !!source.telegram)) throw new PersonalError("delegation_original_entry", "此说明不属于委托原入口，请从原入口查询。");
}

export async function requirePersonalDelegationInput(tx: Tx, ref: PersonalDelegationRef, requestId: string) {
  await source(tx, requestId);
  await originalEntry(tx, await personalDelegation(tx, ref), requestId);
}

export async function personalDelegationSources(tx: Tx, value: Delegation) {
  const sources = new Set([value.source.requestId]);
  for (const report of [...(value.reports ?? []), ...(value.report ? [value.report] : [])]) sources.add(report.source.requestId);
  for (const ref of value.members) {
    const work = await tx.doc(PersonalWorkDoc, ref.requestId, null);
    if (!isDeepStrictEqual(work.ref, ref) || work.delegation?.entryId !== value.ref.entryId || !work.instructionSource) throw new PersonalError("delegation_member_invalid", "委托成员归属无法核实，已停止执行；请保留档案并检查原记录。");
    sources.add(work.instructionSource.requestId);
    if (work.source) sources.add(work.source.requestId);
    for (const note of work.notes ?? []) if (note.source.kind === "input") sources.add(note.source.requestId);
  }
  return sources;
}

export async function personalDelegationBlocker(tx: Tx, value: Delegation, forReport = false, excludeOperation?: TaskId) {
  for (const requestId of await personalDelegationSources(tx, value)) { const blocker = await personalServiceSourceBlocker(tx, requestId, forReport, excludeOperation); if (blocker) return blocker; }
}

async function sourcesReady(tx: Tx, value: Delegation, forReport = false, excludeOperation?: TaskId) {
  if (await personalDelegationBlocker(tx, value, forReport, excludeOperation)) throw new PersonalError("work_source_paused", "委托有尚未核实的服务效果或停止状态，已暂停分析和汇总；请查询原操作并核实，不要换委托重试。");
}

export async function requirePersonalDelegationOpen(tx: Tx, ref: PersonalDelegationRef) {
  const report = (await personalDelegation(tx, ref)).report;
  if (report && report.version !== 2) throw new PersonalError("delegation_sealed", "旧版本委托已安排最终汇总，未接纳新分析或说明；请查询原委托报告，新工作由拥有者另行提交。");
  await refreshPersonalReportState(tx, ref);
}

export async function requirePersonalDelegationActive(tx: Tx, ref: PersonalDelegationRef) {
  const value = await personalDelegation(tx, ref);
  if (value.cancelRequested) throw new PersonalError("delegation_canceled", "原委托已取消，不能续派或追加。本轮拥有者明确提出新的独立工作、原身份空闲且停止已核实时，主 Agent 可保留 agent、省略 delegation 建立新委托；否则查询原结果并结束本轮。不能为原未知效果换委托重试。");
  if (value.telegram && !await telegramSourceActive(tx, value.telegram)) throw new PersonalError("delegation_source_inactive", "委托原入口已失效，请查询原委托；未继续执行或改发其他入口。");
  return value;
}

export async function requirePersonalDelegationReady(tx: Tx, ref: PersonalDelegationRef, forReport = false, excludeOperation?: TaskId) {
  await sourcesReady(tx, await requirePersonalDelegationActive(tx, ref), forReport, excludeOperation);
}

// Note: See .agents/notes/implemented/architecture/2026-10-17-personal-analysis-delegations.md
export async function delegatePersonalAnalysis(tx: Tx, model: ModelRef, input: Parameters<typeof delegatePersonalWork>[2], ref?: PersonalDelegationRef) {
  const instruction = await source(tx, input.sourceRequestId);
  const selected = ref ?? { entryId: instruction.entryId };
  const record = await tx.doc(PersonalDelegationDoc, String(selected.entryId), null);
  if (!record.delegation) {
    if (ref) throw new PersonalError("delegation_missing", "找不到原委托，请查询列表；不能用未知编号创建归属。");
    const { telegram, permission } = await personalSource(tx, input.sourceRequestId, { active: true });
    record.delegation = { ref: selected, source: instruction, permission: { mode: permission.mode, version: permission.version }, ...(telegram ? { telegram } : {}), members: [], cancelRequested: false };
  }
  const value = record.delegation;
  const existing = await tx.doc(PersonalWorkDoc, input.requestId, null);
  if (existing.ref) {
    if (!isDeepStrictEqual(existing.instructionSource, instruction) || existing.delegation?.entryId !== selected.entryId || !value.members.some(ref => isDeepStrictEqual(ref, existing.ref))) throw new PersonalError("work_request_conflict", "原工作请求的说明或委托归属不同，请查询原记录，不要换键重试。");
    return { ref: await delegatePersonalWork(tx, model, { ...input, sourceRequestId: value.source.requestId }), delegation: selected };
  }
  await originalEntry(tx, value, input.sourceRequestId);
  await requirePersonalDelegationOpen(tx, selected);
  await requirePersonalDelegationReady(tx, selected);
  await requirePersonalServiceSourceReady(tx, instruction.requestId);
  const member = await delegatePersonalWork(tx, model, { ...input, sourceRequestId: value.source.requestId });
  const work = await tx.doc(PersonalWorkDoc, member.requestId, null);
  work.permission = { ...value.permission };
  work.delegation = selected;
  work.instructionSource = instruction;
  value.members.push(member);
  return { ref: member, delegation: selected };
}

// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-work-amendments.md
export async function continuePersonalAnalysis(tx: Tx, model: ModelRef, predecessor: PersonalWorkRef, input: { content: string; requestId: string; sourceRequestId: string; modelCall: TaskId }) {
  const origin = await tx.doc(PersonalWorkDoc, predecessor.requestId, null);
  if (!isDeepStrictEqual(origin.ref, predecessor) || !origin.delegation) throw new PersonalError("work_continuation_unavailable", "此工作没有可续接的原委托，未接纳新操作；请查询原结果，拥有者明确交办独立新工作时再用 delegate 登记。");
  const instruction = await personalWorkNoteSource(tx, input.sourceRequestId, input.modelCall);
  if (instruction.kind !== "input") throw new PersonalError("work_source_invalid", "后续工作需要本轮拥有者输入，未接纳操作。");
  await requirePersonalDelegationInput(tx, origin.delegation, input.sourceRequestId);
  const existing = await tx.doc(PersonalWorkDoc, input.requestId, null);
  if (!existing.ref) await requirePersonalWorkContinuation(tx, predecessor);
  else if (!isDeepStrictEqual(existing.continuation?.predecessor, predecessor) || existing.modelCall !== input.modelCall) throw new PersonalError("work_request_conflict", "后续工作的原请求或前项不同，未重做；请查询原记录。");
  const continued = await delegatePersonalAnalysis(tx, model, { content: input.content, requestId: input.requestId, sourceRequestId: input.sourceRequestId, agentId: predecessor.agentId, ...(origin.appData === undefined ? {} : { appData: origin.appData }) }, origin.delegation);
  const work = await tx.doc(PersonalWorkDoc, continued.ref.requestId, null);
  if (!work.continuation) {
    const admission = await tx.appendEntry(PersonalWorkContinuation, ROOT_CONVERSATION_ID, { data: { version: 1, predecessor: { ...predecessor }, work: { ...continued.ref }, source: { requestId: instruction.requestId, submissionId: instruction.submissionId, entryId: instruction.entryId }, modelCall: input.modelCall, content: input.content } });
    work.continuation = { version: 1, predecessor: { ...predecessor }, admission: admission.id };
  }
  return continued;
}

export async function cancelPersonalDelegation(tx: Tx, ref: PersonalDelegationRef, sourceRequestId?: string) {
  const value = await personalDelegation(tx, ref);
  if (sourceRequestId) await originalEntry(tx, value, sourceRequestId);
  for (const member of value.members) {
    if (!isDeepStrictEqual(await personalWorkRef(tx, member.taskId), member)) throw new PersonalError("delegation_member_invalid", "委托成员无法核实，未请求取消；请检查原记录。");
    await personalWorkStatus(tx, member);
  }
  value.cancelRequested = true;
  for (const member of value.members) await requestPersonalWorkCancel(tx, member);
}

export async function personalDelegationProgress(tx: Tx, ref: PersonalDelegationRef, offset = 0, identity?: ToolQueryIdentity) {
  const value = await personalDelegation(tx, ref);
  let active = 0;
  let unverified = 0;
  const members = [];
  for (const [index, member] of value.members.entries()) {
    const status = await personalWorkStatus(tx, member);
    if (status.task.state.status !== "terminal") active++;
    else if (!status.stopVerified) unverified++;
    if (index >= offset && members.length < 8) members.push(await personalWorkSummary(tx, { ...member }, identity));
  }
  let paused = false;
  try { await sourcesReady(tx, value); } catch (error) {
    if (!(error instanceof PersonalError) || error.code !== "work_source_paused") throw error;
    paused = true;
  }
  const entry = await tx.entry(value.source.entryId);
  const message = entry?.model?.[0];
  if (message?.role !== "user") throw new PersonalError("delegation_source_invalid", "委托原说明缺失，请保留档案并检查记录。");
  const content = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("");
  const reportTask = value.report && await tx.task(value.report.taskId);
  if (value.report && !reportTask) throw new PersonalError("report_missing", "委托报告执行缺失，请保留档案。");
  const report = value.report && reportTask ? { delivery: value.report.delivery, state: reportTask.state.status === "terminal" ? reportTask.state.outcome.status : reportTask.state.status } : undefined;
  return { ref: { ...value.ref }, content: content.slice(0, 160), cancelRequested: value.cancelRequested, total: value.members.length, active, unverified, paused, ...(report ? { report } : {}), state: unverified ? "stop_unverified" : value.cancelRequested ? active ? "canceling" : "canceled" : paused ? "paused" : report ? reportTask!.state.status === "terminal" ? reportTask!.state.outcome.status === "completed" ? "reported" : "report_failed" : "reporting" : active ? "active" : "idle", members, ...(offset + 8 < value.members.length ? { nextOffset: offset + 8 } : {}) };
}

export async function listPersonalDelegations(tx: Tx, offset = 0, telegram?: PersonalEntryIdentity) {
  const seen = new Set<EntryId>();
  const items = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: PersonalWorkTask.definition.name, order: "descending" }, 64, cursor);
    for (const task of page.items) {
      const ref = await personalWorkRef(tx, task.id);
      const group = (await tx.doc(PersonalWorkDoc, ref.requestId, null)).delegation;
      if (!group || seen.has(group.entryId)) continue;
      seen.add(group.entryId);
      const value = await personalDelegation(tx, group);
      if (telegram && !samePersonalEntry(telegram, value.telegram)) continue;
      if (offset-- > 0) continue;
      if (items.length === 8) return { items, more: true };
      const progress = await personalDelegationProgress(tx, group);
      const { members: _members, nextOffset: _next, ...summary } = progress;
      items.push(summary);
    }
    cursor = page.next;
  } while (cursor);
  return { items, more: false };
}

export async function verifyPersonalDelegations(tx: Tx, keys: string[], workKeys: string[], enabled: boolean) {
  for (const key of keys) {
    const value = (await tx.doc(PersonalDelegationDoc, key, null)).delegation;
    if (!enabled || !value || String(value.ref?.entryId) !== key || !Array.isArray(value.members) || !value.members.length || typeof value.cancelRequested !== "boolean" || new Set(value.members.map(ref => ref.taskId)).size !== value.members.length || !isDeepStrictEqual(await source(tx, value.source.requestId), value.source) || value.ref.entryId !== value.source.entryId || !["auto-review", "confirm", "full_access"].includes(value.permission?.mode) || !Number.isSafeInteger(value.permission?.version) || value.permission.version < 1) throw new PersonalError("delegation_record_invalid", "分析委托版本、来源或成员缺失，已停止恢复；请保留档案。");
    await originalEntry(tx, value, value.source.requestId);
    const origin = await personalSource(tx, value.source.requestId);
    if (!isDeepStrictEqual(origin.permission, value.permission) || !isDeepStrictEqual(origin.telegram, value.telegram)) throw new PersonalError("delegation_record_invalid", "委托原权限或入口不符，已停止恢复；请保留档案。");
    for (const member of value.members) {
      const work = await tx.doc(PersonalWorkDoc, member.requestId, null);
      if (!workKeys.includes(member.requestId) || !isDeepStrictEqual(await personalWorkRef(tx, member.taskId), member) || work.delegation?.entryId !== value.ref.entryId || !isDeepStrictEqual(work.source, value.source) || !isDeepStrictEqual(work.permission, value.permission) || !isDeepStrictEqual(work.telegram, value.telegram) || !work.instructionSource || !isDeepStrictEqual(await source(tx, work.instructionSource.requestId), work.instructionSource)) throw new PersonalError("delegation_member_invalid", "委托成员与原工作来源不符，已停止恢复；请保留档案。");
      await originalEntry(tx, value, work.instructionSource.requestId);
      const admission = work.delegationAdmission && await tx.entry(PersonalAnalysisAdmission, work.delegationAdmission);
      if (!admission || admission.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(admission.data, { work: member, delegation: value.ref, source: work.instructionSource, origin: work.source, permission: work.permission, ...(work.telegram ? { telegram: work.telegram } : {}), modelCall: work.modelCall })) throw new PersonalError("delegation_member_invalid", "委托成员的原说明接纳证据不符，已停止恢复；请保留档案。");
      if (value.cancelRequested && !work.cancelRequested && (await tx.task(member.taskId))?.state.status !== "terminal") throw new PersonalError("delegation_member_invalid", "委托取消与成员记录不符，已停止恢复；请保留档案。");
      const call = work.modelCall && await tx.task(work.modelCall);
      const input = call?.input;
      const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
      const part = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.id === (input && typeof input === "object" && !Array.isArray(input) ? input.callId : undefined));
      const task = await tx.task(member.taskId);
      const content = task?.input && typeof task.input === "object" && !Array.isArray(task.input) ? task.input.content : undefined;
      if (!assistant || call?.kind !== "pi.tool" || call.conversationId !== ROOT_CONVERSATION_ID || assistant.byTaskId !== call.owner || admission.id <= assistant.id || assistant.id <= work.instructionSource.entryId || part?.type !== "toolCall" || part.name !== "background_work" || part.arguments.content !== content) throw new PersonalError("delegation_member_invalid", "委托成员缺少原模型委派说明，已停止恢复；请保留档案。");
      if (work.continuation) {
        const previous = work.continuation.predecessor;
        const predecessor = await tx.doc(PersonalWorkDoc, previous.requestId, null);
        const status = await personalWorkStatus(tx, previous);
        const continuation = await tx.entry(PersonalWorkContinuation, work.continuation.admission);
        const expected = { version: 1, predecessor: previous, work: member, source: work.instructionSource, modelCall: work.modelCall, content };
        if (work.continuation.version !== 1 || !task || task.version < 3 || task.version > PersonalWorkTask.definition.version || !continuation || continuation.conversationId !== ROOT_CONVERSATION_ID || continuation.id <= assistant.id || continuation.id >= admission.id || !isDeepStrictEqual(continuation.data, expected) || !isDeepStrictEqual(predecessor.ref, previous) || previous.agentId !== member.agentId || previous.taskId >= member.taskId || predecessor.delegation?.entryId !== value.ref.entryId || !value.members.some(ref => isDeepStrictEqual(ref, previous)) || status.task.state.status !== "terminal" || status.task.state.outcome.status !== "completed" || !status.stopVerified || status.cancelRequested || part.arguments.action !== "append" || !isDeepStrictEqual(part.arguments, { action: "append", work: previous.taskId, content }) || work.appData !== predecessor.appData || createHash("sha256").update(JSON.stringify([content, value.source.requestId, previous.agentId, null, ...(work.appData === undefined ? [] : [work.appData])])).digest("hex") !== work.fingerprint) throw new PersonalError("delegation_member_invalid", "后续工作与已完成的原任务或拥有者追加来源不符，已停止恢复；请保留档案。");
      } else if (part.arguments.action !== "delegate" || part.arguments.appData !== work.appData || Object.keys(part.arguments).some(key => !["action", "content", "agent", "label", "delegation", "appData"].includes(key)) || createHash("sha256").update(JSON.stringify([part.arguments.content, value.source.requestId, part.arguments.agent ?? null, part.arguments.label ?? null, ...(part.arguments.appData === undefined ? [] : [part.arguments.appData])])).digest("hex") !== work.fingerprint || (part.arguments.agent !== undefined && part.arguments.agent !== member.agentId) || (part.arguments.delegation === undefined ? value.source.entryId !== work.instructionSource.entryId : part.arguments.delegation !== value.ref.entryId)) throw new PersonalError("delegation_member_invalid", "委托成员缺少原模型委派说明，已停止恢复；请保留档案。");
    }
  }
  for (const key of workKeys) {
    const work = await tx.doc(PersonalWorkDoc, key, null);
    if ((work.instructionSource || work.delegationAdmission !== undefined || work.continuation) && !work.delegation) throw new PersonalError("delegation_member_invalid", "工作说明缺少所属委托，已停止恢复；请保留档案。");
    if (!work.delegation) continue;
    const value = await personalDelegation(tx, work.delegation);
    if (!keys.includes(String(work.delegation.entryId)) || !value.members.some(ref => isDeepStrictEqual(ref, work.ref))) throw new PersonalError("delegation_member_invalid", "工作缺少原委托成员关系，已停止恢复；请保留档案。");
  }
  let cursor: Cursor | undefined;
  const continuations = new Set<TaskId>();
  if (!await tx.conversation(ROOT_CONVERSATION_ID)) return;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 256, cursor);
    for (const entry of page.items) {
      if (!PersonalWorkContinuation.is(entry)) continue;
      if (!entry.data || typeof entry.data !== "object" || !entry.data.work || typeof entry.data.work !== "object" || typeof entry.data.work.requestId !== "string" || !Number.isSafeInteger(entry.data.work.taskId)) throw new PersonalError("delegation_member_invalid", "后续工作的原接纳记录损坏，已停止恢复；请保留档案。");
      const work = await tx.doc(PersonalWorkDoc, entry.data.work.requestId, null);
      if (!enabled || continuations.has(entry.data.work.taskId) || !workKeys.includes(entry.data.work.requestId) || !isDeepStrictEqual(work.ref, entry.data.work) || work.continuation?.admission !== entry.id) throw new PersonalError("delegation_member_invalid", "后续工作的原接纳记录缺少唯一工作关系，已停止恢复；请保留档案。");
      continuations.add(entry.data.work.taskId);
    }
    cursor = page.next;
  } while (cursor);
}
