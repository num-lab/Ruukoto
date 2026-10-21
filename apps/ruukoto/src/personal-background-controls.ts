import { isDeepStrictEqual } from "node:util";
import type { TaskId, Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { telegramSelection, telegramSourceActive } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc, samePersonalEntry, type TelegramControlInput } from "./personal-telegram-records.ts";
import { PersonalBackgroundDoc, personalBackgroundProcess, personalBackgroundProcesses, personalBackgroundView, type personalBackground } from "./personal-background-processes.ts";

type Manager = ReturnType<typeof personalBackground>;
export type PersonalBackgroundMenu = { kind: "background-list"; ids: string[]; nextOffset?: number } | { kind: "background"; id: string; stream?: "stdout" | "stderr"; nextOffset?: number } | { kind: "background-end" };
export type PersonalBackgroundAction = { id: string; taskId?: TaskId } | { requestId: string; processes: string[] };
const actions = ["/后台", "更多后台", "刷新后台", "后台输出", "后台错误", "下一页后台日志", "停止此后台", "结束本会话后台", "确认结束本会话后台"];
async function original(tx: Tx, id: string, actor: TelegramControlInput) {
  const process = await personalBackgroundProcess(tx, id);
  if (!samePersonalEntry(process.origin.telegram, actor)) throw new PersonalError("background_original_entry_required", "后台属于另一原入口；请从原平台查询，旧入口可用本机管理。");
  return process;
}
export async function personalBackgroundControl(tx: Tx, value: TelegramControlInput, manager?: Manager): Promise<boolean> {
  const choice = /^后台([1-8])$/.exec(value.content);
  if (!choice && !actions.includes(value.content)) return false;
  if (!manager) { value.reply = "会话后台未装配；请停止实例后在 Linux 本机配置固定命令目录。"; return true; }
  if (!value.direct || !await telegramSourceActive(tx, value)) { value.reply = "请由绑定拥有者直接发送 /后台，再回复已送达原菜单选择；转发与引用摘录不能停止后台。"; return true; }
  try {
    const previous = value.content === "/后台" ? undefined : (await telegramSelection(tx, value))?.selection;
    if (value.content === "/后台" || value.content === "更多后台" && previous?.kind === "background-list" && previous.nextOffset !== undefined) {
      const all = (await personalBackgroundProcesses(tx)).filter(process => samePersonalEntry(process.origin.telegram, value)).reverse(), offset = previous?.kind === "background-list" ? previous.nextOffset! : 0, items = all.slice(offset, offset + 8);
      value.selection = { kind: "background-list", ids: items.map(process => process.id), ...(offset + 8 < all.length ? { nextOffset: offset + 8 } : {}) };
      value.reply = `本入口会话后台：\n${items.length ? items.map((process, index) => `后台${index + 1}：${process.command.slice(0, 120)}；${process.state}；停止${process.stopped ? "已核实" : "未核实"}`).join("\n") : "暂无记录"}\n回复本菜单选择${items.length ? `后台1至后台${items.length}、` : ""}${offset + 8 < all.length ? "更多后台、" : ""}结束本会话后台。退出客户端或存档会保留后台。`;
      return true;
    }
    if (value.content === "结束本会话后台") {
      if (previous?.kind !== "background-list" && previous?.kind !== "background") throw new PersonalError("background_menu_stale", "结束须回复原后台菜单，请先发送 /后台。");
      value.selection = { kind: "background-end" }; value.reply = "停止并核实本次涉及的本入口会话后台；会话和历史保留。回复本消息「确认结束本会话后台」，或发送 /后台 返回。"; return true;
    }
    if (value.content === "确认结束本会话后台") {
      if (previous?.kind !== "background-end") throw new PersonalError("background_menu_stale", "确认须回复原结束菜单，没有改变后台。");
      const closure = await manager.closeIn(tx, value.requestId, value); value.backgroundAction = { requestId: value.requestId, processes: closure.processes };
      value.reply = "结束请求已登记；登记不表示停止完成。请发送 /后台 查询停止核实，不能根据停止断言外部写入回滚。"; return true;
    }
    const id = choice ? previous?.kind === "background-list" ? previous.ids[Number(choice[1]) - 1] : undefined : previous?.kind === "background" ? previous.id : undefined;
    if (!id) throw new PersonalError("background_menu_stale", "原后台菜单不可用，请发送 /后台 重新选择。");
    const process = await original(tx, id, value);
    value.selection = { kind: "background", id };
    if (value.content === "停止此后台") {
      if (previous?.kind !== "background") throw new PersonalError("background_menu_stale", "停止须回复原后台详情，没有改变后台。");
      await manager.requestStop(tx, id);
      value.backgroundAction = { id, ...(process.stopTask ? { taskId: process.stopTask } : {}) };
      value.reply = "已登记原后台停止；接纳不代表停止。回复「刷新后台」核实，停止未核实时目录认领保留。"; return true;
    }
    if (!choice && !["刷新后台", "后台输出", "后台错误", "下一页后台日志"].includes(value.content)) throw new PersonalError("background_menu_stale", "请回复原后台菜单刷新或翻页。");
    const stream = value.content === "后台输出" ? "stdout" : value.content === "后台错误" ? "stderr" : previous?.kind === "background" ? previous.stream : undefined;
    const offset = value.content === "下一页后台日志" && previous?.kind === "background" ? previous.nextOffset : 0;
    if (offset === undefined) throw new PersonalError("background_menu_stale", "原菜单没有下一页，请刷新后台。");
    let output = "";
    if (stream) {
      const page = await manager.outputIn(tx, id, stream, offset);
      // IM 正文有界，游标按实际展示字节推进，剩余原页不丢弃。
      const bytes = Buffer.from(page.base64, "base64").subarray(0, 2048), nextOffset = offset + bytes.length;
      value.selection = { kind: "background", id, stream, ...(nextOffset < page.totalBytes ? { nextOffset } : {}) };
      output = `\n${stream}${page.partial ? "（捕获片段）" : ""}；UTF-8预览，原字节可从本机菜单读取：\n${bytes.toString("utf8")}\n`;
    }
    const view = personalBackgroundView(process);
    value.reply = `${view.command.slice(0, 600)}\n${view.state}；停止${view.stopVerified ? "已核实" : "未核实"}；退出码${view.exit?.code ?? "未知"}。退出与停止不证明业务成功或回滚。${output}\n回复本消息选择：刷新后台、后台输出、后台错误${value.selection.kind === "background" && value.selection.nextOffset !== undefined ? "、下一页后台日志" : ""}、停止此后台、结束本会话后台。`;
  } catch (error) { if (!(error instanceof PersonalError)) throw error; delete value.selection; value.reply = `${error.message} 请发送 /后台 查询原记录。`; }
  return true;
}

