# Agent Note: Reduce CI latency through isolated shards and shared preparation

Status: implemented

## Problem

The owner's November 7 timing report identifies long MCP discovery waits and repeated real setup in corruption matrices. The successful [CI baseline](https://github.com/num-lab/Ruukoto/actions/runs/42325386963) spends 40m16s checking macOS and 31m48s checking Linux. The report's proposed reductions group cases with similar titles, but missing verification evidence, unknown effects, permission changes and cold recovery exercise different guards. Removing these cases would lose regression coverage.

## Decision

Application tests use four isolated Actions runners per OS, retaining Node 24.15.0, the ninety-minute job deadline and ordinary file concurrency two. Sorted ordinary file names are assigned round-robin; the five macOS exclusive files remain together, serially before ordinary tests on shard 1. Validate complete discovery before selection, and reject invalid or empty shards. Every runner performs setup and build; shard 1 performs static and foundation checks once per OS. Every matrix job must succeed. Local unsharded commands retain the full suite, offline switches and exit semantics. Concurrent shards require isolated hosts because shared-UID fixtures cannot be exclusive across processes on one host.

This reopens the scheduling choice deferred by [Node 24 and CI budget](2026-10-24-node24-ci-budget.md): separate machines reduce wall time without raising contention within a runner. It partially supersedes scheduling in [CI prerequisites](2026-10-22-ci-prerequisites.md), [workflow joint acceptance](2026-10-13-workflow-joint-acceptance.md) and [suite reduction](2026-10-24-test-suite-reduction.md). Their native prerequisites, failure propagation, useful-coverage and exclusivity decisions remain.

The missing-required-MCP fixture uses existing one-second connect and list budgets. An empty visible catalog otherwise waits for both fifteen-second budgets on every preflight. Preserve all missing-tool, closed-service and zero-registration/model/tool-call assertions; production budgets remain unchanged.

Personal tool corruption prepares one real amended, redisplayed and approved-write history, then restores its clean closed SQLite baseline at the original path before each of twelve independent mutations and actual rejected reopens. Completed-workflow recovery similarly shares one real change/verification chain while preserving four actual Runtime restarts, pause reasons, rejected resumes, unchanged tasks/attempts/executions and source/copy bytes. Each case asserts no additional model calls. Only the database is restored after its owner closes; directory paths/inodes, Git copies, artifacts and execution identities remain in place. This extends the existing closed-baseline method in the suite-reduction decision.

Desktop SSR fixtures disable unused client dependency optimization through a shared post-config hook. React's plugin adds explicit optimization inputs, so the hook clears them after plugin configuration and disables discovery. SSR transforms and module loading remain real. The default cache lives under the protected source tree; concurrent optimizer directory changes correctly reject restricted work-copy startup during its identity scan. Removing these unnecessary test writes preserves the runtime protection checks. Service-helper stop tests wait for dispatch rather than claim creation; report tests wait for the matching projected publication state because timeline entries and state frames travel independently.

The HTTP amendment fixture holds the connection through amendment and confirms that effect resolution is rejected while the operation is still `started`. After disconnecting, it awaits the persisted observation before resolving the unknown effect and independently verifying remote stop. Request arrival alone proves neither local completion nor an observation; a fixed delay would leave the same race under load. This follows [observable async phases](2026-10-11-await-observed-async-phases.md) and preserves the production resolution guard.

Service inspection cancellation waits for the helper to finish its claim before aborting; the call log precedes that write, and interrupting it cannot provide the complete identity needed for later stop verification. Telegram shutdown checks new client poll dispatches. A controlled server gate lets an already-sent poll appear in the server log after shutdown, retaining that counterexample while requiring no new dispatch and a released profile lock.

History-search source checks consume cursor pages until completion and accumulate every page's hits and source issues. A controlled clock crosses the normal page budget to exercise continuation deterministically, while exact result order, missing/corrupt/pending source classifications and legacy cursor semantics remain asserted. Completion is a protocol fact, not a promise that one request finishes within a CI runner's scheduling window.

## Alternatives considered

- Delete the report's suggested parameter variants: fewer executions, but the variants cover distinct provenance, snapshot, permission and effect states. Retain them and share only stable preparation. The four-input Coding acceptance also uniquely proves capacity, queue replacement and partial final delivery; the single-step workflow suite cannot replace it.
- Increase concurrency on one runner: avoids additional setup, but existing worker deadlines and same-UID fixtures already motivated the two-file cap. Independent runners preserve that contention boundary.
- Balance shards with a maintained timing manifest or distribute built artifacts: potentially improves utilization, but adds stale metadata and cross-platform transfer logic. Round-robin files and the existing cheap build are sufficient initially; revisit if measured shard skew dominates.
- Move Vite caches to private temporary directories: isolates concurrent source scans, but optimizer writes can outlive server close and recreate a removed directory. These fixtures only load SSR modules, so disable unused client optimization instead of adding cleanup retries. A top-level discovery setting alone is insufficient because React merges its explicit inputs back in.

## Consequences

Four runners per OS add installation overhead and runner demand. Queue delay can dominate: the same-SHA PR baseline queued macOS for about forty-seven minutes. This change preserves push and PR triggers, so duplicate-event cost remains. Aggregate compute time may increase even as execution latency decreases; report both queue and job time.

Focused local checks measure fixture savings and verify allocation/failure behavior; they do not establish hosted shard wall time or Linux acceptance. [Issue 51](https://github.com/num-lab/Ruukoto/issues/51) records reviewed scope, measured evidence and remaining publication/matrix verification. Keep the exact-candidate remote result separate from historical timing and local passes.
