import { copyJson } from "@earendil-works/chord";
import { type Tx } from "@earendil-works/pi-durable";
import type { PersonalOwnerAnswer as OwnerAnswer, PersonalQuestionItem as OwnerQuestionItem } from "./personal-questions.ts";
import { isDeepStrictEqual } from "node:util";
import { PersonalError } from "./personal-error.ts";
import { answerPersonalQuestion, cancelPersonalQuestion, personalQuestion, personalQuestionList, type PersonalQuestion } from "./personal-questions.ts";
import { telegramSelection, telegramSourceActive } from "./personal-permissions.ts";
import { samePersonalEntry, PersonalTelegramReceiptDoc, type TelegramControlInput } from "./personal-telegram-records.ts";

export type PersonalQuestionMenu = { kind: "question-list"; ids: string[]; nextOffset?: number } | { kind: "question-draft"; id: string; version: number; step: number; answers: OwnerAnswer[]; selected?: number[]; page?: number } | { kind: "question-view"; id: string; page: number };
export const questionOptionLabel = (value: NonNullable<OwnerQuestionItem["options"]>[number]) => typeof value === "string" ? value : value.label;
export const personalQuestionState = (value: Pick<PersonalQuestion, "status" | "answer">) => ({ pending: "待回答", answered: `已回答${value.answer ? `；${({ waiting: "正在续接", local: "回答保存在本机", pending: "等待发送", sending: "正在发送", sent: "回答已送达", failed: "回答未发出", effect_unknown: "发送结果未知，请查询原会话，勿重发", canceled: "原入口失效或续接已取消", unanswered: "续接未获完整回答" })[value.answer.delivery]}` : ""}`, canceled: "已取消", stale: "已失效" })[value.status];
function pages(text: string) { const chars = Array.from(text), result: string[] = []; for (let offset = 0; offset < chars.length; offset += 3000) result.push(chars.slice(offset, offset + 3000).join("")); return result.length ? result : [""]; }
function draftText(value: PersonalQuestion, menu: Extract<PersonalQuestionMenu, { kind: "question-draft" }>) {
  if (menu.step === value.questions.length) return `请核对全部答案：\n${value.questions.map((question, index) => `${index + 1}. ${question.question}\n${menu.answers[index]?.text || "（跳过）"}`).join("\n\n")}`;
  const question = value.questions[menu.step];
  return `第${menu.step + 1}/${value.questions.length}题：${question.question}\n${question.options?.map((option, index) => `${menu.selected?.includes(index) ? "☑ " : ""}${index + 1}. ${questionOptionLabel(option)}${typeof option === "object" && option.recommended ? "（推荐）" : ""}${typeof option === "object" && option.description ? `：${option.description}` : ""}`).join("\n") ?? ""}`;
}
export function personalQuestionLastPage(value: PersonalQuestion, menu: Extract<PersonalQuestionMenu, { kind: "question-draft" }>) { return pages(draftText(value, menu)).length - 1; }
export function personalQuestionPrompt(value: PersonalQuestion, menu: Extract<PersonalQuestionMenu, { kind: "question-draft" }>) {
  const text = pages(draftText(value, menu)), page = menu.page ?? 0;
  if (!Number.isSafeInteger(page) || page < 0 || page >= text.length) throw new PersonalError("question_page_invalid", "原问题页码无效，请发送 /问题 重新选择。");
  const navigation = `${page > 0 ? "上一页问题、" : ""}${page + 1 < text.length ? "下一页问题、" : ""}`;
  const item = value.questions[menu.step];
  const actions = page + 1 < text.length ? "取消问题" : menu.step === value.questions.length ? "确认回答、重新回答、取消问题。业务回答不批准操作" : `${item.options ? item.multiple ? "逐项选择或取消选项编号，再回复「完成选择」；也可直接填写答案" : "选择选项编号，或直接填写答案" : "直接填写答案"}；跳过、全部跳过、取消问题`;
  return `${text[page]}\n第${page + 1}/${text.length}页。回复本消息：${navigation}${actions}。`;
}
function viewText(value: PersonalQuestion) { return `${value.questions.map((item, index) => `${index + 1}. ${item.question}${value.answer ? `\n${value.answer.answers[index].text || "（跳过）"}` : ""}`).join("\n\n")}`; }
function viewPrompt(value: PersonalQuestion, page: number) { const text = pages(viewText(value)); if (!Number.isSafeInteger(page) || page < 0 || page >= text.length) throw new PersonalError("question_page_invalid", "原问题页码无效，请发送 /问题 重新选择。"); return `${personalQuestionState(value)}。\n${text[page]}\n第${page + 1}/${text.length}页。${page > 0 ? "可回复「上一页问题」。" : ""}${page + 1 < text.length ? "回复本消息选择「下一页问题」。" : "发送 /问题 返回列表。"}`; }

