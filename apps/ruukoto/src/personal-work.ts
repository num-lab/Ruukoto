import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, AssistantEntry, configure, defineDoc, defineDocFamily, defineExtension, defineTask, ROOT_CONVERSATION_ID, section, type ConversationId, type Cursor, type EntryId, type Harness, type ModelRef, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { permissionSnapshot, telegramSelection, telegramSourceActive, PersonalPermissionsDoc, type PersonalTelegramSource } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";
import { requirePersonalServiceSourceReady } from "./personal-service-operations.ts";
import { PersonalError } from "./personal-error.ts";
import { LocalInputDoc, personalInputDigest } from "./personal-local-records.ts";

type WorkResult = { submissionId: SubmissionId };
export type PersonalWorkRef = { requestId: string; taskId: TaskId<WorkResult>; agentId: ConversationId };
type AgentIndex = { id: ConversationId; label: string; closed: boolean; work?: PersonalWorkRef };
type NoteSource = { kind: "input"; requestId: string; submissionId: SubmissionId; entryId: EntryId; modelCall?: TaskId } | { kind: "local" } | { kind: "telegram" };
type WorkNote = { requestId: string; content: string; source: NoteSource; submissionId?: SubmissionId };
type WorkFacts = { notes?: WorkNote[]; fingerprint: string; ref?: PersonalWorkRef; source?: { requestId: string; submissionId: SubmissionId; entryId: EntryId }; submissionId?: SubmissionId; cancelRequested: boolean; permission?: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; modelCall?: TaskId };
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
      // Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-work-notes.md
      let start = -1;
      await runtime.commit(async tx => {
        const work = await facts(tx, ref);
        for (const [i, note] of (work.notes ?? []).entries()) if (await tx.submissionByRequest(ref.agentId, noteSubmissionKey(ref, note))) start = i;
        return undefined;
      }, context);
      for (let index = start; ; index++) {
        const latest = await runtime.snapshot(PersonalWorkDoc, task.input.requestId, context);
        const note = index < 0 ? undefined : latest?.notes?.[index];
        if (index >= 0 && !note) throw new PersonalError("work_note_missing", "后台分析的追加记录缺失，已保留占用；请检查档案。");
        const submission = await child.submit({ type: "input", content: note?.content ?? task.input.content, requestId: note ? noteSubmissionKey(ref, note) : `personal-work:${task.id}`, whenBusy: "reject" }, context);
        await runtime.commit(async tx => {
          const work = await facts(tx, ref);
          if (index < 0) work.submissionId = submission.id;
          else work.notes![index].submissionId = submission.id;
          return undefined;
        }, context);
        const watch = await runtime.watchDoc(PersonalWorkDoc, task.input.requestId, context);
        if (!watch) throw new PersonalError("work_missing", "后台工作的取消记录缺失，已保留占用；请检查档案。");
        let settled;
        try {
          const canceled = new Promise<undefined>((resolve, reject) => {
            const check = (value: typeof watch.value) => {
              if (!value?.ref || value.ref.taskId !== task.id) reject(new PersonalError("work_missing", "后台工作的取消归属无法核实，已保留占用；请检查档案。"));
              else if (value.cancelRequested) resolve(undefined);
            };
            watch.start(async value => { check(value); });
            check(watch.value);
            void watch.closed.then(() => reject(new PersonalError("work_wait_stopped", "后台工作等待已停止，请查询原工作；占用未核实前不能复用。")));
          });
          settled = await Promise.race([submission.wait(context), canceled]);
        } finally { await watch.stop(); }
        await child.abort(context, { background: true });
        let next = false;
        await runtime.commit(async tx => {
          const work = await facts(tx, ref);
          if (work.cancelRequested) {
            await release(tx, task.input, task.id);
            return { status: "terminal", outcome: { status: "aborted" } };
          }
          if (settled?.status === "done" && (work.notes?.length ?? 0) > index + 1) { next = true; return undefined; }
          await release(tx, task.input, task.id);
          return { status: "terminal", outcome: settled?.status === "done" ? { status: "completed", result: { submissionId: submission.id } } : { status: "failed", error: { message: "子会话未完成回答，后续说明未执行；请查询原输入记录。" }, result: { submissionId: submission.id } } };
        }, context);
        if (!next) return;
      }
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

export const personalWorkNotes = defineExtension({ name: "personal-work-notes" });
const noteSubmissionKey = (ref: PersonalWorkRef, note: WorkNote) => `personal-work:${ref.taskId}:note:${note.requestId}`;

