# Agent Note: Page through Git history to its end

Status: implemented

[Operation-specific checks](../bug-fix/2026-10-24-operation-specific-checks.md) removes whole-tree Git metadata scanning, supports normal links/shared object stores, includes HEAD link text in revision identity, and fixes output to UTF-8. [Owner browsing](2026-10-24-owner-workspace-browsing.md) removes protected-root restrictions. Paging and relevant revision/metadata checks remain.

## Problem

Desktop treated 200 commits as both a page size and a total-history limit. Removing max-count outright would exceed output/time budgets and amplify the per-row scan of every graph edge.

## Decision

`read_workspace_git` accepts a program-managed opaque cursor and returns nextCursor, null at the end. Pages contain 200 commits, with no cumulative commit/page limit. The original Desktop button appended pages while refresh replaced the first batch; [automatic scrolling](2026-10-17-desktop-git-lazy-loading.md) now owns the trigger. Each page retains a five-second budget, 512KiB per command, and 768KiB response. Original protected-root and 100000-entry tree-scan restrictions are superseded as noted above. The cursor contains only offset/revision digest, never client command, root, or revision argv. Protocol version 31 introduced this without a persistence change.

Revision binds workspace, root and Git/common-directory identity, raw/resolved HEAD, every ref and remote name, and shallow/info-grafts contents. Git log uses --all, so nonbranch/nontag refs can change traversal and must participate. --no-replace-objects does not disable grafts. A changed start/end digest, cursor revision mismatch, or repository disappearance during paging fails with `workspace_git_changed` and requires refresh, never splices a floating-offset page into the old prefix. All parameters validate before the read; metadata reads are bounded and preserve relevant identity checks.

Inspector appends only to the original cache object, instance generation, and cursor, deduplicating concurrent requests. Refresh/disconnect invalidates old append replies. Failure retains loaded content and permits retrying the same cursor. Layout covers accumulated commits with stable lane prefixes; useMemo avoids unrelated relayout, row-edge indexing replaces filtering all edges per row, and a loop computes maximum lanes. Demo displays complete static samples, not fake backend paging.

This replaces the 200-total limit in [Desktop migration](../architecture/2026-10-17-desktop-demo-v4.md). [Graph samples](2026-10-17-demo-git-graph.md) and [commit details](2026-10-17-demo-git-commit-details.md) own presentation/row heights. [Row windowing](2026-10-18-desktop-git-graph-windowing.md) owns later virtualization.

## Alternatives considered

All-at-once output avoids paging state but exceeds frame/command budgets on large repositories; a larger fixed limit still prevents reaching the end. Offset alone is simpler but refs, grafts, or shallow changes cause omissions/duplicates. Revision-bound cursors prevent that. Virtualization helps large DOMs but was unnecessary for the paging change; removing repeated edge scans and large-array argument expansion came first without a dependency.

## Consequences

All reachable history is accessible within explicit per-read budgets. Repository changes require refresh instead of silently mixing revisions. Regressions cover 405 real commits, cross-page merges, start/end changes, invalid/cross-workspace cursors, append failure/late replies, and 70000-commit layout. Layout checks do not prove 70000 DOM rows' frame rate. Historical engineering/UI evidence is in the offline copy of `.scratch/desktop-shadcn/issues/21-polish-history.md`.
