# Agent Note: Retrieve queued Coding input and simplify pause/resume

Status: implemented

## Problem

The user queue previously included internal summaries and question answers. Arbitrary queued messages could not be retrieved independently, and interrupting the current task did not pause later dispatch. Desktop also automatically turned the next input after interruption into continuation of the old task, obscuring what a submission controls.

Owner-confirmed requirements and implementation tracking belong to [the input-lifecycle issue](https://github.com/num-lab/Ruukoto/issues/30). This note owns user-queue and continuation-entry decisions; [report delivery](2026-10-30-coding-report-delivery-boundary.md) and [in-task questions](2026-10-30-coding-owner-question-wait.md) own the two input types excluded from that queue.

## Decision

The user queue displays, reorders and retrieves only unstarted ordinary owner input. Task remains the durable acceptance receipt; do not introduce another message queue. Pending guidance is excluded, while fallback guidance becomes ordinary queued input. Internal-report fallback tasks retain host identity and their ledger but are excluded from user-queue queries, counts and panels. Question answers no longer create tasks.

### Separate queued retrieval from historical recall

Reuse `message_recall` and `message_recalls` with explicit `purpose: "queued"` or `purpose: "historical"` supplied by the client entry and included in the request digest and persistent receipt. Queue entries permit any eligible item without the latest-input candidate check; historical entries retain existing candidate and source-sealing rules. Losing queued eligibility rejects and refreshes; never silently escalate to execution stopping or history mutation.

An in-task answer remains genuine owner input. Its transaction reuses the answer event's sequence to save acceptance order on the question record, comparable with ordinary input. Historical candidates explicitly distinguish a source Task from a question answer. If the latest effective input is an answer, including Skip, return `unsupported_input`: never skip it, treat the original requirement as latest or disguise the question's taskId as recallable input. Recalling a later ordinary input/guidance can expose the answer as a blocker again. Arbitrary queued retrieval remains exempt from latest-input restrictions; do not recreate answer tasks or add another input ledger.

Queued retrieval transactionally verifies conversation, ordinary provenance, queued state, no history admission, no pending guidance route and current revision; it cancels only the selected Task and saves a completion receipt. Change only that item and queue revision: do not pause the queue, stop the current task, reorder other items or write JSONL. An unresolved recall still blocks conflicting operations. Recovery verifies the persisted cancellation facts, not a JSONL marker that only historical recall writes. Inconsistent records still fail; missing history is not proof of nonexecution.

Restore text and attachments only to the initiator holding the original request key. `restoreForRecall` verifies original attachments and creates new staged references; retries reuse the same receipt. Save the key before sending and query it first after a lost response. Separate draft-installation eligibility from historical edit pause: retrieval neither restores an old queue state nor lets ordinary queue changes clear visible history/stream fragments. Existing draft replacement and consecutive-retrieval rules remain, without a recovery stack.

### Manual pause and resumption

When the owner pauses an ordinary Coding main task, synchronously commit the conversation's manual pause and current execution's stop intent before asynchronously stopping the Driver. No new model request or queue-head dispatch may start during stopping. Once accepted, pause persists even when the queue is empty. Internal stops, resource yielding and automatic finalization in other conversations do not become manual pauses. Started operations retain real effects; this queue pause does not cancel entire SubAgent work, workflows or background processes.

Ordinary submission, retrieval, reordering, report arrival, restart and retrieval-edit completion cannot clear manual pause. Explicit resumption executes only still-queued work, never reruns an interrupted Task. Restart must not replace manual pause with `backend_restart` and then clear it through a reports-only auto-resume path. Candidate selection and the transaction after asynchronous verification must use identical pause/priority rules.

Distinguish everyday queue resumption from verification of retained occupancy. Keep `resume_queue`: without retained occupancy it resumes dispatch; when stopping remains unverified, require explicit `stop_confirmed` owner confirmation of stopping rather than interpreting an ordinary resume click as verification. Active occupancy, unfinished historical recall and corrupt history still block. Confirmation cannot rewrite effect unknown. Clients reuse confirmation interaction; CLI extends its existing resumption entry, not a new queue-editing command family.

### Remove continuation entries

Remove `Runtime.continueTask`, control `continue`, CLI `continue`, TUI `/continue`, Desktop continuation intent/automatic continuation drafts after stopping, associated help and Scheduled continuation exceptions. Later input always creates a new ordinary task in the same conversation. Do not broaden ordinary-submission eligibility for active Scheduled conversations.

Retain historical `resumesTaskId`, read-only continuation provenance, attachment/source closures and existing idempotency fields in old submission digests. Old pending continue requests retain original instance, key, text and attachments as retired requests verifiable by the original version; never discard, automatically replay or convert them to submit. Old profiles and pending requests are not migrated into the new instance.

## Related decision audit

[Queue/guidance](2026-10-28-coding-message-control.md), [message recall](2026-10-30-coding-message-recall.md) and [backend/FIFO ownership](../architecture/2026-09-19-detach-terminal-from-task-runtime.md) partially overlap: change the user queue, queued retrieval and manual pause while retaining guidance, append-only history, idempotency and stopping guarantees. [Coding Scheduled](2026-10-25-code-scheduled.md) loses only its continuation exception; schedule provenance and admission restrictions remain. Existing notes retain their original decisions and link to these superseding contracts.

[History preservation](../architecture/2026-09-19-preserve-session-history.md), [execution boundaries](../architecture/2026-09-20-tool-worker-per-task-container.md), [SubAgent restart](../architecture/2026-10-05-subagent-restart-recovery.md), [conversation archive](2026-10-20-desktop-session-archive.md), [conversation backgrounds](2026-10-21-coding-background-processes.md), [generic wait](2026-10-25-code-wait.md) and [side chat](2026-10-29-coding-side-chat.md) retain independent lifecycle/history/stopping constraints and dedicated controls. Personal backgrounds, work controls, Telegram, IM configuration and retired group-chat decisions are unrelated to this Coding scope. No note is fully absorbed, deleted or archived; no related rejected proposal was found.

## Alternatives considered

- Use full historical recall for every queued item: maximizes entry reuse and freezes dispatch during editing, but the owner requires retrieval not to affect other execution. Reuse receipts/attachments, not historical pause and stop closures.
- Interrupt then pause only at the button: minimizes UI changes, but stopping races with queue dispatch and CLI could bypass it. Shared Runtime must accept pause first.
- Retain continue as a hidden alias: accommodates old clients, but preserves a second submission meaning contrary to explicit removal. Keep history and old pending inputs, not an executable alias.

## Verification

Store, Runtime, control and client regressions verify arbitrary queued retrieval, immutable attachments, retained order/pause, lost-response recovery, answer/Skip recall barriers and explicit stop confirmation. The owner confirmed real Desktop/TUI product acceptance on 2026-10-31. Engineering evidence and the accepted scope are recorded in [Issue #30](https://github.com/num-lab/Ruukoto/issues/30).

## Consequences

Ordinary submission while paused requires explicit resumption. Everyday resume cannot bypass unverified stopping. New receipt purposes and question formats use schema 58/protocol 49; [strict version policy](../simplification/2026-10-24-code-instance-mcp.md) requires a fresh profile without migration or deletion of old data. Restored text still replaces the initiating draft; any recall-recovery stack requires a separate decision.
