import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { OwnerQuestionError, parseOwnerAnswers } from "@ruukoto/core/owner-question-input.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineEntry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Cursor, type EntryId, type Harness, type TaskId, type TaskRecord, type Tx } from "@earendil-works/pi-durable";
import type { PersonalDesktopFamily } from "@ruukoto/view/personal-protocol.ts";
import { PersonalError } from "./personal-error.ts";
import { PersonalImApiError, type PersonalImAccess } from "./personal-im-api.ts";
import { personalImDeliveryRecord, personalImDeliveryResult, requestPersonalImDelivery, type PersonalImDeliveryInput, type PersonalImDeliveryRecord } from "./personal-im-delivery.ts";
import { personalDesktopTarget, personalDesktopTargets, type PersonalDesktopTarget } from "./personal-desktop-actions.ts";
import { PersonalTelegramDisplayAdmission, PersonalTelegramDisplayDoc, PersonalTelegramDisplaysDoc, PersonalTelegramTokenDoc, type PersonalTelegramDisplay, type PersonalTelegramDisplayTarget } from "./personal-telegram-display-records.ts";
import { PERSONAL_TELEGRAM_CUA_ACTIONS, PERSONAL_TELEGRAM_CUA_VIEW, PersonalTelegramDoc, PersonalTelegramReceiptDoc, samePersonalEntry, type PersonalEntryIdentity, type TelegramControlInput, type TelegramSelection } from "./personal-telegram-records.ts";
import { telegramSourceActive } from "./personal-permissions.ts";
import { personalQuestion, PersonalQuestionsDoc, refreshPersonalQuestions, type PersonalQuestion } from "./personal-questions.ts";
import { personalQuestionLastPage, personalQuestionPrompt, questionOptionLabel } from "./personal-question-controls.ts";
import { personalToolSummary, toolOperation } from "./personal-tools.ts";
import { mcpDetail, mcpOperation, type PersonalCuaRecoveryBinding } from "./personal-mcp.ts";
import { appDataOperation, appDataUnresolved } from "./personal-app-data.ts";
import { personalServiceOperation, personalServiceOperationsIn } from "./personal-service-operations.ts";
import { personalServiceDetail, personalServiceRef } from "./personal-service-controls.ts";
import { personalCommand, personalCommandRef } from "./personal-command-work.ts";
import { PersonalWorkDoc } from "./personal-work.ts";
import { browserDetail, browserOperation, PersonalBrowserDoc, PersonalBrowserSessionDoc } from "./personal-browser.ts";
import { personalBackgroundProcesses } from "./personal-background-processes.ts";
import { personalSource, personalSourceImReceipt } from "./personal-source.ts";
import { personalImEffectContent } from "./personal-recovery-claims.ts";
import { personalTelegramDisplaySelection, type PersonalTelegramSelection } from "./personal-telegram-selection.ts";
import type { PersonalTelegramApi } from "./personal-telegram-api.ts";
import { personalTelegramCuaImagesDelivered } from "./personal-telegram-cua-images.ts";

const context = BACKGROUND_CONTEXT;
const TASK = "ruukoto.telegram-card-edit";
type Action = { text: string; action: string };
type Projection = { target: PersonalTelegramDisplayTarget; binding: JsonValue; source: PersonalEntryIdentity; messageId: number; selection: TelegramSelection; text: string; actions: Action[]; state: string; transition: string; continuation?: PersonalCuaRecoveryBinding };
type DisplayInput = { key: string; source: PersonalEntryIdentity; messageId: number; selection: TelegramSelection; text: string; actions: Action[]; origin: EntryId; target?: PersonalTelegramDisplayTarget; binding?: JsonValue; continuation?: PersonalCuaRecoveryBinding; transition?: string; redisplay?: { display: string } };
export type PersonalTelegramDisplayPreparation = { previous?: PersonalTelegramDisplay; projections: Projection[]; questions: PersonalQuestion[] };
const EditAdmission = defineEntry<{ key: string; taskId: TaskId; text: string }>("ruukoto.telegram-card-edit-admission");
const EditClaim = defineEntry<{ key: string; display: EntryId; messageId: string; text: string }>("ruukoto.telegram-card-edit-claim");
const EditObservation = defineEntry<{ key: string; state: string }>("ruukoto.telegram-card-edit-observation");
type EditState = NonNullable<PersonalTelegramDisplay["edit"]>;
const invalid = () => new PersonalError("telegram_display_invalid", "原卡片无法核实，请查询原操作或重新显示卡片。");
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const hash = (value: JsonValue) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const label = (family: PersonalDesktopFamily) => ({ tools: "操作", "app-data": "应用数据", services: "服务", commands: "命令", browser: "网页", mcp: "外部工具", questions: "问题", background: "后台", inspections: "检查" })[family];
const effects = (family: PersonalDesktopFamily): Action[] => ["applied", "not_applied"].map(effect => ({ text: effect === "applied" ? "已生效" : "未生效", action: personalImEffectContent(family, effect as "applied" | "not_applied")! }));

function selectionMatches(selection: TelegramSelection, target: PersonalTelegramDisplayTarget) {
  if (["tool", "tool-resolution", "tool-stop"].includes(selection.kind)) return target.family === "tools" && "operation" in selection && selection.operation === target.operation;
  if (["mcp", "mcp-resolution"].includes(selection.kind)) return target.family === "mcp" && "operation" in selection && selection.operation === target.operation;
  if (["browser", "browser-resolution"].includes(selection.kind)) return target.family === "browser" && "operation" in selection && selection.operation === target.operation;
  if (selection.kind === "app-data") return target.family === "app-data" && selection.operation === target.operation;
  if (["approval", "service-status", "service-recovery", "service-resolution"].includes(selection.kind)) return target.family === "services" && "ref" in selection && "taskId" in selection.ref && selection.ref.taskId === target.operation;
  if (["command", "command-resolution"].includes(selection.kind)) return target.family === "commands" && "ref" in selection && "taskId" in selection.ref && selection.ref.taskId === target.operation;
  if (["question-draft", "question-view"].includes(selection.kind)) return target.family === "questions" && "id" in selection && selection.id === String(target.operation);
  return target.family === "background" && selection.kind === "background";
}

