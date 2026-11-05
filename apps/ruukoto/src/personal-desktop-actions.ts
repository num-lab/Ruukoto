import { isDeepStrictEqual } from "node:util";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel, type Context } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Cursor, type EntryId, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { PersonalDesktopAction, PersonalDesktopActionName, PersonalDesktopActionReceipt, PersonalDesktopApproval, PersonalDesktopCheck, PersonalDesktopFamily } from "@ruukoto/view/personal-protocol.ts";
import { PersonalError } from "./personal-error.ts";
import { personalToolParameters, personalToolSummary, toolOperation, toolOperations, toolDecide, prepareToolResolution, type personalTools } from "./personal-tools.ts";
import { appDataOperation, appDataOperations, appDataDecide, appDataUnresolved, AppDataObservation, type personalAppData } from "./personal-app-data.ts";
import { personalServiceOperationsIn, personalServiceOperation, decidePersonalServiceOperation, preparePersonalServiceResolution, type personalServiceOperations } from "./personal-service-operations.ts";
import { personalServiceRef } from "./personal-service-controls.ts";
import { personalCommand, personalCommandRef, personalCommandsIn, personalCommandUnresolved, preparePersonalCommandResolution, CommandObservation, type personalCommandWork } from "./personal-command-work.ts";
import { browserOperation, browserOperations, browserDetail, prepareBrowserResolution, PersonalBrowserSessionDoc, PersonalBrowserDoc, type personalBrowser } from "./personal-browser.ts";
import { mcpOperation, mcpOperations, mcpDetail, mcpDecide, prepareMcpResolution, mcpEnd, PersonalMcpConfigDoc, type PersonalCuaRecoveryBinding, type personalMcp } from "./personal-mcp.ts";
import { personalBackgroundProcesses, type personalBackground } from "./personal-background-processes.ts";
import { personalQuestion, personalQuestionActions, answerPersonalQuestion, cancelPersonalQuestion, type PersonalOwnerAnswer } from "./personal-questions.ts";
import { PersonalInspectionDoc, PersonalPendingInspectionsDoc, ServiceInspectionAdmission, ServiceInspectionStopEntry } from "./personal-service-inspection.ts";
import type { personalInspectionControls } from "./personal-inspection-controls.ts";
import { PersonalWorkDoc, personalWorkRef } from "./personal-work.ts";
import type { PersonalEntryIdentity } from "./personal-telegram-records.ts";
import { recordPersonalOwnerClaim, recordPersonalRecoveryCheck, verifyPersonalOwnerClaim, verifyPersonalRecoveryCheck, personalNativeActorValid, PersonalOwnerClaim, PersonalRecoveryCheck, type PersonalNativeActor } from "./personal-recovery-claims.ts";
import { executePersonalHttp } from "./personal-tool-io.ts";
import { personalFileIoJobs, fileIoJobUnresolved, type PersonalFileJobId } from "./personal-file-io.ts";

const context = BACKGROUND_CONTEXT;
type JsonObject = { [key: string]: JsonValue };
type ActionRequest = Omit<PersonalDesktopAction, "answers"> & { answers?: PersonalOwnerAnswer[] };
type ActionReceipt = Omit<PersonalDesktopActionReceipt, "request"> & { request: ActionRequest };
const PERSONAL_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASK = "ruukoto.desktop-action";
const ACTIONS: PersonalDesktopActionName[] = ["approve", "reject", "answer", "cancel_question", "check", "cleanup", "claim_applied", "claim_not_applied", "end_unknown", "resume", "observe", "accept", "stop_sandbox"];
const FAMILIES: PersonalDesktopFamily[] = ["tools", "app-data", "services", "commands", "browser", "mcp", "background", "questions", "inspections"];
const invalid = (code = "desktop_action_invalid", message = "原操作选择无效，请刷新原卡片。") => new PersonalError(code, message);
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
type Continuation = PersonalCuaRecoveryBinding & { fileJobs?: PersonalFileJobId[] };
type Stored = { continuation?: Continuation; receipt: ActionReceipt; actor: PersonalNativeActor; at: number; binding: JsonObject; task?: TaskId; started?: EntryId; result?: EntryId; claim?: EntryId };
export const PersonalDesktopActionsDoc = defineDoc<{ requests: string[] }>({ kind: "ruukoto.desktop-actions", scope: "session", version: 1, initial: () => ({ requests: [] }) });
export const PersonalDesktopActionDoc = defineDocFamily<{ action?: Stored }, null>({ kind: "ruukoto.desktop-action", scope: "session", version: 1, family: true, initial: () => ({}) });
const ActionAdmission = defineEntry<{ v: 1; request: ActionRequest; actor: PersonalNativeActor; at: number; binding: JsonObject; continuation?: Continuation; task?: TaskId }>("ruukoto.desktop-action-admission");
const ActionStart = defineEntry<{ requestId: string; admission: EntryId }>("ruukoto.desktop-action-start");
const ActionResult = defineEntry<{ requestId: string; admission: EntryId; state: PersonalDesktopActionReceipt["state"]; code?: string; check?: PersonalDesktopCheck; claim?: EntryId }>("ruukoto.desktop-action-result");

export type PersonalDesktopTarget = { retained?: boolean; summary: PersonalDesktopApproval; target: string; occurrences: number[]; params: JsonObject; origin: { conversationId: number; work?: number; telegram?: PersonalEntryIdentity }; binding: JsonObject };
export type PersonalDesktopActionServices = { tools?: ReturnType<typeof personalTools>; browser?: ReturnType<typeof personalBrowser>; appData: ReturnType<typeof personalAppData>; commands?: ReturnType<typeof personalCommandWork>; mcp?: ReturnType<typeof personalMcp>; background?: ReturnType<typeof personalBackground>; service?: ReturnType<ReturnType<typeof personalServiceOperations>["api"]>; inspections?: ReturnType<typeof personalInspectionControls> };

