import { isDeepStrictEqual } from "node:util";
import { defineEntry, ROOT_CONVERSATION_ID, type EntryId, type Tx } from "@earendil-works/pi-durable";
import type { PersonalDesktopAction, PersonalDesktopCheck, PersonalDesktopFamily } from "@ruukoto/view/personal-protocol.ts";
import { PersonalError } from "./personal-error.ts";

export type PersonalNativeActor = { kind: "local" } | { kind: "native"; credential: string };
export type PersonalRecoveryEvidence = { evidence?: string; claim?: EntryId };
type Claim = { v: 1; requestId: string; action: EntryId; family: PersonalDesktopFamily; operation: number; admission: number; occurrence: number; actor: PersonalNativeActor; at: number; effect: "applied" | "not_applied"; check?: EntryId };
type Check = { v: 1; requestId: string; action: EntryId; family: PersonalDesktopFamily; operation: number; admission: number; actor: PersonalNativeActor; at: number; kind: PersonalDesktopCheck["kind"]; code: string; text: string };
export const PersonalOwnerClaim = defineEntry<Claim>("ruukoto.owner-effect-claim");
export const PersonalRecoveryCheck = defineEntry<Check>("ruukoto.recovery-check");
const invalid = () => new PersonalError("recovery_claim_invalid", "原效果说明或检查来源无法核实，请查询原操作。");
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
export function personalNativeActorValid(value: PersonalNativeActor) { return value.kind === "local" ? Object.keys(value).length === 1 : value.kind === "native" && Object.keys(value).length === 2 && typeof value.credential === "string" && /^[0-9a-f-]{36}$/.test(value.credential); }

// Note: See .agents/notes/implemented/architecture/2026-11-05-personal-desktop-recovery.md
export async function recordPersonalOwnerClaim(tx: Tx, request: PersonalDesktopAction, action: EntryId, actor: PersonalNativeActor) {
  if (!["claim_applied", "claim_not_applied"].includes(request.action) || !personalNativeActorValid(actor)) throw invalid();
  return (await tx.appendEntry(PersonalOwnerClaim, ROOT_CONVERSATION_ID, { data: { v: 1, requestId: request.requestId, action, family: request.family, operation: request.operation, admission: request.admission, occurrence: request.occurrence, actor, at: Date.now(), effect: request.action === "claim_applied" ? "applied" : "not_applied", ...(request.check === undefined ? {} : { check: request.check as EntryId }) } })).id;
}

export async function verifyPersonalOwnerClaim(tx: Tx, id: EntryId, expected: { family: PersonalDesktopFamily; operation: number; admission: number; effect: "applied" | "not_applied" }) {
  const entry = await tx.entry(PersonalOwnerClaim, id), claim = entry?.data;
  if (!entry || entry.conversationId !== ROOT_CONVERSATION_ID || !claim || claim.v !== 1 || !positive(claim.action) || claim.action >= entry.id || claim.admission >= claim.action || !Number.isSafeInteger(claim.at) || claim.at < 1 || !personalNativeActorValid(claim.actor) || !isDeepStrictEqual({ family: claim.family, operation: claim.operation, admission: claim.admission, effect: claim.effect }, expected)) throw invalid();
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