async function project(tx: Tx, value: PersonalDesktopTarget, source: PersonalEntryIdentity, occurrence: EntryId): Promise<Projection | undefined> {
  const { summary } = value, family = summary.family ?? "tools", operation = summary.operation as TaskId;
  if (!samePersonalEntry(value.origin.telegram, source) || !await telegramSourceActive(tx, source)) return;
  const actor = { ...source, requestId: "telegram-display" }, actions: Action[] = [];
  let selection: TelegramSelection, continuation: PersonalCuaRecoveryBinding | undefined, facts: JsonValue = json(summary), state = summary.notice ?? (summary.effect === "effect_unknown" && summary.code !== "started" ? "结果还需要核实。" : summary.approval === "rejected" ? "这项操作已拒绝。" : summary.approval === "approved" ? "本次操作已批准。" : summary.effect === "returned" || summary.effect === "committed" ? "原操作已有结果。" : "这项操作没有执行。"), pending = false;
  if (family === "tools") {
    selection = { kind: "tool", operation };
    const saved = await toolOperation(tx, operation), current = personalToolSummary(saved, { telegram: source });
    if (current.canDecide) { pending = true; actions.push({ text: "批准本次", action: "工具批准本次" }, { text: "拒绝", action: "工具拒绝" }); }
    else if (current.canResolve) actions.push(...effects(family));
    if (current.canVerifyStop) actions.push({ text: "核实原请求结束", action: "核实工具原请求结束" });
    facts = json({ decision: saved.decisionEntry, observation: saved.observation, resolution: saved.resolution?.entry, stop: saved.stopEvidence?.entry, superseded: saved.superseded?.entry });
  } else if (family === "app-data") {
    selection = { kind: "app-data", operation };
    const saved = await appDataOperation(tx, operation);
    if (saved.decision === "pending" && !saved.started && !saved.result) { pending = true; actions.push({ text: "批准本次", action: "数据批准本次" }, { text: "拒绝", action: "数据拒绝" }); }
    if (appDataUnresolved(saved) && (await tx.task(operation))?.state.status === "terminal") actions.push({ text: "核实原回执", action: "重新核实数据回执" });
    facts = json({ decision: saved.decisionEntry, observation: saved.observation, rechecks: saved.rechecks, superseded: saved.superseded?.entry });
  } else if (family === "mcp") {
    selection = { kind: "mcp", operation };
    const saved = await mcpOperation(tx, operation), current = (await mcpDetail(tx, operation, 0, actor)).summary;
    if (current.canDecide && summary.approval !== "unneeded") { pending = true; actions.push({ text: "批准本次", action: "MCP批准本次" }, { text: "拒绝", action: "MCP拒绝" }); }
    else if (current.canResolve) actions.push(...effects(family));
    if (current.canEnd) actions.push({ text: "结束并保留未知结果", action: "MCP结束此工作" });
    if (saved.config.services.find(service => service.id === saved.service)?.cua) {
      const canonical = await personalDesktopTarget(tx, family, operation, source), scene = saved.takeover ?? saved.cua?.recovery;
      const delivered = scene?.observation && await personalTelegramCuaImagesDelivered(tx, operation, scene.observation.entry, source);
      if (scene?.observation) actions.push({ text: "查看现场截图", action: PERSONAL_TELEGRAM_CUA_VIEW });
      for (const [action, name] of Object.entries(PERSONAL_TELEGRAM_CUA_ACTIONS)) if (canonical.summary.actions?.includes(name) && (name !== "accept" || delivered)) actions.push({ text: action, action });
      continuation = { ...(saved.takeover ? { pause: saved.takeover.paused } : {}), ...(scene?.observation ? { observation: scene.observation.entry } : {}), ...(scene?.accepted ? { accepted: scene.accepted } : {}), ...(saved.cua ? { execution: saved.cua.execution } : {}), ...(saved.cuaLaunches ? { launches: saved.cuaLaunches.map(launch => launch.entry) } : {}) };
      if (current.cuaRecovery) state = ({ frozen: "电脑已暂停，请分别核实效果与原执行停止。", stopped: "原电脑停止已核实，可以观察新现场。", begun: "电脑恢复已开始，可以重新观察现场。", observed: "新现场已保存，请核对后接受。", accepted: "新现场已接受。" } as Record<string, string>)[current.cuaRecovery] ?? state;
    }
    facts = json({ decision: saved.decisionEntry, observation: saved.observation, resolution: saved.resolution?.entry, ended: saved.ended?.entry, stop: saved.cuaStopPending, recovery: saved.cua?.recovery, takeover: saved.takeover });
  } else if (family === "services") {
    const saved = await personalServiceOperation(tx, await personalServiceRef(tx, operation));
    const task = await tx.task(operation), current = (await personalServiceDetail(tx, saved.ref, 0, actor)).summary;
    pending = saved.mode !== "full_access" && !!saved.snapshot && !saved.consumed && !saved.cancelRequested && !saved.result && saved.decision === "pending" && task?.state.status !== "terminal" && !task?.abortRequested;
    selection = pending ? { kind: "approval", ref: saved.ref } : { kind: "service-recovery", ref: saved.ref };
    if (pending) {
      actions.push({ text: "批准本次", action: "批准本次" }, { text: "拒绝", action: "拒绝" });
      if (!(await personalSource(tx, saved.source.requestId)).scheduled) actions.push({ text: "批准并长期授权", action: "批准并长期授权" });
    } else {
      if (current.canResolve) actions.push(...effects(family));
      if (current.canRecheck) actions.push({ text: "核实原执行停止", action: "核实操作停止" });
    }
    facts = json({ decision: saved.decidedBy, result: saved.result, resolution: saved.resolution, stopped: saved.launcherStopped, stop: current.stop, superseded: saved.superseded?.entry });
  } else if (family === "commands") {
    const ref = await personalCommandRef(tx, operation), saved = await personalCommand(tx, ref);
    selection = { kind: "command", ref, view: "record" };
    if (saved.result?.effect === "effect_unknown" && saved.result.code !== "started" && !saved.resolution) actions.push(...effects(family));
    if (saved.started && saved.result?.code !== "started") actions.push({ text: "核实原命令停止", action: "核实命令停止" });
    facts = json({ observation: saved.observation, resolution: saved.resolution?.entry, stopped: saved.stopped, preparationStop: saved.preparationStop, superseded: saved.superseded?.entry });
  } else if (family === "browser") {
    selection = { kind: "browser", operation };
    const saved = await browserOperation(tx, operation), current = (await browserDetail(tx, operation, 0, actor)).summary;
    if (current.canResolve) actions.push(...effects(family));
    if (current.canVerifyStop) actions.push({ text: "核实浏览器停止", action: "停止并核实浏览器" });
    if (current.canResume) {
      actions.push({ text: "继续原浏览器工作", action: "继续原浏览器工作" });
      const session = saved.origin.conversationId === ROOT_CONVERSATION_ID ? await tx.doc(PersonalBrowserDoc) : await tx.doc(PersonalBrowserSessionDoc, String(saved.origin.conversationId), null);
      continuation = session.pause ? { pause: session.pause.entry } : undefined;
      state = "浏览器已暂停，完成操作后可继续原工作。";
    }
    facts = json({ observation: saved.observation, resolution: saved.resolution?.entry, stopped: saved.stopped, stop: saved.stopEvidence, pause: continuation?.pause, superseded: saved.superseded?.entry });
  } else if (family === "background") {
    const saved = (await personalBackgroundProcesses(tx)).find(process => process.operation === operation);
    if (!saved) throw invalid();
    selection = { kind: "background", id: saved.id };
    if (!saved.stopped && summary.actions?.includes("cleanup")) actions.push({ text: "核实原后台停止", action: "停止此后台" });
    facts = json({ observation: saved.observation, stopped: saved.stopped, stops: saved.stopIntents });
  } else return;
  if (pending) state = "需要你确认这项操作。";
  let requestId: string;
  if (family === "services") requestId = (await personalServiceOperation(tx, await personalServiceRef(tx, operation))).source.requestId;
  else if (family === "commands") {
    const command = await personalCommand(tx, await personalCommandRef(tx, operation));
    const work = await tx.doc(PersonalWorkDoc, command.work.ref.requestId, null);
    if (!work.source) throw invalid();
    requestId = work.source.requestId;
  } else {
    const origin = value.binding.origin;
    if (!origin || typeof origin !== "object" || Array.isArray(origin) || !origin.source || typeof origin.source !== "object" || Array.isArray(origin.source) || typeof origin.source.requestId !== "string") throw invalid();
    requestId = origin.source.requestId;
  }
  const receipt = await personalSourceImReceipt(tx, requestId);
  if (!receipt || !samePersonalEntry(receipt, source)) throw invalid();
  const text = `${state}\n${label(family)}：${value.target}${actions.some(action => action.action === "停止原电脑沙箱") ? "\n停止整个电脑沙箱可能丢失其他未保存内容。" : ""}${actions.some(action => action.action === PERSONAL_TELEGRAM_CUA_VIEW) ? "\n请查看并核对本次现场截图，完整送达后才可接受。" : ""}${pending ? `\n${JSON.stringify(value.params, null, 2)}\n1. 批准本次\n2. 拒绝` : ""}`;
  return { target: { family, operation, admission: summary.admission as EntryId, occurrence }, binding: value.binding, source, messageId: receipt.messageId, selection, text, actions, state, transition: hash(json({ facts, actions, continuation })), ...(continuation ? { continuation } : {}) };
}

