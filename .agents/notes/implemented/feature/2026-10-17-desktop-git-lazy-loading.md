# Agent Note: Automatically page Git history while scrolling

Status: implemented

## Problem

Git graph already paged through complete history, but repeatedly clicking Load more interrupted continuous browsing.

## Decision

Place a sentinel at the end of the commit scroller. Its IntersectionObserver uses that scroller as root and requests the next page 224px before the bottom. Each observation requests at most once; loading-state or cursor changes rearm it. If the sentinel remains in range after appending, continue until it leaves range or history ends. Callbacks remain current without recreating observations on ordinary rerenders. Notifications after cleanup are ignored.

Observe only when the current Git panel is expanded and online, has a next page, is neither refreshing nor appending, and has no error. Workspace and instance keys isolate state; switching tabs unmounts it. Loading has status text. Append failure preserves history and offers an error and retry; refresh failure retains the refresh button. Either error suspends automatic requests to avoid a failure loop. Demo has complete static samples and no pagination button or simulated backend.

This replaces the click trigger in [Git-history paging](2026-10-17-desktop-git-history-pages.md), retaining page size, cursors, revision checks, deduplication, and late-response isolation. Protocol and backend budgets do not change.

## Alternatives considered

Scroll events can measure remaining distance but need additional handling for an initially short viewport and content-size changes. Observing the end delegates both to the platform. A normal Load more button gives manual control but contradicts the owner's automatic-paging request; manual retry remains for errors. Reading all history at once bypasses existing output and time budgets.

## Consequences

History browsing is continuous without request loops on errors or hidden panels. This change alone accumulates DOM page by page and promises neither virtualization nor frame rate. Component-effect regressions cover intersection, duplicate notifications, append, errors, hiding, refresh, and unmount. Historical browser and native verification scope is in the offline copy of `.scratch/desktop-shadcn/issues/22-git-lazy-loading.md`.

Later [execution-activity feedback](../bug-fix/2026-10-17-desktop-execution-activity.md) changes related presentation without replacing tool details, identity, errors, or paging lifecycle. [Git-graph windowing](2026-10-18-desktop-git-graph-windowing.md) owns row virtualization; triggers, suspension, and deduplication remain here.