function advanceQuestionDraft(question: PersonalQuestion, draft: Extract<PersonalQuestionMenu, { kind: "question-draft" }>, content: string) {
  const page = draft.page ?? 0, last = personalQuestionLastPage(question, draft);
  if (content === "下一页问题" || content === "上一页问题") { const next = page + (content === "下一页问题" ? 1 : -1); if (next < 0 || next > last) throw new PersonalError("question_page_invalid", "此页没有该方向的内容，请回复原菜单列出的动作。"); draft.page = next; return draft; }
  if (page !== last) throw new PersonalError("question_page_unread", "请先回复原菜单选择下一页问题，完整查看后再作答或确认。");
  if (content !== "重新回答") {
      if (draft.step === question.questions.length) throw new PersonalError("question_choice_invalid", "请核对后选择确认回答、重新回答或取消问题。");
      const item = question.questions[draft.step], option = /^[1-5]$/.test(content) ? Number(content) - 1 : -1;
      if (content === "全部跳过") { draft.answers = question.questions.map(() => ({ text: "" })); draft.step = question.questions.length; delete draft.selected; delete draft.page; }
      else if (item.multiple && option >= 0 && item.options?.[option]) { draft.selected = draft.selected?.includes(option) ? draft.selected.filter(index => index !== option) : [...(draft.selected ?? []), option].sort((a, b) => a - b); if (draft.page !== undefined) draft.page = Math.min(draft.page, personalQuestionLastPage(question, draft)); }
      else {
        let answer: OwnerAnswer;
        if (content === "跳过") answer = { text: "" };
        else if (content === "完成选择" && item.multiple) { if (!draft.selected?.length) throw new PersonalError("question_choice_invalid", "请先选择至少一项，或选择跳过。"); answer = { options: draft.selected, text: draft.selected.map(index => questionOptionLabel(item.options![index])).join("\n") }; }
        else if (!item.multiple && option >= 0 && item.options?.[option]) answer = { option, text: questionOptionLabel(item.options[option]) };
        else { if (!content.trim() || content.length > 4096) throw new PersonalError("question_input_invalid", "答案须为最多4096字符的非空文本；也可选择跳过。"); answer = { text: content }; }
        draft.answers[draft.step] = answer; draft.step++; delete draft.selected; delete draft.page;
      }
    }
  return draft;
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-owner-questions.md
export async function personalQuestionControl(tx: Tx, value: TelegramControlInput): Promise<boolean> {
  const previous = value.replyTo === undefined ? undefined : await telegramSelection(tx, value), menu = previous?.selection;
  if (!["/问题", "更多问题"].includes(value.content) && menu?.kind !== "question-list" && menu?.kind !== "question-draft" && menu?.kind !== "question-view") return false;
  if (!value.direct) { value.reply = "请由绑定拥有者直接发送 /问题，再回复已送达的原宿主菜单；转发与引用摘录不能作答。"; return true; }
  try {
    if (value.content === "/问题" || value.content === "更多问题" && menu?.kind === "question-list" && menu.nextOffset !== undefined) {
      const page = await personalQuestionList(tx, value.content === "更多问题" && menu?.kind === "question-list" ? menu.nextOffset! : 0, value);
      value.selection = { kind: "question-list", ids: page.items.map(item => item.id), ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) };
      value.reply = page.items.length ? `原入口问题：\n${page.items.map((item, index) => `问题${index + 1}：${({ pending: "待回答", answered: "已回答", canceled: "已取消", stale: "已失效" })[item.status]}；${item.question}`).join("\n")}\n回复本消息选择问题1至问题${page.items.length}${page.nextOffset === undefined ? "。" : "，或选择「更多问题」。"}` : "原入口暂无问题；普通聊天可继续。";
      return true;
    }
    const choice = /^问题([1-8])$/.exec(value.content);
    const id = choice && menu?.kind === "question-list" ? menu.ids[Number(choice[1]) - 1] : menu?.kind === "question-draft" || menu?.kind === "question-view" ? menu.id : undefined;
    if (!id) { value.reply = "没有改变问题。请发送 /问题，再回复已送达的原宿主菜单选择。"; return true; }
    const question = await personalQuestion(tx, id);
    if (!samePersonalEntry(question.origin.telegram, value) || !await telegramSourceActive(tx, value)) throw new PersonalError("question_original_entry_required", "问题属于其他入口或原入口已失效，请发送 /问题 查询。");
    if (question.status !== "pending") { if (!choice && !(menu?.kind === "question-view" && ["下一页问题", "上一页问题"].includes(value.content))) { value.reply = `${personalQuestionState(question)}。请发送 /问题 选择并查看完整记录。`; return true; } const page = menu?.kind === "question-view" ? menu.page + (value.content === "下一页问题" ? 1 : value.content === "上一页问题" ? -1 : 0) : 0; value.reply = viewPrompt(question, page); value.selection = { kind: "question-view", id, page }; return true; }
    const draft: Extract<PersonalQuestionMenu, { kind: "question-draft" }> = choice || value.content === "重新回答" ? { kind: "question-draft", id, version: question.version, step: 0, answers: [] } : menu?.kind === "question-draft" ? copyJson(menu) as Extract<PersonalQuestionMenu, { kind: "question-draft" }> : { kind: "question-draft", id, version: question.version, step: 0, answers: [] };
    if (draft.version !== question.version) throw new PersonalError("question_version", "问题已变化，请发送 /问题 重新选择。");
    if (value.content === "取消问题") {
      await cancelPersonalQuestion(tx, { question: id, version: draft.version, requestId: value.requestId }, { kind: "im", input: value, menuRequestId: previous!.requestId });
      value.questionCancel = { question: id, requestId: value.requestId }; value.reply = "原问题已取消，没有生成答案或续接；普通聊天可继续。"; return true;
    }
    if (value.content === "确认回答" && draft.step === question.questions.length && (draft.page ?? 0) === personalQuestionLastPage(question, draft)) {
      await answerPersonalQuestion(tx, { question: id, version: draft.version, requestId: value.requestId, answers: draft.answers }, { kind: "im", input: value, menuRequestId: previous!.requestId });
      value.questionAnswer = { question: id, requestId: value.requestId }; value.reply = "全部答案已接纳，正在继续原会话；本次业务回答不批准工具操作。普通聊天可继续。"; return true;
    }
    if (!choice) advanceQuestionDraft(question, draft, value.content);
    value.selection = draft; value.reply = personalQuestionPrompt(question, draft);
  } catch (error) { if (!(error instanceof PersonalError)) throw error; value.reply = `${error.message} 请回复原菜单重新选择，或发送 /问题 查询。`; delete value.selection; }
  return true;
}