function questionActions(value: Awaited<ReturnType<typeof personalQuestion>>, menu: Extract<TelegramSelection, { kind: "question-draft" }>): Action[] {
  const actions: Action[] = [], page = menu.page ?? 0, last = personalQuestionLastPage(value, menu);
  if (page > 0) actions.push({ text: "上一页", action: "上一页问题" });
  if (page < last) actions.push({ text: "下一页", action: "下一页问题" });
  else if (menu.step === value.questions.length) actions.push({ text: "提交答案", action: "确认回答" }, { text: "重新回答", action: "重新回答" });
  else {
    const item = value.questions[menu.step];
    item.options?.forEach((option, index) => actions.push({ text: `${menu.selected?.includes(index) ? "☑ " : ""}${questionOptionLabel(option)}`, action: String(index + 1) }));
    if (item.multiple) actions.push({ text: "完成选择", action: "完成选择" });
    actions.push({ text: "跳过", action: "跳过" });
  }
  actions.push({ text: "取消问题", action: "取消问题" });
  return actions;
}

function questionProjection(value: PersonalQuestion, target: PersonalTelegramDisplayTarget, source: PersonalEntryIdentity, messageId: number): Projection {
  const menu: Extract<TelegramSelection, { kind: "question-draft" }> = { kind: "question-draft", id: value.id, version: value.version, step: 0, answers: [] };
  return { target, binding: json({ admission: value.admission, origin: value.origin, generation: value.generation }), source, messageId, selection: menu, text: value.status === "pending" ? personalQuestionPrompt(value, menu) : value.status === "answered" ? "问题已回答。" : "问题已取消或失效。", actions: value.status === "pending" ? questionActions(value, menu) : [], state: value.status, transition: hash(json({ admission: value.admission, version: value.version, status: value.status })) };
}

