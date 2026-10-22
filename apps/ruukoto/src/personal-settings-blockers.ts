import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ConversationId, type Cursor, type Harness, type Storage, type TaskId } from "@earendil-works/pi-durable";
import { appDataUnresolved, PersonalAppDataDoc, PersonalAppDataOperationDoc } from "./personal-app-data.ts";
import { browserUnresolved, personalBrowserSessionStateStopped, PersonalBrowserDoc, PersonalBrowserOperationDoc, PersonalBrowserSessionDoc } from "./personal-browser.ts";
import { personalCommandUnresolved, PersonalCommandDoc } from "./personal-command-work.ts";
import { PersonalError } from "./personal-error.ts";
import { mcpUnresolved, PersonalMcpConfigDoc, PersonalMcpDoc } from "./personal-mcp.ts";
import { PersonalInspectionDoc, PersonalPendingInspectionsDoc } from "./personal-service-inspection.ts";
import { personalServiceUnresolved, PersonalServiceOperationDoc } from "./personal-service-operations.ts";
import { toolUnresolved, PersonalToolDoc, PersonalToolsDoc } from "./personal-tools.ts";

export type PersonalExternalSettingsBlocker = { kind: "tool-unresolved" | "browser-unresolved" | "mcp-unresolved" | "command-unresolved" | "service-unresolved" | "inspection-unresolved" | "app-data-unresolved"; operation: TaskId } | { kind: "browser-session-unresolved"; conversation: ConversationId };
type Family = "tool" | "browser" | "mcp" | "command" | "service" | "inspection" | "app-data";
const context = BACKGROUND_CONTEXT;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function references(value: unknown): number[] {
  if (!Array.isArray(value) || value.some(item => !id(item)) || new Set(value).size !== value.length) throw invalid();
  return value;
}
const invalid = () => new PersonalError("settings_external_state_invalid", "原外部操作或停止记录无法核实，未更改设置；请保留档案并恢复原记录。");
const resolved = (value: unknown) => value === undefined || object(value) && (value.effect === "applied" || value.effect === "not_applied") && typeof value.evidence === "string" && !!value.evidence.trim();
function result(value: unknown, effects: readonly string[]): boolean { return value === undefined || object(value) && typeof value.effect === "string" && effects.includes(value.effect) && typeof value.code === "string"; }

function operationBlocker(family: Family, value: unknown, key: string): PersonalExternalSettingsBlocker | undefined {
  if (!object(value)) throw invalid();
  const reference = family === "command" || family === "service" ? value.ref : undefined;
  const operation = family === "inspection" ? value.taskId : reference && object(reference) ? reference.taskId : value.operation;
  if (!id(operation) || (reference ? !object(reference) || reference.requestId !== key : String(operation) !== key)) throw invalid();
  let pending: boolean;
  if (family === "inspection") {
    if (typeof value.stopped !== "boolean") throw invalid();
    pending = !value.stopped;
  } else if (family === "app-data") {
    if (value.started !== undefined && !id(value.started) || !result(value.result, ["committed", "not_committed", "effect_unknown"])) throw invalid();
    pending = appDataUnresolved(value as Parameters<typeof appDataUnresolved>[0]);
  } else if (family === "service") {
    if (typeof value.consumed !== "boolean" || typeof value.launcherStopped !== "boolean" || !result(value.result, ["executed", "not_executed", "effect_unknown"]) || !resolved(value.resolution)) throw invalid();
    pending = personalServiceUnresolved(value as Parameters<typeof personalServiceUnresolved>[0]);
  } else if (family === "command") {
    if (typeof value.started !== "boolean" || typeof value.stopped !== "boolean" || !result(value.result, ["returned", "not_executed", "effect_unknown"]) || !resolved(value.resolution)) throw invalid();
    pending = personalCommandUnresolved(value as Parameters<typeof personalCommandUnresolved>[0]);
  } else {
    if (typeof value.started !== "boolean" || typeof (family === "mcp" ? value.remoteEnded : value.stopped) !== "boolean" || !resolved(value.resolution) || typeof value.effect !== "string" || !(family === "mcp" ? ["not_executed", "returned", "effect_unknown"] : ["not_executed", "returned", "no_write", "effect_unknown"]).includes(value.effect)) throw invalid();
    pending = family === "mcp" ? mcpUnresolved(value as Parameters<typeof mcpUnresolved>[0]) : family === "tool" ? toolUnresolved(value as Parameters<typeof toolUnresolved>[0]) : browserUnresolved(value as Parameters<typeof browserUnresolved>[0]);
  }
  if (pending) return { kind: `${family}-unresolved`, operation: operation as TaskId };
}

