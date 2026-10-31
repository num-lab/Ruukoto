# Agent Note: Pin the original inspection reference before force-stop tests

Status: implemented

## Problem

The child-inspection force-kill recovery test killed its helper, waited 30 ms, then took the first unverified-list entry to request verification. The canceling tool also verifies exit and can legitimately empty that list first. Reading `undefined.taskId` then prevented testing cancellation cleanup. [Fixed inspection ownership](../architecture/2026-10-17-personal-subagent-inspection.md) permits that ordering.

## Decision

After confirming the original work's stop is unverified, capture its inspection reference. After killing the helper, always recheck that reference. Rechecking an already exited original inspection is idempotent. Retain all assertions about pre-kill occupation, separate chat, original inspection invocation count and identity release after cancellation; do not change runtime behavior.

The child/durable inspection ownership and control notes retain product behavior; this note owns only test ordering. Shared-helper and other fault-injection decisions remain unaffected.

## Alternatives considered

- Reading the unverified list after killing mirrors the management menu, but that list describes current pending items and cannot guarantee the original item remains.
- Disabling automatic rechecks fixes the manual recheck's ordering, but removes the real cancellation-recovery path and its coverage.

## Consequences

Both baseline and candidate reproduced the original failure. Isolated diagnosis showed an empty list alongside the original inspection's `stopped` and `stopEvidence`. Pinning its reference removes the list race while cancellation still requires original exit evidence. This adds one local reference, no production logic. Historical commands/evidence remain in the offline Personal service-recovery work item.
