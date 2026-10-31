# Agent Note: Recover SubAgents without bypassing execution verification

Status: implemented

[Personal entry/legacy retirement](../simplification/2026-10-18-personal-product-entry.md) supersedes Personal recovery with durable safe-work recovery, still pausing unknown effects/unverified stop. Coding and legacy formats retain the original rules below. Personal provenance/verification belongs to [durable migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) and capability notes; complete migration acceptance remains separate.

Original source: ADR 0020, backend-restart recovery supplement.

## Problem

Restart must preserve [work/SubAgent/task](2026-10-03-work-delegation-subagent-task.md) ownership, report interruptions, and let owners decide continuation. Earlier recovery left child queued tasks paused and agents permanently running, with no unverified-to-idle path. Recovery must also avoid concurrent writes alongside an old execution that has not stopped.

## Decision

1. The recovery transaction calls SubAgentManager.recoverQueuedTasks() to mark never-started owner/main-Agent delegated child tasks without source_event_id as interrupted(backend_restart). Runtime handles running tasks. Never-started work has no unknown effect. It is neither automatically continued, successful, nor a new delegation. Startup inspection records its result once through setTaskResult, retaining work/agent/parent-session/parent-task references. Main parents wake by a stable key; dev parents receive result injection. Owner/parent chooses continuation under [reuse rules](../feature/2026-10-04-subagent-reuse-close.md) or abandonment. In the result transaction, only an agent still pointing to that task becomes idle or unverified according to occupancy. Source-event-backed host review tasks are excluded.
2. After recording results, the orchestrator awaits manager.start(): flush pending messages, then automatically resume only child sessions paused for backend_restart with no residual occupancy. Retained host-review queued tasks can run; role queues remain orchestrator-owned. occupancy_unverified pauses/residual occupancy never clear automatically or permit concurrent writes with old execution.
3. resume-queue is the exit from unverified. Once the owner verifies prior execution, Runtime.resumeQueue releases residual occupancy/unpauses and calls executionVerified(sessionId) in one transaction. Occupancy held by active tasks cannot be released. An idle return requires no active task and a recorded result for the current terminal task. Missing result throws invalid_state and rolls back the whole transaction; record the result first. Manager returns parent-session ID; Runtime awaits flushPendingMessages after commit. [Canceled work](../feature/2026-10-04-cancel-work.md) neither reruns nor receives a new startup wakeup.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

Queued owner/main delegations finish and report once rather than replay; source-event host reviews resume automatically. Every step depends on recorded results/verified occupancy, so missing results roll back resume-queue and old occupancy never releases itself. [Messaging](../feature/2026-10-05-subagent-messaging.md) flushes pending messages after verification.

## Verification

Historical `.scratch/agent-direction/issues/15-recover-subagents.md` records test/86 3/3 with mocked model, local realTools worker, and in-process Runtime restart; related tests 75/75, typecheck, and four diagrams passed. Full tests were 889/892 with recorded DNS/worktree-name environment failures. macOS Docker smoke-15 passed 8/8 with real container, control socket, CLI, and DB, but simulated model/platform and DB-injected crash state rather than a real kill. Linux remote smoke was not run in that original implementation.

[Generic scheduled tasks](../feature/2026-10-12-generic-scheduled-tasks.md) owns independent runs, ownership, approval provenance, and whole-request cancellation. [Workflow runtime/store](2026-10-13-workflow-runtime-and-store.md) gives the coordinator separate authority, pointers, results, and recovery for bound steps/short host operations. Ordinary recovery retains this note.
