import { defineDoc, defineExtension, type Cursor, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { samePersonalEntry, personalEntryConfig, type PersonalEntryIdentity, PersonalTelegramDoc, PersonalTelegramReceiptDoc, type TelegramReceipt, type TelegramControlInput } from "./personal-telegram-records.ts";
import type { PersonalServiceMode } from "./personal-service-operations.ts";

export type PersonalTelegramSource = PersonalEntryIdentity & { mode: PersonalServiceMode; version: number };
export const PersonalPermissionsDoc = defineDoc<{ mode: PersonalServiceMode; version: number; qq?: { mode: PersonalServiceMode; version: number } }>({ kind: "ruukoto.permissions", scope: "session", version: 1, initial: () => ({ mode: "auto-review", version: 1 }) });
export const personalPermissions = defineExtension({ name: "personal-telegram-permissions" });
const MODES = { "自动审查": "auto-review", "请求确认": "confirm", "完全访问": "full_access" } as const;
export const TELEGRAM_SERVICE_ACTIONS = ["/审批", "/授权", "/服务状态", "批准本次", "批准并长期授权", "拒绝", "撤销授权", "下一项"];

export function permissionSnapshot(value: TelegramControlInput): PersonalTelegramSource | undefined {
  return value.direct && !value.control && value.permission ? { ...(value.platform ? { platform: value.platform } : {}), generation: value.generation, botId: value.botId, ownerId: value.ownerId, ...value.permission } : undefined;
}

export async function telegramSourceActive(tx: Tx, source: PersonalEntryIdentity) {
  const current = personalEntryConfig(await tx.doc(PersonalTelegramDoc), source);
  return current?.enabled === true && current.generation === source.generation && current.botId === source.botId && current.ownerId === source.ownerId;
}

export async function personalPermissionFor(tx: Tx, source?: Pick<PersonalEntryIdentity, "platform">) {
  const permission = await tx.doc(PersonalPermissionsDoc);
  if (source?.platform !== "qq") return permission;
  if (!permission.qq) permission.qq = { mode: "auto-review", version: 1 };
  return permission.qq;
}

export async function telegramSelection(tx: Tx, value: TelegramControlInput): Promise<TelegramReceipt | undefined> {
  if (!value.direct || value.replyBotId !== value.botId || value.replyTo === undefined) return;
  let selected: TelegramReceipt | undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: "ruukoto.telegram-input" }, 256, cursor);
    for (const task of page.items) {
      const key = task.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.requestId;
      if (typeof key !== "string") throw new PersonalError("telegram_receipt_invalid", "宿主消息的原收件无法核实，请保留档案。");
      const other = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt;
      if (!other || other.taskId !== task.id) throw new PersonalError("telegram_receipt_invalid", "宿主消息的原收件缺失，请保留档案。");
      if (other.platformMessageId !== String(value.replyTo) || !samePersonalEntry(other, value) || other.delivery !== "sent" || !other.control || !other.selection) continue;
      if (selected) throw new PersonalError("telegram_menu_ambiguous", "原宿主消息不唯一，已停止决定；请保留档案。");
      selected = other;
    }
    cursor = page.next;
  } while (cursor);
  return selected;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-telegram-permissions.md
export async function telegramPermissionControl(tx: Tx, value: TelegramControlInput): Promise<boolean> {
  const mode = Object.hasOwn(MODES, value.content) ? MODES[value.content as keyof typeof MODES] : undefined;
  if (value.content !== "/权限" && !mode) {
    if (TELEGRAM_SERVICE_ACTIONS.includes(value.content)) {
      if (!value.direct) { value.reply = "请由绑定拥有者直接发送控制命令；转发和引用摘录不能提供决定。"; return true; }
      return false;
    }
    return false;
  }
  if (!value.direct) { value.reply = "请直接发送 /权限，再回复宿主菜单选择；转发和引用摘录不能改变权限。"; return true; }
  const permission = await personalPermissionFor(tx, value);
  const platform = value.platform === "qq" ? "QQ" : "Telegram";
  if (value.content === "/权限") {
    value.selection = { kind: "mode" };
    value.reply = `新 ${platform} 输入默认模式：${Object.entries(MODES).find(([, mode]) => mode === permission.mode)![0]}。回复这条消息选择：自动审查、请求确认、完全访问。完全访问使用后台账户权限并免逐次审批；未知操作仍暂停。变更只影响以后收到的新 ${platform} 输入。`;
  } else if ((await telegramSelection(tx, value))?.selection?.kind !== "mode") value.reply = "权限未改变。请直接发送 /权限，再回复该条宿主菜单选择模式。";
  else {
    if (permission.mode !== mode) { permission.mode = mode!; permission.version++; }
    value.reply = `新 ${platform} 输入默认模式已设为${value.content}；已有工作保持原权限。`;
  }
  return true;
}
