import { defineDoc, defineDocFamily, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import type { PersonalServiceMode, PersonalServiceOperationRef } from "./personal-service-operations.ts";
import type { PersonalTelegramConfig } from "./personal-telegram-config.ts";
import type { PersonalWorkRef } from "./personal-work.ts";
import type { PersonalDelegationRef } from "./personal-delegation.ts";

export type TelegramSelection = { kind: "mode" } | { kind: "approval" | "service-status"; ref: PersonalServiceOperationRef } | { kind: "grant"; id: string; version: number } | { kind: "work-list"; refs: PersonalWorkRef[]; nextOffset?: number } | { kind: "work"; ref: PersonalWorkRef; nextOffset?: number } | { kind: "delegation-list"; refs: PersonalDelegationRef[]; nextOffset?: number } | { kind: "delegation"; ref: PersonalDelegationRef; nextOffset?: number; reportNextOffset?: number };
type Delivery = "waiting" | "pending" | "sending" | "sent" | "failed" | "effect_unknown" | "canceled" | "unanswered";
export type TelegramResult = { delivery: Delivery };
export type TelegramReceipt = { taskId: TaskId<TelegramResult>; requestId: string; generation: string; botId: string; ownerId: string; messageId: number; updateId: number; content: string; direct?: boolean; replyTo?: number; replyBotId?: string; permission?: { mode: PersonalServiceMode; version: number }; control?: boolean; serviceDecision?: { ref: PersonalServiceOperationRef; decision: "approved" | "rejected"; grant?: { id: string; version: number } }; selection?: TelegramSelection; submissionId?: SubmissionId; delivery: Delivery; reply?: string; platformMessageId?: string };
export const PersonalTelegramDoc = defineDoc<{ config?: PersonalTelegramConfig; lastUpdateId?: number; rejected: number }>({ kind: "ruukoto.telegram", scope: "session", version: 1, initial: () => ({ rejected: 0 }) });
export const PersonalTelegramReceiptDoc = defineDocFamily<{ receipt?: TelegramReceipt }, null>({ kind: "ruukoto.telegram-receipt", scope: "session", version: 1, family: true, initial: () => ({}) });
export type TelegramControlInput = Omit<TelegramReceipt, "taskId">;
