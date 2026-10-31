# Agent Note: Schedules trigger independent generic tasks, not built-in business actions

Status: implemented

[Coding Scheduled](2026-10-25-code-scheduled.md) supersedes the original exclusion of Coding scheduling with its own plans/workspace/model coordinator. [Personal durable scheduled work](../architecture/2026-10-18-personal-durable-scheduled-work.md) preserves independent context/fixed authority/whole-run reporting while replacing legacy SchedulerStore/Runtime/outbox with native durable Tasks, reusing only time calculations and transport. Historical implementation evidence is offline `.scratch/generic-scheduler/issues/01-generic-scheduled-tasks.md`.

## Problem

The old scheduler dispatches wake_main, notify, and news. News hardcodes search sources/keywords/summary/sending; notify executes fixed business content directly. Each new business type would add host branches. Merely deleting news leaves wake_main occupying shared main during approval, incomplete scheduled-source approval/reporting, and runs closing at the first task rather than waiting for SubAgents. The owner wants generic time plus task instructions and existing tools.

## Decision

### One task entry

Schedules hold time rules and task instructions. Remove built-in news, scheduled fixed notify, and shared-main wake dispatch; do not predefine news/reminder/inspection types or add a business-handler registry. Reuse once/daily/weekly rules, IANA zones, and DST; edits still cancel/recreate. Original scope was personal-only, later explicitly extended separately to Coding. Ordinary search, direct messaging, outbox, platform replies, and approval controls remain; deleting news must not delete provider search parameters merely sharing that word.

Each trigger gets a new context containing instructions and explicit references, not automatic main/previous-run history. Runs/results are queryable; other history needs existing authorized reads. Use personal task/model/tool/delegation/process capabilities without the main serial queue, within runtime resource limits. Even simple reminders call a model. Persist plan/run/session/task ownership; ordinary dev/SubAgent identities lack complete personal tools and cannot stand in for this identity, nor may the host duplicate main bindings.

One run includes root execution, derived work/tasks/messages, and final summary. Close only after all work finishes with a final result or explicit failure, not after the initial answer.

### Authority and final delivery

Save the effective creation access mode under [full-access policy](2026-10-12-full-access-current-account.md), and use it for triggers/derived work. Changing main defaults does not rewrite plans/runs. Text/model parameters cannot choose host identity or elevate; one-use approvals and bounded standing permissions are not inherited. Full access asks no operation approval. Confirm/auto-review waits pause only this run and route specific approval to the plan's original owner entry, or existing TUI/control if unbound. Task/operation/permission/original target generation still bind approval; scheduling grants no automatic approval.

At creation the host saves a trusted owner IM target/generation. Creation without IM is allowed, but results remain queryable and later configuration never invents a recipient. Do not fake IM inbound events or infer the target from main's latest message.

Register one final result/failure report to that target, no intermediate reports. Creating a plan authorizes this fixed-target final report only, not arbitrary proactive sends/tools. Cover all work, not initial answer plus each child plus final summary. Persist terminal/send intent before delivery; run ID is the unique logical report key across reconnect/recovery/late events. Preserve offline waiting, same-operation explicit-rate retry, and unknown-send no replay. Invalid targets keep results with undelivered status, never redirect or claim success.

### Overlap, recovery, and cancellation

While any work/approval/summary remains unfinished, create no second run; merge missed periods into that run without a catch-up queue. After downtime with no unfinished run, catch up at most the latest occurrence and record the merged range. Registered-but-unstarted task/send work resumes under original keys. Started execution without verifiable results follows interruption/unknown-effect rules, never automatic redo. Future periods are new runs, not retries of failed operations; preserve plan/run/tool/send distinctions.

Canceling a plan stops future triggers and requests cancellation of queued/running/approval-wait tasks, children, and summaries. Persist intent/state first, stop outside transactions, then record verification. Late tasks/results/approvals cannot restart or produce success reports. Keep records/copies/results; unverified stop retains occupancy. Sent messages, file changes, and external effects are not rolled back, and canceled plan does not prove all processes exited.

Self-cancellation saves whole-run intent, asynchronously stops the initiating task so its tool can return without deadlocking on its own SDK abort, and waits for other stops. Unverified occupancy blocks run closure and the next trigger; queries show task/occupancy facts. Trusted uncanceled unstarted work resumes with the old key; started work does not replay.

