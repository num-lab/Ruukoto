# Agent Note: Durable scheduler and notification outbox facts, fixed authorization, and recovery limits

Status: implemented

Original identifier: ADR 0010.

## Problem

Reminders must survive restart, follow local clock time across DST, and require owner approval for external sends not already authorized. Memory timers cannot preserve due/send facts. A lost send response is not proof of non-delivery: replay could duplicate an external effect. Scheduling belongs to one backend instance; business records and core runtime state have separate owners. The original requirement is historical offline `.scratch/daily-agent/spec.md` items 6-7.

## Decision

1. Persist `schedules`, `schedule_runs`, and `notification_ops` in core `ruukoto.db` (introduced in schema v13); memory only wakes scans. Application-data tools cannot reach these tables, while business fields stay in the [application data space](2026-09-23-main-app-data-space.md). State changes and corresponding events commit in core transactions; network/model/application queries run outside them.
2. Support once/daily/weekly rules with IANA zones and ISO calendar. Reconstruct recurrent instants from local date and the original clock time. Fixed DST `compatible` shifts gaps forward and selects the earlier fold occurrence. `packages/channels/src/scheduler/time.ts` centralizes locked `@js-temporal/polyfill` use. One-shot timestamps require `Z` or explicit offset; never infer server timezone. Clock rollback never retreats processed coverage; timezone-data updates affect only future unregistered instants.
3. Coalesce missed periods once. A schedule has at most one unfinished run, uniquely keyed by `(schedule_id, schedule_version, scheduled_for)`. Without one, choose the latest occurrence before the scan cutoff and record delay/coalesced range. With one, retain its run key and body and merge later missed periods. Recovery preparation MUST read actual task states before generic `Runtime.recover()` rewrites running tasks: close already-terminal runs, merge genuinely pending ones, then classify leftover `sending` as `effect_unknown`. A later ordinary period is a new run, not a retry of an old failed send.
4. `pending` is unclaimed; `sending` is claimed and possibly sent. Only the winner of the conditional claim calls the sender once. Proven success is `sent`, proven non-send is `failed`, otherwise `effect_unknown`. `sent`, `failed`, `effect_unknown`, and `canceled` NEVER auto-resend; late receipts are recorded only. The [Telegram rate-limit exception](../feature/2026-09-24-telegram-owner-entry.md) applies only to explicit platform refusal proving non-send: restore the same operation to pending with `not_before`, unchanged key/target/body; a cancellation recorded while claimed makes it canceled. Timeout, 5xx, and interrupted sends do not qualify.
5. Host-generated logical send keys are fixed: schedule run ID, one-confirmation task notification slot, or inbound event plus owner-reply slot. `(source_kind, source_key)` is unique; identical parameters return the existing record, different parameters conflict. Models cannot generate a fresh key to evade unknown outcomes. [QQ replies](../feature/2026-09-24-qq-private-shared-main.md), [Telegram replies](../feature/2026-09-24-telegram-owner-entry.md), [asynchronous final reports](../feature/2026-10-02-im-approval-and-final-report.md), and [GitHub notifications](../feature/2026-09-24-github-event-review.md) own their source-specific slots.
6. Sending authority fixes target, complete body, and duration. Targets come from trusted channel configuration. `notify` schedules and one-time `notification_enqueue` use `ApprovalScope.kind = notification`, fixing target/account/config version, time rule, IANA zone, DST, and persistent scope. Recheck and consume once in the same core transaction. Changed/disabled target configuration invalidates old approval, never redirects it. `wake_main` records a trigger instruction but inherits no sending authority; the archived [news schedule](../../archived/feature/2026-09-25-scheduled-news.md) records its separate fixed-collection authorization.

## Execution permissions and cancellation

The original policy required owner confirmation for persistent sends and unapproved one-time external sends even in full access, because recipients are a separate authorization concern. Auto-review's `classifyForReview` does not cover `notification`, so it asks the owner without a review-model call. Approved plans and trusted owner replies are host-defined automatic sending scopes, not copies of MCP's full-access branch. The later [current-account full-access decision](../feature/2026-10-12-full-access-current-account.md) owns any revised approval/account/environment and derived-task rules.

Schedules offer create/query/cancel, not edits: changing time/body/action means cancel and recreate, with new notification confirmation. Cancellation stops future triggers, unsent pending operations, and queued tasks; already-running tasks/sends retain real effects and only gain cancellation intent, never a promise of recall. Permanent invalidity cancels; temporary offline state or missing sender keeps pending with a waiting reason. Resolve body references to bounded immutable snapshots before approval. Later business-row edits do not change approved text; revocable source-data access is still rechecked before sending.

[Generic scheduled tasks](../feature/2026-10-12-generic-scheduled-tasks.md) supersedes independent execution, run ownership, approval provenance, and whole-work cancellation. [Workflow delivery](../feature/2026-10-13-workflow-owner-input-and-delivery.md) adds `workflow_question`; original-entry final results use owner_reply, while scheduled workflow runs report through schedule_run.

## Alternatives considered

- **Reuse `qq_outbox`:** already a group-reply ledger, but its pending state conflated unsent and in-flight, restart made all unknown, and it lacked business idempotency keys. Public notifications need the unclaimed/possibly-sent distinction. Preserve old group records separately rather than migrate them into this outbox.
- **Implement IANA/DST or raise Node for global Temporal:** either avoids the polyfill or uses a platform API, but Node 24.15 then lacked global Temporal and the project then supported `>=22.19`. Maintaining historic offsets and half-hour DST was unjustified. Centralize a locked polyfill; those old minimum-version facts are not current requirements.
- **Redis, a message broker, or distributed scheduling:** useful for distributed queues, but the confirmed scope is one SQLite-owning process with an instance lock, not multi-machine delivery.

Detailed original alternatives are historical offline `.scratch/daily-agent/issues/03-scheduler-outbox.md` sections 1/3 and delivery notes.

## Consequences

Schedule, trigger, authorization, and send facts survive restart and are inspectable through the control plane and legacy `ruukoto schedule|notify list|show|cancel` interfaces; current personal entry commands belong to its successor documentation. Scanning and sending do not take the coding queue or workspace. Short scan transactions and a separate single-in-flight sender prevent a slow send from blocking due registration, control requests, or coding tasks.

Local uniqueness guarantees at most one operation per logical key and no repeated attempt after a possible external effect. Without platform idempotency it cannot guarantee remote exactly-once or delivery in the unknown window; the owner must verify `effect_unknown`. The initial design excluded cron, general workflows, platform plugin systems, and generic retries. Later extensions require their own authorization/recovery decisions rather than pretending these were original capabilities.

## Verification

Historical issue 03 evidence: macOS / Node 24.15, mock model/channel, passing typecheck; 388 tests with 387 passed and one default-disabled real-model test. The 16-case `test/37-scheduler-outbox.test.ts` covered New York gap/fold, Lord Howe half-hour DST, Kathmandu offset, multi-year downtime, duplicate/concurrent ticks, approvals/snapshots, claim/recovery/late receipt, cancellation races, slow-send independence, v12-to-v13 migration, and SQLite integrity.

A real backend child was SIGKILLed after the mock platform accepted but before local result persistence: restart recorded `effect_unknown` and the platform observed one send. That run did not test real Telegram/QQ delivery or Linux. These are historical acceptance records, not tests rerun by this prose migration.
