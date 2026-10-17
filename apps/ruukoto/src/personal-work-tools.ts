import { AgentDoc, defineExtension, defineTool, LiveDoc, ROOT_CONVERSATION_ID, type ConversationId, type Harness, type TaskId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { PersonalError } from "./personal-error.ts";
import { appendPersonalWork, personalWorkNoteSource, delegatePersonalWork, PersonalAgentsDoc, PersonalWorkDoc, personalWorkRef, personalWorkResult, personalWorkStatus, requestPersonalWorkCancel, closePersonalAgent } from "./personal-work.ts";
import { permissionSnapshot, telegramSourceActive } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";

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
    description: "管理可长期复用的后台分析子 Agent。delegate 登记后立即返回，主聊天可继续；子 Agent 只有对话分析能力，没有外部工具，不能再委派或联系拥有者。append 用 work 与 content 补充仍在运行的原工作，当前回答结束后按顺序处理；接纳不代表执行或完成，不改变原权限；已取消/结束或原操作待核实则拒绝，请结束本轮向拥有者报告。list 分页列身份与当前工作；result 分页读原工作的完整文本。运行中请结束本轮，后续拥有者询问时再查询；当前不会自动回报。cancel 等待当前工作停止，取消不关闭身份；close 只关闭空闲身份，历史保留。占用未释放时不能复用或关闭，停止无法核实须向拥有者报告。回报输入可查询，不能变更工作。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("delegate"), Type.Literal("append"), Type.Literal("list"), Type.Literal("result"), Type.Literal("cancel"), Type.Literal("close")], { description: "delegate 需要 content，可选 agent 或 label；append 只需 work 与 content，补充当前工作，当前回答结束后处理；list 仅可选 offset；result 需要 work，可选 offset；cancel 只需 work；close 只需 agent。其余字段须省略。" }),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 16384, description: "delegate/append 的完整分析要求，须含所需资料；子会话不读取主聊天。" })),
      agent: Type.Optional(Type.Integer({ minimum: 1, description: "list 或 delegate 返回的子 Agent 编号；delegate 复用空闲且未关闭的身份，省略则新建；close 必填。" })),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "仅新建身份时使用的名称；复用 agent 时省略。" })),
      work: Type.Optional(Type.Integer({ minimum: 1, description: "delegate 或 list 返回的工作编号，用于 result/append/cancel；不使用子 Agent 编号代替。" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "list/result 从 0 开始；后续页使用返回的 nextOffset。list 每页 16 个身份，result 每页 4096 字符。" })),
    }, { additionalProperties: false }),
    replay: "safe",
    executionMode: "sequential",
    async execute(input, api, context) {
      const execute = async () => {
        const { action, content, agent, label, work, offset = 0 } = input;
        const allowed = { delegate: ["content", "agent", "label"], append: ["work", "content"], list: ["offset"], result: ["work", "offset"], cancel: ["work"], close: ["agent"] }[action];
        if (Object.keys(input).some(key => key !== "action" && !allowed.includes(key)) || (action === "delegate" && (!content?.trim() || (agent !== undefined && label !== undefined))) || ((action === "result" || action === "cancel" || action === "append") && work === undefined) || (action === "append" && !content?.trim()) || (action === "close" && agent === undefined)) throw new PersonalError("work_input_invalid", "参数组合无效，请按 action 描述仅提供该动作所需字段。");
        const live = await api.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context);
        const candidate = live?.run?.inputs.length === 1 ? await getHarness().submission(live.run.inputs[0], context) : undefined;
        const sourceRequestId = (await candidate?.status(context))?.requestId;
        const result = await api.commit(async tx => {
          const source = await personalToolSource(tx, api, action !== "list" && action !== "result", sourceRequestId);
          if (action === "delegate") {
            const model = (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).model;
            if (!model) throw new PersonalError("model_unavailable", "当前模型缺失，请结束本轮并报告拥有者。");
            const ref = await delegatePersonalWork(tx, model, { content: content!, requestId: `personal-tool:${api.taskId}`, sourceRequestId: source!, ...(agent === undefined ? {} : { agentId: agent as ConversationId }), ...(label === undefined ? {} : { label }) });
            (await tx.doc(PersonalWorkDoc, ref.requestId, null)).modelCall = api.taskId;
            return { work: ref.taskId, agent: ref.agentId, state: "registered", next: "结束本轮并告知已登记；后续用 result 查询，不表示已经完成。" };
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
