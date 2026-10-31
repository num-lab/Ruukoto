# Agent Note: Reuse native restricted execution and retire Docker workers

Status: implemented

Partly superseded: [the personal product entry](../simplification/2026-10-18-personal-product-entry.md) replaces personal runtime assembly and old CLI flags. Durable now records command provenance, execution, and stop facts; ordinary dev/worktree wiring no longer serves the official personal product. Native platform primitives remain shared. [Durable Linux claims](2026-10-17-native-linux-execution-identity.md) adds cross-process stop proof below those launchers; [durable commands](2026-10-17-personal-durable-commands.md) owns their actual wiring.

## Problem

Both products shared workers and task lifecycle but shipped different restricted execution: native for Code, Docker images for personal production. The owner chose native for both to remove Docker and worker-image deployment dependencies. Changing service variables alone was insufficient: personal capabilities defaulted to local, and its CLI accepted only local/container by default.

Linux native execution already existed, but user scopes require a user manager, user bus, and cgroup delegation. A system service under a designated account must work without an interactive login, including after reboot; terminal probes cannot prove those conditions or show that backend KillMode reclaims a separate user scope. Removing Docker also removes its 64 MiB `/tmp` cap, an explicit behavior change.

## Decision

### One official restricted backend

Both products declare native as the sole official restricted backend, used by CLI, server, and development assembly. Explicit container/local backend flags or environment overrides are rejected with migration guidance. Missing native prerequisites fail clearly, never falling back to Docker or unrestricted host execution. Shared packages follow capabilities, not product-name branches.

Personal remains a Linux product, reusing WorkerLauncher, bubblewrap namespaces, seccomp, and user scope/cgroup. Existing owners retain worker protocol, task ledger, single-use approvals, protected roots, granted-path identity, read-only shared Git, and stop-result propagation. Native uses the host toolchain without opening all HOME, source roots, or unknown installation parents merely to locate tools. Full access follows [current-account execution](../feature/2026-10-12-full-access-current-account.md); local survives only as that implementation and an offline-test facility.

At this decision's implementation, coverage included ordinary dev sessions, main/scheduled SubAgents, and worktree creation/integration. Main and independent scheduled root business tools stayed on the host without gaining coding tools or direct untrusted Git execution. The personal-entry supersession above now governs official personal wiring.

### Persistent prerequisites and stop proof

Keep the existing system service and explicitly provision its account's user manager for boot and post-logout survival, runtime-dir/user-bus environment, and startup ordering. Only the trusted launcher reaches these management facilities. Restricted worker environments strip internal control variables, credentials, proxies, SSH agent, and user bus. Deployment installs prerequisites and policy; task launchers must not install, elevate, or disable host user-namespace hardening.

Before switching defaults, verify official bwrap/profile, cgroup v2, delegated scope, and cgroup.kill in an isolated tx account's system service and a disposable Ubuntu VM. Cover cold boot without login, post-logout work, cancellation, backend SIGKILL, and a real guest reboot. Verify descendants using PID namespace, scope, and cgroup results; backend KillMode, disappearance of the main worker PID, or successful kill calls alone are not stop proof.

[Unverified stop preservation](../bug-fix/2026-10-11-preserve-unverified-worker-stop.md) governs failures: errors after launch expose execution-unit identity; unknown stopping retains occupancy and evidence and refuses a substitute environment. Restart preserves interrupted/paused state and does not replay unknown effects. Fix diagnostic loss in the worker owner rather than weakening timeouts, protected roots, or stop requirements.

Worker ready/init failures preserve the original `ExecutionError` in standard `Error.cause`, allowing internal code-based distinction among timeout, fatal, exit, and channel failure. External errors remain `execution_unavailable`/`worker_failed`, with unit identity and stop conclusions, not message parsing. Material analysis sends an explicit empty `readRoots` even without extra roots, pinning read-only tools to its subdirectory; this does not add a sandbox to full-access ordinary dev/modification tasks.

### Deletion and resource semantics

Delete Docker launcher/backend values, dedicated environment settings, container UID/GID checks, VM inode exceptions, image builds, and obsolete active checks. Move useful execution/collaboration/recovery/original-entry reporting scenarios to native. Keep old real-container results historical, not relabeled as native evidence. Service-helper prohibitions on managing infrastructure such as Docker remain independently useful; containers used by other software are outside scope.

Use existing private native HOME/TMPDIR without a per-task capacity cap. Clean them only after verified stopping; otherwise retain them. Removing the 64 MiB Docker `/tmp` limit is owner-approved, not resource equivalence. Existing launchers applied no explicit CPU, memory, PID, or workspace quotas; add no new quota system here. Revisit if hard limits become required or disk use becomes unacceptable.

Upgrade by stopping the old backend, verifying its workers per instance, then changing code/configuration. Preserve data and abnormal occupancy. Do not switch active execution environments online, delete containers automatically, or uninstall server Docker. Isolated rehearsals did not touch the live instance; production cutover remains separate.

