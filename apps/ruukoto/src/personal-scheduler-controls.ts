import { defineExtension, type Tx } from "@earendil-works/pi-durable";
import { localTimeOf, parseRule, RuleError, type ScheduleRule } from "@ruukoto/channels/scheduler/time.ts";
import { isDeepStrictEqual } from "node:util";
import { PersonalError } from "./personal-error.ts";
import { telegramSelection } from "./personal-permissions.ts";
import { personalReportDelivery } from "./personal-work-controls.ts";
import { samePersonalEntry, PersonalTelegramReceiptDoc, type TelegramControlInput, type TelegramReceipt } from "./personal-telegram-records.ts";
import type { personalScheduler } from "./personal-scheduler.ts";
import { personalScheduleRun } from "./personal-scheduler-records.ts";

type Scheduler = Pick<ReturnType<typeof personalScheduler>, "create" | "createByRequest" | "list" | "get" | "cancel" | "runs" | "result">;
export type PersonalScheduleCreateBody = Omit<Parameters<Scheduler["create"]>[1], "rule"> & { rule: ScheduleRule };

export function parsePersonalScheduleCreate(value: unknown): PersonalScheduleCreateBody {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["requestId", "label", "instruction", "rule"].includes(key)) || !("requestId" in value) || typeof value.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId) || !("label" in value) || typeof value.label !== "string" || !value.label.trim() || value.label.length > 128 || !("instruction" in value) || typeof value.instruction !== "string" || !value.instruction.trim() || value.instruction.length > 16384 || !("rule" in value)) throw new PersonalError("schedule_input_invalid", "请输入计划名称、工作要求与执行时间；请求标识由程序管理。");
  return { requestId: value.requestId, label: value.label, instruction: value.instruction, rule: draftRule(value.rule) };
}

type Draft = { requestId: string; step: "kind" | "zone" | "custom-zone" | "at" | "time" | "weekdays" | "label" | "instruction" | "confirm"; kind?: "once" | "daily" | "weekly"; timeZone?: string; at?: string; time?: string; weekdays?: number[]; label?: string; instruction?: string };
export type PersonalScheduleMenu = { kind: "schedule-list"; ids: string[]; nextOffset?: number } | { kind: "schedule"; id: string } | { kind: "schedule-runs"; id: string; runIds: string[]; nextOffset?: number } | { kind: "schedule-run"; id: string; runId: string; nextOffset?: number } | { kind: "schedule-draft"; draft: Draft };
export const personalSchedulerControls = defineExtension({ name: "personal-scheduler-controls" });
const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const ACTIONS = ["/定时", "新建计划", "更多计划", "刷新计划", "查看运行", "更多运行", "刷新运行", "查看定时报告", "下一页定时报告", "取消这项计划", "放弃创建", "确认创建计划"];
const preview = (text: string) => Array.from(text).length > 2400 ? Array.from(text).slice(0, 2400).join("") + "…（显示已截断，计划保存完整要求）" : text;

export function personalScheduleRuleDescription(rule: ScheduleRule) {
  if (rule.kind === "once") return `一次性 ${localTimeOf(rule.at, rule.timeZone)}`;
  return `${rule.kind === "daily" ? "每日" : `每周 ${rule.weekdays.map(day => DAYS[day - 1]).join("、")}`} ${rule.time}（${rule.timeZone}），持续至取消`;
}

export function personalScheduleDescription(value: { label: string; rule: ScheduleRule; canceled: boolean; nextDueAt: string | null }) {
  return `${value.label}：${personalScheduleRuleDescription(value.rule)}；${value.canceled ? "已取消，历史保留" : value.nextDueAt ? `下次 ${localTimeOf(value.nextDueAt, value.rule.timeZone)}` : "等待运行或已执行一次性计划"}`;
}

