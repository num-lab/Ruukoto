import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, configure, defineDoc, defineDocFamily, defineExtension, defineTask, ROOT_CONVERSATION_ID, section, type ConversationId, type EntryId, type Harness, type ModelRef, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { permissionSnapshot, telegramSourceActive, PersonalPermissionsDoc, type PersonalTelegramSource } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";
import { requirePersonalServiceSourceReady } from "./personal-service-operations.ts";
import { PersonalError } from "./personal-error.ts";

type WorkResult = { submissionId: SubmissionId };
export type PersonalWorkRef = { requestId: string; taskId: TaskId<WorkResult>; agentId: ConversationId };
type AgentIndex = { id: ConversationId; label: string; closed: boolean; work?: PersonalWorkRef };
type WorkFacts = { fingerprint: string; ref?: PersonalWorkRef; source?: { requestId: string; submissionId: SubmissionId; entryId: EntryId }; submissionId?: SubmissionId; cancelRequested: boolean; permission?: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; modelCall?: TaskId };
type WorkInput = { requestId: string; agentId: ConversationId; content: string };
const context = BACKGROUND_CONTEXT;
export const PersonalAgentsDoc = defineDoc<{ agents: AgentIndex[] }>({ kind: "ruukoto.subagents", scope: "session", version: 1, initial: () => ({ agents: [] }) });
export const PersonalWorkDoc = defineDocFamily<WorkFacts, null>({ kind: "ruukoto.work", scope: "session", version: 1, family: true, initial: () => ({ fingerprint: "", cancelRequested: false }) });

async function facts(tx: Tx, ref: PersonalWorkRef) {
  const work = await tx.doc(PersonalWorkDoc, ref.requestId, null);
  if (!work.ref || work.ref.taskId !== ref.taskId || work.ref.agentId !== ref.agentId) throw new PersonalError("work_missing", "找不到此后台工作，请查询原工作记录。");
  return work;
}

async function occupancy(tx: Tx, input: WorkInput, taskId: TaskId) {
  const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === input.agentId);
  if (!agent || agent.closed || agent.work?.taskId !== taskId) throw new PersonalError("work_ownership", "后台工作的占用记录不符，已保留现场；请检查档案。");
  return agent;
}

async function release(tx: Tx, input: WorkInput, taskId: TaskId) {
  const agent = await occupancy(tx, input, taskId);
  delete agent.work;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-background-work.md
export const PersonalWorkTask = defineTask<WorkInput, { phase: "run" }, WorkResult>({
  name: "ruukoto.background-work",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    async run(task, runtime, context) {
      const work = await runtime.snapshot(PersonalWorkDoc, task.input.requestId, context);
      const ref = work?.ref;
      if (!ref || ref.taskId !== task.id || ref.agentId !== task.input.agentId) throw new PersonalError("work_missing", "后台工作缺少归属记录，已停止；请检查档案。");
      await runtime.commit(async tx => { await occupancy(tx, task.input, task.id); return undefined; }, context);
      const child = await runtime.conversation(task.input.agentId, context);
      if (!child) throw new PersonalError("work_agent_missing", "后台工作的子会话缺失，已停止；请保留档案。");
      if (work.cancelRequested) {
        await child.abort(context, { background: true });
        await runtime.commit(async tx => { await release(tx, task.input, task.id); return { status: "terminal", outcome: { status: "aborted" } }; }, context);
        return;
      }
      // 原生受理不能与工作登记同 commit；恢复始终重接同一 submission。
      const submission = await child.submit({ type: "input", content: task.input.content, requestId: `personal-work:${task.id}`, whenBusy: "reject" }, context);
      await runtime.commit(async tx => { (await facts(tx, ref)).submissionId = submission.id; return undefined; }, context);
      const settled = await submission.wait(context);
      await child.abort(context, { background: true });
      await runtime.commit(async tx => {
        if ((await facts(tx, ref)).cancelRequested) {
          await release(tx, task.input, task.id);
          return { status: "terminal", outcome: { status: "aborted" } };
        }
        await release(tx, task.input, task.id);
        return { status: "terminal", outcome: settled.status === "done" ? { status: "completed", result: { submissionId: submission.id } } : { status: "failed", error: { message: "子会话未完成回答，请查询原输入记录。" }, result: { submissionId: submission.id } } };
      }, context);
    },
  },
  async abort(task, runtime, context) {
    await runtime.commit(async tx => { await occupancy(tx, task.input, task.id); (await facts(tx, { ...task.input, taskId: task.id })).cancelRequested = true; return undefined; }, context);
    const child = await runtime.conversation(task.input.agentId, context);
    if (!child) throw new PersonalError("work_agent_missing", "取消时找不到子会话，占用仍保留；请检查档案。");
    await child.abort(context, { background: true });
    await runtime.commit(async tx => { await release(tx, task.input, task.id); return { status: "terminal", outcome: { status: "aborted" } }; }, context);
  },
});

