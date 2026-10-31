# Agent Note: Continue, reuse, and explicitly close SubAgents

Status: implemented

Original source: ADR 0020, continuation/reuse/closure supplement.

## Problem

[Delegation](../architecture/2026-10-03-work-delegation-subagent-task.md) retains identity/context but originally only continued the same work. Delegating while busy overwrote current_task_id so the prior result could falsely mark a newly executing agent idle. Execution-key-only snapshot names overwrote old work. Verifying only new provenance missed revoked material retained in context.

## Decision

1. Schema v25 adds nullable closed_at/closed_by (owner or agent:<task ID>) without changing running/idle/unverified state or rebuilding its CHECK. Closure and execution are independent. Unverified agents can close, while [restart recovery](../architecture/2026-10-05-subagent-restart-recovery.md) still owns occupancy proof.
2. Reject close with queued/running/awaiting_confirmation tasks; finish or owner-cancel first. Avoid closed-but-still-running state. Close/delegation arbitrate in one synchronous transaction: first close rejects new work, first delegation rejects close. During close, manager pendingMessageContext centrally checks/removes messages addressed to that agent. Do not asynchronously flush other agents; no active task means no freed slot needing it. [Whole-work cancellation](2026-10-04-cancel-work.md) is separate.
3. Continue/reuse require same parent, not closed, idle with no active task, and directory realpath/dev/ino matching child-session records. Busy explicitly rejects, never queues/overwrites current_task_id. Supplying only sub_agent_id creates new work_delegations pointing to the same agent and all its child-session history; supplying work_id too is [collaborative joining](2026-10-05-subagent-messaging.md). Include sub_agent_id in parameter digests only when supplied, preserving old replay digests. Name snapshots materials-<workId>-<key>.txt. Preparation/registration failure removes only this attempt: new directory for first delegation, or only new snapshots in reused directories, including body-size failures.
4. Registration and every presend check verify the union of all that agent's historical task-source references and the new ones. Any revocation rejects registration or blocks send with task_sources_revoked, because reused context retains old material.
5. subagent_result without work_id lists this parent's agents for later reuse; work-scoped results show closure. work_list/work_get include closure fields. TUI displays closed through subagent.closed/snapshots without a new command. Terminal task, TUI exit, and idle never auto-close; no idle-timeout setting is added.
6. setTaskResult remains write-once. In that transaction, manager.resultRecorded(task) updates agent state/clears current task only if currentTaskId matches, choosing idle/unverified by child occupancy. Backfilled old results/events never overwrite new work identity. Seeded inconsistent-history tests prove the guard, not that normal flow creates that combination. Dev delivery uses durable events plus next-request host-material injection with result_delivered_at; main retains stable wake:<childId>. coding_result reads through the same narrow ownership path; all new delegation uses subagent_delegate.

## Alternatives considered

Combining closed with execution state makes one-column viewing easier but conflates independent dimensions, increases CHECK migration cost, and hides unverified execution. Allowing current work after close saves one cancellation step but adds closed-running state/races. Queueing while busy accepts requests sooner but overwrites current identity. Independent closure fields and idle-only admission avoid those failures. Historical decisions are in `.scratch/agent-direction/issues/12-subagent-reuse-close.md` offline.

## Consequences

Same-parent reuse keeps complete context, and closed histories/artifacts/directories remain readable. Full retained history requires checking every historical source at registration/send; one revoked source blocks reuse and needs a new SubAgent. Read paths/authority are freshly pinned, but past-read text is not retroactively deleted. Close/delegation share synchronous arbitration with no auto-close, idle timeout, or dedicated TUI close command.

## Verification

The archived issue records test/81 9/9, typecheck, full tests 882 pass/0 fail/1 skip of 883, and macOS/Linux Docker smoke-12 each 6/6. Real Runtime, CLI, DB, and restricted workers cover old-path denial, refusal after close, and retained results. Models/platforms were simulated, not actual QQ/Telegram. Seeded historical combinations verify the old-result guard without claiming they arise naturally.
