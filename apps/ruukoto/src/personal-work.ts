import { configureAppDataChild, requireWorkAppDataStopped, appDataOperations, appDataUnresolved, waitWorkAppData } from "./personal-app-data.ts";
import { PERSONAL_MEMORY, PERSONAL_MEMORY_TOOLS } from "./personal-memory.ts";
import { PERSONAL_HISTORY, PERSONAL_HISTORY_TOOLS } from "./personal-history.ts";
import { PERSONAL_SKILLS, PERSONAL_SKILL_TOOLS } from "./personal-skills.ts";
import { PERSONAL_MEDIA } from "./personal-media.ts";
import { PERSONAL_FILE_SEARCH } from "./personal-file-search.ts";
import { PERSONAL_TOOLS, PERSONAL_TOOL_NAMES, requireWorkToolsStopped, supersedePersonalToolOperations, personalWorkToolFacts, toolOperations, toolUnresolved, waitWorkTools, type ToolQueryIdentity } from "./personal-tools.ts";
import { isDeepStrictEqual } from "node:util";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { AgentDoc, AssistantEntry, configure, defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, ROOT_CONVERSATION_ID, section, type ConversationHandle, type ConversationId, type Cursor, type EntryId, type Harness, type ModelRef, type Submission, type SubmissionId, type SubmissionRecord, type TaskId, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { permissionSnapshot, telegramSelection, telegramSourceActive, type PersonalTelegramSource } from "./personal-permissions.ts";
import { samePersonalEntry, type PersonalEntryIdentity, isPersonalImRequest, PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";
import { PERSONAL_SERVICE_WORK, interruptedPersonalService, personalServiceOperationsIn, personalServiceResult, personalWorkServices, requirePersonalWorkServicesStopped, requirePersonalServiceSourceReady, waitPersonalServiceEffect, type PersonalServiceOperationRef } from "./personal-service-operations.ts";
import { PersonalError } from "./personal-error.ts";
import { LocalInputDoc, personalInputDigest } from "./personal-local-records.ts";
import { requirePersonalDelegationActive, requirePersonalDelegationOpen, requirePersonalDelegationReady, requirePersonalDelegationInput, type PersonalDelegationRef, type PersonalWorkSource } from "./personal-delegation.ts";
import { PersonalPendingInspectionsDoc, pendingWorkInspection } from "./personal-service-inspection.ts";
import { personalSubAgentServices } from "./personal-services.ts";
import { PERSONAL_COMMAND_WORK, personalCommandResult, personalWorkCommands, requirePersonalCommandsStopped, waitPersonalCommand } from "./personal-command-work.ts";

import { PERSONAL_MCP, PERSONAL_MCP_TOOLS, mcpOperations, mcpUnresolved, requireWorkMcpStopped, waitWorkMcp } from "./personal-mcp.ts";
import { personalSource } from "./personal-source.ts";
import { registerPersonalReportForAdmission } from "./personal-report.ts";
import { personalCoordinationCutoff } from "./personal-coordination.ts";
import { scheduledConversation, SCHEDULE_SUMMARY_INPUT } from "./personal-scheduler-records.ts";
import { LiveDoc } from "@earendil-works/pi-durable";

type WorkResult = { submissionId: SubmissionId };
export type PersonalWorkRef = { requestId: string; taskId: TaskId<WorkResult>; agentId: ConversationId };
type AgentIndex = { id: ConversationId; label: string; closed: boolean; work?: PersonalWorkRef };
type NoteSource = { kind: "input"; requestId: string; submissionId: SubmissionId; entryId: EntryId; modelCall?: TaskId } | { kind: "local" } | { kind: "telegram" | "qq" };
type WorkNote = { admission?: EntryId; requestId: string; content: string; source: NoteSource; submissionId?: SubmissionId };
type WorkFacts = { appData?: boolean; delegationAdmission?: EntryId; delegation?: PersonalDelegationRef; instructionSource?: PersonalWorkSource; continuation?: { version: 1; predecessor: PersonalWorkRef; admission: EntryId }; notes?: WorkNote[]; fingerprint: string; ref?: PersonalWorkRef; source?: PersonalWorkSource; submissionId?: SubmissionId; cancelRequested: boolean; permission?: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; modelCall?: TaskId };
type WorkInput = { requestId: string; agentId: ConversationId; content: string };
const context = BACKGROUND_CONTEXT;
export const PersonalWorkNoteAdmission = defineEntry<{ ref: PersonalWorkRef; requestId: string; content: string; source: NoteSource }>("ruukoto.work-note-admission");
export const PersonalWorkContinuation = defineEntry<{ version: 1; predecessor: PersonalWorkRef; work: PersonalWorkRef; source: PersonalWorkSource; modelCall: TaskId; content: string }>("ruukoto.work-continuation");
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
  await requirePersonalWorkServicesStopped(tx, taskId);
  await requirePersonalCommandsStopped(tx, taskId);
  await requireWorkMcpStopped(tx, taskId);
  await requireWorkToolsStopped(tx, taskId);
  if (await pendingWorkInspection(tx, taskId)) throw new PersonalError("work_stop_unverified", "子工作仍有未核实的检查，占用保留；请核实原检查停止。");
  await requireWorkAppDataStopped(tx, taskId);
  await configureAppDataChild(tx, agent.id, false);
  delete agent.work;
}

// Note: See .agents/notes/implemented/architecture/2026-10-17-personal-subagent-service-operations.md
async function settleServices(runtime: TaskRuntime<WorkInput, { phase: "run" }, WorkResult, object>, taskId: TaskId, context: Context, cancel: boolean) {
  let refs: PersonalServiceOperationRef[] = [];
  await runtime.commit(async tx => { refs = (await personalWorkServices(tx, taskId)).map(op => ({ ...op.ref })); return undefined; }, context);
  for (const ref of refs) {
    if (cancel) await runtime.abortOwned(ref.taskId, context);
    else await runtime.waitForTask(ref.taskId, context);
    await runtime.commit(async tx => { for (const value of await personalWorkServices(tx, taskId)) await interruptedPersonalService(tx, value); return undefined; }, context);
    await waitPersonalServiceEffect(runtime, ref, context);
  }
}

async function settleCommands(runtime: TaskRuntime<WorkInput, { phase: "run" }, WorkResult, object>, taskId: TaskId, context: Context, cancel: boolean) {
  let refs: import("./personal-command-work.ts").PersonalCommandRef[] = [];
  await runtime.commit(async tx => { refs = (await personalWorkCommands(tx, taskId)).map(op => ({ ...op.ref })); return undefined; }, context);
  for (const ref of refs) {
    if (cancel) await runtime.abortOwned(ref.taskId, context);
    else await runtime.waitForTask(ref.taskId, context);
    await waitPersonalCommand(runtime, ref, context);
  }
}

async function settleMcp(runtime: TaskRuntime<WorkInput, { phase: "run" }, WorkResult, object>, taskId: TaskId, context: Context) {
  let pending: TaskId[] = [];
  await runtime.commit(async tx => { pending = (await mcpOperations(tx)).filter(value => value.origin.work?.ref.taskId === taskId && mcpUnresolved(value)).map(value => value.operation); return undefined; }, context);
  await waitWorkMcp(runtime, pending, context);
}

async function settleTools(runtime: TaskRuntime<WorkInput, { phase: "run" }, WorkResult, object>, taskId: TaskId, context: Context) {
  let ids: TaskId[] = [];
  await runtime.commit(async tx => { ids = (await toolOperations(tx)).filter(value => value.origin.work?.ref.taskId === taskId && toolUnresolved(value)).map(value => value.operation); return undefined; }, context);
  await waitWorkTools(runtime, ids, taskId, context);
}

async function settleAppData(runtime: TaskRuntime<WorkInput, { phase: "run" }, WorkResult, object>, taskId: TaskId, context: Context) {
  let ids: TaskId[] = [];
  await runtime.commit(async tx => { ids = (await appDataOperations(tx)).filter(value => value.origin.work?.ref.taskId === taskId && appDataUnresolved(value)).map(value => value.operation); return undefined; }, context);
  await waitWorkAppData(runtime, ids, context);
}

async function settleWorkResources(runtime: TaskRuntime<WorkInput, { phase: "run" }, WorkResult, object>, child: ConversationHandle, taskId: TaskId, context: Context, cancel: boolean) {
  await child.abort(context, { background: true });
  await Promise.all([settleCommands(runtime, taskId, context, cancel), settleServices(runtime, taskId, context, cancel), settleMcp(runtime, taskId, context), settleTools(runtime, taskId, context), settleAppData(runtime, taskId, context)]);
  await waitForInspections(runtime, taskId, context);
}

// Note: See .agents/notes/implemented/architecture/2026-10-17-personal-subagent-inspection.md
async function waitForInspections(runtime: TaskRuntime<WorkInput, { phase: "run" }, WorkResult, object>, taskId: TaskId, context: Context) {
  while (true) {
    const watch = await runtime.watchDoc(PersonalPendingInspectionsDoc, context);
    if (!watch) return;
    try {
      const changed = new Promise<void>(resolve => { watch.start(async () => { resolve(); }); void watch.closed.then(() => resolve()); });
      let pending = false;
      await runtime.commit(async tx => { pending = await pendingWorkInspection(tx, taskId); return undefined; }, context);
      if (!pending) return;
      await changed;
    } finally { await watch.stop(); }
  }
}

// Note: See .agents/notes/implemented/architecture/2026-10-17-personal-background-work.md
// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-work-amendments.md
export const PersonalWorkTask = defineTask<WorkInput, { phase: "run" }, WorkResult>({
  name: "ruukoto.background-work",
  version: 3,
  initial: () => ({ phase: "run" }),
  phases: {
    async run(task, runtime, context) {
      const work = await runtime.snapshot(PersonalWorkDoc, task.input.requestId, context);
      const ref = work?.ref;
      if (!ref || ref.taskId !== task.id || ref.agentId !== task.input.agentId) throw new PersonalError("work_missing", "后台工作缺少归属记录，已停止；请检查档案。");
      await runtime.commit(async tx => { await occupancy(tx, task.input, task.id); return undefined; }, context);
      const child = await runtime.conversation(task.input.agentId, context);
      if (!child) throw new PersonalError("work_agent_missing", "后台工作的子会话缺失，已停止；请保留档案。");
      const collect = (cancel: boolean) => settleWorkResources(runtime, child, task.id, context, cancel);
      if (work.cancelRequested) {
        await collect(true);
        await runtime.commit(async tx => { await release(tx, task.input, task.id); return { status: "terminal", outcome: { status: "aborted" } }; }, context);
        return;
      }
      // Native submission follows work registration; recovery rejoins the original submission.
      // Only this supervisor submits accepted notes, in admission order, to the original child.
      // Note: See .agents/notes/implemented/architecture/2026-10-17-personal-work-notes.md
      type Tracked = { submission: Submission; wait: ReturnType<Submission["wait"]> };
      const tracked = new Map<number, Tracked>();
      const ORIGINAL = -1;
      const submit = async (index: number, note?: WorkNote) => {
        const submission = await child.submit({ type: "input", content: note?.content ?? task.input.content, requestId: note ? noteSubmissionKey(ref, note) : `personal-work:${task.id}`, whenBusy: index === ORIGINAL ? "reject" : "steer" }, context);
        await runtime.commit(async tx => {
          const work = await facts(tx, ref);
          if (index === ORIGINAL) {
            if (work.submissionId !== undefined && work.submissionId !== submission.id) throw new PersonalError("work_note_missing", "后台工作的原输入引用不符，已保留占用；请检查档案。");
            work.submissionId = submission.id;
          } else {
            const saved = work.notes?.[index];
            if (saved?.requestId !== note!.requestId || (saved.submissionId !== undefined && saved.submissionId !== submission.id)) throw new PersonalError("work_note_missing", "后台分析的追加记录缺失，已保留占用；请检查档案。");
            saved.submissionId = submission.id;
          }
          return undefined;
        }, context);
        const wait = submission.wait(context);
        // The same promise rejoins the race when the loop lands on it; a close-time rejection in between must count as observed, not unhandled.
        void wait.catch(() => undefined);
        tracked.set(index, { submission, wait });
      };
      // Collect resources after all submitted inputs settle; the final commit includes notes accepted during cleanup.
      // Note: See .agents/notes/implemented/architecture/2026-11-02-personal-work-note-supervision.md
      // Submit before watching; each loop snapshot also covers earlier notes and cancellation.
      await submit(ORIGINAL);
      let wakeResolve: (() => void) | undefined, wakeReject: ((error: unknown) => void) | undefined;
      // The original submission creates live state; without it queued work cannot wake safely.
      const liveWatch = await runtime.watchDoc(LiveDoc, task.input.agentId, context);
      if (!liveWatch) throw new PersonalError("work_missing", "子会话的运行记录缺失，已保留占用；请检查档案。");
      const workWatch = await runtime.watchDoc(PersonalWorkDoc, task.input.requestId, context);
      if (!workWatch) throw new PersonalError("work_missing", "后台工作的取消记录缺失，已保留占用；请检查档案。");
      const stopped = new PersonalError("work_wait_stopped", "后台工作等待已停止，请查询原工作；占用未核实前不能复用。");
      try {
        liveWatch.start(async () => wakeResolve?.());
        void liveWatch.closed.then(() => wakeReject?.(stopped));
        workWatch.start(async () => wakeResolve?.());
        void workWatch.closed.then(() => wakeReject?.(stopped));
        for (;;) {
          const latest = await runtime.snapshot(PersonalWorkDoc, task.input.requestId, context);
          if (!latest?.ref || latest.ref.taskId !== task.id || latest.ref.agentId !== task.input.agentId) throw new PersonalError("work_missing", "后台工作的归属记录缺失，已保留占用；请检查档案。");
          for (const [index, note] of (latest.notes ?? []).entries()) if (!tracked.has(index)) await submit(index, note);
          const statuses = new Map<number, SubmissionRecord>();
          for (const [index, value] of tracked) statuses.set(index, await value.submission.status(context));
          const unsettled = [...statuses].filter(([, record]) => record.status === "queued" || record.status === "placed");
          if (latest.cancelRequested) {
            await collect(true);
            await runtime.commit(async tx => { await release(tx, task.input, task.id); return { status: "terminal", outcome: { status: "aborted" } }; }, context);
            return;
          }
          // A queued input with no live run is failed-run residue, not permission to replay.
          if ([...statuses.values()].some(record => record.status === "unanswered") || (unsettled.some(([, record]) => record.status === "queued") && !(await runtime.snapshot(LiveDoc, task.input.agentId, context))?.run)) {
            await collect(true);
            await runtime.commit(async tx => {
              const work = await facts(tx, ref);
              await release(tx, task.input, task.id);
              if (work.cancelRequested) return { status: "terminal", outcome: { status: "aborted" } };
              const last = [...statuses].reverse().find(([, record]) => record.status !== "queued")![1].id;
              return { status: "terminal", outcome: { status: "failed", error: { message: "子会话未完成回答，后续说明未执行；请查询原输入记录。" }, result: { submissionId: last } } };
            }, context);
            return;
          }
          if (!unsettled.length) {
            await collect(false);
            let resume = false;
            await runtime.commit(async tx => {
              const work = await facts(tx, ref);
              await occupancy(tx, task.input, task.id);
              if (work.cancelRequested) {
                await release(tx, task.input, task.id);
                return { status: "terminal", outcome: { status: "aborted" } };
              }
              if ((work.notes?.length ?? 0) > tracked.size - 1) { resume = true; return undefined; }
              await release(tx, task.input, task.id);
              const last = tracked.get(Math.max(...tracked.keys()))!;
              return { status: "terminal", outcome: { status: "completed", result: { submissionId: last.submission.id } } };
            }, context);
            if (!resume) return;
            continue;
          }
          const wake = new Promise<void>((resolve, reject) => { wakeResolve = resolve; wakeReject = reject; });
          try { await Promise.race([wake, ...unsettled.map(([index]) => tracked.get(index)!.wait)]); }
          finally { wakeResolve = undefined; wakeReject = undefined; }
        }
      } finally { wakeResolve = undefined; wakeReject = undefined; await workWatch.stop(); await liveWatch.stop(); }
    },
  },
  async abort(task, runtime, context) {
    await runtime.commit(async tx => { await occupancy(tx, task.input, task.id); (await facts(tx, { ...task.input, taskId: task.id })).cancelRequested = true; return undefined; }, context);
    const child = await runtime.conversation(task.input.agentId, context);
    if (!child) throw new PersonalError("work_agent_missing", "取消时找不到子会话，占用仍保留；请检查档案。");
    await settleWorkResources(runtime, child, task.id, context, true);
    await runtime.commit(async tx => { await release(tx, task.input, task.id); return { status: "terminal", outcome: { status: "aborted" } }; }, context);
  },
});

export const personalBackgroundWork = defineExtension({ name: "personal-background-work", tasks: [PersonalWorkTask] });
export const personalSubAgent = defineExtension({ name: "personal-subagent", sections: [section("subagent", () => "你是个人助手的子 Agent，只处理当前委派的工作并向主 Agent 返回结果。历史上下文可供参考，不代表新工作的授权。仅使用本轮提供的工具，无法再委派或联系拥有者；需要不可用的外部操作时在结果中说明。外部操作效果或停止未核实时，宿主暂停整项委托的后续操作并保留占用；由拥有者核实后收尾，不要换方式重试。", { tag: false })] });

type DelegateInput = { content: string; requestId: string; sourceRequestId: string; agentId?: ConversationId; label?: string; appData?: boolean };

export async function delegatePersonalWork(tx: Tx, model: ModelRef, input: DelegateInput): Promise<PersonalWorkRef> {
  if (input.appData !== undefined && typeof input.appData !== "boolean" || !input.content.trim() || input.content.length > 16384 || !input.requestId || input.requestId.length > 256 || !input.sourceRequestId || input.sourceRequestId.length > 256 || (input.label !== undefined && (!input.label.trim() || input.label.length > 128))) throw new PersonalError("work_input_invalid", "工作说明、名称或请求引用无效，请缩短说明并使用原请求引用。");
  const fingerprint = createHash("sha256").update(JSON.stringify([input.content, input.sourceRequestId, input.agentId ?? null, input.label ?? null, ...(input.appData === undefined ? [] : [input.appData])])).digest("hex");
  const work = await tx.doc(PersonalWorkDoc, input.requestId, null);
  if (work.ref) {
    if (work.fingerprint !== fingerprint) throw new PersonalError("work_request_conflict", "同一后台工作请求的内容不同，请查询原工作；不要换键自动重试。");
    return { ...work.ref };
  }
  const origin = await personalSource(tx, input.sourceRequestId, { active: true, invalidCode: "work_source_invalid" });
  // A placed-but-cut-off input is still "active" until the cutoff settle lands; the fence keeps any
  // admission (host or model path) out of its cancelled set.
  if (await personalCoordinationCutoff(tx, input.sourceRequestId)) throw new PersonalError("work_source_invalid", "原工作输入已超出协调批次并停止，未接纳新子工作；请查询原工作。");
  const { submission: source, entry, telegram, permission } = origin;
  if (origin.scheduled && origin.run.sealed) throw new PersonalError("work_source_sealed", "定时运行已封组收尾，未接纳新子工作；请查询本次运行并结束本轮。");
  await requirePersonalServiceSourceReady(tx, input.sourceRequestId);
  const index = await tx.doc(PersonalAgentsDoc);
  let agent = input.agentId && index.agents.find(agent => agent.id === input.agentId);
  if (input.agentId && !agent) throw new PersonalError("subagent_missing", "找不到此子 Agent，请查询已有身份。");
  if (agent && (agent.closed || agent.work)) throw new PersonalError(agent.closed ? "subagent_closed" : "subagent_busy", agent.closed ? "子 Agent 已关闭，历史仍保留；请选择其他身份。" : "子 Agent 仍被工作占用，请等待完成或取消核实后再委派。");
  if (!agent) {
    const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const main = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID);
    const services = Array.isArray(main.extensions) && main.extensions.includes(personalSubAgentServices.name);
    await configure(tx, child.id, { model, thinkingLevel: "off", extensions: [personalSubAgent, personalBackgroundWork], tools: [] });
    if (services) {
      const config = await tx.doc(AgentDoc, child.id);
      config.extensions = [personalSubAgent.name, personalBackgroundWork.name, "personal-service-inspect", personalSubAgentServices.name];
      config.tools = ["service_inspect", "read_service_inspection"];
      if (Array.isArray(main.extensions) && main.extensions.includes(PERSONAL_SERVICE_WORK)) {
        config.extensions.push(PERSONAL_SERVICE_WORK);
        config.tools.push("service_restart", "read_service_operation");
      }
    }
    if (Array.isArray(main.extensions) && main.extensions.includes(PERSONAL_COMMAND_WORK)) {
      const config = await tx.doc(AgentDoc, child.id);
      if (!Array.isArray(config.extensions) || !Array.isArray(config.tools)) throw new PersonalError("work_config_changed", "子会话的工具配置无法核实，请保留档案。");
      config.extensions.push(PERSONAL_COMMAND_WORK);
      config.tools.push("run_command", "read_command_output");
    }
    if (Array.isArray(main.extensions) && main.extensions.includes(PERSONAL_MCP)) {
      const config = await tx.doc(AgentDoc, child.id);
      if (!Array.isArray(config.extensions) || !Array.isArray(config.tools)) throw new PersonalError("work_config_changed", "子会话的 MCP 工具配置无法核实，请保留档案。");
      config.extensions.push(PERSONAL_MCP);
      config.tools.push(...PERSONAL_MCP_TOOLS);
    }
    if (Array.isArray(main.extensions) && main.extensions.includes(PERSONAL_TOOLS)) {
      const config = await tx.doc(AgentDoc, child.id);
      if (!Array.isArray(config.extensions) || !Array.isArray(config.tools)) throw new PersonalError("work_config_changed", "子会话工具配置无法核实，请保留档案。");
      config.extensions.push(PERSONAL_TOOLS, ...(main.extensions.includes(PERSONAL_FILE_SEARCH) ? [PERSONAL_FILE_SEARCH] : [])); config.tools.push(...PERSONAL_TOOL_NAMES.filter(name => Array.isArray(main.tools) && main.tools.includes(name)));
    }
    if (Array.isArray(main.extensions) && main.extensions.includes(PERSONAL_MEDIA)) {
      const config = await tx.doc(AgentDoc, child.id);
      if (!Array.isArray(config.extensions)) throw new PersonalError("work_config_changed", "子会话扩展配置无法核实，请保留档案。");
      config.extensions.splice(2, 0, PERSONAL_MEDIA);
    }
    for (const [extension, tools] of [[PERSONAL_SKILLS, PERSONAL_SKILL_TOOLS], [PERSONAL_HISTORY, PERSONAL_HISTORY_TOOLS], [PERSONAL_MEMORY, PERSONAL_MEMORY_TOOLS]] as const) if (Array.isArray(main.extensions) && main.extensions.includes(extension)) {
      const config = await tx.doc(AgentDoc, child.id);
      if (!Array.isArray(config.extensions) || !Array.isArray(config.tools)) throw new PersonalError("work_config_changed", "子会话参考工具配置无法核实，请保留档案。");
      config.extensions.push(extension); config.tools.unshift(...tools);
    }
    index.agents.push({ id: child.id, label: input.label ?? "子 Agent", closed: false });
    agent = index.agents[index.agents.length - 1];
  }
  const taskId = await tx.createTask(PersonalWorkTask, { requestId: input.requestId, agentId: agent.id, content: input.content }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
  const ref = { requestId: input.requestId, taskId, agentId: agent.id };
  agent.work = ref;
  if (input.appData !== undefined) work.appData = input.appData;
  await configureAppDataChild(tx, agent.id, input.appData === true);
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
  const value = await personalSource(tx, requestId, { active: true, invalidCode: "work_source_invalid" });
  if (await personalCoordinationCutoff(tx, requestId)) throw new PersonalError("work_source_invalid", "原工作输入已超出协调批次并停止，未接纳新子工作；请查询原工作。");
  if (value.scheduled) throw new PersonalError("work_source_invalid", "定时来源不能追加主聊天工作，请查询原运行。");
  return { kind: "input", ...value.source, ...(modelCall === undefined ? {} : { modelCall }) };
}

export type PersonalWorkAppendOutcome = { accepted: true } | { accepted: false; outcome: "completed" | "failed" | "aborted" | "faulted" | "orphaned" };

// Admission records identity and ownership; the model-request gate owns execution readiness.
// Note: See .agents/notes/implemented/architecture/2026-10-17-personal-work-notes.md
// Note: See .agents/notes/implemented/architecture/2026-11-02-personal-work-note-supervision.md
// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-work-amendments.md
export async function appendPersonalWork(tx: Tx, ref: PersonalWorkRef, input: { requestId: string; content: string; source: NoteSource }): Promise<PersonalWorkAppendOutcome> {
  if (!input.requestId || input.requestId.length > 256 || !input.content.trim() || Buffer.byteLength(input.content) > 16384) throw new PersonalError("work_input_invalid", "请输入非空追加说明，每条最多 16 KiB。说明只补充当前分析，不改变权限。");
  const work = await facts(tx, ref);
  const existing = work.notes?.find(note => note.requestId === input.requestId);
  if (existing) {
    if (existing.content !== input.content || !isDeepStrictEqual(existing.source, input.source)) throw new PersonalError("work_request_conflict", "同一追加请求的内容或来源不同，请查询原工作；不要换键自动重试。");
    return { accepted: true };
  }
  const task = await tx.task(ref.taskId);
  if (task?.state.status === "terminal" || task?.state.status === "completing") return { accepted: false, outcome: task.state.outcome.status };
  if (work.cancelRequested || !task || task.abortRequested) throw new PersonalError("work_inactive", "原分析已结束或正在取消，未接纳说明；请查询原工作后决定下一步。");
  if (work.source) { const origin = await personalSource(tx, work.source.requestId, { active: true }); if (origin.scheduled && origin.run.sealed) throw new PersonalError("work_source_sealed", "本次定时运行已封组，未接纳新说明；请查询原运行。新工作由拥有者另行提交。"); }
  await occupancy(tx, { ...ref, content: "" }, ref.taskId);
  if (work.delegation) await requirePersonalDelegationActive(tx, work.delegation);
  if (work.delegation) await requirePersonalDelegationOpen(tx, work.delegation);
  if (work.delegation && input.source.kind === "input") await requirePersonalDelegationInput(tx, work.delegation, input.source.requestId);
  if (input.source.kind === "input") { const source = await personalSource(tx, input.source.requestId, { active: true }); if (source.submission.id !== input.source.submissionId || source.entry.id !== input.source.entryId || (source.telegram && !samePersonalEntry(source.telegram, work.telegram))) throw new PersonalError("work_original_entry_required", "此说明不属于原拥有者入口，请从原入口查询。"); if (await personalCoordinationCutoff(tx, input.source.requestId)) throw new PersonalError("work_source_inactive", "原工作输入已超出协调批次并停止，未接纳说明；请查询原工作。"); }
  if (work.telegram && !await telegramSourceActive(tx, work.telegram)) throw new PersonalError("work_source_inactive", "原拥有者入口已停用或变更，未接纳说明；请查询原工作。");
  work.notes ??= [];
  const admission = (await tx.appendEntry(PersonalWorkNoteAdmission, ROOT_CONVERSATION_ID, { data: { ref: { ...ref }, ...input } })).id;
  work.notes.push({ ...input, admission });
  await supersedePersonalToolOperations(tx, ref.taskId, admission);
  if (work.delegation) await registerPersonalReportForAdmission(tx, work.delegation, admission);
  return { accepted: true };
}

// Note: See .agents/notes/implemented/architecture/2026-11-02-personal-work-note-supervision.md
export async function verifyPersonalWorkNotes(tx: Tx, ref: PersonalWorkRef, enabled: boolean) {
  const work = await facts(tx, ref);
  if (!work.notes) return;
  if (!enabled || !Array.isArray(work.notes) || new Set(work.notes.map(note => note.requestId)).size !== work.notes.length) throw new PersonalError("work_note_invalid", "追加说明版本或请求关系无法核实，已停止恢复；请保留档案。");
  const task = await tx.task(ref.taskId);
  // Version 2 permits overlapping inputs/shared answers; version 1 retains sequential-round verification.
  const supervised = task !== undefined && task.version !== undefined && task.version >= 2;
  let previous = await tx.submissionByRequest(ref.agentId, `personal-work:${ref.taskId}`);
  let gap = previous === undefined, allDone = previous?.status === "done";
  for (const note of work.notes) {
    if (work.delegation || note.admission !== undefined) {
      const admission = note.admission && await tx.entry(PersonalWorkNoteAdmission, note.admission);
      if (!admission || admission.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(admission.data, { ref, requestId: note.requestId, content: note.content, source: note.source })) throw new PersonalError("work_note_invalid", "追加说明的原接纳证据不符，已停止恢复；请保留档案。");
    }
    if (!note.requestId || note.requestId.length > 256 || !note.content?.trim() || Buffer.byteLength(note.content) > 16384) throw new PersonalError("work_note_invalid", "追加说明正文或请求缺失，已停止恢复；请保留档案。");
    if (note.requestId.startsWith("personal-note-tool:") && (note.source?.kind !== "input" || note.source.modelCall === undefined)) throw new PersonalError("work_note_invalid", "模型追加说明缺少原工具来源，已停止恢复；请保留档案。");
    if (!note.source) throw new PersonalError("work_note_invalid", "追加说明来源缺失，已停止恢复；请保留档案。");
    if (note.source.kind === "local") {
      const intent = await tx.doc(LocalInputDoc, note.requestId, "");
      if (intent.work !== ref.taskId || intent.digest !== personalInputDigest(note.content, ref.taskId)) throw new PersonalError("work_note_invalid", "追加说明的本机原请求不符，已停止恢复；请保留档案。");
    } else if (note.source.kind === "telegram" || note.source.kind === "qq") {
      const receipt = (await tx.doc(PersonalTelegramReceiptDoc, note.requestId, null)).receipt;
      const menu = receipt && (await telegramSelection(tx, receipt))?.selection;
      if (menu?.kind !== "work" || menu.ref.taskId !== ref.taskId || !receipt?.direct || !receipt.control || receipt.selection?.kind !== "work" || receipt.selection.ref.taskId !== ref.taskId || receipt.content !== `补充：${note.content}` || !samePersonalEntry(receipt, work.telegram) || (receipt.platform ?? "telegram") !== note.source.kind) throw new PersonalError("work_note_invalid", "追加说明的拥有者原菜单或入口不符，已停止恢复；请保留档案。");
    } else if (note.source.kind === "input") {
      const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, note.source.requestId);
      if (source?.id !== note.source.submissionId || source.entry !== note.source.entryId || !isDeepStrictEqual((await personalSource(tx, note.source.requestId)).source, { requestId: note.source.requestId, submissionId: note.source.submissionId, entryId: note.source.entryId })) throw new PersonalError("work_note_invalid", "追加说明的拥有者原输入缺失，已停止恢复；请保留档案。");
      if (note.source.modelCall !== undefined) {
        const call = await tx.task(note.source.modelCall);
        const input = call?.input;
        const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
        const toolCall = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.id === (input && typeof input === "object" && !Array.isArray(input) ? input.callId : undefined));
        if (!assistant || assistant.conversationId !== ROOT_CONVERSATION_ID || assistant.byTaskId !== call?.owner || assistant.id <= note.source.entryId || toolCall?.type !== "toolCall" || toolCall.name !== "background_work" || toolCall.arguments.action !== "append" || toolCall.arguments.work !== ref.taskId || toolCall.arguments.content !== note.content || note.requestId !== `personal-note-tool:${note.source.modelCall}` || call?.kind !== "pi.tool" || call.conversationId !== ROOT_CONVERSATION_ID || !input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model") throw new PersonalError("work_note_invalid", "追加说明的模型工具来源不符，已停止恢复；请保留档案。");
      }
    } else throw new PersonalError("work_note_invalid", "追加说明来源不受支持，已停止恢复；请保留档案。");
    const submission = await tx.submissionByRequest(ref.agentId, noteSubmissionKey(ref, note));
    if (!supervised && submission && previous?.status !== "done") throw new PersonalError("work_note_invalid", "追加说明越过了未完成的原轮次，已停止恢复；请保留档案。");
    if (supervised && submission && (gap || submission.id <= previous!.id)) throw new PersonalError("work_note_invalid", "追加说明越过了未接纳的原输入或原生键顺序不符，已停止恢复；请保留档案。");
    const entry = submission?.entry && await tx.entry(submission.entry);
    const message = entry && entry.model?.[0];
    if ((note.submissionId !== undefined && note.submissionId !== submission?.id) || (submission && (submission.type !== "input" || (submission.entry && (entry?.kind !== "pi.user" || message?.role !== "user" || message.content !== note.content))))) throw new PersonalError("work_note_invalid", "追加说明的原生输入关系不符，已停止恢复；请保留档案。");
    if (submission === undefined) { if (supervised) gap = true; else previous = submission; }
    else { previous = submission; allDone &&= submission.status === "done"; }
  }
  const result = task?.state.status === "terminal" && task.state.outcome.result;
  const chain = supervised ? !gap && previous !== undefined && allDone : previous?.status === "done";
  if (task?.state.status === "terminal" && task.state.outcome.status === "completed" && (!chain || !result || typeof result !== "object" || Array.isArray(result) || result.submissionId !== previous!.id)) throw new PersonalError("work_note_invalid", "追加说明的最终回答无法核实，已停止恢复；请保留档案。");
}

