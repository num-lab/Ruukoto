# Agent Note: Desktop's initial-connection overlay

Status: implemented

## Problem

After approving the loading page, the owner requested removing its visible Ruukoto title, centering the remaining content, and migrating it to Desktop. Real connections may synchronously replay an old online state before a snapshot, or retry indefinitely after an initial failure. Copying Demo's timer invents readiness; waiting for all retries can conceal recovery controls forever.

## Decision

Demo and Desktop share `ConnectionLoading` composition and style deltas. A spinner and connection text are centered as one row; DialogTitle remains screen-reader-only. App supplies `pending`. The component initially opens, then exits according to pending, and only the close-autofocus callback releases underlying inert content and shortcut isolation. Demo's 2.2-second simulation and replay remain in Demo App. Production adds neither display delay nor a new connection deadline.

Desktop covers only the first local Code connection. It stays while connecting, or while online without an installed instance snapshot. It exits when online with an instance, failed, closed, or first reconnecting. The real control connection installs the snapshot before online, but host subscription can replay an earlier online state, so both must be checked. Reconnecting means the initial attempt failed; ending the overlay exposes existing errors, reconnect behavior, and Personal settings. Later reconnects and an unconfigured Personal target do not block the whole screen. Exit focuses message input, or a sidebar button when no session exists.

The full-screen layer resets `transform:none` and `translate:initial` separately. Translate's initial value is none. Writing both as none lets production minification merge them into legacy transform, leaving Dialog's independent `translate:-50% -50%` and shifting the layer up-left. Regression processes the actual style delta through Safari 16-targeted minification and requires both resets. Production CSS and native WKWebView rectangles require verification; a development-server screenshot does not substitute.

This supersedes the visible title and Demo-only scope of [Demo loading](2026-10-18-demo-connection-loading.md), retaining modal isolation, themes, and reduced motion. [Startup warming](../bug-fix/2026-10-17-desktop-connection-startup.md) keeps its backend/host lifecycle.

## Alternatives considered

Reusing the 2.2-second timer is shortest but hides real waiting or exits before connection. Keeping the overlay through reconnecting can wait forever and hide recovery. Showing it on every target switch/reconnect blocks unconfigured Personal settings and already loaded content. Existing state for the first Code connection is sufficient.

## Consequences

Production and Demo appearance can be compared directly, while the existing UI reports real errors. Actual App with an isolated bridge fixture verifies synchronous terminal states, online-before-snapshot, failure/retry, and exit isolation. Historical sources and evidence are in the offline copy of `.scratch/desktop-shadcn/issues/28-startup-loading-migration.md`. Backend connection, permissions, and retry policy do not change.
