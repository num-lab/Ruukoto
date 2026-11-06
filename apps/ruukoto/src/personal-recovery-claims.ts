import { isDeepStrictEqual } from "node:util";
import { defineEntry, ROOT_CONVERSATION_ID, type EntryId, type Tx } from "@earendil-works/pi-durable";
import type { PersonalDesktopAction, PersonalDesktopCheck, PersonalDesktopFamily } from "@ruukoto/view/personal-protocol.ts";
import { PersonalError } from "./personal-error.ts";
import { telegramSelection, telegramSourceActive } from "./personal-permissions.ts";
import { PersonalTelegramReceiptDoc, samePersonalEntry, type TelegramControlInput, type TelegramSelection } from "./personal-telegram-records.ts";

export type PersonalNativeActor = { kind: "local" } | { kind: "native"; credential: string };
export type PersonalImClaimActor = { kind: "im"; requestId: string; menuRequestId: string; botId: string; ownerId: string; generation: string; messageId: number };
export type PersonalRecoveryEvidence = { evidence?: string; claim?: EntryId };
type Claim = { v: 1; requestId: string; action: EntryId; family: PersonalDesktopFamily; operation: number; admission: number; occurrence: number; actor: PersonalNativeActor | PersonalImClaimActor; at: number; effect: "applied" | "not_applied"; check?: EntryId };
type Check = { v: 1; requestId: string; action: EntryId; family: PersonalDesktopFamily; operation: number; admission: number; actor: PersonalNativeActor; at: number; kind: PersonalDesktopCheck["kind"]; code: string; text: string };
export const PersonalOwnerClaim = defineEntry<Claim>("ruukoto.owner-effect-claim");
export const PersonalImEffectAction = defineEntry<{ v: 1; requestId: string; family: PersonalDesktopFamily; operation: number; admission: number; actor: PersonalImClaimActor; content: string }>("ruukoto.im-effect-action");
export const PersonalRecoveryCheck = defineEntry<Check>("ruukoto.recovery-check");
const invalid = () => new PersonalError("recovery_claim_invalid", "原效果说明或检查来源无法核实，请查询原操作。");
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
export function personalNativeActorValid(value: PersonalNativeActor | PersonalImClaimActor) { return value.kind === "local" ? Object.keys(value).length === 1 : value.kind === "native" && Object.keys(value).length === 2 && typeof value.credential === "string" && /^[0-9a-f-]{36}$/.test(value.credential); }

function imSelectionOperation(menu: TelegramSelection | undefined, family: PersonalDesktopFamily) {
  if (family === "tools" && menu?.kind === "tool" || family === "browser" && menu?.kind === "browser" || family === "mcp" && menu?.kind === "mcp") return menu.operation;
  if (family === "commands" && menu?.kind === "command") return menu.ref.taskId;
  if (family === "services" && menu?.kind === "service-recovery") return menu.ref.taskId;
  return undefined;
}
function imClaimActorValid(actor: PersonalImClaimActor) { return Object.keys(actor).length === 7 && typeof actor.requestId === "string" && typeof actor.menuRequestId === "string" && typeof actor.botId === "string" && typeof actor.ownerId === "string" && typeof actor.generation === "string" && positive(actor.messageId); }
function imClaimReceipt(value: TelegramControlInput, family: PersonalDesktopFamily) {
  if (family === "tools") return value.toolResolution;
  if (family === "browser") return value.browserResolution;
  if (family === "mcp") return value.mcpResolution;
  const ref = family === "commands" ? value.commandResolution : family === "services" ? value.serviceResolution : undefined;
  return ref && { operation: ref.ref.taskId, effect: ref.effect };
}
export async function personalImControlAccepted(tx: Tx, value: TelegramControlInput) {
  const entry = value.accepted === undefined ? undefined : await tx.entry(value.accepted), data = entry?.data;
  if (!entry || entry.conversationId !== ROOT_CONVERSATION_ID || !data || typeof data !== "object" || Array.isArray(data)) return false;
  if (entry.kind === "ruukoto.telegram-received") return isDeepStrictEqual(data, { requestId: value.requestId, generation: value.generation });
  if (entry.kind !== "ruukoto.telegram-callback" || !Number.isSafeInteger(value.messageId) || value.messageId < 1 || !value.requestId.startsWith(`telegram-callback:${value.botId}:`)) return false;
  const raw = value as TelegramControlInput & { callback?: { queryId: string; token: string; display: string } };
  return !!raw.callback && typeof raw.callback.queryId === "string" && raw.callback.queryId.length > 0 && Buffer.byteLength(raw.callback.queryId) <= 256 && !/[\x00-\x1f\x7f]/.test(raw.callback.queryId) && typeof raw.callback.token === "string" && raw.callback.token.length > 0 && Buffer.byteLength(raw.callback.token) <= 64 && typeof raw.callback.display === "string" && raw.callback.display.length > 0 && value.requestId === `telegram-callback:${value.botId}:${raw.callback.queryId}` && isDeepStrictEqual(data, { requestId: value.requestId, generation: value.generation, ...raw.callback });
}
export function personalImEffectContent(family: PersonalDesktopFamily, effect: "applied" | "not_applied") {
  const prefix = ({ tools: "工具确认", browser: "浏览器确认", mcp: "MCP确认", commands: "命令确认", services: "确认" } as Partial<Record<PersonalDesktopFamily, string>>)[family];
  return prefix === undefined ? undefined : prefix + (effect === "applied" ? "已生效" : "未生效");
}

