/** File I/O runs outside the host event loop and Session transactions; short commits own authorization and claims.
 * A lost dispatched write retains unknown effects and occupancy. Missing IPC is never stop evidence.
 * Note: See .agents/notes/implemented/architecture/2026-11-03-personal-file-io-jobs.md
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, defineEntry, ROOT_CONVERSATION_ID, type ConversationId, type Cursor, type EntryId, type Harness, type Storage, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { processIdentity, validProcessIdentity } from "@ruukoto/core/process-identity.ts";
import { PersonalError } from "./personal-error.ts";
import type { PersonalFilePrepareInput, PersonalFileRequest, PersonalToolIoResult } from "./personal-tool-io.ts";
import type { PersonalToolOrigin } from "./personal-tool-source.ts";

const PERSONAL_FILE_WORKER = fileURLToPath(new URL("../../../worker/personal-file-worker.mjs", import.meta.url));
export const PERSONAL_FILE_IO_CAPACITY = 4;
const FILE_IO_DEADLINE_MS = 120_000;
const FILE_IO_TERMINATION_GRACE_MS = 5_000;
const FILE_RESULT_CAP = 8 * 1024 * 1024;
const DIAGNOSTIC = "[ruukoto:personal-file-io] File-I/O lifecycle persistence failed; new dispatch is sealed and original workers remain subject to verified stopping.\n";
const FOREIGN = "[ruukoto:personal-file-io] Ignored a file-worker reply that does not match its original job.\n";
const MESSAGES: Record<string, string> = {
  file_io_capacity_unavailable: "文件操作容量暂不可用，本次未执行，原批准不会稍后执行；请结束本轮并报告拥有者，待原执行停止或存储修复后由拥有者发起新操作。",
  file_io_timeout: "文件操作超过等待期限；本次不自动重试，实际停止与写入效果以原操作记录为准，请结束本轮并报告拥有者。",
  file_io_canceled: "原文件操作已请求取消；实际停止与写入效果以原操作记录为准，请查询原操作，不要重试。",
  file_io_closed: "文件操作入口正在停止，未派发新请求；请查询原操作并等待停止核实。",
  file_io_stop_unverified: "原文件工作线程尚未核实退出，档案锁与容量仍保留；请核实原执行或修复存储后再次请求停止。",
  file_io_record_invalid: "文件操作的原身份、阶段或生命周期证据无法核实，已停止恢复；请保留档案并查询原操作。",
  file_io_host_unverified: "原文件执行宿主尚未核实结束，停止与占用仍保留；请检查原宿主或存储，不要重新执行原操作。",
  file_io_worker_unavailable: "文件工作线程入口缺失，未执行文件操作；请重新构建后启动。",
  file_io_worker_failed: "文件工作线程执行失败；请保留档案并核实原执行。",
  file_io_worker_lost: "文件工作线程在任务应答前已结束，原执行结果未能核实；请保留档案并查询原操作。",
  file_io_protocol_invalid: "原文件工作线程的应答身份或内容无法核实，原结果保留未知；请保留档案并查询原操作。",
  file_io_persistence_failed: "原文件执行证据未能保存，已停止新操作；请保留档案并核实原执行与存储。",
};
export type PersonalFileJobId = string;
export type PersonalFileJobPhase = "prepare" | "revalidate" | "execute";
export type PersonalFileJobHost = { pid: number; startIdentity: string | null; incarnation: string };
export type PersonalFileJobMeta = { v: 1; id: PersonalFileJobId; host: PersonalFileJobHost; phase: PersonalFileJobPhase; access: "read" | "read_write"; requestSha256: string; request: JsonValue; operation?: TaskId; origin?: PersonalToolOrigin; deadlineAt: number };
type Settlement = { outcome: "result" | "timeout" | "canceled" | "error" | "released"; code: string };
type EventDetail = { kind: "starting" | "dispatch" | "no-dispatch" | "release" | "terminate" | "host-ended" } | ({ kind: "settle" } & Settlement) | { kind: "result"; ok: boolean; payload: JsonValue } | { kind: "exit"; code: number };
export type PersonalFileIoEvent = { kind: "admit"; job: PersonalFileJobMeta } | (EventDetail & { jobId: PersonalFileJobId; host: PersonalFileJobHost; seq: number });
export type PersonalFileJobRecord = PersonalFileJobMeta & { admission: EntryId; seq: number; events: EntryId[]; starting?: EntryId; dispatch?: EntryId; noDispatch?: EntryId; released?: EntryId; terminate?: EntryId; hostEnded?: EntryId; settle?: Settlement & { entry: EntryId }; result?: { ok: boolean; payload: JsonValue; entry: EntryId }; exit?: { code: number; entry: EntryId } };
export type PersonalFileJobContext = { phase: PersonalFileJobPhase; profile?: string; operation?: TaskId; origin?: PersonalToolOrigin; signal?: AbortSignal; record?: (event: PersonalFileIoEvent) => Promise<void> };
export interface PersonalFileReservation { readonly id: PersonalFileJobId; assertReady(): void; execute(): Promise<PersonalToolIoResult>; release(): Promise<void> }
export interface PersonalFileIo { prepare(input: PersonalFilePrepareInput, context?: PersonalFileJobContext): Promise<PersonalFileRequest>; execute(request: PersonalFileRequest, context?: PersonalFileJobContext): Promise<PersonalToolIoResult>; reserve(request: PersonalFileRequest, context?: PersonalFileJobContext): Promise<PersonalFileReservation>; close(): Promise<void> }
export interface PersonalFileIoOptions { script?: string; stallMs?: number; profile?: string; deadlineMs?: number; terminationGraceMs?: number; workerProbe?: (worker: Worker, job: PersonalFileJobMeta) => void }
export class PersonalFileIoError extends PersonalError {
  constructor(code: string, message: string, readonly jobId?: PersonalFileJobId, readonly dispatched?: boolean, readonly stopped?: boolean, options?: ErrorOptions) { super(code, message, options); this.name = "PersonalFileIoError"; }
}
const errorFor = (code: string, job?: FileJob, cause?: unknown) => new PersonalFileIoError(code, MESSAGES[code] ?? MESSAGES.file_io_worker_failed, job?.meta.id, job?.posted, job ? job.stopped || job.exited : true, { cause });
const invalid = () => errorFor("file_io_record_invalid");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const identityNumber = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const INCARNATION = randomUUID();
let host: PersonalFileJobHost | undefined;
const hostIdentity = () => host ??= { pid: process.pid, startIdentity: processIdentity(process.pid), incarnation: INCARNATION };
const conversationOf = (job: PersonalFileJobMeta): ConversationId => job.origin?.conversationId ?? ROOT_CONVERSATION_ID;

export function fileIoJobStopped(job: PersonalFileJobRecord): boolean { return !!(job.result || job.exit || job.hostEnded || job.released); }
// Note: See .agents/notes/implemented/bug-fix/2026-11-04-personal-foundation-integration.md
export function fileIoJobUnresolved(job: PersonalFileJobRecord): boolean { return !fileIoJobStopped(job); }
export function fileIoJobNotDispatched(job: PersonalFileJobRecord): boolean { return !!job.noDispatch || !!job.released || !job.dispatch && !!job.hostEnded; }
export function personalFileIoAttemptError(job: PersonalFileJobRecord): PersonalFileIoError {
  const code = job.settle && Object.hasOwn(MESSAGES, job.settle.code) ? job.settle.code : fileIoJobNotDispatched(job) ? "file_io_canceled" : "file_io_worker_lost";
  return new PersonalFileIoError(code, MESSAGES[code], job.id, !!job.dispatch && !fileIoJobNotDispatched(job), fileIoJobStopped(job));
}
export const PersonalFileIoDoc = defineDoc<{ jobs: PersonalFileJobId[] }>({ kind: "ruukoto.file-io", scope: "session", version: 1, initial: () => ({ jobs: [] }) });
export const PersonalFileJobDoc = defineDocFamily<{ job?: PersonalFileJobRecord }, null>({ kind: "ruukoto.file-io-job", scope: "session", version: 1, family: true, initial: () => ({}) });
export const PersonalFileIoAdmission = defineEntry<PersonalFileJobMeta>("ruukoto.file-io-admission");
export const PersonalFileIoLifecycle = defineEntry<Exclude<PersonalFileIoEvent, { kind: "admit" }>>("ruukoto.file-io-lifecycle");

function preparedRequest(value: unknown, input?: unknown): value is PersonalFileRequest {
  if (!object(value) || !exactKeys(value, ["path", "access", "targetDev", "targetIno", "originalSha256", "protectedRoots"], ["content", "writeProtectedRoots"]) || typeof value.path !== "string" || !isAbsolute(value.path) || !["read", "read_write"].includes(String(value.access)) || !identityNumber(value.targetDev) || !identityNumber(value.targetIno) || !(value.originalSha256 === null || typeof value.originalSha256 === "string" && SHA.test(value.originalSha256)) || !strings(value.protectedRoots) || value.writeProtectedRoots !== undefined && !strings(value.writeProtectedRoots) || value.access === "read" && (value.content !== undefined || value.originalSha256 === null) || value.access === "read_write" && (typeof value.content !== "string" || Buffer.byteLength(value.content) > FILE_RESULT_CAP)) return false;
  return !input || object(input) && value.access === input.access && value.content === input.content && isDeepStrictEqual(value.protectedRoots, input.protectedRoots) && value.writeProtectedRoots === undefined;
}
function prepareInput(value: unknown): boolean {
  return object(value) && exactKeys(value, ["path", "access", "protectedRoots"], ["content"]) && typeof value.path === "string" && value.path.length <= 4096 && ["read", "read_write"].includes(String(value.access)) && strings(value.protectedRoots) && (value.access === "read" ? value.content === undefined : typeof value.content === "string" && Buffer.byteLength(value.content) <= FILE_RESULT_CAP);
}
function toolResult(value: unknown, access: string): value is PersonalToolIoResult {
  return object(value) && exactKeys(value, ["effect", "code", "bytes", "partial"]) && (access === "read" ? ["returned", "not_executed", "no_write"] : ["returned", "not_executed", "effect_unknown"]).includes(String(value.effect)) && typeof value.code === "string" && !!value.code && value.bytes instanceof Uint8Array && value.bytes.byteLength <= FILE_RESULT_CAP && typeof value.partial === "boolean";
}
type Reply = { ok: true; result: PersonalFileRequest | PersonalToolIoResult } | { ok: false; error: { code: string; message: string } };
function parseReply(job: FileJob, raw: unknown): Reply | "foreign" | "invalid" {
  if (!object(raw)) return "invalid";
  if (raw.id !== job.meta.id) return "foreign";
  if (!exactKeys(raw, ["id", "phase", "op", "ok"], ["result", "error"]) || raw.phase !== job.meta.phase || raw.op !== (job.meta.phase === "execute" ? "execute" : "prepare") || typeof raw.ok !== "boolean") return "invalid";
  if (!raw.ok) return object(raw.error) && exactKeys(raw.error, ["code", "message"]) && typeof raw.error.code === "string" && typeof raw.error.message === "string" && raw.result === undefined ? { ok: false, error: { code: raw.error.code, message: raw.error.message } } : "invalid";
  if (raw.error !== undefined) return "invalid";
  return job.meta.phase === "execute" ? toolResult(raw.result, job.meta.access) ? { ok: true, result: raw.result } : "invalid" : preparedRequest(raw.result, job.meta.request) ? { ok: true, result: raw.result } : "invalid";
}
const resultPayload = (job: PersonalFileJobMeta, reply: Reply): JsonValue => {
  if (!reply.ok) return { error: reply.error };
  if (job.phase !== "execute") return { request: json(reply.result) };
  const result = reply.result as PersonalToolIoResult;
  return { effect: result.effect, code: result.code, partial: result.partial, bytesLength: result.bytes.byteLength, bytesSha256: createHash("sha256").update(result.bytes).digest("hex") };
};
function validPayload(job: PersonalFileJobMeta, ok: boolean, payload: unknown): boolean {
  if (!object(payload)) return false;
  if (!ok) return exactKeys(payload, ["error"]) && object(payload.error) && exactKeys(payload.error, ["code", "message"]) && typeof payload.error.code === "string" && typeof payload.error.message === "string";
  if (job.phase !== "execute") return exactKeys(payload, ["request"]) && preparedRequest(payload.request, job.request);
  return exactKeys(payload, ["effect", "code", "partial", "bytesLength", "bytesSha256"]) && (job.access === "read" ? ["returned", "not_executed", "no_write"] : ["returned", "not_executed", "effect_unknown"]).includes(String(payload.effect)) && typeof payload.code === "string" && typeof payload.partial === "boolean" && identityNumber(payload.bytesLength) && payload.bytesLength <= FILE_RESULT_CAP && typeof payload.bytesSha256 === "string" && SHA.test(payload.bytesSha256);
}

function project(job: PersonalFileJobRecord, event: Exclude<PersonalFileIoEvent, { kind: "admit" }>, entry: EntryId): void {
  if (event.jobId !== job.id || !isDeepStrictEqual(event.host, job.host) || event.seq !== job.seq + 1 || entry <= job.admission || entry <= (job.events.at(-1) ?? job.admission)) throw invalid();
  switch (event.kind) {
    case "starting": if (job.starting || job.settle || job.released) throw invalid(); job.starting = entry; break;
    case "dispatch": if (!job.starting || job.dispatch || job.settle || job.noDispatch) throw invalid(); job.dispatch = entry; break;
    case "no-dispatch": if (job.noDispatch || job.result) throw invalid(); job.noDispatch = entry; break;
    case "release": if (job.released || !job.noDispatch) throw invalid(); job.released = entry; break;
    case "terminate": if (!job.starting || job.terminate || job.exit) throw invalid(); job.terminate = entry; break;
    case "result": if (!job.dispatch || job.noDispatch || job.result || typeof event.ok !== "boolean" || !validPayload(job, event.ok, event.payload)) throw invalid(); job.result = { ok: event.ok, payload: copy(event.payload), entry }; break;
    case "exit": if (!job.starting || job.exit || !Number.isSafeInteger(event.code) || event.code < 0) throw invalid(); job.exit = { code: event.code, entry }; break;
    case "host-ended": if (job.hostEnded) throw invalid(); job.hostEnded = entry; break;
    case "settle": {
      if (job.settle || !["result", "timeout", "canceled", "error", "released"].includes(event.outcome) || typeof event.code !== "string" || !event.code) throw invalid();
      if (event.outcome === "result") {
        if (!job.result) throw invalid();
        const payload = job.result.payload as Record<string, JsonValue>;
        const code = job.result.ok ? job.phase === "execute" ? payload.code : "returned" : (payload.error as Record<string, JsonValue>).code;
        if (event.code !== code) throw invalid();
      }
      if (event.outcome === "released" && !fileIoJobNotDispatched(job) || event.outcome === "timeout" && event.code !== "file_io_timeout") throw invalid();
      job.settle = { outcome: event.outcome, code: event.code, entry }; break;
    }
    default: throw invalid();
  }
  job.seq = event.seq; job.events.push(entry);
}
export type PersonalFileIoStopLinker = (tx: Tx, job: PersonalFileJobRecord, event: PersonalFileIoEvent, entry: EntryId) => Promise<void>;
export function createPersonalFileIoRecorder(getHarness: () => Harness | undefined, link?: PersonalFileIoStopLinker): (event: PersonalFileIoEvent) => Promise<void> {
  return async event => {
    const harness = getHarness(); if (!harness) throw errorFor("file_io_persistence_failed");
    await harness.commit(async tx => {
      const id = event.kind === "admit" ? event.job.id : event.jobId;
      const doc = await tx.doc(PersonalFileJobDoc, id, null);
      if (event.kind === "admit") {
        if (doc.job) { if (doc.job.id !== id) throw invalid(); const prior = await tx.entry(PersonalFileIoAdmission, doc.job.admission); if (!prior || !isDeepStrictEqual(prior.data, event.job)) throw invalid(); return; }
        const entry = await tx.appendEntry(PersonalFileIoAdmission, conversationOf(event.job), { data: copy(event.job) });
        doc.job = { ...copy(event.job), admission: entry.id, seq: 0, events: [] };
        (await tx.doc(PersonalFileIoDoc)).jobs.push(id);
        if (link) await link(tx, doc.job, event, entry.id);
        return;
      }
      const job = doc.job; if (!job || job.id !== id) throw invalid();
      if (event.seq <= job.seq) { const prior = await tx.entry(PersonalFileIoLifecycle, job.events[event.seq - 1]); if (!prior || !isDeepStrictEqual(prior.data, event)) throw invalid(); return; }
      const entry = await tx.appendEntry(PersonalFileIoLifecycle, conversationOf(job), { data: copy(event) });
      project(job, event, entry.id);
      if (link) await link(tx, job, event, entry.id);
    }, BACKGROUND_CONTEXT);
  };
}

interface Receipt { event: PersonalFileIoEvent; promise: Promise<void> }
interface FileJob {
  meta: PersonalFileJobMeta; namespace: FileNamespace; owner: object; writer?: PersonalFileJobContext["record"]; signal?: AbortSignal; seq: number; slot: boolean; denied?: string; starting: boolean; posted: boolean; noDispatch: boolean; released: boolean; exited: boolean; stopped: boolean; worker?: Worker; terminated: boolean; logical?: Settlement; reply?: Reply; receipts: Receipt[]; tail: Promise<void>; sessionDead: boolean; delivered: boolean; promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void; interrupted: Promise<never>; interrupt: (error: unknown) => void; exitPromise: Promise<void>; exitResolve: () => void; timer?: NodeJS.Timeout; detach?: () => void;
}
interface FileNamespace { jobs: Map<PersonalFileJobId, FileJob>; sealed: boolean; sessionDead: boolean; persistFailed: boolean; grace: number; waiters: Set<() => void> }
const namespaces = new Map<string, FileNamespace>();
const namespaceKey = (profile?: string) => profile === undefined ? "standalone" : `profile:${realpathSync(profile)}`;
function namespaceFor(profile?: string): FileNamespace { const key = namespaceKey(profile); let value = namespaces.get(key); if (!value) { value = { jobs: new Map(), sealed: false, sessionDead: false, persistFailed: false, grace: FILE_IO_TERMINATION_GRACE_MS, waiters: new Set() }; namespaces.set(key, value); } return value; }
const live = (ns: FileNamespace) => [...ns.jobs.values()].some(job => job.slot);
function prune(job: FileJob): void {
  if (!job.slot && !job.receipts.length && job.delivered) job.namespace.jobs.delete(job.meta.id);
  if (!live(job.namespace)) { for (const done of job.namespace.waiters) done(); job.namespace.waiters.clear(); }
}
function free(job: FileJob): void { job.slot = false; job.exitResolve(); prune(job); }
function deliverFailure(job: FileJob, error: unknown): void { if (job.delivered) return; job.delivered = true; clearTimeout(job.timer); job.detach?.(); job.reject(error); job.interrupt(error); prune(job); }
function emit(job: FileJob, detail: { kind: "admit" } | EventDetail): Promise<void> {
  const event: PersonalFileIoEvent = detail.kind === "admit" ? { kind: "admit", job: copy(job.meta) } : { ...detail, jobId: job.meta.id, host: copy(job.meta.host), seq: ++job.seq };
  let receipt: Receipt;
  const pending = job.tail.then(async () => {
    if (job.sessionDead || job.namespace.persistFailed) throw errorFor("file_io_persistence_failed", job);
    try { if (job.writer) await job.writer(event); }
    catch (cause) { failPersistence(job.namespace, cause); throw errorFor("file_io_persistence_failed", job, cause); }
    const index = job.receipts.indexOf(receipt); if (index >= 0) job.receipts.splice(index, 1); prune(job);
  });
  receipt = { event, promise: pending }; job.receipts.push(receipt); job.tail = pending.catch(() => undefined); void pending.catch(() => undefined); return pending;
}
function noDispatch(job: FileJob): void {
  if (job.posted || job.noDispatch) return;
  job.noDispatch = true; void emit(job, { kind: "no-dispatch" });
  if (!job.worker && !job.released) { job.released = true; void emit(job, { kind: "release" }); }
  if (!job.worker) { job.stopped = true; free(job); }
}
function terminate(job: FileJob): void {
  if (!job.worker || job.exited || job.terminated) return;
  job.terminated = true; void emit(job, { kind: "terminate" });
  void job.worker.terminate().catch(cause => { if (!job.logical) failJob(job, "error", "file_io_worker_failed", cause); });
}
function settle(job: FileJob, outcome: Settlement["outcome"], code: string): Promise<void> | undefined {
  if (job.logical) return;
  job.logical = { outcome, code };
  return emit(job, { kind: "settle", outcome, code });
}
function failJob(job: FileJob, outcome: Settlement["outcome"], code: string, cause?: unknown): void {
  if (job.logical) return;
  noDispatch(job); void settle(job, outcome, code); deliverFailure(job, errorFor(code, job, cause)); terminate(job);
}
function failPersistence(ns: FileNamespace, cause: unknown): void {
  if (!ns.persistFailed) process.stderr.write(DIAGNOSTIC);
  ns.persistFailed = true;
  for (const job of ns.jobs.values()) { if (!job.logical) { noDispatch(job); void settle(job, "error", "file_io_persistence_failed"); } deliverFailure(job, errorFor("file_io_persistence_failed", job, cause)); terminate(job); }
}
function attach(job: FileJob, worker: Worker): void {
  job.worker = worker;
  // In-flight workers retain the event loop; idle managers own no cached worker.
  worker.ref();
  worker.on("message", raw => {
    const reply = parseReply(job, raw);
    // A reply belongs only to its original job; foreign or duplicate replies cannot settle another request.
    if (reply === "foreign" || job.reply) { process.stderr.write(FOREIGN); return; }
    if (reply === "invalid") { process.stderr.write(FOREIGN); failJob(job, "error", "file_io_protocol_invalid"); return; }
    job.reply = reply; job.stopped = true;
    const completion = emit(job, { kind: "result", ok: reply.ok, payload: resultPayload(job.meta, reply) });
    if (job.logical) return;
    const settlement = settle(job, "result", reply.ok ? job.meta.phase === "execute" ? (reply.result as PersonalToolIoResult).code : "returned" : reply.error.code);
    void Promise.all([completion, settlement]).then(() => {
      if (job.delivered) return;
      job.delivered = true; clearTimeout(job.timer); job.detach?.();
      if (reply.ok) job.resolve(reply.result); else job.reject(new PersonalFileIoError(reply.error.code, reply.error.message, job.meta.id, job.posted, true));
      prune(job);
    }, cause => deliverFailure(job, errorFor("file_io_persistence_failed", job, cause)));
  });
  worker.on("error", cause => failJob(job, "error", "file_io_worker_failed", cause));
  worker.on("exit", code => {
    job.exited = true; job.stopped = true; worker.unref();
    if (!job.posted) noDispatch(job);
    void emit(job, { kind: "exit", code }); free(job);
    if (!job.logical) { void settle(job, "error", "file_io_worker_lost"); deliverFailure(job, errorFor("file_io_worker_lost", job)); }
  });
}
function ready(job: FileJob, sealed: boolean): void {
  if (job.logical) throw errorFor(Object.hasOwn(MESSAGES, job.logical.code) ? job.logical.code : "file_io_canceled", job);
  if (job.namespace.sealed || job.namespace.sessionDead || sealed) throw errorFor("file_io_closed", job);
  if (job.namespace.persistFailed) throw errorFor("file_io_persistence_failed", job);
  if (!job.slot) throw errorFor("file_io_canceled", job);
  if (job.signal?.aborted) { failJob(job, "canceled", "file_io_canceled"); throw errorFor("file_io_canceled", job); }
  if (Date.now() >= job.meta.deadlineAt) { failJob(job, "timeout", "file_io_timeout"); throw errorFor("file_io_timeout", job); }
}
function arm(job: FileJob): void {
  const cancel = () => { if (!job.logical) failJob(job, "canceled", "file_io_canceled"); else if (!job.delivered) deliverFailure(job, errorFor("file_io_canceled", job)); };
  job.signal?.addEventListener("abort", cancel, { once: true }); job.detach = () => job.signal?.removeEventListener("abort", cancel);
  job.timer = setTimeout(() => { if (!job.logical) failJob(job, "timeout", "file_io_timeout"); else if (!job.delivered) deliverFailure(job, errorFor("file_io_timeout", job)); }, Math.max(0, job.meta.deadlineAt - Date.now()));
  if (job.signal?.aborted) cancel();
}
async function graceWait(pending: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([pending.then(() => true), new Promise<false>(resolve => timer = setTimeout(() => resolve(false), ms))]); }
  finally { clearTimeout(timer); }
}
async function drain(jobs: FileJob[], grace: number, ns?: FileNamespace): Promise<void> {
  if (ns) ns.sealed = true;
  for (const job of jobs) { if (!job.logical) failJob(job, "canceled", "file_io_canceled"); else terminate(job); }
  const flushed = Promise.all(jobs.map(async job => { await job.exitPromise; if (job.sessionDead) return; for (;;) { const tail = job.tail; await tail; if (tail === job.tail) break; } if (job.receipts.length) throw errorFor("file_io_persistence_failed", job); }));
  if (!await graceWait(flushed, grace)) throw errorFor("file_io_stop_unverified");
}
export function openPersonalFileIo(options: PersonalFileIoOptions = {}): PersonalFileIo {
  const script = options.script ?? PERSONAL_FILE_WORKER;
  if (!existsSync(script)) throw errorFor("file_io_worker_unavailable");
  const deadline = options.deadlineMs ?? FILE_IO_DEADLINE_MS, grace = options.terminationGraceMs ?? FILE_IO_TERMINATION_GRACE_MS;
  if (!Number.isFinite(deadline) || deadline <= 0 || !Number.isFinite(grace) || grace <= 0) throw invalid();
  const owner = {}, used = new Set<FileNamespace>(); let closing: Promise<void> | undefined, sealed = false;
  const begin = (request: PersonalFilePrepareInput | PersonalFileRequest, phase: PersonalFileJobPhase, context?: PersonalFileJobContext): FileJob => {
    if (sealed) throw errorFor("file_io_closed");
    if ((context?.operation === undefined) !== (context?.origin === undefined) || context && context.phase !== phase) throw invalid();
    if (options.profile && context?.profile && namespaceKey(options.profile) !== namespaceKey(context.profile)) throw invalid();
    const ns = namespaceFor(context?.profile ?? options.profile); used.add(ns); if (options.terminationGraceMs !== undefined) ns.grace = grace;
    if (ns.sealed || ns.sessionDead) throw errorFor("file_io_closed");
    if (ns.persistFailed) throw errorFor("file_io_persistence_failed");
    const input = json(request), meta: PersonalFileJobMeta = { v: 1, id: randomUUID(), host: copy(hostIdentity()), phase, access: request.access, request: input, requestSha256: digest(input), ...(context?.operation === undefined ? {} : { operation: context.operation, origin: copy(context.origin!) }), deadlineAt: Date.now() + deadline };
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void, interrupt!: (error: unknown) => void, exitResolve!: () => void;
    const promise = new Promise<unknown>((a, b) => { resolve = a; reject = b; }), interrupted = new Promise<never>((_, b) => interrupt = b), exitPromise = new Promise<void>(a => exitResolve = a);
    void promise.catch(() => undefined); void interrupted.catch(() => undefined);
    const denied = ns.sealed || ns.sessionDead ? "file_io_closed" : ns.persistFailed ? "file_io_persistence_failed" : [...ns.jobs.values()].filter(job => job.slot).length >= PERSONAL_FILE_IO_CAPACITY ? "file_io_capacity_unavailable" : undefined;
    const job: FileJob = { meta, namespace: ns, owner, writer: context?.record, signal: context?.signal, seq: 0, slot: !denied, denied, starting: false, posted: false, noDispatch: false, released: false, exited: false, stopped: false, terminated: false, receipts: [], tail: Promise.resolve(), sessionDead: ns.sessionDead, delivered: false, promise, resolve, reject, interrupted, interrupt, exitPromise, exitResolve };
    ns.jobs.set(meta.id, job); const admission = emit(job, { kind: "admit" }); arm(job);
    if (denied) { noDispatch(job); void settle(job, "error", denied); void job.tail.then(() => deliverFailure(job, errorFor(denied, job)), cause => deliverFailure(job, errorFor("file_io_persistence_failed", job, cause))); }
    else void admission.catch(cause => deliverFailure(job, errorFor("file_io_persistence_failed", job, cause)));
    return job;
  };
  const evidence = (job: FileJob, pending: Promise<void>) => Promise.race([pending, job.interrupted]);
  const start = async (job: FileJob): Promise<unknown> => {
    try {
      await evidence(job, job.tail); ready(job, sealed);
      const starting = emit(job, { kind: "starting" }); job.starting = true;
      await evidence(job, starting); ready(job, sealed);
      // Clear host eval/import flags: a fixed file-based .mjs worker must not inherit them.
      const worker = new Worker(script, { execArgv: [], workerData: options.stallMs ? { stallMs: options.stallMs } : undefined });
      attach(job, worker); options.workerProbe?.(worker, copy(job.meta));
      await evidence(job, emit(job, { kind: "dispatch" })); ready(job, sealed);
      worker.postMessage({ id: job.meta.id, phase: job.meta.phase, op: job.meta.phase === "execute" ? "execute" : "prepare", input: copy(job.meta.request) }); job.posted = true;
    } catch (cause) {
      if (!job.logical) failJob(job, "error", cause instanceof PersonalFileIoError ? cause.code : "file_io_worker_failed", cause);
      noDispatch(job); terminate(job);
    }
    return job.promise;
  };
  return {
    async prepare(input, context) { const phase = context?.phase ?? "prepare"; if (phase === "execute") throw invalid(); const job = begin(input, phase, context); return await start(job) as PersonalFileRequest; },
    async execute(request, context) { const result = await start(begin(request, "execute", context)) as PersonalToolIoResult; result.bytes = Buffer.from(result.bytes); return result; },
    async reserve(request, context) {
      const job = begin(request, "execute", context);
      await evidence(job, job.tail); ready(job, sealed);
      let state: "reserved" | "starting" | "done" = "reserved";
      return { id: job.meta.id,
        assertReady() { if (state !== "reserved") throw errorFor("file_io_canceled", job); ready(job, sealed); },
        async execute() { if (state !== "reserved") throw errorFor("file_io_canceled", job); state = "starting"; try { ready(job, sealed); const result = await start(job) as PersonalToolIoResult; result.bytes = Buffer.from(result.bytes); return result; } finally { state = "done"; } },
        async release() { if (state !== "reserved") throw errorFor("file_io_canceled", job); state = "done"; if (!job.logical) failJob(job, "released", "file_io_canceled"); if (!await graceWait(job.tail, Math.max(1, job.meta.deadlineAt - Date.now()))) throw errorFor("file_io_timeout", job); },
      };
    },
    async close() { if (!closing) { sealed = true; const jobs = [...used].flatMap(ns => [...ns.jobs.values()].filter(job => job.owner === owner)); const attempt = drain(jobs, grace); closing = attempt; void attempt.catch(() => { if (closing === attempt) closing = undefined; }); } return closing; },
  };
}
export function personalFileIoLiveJobs(directory: string): boolean { const ns = namespaces.get(namespaceKey(directory)); return !!ns && live(ns); }
export function personalFileIoJobLive(id: PersonalFileJobId): boolean { return [...namespaces.values()].some(ns => ns.jobs.get(id)?.slot); }
export async function stopPersonalFileIoJob(directory: string, id: PersonalFileJobId): Promise<boolean> {
  const ns = namespaces.get(namespaceKey(directory)), job = ns?.jobs.get(id);
  if (!job) return false;
  await drain([job], ns!.grace);
  return job.stopped || job.exited;
}
export function waitPersonalFileIoDrained(directory: string): Promise<void> { const ns = namespaces.get(namespaceKey(directory)); return !ns || !live(ns) ? Promise.resolve() : new Promise<void>(resolve => ns.waiters.add(resolve)); }
export async function closePersonalFileIoNamespace(directory: string): Promise<void> { const ns = namespaceFor(directory); await drain([...ns.jobs.values()], ns.grace, ns); }
export function sealPersonalFileIoSessionClosed(directory: string): void {
  const ns = namespaceFor(directory); ns.sealed = true; ns.sessionDead = true;
  for (const job of ns.jobs.values()) { job.sessionDead = true; if (!job.logical) { noDispatch(job); void settle(job, "canceled", "file_io_closed"); } deliverFailure(job, errorFor("file_io_closed", job)); terminate(job); }
}
export function personalFileIoPersistenceFailed(directory: string): boolean { return namespaces.get(namespaceKey(directory))?.persistFailed === true; }
export async function personalFileIoJobs(tx: Tx): Promise<PersonalFileJobRecord[]> {
  const index = await tx.doc(PersonalFileIoDoc); if (!Array.isArray(index.jobs) || new Set(index.jobs).size !== index.jobs.length) throw invalid();
  const jobs: PersonalFileJobRecord[] = [];
  for (const id of index.jobs) { if (typeof id !== "string" || !UUID.test(id)) throw invalid(); const value = (await tx.doc(PersonalFileJobDoc, id, null)).job; if (!value || value.id !== id) throw invalid(); jobs.push(copy(value)); }
  return jobs;
}
export async function personalFileJobStopped(tx: Tx, id: PersonalFileJobId): Promise<boolean> { const job = (await tx.doc(PersonalFileJobDoc, id, null)).job; if (!job || job.id !== id) throw invalid(); return fileIoJobStopped(job); }
export async function personalFileIoSourceBlocker(tx: Tx, sourceId: SubmissionId, exclude?: TaskId): Promise<PersonalFileJobRecord | undefined> { return (await personalFileIoJobs(tx)).find(job => job.operation !== exclude && job.origin?.sources.includes(sourceId) && fileIoJobUnresolved(job)); }
export async function personalFileIoWorkBlocker(tx: Tx, taskId: TaskId, exclude?: TaskId): Promise<PersonalFileJobRecord | undefined> { return (await personalFileIoJobs(tx)).find(job => job.operation !== exclude && job.origin?.work?.ref.taskId === taskId && fileIoJobUnresolved(job)); }
export function fileIoHostEnded(value: PersonalFileJobHost): boolean {
  if (!positiveId(value.pid) || value.pid === process.pid && value.incarnation === INCARNATION) return false;
  try { process.kill(value.pid, 0); } catch (cause) { return object(cause) && cause.code === "ESRCH"; }
  const current = processIdentity(value.pid); return current !== null && value.startIdentity !== null && current !== value.startIdentity;
}
function validMeta(value: unknown): value is PersonalFileJobMeta {
  if (!object(value) || !exactKeys(value, ["v", "id", "host", "phase", "access", "requestSha256", "request", "deadlineAt"], ["operation", "origin"]) || value.v !== 1 || typeof value.id !== "string" || !UUID.test(value.id) || !object(value.host) || !exactKeys(value.host, ["pid", "startIdentity", "incarnation"]) || !positiveId(value.host.pid) || typeof value.host.incarnation !== "string" || !UUID.test(value.host.incarnation) || !(value.host.startIdentity === null || validProcessIdentity(value.host.startIdentity)) || !["prepare", "revalidate", "execute"].includes(String(value.phase)) || !["read", "read_write"].includes(String(value.access)) || typeof value.requestSha256 !== "string" || !SHA.test(value.requestSha256) || digest(value.request) !== value.requestSha256 || !Number.isFinite(value.deadlineAt) || Number(value.deadlineAt) <= 0 || !object(value.request) || value.request.access !== value.access || !(value.phase === "execute" ? preparedRequest(value.request) : prepareInput(value.request)) || (value.operation === undefined) !== (value.origin === undefined)) return false;
  if (value.operation === undefined) return true;
  const origin = value.origin;
  return positiveId(value.operation) && object(origin) && identityNumber(origin.conversationId) && positiveId(origin.generation) && Array.isArray(origin.inputs) && origin.inputs.length > 0 && origin.inputs.every(positiveId) && new Set(origin.inputs).size === origin.inputs.length && Array.isArray(origin.sources) && origin.sources.length > 0 && origin.sources.every(positiveId) && new Set(origin.sources).size === origin.sources.length && object(origin.source) && typeof origin.source.requestId === "string" && positiveId(origin.source.submissionId) && positiveId(origin.source.entryId) && object(origin.permission) && ["auto-review", "confirm", "full_access"].includes(String(origin.permission.mode)) && positiveId(origin.permission.version);
}
export async function verifyPersonalFileIoStorage(storage: Storage): Promise<void> {
  let cursor: Cursor | undefined; const keys = new Set<string>(); let index: string[] | undefined;
  for (const token of [PersonalFileIoDoc, PersonalFileJobDoc]) {
    do { const page = await storage.scanDocuments({ kind: token.definition.kind, scope: { kind: "session" }, at: "current" }, 256, cursor, BACKGROUND_CONTEXT);
      for (const record of page.items) { const stored = await storage.document(record.id, "current", BACKGROUND_CONTEXT); if (!stored || stored.version !== 1) throw invalid(); if (token === PersonalFileIoDoc) { if (index !== undefined || !exactKeys(stored.value, ["jobs"]) || !Array.isArray(stored.value.jobs) || stored.value.jobs.some(id => typeof id !== "string" || !UUID.test(id)) || new Set(stored.value.jobs).size !== stored.value.jobs.length) throw invalid(); index = stored.value.jobs as string[]; } else if (stored.value.job !== undefined) { if (record.key === undefined || !UUID.test(record.key) || keys.has(record.key) || !exactKeys(stored.value, ["job"]) || !object(stored.value.job) || (stored.value.job as { id?: unknown }).id !== record.key) throw invalid(); keys.add(record.key); } else if (Object.keys(stored.value).length) throw invalid(); }
      cursor = page.next;
    } while (cursor);
  }
  if (keys.size !== (index?.length ?? 0) || (index ?? []).some(id => !keys.has(id))) throw invalid();
}
export async function verifyPersonalFileIo(tx: Tx, scanned: ReadonlySet<EntryId>, verifyJob?: (tx: Tx, job: PersonalFileJobRecord) => Promise<void>): Promise<void> {
  const referenced = new Set<EntryId>();
  for (const job of await personalFileIoJobs(tx)) {
    const meta: PersonalFileJobMeta = { v: job.v, id: job.id, host: job.host, phase: job.phase, access: job.access, requestSha256: job.requestSha256, request: job.request, ...(job.operation === undefined ? {} : { operation: job.operation, origin: job.origin }), deadlineAt: job.deadlineAt };
    if (!validMeta(meta) || !positiveId(job.admission) || !Array.isArray(job.events) || job.events.some(id => !positiveId(id)) || job.seq !== job.events.length || new Set(job.events).size !== job.events.length) throw invalid();
    const admission = await tx.entry(PersonalFileIoAdmission, job.admission);
    if (!admission || admission.byTaskId !== undefined || admission.conversationId !== conversationOf(job) || !isDeepStrictEqual(admission.data, meta)) throw invalid(); referenced.add(job.admission);
    const projected: PersonalFileJobRecord = { ...meta, admission: job.admission, seq: 0, events: [] };
    for (const id of job.events) {
      const entry = await tx.entry(PersonalFileIoLifecycle, id); if (!entry || entry.byTaskId !== undefined || entry.conversationId !== conversationOf(job)) throw invalid();
      const event = entry.data;
      if (!object(event)) throw invalid();
      const expected = event.kind === "settle" ? ["outcome", "code"] : event.kind === "result" ? ["ok", "payload"] : event.kind === "exit" ? ["code"] : [];
      if (!exactKeys(event, ["kind", "jobId", "host", "seq", ...expected])) throw invalid();
      project(projected, event, id); referenced.add(id);
    }
    if (!isDeepStrictEqual(projected, job)) throw invalid();
    if (job.operation !== undefined) { if (!verifyJob) throw invalid(); await verifyJob(tx, job); }
  }
  if (referenced.size !== scanned.size || [...scanned].some(id => !referenced.has(id))) throw invalid();
}
export async function reconcilePersonalFileIo(harness: Harness, directory: string, link?: PersonalFileIoStopLinker): Promise<void> {
  const ns = namespaces.get(namespaceKey(directory)); if (ns && live(ns)) throw errorFor("file_io_stop_unverified");
  const writer = createPersonalFileIoRecorder(() => harness, link);
  for (const runtime of [...ns?.jobs.values() ?? []]) {
    await runtime.tail;
    for (const receipt of [...runtime.receipts]) { await writer(receipt.event); const index = runtime.receipts.indexOf(receipt); if (index >= 0) runtime.receipts.splice(index, 1); }
    prune(runtime);
  }
  for (const job of await harness.commit(tx => personalFileIoJobs(tx), BACKGROUND_CONTEXT)) {
    if (job.settle && fileIoJobStopped(job)) continue;
    const runtime = ns?.jobs.get(job.id);
    if (runtime) { if (runtime.meta.host.incarnation !== job.host.incarnation || !isDeepStrictEqual(runtime.meta, { ...(await harness.commit(tx => tx.entry(PersonalFileIoAdmission, job.admission), BACKGROUND_CONTEXT))!.data })) throw invalid(); continue; }
    if (!fileIoHostEnded(job.host)) { if (fileIoJobUnresolved(job)) throw errorFor("file_io_host_unverified"); continue; }
    let seq = job.seq;
    const append = (detail: EventDetail) => writer({ ...detail, jobId: job.id, host: copy(job.host), seq: ++seq });
    if (!job.hostEnded) await append({ kind: "host-ended" });
    if (!job.dispatch && !job.noDispatch) await append({ kind: "no-dispatch" });
    if (job.result && !job.settle) {
      const payload = job.result.payload as Record<string, JsonValue>;
      await append({ kind: "settle", outcome: "result", code: String(job.result.ok ? job.phase === "execute" ? payload.code : "returned" : (payload.error as Record<string, JsonValue>).code) });
    } else if (!job.settle) await append({ kind: "settle", outcome: !job.dispatch ? "released" : "error", code: !job.dispatch ? "file_io_canceled" : "file_io_worker_lost" });
  }
  if (ns) { if (live(ns) || [...ns.jobs.values()].some(job => job.receipts.length)) throw errorFor("file_io_persistence_failed"); ns.persistFailed = false; ns.sessionDead = false; ns.sealed = false; }
}
