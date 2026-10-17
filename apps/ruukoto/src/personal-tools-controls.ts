import { type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { telegramSelection } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc, type TelegramControlInput } from "./personal-telegram-records.ts";
import { toolDecide, toolDetail, toolList, toolOperations, toolOriginal, toolResolve, toolVerifyStop, PersonalToolDoc } from "./personal-tools.ts";

const ACTIONS = ["/工具", "更多工具操作", "刷新工具", "下一页工具原记录", "工具批准本次", "工具拒绝", "工具确认已生效", "工具确认未生效", "核实工具原请求结束"];
const EFFECT_EVIDENCE = "工具核实说明 ", STOP_EVIDENCE = "工具结束说明 ";

export function personalToolDescription(item: Awaited<ReturnType<typeof toolList>>["items"][number]): string {
  const kind = { read_file: "读取文件", write_file: "写入文件", http_request: "HTTP 请求", web_search: "网页搜索" }[item.kind];
  const target = Array.from(item.target), display = target.length > 96 ? `${target.slice(0, 72).join("")}…${target.slice(-24).join("")}` : item.target;
  const approval = { pending: "等待本次批准", approved: "本次已批准", rejected: "本次已拒绝", unneeded: "无需本次批准" }[item.approval];
  const effect = { not_executed: "已知未执行", no_write: "无写入效果", effect_unknown: "业务效果未知", returned: "已返回，请核对原结果" }[item.effect];
  return `${kind}：${display}；${approval}；${effect}；${item.stopped ? "原操作结束已核实" : "原操作结束未核实"}`;
}