export async function recordPersonalImOwnerClaim(tx: Tx, value: TelegramControlInput, target: { family: PersonalDesktopFamily; operation: number; admission: number }, effect: "applied" | "not_applied") {
  const menu = await telegramSelection(tx, value);
  if (value.platform !== undefined || !value.direct || value.replyTo === undefined || !positive(value.replyTo) || !positive(target.operation) || !positive(target.admission) || !menu || imSelectionOperation(menu.selection, target.family) !== target.operation || value.content !== personalImEffectContent(target.family, effect) || !await telegramSourceActive(tx, value)) throw invalid();
  const actor: PersonalImClaimActor = { kind: "im", requestId: value.requestId, menuRequestId: menu.requestId, botId: value.botId, ownerId: value.ownerId, generation: value.generation, messageId: value.replyTo };
  const action = (await tx.appendEntry(PersonalImEffectAction, ROOT_CONVERSATION_ID, { data: { v: 1, requestId: value.requestId, ...target, actor, content: value.content } })).id;
  return (await tx.appendEntry(PersonalOwnerClaim, ROOT_CONVERSATION_ID, { data: { v: 1, requestId: value.requestId, action, ...target, occurrence: value.replyTo, actor, at: Date.now(), effect } })).id;
}

// Note: See .agents/notes/implemented/architecture/2026-11-05-personal-desktop-recovery.md
export async function recordPersonalOwnerClaim(tx: Tx, request: PersonalDesktopAction, action: EntryId, actor: PersonalNativeActor) {
  if (!["claim_applied", "claim_not_applied"].includes(request.action) || !personalNativeActorValid(actor)) throw invalid();
  return (await tx.appendEntry(PersonalOwnerClaim, ROOT_CONVERSATION_ID, { data: { v: 1, requestId: request.requestId, action, family: request.family, operation: request.operation, admission: request.admission, occurrence: request.occurrence, actor, at: Date.now(), effect: request.action === "claim_applied" ? "applied" : "not_applied", ...(request.check === undefined ? {} : { check: request.check as EntryId }) } })).id;
}

