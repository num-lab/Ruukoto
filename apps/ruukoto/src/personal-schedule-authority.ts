import { isDeepStrictEqual } from "node:util";
import { defineEntry, ROOT_CONVERSATION_ID, type EntryId, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { ToolCall } from "@earendil-works/pi-ai";
import { parseRule } from "@ruukoto/channels/scheduler/time.ts";
import { PersonalError } from "./personal-error.ts";
import { personalToolOrigin } from "./personal-tool-source.ts";
import { personalSource } from "./personal-source.ts";
import { PersonalPermissionsDoc, personalPermissionFor, telegramSelection, telegramSourceActive } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc, samePersonalEntry } from "./personal-telegram-records.ts";
import type { PersonalSchedule, PersonalScheduleActor, PersonalScheduleAuthority, PersonalScheduleCancellation } from "./personal-scheduler-records.ts";

type Authority = Omit<PersonalScheduleAuthority, "proof"> & { kind: PersonalScheduleActor["kind"]; requestId: string; menuRequestId?: string; modelCall?: number };
const ScheduleAuthorityAdmission = defineEntry<Authority>("ruukoto.schedule-authority");
const invalid = () => new PersonalError("schedule_authority_invalid", "定时计划的创建授权无法核实，未执行；请查询原计划与原入口。");
function normalizedArguments(definition: ToolRegistration | undefined, call: ToolCall): Record<string, JsonValue> {
  if (!definition) throw invalid();
  try { return validateToolArguments(definition, { ...call, arguments: copyJson(call.arguments) as Record<string, JsonValue> }) as Record<string, JsonValue>; } catch { throw invalid(); }
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-18-personal-durable-scheduled-work.md
export async function authorizePersonalSchedule(tx: Tx, actor: PersonalScheduleActor): Promise<PersonalScheduleAuthority> {
  let value: Authority;
  if (actor.kind === "model") {
    if (actor.conversationId !== ROOT_CONVERSATION_ID) throw invalid();
    const origin = await personalToolOrigin(tx, actor, actor.requestId);
    if ((await personalSource(tx, origin.source.requestId)).scheduled) throw invalid();
    value = { kind: actor.kind, requestId: actor.requestId, modelCall: actor.taskId, source: origin.source, permission: origin.permission, ...(origin.telegram ? { telegram: origin.telegram } : {}) };
  } else if (actor.kind === "im") {
    const input = actor.input, menu = await telegramSelection(tx, input);
    if (!input.direct || !menu || menu.requestId !== actor.menuRequestId || !await telegramSourceActive(tx, input)) throw invalid();
    const permission = await personalPermissionFor(tx, input);
    value = { kind: actor.kind, requestId: input.requestId, menuRequestId: menu.requestId, permission: { mode: permission.mode, version: permission.version }, telegram: { ...(input.platform ? { platform: input.platform } : {}), botId: input.botId, ownerId: input.ownerId, generation: input.generation, mode: permission.mode, version: permission.version } };
  } else {
    const permission = await tx.doc(PersonalPermissionsDoc);
    value = { kind: actor.kind, requestId: actor.requestId, permission: { mode: permission.mode, version: permission.version } };
  }
  const proof = (await tx.appendEntry(ScheduleAuthorityAdmission, ROOT_CONVERSATION_ID, { data: value })).id;
  return { permission: { ...value.permission }, ...(value.telegram ? { telegram: { ...value.telegram } } : {}), ...(value.source ? { source: { ...value.source } } : {}), proof: { authority: proof } };
}

export async function verifyPersonalScheduleCreator(tx: Tx, plan: PersonalSchedule, createTool?: ToolRegistration) {
  const { actor, authority } = plan.createdBy, proof = authority.proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof) || typeof proof.authority !== "number") throw invalid();
  const admission = await tx.entry(ScheduleAuthorityAdmission, proof.authority as EntryId), value = admission?.data;
  if (!admission || admission.conversationId !== ROOT_CONVERSATION_ID || admission.id >= plan.admission || !value || value.kind !== actor.kind || !isDeepStrictEqual(value.permission, plan.permission) || !isDeepStrictEqual(value.telegram, plan.telegram) || !isDeepStrictEqual(value.source, authority.source)) throw invalid();
  if (actor.kind === "local") { if (value.requestId !== actor.requestId || actor.requestId !== plan.requestId || value.telegram || value.source || value.modelCall !== undefined || value.menuRequestId !== undefined) throw invalid(); return; }
  if (actor.kind === "model") {
    const origin = await personalSource(tx, actor.requestId), call = await tx.task(actor.taskId), input = call?.input;
    const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
    const part = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.id === (input && typeof input === "object" && !Array.isArray(input) ? input.callId : undefined));
    if (origin.scheduled || actor.conversationId !== ROOT_CONVERSATION_ID || value.requestId !== actor.requestId || value.modelCall !== actor.taskId || !isDeepStrictEqual(origin.source, value.source) || call?.kind !== "pi.tool" || call.conversationId !== ROOT_CONVERSATION_ID || assistant?.byTaskId !== call.owner || assistant!.id <= origin.entry.id || assistant!.id >= admission.id || part?.type !== "toolCall" || part.name !== "schedule_create") throw invalid();
    const args = normalizedArguments(createTool, part);
    if (args.label !== plan.label || args.instruction !== plan.instruction || !isDeepStrictEqual(parseRule(args.rule), plan.rule)) throw invalid();
    return;
  }
  const input = (await tx.doc(PersonalTelegramReceiptDoc, actor.input.requestId, null)).receipt, menu = input && await telegramSelection(tx, input);
  if (!input?.direct || !input.control || input.content !== "确认创建计划" || !samePersonalEntry(input, plan.telegram) || !isDeepStrictEqual({ requestId: input.requestId, menuRequestId: menu?.requestId }, { requestId: value.requestId, menuRequestId: value.menuRequestId }) || menu?.requestId !== actor.menuRequestId || menu.selection?.kind !== "schedule-draft" || menu.selection.draft.step !== "confirm" || menu.selection.draft.requestId !== plan.requestId || menu.selection.draft.label !== plan.label || menu.selection.draft.instruction !== plan.instruction || !isDeepStrictEqual(parseRule(menu.selection.draft), plan.rule) || input.scheduleCreate?.id !== plan.id || input.scheduleCreate.requestId !== plan.requestId) throw invalid();
}

