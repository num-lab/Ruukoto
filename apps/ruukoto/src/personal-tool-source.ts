import { isDeepStrictEqual } from "node:util";
import { LiveDoc, ROOT_CONVERSATION_ID, type ConversationId, type EntryId, type TaskId, type SubmissionId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { activePersonalWorkInspection, personalWorkInspectionSource, personalWorkInstructionSources, personalWorkInstructionContents, personalWorkInstructionText, verifyPersonalWorkInstructions, PersonalAgentsDoc, PersonalWorkDoc, type PersonalToolInstructions, type PersonalWorkInspectionSource, type PersonalWorkInstructionSnapshot } from "./personal-work.ts";
import { personalToolSource } from "./personal-work-tools.ts";
import { type PersonalTelegramSource } from "./personal-permissions.ts";
import { requirePersonalServiceSourceReady } from "./personal-service-operations.ts";
import type { PersonalWorkSource } from "./personal-delegation.ts";
import { personalSource } from "./personal-source.ts";
import { scheduledConversation } from "./personal-scheduler-records.ts";
import { personalModelRequestEntry } from "./personal-model.ts";
import { requirePersonalQuestionBoundary } from "./personal-questions.ts";

export type PersonalToolOrigin = { conversationId: ConversationId; generation: TaskId; inputs: SubmissionId[]; sources: SubmissionId[]; source: PersonalWorkSource; permission: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; work?: PersonalWorkInspectionSource };

export function requirePersonalChildBusinessTool(api: Pick<ToolExecutionApi, "conversationId">, name: string) {
  if (api.conversationId === ROOT_CONVERSATION_ID) throw new PersonalError("personal_tool_main_ineligible", `${name} 由后台子工作执行；请用 background_work 委派完整要求，再查询原工作进展。`);
}

// Admission and consumption use the request's saved requirements, including delayed model responses.
export async function requirePersonalToolInstructionsFresh(tx: Tx, snapshot: PersonalWorkInstructionSnapshot) {
  const work = await tx.doc(PersonalWorkDoc, snapshot.work.requestId, null);
  for (const note of work.notes ?? []) if (note.admission !== undefined && !snapshot.notes.some(captured => captured.requestId === note.requestId && captured.admission === note.admission)) throw new PersonalError("tool_requirements_changed", "工作要求已更新，本次旧操作未执行。请等宿主在下一模型边界提供已保存的说明，再按更新后的要求准备新操作；不要重试旧参数。");
}

export async function capturePersonalToolInstructions(tx: Tx, api: Pick<ToolExecutionApi, "conversationId" | "taskId">): Promise<PersonalToolInstructions | undefined> {
  const ref = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === api.conversationId)?.work;
  if (!ref) return undefined;
  const live = await tx.doc(LiveDoc, api.conversationId);
  if (!live.run) throw new PersonalError("work_instruction_invalid", "原工作没有活动模型请求，未执行；请查询原工作。");
  const tool = await tx.task(api.taskId);
  if (tool?.owner !== undefined) await requirePersonalQuestionBoundary(tx, api.conversationId, tool.owner, api.taskId);
  await personalWorkInspectionSource(tx, ref, live.run.inputs);
  const request = await personalModelRequestEntry(tx, api.taskId), snapshot = request?.references.instructions;
  if (!request || !snapshot) throw new PersonalError("work_instruction_invalid", "原工作要求的模型请求证据无法核实，未执行；请结束本轮并报告拥有者检查原工作记录。");
  await verifyPersonalWorkInstructions(tx, api.conversationId, snapshot, { work: ref });
  await requirePersonalToolInstructionsFresh(tx, snapshot);
  return { version: 1, requestEntry: request.entry, snapshot };
}

