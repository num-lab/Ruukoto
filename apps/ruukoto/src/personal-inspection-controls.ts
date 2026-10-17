import { isDeepStrictEqual } from "node:util";
import { copyJson } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTask, ROOT_CONVERSATION_ID, type Cursor, type EntryId, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { PersonalInspectionDoc, PersonalPendingInspectionsDoc, ServiceInspectionAdmission, recheckServiceInspection } from "./personal-service-inspection.ts";
import { telegramSelection } from "./personal-permissions.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc, type TelegramControlInput, type TelegramReceipt } from "./personal-telegram-records.ts";
import type { ServiceManagerConfig } from "./service-helper.ts";

export type PersonalInspectionRef = { taskId: TaskId; admission: EntryId };
type Entrance = Pick<TelegramControlInput, "generation" | "botId" | "ownerId">;
type StopInput = { ref: PersonalInspectionRef; telegramRequestId?: string };
const NAME = "personal-inspection-controls";
const TASK = "ruukoto.inspection-stop";
const ACTIONS = ["/检查", "更多检查", "刷新检查", "核实检查停止"];

async function selectedInspection(tx: Tx, ref: PersonalInspectionRef) {
  const value = (await tx.doc(PersonalInspectionDoc, String(ref.taskId), null)).inspection;
  const entry = await tx.entry(ServiceInspectionAdmission, ref.admission);
  if (!value || value.admission !== ref.admission || !entry || entry.data.taskId !== ref.taskId) throw new PersonalError("inspection_menu_stale", "原检查记录已变化，未核实另一检查；请刷新检查列表。");
  const { admission: _admission, stopped: _stopped, stopEvidence: _proof, result: _result, ...identity } = value;
  if (!isDeepStrictEqual(entry.data, identity) || entry.conversationId !== value.conversationId) throw new PersonalError("service_inspection_invalid", "原检查接纳无法核实，已保留占用；请保留档案。");
  return value;
}

async function sameEntrance(tx: Tx, value: Pick<Awaited<ReturnType<typeof selectedInspection>>, "sources">, actor: Entrance, active = true) {
  const current = (await tx.doc(PersonalTelegramDoc)).config;
  if (active && (!current?.enabled || current.botId !== actor.botId || current.ownerId !== actor.ownerId || current.generation !== actor.generation)) return false;
  const matched = new Set<number>();
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: "ruukoto.telegram-input" }, 256, cursor);
    for (const task of page.items) {
      const key = task.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.requestId;
      if (typeof key !== "string") throw new PersonalError("telegram_receipt_invalid", "检查来源的收件引用缺失，请保留档案。");
      const receipt = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt;
      if (!receipt?.submissionId || !value.sources.includes(receipt.submissionId)) continue;
      const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, key);
      if (source?.id === receipt.submissionId && source.type === "input" && receipt.direct && !receipt.control && receipt.botId === actor.botId && receipt.ownerId === actor.ownerId && receipt.generation === actor.generation) matched.add(source.id);
    }
    cursor = page.next;
  } while (cursor);
  return value.sources.length > 0 && value.sources.every(id => matched.has(id));
}

async function mayStop(tx: Tx, ref: PersonalInspectionRef, actor?: Entrance) {
  const value = await selectedInspection(tx, ref);
  if (actor && !await sameEntrance(tx, value, actor)) throw new PersonalError("inspection_original_entry", "检查不属于当前拥有者入口，未请求停止；请从原入口或本机向导管理。");
  const task = await tx.task(ref.taskId);
  if (!task || (task.state.status !== "terminal" && !task.abortRequested)) throw new PersonalError("service_inspection_active", "原检查仍在执行，请先从后台分析取消原工作，或等待检查结束，再核实停止。");
  return copyJson(value) as typeof value;
}

export type PersonalInspectionSummary = { ref: PersonalInspectionRef; unit: string; scope: string; canRecheck: boolean };
export type PersonalInspectionPage = { items: PersonalInspectionSummary[]; nextOffset?: number };
export function personalInspectionDescription(item: PersonalInspectionSummary) { return `${item.unit}；${item.scope}；${item.canRecheck ? "停止未核实，原占用保留" : "原检查仍在执行，请先取消原工作或等待结束"}`; }