export async function personalWorkNoteSource(tx: Tx, requestId: string, modelCall?: TaskId): Promise<NoteSource> {
  const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId);
  if (source?.type !== "input" || !["placed", "done"].includes(source.status) || !source.entry || (await tx.entry(source.entry))?.kind !== "pi.user") throw new PersonalError("work_source_invalid", "追加说明需要已进入主会话的拥有者输入，请查询原工作后重新提交。");
  return { kind: "input", requestId, submissionId: source.id, entryId: source.entry, ...(modelCall === undefined ? {} : { modelCall }) };
}

export async function appendPersonalWork(tx: Tx, ref: PersonalWorkRef, input: { requestId: string; content: string; source: NoteSource }) {
  if (!input.requestId || input.requestId.length > 256 || !input.content.trim() || Buffer.byteLength(input.content) > 16384) throw new PersonalError("work_input_invalid", "请输入非空追加说明，每条最多 16 KiB。说明只补充当前分析，不改变权限。");
  const work = await facts(tx, ref);
  const existing = work.notes?.find(note => note.requestId === input.requestId);
  if (existing) {
    if (existing.content !== input.content || !isDeepStrictEqual(existing.source, input.source)) throw new PersonalError("work_request_conflict", "同一追加请求的内容或来源不同，请查询原工作；不要换键自动重试。");
    return;
  }
  const task = await tx.task(ref.taskId);
  if (work.cancelRequested || !task || task.state.status === "terminal" || task.state.status === "completing" || task.abortRequested) throw new PersonalError("work_inactive", "原分析已结束或正在取消，未接纳说明；请查询原工作后决定下一步。");
  await occupancy(tx, { ...ref, content: "" }, ref.taskId);
  if (input.source.kind === "input") await requirePersonalServiceSourceReady(tx, input.source.requestId);
  if (input.source.kind === "input" && input.source.requestId.startsWith("telegram:")) {
    const receipt = (await tx.doc(PersonalTelegramReceiptDoc, input.source.requestId, null)).receipt;
    const source = receipt && permissionSnapshot(receipt);
    if (!source || !await telegramSourceActive(tx, source) || receipt?.submissionId !== input.source.submissionId || source.botId !== work.telegram?.botId || source.ownerId !== work.telegram.ownerId || source.generation !== work.telegram.generation) throw new PersonalError("work_original_entry_required", "此说明不属于原拥有者入口，未改变工作；请从原入口查询。");
  }
  if (work.telegram && !await telegramSourceActive(tx, work.telegram)) throw new PersonalError("work_source_inactive", "原拥有者入口已停用或变更，未接纳说明；请查询原工作。");
  if (work.source) await requirePersonalServiceSourceReady(tx, work.source.requestId);
  work.notes ??= [];
  work.notes.push({ ...input });
}