export async function requestPersonalWorkCancel(tx: Tx, ref: PersonalWorkRef) {
  const work = await facts(tx, ref);
  const task = await tx.task(ref.taskId);
  if (!task) throw new PersonalError("work_task_missing", "后台工作的执行记录缺失，请保留档案并检查存储。");
  if (task.state.status !== "terminal") {
    work.cancelRequested = true;
    for (const op of await personalWorkServices(tx, ref.taskId)) if ((await tx.task(op.ref.taskId))?.state.status !== "terminal") op.cancelRequested = true;
    for (const op of await personalWorkCommands(tx, ref.taskId)) if ((await tx.task(op.ref.taskId))?.state.status !== "terminal") op.cancelRequested = true;
  }
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

// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-work-amendments.md
export async function requirePersonalWorkContinuation(tx: Tx, ref: PersonalWorkRef) {
  const status = await personalWorkStatus(tx, ref);
  const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === ref.agentId)!;
  if (status.task.state.status !== "terminal" || status.task.state.outcome.status !== "completed" || status.cancelRequested || !status.stopVerified || agent.closed || agent.work) throw new PersonalError("work_continuation_unavailable", "原工作尚未安全完成或子 Agent 正被占用，未接纳后续工作；请查询原结果和停止状态，不能重做原操作。");
  await requirePersonalWorkServicesStopped(tx, ref.taskId);
  await requirePersonalCommandsStopped(tx, ref.taskId);
  await requireWorkMcpStopped(tx, ref.taskId);
  await requireWorkToolsStopped(tx, ref.taskId);
  await requireWorkAppDataStopped(tx, ref.taskId);
  if (await pendingWorkInspection(tx, ref.taskId)) throw new PersonalError("work_continuation_unavailable", "原工作仍有待核实检查，未接纳后续工作；请查询原检查并核实停止。");
}

