# Agent Note: Directory-list protection scans only directories

Status: implemented

[Owner workspace browsing](../feature/2026-10-24-owner-workspace-browsing.md) supersedes this desktop protection check; its dedicated directory-check helper has been removed. This record retains the physical-alias, classification-race and negative-cache tradeoffs relevant to Agent protection.

## Problem

The file tree lists at most 200 entries per level, but generic protection checks before and after reading recursively scanned every protected object for both workspace root and target. Cost therefore grew with protected data and service-source files. Isolated measurements took about 1.4 seconds even for an empty target, blocking the backend event loop. Frontend lazy loading, caching and request deduplication already existed.

## Decision

The original directory-list optimization batched root and target ancestor identities within each phase and scanned each protected directory once. Dirent classification skipped ordinary files and symlinks, after verifying both targets were directories. BigIntStats comparisons of `dev`, `ino`, `mode`, `mtimeNs` and `ctimeNs` before/after each protected-directory enumeration rejected replacement and revision changes, including a file replaced by a directory after classification. `dev`/`ino` matching covered mount aliases of protected descendants. Reverse containment also rejected workspaces covering any protected root, including file roots.

Pre-read and post-read scans were independent; negative results were never reused across phases. Errors failed closed. Generic file protection and previews retained per-object checks. This optimized comparable object types, not the protection rules in [native execution](../architecture/2026-10-10-native-execution-sandbox.md), the read-only identity guarantees in [the desktop design](../architecture/2026-10-16-desktop-current-demo.md), or [MyGo control wiring](../architecture/2026-10-17-desktop-mygo-experiment.md).

## Alternatives considered

- Merely batching four scans into two is smaller but still reads metadata for every file and retains second-scale cost on large trees.
- Removing all protection-tree traversal misses bind/hard-link aliases of protected descendants and violates file protection.
- Watcher or TTL caches cannot prove freshness after lost events, external changes or child mounts; root mtime is insufficient, and stale negative results weaken protection.
- Threads, prefetch or a different tree widget may improve responsiveness, but do not remove the confirmed synchronous work.

## Verification

Historical regressions checked unchanged list results, one scan per protected directory per phase, no per-file lstat growth, independent post-checks, fail-closed behavior, physical directory aliases and generic hard-link/preview protection. A 5,000-file tree improved from 34.260 ms to 4.682 ms median; the protected code tree from about 1.58 s to 0.41 s. Isolated MyGo first content was about 0.52 s and cached reopening 34-46 ms. Seven real Linux bind cases and generic protection regressions passed. Raw records remain in the offline `desktop-file-tree` acceptance material.

## Consequences

Traversal still grows with directory and entry count; it is not constant-time. Dirent classification and physical aliases require real macOS/Linux checks. Changes during reading must be rejected by an independent post-scan. Any future thread-based optimization should follow complete-path measurement, not replace these freshness guarantees.