export function parsePersonalDesktopAction(input: unknown): ActionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !["v", "requestId", "family", "operation", "admission", "occurrence", "action", "questionVersion", "answers", "observation", "check"].includes(key)) || value.v !== 1 || typeof value.requestId !== "string" || !PERSONAL_REQUEST_ID.test(value.requestId) || !FAMILIES.includes(value.family as PersonalDesktopFamily) || !ACTIONS.includes(value.action as PersonalDesktopActionName) || ![value.operation, value.admission, value.occurrence].every(positive) || value.questionVersion !== undefined && !positive(value.questionVersion) || value.observation !== undefined && !positive(value.observation) || value.check !== undefined && !positive(value.check)) throw invalid();
  if ((value.action === "answer") !== (value.answers !== undefined) || value.answers !== undefined && (!Array.isArray(value.answers) || value.answers.length < 1 || value.answers.length > 3) || value.questionVersion !== undefined && !["answer", "cancel_question"].includes(String(value.action)) || value.observation !== undefined && value.action !== "accept" || value.check !== undefined && !["claim_applied", "claim_not_applied"].includes(String(value.action))) throw invalid();
  return copyJson(value) as ActionRequest;
}

function claims(actions: PersonalDesktopActionName[], available: boolean) { if (available) actions.push("claim_applied", "claim_not_applied"); }
function origin(value: { conversationId: number; work?: { ref: { taskId: number } }; telegram?: PersonalEntryIdentity }) { return { conversationId: value.conversationId, ...(value.work ? { work: value.work.ref.taskId } : {}), ...(value.telegram ? { telegram: value.telegram } : {}) }; }
async function workCanceled(tx: Tx, id?: number) { if (id === undefined) return false; const ref = await personalWorkRef(tx, id as TaskId); return (await tx.doc(PersonalWorkDoc, ref.requestId, null)).cancelRequested === true; }
async function commandRecoveryHistory(tx: Tx, value: Awaited<ReturnType<typeof personalCommand>>) {
  if (!value.prepared || !value.observation) return false;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId: (value.startEntry ?? value.admission) + 1 as EntryId, maxEntryId: value.observation }, 256, cursor);
    if (page.items.some(entry => CommandObservation.is(entry) && isDeepStrictEqual(entry.data.ref, value.ref) && isDeepStrictEqual(entry.data.execution, value.execution) && entry.data.fingerprint === value.prepared!.fingerprint && (entry.data.result.effect === "effect_unknown" && entry.data.result.code !== "started" || !entry.data.stopped))) return true;
    cursor = page.next;
  } while (cursor);
  return false;
}
async function appDataRecoveryHistory(tx: Tx, value: Awaited<ReturnType<typeof appDataOperation>>) {
  if (!value.started || !value.observation) return false;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: value.origin.conversationId, minEntryId: value.started + 1 as EntryId, maxEntryId: value.observation }, 256, cursor);
    if (page.items.some(entry => AppDataObservation.is(entry) && entry.data.operation === value.operation && entry.data.result.op_id === value.opId && entry.data.result.effect === "effect_unknown")) return true;
    cursor = page.next;
  } while (cursor);
  return false;
}
async function inspectionRecoveryHistory(tx: Tx, value: NonNullable<ReturnType<typeof PersonalInspectionDoc.definition.initial>["inspection"]>) {
  if (!value.stopEvidence) return false;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: value.conversationId, minEntryId: value.admission + 1 as EntryId, maxEntryId: value.stopEvidence }, 256, cursor);
    if (page.items.some(entry => ServiceInspectionStopEntry.is(entry) && entry.data.inspectionId === value.inspectionId && entry.data.machineId === value.machineId && !(entry.data.reply?.ok === true && entry.data.reply.verb === "stop-inspect" && entry.data.reply.inspectionId === value.inspectionId && entry.data.reply.machineId === value.machineId && entry.data.reply.exited === true))) return true;
    cursor = page.next;
  } while (cursor);
  return false;
}