export function personalScheduleRunDescription(value: { state: string; scheduledFor?: string; delivery?: string }) {
  const states: Record<string, string> = { pending: "等待执行", running: "执行中", waiting: "等待处理或外部核实", completing: "正在收尾", completed: "整项已结束", failed: "运行未完成", aborted: "已取消", faulted: "异常停止，须核实原工作", orphaned: "归属异常，须检查档案", canceling: "已请求取消，停止仍须核实", canceled: "已取消", paused: "外部事实或浏览器暂停待核实；请从原工具、浏览器或服务菜单核实，也可取消计划", closed: "整项已收尾" };
  return `${value.scheduledFor ? `${value.scheduledFor}；` : ""}${states[value.state] ?? "原运行状态待核实"}${value.delivery ? `；${personalReportDelivery(value.delivery)}` : ""}`;
}

function draftRule(draft: unknown) {
  try { return parseRule(draft); } catch (error) {
    if (!(error instanceof RuleError)) throw error;
    throw new PersonalError("schedule_rule_invalid", error.message, { cause: error });
  }
}

function draftReply(draft: Draft) {
  if (draft.step === "kind") return "回复本消息选择：一次性、每日、每周、放弃创建。";
  if (draft.step === "zone") return "回复本消息选择执行时区：东京、上海、UTC、其他时区、放弃创建。";
  if (draft.step === "custom-zone") return "回复本消息填写 IANA 时区，例如 Europe/London；或回复「放弃创建」。";
  if (draft.step === "at") return "回复本消息填写一次性时间，例如 2026-10-20T09:00:00+09:00，必须带 Z 或时区偏移；或回复「放弃创建」。";
  if (draft.step === "time") return "回复本消息填写当地执行时间，格式 HH:mm，例如 09:00；或回复「放弃创建」。";
  if (draft.step === "weekdays") return `已选星期：${draft.weekdays?.map(day => DAYS[day - 1]).join("、") || "无"}。回复本消息逐项选择或取消：${DAYS.join("、")}；选好后回复「完成星期选择」，或回复「放弃创建」。`;
  if (draft.step === "label") return "回复本消息填写计划名称（最多128字符）；或回复「放弃创建」。";
  if (draft.step === "instruction") return "回复本消息填写完整工作要求（最多16384字符）；独立会话不读取主聊天。或回复「放弃创建」。";
  return `定时计划：${draft.label}\n${personalScheduleRuleDescription(draftRule(draft))}\n${preview(draft.instruction!)}\n创建时固定当前模式、工具与资料范围；审批与完整回报固定回到此入口。回复本消息选择：确认创建计划、放弃创建。`;
}

function advanceDraft(previous: Draft, content: string): Draft {
  const draft = { ...previous, ...(previous.weekdays ? { weekdays: previous.weekdays.slice() } : {}) };
  if (draft.step === "kind") {
    const kind = ({ "一次性": "once", "每日": "daily", "每周": "weekly" } as const)[content as "一次性" | "每日" | "每周"];
    if (!kind) throw new PersonalError("schedule_choice_invalid", "请回复原菜单选择一次性、每日或每周。");
    draft.kind = kind; draft.step = "zone";
  } else if (draft.step === "zone") {
    if (content === "其他时区") draft.step = "custom-zone";
    else {
      const zone = ({ "东京": "Asia/Tokyo", "上海": "Asia/Shanghai", "UTC": "UTC" } as const)[content as "东京" | "上海" | "UTC"];
      if (!zone) throw new PersonalError("schedule_choice_invalid", "请选择东京、上海、UTC或其他时区。");
      draft.timeZone = zone; draft.step = draft.kind === "once" ? "at" : "time";
    }
  } else if (draft.step === "custom-zone") {
    draft.timeZone = draftRule({ kind: "daily", time: "00:00", timeZone: content.trim() }).timeZone;
    draft.step = draft.kind === "once" ? "at" : "time";
  } else if (draft.step === "at") {
    draft.at = content.trim(); draftRule(draft); draft.step = "label";
  } else if (draft.step === "time") {
    draft.time = content.trim();
    draftRule({ kind: "daily", time: draft.time, timeZone: draft.timeZone });
    draft.step = draft.kind === "weekly" ? "weekdays" : "label";
    if (draft.step === "weekdays") draft.weekdays = [];
  } else if (draft.step === "weekdays") {
    if (content === "完成星期选择") { draftRule(draft); draft.step = "label"; }
    else {
      const day = DAYS.indexOf(content) + 1;
      if (!day) throw new PersonalError("schedule_choice_invalid", "请从原菜单逐项选择星期，再选择完成星期选择。");
      draft.weekdays = draft.weekdays?.includes(day) ? draft.weekdays.filter(value => value !== day) : [...(draft.weekdays ?? []), day].sort((a, b) => a - b);
    }
  } else if (draft.step === "label") {
    if (!content.trim() || content.length > 128) throw new PersonalError("schedule_input_invalid", "计划名称须非空且最多128字符，请回复原菜单重新填写。");
    draft.label = content.trim(); draft.step = "instruction";
  } else if (draft.step === "instruction") {
    if (!content.trim() || content.length > 16384) throw new PersonalError("schedule_input_invalid", "工作要求须非空且最多16384字符，请回复原菜单重新填写。");
    draft.instruction = content; draft.step = "confirm";
  } else throw new PersonalError("schedule_choice_invalid", "请回复确认菜单选择确认创建计划或放弃创建。");
  return draft;
}

