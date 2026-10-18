import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import { PersonalSchedulesDoc, PersonalScheduleRunDoc, SCHEDULE_SUPERVISOR_TASK } from "./personal-scheduler-records.ts";
import { PersonalError } from "./personal-error.ts";

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-local-management.md
export async function hasPendingPersonalWork(storage: Storage): Promise<boolean> {
  const context = BACKGROUND_CONTEXT;
  const record = await storage.findDocument({ kind: PersonalSchedulesDoc.definition.kind, scope: { kind: "session" } }, "current", context);
  const schedules = record && await storage.document(record.id, "current", context);
  if (schedules) {
    if (schedules.version !== 1 || !Array.isArray(schedules.value.runs)) throw new PersonalError("config_state_invalid", "调度记录无法核实，未更改配置；请保留档案并恢复原记录。");
    for (const runId of schedules.value.runs) {
      if (typeof runId !== "string") throw new PersonalError("config_state_invalid", "定时运行引用无法核实，未更改配置；请保留档案。");
      const record = await storage.findDocument({ kind: PersonalScheduleRunDoc.definition.kind, scope: { kind: "session" }, key: runId }, "current", context);
      const saved = record && await storage.document(record.id, "current", context), run = saved?.value.run;
      if (!saved || saved.version !== 1 || !run || typeof run !== "object" || Array.isArray(run) || !run.result) return true;
    }
  }
  for (const status of ["pending", "running", "waiting", "completing"] as const) {
    let cursor;
    do {
      const page = await storage.scanTasks({ status }, 256, cursor, context);
      for (const task of page.items) if (task.kind !== SCHEDULE_SUPERVISOR_TASK || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || task.owner !== undefined || !task.background || !isDeepStrictEqual(task.input, {}) || schedules?.value.supervisor !== task.id) return true;
      cursor = page.next;
    } while (cursor);
  }
  const inputs = await Promise.all((["queued", "placed"] as const).map(status => storage.scanSubmissions({ status }, 1, undefined, context)));
  return inputs.some(page => page.items.length > 0);
}