// Note: See .agents/notes/implemented/architecture/2026-11-05-personal-desktop-recovery.md
export async function personalDesktopTarget(tx: Tx, family: PersonalDesktopFamily, operation: TaskId): Promise<PersonalDesktopTarget> {
  const actions: PersonalDesktopActionName[] = [];
  let retained = false;
  let target: string, params: JsonObject, binding: JsonObject, source: PersonalDesktopTarget["origin"], summary: PersonalDesktopApproval, occurrences: number[], claim: EntryId | undefined;
  if (family === "tools") {
    const value = await toolOperation(tx, operation), facts = personalToolSummary(value, { local: true });
    target = facts.target; params = json(personalToolParameters(value)); source = origin(value.origin); binding = json({ admission: value.admission, origin: value.origin, prepared: value.prepared, config: value.config, searchConfig: value.searchConfig, grantVersion: value.grantVersion });
    if (facts.canDecide) actions.push("approve", "reject");
    if (value.started && value.code !== "started") actions.push("check");
    const fileJobs = value.fileIoVersion === 1 ? (await personalFileIoJobs(tx)).filter(job => job.operation === operation && fileIoJobUnresolved(job)) : [];
    if (value.code !== "started" && (value.started && !value.stopped && ["file", "file_search"].includes(value.prepared.kind) || !value.started && value.observation !== undefined && fileJobs.length > 0)) actions.push("cleanup");
    claims(actions, facts.canResolve); claim = value.resolution?.claim; retained = value.observation !== undefined && (value.effect === "effect_unknown" || value.effect === "no_write" || value.fileIoVersion === 1 && !["file_returned", "returned"].includes(value.code) && (await personalFileIoJobs(tx)).some(job => job.operation === operation && job.settle !== undefined && job.settle.outcome !== "result")) || !!value.resolution || !!value.redisplay || !!value.redisplays?.length;
    occurrences = [value.admission, ...(value.redisplays ?? (value.redisplay === undefined ? [] : [value.redisplay]))];
    summary = { ...facts, family, target: target.slice(0, 512), targetTruncated: target.length > 512, admission: value.admission, occurrence: value.admission, observed: value.observation !== undefined, ...(value.decisionEntry === undefined ? {} : { decisionEntry: value.decisionEntry }) };
  } else if (family === "app-data") {
    const value = await appDataOperation(tx, operation), local = !value.origin.telegram, native = await tx.task(operation);
    target = `${value.name}${typeof value.params.table === "string" ? `: ${value.params.table}` : ""}`; params = json(value.params); source = origin(value.origin); binding = json({ admission: value.admission, origin: value.origin, instanceId: value.instanceId, opId: value.opId, fingerprint: value.fingerprint, versions: value.versions });
    if (local && value.decision === "pending" && !value.started && !value.result) actions.push("approve", "reject");
    if (appDataUnresolved(value) && native?.state.status === "terminal") actions.push("check");
    retained = !!value.rechecks?.length || await appDataRecoveryHistory(tx, value);
    occurrences = [value.admission]; summary = { family, operation, admission: value.admission, occurrence: value.admission, kind: "app_data", target: target.slice(0, 512), targetTruncated: target.length > 512, approval: value.decision, observed: value.observation !== undefined, started: !!value.started, effect: value.result?.effect ?? (value.started ? "effect_unknown" : "not_committed"), code: value.result?.code ?? (value.started ? "started" : "awaiting_approval"), stopped: native?.state.status === "terminal", canDecide: actions.includes("approve"), ...(value.superseded ? { notice: "要求已更新，这项旧操作没有执行。" } : {}), ...(value.decisionEntry === undefined ? {} : { decisionEntry: value.decisionEntry }) };
  } else if (family === "services") {
    const ref = await personalServiceRef(tx, operation), value = await personalServiceOperation(tx, ref), task = await tx.task(operation), local = !value.telegram;
    const admission = value.work?.admission ?? value.configurationEntry ?? value.source.entryId;
    target = value.unit; params = json({ unit: value.unit, snapshot: value.snapshot }); source = { conversationId: value.work?.ref.agentId ?? ROOT_CONVERSATION_ID, ...(value.work ? { work: value.work.ref.taskId } : {}), ...(value.telegram ? { telegram: value.telegram } : {}) }; binding = json({ admission, ref, source: value.source, telegram: value.telegram, hostOpId: value.hostOpId, snapshot: value.snapshot, configRevision: value.configRevision, configVersion: value.configVersion });
    if (local && value.mode !== "full_access" && value.snapshot && !value.consumed && !value.cancelRequested && !value.result && value.decision === "pending" && task?.state.status !== "terminal" && !task?.abortRequested) actions.push("approve", "reject");
    const unknown = value.consumed && value.result?.effect === "effect_unknown" && value.result.code !== "started";
    if (unknown && value.snapshot) { actions.push("check"); if (!value.launcherStopped) actions.push("cleanup"); }
    claims(actions, local && unknown && !value.resolution); claim = value.resolution?.claim; retained = !!value.resolution || value.cancelRequested && value.launcherStopped;
    occurrences = [admission]; summary = { family, operation, admission, occurrence: admission, kind: "service_restart", target, targetTruncated: false, approval: value.mode === "full_access" ? "unneeded" : value.decision, observed: value.result !== undefined && value.result.code !== "started", started: value.consumed, effect: value.result?.effect === "executed" ? "returned" : value.result?.effect ?? "not_executed", code: value.result?.code ?? "pending", stopped: !value.consumed || value.launcherStopped, canDecide: actions.includes("approve"), ...(value.superseded ? { notice: "要求已更新，这项旧服务操作没有执行。" } : {}) };
  } else if (family === "commands") {
    const ref = await personalCommandRef(tx, operation), value = await personalCommand(tx, ref), local = !value.work.telegram;
    target = value.command; params = json({ command: value.command }); source = { conversationId: value.work.ref.agentId, work: value.work.ref.taskId, ...(value.work.telegram ? { telegram: value.work.telegram } : {}) }; binding = json({ admission: value.admission, ref, execution: value.execution, work: value.work, prepared: value.prepared, configRevision: value.configRevision, configVersion: value.configVersion });
    if (value.started && value.result?.code !== "started" && personalCommandUnresolved(value)) { actions.push("check"); if (!value.stopped) actions.push("cleanup"); }
    claims(actions, local && value.result?.effect === "effect_unknown" && value.result.code !== "started" && !value.resolution); claim = value.resolution?.claim; retained = !!value.preparationStop || !!value.resolution || !!value.stopTask || await commandRecoveryHistory(tx, value);
    occurrences = [value.admission]; summary = { family, operation, admission: value.admission, occurrence: value.admission, kind: "run_command", target: target.slice(0, 512), targetTruncated: target.length > 512, approval: "unneeded", observed: value.observation !== undefined, started: value.started, effect: value.result?.effect ?? "not_executed", code: value.result?.code ?? "pending", stopped: !value.started || value.stopped, canDecide: false, ...(value.superseded ? { notice: "要求已更新，这项旧命令没有执行。" } : {}) };
  } else if (family === "browser") {
    const value = await browserOperation(tx, operation), detail = await browserDetail(tx, operation), local = !value.origin.telegram;
    target = value.params.url ?? value.params.action; params = json(value.params); source = origin(value.origin); binding = json({ admission: value.admission, origin: value.origin, config: value.config, controlled: value.controlled, claim: value.claim, params: value.params });
    if (value.started && value.code !== "started") actions.push("check");
    if (detail.summary.canVerifyStop) actions.push("cleanup");
    if (local && detail.summary.canResume) actions.push("resume");
    claims(actions, local && detail.summary.canResolve); claim = value.resolution?.claim; retained = value.observation !== undefined && ["effect_unknown", "no_write"].includes(value.effect) || !!value.stopEvidence || !!value.stopTask || !!value.resolution || value.params.action === "pause";
    occurrences = [value.admission]; summary = { family, operation, admission: value.admission, occurrence: value.admission, kind: "browser", target: target.slice(0, 512), targetTruncated: target.length > 512, approval: "unneeded", observed: value.observation !== undefined, started: value.started, effect: value.effect, code: value.code, stopped: value.stopped, canDecide: false, ...(value.superseded ? { notice: "要求已更新，这项旧网页操作没有执行。" } : {}) };
  } else if (family === "mcp") {
    const value = await mcpOperation(tx, operation), detail = await mcpDetail(tx, operation, 0, undefined, false), local = !value.origin.telegram, cua = value.config.services.find(service => service.id === value.service)?.cua, facts = detail.summary, unneeded = value.origin.permission.mode === "full_access" || value.localEffect === "read" || !!value.controlled;
    target = `${facts.service}: ${value.tool}`; params = json({ service: value.service, tool: value.tool, arguments: value.args }); source = origin(value.origin); binding = json({ admission: value.admission, origin: value.origin, config: value.config, configVersion: value.configVersion, service: value.service, tool: value.tool, args: value.args, controlled: value.controlled, interactive: value.interactive, execution: value.cua?.execution });
    if (local && !unneeded && facts.canDecide) actions.push("approve", "reject");
    if (value.started && value.code !== "started") actions.push("check");
    if (local && facts.canEnd) actions.push("end_unknown");
    if (cua) {
      if (facts.cuaStopUnverified) actions.push("cleanup");
      if (local && facts.cuaRecovery === "frozen") actions.push("stop_sandbox");
      if (local && ["stopped", "begun", "observed"].includes(facts.cuaRecovery ?? "")) actions.push("observe");
      if (local && facts.cuaRecovery === "observed") actions.push("accept");
      const paused = (await tx.doc(PersonalMcpConfigDoc)).cuaPause;
      if (local && facts.cuaRecovery === "accepted" && paused?.paused && (paused.operation === undefined || paused.operation === operation) && !await workCanceled(tx, source.work)) actions.push("resume");
    }
    claims(actions, local && facts.canResolve);
    claim = value.resolution?.claim; retained = value.cuaStopPending !== undefined || !!value.takeover || !!value.cua?.recovery || !!value.ended || !!value.resolution;
    occurrences = [value.admission]; summary = { family, operation, admission: value.admission, occurrence: value.admission, kind: cua ? "cua" : "http_request", target: target.slice(0, 512), targetTruncated: target.length > 512, approval: unneeded ? "unneeded" : value.decision, observed: value.observation !== undefined, started: value.started, effect: value.effect, code: value.code, stopped: !value.started || value.remoteEnded && !facts.cuaStopUnverified, canDecide: actions.includes("approve"), ...(value.superseded ? { notice: "要求已更新，这项旧操作没有执行。" } : {}), ...(value.decisionEntry === undefined ? {} : { decisionEntry: value.decisionEntry }), ...(facts.cuaObservation === undefined ? {} : { observation: facts.cuaObservation }), ...(detail.recoveryImages?.length ? { images: detail.recoveryImages.map(({ id, mime, bytes, sha256, partial }) => ({ id, mime, bytes, sha256, partial })) } : {}) };
  } else if (family === "background") {
    const value = (await personalBackgroundProcesses(tx)).find(value => value.operation === operation);
    if (!value) throw invalid("desktop_action_stale", "原后台执行不存在，请刷新原工作。");
    target = value.command; params = json({ command: value.command }); source = origin(value.origin); binding = json({ admission: value.admission, id: value.id, execution: value.execution, fingerprint: value.fingerprint, origin: value.origin, directory: value.directory });
    if (value.observation) actions.push("check"); retained = !!value.stopIntents?.length;
    if (!value.stopped && (value.state === "stop_requested" || value.state === "stop_unverified" || await workCanceled(tx, source.work))) actions.push("cleanup");
    occurrences = [value.admission]; summary = { family, operation, admission: value.admission, occurrence: value.admission, kind: "process", target: target.slice(0, 512), targetTruncated: target.length > 512, approval: "unneeded", observed: value.observation !== undefined, started: value.launchClaim !== undefined, effect: value.exit ? "returned" : value.stopped && !value.launchClaim ? "not_executed" : "effect_unknown", code: value.state, stopped: value.stopped, canDecide: false, ...(value.superseded ? { notice: "要求已更新，这项旧启动没有执行。" } : {}) };
  } else if (family === "inspections") {
    const value = (await tx.doc(PersonalInspectionDoc, String(operation), null)).inspection;
    if (!value) throw invalid("desktop_action_stale", "原检查不存在，请刷新卡片。");
    const task = await tx.task(operation);
    target = value.unit; params = json({ unit: value.unit }); source = { conversationId: value.conversationId, ...(value.work ? { work: value.work.ref.taskId } : {}) }; binding = json({ admission: value.admission, inspectionId: value.inspectionId, machineId: value.machineId, unit: value.unit, sources: value.sources, configRevision: value.configRevision, configVersion: value.configVersion });
    const needsStop = !value.stopped && !!task && (task.state.status === "terminal" || task.abortRequested);
    retained = !!task?.abortRequested || task?.state.status === "terminal" && task.state.outcome.status !== "completed" || value.result !== undefined && value.result.code !== "ok" || needsStop || await inspectionRecoveryHistory(tx, value);
    if (retained) actions.push("check"); if (needsStop) actions.push("cleanup");
    occurrences = [value.admission]; summary = { family, operation, admission: value.admission, occurrence: value.admission, kind: "service_inspect", target, targetTruncated: false, approval: "unneeded", observed: value.result !== undefined, started: true, effect: "no_write", code: value.stopped ? "inspection_stopped" : "inspection_stop_unverified", stopped: value.stopped, canDecide: false };
  } else {
    const value = await personalQuestion(tx, String(operation)), facts = personalQuestionActions(value);
    target = value.questions[0].question; params = json({ questions: value.questions }); source = origin(value.origin); binding = json({ admission: value.admission, id: value.id, origin: value.origin, operation, generation: value.generation });
    if (facts.canAnswer) actions.push("answer"); if (facts.canCancel) actions.push("cancel_question");
    occurrences = [value.admission]; summary = { family, operation, admission: value.admission, occurrence: value.admission, kind: "browser", target: target.slice(0, 512), targetTruncated: target.length > 512, approval: "unneeded", observed: value.status !== "pending", started: false, effect: "no_write", code: value.status, stopped: true, canDecide: false };
  }
  summary.actions = actions;
  if (source.work !== undefined) summary.work = source.work;
  if (claim !== undefined) { const data = await verifyPersonalOwnerClaim(tx, claim, { family, operation, admission: summary.admission, effect: (await tx.entry(PersonalOwnerClaim, claim))!.data.effect }); summary.claim = { entry: claim, effect: data.effect, at: data.at }; }
  const saved = (await tx.doc(PersonalDesktopActionsDoc)).requests;
  for (let index = saved.length - 1; index >= 0; index--) {
    const receipt = (await tx.doc(PersonalDesktopActionDoc, saved[index], null)).action?.receipt;
    if (!receipt || receipt.request.family !== family || receipt.request.operation !== operation || receipt.request.admission !== summary.admission || !receipt.check) continue;
    summary.check = { ...receipt.check, text: receipt.check.text.slice(0, 512) }; break;
  }
  return { ...(retained ? { retained } : {}), summary, target, params, origin: source, binding, occurrences };
}

