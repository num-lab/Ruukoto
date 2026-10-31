# Agent Note: Window Git graph rows and incrementally lay out history

Status: implemented

## Problem

Desktop rendered every loaded commit into DOM, with an absolute SVG per row repeating all crossing parent edges. Unbounded cumulative pagination made element count proportional to commits times active lanes; tens of thousands of commits could consume gigabytes. Blink/WebKit amplified the same renderer differently. [Pagination](2026-10-17-desktop-git-history-pages.md) and [automatic loading](2026-10-17-desktop-git-lazy-loading.md) bounded reads, not rendering.

## Decision

Render only visible rows plus six overscan rows on each side and at most one off-window focused row. Keep window rows in normal flow, with `aria-hidden` spacer `<li>` elements before/after and the IntersectionObserver sentinel as a trailing flow `<li>`. This preserves `ol` `min-width: max-content` and sentinel width. A zero-height flow ruler stores the largest measured natural row width since opening, preventing horizontal range, `scrollLeft` or sentinel width from collapsing over short-row windows. Disable browser scroll anchoring with `overflow-anchor: none`.

`git-graph-model.ts` incrementally maintains `laneAt`, `parentLanes`, `rowById` and lane checkpoints every 128 rows. Window layout clones the nearest preceding checkpoint and advances instead of materializing `edgesByRow`. `rowById.has(parentId)` identifies loaded continuations. Append only if length has not decreased and first/last processed IDs still match; otherwise rebuild. HEAD changes do not affect layout. Equal-length changes preserving endpoints are not detected: Inspector revision cursors and first-page replacement on refresh guarantee immutable middle content. As before, clock-skewed upward parent edges (`to < from`) are not drawn.

Generate each absolute `height: 100%` row SVG only within the window, retaining 28 px summary height, nodeY, bends and expansion stretch. Panel-level expansion is keyed by commit ID. Measure rendered CollapsibleContent `scrollHeight` and cache by ID for off-window spacers, total height and clamping. Width changes retain old heights until rows/window rerender; reattach size observation when the container first mounts after an empty repository. Refresh removes vanished IDs. A changed `top(first)` compensates scrollTop when heights above an unchanged window start change.

Track focus through row-button focus events. An off-window focused row renders absolutely at its actual offset, ordered before/after window rows by index. If replacing DOM moves focus to `document.body`, restore it to that retained row. Each row has `aria-setsize`/`aria-posinset`; screen-reader parent text distinguishes loaded and earlier commits.

## Alternatives considered

- One SVG/merged paths plus `content-visibility` reduces edges to O(edges), but retains every row node and its memory, not the gigabyte peak.
- Capping accumulated rows or evicting scrollback is smallest but breaks the approved ability to inspect all reachable history.
- A virtual-list dependency adds integration work for Radix heights/focus/CSS; flow rows and spacers suffice.
- Absolutely positioning all window rows collapses max-content/sentinel width to the viewport and breaks observer loading after horizontal scroll, requiring more width machinery.
- Replacing IntersectionObserver with scroll-position checks changes the accepted trigger/regressions and still needs stable content width.

## Consequences

Row DOM, row-edge elements and navigable rows depend on viewport/focus, not loaded-history length. Appending processes only new rows. Layout memory becomes O(commits + ceil(commits/128) * max lanes) rather than O(commits * lanes).

Tab, screen readers, selection, Ctrl+A and browser Find cover only rendered rows, including the retained focused row; the owner accepted this on 2026-10-18. Width is the largest seen this opening and resets when refresh changes the first commit. Off-window expanded heights stay stale until revisited; natural content height drives spacers during animation, and remounting may replay CSS animation. Scroll compensation only applies when the window start is unchanged, not a simultaneous large scroll. Undrawn upward edges can occupy an extra lane. Real WKWebView scrolling, animation and input-method behavior still need experience acceptance.

## Verification

`test/desktop-git-layout.test.ts` covers 70,000-row checkpoint windows, row/parent/crossing-edge equivalence to Demo `layoutGitGraph`, incremental/full equivalence, endpoint predicates, loaded continuations and multi-lane fixtures. `test/desktop-git-windowing.test.ts` covers metrics, ranges, clamping, focused-row retention, SSR bounds and accessibility. `test/desktop-git-lazy.test.ts` checks flow rows/ruler/sentinel. The historical Chromium `git-windowing` verification script covers horizontal-scroll loading, expansion/focus, width remeasurement, commits after empty state, shortened refresh/clamping and empty repositories; retained script location follows the verification-material migration.
