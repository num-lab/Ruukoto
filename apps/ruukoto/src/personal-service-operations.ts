import { appDataSourceBlocker } from "./personal-app-data.ts";
import { toolSourceBlocker } from "./personal-tools.ts";
import { browserSourceBlocker } from "./personal-browser.ts";
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Cursor, type DocumentObserver, type EntryId, type Harness, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { permissionSnapshot, telegramSelection, telegramSourceActive, TELEGRAM_SERVICE_ACTIONS, type PersonalTelegramSource } from "./personal-permissions.ts";
import { samePersonalEntry, isPersonalImRequest, PersonalTelegramReceiptDoc, type TelegramControlInput } from "./personal-telegram-records.ts";
import { PersonalError } from "./personal-error.ts";
import { PersonalInspectionDoc, PersonalPendingInspectionsDoc, pendingServiceInspection, recheckServiceInspection, runServiceInspection, ServiceInspectionEntry } from "./personal-service-inspection.ts";
import { callHelper, opUnitFor, ServiceHelperError, type HelperReply, type ServiceManagerConfig } from "./service-helper.ts";
import { PersonalWorkDoc, personalWorkInspectionSource, requirePersonalWorkRequest, type PersonalWorkInspectionSource } from "./personal-work.ts";
import { personalCommandSourceBlocker } from "./personal-command-work.ts";

import { mcpSourceBlocker } from "./personal-mcp.ts";
import { personalSource, personalSourceSubmission } from "./personal-source.ts";
import { personalScheduledSource } from "./personal-scheduler-records.ts";

export type PersonalServiceMode = "auto-review" | "confirm" | "full_access";
type Effect = { effect: "executed" | "not_executed" | "effect_unknown"; code: string; exitCode?: number };
export type PersonalServiceOperationRef = { requestId: string; taskId: TaskId<Effect> };
type Snapshot = { machineId: string; policyRevision: string; unitRevision: string };
type Operation = {
  ref: PersonalServiceOperationRef; unit: string; mode: PersonalServiceMode; fingerprint: string; hostOpId: string;
  telegram?: PersonalTelegramSource; decidedBy?: string; grant?: { id: string; version: number };
  source: { requestId: string; submissionId: SubmissionId; entryId: EntryId };
  snapshot?: Snapshot; decision: "pending" | "approved" | "rejected"; consumed: boolean; cancelRequested: boolean;
  result?: Effect; launcherStopped: boolean; resolution?: { effect: "applied" | "not_applied"; evidence: string; controlRequestId?: string };
  work?: ServiceWork & { admission: EntryId };
};
export const PERSONAL_SERVICE_WORK = "personal-subagent-service-operations";
export type ServiceWork = PersonalWorkInspectionSource & { tool: TaskId; generation: TaskId; sources: SubmissionId[] };
export const ServiceWorkAdmission = defineEntry<{ ref: PersonalServiceOperationRef; source: Operation["source"]; work: ServiceWork; unit: string }>("ruukoto.service-work-admission");
type Grant = { id: string; version: number; active: boolean; source: PersonalTelegramSource; snapshot: Snapshot; unit: string; operation: PersonalServiceOperationRef; controlRequestId: string; reason?: string };
export const PersonalServiceGrantsDoc = defineDoc<{ grants: Grant[] }>({ kind: "ruukoto.service-grants", scope: "session", version: 1, initial: () => ({ grants: [] }) });

type Input = { requestId: string };
type State = { phase: "prepare" | "verify" };
export const PersonalServiceOperationsDoc = defineDoc({ kind: "ruukoto.service-operations-config", scope: "session", version: 1, initial: () => ({ enabled: true }) });
export const PersonalServiceOperationDoc = defineDocFamily<{ operation?: Operation }, null>({ kind: "ruukoto.service-operation", scope: "session", version: 1, family: true, initial: () => ({}) });
export const ServiceOperationEvidence = defineEntry<{ requestId: string; verb: string; stdout: string; stderr: string; truncated: boolean; code: string }>("ruukoto.service-operation-evidence");
const context = BACKGROUND_CONTEXT;

export async function personalServiceOperation(tx: Tx, ref: { requestId: string; taskId: TaskId }) {
  const value = (await tx.doc(PersonalServiceOperationDoc, ref.requestId, null)).operation;
  if (!value || value.ref.taskId !== ref.taskId) throw new PersonalError("service_operation_missing", "找不到原服务操作，请保留档案并查询原工作。");
  return value;
}

async function sourceValid(tx: Tx, op: Operation, active = true) {
  if (active && (await appDataSourceBlocker(tx, op.source.requestId) || await personalCommandSourceBlocker(tx, op.source.requestId) || await mcpSourceBlocker(tx, op.source.requestId) || await toolSourceBlocker(tx, op.source.requestId) || await browserSourceBlocker(tx, op.source.requestId))) return false;
  if (active && op.work) {
    const work = await tx.doc(PersonalWorkDoc, op.work.ref.requestId, null);
    if (work.cancelRequested || !isDeepStrictEqual(work.ref, op.work.ref)) return false;
    try { await requirePersonalWorkRequest(tx, op.work.ref.agentId); } catch (error) { if (!(error instanceof PersonalError)) throw error; return false; }
  }
  if (await personalScheduledSource(tx, op.source.requestId)) {
    let original: Awaited<ReturnType<typeof personalSource>>;
    try { original = await personalSource(tx, op.source.requestId, { active }); } catch (error) { if (!(error instanceof PersonalError)) throw error; return false; }
    return original.scheduled && !op.grant && op.mode === original.permission.mode && isDeepStrictEqual(op.telegram, original.telegram) && original.submission.id === op.source.submissionId && original.entry.id === op.source.entryId;
  }
  const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, op.source.requestId);
  const entry = await tx.entry(op.source.entryId);
  if (isPersonalImRequest(op.source.requestId)) {
    const receipt = (await tx.doc(PersonalTelegramReceiptDoc, op.source.requestId, null)).receipt;
    if (!receipt || receipt.submissionId !== op.source.submissionId) return false;
    if (op.telegram && (op.mode !== op.telegram.mode || !isDeepStrictEqual(permissionSnapshot(receipt), op.telegram))) return false;
    if (active && (!op.telegram || !await telegramSourceActive(tx, op.telegram))) return false;
  } else if (op.telegram) return false;
  return source?.id === op.source.submissionId && source.entry === op.source.entryId && source.type === "input" && (!active || source.status === "placed" || source.status === "done") && entry?.kind === "pi.user";
}

