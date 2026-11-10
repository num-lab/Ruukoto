# Scheduling Time Utilities

## Responsibilities and Boundaries

`packages/channels/src/scheduler/time.ts` retains the shared time calculations consumed by [scheduling](scheduler.md). The package name does not imply an active IM channel: QQ, Telegram, GitHub event entry and notification-outbox business are retired.

## Public Interfaces

The runtime scheduler consumes one-shot, daily and weekly calculations with an explicit IANA timezone. [Runtime](runtime.md) owns admission and run lifetime; [core](core.md) owns persisted plans and runs.

## Data and State

Time calculations do not own a transport, authenticated owner entry, send operation or runtime profile. Persisted schedule/version/due-time identity belongs to the caller.

## Main Flows

A schedule coordinator calculates the applicable due time, checks its persisted run identity and admits one independent run. Missed times coalesce under scheduler policy rather than replaying each missed occurrence.

## Invariants and Failure Handling

Timezone and daylight-saving behavior remain part of scheduling correctness. Removing retired transport code must not change retained time semantics or create an IM dependency in scheduled software work.

## Design Rationale

- [Scheduled work](../../.agents/notes/implemented/feature/2026-10-25-code-scheduled.md): retained coordinator and run semantics.
- [Single product](../../.agents/notes/implemented/architecture/2026-11-10-single-product.md): remove PA-only channels, retain shared consumers.