export async function verifyPersonalWorkNotes(tx: Tx, ref: PersonalWorkRef, enabled: boolean) {
  const work = await facts(tx, ref);
  if (!work.notes) return;
  if (!enabled || !Array.isArray(work.notes) || new Set(work.notes.map(note => note.requestId)).size !== work.notes.length) throw new PersonalError("work_note_invalid", "追加说明版本或请求关系无法核实，已停止恢复；请保留档案。");
  let previous = await tx.submissionByRequest(ref.agentId, `personal-work:${ref.taskId}`);
  for (const note of work.notes) {
    if (!note.requestId || note.requestId.length > 256 || !note.content?.trim() || Buffer.byteLength(note.content) > 16384) throw new PersonalError("work_note_invalid", "追加说明正文或请求缺失，已停止恢复；请保留档案。");
    if (note.requestId.startsWith("personal-note-tool:") && (note.source?.kind !== "input" || note.source.modelCall === undefined)) throw new PersonalError("work_note_invalid", "模型追加说明缺少原工具来源，已停止恢复；请保留档案。");
    if (!note.source) throw new PersonalError("work_note_invalid", "追加说明来源缺失，已停止恢复；请保留档案。");
    if (note.source.kind === "local") {
      const intent = await tx.doc(LocalInputDoc, note.requestId, "");
      if (intent.work !== ref.taskId || intent.digest !== personalInputDigest(note.content, ref.taskId)) throw new PersonalError("work_note_invalid", "追加说明的本机原请求不符，已停止恢复；请保留档案。");
    } else if (note.source.kind === "telegram") {
      const receipt = (await tx.doc(PersonalTelegramReceiptDoc, note.requestId, null)).receipt;
      const menu = receipt && (await telegramSelection(tx, receipt))?.selection;
      if (menu?.kind !== "work" || menu.ref.taskId !== ref.taskId || !receipt?.direct || !receipt.control || receipt.selection?.kind !== "work" || receipt.selection.ref.taskId !== ref.taskId || receipt.content !== `补充：${note.content}` || receipt.botId !== work.telegram?.botId || receipt.ownerId !== work.telegram.ownerId || receipt.generation !== work.telegram.generation) throw new PersonalError("work_note_invalid", "追加说明的 Telegram 原菜单或入口不符，已停止恢复；请保留档案。");
    } else if (note.source.kind === "input") {
      const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, note.source.requestId);
      if (source?.id !== note.source.submissionId || source.entry !== note.source.entryId || (await tx.entry(note.source.entryId))?.kind !== "pi.user") throw new PersonalError("work_note_invalid", "追加说明的拥有者原输入缺失，已停止恢复；请保留档案。");
      if (note.source.modelCall !== undefined) {
        const call = await tx.task(note.source.modelCall);
        const input = call?.input;
        const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
        const toolCall = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.id === (input && typeof input === "object" && !Array.isArray(input) ? input.callId : undefined));
        if (!assistant || assistant.conversationId !== ROOT_CONVERSATION_ID || assistant.byTaskId !== call?.owner || assistant.id <= note.source.entryId || toolCall?.type !== "toolCall" || toolCall.name !== "background_work" || toolCall.arguments.action !== "append" || toolCall.arguments.work !== ref.taskId || toolCall.arguments.content !== note.content || note.requestId !== `personal-note-tool:${note.source.modelCall}` || call?.kind !== "pi.tool" || call.conversationId !== ROOT_CONVERSATION_ID || !input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model") throw new PersonalError("work_note_invalid", "追加说明的模型工具来源不符，已停止恢复；请保留档案。");
      }
    } else throw new PersonalError("work_note_invalid", "追加说明来源不受支持，已停止恢复；请保留档案。");
    const submission = await tx.submissionByRequest(ref.agentId, noteSubmissionKey(ref, note));
    if (submission && previous?.status !== "done") throw new PersonalError("work_note_invalid", "追加说明越过了未完成的原轮次，已停止恢复；请保留档案。");
    const entry = submission?.entry && await tx.entry(submission.entry);
    const message = entry && entry.model?.[0];
    if ((note.submissionId !== undefined && note.submissionId !== submission?.id) || (submission && (submission.type !== "input" || (submission.entry && (entry?.kind !== "pi.user" || message?.role !== "user" || message.content !== note.content))))) throw new PersonalError("work_note_invalid", "追加说明的原生输入关系不符，已停止恢复；请保留档案。");
    previous = submission;
  }
  const task = await tx.task(ref.taskId);
  const result = task?.state.status === "terminal" && task.state.outcome.result;
  if (task?.state.status === "terminal" && task.state.outcome.status === "completed" && (previous?.status !== "done" || !result || typeof result !== "object" || Array.isArray(result) || result.submissionId !== previous.id)) throw new PersonalError("work_note_invalid", "追加说明的最终回答无法核实，已停止恢复；请保留档案。");
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

export async function personalWorkRef(tx: Tx, id: TaskId): Promise<PersonalWorkRef> {
  const task = await tx.task(id);
  const input = task?.input;
  if (task?.kind !== PersonalWorkTask.definition.name || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || !input || typeof input !== "object" || Array.isArray(input) || typeof input.requestId !== "string") throw new PersonalError("work_missing", "找不到此后台工作，请查询原工作列表。");
  const work = await tx.doc(PersonalWorkDoc, input.requestId, null);
  if (work.ref?.requestId !== input.requestId || work.ref.taskId !== id || work.ref.agentId !== input.agentId) throw new PersonalError("work_missing", "后台工作归属缺失，已停止；请报告拥有者检查档案。");
  return { ...work.ref };
}

export async function personalWorkStatus(tx: Tx, ref: PersonalWorkRef) {
  const work = await facts(tx, ref);
  const task = await tx.task(ref.taskId);
  if (!task || task.kind !== PersonalWorkTask.definition.name) throw new PersonalError("work_task_missing", "后台工作的执行记录缺失，请保留档案并检查存储。");
  const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === ref.agentId);
  if (!agent) throw new PersonalError("work_agent_missing", "后台工作的身份缺失，请保留档案并检查存储。");
  const last = work.notes?.at(-1);
  const submission = await tx.submissionByRequest(ref.agentId, last ? noteSubmissionKey(ref, last) : `personal-work:${ref.taskId}`);
  const stopVerified = task.state.status === "terminal" && ["completed", "failed", "aborted"].includes(task.state.outcome.status) && agent.work?.taskId !== ref.taskId;
  return { task, submission, cancelRequested: work.cancelRequested, stopVerified, notes: work.notes?.length ?? 0 };
}

export type PersonalWorkResult = { work: TaskId; state: string; cancelRequested?: boolean; next?: string; text?: string; nextOffset?: number };

