# Agent Note: Centralize the ending protocol for running tasks

Status: implemented

## Problem

[Unverified stopping](../bug-fix/2026-10-11-preserve-unverified-worker-stop.md) requires stopping and verifying execution units before the terminal transaction decides directory occupancy. Mark unknown effects only after the conditional terminal update succeeds and before its terminal event. `Store.endTask` centralized that transaction, but Driver `requestStop`/`finalize`, `HostExecutionManager.stop` and `WorkflowCoordinator.stopJob` separately implemented cancellation intent, ledger snapshots, stopping, settlement, stop records and post-commit wakeup.

The 2026-10-16 review at develop `9928103` found divergent behavior. Driver settled the ledger in a separate transaction and marked unknown effects in `onChanged`. Host operations did both in `onChanged`, so losing the terminal race also lost known settlement until restart. Workflow abort marked unknown effects unconditionally before `endTask`, even though its nested Driver could finish the task first. Workflow natural completion used two transactions and settled with an empty snapshot, contradicting `settleAfterWriteFailure`: operations missing results after a write failure stay for restart unless a host family can verify them. The queue's defensive catch released occupancy as failed without verifying execution, whereas `doStop` without a Driver retained it.

Testing these rules required a complete test Runtime, frozen queue, manually inserted task rows and internal Driver access. Another stop path would copy the same protocol again. Offline architecture issues `14-task-ending.md` and `17-task-ending-protocol.md` retain the original requirements and review evidence; they are not current local work entries.

## Decision

`packages/agent/src/task-ending.ts` exports `endTaskExecution` and caller-owned `TaskEndingContext`. The helper owns the protocol; execution owners stop their own resources, pass the same context throughout one task and supply their transaction-local records. It belongs to agent because Driver and the ledger are there; Driver cannot depend on runtime values.

`TaskEndingContext` contains only `taskId` and `stopSnapshot: string[] | null`. Null means no abort snapshot; an empty array means abort began with no pending writes to verify. `endTaskExecution` receives store/ledger and optional `onReleased`, task identity, this context, and terminal/reason, optional `abort: true`, optional asynchronous `halt`, `unreapedReason`, optional `modeSwitchFailure` and `inTx({changed, reaped})`. It returns `{changed, reaped}`. A failed terminal maps reason to `errorMessage`; canceled/interrupted maps it to `interruptReason`.

The order is fixed:

1. On abort, persist cancellation intent in a separate transaction, using `terminal === "canceled"`. Call `beginStop` only when no snapshot exists. Adopt any existing handoff candidate by copying its array, so a successful handoff cannot retract an already adopted abort snapshot. This happens before the first yield and before assembly/controller abort, approval release or resource stopping. Later ending paths cannot replace the original facts with a later snapshot.
2. Call `halt`. An exception means stopping is unverified, emits a `[ruukoto:task-ending]` diagnostic and retains occupancy. Omitting `halt` also means unverified, not successful.
3. After `halt`, reread the shared snapshot and open one transaction. If non-null, `settleTask` first records verifiable results, then `endTask` marks remaining unknown effects inside `onChanged`, and finally `inTx` writes execution-owner records with `changed` and `reaped`. Settlement depends on the current shared snapshot, not this call's `abort` flag or a null cached before the wait.
4. After commit, call `onReleased` only for an actual release: `changed && reaped`.

### One snapshot from task start

The context does not own execution resources, stop Promises, target terminal state or scheduling locks. Create `{taskId, stopSnapshot: null}` once per task and pass the same object through nested execution. Parent and work-copy host tasks have different IDs and separate contexts. The helper has no task registry and never waits for another layer's ending Promise.

The ordinary queue creates the context before `getDriver`, passes it to `Driver.run(task, ending)` and reuses it in catch. Driver stores it during task initialization for interruption, natural finalization, mode-switch failure and directory-yield failure. Direct Driver tests may omit it, causing initialization to create one, never a new object per `finalize`.

Mode switching and directory yielding stage a candidate snapshot before stopping resources. Failure ends from that fact. Success restores the previous snapshot only when no concurrent abort adopted the candidate. Adoption preserves candidate contents but changes the array reference; a handoff cannot erase outer abort facts merely because the inner stop entry has not run yet. Late results do not erase what had already begun before stopping.

