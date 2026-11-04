import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { AppDataError, type AuditReceipt, type OpContext } from "@ruukoto/agent/app-data/store.ts";
import type { QueryRequest, QueryResponse } from "@ruukoto/agent/app-data/query.ts";

export type PersonalAppDataWrite = { name: "app_data_define_table" | "app_data_migrate" | "app_data_insert" | "app_data_update" | "app_data_delete"; params: Record<string, unknown> };
export type PersonalAppDataJob = { file: string; instanceId: string } & (
  | { kind: "initialize" }
  | { kind: "inspect"; write?: PersonalAppDataWrite }
  | { kind: "receipt"; opId: string; taskId: string }
  | { kind: "execute"; write: PersonalAppDataWrite; opId: string; ctx: OpContext }
  | { kind: "query"; request: QueryRequest }
);
export type PersonalAppDataVersions = { schemaVersion: number; revision: number };
export type PersonalAppDataResults = {
  initialize: null;
  inspect: { versions: PersonalAppDataVersions; destructive: boolean };
  receipt: { versions: PersonalAppDataVersions; receipt: AuditReceipt | null; hasTaskReceipt: boolean };
  execute: null;
  query: QueryResponse;
};
type Reply = { ok: true; result: PersonalAppDataResults[keyof PersonalAppDataResults] } | { ok: false; error: { code: string; message: string } };
const SCRIPT = fileURLToPath(new URL("../../../worker/personal-app-data-worker.mjs", import.meta.url));

// Each thread exits before its result is usable. A host crash also ends every writer, so recovery can inspect receipts without racing an orphan write.
// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-m2-execution.md
export function personalAppDataIo(options: { script?: string; stallMs?: (kind: PersonalAppDataJob["kind"]) => number; workerProbe?: (worker: Worker, job: PersonalAppDataJob) => void; deadlineMs?: number } = {}) {
  const active = new Set<Worker>();
  let closed = false;
  async function run<K extends PersonalAppDataJob["kind"]>(job: Extract<PersonalAppDataJob, { kind: K }>, context: Context = BACKGROUND_CONTEXT): Promise<PersonalAppDataResults[K]> {
    if (closed || context.abortSignal?.aborted) throw new AppDataError("app_data_io_canceled", "原应用数据执行已停止，未重发修改；请查询原操作。");
    const worker = new Worker(options.script ?? SCRIPT, { execArgv: [], env: {}, workerData: { stallMs: options.stallMs?.(job.kind) ?? 0 } });
    active.add(worker);
    try {
      return await new Promise<PersonalAppDataResults[K]>((resolve, reject) => {
        let reply: Reply | undefined, failure: Error | undefined;
        const stop = (code: string, message: string) => { failure ??= new AppDataError(code, message); void worker.terminate().catch(error => { process.stderr.write(`[ruukoto:app-data] Worker termination failed: ${String(error)}\n`); }); };
        const abort = () => stop("app_data_io_canceled", "原应用数据执行已停止，请查询原回执核实效果。");
        const timer = setTimeout(() => stop("app_data_io_timeout", "原应用数据执行超时，请查询原回执核实效果；修改不会重发。"), options.deadlineMs ?? (job.kind === "execute" || job.kind === "initialize" ? 10_000 : 2_000));
        context.abortSignal?.addEventListener("abort", abort, { once: true });
        worker.once("message", (message: Reply) => { reply = message; });
        worker.once("error", () => { failure ??= new AppDataError("app_data_io_failed", "原应用数据工作线程失败，请查询原回执核实效果。"); });
        worker.once("exit", code => {
          clearTimeout(timer); context.abortSignal?.removeEventListener("abort", abort);
          if (failure) reject(failure);
          else if (code !== 0 || !reply) reject(new AppDataError("app_data_io_failed", "原应用数据工作线程未完成，请查询原回执核实效果。"));
          else if (!reply.ok) reject(new AppDataError(reply.error.code, reply.error.message));
          else resolve(reply.result as PersonalAppDataResults[K]);
        });
        worker.postMessage(job); options.workerProbe?.(worker, job);
      });
    } finally { active.delete(worker); }
  }
  return { run, get inFlight() { return active.size; }, async close() { closed = true; await Promise.all([...active].map(worker => worker.terminate())); } };
}
export type PersonalAppDataIo = ReturnType<typeof personalAppDataIo>;