export async function verifyPersonalToolInstructions(tx: Tx, instructions: PersonalToolInstructions | undefined, origin: Pick<PersonalToolOrigin, "conversationId" | "generation" | "inputs" | "sources" | "work">, admission: EntryId, toolId?: TaskId) {
  if (!instructions) return;
  const invalid = () => new PersonalError("work_instruction_invalid", "原工作要求的模型请求证据无法核实，已停止恢复；请保留档案并检查原模型请求。");
  const request = await tx.entry(instructions.requestEntry), data = request?.data as { references?: { generation?: unknown; instructions?: unknown }; input?: { messages?: { role?: string; sections?: Record<string, unknown> }[] } } | undefined;
  if (instructions.version !== 1 || !origin.work || !request || request.kind !== "ruukoto.model-request" || request.conversationId !== origin.conversationId || request.id >= admission || data?.references?.generation !== origin.generation || !isDeepStrictEqual(data.references.instructions, instructions.snapshot)) throw invalid();
  if (toolId !== undefined) {
    const selected = await personalModelRequestEntry(tx, toolId), tool = await tx.task(toolId), input = tool?.input;
    const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
    if (selected?.entry !== request.id || !assistant || assistant.byTaskId !== origin.generation || request.id >= assistant.id || assistant.id >= admission) throw invalid();
  }
  await verifyPersonalWorkInstructions(tx, origin.conversationId, instructions.snapshot, { work: origin.work.ref, inputs: origin.inputs });
  if (!isDeepStrictEqual(origin.sources, await personalWorkInstructionSources(tx, instructions.snapshot))) throw invalid();
  const first = data.input?.messages?.[0];
  if (first?.role !== "system" || first.sections?.["personal-work-instructions"] !== personalWorkInstructionText(instructions.snapshot, await personalWorkInstructionContents(tx, instructions.snapshot))) throw invalid();
}

export async function personalToolOrigin(tx: Tx, api: Pick<ToolExecutionApi, "conversationId" | "taskId">, sourceRequestId?: string, options?: { allowBlocked?: boolean; snapshot?: PersonalWorkInstructionSnapshot }): Promise<PersonalToolOrigin> {
  const live = await tx.doc(LiveDoc, api.conversationId), tool = await tx.task(api.taskId), generation = tool?.owner && await tx.task(tool.owner);
  const input = tool?.input;
  if (tool?.kind !== "pi.tool" || tool.conversationId !== api.conversationId || tool.abortRequested || tool.state.status === "terminal" || !input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model" || generation?.kind !== "pi.generation" || generation.conversationId !== api.conversationId || generation.abortRequested || generation.state.status === "terminal" || live.run?.taskId !== generation.id || !live.tools?.some(slot => slot.taskId === api.taskId && slot.status === "running")) throw new PersonalError("tool_inactive", "工具不属于活动模型调用，未执行；请结束本轮并报告拥有者。");
  await requirePersonalQuestionBoundary(tx, api.conversationId, generation.id, api.taskId);
  const scheduled = await scheduledConversation(tx, api.conversationId);
  if (scheduled) {
    if (scheduled.run.sealed) throw new PersonalError("tool_source_sealed", "本次定时运行已封组收尾，未执行新操作；请只查询已有结果并完成汇总。");
    const value = await personalSource(tx, scheduled.run.requestId, { active: true });
    if (!value.scheduled || value.submission.conversationId !== api.conversationId || live.run.inputs.length !== 1 || live.run.inputs[0] !== value.submission.id || sourceRequestId !== undefined && sourceRequestId !== value.source.requestId) throw new PersonalError("tool_source_invalid", "工具不属于本次定时运行的原输入，未执行；请结束本轮并报告拥有者。");
    if (!options?.allowBlocked) await requirePersonalServiceSourceReady(tx, value.source.requestId, api.taskId);
    return { conversationId: api.conversationId, generation: generation.id, inputs: live.run.inputs.slice(), sources: [value.submission.id], source: { ...value.source }, permission: { ...value.permission }, ...(value.telegram ? { telegram: { ...value.telegram } } : {}) };
  }
  if (api.conversationId !== ROOT_CONVERSATION_ID) {
    const current = await activePersonalWorkInspection(tx, api.conversationId, live.run.inputs, api.taskId);
    const inputs = options?.snapshot ? options.snapshot.nativeInputs.slice() : live.run.inputs.slice();
    const child = options?.snapshot ? await personalWorkInspectionSource(tx, current.work.ref, inputs) : current;
    const work = await tx.doc(PersonalWorkDoc, child.work.ref.requestId, null);
    const sources = options?.snapshot ? await personalWorkInstructionSources(tx, options.snapshot) : child.sources;
    return { conversationId: api.conversationId, generation: generation.id, inputs, sources, source: { ...work.source! }, permission: { ...child.work.permission }, ...(child.work.telegram ? { telegram: { ...child.work.telegram } } : {}), work: child.work };
  }
  const requestId = await personalToolSource(tx, api, true, sourceRequestId);
  if (!options?.allowBlocked) await requirePersonalServiceSourceReady(tx, requestId!, api.taskId);
  const value = await personalSource(tx, requestId!, { active: true });
  return { conversationId: api.conversationId, generation: generation.id, inputs: live.run.inputs.slice(), sources: [value.submission.id], source: { ...value.source }, permission: { ...value.permission }, ...(value.telegram ? { telegram: { ...value.telegram } } : {}) };
}
