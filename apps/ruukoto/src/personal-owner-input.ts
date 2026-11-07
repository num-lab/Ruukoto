import { defineDocFamily, defineEntry, ROOT_CONVERSATION_ID, type EntryId, type EntryRecord, type InputSubmissionDraft, type SubmissionId, type SubmissionRecord, type Tx } from "@earendil-works/pi-durable";
import { LocalInputDoc, personalInputDigest } from "./personal-local-records.ts";
import { PersonalError } from "./personal-error.ts";
import type { PersonalTimelineEntry } from "@ruukoto/view/personal-protocol.ts";
import { nativeMetadata, personalMediaInput, PersonalMediaMessageDoc } from "./personal-media.ts";
import { isDeepStrictEqual } from "node:util";

// Note: See .agents/notes/implemented/feature/2026-11-04-personal-desktop-file-loop.md
export const PersonalOwnerInput = defineEntry<{ version: 1; requestId: string; submission: number; text: string; receivedAt: number }>("ruukoto.owner-input-display");
const PersonalOwnerInputDoc = defineDocFamily<{ display?: EntryId; historyEntry?: EntryId }, null>({ kind: "ruukoto.owner-input-display", scope: "session", version: 1, family: true, initial: () => ({}) });
const PersonalOwnerHistoryDoc = defineDocFamily<{ requestId?: string }, null>({ kind: "ruukoto.owner-input-history", scope: "session", version: 1, family: true, initial: () => ({}) });
const PersonalOwnerSubmissionDoc = defineDocFamily<{ requestId?: string }, null>({ kind: "ruukoto.owner-input-submission", scope: "session", version: 1, family: true, initial: () => ({}) });

export async function recordPersonalOwnerInput(tx: Tx, draft: InputSubmissionDraft, submission: SubmissionRecord, receivedAt: number) {
  if (draft.entry !== undefined || draft.requestId === undefined) return;
  const authority = await tx.doc(LocalInputDoc, draft.requestId, "");
  if (authority.accepted === undefined || authority.work !== undefined) return;
  const text = typeof draft.content === "string" ? draft.content : authority.text;
  if (text === undefined || authority.digest !== personalInputDigest(text, undefined, authority.attachments)) throw new PersonalError("input_conflict", "同一请求的正文或附件不一致，请核实原消息。");
  if (authority.attachments?.length) {
    const message = (await tx.doc(PersonalMediaMessageDoc, draft.requestId, null)).message;
    if (!message || !["ready", "bound"].includes(message.state) || !isDeepStrictEqual(nativeMetadata(message), authority.attachments) || message.submissionId !== undefined && message.submissionId !== submission.id) throw new PersonalError("input_conflict", "附件与原输入提交关系不一致，请核实原消息。");
    message.state = "bound"; message.submissionId = submission.id;
  }
  const record = await tx.doc(PersonalOwnerInputDoc, draft.requestId, null);
  if (record.display !== undefined) return;
  record.display = (await tx.appendEntry(PersonalOwnerInput, ROOT_CONVERSATION_ID, { data: { version: 1, requestId: draft.requestId, submission: submission.id, text, receivedAt } })).id;
  (await tx.doc(PersonalOwnerSubmissionDoc, String(submission.id), null)).requestId = draft.requestId;
  if (submission.entry !== undefined) await associatePersonalOwnerInput(tx, submission.id, submission.entry);
}

export async function associatePersonalOwnerInput(tx: Tx, submission: SubmissionId, historyEntry: EntryId) {
  const requestId = (await tx.doc(PersonalOwnerSubmissionDoc, String(submission), null)).requestId;
  if (requestId === undefined) return;
  const record = await tx.doc(PersonalOwnerInputDoc, requestId, null);
  if (record.display === undefined) return;
  if (record.historyEntry !== undefined && record.historyEntry !== historyEntry) throw new PersonalError("input_display_invalid", "原消息的历史关联不一致，请保留档案并检查原输入。");
  record.historyEntry = historyEntry;
  (await tx.doc(PersonalOwnerHistoryDoc, String(historyEntry), null)).requestId = requestId;
}

