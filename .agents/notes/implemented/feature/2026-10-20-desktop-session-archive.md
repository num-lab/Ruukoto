# Agent Note: Session archiving changes list visibility only

Status: implemented

[Desktop Spotlight](2026-10-21-desktop-spotlight-search.md) may explicitly open archived results while retaining their archive marker and execution facts.

## Problem

Old ordinary sessions clutter the workspace tree. Owners need reversible hiding and a place to restore sessions, not another deleted/invalid execution state across tasks, queues, SubAgents and scheduled sessions.

## Decision

`Session.archivedAt` (`null` means unarchived), stored in `sessions.archived_at`, is the sole archive fact. It commits with `session.archive_changed`; this feature introduced schema 46 and control protocol 33.

Archiving changes no projectId, cwd, history file, task ownership, queue or model setting. The workspace tree hides nonnull archivedAt; history/tasks/approvals/notifications/files continue by session ID. A hover/focus Archive button archives a workspace session and closes its tab. Settings list archived sessions newest-first with name, workspace, date and unarchive action.

Only `dev`/`main` sessions qualify. Runtime rejects SubAgent, scheduled and workflow-step sessions because those host-owned executions would lose their visible entry. Repeating the same value writes no event. `withTx` commits state/event atomically. No idle requirement applies: running tasks continue. Branches inherit archivedAt so copying does not unexpectedly resurface the session.

## Alternatives considered

- Deleting/moving history breaks authoritative JSONL and committed-session preservation, and is irreversible.
- Queue pause blocks future execution, not merely visibility.
- Meta JSON avoids a schema change but duplicates per-session row facts, requires whole-object writes and separates snapshots. The owner accepted the schema break instead.
- Event-only protocol state cannot restore visibility on reconnect; include the field in Session snapshots.

## Consequences

Lists stay short and unarchiving is reversible without execution/history changes. The original schema transition requires a compatible/new archive under existing strict-version rules rather than claiming migration. All Session literal fixtures gain a nullable field. Archive state is Boolean in meaning; its timestamp only sorts/displays and never affects authorization/consistency. Importing sessions preserves their visibility.