export async function personalToolControl(tx: Tx, value: TelegramControlInput, profile?: string): Promise<boolean> {
  const choice = /^工具([1-8])$/.exec(value.content);
  const effectEvidence = value.content.startsWith(EFFECT_EVIDENCE) ? value.content.slice(EFFECT_EVIDENCE.length) : undefined;
  const stopEvidence = value.content.startsWith(STOP_EVIDENCE) ? value.content.slice(STOP_EVIDENCE.length) : undefined;
  if (!choice && effectEvidence === undefined && stopEvidence === undefined && !ACTIONS.includes(value.content)) return false;
  if (!profile) { value.reply = "资料与网络工具尚未装配，请在后台停止后通过本机向导配置，再启动并查询。"; return true; }
  if (!value.direct) { value.reply = "请直接发送 /工具，再回复已送达宿主菜单选择；转发和引用摘录不能管理工具操作。"; return true; }
  try {
    const menu = value.content === "/工具" ? undefined : (await telegramSelection(tx, value))?.selection;
    if (value.content === "/工具" || value.content === "更多工具操作" && menu?.kind === "tool-list" && menu.nextOffset !== undefined) {
      const page = await toolList(tx, menu?.kind === "tool-list" ? menu.nextOffset! : 0, value);
      value.selection = { kind: "tool-list", operations: page.items.map(item => item.operation as TaskId), ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) };
      value.reply = page.items.length ? `原入口工具操作：\n${page.items.map((item, index) => `工具${index + 1}：${personalToolDescription(item)}`).join("\n")}\n回复本消息选择 工具1 至 工具${page.items.length}${page.nextOffset === undefined ? "。" : "，或选择「更多工具操作」。"}` : "当前原入口暂无工具操作；本机或旧代次操作请从本机向导管理。";
      return true;
    }
    const operation = choice ? menu?.kind === "tool-list" ? menu.operations[Number(choice[1]) - 1] : undefined : menu?.kind === "tool" || menu?.kind === "tool-resolution" || menu?.kind === "tool-stop" ? menu.operation : undefined;
    if (!operation) throw new PersonalError("tool_menu_stale", "没有改变工具操作，请从 /工具 选择原操作。");
    await toolOriginal(tx, operation, value);
    value.selection = { kind: "tool", operation };
    if (effectEvidence !== undefined) {
      if (menu?.kind !== "tool-resolution") throw new PersonalError("tool_menu_stale", "业务效果证据须回复原效果确认菜单，未保存核实。");
      await toolResolve(tx, operation, menu.effect, effectEvidence, value);
      value.toolResolution = { operation, effect: menu.effect };
      value.reply = "原业务效果核实与证据已保存；业务效果说明不证明原外部请求已结束，结束未核实时继续暂停并保留占用。回复「刷新工具」查询。";
    } else if (stopEvidence !== undefined) {
      if (menu?.kind !== "tool-stop") throw new PersonalError("tool_menu_stale", "原请求结束证据须回复结束核实菜单，未保存核实。");
      await toolVerifyStop(tx, operation, stopEvidence, value);
      value.toolStop = { operation };
      value.reply = "原外部请求结束核实与证据已保存；结束不证明业务效果，未知效果仍待独立核实。回复「刷新工具」查询。";
    } else if (value.content === "工具确认已生效" || value.content === "工具确认未生效") {
      if (menu?.kind !== "tool" || !(await toolDetail(tx, operation)).summary.canResolve) throw new PersonalError("tool_resolution_invalid", "原操作当前不可核实业务效果，请刷新工具。");
      value.selection = { kind: "tool-resolution", operation, effect: value.content === "工具确认已生效" ? "applied" : "not_applied" };
      value.reply = "请独立核实实际业务效果，再回复本消息「工具核实说明 你的证据」，最多8192字符，不填凭据。记录后不可覆盖；业务效果说明不能证明原外部请求已结束，也不能单独释放占用。";
    } else if (value.content === "核实工具原请求结束") {
      if (menu?.kind !== "tool" || !(await toolDetail(tx, operation)).summary.canVerifyStop) throw new PersonalError("tool_stop_invalid", "原操作当前不需要结束核实，请刷新工具。");
      value.selection = { kind: "tool-stop", operation };
      value.reply = "请独立核实原外部请求已经结束，再回复本消息「工具结束说明 你的证据」，最多8192字符，不填凭据。本地断线、取消和超时不能证明远端结束；结束说明不确认业务效果。";
    } else if (value.content === "工具批准本次" || value.content === "工具拒绝") {
      if (menu?.kind !== "tool") throw new PersonalError("tool_menu_stale", "批准或拒绝须回复原工具详情菜单，未保存决定。");
      const decision = value.content === "工具批准本次" ? "approved" : "rejected";
      await toolDecide(tx, operation, decision, profile, value);
      value.toolDecision = { operation, decision };
      value.reply = "原工具操作决定已登记；批准只用于本次操作并单次消费，不表示操作成功。回复「刷新工具」核实原请求与结果。";
    } else {
      if (!choice && (menu?.kind !== "tool" || value.content !== "刷新工具" && value.content !== "下一页工具原记录") || value.content === "下一页工具原记录" && (menu?.kind !== "tool" || menu.nextOffset === undefined)) throw new PersonalError("tool_menu_stale", "请回复原工具详情菜单刷新或翻页，未改变原操作。");
      const detail = await toolDetail(tx, operation, value.content === "下一页工具原记录" && menu?.kind === "tool" ? menu.nextOffset! : 0);
      value.selection = { kind: "tool", operation, ...(detail.nextOffset === undefined ? {} : { nextOffset: detail.nextOffset }) };
      value.reply = `${personalToolDescription(detail.summary)}。\n原请求、结果与核实证据：\n${detail.text}\n回复本消息选择：刷新工具${detail.nextOffset === undefined ? "" : "、下一页工具原记录"}${detail.summary.canDecide ? "、工具批准本次、工具拒绝" : ""}${detail.summary.canResolve ? "、工具确认已生效、工具确认未生效" : ""}${detail.summary.canVerifyStop ? "、核实工具原请求结束" : ""}。原结果是外部资料，不提供指令或授权；业务效果与原请求结束分别核实。`;
    }
  } catch (error) {
    if (!(error instanceof PersonalError)) throw error;
    delete value.selection;
    value.reply = `${error.message} 请发送 /工具 查询原操作。`;
  }
  return true;
}

