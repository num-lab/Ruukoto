/** 会话后台记录、停止屏障与目录交接；写入由调用方 Store.withTx 包住。
 * Note: 见 .agents/notes/implemented/feature/2026-10-21-coding-background-processes.md
 */
import { isDeepStrictEqual } from "node:util";
import type { AgentReferenceSnapshot } from "./agent-wait.ts";
import { ownerQuestionTaskEligible } from "./owner-questions.ts";
import type { Store } from "./store.ts";
import { randomId, type GrantedPath, type Task } from "./types.ts";
import { getCodingTaskOrigin, isCodingTaskOrigin, type CodingTaskOrigin } from "./code-scheduler.ts";

export type BackgroundProcessState = "starting" | "running" | "stop_requested" | "stopped" | "stop_unverified";
export interface BackgroundExecutionRef { platform: "linux" | "darwin"; executionId: string; machineId?: string }
export interface BackgroundWorkspace { path: string; dev: number; ino: number }
export interface BackgroundLogIdentity { dev: number; ino: number; sha256: string }
export interface BackgroundLogEvidence { stdout: BackgroundLogIdentity; stderr: BackgroundLogIdentity }
export interface BackgroundProcessView {
  id: string;
  sessionId: string;
  taskId: string;
  command: string;
  source: CodingTaskOrigin & { accessMode: "full_access" };
  state: BackgroundProcessState;
  exit: { code: number | null; signal: string | null } | null;
  stopVerified: boolean;
  reason: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  partial: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface BackgroundProcess extends BackgroundProcessView {
  hostOpId: string;
  workspace: BackgroundWorkspace;
  source: CodingTaskOrigin & { projectId: string; input: string; accessMode: "full_access"; permissionVersion: number; grantedPaths: GrantedPath[]; inputSeq: number };
  permissionVersion: number;
  handedOff: boolean;
  launchClaimed: boolean;
  launchFingerprint: string | null;
  referenceSnapshot: AgentReferenceSnapshot | null;
  ref: BackgroundExecutionRef;
  logEvidence: BackgroundLogEvidence | null;
}
export interface BackgroundClosure { sessionId: string; requestKey: string; throughInputSeq: number; processIds: string[]; createdAt: string }
export class BackgroundProcessError extends Error {
  constructor(readonly code: string, message = `后台操作未接纳（${code}）；保留记录，核实本会话后台状态后继续。`) {
    super(message);
    this.name = "BackgroundProcessError";
  }
}

const STATES: readonly BackgroundProcessState[] = ["starting", "running", "stop_requested", "stopped", "stop_unverified"];
const count = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const validWorkspace = (value: BackgroundWorkspace): boolean => Boolean(value && typeof value.path === "string" && value.path.startsWith("/") && count(value.dev) && count(value.ino));
const validRef = (value: BackgroundExecutionRef): boolean => Boolean(value && ["linux", "darwin"].includes(value.platform) && typeof value.executionId === "string" && value.executionId && (value.machineId === undefined || typeof value.machineId === "string"));
const validLogEvidence = (value: BackgroundLogEvidence): boolean => Boolean(value && [value.stdout, value.stderr].every(stream => stream && count(stream.dev) && count(stream.ino) && typeof stream.sha256 === "string" && /^[0-9a-f]{64}$/.test(stream.sha256)));
function validSnapshot(value: AgentReferenceSnapshot | null, process: Pick<BackgroundProcess, "taskId" | "permissionVersion">): boolean {
  return Boolean(value && value.taskId === process.taskId && value.permissionVersion === process.permissionVersion &&
    (value.selectionRecordId === null || typeof value.selectionRecordId === "string") && (value.promptArtifactId === null || typeof value.promptArtifactId === "string") &&
    (value.instructions === null || (typeof value.instructions?.text === "string" && typeof value.instructions.version === "string" && Array.isArray(value.instructions.problems))) &&
    (value.skills === null || (Array.isArray(value.skills?.skills) && Array.isArray(value.skills.diagnostics) && typeof value.skills.version === "string")));
}

type ProcessRow = { id: string; session_id: string; task_id: string; host_op_id: string; state: string; payload: string };
function fromRow(row: ProcessRow | undefined): BackgroundProcess | null {
  if (!row) return null;
  let value: BackgroundProcess;
  try { value = JSON.parse(row.payload) as BackgroundProcess; }
  catch { throw new BackgroundProcessError("background_corrupt"); }
  if (!value || value.id !== row.id || value.sessionId !== row.session_id || value.taskId !== row.task_id || value.hostOpId !== row.host_op_id || value.state !== row.state ||
      !STATES.includes(value.state) || typeof value.command !== "string" || !value.command.trim() || value.command.length > 16384 || !validWorkspace(value.workspace) || !validRef(value.ref) ||
      !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" ||
      typeof value.stopVerified !== "boolean" || typeof value.partial !== "boolean" || typeof value.handedOff !== "boolean" || typeof value.launchClaimed !== "boolean" ||
      (value.launchFingerprint !== null && (typeof value.launchFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.launchFingerprint))) || (value.reason !== null && typeof value.reason !== "string") ||
      (value.logEvidence !== null && !validLogEvidence(value.logEvidence)) ||
      !count(value.stdoutBytes) || !count(value.stderrBytes) || value.stdoutBytes + value.stderrBytes > 16 * 1024 * 1024 ||
      !isCodingTaskOrigin(value.source) || typeof value.source.projectId !== "string" || typeof value.source.input !== "string" || value.source.accessMode !== "full_access" ||
      !Number.isSafeInteger(value.permissionVersion) || value.permissionVersion < 1 || value.source.permissionVersion !== value.permissionVersion || !Array.isArray(value.source.grantedPaths) ||
      value.source.grantedPaths.some(grant => !grant || typeof grant.path !== "string" || !["read", "read_write"].includes(grant.access) || typeof grant.purpose !== "string") || !count(value.source.inputSeq) || value.source.inputSeq === 0 ||
      (value.exit !== null && (!value.exit || (value.exit.code !== null && !Number.isInteger(value.exit.code)) || (value.exit.signal !== null && typeof value.exit.signal !== "string"))) ||
      (value.handedOff && !validSnapshot(value.referenceSnapshot, value)) || (!value.handedOff && (value.referenceSnapshot !== null || value.launchClaimed)) ||
      (value.state === "running" && !value.launchClaimed) || value.stopVerified !== (value.state === "stopped")) throw new BackgroundProcessError("background_corrupt", "后台记录无法核实；保留档案与占用，检查存储后继续。");
  return value;
}
export function backgroundProcessToView(process: BackgroundProcess): BackgroundProcessView {
  const { id, sessionId, taskId, command, state, exit, stopVerified, reason, stdoutBytes, stderrBytes, partial, version, createdAt, updatedAt } = process;
  const origin: CodingTaskOrigin = process.source.kind === "coding-owner" ? { kind: "coding-owner" } : { kind: "coding-schedule", runId: process.source.runId, scheduleId: process.source.scheduleId, planVersion: process.source.planVersion };
  return { id, sessionId, taskId, command, source: { ...origin, accessMode: process.source.accessMode }, state, exit: structuredClone(exit), stopVerified, reason, stdoutBytes, stderrBytes, partial, version, createdAt, updatedAt };
}
export function getBackgroundProcess(store: Store, id: string): BackgroundProcess | null {
  return fromRow(store.db.prepare("SELECT * FROM background_processes WHERE id = ?").get(id) as ProcessRow | undefined);
}
export function findBackgroundProcessByOp(store: Store, hostOpId: string): BackgroundProcess | null {
  return fromRow(store.db.prepare("SELECT * FROM background_processes WHERE host_op_id = ?").get(hostOpId) as ProcessRow | undefined);
}
export function listBackgroundProcesses(store: Store, sessionId: string): BackgroundProcess[] {
  return (store.db.prepare("SELECT * FROM background_processes WHERE session_id = ? ORDER BY rowid DESC").all(sessionId) as ProcessRow[]).map(row => fromRow(row)!);
}
export function listActiveBackgroundProcesses(store: Store, sessionId?: string): BackgroundProcess[] {
  return (store.db.prepare("SELECT * FROM background_processes WHERE state != 'stopped' AND (? IS NULL OR session_id = ?) ORDER BY rowid").all(sessionId ?? null, sessionId ?? null) as ProcessRow[]).map(row => fromRow(row)!);
}
export function pageBackgroundProcesses(store: Store, input: { sessionId: string; offset?: number }): { processes: BackgroundProcessView[]; totalCount: number; nextOffset: number | null } {
  const offset = input.offset ?? 0;
  if (!count(offset)) throw new BackgroundProcessError("invalid_params");
  const totalCount = Number((store.db.prepare("SELECT COUNT(*) AS n FROM background_processes WHERE session_id = ?").get(input.sessionId) as { n: number }).n);
  const candidates = (store.db.prepare("SELECT * FROM background_processes WHERE session_id = ? ORDER BY rowid DESC LIMIT 20 OFFSET ?").all(input.sessionId, offset) as ProcessRow[]).map(row => backgroundProcessToView(fromRow(row)!));
  const processes: BackgroundProcessView[] = [];
  for (const process of candidates) {
    const nextProcesses = [...processes, process], end = offset + nextProcesses.length;
    const page = { processes: nextProcesses, totalCount, nextOffset: end < totalCount ? end : null };
    if (processes.length && Buffer.byteLength(JSON.stringify(page)) > 256 * 1024) break;
    processes.push(process);
  }
  return { processes, totalCount, nextOffset: offset + processes.length < totalCount ? offset + processes.length : null };
}
export function latestBackgroundReferenceSnapshot(store: Store, sessionId: string): AgentReferenceSnapshot | null {
  const process = listActiveBackgroundProcesses(store, sessionId)[0];
  return process?.handedOff ? structuredClone(process.referenceSnapshot) : null;
}
function requireProcess(store: Store, id: string): BackgroundProcess {
  const process = getBackgroundProcess(store, id);
  if (!process) throw new BackgroundProcessError("background_not_found");
  return process;
}
function save(store: Store, process: BackgroundProcess): BackgroundProcess {
  const updated = { ...process, version: process.version + 1, updatedAt: new Date().toISOString() };
  store.db.prepare("UPDATE background_processes SET state = ?, payload = ? WHERE id = ?").run(updated.state, JSON.stringify(updated), updated.id);
  changed(store, updated);
  return updated;
}
function changed(store: Store, process: BackgroundProcess): void {
  store.appendEvent({ type: "background_process.changed", process: backgroundProcessToView(process) }, { taskId: process.taskId, sessionId: process.sessionId });
}
export function sessionBackgroundStopSeq(store: Store, sessionId: string): number {
  const seq = Number((store.db.prepare("SELECT COALESCE(MAX(through_input_seq), 0) AS seq FROM background_process_closures WHERE session_id = ?").get(sessionId) as { seq: number }).seq);
  if (!count(seq)) throw new BackgroundProcessError("background_corrupt");
  return seq;
}
function activeSource(store: Store, process: BackgroundProcess): Task {
  const task = store.getTask(process.taskId), session = store.getSession(process.sessionId), op = store.getToolOp(process.hostOpId);
  if (!task || !session || task.sessionId !== session.id || session.projectId !== process.source.projectId || !ownerQuestionTaskEligible(store, task) || task.accessMode !== "full_access" || task.planMode || task.status !== "running" || task.cancelRequested ||
      task.permissionVersion !== process.permissionVersion || !isDeepStrictEqual(task.grantedPaths, process.source.grantedPaths)) throw new BackgroundProcessError("background_source_invalid");
  if (!op || op.taskId !== task.id || op.toolName !== "process_start" || !isDeepStrictEqual(op.params, { command: process.command })) throw new BackgroundProcessError("background_source_invalid");
  const origin = getCodingTaskOrigin(store, task.id);
  if (origin.kind !== process.source.kind || (origin.kind === "coding-schedule" && (process.source.kind !== "coding-schedule" || origin.runId !== process.source.runId || origin.scheduleId !== process.source.scheduleId || origin.planVersion !== process.source.planVersion))) throw new BackgroundProcessError("background_source_invalid");
  const inputSeq = store.getTaskInputSeq(task);
  if (inputSeq === null || inputSeq !== process.source.inputSeq) throw new BackgroundProcessError("background_source_invalid");
  if (inputSeq <= sessionBackgroundStopSeq(store, session.id)) throw new BackgroundProcessError("background_closed", "本次请求已被会话后台关闭动作截住；新的拥有者请求可重新启动。");
  return task;
}

