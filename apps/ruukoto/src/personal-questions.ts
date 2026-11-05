import { personalQuestionLastPage } from "./personal-question-controls.ts";
import { personalSource } from "./personal-source.ts";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { AgentDoc, AssistantEntry, defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, defineTool, hook, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, ToolTask, type ConversationId, type Cursor, type EntryId, type Harness, type SubmissionId, type TaskId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { OwnerQuestionError, parseOwnerAnswers, parseOwnerQuestions, type OwnerAnswer, type OwnerQuestionItem } from "@ruukoto/core/owner-question-input.ts";
import { PersonalError } from "./personal-error.ts";
import { capturePersonalToolInstructions, personalToolOrigin, verifyPersonalToolInstructions, type PersonalToolOrigin } from "./personal-tool-source.ts";
import { personalPermissionFor, telegramSelection, telegramSourceActive, type PersonalTelegramSource } from "./personal-permissions.ts";
import { personalEntryConfig, PersonalTelegramDoc, PersonalTelegramReceiptDoc, samePersonalEntry, type PersonalEntryIdentity, type TelegramControlInput } from "./personal-telegram-records.ts";
import { personalTelegramApi } from "./personal-telegram-api.ts";
import { telegramToken } from "./personal-telegram-config.ts";
import { PersonalImApiError, withPersonalImEntry, type PersonalImAccess, type PersonalImSender } from "./personal-im-api.ts";
import { personalUnparkMode, type PersonalMainAdmission } from "./personal-coordination.ts";
import { PersonalAgentsDoc, PersonalWorkDoc, type PersonalToolInstructions, type PersonalWorkRef } from "./personal-work.ts";
import type { Context } from "@earendil-works/chord/context";

export type PersonalOwnerAnswer = { [K in keyof OwnerAnswer]: OwnerAnswer[K] };
export type PersonalQuestionItem = { [K in keyof OwnerQuestionItem]: OwnerQuestionItem[K] };

export const PERSONAL_QUESTIONS = "personal-questions";
export const PERSONAL_QUESTION_INPUT = "ruukoto.question-answer";
const context = BACKGROUND_CONTEXT;
type Identity = { kind: "local" } | { kind: "im"; requestId: string; menuRequestId: string };
export type PersonalQuestionActor = { kind: "local" } | { kind: "im"; input: TelegramControlInput; menuRequestId: string };
type Delivery = "waiting" | "returned" | "local" | "pending" | "sending" | "sent" | "failed" | "effect_unknown" | "canceled" | "unanswered";
export type PersonalQuestion = { id: string; operation: TaskId; generation: TaskId; admission: EntryId; origin: PersonalToolOrigin; work?: { version: 1; ref: PersonalWorkRef; instructions: PersonalToolInstructions }; questions: PersonalQuestionItem[]; version: number; status: "pending" | "answered" | "canceled" | "stale"; terminal?: EntryId; answer?: { requestId: string; answers: PersonalOwnerAnswer[]; actor: Identity; permission: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; admission: EntryId; taskId: TaskId; content: string; submissionId?: SubmissionId; answerEntry?: EntryId; returned?: EntryId; canceled?: EntryId; delivery: Delivery; reply?: string; platformMessageId?: string; configurationVersion?: string } };
export type PersonalQuestionReceipt = { requestId: string; question: string; version: number; operation: "answer" | "cancel"; answers?: PersonalOwnerAnswer[]; actor: Identity; entry: EntryId; taskId?: TaskId };
export const PersonalQuestionsDoc = defineDoc<{ ids: string[] }>({ kind: "ruukoto.questions", scope: "session", version: 1, initial: () => ({ ids: [] }) });
export const PersonalQuestionDoc = defineDocFamily<{ question?: PersonalQuestion }, null>({ kind: "ruukoto.question", scope: "session", version: 1, family: true, initial: () => ({}) });
export const PersonalQuestionReceiptDoc = defineDocFamily<{ receipt?: PersonalQuestionReceipt }, null>({ kind: "ruukoto.question-receipt", scope: "session", version: 1, family: true, initial: () => ({}) });
const QuestionAdmission = defineEntry<{ id: string; operation: TaskId; generation: TaskId; origin: PersonalToolOrigin; work?: NonNullable<PersonalQuestion["work"]>; questions: PersonalQuestionItem[] }>("ruukoto.question-admission");
const AnswerAdmission = defineEntry<{ question: string; requestId: string; version: number; answers: PersonalOwnerAnswer[]; actor: Identity; permission: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; taskId: TaskId; content: string; work?: PersonalWorkRef }>("ruukoto.question-answer-admission");
const QuestionTerminal = defineEntry<{ question: string; status: "canceled" | "stale"; requestId?: string; version: number; actor?: Identity }>("ruukoto.question-terminal");
const WorkQuestionReturn = defineEntry<{ question: string; operation: TaskId; admission: EntryId; answer: EntryId }>("ruukoto.work-question-return");
const WorkQuestionCanceled = defineEntry<{ question: string; work: PersonalWorkRef; answer: EntryId }>("ruukoto.work-question-canceled");
const invalid = () => new PersonalError("question_record_invalid", "问题、答案或续接来源无法核实，已停止操作；请保留档案并查询原问题。");
const keyFor = (task: TaskId) => `personal-question:${task}`;
const inputData = (value: PersonalQuestion) => ({ question: value.id, admission: value.answer!.admission, taskId: value.answer!.taskId });
const actorIdentity = (actor: PersonalQuestionActor): Identity => actor.kind === "local" ? { kind: "local" } : { kind: "im", requestId: actor.input.requestId, menuRequestId: actor.menuRequestId };
const platformText = (text: string) => Array.from(text).length > 3900 ? Array.from(text).slice(0, 3900).join("") + "…（完整回答保留在个人会话）" : text || "本次回答没有文本，请从本机查询会话。";
function parsed<T>(read: () => T): T { try { return read(); } catch (error) { if (!(error instanceof OwnerQuestionError)) throw error; throw new PersonalError("question_input_invalid", error.message, { cause: error }); } }

export async function personalQuestion(tx: Tx, id: string) { const value = (await tx.doc(PersonalQuestionDoc, id, null)).question; if (!value || value.id !== id) throw new PersonalError("question_missing", "找不到原问题，请刷新问题列表。"); return value; }
async function workQuestionActive(tx: Tx, value: PersonalQuestion) {
  if (!value.work) return true;
  const ref = value.work.ref, work = await tx.doc(PersonalWorkDoc, ref.requestId, null), task = await tx.task(ref.taskId), tool = await tx.task(value.operation);
  const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === ref.agentId);
  return isDeepStrictEqual(work.ref, ref) && !work.cancelRequested && task !== undefined && !task.abortRequested && task.state.status !== "terminal" && task.state.status !== "completing" && !agent?.closed && isDeepStrictEqual(agent?.work, ref) && tool !== undefined && !tool.abortRequested && tool.state.status !== "terminal";
}
async function staleQuestion(tx: Tx, value: PersonalQuestion) {
  value.status = "stale"; value.version++;
  value.terminal = (await tx.appendEntry(QuestionTerminal, ROOT_CONVERSATION_ID, { data: { question: value.id, status: "stale", version: value.version } })).id;
}
async function cancelWorkAnswer(tx: Tx, value: PersonalQuestion, completed = false) {
  const answer = value.answer;
  if (!value.work || !answer || answer.canceled || !["waiting", "returned"].includes(answer.delivery)) return;
  if (completed) return;
  answer.canceled = (await tx.appendEntry(WorkQuestionCanceled, ROOT_CONVERSATION_ID, { data: { question: value.id, work: value.work.ref, answer: answer.admission } })).id;
  answer.delivery = "canceled";
}
export async function cancelPersonalWorkQuestions(tx: Tx, ref: PersonalWorkRef) {
  const values = [];
  for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) {
    const value = await personalQuestion(tx, id);
    if (!value.work || !isDeepStrictEqual(value.work.ref, ref)) continue;
    const tool = await tx.task(value.operation);
    values.push({ value, completed: tool?.state.status === "terminal" && tool.state.outcome.status === "completed" });
  }
  for (const { value, completed } of values) if (value.status === "pending") await staleQuestion(tx, value); else if (value.status === "answered") await cancelWorkAnswer(tx, value, completed);
}
export async function refreshPersonalQuestions(tx: Tx) {
  const values = [];
  for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) {
    const value = await personalQuestion(tx, id), task = await tx.task(value.generation), submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, value.origin.source.requestId);
    const inactive = value.origin.telegram && !await telegramSourceActive(tx, value.origin.telegram) || submission?.status === "unanswered" || task?.abortRequested || task?.state.status === "terminal" && task.state.outcome.status === "aborted" || !await workQuestionActive(tx, value);
    const tool = value.work && await tx.task(value.operation);
    values.push({ value, inactive, completed: tool && tool.state.status === "terminal" && tool.state.outcome.status === "completed" });
  }
  for (const { value, inactive, completed } of values) if (value.status === "pending" && inactive) await staleQuestion(tx, value); else if (value.work && value.status === "answered" && inactive) await cancelWorkAnswer(tx, value, !!completed);
}
export function personalQuestionActions(value: Pick<PersonalQuestion, "status" | "origin">, actor?: PersonalEntryIdentity) {
  return { canAnswer: value.status === "pending" && (!value.origin.telegram || !!actor && samePersonalEntry(value.origin.telegram, actor)), canCancel: value.status === "pending" };
}
export async function personalQuestionList(tx: Tx, offset = 0, actor?: TelegramControlInput) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new PersonalError("question_input_invalid", "请从原问题菜单翻页。");
  await refreshPersonalQuestions(tx);
  const values = await Promise.all((await tx.doc(PersonalQuestionsDoc)).ids.slice().reverse().map(id => personalQuestion(tx, id)));
  const items = values.filter(value => !actor || samePersonalEntry(value.origin.telegram, actor)).sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  return { items: items.slice(offset, offset + 8).map(value => ({ id: value.id, version: value.version, status: value.status, ...personalQuestionActions(value, actor), question: Array.from(value.questions[0].question).slice(0, 140).join("") + (Array.from(value.questions[0].question).length > 140 ? "…（选择后完整查看）" : "") })), ...(offset + 8 < items.length ? { nextOffset: offset + 8 } : {}) };
}
export async function personalWorkQuestionFacts(tx: Tx, taskId: TaskId, actor?: PersonalEntryIdentity) {
  const values = [];
  for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) { const value = await personalQuestion(tx, id); if (value.work?.ref.taskId === taskId) values.push(value); }
  return values.reverse().map(value => ({ id: value.id, admission: value.admission, version: value.version, status: value.status, question: Array.from(value.questions[0].question).slice(0, 140).join(""), ...personalQuestionActions(value, actor), ...(value.answer ? { answer: value.answer.delivery } : {}) }));
}
export async function personalQuestionDetail(tx: Tx, id: string) { await refreshPersonalQuestions(tx); return copyJson(await personalQuestion(tx, id)) as PersonalQuestion; }
export async function personalQuestionReceipt(tx: Tx, requestId: string) { const value = (await tx.doc(PersonalQuestionReceiptDoc, requestId, null)).receipt; return value && copyJson(value) as PersonalQuestionReceipt; }
export function personalQuestionInput(questions: PersonalQuestionItem[], answers: PersonalOwnerAnswer[]) { return `拥有者对原问题的回答（业务澄清，不是操作批准）：\n${JSON.stringify(questions.map((question, index) => ({ ...question, answer: answers[index] })))}`; }