async function waitForChange(reader: DocumentObserver, key: string, ready: (op: Readonly<Operation>) => boolean, context: Context) {
  const watch = await reader.watchDoc(PersonalServiceOperationDoc, key, context);
  if (!watch) throw new PersonalError("service_operation_missing", "服务操作记录缺失，已停止；请保留档案。");
  try {
    await new Promise<void>((resolve, reject) => {
      const check = (value: typeof watch.value) => { if (!value?.operation) reject(new PersonalError("service_operation_missing", "服务操作记录已缺失，请保留档案。")); else if (ready(value.operation)) resolve(); };
      watch.start(async value => { check(value); });
      check(watch.value);
      void watch.closed.then(() => reject(new PersonalError("service_wait_stopped", "服务操作等待已停止，请查询持久工作状态。")));
    });
  } finally { await watch.stop(); }
}

async function invoke(config: ServiceManagerConfig, verb: string, args: string[], signal: AbortSignal, timeoutMs: number) {
  let response: Awaited<ReturnType<typeof callHelper>> | undefined;
  let capture: { stdout: Buffer; stderr: Buffer; truncated: boolean } = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false };
  let code = "ok";
  try { response = await callHelper(config, [verb, ...args], { signal, timeoutMs, maxOutputBytes: 1024 * 1024 }); } catch (error) {
    if (!(error instanceof ServiceHelperError)) throw error;
    capture = error.capture ?? capture;
    code = error.code;
  }
  if (response) capture = { ...response, truncated: false };
  return { reply: response?.reply, evidence: { verb, stdout: capture.stdout.toString("base64"), stderr: capture.stderr.toString("base64"), truncated: capture.truncated, code } };
}

function classify(reply: HelperReply | undefined, op: Operation): Effect {
  if (reply?.verb === "restart" && !reply.ok && reply.launched === false) return { effect: "not_executed", code: reply.reasonCode ?? "refused" };
  if (reply?.ok && reply.verb === "restart" && reply.launched === true && reply.machineId === op.snapshot?.machineId && reply.hostOpId === op.hostOpId && reply.opUnit === opUnitFor(op.hostOpId) && Number.isInteger(reply.exitCode) && reply.exitCode >= 0 && reply.exitCode <= 255 && typeof reply.observedAt === "string" && Number.isFinite(Date.parse(reply.observedAt))) return { effect: "executed", code: "command_completed", exitCode: reply.exitCode };
  return { effect: "effect_unknown", code: "result_unverified" };
}

export { unresolved as personalServiceUnresolved };
function unresolved(op: Operation) { return op.consumed && (!op.result || (op.result.effect === "effect_unknown" && (!op.resolution || !op.launcherStopped))); }

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-subagent-service-operations.md
export function personalServiceResult(op: Readonly<Operation>, terminal: boolean) {
  const result: Effect = op.result ? { ...op.result } : { effect: op.consumed ? "effect_unknown" : "not_executed", code: terminal ? "service_task_failed" : "awaiting_result" };
  const approval = op.mode === "full_access" ? "完全访问，免逐次审批" : op.decidedBy ? op.decision === "approved" ? "拥有者已在原入口批准" : "原入口决定为拒绝或已失效" : op.grant ? "命中原入口长期授权" : !op.telegram && op.decision === "approved" ? "拥有者已在本机批准" : "尚无有效批准";
  let verification: string;
  if (op.resolution) verification = `业务效果已由拥有者核实为${op.resolution.effect === "applied" ? "已生效" : "未生效"}；${op.launcherStopped ? "原写操作停止已核实，双事实已齐，无需重复核实。" : "原写操作停止未核实，仍须核实原停止。"}`;
  else if (!terminal) verification = op.consumed ? "原服务操作仍在执行或收尾，等待原结果，勿重新发起。" : "原服务写操作尚未开始，等待原任务或原入口审批。";
  else if (unresolved(op)) verification = "原服务效果或停止尚未核实，保留原占用；由拥有者从原服务菜单核实，勿重试。";
  else if (result.effect === "not_executed") verification = "原服务写操作已知未执行，无需人工效果核实。";
  else verification = "原服务重启命令已结束；退出码不证明业务健康。";
  return { operation: op.ref.taskId, unit: op.unit, ...(op.work ? { work: op.work.ref.taskId } : {}), ...result, mode: op.mode, approval, consumed: op.consumed, launcherStopped: op.launcherStopped, ...(op.resolution ? { verifiedEffect: op.resolution.effect } : {}), requiresVerification: unresolved(op), verification };
}

export async function interruptedPersonalService(tx: Tx, op: Operation) {
  if (op.consumed && (!op.result || op.result.code === "started") && (await tx.task(op.ref.taskId))?.state.status === "terminal") {
    op.result = { effect: "effect_unknown", code: "interrupted" };
    await invalidateServiceGrants(tx, op);
  }
}

export async function personalWorkServices(tx: Tx, taskId: TaskId) {
  return (await personalServiceOperationsIn(tx)).filter(op => op.work?.ref.taskId === taskId);
}

export async function requirePersonalWorkServicesStopped(tx: Tx, taskId: TaskId) {
  for (const op of await personalWorkServices(tx, taskId)) if ((await tx.task(op.ref.taskId))?.state.status !== "terminal" || unresolved(op)) throw new PersonalError("work_stop_unverified", "子工作的服务操作或效果尚未核实，占用保留；请从原服务菜单核实效果与停止。");
}

export async function waitPersonalServiceEffect(reader: DocumentObserver, ref: PersonalServiceOperationRef, context: Context) {
  await waitForChange(reader, ref.requestId, op => !unresolved(op), context);
}

export type PersonalServiceBlocker = string | { appData: string; admission: EntryId } | { inspection: TaskId; admission: EntryId } | { command: string; admission: EntryId } | { mcp: string; admission: EntryId } | { tool: string; admission: EntryId } | { browser: string; admission: EntryId; pause?: EntryId; session?: boolean };

