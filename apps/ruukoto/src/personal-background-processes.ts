/** 会话后台持有独立 durable 记录；工具或创建轮结束均不释放目录。
 * Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-background-processes.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, defineTool, hook, LiveDoc, ROOT_CONVERSATION_ID, ToolTask, type ConversationId, type Cursor, type EntryId, type Harness, type TaskId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { BackgroundExecution, backgroundExecutionRef, prepareBackgroundExecution, stopBackgroundExecution } from "@ruukoto/agent/execution/background.ts";
import { ExecutionError, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import { PersonalError } from "./personal-error.ts";
import { personalToolOrigin, type PersonalToolOrigin } from "./personal-tool-source.ts";
import { personalSource } from "./personal-source.ts";
import { telegramSourceActive } from "./personal-permissions.ts";
import { samePersonalEntry, type PersonalEntryIdentity } from "./personal-telegram-records.ts";
import { personalCommandsFingerprint, PersonalCommandsDoc } from "./personal-command-work.ts";
import { verifyPersonalCommandConfig, type PersonalCommandConfig } from "./personal-command-config.ts";
import { acquirePersonalDirectory, releasePersonalDirectory, type PersonalDirectory } from "./personal-directory-claims.ts";
import { PersonalBackgroundCapture, readPersonalBackgroundLog, type PersonalBackgroundLogs } from "./personal-background-logs.ts";

export const PERSONAL_BACKGROUND = "personal-background-processes";
export const PERSONAL_BACKGROUND_TOOL_NAMES = ["process_start", "process_status", "process_output", "process_stop"];
type State = "starting" | "running" | "stop_requested" | "stopped" | "stop_unverified";
type ExecutionRef = Pick<ReturnType<typeof backgroundExecutionRef>, keyof ReturnType<typeof backgroundExecutionRef>>;
export type PersonalBackgroundProcess = { id: string; operation: TaskId; taskId: TaskId; command: string; origin: PersonalToolOrigin; config: PersonalCommandConfig; directory: PersonalDirectory; admission: EntryId; accepted: EntryId; claim: EntryId; state: State; createdAt: number; launchClaim?: EntryId; fingerprint?: string; execution: ExecutionRef; stopped: boolean; partial: boolean; reason?: string; logs?: PersonalBackgroundLogs; exit?: { code: number | null; signal: string | null }; observation?: EntryId; observations?: EntryId[]; stopIntents?: Array<{ taskId: TaskId; entry: EntryId; reason: string }>; stopTask?: TaskId };
type Closure = { requestId: string; actor?: PersonalEntryIdentity; through?: EntryId; processes: string[]; entry: EntryId };
export const PersonalBackgroundDoc = defineDoc<{ ids: string[]; closures: Closure[] }>({ kind: "ruukoto.background-processes", scope: "session", version: 1, initial: () => ({ ids: [], closures: [] }) });
export const PersonalBackgroundProcessDoc = defineDocFamily<{ process?: PersonalBackgroundProcess }, null>({ kind: "ruukoto.background-process", scope: "session", version: 1, family: true, initial: () => ({}) });
const BackgroundAdmission = defineEntry<Omit<PersonalBackgroundProcess, "admission" | "claim" | "state" | "stopped" | "partial">>("ruukoto.background-admission");
const BackgroundLaunch = defineEntry<{ id: string; fingerprint: string }>("ruukoto.background-launch");
const BackgroundObservation = defineEntry<{ id: string; state: State; stopped: boolean; partial: boolean; reason?: string; logs?: PersonalBackgroundLogs; exit?: { code: number | null; signal: string | null } }>("ruukoto.background-observation");
const BackgroundStop = defineEntry<{ id: string; reason: string; taskId: TaskId }>("ruukoto.background-stop");
const BackgroundClosure = defineEntry<Omit<Closure, "entry">>("ruukoto.background-closure");
const context = BACKGROUND_CONTEXT;

export async function personalBackgroundProcess(tx: Tx, id: string) {
  const process = (await tx.doc(PersonalBackgroundProcessDoc, id, null)).process;
  if (!process || process.id !== id) throw new PersonalError("background_not_found", "本会话没有该后台执行；请先查询本会话后台清单。");
  return process;
}
export async function personalBackgroundProcesses(tx: Tx) { const result: PersonalBackgroundProcess[] = []; for (const id of (await tx.doc(PersonalBackgroundDoc)).ids) result.push(await personalBackgroundProcess(tx, id)); return result; }
export function personalBackgroundView(process: Readonly<PersonalBackgroundProcess>) {
  const value = { process_id: process.id, state: process.state, command: process.command, source: process.origin.telegram ? process.origin.telegram.platform === "qq" ? "QQ" : "Telegram" : "本机", exit: process.exit ?? null, stopVerified: process.stopped, reason: process.reason ?? null, stdoutBytes: process.logs?.stdout.bytes ?? 0, stderrBytes: process.logs?.stderr.bytes ?? 0, partial: process.partial, createdAt: process.createdAt };
  return copyJson(value) as typeof value;
}
function closedBefore(closures: readonly Closure[], origin: PersonalToolOrigin, accepted: EntryId) { return closures.some(closure => closure.through !== undefined && accepted <= closure.through && (!closure.actor || samePersonalEntry(closure.actor, origin.telegram))); }
async function observe(tx: Tx, process: PersonalBackgroundProcess) {
  process.observation = (await tx.appendEntry(BackgroundObservation, ROOT_CONVERSATION_ID, { data: { id: process.id, state: process.state, stopped: process.stopped, partial: process.partial, ...(process.reason ? { reason: process.reason } : {}), ...(process.logs ? { logs: process.logs } : {}), ...(process.exit ? { exit: process.exit } : {}) } })).id;
  process.observations ??= []; process.observations.push(process.observation);
}
async function currentOrigin(tx: Tx, api: Pick<ToolExecutionApi, "taskId" | "conversationId">, requestId?: string) {
  const source = requestId ? await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId) : undefined;
  const origin = await personalToolOrigin(tx, api, requestId, { allowBlocked: true });
  if (api.conversationId !== ROOT_CONVERSATION_ID || origin.work || source?.conversationId !== ROOT_CONVERSATION_ID || (await personalSource(tx, origin.source.requestId, { active: true })).scheduled) throw new PersonalError("background_source_invalid", "本轮没有真实拥有者主会话来源；请结束本轮并报告拥有者。");
  return origin;
}
async function verifyOrigin(tx: Tx, process: PersonalBackgroundProcess, profile: string, launching = false) {
  verifyPersonalCommandConfig(process.config, profile);
  if ((await tx.doc(PersonalCommandsDoc)).fingerprint !== personalCommandsFingerprint(process.config)) throw new PersonalError("background_source_invalid", "原命令配置失效；已请求停止后台，请查询原记录。");
  const original = await personalSource(tx, process.origin.source.requestId, { active: launching });
  if (original.scheduled || original.telegram && !await telegramSourceActive(tx, original.telegram) || !isDeepStrictEqual(original.source, process.origin.source) || !isDeepStrictEqual(original.permission, process.origin.permission) || !isDeepStrictEqual(original.telegram, process.origin.telegram) || process.origin.permission.mode !== "full_access") throw new PersonalError("background_source_invalid", "后台原入口或授权失效；已请求停止，请查询原记录。");
}
export async function personalBackgroundToolNames(tx: Tx, conversationId: ConversationId, available: readonly string[], requestId?: string) {
  const records = (await personalBackgroundProcesses(tx)).filter(value => !value.stopped), active = records.length > 0;
  if (conversationId !== ROOT_CONVERSATION_ID) return available.filter(name => !PERSONAL_BACKGROUND_TOOL_NAMES.includes(name));
  const submission = requestId ? await tx.submissionByRequest(conversationId, requestId) : undefined;
  let owner = false, fullAccess = false;
  if (submission?.requestId) {
    try { const source = await personalSource(tx, submission.requestId, { active: true }); owner = !source.scheduled; fullAccess = owner && source.permission.mode === "full_access" && records.every(value => source.telegram ? samePersonalEntry(source.telegram, value.origin.telegram) : !value.origin.telegram); }
    catch (error) { if (!(error instanceof PersonalError)) throw error; }
  }
  if (!active) return available.filter(name => !PERSONAL_BACKGROUND_TOOL_NAMES.includes(name) || name !== "process_start" && owner || name === "process_start" && fullAccess);
  const allowed = ["process_status", "process_output", ...(owner ? ["process_stop", "ask_user"] : []), ...(fullAccess ? ["browser"] : [])];
  return available.filter(name => allowed.includes(name));
}

export function personalBackground(profile: string, config: PersonalCommandConfig, getHarness: () => Harness) {
  verifyPersonalCommandConfig(config, profile);
  const directory = path.join(profile, "background"), logsDirectory = path.join(directory, "logs"), executionsDirectory = path.join(directory, "executions");
  const starts = new Map<string, Promise<void>>();
  const units = new Map<string, BackgroundExecution>(), captures = new Map<string, PersonalBackgroundCapture>();
  type PendingCapture = { buffers: Record<"stdout" | "stderr", Buffer>; received: Record<"stdout" | "stderr", number>; committed: Record<"stdout" | "stderr", number>; scheduled: boolean; reason?: string; stopRecorded: boolean };
  const pendingCaptures = new Map<string, PendingCapture>();
  let shutdown: Promise<void> | undefined, persistenceFailure: PersonalError | undefined, failureClosing = false, harnessEnded = false;
  let persistence = Promise.resolve(), closing = false, timer: ReturnType<typeof setInterval> | undefined;
  const commit = <T>(change: (tx: Tx) => Promise<T>) => { if (persistenceFailure) return Promise.reject<T>(persistenceFailure); return getHarness().commit(change, context); };
  const snapshot = (id: string) => getHarness().snapshot(PersonalBackgroundProcessDoc, id, context).then(value => value?.process);
  function queue(change: (tx: Tx) => Promise<void>) {
    const operation = persistence.then(() => commit(change)).catch(error => { persistenceFailure ??= new PersonalError("background_persistence_failed", "后台事实无法保存，已停止执行并关闭会话；保留原目录认领，请核实档案。", { cause: error }); throw persistenceFailure; });
    persistence = operation;
    void operation.catch(async () => {
      if (failureClosing) return;
      failureClosing = true; if (timer) clearInterval(timer);
      await Promise.allSettled([...units.values()].map(unit => unit.stop()));
      await getHarness().close(context);
      process.stderr.write("[ruukoto:background] background_persistence_failed：后台事实提交失败，已停止受管执行并关闭会话；原认领保留。\n");
    }).catch(() => { process.stderr.write("[ruukoto:background] 后台事实失败后的关闭尚未核实；保留原认领，请检查档案。\n"); });
    return operation;
  }
  function flushCapture(id: string, pending: PendingCapture) {
    if (pending.scheduled || persistenceFailure) return;
    pending.scheduled = true;
    void queue(async tx => {
      const capture = captures.get(id);
      if (!capture) return;
      const process = await personalBackgroundProcess(tx, id);
      for (const stream of ["stdout", "stderr"] as const) {
        const end = pending.received[stream];
        if (end === pending.committed[stream]) continue;
        const result = capture.append(stream, pending.buffers[stream].subarray(pending.committed[stream], end));
        pending.committed[stream] = end; process.logs = result.logs;
        pending.reason ??= result.reason;
      }
      if (pending.reason) { process.partial = true; process.reason = pending.reason; if (!pending.stopRecorded) { await requestStop(tx, id, pending.reason); pending.stopRecorded = true; } }
      await observe(tx, process);
    }).then(() => {
      pending.scheduled = false;
      if (pending.received.stdout > pending.committed.stdout || pending.received.stderr > pending.committed.stderr || pending.reason && !pending.stopRecorded) flushCapture(id, pending);
    }, () => { pending.scheduled = false; });
  }
  function captureOutput(id: string, stream: "stdout" | "stderr", bytes: Buffer) {
    if (!captures.has(id) || !bytes.length || persistenceFailure) return;
    const limit = 16 * 1024 * 1024;
    let pending = pendingCaptures.get(id);
    if (!pending) { pending = { buffers: { stdout: Buffer.allocUnsafe(limit), stderr: Buffer.allocUnsafe(limit) }, received: { stdout: 0, stderr: 0 }, committed: { stdout: 0, stderr: 0 }, scheduled: false, stopRecorded: false }; pendingCaptures.set(id, pending); }
    const available = limit - pending.received.stdout - pending.received.stderr;
    if (available <= 0) return;
    const keep = bytes.subarray(0, available);
    keep.copy(pending.buffers[stream], pending.received[stream]); pending.received[stream] += keep.length;
    if (keep.length >= available) pending.reason = "background_output_limit";
    flushCapture(id, pending);
  }
  async function stopOnce(id: string, fromStart = false) {
    if (!fromStart) await starts.get(id);
    const saved = await snapshot(id);
    if (!saved || saved.stopped) return;
    let stopped = !saved.launchClaim, partial = saved.partial, reason = saved.reason ?? "stop_requested";
    try {
      const unit = units.get(id);
      if (saved.launchClaim && saved.fingerprint) { const result = unit ? await unit.stop() : await stopBackgroundExecution(executionsDirectory, saved.execution, saved.fingerprint); stopped = result.exited; partial ||= result.outputComplete === false || !unit; }
      else if (saved.launchClaim) stopped = false;
    } catch (error) { stopped = false; reason = error instanceof ExecutionError || error instanceof PersonalError ? error.code : "background_stop_failed"; }
    await persistence;
    await commit(async tx => { const current = await personalBackgroundProcess(tx, id); current.stopped = stopped; current.state = stopped ? "stopped" : "stop_unverified"; current.partial = partial || !stopped; current.reason = reason; if (stopped) await releasePersonalDirectory(tx, { kind: "background", operation: current.operation }); await observe(tx, current); });
    captures.get(id)?.close(); captures.delete(id); pendingCaptures.delete(id);
    if (stopped) units.delete(id);
  }
  const stopTask = defineTask<{ id: string; admission: EntryId; reason: string }, { phase: "stop" }, object>({
    name: "ruukoto.background-stop", version: 1, initial: () => ({ phase: "stop" }),
    phases: { async stop(current, runtime, context) { await stopOnce(current.input.id); await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), context); } },
    async abort(current, runtime, context) { await stopOnce(current.input.id); await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: {} } }), context); },
  });
  async function requestStop(tx: Tx, id: string, reason = "owner_requested") {
    const process = await personalBackgroundProcess(tx, id);
    if (process.stopped) return personalBackgroundView(process);
    process.state = "stop_requested"; process.reason = reason;
    if (!process.stopTask || (await tx.task(process.stopTask))?.state.status === "terminal") {
      process.stopTask = await tx.createTask(stopTask, { id, admission: process.admission, reason }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
      const entry = await tx.appendEntry(BackgroundStop, ROOT_CONVERSATION_ID, { data: { id, reason, taskId: process.stopTask } });
      process.stopIntents ??= []; process.stopIntents.push({ taskId: process.stopTask, entry: entry.id, reason });
    }
    await observe(tx, process);
    return personalBackgroundView(process);
  }
  const startTask = defineTask<{ id: string }, { phase: "start" | "verify" }, object>({
    name: "ruukoto.background-start", version: 1, initial: () => ({ phase: "start" }),
    phases: {
      async start(current, runtime, taskContext) {
        const saved = await snapshot(current.input.id);
        if (!saved) throw new PersonalError("background_record_invalid", "后台缺少原接纳记录，请保留档案。");
        if (saved.launchClaim) { await stopOnce(saved.id); await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), taskContext); return; }
        let finishStart!: () => void;
        starts.set(saved.id, new Promise<void>(resolve => { finishStart = resolve; }));
        try {
          const spec: LaunchSpec = { taskId: `personal-background:${saved.operation}`, mode: "full_access", workspace: config.workspace, workspaceIdentity: config.identity, grantedPaths: [] };
          const prepared = prepareBackgroundExecution(executionsDirectory, saved.execution, spec);
          const capture = new PersonalBackgroundCapture(path.join(logsDirectory, saved.id)); captures.set(saved.id, capture);
          let launch = false;
          await runtime.commit(async tx => {
            const value = await personalBackgroundProcess(tx, saved.id), state = await tx.doc(PersonalBackgroundDoc);
            if (closing || value.state !== "starting" || closedBefore(state.closures, value.origin, value.accepted)) return { status: "running", checkpoint: { phase: "verify" } };
            await verifyOrigin(tx, value, profile, true);
            await acquirePersonalDirectory(tx, { kind: "background", operation: value.operation }, value.directory);
            value.fingerprint = prepared.fingerprint; value.logs = capture.snapshot();
            value.launchClaim = (await tx.appendEntry(BackgroundLaunch, ROOT_CONVERSATION_ID, { data: { id: saved.id, fingerprint: prepared.fingerprint } })).id;
            await observe(tx, value); launch = true;
            return { status: "running", checkpoint: { phase: "verify" } };
          }, taskContext);
          if (launch) {
            const unit = await BackgroundExecution.launch(prepared, saved.command, String(saved.operation), {
              data: (stream, bytes) => captureOutput(saved.id, stream, bytes),
              exit: exit => { void queue(async tx => { const value = await personalBackgroundProcess(tx, saved.id); value.exit = exit; await observe(tx, value); }).catch(() => undefined); },
              failed: error => { void queue(async tx => { const value = await personalBackgroundProcess(tx, saved.id); value.partial = true; await requestStop(tx, saved.id, error.code); }).catch(() => undefined); },
            });
            if (persistenceFailure || closing) { await unit.stop(); if (persistenceFailure) throw persistenceFailure; }
            units.set(saved.id, unit);
            await persistence;
            await commit(async tx => { const value = await personalBackgroundProcess(tx, saved.id); if (value.state === "starting") value.state = "running"; await observe(tx, value); });
            watch();
          } else await stopOnce(saved.id, true);
        } catch (error) {
          const reason = error instanceof PersonalError || error instanceof ExecutionError ? error.code : "background_start_failed";
          await commit(async tx => { const value = await personalBackgroundProcess(tx, saved.id); value.partial = true; await requestStop(tx, saved.id, reason); });
          await stopOnce(saved.id, true);
        } finally { finishStart(); starts.delete(saved.id); }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), taskContext);
      },
      async verify(current, runtime, context) { await stopOnce(current.input.id); await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), context); },
    },
    async abort(current, runtime, context) { await stopOnce(current.input.id); await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: {} } }), context); },
  });
  function watch() {
    timer ??= setInterval(() => {
      void commit(async tx => { for (const process of await personalBackgroundProcesses(tx)) if (!process.stopped) { try { await verifyOrigin(tx, process, profile); } catch (error) { if (!(error instanceof PersonalError)) throw error; await requestStop(tx, process.id, error.code); } } }).catch(() => { for (const unit of units.values()) void unit.stop(); process.stderr.write("[ruukoto:background] 后台来源监督失败，已请求停止；保留认领并核实原档案。\n"); });
    }, 500);
    timer.unref();
  }
  async function requestIdFor(conversationId: ConversationId) {
    const live = await getHarness().snapshot(LiveDoc, conversationId, context), source = live?.run?.inputs.length === 1 ? await getHarness().submission(live.run.inputs[0], context) : undefined;
    return (await source?.status(context))?.requestId;
  }
  async function authorize(tx: Tx, api: Pick<ToolExecutionApi, "conversationId" | "taskId">, requestId?: string) { return currentOrigin(tx, api, requestId); }
  function visible(process: Readonly<PersonalBackgroundProcess>, origin?: PersonalToolOrigin) { return !origin?.telegram || samePersonalEntry(origin.telegram, process.origin.telegram); }
  function requireVisible(process: Readonly<PersonalBackgroundProcess>, origin: PersonalToolOrigin) { if (!visible(process, origin)) throw new PersonalError("background_source_invalid", "后台属于另一原入口，请从原平台查询；旧入口可用本机管理。"); }
  const processId = Type.String({ minLength: 1, description: "本会话 process_start/status 返回的 process_id。" });
  const invoke = async (api: ToolExecutionApi, run: () => Promise<unknown>) => {
    try { const value = await run(); return { output: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
    catch (error) { if (!(error instanceof PersonalError)) throw error; return { isError: true, output: [{ type: "text" as const, text: `${error.code}：${error.message}` }] }; }
  };
  const start = defineTool({ name: "process_start", description: "在固定命令目录启动一次独立后台命令，返回本会话process_id和实际状态，不保证服务健康。跨消息保留，原轮结束或取消不停止。启动后本轮只可查状态/日志、停止、提问或浏览；修改文件、普通命令和同目录委派须先process_stop，再用process_status核实stopped且stopVerified。每会话最多一个未核实执行；无stdin/PTY；日志合计16MiB达到限额自动停止。启动未知先查原记录，勿重放命令。", parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16384, description: "非空Shell命令，最多16384字符，不含NUL；开发服务明确绑定本机地址。" }) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential", async execute({ command }, api, callContext) { return invoke(api, async () => {
    const requestId = await requestIdFor(api.conversationId);
    const record = await api.commit(async tx => {
      const existing = (await personalBackgroundProcesses(tx)).find(value => value.operation === api.taskId);
      if (existing) { if (existing.command !== command) throw new PersonalError("background_request_conflict", "原后台工具参数不符，未重放；请查询原记录。"); return { id: existing.id, taskId: existing.taskId }; }
      const origin = await authorize(tx, api, requestId), state = await tx.doc(PersonalBackgroundDoc);
      const source = await personalSource(tx, origin.source.requestId);
      if (source.scheduled) throw new PersonalError("background_source_invalid", "定时工作不能启动会话后台，请结束本轮并报告拥有者。");
      const accepted = source.accepted;
      if (closing || origin.permission.mode !== "full_access" || closedBefore(state.closures, origin, accepted)) throw new PersonalError("background_source_invalid", "原拥有者输入不具启动资格或已结束后台；请结束本轮并报告拥有者。");
      if (!command.trim() || command.includes("\0")) throw new PersonalError("background_invalid_params", "命令须非空且不包含NUL，请修正命令。");
      if ((await personalBackgroundProcesses(tx)).some(value => !value.stopped)) throw new PersonalError("background_pending", "本会话已有未核实停止的后台；先查停原执行，勿重放命令。");
      verifyPersonalCommandConfig(config, profile);
      const id = `process_${randomBytes(12).toString("hex")}`, directory = { path: config.workspace, ...config.identity }, execution = backgroundExecutionRef();
      const claim = await acquirePersonalDirectory(tx, { kind: "background", operation: api.taskId }, directory);
      const taskId = await tx.createTask(startTask, { id }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
      const data = { id, operation: api.taskId, taskId, command, origin, config, directory, execution, accepted, createdAt: Date.now() };
      const admission = await tx.appendEntry(BackgroundAdmission, ROOT_CONVERSATION_ID, { data });
      (await tx.doc(PersonalBackgroundProcessDoc, id, null)).process = { ...data, admission: admission.id, claim, state: "starting", stopped: false, partial: false }; state.ids.push(id);
      return { id, taskId };
    }, callContext);
    await api.waitForTask(record.taskId, callContext);
    return commit(async tx => personalBackgroundView(await personalBackgroundProcess(tx, record.id)));
  }); } });
  const status = defineTool({ name: "process_status", description: "查询本会话后台；省略process_id按创建时间倒序每页最多20条及256KiB，offset默认0。指定ID不可带offset。stopped且stopVerified才证明整个受管执行停止；主命令退出码只是观察，不能证明业务成功、回滚或可重试。stop_unverified保留占用，请结束本轮并报告拥有者。", parameters: Type.Object({ process_id: Type.Optional(processId), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential", async execute(input, api) { return invoke(api, async () => { await persistence; const requestId = await requestIdFor(api.conversationId); return commit(async tx => { const origin = await authorize(tx, api, requestId); return statusIn(tx, input.process_id, input.offset, origin); }); }); } });
  const output = defineTool({ name: "process_output", description: "按原字节位置读本会话后台stdout/stderr；offset默认0，每页最多32KiB，用nextOffset继续。base64保真，text只作UTF-8预览，partial表示原证据不完整。日志URL只是候选，须browser真实访问核实；日志和退出码不证明业务效果。", parameters: Type.Object({ process_id: processId, stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential", async execute(input, api) { return invoke(api, async () => { await persistence; const requestId = await requestIdFor(api.conversationId); return commit(async tx => { const origin = await authorize(tx, api, requestId); requireVisible(await personalBackgroundProcess(tx, input.process_id), origin); return outputIn(tx, input.process_id, input.stream, input.offset); }); }); } });
  const stop = defineTool({ name: "process_stop", description: "登记本会话后台停止意图并立即返回；接纳不代表停止。随后process_status核实stopped且stopVerified，再重新取得目录写入。stop_unverified保留占用，请结束本轮并报告拥有者；重复停止只核实原执行，不重放命令。停止受管单元和已确认后代不证明外部写入回滚，主动脱离进程与外部服务须另行核实。", parameters: Type.Object({ process_id: processId }, { additionalProperties: false }), replay: "safe", executionMode: "sequential", async execute({ process_id }, api, callContext) { return invoke(api, async () => { const requestId = await requestIdFor(api.conversationId); return api.commit(async tx => { const origin = await authorize(tx, api, requestId); requireVisible(await personalBackgroundProcess(tx, process_id), origin); return requestStop(tx, process_id); }, callContext); }); } });
  async function statusIn(tx: Tx, id?: string, offset?: number, origin?: PersonalToolOrigin) {
    if (id !== undefined) { if (offset !== undefined) throw new PersonalError("background_invalid_params", "指定process_id时请省略offset。"); const process = await personalBackgroundProcess(tx, id); if (origin) requireVisible(process, origin); return personalBackgroundView(process); }
    const at = offset ?? 0;
    if (!Number.isSafeInteger(at) || at < 0) throw new PersonalError("background_invalid_params", "offset须为非负整数。");
    const all = (await personalBackgroundProcesses(tx)).filter(value => visible(value, origin)).reverse(), processes: ReturnType<typeof personalBackgroundView>[] = [];
    for (const process of all.slice(at, at + 20)) { const view = personalBackgroundView(process); if (Buffer.byteLength(JSON.stringify({ processes: [...processes, view], totalCount: all.length, nextOffset: at + processes.length + 1 })) > 256 * 1024) break; processes.push(view); }
    return { processes, totalCount: all.length, nextOffset: at + processes.length < all.length ? at + processes.length : null };
  }
  async function outputIn(tx: Tx, id: string, stream: "stdout" | "stderr", offset = 0) { const process = await personalBackgroundProcess(tx, id); return { ...readPersonalBackgroundLog(path.join(logsDirectory, id), process.logs, stream, offset), partial: process.partial }; }
  async function closeIn(tx: Tx, requestId: string, actor?: PersonalEntryIdentity) {
    const identity = actor && { ...(actor.platform ? { platform: actor.platform } : {}), botId: actor.botId, ownerId: actor.ownerId, generation: actor.generation };
    const doc = await tx.doc(PersonalBackgroundDoc), prior = doc.closures.find(value => value.requestId === requestId);
    if (prior) { if (!isDeepStrictEqual(prior.actor, identity)) throw new PersonalError("background_request_conflict", "结束请求的原入口不符，请查询原回执。"); return copyJson(prior) as Closure; }
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "descending" }, 1), through = page.items[0]?.id;
    const all = (await personalBackgroundProcesses(tx)).filter(value => !value.stopped && (!actor || samePersonalEntry(value.origin.telegram, actor)));
    const data = { requestId, ...(identity ? { actor: identity } : {}), ...(through ? { through } : {}), processes: all.map(value => value.id) };
    for (const process of all) await requestStop(tx, process.id, "session_background_end");
    const entry = await tx.appendEntry(BackgroundClosure, ROOT_CONVERSATION_ID, { data });
    const closure = { ...data, entry: entry.id }; doc.closures.push(closure);
    return copyJson(closure) as Closure;
  }
  const extension = defineExtension({ name: PERSONAL_BACKGROUND, tools: [start, status, output, stop], tasks: [startTask, stopTask], hooks: [hook(ToolTask, { async beforeTool(call, api) {
    const requestId = await requestIdFor(api.conversationId);
    const allowed = await commit(tx => personalBackgroundToolNames(tx, api.conversationId, [call.name], requestId));
    if (!allowed.includes(call.name)) return { block: "会话后台仍持有目录或本轮来源不允许该操作；请查停原后台，核实后再继续业务操作。" };
    return undefined;
  } })] });
  return { extension, directory, statusIn, outputIn, requestStop, closeIn,
    async stopLive() { await Promise.allSettled([...units.values()].map(unit => unit.stop())); },
    async verifyEvidence() { const all = await commit(async tx => copyJson(await personalBackgroundProcesses(tx)) as PersonalBackgroundProcess[]); for (const process of all) if (process.logs) for (const stream of ["stdout", "stderr"] as const) readPersonalBackgroundLog(path.join(logsDirectory, process.id), process.logs, stream); },
    async recover() { void getHarness().closed.then(() => { harnessEnded = true; }); for (const target of [directory, logsDirectory, executionsDirectory]) fs.mkdirSync(target, { recursive: true, mode: 0o700 }); const all = await commit(async tx => copyJson(await personalBackgroundProcesses(tx)) as PersonalBackgroundProcess[]); for (const process of all) if (!process.stopped) { await commit(tx => requestStop(tx, process.id, "backend_restart")); await stopOnce(process.id); } },
    close() { return shutdown ??= (async () => { closing = true; if (timer) clearInterval(timer); if (persistenceFailure || harnessEnded) { await Promise.allSettled([...units.values()].map(unit => unit.stop())); return; } const all = await commit(async tx => copyJson(await personalBackgroundProcesses(tx)) as PersonalBackgroundProcess[]); for (const process of all) if (!process.stopped) { await commit(tx => requestStop(tx, process.id, "backend_stop")); await stopOnce(process.id); } await persistence; })(); },
    async status(id?: string, offset?: number) { await persistence; return commit(tx => statusIn(tx, id, offset)); },
    async output(id: string, stream: "stdout" | "stderr", offset = 0) { await persistence; return commit(tx => outputIn(tx, id, stream, offset)); },
    async stop(id: string) { const result = await commit(tx => requestStop(tx, id)); getHarness().resume(); return result; },
    async end(requestId: string) { const closure = await commit(tx => closeIn(tx, requestId)); getHarness().resume(); return closure; },
    async endStatus(requestId: string) { return commit(async tx => { const closure = (await tx.doc(PersonalBackgroundDoc)).closures.find(value => value.requestId === requestId); if (!closure) return { accepted: false }; const processes = []; for (const id of closure.processes) processes.push(personalBackgroundView(await personalBackgroundProcess(tx, id))); return { accepted: true, processes, stopVerified: processes.every(value => value.stopVerified) }; }); },
  };
}

export async function verifyPersonalBackground(tx: Tx, keys: string[], enabled: boolean, tools: NonNullable<ReturnType<typeof personalBackground>["extension"]["tools"]> = []) {
  const doc = await tx.doc(PersonalBackgroundDoc), values = await personalBackgroundProcesses(tx), invalid = () => new PersonalError("background_record_invalid", "后台记录与原工具、来源或停止事实不符，已停止恢复；请保留档案。");
  if (!Array.isArray(doc.ids) || new Set(doc.ids).size !== doc.ids.length || keys.length !== values.length || values.some(value => !keys.includes(value.id)) || values.length > 0 && !enabled) throw invalid();
  if (!await tx.conversation(ROOT_CONVERSATION_ID)) { if (values.length || doc.closures.length) throw invalid(); return; }
  for (const process of values) {
    const admission = await tx.entry(BackgroundAdmission, process.admission), task = await tx.task(process.taskId), tool = await tx.task(process.operation), input = tool?.input;
    const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
    const call = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && input && typeof input === "object" && !Array.isArray(input) && part.id === input.callId);
    let normalized: unknown;
    if (call?.type === "toolCall") {
      const definition = tools.find(tool => tool.name === call.name);
      if (!definition) throw invalid();
      try { normalized = validateToolArguments(definition, { ...call, arguments: copyJson(call.arguments) as { command: string } }); } catch { throw invalid(); }
    }
    const data = { id: process.id, operation: process.operation, taskId: process.taskId, command: process.command, origin: process.origin, config: process.config, directory: process.directory, execution: process.execution, accepted: process.accepted, createdAt: process.createdAt };
    if (!admission || admission.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(admission.data, data) || task?.kind !== "ruukoto.background-start" || task.version !== 1 || task.owner !== undefined || !task.background || task.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(task.input, { id: process.id }) || tool?.kind !== "pi.tool" || tool.conversationId !== ROOT_CONVERSATION_ID || tool.owner !== process.origin.generation || assistant?.byTaskId !== process.origin.generation || assistant.id >= admission.id || call?.type !== "toolCall" || call.name !== "process_start" || !isDeepStrictEqual(normalized, { command: process.command }) || process.origin.work || process.origin.conversationId !== ROOT_CONVERSATION_ID || process.origin.permission.mode !== "full_access" || !["starting", "running", "stop_requested", "stopped", "stop_unverified"].includes(process.state) || process.stopped !== (process.state === "stopped")) throw invalid();
    const source = await personalSource(tx, process.origin.source.requestId);
    if (source.scheduled || source.accepted !== process.accepted || !isDeepStrictEqual(source.source, process.origin.source) || !isDeepStrictEqual(source.permission, process.origin.permission) || !isDeepStrictEqual(source.telegram, process.origin.telegram)) throw invalid();
    if (process.launchClaim) { const entry = await tx.entry(BackgroundLaunch, process.launchClaim); if (!entry || entry.id <= admission.id || !process.fingerprint || !isDeepStrictEqual(entry.data, { id: process.id, fingerprint: process.fingerprint })) throw invalid(); }
    else if (process.fingerprint || process.state === "running") throw invalid();
    if (process.launchClaim && !process.logs) throw invalid();
    if ((process.observations?.at(-1) !== process.observation) || process.observations?.some((id, index, all) => id <= process.admission || index > 0 && id <= all[index - 1])) throw invalid();
    for (const intent of process.stopIntents ?? []) {
      const entry = await tx.entry(BackgroundStop, intent.entry), task = await tx.task(intent.taskId);
      if (!entry || !isDeepStrictEqual(entry.data, { id: process.id, reason: intent.reason, taskId: intent.taskId }) || task?.kind !== "ruukoto.background-stop" || task.version !== 1 || task.owner !== undefined || !task.background || task.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(task.input, { id: process.id, admission: process.admission, reason: intent.reason })) throw invalid();
    }
    if (process.stopIntents?.at(-1)?.taskId !== process.stopTask) throw invalid();
    if (process.observation) { const entry = await tx.entry(BackgroundObservation, process.observation); if (!entry || !isDeepStrictEqual(entry.data, { id: process.id, state: process.state, stopped: process.stopped, partial: process.partial, ...(process.reason ? { reason: process.reason } : {}), ...(process.logs ? { logs: process.logs } : {}), ...(process.exit ? { exit: process.exit } : {}) })) throw invalid(); }
  }
  for (const closure of doc.closures) { const entry = await tx.entry(BackgroundClosure, closure.entry); if (!entry || !isDeepStrictEqual(entry.data, { requestId: closure.requestId, ...(closure.actor ? { actor: closure.actor } : {}), ...(closure.through ? { through: closure.through } : {}), processes: closure.processes }) || closure.processes.some(id => !values.some(value => value.id === id && value.admission < entry.id))) throw invalid(); }
  let conversations: Cursor | undefined;
  do { const page = await tx.scanConversations({}, 256, conversations); for (const conversation of page.items) { let cursor: Cursor | undefined; do { const entries = await tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 256, cursor); for (const entry of entries.items) {
    if ((BackgroundAdmission.is(entry) || BackgroundLaunch.is(entry) || BackgroundObservation.is(entry) || BackgroundClosure.is(entry) || BackgroundStop.is(entry)) && conversation.id !== ROOT_CONVERSATION_ID) throw invalid();
    if (BackgroundAdmission.is(entry) && !values.some(value => value.admission === entry.id) || BackgroundLaunch.is(entry) && !values.some(value => value.launchClaim === entry.id) || BackgroundObservation.is(entry) && !values.some(value => value.observations?.includes(entry.id)) || BackgroundClosure.is(entry) && !doc.closures.some(value => value.entry === entry.id) || BackgroundStop.is(entry) && !values.some(value => value.stopIntents?.some(intent => intent.entry === entry.id))) throw invalid();
  } cursor = entries.next; } while (cursor); } conversations = page.next; } while (conversations);
  for (const kind of ["ruukoto.background-start", "ruukoto.background-stop"]) { let cursor: Cursor | undefined; do { const page = await tx.scanTasks({ kind }, 256, cursor); for (const task of page.items) if (!values.some(value => kind === "ruukoto.background-start" ? value.taskId === task.id : value.stopIntents?.some(intent => intent.taskId === task.id))) throw invalid(); cursor = page.next; } while (cursor); }
}
