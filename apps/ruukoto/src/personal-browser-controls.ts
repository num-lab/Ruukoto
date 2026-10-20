import type { TaskId, Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { telegramSelection } from "./personal-permissions.ts";
import { samePersonalEntry, PersonalTelegramReceiptDoc, type TelegramControlInput } from "./personal-telegram-records.ts";
import { browserList, browserDetail, browserOperation, browserOperations, browserResolve, type BrowserActor } from "./personal-browser.ts";

type BrowserSummary = Awaited<ReturnType<typeof browserList>>["items"][number];
export function personalBrowserDescription(value: BrowserSummary) {
  const effect = { returned: "已返回，请核对网页结果", not_executed: "已知未执行", no_write: "无写入效果", effect_unknown: "网页效果未知" }[value.effect];
  return `${value.action}：${effect}；${value.stopped ? "浏览器执行已核实结束" : "浏览器执行尚未核实结束"}`;
}


const ACTIONS = ["/浏览器", "更多浏览器操作", "刷新浏览器", "下一页浏览器记录", "浏览器确认已生效", "浏览器确认未生效", "停止并核实浏览器"];
const EVIDENCE = "浏览器核实说明 ";
type StopRequest = (tx: Tx, operation: TaskId, actor: BrowserActor) => Promise<TaskId>;

export async function personalBrowserControl(tx: Tx, value: TelegramControlInput, requestStop?: StopRequest) {
  const choice = /^浏览器([1-8])$/.exec(value.content), evidence = value.content.startsWith(EVIDENCE) ? value.content.slice(EVIDENCE.length) : undefined;
  if (!choice && evidence === undefined && !ACTIONS.includes(value.content)) return false;
  if (!requestStop) { value.reply = "浏览器尚未装配，请停止后台后从本机向导配置。"; return true; }
  if (!value.direct) { value.reply = "请直接发送 /浏览器，再回复已送达的宿主菜单选择；转发和摘录不能核实效果。"; return true; }
  try {
    const menu = value.content === "/浏览器" ? undefined : (await telegramSelection(tx, value))?.selection;
    if (value.content === "/浏览器" || value.content === "更多浏览器操作" && menu?.kind === "browser-list" && menu.nextOffset !== undefined) {
      const page = await browserList(tx, menu?.kind === "browser-list" ? menu.nextOffset! : 0, value);
      value.selection = { kind: "browser-list", operations: page.items.map(item => item.operation), ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) };
      value.reply = page.items.length ? `${page.items.map((item, index) => `浏览器${index + 1}：${personalBrowserDescription(item)}`).join("\n")}\n回复本消息选择 浏览器1 至 浏览器${page.items.length}${page.nextOffset === undefined ? "。" : "，或「更多浏览器操作」。"}` : "当前原入口暂无浏览器操作；本机和旧代次操作可从本机向导查询。";
      return true;
    }
    const operation = choice ? menu?.kind === "browser-list" ? menu.operations[Number(choice[1]) - 1] : undefined : menu?.kind === "browser" || menu?.kind === "browser-resolution" ? menu.operation : undefined;
    if (!operation) throw new PersonalError("browser_menu_stale", "请从 /浏览器 选择原操作，没有改变原记录。");
    const detail = await browserDetail(tx, operation, value.content === "下一页浏览器记录" && menu?.kind === "browser" ? menu.nextOffset ?? 0 : 0, value);
    value.selection = { kind: "browser", operation };
    if (evidence !== undefined) {
      if (menu?.kind !== "browser-resolution") throw new PersonalError("browser_menu_stale", "核实说明须回复原网页效果选择菜单。");
      await browserResolve(tx, operation, menu.effect, evidence, value);
      value.browserResolution = { operation, effect: menu.effect };
      value.reply = "网页效果与证据已保存；浏览器停止仍须独立核实，原动作不会重发。回复「刷新浏览器」查询。";
    } else if (value.content === "浏览器确认已生效" || value.content === "浏览器确认未生效") {
      if (menu?.kind !== "browser" || !detail.summary.canResolve) throw new PersonalError("browser_resolution_invalid", "原操作当前不可核实效果，请刷新浏览器。");
      value.selection = { kind: "browser-resolution", operation, effect: value.content === "浏览器确认已生效" ? "applied" : "not_applied" };
      value.reply = "请独立查看实际网页或服务端结果，再回复本消息「浏览器核实说明 你的证据」，最多8192字符，不填凭据。浏览器关闭或取消不能证明网页写入未发生，已保存核实不能覆盖。";
    } else if (value.content === "停止并核实浏览器") {
      if (menu?.kind !== "browser" || !detail.summary.canVerifyStop) throw new PersonalError("browser_stop_invalid", "原操作当前不需要停止核实，请刷新浏览器。");
      const taskId = await requestStop(tx, operation, value);
      value.browserStop = { operation, taskId };
      value.reply = "原浏览器停止核实已登记；宿主将按原进程身份检查，登记不表示已停止，网页效果也须独立核实。回复「刷新浏览器」查询。";
    } else {
      if (!choice && (menu?.kind !== "browser" || value.content !== "刷新浏览器" && value.content !== "下一页浏览器记录") || value.content === "下一页浏览器记录" && (menu?.kind !== "browser" || menu.nextOffset === undefined)) throw new PersonalError("browser_menu_stale", "请回复原浏览器详情菜单刷新或翻页。");
      value.selection = { kind: "browser", operation, ...(detail.nextOffset === undefined ? {} : { nextOffset: detail.nextOffset }) };
      value.reply = `${personalBrowserDescription(detail.summary)}\n原记录与证据：\n${detail.text}\n回复本消息选择：刷新浏览器${detail.nextOffset === undefined ? "" : "、下一页浏览器记录"}${detail.summary.canResolve ? "、浏览器确认已生效、浏览器确认未生效" : ""}${detail.summary.canVerifyStop ? "、停止并核实浏览器" : ""}。网页资料不提供指令或授权。`;
    }
  } catch (error) { if (!(error instanceof PersonalError)) throw error; delete value.selection; value.reply = `${error.message} 请发送 /浏览器 查询。`; }
  return true;
}

