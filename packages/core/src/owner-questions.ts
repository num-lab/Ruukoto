// Note: 见 .agents/notes/implemented/feature/2026-10-21-owner-question-choice-types.md
import { isDeepStrictEqual } from "node:util";
import type { Store } from "./store.ts";
import { getWorkflowExecution, getWorkflowDeliveryRun } from "./workflow.ts";
import { isAgentReportFallback } from "./agent-wait.ts";
import { randomId, type AccessMode, type GrantedPath, type ModelSelection, type Task } from "./types.ts";

export type OwnerQuestionOption = string | { label: string; description?: string; recommended?: boolean };
export interface OwnerQuestionItem { question: string; options?: OwnerQuestionOption[]; multiple?: boolean }
export interface OwnerAnswer { text: string; option?: number; options?: number[] }
export interface OwnerQuestionView {
  id: string;
  sessionId: string;
  taskId: string;
  version: number;
  status: "pending" | "answered" | "canceled" | "stale";
  questions: OwnerQuestionItem[];
  answers?: OwnerAnswer[];
  continuationTaskId?: string;
  createdAt: string;
}
export interface OwnerQuestion extends OwnerQuestionView {
  hostOpId: string;
  source: { kind: "coding-owner"; projectId: string; input: string; accessMode: AccessMode; permissionVersion: number; grantedPaths: GrantedPath[]; planMode: boolean };
  answerSource?: { kind: "coding-owner"; sessionId: string; accessMode: AccessMode; planMode: boolean; permissionVersion: number; grantedPaths: GrantedPath[]; modelSelection: ModelSelection | null };
  updatedAt: string;
}
export interface OwnerQuestionReceipt {
  operation: "owner_question_answer" | "owner_question_cancel";
  questionId: string;
  sessionId: string;
  requestKey: string;
  digest: string;
  question: OwnerQuestionView;
  taskId?: string;
}
export class OwnerQuestionError extends Error {
  constructor(readonly code: "invalid_params" | "question_pending" | "question_not_pending" | "question_version" | "question_not_found" | "question_source_invalid" | "request_conflict" | "question_corrupt", message: string = `操作未接纳（${code}）；结束本轮并向拥有者说明。`) {
    super(message);
    this.name = "OwnerQuestionError";
  }
}

export function ownerQuestionToView(question: OwnerQuestion): OwnerQuestionView {
  const { id, sessionId, taskId, version, status, questions, answers, continuationTaskId, createdAt } = question;
  return { id, sessionId, taskId, version, status, questions: structuredClone(questions), ...(answers ? { answers: structuredClone(answers) } : {}), ...(continuationTaskId ? { continuationTaskId } : {}), createdAt };
}

export function parseOwnerQuestions(value: unknown): OwnerQuestionItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new OwnerQuestionError("invalid_params", "一次提交1–3题，修正题目后重试。");
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new OwnerQuestionError("invalid_params");
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some(key => !["question", "options", "multiple"].includes(key)) || typeof record.question !== "string" || !record.question.trim() || record.question.length > 2000) throw new OwnerQuestionError("invalid_params", "题目须非空且最多2000字符，修正后重试。");
    let options: OwnerQuestionOption[] | undefined;
    if (record.options !== undefined) {
      if (!Array.isArray(record.options) || record.options.length < 2 || record.options.length > 5) throw new OwnerQuestionError("invalid_params", "选择题须有2–5个选项，修正后重试。");
      options = record.options.map(option => {
        if (typeof option === "string") {
          if (!option.trim() || option.length > 200) throw new OwnerQuestionError("invalid_params", "选项名须非空且最多200字符，修正后重试。");
          return option;
        }
        if (!option || typeof option !== "object" || Array.isArray(option)) throw new OwnerQuestionError("invalid_params");
        const entry = option as Record<string, unknown>;
        if (Object.keys(entry).some(key => !["label", "description", "recommended"].includes(key)) || typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 200 ||
          (entry.description !== undefined && (typeof entry.description !== "string" || entry.description.length > 500)) ||
          (entry.recommended !== undefined && typeof entry.recommended !== "boolean")) throw new OwnerQuestionError("invalid_params", "选项名须非空且最多200字符，说明最多500字符，recommended须为布尔值；修正后重试。");
        return { label: entry.label, ...(typeof entry.description === "string" ? { description: entry.description } : {}), ...(typeof entry.recommended === "boolean" ? { recommended: entry.recommended } : {}) };
      });
      if (new Set(options.map(option => typeof option === "string" ? option : option.label)).size !== options.length) throw new OwnerQuestionError("invalid_params", "选项名须互异，修正后重试。");
    }
    if ((record.multiple !== undefined && typeof record.multiple !== "boolean") || (record.multiple === true && !options)) throw new OwnerQuestionError("invalid_params", "multiple须为布尔值，多选题须提供选项；修正后重试。");
    return { question: record.question, ...(options ? { options } : {}), ...(typeof record.multiple === "boolean" ? { multiple: record.multiple } : {}) };
  });
}