export function registerBackgroundProcess(store: Store, input: { taskId: string; sessionId: string; hostOpId: string; workspace: BackgroundWorkspace; ref: BackgroundExecutionRef }): BackgroundProcess {
  const existing = findBackgroundProcessByOp(store, input.hostOpId);
  if (existing) {
    if (existing.taskId !== input.taskId || existing.sessionId !== input.sessionId || !isDeepStrictEqual(existing.workspace, input.workspace) || !isDeepStrictEqual(existing.ref, input.ref)) throw new BackgroundProcessError("request_conflict");
    return existing;
  }
  const task = store.getTask(input.taskId), session = store.getSession(input.sessionId), op = store.getToolOp(input.hostOpId);
  if (!task || !session || !op || task.sessionId !== session.id || op.taskId !== task.id || op.toolName !== "process_start" ||
      !op.params || typeof op.params !== "object" || Array.isArray(op.params) || Object.keys(op.params).some(key => key !== "command") || typeof op.params.command !== "string" || !op.params.command.trim() || op.params.command.length > 16384 || !validWorkspace(input.workspace) || !validRef(input.ref) ||
      input.workspace.path !== session.cwdReal || input.workspace.ino !== session.cwdIno) throw new BackgroundProcessError("background_source_invalid");
  const inputSeq = store.getTaskInputSeq(task);
  if (inputSeq === null) throw new BackgroundProcessError("background_source_invalid");
  const now = new Date().toISOString();
  const process: BackgroundProcess = { id: randomId("process"), sessionId: session.id, taskId: task.id, hostOpId: op.id, command: op.params.command, state: "starting", workspace: structuredClone(input.workspace), ref: structuredClone(input.ref),
    permissionVersion: task.permissionVersion, source: { ...getCodingTaskOrigin(store, task.id), projectId: session.projectId, input: task.input, accessMode: "full_access", permissionVersion: task.permissionVersion, grantedPaths: structuredClone(task.grantedPaths), inputSeq },
    handedOff: false, launchClaimed: false, launchFingerprint: null, referenceSnapshot: null, logEvidence: null, exit: null, stopVerified: false, reason: null, stdoutBytes: 0, stderrBytes: 0, partial: false, version: 1, createdAt: now, updatedAt: now };
  activeSource(store, process);
  if (listActiveBackgroundProcesses(store, session.id).length) throw new BackgroundProcessError("background_occupied", "本会话已有未核实停止的后台执行；先停止并核实原执行。");
  const held = store.getOccupancyByDir(input.workspace.path);
  if (held?.taskId !== task.id || held.sessionId !== session.id) throw new BackgroundProcessError("background_occupied");
  store.db.prepare("INSERT INTO background_processes (id, session_id, task_id, host_op_id, state, payload) VALUES (?, ?, ?, ?, ?, ?)").run(process.id, process.sessionId, process.taskId, process.hostOpId, process.state, JSON.stringify(process));
  changed(store, process);
  return process;
}

