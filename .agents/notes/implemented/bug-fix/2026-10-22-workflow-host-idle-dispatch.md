# Agent Note: Dispatch workflow host calls after idle stops script timing

Status: implemented

## Problem

A CI rerun paused a six-input workflow with `script_cpu_limit` after ordinary edits completed. The parent scheduled an invoke microtask immediately upon `call`; when `call` and `idle` arrived in separate frames, synchronous host work ran first. A fast reply then incremented `seq`, invalidating the old idle frame. Trusted host time entered the script's accumulated wall-clock budget, violating [script isolation](../architecture/2026-10-13-workflow-script-isolation.md).

## Decision

`call` registers its ID, pending count and queue entry only. On the latest `idle`, first accumulate script time, stop timing and publish inactivity, then dispatch that batch's invokes concurrently. Replies resume timing and increment `seq` as before. Cancellation, host rejection, limits and stop verification retain their paths. Calls emitted before activity resumes are protocol corruption and fail.

Computation after emitting `call` still consumes the script budget. Queued calls cannot cause host effects before idle; cancellation before dispatch prevents callbacks from running. Neither budget increases nor interpreter-interrupt-only enforcement replace this ordering. [Joint acceptance](../testing/2026-10-13-workflow-joint-acceptance.md) retains real-step, budget and cleanup requirements.

## Alternatives considered

- A larger budget or serial tests lowers reproduction frequency but leaves production host work charged to script time.
- Stopping timing at `call` is shortest, but lets the script compute indefinitely afterward and removes the parent's budget basis for reclaiming long built-ins.
- Delaying invoke by one event-loop turn often lets idle arrive first, but framing and scheduling give no guarantee. Use the explicit idle frame.

## Consequences

Host work starts no earlier than the script yielding in that round. A malicious non-yielding script cannot dispatch queued effects; the existing pending-call limit bounds queue size. A real-worker split-frame regression uses a 500 ms script budget with three 600 ms synchronous host blocks: the old version exceeds the limit, the fix returns the complete result. Infinite computation after call and cancellation at idle both dispatch zero effects. Historical execution/platform records are in the offline CI prerequisites work item.
