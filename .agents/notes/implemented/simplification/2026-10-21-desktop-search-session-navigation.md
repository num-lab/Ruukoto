# Agent Note: Search results open ordinary sessions directly

Status: implemented

## Problem

The owner requested removing search explanations, the history-view bar and read-only composer notice: results should jump directly to the session. A separate history mode added steps before conversation could continue.

## Decision

Both session-name and body results use existing openSession after closing search. Reuse session tabs, latest projection, live output, backward pagination, drafts, attachments and normal input. Do not enter a separate history window or promise scrolling to the matched message; result excerpts still identify the session. Cancel restores prior focus; selecting transfers focus to the session composer.

This supersedes [Spotlight](../feature/2026-10-21-desktop-spotlight-search.md)'s separate history window, match-position highlight and return-to-latest input guard. Search scope, archive marks, provenance, accessibility and performance remain. Delete renderer window controller/special display/submit guards and unused EventFlow window methods. Keep shared backend around/after read protocols and compatibility tests; UI simplification does not revoke shared protocol.

## Alternatives considered

- Hide only the history bar/notices: smaller but leaves separate projections/input restrictions, not direct ordinary-session use.
- Merge match-near pages into latest projection: preserves positioning but requires gap handling, 300-entry clipping, live events and stale latest-page replacement beyond the request.

## Consequences

One existing session-opening lifecycle replaces separate navigation/read-only state. Old text still helps find a session; opening displays its normal current range, with ordinary upward browsing available. Historical engineering evidence and native-experience gaps remain in the offline Spotlight work item.
