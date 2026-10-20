import { isDeepStrictEqual } from "node:util";
import { AgentDoc, defineExtension, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { personalPermissionFor, telegramSelection, telegramSourceActive } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc, samePersonalEntry, type TelegramControlInput } from "./personal-telegram-records.ts";
import { personalCommand, personalCommandsIn, resolvePersonalCommand, type PersonalCommandRef, type personalCommandWork } from "./personal-command-work.ts";

export const personalOwnerControls = defineExtension({ name: "personal-owner-controls" });
const ACTIONS = ["/命令", "更多命令", "刷新命令", "下一页命令记录", "查看命令输出", "查看命令错误", "命令确认已生效", "命令确认未生效", "核实命令停止"];
const EVIDENCE = "命令核实说明 ";
type Commands = ReturnType<typeof personalCommandWork>;

async function original(tx: Tx, ref: PersonalCommandRef, actor: TelegramControlInput, active = true) {
  const op = await personalCommand(tx, ref);
  if (!samePersonalEntry(op.work.telegram, actor) || active && !await telegramSourceActive(tx, actor)) throw new PersonalError("command_original_entry_required", "请从原平台、账号与当前绑定入口查询原命令；旧入口可用本机向导核实。");
  return op;
}
const description = (op: Awaited<ReturnType<typeof personalCommand>>) => `${op.command.slice(0, 120)}；${op.result?.effect === "effect_unknown" ? "业务效果未知" : op.result?.effect === "returned" ? `运行返回，退出码 ${op.result.exitCode}` : op.result?.effect === "not_executed" ? "已知未执行" : "结果尚未核实"}；停止${op.stopped ? "已核实" : "未核实"}${op.resolution ? `；业务${op.resolution.effect === "applied" ? "已生效" : "未生效"}已核实` : ""}`;

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-local-management.md
// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-durable-commands.md
export async function personalOwnerControl(tx: Tx, value: TelegramControlInput, commands?: Commands): Promise<boolean> {
  if (value.content === "/帮助" || value.content === "/状态") {
    if (!value.direct) { value.reply = "请由绑定拥有者直接发送 /帮助 或 /状态。"; return true; }
    if (value.content === "/帮助") value.reply = "拥有者操作：\n/状态 查看当前模式与能力；/权限 切换以后新输入的默认模式。\n/工作 单项分析；/委托 整项进度、报告与取消；/定时 创建、查看与取消计划。\n/审批 服务审批；/授权 查看与撤销长期服务授权；/服务核实、/检查、/命令、/MCP、/工具、/浏览器、/应用数据 查看原操作与适用审批/核实。\n直接发送查询命令，再回复已送达宿主菜单选择；普通聊天、转发与引用摘录不能授权。批准不表示成功，效果与停止分别核实；应答丢失先查询原记录。\n模型、凭据、入口配对、技能与能力配置用本机引导式 CLI，配置前停止后台；资料授权、记忆与历史也有本机菜单。聊天可要求管理记忆、查询历史，显式技能用 /skill:名称 参数。";
    else {
      const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID), permission = await personalPermissionFor(tx, value);
      const tools = Array.isArray(agent.tools) ? agent.tools : [];
      value.reply = `当前入口新输入默认模式：${{ "auto-review": "自动审查", confirm: "请求确认", full_access: "完全访问" }[permission.mode]}；已有工作保持原权限。\n已配置模型：${agent.model?.modelId ?? "无法核实"}。\n${[["命令", !!commands], ["MCP", tools.includes("mcp_call")], ["资料与网络", tools.includes("read_file")], ["浏览器", tools.includes("browser")], ["服务", tools.includes("service_inspect")]].map(([name, enabled]) => `${name}：${enabled ? "已装配" : "未装配"}`).join("；")}。装配不证明外部服务可用；具体效果与停止请从 /帮助 列出的原操作菜单查询。`;
    }
    return true;
  }
  const choice = /^命令([1-8])$/.exec(value.content), evidence = value.content.startsWith(EVIDENCE) ? value.content.slice(EVIDENCE.length) : undefined;
  if (!choice && evidence === undefined && !ACTIONS.includes(value.content)) return false;
  if (!commands) { value.reply = "命令能力未装配，请停止后台后在 Linux 本机向导配置专用目录。"; return true; }
  if (!value.direct) { value.reply = "请直接发送 /命令，再回复已送达宿主菜单选择；转发和引用摘录不能核实命令。"; return true; }
  try {
    const menu = value.content === "/命令" ? undefined : (await telegramSelection(tx, value))?.selection;
    if (value.content === "/命令" || value.content === "更多命令" && menu?.kind === "command-list" && menu.nextOffset !== undefined) {
      const all = (await personalCommandsIn(tx)).filter(op => samePersonalEntry(op.work.telegram, value)).reverse();
      const offset = menu?.kind === "command-list" ? menu.nextOffset! : 0, items = all.slice(offset, offset + 8);
      value.selection = { kind: "command-list", refs: items.map(op => ({ ...op.ref })), ...(offset + 8 < all.length ? { nextOffset: offset + 8 } : {}) };
      value.reply = items.length ? `原入口命令：\n${items.map((op, index) => `命令${index + 1}：${description(op)}`).join("\n")}\n回复本消息选择命令1至命令${items.length}${offset + 8 < all.length ? "，或更多命令" : ""}。` : "原入口暂无命令；本机或旧代次操作请从本机向导查询。";
      return true;
    }
    const ref = choice ? menu?.kind === "command-list" ? menu.refs[Number(choice[1]) - 1] : undefined : menu?.kind === "command" || menu?.kind === "command-resolution" ? menu.ref : undefined;
    if (!ref) throw new PersonalError("command_menu_stale", "没有改变原命令，请从 /命令 重新选择。");
    const op = await original(tx, ref, value);
    value.selection = { kind: "command", ref, view: "record" };
    if (evidence !== undefined) {
      if (menu?.kind !== "command-resolution") throw new PersonalError("command_menu_stale", "核实证据须回复原效果确认菜单，未保存。");
      await resolvePersonalCommand(tx, ref, menu.effect, evidence, value.requestId);
      value.commandResolution = { ref, effect: menu.effect };
      value.reply = "原命令业务效果证据已保存，不可覆盖；停止仍须分别核实。回复「刷新命令」查询；不会重新执行命令。";
    } else if (value.content === "命令确认已生效" || value.content === "命令确认未生效") {
      if (menu?.kind !== "command" || !(await commands.detailIn(tx, ref, "stdout")).canResolve) throw new PersonalError("command_resolution_invalid", "原命令当前不可核实效果，请刷新原记录。");
      value.selection = { kind: "command-resolution", ref, effect: value.content === "命令确认已生效" ? "applied" : "not_applied" };
      value.reply = "请独立核实实际业务效果，再回复本消息「命令核实说明 你的证据」，非空、最多8192字符，不填凭据。效果说明不能证明停止；记录后不可覆盖。";
    } else if (value.content === "核实命令停止") {
      if (menu?.kind !== "command") throw new PersonalError("command_menu_stale", "停止重核须回复原命令详情菜单，未登记。");
      value.commandStop = { ref, taskId: await commands.requestStop(tx, ref, value.requestId) };
      value.reply = "已登记原命令停止重核；登记不证明停止，停止不证明业务效果。回复「刷新命令」查询；不会重新执行命令。";
    } else {
      if (!choice && (menu?.kind !== "command" || !["刷新命令", "查看命令输出", "查看命令错误", "下一页命令记录"].includes(value.content))) throw new PersonalError("command_menu_stale", "请回复原命令详情刷新或翻页。");
      const view = value.content === "查看命令输出" ? "stdout" : value.content === "查看命令错误" ? "stderr" : menu?.kind === "command" ? menu.view : "record";
      const offset = value.content === "下一页命令记录" && menu?.kind === "command" ? menu.nextOffset : 0;
      if (offset === undefined) throw new PersonalError("command_menu_stale", "原菜单没有下一页，请刷新原命令。");
      const detail = await commands.detailIn(tx, ref, view === "stderr" ? "stderr" : "stdout", view === "record" ? 0 : offset);
      const record = `原命令：${op.command}\n运行结果：${JSON.stringify(op.result ?? "尚未返回")}\n业务效果证据：${op.resolution ? `${op.resolution.effect}；${op.resolution.evidence}` : "尚未保存"}`;
      const text = view === "record" ? record.slice(offset, offset + 1200) : detail.output ? `${view}；${detail.output.complete ? "完整捕获" : "只捕获片段"}；${detail.output.bytes}字节。UTF-8预览（跨页字符可能不完整，原字节可从本机读取）：\n${Buffer.from(detail.output.data, "base64").toString("utf8")}` : `原输出${detail.outputError ? "无法核实，请保留现场并从本机查询" : "尚未捕获"}。`;
      const nextOffset = view === "record" ? offset + 1200 < record.length ? offset + 1200 : undefined : detail.output?.nextOffset;
      value.selection = { kind: "command", ref, view, ...(nextOffset === undefined ? {} : { nextOffset }) };
      value.reply = `${description(op)}。运行返回不代表业务成功。\n${text}\n回复本消息选择：刷新命令、查看命令输出、查看命令错误${nextOffset === undefined ? "" : "、下一页命令记录"}${detail.canResolve ? "、命令确认已生效、命令确认未生效" : ""}${detail.canRecheck ? "、核实命令停止" : ""}。效果与停止均核实后才释放占用。`;
    }
  } catch (error) {
    if (!(error instanceof PersonalError)) throw error;
    delete value.selection;
    value.reply = `${error.message} 请发送 /命令 查询原记录。`;
  }
  return true;
}

