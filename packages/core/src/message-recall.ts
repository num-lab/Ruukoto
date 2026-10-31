/**
 * Persistent recall requests and source barriers serialize one target per conversation.
 * Requests fix the source Task, input sequence, parameter digest and idempotency key; changed parameters reject.
 * A partial unique index permits one pending request. Completed/rejected are terminal; only completion replaces the previous successful identity.
 * sealed_task_ids persists the source barrier, rechecked transactionally before derived registration, delivery, consumption or start; rejected requests create no barrier.
 * This module owns persistence and pure predicates; runtime owns stopping, JSONL edits and progression.
 * Note: See .agents/notes/implemented/feature/2026-10-30-coding-message-recall.md
 */

import { createHash } from "node:crypto";
import type { AttachmentMetadata } from "./attachments.ts";
import type { Store } from "./store.ts";
import type { MessageRecall, MessageRecallPhase, PublicMessageRecall, Task } from "./types.ts";

/**
 * Redacted event, snapshot and query view. Draft text and staged attachments are returned only by
 * message_recall_state with the original request key; broadcasts omit them because the key identifies the initiating client.
 */
export function publicMessageRecall(recall: MessageRecall): PublicMessageRecall {
  const { originalInput: _input, originalAttachments: _attachments, draftAttachments: _drafts, ...rest } = recall;
  return rest;
}