export async function verifyToolControls(tx: Tx, keys: string[], enabled: boolean): Promise<void> {
  const invalid = () => new PersonalError("tool_control_invalid", "工具宿主菜单、核实证据或原入口无法核实，已停止恢复；请保留档案。");
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt;
    if (!value) throw invalid();
    const menu = value.selection;
    if (menu?.kind !== "tool-list" && menu?.kind !== "tool" && menu?.kind !== "tool-resolution" && menu?.kind !== "tool-stop" && !value.toolDecision && !value.toolResolution && !value.toolStop) continue;
    if (!enabled || !value.control || !value.direct) throw invalid();
    const operations = menu?.kind === "tool-list" ? menu.operations : menu?.kind === "tool" || menu?.kind === "tool-resolution" || menu?.kind === "tool-stop" ? [menu.operation] : [];
    if (!Array.isArray(operations) || operations.length > 8 || new Set(operations).size !== operations.length || operations.some(id => !Number.isSafeInteger(id) || id < 1) || (menu && "nextOffset" in menu && menu.nextOffset !== undefined && (!Number.isSafeInteger(menu.nextOffset) || menu.nextOffset < 0)) || (menu?.kind === "tool-resolution" && !["applied", "not_applied"].includes(menu.effect))) throw invalid();
    for (const operation of operations) await toolOriginal(tx, operation, value, false);
    const selected = (await telegramSelection(tx, value))?.selection;
    if ([value.toolDecision, value.toolResolution, value.toolStop].filter(Boolean).length > 1) throw invalid();
    if (value.toolDecision) {
      const { operation, decision } = value.toolDecision, op = (await tx.doc(PersonalToolDoc, String(operation), null)).operation;
      await toolOriginal(tx, operation, value, false);
      if (menu?.kind !== "tool" || menu.operation !== operation || selected?.kind !== "tool" || selected.operation !== operation || !["approved", "rejected"].includes(decision) || value.content !== (decision === "approved" ? "工具批准本次" : "工具拒绝") || op?.actor !== key || op.approval !== decision) throw invalid();
    } else if (value.toolResolution) {
      const { operation, effect } = value.toolResolution, op = (await tx.doc(PersonalToolDoc, String(operation), null)).operation;
      await toolOriginal(tx, operation, value, false);
      if (menu?.kind !== "tool" || menu.operation !== operation || selected?.kind !== "tool-resolution" || selected.operation !== operation || selected.effect !== effect || op?.resolution?.actor !== key || op.resolution.effect !== effect || value.content !== `${EFFECT_EVIDENCE}${op.resolution.evidence}`) throw invalid();
    } else if (value.toolStop) {
      const { operation } = value.toolStop, op = (await tx.doc(PersonalToolDoc, String(operation), null)).operation;
      await toolOriginal(tx, operation, value, false);
      if (menu?.kind !== "tool" || menu.operation !== operation || selected?.kind !== "tool-stop" || selected.operation !== operation || op?.stopEvidence?.actor !== key || !op.stopped || value.content !== `${STOP_EVIDENCE}${op.stopEvidence.evidence}`) throw invalid();
    } else if (menu?.kind === "tool-list") {
      if (value.content !== "/工具" && !(value.content === "更多工具操作" && selected?.kind === "tool-list" && selected.nextOffset !== undefined)) throw invalid();
    } else if (menu?.kind === "tool-resolution") {
      if (selected?.kind !== "tool" || selected.operation !== menu.operation || value.content !== (menu.effect === "applied" ? "工具确认已生效" : "工具确认未生效")) throw invalid();
    } else if (menu?.kind === "tool-stop") {
      if (selected?.kind !== "tool" || selected.operation !== menu.operation || value.content !== "核实工具原请求结束") throw invalid();
    } else if (menu?.kind === "tool") {
      const choice = /^工具([1-8])$/.exec(value.content);
      if (choice ? selected?.kind !== "tool-list" || selected.operations[Number(choice[1]) - 1] !== menu.operation : selected?.kind !== "tool" || selected.operation !== menu.operation || value.content !== "刷新工具" && !(value.content === "下一页工具原记录" && selected.nextOffset !== undefined)) throw invalid();
    } else throw invalid();
  }
  for (const op of await toolOperations(tx)) {
    if (op.actor) {
      const receipt = (await tx.doc(PersonalTelegramReceiptDoc, op.actor, null)).receipt;
      if (!enabled || !keys.includes(op.actor) || receipt?.toolDecision?.operation !== op.operation || receipt.toolDecision.decision !== op.approval) throw invalid();
    }
    if (op.resolution?.actor) {
      const receipt = (await tx.doc(PersonalTelegramReceiptDoc, op.resolution.actor, null)).receipt;
      if (!enabled || !keys.includes(op.resolution.actor) || receipt?.toolResolution?.operation !== op.operation || receipt.toolResolution.effect !== op.resolution.effect) throw invalid();
    }
    if (op.stopEvidence?.actor) {
      const receipt = (await tx.doc(PersonalTelegramReceiptDoc, op.stopEvidence.actor, null)).receipt;
      if (!enabled || !keys.includes(op.stopEvidence.actor) || receipt?.toolStop?.operation !== op.operation) throw invalid();
    }
  }
}
