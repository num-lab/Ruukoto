import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, defineEntry, defineExtension, LiveDoc, ROOT_CONVERSATION_ID, type ConversationId, type EntryId, type Harness, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { callHelper, expectRevisions, requireOk, ServiceHelperError, type HelperReply, type ServiceInspectionId, type ServiceManagerConfig } from "./service-helper.ts";
import { PersonalError } from "./personal-error.ts";
import { activePersonalWorkInspection, personalWorkInspectionSource, requirePersonalWorkRequest, type PersonalWorkInspectionSource } from "./personal-work.ts";
import { personalCommandsIn, personalCommandUnresolved } from "./personal-command-work.ts";
import { personalServiceOperation } from "./personal-service-operations.ts";
import { scheduledConversation } from "./personal-scheduler-records.ts";
import { personalSource } from "./personal-source.ts";

type Reply = Extract<HelperReply, { ok: true; verb: "inspect-op" }>;
type Identity = { taskId: TaskId; conversationId: ConversationId; taskKind: string; unit: string; machineId: string; inspectionId: ServiceInspectionId; sources: SubmissionId[]; generation?: TaskId; work?: PersonalWorkInspectionSource };
type Inspection = Identity & { admission: EntryId; stopped: boolean; stopEvidence?: EntryId; result?: { evidence: EntryId; reply?: Reply; code: string } };
export const PersonalInspectionDoc = defineDocFamily<{ inspection?: Inspection }, null>({ kind: "ruukoto.service-execution", scope: "session", version: 1, family: true, initial: () => ({}) });
export const PersonalPendingInspectionsDoc = defineDoc<{ tasks: TaskId[] }>({ kind: "ruukoto.service-executions", scope: "session", version: 1, initial: () => ({ tasks: [] }) });
export const ServiceInspectionAdmission = defineEntry<Identity>("ruukoto.service-inspection-admission");
export const ServiceInspectionEntry = defineEntry<{ unit: string; stdout: string; stderr: string; truncated: boolean; code: string; inspectionId?: ServiceInspectionId; machineId?: string; admission?: EntryId }>("ruukoto.service-inspection");
export const ServiceInspectionStopEntry = defineEntry<{ inspectionId: ServiceInspectionId; machineId: string; stdout: string; stderr: string; truncated: boolean; code: string; reply?: HelperReply }>("ruukoto.service-inspection-stop");
export const personalInspectionExtension = defineExtension({ name: "personal-service-executions" });
const context = BACKGROUND_CONTEXT;
const MAX_CAPTURE = 1024 * 1024;

export function inspectServiceReply(reply: HelperReply | undefined, unit: string, identity: Pick<Identity, "inspectionId" | "machineId">): Reply {
  if (!reply) throw new ServiceHelperError("服务检查没有可信应答", "protocol_error");
  const ok = requireOk(reply, "inspect-op");
  if (ok.verb !== "inspect-op" || ok.inspectionId !== identity.inspectionId || ok.machineId !== identity.machineId) throw new ServiceHelperError("服务检查应答身份不符", "protocol_error");
  expectRevisions(ok);
  const state = ok.state;
  if (ok.unit !== unit || !state || state.id !== unit || ![state.loadState, state.activeState, state.subState, state.invocationId, state.result, state.activeEnterTimestamp, ok.observedAt].every(value => typeof value === "string" && value.length <= 256)
    || !Number.isSafeInteger(state.mainPid) || state.mainPid < 0 || !Number.isFinite(Date.parse(ok.observedAt))) throw new ServiceHelperError("服务检查应答目标或状态字段无效", "protocol_error");
  return ok;
}

function machineFor(config: ServiceManagerConfig): string {
  let value: unknown;
  try { value = JSON.parse(readFileSync(config.policyPath, "utf8")); } catch (error) {
    throw new PersonalError("service_policy_invalid", "无法读取服务策略中的机器身份，未启动检查；请恢复原部署配置。", { cause: error });
  }
  if (!value || typeof value !== "object" || !("machineId" in value) || typeof value.machineId !== "string" || !value.machineId || value.machineId.length > 256 || /[\x00-\x20\x7f]/.test(value.machineId)) throw new PersonalError("service_policy_invalid", "服务策略中的机器身份无效，未启动检查；请核对部署配置。");
  return value.machineId;
}

