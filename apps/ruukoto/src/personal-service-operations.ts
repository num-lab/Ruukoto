import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Cursor, type DocumentObserver, type EntryId, type Harness, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { inspectServiceReply } from "./personal-services.ts";
import { callHelper, opUnitFor, ServiceHelperError, type HelperReply, type ServiceManagerConfig } from "./service-helper.ts";

export type PersonalServiceMode = "auto-review" | "confirm" | "full_access";
type Effect = { effect: "executed" | "not_executed" | "effect_unknown"; code: string; exitCode?: number };
export type PersonalServiceOperationRef = { requestId: string; taskId: TaskId<Effect> };
type Snapshot = { machineId: string; policyRevision: string; unitRevision: string };
type Operation = {
  ref: PersonalServiceOperationRef; unit: string; mode: PersonalServiceMode; fingerprint: string; hostOpId: string;
  source: { requestId: string; submissionId: SubmissionId; entryId: EntryId };
  snapshot?: Snapshot; decision: "pending" | "approved" | "rejected"; consumed: boolean; cancelRequested: boolean;
  result?: Effect; launcherStopped: boolean; resolution?: { effect: "applied" | "not_applied"; evidence: string };
};
type Input = { requestId: string };
type State = { phase: "prepare" | "verify" };
export const PersonalServiceOperationsDoc = defineDoc({ kind: "ruukoto.service-operations-config", scope: "session", version: 1, initial: () => ({ enabled: true }) });
export const PersonalServiceOperationDoc = defineDocFamily<{ operation?: Operation }, null>({ kind: "ruukoto.service-operation", scope: "session", version: 1, family: true, initial: () => ({}) });
export const ServiceOperationEvidence = defineEntry<{ requestId: string; verb: string; stdout: string; stderr: string; truncated: boolean; code: string }>("ruukoto.service-operation-evidence");
const context = BACKGROUND_CONTEXT;

async function operation(tx: Tx, ref: { requestId: string; taskId: TaskId }) {
  const value = (await tx.doc(PersonalServiceOperationDoc, ref.requestId, null)).operation;
  if (!value || value.ref.taskId !== ref.taskId) throw new PersonalError("service_operation_missing", "找不到原服务操作，请保留档案并查询原工作。");
  return value;
}

async function sourceValid(tx: Tx, op: Operation, active = true) {
  const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, op.source.requestId);
  const entry = await tx.entry(op.source.entryId);
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

function unresolved(op: Operation) { return op.consumed && (!op.result || (op.result.effect === "effect_unknown" && (!op.resolution || !op.launcherStopped))); }