async function workServiceResults(tx: Tx, taskId: TaskId) {
  const results = [];
  for (const op of await personalWorkServices(tx, taskId)) results.push(personalServiceResult(op, (await tx.task(op.ref.taskId))?.state.status === "terminal"));
  return results;
}

// Note: See .agents/notes/implemented/architecture/2026-10-17-personal-subagent-service-operations.md
export async function personalServiceTranscriptFacts(tx: Tx, conversationId: ConversationId, input: TranscriptContext) {
  const messages = input.messages.filter(message => message.role === "toolResult").filter(message => message.toolName === "service_restart");
  if (!messages.length || conversationId === ROOT_CONVERSATION_ID || !(await tx.doc(PersonalAgentsDoc)).agents.some(agent => agent.id === conversationId && agent.work && !agent.closed)) return [];
  const matched = new Set<typeof messages[number]>(), results = [];
  const invalid = () => new PersonalError("service_model_reference_invalid", "原服务工具结果无法核实，已停止模型请求；请保留档案并检查原工作。");
  for (const op of await personalServiceOperationsIn(tx)) {
    if (op.work?.ref.agentId !== conversationId) continue;
    const task = await tx.task(op.work.tool), tool = task?.input;
    if (!task || task.kind !== "pi.tool" || task.conversationId !== conversationId || !tool || typeof tool !== "object" || Array.isArray(tool) || tool.kind !== "model") throw invalid();
    if (!messages.some(message => message.toolCallId === tool.callId) || task.state.status !== "terminal") continue;
    const result = task.state.outcome.result;
    const entry = result && typeof result === "object" && !Array.isArray(result) && typeof result.entryId === "number" ? await tx.entry(result.entryId as EntryId) : undefined;
    if (!entry || entry.kind !== "pi.tool-result" || entry.conversationId !== conversationId || entry.byTaskId !== op.work.tool || !entry.model?.some(message => message.role === "toolResult" && message.toolCallId === tool.callId && message.toolName === "service_restart")) throw invalid();
    const selected = messages.filter(message => entry.model!.some(original => isDeepStrictEqual(original, message)));
    if (!selected.length) {
      const assistant = typeof tool.assistant === "number" ? await tx.entry(tool.assistant as EntryId) : undefined;
      if (!assistant || assistant.kind !== "pi.assistant" || assistant.conversationId !== conversationId || !assistant.model?.some(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === tool.callId && part.name === "service_restart"))) throw invalid();
      if (input.messages.some(message => assistant.model!.some(original => isDeepStrictEqual(original, message)))) throw invalid();
      continue;
    }
    if (selected.length !== 1 || matched.has(selected[0])) throw invalid();
    matched.add(selected[0]); results.push(personalServiceResult(op, (await tx.task(op.ref.taskId))?.state.status === "terminal"));
  }
  let cursor: Cursor | undefined;
  while (matched.size < messages.length) {
    const page = await tx.scanTasks({ conversationId, kind: "pi.tool", status: "terminal" }, 256, cursor);
    for (const task of page.items) {
      const tool = task.input;
      if (!tool || typeof tool !== "object" || Array.isArray(tool) || tool.kind !== "model" || !messages.some(message => !matched.has(message) && message.toolCallId === tool.callId)) continue;
      const result = task.state.status === "terminal" && task.state.outcome.result;
      const entry = result && typeof result === "object" && !Array.isArray(result) && typeof result.entryId === "number" ? await tx.entry(result.entryId as EntryId) : undefined;
      const selected = messages.filter(message => !matched.has(message) && entry?.model?.some(original => isDeepStrictEqual(original, message)));
      if (!selected.length) continue;
      const assistant = typeof tool.assistant === "number" ? await tx.entry(tool.assistant as EntryId) : undefined;
      if (!entry || entry.kind !== "pi.tool-result" || entry.conversationId !== conversationId || entry.byTaskId !== task.id || !assistant || assistant.kind !== "pi.assistant" || assistant.conversationId !== conversationId || !assistant.model?.some(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === tool.callId && part.name === "service_restart"))) throw invalid();
      if (selected.length !== 1) throw invalid();
      matched.add(selected[0]);
    }
    cursor = page.next;
    if (!cursor) break;
  }
  if (matched.size !== messages.length) throw invalid();
  return results;
}