export async function personalServiceSourceBlocker(tx: Tx, sourceRequestId: string): Promise<PersonalServiceBlocker | undefined> {
  const appData = await appDataSourceBlocker(tx, sourceRequestId);
  if (appData) return appData;
  const browser = await browserSourceBlocker(tx, sourceRequestId);
  if (browser) return browser;
  const tool = await toolSourceBlocker(tx, sourceRequestId);
  if (tool) return tool;
  const mcp = await mcpSourceBlocker(tx, sourceRequestId);
  if (mcp) return mcp;
  const command = await personalCommandSourceBlocker(tx, sourceRequestId);
  if (command) return command;
  const source = await personalSourceSubmission(tx, sourceRequestId);
  const inspection = source && await pendingServiceInspection(tx, undefined, [source.id]);
  if (inspection) return { inspection: inspection.taskId, admission: inspection.admission };
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: "ruukoto.service-operation" }, 256, cursor);
    for (const task of page.items) {
      const key = task.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.requestId;
      if (typeof key !== "string") throw new PersonalError("service_operation_missing", "服务操作缺少来源记录，已停止委派；请保留档案。");
      const value = await personalServiceOperation(tx, { requestId: key, taskId: task.id });
      if (value.source.requestId === sourceRequestId && unresolved(value)) return key;
    }
    cursor = page.next;
  } while (cursor);
}

export async function requirePersonalServiceSourceReady(tx: Tx, sourceRequestId: string) {
  if (await personalServiceSourceBlocker(tx, sourceRequestId)) throw new PersonalError("work_source_paused", "原工作有尚未核实的外部效果或停止状态，已暂停委派和子模型请求；请向拥有者报告并核实原操作，不要换工作重试。");
}