export async function personalTelegramTarget(tx: Tx, target: PersonalTelegramDisplayTarget, source: PersonalEntryIdentity): Promise<Projection | undefined> {
  if (target.family === "questions") {
    const value = await personalQuestion(tx, String(target.operation));
    if (!samePersonalEntry(value.origin.telegram, source) || value.admission !== target.admission || !await telegramSourceActive(tx, source)) return;
    const receipt = await personalSourceImReceipt(tx, value.origin.source.requestId);
    if (!receipt) throw invalid();
    if (target.occurrence !== value.admission) return;
    return questionProjection(value, target, source, receipt.messageId);
  }
  const current = await personalDesktopTarget(tx, target.family, target.operation, source);
  if (current.summary.admission !== target.admission || !current.occurrences.includes(target.occurrence)) return;
  return project(tx, current, source, target.occurrence);
}

async function display(tx: Tx, key: string) { const value = (await tx.doc(PersonalTelegramDisplayDoc, key, null)).display; if (!value || value.key !== key) throw invalid(); return value; }
async function editState(tx: Tx, key: string, taskId: TaskId) { const saved = await display(tx, key); if (!saved.edit || saved.edit.taskId !== taskId) throw invalid(); return { saved, state: saved.edit }; }
async function observeEdit(tx: Tx, saved: PersonalTelegramDisplay, state: EditState["state"]) {
  if (!saved.edit || !["pending", "sending"].includes(saved.edit.state) || state === "pending" || state === "sending") throw invalid();
  saved.edit.state = state;
  saved.edit.observation = (await tx.appendEntry(EditObservation, ROOT_CONVERSATION_ID, { data: { key: saved.key, state } })).id;
}
export async function requestPersonalTelegramDisplay(tx: Tx, input: DisplayInput) {
  const old = (await tx.doc(PersonalTelegramDisplayDoc, input.key, null)).display;
  if (old) {
    const { admission: _admission, edit: _edit, v: _v, buttons, delivery: _delivery, ...fixed } = old;
    if (!isDeepStrictEqual({ ...fixed, actions: buttons.map(({ token: _token, ...action }) => action) }, input)) throw new PersonalError("telegram_display_conflict", "原卡片请求已登记，内容不符；请查询原记录。");
    return old;
  }
  if (typeof input.key !== "string" || !input.key || input.source.platform || !await telegramSourceActive(tx, input.source) || !positive(input.messageId) || !positive(input.origin) || !input.text || !Array.isArray(input.actions) || new Set(input.actions.map(action => action.action)).size !== input.actions.length || input.target && (!positive(input.target.operation) || !positive(input.target.admission) || !positive(input.target.occurrence) || !selectionMatches(input.selection, input.target)) || !!input.target !== (input.binding !== undefined)) throw invalid();
  const buttons = input.actions.map(action => ({ ...action, token: randomBytes(24).toString("base64url") })), keyboard = buttons.length ? buttons.map(button => [{ text: button.text, callback_data: button.token }]) : undefined;
  const delivery = await requestPersonalImDelivery(tx, { key: input.key, source: { ...input.source }, messageId: input.messageId, text: input.text, ...(keyboard ? { keyboard } : {}) });
  const fixed = { v: 1 as const, key: input.key, source: { ...input.source }, messageId: input.messageId, selection: copyJson(input.selection) as TelegramSelection, text: input.text, buttons, delivery, origin: input.origin, ...(input.target ? { target: { ...input.target } } : {}), ...(input.binding === undefined ? {} : { binding: copyJson(input.binding) }), ...(input.continuation ? { continuation: copyJson(input.continuation) as PersonalCuaRecoveryBinding } : {}), ...(input.transition ? { transition: input.transition } : {}), ...(input.redisplay ? { redisplay: { ...input.redisplay } } : {}) };
  const admission = (await tx.appendEntry(PersonalTelegramDisplayAdmission, ROOT_CONVERSATION_ID, { data: fixed })).id;
  const saved: PersonalTelegramDisplay = { ...fixed, admission };
  (await tx.doc(PersonalTelegramDisplayDoc, input.key, null)).display = saved;
  (await tx.doc(PersonalTelegramDisplaysDoc)).keys.push(input.key);
  for (const button of buttons) { const token = await tx.doc(PersonalTelegramTokenDoc, button.token, null); if (token.display) throw invalid(); token.display = input.key; token.action = button.action; }
  return saved;
}

function menuOperations(menu: TelegramSelection | undefined): Array<{ family: PersonalDesktopFamily; operation: TaskId }> {
  if (!menu) return [];
  const family: PersonalDesktopFamily | undefined = ({ tool: "tools", "tool-list": "tools", "tool-resolution": "tools", "tool-stop": "tools", mcp: "mcp", "mcp-list": "mcp", "mcp-resolution": "mcp", "app-data": "app-data", "app-data-list": "app-data", browser: "browser", "browser-list": "browser", "browser-resolution": "browser", command: "commands", "command-list": "commands", "command-resolution": "commands", approval: "services", "service-status": "services", "service-list": "services", "service-recovery": "services", "service-resolution": "services" } as Partial<Record<TelegramSelection["kind"], PersonalDesktopFamily>>)[menu.kind];
  if (!family) return [];
  const ids = "operations" in menu ? menu.operations : "operation" in menu ? [menu.operation] : "refs" in menu ? menu.refs.flatMap(ref => "taskId" in ref ? [ref.taskId] : []) : "ref" in menu && "taskId" in menu.ref ? [menu.ref.taskId] : [];
  return ids.map(operation => ({ family, operation }));
}