function stopped(reply: HelperReply | undefined, op: Operation) {
  return reply?.ok === true && reply.verb === "stop-op" && reply.machineId === op.snapshot?.machineId && reply.hostOpId === op.hostOpId && reply.opUnit === opUnitFor(op.hostOpId) && reply.exited === true && "launcherExited" in reply && reply.launcherExited === true;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-service-operations.md
export function personalServiceOperations(config: ServiceManagerConfig) {
  const task = defineTask<Input, State, Effect>({
    name: "ruukoto.service-operation", version: 1, initial: () => ({ phase: "prepare" }),
    phases: {
      async prepare(current, runtime, context) {
        const ref = { requestId: current.input.requestId, taskId: current.id };
        let op = await runtime.snapshot(PersonalServiceOperationDoc, ref.requestId, context);
        if (!op?.operation) throw new PersonalError("service_operation_missing", "服务操作缺少原记录，已停止；请检查档案。");
        if (!op.operation.snapshot) {
          const response = await invoke(config, "inspect", [op.operation.unit], runtime.signal, config.timeouts?.inspectMs ?? 20_000);
          let snapshot: Snapshot | undefined;
          let code = response.evidence.code;
          try { snapshot = inspectServiceReply(response.reply, op.operation.unit); } catch (error) {
            if (!(error instanceof ServiceHelperError)) throw error;
            code = error.code;
          }
          await runtime.commit(async tx => {
            const value = await operation(tx, ref);
            await tx.appendEntry(ServiceOperationEvidence, ROOT_CONVERSATION_ID, { data: { requestId: ref.requestId, ...response.evidence, code } });
            if (!snapshot) {
              value.result = { effect: "not_executed", code };
              return { status: "terminal", outcome: { status: "completed", result: value.result } };
            }
            value.snapshot = { machineId: snapshot.machineId, policyRevision: snapshot.policyRevision, unitRevision: snapshot.unitRevision };
            return undefined;
          }, context);
          if (!snapshot) return;
        }
        await waitForChange(runtime, ref.requestId, value => value.decision !== "pending" || value.mode === "full_access" || value.cancelRequested, context);
        let execute = false;
        await runtime.commit(async tx => {
          const value = await operation(tx, ref);
          let code: string | undefined;
          if (value.cancelRequested || !await sourceValid(tx, value)) code = "source_inactive";
          else if (value.decision === "rejected") code = "rejected";
          else {
            let revision: string | undefined;
            try { revision = createHash("sha256").update(readFileSync(config.policyPath)).digest("hex"); } catch {
              // 策略不可读使本次批准失效，不派发操作。
              code = "policy_unreadable";
            }
            if (revision !== value.snapshot?.policyRevision) code ??= "policy_changed";
          }
          if (code) {
            value.result = { effect: "not_executed", code };
            return { status: "terminal", outcome: { status: value.cancelRequested ? "aborted" : "completed", result: value.result } };
          }
          if (value.consumed || (value.mode !== "full_access" && value.decision !== "approved")) throw new PersonalError("service_approval_invalid", "服务批准无法消费，已停止；请核实原操作。");
          value.consumed = true;
          value.result = { effect: "effect_unknown", code: "started" };
          execute = true;
          return { status: "running", checkpoint: { phase: "verify" } };
        }, context);
        if (!execute) return;
        op = await runtime.snapshot(PersonalServiceOperationDoc, ref.requestId, context);
        const value = op!.operation!;
        const response = await invoke(config, "restart", [value.hostOpId, value.snapshot!.policyRevision, value.snapshot!.unitRevision, value.unit], runtime.signal, config.timeouts?.restartMs ?? 150_000);
        const result = classify(response.reply, value);
        await runtime.commit(async tx => {
          const value = await operation(tx, ref);
          await tx.appendEntry(ServiceOperationEvidence, ROOT_CONVERSATION_ID, { data: { requestId: ref.requestId, ...response.evidence } });
          value.result = result;
          if (result.effect !== "effect_unknown") return { status: "terminal", outcome: { status: "completed", result } };
          return undefined;
        }, context);
        if (result.effect === "effect_unknown") await verify(ref, runtime, context);
      },
      async verify(current, runtime, context) { await verify({ requestId: current.input.requestId, taskId: current.id }, runtime, context); },
    },
    async abort(current, runtime, context) {
      const ref = { requestId: current.input.requestId, taskId: current.id };
      await runtime.commit(async tx => { (await operation(tx, ref)).cancelRequested = true; return undefined; }, context);
      const op = (await runtime.snapshot(PersonalServiceOperationDoc, ref.requestId, context))?.operation;
      if (!op) throw new PersonalError("service_operation_missing", "取消时原服务记录缺失，占用保留；请检查档案。");
      if (op.consumed) { await verify(ref, runtime, context); return; }
      await runtime.commit(async tx => {
        const value = await operation(tx, ref);
        value.result = { effect: "not_executed", code: "canceled" };
        return { status: "terminal", outcome: { status: "aborted", result: value.result } };
      }, context);
    },
  });

  async function verify(ref: PersonalServiceOperationRef, runtime: Parameters<typeof task.definition.phases.verify>[1], context: Context) {
    await runtime.commit(async tx => { const value = await operation(tx, ref); if (!value.result || value.result.code === "started") value.result = { effect: "effect_unknown", code: "interrupted" }; return undefined; }, context);
    const value = (await runtime.snapshot(PersonalServiceOperationDoc, ref.requestId, context))!.operation!;
    const response = await invoke(config, "stop-op", [value.hostOpId], runtime.signal, config.timeouts?.stopMs ?? 15_000);
    const reply = response.reply;
    await runtime.commit(async tx => {
      const value = await operation(tx, ref);
      await tx.appendEntry(ServiceOperationEvidence, ROOT_CONVERSATION_ID, { data: { requestId: ref.requestId, ...response.evidence } });
      value.launcherStopped ||= stopped(reply, value);
      return undefined;
    }, context);
    await waitForChange(runtime, ref.requestId, value => !!value.resolution && value.launcherStopped, context);
    await runtime.commit(async tx => {
      const value = await operation(tx, ref);
      return { status: "terminal", outcome: value.cancelRequested ? { status: "aborted", result: value.result! } : { status: "completed", result: value.result! } };
    }, context);
  }

  const extension = defineExtension({ name: "personal-service-operations", tasks: [task] });
  return { task, extension,
    api(harness: Harness) {
      return {
        async request(input: { unit: string; sourceRequestId: string; requestId: string; mode?: PersonalServiceMode }): Promise<PersonalServiceOperationRef> {
          const mode = input.mode ?? "auto-review";
          if (!/^[A-Za-z0-9_.-]+\.service$/.test(input.unit) || input.unit.length > 128 || !input.requestId || input.requestId.length > 256 || !input.sourceRequestId || input.sourceRequestId.length > 256 || !["auto-review", "confirm", "full_access"].includes(mode)) throw new PersonalError("service_input_invalid", "服务目标、模式或原请求引用无效，请使用精确服务名和原输入。");
          const fingerprint = createHash("sha256").update(JSON.stringify([input.unit, input.sourceRequestId, mode])).digest("hex");
          const ref = await harness.commit(async tx => {
            const record = await tx.doc(PersonalServiceOperationDoc, input.requestId, null);
            if (record.operation) {
              if (record.operation.fingerprint !== fingerprint) throw new PersonalError("service_request_conflict", "同键服务操作内容不符，请查询原操作，不要换键自动重试。");
              return { ...record.operation.ref };
            }
            const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, input.sourceRequestId);
            const entry = source?.entry && await tx.entry(source.entry);
            if (source?.type !== "input" || (source.status !== "placed" && source.status !== "done") || entry?.kind !== "pi.user") throw new PersonalError("service_source_invalid", "服务工作需要已进入主会话的拥有者输入，请先核实原输入。");
            let cursor: Cursor | undefined;
            do {
              const page = await tx.scanTasks({ kind: task.definition.name }, 256, cursor);
              for (const current of page.items) {
                const requestId = current.input && typeof current.input === "object" && !Array.isArray(current.input) && current.input.requestId;
                if (typeof requestId !== "string") throw new PersonalError("service_operation_missing", "已有服务工作记录无法核实，已拒绝新操作。");
                const other = await operation(tx, { requestId, taskId: current.id });
                if (current.state.status === "terminal" && !unresolved(other)) continue;
                if (other.unit === input.unit || other.source.requestId === input.sourceRequestId) throw new PersonalError("service_operation_busy", "服务目标或原工作仍未结束，请查询并处理原操作；不能换键重试。");
              }
              cursor = page.next;
            } while (cursor);
            const taskId = await tx.createTask(task, { requestId: input.requestId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
            const ref = { requestId: input.requestId, taskId };
            record.operation = { ref, unit: input.unit, mode, fingerprint, hostOpId: `op_${randomBytes(12).toString("hex")}`, source: { requestId: input.sourceRequestId, submissionId: source.id, entryId: entry.id }, decision: "pending", consumed: false, cancelRequested: false, launcherStopped: false };
            return ref;
          }, context);
          harness.resume();
          return ref;
        },
        async status(ref: PersonalServiceOperationRef) { return harness.commit(async tx => ({ operation: copyJson(await operation(tx, ref)) as Operation, task: await tx.task(ref.taskId) }), context); },
        async list(cursor?: Cursor) {
          return harness.commit(async tx => {
            const page = await tx.scanTasks({ kind: task.definition.name, order: "descending" }, 32, cursor);
            const items = [];
            for (const current of page.items) {
              const requestId = current.input && typeof current.input === "object" && !Array.isArray(current.input) && current.input.requestId;
              if (typeof requestId !== "string") throw new PersonalError("service_operation_missing", "服务工作记录无法核实，请保留档案。");
              items.push({ operation: copyJson(await operation(tx, { requestId, taskId: current.id })) as Operation, task: current });
            }
            return { items, next: page.next };
          }, context);
        },
        async decide(ref: PersonalServiceOperationRef, decision: "approved" | "rejected") {
          if (decision !== "approved" && decision !== "rejected") throw new PersonalError("service_decision_invalid", "请选择批准或拒绝原服务操作。");
          await harness.commit(async tx => {
            const value = await operation(tx, ref);
            if (value.decision === decision && !value.cancelRequested) return;
            const current = await tx.task(ref.taskId);
            if (!value.snapshot || value.consumed || value.cancelRequested || value.decision !== "pending" || current?.state.status === "terminal" || current?.abortRequested || !await sourceValid(tx, value)) throw new PersonalError("service_approval_invalid", "原服务审批已失效或已消费，请查询原操作。");
            value.decision = decision;
          }, context);
        },
        async cancel(ref: PersonalServiceOperationRef) {
          await harness.commit(async tx => { const value = await operation(tx, ref); if ((await tx.task(ref.taskId))?.state.status !== "terminal") value.cancelRequested = true; }, context);
          await harness.abortTask(ref.taskId, context);
        },
        async resolve(ref: PersonalServiceOperationRef, effect: "applied" | "not_applied", evidence: string) {
          if (!["applied", "not_applied"].includes(effect) || !evidence.trim() || evidence.length > 8192) throw new PersonalError("service_resolution_invalid", "核实需要选择已生效或未生效，并提供有界证据说明。");
          await harness.commit(async tx => {
            const value = await operation(tx, ref);
            if (value.consumed && (!value.result || value.result.code === "started") && (await tx.task(ref.taskId))?.state.status === "terminal") value.result = { effect: "effect_unknown", code: "interrupted" };
            if (value.result?.effect !== "effect_unknown" || value.result.code === "started" || value.resolution) throw new PersonalError("service_resolution_invalid", "原操作不处于待核实状态，或已保存核实结果；请查询原记录。");
            value.resolution = { effect, evidence };
          }, context);
        },
        async recheckStop(ref: PersonalServiceOperationRef) {
          const value = await harness.commit(async tx => {
            const value = await operation(tx, ref);
            if (value.consumed && (!value.result || value.result.code === "started") && (await tx.task(ref.taskId))?.state.status === "terminal") value.result = { effect: "effect_unknown", code: "interrupted" };
            return copyJson(value) as Operation;
          }, context);
          if (value.result?.effect !== "effect_unknown" || value.result.code === "started") throw new PersonalError("service_resolution_invalid", "原操作没有待核实停止的未知效果，请查询原记录。");
          const response = await invoke(config, "stop-op", [value.hostOpId], new AbortController().signal, config.timeouts?.stopMs ?? 15_000);
          const reply = response.reply;
          await harness.commit(async tx => {
            const value = await operation(tx, ref);
            await tx.appendEntry(ServiceOperationEvidence, ROOT_CONVERSATION_ID, { data: { requestId: ref.requestId, ...response.evidence } });
            value.launcherStopped ||= stopped(reply, value);
          }, context);
        },
      };
    },
  };
}

export async function verifyServiceOperationRecords(tx: Tx, requestIds: string[]) {
  const activeTargets = new Set<string>();
  const activeSources = new Set<string>();
  for (const requestId of requestIds) {
    const value = (await tx.doc(PersonalServiceOperationDoc, requestId, null)).operation;
    const task = value && await tx.task(value.ref.taskId);
    if (!value || value.ref.requestId !== requestId || !task || task.kind !== "ruukoto.service-operation" || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !task.input || typeof task.input !== "object" || Array.isArray(task.input) || task.input.requestId !== requestId || !await sourceValid(tx, value, false)) throw new PersonalError("service_operation_invalid", "服务操作的来源、执行或归属无法核实，已停止恢复；请保留档案。");
    if (value.consumed && (!value.result || (task.state.status === "terminal" && value.result.code === "started"))) value.result = { effect: "effect_unknown", code: "interrupted" };
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
}