function stopped(reply: HelperReply | undefined, op: Operation) {
  return reply?.ok === true && reply.verb === "stop-op" && reply.machineId === op.snapshot?.machineId && reply.hostOpId === op.hostOpId && reply.opUnit === opUnitFor(op.hostOpId) && reply.exited === true && "launcherExited" in reply && reply.launcherExited === true;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-service-operations.md
export function personalServiceOperations(config: ServiceManagerConfig, getHarness: () => Harness) {
  const task = defineTask<Input, State, Effect>({
    name: "ruukoto.service-operation", version: 1, initial: () => ({ phase: "prepare" }),
    phases: {
      async prepare(current, runtime, context) {
        const ref = { requestId: current.input.requestId, taskId: current.id };
        let op = await runtime.snapshot(PersonalServiceOperationDoc, ref.requestId, context);
        if (!op?.operation) throw new PersonalError("service_operation_missing", "服务操作缺少原记录，已停止；请检查档案。");
        if (op.operation.work && !await getHarness().commit(tx => sourceValid(tx, op!.operation!), context)) {
          await runtime.commit(async tx => { const value = await personalServiceOperation(tx, ref); value.result = { effect: "not_executed", code: "source_inactive" }; return { status: "terminal", outcome: { status: "completed", result: value.result } }; }, context);
          return;
        }
        if (!op.operation.snapshot) {
          const inspection = await runServiceInspection(getHarness(), config, { taskId: current.id, conversationId: current.conversationId, sources: op.operation.work?.sources ?? [op.operation.source.submissionId], signal: runtime.signal }, op.operation.unit);
          const snapshot = inspection.reply;
          const code = inspection.code;
          const evidence = inspection.evidence && await getHarness().commit(tx => tx.entry(ServiceInspectionEntry, inspection.evidence!), context);
          await runtime.commit(async tx => {
            const value = await personalServiceOperation(tx, ref);
            await tx.appendEntry(ServiceOperationEvidence, ROOT_CONVERSATION_ID, { data: { requestId: ref.requestId, verb: "inspect-op", ...(evidence?.data ?? { stdout: "", stderr: "", truncated: false }), code } });
            if (!snapshot) {
              value.result = { effect: "not_executed", code };
              return { status: "terminal", outcome: { status: "completed", result: value.result } };
            }
            value.snapshot = { machineId: snapshot.machineId, policyRevision: snapshot.policyRevision, unitRevision: snapshot.unitRevision };
            return undefined;
          }, context);
          if (!snapshot) return;
        }
        await runtime.commit(async tx => {
          const value = await personalServiceOperation(tx, ref);
          if (value.mode !== "full_access" && value.decision === "pending" && value.telegram && !(await personalSource(tx, value.source.requestId)).scheduled && await sourceValid(tx, value)) {
            for (const grant of (await tx.doc(PersonalServiceGrantsDoc)).grants) {
              if (!grant.active || grant.unit !== value.unit || !samePersonalEntry(grant.source, value.telegram)) continue;
              if (!isDeepStrictEqual(grant.snapshot, value.snapshot)) { invalidateGrant(grant, "deployment_changed"); continue; }
              value.grant = { id: grant.id, version: grant.version };
              value.decision = "approved";
              break;
            }
          }
          if (!value.consumed && !await sourceValid(tx, value)) value.decision = "rejected";
          return undefined;
        }, context);
        let execute = false;
        while (!execute) {
          let waitingAgain = false;
          await waitForChange(runtime, ref.requestId, value => value.decision !== "pending" || value.mode === "full_access" || value.cancelRequested, context);
          await runtime.commit(async tx => {
            const value = await personalServiceOperation(tx, ref);
            let code: string | undefined;
            if (value.cancelRequested || !await sourceValid(tx, value)) code = "source_inactive";
            else if (await pendingServiceInspection(tx, value.unit, value.work?.sources ?? [value.source.submissionId])) code = "inspection_stop_unverified";
            else if (value.decision === "rejected") code = "rejected";
            else {
              let revision: string | undefined;
              try { revision = createHash("sha256").update(readFileSync(config.policyPath)).digest("hex"); } catch {
                // 策略不可读使本次批准失效，不派发操作。
                code = "policy_unreadable";
              }
              if (revision !== value.snapshot?.policyRevision) code ??= "policy_changed";
            }
            if (!code && value.grant) {
              const grant = (await tx.doc(PersonalServiceGrantsDoc)).grants.find(grant => grant.id === value.grant!.id);
              if (!grant || !grant.active || grant.version !== value.grant.version || !value.telegram || !samePersonalEntry(grant.source, value.telegram) || grant.unit !== value.unit || !isDeepStrictEqual(grant.snapshot, value.snapshot)) {
                value.decision = "pending";
                delete value.grant;
                delete value.decidedBy;
                waitingAgain = true;
                return undefined;
              }
            }
            if (code) {
              if (value.grant) { const grant = (await tx.doc(PersonalServiceGrantsDoc)).grants.find(grant => grant.id === value.grant!.id); if (grant) invalidateGrant(grant, code); }
              value.result = { effect: "not_executed", code };
              return { status: "terminal", outcome: { status: value.cancelRequested ? "aborted" : "completed", result: value.result } };
            }
            if (value.consumed || (value.mode !== "full_access" && value.decision !== "approved")) throw new PersonalError("service_approval_invalid", "服务批准无法消费，已停止；请核实原操作。");
            value.consumed = true;
            value.result = { effect: "effect_unknown", code: "started" };
            execute = true;
            return { status: "running", checkpoint: { phase: "verify" } };
          }, context);
          if (!waitingAgain) break;
        }
        if (!execute) return;
        op = await runtime.snapshot(PersonalServiceOperationDoc, ref.requestId, context);
        const value = op!.operation!;
        const response = await invoke(config, "restart", [value.hostOpId, value.snapshot!.policyRevision, value.snapshot!.unitRevision, value.unit], runtime.signal, config.timeouts?.restartMs ?? 150_000);
        const result = classify(response.reply, value);
        await runtime.commit(async tx => {
          const value = await personalServiceOperation(tx, ref);
          await tx.appendEntry(ServiceOperationEvidence, ROOT_CONVERSATION_ID, { data: { requestId: ref.requestId, ...response.evidence } });
          value.result = result;
          if (result.effect === "effect_unknown") await invalidateServiceGrants(tx, value);
          else if (result.effect === "not_executed" && value.grant) { const grant = (await tx.doc(PersonalServiceGrantsDoc)).grants.find(grant => grant.id === value.grant!.id); if (grant) invalidateGrant(grant, "verification_failed"); }
          if (result.effect !== "effect_unknown") return { status: "terminal", outcome: { status: "completed", result } };
          return undefined;
        }, context);
        if (result.effect === "effect_unknown") await verify(ref, runtime, context);
      },
      async verify(current, runtime, context) { await verify({ requestId: current.input.requestId, taskId: current.id }, runtime, context); },
    },
    async abort(current, runtime, context) {
      const ref = { requestId: current.input.requestId, taskId: current.id };
      await runtime.commit(async tx => { (await personalServiceOperation(tx, ref)).cancelRequested = true; return undefined; }, context);
      const op = (await runtime.snapshot(PersonalServiceOperationDoc, ref.requestId, context))?.operation;
      if (!op) throw new PersonalError("service_operation_missing", "取消时原服务记录缺失，占用保留；请检查档案。");
      if (op.consumed) { await verify(ref, runtime, context); return; }
      await recheckServiceInspection(getHarness(), config, current.id);
      await runtime.commit(async tx => {
        const value = await personalServiceOperation(tx, ref);
        value.result = { effect: "not_executed", code: "canceled" };
        return { status: "terminal", outcome: { status: "aborted", result: value.result } };
      }, context);
    },
  });

  async function verify(ref: PersonalServiceOperationRef, runtime: Parameters<typeof task.definition.phases.verify>[1], context: Context) {
    await runtime.commit(async tx => { const value = await personalServiceOperation(tx, ref); if (!value.result || value.result.code === "started") value.result = { effect: "effect_unknown", code: "interrupted" }; await invalidateServiceGrants(tx, value); return undefined; }, context);
    const value = (await runtime.snapshot(PersonalServiceOperationDoc, ref.requestId, context))!.operation!;
    const response = await invoke(config, "stop-op", [value.hostOpId], runtime.signal, config.timeouts?.stopMs ?? 15_000);
    const reply = response.reply;
    await runtime.commit(async tx => {
      const value = await personalServiceOperation(tx, ref);
      await tx.appendEntry(ServiceOperationEvidence, ROOT_CONVERSATION_ID, { data: { requestId: ref.requestId, ...response.evidence } });
      value.launcherStopped ||= stopped(reply, value);
      return undefined;
    }, context);
    await waitForChange(runtime, ref.requestId, value => !!value.resolution && value.launcherStopped, context);
    await runtime.commit(async tx => {
      const value = await personalServiceOperation(tx, ref);
      return { status: "terminal", outcome: value.cancelRequested ? { status: "aborted", result: value.result! } : { status: "completed", result: value.result! } };
    }, context);
  }

  async function request(tx: Tx, input: { unit: string; sourceRequestId: string; requestId: string; mode?: PersonalServiceMode }, work?: ServiceWork): Promise<PersonalServiceOperationRef> {
    const requestedMode = input.mode ?? "auto-review";
    if (!/^[A-Za-z0-9_.-]+\.service$/.test(input.unit) || input.unit.length > 128 || !input.requestId || input.requestId.length > 256 || !input.sourceRequestId || input.sourceRequestId.length > 256 || !["auto-review", "confirm", "full_access"].includes(requestedMode)) throw new PersonalError("service_input_invalid", "服务目标、模式或原请求引用无效，请使用精确服务名和原输入。");
    const record = await tx.doc(PersonalServiceOperationDoc, input.requestId, null);
    const original = await personalSource(tx, input.sourceRequestId, { active: true, invalidCode: "service_source_invalid" });
    const { telegram, submission: source, entry } = original;
    if ((telegram || original.scheduled) && input.mode !== undefined && input.mode !== original.permission.mode) throw new PersonalError("service_mode_invalid", "服务模式必须沿用原工作来源，不能由调用者改写。");
    const mode = work?.permission.mode ?? (original.scheduled ? original.permission.mode : telegram?.mode) ?? requestedMode;
    const fingerprint = createHash("sha256").update(JSON.stringify([input.unit, input.sourceRequestId, mode])).digest("hex");
    if (record.operation) {
      if (record.operation.fingerprint !== fingerprint || !isDeepStrictEqual(record.operation.work && (({ admission: _admission, ...value }) => value)(record.operation.work), work)) throw new PersonalError("service_request_conflict", "同键服务操作内容不符，请查询原操作，不要换键自动重试。");
      return { ...record.operation.ref };
    }
    if (await personalCommandSourceBlocker(tx, input.sourceRequestId)) throw new PersonalError("work_source_paused", "原工作有未核实命令，未接纳服务操作；请在本机命令管理核实原效果和停止。");
    if (await browserSourceBlocker(tx, input.sourceRequestId)) throw new PersonalError("work_source_paused", "原工作有未核实浏览器效果或停止状态，未接纳服务操作；请从浏览器菜单核实原操作。");
    if (await pendingServiceInspection(tx, input.unit, work?.sources ?? [source.id])) throw new PersonalError("service_operation_busy", "服务目标或原工作仍有检查停止未核实，请查询原检查；不能换键重试。");
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({ kind: task.definition.name }, 256, cursor);
      for (const current of page.items) {
        const requestId = current.input && typeof current.input === "object" && !Array.isArray(current.input) && current.input.requestId;
        if (typeof requestId !== "string") throw new PersonalError("service_operation_missing", "已有服务工作记录无法核实，已拒绝新操作。");
        const other = await personalServiceOperation(tx, { requestId, taskId: current.id });
        if (current.state.status === "terminal" && !unresolved(other)) continue;
        if (other.unit === input.unit || other.source.requestId === input.sourceRequestId) throw new PersonalError("service_operation_busy", "服务目标或原工作仍未结束，请查询并处理原操作；不能换键重试。");
      }
      cursor = page.next;
    } while (cursor);
    const taskId = await tx.createTask(task, { requestId: input.requestId }, { conversationId: ROOT_CONVERSATION_ID, ...(work ? { ownership: { kind: "task", taskId: work.ref.taskId } as const } : { ownership: { kind: "conversation" } as const, background: true }) });
    const ref = { requestId: input.requestId, taskId };
    record.operation = { ...(telegram ? { telegram } : {}), ref, unit: input.unit, mode, fingerprint, hostOpId: `op_${randomBytes(12).toString("hex")}`, source: { requestId: input.sourceRequestId, submissionId: source.id, entryId: entry.id }, decision: "pending", consumed: false, cancelRequested: false, launcherStopped: false };
    if (work) {
      const admission = await tx.appendEntry(ServiceWorkAdmission, work.ref.agentId, { data: { ref, unit: input.unit, source: record.operation.source, work } });
      record.operation.work = { ...work, admission: admission.id };
    }
    return ref;
  }

  const extension = defineExtension({ name: "personal-service-operations", tasks: [task] });
  return { task, extension, request, control: serviceTelegramControl,
    api(harness: Harness) {
      return {
        async request(input: { unit: string; sourceRequestId: string; requestId: string; mode?: PersonalServiceMode }): Promise<PersonalServiceOperationRef> {
          const ref = await harness.commit(tx => request(tx, input), context);
          harness.resume();
          return ref;
        },
        async status(ref: PersonalServiceOperationRef) { return harness.commit(async tx => ({ operation: copyJson(await personalServiceOperation(tx, ref)) as Operation, task: await tx.task(ref.taskId), inspectionStopVerified: !(await tx.doc(PersonalPendingInspectionsDoc)).tasks.includes(ref.taskId) }), context); },
        async list(cursor?: Cursor) {
          return harness.commit(async tx => {
            const page = await tx.scanTasks({ kind: task.definition.name, order: "descending" }, 32, cursor);
            const items = [];
            for (const current of page.items) {
              const requestId = current.input && typeof current.input === "object" && !Array.isArray(current.input) && current.input.requestId;
              if (typeof requestId !== "string") throw new PersonalError("service_operation_missing", "服务工作记录无法核实，请保留档案。");
              items.push({ operation: copyJson(await personalServiceOperation(tx, { requestId, taskId: current.id })) as Operation, task: current, inspectionStopVerified: !(await tx.doc(PersonalPendingInspectionsDoc)).tasks.includes(current.id) });
            }
            return { items, next: page.next };
          }, context);
        },
        async decide(ref: PersonalServiceOperationRef, decision: "approved" | "rejected") {
          if (decision !== "approved" && decision !== "rejected") throw new PersonalError("service_decision_invalid", "请选择批准或拒绝原服务操作。");
          await harness.commit(async tx => {
            const value = await personalServiceOperation(tx, ref);
            if (value.telegram || isPersonalImRequest(value.source.requestId)) throw new PersonalError("service_original_entry_required", "请由拥有者在原私聊查询 /审批 并决定原操作。");
            if (value.decision === decision && !value.cancelRequested) return;
            const current = await tx.task(ref.taskId);
            if (!value.snapshot || value.consumed || value.cancelRequested || value.decision !== "pending" || current?.state.status === "terminal" || current?.abortRequested || !await sourceValid(tx, value)) throw new PersonalError("service_approval_invalid", "原服务审批已失效或已消费，请查询原操作。");
            value.decision = decision;
          }, context);
        },
        async cancel(ref: PersonalServiceOperationRef) {
          await harness.commit(async tx => { const value = await personalServiceOperation(tx, ref); if ((await tx.task(ref.taskId))?.state.status !== "terminal") value.cancelRequested = true; }, context);
          await harness.abortTask(ref.taskId, context);
        },
        async resolve(ref: PersonalServiceOperationRef, effect: "applied" | "not_applied", evidence: string) {
          await harness.commit(tx => resolvePersonalServiceOperation(tx, ref, effect, evidence), context);
        },
        async recheckStop(ref: PersonalServiceOperationRef, expected?: { hostOpId: string; machineId: string }) {
          await harness.commit(tx => personalServiceOperation(tx, ref).then(() => undefined), context);
          const inspection = (await harness.snapshot(PersonalInspectionDoc, String(ref.taskId), context))?.inspection;
          if (inspection && !inspection.stopped) { if (expected) throw new PersonalError("service_resolution_invalid", "审批前检查仍待核实，请从检查菜单管理。"); await recheckServiceInspection(harness, config, ref.taskId); return; }
          const value = await harness.commit(async tx => {
            const value = await personalServiceOperation(tx, ref);
            if (value.consumed && (!value.result || value.result.code === "started") && (await tx.task(ref.taskId))?.state.status === "terminal") value.result = { effect: "effect_unknown", code: "interrupted" };
            return copyJson(value) as Operation;
          }, context);
          if (expected && (value.hostOpId !== expected.hostOpId || value.snapshot?.machineId !== expected.machineId)) throw new PersonalError("service_control_invalid", "原操作执行身份已变化，未请求停止。");
          if (value.result?.effect !== "effect_unknown" || value.result.code === "started") throw new PersonalError("service_resolution_invalid", "原操作没有待核实停止的未知效果，请查询原记录。");
          const response = await invoke(config, "stop-op", [value.hostOpId], new AbortController().signal, config.timeouts?.stopMs ?? 15_000);
          const reply = response.reply;
          await harness.commit(async tx => {
            const current = await personalServiceOperation(tx, ref);
            if (current.hostOpId !== value.hostOpId || !isDeepStrictEqual(current.snapshot, value.snapshot)) throw new PersonalError("service_control_invalid", "原操作执行身份已变化，停止证明未写给其他操作。");
            await tx.appendEntry(ServiceOperationEvidence, ROOT_CONVERSATION_ID, { data: { requestId: ref.requestId, ...response.evidence } });
            current.launcherStopped ||= stopped(reply, current);
          }, context);
        },
      };
    },
  };
}

