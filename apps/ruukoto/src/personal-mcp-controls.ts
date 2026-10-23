import { ROOT_CONVERSATION_ID, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { telegramSelection } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc, type TelegramControlInput } from "./personal-telegram-records.ts";
import { mcpDecide, mcpDetail, mcpList, mcpOperations, mcpOriginal, mcpResolve, PersonalMcpDoc } from "./personal-mcp.ts";

const ACTIONS = ["/MCP", "更多MCP操作", "刷新MCP", "下一页MCP原记录", "MCP批准本次", "MCP拒绝", "MCP确认已生效", "MCP确认未生效", "核实MCP原请求结束"];
const EVIDENCE = "MCP核实说明 ";
type Recheck = (tx: Tx, operation: TaskId, actor: TelegramControlInput) => Promise<TaskId>;

export function personalMcpDescription(item: Awaited<ReturnType<typeof mcpList>>["items"][number]): string {
  const decision = { pending: item.canDecide ? "等待本次批准" : "未登记人工批准", approved: "本次已批准", rejected: "本次已拒绝" }[item.decision];
  const effect = { not_executed: "已知未执行", effect_unknown: "业务效果未知", returned: "已返回，请核对原响应", no_write: "只读观察中断，无写入效果" }[item.effect];
  return `${item.service} / ${item.tool}；${decision}；${item.started ? "执行已开始" : "执行未开始"}；${effect}；${item.remoteEnded ? "原远端请求结束已核实" : "原远端请求结束未核实"}${item.cuaRecovery ? `；电脑恢复：${({ frozen: "绑定暂停，请从本机管理核实停止并恢复", stopped: "停止已核实，等待本人检查结果", begun: "本人已选择恢复，等待新截图", observed: "新截图已保存，等待本人接受", accepted: "本人已接受新观察，可开始新工作" })[item.cuaRecovery]}` : ""}`;
}