export async function personalWorkResult(tx: Tx, ref: PersonalWorkRef, offset = 0, size = 4096): Promise<PersonalWorkResult> {
  const { task, submission, cancelRequested } = await personalWorkStatus(tx, ref);
  const state = task.state.status === "terminal" ? task.state.outcome.status : task.state.status;
  if (state !== "completed") return { work: ref.taskId, state, cancelRequested, next: task.state.status === "terminal" ? "工作未成功完成，后续已接纳说明未继续执行；请向拥有者报告，身份仍有占用时不要重试或复用。" : "工作尚未结束，请结束本轮，后续拥有者询问时再查询。" };
  const entry = submission?.status === "done" && submission.type === "input" ? await tx.entry(AssistantEntry, submission.answer) : undefined;
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") throw new PersonalError("work_answer_missing", "原工作的完整回答缺失，请停止引用结果并报告拥有者检查档案。");
  const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
  let end = Math.min(text.length, offset + size);
  if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1]) && /[\udc00-\udfff]/.test(text[end])) end--;
  return { work: ref.taskId, state, text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) };
}

export type PersonalWorkSummary = { ref: PersonalWorkRef; label: string; content: string; state: string; cancelRequested: boolean; stopVerified: boolean; closed: boolean; notes: number };

export async function personalWorkSummary(tx: Tx, ref: PersonalWorkRef): Promise<PersonalWorkSummary> {
  const status = await personalWorkStatus(tx, ref);
  const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === ref.agentId)!;
  const input = status.task.input;
  const content = input && typeof input === "object" && !Array.isArray(input) && input.content;
  if (typeof content !== "string") throw new PersonalError("work_missing", "后台工作说明缺失，请保留档案并检查存储。");
  return { ref, label: agent.label, content: content.slice(0, 160), state: status.task.state.status === "terminal" ? status.task.state.outcome.status : status.task.state.status, cancelRequested: status.cancelRequested, stopVerified: status.stopVerified, closed: agent.closed, notes: status.notes };
}

export async function listPersonalWorks(tx: Tx, offset = 0, source?: Pick<PersonalTelegramSource, "botId" | "ownerId" | "generation">) {
  const items: PersonalWorkSummary[] = [];
  let cursor: Cursor | undefined;
  let skipped = 0;
  do {
    const page = await tx.scanTasks({ kind: PersonalWorkTask.definition.name, order: "descending" }, 64, cursor);
    for (const task of page.items) {
      const ref = await personalWorkRef(tx, task.id);
      const work = await facts(tx, ref);
      if (source && (work.telegram?.botId !== source.botId || work.telegram.ownerId !== source.ownerId || work.telegram.generation !== source.generation)) continue;
      if (skipped++ < offset) continue;
      if (items.length === 8) return { items, nextOffset: offset + 8 };
      items.push(await personalWorkSummary(tx, ref));
    }
    cursor = page.next;
  } while (cursor);
  return { items };
}

export async function closePersonalWorkAgent(tx: Tx, ref: PersonalWorkRef) {
  await facts(tx, ref);
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: PersonalWorkTask.definition.name, order: "descending" }, 64, cursor);
    for (const task of page.items) {
      const other = await personalWorkRef(tx, task.id);
      if (other.agentId !== ref.agentId) continue;
      if (other.taskId !== ref.taskId) throw new PersonalError("work_menu_stale", "此身份已承接后续工作，请重新查询并选择；旧菜单没有关闭身份。");
      await closePersonalAgent(tx, ref.agentId);
      return;
    }
    cursor = page.next;
  } while (cursor);
  throw new PersonalError("work_missing", "后台工作记录缺失，未关闭身份；请检查档案。");
}

/** 可信宿主接口；子会话固定空工具，不能通过此接口获得外部操作权限。 */
export function personalWork(harness: Harness, model: ModelRef) {
  return {
    async delegate(input: DelegateInput): Promise<PersonalWorkRef> {
      const ref = await harness.commit(tx => delegatePersonalWork(tx, model, input), context);
      harness.resume();
      return ref;
    },
    async append(ref: PersonalWorkRef, input: { requestId: string; content: string; sourceRequestId: string }) {
      await harness.commit(async tx => appendPersonalWork(tx, ref, { requestId: input.requestId, content: input.content, source: await personalWorkNoteSource(tx, input.sourceRequestId) }), context);
    },
    async list() { return (await harness.snapshot(PersonalAgentsDoc, context))?.agents ?? []; },
    async status(ref: PersonalWorkRef) {
      return harness.commit(tx => personalWorkStatus(tx, ref), context);
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
  for (const note of work.notes ?? []) if (note.source.kind === "input") await requirePersonalServiceSourceReady(tx, note.source.requestId);
  const task = await tx.task(agent.work.taskId);
  if (!task || task.state.status === "terminal" || task.state.status === "completing" || task.abortRequested) throw new PersonalError("work_inactive", "子 Agent 的工作已停止或无法核实，已停止模型请求；请查询原工作。");
}
