# Agent Note: Bind IM approvals and final reports to the original owner request

Status: implemented

Original sources: ADR 0011/0012 revisions of 2026-10-02 and agent-direction issues 08/18. This note consolidates their shared approval/final-report rules; [Telegram](2026-09-24-telegram-owner-entry.md) and [QQ shared main](2026-09-24-qq-private-shared-main.md) retain connection, ordinary replies, and startup/disable behavior. The mechanics here describe the shared runtime; the [official personal entry](../simplification/2026-10-18-personal-product-entry.md) and its durable IM decisions own the replacement personal assembly.

## Problem

An independent personal server needs approval through bound private IM and must allow conversation during long delegated work. Requiring TUI approval and waking main without returning the final result breaks that loop. Sharing main must not let one platform inspect/approve another's operations or turn asynchronous reports into arbitrary outbound authority.

## Decision

### Host-handled approval messages

Match the entire original sent text before platform templates/quoted excerpts: `/approvals [cursor]`, `/approval <fullId> [offset]`, `/approve <fullId> <permissionVersion>`, and `/reject <fullId> <permissionVersion>`. Require complete IDs, positive permission versions, and bounded paging. Recognized malformed commands get host usage feedback, not a model task. Natural language, quoted/forwarded commands, model output, group messages, and [image-bearing text](../architecture/2026-10-07-inbound-image-staging.md) never approve. [Standing permissions](2026-10-03-standing-permissions.md) owns its additional commands independently.

The host fixes `inbound_events.event_kind=im_approval` (introduced in schema v22), deduplicated by `(source, external_id)`. One synchronous transaction records it and terminates as done/failed, without a normal task/model call/dispatch. Recovery excludes control events: old messages cannot be reinterpreted as prompts or new approvals. This avoids queueing approval behind main's own awaiting-confirmation task.

Lists/details/decisions resolve the original ordinary IM request through recorded `parentTaskId`, rejecting broken chains, cycles, missing provenance, or non-IM task events, never inferring from latest chat. Verify original platform/account or bot/owner/actor/pinned reply target/configuration version; Telegram ownerUserId and chatId are separate checks. Shared main grants no access to another platform or TUI/schedule/GitHub approvals. Original shared-runtime IM tasks were confirm; later derived-authority policy belongs to [current full access](2026-10-12-full-access-current-account.md), not platform identity.

Approval creation transaction registers its initial `confirmation / im-approval:<id>` notification with fixed target, host-formatted exact scope, complete ID/version/commands. Page details within platform limits with explicit next offset; truncated scope is not complete detail. A valid decision uses the original live Driver/unified approval mechanism and atomically commits decision, audit event, control-event terminal status, and `inbound_event / <controlEventId>` receipt. Wake the waiter only after commit. SQL failure rolls everything back. Competing TUI/IM/auto-review/messages can only conditionally update pending once.

Commands select the original request/version, never new parameters/scope. Consumption rechecks task, permission version, unconsumed state, original IM identity/target/configuration, and operation data/credential/configuration. Report approval accepted but still subject to execution-time verification, not operation success. `consumedAt` means execution started; disable/cancel/restart cannot undo it, and unknown effects are not replayed.

### Host-determined final delivery

Only generic work whose `originTaskId -> source_event_id -> inbound_events` identifies an original telegram/qq_private task event qualifies. At a terminal main result wake, require no queued/running/awaiting-confirmation execution and a recorded-result `wake:<id>` for every other terminal execution. That wake's final answer becomes the report. Fixed host guidance asks main to summarize all children; no model completion/report tool decides whether to send. Canceled work gets no automatic final report because its canceling turn already replies.

In the closing wake's result transaction, register `owner_reply` with key `<originEventId>#work:<workId>:<closingExecutionTaskId>` and the closing wake task ID. Reconciliation and repeated terminal handling reuse that key. Additional execution followed by another close has a new execution ID/report. Even cross-entry follow-up goes to the first request's target. TUI/dev/schedule/group/GitHub work does not qualify; GitHub retains [fixed event notification](2026-09-24-github-event-review.md).

### Invalidation, receipts, and sending

Binding, enable/disable, and credential changes advance a monotonic entry configVersion. Before same-name credential replacement/deletion, advance referencing entries so A-to-B-to-A cannot revive old connections/polls/messages/approvals. SQLite and credential files are not atomic: invalidate old authority first; a failed file write does not roll back versions. Keep cache/disk facts consistent, then reconnect/reconcile. Redact late errors using the captured old token. A legacy null Telegram replyTarget cannot be reconstructed from current settings.

Invalidate only original-platform registered/queued work and associated unconsumed approvals, not the other platform's shared-main work. Release affected waiters or follow existing cancellation; merely changing rows must not strand waits. Restart invalidates pending/approved unconsumed requests without recreating waiters. Preserve consumed facts and separately record tool-operation and notification unknown effects. A temporary disconnect with unchanged version waits for recovery, not rebinding/disable.