async function invoke(config: ServiceManagerConfig, args: string[], timeoutMs: number, signal?: AbortSignal) {
  let response: Awaited<ReturnType<typeof callHelper>> | undefined;
  let capture: { stdout: Buffer; stderr: Buffer; truncated: boolean } = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false };
  let code = "ok";
  try { response = await callHelper(config, args, { signal, timeoutMs, maxOutputBytes: MAX_CAPTURE }); } catch (error) {
    if (!(error instanceof ServiceHelperError)) throw error;
    capture = error.capture ?? capture;
    code = error.code;
  }
  if (response) capture = { ...response, truncated: false };
  return { reply: response?.reply, capture: { stdout: capture.stdout.toString("base64"), stderr: capture.stderr.toString("base64"), truncated: capture.truncated, code } };
}

function sameAttempt(a: Inspection | undefined, b: Inspection | undefined) { return !!a && !!b && a.inspectionId === b.inspectionId && a.machineId === b.machineId && a.admission === b.admission; }
function exitProof(reply: HelperReply | undefined, value: Inspection) { return reply?.ok === true && reply.verb === "stop-inspect" && reply.inspectionId === value.inspectionId && reply.machineId === value.machineId && reply.exited === true; }

export async function pendingServiceInspection(tx: Tx, unit?: string, sources: readonly SubmissionId[] = []) {
  for (const taskId of (await tx.doc(PersonalPendingInspectionsDoc)).tasks) {
    const value = (await tx.doc(PersonalInspectionDoc, String(taskId), null)).inspection;
    if (!value || value.stopped) throw new PersonalError("service_inspection_invalid", "检查占用记录无法核实，已停止服务操作；请保留档案。");
    if ((unit !== undefined && value.unit === unit) || value.sources.some(id => sources.includes(id))) return copyJson(value) as Inspection;
  }
}

