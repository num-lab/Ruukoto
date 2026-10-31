# Agent Note: Reorder Coding input queues and guide running tasks durably

Status: implemented

## Problem

Code originally registers every user input as a Task and runs creation-order FIFO. The owner cannot reorder pending input or correct a running task in place. SDK steer alone is volatile; treating the last user message as the entire current task can omit its original requirement. Original product contract/SDK evidence are historical offline `.scratch/coding-message-control/spec.md`, issues `01-queue-and-guidance.md`, and `evidence/sdk-contract.md`.

## Decision

Reuse Task as the durable input receipt, adding queue order and guidance routing. New guidance and queued-to-guidance accept ordinary chat input only, retaining source Task ID/body/attachments/submission choice. Routing chooses current-task input or ordinary queue-front fallback. Continuations/question answers keep their existing independent execution relationships and cannot themselves convert to another task's guidance.

### Queue and compatibility

Tasks have pending order; sessions have queue revision. Without explicit reorder, preserve FIFO. All enqueue sources allocate order together; owner reordering permutes existing owner-input positions only, preserving internal-summary positions. Fallback guidance forms one queue-front batch in admission order, later fallbacks behind earlier unexecuted ones. Order/revision/event commit together; enqueue/dequeue/cancel/route changes advance revision, preventing stale-list overwrite.

After async directory checks, `runQueueLoop` transaction rechecks queued state, no pending guidance route, and executable head position before setting running. Reorder never resumes a paused queue. Handshake/query/replay/view share persisted order, not createdAt.

Original baseline schema 53/protocol 43 advanced to schema 54/protocol v45. Schema must change because older code would independently execute queued guidance sources. Preserve [strict Code versions](../simplification/2026-10-24-code-instance-mcp.md): start a fresh directory, leave old SQLite/JSONL/artifacts/credentials unmoved/unchanged/undeleted, no v53 migration/config conversion. Old rejects new and new rejects all older schema before creating tables/updating version. In-place continuation needs a new owner decision, not hidden compatibility.

### Route and execution ownership

`task_guidance` uses source Task ID as input identity and saves same-session target, admission sequence, stage, and actual JSONL entry. Stages mean pending admission, joined target history, fallback, or pre-admission cancellation, not a copy of model-request lifecycle. At most one unresolved route per source. Reuse Task request keys/digests/lookup/events; no extra guidance ID or first-request snapshot ledger.

Admission transaction verifies ordinary Code session, directly submitted ordinary-chat source, receptive target, queued source, and complete attachment provenance. Host relationships establish identity, not text prefixes. Persist before SDK scheduling, unconsumed-approval invalidation, or wait release. Pending source stays queued but ordinary scheduling excludes it. After actual target JSONL admission, close its independent execution intention as canceled/converted_to_guidance. Views explain the route, not independent completed, owner cancellation, or another cancel bubble. Admitted input can never fall back as a separate execution.

Close target admission before finishing. Unadmitted guidance and guidance arriving after closure remove the route and reuse the same source Task in the front batch with original key/model/mode/authority/attachments. Canceling a pending source revokes route and corresponding SDK input; canceling a queued task cannot retract already-written history. Stop/occupancy/restart protections precede queue-front dispatch.

### SDK and disk-history admission

Pi 1.3.0 can take steering into a local batch before async next-turn preparation; the public queue is then empty, and clearQueue or abort+clearQueue cannot stop that batch appending user history. The SDK counterexample means queue extraction/clearing is not history-admission proof or permission to fallback.

Use public sdk.agent.steer with source Task ID/attachment references on native user messages and all-consumption mode. Verify metadata retention, batch behavior, and finishing through narrow public-API contract tests, not private fields/vendor changes. After durable admission, keep input in host routes initially, not immediately in SDK.

