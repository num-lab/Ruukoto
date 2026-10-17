import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { defineDocFamily, defineEntry, defineExtension, ROOT_CONVERSATION_ID, type Cursor, type EntryId, type ModelRef, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { permissionSnapshot, PersonalPermissionsDoc, telegramSourceActive, type PersonalTelegramSource } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";
import { personalServiceSourceBlocker, requirePersonalServiceSourceReady } from "./personal-service-operations.ts";
import type { PersonalReportFacts } from "./personal-report.ts";
import { delegatePersonalWork, PersonalWorkDoc, PersonalWorkTask, personalWorkRef, personalWorkStatus, personalWorkSummary, requestPersonalWorkCancel, type PersonalWorkRef } from "./personal-work.ts";

export type PersonalDelegationRef = { entryId: EntryId };
export type PersonalWorkSource = { requestId: string; submissionId: SubmissionId; entryId: EntryId };
type Delegation = { ref: PersonalDelegationRef; source: PersonalWorkSource; permission: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; members: PersonalWorkRef[]; cancelRequested: boolean; report?: PersonalReportFacts };
export const PersonalDelegationDoc = defineDocFamily<{ delegation?: Delegation }, null>({ kind: "ruukoto.analysis-delegation", scope: "session", version: 1, family: true, initial: () => ({}) });
export const personalAnalysisDelegations = defineExtension({ name: "personal-analysis-delegations" });
export const PersonalAnalysisAdmission = defineEntry<{ work: PersonalWorkRef; delegation: PersonalDelegationRef; source: PersonalWorkSource; origin: PersonalWorkSource; permission: Delegation["permission"]; telegram?: PersonalTelegramSource; modelCall: TaskId }>("ruukoto.analysis-admission");

async function source(tx: Tx, requestId: string): Promise<PersonalWorkSource> {
  const input = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId);
  const entry = input?.entry && await tx.entry(input.entry);
  if (input?.type !== "input" || !entry || entry.kind !== "pi.user" || entry.conversationId !== ROOT_CONVERSATION_ID) throw new PersonalError("delegation_source_invalid", "委托说明缺少原拥有者输入，请停止操作并查询原委托。");
  return { requestId, submissionId: input.id, entryId: entry.id };
}

export async function personalDelegation(tx: Tx, ref: PersonalDelegationRef) {
  const value = (await tx.doc(PersonalDelegationDoc, String(ref.entryId), null)).delegation;
  if (!value || value.ref.entryId !== ref.entryId) throw new PersonalError("delegation_missing", "找不到原分析委托，请查询委托列表；没有改变工作。");
  return value;
}

async function originalEntry(tx: Tx, value: Delegation, requestId: string) {
  const receipt = requestId.startsWith("telegram:") ? (await tx.doc(PersonalTelegramReceiptDoc, requestId, null)).receipt : undefined;
  const telegram = receipt && permissionSnapshot(receipt);
  if (value.telegram ? !telegram || receipt?.submissionId !== (await source(tx, requestId)).submissionId || value.telegram.botId !== telegram.botId || value.telegram.ownerId !== telegram.ownerId || value.telegram.generation !== telegram.generation : requestId.startsWith("telegram:")) throw new PersonalError("delegation_original_entry", "此说明不属于委托的原入口，未改变工作；请从原入口查询。");
}

export async function requirePersonalDelegationInput(tx: Tx, ref: PersonalDelegationRef, requestId: string) {
  await source(tx, requestId);
  await originalEntry(tx, await personalDelegation(tx, ref), requestId);
}

export async function personalDelegationSources(tx: Tx, value: Delegation) {
  const sources = new Set([value.source.requestId]);
  if (value.report) sources.add(value.report.source.requestId);
  for (const ref of value.members) {
    const work = await tx.doc(PersonalWorkDoc, ref.requestId, null);
    if (!isDeepStrictEqual(work.ref, ref) || work.delegation?.entryId !== value.ref.entryId || !work.instructionSource) throw new PersonalError("delegation_member_invalid", "委托成员归属无法核实，已停止执行；请保留档案并检查原记录。");
    sources.add(work.instructionSource.requestId);
    if (work.source) sources.add(work.source.requestId);
    for (const note of work.notes ?? []) if (note.source.kind === "input") sources.add(note.source.requestId);
  }
  return sources;
}

export async function personalDelegationBlocker(tx: Tx, value: Delegation) {
  for (const requestId of await personalDelegationSources(tx, value)) { const blocker = await personalServiceSourceBlocker(tx, requestId); if (blocker) return blocker; }
}

async function sourcesReady(tx: Tx, value: Delegation) {
  if (await personalDelegationBlocker(tx, value)) throw new PersonalError("work_source_paused", "委托有尚未核实的服务效果或停止状态，已暂停分析和汇总；请查询原操作并核实，不要换委托重试。");
}

