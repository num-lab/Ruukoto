# Agent Note: Put background-process management in a right-hand tab

Status: implemented

## Problem

Background-process management was available only through two session-menu actions opening a modal: process/log management and ending all background processes in the session. The owner requested removal of both actions and the modal in favor of the right sidebar.

## Decision

Add a Code-only `background` inspector-tab type, one per parent session with the fixed id `background`, opened from the new-tab page. Retain `DesktopBackgroundProcesses` unchanged: list paging, byte-based stdout/stderr pages, base64, stopping one process, ending the whole session with the original request key, and recovery of unknown outcomes. `background-process-panel.tsx` becomes an inspector panel rendering the same state instead of a Dialog.

Optional `DesktopInspector` hooks (`sessionId`, `open`, `close`) receive CodeState's existing background instance. Selecting the tab calls `open(parentSession)` with a fresh load, matching the old modal's behavior. Closing the tab clears state. Changing parent clears it only if it still belongs to the old session; returning reopens through the active tab. `closeParent` clears state belonging to that session. Existing `close()` handling covers snapshot `instanceChanged` cleanup.

Removing the two menu actions leaves archive alone. App no longer mounts the modal. `.background-*` styles fix log text, action buttons, and stream selectors to the 14px/12px chrome scale.

## Alternatives considered

Per-parent state would require converting the class to a session-keyed Map and migrating pending filters, generations, and output cursors merely to preserve reading position. The old modal reset on every open, so keep one instance. Triggering the old modal from the sidebar preserves duplicate containers and contradicts its requested removal. Putting management inside Files or Terminal confuses session-owned processes with workspace-owned tabs.

## Consequences

The session menu is shorter and process management shares Files/Git's docked location. Existing `addTab` behavior expands the sidebar on open. Its narrower width makes long commands and logs wrap or scroll sooner, and changing sessions does not preserve reading position. Existing state behavior refreshes a retained background tab during snapshots even while inactive, as it did while the old modal was open.
