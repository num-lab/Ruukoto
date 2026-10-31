# Agent Note: Integrate complete worktree differences and preserve conflicting results

Status: implemented

Original source: ADR 0021, integration and main modification delegation supplement.

[Current-workspace snapshots and child deltas](../architecture/2026-10-15-current-workspace-snapshots.md) supersedes content baselines, zero-write capture/host preparation, whole-file conflicts, and corrupt-baseline isolation. [Personal native execution](../architecture/2026-10-12-personal-native-sandbox.md) supersedes restricted backend choice; [current-account full access](2026-10-12-full-access-current-account.md) owns account/environment/authorization propagation. Other result/retention contracts remain.

## Problem

[Independent worktrees](../architecture/2026-10-04-subagent-worktrees.md) allow parallel changes without modifying the parent, but main must integrate and verify results while preserving both sides on conflict. Main's write delegation needs the same path rather than fixed coding.

## Decision

1. `subagent_integrate(work_id)` is available to ordinary dev/main, including report wakes; host identity rejects SubAgents, groups, and retired fixed roles. Resolve the write target pinned to that work, not the Agent's newer work after reuse. The original algorithm included untracked files with `git add -N --all`, produced full binary diff/numstat against baseline, checked parent `apply --check`, then applied only after success. Disable fsmonitor/hooks (`/dev/null`) and grant the pinned shared Git directory read/write when the parent is itself a worktree. All Git runs in the [worktree worker](../architecture/2026-10-04-subagent-worktrees.md), never directly in the host. Baseline/extraction now follow the snapshot successor. Integration leaves uncommitted parent changes; it never commits for main. Main verifies the combined result with its own tools; SubAgent instructions also require relevant checks in the copy and a report.
2. Outcomes are applied, already, and conflict. Applied writes and records `work_delegation.integrated`; already means the complete diff is present (`apply --check --reverse`) and performs no repeated write/event; both-direction preflight failure means conflict with named files and next-action guidance, leaving parent and copy unchanged. The event transaction records work/SubAgent/integrating main task/branch/baseline/parent HEAD/file list capped at 64/numstat/patch bytes. The operation ledger reconciles via that event. Applying bytes and recording the event are separate: missing evidence means unverifiable, not unexecuted, and never automatic replay. Preserved copy and parent git status support recovery.
3. Reject active work tasks, missing/replaced copy identities or `.git` targets, a repository root outside the parent workspace, or unreadable `.git`. Use the same directory checks as continuation and never recreate a missing copy. Canceled work or closed SubAgent does not block retrieving/integrating preserved results; occupancy/active checks still apply. Integration/close races retain copy plus event evidence. Non-Git direct-write work has no copy and is reported as already in place; read-only analysis rejects integration.
4. Main may delegate `mode=modify + target` through the same restricted worker/occupancy/integration path. Fixed coding/chat remain rejected. New analysis/writes use `subagent_delegate`; old coding drafts lack work_id and are read-only historical results, not integration inputs. The original new event/tool advanced protocol to v15, a historical introduction number.

The original full-diff algorithm had no incremental integration state: further changes after an integration could conflict with already-applied hunks. Its busy check and apply also had no extra lock, so a newly registered execution could change the copy in between. The snapshot successor owns current delta/baseline and occupancy checks; these original limitations must not be asserted as current where superseded.

## Temporary data and execution

Native `Runtime.executeWorkCopy` uses random 0700 `mktemp -d` directories inside the execution unit's TMPDIR for patch/numstat/errors. Shared fixed `/tmp/ruukoto-integrate.*` could collide with other work/host data. No EXIT trap deletes evidence early; verified unit stop cleans it, unverified stop retains temp data and occupancy. HOME/TMPDIR use host temporary storage with no per-task capacity quota. Full access follows the initiating task's current-account authorization. New personal durable workflow/work-copy capabilities are not implied by the old shared Runtime path.

During migration, coding_delegate(analyze) moved to generic reads while draft stayed on the old path without work_id. Generic modification/integration later removed that delegation entry; coding_result still reads history.

## Alternatives considered

No alternatives were recorded in this pre-format ADR supplement. The later snapshot decision records its own revised baseline/delta choice; this translation does not invent original deliberations.

## Consequences

Integration delivers uncommitted changes rather than silently committing; conflict preserves both sides. Cancellation/close does not destroy results. Filesystem writes and event persistence are not one transaction, so unknown application state needs retained evidence and no replay. Current snapshot/version guarantees are owned by the successor, not the original full-diff limitations.

## Verification

Historical offline `.scratch/agent-direction/issues/17-integrate-worktree-results.md` and smoke-issue17 recorded macOS Docker Desktop and tx Ubuntu 24.04 native Docker (uid/gid 1003) each 7/7: real copy edit/write, unchanged parent bytes before apply, diff/check/apply, unchanged parent HEAD, event/already idempotence, zero-write named conflict, integration after cancel/close, and no container residue. Models were mocked, container/files real. Parent worktrees needed shared Git read/write mounts; fixture/real paths used realpath for macOS `/var` aliases. These are not native results.

Test/95's two-repository numstat barrier ensures both patches coexist before separate application, detecting cross-work temp contamination. Native worker/worktree evidence is separate. This migration reruns no runtime or platform tests.