### Related decisions

The [per-task container note](2026-09-20-tool-worker-per-task-container.md) retains bounded worker protocol, approval, and stop rationale; this decision replaces its personal backend and temporary-space choice. [Code native execution](2026-10-10-native-execution-sandbox.md) retains platform/path/environment mechanisms and accepted macOS limits. [Two products](2026-10-02-two-agent-products.md) retains product/session/capability separation and Linux positioning, not personal container deployment.

[Access modes](../feature/2026-09-19-explicit-access-modes.md), [auto review](../feature/2026-09-22-auto-review-mode.md), and [development launchers](../process/2026-10-09-dev-launchers.md) keep their independent policies with updated backend facts. [Worktrees](2026-10-04-subagent-worktrees.md) and [integration](../feature/2026-10-05-integrate-worktree-results.md) retain write targets, worker-only Git, and result retention. Current-account full access and unverified-stop preservation are reused, not superseded; this migration must not restore the old dedicated full-access account requirement.

Service management, IM approval/reporting, work delegation, reuse/close, messaging, cancellation, and restart-recovery decisions retain their identity/authority/lifecycle rules. Historical Docker tests do not require retaining Docker. GitHub review, group-chat retirement, workspace packaging, and documentation ownership overlap only in historical evidence or build context. The original audit found no proposal requiring full absorption, rejection, or archival.

## Alternatives considered

- Keep explicit Docker fallback: existing container evidence would support servers missing native prerequisites. The owner chose one restricted deployment path, not dual maintenance or automatic downgrade.
- Change the personal entry now and remove unused Docker later: a smaller immediate diff, but obsolete types, configuration, images, and checks would remain after both products stopped using it. The owner chose removal and scenario migration together.
- Preserve the 64 MiB hard temporary-space cap: it limits disk exhaustion, but native had no equivalent and needed new mounts/quotas. The owner accepted native directories and deployment guidance, deferring a separately designed quota policy until needed.
- Remove all server Docker use: simpler operational uniformity, but other services' containers and migration risks are unrelated to task workers and outside the approved scope.

## Consequences

Both products share native execution and installed host tools. Personal deployment requires a continuously available user manager, correct user-bus environment, bwrap/profile, and cgroup delegation. Linger keeps the account manager alive across boot/logout; stopping the system backend and stopping user scopes are different events. Actual tool availability depends on installation layout, supplementary groups, and ACLs; permission preflight uses actual-account `accessSync`, not container UID/GID bit arithmetic. Granted-tree hardlink inspection scales with directory size. Temporary data and unverified-stop evidence consume host disk without new resource quotas or silent fallback.

Deleting the launcher does not stop old-version containers. Before upgrade or rollback, verify old/new units stopped respectively, back up configuration/data, and retain unknown occupancy rather than deleting records to advance cutover.

Historical evidence lived under `.scratch/personal-native-sandbox/` and is now offline provenance, not a maintained acceptance entry. Stage 1 reported 54 real Linux probes on tx Ubuntu 24.04.4/systemd 255/Node 24.21, with an isolated system service whose account lacked Docker-socket access. No-login scheduled writes, post-logout execution, startup cancellation, normal stop, setsid-descendant heartbeats, and empty cgroups passed. Backend SIGKILL stopped the old scope while preserving interrupted/effect-unknown/paused/occupancy-unverified state without replay. A disposable Ubuntu 24.04.5 VM changed boot ID on a real reboot, then its enabled service performed write/bash without login and left an empty cgroup.

Real missing runtime/bus and bwrap/profile cases refused execution. UID 995 with Delegate=no could not create init.scope and returned `execution_unavailable/policy_missing` without a scope, remaining PID, or fallback. Missing ControlGroup and unwritable cgroup.kill after successful manager startup were covered by two targeted substitutes, not claimed as real-kernel reproductions.

Stage 2 reported native scenarios 04/13/15/18/28 passing: four modifying tools, collaboration/material reads under an active parent, recovery, original-IM reporting, main dual-worktree integration, and scheduled confirm/auto-review/full-access delegation. Models, QQ/Telegram, and notifications were deterministic substitutes; processes/files/systemd scopes/socket/SQLite/JSONL were real. Exact abnormal occupancy and initial failure records from main SIGKILL were retained. Stage 3 reported production regression 102/102, integration 13/13, and Code worker 10/worktree 8 Linux cases. The final report held macOS native, entry, permissions, Plan, scheduling, messaging, recovery, combined-release, build/foundation/static results.

A two-product upgrade rehearsal used separately installed/built protocol-compatible commit `8bccb8f` and new code while keeping the other product running. Approval-consumption records, artifact bytes, JSONL, and work copies survived; both products then defaulted to native and wrote real files, while old flags/overrides were rejected. Abnormal occupancy for this upgrade case was seeded through raw SQLite, not a real-kill experiment. No production cutover, real-model use, or real IM outbound acceptance was performed. Real Linux scope was Ubuntu 24.04 x64, not all Linux deployments.
