/** Fixed trusted file worker: slow file prepare/revalidate/execute runs off the main
 * event loop; it executes only verified requests, never judges permission — stop and
 * effect facts belong to the host. Each thread takes exactly one job: one message,
 * one reply, parentPort.close then exit, giving the host per-job exact exit evidence.
 * workerData.stallMs is a test-injected per-job stall for reproducibly holding an
 * in-flight execution; production never sets it.
 * Note: See .agents/notes/implemented/architecture/2026-11-03-personal-file-io-jobs.md
 */
import { parentPort, workerData } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { PersonalError } from "./personal-error.ts";
import { preparePersonalFile, executePersonalFile, type PersonalFilePrepareInput, type PersonalFileRequest } from "./personal-tool-io.ts";

type Job = { id: string; phase: "prepare" | "revalidate" | "execute"; op: "prepare" | "execute"; input: PersonalFilePrepareInput | PersonalFileRequest };
type Reply = { id?: string; phase?: string; op?: string; ok: boolean; result?: PersonalFileRequest | unknown; error?: { code: string; message: string } };
const stallMs = (workerData as { stallMs?: number } | undefined)?.stallMs ?? 0;

parentPort!.once("message", async (job: Job) => {
  let reply: Reply;
  try {
    if (stallMs > 0) await delay(stallMs);
    const result = job?.op === "prepare" ? preparePersonalFile(job.input as PersonalFilePrepareInput)
      : job?.op === "execute" ? executePersonalFile(job.input as PersonalFileRequest)
      : undefined;
    if (result === undefined) throw new PersonalError("file_worker_job_invalid", "文件工作线程请求无法核实，未执行。");
    reply = { id: job.id, phase: job.phase, op: job.op, ok: true, result };
  } catch (error) {
    const failure = error instanceof PersonalError ? error : new PersonalError("file_worker_failed", "文件工作线程执行失败；请保留档案并核实原执行。", { cause: error });
    reply = { id: job?.id, phase: job?.phase, op: job?.op, ok: false, error: { code: failure.code, message: failure.message } };
  }
  try { parentPort!.postMessage(reply); } finally { parentPort!.close(); }
});
