# Agent Note: Demo Git graph and repository eligibility

Status: implemented

## Problem

The owner requested an inspector Git graph visible only for Git repositories. Demo tabs were already session-isolated, but workspaces/files/history were fixtures with no real repository discovery.

## Decision

Repository metadata determines entry visibility and eligibility. An empty repository still qualifies; ordinary directories, new workspaces and PA do not. Each workspace supplies an independent static DAG explicitly labeled read-only fixture. Inspector tabs deduplicate and persist per session.

SVG draws parent edges. A pure function processes newest-to-oldest topological order, retains lanes for parents, allocates free lanes on forks, and merges back into existing lanes. Parents outside the loaded window extend to the bottom. Original rows showed subject, refs, HEAD, author, date and short hash, with screen-reader descriptions of parents, roots and outside-window relationships. No Git writes or new dependency are added.

Reuse [inspector tab identity](2026-10-16-demo-inspector-tools.md), [responsive widths](2026-10-17-demo-responsive-tab-width.md) and [reorder preview](2026-10-17-demo-tab-reorder.md). Later [badges/inline details](2026-10-17-demo-git-commit-details.md) supersedes fixed-height/no-detail presentation. [Colored lanes/typography](2026-10-17-desktop-chrome-typography.md) replaces original neutral semantic colors. Production cumulative history belongs to [Git pagination](2026-10-17-desktop-git-history-pages.md); the demo remains fixture-only.

## Alternatives considered

- A Git-graph library supports complex/large history but is unnecessary for bounded fixtures; SVG and small lane assignment suffice.
- Showing the entry everywhere then reporting non-repositories improves discovery but contradicts repository-only visibility.
- Hardcoded fixture lines are shorter but can diverge from parent relationships. Derive lines from the DAG.

## Consequences

Non-repositories and empty repositories are distinct. Tabs deduplicate without sharing session state; fork/merge/outside-window edges remain accurate, text is escaped, and themes/narrow widths stay readable. Historical evidence remains in the offline Git-graph demo work item. Real repository discovery/history require authenticated backend wiring and separate Desktop acceptance; fixtures are not that evidence.