Redelivered control messages compare original kind, actor, pinned target, and canonical command; same-key different-command fails. A processed message returns its original receipt, never reexecutes under new approval state or target. Before initial-notification send, require the request still valid; decision receipts verify original control event/target without requiring task status still awaiting confirmation. All notifications/details/receipts/reports use the [shared outbox](../architecture/2026-09-24-scheduler-outbox.md): changed targets cancel without rerouting, offline stays pending, explicit rate-limit refusal delays the same operation via not_before, and failed/effect_unknown/restart-leftover sending do not get replacement keys.

The original host header identifies work ID and final report; body comes from that exact closing wake's history. Failure/timeout/restart interruption uses fixed host feedback pointing to TUI details. Truncate to platform reply limits and reference the original inbound message on both platforms. Invalid target at registration records `*.reply_skipped` with `work_report:` reason; recheck before send. Ordinary acceptance registers first and same-channel creation-order claiming sends it before the final report.

This is a narrow exception to no owner replies from child wakes: only the closing turn of IM-origin generic work qualifies; old coding-draft wakes still do not send. `notification_enqueue` without a trusted target fails without approval/send. New owner-IM notifications need separate approval. Wake turns cannot invoke owner-origin delegation tools; further delegation occurs in owner/IM turns and active executions postpone closing. Do not describe the old planning assumption of redelegation inside a wake as current behavior.

[ImApprovals](../../../../packages/channels/src/im-approvals.ts), [parent delivery](../../../../packages/runtime/src/parent-delivery.ts), and [IM entries](../../../../packages/channels/src/im-entries.ts) own these paths without a new report tool or send table. [Workflow delivery](2026-10-13-workflow-owner-input-and-delivery.md) owns workflow questions/tool-free whole-work summaries/scheduled provenance; [generic scheduling](2026-10-12-generic-scheduled-tasks.md) owns independent execution/run approval/cancel semantics.

## Alternatives considered

- TUI-only approval reuses owner authentication/full scope UI, and was the original Telegram choice, but interrupts server-only private-chat use. Expose host-verified concrete approvals, not a general IM control plane.
- Queue approvals as ordinary main tasks: maximal dispatcher reuse, but deadlocks behind awaiting-confirmation and passes control text to the model. Directly terminate durable control events instead.
- Let a model tool declare completion or omit reports: the model knows task content, but missed calls strand results and add an outbound trigger. Host task/wake facts determine reporting.
- Add a report source_kind or duplicate entry fields: direct routing representation, but original task/event/reply_target are already immutable and derivable, and owner_reply has event-plus-slot identity. Reuse it rather than duplicate facts/schema.

## Consequences

Owners can approve while main waits, continue conversation during delegation, and receive main's final summary at the original entry. Approval, execution, receipt, source key, and body are separately verifiable. Shared main does not share platform approval authority. Full IDs/versions and paged detail are less convenient; changed binding/credentials require a fresh request. Main cannot suppress a closing report; cross-entry continuation still replies to the original entry; cancellation does not report automatically. Images/forwards/quotes cannot approve and unknown effects cannot auto-retry. Entry invalidation does not imply canceling all pending outbox sends; startup/disable distinctions remain in the QQ note.

Historical issue 08 evidence reported macOS targeted suites (`test/77-im-approvals.test.ts`, 38/40/63 and regressions), tx key suites 66/66, and typecheck passing. Its 14 test/77 cases covered per-platform request/notification/detail/decision/real controlled data effect/reply, zero model calls while waiting, identity/format/version/cross-platform rejection, dedup/races, A-B-A/deletion/old-target invalidation, transaction rollback, consumption/restart windows, original-key 429 delay, and late old-token redaction. Retired coding-child cases are historical only. Smoke 08 was 9/9 on both macOS/tx with real backend/socket/SQLite/main.db/config/credentials/outbox/restart and simulated model/OneBot/Bot API. Full suite: 815 passed, 1 gated model skip, 1 test/08 DNS timeout of 817; the timeout reproduced on clean `8be27c5`.

Issue 18 reported its nine test/84 cases, regressions/typecheck passing, and full suite 912 passed/0 failed/1 skipped. Coverage included acceptance/chat/report order, original cross-entry target, exact closing body, concurrent/repeated/reconciled single registration, later close keys, invalid/offline/429/unknown targets, and no arbitrary outbound authority. Smoke 18 was 7/7 on each platform using real backend/control/SQLite/outbox/Docker worker/SIGKILL and simulated model/platforms. Original evidence under `.scratch/agent-direction/` is now offline provenance, not maintained task links. Neither cycle exercised real QQ/NapCat or Telegram Bot API; each requires its own real closed-loop acceptance, and old Docker results are not native-backend proof.