export async function personalMcpControl(tx: Tx, value: TelegramControlInput, requestRecheck?: Recheck): Promise<boolean> {
  const choice = /^MCP([1-8])$/.exec(value.content);
  const evidence = value.content.startsWith(EVIDENCE) ? value.content.slice(EVIDENCE.length) : undefined;
  if (!choice && evidence === undefined && !ACTIONS.includes(value.content)) return false;
  if (!requestRecheck) { value.reply = "MCP 尚未装配，请在后台停止后通过本机向导配置服务，再启动并查询。"; return true; }
  if (!value.direct) { value.reply = "请直接发送 /MCP，再回复已送达宿主菜单选择；转发和引用摘录不能管理 MCP 操作。"; return true; }
  try {
    const menu = value.content === "/MCP" ? undefined : (await telegramSelection(tx, value))?.selection;
    if (value.content === "/MCP" || value.content === "更多MCP操作" && menu?.kind === "mcp-list" && menu.nextOffset !== undefined) {
      const page = await mcpList(tx, menu?.kind === "mcp-list" ? menu.nextOffset! : 0, value);
      value.selection = { kind: "mcp-list", operations: page.items.map(item => item.operation as TaskId), ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) };
      value.reply = page.items.length ? `原入口 MCP 操作：\n${page.items.map((item, index) => `MCP${index + 1}：${personalMcpDescription(item)}`).join("\n")}\n回复本消息选择 MCP1 至 MCP${page.items.length}${page.nextOffset === undefined ? "。" : "，或选择「更多MCP操作」。"}` : "当前原入口暂无 MCP 操作；本机或旧代次操作请从本机向导管理。";
      return true;
    }
    const operation = choice && menu?.kind === "mcp-list" ? menu.operations[Number(choice[1]) - 1] : menu?.kind === "mcp" || menu?.kind === "mcp-resolution" ? menu.operation : undefined;
    if (!operation) throw new PersonalError("mcp_menu_stale", "没有改变 MCP 操作，请从 /MCP 选择原操作。");
    await mcpOriginal(tx, operation, value);
    value.selection = { kind: "mcp", operation };
    if (evidence !== undefined) {
      if (menu?.kind !== "mcp-resolution") throw new PersonalError("mcp_menu_stale", "业务效果证据须回复原效果确认菜单，未保存核实。");
      await mcpResolve(tx, operation, menu.effect, evidence, value);
      value.mcpResolution = { operation, effect: menu.effect };
      value.reply = "原业务效果核实与证据已保存；人工说明不证明原远端请求已结束，结束未核实时继续暂停并保留占用。回复「刷新MCP」查询。";
    } else if (value.content === "MCP确认已生效" || value.content === "MCP确认未生效") {
      if (menu?.kind !== "mcp" || !(await mcpDetail(tx, operation, 0, value)).summary.canResolve) throw new PersonalError("mcp_resolution_invalid", "原操作当前不可核实业务效果，请刷新 MCP。");
      value.selection = { kind: "mcp-resolution", operation, effect: value.content === "MCP确认已生效" ? "applied" : "not_applied" };
      value.reply = "请独立核实实际业务效果，再回复本消息「MCP核实说明 你的证据」，最多 8192 字符，不填凭据。记录后不可覆盖；人工业务效果说明不能证明原远端请求已结束，也不能单独释放占用。";
    } else if (value.content === "MCP批准本次" || value.content === "MCP拒绝") {
      if (menu?.kind !== "mcp") throw new PersonalError("mcp_menu_stale", "批准或拒绝须回复原 MCP 详情菜单，未保存决定。");
      const decision = value.content === "MCP批准本次" ? "approved" : "rejected";
      await mcpDecide(tx, operation, decision, value);
      value.mcpDecision = { operation, decision };
      value.reply = "原 MCP 操作决定已登记；批准只用于本次操作并单次消费，不表示操作成功。回复「刷新MCP」核实原请求与原响应。";
    } else if (value.content === "核实MCP原请求结束") {
      if (menu?.kind !== "mcp" || !(await mcpDetail(tx, operation, 0, value)).summary.canRecheck) throw new PersonalError("mcp_recheck_unavailable", "原 MCP 请求当前没有可恢复的远端结果流，请保留原占用并从本机查询原记录。");
      value.mcpRecheck = { operation, taskId: await requestRecheck(tx, operation, value) };
      value.reply = "已登记原请求结果流核实；登记不证明远端结束。只查询原结果流，不重新调用工具；回复「刷新MCP」查询原响应。";
    } else {
      if (value.content === "下一页MCP原记录" && (menu?.kind !== "mcp" || menu.nextOffset === undefined)) throw new PersonalError("mcp_menu_stale", "此菜单没有下一页原记录，请刷新 MCP 从头读取。");
      const detail = await mcpDetail(tx, operation, value.content === "下一页MCP原记录" && menu?.kind === "mcp" ? menu.nextOffset! : 0, value);
      value.selection = { kind: "mcp", operation, ...(detail.nextOffset === undefined ? {} : { nextOffset: detail.nextOffset }) };
      value.reply = `${personalMcpDescription(detail.summary)}。\n原请求、响应与核实证据：\n${detail.text}\n回复本消息选择：刷新MCP${detail.nextOffset === undefined ? "" : "、下一页MCP原记录"}${detail.summary.canDecide ? "、MCP批准本次、MCP拒绝" : ""}${detail.summary.canResolve ? "、MCP确认已生效、MCP确认未生效" : ""}${detail.summary.canRecheck ? "、核实MCP原请求结束" : ""}。原响应返回不代表业务成功；人工效果说明不证明远端结束。`;
    }
  } catch (error) {
    if (!(error instanceof PersonalError)) throw error;
    delete value.selection;
    value.reply = `${error.message} 请发送 /MCP 查询原操作。`;
  }
  return true;
}