function rowToRecall(row: any): MessageRecall {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    requestId: String(row.request_id),
    paramsDigest: String(row.params_digest),
    targetTaskId: String(row.target_task_id),
    inputSeq: Number(row.input_seq),
    expectedRevision: Number(row.expected_revision),
    execTaskId: row.exec_task_id === null ? null : String(row.exec_task_id),
    phase: row.phase as MessageRecallPhase,
    stopTaskIds: JSON.parse(row.stop_task_ids) as string[],
    sealedTaskIds: JSON.parse(row.sealed_task_ids) as string[],
    omittedEntryIds: row.omitted_entry_ids === null ? null : JSON.parse(row.omitted_entry_ids) as string[],
    historyFingerprint: row.history_fingerprint === null ? null : JSON.parse(row.history_fingerprint) as MessageRecall["historyFingerprint"],
    originalInput: String(row.original_input),
    originalAttachments: JSON.parse(row.original_attachments) as AttachmentMetadata[],
    draftAttachments: row.draft_attachments === null ? null : JSON.parse(row.draft_attachments) as AttachmentMetadata[],
    completionRevision: row.completion_revision === null ? null : Number(row.completion_revision),
    nextCandidateTaskId: row.next_candidate_task_id === null ? null : String(row.next_candidate_task_id),
    editOpen: Number(row.edit_open) === 1,
    savedQueueState: row.saved_queue_state as MessageRecall["savedQueueState"],
    savedQueueReason: row.saved_queue_reason === null ? null : String(row.saved_queue_reason),
    error: row.error_code === null ? null : { code: String(row.error_code), message: String(row.error_message ?? "") },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** The parameter digest is the authority for detecting changed parameters under the same key. */
export function recallParamsDigest(params: { sessionId: string; taskId: string; expectedRevision: number }): string {
  return createHash("sha256").update(JSON.stringify([params.sessionId, params.taskId, params.expectedRevision])).digest("hex");
}

export function insertMessageRecall(store: Store, recall: MessageRecall): void {
  store.db.prepare(
    `INSERT INTO message_recalls (id, session_id, request_id, params_digest, target_task_id, input_seq,
      expected_revision, exec_task_id, phase, stop_task_ids, sealed_task_ids, omitted_entry_ids,
      history_fingerprint, original_input, original_attachments, draft_attachments, completion_revision,
      next_candidate_task_id, edit_open, saved_queue_state, saved_queue_reason, error_code,
      error_message, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
  ).run(
    recall.id, recall.sessionId, recall.requestId, recall.paramsDigest, recall.targetTaskId, recall.inputSeq,
    recall.expectedRevision, recall.execTaskId, recall.phase, JSON.stringify(recall.stopTaskIds),
    JSON.stringify(recall.sealedTaskIds), recall.omittedEntryIds === null ? null : JSON.stringify(recall.omittedEntryIds),
    recall.historyFingerprint === null ? null : JSON.stringify(recall.historyFingerprint),
    recall.originalInput, JSON.stringify(recall.originalAttachments),
    recall.draftAttachments === null ? null : JSON.stringify(recall.draftAttachments), recall.completionRevision,
    recall.nextCandidateTaskId, recall.editOpen ? 1 : 0, recall.savedQueueState, recall.savedQueueReason,
    recall.error?.code ?? null, recall.error?.message ?? null, recall.createdAt, recall.updatedAt,
  );
}

/** Update recall progress without changing the reserved payload. */
export function updateMessageRecall(store: Store, recall: MessageRecall): void {
  store.db.prepare(
    `UPDATE message_recalls SET phase = ?, exec_task_id = ?, stop_task_ids = ?, sealed_task_ids = ?,
      omitted_entry_ids = ?, history_fingerprint = ?, draft_attachments = ?, completion_revision = ?, next_candidate_task_id = ?,
      edit_open = ?, saved_queue_state = ?, saved_queue_reason = ?, error_code = ?, error_message = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    recall.phase, recall.execTaskId, JSON.stringify(recall.stopTaskIds), JSON.stringify(recall.sealedTaskIds),
    recall.omittedEntryIds === null ? null : JSON.stringify(recall.omittedEntryIds),
    recall.historyFingerprint === null ? null : JSON.stringify(recall.historyFingerprint),
    recall.draftAttachments === null ? null : JSON.stringify(recall.draftAttachments),
    recall.completionRevision, recall.nextCandidateTaskId, recall.editOpen ? 1 : 0,
    recall.savedQueueState, recall.savedQueueReason, recall.error?.code ?? null, recall.error?.message ?? null,
    recall.updatedAt, recall.id,
  );
}

export function getMessageRecall(store: Store, id: string): MessageRecall | null {
  const row = store.db.prepare("SELECT * FROM message_recalls WHERE id = ?").get(id) as any;
  return row ? rowToRecall(row) : null;
}

export function findMessageRecall(store: Store, sessionId: string, requestId: string): MessageRecall | null {
  const row = store.db.prepare("SELECT * FROM message_recalls WHERE session_id = ? AND request_id = ?").get(sessionId, requestId) as any;
  return row ? rowToRecall(row) : null;
}

/** Return the conversation's sole pending request, or null. */
export function getOpenMessageRecall(store: Store, sessionId: string): MessageRecall | null {
  const row = store.db
    .prepare(`SELECT * FROM message_recalls WHERE session_id = ? AND phase IN ('accepted','stopping','blocked','applying') ORDER BY created_at DESC LIMIT 1`)
    .get(sessionId) as any;
  return row ? rowToRecall(row) : null;
}

export function listMessageRecalls(store: Store, sessionId: string): MessageRecall[] {
  const rows = store.db.prepare("SELECT * FROM message_recalls WHERE session_id = ? ORDER BY created_at").all(sessionId) as any[];
  return rows.map(rowToRecall);
}

export function latestCompletedRecall(store: Store, sessionId: string): MessageRecall | null {
  const row = store.db
    .prepare("SELECT * FROM message_recalls WHERE session_id = ? AND phase = 'completed' ORDER BY completion_revision DESC LIMIT 1")
    .get(sessionId) as any;
  return row ? rowToRecall(row) : null;
}

/** At most one completed request owns the current edit window. */
export function getEditWindowRecall(store: Store, sessionId: string): MessageRecall | null {
  const row = store.db.prepare("SELECT * FROM message_recalls WHERE session_id = ? AND edit_open = 1").get(sessionId) as any;
  return row ? rowToRecall(row) : null;
}

/** Close edit windows when accepting new input, explicitly resuming the queue or completing a replacement recall. */
export function closeEditWindows(store: Store, sessionId: string, at: string): void {
  store.db.prepare("UPDATE message_recalls SET edit_open = 0, updated_at = ? WHERE session_id = ? AND edit_open = 1").run(at, sessionId);
}

export function nextCompletionRevision(store: Store, sessionId: string): number {
  const row = store.db.prepare("SELECT COALESCE(MAX(completion_revision), 0) + 1 AS next FROM message_recalls WHERE session_id = ?").get(sessionId) as { next: number };
  return Number(row.next);
}

/** Successfully recalled inputs neither appear in the effective projection nor block earlier candidates. */
export function recalledInputTaskIds(store: Store, sessionId: string): Set<string> {
  const rows = store.db.prepare("SELECT target_task_id FROM message_recalls WHERE session_id = ? AND phase = 'completed'").all(sessionId) as any[];
  return new Set(rows.map(row => String(row.target_task_id)));
}

/** Whether a recall request seals this task ID; independent conversations keep their own task identities. */
export function isRecallSealedTask(store: Store, taskId: string): boolean {
  const row = store.db
    .prepare(
      `SELECT 1 FROM message_recalls r, json_each(r.sealed_task_ids) j
       WHERE j.value = ? AND r.phase != 'rejected' LIMIT 1`,
    )
    .get(taskId);
  return row !== undefined;
}

/** Real owner input: ordinary Coding input or a continuation answering a structured question. */
export function isOwnerInputTask(store: Store, task: Task): boolean {
  return store.ordinaryCodeTask(task) || store.hasOwnerQuestionContinuation(task.id);
}

/** Structured question answers are unsupported recall targets; reject rather than skip them. */
export function recallInputSupported(store: Store, task: Task): boolean {
  return store.ordinaryCodeTask(task) && !store.hasOwnerQuestionContinuation(task.id);
}

/**
 * The latest accepted real owner input not successfully recalled, ordered by input acceptance.
 * Do not infer the candidate from the queue tail, visible messages or active task.
 */
export function recallCandidate(store: Store, sessionId: string): { task: Task; inputSeq: number } | null {
  const recalled = recalledInputTaskIds(store, sessionId);
  let best: { task: Task; inputSeq: number } | null = null;
  for (const task of store.listTasksBySession(sessionId)) {
    if (!isOwnerInputTask(store, task) || recalled.has(task.id)) continue;
    const inputSeq = store.getTaskInputSeq(task);
    if (inputSeq === null) continue;
    if (!best || inputSeq > best.inputSeq) best = { task, inputSeq };
  }
  return best;
}
