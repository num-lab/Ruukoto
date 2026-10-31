# Agent Note: Revoke stale hover after dragging

Status: implemented

## Problem

After native drag and drop ends, the browser can leave the tab at the old position matching `:hover`. Drag state is already cleared, yet its background, close icon, and text fade remain. [Drag-source visibility](2026-10-17-desktop-tab-drag-source.md) fixes return overlap, not this stale state.

## Decision

Each tab group owns hover eligibility. Drag start, drop, dragend, keyboard reordering, and group or membership changes suspend it. Only pointer movement in that group after dragging restores it. While suspended, ignore the old hover background, hide the close icon and disable its pointer hit area, and remove the text mask. `focus-visible` still reveals and enables the close button with enough text clearance. Selected tabs retain their selected background.

Demo and Desktop retain native drag images, equal-width displacement, stable object identities, and the shared Tab primitive. This supplements the [migration](../architecture/2026-10-17-desktop-demo-v4.md) and source-visibility note; their group, keyboard, width, and drag-source rules remain.

## Alternatives considered

Clearing the drag flag is shortest, but the reproduced DOM already had a cleared flag and a true `:hover`. Blurring moves keyboard focus without clearing hover caching. Pointer-based drag handling could own hit state completely, but replacing native drag and drop is unnecessary; isolate the untrustworthy post-drag hover instead.

## Consequences

The original Demo red/green record covers the old-position background, close-button hit area, and text fade; keyboard Tab still reveals the close button. Hook regressions independently cover cancellation, group changes, and restoration. Native MyGo drag-image and hover behavior still needs its actual pointer environment. Historical evidence is in the offline copy of `.scratch/desktop-shadcn/issues/21-polish-history.md`.
