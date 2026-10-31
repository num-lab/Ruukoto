# Agent Note: Demo commit badges and inline details

Status: implemented

## Problem

The owner placed branch/tag labels before subjects, with graph-colored icon areas, neutral names and no outside border, then requested inline details instead of summary time/short hash. The [original graph](2026-10-17-demo-git-graph.md)'s fixed-height list could not scale one SVG after rows expanded.

## Decision

Use shadcn Badge before the subject. Its icon-area background shares node/lane color with a contrasting icon; names and optional remote suffix stay neutral with a short internal separator and no outer border. Explicit fixture fields determine branch/tag/remote rather than name heuristics. Keys include type/remote/name to distinguish matching local/remote names. Screen-reader text supplies icon type and full names. The original branch color mixed foreground for dark contrast, later superseded by the typography decision below.

Summaries contain only refs/subject. Inline detail contains available time, short hash, author and parents. Independent Radix Collapsibles retain keyboard/expanded state and reduced-motion behavior; parent relationships remain accessible when closed.

Each row owns an SVG without viewBox. The approved compact summary is 28 px rather than 56 px, with a node at its 14 px midpoint and curve controls derived from row height. No right chevron is needed; button semantics, keyboard access and expanded state remain. Refs stay on one line with visual ellipsis but full accessible names, preventing two 18 px labels from increasing height. Source edges curve into parent lanes within the summary, then extend vertically to the actual row bottom; intermediate rows connect top-to-bottom and the parent row ends at its node. Expansion changes only vertical lengths, preserving node/summary alignment. DAG ordering/lane assignment stay unchanged without DOM measurement, observers or dependencies.

This supersedes the earlier no-details scope, not repository eligibility, fixture-only history, tab identity or lack of real Git wiring. Historical engineering/browser evidence remains in the offline commit-details work item.

## Alternatives considered

- Measuring every row and redrawing a single SVG centralizes drawing, but adds observers, frame-by-frame animation synchronization and measurement ordering. Row SVGs follow browser layout naturally.
- Detail below the list preserves fixed graph geometry but separates content from the clicked row.
- Keeping pale backgrounds/dark branch text is smaller but loses dark-theme contrast; update nodes, lines and badges together.
- Bare ref names reduce fixture changes but cannot reliably separate slash-containing branch names, remote prefixes and tags. Explicit fields change fixtures, not a real Git protocol.

## Consequences

Graph, badges and subjects align; multiple open details retain continuous parent edges and node positions. Each row repeats crossing edges, acceptable for bounded fixtures but not proof of large-history performance. This demo change neither reads repositories nor changes production Desktop.

[Colored lanes and typography](2026-10-17-desktop-chrome-typography.md) supersedes mixed semantic colors/non-message font sizes while retaining badge icon colors and inline details. [Graph row windowing](2026-10-18-desktop-git-graph-windowing.md) owns production history virtualization; details, row heights and animation remain applicable.