export async function preparePersonalTelegramReceiptDisplay(tx: Tx, value: TelegramControlInput, previous?: PersonalTelegramSelection): Promise<PersonalTelegramDisplayPreparation> {
  const old = previous && (await tx.doc(PersonalTelegramDisplayDoc, previous.requestId, null)).display, projections: Projection[] = [], questions: PersonalQuestion[] = [];
  if (value.platform) return { projections, questions };
  const candidates = menuOperations(previous?.selection);
  if (value.content === "/审批" || value.content === "下一项" && previous?.selection?.kind === "approval") {
    for (const operation of await personalServiceOperationsIn(tx)) if (samePersonalEntry(operation.telegram, value)) candidates.push({ family: "services", operation: operation.ref.taskId });
  }
  for (const candidate of new Map(candidates.map(candidate => [`${candidate.family}:${candidate.operation}`, candidate])).values()) {
    const current = await personalDesktopTarget(tx, candidate.family, candidate.operation, value), projection = await project(tx, current, value, current.summary.admission as EntryId);
    if (projection) projections.push(copyJson(projection) as Projection);
  }
  const menu = previous?.selection, ids = menu?.kind === "question-list" ? menu.ids : menu?.kind === "question-draft" || menu?.kind === "question-view" ? [menu.id] : [];
  for (const id of ids) questions.push(copyJson(await personalQuestion(tx, id)) as PersonalQuestion);
  return { ...(old ? { previous: copyJson(old) as PersonalTelegramDisplay } : {}), projections, questions };
}

function committedControl(value: TelegramControlInput) { return !!(value.toolDecision || value.toolResolution || value.toolStop || value.mcpDecision || value.mcpResolution || value.mcpEnded || value.mcpRecheck || value.browserResolution || value.browserResume || value.browserStop || value.appDataDecision || value.appDataRecheck || value.serviceDecision || value.serviceResolution || value.serviceStop || value.commandResolution || value.commandStop || value.backgroundAction || value.cuaAction); }

export async function personalTelegramReceiptDisplay(tx: Tx, value: TelegramControlInput, prepared: PersonalTelegramDisplayPreparation = { projections: [], questions: [] }) {
  if (value.platform || !value.reply || value.accepted === undefined || !value.selection && !value.redisplay) return;
  const original = value.redisplay ? prepared.previous : undefined, selection = original?.selection ?? value.selection;
  if (!selection || value.redisplay && (!original || original.key !== value.redisplay.display || !samePersonalEntry(original.source, value) || value.reply !== original.text || value.selection !== undefined)) throw invalid();
  const projection = prepared.projections.find(item => selectionMatches(selection, item.target));
  let target = original?.target ?? projection?.target, binding = original?.binding ?? projection?.binding, continuation = original?.continuation ?? projection?.continuation, transition = original?.transition ?? projection?.transition, actions: Action[] = [];
  if (selection.kind === "question-draft") {
    const question = await personalQuestion(tx, selection.id);
    target = { family: "questions", operation: question.operation, admission: question.admission, occurrence: question.admission };
    binding = json({ admission: question.admission, origin: question.origin, generation: question.generation });
    actions = question.status === "pending" ? questionActions(question, selection) : [];
    transition = hash(json({ admission: question.admission, version: question.version, status: question.status }));
  } else if (projection && !committedControl(value) && selection.kind === projection.selection.kind) {
    actions = projection.actions;
    continuation = projection.continuation; transition = projection.transition;
  }
  const saved = await requestPersonalTelegramDisplay(tx, { key: `telegram-display:receipt:${value.requestId}`, source: { botId: value.botId, ownerId: value.ownerId, generation: value.generation }, messageId: value.messageId, selection, text: value.reply, actions, origin: value.accepted, ...(target ? { target } : {}), ...(binding === undefined ? {} : { binding }), ...(continuation ? { continuation } : {}), ...(transition ? { transition } : {}), ...(value.redisplay ? { redisplay: { ...value.redisplay } } : {}) });
  value.display = saved.key;
  return saved.delivery;
}

export async function validatePersonalTelegramDisplayAction(tx: Tx, value: TelegramControlInput) {
  const selected = await personalTelegramDisplaySelection(tx, value);
  if (!selected) return !value.callback;
  const saved = await display(tx, selected.requestId);
  if (!value.callback) return true;
  if (saved.target) {
    const current = await personalTelegramTarget(tx, saved.target, value);
    if (!current || !isDeepStrictEqual(current.binding, saved.binding)) return false;
    if (saved.target.family === "questions") { if (current.state !== "pending") return false; }
    else if (!current.actions.some(action => action.action === value.content)) return false;
    if (Object.hasOwn(PERSONAL_TELEGRAM_CUA_ACTIONS, value.content) || value.content === PERSONAL_TELEGRAM_CUA_VIEW || value.content === "继续原浏览器工作") if (!isDeepStrictEqual(current.continuation, saved.continuation)) return false;
  }
  return !value.callback || saved.buttons.some(button => button.token === value.callback!.token && button.action === value.content);
}

export async function authorizePersonalTelegramDisplay(tx: Tx, input: PersonalImDeliveryInput) {
  const saved = (await tx.doc(PersonalTelegramDisplayDoc, input.key, null)).display;
  if (!saved) return true;
  if (saved.delivery.key !== input.key || !isDeepStrictEqual(saved.source, input.source) || saved.text !== input.text || saved.messageId !== input.messageId) throw invalid();
  if (!saved.target || !saved.buttons.length) return true;
  const current = await personalTelegramTarget(tx, saved.target, saved.source);
  if (!current || !isDeepStrictEqual(current.binding, saved.binding)) return false;
  if (saved.target.family === "questions") return current.state === "pending";
  return saved.buttons.every(button => current.actions.some(action => action.action === button.action)) && (!saved.continuation || isDeepStrictEqual(current.continuation, saved.continuation));
}

