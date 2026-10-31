# Agent Note: Page directory entries and query Git only after opening it

Status: implemented

## Problem

Each tree level stopped after its first 200 enumerated items without continuation. Git visibility depended on pre-discovery, causing queries when opening the inspector/new tabs or reconnecting. The owner requested directory continuation and a permanent Git entry that queries on click and briefly explains non-repositories.

## Decision

`list_workspace_files` accepts opaque optional `cursor` and returns `nextCursor` (`null` ends), replacing `truncated`; this introduced protocol 39. Pages retain 200-entry and 768 KiB budgets without total-entry/page limits. Sort directories first, then names by strict JavaScript string order, avoiding locale-equivalent names breaking cursors.

Each page asynchronously enumerates one level, using binary insertion to retain the smallest 201 candidates after the cursor. No recursion, open-handle/result cache or synchronous per-entry disk wait. Cursors bind registered workspace, canonical relative path, root/parent identities, target revision and last returned item. Pre/post identity/revision checks detect changes; cross-page changes return `workspace_file_changed`, malformed/mismatched-source cursors fail. Path/link/authentication/read-error rules remain.

Desktop appends a load-more action per level and preserves existing entries. Append failures retry the same cursor; expired/inconsistent pages require refresh. Refresh rebuilds from page one through at least the old count and old last-item sort position, then replaces atomically, preventing inserted prefixes from misclassifying old tail entries as deleted. Failure preserves the full old tree. Instance generation/state identity rejects stale replies and appends deduplicate. Active trees refresh root/expanded levels every three seconds and on focus. Collapse retains a single already-issued read cache; switching/unmount/collapse stops later refresh pages/levels.

Code's new inspector tab always shows Git graph and allows opening with a workspace. New pages and snapshots/inspectors without an active Git page do not query. Opening Git starts reading; existing page selection/restoration/refresh/history continuation retain their rules. Non-repositories show a brief explanation plus refresh, errors retain retry, empty repositories show no commits. Personal file/Git capabilities remain off.

## Related decisions

This replaces per-level total limits in [file wiring](../architecture/2026-10-16-desktop-current-demo.md), expands [refresh](../bug-fix/2026-10-17-desktop-file-tree-refresh.md) to loaded prefixes while retaining cancellation, and removes new-page Git discovery/errors from [loading feedback](2026-10-17-desktop-file-tree-loading.md). [Production Git wiring](../architecture/2026-10-17-desktop-demo-v4.md) becomes click-triggered; [history pagination](2026-10-17-desktop-git-history-pages.md)/windowing remain. Frozen demo behavior is historical, not evidence of current reads.

## Alternatives considered

- Raising the cap still leaves unreachable entries.
- Open handles/full-result caches save repeat scans but add lifecycle, expiration and cross-client state.
- Sorting all entries is simpler but unbounded in memory; retain only next-page candidates.
- Enumeration offsets avoid an initial full scan but cannot provide stable global order; use deterministic order/revisions.
- Pre-discovery hides irrelevant entries but causes waiting for unrequested functionality. Explain non-repositories after opening.

## Consequences

All directory entries are reachable and loaded prefixes refresh. Git queries serve open Git pages only. Each page still scans the entire target level; multipage refresh repeats scans and is not constant-latency. Pre/post filesystem checks are not atomic snapshots; continuously changing directories may require stabilization/retry. No database/session-format change occurs, but matching protocol client/backend is required. Historical engineering/browser acceptance remains in the offline directory-pagination work item.
