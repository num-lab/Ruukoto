# Agent Note: Publish lock ownership atomically

Status: implemented

## Problem

[Issue #22](https://github.com/num-lab/Ruukoto/issues/22) records two starters acquiring the same instance/configuration lock between directory creation and owner publication. Treating a missing owner as stale also allows a contender to remove an in-progress lock. Unconditional release or stale takeover can delete a successor.

## Decision

A starter writes and syncs its process identity in a private staging directory, then installs that complete directory with the host's exclusive, fd-relative rename. The final lock is either absent or has a complete owner. Linux uses `renameat2(RENAME_NOREPLACE)`; macOS uses `renameatx_np(RENAME_EXCL)`, through the existing Python prerequisite. New publishers and releasers briefly flock the persistent parent inode while comparing/removing/installing entries. This transient exclusion is not the lifetime lock and cannot leave an ownerless recovery gate after a crash.

Electron and MyGo embed the Python helper's source in their signed JavaScript host bundle. Source execution reads the adjacent helper once; bundled execution never depends on an unshipped source-tree file.

A stale decision binds both the lock inode and a digest of its owner bytes. Conditional takeover and release operate only on that binding; they never recursively delete a current lock or any additional contents. A released handle cannot remove a successor. Missing, malformed, unreadable or linked owner records are unverifiable, including invalid PIDs and process-start identities. Valid exited or reused PIDs retain stale-lock behavior. Legacy valid records without a process identity retain the command check so the predecessor admission guard can hold compatible exclusion.

Published locks prevent the archived predecessor's delayed recursive takeover from removing or overwriting `owner.json`, even though it does not participate in the parent flock. Linux uses a mode-0500 directory and mode-0400 owner. macOS uses a mode-0700 directory and seals the owner with `UF_IMMUTABLE` before publication: older macOS filesystems [reject renaming a nonwritable directory](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/rename.2.html), including same-parent renames. Release first renames the complete directory away from the canonical lock name, then clears protection only on that tombstone for cleanup. The owner record carries a bounded diagnostic command, not arbitrary CLI arguments. Missing lock observations attempt exclusive publication; they do not combine an earlier missing snapshot with a later existence check and misclassify normal contention as unverifiable.

The predecessor admission guard requires an ordinary user account: UID 0 bypasses Linux's filesystem permission barrier and therefore cannot establish mixed-version exclusion. No predecessor process is signaled or automatically stopped. The record stays compatible with the old owner reader, while malformed and ownerless old locks remain terminal errors.

This supports the [single-product cutover](https://github.com/num-lab/Ruukoto/issues/58) bootstrap without adopting legacy ownerless directories. It supplements the lifetime/exit-code contract in [detached runtime](../architecture/2026-09-19-detach-terminal-from-task-runtime.md) and reuses the exclusive-installation mechanism of [managed workspaces](../feature/2026-11-07-managed-coding-workspaces.md).

## Alternatives considered

- Publish directly with `mkdir`, then write the owner: inexpensive, but its intermediate state cannot distinguish a live initializer from debris.
- Use ordinary directory rename: often atomic but may replace an existing empty directory and does not establish exclusive ownership.
- Serialize takeover with another owner-file lock: introduces the same publication and stale-takeover problem recursively. The persistent parent inode's OS lock releases on helper exit.
- Make a published directory writable while renaming it, or protect it only after publication: permits older macOS to rename, but opens an owner-deletion window for a predecessor that does not join the flock. macOS owner immutability keeps that exclusion throughout publication and retirement.

## Consequences

Lock acquisition needs Python and the supported OS rename/flock primitives before persistent application state is opened; macOS also requires user-settable file immutability. Failure to establish protection rejects publication. Failed private staging is unsealed only while its original inode remains at the staging name; published owners remain protected. A killed staging writer can leave an unreferenced private directory; it never qualifies as a lock and is not adopted. Unverifiable legacy locks require owner inspection. Process identity errors reject rather than guessing. The public lock shape remains a directory with `owner.json`, allowing transient exclusion against recognized predecessor profiles.