// Note: See .agents/notes/implemented/architecture/2026-11-06-personal-telegram-delivery.md
export function personalTelegramDisplays(getHarness: () => Harness, im: PersonalImAccess, transport: (source: PersonalEntryIdentity) => PersonalTelegramApi | undefined) {
  let stopping = false, queued = false, scanning: Promise<void> | undefined, unsubscribe: (() => void) | undefined;
  const edit = defineTask<{ key: string }, { phase: "send" } | { phase: "verify" }, null>({ name: TASK, version: 1, initial: () => ({ phase: "send" }), phases: {
    async send(current, runtime, callContext) {
      let api: PersonalTelegramApi | undefined, target: { source: PersonalEntryIdentity; messageId: number; text: string } | undefined;
      const original = (await runtime.snapshot(PersonalTelegramDisplayDoc, current.input.key, callContext))?.display;
      if (!original) throw invalid();
      await im.withEntry(original.source, async () => {
        await runtime.commit(async tx => {
          const { saved, state } = await editState(tx, current.input.key, current.id);
          if (state.state !== "pending" || state.claim || state.observation) throw invalid();
          const sent = (await personalImDeliveryRecord(tx, saved.delivery)).parts.findLast(part => part.kind === "text");
          if (!im.isActive(saved.source) || !await telegramSourceActive(tx, saved.source) || sent?.state !== "sent" || !sent.platformMessageId) { await observeEdit(tx, saved, "canceled"); return { status: "terminal", outcome: { status: "completed", result: null } }; }
          if (!positive(Number(sent.platformMessageId))) throw invalid();
          state.state = "sending"; state.claim = (await tx.appendEntry(EditClaim, ROOT_CONVERSATION_ID, { data: { key: saved.key, display: saved.admission, messageId: sent.platformMessageId, text: state.text } })).id;
          target = { source: { ...saved.source }, messageId: Number(sent.platformMessageId), text: state.text };
          return { status: "running", checkpoint: { phase: "verify" } };
        }, callContext);
        if (target) api = transport(target.source);
      });
      if (!target) return;
      let state: NonNullable<PersonalTelegramDisplay["edit"]>["state"] = "sent";
      try { if (!api) throw new PersonalImApiError("telegram_inactive", "原入口不可用。", "not_sent"); await api.edit(target.source.ownerId, target.messageId, target.text, runtime.signal); }
      catch (error) { state = error instanceof PersonalImApiError && error.effect === "not_sent" ? "failed" : "effect_unknown"; }
      await runtime.commit(async tx => { const currentEdit = await editState(tx, current.input.key, current.id); if (currentEdit.state.state !== "sending" || !currentEdit.state.claim || currentEdit.state.observation) throw invalid(); await observeEdit(tx, currentEdit.saved, state); return { status: "terminal", outcome: { status: "completed", result: null } }; }, callContext);
    },
    async verify(current, runtime, callContext) { await runtime.commit(async tx => { const { saved, state } = await editState(tx, current.input.key, current.id); if (state.state !== "sending" || !state.claim || state.observation) throw invalid(); await observeEdit(tx, saved, "effect_unknown"); return { status: "terminal", outcome: { status: "completed", result: null } }; }, callContext); },
  }, async abort(current, runtime, callContext) { await runtime.commit(async tx => { const { saved, state } = await editState(tx, current.input.key, current.id); if (state.state === "pending" || state.state === "sending") await observeEdit(tx, saved, state.state === "sending" ? "effect_unknown" : "canceled"); return { status: "terminal", outcome: { status: "aborted", result: null } }; }, callContext); } });
  async function scan() {
    await getHarness().commit(tx => refreshPersonalQuestions(tx), context);
    await getHarness().commit(async tx => {
      const source = (await tx.doc(PersonalTelegramDoc)).config;
      if (!source?.enabled || !im.isActive(source)) return;
      const projections: Projection[] = [];
      for (const target of await personalDesktopTargets(tx)) if (target.origin.telegram && samePersonalEntry(target.origin.telegram, source)) for (const occurrence of target.occurrences) { const current = await project(tx, target, source, occurrence as EntryId); if (current) projections.push(current); }
      for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) { const question = await personalQuestion(tx, id); if (!samePersonalEntry(question.origin.telegram, source)) continue; const current = await personalTelegramTarget(tx, { family: "questions", operation: question.operation, admission: question.admission, occurrence: question.admission }, source); if (current) projections.push(current); }
      const additions: DisplayInput[] = [], edits: { saved: PersonalTelegramDisplay; text: string }[] = [];
      for (const projection of projections) if (projection.actions.length) {
        const { target, binding, selection, text, actions, transition, continuation, messageId } = projection, key = `telegram-display:${target.family}:${target.operation}:${target.occurrence}:${transition}`;
        if (!(await tx.doc(PersonalTelegramDisplayDoc, key, null)).display) additions.push({ key, target, binding, source: { botId: source.botId, ownerId: source.ownerId, generation: source.generation }, selection, text, actions, transition, messageId, origin: target.occurrence, ...(continuation ? { continuation } : {}) });
      }
      for (const key of (await tx.doc(PersonalTelegramDisplaysDoc)).keys) {
        const saved = await display(tx, key);
        if (!saved.target || !saved.buttons.length || saved.edit || !samePersonalEntry(saved.source, source)) continue;
        const current = projections.find(item => isDeepStrictEqual(item.target, saved.target));
        if (current && isDeepStrictEqual(current.binding, saved.binding) && (saved.target.family === "questions" ? current.state === "pending" : saved.buttons.every(button => current.actions.some(action => action.action === button.action)) && (!saved.continuation || isDeepStrictEqual(current.continuation, saved.continuation)))) continue;
        const delivery = await personalImDeliveryRecord(tx, saved.delivery);
        if (personalImDeliveryResult(delivery).textState !== "sent") continue;
        const text = Array.from(`${current?.state ?? "原入口已失效或操作已结束。"}\n${label(saved.target.family)}：${current?.text.split("\n")[1]?.replace(/^[^：]*：/, "") ?? "请查询原记录。"}`).slice(0, 3500).join("");
        edits.push({ saved, text });
      }
      for (const input of additions) await requestPersonalTelegramDisplay(tx, input);
      for (const { saved, text } of edits) { const taskId = await tx.createTask(edit, { key: saved.key }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }), admission = (await tx.appendEntry(EditAdmission, ROOT_CONVERSATION_ID, { data: { key: saved.key, taskId, text } })).id; saved.edit = { taskId, text, admission, state: "pending" }; }
    }, context);
    getHarness().resume();
  }
  function schedule() {
    if (stopping) return;
    queued = true;
    if (scanning) return;
    scanning = (async () => { while (queued && !stopping) { queued = false; await scan(); } })().catch(error => { if (!stopping) process.stderr.write(`[ruukoto:personal] Telegram card projection failed (${error instanceof PersonalError ? error.code : "projection_failed"}); pending decisions remain available through their original menus.\n`); }).finally(() => { scanning = undefined; if (queued && !stopping) schedule(); });
  }
  return { extension: defineExtension({ name: "personal-telegram-displays", tasks: [edit] }),
    async start() {
      if (unsubscribe || stopping) return;
      unsubscribe = getHarness().subscribeCommits(publication => { if (publication.changes.some(change => change.type === "entry" ? ![PersonalTelegramDisplayAdmission.kind, EditAdmission.kind, EditClaim.kind, EditObservation.kind, "ruukoto.im-delivery-admission", "ruukoto.im-delivery-claim", "ruukoto.im-delivery-observation"].includes(change.value.kind) : change.type === "task" ? change.value.kind !== TASK : change.type === "document" && !["ruukoto.telegram-displays", "ruukoto.telegram-display", "ruukoto.telegram-token"].includes(change.record.kind))) schedule(); });
      await scan();
    },
    async close() { stopping = true; unsubscribe?.(); await scanning; },
  };
}