Workflow creates the context with `AgentJob`, passes it through `WorkflowAgentContext.ending`, and the default `WorkflowSteps.agent` supplies it to `Driver.run` at startup. Outer `stopJob`, inner Driver, natural completion and catch therefore share it without changing `ManagedEntry.stop()`. Capture before `job.controller.abort()` and before awaiting `entry.stop()`: forwarding a snapshot to `requestStop` only after an `await ready` can be too late. A first abort arriving after `stopJob(false)` began must still capture facts and cancellation intent before reusing its stop Promise; `if (job.stop) return job.stop` cannot bypass this.

If natural completion enters `halt` first and abort captures a snapshot during that wait, natural completion sees it before its terminal transaction and handles unknown effects if it wins. If a terminal state committed before any abort, a later abort cannot append unknown effects. Each owner retains its existing Promise deduplication: the winner marks unknown effects; the loser can still record known results and its own execution records.

`HostExecutionManager` creates the host task's context at attach. A first cancel/interrupt during unfinished natural stopping goes through the helper before waiting for the old stop Promise. Once terminal state is committed, reuse that Promise immediately without changing cancellation intent or settling the ledger. Natural stopping reads the same snapshot; a later path neither stops units again nor wakes the queue twice.

Driver exposes a read-only reference to the current task context. Work-copy execution captures the parent reference before requesting parent stop and reuses it in failure fallback, rather than reading Driver state later in catch when it may belong to another task. Existing execution ownership retains the context through ending. Transaction failure does not clear it; the next task gets a fresh context.

### Missing workflow results

Natural completion with a still-null shared snapshot does not call `settleTask`, synthesize tool results or mark unknown effects. A final step output is not evidence that its writes completed. Workflow safety uses persisted facts:

1. `unsafeReason` first preserves existing unverified-occupancy and task/operation-effect-unknown checks.
2. Share the per-operation classification with `safeToRetry`: a read-only tool, or an operation with approvals all unconsumed, proves no write effect. Any operation with `resultSummary === null` outside that classification yields `write_result_missing`, regardless of `hasOutput`. This query neither writes the ledger nor calls host-family verification to manufacture results.
3. Without final output, the existing `safeToRetry(task)` still decides whether recorded operations permit retry. Complete tool results plus valid output allow a normal write step to finish. Read-only or entirely unconsumed-approval attempts can retry within existing limits.

Both workflow checks use the injected `ToolOpLedger.hasNoWriteEffect` and the same approval facts. Apply them to Agent and host tasks before `finishWorkflowStep`, delivery or successful aggregation. Leave the missing write result for restart `settleAll`. A paused workflow step does not rewrite the ordinary Driver's independently chosen task terminal state.

### Included and excluded paths

Included paths are Driver cancellation/interruption, mode-switch failure, backend stop, natural completion/failure and unverified `yieldWorkspace`; `HostExecutionManager.stop` for workflow/work-copy host operations; and workflow `stopJob` abort, natural completion and catch.

`doStop` without a Driver creates a separate context and supplies neither `halt` nor `abort`, preserving the original cancellation flag and unsettled operations while retaining occupancy for recovery verification.

The queue's defensive catch uses the original context. If `getDriver` threw before returning and this task's `run` was never called, `halt` returns true: no execution unit began. After obtaining a Driver, it awaits `driver.stopManagedProcesses(task.id)` but returns false even on success. Managed-process stopping alone does not verify every task resource; a thrown stop is also unverified.

The parent-stop failure fallback in `executeOrdinaryWorkCopy` reuses the context captured before stopping. It does not request stop again or take a new snapshot. Without `halt`, it ends as interrupted with `tool_process_unreaped`, retaining occupancy and settling from the existing snapshot. The fire-and-forget caller handles the complete fallback Promise; another persistence failure emits `[ruukoto:runtime]`, retains task/occupancy for recovery and neither leaves an unhandled rejection nor retries or claims completion.

Excluded paths remain:

- A queued task's direct terminal update: no execution unit exists, so `Store.endTask` suffices.
- Restart `recover()`, `resumeQueue` and immediate workflow host-start ending.
- Synchronous work-copy host attach failure. Attach removes its failed registration before `executeWorkCopy` is called, proving zero execution units started. The original transaction records host failure result, terminal state, occupancy release and `workCopyHost.stopVerified=true` together. Failures after successful attach are not exempt.
- Transaction-local parts of group cancellation. Their post-commit `cancelTask` calls use the centralized path.