/** 临时执行已由 Runtime 核实停止；同事务转移原根占用与持久对话阶段，不释放后重抢。 */
export function handoffBackgroundProcess(store: Store, input: { processId: string; snapshot: AgentReferenceSnapshot; workspace: BackgroundWorkspace }): BackgroundProcess {
  const process = requireProcess(store, input.processId);
  if (process.handedOff) {
    if (!isDeepStrictEqual(process.referenceSnapshot, input.snapshot) || !isDeepStrictEqual(process.workspace, input.workspace)) throw new BackgroundProcessError("request_conflict");
    return process;
  }
  activeSource(store, process);
  if (process.state !== "starting" || !validSnapshot(input.snapshot, process) || !isDeepStrictEqual(process.workspace, input.workspace)) throw new BackgroundProcessError("background_not_ready");
  const changedRows = store.db.prepare("UPDATE occupancy SET task_id = NULL, process_id = ? WHERE cwd_real = ? AND cwd_dev = ? AND cwd_ino = ? AND task_id = ? AND session_id = ? AND process_id IS NULL")
    .run(process.id, process.workspace.path, process.workspace.dev, process.workspace.ino, process.taskId, process.sessionId);
  if (Number(changedRows.changes) !== 1) throw new BackgroundProcessError("background_occupied");
  const updated = save(store, { ...process, handedOff: true, referenceSnapshot: structuredClone(input.snapshot) });
  store.appendEvent({ type: "task.resources_changed", taskId: process.taskId, sessionId: process.sessionId, phase: "conversation" }, { taskId: process.taskId, sessionId: process.sessionId });
  return updated;
}
export function claimBackgroundLaunch(store: Store, processId: string, launchFingerprint?: string): boolean {
  const process = requireProcess(store, processId);
  if (process.launchClaimed) {
    if (launchFingerprint !== undefined && process.launchFingerprint !== launchFingerprint) throw new BackgroundProcessError("request_conflict");
    return false;
  }
  activeSource(store, process);
  if (!process.handedOff || process.state !== "starting") throw new BackgroundProcessError("background_not_ready");
  if (launchFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(launchFingerprint)) throw new BackgroundProcessError("invalid_params");
  if (launchFingerprint !== undefined && process.launchFingerprint !== null && process.launchFingerprint !== launchFingerprint) throw new BackgroundProcessError("request_conflict");
  save(store, { ...process, launchClaimed: true, launchFingerprint: launchFingerprint ?? process.launchFingerprint });
  return true;
}
export function requestBackgroundStop(store: Store, processId: string, reason: string): BackgroundProcess {
  const process = requireProcess(store, processId);
  if (process.state === "stopped" || process.state === "stop_requested") return process;
  return save(store, { ...process, state: "stop_requested", reason });
}
export function finishBackgroundStop(store: Store, input: { processId: string; verified: boolean; reason: string | null; exit?: BackgroundProcess["exit"] }): BackgroundProcess {
  const process = requireProcess(store, input.processId);
  if (process.state === "stopped") return process;
  if (input.verified) store.db.prepare("DELETE FROM occupancy WHERE process_id = ?").run(process.id);
  return save(store, { ...process, state: input.verified ? "stopped" : "stop_unverified", stopVerified: input.verified, reason: input.reason, ...(input.exit !== undefined ? { exit: structuredClone(input.exit) } : {}) });
}
export function updateBackgroundObserved(store: Store, input: { processId: string; state?: "running"; exit?: BackgroundProcess["exit"]; stdoutBytes?: number; stderrBytes?: number; partial?: boolean; reason?: string | null; launchFingerprint?: string; logEvidence?: BackgroundLogEvidence }): BackgroundProcess {
  const process = requireProcess(store, input.processId);
  const stdoutBytes = input.stdoutBytes ?? process.stdoutBytes, stderrBytes = input.stderrBytes ?? process.stderrBytes;
  if (!count(stdoutBytes) || !count(stderrBytes) || stdoutBytes < process.stdoutBytes || stderrBytes < process.stderrBytes || stdoutBytes + stderrBytes > 16 * 1024 * 1024 ||
      (input.launchFingerprint !== undefined && (!/^[0-9a-f]{64}$/.test(input.launchFingerprint) || (process.launchFingerprint !== null && process.launchFingerprint !== input.launchFingerprint))) ||
      (input.logEvidence !== undefined && (!validLogEvidence(input.logEvidence) || (process.logEvidence !== null && (["stdout", "stderr"] as const).some(stream => process.logEvidence![stream].dev !== input.logEvidence![stream].dev || process.logEvidence![stream].ino !== input.logEvidence![stream].ino))))) throw new BackgroundProcessError("invalid_params");
  if (input.state === "running" && !process.launchClaimed) throw new BackgroundProcessError("background_not_ready");
  const updated = { ...process, stdoutBytes, stderrBytes, partial: process.partial || Boolean(input.partial),
    ...(input.exit !== undefined ? { exit: structuredClone(input.exit) } : {}), ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.launchFingerprint !== undefined ? { launchFingerprint: input.launchFingerprint } : {}), ...(input.state && process.state === "starting" ? { state: input.state } : {}) };
  if (input.logEvidence !== undefined) updated.logEvidence = structuredClone(input.logEvidence);
  return isDeepStrictEqual(updated, process) ? process : save(store, updated);
}