export async function verifyOwnerControls(tx: Tx, keys: string[], enabled: boolean) {
  const invalid = () => new PersonalError("command_control_invalid", "原命令菜单、核实或停止收件无法核实，已停止恢复；请保留档案。");
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt!;
    const menu = value.selection;
    if (menu?.kind !== "command-list" && menu?.kind !== "command" && menu?.kind !== "command-resolution" && !value.commandResolution && !value.commandStop) continue;
    if (!enabled || !value.control || !value.direct) throw invalid();
    const refs = menu?.kind === "command-list" ? menu.refs : menu?.kind === "command" || menu?.kind === "command-resolution" ? [menu.ref] : [];
    if (!Array.isArray(refs) || refs.length > 8 || new Set(refs.map(ref => ref.taskId)).size !== refs.length || menu && "nextOffset" in menu && menu.nextOffset !== undefined && (!Number.isSafeInteger(menu.nextOffset) || menu.nextOffset < 0)) throw invalid();
    for (const ref of refs) await original(tx, ref, value, false);
    const selected = (await telegramSelection(tx, value))?.selection;
    if (value.commandResolution && value.commandStop) throw invalid();
    if (value.commandResolution) {
      const { ref, effect } = value.commandResolution, op = await original(tx, ref, value, false);
      if (menu?.kind !== "command" || !isDeepStrictEqual(menu.ref, ref) || selected?.kind !== "command-resolution" || !isDeepStrictEqual(selected.ref, ref) || selected.effect !== effect || op.resolution?.actor !== key || op.resolution.effect !== effect || value.content !== `${EVIDENCE}${op.resolution.evidence}`) throw invalid();
    } else if (value.commandStop) {
      const { ref, taskId } = value.commandStop, op = await original(tx, ref, value, false), task = await tx.task(taskId);
      if (menu?.kind !== "command" || !isDeepStrictEqual(menu.ref, ref) || selected?.kind !== "command" || !isDeepStrictEqual(selected.ref, ref) || value.content !== "核实命令停止" || task?.kind !== "ruukoto.command-stop" || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || task.owner !== undefined || !task.background || !task.input || typeof task.input !== "object" || Array.isArray(task.input) || !isDeepStrictEqual(task.input.ref, ref) || task.input.admission !== op.admission) throw invalid();
    } else if (menu?.kind === "command-list") {
      if (value.content !== "/命令" && !(value.content === "更多命令" && selected?.kind === "command-list" && selected.nextOffset !== undefined)) throw invalid();
    } else if (menu?.kind === "command-resolution") {
      if (selected?.kind !== "command" || !isDeepStrictEqual(selected.ref, menu.ref) || !["applied", "not_applied"].includes(menu.effect) || value.content !== (menu.effect === "applied" ? "命令确认已生效" : "命令确认未生效")) throw invalid();
    } else if (menu?.kind === "command") {
      const choice = /^命令([1-8])$/.exec(value.content);
      if (!["record", "stdout", "stderr"].includes(menu.view) || (choice ? selected?.kind !== "command-list" || !isDeepStrictEqual(selected.refs[Number(choice[1]) - 1], menu.ref) : selected?.kind !== "command" || !isDeepStrictEqual(selected.ref, menu.ref) || !["刷新命令", "查看命令输出", "查看命令错误", "下一页命令记录"].includes(value.content) || value.content === "下一页命令记录" && selected.nextOffset === undefined)) throw invalid();
    } else throw invalid();
  }
  for (const op of await personalCommandsIn(tx)) {
    if (op.resolution?.actor) {
      const actor = (await tx.doc(PersonalTelegramReceiptDoc, op.resolution.actor, null)).receipt;
      if (!enabled || !keys.includes(op.resolution.actor) || !isDeepStrictEqual(actor?.commandResolution, { ref: op.ref, effect: op.resolution.effect })) throw invalid();
    }
  }
  let cursor;
  do {
    const page = await tx.scanTasks({ kind: "ruukoto.command-stop" }, 256, cursor);
    for (const task of page.items) {
      const input = task.input;
      if (!input || typeof input !== "object" || Array.isArray(input) || input.controlRequestId === undefined) continue;
      if (!enabled || typeof input.controlRequestId !== "string" || !keys.includes(input.controlRequestId)) throw invalid();
      const actor = (await tx.doc(PersonalTelegramReceiptDoc, input.controlRequestId, null)).receipt;
      if (!actor || actor.commandStop?.taskId !== task.id || !isDeepStrictEqual(actor.commandStop.ref, input.ref)) throw invalid();
      await original(tx, actor.commandStop.ref, actor, false);
    }
    cursor = page.next;
  } while (cursor);
}
