import { personalSource } from "./personal-source.ts";
import { AgentDoc, AssistantEntry, defineExtension, defineTool, hook, LiveDoc, ROOT_CONVERSATION_ID, ToolTask, type ConversationId, type Cursor, type EntryId, type Harness, type TaskId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { PersonalError } from "./personal-error.ts";
import { appendPersonalWork, personalWorkNoteSource, PersonalAgentsDoc, PersonalWorkDoc, personalWorkRef, personalWorkResult, requestPersonalWorkCancel, closePersonalAgent } from "./personal-work.ts";
import { PersonalAnalysisAdmission, cancelPersonalDelegation, delegatePersonalAnalysis, listPersonalDelegations, personalDelegationProgress } from "./personal-delegation.ts";
import { requestPersonalReport, personalReportResult } from "./personal-report.ts";
import { PERSONAL_MAIN_TOOL_ROUNDS, personalCoordinationCutoff, personalCoordinationTailRounds } from "./personal-coordination.ts";

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-model-work.md
export async function personalToolSource(tx: Tx, api: Pick<ToolExecutionApi, "taskId" | "conversationId">, owner: boolean, sourceRequestId?: string) {
  const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
  const tool = await tx.task(api.taskId);
  const generation = tool?.owner && await tx.task(tool.owner);
  if (api.conversationId !== ROOT_CONVERSATION_ID || tool?.conversationId !== ROOT_CONVERSATION_ID || tool.kind !== "pi.tool" || tool.state.status === "terminal" || tool.abortRequested || !tool.input || typeof tool.input !== "object" || Array.isArray(tool.input) || tool.input.kind !== "model" || generation?.id !== live.run?.taskId || generation?.kind !== "pi.generation" || generation.abortRequested || !live.tools?.some(slot => slot.taskId === api.taskId && slot.status === "running")) throw new PersonalError("work_tool_inactive", "当前工具不属于活动主会话，已停止工作操作；请结束本轮并报告拥有者。");
  if (!owner) return;
  if (live.run!.inputs.length !== 1) throw new PersonalError("work_source_ambiguous", "当前轮次包含多项输入，无法唯一确定工作归属；请结束本轮并请拥有者单独提交工作要求。");
  if (!sourceRequestId) throw new PersonalError("work_source_invalid", "本轮拥有者来源缺失，请结束本轮并报告拥有者。");
  const source = await personalSource(tx, sourceRequestId, { active: true, invalidCode: "work_source_invalid" });
  if (source.scheduled || source.submission.id !== live.run!.inputs[0] || source.submission.status !== "placed") throw new PersonalError("work_source_invalid", "工作变更需要本轮拥有者输入，请结束本轮并报告拥有者。");
  // The committed cutoff intent is visible inside this same serialized commit, so no later admission
  // by this input can slip between the intent write and this fence.
  if (await personalCoordinationCutoff(tx, sourceRequestId)) throw new PersonalError("work_tool_coordination_cutoff", "本轮输入已因协调超预算停止；不再接纳新的工作变更，请查询原状态。");
  return source.source.requestId;
}

const ARRANGEMENT_ACTIONS = new Set(["delegate", "append", "cancel", "cancel_delegation", "close", "report"]);
const YIELD = { terminate: true } as const;

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-delegation-reports.md
export function personalWorkTools(getHarness: () => Harness) {
  const tool = defineTool({
    name: "background_work",
    description: "管理长期复用的分析子 Agent；子会话只可使用宿主提供的受控工具。delegate 立即返回；同轮多项分析归同一委托，跨轮提供 delegation 继续原委托，保持原入口和授权；省略则建立本轮委托。本轮拥有者明确交办独立新工作时，可复用空闲且停止已核实的 agent，并省略 delegation；身份复用不等于续派旧委托。delegations 列委托，progress 读委托成员进度；全部分析空闲不表示整项完成。cancel_delegation 一次请求取消全部分析成员，不关闭身份；包含成员的固定服务检查和服务重启，效果或停止未核实时继续保留占用；不涵盖独立宿主服务写操作。append 补充活动 work，同一子 Agent 按接纳顺序继续处理。list 列身份，result 分页读单项已保存回答，partial=true表示模型因长度限制截断，翻完页也不是完整回答，应报告遗漏，不自动续写或重试；commands/services/notice 是宿主当前事实，优先于 text 中旧子回答的解释；notes 逐项给出已接纳说明的原生受理状态：queued=已接纳待进入运行、placed=已入运行待答、done=已回答、unanswered=运行结束未答、not_submitted=工作先停未下发，queued/placed 不代表模型已读；requiresVerification=false 表示不再等待核实，原 MCP 未知事实仍以 notice 为准，不据旧子回答恢复占用或重试；cancel 请求单项取消后立即返回，用 result 查询停止结果，close 关闭空闲身份并保留历史。已取消委托不能续派/追加，但不禁止新的独立工作复用空闲身份。原入口失效时只能查询或取消；任一成员说明来源的服务效果未知会暂停整个委托，原入口有效且未取消时仍可登记 report，须向拥有者报告核实，不能为原未知效果换委托重试。占用未释放或停止无法核实不能复用。安排完全部分析后调用 report，只登记封组，成员仍活动或效果未知时也可安排；宿主等全部成员及真实资源停止、必要效果核实后才生成并发送报告，封组后不能续派或追加。普通 MCP 结果未知可由拥有者结束原工作并保留未知后汇总，电脑调用仍须停止核实并接受新截图。report_result 分页读完整报告和发送状态。未知命令/服务及未恢复电脑调用会暂停报告；普通 MCP 人工收尾只允许汇总未知，不恢复原来源执行。阻塞解除后可重做模型汇总，未知发送不重发。普通汇总失败请查询报告并向拥有者说明，不换委托重试。回报输入只可查询。同一工具批的全部调用同时发出、互相看不到返回编号：对本批新建 work/delegation 的 append/cancel/report 须等结果返回后在之后的批发出，对已有编号的操作可同批进行。只含安排动作（delegate/append/cancel/cancel_delegation/close/report）的批执行完后，宿主按已登记事实向拥有者回执并让出本轮，之后不能再输出文本；批内含任一查询动作（list/result/progress/delegations/report_result）则本轮继续，可继续安排、查询或输出正文。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("delegate"), Type.Literal("append"), Type.Literal("list"), Type.Literal("result"), Type.Literal("cancel"), Type.Literal("close"), Type.Literal("delegations"), Type.Literal("progress"), Type.Literal("cancel_delegation"), Type.Literal("report"), Type.Literal("report_result")], { description: "delegate 必填 content，可选 agent 或 label、delegation、appData；append 必填 work/content；list/delegations 仅可选 offset；result 必填 work，可选 offset；progress/report_result 必填 delegation，可选 offset；report/cancel_delegation 必填 delegation；cancel 必填 work；close 必填 agent。其余字段省略。report 新登记须原入口有效且未取消，只登记封组，成员仍活动或效果未知时也可安排；宿主等成员及真实资源停止、必要效果核实后报告；普通 MCP 可由拥有者人工收尾并保留未知后汇总，电脑须停止核实并接受新截图。封组后不能续派或追加。" }),
      appData: Type.Optional(Type.Boolean({ description: "仅delegate：本次子工作确需应用数据时显式设true，默认无资格；复用身份不继承上次资格。" })),
      delegation: Type.Optional(Type.Integer({ minimum: 1, description: "delegate/delegations 返回的委托编号；progress/cancel_delegation/report/report_result 必填。delegate 仅继续未取消、未封组的原委托时提供；本轮独立新工作省略 delegation，即使同时用 agent 复用身份。不能用 work 或 agent 编号代替，不能为原未知效果换委托重试。" })),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 16384, description: "delegate/append 的完整分析要求，须含所需资料；子会话不读取主聊天。" })),
      agent: Type.Optional(Type.Integer({ minimum: 1, description: "list 或 delegate 返回的长期子 Agent 身份编号，不是委托编号。delegate 复用空闲、未关闭且停止已核实的身份，省略则新建；独立新工作复用身份时省略 delegation。close 必填。" })),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "仅新建身份时使用的名称；复用 agent 时省略。" })),
      work: Type.Optional(Type.Integer({ minimum: 1, description: "delegate 或 list 返回的工作编号，用于 result/append/cancel；不使用子 Agent 编号代替。" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "result/report_result 是从 0 开始的文本位置，返回 offset 和完整保存文本的 totalChars；list/delegations/progress 是从 0 开始的条目位置。后页只用 nextOffset，缺失表示本页已到保存内容末尾；partial=true 是模型生成截断，与分页无关。身份每页16个、委托和成员每页8项、文本每页4096字符。" })),
    }, { additionalProperties: false }),
    replay: "safe",
    executionMode: "sequential",
    async execute(input, api, context) {
      const execute = async () => {
        const { action, content, agent, label, work, delegation, appData, offset = 0 } = input;
        const allowed = { delegate: ["content", "agent", "label", "delegation", "appData"], append: ["work", "content"], list: ["offset"], result: ["work", "offset"], cancel: ["work"], close: ["agent"], delegations: ["offset"], progress: ["delegation", "offset"], cancel_delegation: ["delegation"], report: ["delegation"], report_result: ["delegation", "offset"] }[action];
        if (Object.keys(input).some(key => key !== "action" && !allowed.includes(key)) || (action === "delegate" && (!content?.trim() || (agent !== undefined && label !== undefined))) || ((action === "result" || action === "cancel" || action === "append") && work === undefined) || (action === "append" && !content?.trim()) || (action === "close" && agent === undefined) || (["progress", "cancel_delegation", "report", "report_result"].includes(action) && delegation === undefined)) throw new PersonalError("work_input_invalid", "参数组合无效，请按 action 描述仅提供该动作所需字段。");
        const live = await api.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context);
        const candidate = live?.run?.inputs.length === 1 ? await getHarness().submission(live.run.inputs[0], context) : undefined;
        const sourceRequestId = (await candidate?.status(context))?.requestId;
        const result = await api.commit(async tx => {
          const source = await personalToolSource(tx, api, !["list", "result", "delegations", "progress", "report_result"].includes(action), sourceRequestId);
          if (action === "report_result") {
            const submission = sourceRequestId ? await tx.submissionByRequest(ROOT_CONVERSATION_ID, sourceRequestId) : undefined;
            const entry = submission?.entry ? await tx.entry(submission.entry) : undefined;
            if (entry?.kind === "ruukoto.delegation-report") return { next: "请用 progress 查询本委托成员，再用 result 分页读取业务结果并完成正文；本轮结束后由宿主处理发送，正文无需判断报告发送状态。" };
            return personalReportResult(tx, { entryId: delegation as EntryId }, offset);
          }
          if (action === "report") { await requestPersonalReport(tx, { entryId: delegation as EntryId }, source!, api.taskId); return { delegation, state: "report_registered", next: "已固定最终汇总安排，全部成员停止后宿主请主 Agent 汇总并回报原入口，不能再为此委托续派或追加；后续用 report_result 查询完整报告。" }; }
          if (action === "delegations") {
            const page = await listPersonalDelegations(tx, offset);
            return { delegations: page.items.map(({ ref, report: _report, state: _state, ...value }) => ({ delegation: ref.entryId, ...value })), ...(page.more ? { nextOffset: offset + 8 } : {}) };
          }
          if (action === "progress") {
            const { ref, members, report: _report, state: _state, ...value } = await personalDelegationProgress(tx, { entryId: delegation as EntryId }, offset);
            return { delegation: ref.entryId, ...value, members: members.map(({ ref, ...member }) => ({ work: ref.taskId, ...member })) };
          }
          if (action === "cancel_delegation") {
            await cancelPersonalDelegation(tx, { entryId: delegation as EntryId }, source!);
            return { delegation, state: "cancel_requested", next: "已登记全部分析成员取消，停止尚须核实；后续用 progress 查询。身份和历史保留，包括成员服务操作的效果和停止核实，不涵盖独立宿主服务写操作。" };
          }
          if (action === "delegate") {
            const model = (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).model;
            if (!model) throw new PersonalError("model_unavailable", "当前模型缺失，请结束本轮并报告拥有者。");
            const { ref, delegation: group } = await delegatePersonalAnalysis(tx, model, { content: content!, requestId: `personal-tool:${api.taskId}`, sourceRequestId: source!, ...(agent === undefined ? {} : { agentId: agent as ConversationId }), ...(label === undefined ? {} : { label }), ...(appData === undefined ? {} : { appData }) }, delegation === undefined ? undefined : { entryId: delegation as EntryId });
            const saved = await tx.doc(PersonalWorkDoc, ref.requestId, null);
            saved.modelCall = api.taskId;
            if (saved.delegationAdmission === undefined) saved.delegationAdmission = (await tx.appendEntry(PersonalAnalysisAdmission, ROOT_CONVERSATION_ID, { data: { work: ref, delegation: group, source: { ...saved.instructionSource! }, origin: { ...saved.source! }, permission: { ...saved.permission! }, ...(saved.telegram ? { telegram: { ...saved.telegram } } : {}), modelCall: api.taskId } })).id;
            return { work: ref.taskId, agent: ref.agentId, delegation: group.entryId, state: "registered", next: "已登记安排。本次返回的 work/delegation 编号本批其它调用看不到：对本委托的续派或 report 须在之后的批发出，对已有编号的操作可同批。未封组时可跨轮继续，progress 查询委托、result 读取单项结果。" };
          }
          if (action === "append") {
            const ref = await personalWorkRef(tx, work as TaskId);
            const outcome = await appendPersonalWork(tx, ref, { requestId: `personal-note-tool:${api.taskId}`, content: content!, source: await personalWorkNoteSource(tx, source!, api.taskId) });
            if (!outcome.accepted) return { work, state: outcome.outcome, next: "原工作在此说明接纳前已结束，未接纳说明；用 result 查询原结果与已接纳说明的处理情况，需要新的分析由拥有者另行交办。不要复用同一说明键重试。" };
            return { work, state: "note_accepted", next: "说明已归原工作，同一子 Agent 按接纳顺序继续处理，权限保持原范围；后续用 result 查询原结果。" };
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
        const cancelled = "cancel" in result ? result.cancel : undefined;
        if (cancelled) {
          // Cancellation intent is already durable in the commit above; abortTask's mark commits
          // independently while its join is left un-awaited — a held child invocation must not keep
          // this input placed, and the physical stop stays unverified until observed.
          void harness.abortTask(cancelled.taskId, context).catch(() => process.stderr.write(`[ruukoto:personal] work ${cancelled.taskId} post-cancel physical stop unverified; query the original record.\n`));
          return { output: [{ type: "text" as const, text: JSON.stringify({ work, state: "cancel_requested", next: "已登记取消，停止仍须核实，保留占用；后续用 result 查询，不要重试或复用身份。" }) }] };
        }
        return { output: [{ type: "text" as const, text: JSON.stringify(result) }] };
      };
      try { return await execute(); } catch (error) {
        if (!(error instanceof PersonalError)) throw error;
        // Source/ownership errors the model cannot repair may only end the round and report; correctable input or state errors keep the model's chance to continue.
        const output = [{ type: "text" as const, text: `${error.code}：${error.message}` }];
        if (["work_tool_inactive", "work_source_ambiguous", "work_source_invalid", "work_tool_coordination_cutoff"].includes(error.code)) return { isError: true, output, control: YIELD };
        return { isError: true, output };
      }
    },
  });
  return defineExtension({
    name: "personal-model-work",
    tools: [tool],
    // Arrangement-only batches end through afterTool termination; query-containing batches keep the
    // model-written answer. The batch budget guard refuses effects once the tail exceeds the bound.
    hooks: [hook(ToolTask, {
      async beforeTool(call, api, callContext) {
        if (api.conversationId !== ROOT_CONVERSATION_ID) return;
        if (await getHarness().commit(tx => personalCoordinationTailRounds(tx, api.conversationId), callContext) > PERSONAL_MAIN_TOOL_ROUNDS) return { block: "原协调批次预算已耗尽；本批由宿主停止，未执行。" };
      },
      async afterTool(call, result, api, callContext) {
        if (api.conversationId !== ROOT_CONVERSATION_ID || call.parent) return;
        const terminate = await getHarness().commit(async tx => {
          const task = await tx.task(api.taskId), input = task?.input;
          if (!input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model" || typeof input.assistant !== "number") return false;
          const assistant = await tx.entry(input.assistant as EntryId), message = assistant?.model?.[0];
          if (!assistant || message?.role !== "assistant" || !Array.isArray(message.content)) return false;
          const calls = message.content.filter(part => part.type === "toolCall");
          return calls.length > 0 && calls.every(part => part.name === "background_work" && part.arguments !== undefined && typeof part.arguments === "object" && !Array.isArray(part.arguments) && ARRANGEMENT_ACTIONS.has(String((part.arguments as Record<string, unknown>).action)));
        }, callContext);
        if (terminate) return { ...result, control: { ...result.control, terminate: true } };
      },
    })],
  });
}

