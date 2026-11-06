import { personalSource } from "./personal-source.ts";
import { AgentDoc, AssistantEntry, defineExtension, defineTool, hook, LiveDoc, ROOT_CONVERSATION_ID, ToolTask, type ConversationId, type Cursor, type EntryId, type Harness, type TaskId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { PersonalError } from "./personal-error.ts";
import { appendPersonalWork, personalWorkNoteSource, PersonalAgentsDoc, PersonalWorkDoc, personalWorkRef, personalWorkResult, requestPersonalWorkCancel, closePersonalAgent } from "./personal-work.ts";
import { personalToolFacts, personalToolRedisplay, personalWorkToolFacts } from "./personal-tools.ts";
import { PersonalAnalysisAdmission, cancelPersonalDelegation, continuePersonalAnalysis, delegatePersonalAnalysis, listPersonalDelegations, personalDelegationProgress } from "./personal-delegation.ts";
import { registerPersonalReport, requestPersonalReport, personalReportResult } from "./personal-report.ts";
import { PERSONAL_MAIN_TOOL_ROUNDS, personalCoordinationCutoff, personalCoordinationTailRounds } from "./personal-coordination.ts";
import { PERSONAL_QUESTION_INPUT } from "./personal-questions.ts";

// Note: See .agents/notes/implemented/architecture/2026-10-17-personal-model-work.md
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

// Note: See .agents/notes/implemented/architecture/2026-10-17-personal-delegation-reports.md
export function personalWorkTools(getHarness: () => Harness) {
  const tool = defineTool({
    name: "background_work",
    description: "委派、追加和查询后台工作。delegate 立即返回 work、agent、delegation；宿主自动登记汇总，等贡献此委托的主会话安排、全部已接纳工作和必要核实完成后才发布。追加或新成员会使尚未发布的旧草稿失效；无需另调 report。跨轮继续同一委托时提供 delegation，保持原入口和权限；本轮独立新工作省略 delegation，可复用空闲且停止已核实的 agent。append 只用于真正增加或修改要求：活动 work 由同一子 Agent 按接纳顺序处理，已完成 work 在身份空闲且原效果与停止已核实时显式建立关联的后续 work，旧结果保留且旧操作不重做。失败、取消或未知效果不能自动续接。每次有效追加使同一 work 的旧未开始文件、网络、MCP、应用数据、服务、命令和资源启动操作失效，包括已批准但未消费的操作，即使只是补充。把进度问题误当追加会使原批准失效；进度或待决定事项用 progress、result、operations、operation 查询。operations 分页列普通文件与网络操作，operation 只读这些普通操作的精确参数和当前决定；MCP 原参数和响应用 read_mcp_result，appData 批准用原入口应用数据菜单，browser 用原入口浏览器菜单。appData/MCP/browser/commands/services 的 operation 编号不能传给普通 operation/operations；已有宿主事实足够回答进度时直接报告待决定事项，不再查询业务工具。redisplay 仅在拥有者本轮要求重显示时为原入口登记同一个决定的显示请求，不批准或重做。list 列身份，delegations 列委托，progress 查询全部成员；空闲不表示整项完成。result 分页读单项已保存回答：partial=true 表示模型生成截断，翻完页也不是完整回答，应报告遗漏，不自动续写或重试；commands/services/tools/mcp/appData/browser/processes/resources/notice 是当前宿主事实，优先于旧子回答。resources 显示原资源排队或归属，processes 显示跨普通回答保留的进程。notes 给出每项说明的原生状态：queued/placed 不代表模型已读，done=已回答，unanswered=运行结束未答，not_submitted=工作先停未下发。cancel 请求单项取消，cancel_delegation 请求整项取消后立即返回；停止仍须查询核实。close 只关闭空闲身份并保留历史。原入口失效时只可查询或取消；原效果或停止未知会阻止后续执行，不能换工具、身份或委托重试。普通 MCP 可由拥有者人工结束并保留未知后汇总；电脑须停止核实并接受新截图，命令/服务须核实原效果与停止。report 可登记已有委托汇总，保留追加能力；report_result 读取已发布报告与发送状态。汇总输入只可查询，不取得新操作授权；普通汇总失败应报告，未知发送不重发。同一工具批的调用互相看不到返回编号：对本批新建 work/delegation 的后续动作须等返回后再发。仅含 delegate/append/cancel/cancel_delegation/close/report 的批结束后宿主按实际结果回执并让出本轮；含查询或 redisplay 的批继续，让你回答拥有者。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("delegate"), Type.Literal("append"), Type.Literal("list"), Type.Literal("result"), Type.Literal("cancel"), Type.Literal("close"), Type.Literal("delegations"), Type.Literal("progress"), Type.Literal("cancel_delegation"), Type.Literal("report"), Type.Literal("report_result"), Type.Literal("operations"), Type.Literal("operation"), Type.Literal("redisplay")], { description: "delegate 必填 content，可选 agent 或 label、delegation、appData；append 必填 work/content；list/delegations 仅可选 offset；result 必填 work，可选 offset、factsOffset；progress/report_result 必填 delegation，可选 offset；report/cancel_delegation 必填 delegation；cancel 必填 work；close 必填 agent。operations 可选 work/offset；operation 必填 operation，可选 offset；redisplay 必填 operation，其他字段省略。查询进度和待决定事项不能使用 append。其余字段省略。report 须原入口有效且未取消；自动汇总已登记时返回原安排，仍可续派或追加。append 的已完成目标须安全空闲才能建立关联后续工作，不重做旧效果。" }),
      operation: Type.Optional(Type.Integer({ minimum: 1, description: "operations 返回的普通操作编号，用于 operation 或 redisplay；不是 work 或 agent 编号。" })),
      appData: Type.Optional(Type.Boolean({ description: "仅delegate：本次子工作确需应用数据时显式设true，默认无资格；复用身份不继承上次资格。" })),
      delegation: Type.Optional(Type.Integer({ minimum: 1, description: "delegate/delegations 返回的委托编号；progress/cancel_delegation/report/report_result 必填。delegate 继续未取消且原来源可执行的委托时提供；本轮独立新工作省略 delegation，即使同时用 agent 复用身份。不能用 work 或 agent 编号代替，不能为原未知效果换委托重试。" })),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 16384, description: "delegate/append 的完整要求，须含所需资料；子会话不读取主聊天。原样保留拥有者指定的目标、字面正文和限制，包括空白与末尾换行；不得擅自允许改写或添加换行，也不得增加读取或其他验证操作。只依据已获准操作的返回事实报告。追加已完成工作时只说明新增或修改的要求，不重复已完成的效果。" })),
      agent: Type.Optional(Type.Integer({ minimum: 1, description: "list 或 delegate 返回的长期子 Agent 身份编号，不是委托编号。delegate 复用空闲、未关闭且停止已核实的身份，省略则新建；独立新工作复用身份时省略 delegation。close 必填。" })),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "仅新建身份时使用的名称；复用 agent 时省略。" })),
      work: Type.Optional(Type.Integer({ minimum: 1, description: "delegate 或 list 返回的工作编号，用于 result/append/cancel；不使用子 Agent 编号代替。" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "result/report_result/operation 是从 0 开始的文本位置；list/delegations/progress/operations 是从 0 开始的条目位置。后页只用 nextOffset，缺失表示已到保存内容末尾；partial=true 是模型生成截断，与分页无关。身份每页16个、委托/成员/普通操作每页8项、文本每页4096字符。" })),
      factsOffset: Type.Optional(Type.Integer({ minimum: 0, description: "仅 result：独立于回答正文 offset 的宿主事实位置，默认0；commands/services/tools/mcp/appData/browser/processes/resources/questions 每类最多8项，用 nextFactsOffset 继续，缺失表示事实末页。progress 只给各类首8项。questions 列原工作问题和答案状态，pending 须由拥有者从原问题卡或原私聊菜单回答；不要把普通聊天或 append 当作答案。分页时 factCounts 的 total/pending/unknown 统计全部事实；pending 是未完成操作、资源排队或待人工继续，unknown 是待核实的效果或停止（普通 MCP 人工结束后仍保留未核实效果）。本页未列出不表示整项无待办。processes 只给简要状态，原命令详情用 process_status；commands/services 精确事实由拥有者从原管理菜单查询。" })),
    }, { additionalProperties: false }),
    replay: "safe",
    executionMode: "sequential",
    async execute(input, api, context) {
      const execute = async () => {
        const { action, content, agent, label, work, delegation, appData, offset = 0, factsOffset = 0, operation } = input;
        const allowed = { delegate: ["content", "agent", "label", "delegation", "appData"], append: ["work", "content"], list: ["offset"], result: ["work", "offset", "factsOffset"], cancel: ["work"], close: ["agent"], delegations: ["offset"], progress: ["delegation", "offset"], cancel_delegation: ["delegation"], report: ["delegation"], report_result: ["delegation", "offset"], operations: ["work", "offset"], operation: ["operation", "offset"], redisplay: ["operation"] }[action];
        if (Object.keys(input).some(key => key !== "action" && !allowed.includes(key)) || (action === "delegate" && (!content?.trim() || (agent !== undefined && label !== undefined))) || ((action === "result" || action === "cancel" || action === "append") && work === undefined) || (action === "append" && !content?.trim()) || (action === "close" && agent === undefined) || (["progress", "cancel_delegation", "report", "report_result"].includes(action) && delegation === undefined) || ((action === "operation" || action === "redisplay") && operation === undefined)) throw new PersonalError("work_input_invalid", "参数组合无效，请按 action 描述仅提供该动作所需字段。");
        const live = await api.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context);
        const candidate = live?.run?.inputs.length === 1 ? await getHarness().submission(live.run.inputs[0], context) : undefined;
        const sourceRequestId = (await candidate?.status(context))?.requestId;
        const queryIdentity = async (tx: Tx) => {
          if (sourceRequestId === undefined) return undefined;
          const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, sourceRequestId);
          const original = submission?.entry === undefined ? undefined : await tx.entry(submission.entry);
          if (original && original.kind !== "pi.user" && original.kind !== PERSONAL_QUESTION_INPUT) return undefined;
          const value = await personalSource(tx, sourceRequestId);
          if (value.scheduled) return undefined;
          return value.telegram ? { telegram: value.telegram } : { local: true };
        };
        const result = await api.commit(async tx => {
          const source = await personalToolSource(tx, api, !["list", "result", "delegations", "progress", "report_result", "operations", "operation"].includes(action), sourceRequestId);
          if (action === "report_result") {
            const submission = sourceRequestId ? await tx.submissionByRequest(ROOT_CONVERSATION_ID, sourceRequestId) : undefined;
            const entry = submission?.entry ? await tx.entry(submission.entry) : undefined;
            if (entry?.kind === "ruukoto.delegation-report") return { next: "请用 progress 查询本委托成员，再用 result 分页读取业务结果并完成正文；本轮结束后由宿主处理发送，正文无需判断报告发送状态。" };
            return personalReportResult(tx, { entryId: delegation as EntryId }, offset);
          }
          if (action === "report") { await requestPersonalReport(tx, { entryId: delegation as EntryId }, source!, api.taskId); return { delegation, state: "report_registered", next: "已登记汇总安排，仍可接纳新成员或要求；宿主等本轮安排、已接纳工作与必要核实完成后发布当前结果。后续用 report_result 查询已发布报告。" }; }
          if (action === "delegations") {
            const page = await listPersonalDelegations(tx, offset);
            return { delegations: page.items.map(({ ref, report: _report, state: _state, ...value }) => ({ delegation: ref.entryId, ...value })), ...(page.more ? { nextOffset: offset + 8 } : {}) };
          }
          if (action === "progress") {
            const { ref, members, report: _report, state: _state, ...value } = await personalDelegationProgress(tx, { entryId: delegation as EntryId }, offset, await queryIdentity(tx));
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
            await registerPersonalReport(tx, group, source!, api.taskId, saved.delegationAdmission);
            return { work: ref.taskId, agent: ref.agentId, delegation: group.entryId, state: "registered", next: "已登记工作与自动汇总。本次返回的 work/delegation 编号本批其它调用看不到，续派须等返回后再用；仍可跨轮增加成员或要求。progress 查询委托、result 读取单项结果。" };
          }
          if (action === "append") {
            const ref = await personalWorkRef(tx, work as TaskId);
            const outcome = await appendPersonalWork(tx, ref, { requestId: `personal-note-tool:${api.taskId}`, content: content!, source: await personalWorkNoteSource(tx, source!, api.taskId) });
            if (!outcome.accepted && outcome.outcome === "completed") {
              const model = (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).model;
              if (!model) throw new PersonalError("model_unavailable", "当前模型缺失，请结束本轮并报告拥有者。");
              const continued = await continuePersonalAnalysis(tx, model, ref, { content: content!, requestId: `personal-continue-tool:${api.taskId}`, sourceRequestId: source!, modelCall: api.taskId });
              const saved = await tx.doc(PersonalWorkDoc, continued.ref.requestId, null);
              saved.modelCall = api.taskId;
              if (saved.delegationAdmission === undefined) saved.delegationAdmission = (await tx.appendEntry(PersonalAnalysisAdmission, ROOT_CONVERSATION_ID, { data: { work: continued.ref, delegation: continued.delegation, source: { ...saved.instructionSource! }, origin: { ...saved.source! }, permission: { ...saved.permission! }, ...(saved.telegram ? { telegram: { ...saved.telegram } } : {}), modelCall: api.taskId } })).id;
              await registerPersonalReport(tx, continued.delegation, source!, api.taskId, saved.delegationAdmission);
              return { predecessor: work, work: continued.ref.taskId, agent: continued.ref.agentId, delegation: continued.delegation.entryId, state: "continued", next: "原工作已完成且结果保留；本次要求已显式登记为同一子 Agent 的后续工作，权限保持原范围。只执行本次新增要求，不重复旧操作；宿主完成后自动发布后续结果。" };
            }
            if (!outcome.accepted) return { work, accepted: false, state: outcome.outcome, next: "原工作已结束，未接纳说明；用 result 查询原结果和停止状态。失败、取消或未知效果不能自动续接或重做。" };
            const saved = await tx.doc(PersonalWorkDoc, ref.requestId, null);
            if (saved.delegation) await registerPersonalReport(tx, saved.delegation, source!, api.taskId, saved.notes!.find(note => note.requestId === `personal-note-tool:${api.taskId}`)!.admission!);
            return { work, state: "note_accepted", next: "说明已归原工作，同一子 Agent 按接纳顺序继续处理，权限保持原范围；后续用 result 查询原结果。" };
          }
          if (action === "operations") {
            const page = await personalWorkToolFacts(tx, work as TaskId | undefined, offset, await queryIdentity(tx));
            return { operations: page.items, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}) };
          }
          if (action === "operation") {
            const detail = await personalToolFacts(tx, operation as TaskId, offset, await queryIdentity(tx));
            return { operation: detail.operation, text: detail.text, offset: detail.offset, ...(detail.nextOffset !== undefined ? { nextOffset: detail.nextOffset, next: detail.next } : {}) };
          }
          if (action === "redisplay") {
            const original = await personalSource(tx, source!, { active: true, invalidCode: "work_source_invalid" });
            if (original.scheduled) throw new PersonalError("work_source_invalid", "定时来源不能管理主聊天委托，请查询原运行。");
            return personalToolRedisplay(tx, operation as TaskId, original, api.taskId, await queryIdentity(tx));
          }
          if (action === "list") {
            const agents = (await tx.doc(PersonalAgentsDoc)).agents;
            return { agents: agents.slice(offset, offset + 16).map(value => ({ agent: value.id, label: value.label, closed: value.closed, ...(value.work ? { work: value.work.taskId } : {}) })), ...(offset + 16 < agents.length ? { nextOffset: offset + 16 } : {}) };
          }
          if (action === "close") { await closePersonalAgent(tx, agent as ConversationId); return { agent, state: "closed" }; }
          const ref = await personalWorkRef(tx, work as TaskId);
          if (action === "cancel") { await requestPersonalWorkCancel(tx, ref); return { cancel: ref }; }
          return personalWorkResult(tx, ref, offset, 4096, await queryIdentity(tx), factsOffset);
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
// Note: See .agents/notes/implemented/architecture/2026-11-02-personal-main-handoff.md
export async function personalWorkHandoff(tx: Tx, answer: EntryId, limit?: number, natural = false): Promise<string | undefined> {
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
  // payload cannot fit every detail; refused outcomes must stay visible.
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
    if (resultMessage?.role === "toolResult" && resultMessage.isError) { facts.push({ text: natural ? `这项安排未能完成：${resultText || "执行被拒绝"}` : `调用 ${call.name} 未生效：${resultText || "执行被拒绝"}`, short: `调用 ${call.name} 未生效`, refused: true }); continue; }
    if (natural && call.name === "background_work") {
      const parsed = (() => { try { const value: unknown = JSON.parse(resultText); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; } catch { return undefined; } })();
      const state = parsed?.state;
      const text = args.action === "delegate" ? "已安排后台处理，完成后会在这里发送结果" : args.action === "append" ? state === "note_accepted" ? "新要求已交给原工作继续处理" : state === "continued" ? "原结果已保留，已安排处理新增要求" : "原工作已结束，这次要求未能追加" : args.action === "cancel" || args.action === "cancel_delegation" ? "已登记取消，正在核实原执行停止；已经完成的操作仍保留" : args.action === "report" ? "已安排汇总，结果核实后会在这里发送" : args.action === "redisplay" ? "已安排重新显示原卡片" : "这项安排已记录";
      facts.push({ text, short: text, refused: args.action === "append" && state !== "note_accepted" && state !== "continued" });
      continue;
    }
    if (call.name === "background_work" && args.action === "report") facts.push({ text: `已登记委托 ${args.delegation} 的最终汇总安排，全部成员停止并核实后自动回报原入口`, short: `已登记委托${args.delegation}汇总安排`, refused: false });
    else if (call.name === "background_work" && args.action === "append") {
      // A completed call can still refuse admission (the work ended first); the persisted outcome,
      // not merely isError, decides whether the owner hears accepted or not-admitted.
      const parsed = (() => { try { const value = JSON.parse(resultText); return value && typeof value === "object" && !Array.isArray(value) ? value as { state?: unknown; work?: unknown; predecessor?: unknown } : undefined; } catch { return undefined; } })();
      if (parsed?.state === "note_accepted") facts.push({ text: `已补充工作 ${args.work} 的说明，同一子 Agent 按接纳顺序处理`, short: `已补充工作${args.work}说明`, refused: false });
      else if (parsed?.state === "continued" && typeof parsed.work === "number" && parsed.predecessor === args.work) facts.push({ text: `原工作 ${args.work} 的结果保留；已登记同一子 Agent 的后续工作 ${parsed.work}，只处理本次新要求`, short: `已登记工作${args.work}的后续工作${parsed.work}`, refused: false });
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
  let body = natural ? `${facts.map(fact => fact.text).join("；")}。` : `本轮以工具调用让出：${facts.map(fact => fact.text).join("；")}。`;
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