export function getBackgroundClosure(store: Store, sessionId: string, requestKey: string): BackgroundClosure | null {
  const row = store.db.prepare("SELECT through_input_seq, payload FROM background_process_closures WHERE session_id = ? AND request_key = ?").get(sessionId, requestKey) as { through_input_seq: number; payload: string } | undefined;
  if (!row) return null;
  let closure: BackgroundClosure;
  try { closure = JSON.parse(row.payload) as BackgroundClosure; }
  catch { throw new BackgroundProcessError("background_corrupt"); }
  if (!closure || closure.sessionId !== sessionId || closure.requestKey !== requestKey || closure.throughInputSeq !== row.through_input_seq || !count(closure.throughInputSeq) || !Array.isArray(closure.processIds) || closure.processIds.some(id => typeof id !== "string") || typeof closure.createdAt !== "string") throw new BackgroundProcessError("background_corrupt");
  return closure;
}
export function closeSessionBackgroundBarrier(store: Store, input: { sessionId: string; requestKey: string }): BackgroundClosure {
  if (!input.requestKey || !store.getSession(input.sessionId)) throw new BackgroundProcessError("invalid_params");
  const existing = getBackgroundClosure(store, input.sessionId, input.requestKey);
  if (existing) return existing;
  const processes = listActiveBackgroundProcesses(store, input.sessionId);
  const closure: BackgroundClosure = { ...input, throughInputSeq: store.getMaxSeq(), processIds: processes.map(process => process.id), createdAt: new Date().toISOString() };
  store.db.prepare("INSERT INTO background_process_closures (session_id, request_key, through_input_seq, payload) VALUES (?, ?, ?, ?)").run(closure.sessionId, closure.requestKey, closure.throughInputSeq, JSON.stringify(closure));
  for (const process of processes) requestBackgroundStop(store, process.id, "session_closed");
  store.appendEvent({ type: "background_process.closed", closure }, { sessionId: closure.sessionId });
  return closure;
}