`finishTurn` respects action:end, error, and stop. Only when continuation is allowed and guidance is pending does it synchronously reserve current source IDs in an in-memory batch before returning continue. If source cancel commits first it is excluded; if reservation wins, cancellation waits for actual persistence reconciliation, without prematurely marking SQL admitted. This avoids an empty batch from prepare-time cancellation causing an extra model call.

Public prepareNextTurnWithContext completes original SDK preparation, then synchronously adds still-live guidance received during preparation and steers all in durable admission order. That selection is the next-request cutoff; later input waits for the next boundary and remains protected by the approval barrier. After all users append, public prepareRequest verifies actual JSONL entries, updates routes, and releases batch cancellation waits. No long model call occurs between selection and ownership update. Existing context assembly still owns selection records; prompt snapshots do not become a new execution gate.

After target stop, synchronous public sdk.subscribe user message_start/message_end listeners throw a fixed coded stop error before append, preventing unpersisted guidance admission. Do not make them async or move to exception-swallowing extension hooks. Agent and SessionManager may both retain unwritten entries; refreshContext reads manager memory, not disk. Wait for run closure, reconcile against actual JSONL, discard old SDK/manager, and use a fresh SDK reopened on the original file for cleanup markers/later tasks. Never continue writing a polluted manager. Parse/ownership failure pauses the affected session. For partial admission, each written entry belongs to target and only unwritten sources cancel/fallback; settle batch waits after success/stop/error reconciliation, leaving no hanging promises.

SDK user message_end precedes JSONL append and only assembles references. Register admission after matching real entry by source Task ID. Selection persistence remains required; diagnostic prompt snapshots may be missing and follow existing error reporting, not a new guidance requirement. History admission is not proof the model read it; actual request/response records establish that.

JSONL is authoritative and not atomic with SQLite. Recovery compares source IDs, target log, and routes: unwritten input returns to queue front; written input stays in target and never reappends or executes independently. Log-written/SQL-missing gets a proven association; SQL-admitted/log-missing or conflicting ownership pauses/reports. Missing diagnostic snapshots do not affect classification. Abort does not clear steering: close admission, wait for run closure, clear residue, reconcile each entry, then fallback. Identical text has distinct source IDs; memory cleanup is not evidence.

### Complete input, projection, and authority

Mandatory current input is original requirements plus every admitted guidance item, not last user only. Context selector, Jev relevance, budgets, compaction, and resume use the same input set with reconstructable selection/requests. User grouping must not demote original requirements or pre-guidance task tools to another task. Keep existing lossy tool-result/budget policy; no unlimited-context promise or unconditional inclusion of other Tasks.

Continuation/answer queueing/reordering and independent execution retain resumesTaskId, attachment chain, continuationTaskId, and answer receipts, with no answer-card/receipt routes. Ordinary guidance can join such a running task while existing assembly preserves its original source.

Separate input identity from execution target: target groups execution; bubbles dedupe source Task ID plus real entry, not one-user-per-task. Preserve original and two identical guidance messages independently; answer cards must not replace ordinary guidance in the same task. find_task still returns source Task with route fields explaining target.

Queue creation, execution, and chat admission have distinct evidence. Pending list uses persisted order; ordinary chat uses actual start event, guidance actual JSONL position, never source createdAt. Live/replay/history/cold recovery merge stable identities in the same order, not insert old bubbles then reshuffle by timestamps.

Guidance files/images remain immutable source-task artifacts, available to target only through trusted same-session current-input routes. Extend existing task.attachments/resume resolution without copying artifacts or accepting arbitrary task artifacts/local paths. Per-input references avoid one shared pending-attachment variable. Branching copies JSONL and freezes trusted guided-attachment provenance, never active routes. Offline import rejects Code source profiles/guidance records and declares the new table excluded in TABLE_POLICY; no guidance/answer-source migration is added.

Target retains its model/permission/source; source input mode/path does not elevate it. Consumed data still rechecks existing access. Fallback uses source's original submission, not later session defaults.

### Approval and waits