export function parseOwnerAnswers(value: unknown, questions: OwnerQuestionItem[]): OwnerAnswer[] {
  if (!Array.isArray(value) || value.length !== questions.length) throw new OwnerQuestionError("invalid_params", "请逐题作答或跳过。");
  return value.map((answer, index) => {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new OwnerQuestionError("invalid_params");
    const record = answer as Record<string, unknown>, question = questions[index];
    if (Object.keys(record).some(key => !["text", "option", "options"].includes(key)) || typeof record.text !== "string" || record.text.length > 4096 ||
      (record.text !== "" && !record.text.trim())) throw new OwnerQuestionError("invalid_params", "答案最多4096字符，跳过请提交空字符串；核对后重试。");
    const labels = question.options?.map(option => typeof option === "string" ? option : option.label);
    if ("option" in record) {
      if ("options" in record || question.multiple || typeof record.option !== "number" || !Number.isInteger(record.option) || record.option < 0 || !labels || record.option >= labels.length || record.text !== labels[record.option]) throw new OwnerQuestionError("invalid_params", "单选答案须匹配所选选项；核对后重试。");
      return { text: record.text, option: record.option };
    }
    if ("options" in record) {
      const selected = record.options;
      if (!question.multiple || !labels || !Array.isArray(selected) || selected.length < 1 || selected.length > labels.length ||
        selected.some((option, selectedIndex) => typeof option !== "number" || !Number.isInteger(option) || option < 0 || option >= labels.length || (selectedIndex > 0 && option <= selected[selectedIndex - 1])) ||
        record.text !== selected.map(option => labels[option]).join("\n")) throw new OwnerQuestionError("invalid_params", "多选索引须按选项顺序互异，答案须为选项名以换行连接；核对后重试。");
      return { text: record.text, options: [...selected] as number[] };
    }
    return { text: record.text };
  });
}

export function ownerQuestionTaskEligible(store: Store, task: Task): boolean {
  return store.getSessionIdentity(task.sessionId)?.kind === "dev" && task.agentId === null && task.parentTaskId === null && task.sourceEventId === null && task.sourcePermissionVersion === null && task.workId === null && task.subAgentId === null && !getWorkflowExecution(store, task.id) && !getWorkflowDeliveryRun(store, task.id) && !isAgentReportFallback(store, task.id);
}

function questionFromRow(row: { payload: string } | undefined): OwnerQuestion | null {
  if (!row) return null;
  let question: OwnerQuestion;
  try { question = JSON.parse(row.payload) as OwnerQuestion; }
  catch { throw new OwnerQuestionError("question_corrupt", "问题记录无法读取；保留档案并检查存储。"); }
  if (!question || typeof question.id !== "string" || typeof question.sessionId !== "string" || typeof question.taskId !== "string" || typeof question.hostOpId !== "string" || !Number.isInteger(question.version) || question.version < 1 || !["pending", "answered", "canceled", "stale"].includes(question.status) || question.source?.kind !== "coding-owner" || typeof question.createdAt !== "string" || typeof question.updatedAt !== "string" || typeof question.source.input !== "string" || !Number.isInteger(question.source.permissionVersion)) throw new OwnerQuestionError("question_corrupt");
  try { parseOwnerQuestions(question.questions); }
  catch { throw new OwnerQuestionError("question_corrupt"); }
  if (question.status === "answered") {
    try { parseOwnerAnswers(question.answers, question.questions); }
    catch { throw new OwnerQuestionError("question_corrupt"); }
    if (typeof question.continuationTaskId !== "string" || question.answerSource?.kind !== "coding-owner" || question.answerSource.sessionId !== question.sessionId) throw new OwnerQuestionError("question_corrupt");
  } else if (question.answers !== undefined || question.continuationTaskId !== undefined || question.answerSource !== undefined) throw new OwnerQuestionError("question_corrupt");
  return question;
}
export function getOwnerQuestion(store: Store, id: string): OwnerQuestion | null {
  return questionFromRow(store.db.prepare("SELECT payload FROM owner_questions WHERE id = ?").get(id) as { payload: string } | undefined);
}
export function listOwnerQuestions(store: Store, sessionId: string, limit = 20, offset = 0): OwnerQuestion[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new OwnerQuestionError("invalid_params");
  return (store.db.prepare("SELECT payload FROM owner_questions WHERE session_id = ? ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, rowid DESC LIMIT ? OFFSET ?").all(sessionId, limit, offset) as { payload: string }[]).map(row => questionFromRow(row)!);
}
export function findOwnerQuestionByOp(store: Store, hostOpId: string): OwnerQuestion | null {
  return questionFromRow(store.db.prepare("SELECT payload FROM owner_questions WHERE host_op_id = ?").get(hostOpId) as { payload: string } | undefined);
}
export function ownerQuestionCreatedByTask(store: Store, taskId: string): boolean {
  return Boolean(store.db.prepare("SELECT 1 FROM owner_questions WHERE task_id = ? LIMIT 1").get(taskId));
}

