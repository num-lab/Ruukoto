# Agent Note: A changed device number does not invalidate a registered working directory

Status: implemented

## Problem

An owner reported task failure with an unchanged real path and inode but a changed device number, and requested removal of device-number detection. A device number describes the current mount; its change alone cannot prove replacement of a persistently registered directory. The actual volume remount cause was not verified.

## Decision

Shared `verifyDirIdentity` and its synchronous variant compare registered real path and inode only. Missing/non-directory targets still fail. Success returns the complete current identity without rewriting historical registration. Ordinary task launch and re-acquisition after waiting use the current device number; ToolRouter rechecks the workspace and passes current `dev`/`ino` into LaunchSpec.

The stored device field and physical-alias comparison in `sameDirIdentity` remain. Native startup, worker initialization and each invocation use `dev`/`ino` pinned for that execution and still reject changes during execution. This is distinct from comparing a persistent registration across launches. Frozen workflow sources, workspace snapshots, approval objects and legacy-import identity contracts are unchanged.

[Native execution](../architecture/2026-10-10-native-execution-sandbox.md) retains host identity checks for one execution; this note explains conversion from persistent registration to the current launch identity. [Legacy import](../architecture/2026-10-04-legacy-instance-import.md) and [SubAgent reuse](../feature/2026-10-04-subagent-reuse-close.md) retain their independent attribution/source checks. [Runtime ownership](../architecture/2026-09-19-detach-terminal-from-task-runtime.md) is unaffected.

## Alternatives considered

- Keeping the comparison and asking users to reopen the directory preserves strict cross-device detection, but contradicts the approved behavior and need not refresh old fields when a project is reused.
- Changing only the shared comparison is shorter, but leaves stale device numbers in LaunchSpec and still fails native startup/worker initialization. Recheck and pass the current identity too.
- Removing all device fields and physical checks would lose alias mutual exclusion, protected-scope recognition and within-execution replacement detection, exceeding the request.

## Consequences

Device-number changes no longer invalidate ordinary sessions/workspace reads, without a database migration or historical rewrite. The cost is that shared registration checks no longer detect a cross-volume replacement with the same real path and inode. Frozen sources/snapshots may still reject changes under their own contracts.

Regressions use real temporary directories with old registered device numbers. They cover synchronous/asynchronous positive and negative cases, file/Git reads, a real ordinary-task `read`, occupation, and LaunchSpec current identity. Actual remounting and desktop use after reboot were not verified. Existing native launch-identity rejection tests cover that boundary; local-worker success is not real-sandbox acceptance.
