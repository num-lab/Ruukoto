import type { OwnerAnswer, OwnerQuestionView } from "@ruukoto/core/owner-questions.ts";
import type { ViewState } from "@ruukoto/view/state.ts";
import type { DesktopBridge, DesktopCancelQuestionResult, DesktopSubmitResult, DesktopUpdate, PendingInput } from "../shared/bridge.ts";
import { WriteFailure } from "./code-writes.ts";

export interface QuestionDraft { index: number; answers: OwnerAnswer[]; review: boolean }
export function questionStatus(status: OwnerQuestionView["status"]): string { return ({ pending: "待回答", answered: "已回答", canceled: "已取消", stale: "已失效" })[status]; }

// Note: 见 .agents/notes/implemented/feature/2026-10-21-coding-owner-questions.md
// Note: 见 .agents/notes/implemented/feature/2026-10-21-owner-question-choice-types.md
export class DesktopQuestions {
  private readonly drafts = new Map<string, QuestionDraft>();
  private readonly notices = new Set<string>();
  readonly busy = new Set<string>();
  entries: PendingInput[] = [];
  message: string | null = null;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly view: ViewState, private readonly online: () => boolean, private readonly changed: () => void) {}
  private key(question: OwnerQuestionView): string { return `${this.view.instanceId}:${question.id}:${question.version}`; }
  draft(question: OwnerQuestionView): QuestionDraft {
    const key = this.key(question);
    let draft = this.drafts.get(key);
    if (!draft) { draft = { index: 0, answers: question.questions.map(() => ({ text: "" })), review: false }; this.drafts.set(key, draft); }
    return draft;
  }
  blocked(question: OwnerQuestionView): boolean {
    return !this.online() || question.status !== "pending" || this.busy.has(question.id) || this.entries.some(entry => entry.record.instanceId === this.view.instanceId && entry.record.params.question_id === question.id);
  }
  edit(question: OwnerQuestionView, text: string): void { const draft = this.draft(question); draft.answers[draft.index] = { text }; this.changed(); }
  choose(question: OwnerQuestionView, option: number | number[]): void {
    const draft = this.draft(question), choices = question.questions[draft.index].options!, indices = typeof option === "number" ? [option] : option.toSorted((a, b) => a - b);
    const labels = indices.map(index => typeof choices[index] === "string" ? choices[index] : choices[index].label);
    draft.answers[draft.index] = typeof option === "number" ? { text: labels[0], option } : { text: labels.join("\n"), ...(indices.length ? { options: indices } : {}) };
    this.changed();
  }
  next(question: OwnerQuestionView, skip = false): void {
    const draft = this.draft(question), answer = draft.answers[draft.index];
    if (!skip && (!answer.text.trim() || answer.text.length > 4096)) { this.message = "请填写回答或选择 Skip 跳过，最多 4096 字。"; this.changed(); return; }
    if (skip) draft.answers[draft.index] = { text: "" };
    if (draft.index + 1 === question.questions.length) draft.review = true; else draft.index++;
    this.message = null;
    this.changed();
  }
  back(question: OwnerQuestionView): void { const draft = this.draft(question); if (draft.review) draft.review = false; else if (draft.index > 0) draft.index--; this.changed(); }
  update(update: DesktopUpdate): void {
    if (update.type === "pending") {
      this.entries = update.entries.filter(entry => entry.record.op === "owner_question_answer" || entry.record.op === "owner_question_cancel");
      for (const entry of this.entries) {
        if (entry.record.instanceId !== this.view.instanceId || typeof entry.record.params.question_id !== "string") continue;
        const question = this.view.ownerQuestions.find(item => item.id === entry.record.params.question_id);
        if (!question || !Array.isArray(entry.record.params.answers)) continue;
        // 完整原回答由主进程的待核实 wire 记录恢复，仍沿原键核实。
        const draft = this.draft(question); draft.answers = entry.record.params.answers as OwnerAnswer[]; draft.review = true;
      }
    } else if ((update.type === "submission" && update.record.op === "owner_question_answer") || update.type === "question_cancel") {
      const { record, result } = update;
      if (record.instanceId !== this.view.instanceId || this.notices.has(record.requestId)) return;
      if (result.kind === "linked" || result.kind === "resent" || result.kind === "rejected") {
        this.notices.add(record.requestId);
        this.entries = this.entries.filter(entry => entry.record.requestId !== record.requestId);
        this.message = result.kind === "rejected" ? `原问题请求被拒绝：${result.reason}；请查看最新问题状态。` : record.op === "owner_question_cancel" ? "已恢复取消结果。" : "已恢复回答结果。";
      } else if (result.kind === "foreign_instance") this.message = "原回答属于其他数据实例，请连回原实例核实。";
      else if (result.kind === "kept") this.message = `原问题请求待核实：${result.reason}`;
    }
  }
  async send(question: OwnerQuestionView, cancel = false): Promise<void> {
    if (this.blocked(question)) return;
    this.busy.add(question.id); this.changed();
    try {
      const draft = this.draft(question);
      const params = { session_id: question.sessionId, question_id: question.id, question_version: question.version, request_id: crypto.randomUUID(), ...(!cancel ? { answers: draft.answers } : {}) };
      const response = await this.bridge.request("code", cancel ? "owner_question_cancel" : "owner_question_answer", params);
      if (!response.ok) throw new WriteFailure(response.error);
      const result = response.value as DesktopSubmitResult | DesktopCancelQuestionResult;
      this.message = result.kind === "accepted" ? cancel ? "问题已取消。" : "回答已提交。"
        : result.kind === "pending_existing" || result.kind === "pending_verification" || result.kind === "conflict" ? "正在核实提交结果，连接恢复后会自动更新。" : result.message;
    } catch (error) { this.message = `问题请求未完成：${(error as Error).message}；请查看最新状态与原回执。`; }
    this.busy.delete(question.id); this.changed();
  }
}
