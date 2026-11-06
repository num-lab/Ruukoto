import { isDeepStrictEqual } from "node:util";
import { type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { personalImDeliveryRecord } from "./personal-im-delivery.ts";
import { PersonalTelegramDisplayDoc, PersonalTelegramDisplaysDoc, PersonalTelegramTokenDoc } from "./personal-telegram-display-records.ts";
import { samePersonalEntry, type TelegramControlInput, type TelegramSelection } from "./personal-telegram-records.ts";

export type PersonalTelegramSelection = { requestId: string; selection?: TelegramSelection; platformMessageId?: string };

// Note: See .agents/notes/implemented/architecture/2026-11-06-personal-telegram-delivery.md
export async function personalTelegramDisplaySelection(tx: Tx, value: TelegramControlInput): Promise<PersonalTelegramSelection | undefined> {
  if (value.platform || !value.direct || value.replyBotId !== value.botId || value.replyTo === undefined) return;
  const callback = value.callback;
  const token = callback ? await tx.doc(PersonalTelegramTokenDoc, callback.token, null) : undefined;
  if (callback && (token?.display !== callback.display || token.action !== value.content)) return;
  const keys = callback ? [callback.display] : (await tx.doc(PersonalTelegramDisplaysDoc)).keys;
  let selected: PersonalTelegramSelection | undefined;
  for (const key of keys) {
    const display = (await tx.doc(PersonalTelegramDisplayDoc, key, null)).display;
    if (!display || !samePersonalEntry(display.source, value)) continue;
    const delivery = await personalImDeliveryRecord(tx, display.delivery), last = delivery.parts.findLast(part => part.kind === "text");
    if (last?.state !== "sent" || last.platformMessageId !== String(value.replyTo)) continue;
    if (!isDeepStrictEqual(delivery.input.source, display.source) || delivery.input.messageId !== display.messageId || delivery.input.text !== display.text) throw new PersonalError("telegram_display_invalid", "原卡片与发送内容不符，请保留档案并查询原操作。");
    if (callback && !display.buttons.some(button => button.token === callback.token && button.action === value.content)) return;
    if (selected) throw new PersonalError("telegram_menu_ambiguous", "原卡片不唯一，请保留档案并查询原操作。");
    selected = { requestId: key, selection: display.selection, platformMessageId: last.platformMessageId };
  }
  return selected;
}