export const personalBackgroundWork = defineExtension({ name: "personal-background-work", tasks: [PersonalWorkTask] });
export const personalSubAgent = defineExtension({ name: "personal-subagent", sections: [section("subagent", () => "你是个人助手的子 Agent，只处理当前委派的工作并向主 Agent 返回结果。历史上下文可供参考，不代表新工作的授权。当前没有外部工具，无法委派或联系拥有者；需要外部操作时在结果中说明。", { tag: false })] });

type DelegateInput = { content: string; requestId: string; sourceRequestId: string; agentId?: ConversationId; label?: string };

export async function delegatePersonalWork(tx: Tx, model: ModelRef, input: DelegateInput): Promise<PersonalWorkRef> {
  if (!input.content.trim() || input.content.length > 16384 || !input.requestId || input.requestId.length > 256 || !input.sourceRequestId || input.sourceRequestId.length > 256 || (input.label !== undefined && (!input.label.trim() || input.label.length > 128))) throw new PersonalError("work_input_invalid", "工作说明、名称或请求引用无效，请缩短说明并使用原请求引用。");
  const fingerprint = createHash("sha256").update(JSON.stringify([input.content, input.sourceRequestId, input.agentId ?? null, input.label ?? null])).digest("hex");
  const work = await tx.doc(PersonalWorkDoc, input.requestId, null);
  if (work.ref) {
    if (work.fingerprint !== fingerprint) throw new PersonalError("work_request_conflict", "同一后台工作请求的内容不同，请查询原工作；不要换键自动重试。");
    return { ...work.ref };
  }
  const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, input.sourceRequestId);
  const entry = source?.entry && await tx.entry(source.entry);
  if (source?.type !== "input" || (source.status !== "placed" && source.status !== "done") || !entry || entry.kind !== "pi.user") throw new PersonalError("work_source_invalid", "后台工作需要已进入主会话的拥有者输入，不能使用回报、排队或失败的输入。");
  const receipt = input.sourceRequestId.startsWith("telegram:") ? (await tx.doc(PersonalTelegramReceiptDoc, input.sourceRequestId, null)).receipt : undefined;
  const telegram = receipt && permissionSnapshot(receipt);
  if (input.sourceRequestId.startsWith("telegram:") && (!telegram || receipt?.submissionId !== source.id || !await telegramSourceActive(tx, telegram))) throw new PersonalError("work_source_invalid", "原 Telegram 输入没有有效的拥有者权限快照，请由当前绑定拥有者重新提交委托。");
  await requirePersonalServiceSourceReady(tx, input.sourceRequestId);
  const permission = telegram ?? await tx.doc(PersonalPermissionsDoc);
  const index = await tx.doc(PersonalAgentsDoc);
  let agent = input.agentId && index.agents.find(agent => agent.id === input.agentId);
  if (input.agentId && !agent) throw new PersonalError("subagent_missing", "找不到此子 Agent，请查询已有身份。");
  if (agent && (agent.closed || agent.work)) throw new PersonalError(agent.closed ? "subagent_closed" : "subagent_busy", agent.closed ? "子 Agent 已关闭，历史仍保留；请选择其他身份。" : "子 Agent 仍被工作占用，请等待完成或取消核实后再委派。");
  if (!agent) {
    const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, child.id, { model, thinkingLevel: "off", extensions: [personalSubAgent, personalBackgroundWork], tools: [] });
    index.agents.push({ id: child.id, label: input.label ?? "子 Agent", closed: false });
    agent = index.agents[index.agents.length - 1];
  }
  const taskId = await tx.createTask(PersonalWorkTask, { requestId: input.requestId, agentId: agent.id, content: input.content }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
  const ref = { requestId: input.requestId, taskId, agentId: agent.id };
  agent.work = ref;
  work.fingerprint = fingerprint;
  work.ref = ref;
  work.source = { requestId: input.sourceRequestId, submissionId: source.id, entryId: entry.id };
  work.permission = { mode: permission.mode, version: permission.version };
  if (telegram) work.telegram = telegram;
  return ref;
}