function questionDraftValid(question: PersonalQuestion, selection: TelegramSelection) {
  if (selection.kind !== "question-draft") return selection.kind === "question-view" && selection.id === question.id && Number.isSafeInteger(selection.page) && selection.page >= 0;
  if (selection.id !== question.id || selection.version !== 1 || !Number.isSafeInteger(selection.step) || selection.step < 0 || selection.step > question.questions.length || !Array.isArray(selection.answers) || selection.answers.length !== selection.step) return false;
  try { parseOwnerAnswers([...selection.answers, ...question.questions.slice(selection.step).map(() => ({ text: "" }))], question.questions); }
  catch (error) { if (!(error instanceof OwnerQuestionError)) throw error; return false; }
  const item = question.questions[selection.step];
  if (selection.selected !== undefined && (!item?.multiple || !Array.isArray(selection.selected) || selection.selected.some((index, position) => !Number.isSafeInteger(index) || index < 0 || !item.options?.[index] || position > 0 && index <= selection.selected![position - 1]))) return false;
  return Number.isSafeInteger(selection.page ?? 0) && (selection.page ?? 0) >= 0 && (selection.page ?? 0) <= personalQuestionLastPage(question, selection);
}

async function verifyDisplayEdit(tx: Tx, saved: PersonalTelegramDisplay, delivery: PersonalImDeliveryRecord, task: TaskRecord<JsonValue, JsonValue, JsonValue>, entries: Set<EntryId>) {
  const state = saved.edit!, start = await tx.entry(EditAdmission, state.admission), sent = delivery.parts.findLast(part => part.kind === "text");
  if (task.kind !== TASK || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !isDeepStrictEqual(task.input, { key: saved.key }) || !start || start.conversationId !== ROOT_CONVERSATION_ID || start.id <= saved.admission || !isDeepStrictEqual(start.data, { key: saved.key, taskId: task.id, text: state.text }) || typeof state.text !== "string" || !state.text || Array.from(state.text).length > 4096 || !["pending", "sending", "sent", "failed", "effect_unknown", "canceled"].includes(state.state)) throw invalid();
  entries.add(start.id);
  if (state.claim !== undefined) {
    const claim = await tx.entry(EditClaim, state.claim);
    if (!claim || claim.conversationId !== ROOT_CONVERSATION_ID || claim.id <= start.id || sent?.state !== "sent" || !positive(Number(sent.platformMessageId)) || !isDeepStrictEqual(claim.data, { key: saved.key, display: saved.admission, messageId: sent.platformMessageId, text: state.text })) throw invalid();
    entries.add(claim.id);
  }
  if (state.observation !== undefined) {
    const observation = await tx.entry(EditObservation, state.observation);
    if (!observation || observation.conversationId !== ROOT_CONVERSATION_ID || observation.id <= (state.claim ?? start.id) || !isDeepStrictEqual(observation.data, { key: saved.key, state: state.state })) throw invalid();
    entries.add(observation.id);
  }
  if (state.state === "pending" || state.state === "sending") {
    if (state.observation !== undefined || (state.state === "sending") !== (state.claim !== undefined)) throw invalid();
    if (task.state.status === "terminal") { if (!["failed", "faulted", "orphaned"].includes(task.state.outcome.status)) throw invalid(); return true; }
    if (task.state.status === "completing" || !isDeepStrictEqual(task.state.checkpoint, { phase: state.state === "pending" ? "send" : "verify" })) throw invalid();
  } else {
    if (state.observation === undefined || (state.state !== "canceled") !== (state.claim !== undefined) || task.state.status !== "terminal" && task.state.status !== "completing") throw invalid();
    if (["completed", "aborted"].includes(task.state.outcome.status) && task.state.outcome.result !== null) throw invalid();
  }
  return false;
}

