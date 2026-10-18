import { LiveDoc, ROOT_CONVERSATION_ID, type ConversationId, type TaskId, type SubmissionId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { activePersonalWorkInspection, PersonalWorkDoc, type PersonalWorkInspectionSource } from "./personal-work.ts";
import { personalToolSource } from "./personal-work-tools.ts";
import { PersonalPermissionsDoc, permissionSnapshot, type PersonalTelegramSource } from "./personal-permissions.ts";
import { isPersonalImRequest, PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";
import { requirePersonalServiceSourceReady } from "./personal-service-operations.ts";
import type { PersonalWorkSource } from "./personal-delegation.ts";
import { personalLocalPermission } from "./personal-local-records.ts";

export type PersonalToolOrigin = { conversationId: ConversationId; generation: TaskId; inputs: SubmissionId[]; sources: SubmissionId[]; source: PersonalWorkSource; permission: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; work?: PersonalWorkInspectionSource };

export async function personalToolOrigin(tx: Tx, api: Pick<ToolExecutionApi, "conversationId" | "taskId">, sourceRequestId?: string, options?: { allowBlocked?: boolean }): Promise<PersonalToolOrigin> {
  const live = await tx.doc(LiveDoc, api.conversationId), tool = await tx.task(api.taskId), generation = tool?.owner && await tx.task(tool.owner);
  const input = tool?.input;
  if (tool?.kind !== "pi.tool" || tool.conversationId !== api.conversationId || tool.abortRequested || tool.state.status === "terminal" || !input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model" || generation?.kind !== "pi.generation" || generation.conversationId !== api.conversationId || generation.abortRequested || generation.state.status === "terminal" || live.run?.taskId !== generation.id || !live.tools?.some(slot => slot.taskId === api.taskId && slot.status === "running")) throw new PersonalError("tool_inactive", "工具不属于活动模型调用，未执行；请结束本轮并报告拥有者。");
  if (api.conversationId !== ROOT_CONVERSATION_ID) {
    const child = await activePersonalWorkInspection(tx, api.conversationId, live.run.inputs);
    const work = await tx.doc(PersonalWorkDoc, child.work.ref.requestId, null);
    return { conversationId: api.conversationId, generation: generation.id, inputs: live.run.inputs.slice(), sources: child.sources, source: { ...work.source! }, permission: { ...child.work.permission }, ...(child.work.telegram ? { telegram: { ...child.work.telegram } } : {}), work: child.work };
  }
  const requestId = await personalToolSource(tx, api, true, sourceRequestId);
  if (!options?.allowBlocked) await requirePersonalServiceSourceReady(tx, requestId!);
  const submission = (await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId!))!;
  const receipt = isPersonalImRequest(requestId!) ? (await tx.doc(PersonalTelegramReceiptDoc, requestId!, null)).receipt : undefined;
  const local = receipt ? undefined : await personalLocalPermission(tx, requestId!);
  const telegram = receipt && permissionSnapshot(receipt), permission = telegram ?? local ?? await tx.doc(PersonalPermissionsDoc);
  return { conversationId: api.conversationId, generation: generation.id, inputs: live.run.inputs.slice(), sources: [submission.id], source: { requestId: requestId!, submissionId: submission.id, entryId: submission.entry! }, permission: { mode: permission.mode, version: permission.version }, ...(telegram ? { telegram } : {}) };
}
