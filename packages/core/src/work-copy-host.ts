/** 普通工作副本宿主操作的持久身份；不建立模型会话或继承 SubAgent 身份。 */
import * as path from "node:path";
import type { Task } from "./types.ts";

export interface WorkCopyHostSnapshot {
  version: 1;
  parentTaskId: string;
  workId: string;
  operation: "capture" | "create" | "freeze" | "verify" | "integrate";
  source: { path: string; dev: number; ino: number };
  units: { kind: "starting" | "process_group" | "systemd_unit"; id: string; label: string }[];
  stopVerified: boolean | null;
}

export class WorkCopyHostError extends Error {
  constructor(readonly code: string) {
    super("工作副本宿主记录缺失或损坏；保留现场，请核实原任务与执行记录");
  }
}

export function requireWorkCopyHost(value: unknown): WorkCopyHostSnapshot {
  if (value === undefined) throw new WorkCopyHostError("work_copy_host_missing");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkCopyHostError("work_copy_host_corrupt");
  const row = value as WorkCopyHostSnapshot;
  if (Object.keys(row).length !== 7 || row.version !== 1 ||
      ![row.parentTaskId, row.workId].every(id => typeof id === "string" && id.length > 0) ||
      !["capture", "create", "freeze", "verify", "integrate"].includes(row.operation) ||
      !row.source || typeof row.source !== "object" || Array.isArray(row.source) || Object.keys(row.source).length !== 3 ||
      typeof row.source.path !== "string" || !path.isAbsolute(row.source.path) ||
      !Number.isSafeInteger(row.source.dev) || !Number.isSafeInteger(row.source.ino) ||
      !Array.isArray(row.units) || row.units.some(unit => !unit || typeof unit !== "object" || Array.isArray(unit) ||
        !["starting", "process_group", "systemd_unit"].includes(unit.kind) ||
        ![unit.id, unit.label].every(value => typeof value === "string" && value.length > 0)) ||
      (row.stopVerified !== null && typeof row.stopVerified !== "boolean")) throw new WorkCopyHostError("work_copy_host_corrupt");
  return row;
}

export function workCopyHostFor(task: Pick<Task, "readScope" | "requestId">): WorkCopyHostSnapshot | null {
  if (task.readScope?.workCopyHost === undefined && !task.requestId.startsWith("work-copy-host:")) return null;
  return requireWorkCopyHost(task.readScope?.workCopyHost);
}
