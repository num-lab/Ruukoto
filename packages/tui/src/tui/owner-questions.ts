import { Input, SelectList, Text, matchesKey, type Component, type SelectItem } from "@earendil-works/pi-tui";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import { OwnerQuestionCancelGuard } from "@ruukoto/control/owner-question-cancel.ts";
import type { OwnerAnswer, OwnerQuestionView } from "@ruukoto/core/owner-questions.ts";
import type { Session } from "@ruukoto/core/types.ts";
import { sanitizeForDisplay } from "./sanitize.ts";

interface Deps {
  request: ControlConnection["request"];
  pending: PendingRequestStore;
  session: () => Session | undefined;
  instanceId: () => string | null;
  known: () => OwnerQuestionView[];
  install: (sessionId: string, questions: OwnerQuestionView[]) => void;
  online: () => boolean;
  beforeSend: () => Promise<void>;
  render: () => void;
  close: () => void;
}
export const ownerQuestionStatus = (status: OwnerQuestionView["status"]): string => ({ pending: "待回答", answered: "已回答，后续任务已接纳", canceled: "已取消，没有续接", stale: "已失效，请继续普通聊天" })[status];

// Note: 见 .agents/notes/implemented/feature/2026-10-21-coding-owner-questions.md
// Note: 见 .agents/notes/implemented/feature/2026-10-21-owner-question-choice-types.md
export class OwnerQuestions implements Component {
  private questions: OwnerQuestionView[] = [];
  private selected: OwnerQuestionView | null = null;
  private answers: OwnerAnswer[] = [];
  private index = 0;
  private screen: "root" | "answer" | "input" | "review" | "cancel" | "status" = "root";
  private list: SelectList | null = null;
  private input: Input | null = null;
  private message = "";
  private busy = false;
  private generation = 0;
  private sessionId: string | null = null;
  private instanceId: string | null = null;
  constructor(private readonly deps: Deps) {}
  invalidate(): void {}
  private connection(): Pick<ControlConnection, "request" | "instanceId"> {
    const instanceId = this.deps.instanceId();
    return { instanceId, request: (op, params) => {
      if (this.deps.instanceId() !== instanceId) throw new ControlClientError("connection_changed", "数据实例已变化；请连回原实例核实。", "not_sent");
      return this.deps.request(op, params);
    } };
  }
  async refresh(): Promise<void> {
    const sessionId = this.deps.session()?.id ?? null, instanceId = this.deps.instanceId();
    if (sessionId !== this.sessionId || instanceId !== this.instanceId) {
      this.sessionId = sessionId; this.instanceId = instanceId;
      this.selected = null; this.screen = "root"; this.answers = []; this.message = "";
    }
    const generation = ++this.generation;
    if (!sessionId || !this.deps.online()) { this.questions = []; this.build(); return; }
    try {
      const result = await this.deps.request("owner_questions", { session_id: sessionId });
      if (generation !== this.generation || this.deps.session()?.id !== sessionId || this.deps.instanceId() !== instanceId) return;
      const known = this.deps.known().filter(question => question.sessionId === sessionId);
      this.questions = result.questions.map(question => {
        const latest = known.find(item => item.id === question.id);
        return latest && latest.version > question.version ? latest : question;
      });
      this.questions.unshift(...known.filter(question => question.status === "pending" && !this.questions.some(item => item.id === question.id)));
      this.deps.install(sessionId, this.questions);
      if (this.selected) this.selected = this.questions.find(item => item.id === this.selected!.id) ?? this.selected;
    } catch (error) { if (generation === this.generation) this.message = `问题查询失败：${(error as Error).message}；按 r 重新查询。`; }
    if (generation === this.generation) this.build();
  }
  async reconnect(): Promise<void> {
    if (this.busy) return;
    await this.refresh();
    const connection = this.connection();
    const saved = this.deps.pending.list();
    if (saved.corrupt.length) this.message = "有损坏的回答记录，原文件已保留；请核实客户端数据目录。";
    for (const record of saved.records) {
      const result = record.op === "owner_question_cancel"
        ? await new OwnerQuestionCancelGuard(this.deps.pending, connection).reconcile(record)
        : await new SubmissionGuard(this.deps.pending, connection).reconcile(record);
      if (result.kind === "linked" || result.kind === "resent") this.message = "原请求已接纳；已关联原回执。";
      else if (result.kind === "foreign_instance") this.message = "回答属于原数据实例；请连回原实例核实。";
      else if (result.kind === "kept") this.message = result.reason;
      else if (result.kind === "rejected") this.message = result.reason;
    }
    await this.refresh();
  }
  private choices(items: (SelectItem & { pick: () => void })[]): void {
    const cleanItems = items.map(item => ({ ...item, label: sanitizeForDisplay(item.label).replace(/\s+/g, " "), ...(item.description ? { description: sanitizeForDisplay(item.description).replace(/\s+/g, " ") } : {}) }));
    const list = new SelectList(cleanItems, 7, { selectedPrefix: text => `\x1b[36m${text}\x1b[0m`, selectedText: text => text, description: text => text, scrollInfo: text => text, noMatch: text => text });
    list.onSelect = item => items.find(choice => choice.value === item.value)?.pick();
    list.onCancel = () => this.back(); this.list = list; this.input = null;
  }
  private build(): void {
    const question = this.selected;
    const held = this.deps.pending.list().records.some(record => record.instanceId === this.deps.instanceId() && record.params.session_id === this.sessionId);
    if (question && question.status !== "pending") this.screen = "status";
    if (this.screen === "root") {
      this.choices([...this.questions.map(item => ({ value: item.id, label: `${ownerQuestionStatus(item.status)} · ${item.questions[0].question}`, pick: () => { this.selected = item; this.answers = []; this.index = 0; this.screen = "answer"; this.build(); } })),
        { value: "$refresh", label: "核实原请求与刷新", pick: () => void this.reconnect() },
        { value: "$close", label: "返回聊天", pick: () => this.deps.close() }]);
    } else if (this.screen === "status") {
      this.choices([{ value: "$back", label: "返回问题列表", pick: () => this.back() }]);
    } else if (question && this.screen === "answer") {
      const current = question.questions[this.index];
      this.choices([...(current.options ?? []).map((option, index) => {
        const label = typeof option === "string" ? option : option.label;
        return { value: String(index), label: `${current.multiple ? this.answers[this.index]?.options?.includes(index) ? "[x] " : "[ ] " : `${index + 1}. `}${label}${typeof option !== "string" && option.recommended ? " (Recommended)" : ""}`, ...(typeof option !== "string" && option.description ? { description: option.description } : {}), pick: () => {
          if (!current.multiple) { this.answer({ text: label, option: index }); return; }
          const previous = this.answers[this.index]?.options ?? [];
          const selected = previous.includes(index) ? previous.filter(item => item !== index) : [...previous, index].sort((a, b) => a - b);
          this.answers[this.index] = selected.length ? { text: selected.map(item => { const value = current.options![item]; return typeof value === "string" ? value : value.label; }).join("\n"), options: selected } : { text: "" };
          this.message = ""; this.build(); this.list?.setSelectedIndex(index);
        } };
      }),
        ...(current.multiple ? [{ value: "$next", label: this.index + 1 === question.questions.length ? "核对回答" : "下一题", pick: () => { const answer = this.answers[this.index]; if (!answer?.text.trim()) { this.message = "请选择至少一项，或跳过当前问题。"; this.deps.render(); return; } this.answer(answer); } }] : []),
        { value: "$text", label: "自由输入", pick: () => { this.screen = "input"; this.input = new Input({ prompt: "> " }); const answer = this.answers[this.index]; this.input.setValue(answer?.option === undefined && answer?.options === undefined ? answer?.text ?? "" : ""); this.input.onSubmit = text => { if (!text.trim() || text.length > 4096) { this.message = "请填写非空回答，最多 4096 字。"; this.deps.render(); return; } this.answer({ text }); }; this.input.onEscape = () => this.back(); this.list = null; this.deps.render(); } },
        { value: "$cancel", label: "取消此批问题", pick: () => { this.screen = "cancel"; this.build(); } },
        { value: "$back", label: this.index > 0 ? "返回上一题" : "返回问题列表", pick: () => this.back() },
        { value: "$skip", label: "Skip · 跳过当前问题", pick: () => this.answer({ text: "" }) }]);
    } else if (question && (this.screen === "review" || this.screen === "cancel")) {
      this.choices([{ value: "$send", label: this.screen === "cancel" ? "确认取消" : "提交全部回答并继续", pick: () => { if (!held && !this.busy && this.deps.online()) void this.send(); } },
        { value: "$back", label: "返回修改", pick: () => this.back() }]);
    }
    this.deps.render();
  }
  private answer(answer: OwnerAnswer): void {
    this.answers[this.index] = answer;
    if (++this.index >= this.selected!.questions.length) this.screen = "review";
    else this.screen = "answer";
    this.message = ""; this.build();
  }
  private back(): void {
    if (this.busy) return;
    if (this.screen === "input" || this.screen === "cancel") this.screen = "answer";
    else if (this.screen === "review" || this.screen === "answer" && this.index > 0) { this.index--; this.screen = "answer"; }
    else if (this.screen === "root") { this.deps.close(); return; }
    else { this.selected = null; this.screen = "root"; }
    this.build();
  }
  private async send(): Promise<void> {
    if (this.busy || !this.selected) return;
    const question = this.selected, cancel = this.screen === "cancel", instanceId = this.deps.instanceId();
    this.busy = true;
    try { await this.deps.beforeSend(); }
    catch (error) { this.busy = false; this.message = `会话设置尚未保存：${(error as Error).message}；请核实设置后再回答。`; this.deps.render(); return; }
    const session = this.deps.session();
    if (!session || session.id !== question.sessionId || this.deps.instanceId() !== instanceId) { this.busy = false; return; }
    if (!cancel && !session.modelSelection) { this.busy = false; this.message = "请返回聊天，通过 /model 选择模型后再提交。"; this.deps.render(); return; }
    this.message = "正在提交；关闭窗口后仍会保留原请求。"; this.deps.render();
    try {
      const params = { session_id: session.id, question_id: question.id, question_version: question.version };
      const result = cancel ? await new OwnerQuestionCancelGuard(this.deps.pending, this.connection()).cancel(params)
        : await new SubmissionGuard(this.deps.pending, this.connection()).submit("owner_question_answer", { ...params, answers: this.answers, model_selection: session.modelSelection });
      this.message = result.kind === "accepted" ? cancel ? "已取消，没有续接。" : "回答已接纳，后续任务已排队。"
        : result.kind === "pending_verification" ? "应答丢失，原请求已保留；恢复连接后核实原回执。" : result.message;
      if (result.kind === "accepted") { this.selected = null; this.screen = "root"; }
    } catch (error) { this.message = `未能提交：${(error as Error).message}；请核实原记录后再操作。`; }
    this.busy = false; await this.refresh();
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { this.back(); return; }
    if (this.input) this.input.handleInput(data);
    else if (data === "r") void this.reconnect();
    else if (data === "q" && this.screen === "root") this.deps.close();
    else this.list?.handleInput(data);
    this.deps.render();
  }
  render(width: number): string[] {
    const selected = this.selected;
    const current = selected?.questions[Math.min(this.index, selected.questions.length - 1)];
    const text = ["拥有者问题", this.screen === "root" ? this.questions.length ? "选择问题查看、回答或取消。" : "当前没有问题；继续普通聊天。" : `${ownerQuestionStatus(selected!.status)} · 第 ${Math.min(this.index + 1, selected!.questions.length)} / ${selected!.questions.length} 题`,
      this.screen !== "root" ? current?.question : "", this.screen === "status" ? selected!.questions.map((item, index) => `${item.question}\n${selected!.answers?.[index] ? selected!.answers[index].text || "已跳过" : ""}`).join("\n") : this.screen === "review" ? this.answers.map((answer, index) => `${index + 1}. ${selected!.questions[index].question}\n${answer.text || "已跳过"}`).join("\n") : "", this.screen === "cancel" ? "取消整批问题，不产生回答或后续任务。" : "",
      this.screen === "answer" ? current?.options?.map((option, index) => `${current.multiple ? this.answers[this.index]?.options?.includes(index) ? "[x] " : "[ ] " : `${index + 1}. `}${typeof option === "string" ? option : `${option.label}${option.recommended ? " (Recommended)" : ""}${option.description ? ` ${option.description}` : ""}`}`).join("\n") : "",
      this.message, !this.deps.online() ? "连接已断开；恢复在线后核实原请求。" : "", "Esc 返回 · PgUp/PgDn 续读 · 关闭窗口保留待答问题"].filter(Boolean).join("\n");
    return [...new Text(sanitizeForDisplay(text), 0, 0).render(width), ...(this.input?.render(width) ?? this.list?.render(width) ?? [])];
  }
}