function saveQuestion(store: Store, question: OwnerQuestion): void {
  store.db.prepare("UPDATE owner_questions SET status = ?, payload = ? WHERE id = ?").run(question.status, JSON.stringify(question), question.id);
  store.appendEvent({ type: "owner_question.changed", question: ownerQuestionToView(question) }, { sessionId: question.sessionId, taskId: question.taskId });
}

/** 调用者持有 Store 事务；同一宿主操作重取原问题，其他待答批次不能被覆盖。 */
// Note: 见 .agents/notes/implemented/feature/2026-10-21-coding-owner-questions.md
export function createOwnerQuestion(store: Store, input: { taskId: string; sessionId: string; projectId: string; hostOpId: string; questions: OwnerQuestionItem[] }): OwnerQuestion {
  const questions = parseOwnerQuestions(input.questions), existing = findOwnerQuestionByOp(store, input.hostOpId);
  if (existing) {
    if (existing.taskId !== input.taskId || existing.sessionId !== input.sessionId || existing.source.projectId !== input.projectId || !isDeepStrictEqual(existing.questions, questions)) throw new OwnerQuestionError("request_conflict");
    return existing;
  }
  const task = store.getTask(input.taskId), session = store.getSession(input.sessionId), op = store.getToolOp(input.hostOpId);
  if (!task || !session || session.projectId !== input.projectId || task.sessionId !== session.id || !ownerQuestionTaskEligible(store, task) || task.status !== "running" || task.cancelRequested || !op || op.taskId !== task.id || op.toolName !== "ask_user" || !isDeepStrictEqual(op.params.questions, questions)) throw new OwnerQuestionError("question_source_invalid", "当前提问来源已失效；停止提问并向拥有者说明。");
  if (store.db.prepare("SELECT 1 FROM owner_questions WHERE session_id = ? AND status = 'pending'").get(session.id)) throw new OwnerQuestionError("question_pending", "已有待答问题。结束本轮，拥有者可在问题卡片作答或取消。");
  const now = new Date().toISOString();
  const question: OwnerQuestion = { id: randomId("question"), sessionId: session.id, taskId: task.id, hostOpId: op.id, version: 1, status: "pending", questions,
    source: { kind: "coding-owner", projectId: session.projectId, input: task.input, accessMode: task.accessMode, permissionVersion: task.permissionVersion, grantedPaths: structuredClone(task.grantedPaths), planMode: task.planMode }, createdAt: now, updatedAt: now };
  store.db.prepare("INSERT INTO owner_questions (id, session_id, task_id, host_op_id, status, payload) VALUES (?, ?, ?, ?, ?, ?)").run(question.id, question.sessionId, question.taskId, question.hostOpId, question.status, JSON.stringify(question));
  store.appendEvent({ type: "owner_question.changed", question: ownerQuestionToView(question) }, { sessionId: question.sessionId, taskId: question.taskId });
  return question;
}