async function allowedActor(tx: Tx, value: PersonalQuestion, actor: PersonalQuestionActor, operation: "answer" | "cancel") {
  if (actor.kind === "local") {
    if (operation === "answer" && !personalQuestionActions(value).canAnswer) throw new PersonalError("question_original_entry_required", "请从原平台的当前私聊问题菜单回答；本机可查询或取消旧问题。");
    return;
  }
  const menu = await telegramSelection(tx, actor.input);
  if (!actor.input.direct || !samePersonalEntry(value.origin.telegram, actor.input) || !await telegramSourceActive(tx, actor.input) || menu?.requestId !== actor.menuRequestId || menu.selection?.kind !== "question-draft" || menu.selection.id !== value.id || menu.selection.version !== value.version || operation === "answer" && (menu.selection.step !== value.questions.length || (menu.selection.page ?? 0) !== personalQuestionLastPage(value, menu.selection))) throw new PersonalError("question_original_entry_required", "请回复原平台、账号与当前私聊已送达的问题核对菜单；没有改变原问题。");
}
export async function answerPersonalQuestion(tx: Tx, input: { question: string; version: number; requestId: string; answers: PersonalOwnerAnswer[] }, actor: PersonalQuestionActor) {
  const prior = await personalQuestionReceipt(tx, input.requestId), identity = actorIdentity(actor);
  const value = await personalQuestion(tx, input.question), answers = parsed(() => parseOwnerAnswers(input.answers, value.questions));
  if (prior) { if (!isDeepStrictEqual({ ...prior, entry: undefined, taskId: undefined }, { requestId: input.requestId, question: input.question, version: input.version, operation: "answer", answers, actor: identity, entry: undefined, taskId: undefined })) throw new PersonalError("question_request_conflict", "原请求与本次答案不同，请查询原回执；未新建续接。"); return copyJson(prior) as PersonalQuestionReceipt; }
  if (value.status !== "pending" || value.version !== input.version) throw new PersonalError("question_not_pending", "问题已回答、取消或失效，请刷新原问题；未新建续接。");
  await allowedActor(tx, value, actor, "answer");
  if (actor.kind === "im") { const menu = (await telegramSelection(tx, actor.input))?.selection; if (menu?.kind !== "question-draft" || !isDeepStrictEqual(menu.answers, answers)) throw new PersonalError("question_input_invalid", "答案与原核对菜单不同，请回复原菜单重新核对。"); }
  if (value.work) await personalSource(tx, value.origin.source.requestId, { active: true });
  const permission = value.work ? value.origin.permission : await personalPermissionFor(tx, actor.kind === "im" ? actor.input : undefined);
  const telegram = value.work ? value.origin.telegram : actor.kind === "im" ? { ...(actor.input.platform ? { platform: actor.input.platform } : {}), botId: actor.input.botId, ownerId: actor.input.ownerId, generation: actor.input.generation, mode: permission.mode, version: permission.version } : undefined;
  const content = personalQuestionInput(value.questions, answers);
  await refreshPersonalQuestions(tx);
  if (value.status !== "pending" || value.version !== input.version) throw new PersonalError("question_not_pending", "问题已回答、取消或失效，请刷新原问题；未新建续接。");
  const taskId = value.work ? value.operation : await tx.createTask(PersonalQuestionTask, { question: value.id, requestId: input.requestId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
  const data = { question: value.id, requestId: input.requestId, version: input.version, answers, actor: identity, permission: { mode: permission.mode, version: permission.version }, ...(telegram ? { telegram } : {}), taskId, content, ...(value.work ? { work: value.work.ref } : {}) };
  const entry = (await tx.appendEntry(AnswerAdmission, ROOT_CONVERSATION_ID, { data })).id;
  value.status = "answered"; value.version++;
  value.answer = { ...data, admission: entry, delivery: "waiting" };
  const receipt: PersonalQuestionReceipt = { requestId: input.requestId, question: value.id, version: input.version, operation: "answer", answers, actor: identity, entry, taskId };
  (await tx.doc(PersonalQuestionReceiptDoc, input.requestId, null)).receipt = receipt;
  return copyJson(receipt) as PersonalQuestionReceipt;
}
export async function cancelPersonalQuestion(tx: Tx, input: { question: string; version: number; requestId: string }, actor: PersonalQuestionActor) {
  const identity = actorIdentity(actor), prior = await personalQuestionReceipt(tx, input.requestId);
  if (prior) { if (prior.operation !== "cancel" || prior.question !== input.question || prior.version !== input.version || !isDeepStrictEqual(prior.actor, identity)) throw new PersonalError("question_request_conflict", "原取消请求内容不同，请查询原回执。"); return copyJson(prior) as PersonalQuestionReceipt; }
  const value = await personalQuestion(tx, input.question);
  if (value.status !== "pending" || value.version !== input.version) throw new PersonalError("question_not_pending", "问题已处理，请刷新原问题；没有改变答案。");
  await allowedActor(tx, value, actor, "cancel");
  await refreshPersonalQuestions(tx);
  if (value.status !== "pending" || value.version !== input.version) throw new PersonalError("question_not_pending", "问题已处理，请刷新原问题；没有改变答案。");
  value.status = "canceled"; value.version++;
  const entry = (await tx.appendEntry(QuestionTerminal, ROOT_CONVERSATION_ID, { data: { question: value.id, status: "canceled", requestId: input.requestId, version: value.version, actor: identity } })).id;
  value.terminal = entry;
  const receipt: PersonalQuestionReceipt = { ...input, operation: "cancel", actor: identity, entry };
  (await tx.doc(PersonalQuestionReceiptDoc, input.requestId, null)).receipt = receipt;
  return copyJson(receipt) as PersonalQuestionReceipt;
}

export async function personalQuestionSubmission(tx: Tx, value: PersonalQuestion) {
  if (!value.answer || value.work) return;
  const answer = value.answer, submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, keyFor(answer.taskId));
  if (!submission) { if (answer.submissionId !== undefined || answer.answerEntry !== undefined) throw invalid(); return; }
  if (submission.type !== "input" || answer.submissionId !== undefined && answer.submissionId !== submission.id || answer.answerEntry !== undefined && (submission.status !== "done" || submission.answer !== answer.answerEntry)) throw invalid();
  if (submission.entry) {
    const entry = await tx.entry(submission.entry);
    if (entry?.kind !== PERSONAL_QUESTION_INPUT || entry.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(entry.data, inputData(value)) || !entry.model?.some(message => message.role === "user" && message.content === answer.content)) throw invalid();
  } else if (submission.status === "queued") {
    const queued = (await tx.doc(InboxDoc, ROOT_CONVERSATION_ID)).items.find(item => item.id === submission.id);
    if (!queued || queued.mode === "write" || personalUnparkMode(queued.mode) !== "followUp" || queued.content !== answer.content || !isDeepStrictEqual(queued.entry, { kind: PERSONAL_QUESTION_INPUT, data: inputData(value) })) throw invalid();
  }
  return submission;
}
export async function personalQuestionSource(tx: Tx, requestId: string, active = false) {
  if (!requestId.startsWith("personal-question:")) return;
  const suffix = requestId.slice("personal-question:".length);
  if (!/^[1-9][0-9]*$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) throw invalid();
  const task = await tx.task(Number(suffix) as TaskId);
  const input = task?.input;
  if (!task || !input || typeof input !== "object" || Array.isArray(input) || typeof input.question !== "string") throw invalid();
  const value = await personalQuestion(tx, input.question), answer = value.answer;
  const submission = await personalQuestionSubmission(tx, value), entry = submission?.entry && await tx.entry(submission.entry);
  if (!answer || answer.taskId !== task.id || value.status !== "answered" || !submission || !entry || active && (!(["placed", "done"].includes(submission.status)) || answer.telegram && !await telegramSourceActive(tx, answer.telegram))) throw invalid();
  await verifyQuestionAnswer(tx, value);
  return { submission, entry, accepted: answer.admission, ...(answer.actor.kind === "im" ? { receiptRequestId: answer.actor.requestId } : {}), source: { requestId, submissionId: submission.id, entryId: entry.id }, permission: { ...answer.permission }, ...(answer.telegram ? { telegram: { ...answer.telegram } } : {}) };
}
async function verifyQuestionAnswer(tx: Tx, value: PersonalQuestion) {
  if (value.work) return verifyWorkQuestionAnswer(tx, value);
  const answer = value.answer;
  if (!answer) throw invalid();
  const admission = await tx.entry(AnswerAdmission, answer.admission), task = await tx.task(answer.taskId), receipt = await personalQuestionReceipt(tx, answer.requestId);
  const data = { question: value.id, requestId: answer.requestId, version: 1, answers: answer.answers, actor: answer.actor, permission: answer.permission, ...(answer.telegram ? { telegram: answer.telegram } : {}), taskId: answer.taskId, content: answer.content };
  if (!admission || admission.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(admission.data, data) || !isDeepStrictEqual(parsed(() => parseOwnerAnswers(answer.answers, value.questions)), answer.answers) || answer.content !== personalQuestionInput(value.questions, answer.answers) || task?.kind !== "ruukoto.question-continuation" || task.version !== 1 || task.owner !== undefined || !task.background || task.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(task.input, { question: value.id, requestId: answer.requestId }) || !receipt || receipt.entry !== answer.admission || receipt.taskId !== answer.taskId || receipt.operation !== "answer" || receipt.question !== value.id || receipt.version !== 1 || !isDeepStrictEqual(receipt.answers, answer.answers) || !isDeepStrictEqual(receipt.actor, answer.actor)) throw invalid();
  if (!["waiting", "local", "pending", "sending", "sent", "failed", "effect_unknown", "canceled", "unanswered"].includes(answer.delivery)) throw invalid();
  if (answer.answerEntry !== undefined) { const entry = await tx.entry(AssistantEntry, answer.answerEntry), message = entry?.model?.[0]; if (entry?.conversationId !== ROOT_CONVERSATION_ID || message?.role !== "assistant" || answer.reply !== platformText(message.content.filter(part => part.type === "text").map(part => part.text).join(""))) throw invalid(); }
  else if (answer.reply !== undefined || ["local", "pending", "sending", "sent", "failed", "effect_unknown"].includes(answer.delivery)) throw invalid();
  if (answer.actor.kind === "im") {
    const actor = (await tx.doc(PersonalTelegramReceiptDoc, answer.actor.requestId, null)).receipt;
    const menu = actor && await telegramSelection(tx, actor);
    if (!actor?.control || !actor.direct || !samePersonalEntry(value.origin.telegram, actor) || !samePersonalEntry(answer.telegram, actor) || menu?.requestId !== answer.actor.menuRequestId || menu.selection?.kind !== "question-draft" || menu.selection.id !== value.id || menu.selection.version !== 1 || menu.selection.step !== value.questions.length || (menu.selection.page ?? 0) !== personalQuestionLastPage(value, menu.selection) || !isDeepStrictEqual(menu.selection.answers, answer.answers) || actor.questionAnswer?.requestId !== answer.requestId || actor.questionAnswer.question !== value.id || !isDeepStrictEqual(answer.permission, answer.telegram && { mode: answer.telegram.mode, version: answer.telegram.version })) throw invalid();
  } else if (answer.telegram || value.origin.telegram) throw invalid();
}

function workQuestionAnswer(value: PersonalQuestion) {
  return { status: "answered", questions: value.questions, answers: value.answer!.answers, message: "业务澄清不是操作批准；按实际答案和已保存的新要求继续同一工作，不重复已完成效果。" };
}
function workQuestionOutput(value: PersonalQuestion) {
  return value.answer?.delivery === "returned" ? workQuestionAnswer(value) : { status: value.status === "answered" ? "canceled" : value.status, message: "原问题未获可用答案；请读取已保存的新要求，停止依赖缺失信息的操作并报告。" };
}
async function verifyWorkQuestionResult(tx: Tx, value: PersonalQuestion) {
  const task = await tx.task(value.operation);
  if (task?.state.status !== "terminal" || task.state.outcome.status !== "completed") return;
  const result = task.state.outcome.result, entry = result && typeof result === "object" && !Array.isArray(result) && typeof result.entryId === "number" ? await tx.entry(result.entryId as EntryId) : undefined, message = entry?.model?.[0];
  const text = message?.role === "toolResult" ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : undefined;
  const answered = value.answer?.returned && value.answer.canceled ? JSON.stringify(workQuestionAnswer(value)) : undefined;
  if (!entry || entry.conversationId !== value.origin.conversationId || entry.byTaskId !== value.operation || message?.role !== "toolResult" || message.toolName !== "ask_user" || message.isError || text !== JSON.stringify(workQuestionOutput(value)) && text !== answered || value.status === "pending" || value.answer?.delivery === "waiting") throw invalid();
}
async function verifyWorkQuestionAnswer(tx: Tx, value: PersonalQuestion) {
  const answer = value.answer, work = value.work;
  if (!answer || !work) throw invalid();
  const admission = await tx.entry(AnswerAdmission, answer.admission), receipt = await personalQuestionReceipt(tx, answer.requestId);
  const data = { question: value.id, requestId: answer.requestId, version: 1, answers: answer.answers, actor: answer.actor, permission: answer.permission, ...(answer.telegram ? { telegram: answer.telegram } : {}), taskId: answer.taskId, content: answer.content, work: work.ref };
  if (answer.taskId !== value.operation || !admission || admission.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(admission.data, data) || !isDeepStrictEqual(answer.permission, value.origin.permission) || !isDeepStrictEqual(answer.telegram, value.origin.telegram) || !isDeepStrictEqual(parsed(() => parseOwnerAnswers(answer.answers, value.questions)), answer.answers) || answer.content !== personalQuestionInput(value.questions, answer.answers) || !receipt || receipt.entry !== answer.admission || receipt.taskId !== value.operation || receipt.operation !== "answer" || receipt.question !== value.id || receipt.version !== 1 || !isDeepStrictEqual(receipt.answers, answer.answers) || !isDeepStrictEqual(receipt.actor, answer.actor) || !["waiting", "returned", "canceled", "unanswered"].includes(answer.delivery) || answer.submissionId !== undefined || answer.answerEntry !== undefined || answer.reply !== undefined || answer.platformMessageId !== undefined || answer.configurationVersion !== undefined) throw invalid();
  if (answer.actor.kind === "im") {
    const actor = (await tx.doc(PersonalTelegramReceiptDoc, answer.actor.requestId, null)).receipt, menu = actor && await telegramSelection(tx, actor);
    if (!actor?.control || !actor.direct || !samePersonalEntry(value.origin.telegram, actor) || menu?.requestId !== answer.actor.menuRequestId || menu.selection?.kind !== "question-draft" || menu.selection.id !== value.id || menu.selection.version !== 1 || menu.selection.step !== value.questions.length || (menu.selection.page ?? 0) !== personalQuestionLastPage(value, menu.selection) || !isDeepStrictEqual(menu.selection.answers, answer.answers) || actor.questionAnswer?.requestId !== answer.requestId || actor.questionAnswer.question !== value.id) throw invalid();
  } else if (value.origin.telegram) throw invalid();
  if (answer.returned !== undefined) {
    const returned = await tx.entry(WorkQuestionReturn, answer.returned);
    if (!returned || returned.conversationId !== value.origin.conversationId || returned.id <= answer.admission || !isDeepStrictEqual(returned.data, { question: value.id, operation: value.operation, admission: value.admission, answer: answer.admission })) throw invalid();
  } else if (answer.delivery === "returned") throw invalid();
  if (answer.canceled !== undefined) {
    const canceled = await tx.entry(WorkQuestionCanceled, answer.canceled);
    if (!canceled || canceled.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(canceled.data, { question: value.id, work: work.ref, answer: answer.admission }) || answer.delivery !== "canceled") throw invalid();
  } else if (answer.delivery === "canceled") throw invalid();
  await verifyWorkQuestionResult(tx, value);
}

// Note: See .agents/notes/implemented/feature/2026-11-05-personal-work-questions.md
async function waitWorkQuestion(api: ToolExecutionApi, id: string, callContext: Context, im?: PersonalImAccess) {
  const watch = await api.watchDoc(PersonalQuestionDoc, id, callContext);
  if (!watch?.value?.question?.work) throw invalid();
  const workWatch = await api.watchDoc(PersonalWorkDoc, watch.value.question.work.ref.requestId, callContext), entryWatch = watch.value.question.origin.telegram ? await api.watchDoc(PersonalTelegramDoc, callContext) : undefined;
  if (!workWatch) throw invalid();
  try {
    await new Promise<void>((resolve, reject) => {
      const check = async () => {
        try {
          const ready = await api.commit(async tx => { await refreshPersonalQuestions(tx); return (await personalQuestion(tx, id)).status !== "pending"; }, callContext);
          if (ready) resolve();
        } catch (error) { reject(error); }
      };
      for (const value of [watch, workWatch, entryWatch]) if (value) { value.start(async () => check()); void value.closed.then(() => reject(new PersonalError("question_wait_stopped", "原问题等待已停止，请查询原工作；不能用普通消息替代答案。"))); }
      void check();
    });
    const saved = await api.commit(async tx => {
      const value = await personalQuestion(tx, id);
      if (!value.work || value.operation !== api.taskId || value.origin.conversationId !== api.conversationId) throw invalid();
      if (value.status === "answered" && value.answer?.delivery !== "canceled") {
        await verifyWorkQuestionAnswer(tx, value);
        if (!await workQuestionActive(tx, value)) { await cancelWorkAnswer(tx, value); return copyJson(value) as PersonalQuestion; }
        await personalSource(tx, value.origin.source.requestId, { active: true });
        if (value.origin.telegram && im && !im.isActive(value.origin.telegram)) { await cancelWorkAnswer(tx, value); return copyJson(value) as PersonalQuestion; }
        if (!value.answer!.returned) value.answer!.returned = (await tx.appendEntry(WorkQuestionReturn, api.conversationId, { data: { question: value.id, operation: value.operation, admission: value.admission, answer: value.answer!.admission } })).id;
        value.answer!.delivery = "returned";
      }
      return copyJson(value) as PersonalQuestion;
    }, callContext);
    return { output: [{ type: "text" as const, text: JSON.stringify(workQuestionOutput(saved)) }] };
  } finally { await watch.stop(); await workWatch.stop(); await entryWatch?.stop(); }
}

export async function requirePersonalQuestionBoundary(tx: Tx, conversationId: ConversationId, generation: TaskId, excludeOperation?: TaskId) {
  if (conversationId === ROOT_CONVERSATION_ID) return;
  for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) {
    const value = await personalQuestion(tx, id);
    if (value.work && value.origin.conversationId === conversationId && value.generation === generation && value.operation !== excludeOperation) throw new PersonalError("question_boundary_wait", "本批已提出业务问题，这项旧操作未执行；收到实际答案并在下一模型请求读到后，再准备新操作。");
  }
}