function browserSessionBlocker(value: unknown, key: string): PersonalExternalSettingsBlocker | undefined {
  if (!object(value) || !id(Number(key)) || value.stateJson !== undefined && typeof value.stateJson !== "string" || value.bindingEntry !== undefined && !id(value.bindingEntry)) throw invalid();
  const stopped = personalBrowserSessionStateStopped(value as Parameters<typeof personalBrowserSessionStateStopped>[0], key);
  if (!stopped) return { kind: "browser-session-unresolved", conversation: Number(key) as ConversationId };
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-settings.md
export async function personalSettingsExternalBlockers(source: { storage: Storage } | { harness: Harness }): Promise<PersonalExternalSettingsBlocker[]> {
  const blockers: PersonalExternalSettingsBlocker[] = [];
  const add = (blocker: PersonalExternalSettingsBlocker | undefined) => { if (blocker && blockers.length < 32) blockers.push(blocker); };
  if ("storage" in source) {
    const storage = source.storage, populated = new Map<string, Set<string>>(), pendingInspections = new Set<string>();
    for (const [family, kind, property] of [
      ["tool", "ruukoto.tool-operation", "operation"], ["browser", "ruukoto.browser-operation", "operation"], ["mcp", "ruukoto.mcp", "operation"], ["command", "ruukoto.command", "command"], ["service", "ruukoto.service-operation", "operation"], ["inspection", "ruukoto.service-execution", "inspection"], ["app-data", "ruukoto.app-data-operation", "operation"],
    ] as const) {
      const keys = new Set<string>(); populated.set(kind, keys);
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanDocuments({ kind, scope: { kind: "session" }, at: "current" }, 256, cursor, context);
        for (const record of page.items) {
          const saved = await storage.document(record.id, "current", context);
          if (!saved || saved.version !== 1 || record.key === undefined) throw invalid();
          const value = saved.value[property];
          if (value === undefined) { if (Object.keys(saved.value).length) throw invalid(); continue; }
          keys.add(record.key);
          const blocker = operationBlocker(family, value, record.key);
          if (family === "inspection" && blocker) pendingInspections.add(record.key);
          add(blocker);
        }
        cursor = page.next;
      } while (cursor);
    }
    for (const kind of ["ruukoto.browser", "ruukoto.browser-session"]) {
      const keys = new Set<string>(); populated.set(kind, keys);
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanDocuments({ kind, scope: { kind: "session" }, at: "current" }, 256, cursor, context);
        for (const record of page.items) {
          const saved = await storage.document(record.id, "current", context);
          if (!saved || saved.version !== 1 || kind === "ruukoto.browser-session" && record.key === undefined) throw invalid();
          const key = kind === "ruukoto.browser" ? String(ROOT_CONVERSATION_ID) : record.key!;
          keys.add(key); add(browserSessionBlocker(saved.value, key));
        }
        cursor = page.next;
      } while (cursor);
    }
    for (const [kind, property, family] of [["ruukoto.tools", "operations", "ruukoto.tool-operation"], ["ruukoto.browser", "operations", "ruukoto.browser-operation"], ["ruukoto.mcp-config", "operations", "ruukoto.mcp"], ["ruukoto.app-data", "operations", "ruukoto.app-data-operation"], ["ruukoto.service-executions", "tasks", "ruukoto.service-execution"]] as const) {
      const record = await storage.findDocument({ kind, scope: { kind: "session" } }, "current", context);
      if (!record) continue;
      const saved = await storage.document(record.id, "current", context);
      if (!saved || saved.version !== 1) throw invalid();
      const ids = references(saved.value[property]);
      if (ids.some(operation => !populated.get(family)?.has(String(operation)))) throw invalid();
      if (kind === "ruukoto.service-executions" && (ids.some(operation => !pendingInspections.has(String(operation))) || pendingInspections.size !== ids.length)) throw invalid();
      if (kind === "ruukoto.browser" && saved.value.sessions !== undefined && references(saved.value.sessions).some(conversation => !populated.get("ruukoto.browser-session")?.has(String(conversation)))) throw invalid();
    }
    for (const kind of ["ruukoto.command", "ruukoto.service-operation"]) {
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanTasks({ kind }, 256, cursor, context);
        for (const task of page.items) {
          const key = object(task.input) && task.input.requestId;
          if (typeof key !== "string" || !populated.get(kind)?.has(key)) throw invalid();
        }
        cursor = page.next;
      } while (cursor);
    }
    return blockers;
  }
  const harness = source.harness;
  const tools = await harness.snapshot(PersonalToolsDoc, context);
  for (const operation of tools ? references(tools.operations) : []) add(operationBlocker("tool", (await harness.snapshot(PersonalToolDoc, String(operation), context))?.operation, String(operation)));
  const browser = await harness.snapshot(PersonalBrowserDoc, context);
  for (const operation of browser ? references(browser.operations) : []) add(operationBlocker("browser", (await harness.snapshot(PersonalBrowserOperationDoc, String(operation), context))?.operation, String(operation)));
  if (browser) add(browserSessionBlocker(browser, String(ROOT_CONVERSATION_ID)));
  for (const conversation of references(browser?.sessions ?? [])) add(browserSessionBlocker(await harness.snapshot(PersonalBrowserSessionDoc, String(conversation), context), String(conversation)));
  const mcp = await harness.snapshot(PersonalMcpConfigDoc, context);
  for (const operation of mcp ? references(mcp.operations) : []) add(operationBlocker("mcp", (await harness.snapshot(PersonalMcpDoc, String(operation), context))?.operation, String(operation)));
  const data = await harness.snapshot(PersonalAppDataDoc, context);
  for (const operation of data ? references(data.operations) : []) add(operationBlocker("app-data", (await harness.snapshot(PersonalAppDataOperationDoc, String(operation), context))?.operation, String(operation)));
  const inspections = await harness.snapshot(PersonalPendingInspectionsDoc, context);
  for (const operation of inspections ? references(inspections.tasks) : []) {
    const value = (await harness.snapshot(PersonalInspectionDoc, String(operation), context))?.inspection;
    const blocker = operationBlocker("inspection", value, String(operation));
    if (!blocker) throw invalid();
    add(blocker);
  }
  for (const kind of ["ruukoto.command", "ruukoto.service-operation"]) {
    let cursor: Cursor | undefined;
    do {
      const page = await harness.commit(tx => tx.scanTasks({ kind }, 256, cursor), context);
      for (const task of page.items) {
        const key = object(task.input) && task.input.requestId;
        if (typeof key !== "string") throw invalid();
        const value = kind === "ruukoto.command" ? (await harness.snapshot(PersonalCommandDoc, key, context))?.command : (await harness.snapshot(PersonalServiceOperationDoc, key, context))?.operation;
        add(operationBlocker(kind === "ruukoto.command" ? "command" : "service", value, key));
      }
      cursor = page.next;
    } while (cursor);
  }
  return blockers;
}
