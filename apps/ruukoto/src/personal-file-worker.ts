/** 固定受信文件工作线程：慢速文件准备/复核/执行离开主事件循环；只做已核实请求，不判断权限，停止与效果事实由宿主持有。
 * workerData.stallMs 是测试注入的逐任务停顿，用于可复现地持有在途执行；生产配置不设置。
 * Note: 见 .agents/notes/implemented/architecture/2026-11-02-personal-file-io-worker.md
 */
import { parentPort, workerData } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { PersonalError } from "./personal-error.ts";
import { preparePersonalFile, executePersonalFile, type PersonalFilePrepareInput, type PersonalFileRequest } from "./personal-tool-io.ts";

type Job = { id: number; op: "prepare" | "execute"; input: PersonalFilePrepareInput | PersonalFileRequest };
const stallMs = (workerData as { stallMs?: number } | undefined)?.stallMs ?? 0;

parentPort!.on("message", async (job: Job) => {
  try {
    if (stallMs > 0) await delay(stallMs);
    const result = job?.op === "prepare" ? preparePersonalFile(job.input as PersonalFilePrepareInput)
      : job?.op === "execute" ? executePersonalFile(job.input as PersonalFileRequest)
      : undefined;
    if (result === undefined) throw new PersonalError("file_worker_job_invalid", "文件工作线程请求无法核实，未执行。");
    parentPort!.postMessage({ id: job.id, ok: true, result });
  } catch (error) {
    const failure = error instanceof PersonalError ? error : new PersonalError("file_worker_failed", "文件工作线程执行失败；请保留档案并核实原执行。", { cause: error });
    parentPort!.postMessage({ id: job?.id, ok: false, error: { code: failure.code, message: failure.message } });
  }
});