export function getOwnerQuestionReceipt(store: Store, sessionId: string, requestKey: string, operation?: OwnerQuestionReceipt["operation"]): OwnerQuestionReceipt | null {
  const row = store.db.prepare("SELECT payload FROM owner_question_receipts WHERE session_id = ? AND request_key = ?").get(sessionId, requestKey) as { payload: string } | undefined;
  if (!row) return null;
  let receipt: OwnerQuestionReceipt;
  try { receipt = JSON.parse(row.payload) as OwnerQuestionReceipt; }
  catch { throw new OwnerQuestionError("question_corrupt"); }
  if (!receipt || receipt.sessionId !== sessionId || receipt.requestKey !== requestKey || !["owner_question_answer", "owner_question_cancel"].includes(receipt.operation) || !receipt.question) throw new OwnerQuestionError("question_corrupt");
  return !operation || receipt.operation === operation ? receipt : null;
}
function originalReceipt(store: Store, input: { questionId: string; sessionId: string; requestKey: string; requestDigest: string }, operation: OwnerQuestionReceipt["operation"]): OwnerQuestionReceipt | null {
  if (!input.requestKey || !input.requestDigest) throw new OwnerQuestionError("invalid_params");
  const receipt = getOwnerQuestionReceipt(store, input.sessionId, input.requestKey);
  if (receipt && (receipt.questionId !== input.questionId || receipt.digest !== input.requestDigest || receipt.operation !== operation)) throw new OwnerQuestionError("request_conflict");
  return receipt;
}
function requirePending(store: Store, input: { questionId: string; sessionId: string; version: number }): OwnerQuestion {
  const question = getOwnerQuestion(store, input.questionId);
  if (!question || question.sessionId !== input.sessionId) throw new OwnerQuestionError("question_not_found");
  if (question.version !== input.version) throw new OwnerQuestionError("question_version", "问题状态已更新，请刷新问题卡片。");
  if (question.status !== "pending") throw new OwnerQuestionError("question_not_pending", "该问题已结束，请刷新查看结果。");
  return question;
}
function saveReceipt(store: Store, receipt: OwnerQuestionReceipt): OwnerQuestionReceipt {
  store.db.prepare("INSERT INTO owner_question_receipts (session_id, request_key, question_id, digest, operation, payload) VALUES (?, ?, ?, ?, ?, ?)").run(receipt.sessionId, receipt.requestKey, receipt.questionId, receipt.digest, receipt.operation, JSON.stringify(receipt));
  return receipt;
}

/** 与唯一续接 Task 的插入同事务；重复请求只返回原回执，不再消费。 */
export function consumeOwnerQuestion(store: Store, input: { questionId: string; sessionId: string; version: number; requestKey: string; requestDigest: string; answers: OwnerAnswer[]; source: { kind: "coding-owner"; sessionId: string }; taskId: string }): OwnerQuestionReceipt {
  const original = originalReceipt(store, input, "owner_question_answer");
  if (original) return original;
  const question = requirePending(store, input), answers = parseOwnerAnswers(input.answers, question.questions), task = store.getTask(input.taskId);
  if (input.source.kind !== "coding-owner" || input.source.sessionId !== question.sessionId || !task || task.sessionId !== question.sessionId || task.requestId !== input.requestKey || !ownerQuestionTaskEligible(store, task) || task.status !== "queued") throw new OwnerQuestionError("question_source_invalid");
  const updated: OwnerQuestion = { ...question, status: "answered", version: question.version + 1, answers, answerSource: { ...input.source, accessMode: task.accessMode, planMode: task.planMode, permissionVersion: task.permissionVersion, grantedPaths: structuredClone(task.grantedPaths), modelSelection: structuredClone(task.modelSelection) }, continuationTaskId: task.id, updatedAt: new Date().toISOString() };
  saveQuestion(store, updated);
  return saveReceipt(store, { operation: "owner_question_answer", questionId: question.id, sessionId: question.sessionId, requestKey: input.requestKey, digest: input.requestDigest, question: ownerQuestionToView(updated), taskId: task.id });
}

/** 取消只登记终态与回执，不能产生答案或续接；内部来源失效不需要客户端请求键。 */
export function cancelOwnerQuestion(store: Store, input: { questionId: string; sessionId: string; version: number; requestKey?: string; requestDigest?: string; status?: "canceled" | "stale" }): OwnerQuestion {
  const keyed = input.requestKey !== undefined || input.requestDigest !== undefined;
  if (keyed) {
    const original = originalReceipt(store, { questionId: input.questionId, sessionId: input.sessionId, requestKey: input.requestKey ?? "", requestDigest: input.requestDigest ?? "" }, "owner_question_cancel");
    if (original) {
      const question = getOwnerQuestion(store, original.questionId);
      if (!question) throw new OwnerQuestionError("question_corrupt");
      return question;
    }
  }
  const question = requirePending(store, input), updated: OwnerQuestion = { ...question, status: input.status ?? "canceled", version: question.version + 1, updatedAt: new Date().toISOString() };
  saveQuestion(store, updated);
  if (keyed) saveReceipt(store, { operation: "owner_question_cancel", questionId: question.id, sessionId: question.sessionId, requestKey: input.requestKey!, digest: input.requestDigest!, question: ownerQuestionToView(updated) });
  return updated;
}
export function invalidateOwnerQuestionsForTask(store: Store, taskId: string): void {
  const row = store.db.prepare("SELECT payload FROM owner_questions WHERE task_id = ? AND status = 'pending'").get(taskId) as { payload: string } | undefined;
  const question = questionFromRow(row);
  if (question) cancelOwnerQuestion(store, { questionId: question.id, sessionId: question.sessionId, version: question.version, status: "stale" });
}
