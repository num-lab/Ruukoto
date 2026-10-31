# Agent Note: Linux native execution rechecks stopping by persistent identity

Status: implemented

## Problem

The [Personal migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) requires proof of external stopping after backend restart. Existing native-launcher scope/group/exit facts lived only in memory. Relaunching creates a second execution; original PID or unit not-found cannot exclude late creation or descendants that changed process groups.

## Decision

Linux restricted execution gains an independent persistent-claim API taking a host-precommitted execution reference and private directory inaccessible to the worker. Atomic claim precedes platform calls; the same ID never launches twice. It pins machine, boot, scope and parameter fingerprint, recording the independent launcher's lifetime identity. Scope Description contains a random host token. The private started marker, Description, InvocationID and launcher's /proc cgroup membership must all match before recording original unit/cgroup dev/ino.

[Durable commands](2026-10-17-personal-durable-commands.md) supplies the original launch fingerprint on recovery. Stopping accepts only an existing matching launch claim; absence does not create a stop-first claim, and an existing stop-first claim cannot prove exit of an old execution whose record is missing. Default calls retain stop-first semantics for undispatched execution. Stopping first persistently blocks late launch, then verifies original unit/cgroup identity before requesting termination. Unobserved execution, same-name occupancy or rebuilt groups do not cause name-based kills, and persisted PID/PGID values are never signaled.

Termination writes only to original cgroup.kill opened beneath a directory FD with verified dev/ino, not systemctl kill/stop by name. Same-name replacement after checking cannot kill the new group. Exit proof requires original launcher/whole group ended, the previously observed original cgroup empty or gone, and unit quiescent. Undispatched execution or a different boot can independently prove no remainder. Missing/corrupt evidence, identity changes or failed queries preserve unverified state and evidence. Stop results are not command-effect receipts. The [one-shot command host](2026-10-17-personal-command-execution.md) separately saves original temporary directory/return evidence; durable still records results/unknown pauses independently.

Reuse existing platform launch checks. Coding's default path does not enable persistent claims. The original slice works below PreparedNativeLaunch without changing old worker Pi-dependency discovery or adding tools, duplicate runtime state or an operation framework. [Full-access commands](2026-10-17-personal-full-access-commands.md) later extends tracked execution beyond the initial restricted-only scope while retaining these identity/stopping rules.

## Related decisions

The original active-note audit searched Personal durable, native execution, stopping and service identity. [Native sandbox](2026-10-10-native-execution-sandbox.md) and [Personal native execution](2026-10-12-personal-native-sandbox.md) retain permissions/Coding paths. [Fixed inspection claims](2026-10-17-service-inspection-identity.md) supplies claim/stop-first precedent, but process-group inspection cannot replace cgroup proof for arbitrary commands. No note was wholly absorbed or invalidated.

## Alternatives considered

- Original backend PID plus fixed scope: smallest change, but backend lifetime differs from an individual launcher and cannot prove unrelated group work/late creation ended.
- Copy the service-helper protocol: existing claims/stop-first behavior, but root service allowlists and fixed show/restart do not suit general tools; expanding the helper adds privilege exposure.
- Rebuild workers and durable command tools together: complete capability at once, but couples stopping primitives with permissions, approvals, artifacts and unknown recovery, obscuring SIGKILL-window verification.

## Verification

Original at-most-once launch, stop-first, conservative bad-evidence rejection, real Linux scope/process-group escape and backend-SIGKILL recovery evidence is offline at `.scratch/personal-pi-durable/issues/22-native-execution-identity.md`.

## Consequences

Claims/external processes are not atomic. Missing post-dispatch evidence can block conservatively indefinitely; invoking the same ID again is not repair. The later full-access extension retains its explicit escape limits. Remote MCP is outside local stopping proof. Persistent files cover process crashes, not guaranteed retention of latest writes through power loss.
