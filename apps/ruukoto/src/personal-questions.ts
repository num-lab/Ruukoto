import { personalQuestionLastPage } from "./personal-question-controls.ts";
import { personalSource } from "./personal-source.ts";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { AssistantEntry, defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, defineTool, hook, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, ToolTask, type ConversationId, type Cursor, type EntryId, type Harness, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { OwnerQuestionError, parseOwnerAnswers, parseOwnerQuestions, type OwnerAnswer, type OwnerQuestionItem } from "@ruukoto/core/owner-questions.ts";
import { PersonalError } from "./personal-error.ts";
import { personalToolOrigin, type PersonalToolOrigin } from "./personal-tool-source.ts";
import { personalPermissionFor, telegramSelection, telegramSourceActive, type PersonalTelegramSource } from "./personal-permissions.ts";
import { personalEntryConfig, PersonalTelegramDoc, PersonalTelegramReceiptDoc, samePersonalEntry, type TelegramControlInput } from "./personal-telegram-records.ts";
import { personalTelegramApi } from "./personal-telegram-api.ts";
import { telegramToken } from "./personal-telegram-config.ts";
import { PersonalImApiError } from "./personal-im-api.ts";
import type { PersonalQqApi } from "./personal-qq-api.ts";

export type PersonalOwnerAnswer = { [K in keyof OwnerAnswer]: OwnerAnswer[K] };
export type PersonalQuestionItem = { [K in keyof OwnerQuestionItem]: OwnerQuestionItem[K] };

export const PERSONAL_QUESTIONS = "personal-questions";
export const PERSONAL_QUESTION_INPUT = "ruukoto.question-answer";
const context = BACKGROUND_CONTEXT;
type Identity = { kind: "local" } | { kind: "im"; requestId: string; menuRequestId: string };
export type PersonalQuestionActor = { kind: "local" } | { kind: "im"; input: TelegramControlInput; menuRequestId: string };
type Delivery = "waiting" | "local" | "pending" | "sending" | "sent" | "failed" | "effect_unknown" | "canceled" | "unanswered";
export type PersonalQuestion = { id: string; operation: TaskId; generation: TaskId; admission: EntryId; origin: PersonalToolOrigin; questions: PersonalQuestionItem[]; version: number; status: "pending" | "answered" | "canceled" | "stale"; terminal?: EntryId; answer?: { requestId: string; answers: PersonalOwnerAnswer[]; actor: Identity; permission: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; admission: EntryId; taskId: TaskId; content: string; submissionId?: SubmissionId; answerEntry?: EntryId; delivery: Delivery; reply?: string; platformMessageId?: string } };
export type PersonalQuestionReceipt = { requestId: string; question: string; version: number; operation: "answer" | "cancel"; answers?: PersonalOwnerAnswer[]; actor: Identity; entry: EntryId; taskId?: TaskId };
export const PersonalQuestionsDoc = defineDoc<{ ids: string[] }>({ kind: "ruukoto.questions", scope: "session", version: 1, initial: () => ({ ids: [] }) });
export const PersonalQuestionDoc = defineDocFamily<{ question?: PersonalQuestion }, null>({ kind: "ruukoto.question", scope: "session", version: 1, family: true, initial: () => ({}) });
export const PersonalQuestionReceiptDoc = defineDocFamily<{ receipt?: PersonalQuestionReceipt }, null>({ kind: "ruukoto.question-receipt", scope: "session", version: 1, family: true, initial: () => ({}) });
const QuestionAdmission = defineEntry<{ id: string; operation: TaskId; generation: TaskId; origin: PersonalToolOrigin; questions: PersonalQuestionItem[] }>("ruukoto.question-admission");
const AnswerAdmission = defineEntry<{ question: string; requestId: string; version: number; answers: PersonalOwnerAnswer[]; actor: Identity; permission: { mode: PersonalTelegramSource["mode"]; version: number }; telegram?: PersonalTelegramSource; taskId: TaskId; content: string }>("ruukoto.question-answer-admission");
const QuestionTerminal = defineEntry<{ question: string; status: "canceled" | "stale"; requestId?: string; version: number; actor?: Identity }>("ruukoto.question-terminal");
const invalid = () => new PersonalError("question_record_invalid", "问题、答案或续接来源无法核实，已停止操作；请保留档案并查询原问题。");
const keyFor = (task: TaskId) => `personal-question:${task}`;
const inputData = (value: PersonalQuestion) => ({ question: value.id, admission: value.answer!.admission, taskId: value.answer!.taskId });
const actorIdentity = (actor: PersonalQuestionActor): Identity => actor.kind === "local" ? { kind: "local" } : { kind: "im", requestId: actor.input.requestId, menuRequestId: actor.menuRequestId };
const platformText = (text: string) => Array.from(text).length > 3900 ? Array.from(text).slice(0, 3900).join("") + "…（完整回答保留在个人会话）" : text || "本次回答没有文本，请从本机查询会话。";
function parsed<T>(read: () => T): T { try { return read(); } catch (error) { if (!(error instanceof OwnerQuestionError)) throw error; throw new PersonalError("question_input_invalid", error.message, { cause: error }); } }

export async function personalQuestion(tx: Tx, id: string) { const value = (await tx.doc(PersonalQuestionDoc, id, null)).question; if (!value || value.id !== id) throw new PersonalError("question_missing", "找不到原问题，请刷新问题列表。"); return value; }
export async function refreshPersonalQuestions(tx: Tx) {
  for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) {
    const value = await personalQuestion(tx, id), task = await tx.task(value.generation), submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, value.origin.source.requestId);
    if (value.status !== "pending" || !(value.origin.telegram && !await telegramSourceActive(tx, value.origin.telegram) || submission?.status === "unanswered" || task?.abortRequested || task?.state.status === "terminal" && task.state.outcome.status === "aborted")) continue;
    value.status = "stale"; value.version++;
    value.terminal = (await tx.appendEntry(QuestionTerminal, ROOT_CONVERSATION_ID, { data: { question: id, status: "stale", version: value.version } })).id;
  }
}
export async function personalQuestionList(tx: Tx, offset = 0, actor?: TelegramControlInput) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new PersonalError("question_input_invalid", "请从原问题菜单翻页。");
  await refreshPersonalQuestions(tx);
  const values = await Promise.all((await tx.doc(PersonalQuestionsDoc)).ids.slice().reverse().map(id => personalQuestion(tx, id)));
  const items = values.filter(value => !actor || samePersonalEntry(value.origin.telegram, actor)).sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  return { items: items.slice(offset, offset + 8).map(value => ({ id: value.id, version: value.version, status: value.status, question: Array.from(value.questions[0].question).slice(0, 140).join("") + (Array.from(value.questions[0].question).length > 140 ? "…（选择后完整查看）" : "") })), ...(offset + 8 < items.length ? { nextOffset: offset + 8 } : {}) };
}
export async function personalQuestionDetail(tx: Tx, id: string) { await refreshPersonalQuestions(tx); return copyJson(await personalQuestion(tx, id)) as PersonalQuestion; }
export async function personalQuestionReceipt(tx: Tx, requestId: string) { const value = (await tx.doc(PersonalQuestionReceiptDoc, requestId, null)).receipt; return value && copyJson(value) as PersonalQuestionReceipt; }
export function personalQuestionInput(questions: PersonalQuestionItem[], answers: PersonalOwnerAnswer[]) { return `拥有者对原问题的回答（业务澄清，不是操作批准）：\n${JSON.stringify(questions.map((question, index) => ({ ...question, answer: answers[index] })))}`; }