export async function verifyMcpControls(tx: Tx, keys: string[], enabled: boolean): Promise<void> {
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt!;
    const menu = value.selection;
    if (menu?.kind !== "mcp-list" && menu?.kind !== "mcp" && menu?.kind !== "mcp-resolution" && !value.mcpDecision && !value.mcpResolution && !value.mcpRecheck) continue;
    const invalid = () => new PersonalError("mcp_control_invalid", "MCP 宿主菜单或原入口无法核实，已停止恢复；请保留档案。");
    if (!enabled || !value.control || !value.direct) throw invalid();
    const operations = menu?.kind === "mcp-list" ? menu.operations : menu?.kind === "mcp" || menu?.kind === "mcp-resolution" ? [menu.operation] : [];
    if (!Array.isArray(operations) || operations.length > 8 || operations.some(id => !Number.isSafeInteger(id) || id < 1) || (menu && "nextOffset" in menu && menu.nextOffset !== undefined && (!Number.isSafeInteger(menu.nextOffset) || menu.nextOffset < 0)) || (menu?.kind === "mcp-resolution" && !["applied", "not_applied"].includes(menu.effect))) throw invalid();
    for (const operation of operations) await mcpOriginal(tx, operation, value, false);
    const selected = (await telegramSelection(tx, value))?.selection;
    if (value.mcpDecision) {
      const operation = value.mcpDecision.operation;
      await mcpOriginal(tx, operation, value, false);
      const op = (await tx.doc(PersonalMcpDoc, String(operation), null)).operation;
      if (selected?.kind !== "mcp" || selected.operation !== operation || !["approved", "rejected"].includes(value.mcpDecision.decision) || value.content !== (value.mcpDecision.decision === "approved" ? "MCP批准本次" : "MCP拒绝") || op?.decidedBy !== key || op.decision !== value.mcpDecision.decision) throw invalid();
    }
    if (value.mcpResolution) {
      const operation = value.mcpResolution.operation;
      await mcpOriginal(tx, operation, value, false);
      const op = (await tx.doc(PersonalMcpDoc, String(operation), null)).operation;
      if (selected?.kind !== "mcp-resolution" || selected.operation !== operation || selected.effect !== value.mcpResolution.effect || op?.resolution?.requestId !== key || op.resolution.effect !== selected.effect || value.content !== `${EVIDENCE}${op.resolution.evidence}`) throw invalid();
    }
    if (value.mcpRecheck) {
      await mcpOriginal(tx, value.mcpRecheck.operation, value, false);
      const task = await tx.task(value.mcpRecheck.taskId);
      const op = (await tx.doc(PersonalMcpDoc, String(value.mcpRecheck.operation), null)).operation!;
      if (value.content !== "核实MCP原请求结束" || selected?.kind !== "mcp" || selected.operation !== value.mcpRecheck.operation || task?.kind !== "ruukoto.mcp-recheck" || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !task.input || typeof task.input !== "object" || Array.isArray(task.input) || task.input.operation !== op.operation || task.input.admission !== op.admission) throw invalid();
    }
  }
  for (const op of await mcpOperations(tx)) {
    const invalid = () => new PersonalError("mcp_control_invalid", "MCP 决定或效果核实缺少原控制收件，已停止恢复；请保留档案。");
    if (op.decidedBy) {
      const receipt = (await tx.doc(PersonalTelegramReceiptDoc, op.decidedBy, null)).receipt;
      if (!enabled || !keys.includes(op.decidedBy) || receipt?.mcpDecision?.operation !== op.operation || receipt.mcpDecision.decision !== op.decision) throw invalid();
    }
    if (op.resolution?.requestId) {
      const receipt = (await tx.doc(PersonalTelegramReceiptDoc, op.resolution.requestId, null)).receipt;
      if (!enabled || !keys.includes(op.resolution.requestId) || receipt?.mcpResolution?.operation !== op.operation || receipt.mcpResolution.effect !== op.resolution.effect) throw invalid();
    }
  }
}