export async function verifyPersonalTelegramDisplays(tx: Tx) {
  const keys = (await tx.doc(PersonalTelegramDisplaysDoc)).keys, tokens = new Set<string>(), tasks = new Set<TaskId>(), entries = new Set<EntryId>(), interrupted: PersonalTelegramDisplay[] = [];
  if (!Array.isArray(keys) || new Set(keys).size !== keys.length) throw invalid();
  for (const key of keys) {
    const saved = await display(tx, key), admission = await tx.entry(PersonalTelegramDisplayAdmission, saved.admission), { admission: _admission, edit: _edit, ...fixed } = saved;
    if (saved.v !== 1 || !admission || admission.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(admission.data, fixed) || !positive(saved.origin) || saved.origin >= saved.admission || !await tx.entry(saved.origin) || entries.has(admission.id) || saved.source.platform !== undefined || typeof saved.text !== "string" || !saved.text || !positive(saved.messageId) || !Array.isArray(saved.buttons) || new Set(saved.buttons.map(button => button.action)).size !== saved.buttons.length) throw invalid();
    entries.add(admission.id);
    const delivery = await personalImDeliveryRecord(tx, saved.delivery);
    if (delivery.ref.key !== key || delivery.admission <= saved.origin || delivery.admission >= saved.admission || !samePersonalEntry(delivery.input.source, saved.source) || delivery.input.text !== saved.text || delivery.input.messageId !== saved.messageId || !isDeepStrictEqual(delivery.input.keyboard, saved.buttons.length ? saved.buttons.map(button => [{ text: button.text, callback_data: button.token }]) : undefined)) throw invalid();
    if (saved.target) {
      if (!positive(saved.target.admission) || !positive(saved.target.operation) || !positive(saved.target.occurrence) || !selectionMatches(saved.selection, saved.target) || saved.binding === undefined) throw invalid();
      if (saved.target.family === "questions") {
        const current = await personalQuestion(tx, String(saved.target.operation));
        if (current.admission !== saved.target.admission || current.admission !== saved.target.occurrence || !samePersonalEntry(current.origin.telegram, saved.source) || !isDeepStrictEqual(saved.binding, json({ admission: current.admission, origin: current.origin, generation: current.generation })) || !questionDraftValid(current, saved.selection)) throw invalid();
      } else {
        const current = await personalDesktopTarget(tx, saved.target.family, saved.target.operation, saved.source);
        if (current.summary.admission !== saved.target.admission || !current.occurrences.includes(saved.target.occurrence) || !samePersonalEntry(current.origin.telegram, saved.source) || !isDeepStrictEqual(current.binding, saved.binding)) throw invalid();
      }
    } else if (saved.binding !== undefined || saved.continuation !== undefined) throw invalid();
    if (saved.redisplay) { const original = await display(tx, saved.redisplay.display); if (original.admission >= saved.origin || !samePersonalEntry(original.source, saved.source) || original.text !== saved.text || !isDeepStrictEqual(original.selection, saved.selection) || !isDeepStrictEqual(original.target, saved.target) || !isDeepStrictEqual(original.binding, saved.binding)) throw invalid(); }
    if (key.startsWith("telegram-display:receipt:")) { const receipt = (await tx.doc(PersonalTelegramReceiptDoc, key.slice("telegram-display:receipt:".length), null)).receipt; if (!receipt?.control || receipt.accepted !== saved.origin || !samePersonalEntry(receipt, saved.source) || receipt.messageId !== saved.messageId || receipt.reply !== saved.text || !isDeepStrictEqual(receipt.redisplay, saved.redisplay) || !saved.redisplay && !isDeepStrictEqual(receipt.selection, saved.selection)) throw invalid(); }
    for (const button of saved.buttons) { const token = await tx.doc(PersonalTelegramTokenDoc, button.token, null); if (tokens.has(button.token) || !/^[A-Za-z0-9_-]{32}$/.test(button.token) || token.display !== key || token.action !== button.action) throw invalid(); tokens.add(button.token); }
    if (saved.edit) {
      const task = await tx.task(saved.edit.taskId);
      if (!task || tasks.has(task.id)) throw invalid();
      if (await verifyDisplayEdit(tx, saved, delivery, task, entries)) interrupted.push(saved);
      tasks.add(task.id);
    }
  }
  let cursor: Cursor | undefined;
  do { const page = await tx.scanTasks({ kind: TASK }, 256, cursor); if (page.items.some(task => !tasks.has(task.id))) throw invalid(); cursor = page.next; } while (cursor);
  do { const page = await tx.scanConversations({}, 256, cursor); for (const conversation of page.items) { let entryCursor: Cursor | undefined; do { const page = await tx.scanEntries({ conversationId: conversation.id }, 256, entryCursor); if (page.items.some(entry => [PersonalTelegramDisplayAdmission.kind, EditAdmission.kind, EditClaim.kind, EditObservation.kind].includes(entry.kind) && !entries.has(entry.id))) throw invalid(); entryCursor = page.next; } while (entryCursor); } cursor = page.next; } while (cursor);
  for (const saved of interrupted) await observeEdit(tx, saved, saved.edit!.state === "sending" ? "effect_unknown" : "canceled");
}
