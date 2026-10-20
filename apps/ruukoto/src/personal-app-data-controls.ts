import { type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { telegramSelection } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc, type TelegramControlInput } from "./personal-telegram-records.ts";
import { appDataDecide, appDataDetail, appDataList, appDataOperation, appDataOperations, appDataOriginal, appDataRecheck } from "./personal-app-data.ts";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { personalControl } from "./personal-control.ts";

const ACTIONS = ["/应用数据", "更多数据操作", "刷新数据操作", "下一页数据原记录", "数据批准本次", "数据拒绝", "重新核实数据回执"];
export function appDataDescription(item: Awaited<ReturnType<typeof appDataList>>["items"][number]) { return `${item.name}${typeof item.table === "string" ? ` ${item.table}` : ""}；${item.decision === "pending" ? "等待原入口批准" : item.decision === "rejected" ? "已拒绝" : item.decision === "approved" ? "本次已批准" : "无需本次批准"}；${item.code}；${item.effect === "committed" ? "已提交" : item.effect === "effect_unknown" ? "效果未知，原工作暂停" : "未提交或尚未执行"}`; }
export async function personalAppDataControl(tx: Tx, value: TelegramControlInput, directory: string): Promise<boolean> {
  const choice = /^数据([1-8])$/.exec(value.content);
  if (!choice && !ACTIONS.includes(value.content)) return false;
  if (!value.direct) { value.reply = "请直接发送 /应用数据，再回复已送达的宿主菜单选择；转发和引用摘录不提供决定。"; return true; }
  try {
    const selected = value.content === "/应用数据" ? undefined : (await telegramSelection(tx, value))?.selection;
    if (value.content === "/应用数据" || value.content === "更多数据操作" && selected?.kind === "app-data-list" && selected.nextOffset !== undefined) {
      const page = await appDataList(tx, selected?.kind === "app-data-list" ? selected.nextOffset! : 0, value);
      value.selection = { kind: "app-data-list", operations: page.items.map(item => item.operation), ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) };
      value.reply = page.items.length ? `原入口应用数据操作：\n${page.items.map((item, i) => `数据${i + 1}：${appDataDescription(item)}`).join("\n")}\n回复本消息选择 数据1 至 数据${page.items.length}${page.nextOffset === undefined ? "。" : "，或「更多数据操作」。"}` : "当前原入口没有应用数据写操作；本机或旧代次记录从本机向导查询。";
      return true;
    }
    const operation = choice ? selected?.kind === "app-data-list" ? selected.operations[Number(choice[1]) - 1] : undefined : selected?.kind === "app-data" ? selected.operation : undefined;
    if (!operation) throw new PersonalError("app_data_menu_stale", "没有改变操作，请从 /应用数据 选择原记录。");
    await appDataOriginal(tx, operation, value);
    const terminal = (await tx.task(operation))?.state.status === "terminal";
    if (value.content === "数据批准本次" || value.content === "数据拒绝") {
      if (selected?.kind !== "app-data") throw new PersonalError("app_data_menu_stale", "批准或拒绝须回复原详情菜单。");
      const decision = value.content === "数据批准本次" ? "approved" : "rejected";
      await appDataDecide(tx, directory, operation, decision, value); value.appDataDecision = { operation, decision };
    } else if (value.content === "重新核实数据回执") {
      await appDataRecheck(tx, directory, operation); value.appDataRecheck = { operation };
    } else if (!choice && (selected?.kind !== "app-data" || !["刷新数据操作", "下一页数据原记录"].includes(value.content) || value.content === "下一页数据原记录" && selected.nextOffset === undefined)) throw new PersonalError("app_data_menu_stale", "请回复原详情菜单刷新或继续读取。");
    const detail = await appDataDetail(tx, operation, value.content === "下一页数据原记录" && selected?.kind === "app-data" ? selected.nextOffset! : 0), current = await appDataOperation(tx, operation);
    value.selection = { kind: "app-data", operation, ...(detail.nextOffset === undefined ? {} : { nextOffset: detail.nextOffset }) };
    value.reply = `${detail.text}\n批准仅登记本次决定，不表示执行成功。回复本消息：刷新数据操作${detail.nextOffset === undefined ? "" : "、下一页数据原记录"}${current.decision === "pending" && !current.result && !current.started ? "、数据批准本次、数据拒绝" : ""}${current.started && (!current.result || current.result.effect === "effect_unknown") && terminal ? "、重新核实数据回执" : ""}。缺库/换库/坏回执须保留档案并恢复可信原库；核实只读原回执，不重发修改。`;
  } catch (error) { if (!(error instanceof PersonalError)) throw error; delete value.selection; value.reply = `${error.message} 请发送 /应用数据 查询原操作。`; }
  return true;
}
export async function verifyAppDataControls(tx: Tx, keys: string[]) {
  const invalid = () => new PersonalError("app_data_control_invalid", "应用数据宿主菜单或原决定不符，已停止恢复；请保留档案。");
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt!;
    const menu = value.selection;
    if (menu?.kind !== "app-data-list" && menu?.kind !== "app-data" && !value.appDataDecision && !value.appDataRecheck) continue;
    if (!value.control || !value.direct || value.appDataDecision && value.appDataRecheck) throw invalid();
    const operations = menu?.kind === "app-data-list" ? menu.operations : menu?.kind === "app-data" ? [menu.operation] : [];
    if (!Array.isArray(operations) || operations.length > 8 || new Set(operations).size !== operations.length || menu && "nextOffset" in menu && menu.nextOffset !== undefined && (!Number.isSafeInteger(menu.nextOffset) || menu.nextOffset < 0)) throw invalid();
    for (const id of operations) await appDataOriginal(tx, id, value, false);
    const selected = (await telegramSelection(tx, value))?.selection;
    if (value.appDataDecision || value.appDataRecheck) {
      const id = (value.appDataDecision ?? value.appDataRecheck)!.operation;
      if (menu?.kind !== "app-data" || menu.operation !== id || selected?.kind !== "app-data" || selected.operation !== id) throw invalid();
      const op = await appDataOperation(tx, id);
      if (value.appDataDecision ? op.actor !== key || op.decision !== value.appDataDecision.decision || value.content !== (value.appDataDecision.decision === "approved" ? "数据批准本次" : "数据拒绝") : value.content !== "重新核实数据回执") throw invalid();
    } else if (menu?.kind === "app-data-list") { if (value.content !== "/应用数据" && !(value.content === "更多数据操作" && selected?.kind === "app-data-list" && selected.nextOffset !== undefined)) throw invalid(); }
    else if (menu?.kind === "app-data") { const choice = /^数据([1-8])$/.exec(value.content); if (choice ? selected?.kind !== "app-data-list" || selected.operations[Number(choice[1]) - 1] !== menu.operation : selected?.kind !== "app-data" || selected.operation !== menu.operation || value.content !== "刷新数据操作" && !(value.content === "下一页数据原记录" && selected.nextOffset !== undefined)) throw invalid(); }
    else throw invalid();
  }
  for (const op of await appDataOperations(tx)) if (op.actor) { const receipt = (await tx.doc(PersonalTelegramReceiptDoc, op.actor, null)).receipt; if (!keys.includes(op.actor) || receipt?.appDataDecision?.operation !== op.operation || receipt.appDataDecision.decision !== op.decision) throw invalid(); }
}
export async function managePersonalAppData(io: PersonalCliIO, directory: string) {
  let offset = 0;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<typeof appDataList>>>(directory, "GET", `/app-data/operations?offset=${offset}`);
    const index = await choose(io, "应用数据原操作", [...page.items.map(appDataDescription), ...(page.nextOffset === undefined ? [] : ["下一页"]), "返回"]);
    if (index === page.items.length && page.nextOffset !== undefined) { offset = page.nextOffset; continue; }
    if (index >= page.items.length) return;
    const item = page.items[index]; let cursor = 0;
    while (true) { const detail = await personalControl<Awaited<ReturnType<typeof appDataDetail>>>(directory, "GET", `/app-data/operation?operation=${item.operation}&offset=${cursor}`); io.write(`${detail.text}\n`); if (detail.nextOffset === undefined || await choose(io, "原记录", ["继续读取", "结束读取"]) === 1) break; cursor = detail.nextOffset; }
    const actions = ["返回列表", ...(item.canDecide ? ["批准本次", "拒绝"] : []), ...(item.canRecheck ? ["恢复原库后重新核实回执"] : [])], action = actions[await choose(io, "原操作", actions)];
    if (action === "返回列表") continue;
    if (action === "批准本次" || action === "拒绝") await personalControl(directory, "POST", `/app-data/decide?operation=${item.operation}`, { decision: action === "批准本次" ? "approved" : "rejected" });
    else await personalControl(directory, "POST", `/app-data/recheck?operation=${item.operation}`);
    io.write("原操作记录已更新，请刷新列表核实结果；回执核实不重发修改。\n");
  }
}