export async function resolvePersonalServiceOperation(tx: Tx, ref: PersonalServiceOperationRef, effect: "applied" | "not_applied", evidence: string, controlRequestId?: string) {
  if (!["applied", "not_applied"].includes(effect) || !evidence.trim() || evidence.length > 8192) throw new PersonalError("service_resolution_invalid", "核实需要选择已生效或未生效，并提供最多 8192 字符的非空证据说明。");
  const value = await personalServiceOperation(tx, ref);
  if (value.consumed && (!value.result || value.result.code === "started") && (await tx.task(ref.taskId))?.state.status === "terminal") value.result = { effect: "effect_unknown", code: "interrupted" };
  if (!value.consumed || value.result?.effect !== "effect_unknown" || value.result.code === "started" || value.resolution) throw new PersonalError("service_resolution_invalid", "原操作不处于待核实状态，或已保存核实结果；请查询原记录。");
  value.resolution = { effect, evidence, ...(controlRequestId ? { controlRequestId } : {}) };
}

function invalidateGrant(grant: Grant, reason: string) {
  if (grant.active) { grant.active = false; grant.version++; grant.reason = reason; }
}

export async function listPersonalServiceGrants(tx: Tx, offset = 0) {
  const all = (await tx.doc(PersonalServiceGrantsDoc)).grants, items = [];
  for (const grant of all.slice(offset, offset + 8)) items.push({ id: grant.id, version: grant.version, unit: grant.unit, machine: grant.snapshot.machineId, platform: grant.source.platform === "qq" ? "QQ" : "Telegram", active: grant.active, source: `入口账号 ${grant.source.botId}；拥有者账号 ${grant.source.ownerId}；${await telegramSourceActive(tx, grant.source) ? "当前绑定" : "旧绑定"}` });
  return { items, ...(offset + 8 < all.length ? { nextOffset: offset + 8 } : {}) };
}

