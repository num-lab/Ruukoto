# Agent Note: Preserve unverified execution stop through task settlement

Status: implemented

## Problem

The original investigation found ready failures discarding stop outcomes, repeated stop reporting success after handles were cleared, Driver removing registrations or ending tasks before cleanup, and unregistered temporary worktree workers. These paths turned unverified exit into releasable directory occupancy, contradicting [tool workers](../architecture/2026-09-20-tool-worker-per-task-container.md) and undermining [native sandbox](../architecture/2026-10-10-native-execution-sandbox.md) residue reports. Offline provenance: retired `.scratch/agent-direction/issues/27-preserve-unverified-worker-stop.md`.

## Decision

Keep one host execution record from launch through ready/init, calls, and stop. Distinguish no unit created, created-and-verified-stopped, and created-but-stop-unverified; an empty communication handle is not exit proof. Concurrent/repeated stop calls share one Promise and cached final conclusion. Stop exceptions become unverified with code/reason retained, not automatically retried into success.

Register task ownership before asynchronous launch, with independent identity per launch. Temporary-worker names differ from ordinary ones, but the real parent task ID travels through registration and tool ledger; a launch name is not ownership. Starting and actual-unit references share the same conclusion, so ready failure or late success cannot evade cancellation. A launcher failing after unit creation must retain a reclaimable identity; only proven no-unit rejection needs no cleanup.

Driver aggregates every managed unit, continuing other cleanup after one failure. Natural/error/cancel/mode-switch settlement waits for the aggregate before existing `Store.endTask` decides occupancy. Clearing a registry must not discard unverified records. Terminal state, `task.tool_process_unreaped`, and occupancy update together in one transaction. Received results and exit verification are separate facts: retain results and never replay effect-unknown operations.

### Temporary execution and explicit recovery

The original worktree fix required the active initiating parent to hold source and copy occupancy and register temporary execution in Driver. `WorkCopyManager` passed ownership/results rather than adding another scheduler. Git success alone did not permit dependent work: verified stop released only that copy; failure retained parent/copy occupancy and files against child/other-session writes. Occupancy already allowed several rows per task, so no migration was needed; whole-task release succeeded if at least one row was deleted, while temporary cleanup removed only its task/directory row.

`worktree_start` ledger evidence retained work ID, copy path, and branch even before work registration; after ready it separately recorded Git intent/result. Cancellation in the launch window meant Git not executed; only a dispatched call lacking result was effect unknown. [Current-workspace snapshots](../architecture/2026-10-15-current-workspace-snapshots.md) later gave capture/registration independent no-model host tasks. That supersedes parent-only temporary ownership, not stop-before-dependent-work or preservation of both occupancies.

The owner uses the existing verification/recovery entry to release residue. Same-process recovery discards the ended old Driver and rebuilds host records; only explicit new verification may cross the cached unverified conclusion.

### What counts as stopped

Container/systemd adapters accept only a successful query with an explicit exited state; query error is not absence. `killProcessGroup` checks the original group, not just the leader. It does not prove detached descendants ended: native platform reclamation remains owned by [the sandbox decision](../architecture/2026-10-10-native-execution-sandbox.md), and this fix does not make local execution isolated.

Full-access local workers additionally need a complete `stopped.reaped=true` receipt for registered command groups. Process exit may precede the final stdout frame. Once the worker group is verified stopped, wait at most three more seconds for a receipt, ending early on a complete frame, stdout end/close, or read error. Only a complete successful receipt plus group-stop proof succeeds. Missing/partial/failed frames or timeout retain occupancy; process exit and pipe drain alone are not command-group proof. This bounded host wait changes neither launcher exit semantics nor cached stop results and never retries a tool.

Group-stop verification polls within existing TERM/KILL budgets. Transient `ps` failure/incomplete output means unknown now, not immediate abandonment of remaining time. Only a later successful query proving no executable members or explicit original-group absence returns true. Query timeout/sleep shrink to remaining stage budget; no new query starts after exhaustion. Each stage still gets at least one check, using a minimum 1 ms timeout at zero budget because Node interprets zero as unlimited. Without explicit proof at budget end, return false and cache it. Repeated queries are not repeated tool effects and earlier errors never count as exit evidence.

Failed TERM/KILL also enters the same verification window. A macOS group containing only zombies can yield EPERM until parent reaping makes it ESRCH; signal failure must not skip verification, and EPERM itself proves nothing. Persistent permission/query failure remains false. Historical joint-acceptance evidence retained signals and zombie `ps` output for the same PID, plus a narrow assertion that fails without this handling.

## Alternatives considered

- Cache only a boolean in `ToolWorkerHost.stop`: fixes repeated calls, not rejected starts, Driver ignoring results, or missing temporary registration.
- Retry every stop and treat missing handles as success: may clean up transient failures, but without persistent identity/full-unit proof can turn unknown into success and race concurrent cleanup.
- Retain only the parent directory: fewer changes, but a work copy outside it remains writable by another task. Retain copy occupancy too.
- Add a second temporary-worker manager: covers backend stop but duplicates parent cancellation/mode/terminal handling. Reuse execution registration with real parent provenance.
- Redefine launcher exit as all stdio closed: avoids tail-frame ordering globally, but escaped descendants may hold pipes and change every caller's semantics. Bound only the host stop path needing the receipt.

## Consequences

Conservative retention can block directories until owner verification. Cached results do not improve actual backend stop capability, and memory registration alone proves nothing about pre-restart processes; persistent occupancy recovery remains necessary. Existing worktree/result-retention/cancellation/authorization decisions continue unless explicitly superseded above.

`test/100-worker-stop.test.ts` and targeted lifecycle tests cover controlled launchers, task termination, mode changes, temporary ownership, occupancy, and visible state. Real same-group heartbeat processes prove descendant reclamation when the leader exits first. Modelled stop failure is not a reproduced OS-unit failure; macOS/Linux native acceptance remains separate.

Tail receipts arriving in the next macrotask cover success/failure/missing/partial frames, unverified worker groups, and bounded waiting on open pipes; removing the host wait makes the success case fail. Historical same-source counterexamples and Coding comparison were in retired `.scratch/personal-pi-durable/issues/36-coding-regression.md`; they do not establish the exact original Linux trigger.

Transient query failure uses a real TERM-ignoring group with faults in its first two queries, then actual host `/bin/ps` proof. Controlled callbacks cover persistent failure/incomplete output; controlled clock/query logs prove no query after exhaustion and tightened timeouts/sleeps. A temporary executable's startup can itself consume a short budget, so whether it launches does not prove query retry. Old CI raw `ps` output was not saved; deterministic reproduction is not a captured remote root cause. Offline provenance: `.scratch/ci/2026-10-11-previous-ci-failures.md` and `.scratch/agent-workflow/issues/07-acceptance.md`.

[Task-ending protocol](../architecture/2026-10-16-task-ending-protocol.md) now centralizes the three execution owners' settlement, retaining these stop/occupancy rules. [Script isolation](../architecture/2026-10-13-workflow-script-isolation.md) reuses starting identity/unverified retention while owning script/WASM disposal. [Current-account full access](../feature/2026-10-12-full-access-current-account.md) owns account/environment/approval policy. Both [Coding](../feature/2026-10-21-coding-background-processes.md) and [Personal](../feature/2026-10-21-personal-background-processes.md) backgrounds now reuse these facts for independent session execution; ordinary bash remains reclaimed at call completion.