export async function personalDesktopTargets(tx: Tx) {
  const targets: PersonalDesktopTarget[] = [], inspections = new Set<TaskId>((await tx.doc(PersonalPendingInspectionsDoc)).tasks);
  let conversations: Cursor | undefined;
  do { const page = await tx.scanConversations({}, 256, conversations); for (const conversation of page.items) { let cursor: Cursor | undefined; do { const page = await tx.scanEntries({ conversationId: conversation.id }, 256, cursor); for (const entry of page.items) if (ServiceInspectionAdmission.is(entry)) inspections.add(entry.data.taskId); cursor = page.next; } while (cursor); } conversations = page.next; } while (conversations);
  const ids: Array<[PersonalDesktopFamily, TaskId[]]> = [["tools", (await toolOperations(tx)).map(value => value.operation)], ["app-data", (await appDataOperations(tx)).map(value => value.operation)], ["services", (await personalServiceOperationsIn(tx)).map(value => value.ref.taskId)], ["commands", (await personalCommandsIn(tx)).map(value => value.ref.taskId)], ["browser", (await browserOperations(tx)).map(value => value.operation)], ["mcp", (await mcpOperations(tx)).map(value => value.operation)], ["background", (await personalBackgroundProcesses(tx)).map(value => value.operation)], ["inspections", [...inspections]]];
  for (const [family, operations] of ids) for (const operation of operations) targets.push(await personalDesktopTarget(tx, family, operation));
  return targets;
}