export async function listPersonalInspections(tx: Tx, offset = 0, actor?: Entrance): Promise<PersonalInspectionPage> {
  const items: PersonalInspectionSummary[] = [];
  for (const id of (await tx.doc(PersonalPendingInspectionsDoc)).tasks) {
    const value = (await tx.doc(PersonalInspectionDoc, String(id), null)).inspection;
    if (!value || value.stopped) throw new PersonalError("service_inspection_invalid", "检查占用记录无法核实，请保留档案。");
    if (actor && !await sameEntrance(tx, value, actor)) continue;
    const task = await tx.task(id);
    items.push({ ref: { taskId: id, admission: value.admission }, unit: value.unit, scope: value.work ? "后台分析的固定检查" : "主会话或服务审批前检查", canRecheck: !!task && (task.state.status === "terminal" || task.abortRequested) });
  }
  return { items: items.slice(offset, offset + 8), ...(items.length > offset + 8 ? { nextOffset: offset + 8 } : {}) };
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-inspection-stop-controls.md
export function personalInspectionControls(config: ServiceManagerConfig | undefined, getHarness: () => Harness) {
  async function checkStop(input: StopInput, taskId: TaskId, ctx: Context) {
    const value = await getHarness().commit(async tx => {
      const receipt = input.telegramRequestId ? (await tx.doc(PersonalTelegramReceiptDoc, input.telegramRequestId, null)).receipt : undefined;
      if (input.telegramRequestId && (!receipt || receipt.inspectionStop?.taskId !== taskId || !isDeepStrictEqual(receipt.inspectionStop.ref, input.ref))) throw new PersonalError("inspection_control_invalid", "原重核控制收件无法核实，已保留占用。");
      return mayStop(tx, input.ref, receipt);
    }, ctx);
    if (!config) throw new PersonalError("service_config_missing", "检查重核未装配，请恢复原服务配置。");
    if (!value.stopped) await recheckServiceInspection(getHarness(), config, input.ref.taskId, value);
    const stopped = await getHarness().commit(async tx => (await selectedInspection(tx, input.ref)).stopped, ctx);
    return { stopped, code: stopped ? "stopped" : "stop_unverified" };
  }
  const task = defineTask<StopInput, { phase: "run" }, { stopped: boolean; code: string }>({
    name: TASK, version: 1, initial: () => ({ phase: "run" }),
    phases: { async run(current, runtime, ctx) {
      let result = { stopped: false, code: "stop_unverified" };
      try { result = await checkStop(current.input, current.id, ctx); } catch (error) {
        if (!(error instanceof PersonalError)) throw error;
        result.code = error.code;
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), ctx);
    } },
    async abort(_current, runtime, ctx) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: { stopped: false, code: "canceled" } } }), ctx); },
  });
  return {
    extension: defineExtension({ name: NAME, tasks: [task] }),
    async request(tx: Tx, ref: PersonalInspectionRef, actor?: TelegramControlInput) {
      if (!config) throw new PersonalError("service_config_missing", "宿主未启用服务检查，请先核实服务配置。");
      await mayStop(tx, ref, actor);
      return tx.createTask(task, { ref: { ...ref }, ...(actor ? { telegramRequestId: actor.requestId } : {}) }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
    },
  };
}

export async function telegramInspectionControl(tx: Tx, value: TelegramControlInput, request: (tx: Tx, ref: PersonalInspectionRef, actor: TelegramControlInput) => Promise<TaskId>): Promise<boolean> {
  const choice = /^检查([1-8])$/.exec(value.content);
  if (!choice && !ACTIONS.includes(value.content)) return false;
  if (!value.direct) { value.reply = "请直接发送 /检查，再回复已送达宿主菜单；转发和引用摘录不能请求停止。"; return true; }
  async function applyControl() {
    const menu = value.content === "/检查" ? undefined : (await telegramSelection(tx, value))?.selection;
    if (value.content === "/检查" || (value.content === "更多检查" && menu?.kind === "inspection-list" && menu.nextOffset !== undefined)) {
      const page = await listPersonalInspections(tx, value.content === "/检查" ? 0 : menu?.kind === "inspection-list" ? menu.nextOffset! : 0, value);
      value.selection = { kind: "inspection-list", refs: page.items.map(item => item.ref), ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) };
      value.reply = page.items.length ? `原入口未核实检查：\n${page.items.map((item, i) => `检查${i + 1}：${personalInspectionDescription(item)}`).join("\n")}\n回复本消息选择检查1至检查${page.items.length}${page.nextOffset === undefined ? "。" : "，或选择「更多检查」。"}` : "当前入口暂无停止未核实的检查；旧入口或本机检查请从本机向导管理。";
      return true;
    }
    const ref = choice && menu?.kind === "inspection-list" ? menu.refs[Number(choice[1]) - 1] : menu?.kind === "inspection" ? menu.ref : undefined;
    if (!ref) { value.reply = "没有请求停止。请发送 /检查，再回复已送达宿主菜单选择列出的动作。"; return true; }
    const inspection = await selectedInspection(tx, ref);
    if (!await sameEntrance(tx, inspection, value)) throw new PersonalError("inspection_original_entry", "检查不属于当前入口，未请求停止。");
    value.selection = { kind: "inspection", ref: { ...ref } };
    if (value.content === "核实检查停止") {
      value.inspectionStop = { ref: { ...ref }, taskId: await request(tx, ref, value) };
      value.reply = "已登记原检查的停止重核；登记不表示已停止。回复「刷新检查」查询。未核实时保留原占用，请检查 helper 部署后再主动重核。";
    } else value.reply = `${inspection.unit}；${inspection.stopped ? "原检查停止已核实" : "原检查停止尚未核实，原占用保留"}。回复本消息选择：刷新检查、核实检查停止。原检查仍在执行时请先取消原工作或等待结束；不确认服务写入效果，也不强制释放占用。`;
  }
  try { await applyControl(); } catch (error) {
    if (!(error instanceof PersonalError)) throw error;
    delete value.selection;
    value.reply = `${error.message} 请发送 /检查 查询。`;
  }
  return true;
}