export async function requirePersonalDelegationOpen(tx: Tx, ref: PersonalDelegationRef) {
  if ((await personalDelegation(tx, ref)).report) throw new PersonalError("delegation_sealed", "委托已安排最终汇总，未接纳新分析或说明；请查询原委托报告，新工作由拥有者另行提交。");
}

export async function requirePersonalDelegationReady(tx: Tx, ref: PersonalDelegationRef) {
  const value = await personalDelegation(tx, ref);
  if (value.cancelRequested) throw new PersonalError("delegation_canceled", "整项分析委托已取消，请查询原结果并向拥有者报告；不能续派或追加。");
  if (value.telegram && !await telegramSourceActive(tx, value.telegram)) throw new PersonalError("delegation_source_inactive", "委托原入口已失效，请查询原委托；未继续执行或改发其他入口。");
  await sourcesReady(tx, value);
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-analysis-delegations.md
export async function delegatePersonalAnalysis(tx: Tx, model: ModelRef, input: Parameters<typeof delegatePersonalWork>[2], ref?: PersonalDelegationRef) {
  const instruction = await source(tx, input.sourceRequestId);
  const selected = ref ?? { entryId: instruction.entryId };
  const record = await tx.doc(PersonalDelegationDoc, String(selected.entryId), null);
  if (!record.delegation) {
    if (ref) throw new PersonalError("delegation_missing", "找不到原委托，请查询列表；不能用未知编号创建归属。");
    const receipt = input.sourceRequestId.startsWith("telegram:") ? (await tx.doc(PersonalTelegramReceiptDoc, input.sourceRequestId, null)).receipt : undefined;
    const telegram = receipt && permissionSnapshot(receipt);
    const permission = telegram ?? await tx.doc(PersonalPermissionsDoc);
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

export async function personalDelegationProgress(tx: Tx, ref: PersonalDelegationRef, offset = 0) {
  const value = await personalDelegation(tx, ref);
  let active = 0;
  let unverified = 0;
  const members = [];
  for (const [index, member] of value.members.entries()) {
    const status = await personalWorkStatus(tx, member);
    if (status.task.state.status !== "terminal") active++;
    else if (!status.stopVerified) unverified++;
    if (index >= offset && members.length < 8) members.push(await personalWorkSummary(tx, { ...member }));
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

export async function listPersonalDelegations(tx: Tx, offset = 0, telegram?: Pick<PersonalTelegramSource, "botId" | "ownerId" | "generation">) {
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
      if (telegram && (telegram.botId !== value.telegram?.botId || telegram.ownerId !== value.telegram.ownerId || telegram.generation !== value.telegram.generation)) continue;
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
    if (value.telegram) {
      const receipt = (await tx.doc(PersonalTelegramReceiptDoc, value.source.requestId, null)).receipt;
      if (!receipt || !isDeepStrictEqual(permissionSnapshot(receipt), value.telegram) || !isDeepStrictEqual(value.permission, { mode: value.telegram.mode, version: value.telegram.version })) throw new PersonalError("delegation_record_invalid", "委托原权限或入口不符，已停止恢复；请保留档案。");
    }
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
      if (!assistant || assistant.byTaskId !== call?.owner || admission.id <= assistant.id || assistant.id <= work.instructionSource.entryId || part?.type !== "toolCall" || part.name !== "background_work" || part.arguments.action !== "delegate" || part.arguments.content !== content || Object.keys(part.arguments).some(key => !["action", "content", "agent", "label", "delegation"].includes(key)) || createHash("sha256").update(JSON.stringify([part.arguments.content, value.source.requestId, part.arguments.agent ?? null, part.arguments.label ?? null])).digest("hex") !== work.fingerprint || (part.arguments.agent !== undefined && part.arguments.agent !== member.agentId) || (part.arguments.delegation === undefined ? value.source.entryId !== work.instructionSource.entryId : part.arguments.delegation !== value.ref.entryId)) throw new PersonalError("delegation_member_invalid", "委托成员缺少原模型委派说明，已停止恢复；请保留档案。");
    }
  }
  for (const key of workKeys) {
    const work = await tx.doc(PersonalWorkDoc, key, null);
    if ((work.instructionSource || work.delegationAdmission !== undefined) && !work.delegation) throw new PersonalError("delegation_member_invalid", "工作说明缺少所属委托，已停止恢复；请保留档案。");
    if (!work.delegation) continue;
    const value = await personalDelegation(tx, work.delegation);
    if (!keys.includes(String(work.delegation.entryId)) || !value.members.some(ref => isDeepStrictEqual(ref, work.ref))) throw new PersonalError("delegation_member_invalid", "工作缺少原委托成员关系，已停止恢复；请保留档案。");
  }
}
