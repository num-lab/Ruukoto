import { PersonalError } from "./personal-error.ts";
import type { PersonalEntryIdentity } from "./personal-telegram-records.ts";

export type PersonalImSender = { send(ownerId: string, messageId: number, text: string, signal: AbortSignal): Promise<string> };
export interface PersonalImAccess {
  withEntry<T>(source: { platform?: "qq" }, action: () => Promise<T>): Promise<T>;
  sender(source: PersonalEntryIdentity): PersonalImSender | undefined;
  configurationVersion(source: { platform?: "qq" }): string | undefined;
  isActive(source: PersonalEntryIdentity): boolean;
}
export function withPersonalImEntry<T>(im: PersonalImAccess | undefined, source: { platform?: "qq" }, action: () => Promise<T>): Promise<T> { return im ? im.withEntry(source, action) : action(); }

export class PersonalImApiError extends PersonalError {
  constructor(code: string, message: string, readonly effect: "not_sent" | "effect_unknown", readonly retryAfterMs?: number) { super(code, message); }
}
