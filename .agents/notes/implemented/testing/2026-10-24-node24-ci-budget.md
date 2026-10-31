# Agent Note: Standardize on Node 24 and allow complete CI feedback

Status: implemented

## Problem

The test-reduction candidate still exceeded forty-five minutes on GitHub macOS/Node 24 and both Node 22 jobs; Linux/Node 24 succeeded. The owner requested a larger CI budget and retirement of Node 22 compatibility.

## Decision

CI has two jobs, macOS and Linux, fixed at Node 24.15.0 with a ninety-minute timeout. Repository packages require `>=24.15`. Setup, desktop environment, deployment examples and build targets agree; Node 22 SQLite parameter-binding compatibility is removed. Internal execution budgets, file concurrency, exclusive batches and failure/skip semantics remain unchanged. A timeout increase is not a performance improvement and does not turn cancellation into success.

This supersedes matrix/job limits in [test reduction](2026-10-24-test-suite-reduction.md) and [CI prerequisites](2026-10-22-ci-prerequisites.md), retaining their necessity reviews, platform prerequisites, concurrency and failure propagation. [Workflow joint acceptance](2026-10-13-workflow-joint-acceptance.md) follows the supported versions; old four-cell runs remain historical evidence, as do Node 22 fault investigations and isolation experiments.

## Alternatives considered

- Keeping Node 22 serves older machines, but the owner chose a smaller support surface rather than maintaining its builds and compatibility code.
- Sixty minutes terminates runaway jobs sooner, but only forty-five-minute truncated macOS samples existed. Ninety minutes allows fuller feedback while retaining a hard limit.
- Sharding or higher concurrency may reduce wall time but changes contention and scope. Preserve scheduling in this change.

## Verification

Node 22 and versions below 24.15 are rejected; the 24.15 minimum is accepted. Maintained manifests/locks, targets and current documentation agree. Both SQLite queries retain their real ledger behavior on Node 24. Remote CI passes only when both platforms actually reach foundation tests and exit successfully; missing results remain pending acceptance.

## Consequences

Older Node environments must upgrade. Longer jobs increase waiting and compute cost on failure and cannot cure every blockage/failure. Historical change/evidence records remain in the offline CI Node 24 budget work item.
