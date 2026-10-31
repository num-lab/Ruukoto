# Agent Note: Give each modifying SubAgent work its own write target

Status: implemented

Original identifier: ADR 0021

Partly superseded: [current-workspace snapshots](2026-10-15-current-workspace-snapshots.md) owns content baselines, zero-write capture, host preparation, whole-file conflicts, and bad-baseline isolation. [Configurable roles](2026-10-14-configurable-subagent-roles.md) separates role, source capabilities, and execution target. [Native execution](2026-10-12-personal-native-sandbox.md) replaces container wiring and permission/identity checks. This note retains write-target identity, worker-only Git, serialization, and result retention.

## Problem

[Two products](2026-10-02-two-agent-products.md) requires independent Git worktrees for parallel modification and serial writes in non-Git directories. The first [SubAgent implementation](2026-10-03-work-delegation-subagent-task.md) only analyzed material: it had no write mode/tools, no worktree preparation, and a cwd-based occupancy key that did not conflict with ancestor or descendant directories.

## Decision

Pin one write target when a work delegation is first created. Schema v27 introduced nullable `work_delegations.write_target`: Git records repository root, common Git directory, worktree gitdir/path/dev/ino, branch, and base commit; direct non-Git work records path/dev/ino. A null target means analysis-only and cannot be upgraded to modification. Continuing a `work_id` reuses and verifies its directory identity and `.git` pointer. Replacement, deletion, or changed gitdir fails explicitly; never recreate silently. Reusing a SubAgent for a new work creates a new copy.

Git work uses `<dataDir>/../agent-work/worktrees/<workId>` outside protected roots and the parent workspace, with branch `ruukoto/work-<workId>`. Retain all copies, including failed preparation, and report the path/branch on failure; provide no deletion or automatic adoption of nonempty leftovers. SubAgents do not add/commit/push: the parent applies results under [integration rules](../feature/2026-10-05-integrate-worktree-results.md). The original HEAD-only baseline excluded parent uncommitted changes; the linked current-workspace snapshot decision replaces that baseline, not the retention rule.

Occupancy conflicts on equal dev/ino, equal realpath, or path-component-bounded ancestor/descendant relationships, for every task. Non-Git child writes and parent work serialize; formerly independent nested-cwd sessions now serialize too. Release by `taskId`. The original interface had no blocking parent wait that could hold occupancy while waiting on a child; later waiting behavior belongs to [wait/report ownership](2026-10-14-agent-wait-and-report-ownership.md).

### Git belongs inside the worker

The host never runs Git against an untrusted repository. A parent worker can alter `.git/config`; running host-account Git could execute planted fsmonitor/filter programs outside the restricted boundary. Worktree preparation runs a host-fixed command through the task worker with `core.fsmonitor=false` and `core.hooksPath=/dev/null`, verifies the base commit as a 40-digit hex ID, and uses the repository root plus the copy's required access. It does not acquire the parent's occupancy and self-deadlock; Git coordinates its own metadata locks.

Use the copy's realpath consistently in the command, execution configuration, and write-target record. Git stores literal worktree paths in its shared metadata; macOS `/var` versus `/private/var` aliases historically produced "not a git repository" when the stored and verified forms differed. Precreate an empty 0700 copy directory, refusing nonempty leftovers. Originally this also prevented Docker from creating a root-owned bind source that the container uid could not write.

The worktree is writable but the shared Git directory is a read-only root. Status/diff/log remain available; writes to refs/hooks/config do not. Otherwise a child could plant code later executed by the owner's Git. Reject read-write grants covering `agent-work/worktrees` or descendants so grants cannot bypass copy ownership; read-only grants remain allowed. Fixed Git configuration is limited to preparation, copy use, and integration rather than becoming general task authority.

### Current execution scope

`Runtime.executeWorkCopy` registers `ToolWorkerHost.create` before `host.start()`, then executes fixed Git commands under the originating task's actual mode. Restricted tasks use native execution; [current-account full access](../feature/2026-10-12-full-access-current-account.md) governs full-access execution and propagation. Ordinary dev and main can delegate modifications within their eligibility rules; plan mode, SubAgent, and retired coding/chat identities cannot use the old root delegation path. The initial confirm-only child policy and fixed read/edit/write/bash/read_artifact set are historical; current role/source/target decisions govern eligibility and tools.

Workspace/read-root dev/ino are now host identities. `WorkCopyManager.canRead`/`canWrite` use actual-account `accessSync`, including supplementary groups and ACLs. Container UID/GID permission tests, Docker Desktop's remapped-inode exception, and container `safe.directory=*` injection are retired. Historically Linux bind mounts preserved identity while macOS Docker Desktop did not; the latter used path pinning in the worker and host queue-loop identity checks. This exception was tied to that backend, never a reason to weaken native identity checks.

[Workflow capabilities](2026-10-13-workflow-step-capabilities.md) owns freezing, independent verification, and controlled import; ordinary integration refuses workflow output. [Workflow runtime/store](2026-10-13-workflow-runtime-and-store.md) owns separately authorized step executions, pointers, results, and recovery. The current personal durable product no longer uses the old shared personal worktree assembly; native platform primitives remain shared as described by the native-execution note.

## Alternatives considered

- Host-side Git avoids worker startup and access preparation, but repository-controlled fsmonitor/filter configuration can execute with host authority. Run fixed Git commands inside the worker with hooks/fsmonitor disabled instead.
- Writable shared Git metadata allows an ordinary commit workflow, but also lets children alter hooks/config that later run in the owner's environment. Keep it read-only and leave commit/push decisions with the parent.

## Consequences

Parallel Git work retains independent results; non-Git and nested-directory writes serialize. Copies and failure evidence consume disk indefinitely, and identity or Git-pointer changes require explicit failure rather than silent repair. Baseline content now follows the snapshot decision. Native identity/permission checks replace backend-specific exceptions without relaxing worker-only Git or result/conflict retention.

Historical issue 16 and `smoke-16-parallel-worktrees.mts` reported test/83 13/13, npm test 903 passed/0 failed/1 skipped of 904, and typecheck passing. macOS Docker Desktop and Linux Docker via `ssh tx` (uid/gid 1003) each passed 9/9: real Runtime/files/containers, simulated model. Coverage included parallel worktrees, non-Git serialization, safe.directory, denied commit/hooks/config writes, planted host-code nonexecution, and no remaining containers. The former `.scratch/agent-direction/issues/16-parallel-worktrees.md` is offline historical provenance; those results are not native-backend acceptance evidence.