export async function pendingWorkInspection(tx: Tx, taskId: TaskId) {
  for (const id of (await tx.doc(PersonalPendingInspectionsDoc)).tasks) {
    const value = (await tx.doc(PersonalInspectionDoc, String(id), null)).inspection;
    if (!value || value.stopped) throw new PersonalError("service_inspection_invalid", "检查占用记录无法核实，已保留工作占用；请保留档案。");
    if (value.work?.ref.taskId === taskId || (value.taskKind === "ruukoto.service-operation" && (await tx.task(value.taskId))?.owner === taskId)) return true;
  }
  return false;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-durable-inspection.md
export async function recheckServiceInspection(harness: Harness, config: ServiceManagerConfig, taskId: TaskId, original?: Inspection) {
  const value = original ?? (await harness.snapshot(PersonalInspectionDoc, String(taskId), context))?.inspection;
  if (!value || value.stopped) return;
  // 原 invocation 可能已经取消；停止观察独立限时，证据仍由 Harness 持有。
  const response = await invoke(config, ["stop-inspect", value.inspectionId, value.machineId], config.timeouts?.stopMs ?? 15_000);
  await harness.commit(async tx => {
    const evidence = await tx.appendEntry(ServiceInspectionStopEntry, value.conversationId, { data: { inspectionId: value.inspectionId, machineId: value.machineId, ...response.capture, ...(response.reply ? { reply: response.reply } : {}) } });
    const current = (await tx.doc(PersonalInspectionDoc, String(taskId), null)).inspection;
    if (!sameAttempt(current, value) || !exitProof(response.reply, value)) return;
    current!.stopped = true;
    current!.stopEvidence = evidence.id;
    const pending = await tx.doc(PersonalPendingInspectionsDoc);
    pending.tasks = pending.tasks.filter(id => id !== taskId);
  }, context);
}

export async function runServiceInspection(harness: Harness, config: ServiceManagerConfig, owner: { taskId: TaskId; conversationId: ConversationId; sources?: SubmissionId[]; signal?: AbortSignal }, unit: string): Promise<{ code: string; evidence?: EntryId; reply?: Reply }> {
  let previous = (await harness.snapshot(PersonalInspectionDoc, String(owner.taskId), context))?.inspection;
  if (previous) {
    if (previous.unit !== unit || previous.conversationId !== owner.conversationId) throw new PersonalError("service_inspection_invalid", "原检查与本次调用不符，已停止；请保留档案。");
    await recheckServiceInspection(harness, config, owner.taskId);
    previous = (await harness.snapshot(PersonalInspectionDoc, String(owner.taskId), context))!.inspection!;
    if (!previous.stopped) return { code: "inspection_stop_unverified" };
    if (previous.result) return { ...previous.result };
  }
  const machineId = machineFor(config);
  const value = await harness.commit(async tx => {
    const task = await tx.task(owner.taskId);
    if (owner.signal?.aborted || !task || task.state.status === "terminal" || task.abortRequested || task.conversationId !== owner.conversationId) throw new PersonalError("service_inspection_inactive", "原检查任务已停止，未启动新检查。");
    const live = task.kind === "pi.tool" ? await tx.doc(LiveDoc, task.conversationId) : undefined;
    if (task.kind !== "ruukoto.service-operation" && (task.kind !== "pi.tool" || !task.owner || live?.run?.taskId !== task.owner)) throw new PersonalError("service_inspection_invalid", "检查不属于原活动执行，未启动；请保留档案。");
    if (owner.conversationId !== ROOT_CONVERSATION_ID && (task.kind !== "pi.tool" || owner.sources)) throw new PersonalError("service_inspection_invalid", "子检查的执行消费者不符，未启动；请查询原工作。");
    if (task.kind === "ruukoto.service-operation" && task.owner) {
      const input = task.input;
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.requestId !== "string") throw new PersonalError("service_inspection_invalid", "子服务操作缺少原引用，未启动检查。");
      const op = await personalServiceOperation(tx, { requestId: input.requestId, taskId: task.id });
      if (op.work?.ref.taskId !== task.owner || !isDeepStrictEqual(op.work.sources, owner.sources) || op.unit !== unit || op.cancelRequested) throw new PersonalError("service_inspection_inactive", "子服务操作已停止或归属不符，未启动检查。");
      await requirePersonalWorkRequest(tx, op.work.ref.agentId);
    }
    if (owner.conversationId !== ROOT_CONVERSATION_ID) {
      const generation = task.owner && await tx.task(task.owner);
      const input = task.input;
      if (generation?.kind !== "pi.generation" || generation.conversationId !== owner.conversationId || generation.abortRequested || generation.state.status === "terminal" || !live?.tools?.some(slot => slot.taskId === owner.taskId && slot.status === "running") || !input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model") throw new PersonalError("service_inspection_inactive", "子检查不属于活动模型工具，未执行；请查询原工作。");
    }
    const scheduled = await scheduledConversation(tx, owner.conversationId);
    if (scheduled) {
      const origin = await personalSource(tx, scheduled.run.requestId, { active: true });
      if (scheduled.run.sealed || live?.run?.inputs.length !== 1 || live.run.inputs[0] !== origin.submission.id) throw new PersonalError("service_inspection_inactive", "定时检查不属于活动执行输入，未启动；请查询原运行。");
      await requirePersonalWorkRequest(tx, owner.conversationId);
    }
    const child = owner.conversationId !== ROOT_CONVERSATION_ID && !scheduled ? await activePersonalWorkInspection(tx, owner.conversationId, live!.run!.inputs) : undefined;
    const sources = child?.sources ?? owner.sources ?? live!.run!.inputs.slice();
    if ((await personalCommandsIn(tx)).some(op => personalCommandUnresolved(op) && op.work.sources.some(id => sources.includes(id)))) throw new PersonalError("work_source_paused", "原工作有未核实命令，未启动服务检查；请在本机命令管理核实原效果和停止。");
    if (!sources.length) throw new PersonalError("service_inspection_invalid", "检查缺少原输入归属，未启动；请保留档案。");
    if (await pendingServiceInspection(tx, unit, sources)) return undefined;
    const record = await tx.doc(PersonalInspectionDoc, String(owner.taskId), null);
    if (record.inspection && !sameAttempt(record.inspection, previous!)) throw new PersonalError("service_inspection_invalid", "原检查尝试已变化，未启动新检查。");
    const identity: Identity = { taskId: owner.taskId, conversationId: owner.conversationId, taskKind: task.kind, unit, machineId, inspectionId: `inspect_${randomBytes(12).toString("hex")}`, sources, ...(task.owner ? { generation: task.owner } : {}), ...(child ? { work: child.work } : {}) };
    const admission = await tx.appendEntry(ServiceInspectionAdmission, owner.conversationId, { data: identity });
    const inspection: Inspection = { ...identity, admission: admission.id, stopped: false };
    record.inspection = inspection;
    (await tx.doc(PersonalPendingInspectionsDoc)).tasks.push(owner.taskId);
    return inspection;
  }, context);
  if (!value) return { code: "inspection_stop_unverified" };
  const response = await invoke(config, ["inspect-op", value.inspectionId, value.machineId, unit], config.timeouts?.inspectMs ?? 20_000, owner.signal);
  let reply: Reply | undefined;
  let code = response.capture.code;
  try { reply = inspectServiceReply(response.reply, unit, value); } catch (error) {
    if (!(error instanceof ServiceHelperError)) throw error;
    if (code === "ok") code = error.code;
  }
  await harness.commit(async tx => {
    const evidence = await tx.appendEntry(ServiceInspectionEntry, owner.conversationId, { data: { unit, inspectionId: value.inspectionId, machineId: value.machineId, admission: value.admission, ...response.capture, code } });
    const current = (await tx.doc(PersonalInspectionDoc, String(owner.taskId), null)).inspection;
    if (sameAttempt(current, value)) current!.result = { evidence: evidence.id, code, ...(reply ? { reply } : {}) };
  }, context);
  await recheckServiceInspection(harness, config, owner.taskId, value);
  const current = (await harness.snapshot(PersonalInspectionDoc, String(owner.taskId), context))!.inspection!;
  if (!sameAttempt(current, value) || !current.stopped) return { code: "inspection_stop_unverified" };
  return { ...current.result! };
}

export async function verifyServiceInspections(tx: Tx, keys: string[]) {
  const pending = await tx.doc(PersonalPendingInspectionsDoc);
  const expected: TaskId[] = [];
  for (const key of keys) {
    const value = (await tx.doc(PersonalInspectionDoc, key, null)).inspection;
    if (!value || String(value.taskId) !== key) throw new PersonalError("service_inspection_invalid", "服务检查身份记录缺失，已停止恢复；请保留档案。");
    const task = await tx.task(value.taskId);
    const entry = await tx.entry(ServiceInspectionAdmission, value.admission);
    const { admission: _admission, stopped: _stopped, stopEvidence: _stopEvidence, result: _result, ...identity } = value;
    if (!task || task.kind !== value.taskKind || task.conversationId !== value.conversationId || task.owner !== value.generation || !entry || entry.conversationId !== value.conversationId || !isDeepStrictEqual(entry.data, identity) || !/^inspect_[0-9a-f]{24}$/.test(value.inspectionId) || !value.sources.length) throw new PersonalError("service_inspection_invalid", "服务检查与原接纳或执行归属不符，已停止恢复；请保留档案。");
    if (!["pi.tool", "ruukoto.service-operation"].includes(task.kind)) throw new PersonalError("service_inspection_invalid", "服务检查的消费者无效，已停止恢复；请保留档案。");
    const scheduled = await scheduledConversation(tx, value.conversationId);
    if (value.conversationId === ROOT_CONVERSATION_ID || scheduled ? value.work !== undefined : !value.work || value.taskKind !== "pi.tool" || value.work.ref.agentId !== value.conversationId) throw new PersonalError("service_inspection_invalid", "服务检查的来源归属不符，已停止恢复；请保留档案。");
    if (scheduled) { const original = await personalSource(tx, scheduled.run.requestId); if (!isDeepStrictEqual(value.sources, [original.submission.id])) throw new PersonalError("service_inspection_invalid", "定时检查的原输入不符，已停止恢复；请保留档案。"); }
    if (value.work) {
      const source = await personalWorkInspectionSource(tx, value.work.ref, value.work.inputs, value.admission);
      if (!isDeepStrictEqual(source.work, value.work) || !isDeepStrictEqual(source.sources, value.sources)) throw new PersonalError("service_inspection_invalid", "子检查与原工作权限或来源不符，已停止恢复；请保留档案。");
    }
    if (task.kind === "pi.tool") {
      const input = task.input;
      const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
      const message = assistant?.model?.[0];
      if (!input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model" || !value.generation || (await tx.task(value.generation))?.kind !== "pi.generation" || (await tx.task(value.generation))?.conversationId !== value.conversationId || assistant?.conversationId !== value.conversationId || assistant.byTaskId !== value.generation || message?.role !== "assistant" || !message.content.some(part => part.type === "toolCall" && part.id === input.callId && part.name === "service_inspect" && part.arguments.unit === value.unit)) throw new PersonalError("service_inspection_invalid", "服务检查缺少原工具调用，已停止恢复；请保留档案。");
    }
    if (value.result) {
      const evidence = await tx.entry(ServiceInspectionEntry, value.result.evidence);
      if (!evidence || evidence.conversationId !== value.conversationId || evidence.data.unit !== value.unit || evidence.data.code !== value.result.code || evidence.data.inspectionId !== value.inspectionId || evidence.data.machineId !== value.machineId || evidence.data.admission !== value.admission) throw new PersonalError("service_inspection_invalid", "服务检查结果缺少原证据，已停止恢复；请保留档案。");
      if (value.result.reply) inspectServiceReply(value.result.reply, value.unit, value);
    }
    if (value.stopped) {
      const proof = value.stopEvidence && await tx.entry(ServiceInspectionStopEntry, value.stopEvidence);
      if (!proof || proof.conversationId !== value.conversationId || !exitProof(proof.data.reply, value) || proof.data.inspectionId !== value.inspectionId || proof.data.machineId !== value.machineId) throw new PersonalError("service_inspection_invalid", "服务检查停止缺少原身份的证明，已停止恢复；请保留档案。");
    } else expected.push(value.taskId);
  }
  if (new Set(pending.tasks).size !== pending.tasks.length || !isDeepStrictEqual([...pending.tasks].sort(), expected.sort())) throw new PersonalError("service_inspection_invalid", "服务检查占用索引不符，已停止恢复；请保留档案。");
  const latest = new Map<TaskId, EntryId>();
  let cursor;
  do {
    const page = await tx.scanConversations({}, 256, cursor);
    for (const conversation of page.items) {
      let entryCursor;
      do {
        const entries = await tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 256, entryCursor);
        for (const entry of entries.items) if (ServiceInspectionAdmission.is(entry)) latest.set(entry.data.taskId, entry.id);
        entryCursor = entries.next;
      } while (entryCursor);
    }
    cursor = page.next;
  } while (cursor);
  for (const [id, admission] of latest) {
    if (!keys.includes(String(id)) || (await tx.doc(PersonalInspectionDoc, String(id), null)).inspection?.admission !== admission) throw new PersonalError("service_inspection_invalid", "原检查接纳缺少最新身份记录，已停止恢复；请保留档案。");
  }
}

export function personalInspectionControl(harness: Harness, config: ServiceManagerConfig) {
  return {
    async list() { return harness.commit(async tx => { const items = []; for (const id of (await tx.doc(PersonalPendingInspectionsDoc)).tasks) items.push((await tx.doc(PersonalInspectionDoc, String(id), null)).inspection!); return copyJson(items) as Inspection[]; }, context); },
    async recheckStop(taskId: TaskId) {
      const task = await harness.commit(tx => tx.task(taskId), context);
      if (task && task.state.status !== "terminal" && !task.abortRequested) throw new PersonalError("service_inspection_active", "原检查仍在执行，请先取消原工作，再核实停止。");
      await recheckServiceInspection(harness, config, taskId);
    },
  };
}
