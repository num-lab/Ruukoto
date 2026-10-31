# Agent Note: Recall Coding messages with append-only omissions

Status: implemented

[User queue controls](2026-10-30-coding-user-queue.md) replaces the latest-candidate and edit-pause rules for queued input with independent retrieval of any unstarted item. Historical recall retains source sealing and append-only omission. The follow-up owns the queued-retrieval contract; this note preserves historical recall and its retained guarantees.

## Problem

The owner needs to correct the latest Coding input, including after a completed reply, and recall earlier inputs one at a time. Input history only copies text; canceling a Task only stops execution. Neither removes old input and subsequent output from model context. Moving the SDK's in-memory leaf does not survive reopening and would invalidate the host's linear history reader.

The imported requirements, implementation provenance and remaining acceptance are tracked in [the integration issue](https://github.com/num-lab/Ruukoto/issues/29). Original specifications and execution evidence remain in the legacy repository's offline records.

## Decision

Use Pi 1.3.0's public `SessionManager.appendContextEdit(entryId, null)` to append one omission per recalled model-visible contribution, followed by an ordinary `custom` completion marker (`ruukoto_message_recall`). Original JSONL bytes, IDs, physical order and parent chains stay unchanged. New context and default history reads use the effective projection.

Do not use `navigateTree`: it can be a no-op when the user entry is already the leaf, and leaf changes are only in memory. Persistent omission avoids relaxing `core/history.ts` physical-linearity checks or adding history-file generations to one conversation.

### Input and execution identity

`recallCandidate` in `packages/core/src/message-recall.ts` selects the source Task with the latest `Store.getTaskInputSeq` among all genuine owner inputs in the conversation, excluding successful recalls. Unsupported question answers must remain candidates and reject explicitly, rather than being filtered out first. Terminal state, ordinary cancellation and `converted_to_guidance` do not mean recalled.

The source Task identifies one owner input; the execution Task identifies its execution. Guidance and original requirements can share an execution Task. After guidance is recalled, the retained original requirement can become the next candidate. A request fixes source Task, acceptance sequence, conversation completion revision and idempotency key. Reusing a key with changed parameters conflicts; retrying an old key only verifies its original target.

Later-input blocking uses the effective projection: successfully omitted user entries no longer block earlier input, but unrecalled user entries still block after their tasks finish. Recheck after freezing and before appending any omission.

### Stopping and sealing sources

Accepting recall intent freezes this conversation's new input, dispatch and conflicting history operations with queue pause reason `message_recall`. It seals affected execution sources against new derived work, deliveries and unconsumed operations. Derived registration and approval consumption recheck the barrier transactionally: `assertSourceNotSealed` guards `Runtime.workflowSource`, SubAgent `assertSource`, submitted `parentTaskId` and approval consumption. Started operations retain their real effect facts.

Freeze and verify the stopping closure through trusted provenance: execution Task, host-derived tasks, work delegations, workflow runs and executions, background processes and pending deliveries. Time, text or bare SDK call IDs cannot establish ownership. Reused work from another task, inseparable shared sources and conflicting associations block recall. Newly discovered registered members join verification during finalization; the source barrier prevents indefinite growth. Sources remain sealed after completion.

Completion requires actual subsystem stopping facts, including retained SubAgent occupancy, workflow stop verification and background `stopped`/`stopVerified`. A terminal Task alone is insufficient. Effect unknown and stop unverified remain separate; neither becomes known-not-executed or permits automatic occupancy release.

Workflow cancellation cannot independently verify stopping after reaching a terminal state. Recall provides `message_recall_verify` / `verifyMessageRecallStop`: retry only the original stop and verify the same execution identity, then release corresponding old occupancy and advance the original recall. Never restart scripts, steps or models. Unverified stopping remains phase `blocked` with `stop_unverified`; do not reuse a cached failed Promise.

Terminal tasks can retain pending questions or unconsumed approvals; stopping explicitly invalidates them. The write barrier does not reject read-only source audits or legitimate identity reuse by a new Task.

### Persistent commit and recovery

`message_recalls` fixes input, execution ownership, history identity/fingerprint, original text/attachments, stopping and sealed-source sets, phase, completion revision, edit window and machine-readable failure. The final omission list is fixed only after execution becomes quiescent because stopping can still append genuine output.

1. Preflight eligibility, trusted history and attachments. Transactionally accept the fixed request and save prior queue state, pause and source barrier. Allow at most one unresolved recall per conversation.
2. Resolve guidance ownership and verify whole-closure stopping. Reopen the real JSONL, verify its original prefix and final effective dialogue, fix the remaining contribution IDs from the target onward and their fingerprint, then enter `applying`.
3. With a fresh manager, append null edits for list members not already omitted, append the non-model `custom` completion marker and flush. Discard the manager after any failure rather than trusting its memory.
4. Verify marker, complete list and recoverable text/attachments. In one SQL transaction record `completed`, next candidate, revision and persistent `message_recall.changed` event. Enter edit pause `message_recall_edit` without automatic dispatch.

The queued fast path requires proof that input was never admitted; it cancels and completes transactionally without requiring a history file or opening another manager. A missing previously existing log is not proof of fast-path eligibility.

JSONL and SQLite are not atomic. Startup `MessageRecallRuntime.recoverAll`, after workflow/SubAgent assembly, or an original-key write retry advances pending/applying requests from their original fingerprint and fixed list. Append missing edits, or complete the SQL receipt when the file is already complete; never select a new latest input. `message_recall_state` only queries. If SQL claims completion but the log is missing, malformed, has a partial tail or changed prefix, retain the pause and report it without truncating or rewriting the source. Raw audit remains readable; model execution, effective history, branching and compaction that could expose a partial application reject until recovery completes.

Preflight rejection does not overwrite drafts. Failure after stopping or during application preserves actual stopped state, barriers and blockers. `resume_queue` cannot bypass unfinished recall (`recall_pending`) or corrupt history. Explicit resumption of an edit window closes it and restores the saved pre-recall queue state. Successfully accepting new input clears only this edit pause, without calling generic resumption that could release retained occupancy.

### Effective projection and physical audit

`packages/core/src/history-effective.ts` is read-only. An edit may reference only an earlier editable contribution in the same file: a user/assistant/toolResult message or `custom_message`. Only null replacement is supported; invalid references produce `history_corrupt`. `materializeEffectiveHistory` creates an effective-only prefix copy; the `session` header is outside the parent chain.

| Consumer | Read contract |
| --- | --- |
| Driver messages, context selection, automatic/manual compaction, work checklist and browser observations | Effective contributions; discard old SDK/manager after stopping and reverify compaction against the effective prefix |
| Default chat, `readHistoryPage` / `readHistoryEntryText`, history index/search | Effective contributions; completion revision invalidates old pages, stream fragments, searches and draft receipts |
| Original Task/guidance disk ownership, tool effects, approvals and recovery audit | Original physical records |
| New branches and side chat through `snapshotSessionHistory` / `effectiveBranchHistoryBytes` | Freeze the whole source file including trailing omissions; `cutEntryId` retains the original selection boundary; copy effective entries with reconnected parents, not edit-control entries |
| Existing independent branches and side chat | Retain their own snapshots; never hide globally by the parent conversation's source Task ID |

Ordinary `custom` entries, including task boundaries, guidance provenance and recall completion, do not contribute model input and remain in copies. `custom_message` does contribute and can be omitted. Historical system messages are not edit targets. Native `compaction`/`branch_summary` do not support null edits; the host disables them and rejects unexpected contributions.

### Attachments and clients

Attachments already bound to an old Task cannot be rebound. `OwnerAttachments.restoreForRecall` verifies original conversation, source Task, bytes and hash, then creates new staged references from immutable original bytes. `draft_attachments` persists them with per-request idempotency. Original attachments/artifacts remain unchanged; no arbitrary artifact ID or local-path access is added. TUI adds only restored-attachment state, display, removal (`/detach`) and sending.

Desktop reuses message action bars and queue actions, showing recall only for the server-selected candidate. Composer offers verify-only when blocked. TUI exposes `/recall` and `/recall verify`. The initial receipt is an asynchronous acceptance snapshot: the initiator records its request key first; Desktop persists it in localStorage and rechecks original-key edit ownership after cold startup, while TUI polls until resolution. On completion, `message_recall_state.edit` replaces the original conversation's draft and clears continuation/guidance state. Rejection, another client's later recall or new input invalidates the key.

Events, snapshots and `message_recall_state.open`/`receipt` expose only sanitized `PublicMessageRecall`. Neither `originalInput` nor old/new attachment references are broadcast. Only a caller holding the original request key obtains draft text through `edit.input` and new attachment references.

While recall is unresolved, `assertNoOpenRecall` rejects steering, cancellation, reordering, branching, side chat, manual compaction and approval consumption. SubAgent delivery (`deliverAsTask`, `messageRecorded`) marks sealed-source messages undelivered while retaining their ledger. Verify-only also records `stopVerified` for terminal workflow executions; canceled runs have no live job and this is their remaining verification path.

Resending uses current selections and a new request key. Draft editing adds no persistence, backup or redo stack. Completion uses ordinary `custom`, not hidden `custom_message` or a reference block describing non-rolled-back effects. Restart recovery automatically verifies the original request; no extra restore-recalled-input entry is added. Initiator identity lasts until the edit window ends through new acceptance, explicit resumption or another client's recall.

### Versions

Schema advances from 56 to 57 for `message_recalls`; control protocol advances from 47 to 48 for `message_recall`, `message_recall_verify`, `message_recall_state`, the `message_recall.changed` event and snapshots of unresolved requests/open edit windows. Coding's strict-version policy requires a fresh data directory; old databases and profiles remain untouched.

## Alternatives considered

- Copy old text or cancel and refill: maximizes reuse and works for unadmitted input, but cannot exclude completed dialogue. Retain only as a local fast path.
- Branch from before submission: reuses publication/recovery and naturally isolates original history, but the owner explicitly chose to stay in the same conversation.
- Native tree plus persistent leaf anchor: can express omission with fewer records, but requires relaxed parent chains and changes to all snapshots/source lookup. `context_edit` already preserves linearity.
- New history-file generation in the same conversation: directly supplies a new prefix, but introduces multi-file authority, old-reference lookup and publication recovery beyond this need.
- UI-only hiding or rewriting/deleting JSONL: the former leaves old model input intact; the latter destroys original records and audit. Neither satisfies the contract.

## Consequences

Recall may stop long-running work or block on unverified stopping/ownership; verify-only advances phase `blocked`. Stopping has irreversible effects, and failure does not pretend execution never began. Consecutive recall replaces unsent edits as requested, without a recovery stack. Raw storage keeps growing; per-entry edits and effective-index cost use existing local-conversation scale until a real bottleneck warrants optimization.

Strict version changes require fresh profiles; old conversations cannot automatically continue on new code. `TABLE_POLICY` excludes `message_recalls`: requests, stopping sets and edit windows belong to the original instance and are not imported with data. Real-model and dual-client experience remain separate acceptance.

## Related decisions

- [Preserve session history](../architecture/2026-09-19-preserve-session-history.md): add effective omissions while retaining raw append-only history, not deletion.
- [Queue and running-task guidance](2026-10-28-coding-message-control.md): preserve acceptance, admission and actual model consumption as separate facts; ordinary cancellation is not recall.
- [Owner attachment provenance](../architecture/2026-10-16-owner-attachments.md): restore new ownership only from verified recall receipts, without broadening artifact access.
- [Conversation branches](2026-10-11-branch-session-snapshot.md) and [Coding side chat](2026-10-29-coding-side-chat.md): new snapshots consume effective history; existing independent snapshots stay unchanged.
- [Manual compaction](2026-10-11-manual-context-compaction.md): effective prefixes and recall revisions invalidate mismatched compaction points while retaining original material.
