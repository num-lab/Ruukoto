import { parentPort, workerData } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { AppDataStore, AppDataError } from "@ruukoto/agent/app-data/store.ts";
import { analyzeMigrate } from "@ruukoto/agent/app-data/contract.ts";
import { runQuery, validateQueryRequest } from "@ruukoto/agent/app-data/query.ts";
import type { PersonalAppDataJob, PersonalAppDataResults } from "./personal-app-data-io.ts";

// The fixed worker receives only its application database and operation; it has no model credentials or core-storage handle.
// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-m2-execution.md
parentPort!.once("message", async (job: PersonalAppDataJob) => {
  let store: AppDataStore | undefined;
  try {
    const stallMs = (workerData as { stallMs: number }).stallMs;
    if (stallMs > 0) await delay(stallMs);
    try { store = new AppDataStore(job.file, { timeout: 1000, ...(job.kind === "initialize" ? { initialInstanceId: job.instanceId } : { expectedInstanceId: job.instanceId, readOnly: job.kind !== "execute" }) }); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR" && "errcode" in error && typeof error.errcode === "number" && [5, 6].includes(error.errcode & 0xff)) throw new AppDataError("app_data_io_busy", "原应用库暂被其他执行占用，本次未完成；请查询原操作。");
      throw new AppDataError("app_data_unavailable", "原应用库缺失、身份或结构不符，已停止应用数据；请恢复原库后重新核实，勿新建库或重试修改。");
    }
    const bound = store;
    let result: PersonalAppDataResults[keyof PersonalAppDataResults] = null;
    if (job.kind === "inspect") result = bound.readTx(() => ({ versions: bound.getVersions(), destructive: job.write?.name === "app_data_migrate" ? analyzeMigrate(bound, job.write.params).destructive : !!job.write && ["app_data_update", "app_data_delete"].includes(job.write.name) && Array.isArray(job.write.params.rows) && job.write.params.rows.length > 1 }));
    else if (job.kind === "receipt") {
      try { result = bound.readTx(() => ({ versions: bound.getVersions(), receipt: bound.getReceipt(job.opId), hasTaskReceipt: bound.hasTaskReceipt(job.taskId) })); }
      catch { throw new AppDataError("app_data_receipt_invalid", "原应用数据回执损坏，保持效果未知；请保留原库并检查审计记录。"); }
    }
    else if (job.kind === "query") result = runQuery(bound, validateQueryRequest(job.request));
    else if (job.kind === "execute") {
      const input = { ...job.write.params, opId: job.opId, ctx: job.ctx };
      if (job.write.name === "app_data_define_table") bound.defineTable(input);
      else if (job.write.name === "app_data_migrate") bound.migrate(input);
      else if (job.write.name === "app_data_insert") bound.insert(input);
      else if (job.write.name === "app_data_update") bound.updateRows(input);
      else if (job.write.name === "app_data_delete") bound.deleteRows(input);
      else throw new AppDataError("app_data_io_invalid", "应用数据工作线程操作无效，未执行。");
    } else if (job.kind !== "initialize") throw new AppDataError("app_data_io_invalid", "应用数据工作线程请求无效，未执行。");
    store.close(); store = undefined;
    parentPort!.postMessage({ ok: true, result });
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: { code: error instanceof AppDataError ? error.code : "app_data_io_failed", message: error instanceof AppDataError ? error.message : "原应用数据执行失败，请核实原库和回执。" } });
  } finally { store?.close(); parentPort!.close(); }
});
