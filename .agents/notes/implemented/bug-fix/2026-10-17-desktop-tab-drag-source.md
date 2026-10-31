# Agent Note: Drag-source tab visibility

Status: implemented

## Problem

Leaving the tab list cleared the target slot and revealed the source tab too early. Its return animation overlapped neighboring tabs moving out of the way.

## Decision

After first entering a drop preview, the source stays hidden until drop, dragend, or a reset of its group. Leaving the list only removes the target displacement. Demo and Desktop share this behavior; native drag and drop still owns the drag image.

This extends the lifecycle rules in the [Desktop migration](../architecture/2026-10-17-desktop-demo-v4.md), without changing its other decisions. The original requirement and evidence were recorded in `.scratch/desktop-shadcn/issues/20-desktop-interaction-fixes.md`, retained in the offline archive.

## Alternatives considered

Revealing the source immediately on leaving the list is simpler, but its return crosses neighboring tabs. Replacing native drag and drop with pointer handling would give full control of the drag image, but the lifecycle fix resolves the reproduced overlap without that larger change.

## Consequences

Real hook-event replay covers leaving, reentry, cancellation, drop, and group reset. It proves the DOM source lifecycle, not the appearance of the native drag image.

Residual hover at the old position after a drag is handled separately by [hover eligibility](2026-10-17-desktop-tab-hover.md); this visibility lifecycle remains in force.