export async function personalOwnerInputMessage(tx: Tx, entry: EntryRecord): Promise<PersonalTimelineEntry | undefined> {
  if (!PersonalOwnerInput.is(entry)) return;
  const data = entry.data;
  const invalid = () => new PersonalError("input_display_invalid", "原消息的接纳记录无法核实，请保留档案并检查原输入。");
  if (entry.conversationId !== ROOT_CONVERSATION_ID || data.version !== 1 || typeof data.requestId !== "string" || typeof data.text !== "string" || !Number.isFinite(data.receivedAt) || !Number.isSafeInteger(data.submission)) throw invalid();
  const native = await tx.submissionByRequest(ROOT_CONVERSATION_ID, data.requestId), record = await tx.doc(PersonalOwnerInputDoc, data.requestId, null), authority = await tx.doc(LocalInputDoc, data.requestId, "");
  if (!native || native.type !== "input" || native.id !== data.submission || record.display !== entry.id || authority.accepted === undefined || authority.digest !== personalInputDigest(data.text, undefined, authority.attachments) || record.historyEntry !== native.entry) throw invalid();
  if (native.entry !== undefined) {
    const history = await tx.entry(native.entry), association = await tx.doc(PersonalOwnerHistoryDoc, String(native.entry), null), message = history?.model?.[0];
    const media = authority.attachments ? (await tx.doc(PersonalMediaMessageDoc, data.requestId, null)).message : undefined;
    if (association.requestId !== data.requestId || message?.role !== "user" || (authority.attachments ? !media || !isDeepStrictEqual(message.content, personalMediaInput(media)) : message.content !== data.text)) throw invalid();
  }
  if (authority.attachments) { const media = (await tx.doc(PersonalMediaMessageDoc, data.requestId, null)).message; if (!media || !isDeepStrictEqual(nativeMetadata(media), authority.attachments)) throw invalid(); }
  return { entry: entry.id, conversation: entry.conversationId, kind: entry.kind, role: "user", text: data.text.slice(0, 4096), partial: false, truncated: data.text.length > 4096, timestamp: data.receivedAt, ...(authority.attachments ? { attachments: authority.attachments.map(ref => ({ ...ref })) } : {}), input: { requestId: data.requestId, submission: native.id, status: native.status, ...(native.entry ===undefined ? {} : { historyEntry: native.entry }) } };
}

export async function personalOwnerHistoryAssociated(tx: Tx, entry: EntryRecord, through = Infinity) {
  if (entry.kind !== "pi.user") return false;
  const record = await tx.doc(PersonalOwnerHistoryDoc, String(entry.id), null);
  if (record.requestId === undefined) return false;
  const display = (await tx.doc(PersonalOwnerInputDoc, record.requestId, null)).display;
  if (display !== undefined && display > through) return false;
  const original = display === undefined ? undefined : await tx.entry(display);
  const message = original && await personalOwnerInputMessage(tx, original);
  if (message?.input?.historyEntry !== entry.id) throw new PersonalError("input_display_invalid", "原消息的显示记录缺失或关联不符，请保留档案并检查原输入。");
  return true;
}

export async function personalOwnerSubmissionMessage(tx: Tx, submission: number) {
  const requestId = (await tx.doc(PersonalOwnerSubmissionDoc, String(submission), null)).requestId;
  if (requestId === undefined) return;
  const display = (await tx.doc(PersonalOwnerInputDoc, requestId, null)).display;
  const entry = display === undefined ? undefined : await tx.entry(display);
  if (!entry) throw new PersonalError("input_display_invalid", "原消息的显示记录缺失，请保留档案并检查原输入。");
  const message = await personalOwnerInputMessage(tx, entry);
  if (message?.input?.submission !== submission) throw new PersonalError("input_display_invalid", "原消息的提交关联不符，请保留档案并检查原输入。");
  return message;
}

export async function personalOwnerInputByRequest(tx: Tx, requestId: string) {
  const display = (await tx.doc(PersonalOwnerInputDoc, requestId, null)).display;
  if (display === undefined) return null;
  const entry = await tx.entry(display);
  if (!entry) throw new PersonalError("input_display_invalid", "原消息的显示记录缺失，请保留档案并检查原输入。");
  const message = await personalOwnerInputMessage(tx, entry);
  if (message?.input?.requestId !== requestId) throw new PersonalError("input_display_invalid", "原消息的请求关联不符，请保留档案并检查原输入。");
  return message;
}
