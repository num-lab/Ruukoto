# Agent Note: Verify service effects and original write execution separately

Status: implemented

## Problem

[Service operations](2026-10-17-personal-service-operations.md) retained unknown effects and original launcher identity, but only trusted APIs could confirm effects or recheck stop. Owners lacked CLI/Telegram recovery controls. Adding child writes first would create more unknown-effect sources while still requiring manual internal APIs. [Inspection stop controls](2026-10-17-personal-inspection-stop-controls.md) prove read-only inspection exit, not service-write exit.

## Decision

Authenticated local menus and Telegram's `/服务核实` provide original-operation query, one-time effect verification, and write-stop recheck. Trusted host callers still initiate service writes; no model tool, service operation, or authority source is added. Owner evidence records took-effect/did-not-take-effect with at most 8192 characters, without overwriting the original unknown result or restoring stale standing authority. Saved evidence pages use 1200 characters; the program owns internal references.

Telegram manages only original bot/owner/generation and accepts choices/effect confirmation from delivered host menus. Direct replies to the confirmation menu submit evidence. Decision, original-operation reference, and input share a transaction. Recovery verifies bidirectional menu/effect/original-text/operation links. Redelivery reuses input; saved verification cannot be overwritten. Local trusted controls may verify old-generation operations and query original facts after a lost reply.

A stop request and input transaction registers an independent background Task. Acceptance and execution both require the original service operation to be consumed and effect_unknown, not still started/executing, and no unresolved preapproval inspection. Task pins original requestId/TaskId, hostOpId, and machine and rechecks entry before execution. External calls use only stop-op; result commit validates original execution identity. Existing launcher/command-unit protocol proves exit, not owner testimony or Task termination. Recovery rechecks only that identity; failure does not loop. Refresh exposes latest Task state/error code.

Main durably registers a separate controls extension, causing older programs to reject recovery. New code validates stop Task version, operation, execution identity, and optional input backlinks before scheduling. Query/control use no main-model occupancy. Existing service work/report waits complete only after both effect and stop are verified.

This supplements service operations, Telegram authority, and inspection ownership without changing helper, MCP, command, or notification protocols. [Child service operations](2026-10-17-personal-subagent-service-operations.md) later adds controlled restart under WorkTask authority/cancellation/unknown-effect rules; other boundaries remain.

## Alternatives considered

Opening child writes first advances capability but adds provenance, per-call authority, whole-request cancellation, and reporting before a usable recovery path. Waiting for recheckStop inside HTTP/Telegram acceptance is shorter but exceeds local request limits and blocks incoming transactions. Reusing inspection-stop proof confuses read-only process groups with write launchers/command units; share interaction patterns, not identities or evidence.

## Consequences

Owners can recover paused work through product entry points but must independently verify real service effects; the system cannot supply that testimony. New control Tasks and input backlinks cost maintenance, and conservative stop proof may remain unavailable indefinitely. There is no forced release, withdrawal of committed systemd jobs, or replayed restart. Historical overall/implementation evidence is in the offline copies of `.scratch/personal-pi-durable/issues/01-migration-plan.md` and `20-service-recovery-controls.md`; real systemd/platform and full migration retain separate acceptance.