export async function verifyPersonalOwnerClaim(tx: Tx, id: EntryId, expected: { family: PersonalDesktopFamily; operation: number; admission: number; effect: "applied" | "not_applied" }) {
  const entry = await tx.entry(PersonalOwnerClaim, id), claim = entry?.data;
  if (!entry || entry.conversationId !== ROOT_CONVERSATION_ID || !claim || claim.v !== 1 || !claim.actor || !positive(claim.action) || claim.action >= entry.id || !positive(claim.admission) || claim.admission >= claim.action || !Number.isSafeInteger(claim.at) || claim.at < 1 || !isDeepStrictEqual({ family: claim.family, operation: claim.operation, admission: claim.admission, effect: claim.effect }, expected)) throw invalid();
  if (claim.actor.kind === "im") {
    const actor = claim.actor, action = await tx.entry(PersonalImEffectAction, claim.action), value = (await tx.doc(PersonalTelegramReceiptDoc, claim.requestId, null)).receipt, menu = value && await telegramSelection(tx, value);
    if (!imClaimActorValid(actor) || !value?.control || !value.direct || value.platform !== undefined || !await personalImControlAccepted(tx, value) || !samePersonalEntry(actor, value) || value.requestId !== actor.requestId || value.requestId !== claim.requestId || value.replyTo !== actor.messageId || claim.occurrence !== actor.messageId || menu?.requestId !== actor.menuRequestId || imSelectionOperation(menu.selection, claim.family) !== claim.operation || value.content !== personalImEffectContent(claim.family, claim.effect) || !isDeepStrictEqual(imClaimReceipt(value, claim.family), { operation: claim.operation, effect: claim.effect }) || claim.check !== undefined || !action || action.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(action.data, { v: 1, requestId: claim.requestId, family: claim.family, operation: claim.operation, admission: claim.admission, actor, content: value.content })) throw invalid();
    return claim;
  }
  if (!personalNativeActorValid(claim.actor)) throw invalid();
  const action = await tx.entry(claim.action), data = action?.data;
  if (action?.kind !== "ruukoto.desktop-action-admission" || !data || typeof data !== "object" || Array.isArray(data) || !isDeepStrictEqual(data.actor, claim.actor) || !data.request || typeof data.request !== "object" || Array.isArray(data.request) || data.request.requestId !== claim.requestId || data.request.family !== claim.family || data.request.operation !== claim.operation || data.request.admission !== claim.admission || data.request.occurrence !== claim.occurrence || data.request.action !== (claim.effect === "applied" ? "claim_applied" : "claim_not_applied") || data.request.check !== claim.check) throw invalid();
  if (claim.check !== undefined) { if (claim.check >= entry.id) throw invalid(); await verifyPersonalRecoveryCheck(tx, claim.check, claim); }
  return claim;
}

export function personalRecoveryEvidence(value: string | { claim: EntryId }): PersonalRecoveryEvidence {
  if (typeof value === "string") { if (!value.trim() || value.length > 8192) throw invalid(); return { evidence: value }; }
  if (!value || Object.keys(value).length !== 1 || !positive(value.claim)) throw invalid();
  return { claim: value.claim };
}
export function personalRecoveryEvidenceText(value: { evidence?: string; claim?: EntryId }) { return value.claim === undefined ? value.evidence ?? "" : "拥有者已说明实际效果。"; }

export async function recordPersonalRecoveryCheck(tx: Tx, request: PersonalDesktopAction, action: EntryId, actor: PersonalNativeActor, value: Omit<PersonalDesktopCheck, "entry">) {
  const entry = await tx.appendEntry(PersonalRecoveryCheck, ROOT_CONVERSATION_ID, { data: { v: 1, requestId: request.requestId, action, family: request.family, operation: request.operation, admission: request.admission, actor, at: Date.now(), ...value, text: value.text.slice(0, 2048) } });
  return { entry: entry.id, kind: entry.data.kind, code: entry.data.code, text: entry.data.text };
}
export async function verifyPersonalRecoveryCheck(tx: Tx, id: EntryId, expected: Pick<PersonalDesktopAction, "family" | "operation" | "admission">) {
  const entry = await tx.entry(PersonalRecoveryCheck, id), check = entry?.data;
  if (!entry || entry.conversationId !== ROOT_CONVERSATION_ID || !check || check.v !== 1 || check.family !== expected.family || check.operation !== expected.operation || check.admission !== expected.admission || !positive(check.action) || check.action >= entry.id || check.admission >= check.action || !personalNativeActorValid(check.actor) || !Number.isSafeInteger(check.at) || check.at < 1 || !["receipt", "observation"].includes(check.kind) || typeof check.code !== "string" || typeof check.text !== "string" || check.text.length > 2048) throw invalid();
  const action = await tx.entry(check.action), data = action?.data;
  if (action?.kind !== "ruukoto.desktop-action-admission" || !data || typeof data !== "object" || Array.isArray(data) || !isDeepStrictEqual(data.actor, check.actor) || !data.request || typeof data.request !== "object" || Array.isArray(data.request) || data.request.action !== "check" || data.request.requestId !== check.requestId || data.request.family !== check.family || data.request.operation !== check.operation || data.request.admission !== check.admission) throw invalid();
  return check;
}
