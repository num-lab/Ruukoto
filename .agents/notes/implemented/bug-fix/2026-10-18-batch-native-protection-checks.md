# Agent Note: Batch native dependency checks against protected trees

Status: implemented

[Read-check reuse](2026-10-24-read-check-overhead.md) extends this batching to explicit native mounts while retaining per-protected-root exceptions for runtime dependencies.

## Problem

Native startup synchronously traversed the same protected tree for each runtime dependency. Source roots contain dependencies and evidence; concurrent real workers multiplied scans, exceeded normal waits and blocked unrelated host events. Bind/hard-link aliases of protected descendants still require physical identity checks, not path strings or `nlink` shortcuts.

## Decision

Within one native startup, batch runtime dependencies separately for each protected root. Collect candidate and ancestor `dev`/`ino` identities, then traverse each protected tree once using the existing no-symlink-following and directory-inode-deduplication algorithm. Any identity match rejects access, as do textual or physical ancestors of the protected root. Read-only code-asset exceptions remain per protected root. Explicit mounts, file-alias permissions and hard-link closure checks retain their rules.

The batch retains fixed identities only within one synchronous call. Before returning, recheck candidates, ancestors and protected roots; on directory exit, recheck identity and entry revisions. Read failures or observed changes propagate before native-unit creation. Single-target callers reuse the physical-scan algorithm and existing errors. No successful authorization is cached across calls or startups.

This supplements the cost model of [native execution](../architecture/2026-10-10-native-execution-sandbox.md), not source protection in [workspace snapshots](../architecture/2026-10-15-current-workspace-snapshots.md). Those notes retain execution identity and source/copy ownership respectively.

## Alternatives considered

A full protected-tree inode index can serve many candidates but consumes memory proportional to entries and risks surviving asynchronous preparation. Use the smaller target-ancestor set and discard it after traversal. A global cache cannot reliably observe external paths, hard links or mount changes, so cannot authorize access. Longer waits or serial tests hide timeouts without fixing synchronous event-loop blockage; retain the existing wait and concurrency entry points.

## Consequences

Runtime-dependency scanning grows with protected-tree entries, no longer multiplied by candidate count. Single-target calls still scan each time; large trees remain costly. These checks are not an atomic filesystem snapshot. Privileged external native preparation retains its separately stated limits, and this fix does not explain historical stop-identity verification failures.
