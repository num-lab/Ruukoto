import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import { PersonalSchedulesDoc, PersonalScheduleRunDoc, SCHEDULE_SUPERVISOR_TASK } from "./personal-scheduler-records.ts";
import { PersonalDirectoryClaimsDoc } from "./personal-directory-claims.ts";
import { PersonalError } from "./personal-error.ts";

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-local-management.md
export async function hasPendingPersonalWork(storage: Storage): Promise<boolean> {
  const context = BACKGROUND_CONTEXT;
  const claimsRecord = await storage.findDocument({ kind: PersonalDirectoryClaimsDoc.definition.kind, scope: { kind: "session" } }, "current", context), claims = claimsRecord && await storage.document(claimsRecord.id, "current", context);
  if (claims) {
    if (claims.version !== 1 || !Array.isArray(claims.value.claims)) throw new PersonalError("config_state_invalid", "目录认领无法核实，未更改配置；请保留档案。");
    for (const claim of claims.value.claims) { if (!claim || typeof claim !== "object" || Array.isArray(claim)) throw new PersonalError("config_state_invalid", "原目录认领无效，未更改配置；请保留档案。"); if (!claim.released) return true; }
  }
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
  let questionCursor;
  do {
    const page = await storage.scanDocuments({ kind: "ruukoto.question", scope: { kind: "session" }, at: "current" }, 256, questionCursor, context);
    for (const record of page.items) {
      const saved = await storage.document(record.id, "current", context), question = saved?.value.question;
      if (!saved || saved.version !== 1 || question && (typeof question !== "object" || Array.isArray(question))) throw new PersonalError("config_state_invalid", "问题记录无法核实，未更改配置；请保留档案。");
      if (question && typeof question === "object" && !Array.isArray(question) && question.status === "pending") return true;
    }
    questionCursor = page.next;
  } while (questionCursor);
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