export type PersonalWorkResult = { work: TaskId; state: string; cancelRequested?: boolean; next?: string; text?: string; offset?: number; totalChars?: number; partial?: boolean; commands?: ReturnType<typeof personalCommandResult>[]; services?: ReturnType<typeof personalServiceResult>[]; tools?: Awaited<ReturnType<typeof personalWorkToolFacts>>; notice?: string; nextOffset?: number; notes?: { requestId: string; state: string }[] };

export async function personalWorkResult(tx: Tx, ref: PersonalWorkRef, offset = 0, size = 4096, identity?: ToolQueryIdentity): Promise<PersonalWorkResult> {
  const { task, submission, cancelRequested } = await personalWorkStatus(tx, ref);
  const state = task.state.status === "terminal" ? task.state.outcome.status : task.state.status;
  const commands = (await personalWorkCommands(tx, ref.taskId)).map(personalCommandResult);
  const services = await workServiceResults(tx, ref.taskId);
  const unknownMcp = (await mcpOperations(tx)).filter(value => value.origin.work?.ref.taskId === ref.taskId && value.effect === "effect_unknown");
  const notice = [commands.length ? `当前宿主命令事实（优先于历史子回答）：\n${commands.map(command => command.verification).join("\n")}` : "", services.length ? `当前宿主服务事实（优先于历史子回答）：\n${services.map(service => service.verification).join("\n")}` : "", unknownMcp.length ? `原 MCP 调用结果未知：${unknownMcp.map(value => `${value.config.services.find(service => service.id === value.service)!.label}/${value.tool}${value.ended ? "（拥有者已人工结束工作，未知事实保留）" : "（等待拥有者人工收尾）"}`).join("、")}；同一来源不再执行。` : ""].filter(Boolean).join("\n");
  const tools = await personalWorkToolFacts(tx, ref.taskId, 0, identity);
  const executionFacts = { ...(commands.length ? { commands } : {}), ...(services.length ? { services } : {}), ...(tools.items.length ? { tools } : {}), ...(notice ? { notice } : {}) };
  // Native submission status records admission and completion, not proof the model read a note.
  const noteFacts = [];
  for (const note of (await facts(tx, ref)).notes ?? []) noteFacts.push({ requestId: note.requestId, state: (await tx.submissionByRequest(ref.agentId, noteSubmissionKey(ref, note)))?.status ?? "not_submitted" });
  const notes = noteFacts.length ? { notes: noteFacts } : {};
  if (state !== "completed") return { work: ref.taskId, state, ...executionFacts, ...notes, cancelRequested, next: task.state.status === "terminal" ? "工作未成功完成，后续已接纳说明未继续执行；请向拥有者报告，身份仍有占用时不要重试或复用。" : "工作尚未结束，请结束本轮，后续拥有者询问时再查询。" };
  const entry = submission?.status === "done" && submission.type === "input" ? await tx.entry(AssistantEntry, submission.answer) : undefined;
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") throw new PersonalError("work_answer_missing", "原工作的完整回答缺失，请停止引用结果并报告拥有者检查档案。");
  const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
  let end = Math.min(text.length, offset + size);
  if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1]) && /[\udc00-\udfff]/.test(text[end])) end--;
  const partial = message.stopReason === "length";
  return { work: ref.taskId, state, ...executionFacts, ...notes, text: text.slice(offset, end), offset, totalChars: text.length, partial, ...(partial ? { next: "模型输出因长度限制截断，仅为已保存片段。请报告遗漏，不自动续写或重试外部操作。" } : {}), ...(end < text.length ? { nextOffset: end } : {}) };
}

