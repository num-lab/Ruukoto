import type { TaskStatus } from "./types.ts";

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "awaiting_confirmation"];