export async function verifyPersonalScheduleCancellation(tx: Tx, plan: PersonalSchedule, cancellation: PersonalScheduleCancellation, cancelTool?: ToolRegistration) {
  const { actor, authority } = cancellation, proof = authority.proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof) || typeof proof.authority !== "number" || !plan.cancelEntry) throw invalid();
  const admission = await tx.entry(ScheduleAuthorityAdmission, proof.authority as EntryId), value = admission?.data;
  if (!value || !admission || admission.conversationId !== ROOT_CONVERSATION_ID || admission.id <= plan.admission || admission.id >= plan.cancelEntry || value.kind !== actor.kind || !isDeepStrictEqual(value.permission, authority.permission) || !isDeepStrictEqual(value.telegram, authority.telegram) || !isDeepStrictEqual(value.source, authority.source)) throw invalid();
  if (actor.kind === "local") { if (value.requestId !== actor.requestId || value.telegram || value.source) throw invalid(); return; }
  if (actor.kind === "model") {
    const source = await personalSource(tx, actor.requestId), call = await tx.task(actor.taskId), input = call?.input;
    const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
    const part = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.id === (input && typeof input === "object" && !Array.isArray(input) ? input.callId : undefined));
    if (source.scheduled || actor.conversationId !== ROOT_CONVERSATION_ID || value.requestId !== actor.requestId || value.modelCall !== actor.taskId || !isDeepStrictEqual(value.source, source.source) || call?.kind !== "pi.tool" || call.conversationId !== ROOT_CONVERSATION_ID || assistant?.byTaskId !== call.owner || assistant!.id <= source.entry.id || assistant!.id >= admission.id || part?.type !== "toolCall" || part.name !== "schedule_cancel" || normalizedArguments(cancelTool, part).plan !== plan.id) throw invalid();
    return;
  }
  const input = (await tx.doc(PersonalTelegramReceiptDoc, actor.input.requestId, null)).receipt, menu = input && await telegramSelection(tx, input);
  if (!input?.direct || !input.control || input.content !== "取消这项计划" || !samePersonalEntry(input, plan.telegram) || !samePersonalEntry(input, value.telegram) || value.requestId !== input.requestId || value.menuRequestId !== menu?.requestId || menu?.requestId !== actor.menuRequestId || menu.selection?.kind !== "schedule" || menu.selection.id !== plan.id || input.scheduleCancel?.id !== plan.id) throw invalid();
}
