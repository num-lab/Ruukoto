/** 文件 I/O 工作线程宿主端：慢速准备/复核/执行离开主事件循环与 Session 事务，短事务只核对版本与认领；结果回到宿主后才记停止。
 * 线程内执行死亡的请求结果视为丢失：已派发写入保留未知效果与占用，不据丢失的 IPC 回复推断停止。
 * Note: 见 .agents/notes/implemented/architecture/2026-11-02-personal-file-io-worker.md
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { PersonalError } from "./personal-error.ts";
import type { PersonalFilePrepareInput, PersonalFileRequest, PersonalToolIoResult } from "./personal-tool-io.ts";

const PERSONAL_FILE_WORKER = fileURLToPath(new URL("../../../worker/personal-file-worker.mjs", import.meta.url));

export interface PersonalFileIo {
  prepare(input: PersonalFilePrepareInput): Promise<PersonalFileRequest>;
  execute(request: PersonalFileRequest): Promise<PersonalToolIoResult>;
  close(): Promise<void>;
}

type Reply = { id: number; ok: boolean; result?: PersonalFileRequest | PersonalToolIoResult; error?: { code?: string; message?: string } };

export function openPersonalFileIo(options?: { script?: string; stallMs?: number }): PersonalFileIo {
  const script = options?.script ?? PERSONAL_FILE_WORKER;
  if (!fs.existsSync(script)) throw new PersonalError("file_io_worker_unavailable", "文件工作线程入口缺失，未执行文件操作；请重新构建后启动。");
  // execArgv 清空：宿主若以 --eval/--import 等方式运行，继承的参数对独立 .mjs 工作线程非法或多余。
  const worker = new Worker(script, { execArgv: [], workerData: options?.stallMs ? { stallMs: options.stallMs } : undefined });
  // 空闲时不持有事件循环；有在途任务时 ref，执行中的文件操作不得因宿主可退出而被默默遗弃。
  worker.unref();
  let seq = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  const settle = (id: number) => { pending.delete(id); if (!pending.size) worker.unref(); };
  const fail = (error: unknown) => { const jobs = [...pending.entries()]; pending.clear(); worker.unref(); for (const [, job] of jobs) job.reject(error); };
  worker.on("message", (reply: Reply) => {
    const job = pending.get(reply.id);
    // 无主回复意味着 IPC 应答与在途任务失配，按协议损坏诊断，不静默丢弃。
    if (!job) { process.stderr.write(`[ruukoto:personal-file-io] 工作线程回复无对应请求 ${reply.id}，已忽略。\n`); return; }
    settle(reply.id);
    if (reply.ok) job.resolve(reply.result);
    else job.reject(new PersonalError(reply.error?.code ?? "file_io_worker_failed", reply.error?.message ?? "文件工作线程执行失败；请保留档案并核实原执行。"));
  });
  let alive = true;
  worker.on("error", error => fail(new PersonalError("file_io_worker_failed", "文件工作线程执行失败；请保留档案并核实原执行。", { cause: error })));
  worker.on("exit", () => { alive = false; fail(new PersonalError("file_io_worker_lost", "文件工作线程在任务应答前已结束，原执行结果未能核实；请保留档案并查询原操作。")); });
  const dispatch = <T>(op: "prepare" | "execute", input: unknown) => new Promise<T>((resolve, reject) => {
    if (!alive) { reject(new PersonalError("file_io_worker_lost", "文件工作线程已结束，未再派发文件操作；请保留档案并查询原操作。")); return; }
    const id = ++seq;
    pending.set(id, { resolve: value => resolve(value as T), reject });
    worker.ref();
    try { worker.postMessage({ id, op, input }); }
    catch (error) { settle(id); reject(error); }
  });
  return {
    prepare: input => dispatch<PersonalFileRequest>("prepare", input),
    execute: async request => {
      const result = await dispatch<PersonalToolIoResult>("execute", request);
      // IPC 结构化克隆到达的是 Uint8Array；统一回 Buffer 以沿用产物保存的既有约定。
      result.bytes = Buffer.from(result.bytes);
      return result;
    },
    async close() { await worker.terminate(); },
  };
}