async function originalSchedule(tx: Tx, scheduler: Scheduler, id: string, actor: TelegramControlInput) {
  const value = await scheduler.get(tx, id);
  if (!samePersonalEntry(value.telegram, actor)) throw new PersonalError("schedule_original_entry", "此计划不属于原拥有者入口，请发送 /定时 查询；没有改变计划。");
  return value;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-18-personal-durable-scheduled-work.md
export async function personalScheduleControl(tx: Tx, value: TelegramControlInput, scheduler: Scheduler): Promise<boolean> {
  const choice = /^计划([1-8])$/.exec(value.content), runChoice = /^运行([1-8])$/.exec(value.content);
  let selected: TelegramReceipt | undefined;
  if (value.replyTo !== undefined) selected = await telegramSelection(tx, value);
  const menu = selected?.selection;
  if (!choice && !runChoice && !ACTIONS.includes(value.content) && menu?.kind !== "schedule-draft") return false;
  if (!value.direct) { value.reply = "请由绑定拥有者直接发送 /定时，再回复宿主菜单选择；转发与引用摘录不能创建或控制计划。"; return true; }
  try {
    if (value.content === "/定时" || value.content === "更多计划" && menu?.kind === "schedule-list" && menu.nextOffset !== undefined) {
      const page = await scheduler.list(tx, value.content === "更多计划" && menu?.kind === "schedule-list" ? menu.nextOffset! : 0, value);
      value.selection = { kind: "schedule-list", ids: page.items.map(item => item.id), ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) };
      value.reply = `${page.items.length ? `定时计划：\n${page.items.map((item, index) => `计划${index + 1}：${personalScheduleDescription(item)}`).join("\n")}\n回复本消息选择计划1至计划${page.items.length}，或选择` : "原入口暂无定时计划。回复本消息选择"}「新建计划」${page.nextOffset === undefined ? "。" : "或「更多计划」。"}`;
      return true;
    }
    if (value.content === "新建计划" && menu?.kind === "schedule-list") {
      const draft: Draft = { requestId: value.requestId, step: "kind" };
      value.selection = { kind: "schedule-draft", draft }; value.reply = draftReply(draft); return true;
    }
    if (menu?.kind === "schedule-draft") {
      if (value.content === "放弃创建") { value.reply = "未创建计划；随时发送 /定时 重新选择。"; return true; }
      if (value.content === "确认创建计划" && menu.draft.step === "confirm") {
        const input = { requestId: menu.draft.requestId, label: menu.draft.label!, instruction: menu.draft.instruction!, rule: draftRule(menu.draft) };
        const plan = await scheduler.create(tx, input, { kind: "im", input: structuredClone(value), menuRequestId: selected!.requestId });
        value.scheduleCreate = { id: plan.id, requestId: input.requestId };
        value.selection = { kind: "schedule", id: plan.id };
        value.reply = `${personalScheduleDescription(plan)}。计划已创建；后台独立执行，主聊天仍可继续。回复本消息选择：刷新计划、查看运行、取消这项计划。`;
        return true;
      }
      const draft = advanceDraft(menu.draft, value.content);
      value.selection = { kind: "schedule-draft", draft }; value.reply = draftReply(draft); return true;
    }
    const id = choice && menu?.kind === "schedule-list" ? menu.ids[Number(choice[1]) - 1] : menu?.kind === "schedule" || menu?.kind === "schedule-runs" || menu?.kind === "schedule-run" ? menu.id : undefined;
    if (!id) { value.reply = "没有改变计划。请发送 /定时，再回复已送达的原宿主菜单选择。"; return true; }
    const plan = await originalSchedule(tx, scheduler, id, value);
    if (value.content === "取消这项计划" && menu?.kind === "schedule") {
      await scheduler.cancel(tx, id, { kind: "im", input: structuredClone(value), menuRequestId: selected!.requestId });
      value.scheduleCancel = { id }; value.selection = { kind: "schedule", id };
      value.reply = "已登记计划及未结束运行的取消；停止与外部效果仍须核实，历史保留。回复本消息选择：刷新计划、查看运行。"; return true;
    }
    if (value.content === "查看运行" || value.content === "更多运行" && menu?.kind === "schedule-runs" && menu.nextOffset !== undefined) {
      const page = await scheduler.runs(tx, id, value.content === "更多运行" && menu?.kind === "schedule-runs" ? menu.nextOffset! : 0);
      value.selection = { kind: "schedule-runs", id, runIds: page.items.map(item => item.id), ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) };
      value.reply = page.items.length ? `原计划运行：\n${page.items.map((item, index) => `运行${index + 1}：${personalScheduleRunDescription(item)}`).join("\n")}\n回复本消息选择运行1至运行${page.items.length}${page.nextOffset === undefined ? "。" : "，或选择「更多运行」。"}` : "原计划暂无运行；回复本消息选择「刷新计划」。";
      return true;
    }
    const runId = runChoice && menu?.kind === "schedule-runs" ? menu.runIds[Number(runChoice[1]) - 1] : menu?.kind === "schedule-run" ? menu.runId : undefined;
    if (runId && (runChoice || ["刷新运行", "查看定时报告", "下一页定时报告"].includes(value.content))) {
      if ((await personalScheduleRun(tx, runId)).planId !== id) throw new PersonalError("schedule_menu_stale", "原运行不属于此计划，请发送 /定时 重新选择。");
      if (value.content === "下一页定时报告" && (menu?.kind !== "schedule-run" || menu.nextOffset === undefined)) throw new PersonalError("schedule_menu_stale", "此菜单没有下一页报告，请回复原运行菜单选择查看定时报告。");
      const result = await scheduler.result(tx, runId, value.content === "下一页定时报告" && menu?.kind === "schedule-run" ? menu.nextOffset! : 0, 2400);
      value.selection = { kind: "schedule-run", id, runId, ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }) };
      value.reply = `${personalScheduleRunDescription(result)}。\n${result.text ?? "暂无完整报告，请稍后刷新原运行。"}\n回复本消息选择：刷新运行、查看定时报告、查看运行、刷新计划${result.nextOffset === undefined ? "。" : "、下一页定时报告。"}`;
      return true;
    }
    if (choice || value.content === "刷新计划") {
      value.selection = { kind: "schedule", id };
      value.reply = `${personalScheduleDescription(plan)}\n${preview(plan.instruction)}\n回复本消息选择：刷新计划、查看运行${plan.canceled ? "。" : "、取消这项计划。"}`;
    } else value.reply = "没有改变计划。请回复原菜单选择列出的动作，或发送 /定时。";
  } catch (error) {
    if (!(error instanceof PersonalError) && !(error instanceof RuleError)) throw error;
    value.reply = `${error.message} 请回复原菜单重新选择，或发送 /定时 查询。`;
    delete value.selection;
  }
  return true;
}