export async function verifyPersonalQuestionControls(tx: Tx, keys: string[], enabled: boolean) {
  const invalid = () => new PersonalError("question_menu_invalid", "问题菜单、答案或原平台来源无法核实，已停止恢复；请保留档案。");
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt;
    if (!value) throw invalid();
    const menu = value.selection;
    if (menu?.kind !== "question-list" && menu?.kind !== "question-draft" && menu?.kind !== "question-view" && !value.questionAnswer && !value.questionCancel) continue;
    if (!enabled || !value.direct || !value.control || value.questionAnswer && value.questionCancel) throw invalid();
    const selected = await telegramSelection(tx, value), previous = selected?.selection;
    if (menu?.kind === "question-list") {
      if (!Array.isArray(menu.ids) || menu.ids.length > 8 || new Set(menu.ids).size !== menu.ids.length || value.content !== "/问题" && !(value.content === "更多问题" && previous?.kind === "question-list" && previous.nextOffset !== undefined)) throw invalid();
      for (const id of menu.ids) if (!samePersonalEntry((await personalQuestion(tx, id)).origin.telegram, value)) throw invalid();
      continue;
    }
    const id = menu?.kind === "question-draft" || menu?.kind === "question-view" ? menu.id : value.questionAnswer?.question ?? value.questionCancel?.question;
    if (!id) throw invalid();
    const question = await personalQuestion(tx, id);
    if (!samePersonalEntry(question.origin.telegram, value)) throw invalid();
    if (menu?.kind === "question-view") {
      const choice = /^问题([1-8])$/.exec(value.content);
      if (choice ? previous?.kind !== "question-list" || previous.ids[Number(choice[1]) - 1] !== id || menu.page !== 0 : previous?.kind !== "question-view" || previous.id !== id || !["下一页问题", "上一页问题"].includes(value.content) || menu.page !== previous.page + (value.content === "下一页问题" ? 1 : -1)) throw invalid();
      viewPrompt(question, menu.page); continue;
    }
    if (menu?.kind === "question-draft") {
      const choice = /^问题([1-8])$/.exec(value.content);
      if (choice) {
        if (previous?.kind !== "question-list" || previous.ids[Number(choice[1]) - 1] !== id || !isDeepStrictEqual(menu, { kind: "question-draft", id, version: 1, step: 0, answers: [] })) throw invalid();
      } else {
        if (previous?.kind !== "question-draft" || previous.id !== id || previous.version !== 1) throw invalid();
        const expected = value.content === "重新回答" ? { kind: "question-draft" as const, id, version: 1, step: 0, answers: [] } : advanceQuestionDraft(question, copyJson(previous) as Extract<PersonalQuestionMenu, { kind: "question-draft" }>, value.content);
        if (!isDeepStrictEqual(menu, expected)) throw invalid();
      }
    } else {
      if (previous?.kind !== "question-draft" || previous.id !== id || previous.version !== 1 || selected?.requestId === undefined) throw invalid();
      const receipt = value.questionAnswer ?? value.questionCancel;
      if (!receipt || receipt.requestId !== key || value.content !== (value.questionAnswer ? "确认回答" : "取消问题")) throw invalid();
      if (value.questionAnswer && (previous.step !== question.questions.length || (previous.page ?? 0) !== personalQuestionLastPage(question, previous) || question.answer?.requestId !== key || question.answer.actor.kind !== "im" || question.answer.actor.menuRequestId !== selected.requestId || !isDeepStrictEqual(question.answer.answers, previous.answers))) throw invalid();
    }
  }
}
