import { PersonalError } from "./personal-error.ts";
import type { PersonalEntryIdentity } from "./personal-telegram-records.ts";

export type PersonalImDocument = { name: string; mime: string; bytes: Uint8Array };
export type PersonalImKeyboard = { text: string; callback_data: string }[][];
export type PersonalImSender = { send(ownerId: string, messageId: number, text: string, signal: AbortSignal, keyboard?: PersonalImKeyboard): Promise<string>; document?(ownerId: string, messageId: number, file: PersonalImDocument, signal: AbortSignal): Promise<string> };
export interface PersonalImAccess {
  readonly delivery?: ReturnType<typeof import("./personal-im-delivery.ts").personalImDelivery>;
  withEntry<T>(source: { platform?: "qq" }, action: () => Promise<T>): Promise<T>;
  sender(source: PersonalEntryIdentity): PersonalImSender | undefined;
  configurationVersion(source: { platform?: "qq" }): string | undefined;
  isActive(source: PersonalEntryIdentity): boolean;
}
export function withPersonalImEntry<T>(im: PersonalImAccess | undefined, source: { platform?: "qq" }, action: () => Promise<T>): Promise<T> { return im ? im.withEntry(source, action) : action(); }

export class PersonalImApiError extends PersonalError {
  constructor(code: string, message: string, readonly effect: "not_sent" | "effect_unknown", readonly retryAfterMs?: number) { super(code, message); }
}
