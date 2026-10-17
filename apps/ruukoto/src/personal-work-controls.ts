import { defineExtension, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { telegramSelection } from "./personal-permissions.ts";
import { closePersonalWorkAgent, listPersonalWorks, PersonalWorkDoc, personalWorkRef, personalWorkResult, personalWorkSummary, requestPersonalWorkCancel, type PersonalWorkSummary, type PersonalWorkRef } from "./personal-work.ts";
import type { TelegramControlInput, TelegramReceipt } from "./personal-telegram-records.ts";

export const personalWorkControls = defineExtension({ name: "personal-work-controls" });
const ACTIONS = ["/工作", "更多分析", "刷新分析", "查看结果", "下一页结果", "取消这项分析", "关闭此身份"];

export function personalWorkDescription(value: PersonalWorkSummary) {
  const states: Record<string, string> = { pending: "等待执行", running: "执行中", waiting: "等待处理", completing: "正在收尾", completed: "已完成", failed: "未成功完成", aborted: "已取消", faulted: "异常停止，停止尚未核实", orphaned: "执行归属异常，停止尚未核实" };
  return `${value.label}：${value.content}；${states[value.state] ?? "状态无法核实"}${value.cancelRequested && !value.stopVerified ? "；已请求取消，停止待核实" : ""}${value.stopVerified ? "；停止已核实" : ""}${value.closed ? "；身份已关闭" : ""}`;
}

async function originalWork(tx: Tx, ref: PersonalWorkRef, value: TelegramControlInput) {
  const actual = await personalWorkRef(tx, ref.taskId);
  const source = (await tx.doc(PersonalWorkDoc, actual.requestId, null)).telegram;
  if (actual.requestId !== ref.requestId || actual.agentId !== ref.agentId || source?.botId !== value.botId || source.ownerId !== value.ownerId || source.generation !== value.generation) throw new PersonalError("work_original_entry_required", "此分析不属于原拥有者入口，请重新发送 /工作 查询；没有改变工作。");
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-work-controls.md
export async function telegramWorkControl(tx: Tx, value: TelegramControlInput): Promise<boolean> {
  const choice = /^分析([1-8])$/.exec(value.content);
  if (!choice && !ACTIONS.includes(value.content)) return false;
  if (!value.direct) { value.reply = "请由绑定拥有者直接发送 /工作，再回复宿主菜单选择；转发和引用摘录不能控制工作。"; return true; }
  try {
    const menu = value.content === "/工作" ? undefined : (await telegramSelection(tx, value))?.selection;
    if (value.content === "/工作" || (value.content === "更多分析" && menu?.kind === "work-list" && menu.nextOffset !== undefined)) {
      const page = await listPersonalWorks(tx, menu?.kind === "work-list" ? menu.nextOffset : 0, value);
      value.selection = { kind: "work-list", refs: page.items.map(item => item.ref), ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) };
      value.reply = page.items.length ? `后台分析（单项工作）：\n${page.items.map((item, index) => `分析${index + 1}：${personalWorkDescription(item)}`).join("\n")}\n回复本消息选择分析1至分析${page.items.length}${page.nextOffset === undefined ? "。" : "，或选择「更多分析」。"}` : "原入口暂无后台分析；主聊天仍可继续。";
      return true;
    }
    const ref = choice && menu?.kind === "work-list" ? menu.refs[Number(choice[1]) - 1] : menu?.kind === "work" ? menu.ref : undefined;
    if (!ref) { value.reply = "没有改变工作。请发送 /工作，再回复已送达的宿主菜单选择列出的完整动作。"; return true; }
    await originalWork(tx, ref, value);
    value.selection = { kind: "work", ref: { ...ref } };
    if (value.content === "取消这项分析") {
      await requestPersonalWorkCancel(tx, ref);
      value.reply = "已登记此分析的取消请求；停止仍须核实。回复「刷新分析」查询原工作，身份和历史保留。";
    } else if (value.content === "关闭此身份") {
      await closePersonalWorkAgent(tx, ref);
      value.reply = "此空闲身份已关闭，原工作历史仍保留。";
    } else if (value.content === "查看结果" || value.content === "下一页结果") {
      if (value.content === "下一页结果" && (menu?.kind !== "work" || menu.nextOffset === undefined)) { value.reply = "此菜单没有下一页结果，请回复「查看结果」从原回答开始读取。"; return true; }
      const offset = value.content === "下一页结果" && menu?.kind === "work" ? menu.nextOffset! : 0;
      const result = await personalWorkResult(tx, ref, offset, 2400);
      if (result.text === undefined) value.reply = `${personalWorkDescription(await personalWorkSummary(tx, ref))}。原工作没有成功完成的回答，请稍后刷新状态；停止未核实前不要复用身份。`;
      else {
        if (result.nextOffset !== undefined) value.selection.nextOffset = result.nextOffset;
        value.reply = `原分析结果：\n${result.text || "（无文本内容）"}${result.nextOffset === undefined ? "\n原回答已读完。" : "\n回复本消息选择「下一页结果」继续。"}`;
      }
    } else value.reply = `${personalWorkDescription(await personalWorkSummary(tx, ref))}。回复本消息选择：刷新分析、查看结果、取消这项分析、关闭此身份。关闭只适用未再复用且空闲的身份。`;
  } catch (error) {
    if (!(error instanceof PersonalError)) throw error;
    delete value.selection;
    value.reply = `${error.message} 请发送 /工作 查询当前记录。`;
  }
  return true;
}

export async function verifyWorkMenu(tx: Tx, value: TelegramReceipt, enabled: boolean) {
  const selection = value.selection;
  if (selection?.kind !== "work" && selection?.kind !== "work-list") return;
  const refs = selection.kind === "work" ? [selection.ref] : selection.refs;
  if (!enabled || !value.direct || !value.control || !Array.isArray(refs) || refs.length > 8 || (selection.nextOffset !== undefined && (!Number.isSafeInteger(selection.nextOffset) || selection.nextOffset < 0))) throw new PersonalError("work_menu_invalid", "后台分析菜单版本或归属无法核实，已停止恢复；请保留档案。");
  for (const ref of refs) await originalWork(tx, ref, value);
}
