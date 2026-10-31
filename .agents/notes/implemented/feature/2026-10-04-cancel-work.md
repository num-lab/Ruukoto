# Agent Note: Cancel whole work while retaining identity and results

Status: implemented

Original source: ADR 0020, whole-work cancellation supplement.

## Problem

Once [delegation and execution tasks are separate](../architecture/2026-10-03-work-delegation-subagent-task.md), canceling one task cannot stop all queued/active attempts for that work. Late results can wake the parent again. Owner/main Agent need whole-work cancellation without destroying identity, records, or results needed for inspection/reuse.

## Decision

1. Schema v26 adds nullable canceled_at, canceled_by (owner or agent:<task ID>), and cancel_reason to work_delegations. Write once under canceled_at IS NULL; repeated cancellation returns original facts/current task states. Work state derives from cancellation/task fields without a new state machine or rewriting terminal task results.
2. Owners use control work_cancel (introduced in protocol v13) or work cancel CLI; main Agent uses subagent_cancel(work_id, reason?) in dev/main, including report-wakeup rounds because cancellation narrows capability. Children and other parent sessions are rejected. [Explicit close/reuse](2026-10-04-subagent-reuse-close.md) follows the same authority boundary.
3. One synchronous transaction records cancellation, directly cancels queued work tasks with work_canceled, marks running/awaiting tasks cancel_requested=1, and appends work_delegation.canceled with separate canceledTaskIds/stoppingTaskIds. After commit, existing cancelTask stop paths run via Promise.allSettled. Serialization with delegation ensures prior tasks enter the list and later registration sees cancellation and rejects, while same-key/same-parameter replay returns original records. Failed stop retains occupancy and unverified agent state.
4. Shared cancelTask first persists cancel_requested then requestStop. This closes the running-before-currentTask window: Driver.runInner sees the flag, finalizes canceled, and calls no model. Known limitation: timeout cancellation in precisely this window records canceled rather than timeout, without a separate reason.
5. Late terminal results still persist through setTaskResult, subagent_task events, subagent_result, and work show, but cancellation prevents automatic delivery to any parent model. Orchestrator rereads work before waking; the queue checks work before starting wake:<childId> and cancels it, covering queued, later-inserted, and startup-repaired wakeups. Dev injection and startup wake lists exclude canceled_at records. Parents may explicitly read results. Already running main wakeup rounds are not cascade-canceled.
6. Cancellation does not close SubAgent: after verified completion it becomes idle, or unverified if occupancy remains, and may later take other work through reuse rules. Work directories, JSONL, artifacts, resultRef, and work records stay. Legacy coding drafts without work_id remain single-task-cancel operations. Existing unknown effects are recorded, not replayed.

## Alternatives considered

Delivering late results with a special label informs parents promptly but can induce restarting canceled work. The original decision in archived `.scratch/agent-direction/issues/14-cancel-work.md` therefore suppresses all automatic delivery after cancellation while preserving explicit result queries.

## Consequences

Cancellation affects only its work, not other delegations, identity storage, or already running main wake rounds. Host must guard registration, start, wake, and dev injection together. Failed stop retains occupancy/unverified; unknown effects never replay. The narrow timeout/running window remains a documented canceled-not-timeout limit.

## Verification

The historical issue records test/82 8/8, typecheck passing, full tests 890 pass/0 fail/1 skip out of 891, and macOS/Linux smoke-14 each 7/7. Real Runtime, CLI, SQLite, JSONL, and Docker workers cover whole-work cancellation, queued zero-model behavior, active-container stop, queryable-but-uninjected late results, and restart persistence. Models/messaging platforms were simulated. [Generic scheduled tasks](2026-10-12-generic-scheduled-tasks.md) separately owns scheduled execution, provenance, and whole-request cancellation.