function questionTask(im?: PersonalImAccess, admitInput?: PersonalMainAdmission) { return defineTask<{ question: string; requestId: string }, { phase: "admit" } | { phase: "send"; retryAt?: number } | { phase: "verify" }, { delivery: Delivery }>({
  name: "ruukoto.question-continuation", version: 1, initial: () => ({ phase: "admit" }),
  phases: {
    async admit(current, runtime, callContext) {
      let proceed = true;
      await runtime.commit(async tx => { const value = await personalQuestion(tx, current.input.question); await verifyQuestionAnswer(tx, value); if (!await personalQuestionSubmission(tx, value) && value.answer!.telegram && (!await telegramSourceActive(tx, value.answer!.telegram!) || im && !im.isActive(value.answer!.telegram!))) { value.answer!.delivery = "canceled"; proceed = false; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; } return undefined; }, callContext);
      if (!proceed) return;
      const saved = (await runtime.snapshot(PersonalQuestionDoc, current.input.question, callContext))!.question!;
      const main = await runtime.conversation(ROOT_CONVERSATION_ID, callContext);
      if (!main) throw invalid();
      const submission = await withPersonalImEntry(im, saved.answer!.telegram ?? {}, async () => {
        let permitted = true;
        await runtime.commit(async tx => { const value = await personalQuestion(tx, saved.id); await verifyQuestionAnswer(tx, value); if (!await personalQuestionSubmission(tx, value) && value.answer!.telegram && (!await telegramSourceActive(tx, value.answer!.telegram!) || im && !im.isActive(value.answer!.telegram!))) { value.answer!.delivery = "canceled"; permitted = false; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; } return undefined; }, callContext);
        if (!permitted) return;
        const submission = await (admitInput ?? main.submit.bind(main))({ type: "input", requestId: keyFor(current.id), content: saved.answer!.content, entry: { kind: PERSONAL_QUESTION_INPUT, data: inputData(saved) }, whenBusy: "followUp" }, callContext);
        await runtime.commit(async tx => { const value = await personalQuestion(tx, saved.id); await personalQuestionSubmission(tx, value); value.answer!.submissionId = submission.id; return undefined; }, callContext);
        return submission;
      });
      if (!submission) return;
      const settled = await submission.wait(callContext);
      await runtime.commit(async tx => {
        const value = await personalQuestion(tx, saved.id), answer = value.answer!;
        if (settled.status !== "done" || settled.type !== "input") { answer.delivery = "unanswered"; return { status: "terminal", outcome: { status: "completed", result: { delivery: answer.delivery } } }; }
        const entry = await tx.entry(AssistantEntry, settled.answer), message = entry?.model?.[0];
        if (message?.role !== "assistant") throw invalid();
        answer.answerEntry = settled.answer; answer.reply = platformText(message.content.filter(part => part.type === "text").map(part => part.text).join(""));
        answer.delivery = answer.telegram ? "pending" : "local";
        return answer.telegram ? { status: "running", checkpoint: { phase: "send" } } : { status: "terminal", outcome: { status: "completed", result: { delivery: "local" } } };
      }, callContext);
    },
    async send(current, runtime, callContext) {
      if (current.state.checkpoint.retryAt) await runtime.sleep(current.state.checkpoint.retryAt, callContext);
      const saved = (await runtime.snapshot(PersonalQuestionDoc, current.input.question, callContext))!.question!, answer = saved.answer!, state = await runtime.snapshot(PersonalTelegramDoc, callContext), config = personalEntryConfig(state ?? {}, answer.telegram!);
      let api: PersonalImSender | undefined = !im && state?.config?.enabled ? personalTelegramApi(state.config.apiBase, telegramToken(state.config)) : undefined;
      let target: { owner: string; message: number; reply: string } | undefined;
      await withPersonalImEntry(im, answer.telegram ?? {}, async () => {
      await runtime.commit(async tx => { const value = await personalQuestion(tx, saved.id), answer = value.answer!; if (!answer.telegram || im && !im.isActive(answer.telegram) || !await telegramSourceActive(tx, answer.telegram) || !isDeepStrictEqual(config, personalEntryConfig(await tx.doc(PersonalTelegramDoc), answer.telegram))) { answer.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; } const actor = answer.actor.kind === "im" && (await tx.doc(PersonalTelegramReceiptDoc, answer.actor.requestId, null)).receipt; if (!actor || answer.delivery !== "pending" || !answer.reply) throw invalid(); target = { owner: answer.telegram.ownerId, message: actor.messageId, reply: answer.reply }; answer.delivery = "sending"; const version = im?.configurationVersion(answer.telegram); if (version) answer.configurationVersion = version; return { status: "running", checkpoint: { phase: "verify" } }; }, callContext);
      if (target && im) api = im.sender(answer.telegram!);
      });
      if (!target) return;
      let message: string | undefined, failure: PersonalImApiError | undefined;
      try { if (!api) throw new PersonalImApiError("im_target_inactive", "原问题回复入口已失效，未发送；请查询原问题。", "not_sent"); message = await api.send(target.owner, target.message, target.reply, runtime.signal); } catch (error) { if (!(error instanceof PersonalImApiError)) throw error; failure = error; }
      await runtime.commit(async tx => { const answer = (await personalQuestion(tx, saved.id)).answer!; if (failure?.retryAfterMs) { answer.delivery = "pending"; return { status: "running", checkpoint: { phase: "send", retryAt: runtime.now() + failure.retryAfterMs } }; } answer.delivery = message ? "sent" : failure?.effect === "not_sent" ? "failed" : "effect_unknown"; if (message) answer.platformMessageId = message; return { status: "terminal", outcome: { status: "completed", result: { delivery: answer.delivery } } }; }, callContext);
    },
    async verify(current, runtime, callContext) { await runtime.commit(async tx => { const answer = (await personalQuestion(tx, current.input.question)).answer!; answer.delivery = "effect_unknown"; return { status: "terminal", outcome: { status: "completed", result: { delivery: answer.delivery } } }; }, callContext); },
  },
  async abort(current, runtime, callContext) { const saved = (await runtime.snapshot(PersonalQuestionDoc, current.input.question, callContext))!.question!; let admitted = false; await runtime.commit(async tx => { admitted = !!await personalQuestionSubmission(tx, await personalQuestion(tx, saved.id)); return undefined; }, callContext); if (admitted && saved.answer) { const submission = await runtime.conversation(ROOT_CONVERSATION_ID, callContext); const original = submission && await (admitInput ?? submission.submit.bind(submission))({ type: "input", requestId: keyFor(current.id), content: saved.answer.content, entry: { kind: PERSONAL_QUESTION_INPUT, data: inputData(saved) }, whenBusy: "followUp" }, callContext); await original?.abort(callContext); } await runtime.commit(async tx => { const answer = (await personalQuestion(tx, saved.id)).answer!; answer.delivery = answer.delivery === "sending" ? "effect_unknown" : "canceled"; return { status: "terminal", outcome: { status: "aborted", result: { delivery: answer.delivery } } }; }, callContext); },
}); }
export const PersonalQuestionTask = questionTask();

