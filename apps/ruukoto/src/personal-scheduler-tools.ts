import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, LiveDoc, defineExtension, defineTool, type Harness, type ToolExecutionApi, type Tx, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { PersonalError } from "./personal-error.ts";
import { personalToolSource } from "./personal-work-tools.ts";
import { delegatePersonalWork, personalWorkResult, personalWorkStatus, PersonalWorkDoc, requestPersonalWorkCancel, type PersonalWorkRef } from "./personal-work.ts";
import { PERSONAL_SCHEDULED_WORK, ScheduledWorkAdmission, personalScheduledSource, requireScheduledSourceReady, scheduledConversation, type PersonalScheduleActor } from "./personal-scheduler-records.ts";
import type { PersonalScheduler } from "./personal-scheduler.ts";

export const PERSONAL_SCHEDULE_TOOLS = "personal-schedule-tools";
export const PERSONAL_SCHEDULE_TOOL_NAMES = ["schedule_create", "schedule_query", "schedule_cancel"];
async function modelActor(getHarness: () => Harness, api: ToolExecutionApi, context: Context): Promise<PersonalScheduleActor> {
  const live = await api.snapshot(LiveDoc, api.conversationId, context), candidate = live?.run?.inputs.length === 1 ? await getHarness().submission(live.run.inputs[0], context) : undefined, requestId = (await candidate?.status(context))?.requestId;
  if (!requestId) throw new PersonalError("schedule_source_invalid", "创建或取消计划需要本轮唯一拥有者输入，请结束本轮并向拥有者报告。");
  return { kind: "model", conversationId: api.conversationId, taskId: api.taskId, requestId };
}
const output = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
async function reportError(work: () => Promise<ReturnType<typeof output>>) { try { return await work(); } catch (error) { if (!(error instanceof PersonalError)) throw error; return { isError: true, output: [{ type: "text" as const, text: `${error.code}：${error.message}` }] }; } }
export function personalScheduleTools(getHarness: () => Harness, scheduler: Pick<PersonalScheduler, "create" | "list" | "get" | "cancel" | "runs" | "result">) {
  const create = defineTool({ name: "schedule_create", description: "创建一个独立执行的定时计划。提供自足说明和明确资料；不会复制主聊天。一次性必须含Z或显式偏移；每日/每周使用IANA时区和当地HH:mm。每计划最多一项未完成运行，漏期合并；宿主等待全部子工作和外部核实后只向创建时原入口回报一次。创建时模式、工具和资料是上限，后续配置变更可使旧计划停止，需拥有者核实后重建；计划不继承单次批准或长期服务授权。修改须先取消再新建。", parameters: Type.Object({ label: Type.String({ minLength: 1, maxLength: 128, description: "便于拥有者识别的计划名称。" }), instruction: Type.String({ minLength: 1, maxLength: 16384, description: "完整任务和明确资料，不依赖主聊天中的省略指代。" }), rule: Type.Object({ kind: Type.Union([Type.Literal("once"), Type.Literal("daily"), Type.Literal("weekly")]), time_zone: Type.String({ description: "IANA时区，如Asia/Tokyo。" }), at: Type.Optional(Type.String({ description: "仅once必填，ISO时间须带Z或显式偏移；过去时刻会延迟执行一次。" })), time: Type.Optional(Type.String({ description: "daily/weekly必填，当地HH:mm。" })), weekdays: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, description: "仅weekly必填，不重复的ISO星期，1为周一。" })) }, { additionalProperties: false }) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential", async execute(input, api, context) { return reportError(async () => { const actor = await modelActor(getHarness, api, context); const plan = await api.commit(tx => scheduler.create(tx, { ...input, requestId: `personal-schedule-create:${api.taskId}` }, actor), context); return output({ plan: plan.id, label: plan.label, nextDueAt: plan.nextDueAt, next: "计划已保存。结束本轮，后续用schedule_query查看运行和最终回报。" }); }); } });
  const query = defineTool({ name: "schedule_query", description: "查询计划或本次完整运行结果，不执行任务。省略plan/run列计划；plan列该计划的运行；run分页读完整最终报告和发送状态。offset从0开始，有nextOffset时继续。等待审批、未知效果或停止核实时只可查询/取消，由拥有者核实原操作；结束本轮，不换计划重试。", parameters: Type.Object({ plan: Type.Optional(Type.String()), run: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), replay: "safe", async execute({ plan, run, offset = 0 }, api, context) { return reportError(async () => output(await api.commit(async tx => { await personalToolSource(tx, api, false); if (plan && run) throw new PersonalError("schedule_input_invalid", "每次只查询plan或run之一。"); if (run) return scheduler.result(tx, run, offset); if (plan) { const value = await scheduler.get(tx, plan); return { plan: value.id, label: value.label, instruction: value.instruction, rule: value.rule, mode: value.permission.mode, canceled: value.canceled, nextDueAt: value.nextDueAt, runs: await scheduler.runs(tx, plan, offset) }; } const page = await scheduler.list(tx, offset); return { items: page.items.map(value => ({ plan: value.id, label: value.label, rule: value.rule, mode: value.permission.mode, canceled: value.canceled, nextDueAt: value.nextDueAt })), ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) }; }, context))); } });
  const cancel = defineTool({ name: "schedule_cancel", description: "取消一个计划，立即登记停止未来触发及当前整项运行。返回不等于所有进程已退出；未知效果或停止未核实时继续保留占用，迟到结果不会恢复计划。已发生效果不撤销，后续用schedule_query查看。", parameters: Type.Object({ plan: Type.String({ minLength: 1, description: "schedule_create/query返回的计划引用。" }) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential", async execute({ plan }, api, context) { return reportError(async () => { const actor = await modelActor(getHarness, api, context); await api.commit(tx => scheduler.cancel(tx, plan, actor), context); return output({ plan, canceled: true, next: "已登记整项取消。结束本轮，后续查询原计划核实停止和外部效果。" }); }); } });
  return defineExtension({ name: PERSONAL_SCHEDULE_TOOLS, tools: [create, query, cancel] });
}

async function scheduledTool(tx: Tx, api: ToolExecutionApi, write: boolean) {
  const target = await scheduledConversation(tx, api.conversationId), live = await tx.doc(LiveDoc, api.conversationId), tool = await tx.task(api.taskId), generation = tool?.owner && await tx.task(tool.owner);
  if (!target || tool?.kind !== "pi.tool" || tool.conversationId !== api.conversationId || tool.abortRequested || tool.state.status === "terminal" || generation?.kind !== "pi.generation" || generation.conversationId !== api.conversationId || generation.id !== live.run?.taskId || generation.abortRequested || !live.tools?.some(slot => slot.taskId === api.taskId && slot.status === "running")) throw new PersonalError("schedule_tool_inactive", "当前工具不属于活动定时会话，请结束本轮并报告拥有者。");
  if (write) { const source = await personalScheduledSource(tx, target.run.requestId); await requireScheduledSourceReady(tx, target.run.requestId); if (!source || source.run.sealed || live.run.inputs.length !== 1 || live.run.inputs[0] !== source.submission.id) throw new PersonalError("schedule_run_sealed", "本轮定时工作已封组，只能查询原结果；请完成本轮汇总。" ); }
  return target;
}
export function personalScheduledWork(getHarness: () => Harness) {
  const background = defineTool({ name: "background_work", description: "本轮定时工作的一层子工作。delegate立即返回，必填content、可选label；不读取主聊天。list列本轮成员；result必填work、可选offset，每页4096字符；cancel必填work只取消本轮成员并保留身份/成果。不得引用其他运行成员。安排好后结束本轮，宿主自动封组、等待所有成员和外部核实，再请本会话查询汇总并固定回报；汇总轮只可list/result，不再委派或写操作。未知效果或停止未核实会暂停整项运行，由拥有者核实，不换工具重试。", parameters: Type.Object({ action: Type.Union([Type.Literal("delegate"), Type.Literal("list"), Type.Literal("result"), Type.Literal("cancel")]), content: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })), label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), work: Type.Optional(Type.Integer({ minimum: 1 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential", async execute(input, api, context) { return reportError(async () => {
    const { action, content, label, work, offset = 0 } = input, allowed = { delegate: ["content", "label"], list: ["offset"], result: ["work", "offset"], cancel: ["work"] }[action];
    if (Object.keys(input).some(key => key !== "action" && !allowed.includes(key)) || action === "delegate" && !content?.trim() || ["result", "cancel"].includes(action) && work === undefined) throw new PersonalError("schedule_input_invalid", "参数组合无效，请按动作说明只提供所需字段。");
    const result = await api.commit(async tx => {
      const { plan, run } = await scheduledTool(tx, api, ["delegate", "cancel"].includes(action));
      if (action === "list") { const items = []; for (const ref of run.members.slice(offset, offset + 8)) { const status = await personalWorkStatus(tx, ref); items.push({ work: ref.taskId, state: status.task.state.status === "terminal" ? status.task.state.outcome.status : status.task.state.status, stopped: status.stopVerified }); } return { items, ...(offset + 8 < run.members.length ? { nextOffset: offset + 8 } : {}) }; }
      if (action === "delegate") {
        const model = (await tx.doc(AgentDoc, api.conversationId)).model; if (!model) throw new PersonalError("model_unavailable", "定时执行模型不可用，请结束本轮并报告拥有者。");
        const ref = await delegatePersonalWork(tx, model, { content: content!, requestId: `personal-tool:${api.taskId}`, sourceRequestId: run.requestId, ...(label === undefined ? {} : { label }) });
        const saved = await tx.doc(PersonalWorkDoc, ref.requestId, null); saved.modelCall = api.taskId;
        if (!run.members.some(member => member.taskId === ref.taskId)) { run.members.push(ref); await tx.appendEntry(ScheduledWorkAdmission, run.conversationId, { data: { runId: run.id, work: ref, modelCall: api.taskId, content: content!, ...(label === undefined ? {} : { label }) } }); }
        if (!saved.permission || !isSamePermission(saved.permission, plan.permission)) throw new PersonalError("schedule_permission_changed", "子工作没有沿用计划原权限，未委派；请报告拥有者。");
        return { work: ref.taskId, state: "registered", next: "继续安排本轮其他分析；安排好后结束本轮，宿主自动等待并汇总。" };
      }
      const ref = run.members.find(member => member.taskId === work); if (!ref) throw new PersonalError("schedule_work_forbidden", "此子工作不属于本次运行，请用list查询本轮成员。");
      if (action === "result") return personalWorkResult(tx, ref, offset);
      await requestPersonalWorkCancel(tx, ref); return { cancel: ref, state: "cancel_requested" };
    }, context);
    if ("cancel" in result && result.cancel) await getHarness().abortTask(result.cancel.taskId, context);
    return output(result);
  }); } });
  return defineExtension({ name: PERSONAL_SCHEDULED_WORK, tools: [background], sections: [section("scheduled-work", () => "你是个人助手的一次独立定时执行。只处理本轮完整计划说明和明确资料，不读取主聊天作为授权。沿用计划创建时模式、工具与资料上限；子工作只能继承本轮范围，单次批准和长期服务授权不继承。安排完本轮子工作后结束当前回答，宿主自动封组并等待全部子工作和外部核实，再在本会话请求最终汇总。汇总轮只能查询本轮结果，不能新增委派或外部写入。未知效果或停止未核实由拥有者核实，不能换工具或新工作重试。", { tag: false })] });
}
function isSamePermission(left: { mode: string; version: number }, right: { mode: string; version: number }) { return left.mode === right.mode && left.version === right.version; }