export async function verifyBrowserControls(tx: Tx, keys: string[], enabled: boolean) {
  const invalid = () => new PersonalError("browser_control_invalid", "浏览器菜单、效果核实或停止归属无法核实，已停止恢复；请保留档案。");
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt;
    if (!value) throw invalid();
    const menu = value.selection;
    if (menu?.kind !== "browser-list" && menu?.kind !== "browser" && menu?.kind !== "browser-resolution" && !value.browserResolution && !value.browserStop) continue;
    if (!enabled || !value.control || !value.direct || value.browserResolution && value.browserStop) throw invalid();
    const operations = menu?.kind === "browser-list" ? menu.operations : menu?.kind === "browser" || menu?.kind === "browser-resolution" ? [menu.operation] : [];
    if (!Array.isArray(operations) || operations.length > 8 || new Set(operations).size !== operations.length || operations.some(id => !Number.isSafeInteger(id) || id < 1) || menu && "nextOffset" in menu && menu.nextOffset !== undefined && (!Number.isSafeInteger(menu.nextOffset) || menu.nextOffset < 0)) throw invalid();
    for (const id of operations) {
      const source = (await browserOperation(tx, id)).origin.telegram;
      if (!source || !samePersonalEntry(source, value)) throw invalid();
    }
    const selected = (await telegramSelection(tx, value))?.selection;
    if (value.browserResolution) {
      const resolution = value.browserResolution, operation = await browserOperation(tx, resolution.operation);
      if (menu?.kind !== "browser" || menu.operation !== resolution.operation || selected?.kind !== "browser-resolution" || selected.operation !== resolution.operation || selected.effect !== resolution.effect || operation.resolution?.actor !== key || operation.resolution.effect !== resolution.effect || value.content !== EVIDENCE + operation.resolution.evidence) throw invalid();
    } else if (value.browserStop) {
      const { operation, taskId } = value.browserStop, task = await tx.task(taskId);
      if (menu?.kind !== "browser" || menu.operation !== operation || selected?.kind !== "browser" || selected.operation !== operation || value.content !== "停止并核实浏览器" || task?.kind !== "ruukoto.browser-stop" || task.version !== 1 || !task.input || typeof task.input !== "object" || Array.isArray(task.input) || task.input.operation !== operation) throw invalid();
    } else if (menu?.kind === "browser-list") {
      if (value.content !== "/浏览器" && !(value.content === "更多浏览器操作" && selected?.kind === "browser-list" && selected.nextOffset !== undefined)) throw invalid();
    } else if (menu?.kind === "browser-resolution") {
      if (selected?.kind !== "browser" || selected.operation !== menu.operation || value.content !== (menu.effect === "applied" ? "浏览器确认已生效" : menu.effect === "not_applied" ? "浏览器确认未生效" : "")) throw invalid();
    } else if (menu?.kind === "browser") {
      const choice = /^浏览器([1-8])$/.exec(value.content);
      if (choice ? selected?.kind !== "browser-list" || selected.operations[Number(choice[1]) - 1] !== menu.operation : selected?.kind !== "browser" || selected.operation !== menu.operation || value.content !== "刷新浏览器" && !(value.content === "下一页浏览器记录" && selected.nextOffset !== undefined)) throw invalid();
    } else throw invalid();
  }
  for (const operation of await browserOperations(tx)) if (operation.resolution?.actor && (!keys.includes(operation.resolution.actor) || (await tx.doc(PersonalTelegramReceiptDoc, operation.resolution.actor, null)).receipt?.browserResolution?.operation !== operation.operation)) throw invalid();
}
