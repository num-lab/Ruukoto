import type { TaskStatus } from "./types.ts";

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "awaiting_confirmation"];

/** 任务的执行结束状态（终态，不允许再转换）。 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["completed", "failed", "canceled", "interrupted"];
