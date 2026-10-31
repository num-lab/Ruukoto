# Agent Note: Return interrupted service-helper calls only after child close

Status: implemented

## Problem

[Service inspection](2026-10-17-personal-service-inspect.md) and [operations](2026-10-17-personal-service-operations.md) share callHelper. Timeout/cancel previously rejected immediately after SIGKILL, before the call process/stdio closed and tail output arrived. [Long-running child work](2026-10-17-personal-background-work.md) could then finish cancellation before the call actually ended.

## Decision

On interruption, preserve the first failure reason and stop the original process group, but settle the Promise only on child `close`. Continue bounded raw capture and return the failure code with final captured output. Spawn errors stay typed. Check already-aborted signal before spawn/listener setup and again after installing listeners, covering cancellation during spawn. If the process never closes, continue waiting; signal delivery is not exit evidence.

This proves only that the call process and stdio closed, not a systemd operation unit/all descendants. It does not solve recovery of detached helpers after backend SIGKILL. Service writes still stop-op by original operation identity and retain occupation for unknown effects. External child tools require their own durable execution identity/recovery before integration.

[Migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md), inspection/operation/background notes and [fixed helper](2026-10-03-service-management-helper.md) retain execution/stop ownership; this note only narrows transport completion timing.

## Alternatives considered

- Return immediately after signaling: responsive with existing timeout, but permits premature cleanup and incomplete output.
- Wait a fixed delay: bounded, but elapsed time is not exit proof.
- Enable child read-only tools simultaneously: advances features but lacks detached-helper crash recovery. Replayability does not waive occupation/stop evidence.

## Verification

Real child tests retain pending during controlled delayed-stop cancellation/timeout and return the original code/full bounded capture after close. Pre-spawn/during-spawn cancellation leaves no process; oversize/spawn failures do not hang. Historical macOS/Linux, old/new callers and isolated pre-fix negative controls remain in the offline helper-exit work item.

## Consequences

Callers cannot receive interruption before child close and retain final output. A child that cannot finish may wait indefinitely; no new operational escape is introduced. Call closure is not external stop proof; backend hard-kill/different-privilege descendants still need durable identity and controlled verification. This does not authorize delegated tools or production cutover.