### Conservative queue fallback

Driver's explicit stop also combines a browser-stop result, which is not part of the managed-process registry. If browser stop returns false and the terminal transaction rolls back, a queue catch that later observes worker true cannot release occupancy. Failure can occur before the aggregate stop result returns at all. Continue reclaiming managed processes but retain occupancy; do not introduce another complete-stop cache or close the browser again to overwrite the original failure.

The conditional failed update records `tool_process_unreaped` and its unverified event through the same context/helper. If another ending path already committed, it does not overwrite that terminal state or occupancy. The helper does not call `onReleased` for retention. Runtime's existing `finally` may recheck the queue, but retained occupancy must keep later tasks in the same directory queued. Owner-verified recovery still uses `resumeQueue`; a later worker true is not automatic permission to proceed.

### What remains separate

Execution owners retain their `stopPromise`, `state.stop` and workflow `job.stop`/`job.abort` deduplication. A default workflow Agent step registers a real Driver that can end the same task. Shared facts do not create wait dependencies; task-global Promise deduplication would deadlock an outer stop awaiting its nested Driver. `job.stop` stops units only; `job.abort` caches the complete abort. Repeated abort must not rewrite execution events, otherwise a committed pause event can trigger `stopRun` repeatedly in microtasks and starve I/O. The first abort during natural stopping captures facts before creating `job.abort` and reusing `job.stop`.

The first terminal committer still wins. Runtime still owns execution-owner lookup, the `cancel_requested` cancellation window from [cancel work](../feature/2026-10-04-cancel-work.md), and `doStop` ordering. Storage/event formats are unchanged: stop facts remain in occupancy, `read_scope.workCopyHost.stopVerified` and `workflow_executions.stopVerified`, supplied through `inTx`; each owner chooses its `task.tool_process_unreaped` reason. A storage-unification `XXX` remains in the helper. Wakeup uses Runtime's injected `kickAll`.

### Behavioral corrections

Host operations settle known facts even after losing the terminal race and write `cancel_requested=0` on interruption, like Driver. Workflow abort records cancellation intent and marks unknown effects only after a successful conditional terminal update. It chooses its target from run state when that abort begins: if paused then canceled while stopping, an outer winner can leave task interrupted while the run is canceled. The inner Driver independently chooses its own target; the winner is never overwritten.

Unaborted workflow natural completion no longer settles the ledger. Missing write results pause with `write_result_missing` even when final output exists. Every nested ending path uses the same first snapshot so late results cannot hide operations begun before abort. The queue releases on a pre-Driver failure with no task execution, but retains on later exceptions without complete stop evidence. Only the winner that releases occupancy wakes through the helper.

## Related decisions

[Unverified stopping](../bug-fix/2026-10-11-preserve-unverified-worker-stop.md) owns the safety rule; this note centralizes its protocol. [Workflow runtime/store](2026-10-13-workflow-runtime-and-store.md) retains execution registration and stopping. [Application data](2026-09-23-main-app-data-space.md) retains host-verifiable settlement after result-write failure; other operations wait for restart, and workflow missing-result checks only pause.

[Background lifecycle](../../proposed/feature/2026-10-14-bash-background-lifecycle.md) originally proposed a Driver-registry fix. Current [Coding backgrounds](../feature/2026-10-21-coding-background-processes.md) and [Personal backgrounds](../feature/2026-10-21-personal-background-processes.md) own the later cross-message, session-owned units; they are not another execution owner for this task-ending helper. Revisit scope when a new owner introduces task-external stopping facts. Cancellation and [wait/report ownership](2026-10-14-agent-wait-and-report-ownership.md) remain unchanged. [Native execution](2026-10-10-native-execution-sandbox.md) keeps per-call checks in `ToolWorkerHost.call`; the original scheduling/import/IM/product audit found no overlap requiring absorption.

## Alternatives considered