export async function revokePersonalServiceGrant(tx: Tx, id: string, version: number) {
  const grant = (await tx.doc(PersonalServiceGrantsDoc)).grants.find(grant => grant.id === id);
  if (!grant || grant.version !== version) throw new PersonalError("service_grant_stale", "原授权已变化，未撤销其他授权；请刷新列表核实原记录。");
  if (!grant.active) return;
  invalidateGrant(grant, "owner_revoked");
  await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.service-grant-revoked", data: { id, version: grant.version, source: "local" } });
}

async function invalidateServiceGrants(tx: Tx, value: Operation) {
  for (const grant of (await tx.doc(PersonalServiceGrantsDoc)).grants) {
    if (grant.snapshot.machineId === value.snapshot?.machineId && grant.unit === value.unit) invalidateGrant(grant, "effect_unknown");
  }
}

export async function personalServiceOperationsIn(tx: Tx) {
  const values: Operation[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: "ruukoto.service-operation" }, 256, cursor);
    for (const task of page.items) {
      const key = task.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.requestId;
      if (typeof key !== "string") throw new PersonalError("service_operation_invalid", "服务工作缺少操作引用，请保留档案。");
      values.push(await personalServiceOperation(tx, { requestId: key, taskId: task.id }));
    }
    cursor = page.next;
  } while (cursor);
  return values;
}

async function pendingApproval(tx: Tx, value: Operation, actor: TelegramControlInput) {
  const task = await tx.task(value.ref.taskId);
  return value.mode !== "full_access" && !!value.telegram && samePersonalEntry(value.telegram, actor) && !!value.snapshot && !value.consumed && !value.cancelRequested && value.decision === "pending" && task?.state.status !== "terminal" && !task?.abortRequested && await sourceValid(tx, value);
}