After durable guidance admission, transactionally invalidate target pending/approved-but-unconsumed approvals, then release relevant waits. Consumption and invalidation arbitrate in the same database state; consumed operations continue. The barrier lasts until the batch enters the next model request; late approvals/unconsumed operations from the old assistant tool batch cannot run first. Started operations are not forcibly stopped and retain real effect facts.

Reuse wait-only release for agent/background-process waits, not whole-task requestStop. Do not cancel SubAgents/workflows/background processes or discard directory yield/reacquire/report claims. Tool text accurately says guidance arrived, old pending operation did not execute, or only waiting ended; it is not owner rejection or proof background stopped. Model-visible wording follows agent-facing-text and actual snapshots, not invented model evidence.

Ordinary submit in a normal Code main session no longer automatically releases agent/process wait and calls requestStop(owner_input). Enter always queues; explicit guidance alone uses wait-only release. Other host/session sources retain their own eligibility, not new interruption authority.

## Related decisions

This extends [backend/FIFO ownership](../architecture/2026-09-19-detach-terminal-from-task-runtime.md), [owner attachments](../architecture/2026-10-16-owner-attachments.md), and [wait/report ownership](../architecture/2026-10-14-agent-wait-and-report-ownership.md); other history/no-replay/authorization/report rules remain. [Generic wait](2026-10-25-code-wait.md), [durable questions](2026-10-21-coding-owner-questions.md), and strict version switching retain their independent contracts. The audit found no relevant competing rejected note and no complete absorption/deletion/archive change; personal/IM/background-lifecycle matches were unrelated.

## Alternatives considered

- **SDK steer/follow-up only:** minimal/native, but volatile with abort residue and no durable acceptance/unique-execution proof. Use it as a carrier only.
- **Stop then continue:** reuses stop, but force-stops tools and changes identity/approvals contrary to guidance semantics.
- **Universal owner-input subsystem:** conceptually separates all inputs, but expands Task attachment FKs, submits, questions, and host sources beyond this need. Task plus route is enough.
- **Put order/routes in meta without schema bump:** flexible JSON, but old programs execute pending sources and lifecycle/receipts become manual indexes. Use real tables and version rejection.
- **Cancel queued Task then copy body:** easy wiring, but loses request/attachment identity and can create duplicate fallback tasks. Reuse the receipt.
- **Convert/import continuations/answers or add guidance IDs/snapshot ledgers:** unifies more paths without a first-release use case; source Task/target entry/existing request records suffice.
- **Additive v53 migration:** locally feasible and preserves sessions, but the owner already chose strict new-profile versions. This task cannot reverse that authorization.

## Consequences

Store owns tasks.queue_order, sessions.queue_revision, and task_guidance. Runtime adds submit.guidance, steerTask, reorderQueue, getTaskQueueDetail; control adds task_queue/queue_reorder/steer_task, session.queue_changed/task.guidance, and taskGuidance snapshots. Shared views use guidanceFor/queuedTasksFor, exclude pending routed sources, and use ruukotoSourceTaskId plus actual admission for history. Desktop supplies compact accessible move-up/down/convert controls and send-as-guidance; TUI has /queue and /steer.

Persistent acceptance, disk admission, and actual model reading must stay distinct to prevent simultaneous SDK/ordinary execution. Cross-store recovery, multi-user projections, and approval barriers depend on complete provenance. Continuation/answer conversion remains excluded. Fresh schema means old chats do not automatically appear; retain old profiles/unknown effects with matching code for verification.

## Verification

Original implementation recorded passing store/runtime/SDK/control cases in `test/queue-guidance-*.test.ts`, `test/sdk-steering-contract.test.ts`, and `test/66-control-seam.test.ts`, covering order/revision/routes/old-schema rejection, submit/convert/fallback/CAS, steer/abort/reservation/stop guards, and op enumeration; check:static passed at that revision. These are historical results, not rerun here. Real-model and dual-client interaction remain external acceptance with unmet prerequisites never counted as passes.