async function allowedActor(tx: Tx, value: PersonalQuestion, actor: PersonalQuestionActor, operation: "answer" | "cancel") {
  if (actor.kind === "local") {
    if (operation === "answer" && value.origin.telegram) throw new PersonalError("question_original_entry_required", "请从原平台的当前私聊问题菜单回答；本机可查询或取消旧问题。");
    return;
  }
  const menu = await telegramSelection(tx, actor.input);
  if (!actor.input.direct || !samePersonalEntry(value.origin.telegram, actor.input) || !await telegramSourceActive(tx, actor.input) || menu?.requestId !== actor.menuRequestId || menu.selection?.kind !== "question-draft" || menu.selection.id !== value.id || menu.selection.version !== value.version || operation === "answer" && (menu.selection.step !== value.questions.length || (menu.selection.page ?? 0) !== personalQuestionLastPage(value, menu.selection))) throw new PersonalError("question_original_entry_required", "请回复原平台、账号与当前私聊已送达的问题核对菜单；没有改变原问题。");
}
export async function answerPersonalQuestion(tx: Tx, input: { question: string; version: number; requestId: string; answers: PersonalOwnerAnswer[] }, actor: PersonalQuestionActor) {
  const prior = await personalQuestionReceipt(tx, input.requestId), identity = actorIdentity(actor);
  const value = await personalQuestion(tx, input.question), answers = parsed(() => parseOwnerAnswers(input.answers, value.questions));
  if (prior) { if (!isDeepStrictEqual({ ...prior, entry: undefined, taskId: undefined }, { requestId: input.requestId, question: input.question, version: input.version, operation: "answer", answers, actor: identity, entry: undefined, taskId: undefined })) throw new PersonalError("question_request_conflict", "原请求与本次答案不同，请查询原回执；未新建续接。"); return copyJson(prior) as PersonalQuestionReceipt; }
  await refreshPersonalQuestions(tx);
  if (value.status !== "pending" || value.version !== input.version) throw new PersonalError("question_not_pending", "问题已回答、取消或失效，请刷新原问题；未新建续接。");
  await allowedActor(tx, value, actor, "answer");
  if (actor.kind === "im") { const menu = (await telegramSelection(tx, actor.input))?.selection; if (menu?.kind !== "question-draft" || !isDeepStrictEqual(menu.answers, answers)) throw new PersonalError("question_input_invalid", "答案与原核对菜单不同，请回复原菜单重新核对。"); }
  const permission = await personalPermissionFor(tx, actor.kind === "im" ? actor.input : undefined);
  const telegram = actor.kind === "im" ? { ...(actor.input.platform ? { platform: actor.input.platform } : {}), botId: actor.input.botId, ownerId: actor.input.ownerId, generation: actor.input.generation, mode: permission.mode, version: permission.version } : undefined;
  const content = personalQuestionInput(value.questions, answers);
  const taskId = await tx.createTask(PersonalQuestionTask, { question: value.id, requestId: input.requestId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
  const data = { question: value.id, requestId: input.requestId, version: input.version, answers, actor: identity, permission: { mode: permission.mode, version: permission.version }, ...(telegram ? { telegram } : {}), taskId, content };
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
  await refreshPersonalQuestions(tx);
  if (value.status !== "pending" || value.version !== input.version) throw new PersonalError("question_not_pending", "问题已处理，请刷新原问题；没有改变答案。");
  await allowedActor(tx, value, actor, "cancel");
  value.status = "canceled"; value.version++;
  const entry = (await tx.appendEntry(QuestionTerminal, ROOT_CONVERSATION_ID, { data: { question: value.id, status: "canceled", requestId: input.requestId, version: value.version, actor: identity } })).id;
  value.terminal = entry;
  const receipt: PersonalQuestionReceipt = { ...input, operation: "cancel", actor: identity, entry };
  (await tx.doc(PersonalQuestionReceiptDoc, input.requestId, null)).receipt = receipt;
  return copyJson(receipt) as PersonalQuestionReceipt;
}

export async function personalQuestionSubmission(tx: Tx, value: PersonalQuestion) {
  if (!value.answer) return;
  const answer = value.answer, submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, keyFor(answer.taskId));
  if (!submission) { if (answer.submissionId !== undefined || answer.answerEntry !== undefined) throw invalid(); return; }
  if (submission.type !== "input" || answer.submissionId !== undefined && answer.submissionId !== submission.id || answer.answerEntry !== undefined && (submission.status !== "done" || submission.answer !== answer.answerEntry)) throw invalid();
  if (submission.entry) {
    const entry = await tx.entry(submission.entry);
    if (entry?.kind !== PERSONAL_QUESTION_INPUT || entry.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(entry.data, inputData(value)) || !entry.model?.some(message => message.role === "user" && message.content === answer.content)) throw invalid();
  } else if (submission.status === "queued") {
    const queued = (await tx.doc(InboxDoc, ROOT_CONVERSATION_ID)).items.find(item => item.id === submission.id);
    if (!queued || queued.mode !== "followUp" || queued.content !== answer.content || !isDeepStrictEqual(queued.entry, { kind: PERSONAL_QUESTION_INPUT, data: inputData(value) })) throw invalid();
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

function questionTask(qqApi?: PersonalQqApi) { return defineTask<{ question: string; requestId: string }, { phase: "admit" } | { phase: "send"; retryAt?: number } | { phase: "verify" }, { delivery: Delivery }>({
  name: "ruukoto.question-continuation", version: 1, initial: () => ({ phase: "admit" }),
  phases: {
    async admit(current, runtime, callContext) {
      let proceed = true;
      await runtime.commit(async tx => { const value = await personalQuestion(tx, current.input.question); await verifyQuestionAnswer(tx, value); if (value.answer!.telegram && !await telegramSourceActive(tx, value.answer!.telegram!)) { value.answer!.delivery = "canceled"; proceed = false; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; } return undefined; }, callContext);
      if (!proceed) return;
      const saved = (await runtime.snapshot(PersonalQuestionDoc, current.input.question, callContext))!.question!;
      const main = await runtime.conversation(ROOT_CONVERSATION_ID, callContext);
      if (!main) throw invalid();
      const submission = await main.submit({ type: "input", requestId: keyFor(current.id), content: saved.answer!.content, entry: { kind: PERSONAL_QUESTION_INPUT, data: inputData(saved) }, whenBusy: "followUp" }, callContext);
      await runtime.commit(async tx => { const value = await personalQuestion(tx, saved.id); await personalQuestionSubmission(tx, value); value.answer!.submissionId = submission.id; return undefined; }, callContext);
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
      const api = answer.telegram?.platform === "qq" ? qqApi : state?.config?.enabled ? personalTelegramApi(state.config.apiBase, telegramToken(state.config)) : undefined;
      let target: { owner: string; message: number; reply: string } | undefined;
      await runtime.commit(async tx => { const value = await personalQuestion(tx, saved.id), answer = value.answer!; if (!answer.telegram || !await telegramSourceActive(tx, answer.telegram) || !isDeepStrictEqual(config, personalEntryConfig(await tx.doc(PersonalTelegramDoc), answer.telegram))) { answer.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; } const actor = answer.actor.kind === "im" && (await tx.doc(PersonalTelegramReceiptDoc, answer.actor.requestId, null)).receipt; if (!api || !actor || answer.delivery !== "pending" || !answer.reply) throw invalid(); target = { owner: answer.telegram.ownerId, message: actor.messageId, reply: answer.reply }; answer.delivery = "sending"; return { status: "running", checkpoint: { phase: "verify" } }; }, callContext);
      if (!target) return;
      let message: string | undefined, failure: PersonalImApiError | undefined;
      try { message = await api!.send(target.owner, target.message, target.reply, runtime.signal); } catch (error) { if (!(error instanceof PersonalImApiError)) throw error; failure = error; }
      await runtime.commit(async tx => { const answer = (await personalQuestion(tx, saved.id)).answer!; if (failure?.retryAfterMs) { answer.delivery = "pending"; return { status: "running", checkpoint: { phase: "send", retryAt: runtime.now() + failure.retryAfterMs } }; } answer.delivery = message ? "sent" : failure?.effect === "not_sent" ? "failed" : "effect_unknown"; if (message) answer.platformMessageId = message; return { status: "terminal", outcome: { status: "completed", result: { delivery: answer.delivery } } }; }, callContext);
    },
    async verify(current, runtime, callContext) { await runtime.commit(async tx => { const answer = (await personalQuestion(tx, current.input.question)).answer!; answer.delivery = "effect_unknown"; return { status: "terminal", outcome: { status: "completed", result: { delivery: answer.delivery } } }; }, callContext); },
  },
  async abort(current, runtime, callContext) { const saved = (await runtime.snapshot(PersonalQuestionDoc, current.input.question, callContext))!.question!; let admitted = false; await runtime.commit(async tx => { admitted = !!await personalQuestionSubmission(tx, await personalQuestion(tx, saved.id)); return undefined; }, callContext); if (admitted && saved.answer) { const submission = await runtime.conversation(ROOT_CONVERSATION_ID, callContext); const original = submission && await submission.submit({ type: "input", requestId: keyFor(current.id), content: saved.answer.content, entry: { kind: PERSONAL_QUESTION_INPUT, data: inputData(saved) }, whenBusy: "followUp" }, callContext); await original?.abort(callContext); } await runtime.commit(async tx => { const answer = (await personalQuestion(tx, saved.id)).answer!; answer.delivery = answer.delivery === "sending" ? "effect_unknown" : "canceled"; return { status: "terminal", outcome: { status: "aborted", result: { delivery: answer.delivery } } }; }, callContext); },
}); }
export const PersonalQuestionTask = questionTask();

// Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-owner-questions.md
export async function personalQuestionToolNames(tx: Tx, conversationId: ConversationId, names: readonly string[]) {
  if (conversationId !== ROOT_CONVERSATION_ID) return names.filter(name => name !== "ask_user");
  const live = await tx.doc(LiveDoc, conversationId);
  for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) if ((await personalQuestion(tx, id)).origin.inputs.some(input => live.run?.inputs.includes(input))) return names.filter(name => name === "process_status" || name === "process_output");
  return [...names];
}
export async function verifyPersonalQuestionRequest(tx: Tx, conversationId: ConversationId) {
  if (conversationId !== ROOT_CONVERSATION_ID) return;
  const live = await tx.doc(LiveDoc, conversationId);
  for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) { const value = await personalQuestion(tx, id), input = await personalQuestionSubmission(tx, value); if (input && live.run?.inputs.includes(input.id)) await personalQuestionSource(tx, keyFor(value.answer!.taskId), true); }
}
export function personalQuestions(getHarness: () => Harness, qqApi?: PersonalQqApi) {
  const ask = defineTool({ name: "ask_user", description: "登记1–3题业务澄清并立即返回pending；拥有者从本机问题菜单或原私聊 /问题 逐题选择、输入或跳过，最后核对提交。有选项也允许自由输入；multiple开启多选，推荐仅展示。每会话只保留一批待答问题。成功后结束本轮，回答作为后续拥有者输入；待答期间普通聊天继续，业务回答不批准操作。", parameters: Type.Object({ questions: Type.Array(Type.Object({ question: Type.String({ minLength: 1, maxLength: 2000 }), options: Type.Optional(Type.Array(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Object({ label: Type.String({ minLength: 1, maxLength: 200 }), description: Type.Optional(Type.String({ maxLength: 500 })), recommended: Type.Optional(Type.Boolean()) }, { additionalProperties: false })]), { minItems: 2, maxItems: 5, description: "选项名互异；省略时自由输入。" })), multiple: Type.Optional(Type.Boolean({ description: "true须有options；省略或false为单选。" })) }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential", async execute(input, api, callContext) {
    const questions = parsed(() => parseOwnerQuestions(input.questions));
    const live = await api.snapshot(LiveDoc, api.conversationId, callContext), candidate = live?.run?.inputs.length === 1 ? await getHarness().submission(live.run.inputs[0], callContext) : undefined, sourceRequestId = (await candidate?.status(callContext))?.requestId;
    await api.commit(async tx => {
      const prior = (await tx.doc(PersonalQuestionDoc, String(api.taskId), null)).question;
      if (prior) { if (!isDeepStrictEqual(prior.questions, questions)) throw invalid(); return; }
      if (api.conversationId !== ROOT_CONVERSATION_ID || !sourceRequestId) throw new PersonalError("question_source_invalid", "本轮没有唯一拥有者输入，请结束本轮并报告缺少的信息。");
      const origin = await personalToolOrigin(tx, api, sourceRequestId);
      await refreshPersonalQuestions(tx);
      const doc = await tx.doc(PersonalQuestionsDoc);
      for (const id of doc.ids) if ((await personalQuestion(tx, id)).status === "pending") throw new PersonalError("question_pending", "已有待答问题，请结束本轮；拥有者可从原问题菜单回答或取消。");
      const id = String(api.taskId), data = { id, operation: api.taskId, generation: origin.generation, origin, questions };
      const admission = (await tx.appendEntry(QuestionAdmission, api.conversationId, { data })).id;
      (await tx.doc(PersonalQuestionDoc, id, null)).question = { ...data, admission, status: "pending", version: 1 }; doc.ids.push(id);
    }, callContext);
    return { output: [{ type: "text", text: JSON.stringify({ status: "pending", message: "结束本轮，回答将作为后续拥有者输入。" }) }] };
  } });
  return defineExtension({ name: PERSONAL_QUESTIONS, tools: [ask], tasks: [questionTask(qqApi)], hooks: [hook(ToolTask, { async beforeTool(call, api, callContext) { const names = await getHarness().commit(tx => personalQuestionToolNames(tx, api.conversationId, [call.name]), callContext); if (!names.includes(call.name)) return { block: "本轮已登记问题，只可查询后台状态；请输出说明并结束本轮，收到实际回答后再继续。" }; } })] });
}
export async function verifyPersonalQuestions(tx: Tx, keys: string[], receiptKeys: string[], enabled: boolean, definition?: ToolRegistration) {
  const ids = (await tx.doc(PersonalQuestionsDoc)).ids;
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || !isDeepStrictEqual([...ids].sort(), [...keys].sort()) || ids.length && !enabled) throw invalid();
  let pending = 0;
  for (const id of ids) {
    const value = await personalQuestion(tx, id), admission = await tx.entry(QuestionAdmission, value.admission), tool = await tx.task(value.operation), generation = await tx.task(value.generation), callInput = tool?.input;
    const assistant = callInput && typeof callInput === "object" && !Array.isArray(callInput) && typeof callInput.assistant === "number" ? await tx.entry(callInput.assistant as EntryId) : undefined;
    const call = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && callInput && typeof callInput === "object" && !Array.isArray(callInput) && part.id === callInput.callId);
    let normalized: Record<string, JsonValue> | undefined;
    if (call?.type === "toolCall" && definition) { try { normalized = validateToolArguments(definition, { ...call, arguments: copyJson(call.arguments) as Record<string, JsonValue> }) as Record<string, JsonValue>; } catch { throw invalid(); } }
    if (value.id !== String(value.operation) || value.origin.conversationId !== ROOT_CONVERSATION_ID || value.generation !== value.origin.generation || tool?.kind !== "pi.tool" || tool.owner !== generation?.id || generation?.kind !== "pi.generation" || tool.conversationId !== ROOT_CONVERSATION_ID || call?.type !== "toolCall" || call.name !== "ask_user" || !isDeepStrictEqual(normalized, { questions: value.questions }) || !admission || admission.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(admission.data, { id, operation: value.operation, generation: value.generation, origin: value.origin, questions: value.questions }) || !isDeepStrictEqual(parsed(() => parseOwnerQuestions(value.questions)), value.questions) || !["pending", "answered", "canceled", "stale"].includes(value.status) || value.version !== (value.status === "pending" ? 1 : 2)) throw invalid();
    const source = await personalSource(tx, value.origin.source.requestId);
    if (!isDeepStrictEqual(source.source, value.origin.source) || !isDeepStrictEqual(source.permission, value.origin.permission) || !isDeepStrictEqual(source.telegram, value.origin.telegram)) throw invalid();
    if (value.status === "pending") { pending++; if (value.answer || value.terminal) throw invalid(); }
    else if (value.status === "answered") {
      if (value.terminal) throw invalid();
      await verifyQuestionAnswer(tx, value); await personalQuestionSubmission(tx, value);
      const task = await tx.task(value.answer!.taskId);
      if (task?.state.status === "terminal") {
        if (value.answer!.delivery === "sending") value.answer!.delivery = "effect_unknown";
        else if (value.answer!.delivery === "waiting") value.answer!.delivery = "unanswered";
        else if (value.answer!.delivery === "pending") value.answer!.delivery = "failed";
      }
    }
    else { const terminal = value.terminal && await tx.entry(QuestionTerminal, value.terminal); if (!terminal || terminal.data.question !== id || terminal.data.status !== value.status || terminal.data.version !== value.version || value.answer) throw invalid();
      if (value.status === "canceled") { const receipt = terminal.data.requestId && await personalQuestionReceipt(tx, terminal.data.requestId); if (!receipt || receipt.entry !== terminal.id || receipt.operation !== "cancel" || receipt.question !== id || receipt.version !== 1 || !isDeepStrictEqual(receipt.actor, terminal.data.actor)) throw invalid(); }
      else if (terminal.data.requestId || terminal.data.actor) throw invalid(); }
  }
  if (pending > 1) throw invalid();
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
            if (conversation.id !== ROOT_CONVERSATION_ID || !ids.includes(entry.data.id) || (await personalQuestion(tx, entry.data.id)).admission !== entry.id) throw invalid();
          } else if (AnswerAdmission.is(entry)) {
            if (conversation.id !== ROOT_CONVERSATION_ID || !ids.includes(entry.data.question) || (await personalQuestion(tx, entry.data.question)).answer?.admission !== entry.id || !receiptKeys.includes(entry.data.requestId)) throw invalid();
          } else if (QuestionTerminal.is(entry)) {
            if (conversation.id !== ROOT_CONVERSATION_ID || !ids.includes(entry.data.question) || (await personalQuestion(tx, entry.data.question)).terminal !== entry.id || entry.data.requestId !== undefined && !receiptKeys.includes(entry.data.requestId)) throw invalid();
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