export type PersonalWorkSummary = { ref: PersonalWorkRef; label: string; content: string; state: string; cancelRequested: boolean; stopVerified: boolean; closed: boolean; notes: number; services?: ReturnType<typeof personalServiceResult>[]; tools?: Awaited<ReturnType<typeof personalWorkToolFacts>> };

export async function personalWorkSummary(tx: Tx, ref: PersonalWorkRef, identity?: ToolQueryIdentity): Promise<PersonalWorkSummary> {
  const status = await personalWorkStatus(tx, ref);
  const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === ref.agentId)!;
  const input = status.task.input;
  const content = input && typeof input === "object" && !Array.isArray(input) && input.content;
  if (typeof content !== "string") throw new PersonalError("work_missing", "后台工作说明缺失，请保留档案并检查存储。");
  const services = await workServiceResults(tx, ref.taskId), tools = await personalWorkToolFacts(tx, ref.taskId, 0, identity);
  return { ref, label: agent.label, content: content.slice(0, 160), state: status.task.state.status === "terminal" ? status.task.state.outcome.status : status.task.state.status, cancelRequested: status.cancelRequested, stopVerified: status.stopVerified, closed: agent.closed, notes: status.notes, ...(services.length ? { services } : {}), ...(tools.items.length ? { tools } : {}) };
}