async function actionContinuation(tx: Tx, request: PersonalDesktopAction): Promise<Continuation | undefined> {
  if (request.family === "tools" && request.action === "cleanup" && (await toolOperation(tx, request.operation as TaskId)).fileIoVersion === 1) return { fileJobs: (await personalFileIoJobs(tx)).filter(job => job.operation === request.operation).map(job => job.id) };
  if (request.family === "mcp" && ["observe", "accept", "cleanup", "stop_sandbox", "resume"].includes(request.action)) {
    const value = await mcpOperation(tx, request.operation as TaskId);
    return copyJson({ ...(value.takeover ? { pause: value.takeover.paused } : {}), ...(request.action === "accept" ? { observation: request.observation } : {}), ...(request.action === "resume" ? { observation: (value.takeover ?? value.cua?.recovery)?.observation?.entry, accepted: (value.takeover ?? value.cua?.recovery)?.accepted } : {}), ...(value.cua ? { execution: value.cua.execution } : {}), ...(request.action === "cleanup" ? { launches: value.cuaLaunches?.map(launch => launch.entry) ?? [] } : {}) }) as Continuation;
  }
  if (request.family === "browser" && request.action === "resume") {
    const value = await browserOperation(tx, request.operation as TaskId), session = value.origin.conversationId === ROOT_CONVERSATION_ID ? await tx.doc(PersonalBrowserDoc) : await tx.doc(PersonalBrowserSessionDoc, String(value.origin.conversationId), null);
    return { ...(session.pause ? { pause: session.pause.entry } : {}) };
  }
}

