import { defineExtension, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { telegramSelection } from "./personal-permissions.ts";
import { appendPersonalWork, closePersonalWorkAgent, listPersonalWorks, PersonalWorkDoc, personalWorkRef, personalWorkResult, personalWorkSummary, requestPersonalWorkCancel, type PersonalWorkSummary, type PersonalWorkRef } from "./personal-work.ts";
import type { TelegramControlInput, TelegramReceipt } from "./personal-telegram-records.ts";
import { cancelPersonalDelegation, listPersonalDelegations, personalDelegation, personalDelegationProgress, type PersonalDelegationRef } from "./personal-delegation.ts";
import { personalReportResult } from "./personal-report.ts";

export const personalWorkControls = defineExtension({ name: "personal-work-controls" });
const ACTIONS = ["/工作", "更多分析", "刷新分析", "查看结果", "下一页结果", "取消这项分析", "关闭此身份"];

export function personalWorkDescription(value: PersonalWorkSummary) {
  const states: Record<string, string> = { pending: "等待执行", running: "执行中", waiting: "等待处理", completing: "正在收尾", completed: "已完成", failed: "未成功完成", aborted: "已取消", faulted: "异常停止，停止尚未核实", orphaned: "执行归属异常，停止尚未核实" };
  return `${value.label}：${value.content}；${states[value.state] ?? "状态无法核实"}${value.cancelRequested && !value.stopVerified ? "；已请求取消，停止待核实" : ""}${value.stopVerified ? "；停止已核实" : ""}${value.notes ? `；已接纳 ${value.notes} 条追加说明` : ""}${value.closed ? "；身份已关闭" : ""}`;
}

async function originalWork(tx: Tx, ref: PersonalWorkRef, value: TelegramControlInput) {
  const actual = await personalWorkRef(tx, ref.taskId);
  const source = (await tx.doc(PersonalWorkDoc, actual.requestId, null)).telegram;
  if (actual.requestId !== ref.requestId || actual.agentId !== ref.agentId || source?.botId !== value.botId || source.ownerId !== value.ownerId || source.generation !== value.generation) throw new PersonalError("work_original_entry_required", "此分析不属于原拥有者入口，请重新发送 /工作 查询；没有改变工作。");
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-work-controls.md
export async function telegramWorkControl(tx: Tx, value: TelegramControlInput): Promise<boolean> {
  const choice = /^分析([1-8])$/.exec(value.content);
  if (!choice && !ACTIONS.includes(value.content) && !value.content.startsWith("补充：")) return false;
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
    if (value.content.startsWith("补充：")) {
      await appendPersonalWork(tx, ref, { requestId: value.requestId, content: value.content.slice(3), source: { kind: "telegram" } });
      value.reply = "原分析已接纳说明，将在当前回答结束后按顺序处理；原权限保持。回复「刷新分析」查询状态。";
    } else if (value.content === "取消这项分析") {
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
    } else value.reply = `${personalWorkDescription(await personalWorkSummary(tx, ref))}。回复本消息选择：刷新分析、查看结果、取消这项分析、关闭此身份；追加说明请回复「补充：正文」，在当前回答结束后处理。关闭只适用未再复用且空闲的身份。`;
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

export function personalDelegationDescription(value: Pick<Awaited<ReturnType<typeof personalDelegationProgress>>, "content" | "total" | "active" | "unverified" | "state" | "paused" | "report">) {
  const states: Record<string, string> = { active: "分析中", idle: "分析空闲，可继续原委托；尚未安排汇总", reporting: "已封组，等待成员或主 Agent 汇总", reported: "报告处理已结束，请核对送达状态", report_failed: "报告未完成，请查看原报告状态", canceling: "取消已登记，正在核实停止", canceled: "整项分析已取消，停止已核实", stop_unverified: "停止尚未核实，请检查原工作", paused: "服务效果待核实，分析委托暂停" };
  return `${value.content}；${states[value.state] ?? "状态无法核实"}；共 ${value.total} 项，活动 ${value.active} 项，停止未核实 ${value.unverified} 项${value.paused && value.state !== "paused" ? "；原服务效果待核实" : ""}${value.report ? `；${personalReportDelivery(value.report.delivery)}` : ""}`;
}

export function personalReportDelivery(delivery: string) {
  return ({ not_requested: "尚未安排最终汇总", waiting: "报告等待中", local: "完整报告已保存本机", pending: "报告等待发送", sending: "报告发送已开始，结果待核实", sent: "报告已送达原入口", failed: "报告明确未发送，请查询原报告", effect_unknown: "报告发送效果未知，未自动重发；请在原平台核实", canceled: "报告已取消；已开始的发送另按原效果记录", blocked: "停止未核实，报告未生成", unanswered: "主 Agent 未完成报告，未外发；请查看原委托" } as Record<string, string>)[delivery] ?? "报告状态无法核实，请保留档案";
}

async function originalDelegation(tx: Tx, ref: PersonalDelegationRef, input: TelegramControlInput) {
  const source = (await personalDelegation(tx, ref)).telegram;
  if (source?.botId !== input.botId || source.ownerId !== input.ownerId || source.generation !== input.generation) throw new PersonalError("delegation_original_entry", "委托不属于原拥有者入口，未改变工作；请发送 /委托 查询。");
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-analysis-delegations.md
export async function telegramDelegationControl(tx: Tx, value: TelegramControlInput): Promise<boolean> {
  const choice = /^委托([1-8])$/.exec(value.content);
  if (!choice && !["/委托", "更多委托", "刷新委托", "下一页分析", "取消整项分析", "查看报告", "下一页报告"].includes(value.content)) return false;
  if (!value.direct) { value.reply = "请直接发送 /委托，再回复已送达宿主菜单；转发和引用摘录不能控制委托。"; return true; }
  try {
    const menu = value.content === "/委托" ? undefined : (await telegramSelection(tx, value))?.selection;
    if (value.content === "/委托" || (value.content === "更多委托" && menu?.kind === "delegation-list" && menu.nextOffset !== undefined)) {
      const offset = menu?.kind === "delegation-list" ? menu.nextOffset! : 0;
      const page = await listPersonalDelegations(tx, offset, value);
      value.selection = { kind: "delegation-list", refs: page.items.map(item => item.ref), ...(page.more ? { nextOffset: offset + 8 } : {}) };
      value.reply = page.items.length ? `分析委托：\n${page.items.map((item, i) => `委托${i + 1}：${personalDelegationDescription(item)}`).join("\n")}\n回复本消息选择委托1至委托${page.items.length}${page.more ? "，或选择「更多委托」。" : "。"}` : "原入口暂无分析委托；历史单项分析仍可通过 /工作 查询。";
      return true;
    }
    const ref = choice && menu?.kind === "delegation-list" ? menu.refs[Number(choice[1]) - 1] : menu?.kind === "delegation" ? menu.ref : undefined;
    if (!ref || (value.content === "下一页分析" && (menu?.kind !== "delegation" || menu.nextOffset === undefined))) { value.reply = "没有改变委托。请发送 /委托，再回复已送达宿主菜单选择列出的动作。"; return true; }
    await originalDelegation(tx, ref, value);
    if (value.content === "查看报告" || value.content === "下一页报告") {
      if (value.content === "下一页报告" && (menu?.kind !== "delegation" || menu.reportNextOffset === undefined)) { value.reply = "当前菜单没有下一页报告，请回复「查看报告」从头读取。"; return true; }
      const report = await personalReportResult(tx, ref, value.content === "下一页报告" && menu?.kind === "delegation" ? menu.reportNextOffset! : 0, 2400);
      value.selection = { kind: "delegation", ref, ...(report.nextOffset === undefined ? {} : { reportNextOffset: report.nextOffset }) };
      value.reply = `${personalReportDelivery(report.delivery)}。${report.text === undefined ? "" : `\n${report.text || "（无文本内容）"}`}${report.nextOffset === undefined ? "\n回复「刷新委托」查询成员。" : "\n回复「下一页报告」继续。"}`;
      return true;
    }
    const offset = value.content === "下一页分析" && menu?.kind === "delegation" ? menu.nextOffset! : 0;
    const progress = await personalDelegationProgress(tx, ref, offset);
    if (value.content === "取消整项分析") {
      await cancelPersonalDelegation(tx, ref);
      progress.cancelRequested = true;
      progress.state = progress.unverified ? "stop_unverified" : progress.active ? "canceling" : "canceled";
    }
    value.selection = { kind: "delegation", ref, ...(progress.nextOffset === undefined ? {} : { nextOffset: progress.nextOffset }) };
    value.reply = `${personalDelegationDescription(progress)}。\n${progress.members.map(personalWorkDescription).join("\n")}\n回复本消息选择：刷新委托、查看报告、取消整项分析${progress.nextOffset === undefined ? "" : "、下一页分析"}。取消覆盖所属分析成员及尚未开始的最终回报，不关闭身份，不包含服务等外部操作。封组后不能续派或追加；未封组时单项结果与追加说明请发送 /工作 选择。`;
  } catch (error) {
    if (!(error instanceof PersonalError)) throw error;
    delete value.selection;
    value.reply = `${error.message} 请发送 /委托 查询。`;
  }
  return true;
}

export async function verifyDelegationMenu(tx: Tx, value: TelegramReceipt, enabled: boolean) {
  const menu = value.selection;
  if (menu?.kind !== "delegation" && menu?.kind !== "delegation-list") return;
  const refs = menu.kind === "delegation" ? [menu.ref] : menu.refs;
  if (!enabled || !value.direct || !value.control || !Array.isArray(refs) || refs.length > 8 || (menu.nextOffset !== undefined && (!Number.isSafeInteger(menu.nextOffset) || menu.nextOffset < 0))) throw new PersonalError("delegation_menu_invalid", "分析委托菜单版本或来源不符，已停止恢复；请保留档案。");
  if (menu.kind === "delegation" && menu.reportNextOffset !== undefined && (!Number.isSafeInteger(menu.reportNextOffset) || menu.reportNextOffset < 0)) throw new PersonalError("delegation_menu_invalid", "委托报告分页不符，已停止恢复；请保留档案。");
  for (const ref of refs) await originalDelegation(tx, ref, value);
}