export async function verifyPersonalBackgroundControls(tx: Tx, keys: string[], enabled: boolean) {
  const invalid = () => new PersonalError("background_control_invalid", "后台原菜单或停止收件无法核实，已停止恢复；请保留档案。");
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt!, menu = value.selection;
    if (!menu?.kind.startsWith("background") && !value.backgroundAction) continue;
    if (!enabled || !value.direct || !value.control) throw invalid();
    const previous = (await telegramSelection(tx, value))?.selection;
    if (menu?.kind === "background-list") { if (value.content !== "/后台" && !(value.content === "更多后台" && previous?.kind === "background-list" && previous.nextOffset !== undefined) || !Array.isArray(menu.ids) || menu.ids.length > 8 || new Set(menu.ids).size !== menu.ids.length) throw invalid(); for (const id of menu.ids) await original(tx, id, value); }
    if (menu?.kind === "background") { await original(tx, menu.id, value); const choice = /^后台([1-8])$/.exec(value.content); if (choice ? previous?.kind !== "background-list" || previous.ids[Number(choice[1]) - 1] !== menu.id : previous?.kind !== "background" || previous.id !== menu.id || !["刷新后台", "后台输出", "后台错误", "下一页后台日志", "停止此后台"].includes(value.content)) throw invalid(); }
    if (menu?.kind === "background-end" && (value.content !== "结束本会话后台" || previous?.kind !== "background-list" && previous?.kind !== "background")) throw invalid();
    if (value.backgroundAction) {
      const action = value.backgroundAction;
      if ("id" in action) { const process = await original(tx, action.id, value); if (value.content !== "停止此后台" || previous?.kind !== "background" || previous.id !== process.id || action.taskId && !process.stopIntents?.some(intent => intent.taskId === action.taskId)) throw invalid(); }
      else { const closure = (await tx.doc(PersonalBackgroundDoc)).closures.find(item => item.requestId === action.requestId); if (value.content !== "确认结束本会话后台" || previous?.kind !== "background-end" || !closure || !isDeepStrictEqual(closure.processes, action.processes) || !samePersonalEntry(closure.actor, value)) throw invalid(); }
    }
  }
}
