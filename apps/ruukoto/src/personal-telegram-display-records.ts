import { defineDoc, defineDocFamily, defineEntry, type EntryId, type TaskId } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { PersonalDesktopFamily } from "@ruukoto/view/personal-protocol.ts";
import type { PersonalImDeliveryRef } from "./personal-im-delivery.ts";
import type { PersonalCuaRecoveryBinding } from "./personal-mcp.ts";
import type { PersonalEntryIdentity, TelegramSelection } from "./personal-telegram-records.ts";

export type PersonalTelegramDisplayTarget = { family: PersonalDesktopFamily; operation: TaskId; admission: EntryId; occurrence: EntryId };
export type PersonalTelegramDisplay = { v: 1; key: string; admission: EntryId; source: PersonalEntryIdentity; messageId: number; selection: TelegramSelection; text: string; buttons: { text: string; action: string; token: string }[]; delivery: PersonalImDeliveryRef; origin: EntryId; target?: PersonalTelegramDisplayTarget; binding?: JsonValue; continuation?: PersonalCuaRecoveryBinding; transition?: string; redisplay?: { display: string }; edit?: { taskId: TaskId; text: string; admission: EntryId; claim?: EntryId; observation?: EntryId; state: "pending" | "sending" | "sent" | "failed" | "effect_unknown" | "canceled" } };
export const PersonalTelegramDisplaysDoc = defineDoc<{ keys: string[] }>({ kind: "ruukoto.telegram-displays", scope: "session", version: 1, initial: () => ({ keys: [] }) });
export const PersonalTelegramDisplayDoc = defineDocFamily<{ display?: PersonalTelegramDisplay }, null>({ kind: "ruukoto.telegram-display", scope: "session", version: 1, family: true, initial: () => ({}) });
export const PersonalTelegramTokenDoc = defineDocFamily<{ display?: string; action?: string }, null>({ kind: "ruukoto.telegram-token", scope: "session", version: 1, family: true, initial: () => ({}) });
export const PersonalTelegramDisplayAdmission = defineEntry<Omit<PersonalTelegramDisplay, "admission" | "edit">>("ruukoto.telegram-display-admission");
