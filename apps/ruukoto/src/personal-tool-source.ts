import { LiveDoc, ROOT_CONVERSATION_ID, type ConversationId, type TaskId, type SubmissionId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { activePersonalWorkInspection, PersonalWorkDoc, type PersonalWorkInspectionSource } from "./personal-work.ts";
import { personalToolSource } from "./personal-work-tools.ts";
import { type PersonalTelegramSource } from "./personal-permissions.ts";
import { requirePersonalServiceSourceReady } from "./personal-service-operations.ts";
import type { PersonalWorkSource } from "./personal-delegation.ts";
import { personalSource } from "./personal-source.ts";
import { scheduledConversation } from "./personal-scheduler-records.ts";

export type PersonalToolOrigin = { conversationId: ConversationId; generation: TaskId; inputs: SubmissionId[]; sources: SubmissionId[]; source: PersonalWorkSource; permission: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; work?: PersonalWorkInspectionSource };

export async function personalToolOrigin(tx: Tx, api: Pick<ToolExecutionApi, "conversationId" | "taskId">, sourceRequestId?: string, options?: { allowBlocked?: boolean }): Promise<PersonalToolOrigin> {
  const live = await tx.doc(LiveDoc, api.conversationId), tool = await tx.task(api.taskId), generation = tool?.owner && await tx.task(tool.owner);
  const input = tool?.input;
  if (tool?.kind !== "pi.tool" || tool.conversationId !== api.conversationId || tool.abortRequested || tool.state.status === "terminal" || !input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model" || generation?.kind !== "pi.generation" || generation.conversationId !== api.conversationId || generation.abortRequested || generation.state.status === "terminal" || live.run?.taskId !== generation.id || !live.tools?.some(slot => slot.taskId === api.taskId && slot.status === "running")) throw new PersonalError("tool_inactive", "工具不属于活动模型调用，未执行；请结束本轮并报告拥有者。");
  const scheduled = await scheduledConversation(tx, api.conversationId);
  if (scheduled) {
    if (scheduled.run.sealed) throw new PersonalError("tool_source_sealed", "本次定时运行已封组收尾，未执行新操作；请只查询已有结果并完成汇总。");
    const value = await personalSource(tx, scheduled.run.requestId, { active: true });
    if (!value.scheduled || value.submission.conversationId !== api.conversationId || live.run.inputs.length !== 1 || live.run.inputs[0] !== value.submission.id || sourceRequestId !== undefined && sourceRequestId !== value.source.requestId) throw new PersonalError("tool_source_invalid", "工具不属于本次定时运行的原输入，未执行；请结束本轮并报告拥有者。");
    if (!options?.allowBlocked) await requirePersonalServiceSourceReady(tx, value.source.requestId);
    return { conversationId: api.conversationId, generation: generation.id, inputs: live.run.inputs.slice(), sources: [value.submission.id], source: { ...value.source }, permission: { ...value.permission }, ...(value.telegram ? { telegram: { ...value.telegram } } : {}) };
  }
  if (api.conversationId !== ROOT_CONVERSATION_ID) {
    const child = await activePersonalWorkInspection(tx, api.conversationId, live.run.inputs);
    const work = await tx.doc(PersonalWorkDoc, child.work.ref.requestId, null);
    return { conversationId: api.conversationId, generation: generation.id, inputs: live.run.inputs.slice(), sources: child.sources, source: { ...work.source! }, permission: { ...child.work.permission }, ...(child.work.telegram ? { telegram: { ...child.work.telegram } } : {}), work: child.work };
  }
  const requestId = await personalToolSource(tx, api, true, sourceRequestId);
  if (!options?.allowBlocked) await requirePersonalServiceSourceReady(tx, requestId!);
  const value = await personalSource(tx, requestId!, { active: true });
  return { conversationId: api.conversationId, generation: generation.id, inputs: live.run.inputs.slice(), sources: [value.submission.id], source: { ...value.source }, permission: { ...value.permission }, ...(value.telegram ? { telegram: { ...value.telegram } } : {}) };
}