async function serviceTelegramControl(tx: Tx, value: TelegramControlInput): Promise<boolean> {
  if (!TELEGRAM_SERVICE_ACTIONS.includes(value.content)) return false;
  const menu = await telegramSelection(tx, value);
  const selection = menu?.selection;
  const grants = (await tx.doc(PersonalServiceGrantsDoc)).grants;
  if (value.content === "/审批" || (value.content === "下一项" && selection?.kind === "approval")) {
    const pending: Operation[] = [];
    for (const op of await personalServiceOperationsIn(tx)) if (await pendingApproval(tx, op, value)) pending.push(op);
    const previous = selection?.kind === "approval" ? pending.findIndex(op => op.ref.taskId === selection.ref.taskId) : -1;
    const op = pending[(previous + 1) % pending.length];
    if (!op) value.reply = "原入口暂无可决定的服务审批。检查尚在进行时请稍后重新发送 /审批。";
    else {
      value.selection = { kind: "approval", ref: { ...op.ref } };
      value.reply = (await personalSource(tx, op.source.requestId)).scheduled ? `定时工作待审批：重启 ${op.unit}，仅限本次固定目标及检查修订。回复这条消息选择：批准本次、拒绝、下一项；定时工作不继承或创建长期授权。` : `待审批：在机器 ${op.snapshot!.machineId} 重启 ${op.unit}。仅限本次固定目标及检查修订。回复这条消息选择：批准本次、批准并长期授权、拒绝、下一项。长期授权仅允许原入口在相同策略和单元修订下重复执行此重启，可用 /授权 查询和撤销。`;
    }
  } else if (value.content === "/服务状态" || (value.content === "下一项" && selection?.kind === "service-status")) {
    const available = (await personalServiceOperationsIn(tx)).filter(op => samePersonalEntry(op.telegram, value)).reverse();
    const previous = selection?.kind === "service-status" ? available.findIndex(op => op.ref.taskId === selection.ref.taskId) : -1;
    const op = available[(previous + 1) % available.length];
    if (!op) value.reply = "原入口暂无服务工作。";
    else {
      value.selection = { kind: "service-status", ref: { ...op.ref } };
      const inspectionPending = (await tx.doc(PersonalPendingInspectionsDoc)).tasks.includes(op.ref.taskId);
      const status = inspectionPending ? "原检查停止未核实，保留原工作与服务目标占用；请核实停止，勿重新委托重试" : op.result?.effect === "effect_unknown" ? op.resolution && op.launcherStopped ? "原未知效果已人工核实且停止已核实" : "效果未知，自动操作暂停；请核实服务效果与停止，勿重新委托重试" : op.result?.effect === "executed" ? `重启命令已结束，退出码 ${op.result.exitCode}；这不代表业务健康` : op.result?.effect === "not_executed" ? "已知未执行" : op.consumed ? "已开始，结果尚未核实" : op.decision === "pending" ? "等待原入口审批" : "已决定，等待执行前核实";
      value.reply = `服务工作：重启 ${op.unit}。${status}。回复这条消息选择「下一项」查看其他工作；审批请发送 /审批。`;
    }
  } else if (value.content === "/授权" || (value.content === "下一项" && selection?.kind === "grant")) {
    const available = grants.filter(grant => samePersonalEntry(grant.source, value));
    const previous = selection?.kind === "grant" ? available.findIndex(grant => grant.id === selection.id) : -1;
    const grant = available[(previous + 1) % available.length];
    if (!grant) value.reply = "原入口没有服务长期授权；授权只能从原待审批操作明确创建。";
    else {
      value.selection = { kind: "grant", id: grant.id, version: grant.version };
      value.reply = `长期服务授权：机器 ${grant.snapshot.machineId}，重启 ${grant.unit}，状态：${grant.active ? "有效" : "已撤销或失效"}。仅适用创建时的原入口及策略/单元修订。回复这条消息选择：撤销授权、下一项。`;
    }
  } else if (value.content === "撤销授权" && selection?.kind === "grant") {
    const grant = grants.find(grant => grant.id === selection.id && samePersonalEntry(grant.source, value));
    if (!grant || grant.version !== selection.version) value.reply = "原授权已变化，请重新发送 /授权 查询当前记录。";
    else { invalidateGrant(grant, "owner_revoked"); value.reply = "原长期授权已撤销；已开始操作仍须查询原工作核实，后续操作恢复逐次审批。"; }
  } else if (["批准本次", "批准并长期授权", "拒绝"].includes(value.content) && selection?.kind === "approval") {
    const op = await personalServiceOperation(tx, selection.ref);
    if (!await pendingApproval(tx, op, value)) value.reply = "原审批已失效、已决定或已经消费，请重新发送 /审批 核实，不能按旧菜单重新执行。";
    else {
      if (value.content === "批准并长期授权") {
        if ((await personalSource(tx, op.source.requestId)).scheduled) { value.reply = "定时运行只能批准本次具体操作，不能创建长期授权；请回复原审批菜单选择批准本次或拒绝。"; return true; }
        for (const grant of grants) if (grant.unit === op.unit && samePersonalEntry(grant.source, op.telegram!)) invalidateGrant(grant, "replaced");
        const grant: Grant = { id: `grant_${randomBytes(12).toString("hex")}`, version: 1, active: true, source: { ...op.telegram! }, snapshot: { ...op.snapshot! }, unit: op.unit, operation: { ...op.ref }, controlRequestId: value.requestId };
        grants.push(grant);
        op.grant = { id: grant.id, version: grant.version };
      }
      op.decision = value.content === "拒绝" ? "rejected" : "approved";
      op.decidedBy = value.requestId;
      value.serviceDecision = { ref: { ...op.ref }, decision: op.decision, ...(op.grant ? { grant: { ...op.grant } } : {}) };
      value.reply = value.content === "拒绝" ? "已拒绝原服务操作。" : "原服务操作已批准，执行前仍会复核；批准不表示重启成功。请发送 /服务状态 查询原工作结果。";
    }
  } else value.reply = "没有决定任何操作。请直接发送 /审批 或 /授权，再回复对应宿主菜单选择列出的完整动作。";
  return true;
}

export async function verifyServiceGrants(tx: Tx, requestIds: string[]) {
  const grants = (await tx.doc(PersonalServiceGrantsDoc)).grants;
  if (new Set(grants.map(grant => grant.id)).size !== grants.length) throw new PersonalError("service_grant_invalid", "长期授权身份重复，已停止恢复；请保留档案。");
  for (const grant of grants) {
    const source = (await tx.doc(PersonalTelegramReceiptDoc, grant.controlRequestId, null)).receipt;
    const op = await personalServiceOperation(tx, grant.operation);
    const menu = source && await telegramSelection(tx, source);
    if ((await personalSource(tx, op.source.requestId)).scheduled || !source || source.serviceDecision?.decision !== "approved" || source.serviceDecision.ref.taskId !== op.ref.taskId || source.serviceDecision.grant?.id !== grant.id || grant.version < 1 || source.serviceDecision.grant.version !== 1 || source.content !== "批准并长期授权" || !source.control || !op.telegram || !isDeepStrictEqual(grant.source, op.telegram) || !isDeepStrictEqual(grant.snapshot, op.snapshot) || grant.unit !== op.unit || menu?.selection?.kind !== "approval" || menu.selection.ref.taskId !== op.ref.taskId || !Number.isSafeInteger(grant.version)) throw new PersonalError("service_grant_invalid", "长期授权缺少原入口决定或范围不符，已停止恢复；请保留档案。");
    if (!await telegramSourceActive(tx, grant.source)) invalidateGrant(grant, "entrance_changed");
  }
  for (const requestId of requestIds) {
    const op = (await tx.doc(PersonalServiceOperationDoc, requestId, null)).operation!;
    if (op.grant && !grants.some(grant => grant.id === op.grant!.id && grant.version >= op.grant!.version && grant.unit === op.unit && op.telegram && samePersonalEntry(grant.source, op.telegram) && isDeepStrictEqual(grant.snapshot, op.snapshot))) throw new PersonalError("service_grant_invalid", "服务操作引用的长期授权缺失或不符，已停止恢复；请保留档案。");
  }
}