export async function verifyScheduleControls(tx: Tx, keys: string[], enabled: boolean, scheduler: Scheduler) {
  const invalid = () => new PersonalError("schedule_menu_invalid", "定时菜单、创建确认或原入口无法核实，已停止恢复；请保留档案。");
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt;
    if (!value) throw invalid();
    const menu = value.selection;
    if (!(menu?.kind.startsWith("schedule")) && !value.scheduleCreate && !value.scheduleCancel) continue;
    if (!enabled || !value.direct || !value.control || value.scheduleCreate && value.scheduleCancel) throw invalid();
    const selected = await telegramSelection(tx, value), previous = selected?.selection;
    if (menu?.kind === "schedule-draft") {
      if (value.content === "新建计划") {
        if (previous?.kind !== "schedule-list" || !isDeepStrictEqual(menu.draft, { requestId: value.requestId, step: "kind" })) throw invalid();
      } else if (previous?.kind !== "schedule-draft" || !isDeepStrictEqual(advanceDraft(previous.draft, value.content), menu.draft)) throw invalid();
      continue;
    }
    if (menu?.kind === "schedule-list") {
      if (!Array.isArray(menu.ids) || menu.ids.length > 8 || new Set(menu.ids).size !== menu.ids.length || value.content !== "/定时" && !(value.content === "更多计划" && previous?.kind === "schedule-list" && previous.nextOffset !== undefined)) throw invalid();
      for (const id of menu.ids) await originalSchedule(tx, scheduler, id, value);
    } else if (menu?.kind === "schedule" || menu?.kind === "schedule-runs" || menu?.kind === "schedule-run") {
      await originalSchedule(tx, scheduler, menu.id, value);
      if (value.scheduleCreate) {
        const created = value.scheduleCreate;
        if (menu.kind !== "schedule" || menu.id !== created.id || value.content !== "确认创建计划" || previous?.kind !== "schedule-draft" || previous.draft.step !== "confirm" || previous.draft.requestId !== created.requestId || (await scheduler.createByRequest(tx, created.requestId))?.id !== created.id) throw invalid();
      } else {
        const choice = /^计划([1-8])$/.exec(value.content), runChoice = /^运行([1-8])$/.exec(value.content);
        if (choice ? previous?.kind !== "schedule-list" || previous.ids[Number(choice[1]) - 1] !== menu.id : previous?.kind !== "schedule" && previous?.kind !== "schedule-runs" && previous?.kind !== "schedule-run" || previous.id !== menu.id) throw invalid();
        if (menu.kind === "schedule" && !choice && !["刷新计划", "取消这项计划"].includes(value.content)) throw invalid();
        if (menu.kind === "schedule-runs" && (!Array.isArray(menu.runIds) || menu.runIds.length > 8 || new Set(menu.runIds).size !== menu.runIds.length || !["查看运行", "更多运行"].includes(value.content))) throw invalid();
        if (value.content === "更多运行" && (previous?.kind !== "schedule-runs" || previous.nextOffset === undefined)) throw invalid();
        if (menu.kind === "schedule-run" && (runChoice ? previous?.kind !== "schedule-runs" || previous.runIds[Number(runChoice[1]) - 1] !== menu.runId : previous?.kind !== "schedule-run" || previous.runId !== menu.runId || !["刷新运行", "查看定时报告", "下一页定时报告"].includes(value.content))) throw invalid();
        if (value.content === "下一页定时报告" && (previous?.kind !== "schedule-run" || previous.nextOffset === undefined)) throw invalid();
      }
      if (value.content === "取消这项计划" && !value.scheduleCancel) throw invalid();
      if (value.scheduleCancel && (value.scheduleCancel.id !== menu.id || menu.kind !== "schedule" || previous?.kind !== "schedule" || value.content !== "取消这项计划")) throw invalid();
      for (const runId of menu.kind === "schedule-runs" ? menu.runIds : menu.kind === "schedule-run" ? [menu.runId] : []) if ((await personalScheduleRun(tx, runId)).planId !== menu.id) throw invalid();
    } else throw invalid();
    if (menu && "nextOffset" in menu && menu.nextOffset !== undefined && (!Number.isSafeInteger(menu.nextOffset) || menu.nextOffset < 0)) throw invalid();
  }
}