export function personalDesktopActions(directory: string, getHarness: () => Harness, getServices: () => PersonalDesktopActionServices) {
  async function receipt(tx: Tx, requestId: string) {
    const value = (await tx.doc(PersonalDesktopActionDoc, requestId, null)).action;
    if (value?.receipt.state === "admitted" && value.task && (await tx.task(value.task))?.state.status === "terminal") await finish(tx, value, value.started && value.receipt.request.action !== "check" ? "effect_unknown" : "failed", "desktop_action_interrupted");
    return value && copyJson(value.receipt) as ActionReceipt;
  }
  async function finish(tx: Tx, value: Stored, state: PersonalDesktopActionReceipt["state"], code?: string, check?: PersonalDesktopCheck) {
    value.receipt = { ...value.receipt, state, ...(code === undefined ? {} : { code }), ...(check === undefined ? {} : { check }) };
    value.result = (await tx.appendEntry(ActionResult, ROOT_CONVERSATION_ID, { data: { requestId: value.receipt.request.requestId, admission: value.receipt.entry as EntryId, state, ...(code === undefined ? {} : { code }), ...(check === undefined ? {} : { check }), ...(value.claim === undefined ? {} : { claim: value.claim }) } })).id;
  }
  async function stored(tx: Tx, key: string) { const value = (await tx.doc(PersonalDesktopActionDoc, key, null)).action; if (!value) throw invalid("desktop_action_stale"); return value; }
  async function validateTarget(tx: Tx, input: PersonalDesktopAction) {
    let target: PersonalDesktopTarget;
    try { target = await personalDesktopTarget(tx, input.family, input.operation as TaskId); }
    catch (error) { if (!(error instanceof PersonalError)) throw error; throw invalid("desktop_action_stale", "原操作无法核实，请刷新原卡片。"); }
    if (target.summary.admission !== input.admission || !target.occurrences.includes(input.occurrence)) throw invalid("desktop_action_stale", "原卡片已变化，请刷新原操作。");
    if (target.origin.telegram && !["check", "cleanup", "cancel_question", "end_unknown"].includes(input.action)) throw invalid("desktop_action_original_entry", "请从发起工作的原入口处理此选择。");
    if (!target.summary.actions?.includes(input.action)) throw invalid("desktop_action_unavailable", "原操作现在不能执行此选择，请刷新卡片。");
    if (input.action === "accept" && input.observation !== target.summary.observation) throw invalid("desktop_action_stale", "新观察已变化，请重新查看原卡片。");
    if (input.check !== undefined) { try { await verifyPersonalRecoveryCheck(tx, input.check as EntryId, input); } catch (error) { if (!(error instanceof PersonalError)) throw error; throw invalid("desktop_action_stale", "所选检查不属于原操作。"); } }
    if (input.family === "questions") { const question = await personalQuestion(tx, String(input.operation)); if (input.questionVersion !== question.version) throw invalid("desktop_action_stale", "原问题已处理或版本变化，请刷新问题。"); }
    return target;
  }
  async function sync(tx: Tx, input: PersonalDesktopAction) {
    const operation = input.operation as TaskId;
    if (input.action === "approve" || input.action === "reject") {
      const decision = input.action === "approve" ? "approved" : "rejected";
      if (input.family === "tools") await toolDecide(tx, operation, decision, directory);
      else if (input.family === "app-data") await appDataDecide(tx, directory, operation, decision);
      else if (input.family === "mcp") await mcpDecide(tx, operation, decision);
      else if (input.family === "services") await decidePersonalServiceOperation(tx, await personalServiceRef(tx, operation), decision);
      else throw invalid("desktop_action_unavailable");
    } else if (input.action === "end_unknown") await mcpEnd(tx, operation);
    else if (input.action === "resume" && input.family === "browser") { const browser = getServices().browser; if (!browser) throw invalid("desktop_action_unavailable"); await browser.chooseResume(tx, operation, undefined, input.requestId); }
    else if (input.action === "answer" || input.action === "cancel_question") {
      const original = { question: String(operation), version: input.questionVersion!, requestId: input.requestId };
      if (input.action === "answer") await answerPersonalQuestion(tx, { ...original, answers: input.answers as PersonalOwnerAnswer[] }, { kind: "local" });
      else await cancelPersonalQuestion(tx, original, { kind: "local" });
    } else return false;
    return true;
  }
  async function check(input: PersonalDesktopAction, callContext: Context): Promise<Omit<PersonalDesktopCheck, "entry">> {
    const operation = input.operation as TaskId, services = getServices(), harness = getHarness();
    if (input.family === "app-data") {
      await services.appData.reconcile(operation, callContext);
      const value = await harness.commit(tx => appDataOperation(tx, operation).then(value => copyJson(value) as Awaited<ReturnType<typeof appDataOperation>>), callContext);
      return { kind: "receipt", code: value.result?.code ?? "app_data_receipt_unknown", text: value.result?.effect === "committed" ? "原应用数据操作的审计回执确认已提交。" : value.result?.effect === "not_committed" ? "原应用数据操作没有提交回执。" : "原应用数据审计回执仍无法核实。" };
    }
    if (input.family === "commands") {
      if (!services.commands) throw invalid("desktop_action_unavailable");
      const ref = await harness.commit(tx => personalCommandRef(tx, operation), callContext);
      return services.commands.checkReceipt(harness, ref, callContext);
    }
    if (input.family === "services") {
      if (!services.service) throw invalid("desktop_action_unavailable");
      const value = await harness.commit(async tx => copyJson(await personalServiceOperation(tx, await personalServiceRef(tx, operation))) as Awaited<ReturnType<typeof personalServiceOperation>>, callContext);
      return services.service.checkOriginal(value.ref, { hostOpId: value.hostOpId, machineId: value.snapshot!.machineId });
    }
    if (input.family === "tools") {
      const value = await harness.commit(async tx => copyJson(await toolOperation(tx, operation)) as Awaited<ReturnType<typeof toolOperation>>, callContext);
      if (value.prepared.kind === "http") {
        const result = await executePersonalHttp({ ...value.prepared.request, method: "HEAD", body: undefined }, callContext.abortSignal);
        return { kind: "observation", code: result.code, text: result.status === undefined ? "原网址的当前状态无法核实；原操作的实际效果保持原记录。" : `原网址当前返回 HTTP ${result.status}。这是当前观察，不能确认原请求的效果。` };
      }
      return { kind: "receipt", code: value.code, text: value.effect === "returned" ? "原操作已有完成结果。" : "原操作的结果仍待核实；此次读取没有重新执行。" };
    }
    if (input.family === "browser") {
      const value = await harness.commit(async tx => copyJson(await browserOperation(tx, operation)) as Awaited<ReturnType<typeof browserOperation>>, callContext);
      return { kind: "receipt", code: value.code, text: `原网页动作：${value.code}。此次读取没有重发原动作。` };
    }
    if (input.family === "mcp") {
      const value = await harness.commit(async tx => copyJson(await mcpOperation(tx, operation)) as Awaited<ReturnType<typeof mcpOperation>>, callContext);
      return { kind: "receipt", code: value.code, text: value.remoteEnded ? "原调用已有应答，业务效果以原结果和独立说明为准。" : "原调用没有可核实的完成应答；此次读取没有重发请求。" };
    }
    if (input.family === "inspections") {
      const value = await harness.commit(async tx => (await tx.doc(PersonalInspectionDoc, String(operation), null)).inspection?.stopped, callContext);
      return { kind: "receipt", code: "inspection_receipt", text: value ? "原检查停止已经核实。" : "原检查停止仍未核实。" };
    }
    if (input.family === "background") {
      const value = await harness.commit(async tx => { const process = (await personalBackgroundProcesses(tx)).find(value => value.operation === operation); return process && { state: process.state, stopped: process.stopped }; }, callContext);
      if (!value) throw invalid("desktop_action_stale");
      return { kind: "receipt", code: value.state, text: value.stopped ? "原后台执行的停止已核实。" : "原后台执行仍未核实停止。" };
    }
    throw invalid("desktop_action_unavailable");
  }
  async function cleanup(input: PersonalDesktopAction, action: EntryId, continuation: Continuation | undefined, callContext: Context) {
    const operation = input.operation as TaskId, services = getServices(), harness = getHarness();
    if (input.family === "tools") {
      if (!services.tools) throw invalid("desktop_action_unavailable"); await services.tools.cleanup(operation, continuation?.fileJobs);
    } else if (input.family === "browser") {
      if (!services.browser) throw invalid("desktop_action_unavailable");
      if (!await services.browser.verifyStop(operation)) throw new PersonalError("browser_stop_unverified", "原浏览器停止仍未核实。");
    } else if (input.family === "commands") {
      if (!services.commands) throw invalid("desktop_action_unavailable");
      const ref = await harness.commit(tx => personalCommandRef(tx, operation), callContext); await services.commands.reconcile(harness, ref, callContext);
      const stopped = await harness.commit(async tx => (await personalCommand(tx, ref)).stopped, callContext); if (!stopped) throw new PersonalError("command_stop_unverified", "原命令执行停止仍未核实。");
    } else if (input.family === "services") {
      if (!services.service) throw invalid("desktop_action_unavailable");
      const value = await harness.commit(async tx => copyJson(await personalServiceOperation(tx, await personalServiceRef(tx, operation))) as Awaited<ReturnType<typeof personalServiceOperation>>, callContext);
      await services.service.recheckStop(value.ref, { hostOpId: value.hostOpId, machineId: value.snapshot!.machineId });
      if (!(await services.service.status(value.ref)).operation.launcherStopped) throw new PersonalError("service_stop_unverified", "原服务执行停止仍未核实。");
    } else if (input.family === "mcp") {
      if (!services.mcp) throw invalid("desktop_action_unavailable");
      if (input.action === "resume") { const saved = await harness.commit(tx => stored(tx, input.requestId).then(value => copyJson(value.continuation) as Continuation), callContext); await services.mcp.resumeCua(operation, saved); }
      else if (input.action === "stop_sandbox") await services.mcp.recoverCua(operation, "stop", undefined, action, continuation);
      else if (input.action === "observe") await services.mcp.recoverCua(operation, "observe", undefined, undefined, continuation);
      else if (input.action === "accept") await services.mcp.recoverCua(operation, "accept", input.observation as EntryId, undefined, continuation);
      else await services.mcp.cleanupCua(operation, continuation);
    } else if (input.family === "inspections") {
      if (!services.inspections) throw invalid("desktop_action_unavailable");
      const task = await harness.commit(tx => services.inspections!.request(tx, { taskId: operation, admission: input.admission as EntryId }), callContext);
      await harness.waitForTask(task, callContext);
      const stopped = await harness.commit(async tx => (await tx.doc(PersonalInspectionDoc, String(operation), null)).inspection?.stopped, callContext);
      if (!stopped) throw new PersonalError("inspection_stop_unverified", "原检查停止仍未核实。");
    } else if (input.family === "background") {
      if (!services.background) throw invalid("desktop_action_unavailable");
      const id = await harness.commit(async tx => (await personalBackgroundProcesses(tx)).find(value => value.operation === operation)?.id, callContext);
      if (!id) throw invalid("desktop_action_stale"); await services.background.stop(id);
    } else throw invalid("desktop_action_unavailable");
  }
  async function execute(requestId: string, callContext: Context) {
    const harness = getHarness();
    const start = await harness.commit(async tx => {
      const value = await stored(tx, requestId);
      if (value.receipt.state !== "admitted") return undefined;
      if (value.started) { await finish(tx, value, "effect_unknown", "desktop_action_interrupted"); return undefined; }
      const target = await personalDesktopTarget(tx, value.receipt.request.family, value.receipt.request.operation as TaskId), continuation = await actionContinuation(tx, value.receipt.request);
      if (!isDeepStrictEqual(continuation, value.continuation) || !isDeepStrictEqual(target.binding, value.binding) || !target.summary.actions?.includes(value.receipt.request.action) || value.receipt.request.action === "accept" && target.summary.observation !== value.receipt.request.observation) { await finish(tx, value, "failed", "desktop_action_stale"); return undefined; }
      value.started = (await tx.appendEntry(ActionStart, ROOT_CONVERSATION_ID, { data: { requestId, admission: value.receipt.entry as EntryId } })).id;
      return copyJson(value) as Stored;
    }, callContext);
    if (!start) return;
    let state: PersonalDesktopActionReceipt["state"] = "completed", code: string | undefined, checked: Omit<PersonalDesktopCheck, "entry"> | undefined;
    const child = withCancel(callContext), timeout = setTimeout(() => child.cancel(new PersonalError("desktop_action_timeout", "原检查或停止超过等待期限，请查询原操作。")), 30_000);
    try {
      if (start.receipt.request.action === "check") checked = await check(start.receipt.request, child.context);
      else await cleanup(start.receipt.request, start.receipt.entry as EntryId, start.continuation, child.context);
    } catch (error) { state = start.receipt.request.action === "check" ? "failed" : "effect_unknown"; code = error instanceof PersonalError ? error.code : "desktop_action_failed"; if (!(error instanceof PersonalError)) process.stderr.write("[ruukoto:personal] Native recovery action failed; its original receipt retains the failure and execution uncertainty.\n"); }
    finally { clearTimeout(timeout); child.cancel(); }
    await harness.commit(async tx => {
      const value = await stored(tx, requestId);
      if (value.receipt.state !== "admitted") return;
      const result = checked && await recordPersonalRecoveryCheck(tx, value.receipt.request, value.receipt.entry as EntryId, value.actor, checked);
      await finish(tx, value, state, code, result);
    }, context);
  }
  const task = defineTask<{ requestId: string }, { phase: "run" }, null>({ name: TASK, version: 1, initial: () => ({ phase: "run" }), phases: { async run(current, runtime, callContext) {
    try { await execute(current.input.requestId, callContext); }
    catch (error) {
      if (!(error instanceof PersonalError)) process.stderr.write("[ruukoto:personal] Recovery action could not finish; its original receipt retains the failure.\n");
      await getHarness().commit(async tx => { const value = await stored(tx, current.input.requestId); if (value.receipt.state === "admitted") await finish(tx, value, value.started && value.receipt.request.action !== "check" ? "effect_unknown" : "failed", error instanceof PersonalError ? error.code : "desktop_action_failed"); }, context);
    }
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), callContext);
  } }, async abort(current, runtime, callContext) { await getHarness().commit(async tx => { const value = await stored(tx, current.input.requestId); if (value.receipt.state === "admitted") await finish(tx, value, value.started ? "effect_unknown" : "failed", "desktop_action_canceled"); }, context); await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext); } });
  return { extension: defineExtension({ name: "personal-desktop-actions", tasks: [task] }), receipt,
    async admit(tx: Tx, input: PersonalDesktopAction, actor: PersonalNativeActor = { kind: "local" }) {
      const request = parsePersonalDesktopAction(input); if (!personalNativeActorValid(actor)) throw invalid();
      const old = (await tx.doc(PersonalDesktopActionDoc, input.requestId, null)).action;
      if (old) { if (!isDeepStrictEqual(old.receipt.request, input) || !isDeepStrictEqual(old.actor, actor)) throw invalid("desktop_action_conflict", "原选择请求的内容或来源不同，请查询原回执。"); return copyJson(old.receipt) as ActionReceipt; }
      const target = await validateTarget(tx, input), at = Date.now(), operation = input.operation as TaskId, continuation = await actionContinuation(tx, input);
      const index = await tx.doc(PersonalDesktopActionsDoc);
      for (const key of index.requests) { const pending = (await tx.doc(PersonalDesktopActionDoc, key, null)).action; if (pending?.receipt.state === "admitted" && pending.receipt.request.family === input.family && pending.receipt.request.operation === input.operation) throw invalid("desktop_action_unavailable", "原选择已登记，请查询原回执。"); }
      let applyClaim: ((proof: { claim: EntryId }) => Promise<void>) | undefined;
      try { if (input.action === "claim_applied" || input.action === "claim_not_applied") {
        const effect = input.action === "claim_applied" ? "applied" : "not_applied";
        if (input.family === "tools") applyClaim = await prepareToolResolution(tx, operation, effect);
        else if (input.family === "browser") applyClaim = await prepareBrowserResolution(tx, operation, effect);
        else if (input.family === "commands") applyClaim = await preparePersonalCommandResolution(tx, await personalCommandRef(tx, operation), effect);
        else if (input.family === "services") applyClaim = await preparePersonalServiceResolution(tx, await personalServiceRef(tx, operation), effect);
        else if (input.family === "mcp") applyClaim = await prepareMcpResolution(tx, operation, effect);
        else throw invalid("desktop_action_unavailable");
      } } catch (error) { if (!(error instanceof PersonalError)) throw error; throw invalid("desktop_action_unavailable", error.message); }
      const draft: Stored = { ...(continuation ? { continuation } : {}), receipt: { v: 1, request, entry: 0, state: "admitted" }, actor, at, binding: target.binding };
      let completed = false;
      try { completed = applyClaim ? false : await sync(tx, input); }
      catch (error) { if (!(error instanceof PersonalError)) throw error; throw invalid("desktop_action_unavailable", error.message); }
      draft.receipt.entry = (await tx.appendEntry(ActionAdmission, ROOT_CONVERSATION_ID, { data: { v: 1, request, actor, at, binding: target.binding, ...(continuation ? { continuation } : {}) } })).id;
      if (applyClaim) { draft.claim = await recordPersonalOwnerClaim(tx, request, draft.receipt.entry as EntryId, actor); await applyClaim({ claim: draft.claim }); }
      const document = await tx.doc(PersonalDesktopActionDoc, input.requestId, null); document.action = draft; const value = document.action!; index.requests.push(input.requestId);
      if (applyClaim || completed) await finish(tx, value, "completed");
      else value.task = await tx.createTask(task, { requestId: input.requestId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
      return copyJson(value.receipt) as ActionReceipt;
    },
    async verify(tx: Tx, enabled: boolean) {
      const keys = (await tx.doc(PersonalDesktopActionsDoc)).requests, admissions = new Set<EntryId>(), starts = new Set<EntryId>(), results = new Set<EntryId>(), tasks = new Set<TaskId>(), claims = new Set<EntryId>(), checks = new Set<EntryId>();
      if (new Set(keys).size !== keys.length || !enabled && keys.length) throw invalid("desktop_action_stale");
      if (!await tx.conversation(ROOT_CONVERSATION_ID)) { if (keys.length) throw invalid("desktop_action_stale"); return; }
      for (const key of keys) {
        const value = await stored(tx, key), input = parsePersonalDesktopAction(value.receipt.request), target = await personalDesktopTarget(tx, input.family, input.operation as TaskId), entry = await tx.entry(ActionAdmission, value.receipt.entry as EntryId);
        if (key !== input.requestId || !entry || entry.conversationId !== ROOT_CONVERSATION_ID || !personalNativeActorValid(value.actor) || !Number.isSafeInteger(value.at) || value.at < 1 || !isDeepStrictEqual(entry.data, { v: 1, request: input, actor: value.actor, at: value.at, binding: value.binding, ...(value.continuation ? { continuation: value.continuation } : {}) }) || !isDeepStrictEqual(target.binding, value.binding) || target.summary.admission !== input.admission || !target.occurrences.includes(input.occurrence) || !["admitted", "completed", "failed", "effect_unknown"].includes(value.receipt.state)) throw invalid("desktop_action_stale");
        if (value.continuation?.pause) { const pause = await tx.entry(value.continuation.pause); if (!pause || pause.id >= entry.id || !["ruukoto.mcp-cua-pause", "ruukoto.browser-pause"].includes(pause.kind) || !pause.data || typeof pause.data !== "object" || Array.isArray(pause.data) || pause.data.operation !== input.operation) throw invalid("desktop_action_stale"); }
        if (input.action === "accept" && value.continuation?.observation !== input.observation) throw invalid("desktop_action_stale");
        admissions.add(entry.id);
        if (value.task) { const native = await tx.task(value.task); if (!native || native.kind !== TASK || native.version !== 1 || native.owner !== undefined || !native.background || native.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(native.input, { requestId: key })) throw invalid("desktop_action_stale"); tasks.add(value.task); }
        if (value.started) { const start = await tx.entry(ActionStart, value.started); if (!value.task || !start || start.conversationId !== ROOT_CONVERSATION_ID || start.id <= entry.id || !isDeepStrictEqual(start.data, { requestId: key, admission: entry.id })) throw invalid("desktop_action_stale"); starts.add(start.id); }
        if (value.result) { const result = await tx.entry(ActionResult, value.result); if (!result || result.id <= entry.id || !isDeepStrictEqual(result.data, { requestId: key, admission: entry.id, state: value.receipt.state, ...(value.receipt.code === undefined ? {} : { code: value.receipt.code }), ...(value.receipt.check === undefined ? {} : { check: value.receipt.check }), ...(value.claim === undefined ? {} : { claim: value.claim }) })) throw invalid("desktop_action_stale"); results.add(value.result); }
        else if (value.receipt.state !== "admitted") throw invalid("desktop_action_stale");
        if (value.claim) { const claim = await tx.entry(PersonalOwnerClaim, value.claim); if (!claim || claim.data.action !== entry.id) throw invalid("desktop_action_stale"); await verifyPersonalOwnerClaim(tx, value.claim, { family: input.family, operation: input.operation, admission: input.admission, effect: input.action === "claim_applied" ? "applied" : "not_applied" }); claims.add(value.claim); }
        if (value.receipt.check) { const check = await verifyPersonalRecoveryCheck(tx, value.receipt.check.entry as EntryId, input); if (check.action !== entry.id || !isDeepStrictEqual(value.receipt.check, { entry: value.receipt.check.entry, kind: check.kind, code: check.code, text: check.text })) throw invalid("desktop_action_stale"); checks.add(value.receipt.check.entry as EntryId); }
      }
      let conversations: Cursor | undefined;
      do { const page = await tx.scanConversations({}, 256, conversations); for (const conversation of page.items) { let entries: Cursor | undefined; do { const page = await tx.scanEntries({ conversationId: conversation.id }, 256, entries); for (const entry of page.items) if (ActionAdmission.is(entry) && !admissions.has(entry.id) || ActionStart.is(entry) && !starts.has(entry.id) || ActionResult.is(entry) && !results.has(entry.id) || PersonalOwnerClaim.is(entry) && !claims.has(entry.id) || PersonalRecoveryCheck.is(entry) && !checks.has(entry.id)) throw invalid("desktop_action_stale"); entries = page.next; } while (entries); } conversations = page.next; } while (conversations);
      let cursor: Cursor | undefined;
      cursor = undefined; do { const page = await tx.scanTasks({ kind: TASK }, 256, cursor); if (page.items.some(value => !tasks.has(value.id))) throw invalid("desktop_action_stale"); cursor = page.next; } while (cursor);
    },
  };
}