### Direct replacement and storage ownership

In rapid iteration, do not convert old news/notify plans, backfill retired parameters, or keep dual execution paths. Remove specialized collector/parameters/snapshots/events/approvals/search injection/tests/current guidance, including fixed-notify dispatch. Keep monotonically increasing schema/reject-newer behavior; import cannot reactivate retired actions. This does not authorize clearing real databases or promise old plans remain executable.

Legacy `Schedule` stores data project, creation task/version, instructions/references, creation mode, and fixed target. `ScheduleRun` binds one independent session/root task; descendants follow parent-task chains. Host identity `scheduled` reuses personal business tools without copying main rows. Result registration, run closure, and unique outbox report arbitrate in one transaction.

If root never started and source access is revoked, send only a generic failure without that source, so revocation does not block the diagnostic. Reports containing started/generated content retain source references for pre-send recheck. [Workflow delivery](2026-10-13-workflow-owner-input-and-delivery.md) owns whole-work waits/questions/no-tool summaries/self-cancellation; safely retried historical step attempts do not poison the final schedule state.

## Related decisions

The original audit fully superseded built-in [scheduled news](../../archived/feature/2026-09-25-scheduled-news.md), preserving its frozen rationale, not its no-model/no-private-context guarantee. [Outbox](../architecture/2026-09-24-scheduler-outbox.md) retains time/persistence/idempotency/send facts, with dispatch/closure/cancel revised here. [IM approval/reports](2026-10-02-im-approval-and-final-report.md) retains original-entry isolation and single consumption for host-bound schedule sources.

[Delegation](../architecture/2026-10-03-work-delegation-subagent-task.md), [messaging](2026-10-05-subagent-messaging.md), [cancel work](2026-10-04-cancel-work.md), and [restart](../architecture/2026-10-05-subagent-restart-recovery.md) keep result/unknown rules while gaining run ownership/independent summary/cancel. [Products](../architecture/2026-10-02-two-agent-products.md) and historical [personal import](../architecture/2026-10-05-personal-instance-import.md) reflect the new scope without retired-action conversion. Full-access work removes news approvalId adaptation rather than duplicating scheduling/approval logic. Other data/service/platform/execution/history/UI/testing decisions remain separately owned; no duplicate proposal was found in the original audit.

## Alternatives considered

- **Delete only news, keep wake/fixed notify:** smaller and zero-model reminders, but retains two execution paths and shared-main blocking/report gaps. Accept a model call for uniform tasks.
- **Run in shared main:** existing identity/context, but blocks conversation and imports private history automatically. Use fresh contexts with existing runtime mechanisms.
- **Store results and let tasks choose notification:** less sending logic, but unattended failure/approval can go unnoticed. Default a fixed-target final report; other sends remain mode-bound.
- **Catch up every missed period:** one record per time, but backlog and duplicate external work accumulate. Coalesce/no overlap.
- **Cancel future triggers only:** lets current work finish, but a supposedly canceled plan continues effects. Cancel current whole work while preserving already-real effects and verification status.

## Verification

Shared regressions retain `test/37-scheduler-outbox.test.ts`, `test/93-im-approval-lifecycle.test.ts`, and related imports. Historical generic-run cases are available in `git show 28c033f7:test/51-generic-scheduler.test.ts`; [test reduction](../testing/2026-10-24-test-suite-reduction.md) removed that file from the current set. Offline issue evidence used mock IM/models, not real-platform push or real-model acceptance. No runtime tests are rerun here.

## Consequences

One generic task path replaces business-specific collection and approval; separate queues keep daily main responsive, and mode/source/target survive restart. Personal durable later retains these behavioral contracts without old storage/runtime plumbing.

Every reminder costs model latency/usage and can fail for unavailable models/tools/credentials. Instructions must stand alone rather than rely on private shorthand. Authorized personal data/tools remove the former news collector's no-model/no-private-context guarantee; an independent session is not an OS sandbox. Approval waits block the same plan, coalescing intentionally skips individual periods, and canceled/unverified/unknown work may need owner inspection. Zero-model reminders, interval/monthly rules, and other extensions need demonstrated requirements, not prebuilt branches.
