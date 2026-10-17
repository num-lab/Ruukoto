import { AgentDoc, defineExtension, defineTool, LiveDoc, ROOT_CONVERSATION_ID, type ConversationId, type Harness, type TaskId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { PersonalError } from "./personal-error.ts";
import { appendPersonalWork, personalWorkNoteSource, PersonalAgentsDoc, PersonalWorkDoc, personalWorkRef, personalWorkResult, personalWorkStatus, requestPersonalWorkCancel, closePersonalAgent } from "./personal-work.ts";
import { permissionSnapshot, telegramSourceActive } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";
import { PersonalAnalysisAdmission, cancelPersonalDelegation, delegatePersonalAnalysis, listPersonalDelegations, personalDelegationProgress } from "./personal-delegation.ts";
import type { EntryId } from "@earendil-works/pi-durable";
import { requestPersonalReport, personalReportResult } from "./personal-report.ts";

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-model-work.md
export async function personalToolSource(tx: Tx, api: Pick<ToolExecutionApi, "taskId" | "conversationId">, owner: boolean, sourceRequestId?: string) {
  const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
  const tool = await tx.task(api.taskId);
  const generation = tool?.owner && await tx.task(tool.owner);
  if (api.conversationId !== ROOT_CONVERSATION_ID || tool?.conversationId !== ROOT_CONVERSATION_ID || tool.kind !== "pi.tool" || tool.state.status === "terminal" || tool.abortRequested || !tool.input || typeof tool.input !== "object" || Array.isArray(tool.input) || tool.input.kind !== "model" || generation?.id !== live.run?.taskId || generation?.kind !== "pi.generation" || generation.abortRequested || !live.tools?.some(slot => slot.taskId === api.taskId && slot.status === "running")) throw new PersonalError("work_tool_inactive", "当前工具不属于活动主会话，已停止工作操作；请结束本轮并报告拥有者。");
  if (!owner) return;
  if (live.run!.inputs.length !== 1) throw new PersonalError("work_source_ambiguous", "当前轮次包含多项输入，无法唯一确定工作归属；请结束本轮并请拥有者单独提交工作要求。");
  const source = sourceRequestId ? await tx.submissionByRequest(ROOT_CONVERSATION_ID, sourceRequestId) : undefined;
  const entry = source?.entry && await tx.entry(source.entry);
  if (!source?.requestId || source.id !== live.run!.inputs[0] || source.type !== "input" || source.status !== "placed" || source.conversationId !== ROOT_CONVERSATION_ID || entry?.kind !== "pi.user") throw new PersonalError("work_source_invalid", "工作变更需要本轮拥有者输入；回报或其他参考不能提供授权。请结束本轮并向拥有者报告。");
  if (source.requestId.startsWith("telegram:")) {
    const receipt = (await tx.doc(PersonalTelegramReceiptDoc, source.requestId, null)).receipt;
    const telegram = receipt && permissionSnapshot(receipt);
    if (!telegram || receipt?.submissionId !== source.id || !await telegramSourceActive(tx, telegram)) throw new PersonalError("work_source_invalid", "原 Telegram 输入没有有效拥有者权限，请结束本轮并向拥有者报告。");
  }
  return source.requestId;
}

export function personalWorkTools(getHarness: () => Harness) {
  const tool = defineTool({
    name: "background_work",
    description: "管理长期复用的空工具分析子 Agent。delegate 立即返回；同轮多项分析归同一委托，跨轮提供 delegation 继续原委托，保持原入口和授权；省略则建立本轮委托。delegations 列委托，progress 读委托成员进度；全部分析空闲不表示整项完成。cancel_delegation 一次请求取消全部分析成员，不关闭身份；当前不涵盖服务等外部操作。append 补充活动 work，当前回答结束后依次处理。list 列身份，result 分页读单项完整回答；cancel 等待单项停止，close 关闭空闲身份并保留历史。委托取消后不能续派/追加；原入口失效或任一成员说明来源的服务效果未知会暂停整个委托，仍可查询/取消，须向拥有者报告核实，不换委托重试。占用未释放或停止无法核实不能复用。安排完全部分析后调用 report 封组，宿主等待全部成员停止，再请主 Agent 汇总并固定回报原入口；封组后不能续派或追加。report_result 分页读完整报告和发送状态。未知效果会暂停报告，核实后可安全重做模型汇总，未知发送不重发。普通汇总失败请查询报告并向拥有者说明，不换委托重试。回报输入只可查询。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("delegate"), Type.Literal("append"), Type.Literal("list"), Type.Literal("result"), Type.Literal("cancel"), Type.Literal("close"), Type.Literal("delegations"), Type.Literal("progress"), Type.Literal("cancel_delegation"), Type.Literal("report"), Type.Literal("report_result")], { description: "delegate 必填 content，可选 agent 或 label、delegation；append 必填 work/content；list/delegations 仅可选 offset；result 必填 work，可选 offset；progress/report_result 必填 delegation，可选 offset；report/cancel_delegation 必填 delegation；cancel 必填 work；close 必填 agent。其余字段省略。report 安排好全部分析后调用，封组后不能续派或追加。" }),
      delegation: Type.Optional(Type.Integer({ minimum: 1, description: "delegate/delegations 返回的委托编号；progress/cancel_delegation/report/report_result 必填。delegate 跨轮继续原委托时提供，不能使用 work 或 agent 编号代替。" })),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 16384, description: "delegate/append 的完整分析要求，须含所需资料；子会话不读取主聊天。" })),
      agent: Type.Optional(Type.Integer({ minimum: 1, description: "list 或 delegate 返回的子 Agent 编号；delegate 复用空闲且未关闭的身份，省略则新建；close 必填。" })),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "仅新建身份时使用的名称；复用 agent 时省略。" })),
      work: Type.Optional(Type.Integer({ minimum: 1, description: "delegate 或 list 返回的工作编号，用于 result/append/cancel；不使用子 Agent 编号代替。" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "list/result/delegations/progress 从 0 开始，后续页用 nextOffset；身份每页16个、委托和成员每页8项、结果每页4096字符。" })),
    }, { additionalProperties: false }),
    replay: "safe",
    executionMode: "sequential",
    async execute(input, api, context) {
      const execute = async () => {
        const { action, content, agent, label, work, delegation, offset = 0 } = input;
        const allowed = { delegate: ["content", "agent", "label", "delegation"], append: ["work", "content"], list: ["offset"], result: ["work", "offset"], cancel: ["work"], close: ["agent"], delegations: ["offset"], progress: ["delegation", "offset"], cancel_delegation: ["delegation"], report: ["delegation"], report_result: ["delegation", "offset"] }[action];
        if (Object.keys(input).some(key => key !== "action" && !allowed.includes(key)) || (action === "delegate" && (!content?.trim() || (agent !== undefined && label !== undefined))) || ((action === "result" || action === "cancel" || action === "append") && work === undefined) || (action === "append" && !content?.trim()) || (action === "close" && agent === undefined) || (["progress", "cancel_delegation", "report", "report_result"].includes(action) && delegation === undefined)) throw new PersonalError("work_input_invalid", "参数组合无效，请按 action 描述仅提供该动作所需字段。");
        const live = await api.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context);
        const candidate = live?.run?.inputs.length === 1 ? await getHarness().submission(live.run.inputs[0], context) : undefined;
        const sourceRequestId = (await candidate?.status(context))?.requestId;
        const result = await api.commit(async tx => {
          const source = await personalToolSource(tx, api, !["list", "result", "delegations", "progress", "report_result"].includes(action), sourceRequestId);
          if (action === "report_result") return personalReportResult(tx, { entryId: delegation as EntryId }, offset);
          if (action === "report") { await requestPersonalReport(tx, { entryId: delegation as EntryId }, source!, api.taskId); return { delegation, state: "report_registered", next: "已固定最终汇总安排，全部成员停止后宿主请主 Agent 汇总并回报原入口。结束本轮即可继续其他聊天；不能再为此委托续派或追加，后续用 report_result 查询完整报告。" }; }
          if (action === "delegations") {
            const page = await listPersonalDelegations(tx, offset);
            return { delegations: page.items.map(({ ref, ...value }) => ({ delegation: ref.entryId, ...value })), ...(page.more ? { nextOffset: offset + 8 } : {}) };
          }
          if (action === "progress") {
            const { ref, members, ...value } = await personalDelegationProgress(tx, { entryId: delegation as EntryId }, offset);
            return { delegation: ref.entryId, ...value, members: members.map(({ ref, ...member }) => ({ work: ref.taskId, ...member })) };
          }
          if (action === "cancel_delegation") {
            await cancelPersonalDelegation(tx, { entryId: delegation as EntryId }, source!);
            return { delegation, state: "cancel_requested", next: "已登记全部分析成员取消，停止尚须核实；后续用 progress 查询。身份和历史保留，不涵盖外部服务操作。" };
          }
          if (action === "delegate") {
            const model = (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).model;
            if (!model) throw new PersonalError("model_unavailable", "当前模型缺失，请结束本轮并报告拥有者。");
            const { ref, delegation: group } = await delegatePersonalAnalysis(tx, model, { content: content!, requestId: `personal-tool:${api.taskId}`, sourceRequestId: source!, ...(agent === undefined ? {} : { agentId: agent as ConversationId }), ...(label === undefined ? {} : { label }) }, delegation === undefined ? undefined : { entryId: delegation as EntryId });
            const saved = await tx.doc(PersonalWorkDoc, ref.requestId, null);
            saved.modelCall = api.taskId;
            if (saved.delegationAdmission === undefined) saved.delegationAdmission = (await tx.appendEntry(PersonalAnalysisAdmission, ROOT_CONVERSATION_ID, { data: { work: ref, delegation: group, source: { ...saved.instructionSource! }, origin: { ...saved.source! }, permission: { ...saved.permission! }, ...(saved.telegram ? { telegram: { ...saved.telegram } } : {}), modelCall: api.taskId } })).id;
            return { work: ref.taskId, agent: ref.agentId, delegation: group.entryId, state: "registered", next: "继续安排同一委托的其他分析；安排好后用 report 请求最终汇总，再结束本轮。未封组时可跨轮继续，progress 查询委托、result 读取单项结果。" };
          }
          if (action === "append") {
            const ref = await personalWorkRef(tx, work as TaskId);
            await appendPersonalWork(tx, ref, { requestId: `personal-note-tool:${api.taskId}`, content: content!, source: await personalWorkNoteSource(tx, source!, api.taskId) });
            return { work, state: "note_accepted", next: "说明已归原工作，将在当前回答结束后处理；结束本轮，后续查询原结果。权限保持原范围。" };
          }
          if (action === "list") {
            const agents = (await tx.doc(PersonalAgentsDoc)).agents;
            return { agents: agents.slice(offset, offset + 16).map(value => ({ agent: value.id, label: value.label, closed: value.closed, ...(value.work ? { work: value.work.taskId } : {}) })), ...(offset + 16 < agents.length ? { nextOffset: offset + 16 } : {}) };
          }
          if (action === "close") { await closePersonalAgent(tx, agent as ConversationId); return { agent, state: "closed" }; }
          const ref = await personalWorkRef(tx, work as TaskId);
          if (action === "cancel") { await requestPersonalWorkCancel(tx, ref); return { cancel: ref }; }
          return personalWorkResult(tx, ref, offset);
        }, context);
        const harness = getHarness();
        if ("cancel" in result && result.cancel) {
          await harness.abortTask(result.cancel.taskId, context);
          await harness.waitForTask(result.cancel.taskId, context);
          const stopped = (await api.commit(tx => personalWorkStatus(tx, result.cancel!), context)).stopVerified;
          return { output: [{ type: "text" as const, text: JSON.stringify({ work, state: stopped ? "stopped" : "stop_unverified", next: stopped ? "原工作已停止；用 result 查询其结果。身份未关闭，可用 list 查看。" : "停止仍未核实，保留占用；请向拥有者报告，不要重试或复用身份。" }) }] };
        }
        return { output: [{ type: "text" as const, text: JSON.stringify(result) }] };
      };
      try { return await execute(); } catch (error) {
        if (!(error instanceof PersonalError)) throw error;
        return { isError: true, output: [{ type: "text", text: `${error.code}：${error.message}` }] };
      }
    },
  });
  return defineExtension({ name: "personal-model-work", tools: [tool] });
}
