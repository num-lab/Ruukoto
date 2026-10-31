# Agent Note: Demo Context category details

Status: implemented

## Problem

The owner requested the reference layout: percentage and compact usage at the top, a segmented bar, and three categories below. The [ring-trigger decision](2026-10-16-demo-context-component.md) showed only a title, total and monochrome progress.

## Decision

Keep Hover Card/Progress and the numberless ring; replace only detail content. The heading shows `% of context used` and approximate usage/capacity. System prompt, Tool definitions and Messages use gray, purple and blue swatches and approximate totals, matching the progress segments. The portal stays viewport-bounded within the Neutral themes; add no action/dependency. The approved refinement uses 280 px width, 12 px padding/font/section gaps and 8 px category-row gaps. `align=start` with -16 px offset places the ring center about 30 px from the left, retaining native collision avoidance.

Keep mock totals at 32,000/200,000 and add 1,500 system plus 5,300 tool tokens. Derive Messages by subtraction instead of storing another total. Ordinary new sessions and the first session of a new workspace initialize every category to zero; submission checks do not alter usage. Categories are fixtures, not measured prompt/provider statistics.

Progress retains its full-width translated Indicator. Apply the gradient only to the visible tail, offsetting color stops by unused capacity so low usage does not show only the last category. A stateless detail renderer makes portal values, zero states and categories testable without modifying official primitives. Percentages appear only in the detail, never the gray ring trigger.

## Alternatives considered

- Copying the reference's 18.7K/1M numbers better matches the screenshot but changes existing session capacity unnecessarily.
- Another segmented-bar component or modified official Progress could use explicit widths, but adds a duplicate primitive. A local gradient preserves existing values and accessibility.

## Consequences

The mutable demo's detail, category fixture, two creation initializers and checks change; production Desktop, backend and frozen copies do not. Swatches and bar segments must agree. Zero usage still displays three zero rows with an empty bar. Historical engineering/browser evidence belongs to the offline AI Elements demo work item; the owner accepts the layout.