export async function verifyServiceOperationRecords(tx: Tx, requestIds: string[], inspectionKeys: string[] = [], workEnabled = false) {
  const activeTargets = new Set<string>();
  const activeSources = new Set<string>();
  for (const requestId of requestIds) {
    const value = (await tx.doc(PersonalServiceOperationDoc, requestId, null)).operation;
    const task = value && await tx.task(value.ref.taskId);
    if (!value || value.ref.requestId !== requestId || value.fingerprint !== createHash("sha256").update(JSON.stringify([value.unit, value.source.requestId, value.mode])).digest("hex") || !task || task.kind !== "ruukoto.service-operation" || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || (value.work ? task.owner !== value.work.ref.taskId || task.background : !task.background || task.owner !== undefined) || !task.input || typeof task.input !== "object" || Array.isArray(task.input) || task.input.requestId !== requestId || !await sourceValid(tx, value, false)) throw new PersonalError("service_operation_invalid", "服务操作的来源、执行或归属无法核实，已停止恢复；请保留档案。");
    if (requestId.startsWith("personal-service-tool:") && !value.work) throw new PersonalError("service_work_invalid", "子服务操作缺少原工作接纳，已停止恢复；请保留档案。");
    if (value.work) {
      const { admission, ...work } = value.work;
      const original = await tx.entry(ServiceWorkAdmission, admission);
      const source = await personalWorkInspectionSource(tx, work.ref, work.inputs, admission);
      const facts = await tx.doc(PersonalWorkDoc, work.ref.requestId, null);
      const call = await tx.task(work.tool);
      const input = call?.input;
      const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
      if (!workEnabled || requestId !== `personal-service-tool:${work.tool}` || original?.conversationId !== work.ref.agentId || !isDeepStrictEqual(original.data, { ref: value.ref, source: value.source, unit: value.unit, work }) || !isDeepStrictEqual(source.work, { ref: work.ref, permission: work.permission, ...(work.telegram ? { telegram: work.telegram } : {}), inputs: work.inputs }) || !isDeepStrictEqual(source.sources, work.sources) || !isDeepStrictEqual(facts.source, value.source) || value.mode !== work.permission.mode || !isDeepStrictEqual(value.telegram, work.telegram) || call?.kind !== "pi.tool" || call.conversationId !== work.ref.agentId || call.owner !== work.generation || (await tx.task(work.generation))?.kind !== "pi.generation" || !input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model" || assistant?.conversationId !== work.ref.agentId || assistant.byTaskId !== work.generation || assistant.id >= admission || !assistant.model?.some(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === input.callId && part.name === "service_restart" && part.arguments.unit === value.unit))) throw new PersonalError("service_work_invalid", "子服务操作与原工具、来源或权限不符，已停止恢复；请保留档案。");
    }
    const inspection = inspectionKeys.includes(String(value.ref.taskId)) ? (await tx.doc(PersonalInspectionDoc, String(value.ref.taskId), null)).inspection : undefined;
    if (value.snapshot && (!inspection?.stopped || !inspection.result?.reply || !isDeepStrictEqual(value.snapshot, { machineId: inspection.result.reply.machineId, policyRevision: inspection.result.reply.policyRevision, unitRevision: inspection.result.reply.unitRevision }))) throw new PersonalError("service_inspection_invalid", "服务审批快照缺少原检查与停止证明，已停止恢复；请保留档案。");
    if (inspection && (inspection.unit !== value.unit || !isDeepStrictEqual(inspection.sources, value.work?.sources ?? [value.source.submissionId]))) throw new PersonalError("service_inspection_invalid", "服务检查的原操作来源不符，已停止恢复；请保留档案。");
    if (value.telegram && value.decidedBy) {
      const decision = (await tx.doc(PersonalTelegramReceiptDoc, value.decidedBy, null)).receipt;
      if (!decision?.control || !decision.direct || !decision.serviceDecision || (value.decision === "approved" && decision.serviceDecision.decision !== "approved") || decision.serviceDecision.ref.taskId !== value.ref.taskId || decision.serviceDecision.ref.requestId !== requestId || !samePersonalEntry(value.telegram, decision)) throw new PersonalError("service_approval_invalid", "服务决定缺少原入口的已接受回执，已停止恢复；请保留档案。");
    }
    if (value.telegram && value.decision === "approved" && !value.grant && !value.decidedBy) throw new PersonalError("service_approval_invalid", "服务批准缺少原入口决定，已停止恢复；请保留档案。");
    if (!value.consumed && isPersonalImRequest(value.source.requestId) && !value.telegram) value.decision = "rejected";
    if (value.telegram && !value.consumed && !await telegramSourceActive(tx, value.telegram)) value.decision = "rejected";
    await interruptedPersonalService(tx, value);
    if (value.result?.effect === "effect_unknown" && unresolved(value)) await invalidateServiceGrants(tx, value);
    if (task.state.status !== "terminal" || unresolved(value)) {
      if (activeTargets.has(value.unit) || activeSources.has(value.source.requestId)) throw new PersonalError("service_operation_invalid", "服务目标或来源被多个未结束操作占用，已停止恢复；请保留档案。");
      activeTargets.add(value.unit);
      activeSources.add(value.source.requestId);
    }
  }
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: "ruukoto.service-operation" }, 256, cursor);
    for (const task of page.items) {
      const requestId = task.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.requestId;
      if (typeof requestId !== "string" || !requestIds.includes(requestId) || (await tx.doc(PersonalServiceOperationDoc, requestId, null)).operation?.ref.taskId !== task.id) throw new PersonalError("service_operation_invalid", "服务执行缺少原操作事实，已停止恢复；请保留档案。");
    }
    cursor = page.next;
  } while (cursor);
  do {
    const page = await tx.scanConversations({}, 256, cursor);
    for (const conversation of page.items) {
      let entryCursor: Cursor | undefined;
      do {
        const entries = await tx.scanEntries({ conversationId: conversation.id }, 256, entryCursor);
        for (const entry of entries.items) if (ServiceWorkAdmission.is(entry)) {
          const op = await personalServiceOperation(tx, entry.data.ref);
          if (!workEnabled || op.work?.admission !== entry.id || op.work.ref.agentId !== conversation.id) throw new PersonalError("service_work_invalid", "原子服务接纳缺少操作回链，已停止恢复；请保留档案。");
        }
        entryCursor = entries.next;
      } while (entryCursor);
    }
    cursor = page.next;
  } while (cursor);
}