- **Task registry for ownership and deduplication.** The initial architecture review proposed removing branches from `cancelTask`, `interruptTask` and `doStop`. Only three small lookup branches existed, and a registry would alter cancellation windows and stop ordering. Nested workflow Drivers would also self-deadlock with task-global deduplication.
- **One terminal-state owner per task.** Let the nested Driver halt only and the workflow coordinator choose the terminal state. This removes nesting but changes observable behavior: invalid step output could turn a previously completed task into failed, and Driver's workflow finalization would change. It is a separate design, not protocol extraction.
- **Move every stop result into a task column now.** One storage location is simpler, but roughly 40 readers, workflow execution events and both import directions would migrate with a schema increment. Centralizing the protocol does not require it.
- **Put the function in runtime.** Lookup and wakeup are there, but Driver would need a callback into runtime while the ledger already belongs to agent. Keep it beside Driver/ledger.
- **Settle natural completion too.** All three paths would look identical. That contradicts result-write-failure policy and can mislabel operations whose real results were already obtained as unknown.
- **Pass the outer snapshot only at nested `requestStop`.** Fewer parameters could cover an inner abort committing first. Natural completion can commit during `await ready` or another wait before the snapshot arrives. Share the container from startup and reread immediately before the transaction.
- **Cache complete stop conclusions for the queue catch.** It could release resources known stopped when only terminal persistence failed, avoiding manual recovery. Correct caching must also cover failures before aggregation, distinct ending phases and interrupted evidence. Conservative retention satisfies safety without another verification state; revisit if these exceptional manual recoveries become frequent.

## Verification

Function, real-queue and default-adapter regressions live in `test/94-task-ending.test.ts`, `test/105-workflow-runtime.test.ts`, `test/106-workflow-host.test.ts`, `test/112-workflow-real-steps.test.ts` and `test/work-copy-host-runtime.test.ts`. The original offline architecture issue 17 records executed environments, fix-removal negatives and gaps; it is historical evidence, not a fresh run of those tests during this translation.

- Function tests use a real Store/ToolOpLedger and controlled `halt`, without Runtime: release/wakeup; false/thrown/absent halt retaining occupancy and reason; conditional unknown effects; known settlement after losing the race; natural completion with no snapshot leaving unsettled operations alone; cancellation intent; and `inTx` receiving `changed`.
- Shared-context tests cover an outer snapshot followed by a late result and inner terminal winner, and natural halt followed by abort capture and natural terminal winner. They check unknown marking before the single terminal event, one wakeup, no snapshot inheritance by the next task and snapshot retention after transaction rollback.
- Default-adapter integration proves actual `AgentJob -> WorkflowAgentContext -> WorkflowSteps -> Driver` identity and bounded nested stopping. Passing the same object to two helper calls manually is not wiring evidence.
- Missing-result tests cover Agent and host tasks: legal final output with a missing write result pauses without dispatching dependencies or inventing a result/unknown flag; complete results and valid output complete; read-only/all-unconsumed approvals allow bounded retry without natural settlement.
- Work-copy tests prove zero execution on attach failure and atomic failure/stop records; parent-stop fallback reuses its snapshot, retains occupancy and does not wake. Repeated persistence failure must remain visible with state retained.
- Real Runtime queue tests enter catch and finally: pre-Driver failure releases; a later exception retains despite worker true; browser false plus first terminal-transaction rollback plus worker true preserves unverified facts and keeps the next same-directory task queued; an existing terminal state is not overwritten. Hand-written Store simulations are design probes, not substitutes for queue coverage.

The original acceptance also selected worker-stop, workflow and SubAgent regressions using [pre-push checks](../../../skills/pre-push-checks/SKILL.md) and reported static success. Changed content needs its own scoped evidence; historical success is not a current test claim.

## Consequences

One function owns settlement/terminal ordering, while resource ownership and existing deduplication remain local. Driver settlement and terminal state now roll back together on persistence failure; if fallback also fails, the task can remain running until restart `recover()`. Previously settlement could commit without terminal state. Neither failure permits occupancy release without verification.

A shared object must travel from startup through every ending path. Copying the object, caching null before halt or reusing it across tasks loses stop facts, so both race and wiring tests matter. It is not persisted across restart; recovery still uses the existing ledger and occupancy records.

Workflow pause/cancel races can leave task and run terminal labels different. Safety reads actual run/execution records, not the outer intended label. Missing write results pause even with valid final output and may become unknown during restart settlement; restart is not a promise of safe recovery or retry.

Exceptional queue fallback can retain occupancy even after all resources actually exited, because it lacks complete proof. Owner verification is the deliberate cost of not losing browser-stop failure across transaction rollback; normal Driver ending is unaffected. Reverting this extraction requires restoring Runtime and default-adapter call paths together, with no data migration.