// A done input's tool-call answer counts as a recognized handoff only when every slot's persisted
// result carries control.terminate (the host yield). Assistant text written before the calls is kept
// but never trusted as an outcome: committed call facts always follow it. Any end whose calls did not
// terminate — query batches, ordinary prose — stays on the caller's original path.
// Note: 见 .agents/notes/implemented/architecture/2026-11-02-personal-main-handoff.md
export async function personalWorkHandoff(tx: Tx, answer: EntryId, limit?: number): Promise<string | undefined> {
  const entry = await tx.entry(AssistantEntry, answer);
  const message = entry?.model?.[0];
  if (!entry || message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const calls = message.content.filter(part => part.type === "toolCall");
  if (!calls.length) return undefined;
  const wanted = new Set(calls.map(call => call.id));
  const tasks = new Map<string, Awaited<ReturnType<Tx["task"]>>>();
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: "pi.tool", conversationId: entry.conversationId }, 256, cursor);
    for (const item of page.items) {
      const input = item.input;
      // Provider call IDs are not unique across assistant entries; scope the lookup to the tasks this
      // answer entry actually spawned or a repeated ID would read another entry's outcome.
      if (input && typeof input === "object" && !Array.isArray(input) && input.kind === "model" && input.assistant === answer && typeof input.callId === "string" && wanted.has(input.callId)) tasks.set(input.callId, item);
    }
    cursor = page.next;
  } while (cursor && tasks.size < wanted.size);
  // `text` is the full fact for unbounded consumers; `short` is the compact form used when a bounded
  // payload cannot fit every detail; `refused` marks outcomes the owner must never lose (未生效/未接纳).
  const facts: { text: string; short: string; refused: boolean }[] = [];
  for (const call of calls) {
    const task = tasks.get(call.id);
    const outcome = task && task.state.status !== "pending" && task.state.status !== "running" && task.state.status !== "waiting" ? task.state.outcome : undefined;
    const result = outcome?.status === "completed" ? outcome.result : undefined;
    if (!result || typeof result !== "object" || Array.isArray(result) || result.kind !== "model" || typeof result.entryId !== "number" || (result.control as { terminate?: unknown } | undefined)?.terminate !== true) return undefined;
    const resultEntry = await tx.entry(result.entryId as EntryId);
    const resultMessage = resultEntry?.model?.[0];
    const resultText = resultMessage?.role === "toolResult" ? resultMessage.content.filter(part => part.type === "text").map(part => part.text).join("") : "";
    const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments as Record<string, unknown> : {};
    // Refused calls keep their actual outcome: the handoff reports the refusal, never a fake success.
    if (resultMessage?.role === "toolResult" && resultMessage.isError) { facts.push({ text: `调用 ${call.name} 未生效：${resultText || "执行被拒绝"}`, short: `调用 ${call.name} 未生效`, refused: true }); continue; }
    if (call.name === "background_work" && args.action === "report") facts.push({ text: `已登记委托 ${args.delegation} 的最终汇总安排，全部成员停止并核实后自动回报原入口`, short: `已登记委托${args.delegation}汇总安排`, refused: false });
    else if (call.name === "background_work" && args.action === "append") {
      // A completed call can still refuse admission (the work ended first); the persisted outcome,
      // not merely isError, decides whether the owner hears accepted or not-admitted.
      const parsed = (() => { try { const value = JSON.parse(resultText); return value && typeof value === "object" && !Array.isArray(value) ? value as { state?: unknown } : undefined; } catch { return undefined; } })();
      if (parsed?.state === "note_accepted") facts.push({ text: `已补充工作 ${args.work} 的说明，同一子 Agent 按接纳顺序处理`, short: `已补充工作${args.work}说明`, refused: false });
      else facts.push({ text: `工作 ${args.work} 的说明未接纳：原工作在此说明接纳前已结束`, short: `工作${args.work}说明未接纳`, refused: true });
    }
    else if (call.name === "background_work" && args.action === "cancel") facts.push({ text: `已登记工作 ${args.work} 的取消，停止与效果以原记录为准`, short: `已登记工作${args.work}取消`, refused: false });
    else if (call.name === "background_work" && args.action === "cancel_delegation") facts.push({ text: `已登记委托 ${args.delegation} 的全部成员取消，停止尚须核实`, short: `已登记委托${args.delegation}取消`, refused: false });
    else if (call.name === "background_work" && args.action === "close") facts.push({ text: `已关闭身份 ${args.agent}`, short: `已关闭身份${args.agent}`, refused: false });
    else {
      // Generic success detail (delegate's raw result JSON) is the long tail under a budget; the
      // compact form keeps the registered identifiers.
      let short = `调用 ${call.name} 已生效`;
      if (call.name === "background_work" && args.action === "delegate") {
        const parsed = (() => { try { const value = JSON.parse(resultText); return value && typeof value === "object" && !Array.isArray(value) ? value as { work?: unknown; delegation?: unknown } : undefined; } catch { return undefined; } })();
        if (parsed?.work !== undefined) short = `已登记工作${parsed.work}${parsed.delegation !== undefined ? `（委托${parsed.delegation}）` : ""}`;
      }
      facts.push({ text: resultText || `调用 ${call.name} 已结束本轮`, short, refused: false });
    }
  }
  const prose = message.content.flatMap(part => part.type === "text" && part.text ? [part.text] : []).join("");
  let body = `本轮以工具调用让出：${facts.map(fact => fact.text).join("；")}。`;
  if (limit !== undefined && Array.from(body).length > limit) {
    // The factual body itself exceeded the budget (a large arrangement batch): rebuild it compactly.
    // The aggregate head is exact and always complete; refusals enumerate first, then accepted calls
    // in compact form — a refusal's existence can never be cut by successful result JSON. Facts are
    // kept whole while they fit; the first oversized one is cut with an ellipsis and enumeration
    // stops, and the counts still answer truthfully.
    const refused = facts.filter(fact => fact.refused), accepted = facts.filter(fact => !fact.refused);
    const head = `本轮以工具调用让出：共${facts.length}项调用${accepted.length ? `，${accepted.length}项已生效` : ""}${refused.length ? `，${refused.length}项未生效或未接纳` : ""}`;
    const detail: string[] = [];
    let used = Array.from(head).length + 2;
    for (const fact of [...refused.map(item => item.text), ...accepted.map(item => item.short)]) {
      const sep = detail.length ? 1 : 0, room = limit - used - sep, chars = Array.from(fact);
      if (room < 2) break;
      if (chars.length <= room) { detail.push(fact); used += sep + chars.length; continue; }
      detail.push(chars.slice(0, room - 1).join("") + "…");
      break;
    }
    body = `${head}${detail.length ? `：${detail.join("；")}` : ""}。`;
  }
  if (limit === undefined) return `${prose ? `${prose}；` : ""}${body}`;
  // Outgoing payloads are bounded: committed outcome facts always survive; the model's pre-call
  // prose is truncated or omitted first, so a long claim can never push the facts past the cut.
  const room = Math.max(0, limit - Array.from(body).length - 1);
  const chars = Array.from(prose);
  const kept = chars.length <= room ? prose : room > 1 ? chars.slice(0, room - 1).join("") + "…" : "";
  return `${kept ? `${kept}；` : ""}${body}`;
}
