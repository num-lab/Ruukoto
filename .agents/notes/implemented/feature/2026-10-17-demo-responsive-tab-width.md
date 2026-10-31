# Agent Note: Responsive equal-width Demo tabs

Status: implemented

## Problem

[Tab reordering](2026-10-17-demo-tab-reorder.md) fixed widths at 180 px, causing early horizontal overflow in narrow groups. The owner requested dynamic widths while retaining equal sizing and drag displacement.

## Decision

Each group divides its visible width by its own tab count, clamped to 96-180 px. Below the minimum required space, retain 96 px and scroll horizontally. CSS container units and a count variable express this without measurement state/observers. The original 180 px remains the maximum; 96 px preserves short titles, icons and overlaid close controls.

Drag previews/drop positions use the same actual width, retaining fractional bounding-rectangle widths rather than integer `offsetWidth` so accumulated rounding does not move drop targets. Selected-tab reveal, session identity, cancellation and closing retain their rules. Only the old fixed-width decision is superseded.

## Alternatives considered

- Fixed widths are stable but fail the requested adaptation and waste narrow-group space.
- ResizeObserver could calculate widths, but existing observation only reveals selection; CSS already expresses layout without another size state.
- Unlimited shrinking avoids scrolling but makes many tabs impossible to select/close. Keep a minimum.

## Consequences

Groups remain independently equal-width as size/count changes, with correct limits/overflow. Fractional-width dragging, ordering and cancellation agree, and the active tab stays visible. Historical engineering/browser evidence remains in the offline responsive-tab work item. Only the demo browser was verified; production Desktop must verify container units on its engine. Owners judge the width limits' appearance.