export async function requestPersonalWorkCancel(tx: Tx, ref: PersonalWorkRef) {
  const work = await facts(tx, ref);
  const task = await tx.task(ref.taskId);
  if (!task) throw new PersonalError("work_task_missing", "后台工作的执行记录缺失，请保留档案并检查存储。");
  if (task.state.status !== "terminal") work.cancelRequested = true;
}

export async function closePersonalAgent(tx: Tx, id: ConversationId) {
  const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === id);
  if (!agent) throw new PersonalError("subagent_missing", "找不到此子 Agent，请查询已有身份。");
  if (agent.work) throw new PersonalError("subagent_busy", "子 Agent 仍被工作占用，请等待完成或取消核实后再关闭。");
  agent.closed = true;
}

/** 可信宿主接口；子会话固定空工具，不能通过此接口获得外部操作权限。 */
export function personalWork(harness: Harness, model: ModelRef) {
  return {
    async delegate(input: DelegateInput): Promise<PersonalWorkRef> {
      const ref = await harness.commit(tx => delegatePersonalWork(tx, model, input), context);
      harness.resume();
      return ref;
    },
    async list() { return (await harness.snapshot(PersonalAgentsDoc, context))?.agents ?? []; },
    async status(ref: PersonalWorkRef) {
      return harness.commit(async tx => {
        const work = await facts(tx, ref);
        const task = await tx.task(ref.taskId);
        if (!task || task.kind !== PersonalWorkTask.definition.name) throw new PersonalError("work_task_missing", "后台工作的执行记录缺失，请保留档案并检查存储。");
        const submission = await tx.submissionByRequest(ref.agentId, `personal-work:${ref.taskId}`);
        return { task, submission, cancelRequested: work.cancelRequested };
      }, context);
    },
    async cancel(ref: PersonalWorkRef) {
      await harness.commit(tx => requestPersonalWorkCancel(tx, ref), context);
      await harness.abortTask(ref.taskId, context);
      return harness.waitForTask(ref.taskId, context);
    },
    async closeAgent(id: ConversationId) {
      await harness.commit(tx => closePersonalAgent(tx, id), context);
    },
  };
}

export async function requirePersonalWorkRequest(tx: Tx, conversationId: ConversationId) {
  if (conversationId === ROOT_CONVERSATION_ID) return;
  const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === conversationId);
  if (!agent) {
    const extensions = (await tx.doc(AgentDoc, conversationId)).extensions;
    if (!Array.isArray(extensions) || extensions.includes(personalSubAgent.name)) throw new PersonalError("work_agent_missing", "子 Agent 的身份索引缺失，已停止模型请求；请检查档案。");
    return;
  }
  if (agent.closed || !agent.work || (await facts(tx, agent.work)).cancelRequested) throw new PersonalError("work_inactive", "子 Agent 没有可执行的活动工作，已停止模型请求；请查询工作状态。");
  const work = await facts(tx, agent.work);
  if (work.telegram && !await telegramSourceActive(tx, work.telegram)) throw new PersonalError("work_source_inactive", "原拥有者入口已停用或变更，后台工作已停止模型请求；请向拥有者报告并查询原工作。");
  if (work.source) await requirePersonalServiceSourceReady(tx, work.source.requestId);
  const task = await tx.task(agent.work.taskId);
  if (!task || task.state.status === "terminal" || task.state.status === "completing" || task.abortRequested) throw new PersonalError("work_inactive", "子 Agent 的工作已停止或无法核实，已停止模型请求；请查询原工作。");
}