export async function verifyInspectionControls(tx: Tx, keys: string[], enabled: boolean) {
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt!;
    const menu = value.selection;
    if (menu?.kind !== "inspection" && menu?.kind !== "inspection-list" && !value.inspectionStop) continue;
    if (!enabled || !value.control || !value.direct) throw new PersonalError("inspection_control_invalid", "检查控制扩展或原收件不符，已停止恢复；请保留档案。");
    const refs = menu?.kind === "inspection-list" ? menu.refs : menu?.kind === "inspection" ? [menu.ref] : [];
    if (!Array.isArray(refs) || refs.length > 8 || (menu?.kind === "inspection-list" && menu.nextOffset !== undefined && (!Number.isSafeInteger(menu.nextOffset) || menu.nextOffset < 0))) throw new PersonalError("inspection_control_invalid", "检查菜单分页无效，已停止恢复。");
    // 历史菜单可以指向已被同 Task 后续尝试取代的接纳，不能据此改指当前尝试。
    for (const ref of refs) {
      const entry = await tx.entry(ServiceInspectionAdmission, ref.admission);
      if (!entry || entry.data.taskId !== ref.taskId || !await sameEntrance(tx, entry.data, value, false)) throw new PersonalError("inspection_control_invalid", "检查菜单缺少原接纳或来源不符，已停止恢复。");
    }
    if (value.inspectionStop) {
      const task = await tx.task(value.inspectionStop.taskId);
      const original = (await telegramSelection(tx, value))?.selection;
      if (value.content !== "核实检查停止" || original?.kind !== "inspection" || !isDeepStrictEqual(original.ref, value.inspectionStop.ref) || !task || task.kind !== TASK || !isDeepStrictEqual(task.input, { ref: value.inspectionStop.ref, telegramRequestId: key })) throw new PersonalError("inspection_control_invalid", "检查重核缺少原已送达菜单或执行归属，已停止恢复。");
    }
  }
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: TASK }, 256, cursor);
    for (const task of page.items) {
      const input = task.input as StopInput;
      if (!enabled || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !input?.ref || !Number.isSafeInteger(input.ref.taskId) || !Number.isSafeInteger(input.ref.admission) || input.ref.taskId < 1 || input.ref.admission < 1 || (input.telegramRequestId !== undefined && (typeof input.telegramRequestId !== "string" || !input.telegramRequestId)) || (await tx.entry(ServiceInspectionAdmission, input.ref.admission))?.data.taskId !== input.ref.taskId) throw new PersonalError("inspection_control_invalid", "停止重核任务缺少原检查或执行归属，已停止恢复。");
      if (input.telegramRequestId) {
        const receipt = (await tx.doc(PersonalTelegramReceiptDoc, input.telegramRequestId, null)).receipt;
        if (!receipt?.inspectionStop || receipt.inspectionStop.taskId !== task.id || !isDeepStrictEqual(receipt.inspectionStop.ref, input.ref) || !keys.includes(input.telegramRequestId)) throw new PersonalError("inspection_control_invalid", "停止重核任务缺少原 Telegram 收件，已停止恢复。");
      }
    }
    cursor = page.next;
  } while (cursor);
}
