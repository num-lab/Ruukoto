# Agent Note: Equal-width Demo tabs and within-group reordering

Status: implemented

## Problem

Both header tab groups sized themselves by title and ordered themselves by opening time. The owner requested uniform width and dragging.

## Decision

Initially both groups use 180 px widths, ellipsized titles, existing horizontal scrolling, overlaid close buttons and short separators. Titles fill available width so close-button fades remain at the right edge. [Responsive equal widths](2026-10-17-demo-responsive-tab-width.md) supersedes the fixed 180 px rule, not the sorting/identity rules here.

Native HTML drag/drop sorts within the originating group only. Verify source against page state and, for inspector tabs, the current session. Accept no external payload and no move across groups/targets. Keep the array/DOM order while dragging; calculate target from original layout/pointer position and translate neighbors as a preview. Keep the source until preview entry hides it, after native drag-image capture. The list accepts drops over vacancies, gaps and close buttons. Leaving the visible group/canceling restores preview; only drop commits, preventing moved hit targets from causing oscillation. Reduced motion moves immediately.

Sorting never changes session/inspector object identity. Pin the default active inspector explicitly instead of deriving it from the last array item. Sorting triggers existing selected-tab reveal. Alt+Shift+Left/Right performs the same reorder, restores focus and announces position; ordinary Radix arrow selection stays intact.

[Header layout](2026-10-16-demo-header-model-menu.md) retains close/separator/model-menu rules; [PA main session](2026-10-17-demo-personal-main-tab.md) stays fixed with independent inspector state. [Inspector tools](2026-10-16-demo-inspector-tools.md) are not recreated by reordering. Only mutable-demo source changes, not frozen/production code.

## Alternatives considered

- A drag/drop library offers richer animation/layout, but no installed sortable dependency exists and native events/CSS meet this scope.
- Reordering on every dragover directly renders the target, but requires cancel rollback and creates unstable hit locations. Preview transforms until drop.
- Content widths fit short titles but contradict uniform sizing; preserve scrolling and usable close controls.
- Cross-region/window dragging reorganizes pages but changes session ownership and PA capabilities, outside scope.

## Consequences

Pointer and keyboard ordering retain selection identity, drafts and pages. Closing follows new order; cancel/cross-group drag leaves order unchanged. Themes and overflow work. Historical base reordering and live displacement evidence remain in offline demo work items 14/15. Native browser drag images remain; there are no touch-specific gestures or cross-window layout. Order is page-memory-only and resets on refresh. Desktop migration requires separate acceptance.