export async function listPersonalWorks(tx: Tx, offset = 0, source?: PersonalEntryIdentity) {
  const items: PersonalWorkSummary[] = [];
  let cursor: Cursor | undefined;
  let skipped = 0;
  do {
    const page = await tx.scanTasks({ kind: PersonalWorkTask.definition.name, order: "descending" }, 64, cursor);
    for (const task of page.items) {
      const ref = await personalWorkRef(tx, task.id);
      const work = await facts(tx, ref);
      if (source && !samePersonalEntry(work.telegram, source)) continue;
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

/** Host cancellation waits for original child resources; unverified stopping retains occupancy. */
export function personalWork(harness: Harness, model: ModelRef | (() => ModelRef)) {
  return {
    async delegate(input: DelegateInput): Promise<PersonalWorkRef> {
      const ref = await harness.commit(tx => delegatePersonalWork(tx, typeof model === "function" ? model() : model, input), context);
      harness.resume();
      return ref;
    },
    async append(ref: PersonalWorkRef, input: { requestId: string; content: string; sourceRequestId: string }): Promise<PersonalWorkAppendOutcome> {
      return await harness.commit(async tx => appendPersonalWork(tx, ref, { requestId: input.requestId, content: input.content, source: await personalWorkNoteSource(tx, input.sourceRequestId) }), context);
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

export async function requirePersonalWorkRequest(tx: Tx, conversationId: ConversationId, excludeOperation?: TaskId) {
  if (conversationId === ROOT_CONVERSATION_ID) return;
  const scheduled = await scheduledConversation(tx, conversationId);
  if (scheduled) {
    const source = await personalSource(tx, scheduled.run.requestId, { active: true });
    const live = await tx.doc(LiveDoc, conversationId);
    const summary = scheduled.run.summary && await tx.submissionByRequest(conversationId, `personal-schedule-summary:${scheduled.run.id}`);
    const entry = summary?.entry && await tx.entry(summary.entry);
    const expected = scheduled.run.sealed ? summary?.id : source.submission.id;
    if (live.run?.inputs.length !== 1 || live.run.inputs[0] !== expected || scheduled.run.sealed && (!entry || entry.kind !== SCHEDULE_SUMMARY_INPUT || !isDeepStrictEqual(entry.data, { runId: scheduled.run.id, admission: scheduled.run.summary?.admission }) || entry.model?.[0]?.role !== "user" || entry.model[0].content !== scheduled.run.summary?.content)) throw new PersonalError("schedule_request_invalid", "定时模型请求的执行或汇总来源不符，已停止；请查询原运行。");
    await requirePersonalServiceSourceReady(tx, scheduled.run.requestId, excludeOperation);
    return;
  }
  const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === conversationId);
  if (!agent) {
    const extensions = (await tx.doc(AgentDoc, conversationId)).extensions;
    if (!Array.isArray(extensions) || extensions.includes(personalSubAgent.name)) throw new PersonalError("work_agent_missing", "子 Agent 的身份索引缺失，已停止模型请求；请检查档案。");
    return;
  }
  if (agent.closed || !agent.work || (await facts(tx, agent.work)).cancelRequested) throw new PersonalError("work_inactive", "子 Agent 没有可执行的活动工作，已停止模型请求；请查询工作状态。");
  const work = await facts(tx, agent.work);
  if (work.delegation) await requirePersonalDelegationReady(tx, work.delegation, false, excludeOperation);
  if (work.telegram && !await telegramSourceActive(tx, work.telegram)) throw new PersonalError("work_source_inactive", "原拥有者入口已停用或变更，后台工作已停止模型请求；请向拥有者报告并查询原工作。");
  if (work.source) { await personalSource(tx, work.source.requestId, { active: true }); await requirePersonalServiceSourceReady(tx, work.source.requestId, excludeOperation); }
  for (const note of work.notes ?? []) if (note.source.kind === "input") await requirePersonalServiceSourceReady(tx, note.source.requestId, excludeOperation);
  const task = await tx.task(agent.work.taskId);
  if (!task || task.state.status === "terminal" || task.state.status === "completing" || task.abortRequested) throw new PersonalError("work_inactive", "子 Agent 的工作已停止或无法核实，已停止模型请求；请查询原工作。");
}

export type PersonalWorkInspectionSource = { ref: PersonalWorkRef; permission: NonNullable<WorkFacts["permission"]>; telegram?: PersonalTelegramSource; inputs: SubmissionId[] };

export async function personalWorkInspectionSource(tx: Tx, ref: PersonalWorkRef, inputs: SubmissionId[], cutoff?: EntryId) {
  const work = await facts(tx, ref);
  if (!work.source || !work.permission) throw new PersonalError("work_source_invalid", "子检查缺少原工作授权，未执行；请查询原工作。");
  const sources = new Set([work.source.submissionId, ...(work.instructionSource ? [work.instructionSource.submissionId] : [])]);
  const allowed = new Set<SubmissionId>();
  const original = await tx.submissionByRequest(ref.agentId, `personal-work:${ref.taskId}`);
  if (original?.entry && (cutoff === undefined || original.entry < cutoff)) allowed.add(original.id);
  for (const note of work.notes ?? []) {
    if (cutoff !== undefined && (!note.admission || note.admission >= cutoff)) continue;
    if (note.source.kind === "input") sources.add(note.source.submissionId);
    const submission = await tx.submissionByRequest(ref.agentId, noteSubmissionKey(ref, note));
    if (submission?.entry && (cutoff === undefined || submission.entry < cutoff)) allowed.add(submission.id);
  }
  if (!inputs.length || new Set(inputs).size !== inputs.length || inputs.some(id => !allowed.has(id))) throw new PersonalError("work_source_invalid", "子检查不属于原工作的输入，未执行；请查询原工作。");
  return { sources: [...sources], work: { ref: { ...ref }, permission: { ...work.permission }, ...(work.telegram ? { telegram: { ...work.telegram } } : {}), inputs: inputs.slice() } satisfies PersonalWorkInspectionSource };
}

export async function activePersonalWorkInspection(tx: Tx, conversationId: ConversationId, inputs: SubmissionId[], excludeOperation?: TaskId) {
  await requirePersonalWorkRequest(tx, conversationId, excludeOperation);
  const ref = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === conversationId)?.work;
  if (!ref) throw new PersonalError("work_inactive", "子检查没有活动工作，未执行；请查询原工作。");
  return personalWorkInspectionSource(tx, ref, inputs);
}

// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-work-amendments.md
export type PersonalWorkInstructionSnapshot = { version: 1; work: PersonalWorkRef; cutoff: EntryId; nativeInputs: SubmissionId[]; original: { submissionId: SubmissionId; entryId: EntryId }; notes: { admission: EntryId; requestId: string; submissionId: SubmissionId; entryId: EntryId }[] };
export type PersonalToolInstructions = { version: 1; requestEntry: EntryId; snapshot: PersonalWorkInstructionSnapshot };

export async function personalWorkInstructions(tx: Tx, conversationId: ConversationId): Promise<{ snapshot: PersonalWorkInstructionSnapshot; contents: string[] } | undefined> {
  const ref = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === conversationId)?.work;
  if (!ref) return undefined;
  const task = await tx.task(ref.taskId);
  if (!task || task.version !== PersonalWorkTask.definition.version) return undefined;
  const live = await tx.doc(LiveDoc, conversationId);
  const generation = live.run && await tx.task(live.run.taskId), checkpoint = generation?.state.checkpoint;
  if (!live.run || !checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) || checkpoint.phase !== "request" || !Number.isSafeInteger(checkpoint.cutoff)) return undefined;
  const cutoff = checkpoint.cutoff as EntryId;
  const work = await facts(tx, ref), input = task.input;
  const original = await tx.submissionByRequest(ref.agentId, `personal-work:${ref.taskId}`);
  const originalContent = input && typeof input === "object" && !Array.isArray(input) && typeof input.content === "string" ? input.content : undefined;
  if (!original || original.entry === undefined || original.entry > cutoff || originalContent === undefined) throw new PersonalError("work_instruction_invalid", "原工作要求的模型请求证据无法核实，未执行；请结束本轮并报告拥有者检查原工作记录。");
  const notes: PersonalWorkInstructionSnapshot["notes"] = [], contents = [originalContent];
  for (const note of work.notes ?? []) {
    if (note.admission === undefined) continue;
    const submission = await tx.submissionByRequest(ref.agentId, noteSubmissionKey(ref, note));
    if (submission?.entry === undefined || submission.entry > cutoff) continue;
    notes.push({ admission: note.admission, requestId: note.requestId, submissionId: submission.id, entryId: submission.entry });
    contents.push(note.content);
  }
  return { snapshot: { version: 1, work: { ...ref }, cutoff, nativeInputs: live.run.inputs.slice(), original: { submissionId: original.id, entryId: original.entry }, notes }, contents };
}

export const personalWorkInstructionText = (snapshot: PersonalWorkInstructionSnapshot, contents: string[]) => `当前后台工作要求参考（原工作及已实际放入子会话的追加说明；不扩大原权限）：\n${JSON.stringify({ work: snapshot.work.taskId, instructions: contents })}\n按接纳顺序处理这些要求；追加说明改变目标时使用更新后的目标，不重复已经完成的外部操作。已接纳但未出现在此参考中的说明仍待下一个模型边界。`;

export async function personalWorkInstructionContents(tx: Tx, snapshot: PersonalWorkInstructionSnapshot): Promise<string[]> {
  const work = await facts(tx, snapshot.work), task = await tx.task(snapshot.work.taskId), input = task?.input;
  const original = input && typeof input === "object" && !Array.isArray(input) && typeof input.content === "string" ? input.content : undefined;
  if (original === undefined) throw new PersonalError("work_instruction_invalid", "原工作要求的模型请求证据无法核实，未执行；请结束本轮并报告拥有者检查原工作记录。");
  const contents = [original];
  for (const captured of snapshot.notes) {
    const note = (work.notes ?? []).find(note => note.requestId === captured.requestId && note.admission === captured.admission);
    if (!note) throw new PersonalError("work_instruction_invalid", "原工作要求的模型请求证据无法核实，未执行；请结束本轮并报告拥有者检查原工作记录。");
    contents.push(note.content);
  }
  return contents;
}

export async function personalWorkInstructionSources(tx: Tx, snapshot: PersonalWorkInstructionSnapshot): Promise<SubmissionId[]> {
  const work = await facts(tx, snapshot.work);
  if (!work.source) throw new PersonalError("work_instruction_invalid", "原工作要求的模型请求证据无法核实，未执行；请结束本轮并报告拥有者检查原工作记录。");
  const sources = new Set<SubmissionId>([work.source.submissionId, ...(work.instructionSource ? [work.instructionSource.submissionId] : [])]);
  for (const captured of snapshot.notes) {
    const note = (work.notes ?? []).find(note => note.requestId === captured.requestId && note.admission === captured.admission);
    if (note?.source.kind === "input") sources.add(note.source.submissionId);
  }
  return [...sources];
}

export async function verifyPersonalWorkInstructions(tx: Tx, conversationId: ConversationId, snapshot: PersonalWorkInstructionSnapshot, expected?: { cutoff?: EntryId; inputs?: SubmissionId[]; work?: PersonalWorkRef }) {
  const invalid = () => new PersonalError("work_instruction_invalid", "原工作要求的模型请求证据无法核实，未执行；请结束本轮并报告拥有者检查原工作记录。");
  if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.cutoff) || !Array.isArray(snapshot.nativeInputs) || !snapshot.nativeInputs.length || snapshot.nativeInputs.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(snapshot.nativeInputs).size !== snapshot.nativeInputs.length || !snapshot.original || !Array.isArray(snapshot.notes)) throw invalid();
  const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === conversationId);
  if (expected?.work) {
    if (!agent || snapshot.work.agentId !== conversationId || !isDeepStrictEqual(expected.work, snapshot.work)) throw invalid();
  } else if (!agent?.work || !isDeepStrictEqual(agent.work, snapshot.work)) throw invalid();
  const work = await facts(tx, snapshot.work), task = await tx.task(snapshot.work.taskId);
  if (!task || task.version !== PersonalWorkTask.definition.version) throw invalid();
  if (expected?.cutoff !== undefined && snapshot.cutoff !== expected.cutoff) throw invalid();
  if (expected?.inputs && !isDeepStrictEqual(snapshot.nativeInputs, expected.inputs)) throw invalid();
  const original = await tx.submissionByRequest(snapshot.work.agentId, `personal-work:${snapshot.work.taskId}`);
  const taskInput = task.input, originalContent = taskInput && typeof taskInput === "object" && !Array.isArray(taskInput) && typeof taskInput.content === "string" ? taskInput.content : undefined;
  const originalEntry = original?.entry !== undefined ? await tx.entry(original.entry) : undefined, originalMessage = originalEntry?.model?.[0];
  if (!original || snapshot.original.submissionId !== original.id || snapshot.original.entryId !== original.entry || original.entry === undefined || original.entry > snapshot.cutoff || originalContent === undefined || originalEntry?.kind !== "pi.user" || originalMessage?.role !== "user" || originalMessage.content !== originalContent) throw invalid();
  const seen = new Set<EntryId>(); let position = -1;
  for (const captured of snapshot.notes) {
    const index = (work.notes ?? []).findIndex(note => note.requestId === captured.requestId && note.admission === captured.admission);
    const submission = index >= 0 ? await tx.submissionByRequest(snapshot.work.agentId, noteSubmissionKey(snapshot.work, work.notes![index])) : undefined;
    const entry = submission?.entry !== undefined ? await tx.entry(submission.entry) : undefined, message = entry?.model?.[0];
    if (index <= position || !submission || !Number.isSafeInteger(captured.admission) || !Number.isSafeInteger(captured.submissionId) || !Number.isSafeInteger(captured.entryId) || typeof captured.requestId !== "string" || captured.submissionId !== submission.id || captured.entryId !== submission.entry || submission.entry === undefined || submission.entry > snapshot.cutoff || entry?.kind !== "pi.user" || message?.role !== "user" || message.content !== work.notes![index].content || seen.has(captured.admission)) throw invalid();
    seen.add(captured.admission); position = index;
  }
  const native = new Set<SubmissionId>([original.id, ...snapshot.notes.map(captured => captured.submissionId)]);
  if (snapshot.nativeInputs.some(id => !native.has(id))) throw invalid();
  for (const note of work.notes ?? []) {
    if (note.admission === undefined || seen.has(note.admission)) continue;
    const submission = await tx.submissionByRequest(snapshot.work.agentId, noteSubmissionKey(snapshot.work, note));
    if (submission?.entry !== undefined && submission.entry <= snapshot.cutoff) throw invalid();
  }
}