// Note: See .agents/notes/implemented/feature/2026-10-21-personal-owner-questions.md
// Note: See .agents/notes/implemented/feature/2026-11-05-personal-work-questions.md
export async function personalQuestionToolNames(tx: Tx, conversationId: ConversationId, names: readonly string[]) {
  const live = await tx.doc(LiveDoc, conversationId);
  if (conversationId !== ROOT_CONVERSATION_ID) {
    const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === conversationId);
    if (!agent?.work) return names.filter(name => name !== "ask_user");
    for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) {
      const value = await personalQuestion(tx, id);
      if (value.work && value.origin.conversationId === conversationId && value.generation === live.run?.taskId) return names.filter(name => name === "process_status" || name === "process_output");
    }
    return [...names];
  }
  for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) { const value = await personalQuestion(tx, id); if (!value.work && value.origin.inputs.some(input => live.run?.inputs.includes(input))) return names.filter(name => name === "process_status" || name === "process_output"); }
  return [...names];
}
export async function verifyPersonalQuestionRequest(tx: Tx, conversationId: ConversationId) {
  if (conversationId !== ROOT_CONVERSATION_ID) {
    const live = await tx.doc(LiveDoc, conversationId);
    if (live.run) await requirePersonalQuestionBoundary(tx, conversationId, live.run.taskId);
    return;
  }
  const live = await tx.doc(LiveDoc, conversationId);
  for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) { const value = await personalQuestion(tx, id), input = await personalQuestionSubmission(tx, value); if (input && live.run?.inputs.includes(input.id)) await personalQuestionSource(tx, keyFor(value.answer!.taskId), true); }
}
export function personalQuestions(getHarness: () => Harness, im?: PersonalImAccess, admitInput?: PersonalMainAdmission) {
  const ask = defineTool({ name: "ask_user", description: "提出1–3题业务澄清。主会话登记pending后结束本轮，答案作为后续拥有者输入；后台子工作等待原问题的实际答案并从本调用返回，再按答案和已保存的新要求继续同一工作。各工作可独立提问，同一工作只保留一批待答问题。本批其他业务操作不会执行，须等下一模型请求再准备。单选直接选择，多选用完成，多个问题最后核对；有选项仍可自由输入或跳过，推荐不预选。拥有者从桌面、本机问题菜单或原私聊 /问题 回答。普通聊天不构成问题答案，业务回答不批准操作、不扩大原工作权限。", parameters: Type.Object({ questions: Type.Array(Type.Object({ question: Type.String({ minLength: 1, maxLength: 2000 }), options: Type.Optional(Type.Array(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Object({ label: Type.String({ minLength: 1, maxLength: 200 }), description: Type.Optional(Type.String({ maxLength: 500 })), recommended: Type.Optional(Type.Boolean()) }, { additionalProperties: false })]), { minItems: 2, maxItems: 5, description: "选项名互异；省略时自由输入。" })), multiple: Type.Optional(Type.Boolean({ description: "true须有options；省略或false为单选。" })) }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }) }, { additionalProperties: false }), outputLimits: { maxBytes: 256 * 1024, maxLines: 25000 }, replay: "safe", executionMode: "sequential", async execute(input, api, callContext) {
    const questions = parsed(() => parseOwnerQuestions(input.questions));
    const live = await api.snapshot(LiveDoc, api.conversationId, callContext), candidate = live?.run?.inputs.length === 1 ? await getHarness().submission(live.run.inputs[0], callContext) : undefined, sourceRequestId = (await candidate?.status(callContext))?.requestId;
    await api.commit(async tx => {
      const prior = (await tx.doc(PersonalQuestionDoc, String(api.taskId), null)).question;
      if (prior) { if (!isDeepStrictEqual(prior.questions, questions)) throw invalid(); return; }
      if (api.conversationId === ROOT_CONVERSATION_ID && !sourceRequestId) throw new PersonalError("question_source_invalid", "本轮没有唯一拥有者输入，请结束本轮并报告缺少的信息。");
      const instructions = api.conversationId === ROOT_CONVERSATION_ID ? undefined : await capturePersonalToolInstructions(tx, api);
      const origin = await personalToolOrigin(tx, api, api.conversationId === ROOT_CONVERSATION_ID ? sourceRequestId : undefined, instructions ? { snapshot: instructions.snapshot } : undefined);
      if (api.conversationId !== ROOT_CONVERSATION_ID && (!origin.work || !instructions)) throw new PersonalError("question_source_invalid", "本轮没有可核实的原工作，请结束本轮并报告缺少的信息。");
      await refreshPersonalQuestions(tx);
      const doc = await tx.doc(PersonalQuestionsDoc);
      for (const id of doc.ids) { const value = await personalQuestion(tx, id); if (value.status === "pending" && (origin.work ? value.work?.ref.taskId === origin.work.ref.taskId : !value.work)) throw new PersonalError("question_pending", "原工作已有待答问题，请结束本轮；拥有者可从原问题菜单回答或取消。"); }
      const work = origin.work && instructions ? { version: 1 as const, ref: { ...origin.work.ref }, instructions } : undefined;
      const id = String(api.taskId), data = { id, operation: api.taskId, generation: origin.generation, origin, ...(work ? { work } : {}), questions };
      const admission = (await tx.appendEntry(QuestionAdmission, api.conversationId, { data })).id;
      (await tx.doc(PersonalQuestionDoc, id, null)).question = { ...data, admission, status: "pending", version: 1 }; doc.ids.push(id);
    }, callContext);
    if (api.conversationId !== ROOT_CONVERSATION_ID) return waitWorkQuestion(api, String(api.taskId), callContext, im);
    return { output: [{ type: "text", text: JSON.stringify({ status: "pending", message: "结束本轮，回答将作为后续拥有者输入。" }) }] };
  } });
  return defineExtension({ name: PERSONAL_QUESTIONS, tools: [ask], tasks: [questionTask(im, admitInput)], hooks: [hook(ToolTask, {
    async beforeTool(call, api, callContext) { const names = await getHarness().commit(tx => personalQuestionToolNames(tx, api.conversationId, [call.name]), callContext); if (!names.includes(call.name)) return { block: "本轮已登记问题，只可查询后台状态；请输出说明并结束本轮，收到实际回答后再继续。" }; },
    async afterTool(call, result, api, callContext) {
      if (call.name !== "ask_user" || api.conversationId === ROOT_CONVERSATION_ID) return;
      const value = await getHarness().commit(async tx => { await refreshPersonalQuestions(tx); return copyJson(await personalQuestion(tx, String(api.taskId))) as PersonalQuestion; }, callContext);
      if (value.answer?.delivery === "canceled") return { ...result, output: [{ type: "text", text: JSON.stringify(workQuestionOutput(value)) }] };
      return;
    },
  })] });
}
export async function verifyPersonalQuestions(tx: Tx, keys: string[], receiptKeys: string[], enabled: boolean, definition?: ToolRegistration) {
  const ids = (await tx.doc(PersonalQuestionsDoc)).ids;
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || !isDeepStrictEqual([...ids].sort(), [...keys].sort()) || ids.length && !enabled) throw invalid();
  const pending = new Set<string>();
  for (const id of ids) {
    const value = await personalQuestion(tx, id), admission = await tx.entry(QuestionAdmission, value.admission), tool = await tx.task(value.operation), generation = await tx.task(value.generation), callInput = tool?.input;
    const assistant = callInput && typeof callInput === "object" && !Array.isArray(callInput) && typeof callInput.assistant === "number" ? await tx.entry(callInput.assistant as EntryId) : undefined;
    const call = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && callInput && typeof callInput === "object" && !Array.isArray(callInput) && part.id === callInput.callId);
    let normalized: Record<string, JsonValue> | undefined;
    if (call?.type === "toolCall" && definition) { try { normalized = validateToolArguments(definition, { ...call, arguments: copyJson(call.arguments) as Record<string, JsonValue> }) as Record<string, JsonValue>; } catch { throw invalid(); } }
    if (value.id !== String(value.operation) || !value.work && value.origin.conversationId !== ROOT_CONVERSATION_ID || value.generation !== value.origin.generation || tool?.kind !== "pi.tool" || tool.owner !== generation?.id || generation?.kind !== "pi.generation" || tool.conversationId !== value.origin.conversationId || generation.conversationId !== value.origin.conversationId || call?.type !== "toolCall" || call.name !== "ask_user" || !isDeepStrictEqual(normalized, { questions: value.questions }) || !admission || admission.conversationId !== value.origin.conversationId || !isDeepStrictEqual(admission.data, { id, operation: value.operation, generation: value.generation, origin: value.origin, ...(value.work ? { work: value.work } : {}), questions: value.questions }) || !isDeepStrictEqual(parsed(() => parseOwnerQuestions(value.questions)), value.questions) || !["pending", "answered", "canceled", "stale"].includes(value.status) || value.version !== (value.status === "pending" ? 1 : 2)) throw invalid();
    const source = await personalSource(tx, value.origin.source.requestId);
    if (!isDeepStrictEqual(source.source, value.origin.source) || !isDeepStrictEqual(source.permission, value.origin.permission) || !isDeepStrictEqual(source.telegram, value.origin.telegram)) throw invalid();
    if (value.work) {
      const ref = value.work.ref, work = await tx.doc(PersonalWorkDoc, ref.requestId, null), task = await tx.task(ref.taskId), config = await tx.doc(AgentDoc, ref.agentId);
      if (value.work.version !== 1 || ref.agentId === ROOT_CONVERSATION_ID || value.origin.conversationId !== ref.agentId || !isDeepStrictEqual(value.origin.work?.ref, ref) || !isDeepStrictEqual(work.ref, ref) || task?.kind !== "ruukoto.background-work" || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || !isDeepStrictEqual(work.permission, value.origin.permission) || !isDeepStrictEqual(work.telegram, value.origin.telegram) || !Array.isArray(config.extensions) || !config.extensions.includes(PERSONAL_QUESTIONS) || !Array.isArray(config.tools) || !config.tools.includes("ask_user")) throw invalid();
      await verifyPersonalToolInstructions(tx, value.work.instructions, value.origin, value.admission, value.operation);
      await verifyWorkQuestionResult(tx, value);
    } else if (value.origin.work) throw invalid();
    if (value.status === "pending") { const key = value.work ? `work:${value.work.ref.taskId}` : "root"; if (pending.has(key)) throw invalid(); pending.add(key); if (value.answer || value.terminal) throw invalid(); }
    else if (value.status === "answered") {
      if (value.terminal) throw invalid();
      await verifyQuestionAnswer(tx, value); await personalQuestionSubmission(tx, value);
      const task = await tx.task(value.answer!.taskId);
      if (task?.state.status === "terminal") {
        if (value.answer!.delivery === "sending") value.answer!.delivery = "effect_unknown";
        else if (value.answer!.delivery === "waiting") value.answer!.delivery = "unanswered";
        else if (value.answer!.delivery === "pending") value.answer!.delivery = "failed";
        else if (value.work && value.answer!.delivery === "returned" && task.state.outcome.status !== "completed") value.answer!.delivery = "unanswered";
      }
    }
    else { const terminal = value.terminal && await tx.entry(QuestionTerminal, value.terminal); if (!terminal || terminal.data.question !== id || terminal.data.status !== value.status || terminal.data.version !== value.version || value.answer) throw invalid();
      if (value.status === "canceled") { const receipt = terminal.data.requestId && await personalQuestionReceipt(tx, terminal.data.requestId); if (!receipt || receipt.entry !== terminal.id || receipt.operation !== "cancel" || receipt.question !== id || receipt.version !== 1 || !isDeepStrictEqual(receipt.actor, terminal.data.actor)) throw invalid(); }
      else if (terminal.data.requestId || terminal.data.actor) throw invalid(); }
  }
  for (const requestId of receiptKeys) { const receipt = await personalQuestionReceipt(tx, requestId); if (!receipt || receipt.requestId !== requestId || !ids.includes(receipt.question) || !(await tx.entry(receipt.entry))) throw invalid(); const value = await personalQuestion(tx, receipt.question); if (receipt.operation === "answer" ? value.answer?.requestId !== requestId || value.answer.admission !== receipt.entry : receipt.operation !== "cancel" || value.terminal !== receipt.entry || value.status !== "canceled") throw invalid(); }
  let cursor: Cursor | undefined;
  do { const page = await tx.scanTasks({ kind: PersonalQuestionTask.definition.name }, 256, cursor); for (const task of page.items) { const input = task.input; if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.question !== "string" || !ids.includes(input.question) || (await personalQuestion(tx, input.question)).answer?.taskId !== task.id) throw invalid(); } cursor = page.next; } while (cursor);
  let conversationCursor: Cursor | undefined;
  do {
    const conversations = await tx.scanConversations({}, 256, conversationCursor);
    for (const conversation of conversations.items) {
      let entryCursor: Cursor | undefined;
      do {
        const page = await tx.scanEntries({ conversationId: conversation.id }, 256, entryCursor);
        for (const entry of page.items) {
          if (QuestionAdmission.is(entry)) {
            if (!ids.includes(entry.data.id) || (await personalQuestion(tx, entry.data.id)).admission !== entry.id || (await personalQuestion(tx, entry.data.id)).origin.conversationId !== conversation.id) throw invalid();
          } else if (AnswerAdmission.is(entry)) {
            if (conversation.id !== ROOT_CONVERSATION_ID || !ids.includes(entry.data.question) || (await personalQuestion(tx, entry.data.question)).answer?.admission !== entry.id || !receiptKeys.includes(entry.data.requestId)) throw invalid();
          } else if (QuestionTerminal.is(entry)) {
            if (conversation.id !== ROOT_CONVERSATION_ID || !ids.includes(entry.data.question) || (await personalQuestion(tx, entry.data.question)).terminal !== entry.id || entry.data.requestId !== undefined && !receiptKeys.includes(entry.data.requestId)) throw invalid();
          } else if (WorkQuestionReturn.is(entry)) {
            if (!ids.includes(entry.data.question)) throw invalid();
            const value = await personalQuestion(tx, entry.data.question);
            if (!value.work || value.origin.conversationId !== conversation.id || value.answer?.returned !== entry.id) throw invalid();
          } else if (WorkQuestionCanceled.is(entry)) {
            if (conversation.id !== ROOT_CONVERSATION_ID || !ids.includes(entry.data.question) || (await personalQuestion(tx, entry.data.question)).answer?.canceled !== entry.id) throw invalid();
          } else if (entry.kind === PERSONAL_QUESTION_INPUT) {
            const data = entry.data;
            if (conversation.id !== ROOT_CONVERSATION_ID || !data || typeof data !== "object" || Array.isArray(data) || typeof data.question !== "string" || !ids.includes(data.question)) throw invalid();
            const value = await personalQuestion(tx, data.question), submission = await personalQuestionSubmission(tx, value);
            if (submission?.entry !== entry.id || !isDeepStrictEqual(data, inputData(value))) throw invalid();
          }
        }
        entryCursor = page.next;
      } while (entryCursor);
    }
    conversationCursor = conversations.next;
  } while (conversationCursor);
  await refreshPersonalQuestions(tx);
}
