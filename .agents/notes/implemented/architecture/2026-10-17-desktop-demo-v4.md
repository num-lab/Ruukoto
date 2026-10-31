# Agent Note: Desktop adopts Personal and repository tabs from demo v4

Status: implemented

[Lazy Git/directory pages](../feature/2026-10-24-directory-pages-lazy-git.md) makes production Git queries click-triggered with a persistent new-tab entry and non-repository feedback after entry. [Operation-specific checks](../bug-fix/2026-10-24-operation-specific-checks.md) replaces whole Git-metadata scans/external-reference restrictions, while [owner browsing](../feature/2026-10-24-owner-workspace-browsing.md) replaces protected-root browsing restrictions. Fixed read-only commands, budgets, identity and page consistency remain. Old shared-runtime Personal wiring described below is superseded by the [durable product entry](../simplification/2026-10-18-personal-product-entry.md), not a claim that today's Personal uses the old protocol.

## Problem

The demo's Personal main tab, connection settings, draggable equal-width tabs, Git graph and glass layer had not reached Desktop. Production had a Personal placeholder and no Git-history read API. Copying sample state would replace real data, send verification and path protection with simulations.

## Decision

Freeze approved-demo-v4 with style/primitive provenance assertions and unchanged older baselines, now under `test/fixtures/desktop-baselines/`. Original work scope is offline at `.scratch/desktop-shadcn/issues/19-desktop-demo-v4.md`. Both tab groups share ordering/slot avoidance. Main tabs use target plus session identity; Personal main is Ruukoto. Right-tab order belongs to its parent session. Drag neither recreates objects nor changes active selection; cancel restores order. Keyboard ordering/screen-reader announcements match demo.

One app-window layer uses 72% background and 28-px blur. Left sidebar, both top bars and rounded message-area gaps reveal that transparent shared layer rather than separately sampling backgrounds and producing seams. Main/right bodies remain solid with reduced-transparency fallback. The frozen approved-demo-v4-glass.css delta is authoritative; two earlier corner fixes remain unused references, not production sources.

The original shared-runtime Personal snapshot explicitly supplied mainSessionId. Missing identity displayed not-ready rather than guessing role order or creating a dev replacement. History, tools, approvals, model, Context, queue/input reused actual projections; Plan remained Code-only. Personal right sidebar exposed browser/SubAgent only, with file/Git blocked at action and IPC layers and sidebar diff actions rejected, while inline tool diffs remained readable. Settings used host/controlDir. DesktopSubmissions partitioned unresolved sends by their digest, never replaying old-instance input on another connection. Attachments carried target through the chain and checked original controller, connection object and instance at picker/upload stages, preserving Code defaults. Later Personal-specific assembly retains explicit ownership rather than inheriting retired protocol wiring.

Code Git reads registered roots through Runtime/control read_workspace_git; clients cannot supply commands, absolute paths or root directories. Non-repositories return null, empty repositories empty commits, with actual parents/explicit refs. The original cap was 200 commits, five seconds total, 512 KiB per command and 768 KiB result. Fixed argv and sanitized Git environment disable lazy fetch, pager and replace. Root/Git metadata identities are checked before/after reads. The original full-protection policy rejected metadata symlinks/hard links, alternates and include/includeIf with a 100000-item scan limit while supporting ordinary worktrees. Later operation-specific/browsing decisions replace the overbroad checks; [Git paging](../feature/2026-10-17-desktop-git-history-pages.md) replaces the 200-total cap.

Failures remain visible/retryable, not cached as non-repositories. Caches discard late replies by workspace, instance generation and state-object identity. Graph geometry uses demo's 28-px rows, 14-px nodes and per-row SVG, not variable row-height scaling. HEAD marks its commit separately without claiming an unconfirmed branch.

This migration introduced protocol 29 for mainSessionId/Git reads without SQLite/JSONL changes; it is historical, not the current protocol. Main attachments reused owner snapshot storage and rejected child-session upload.

## Related decisions

The original active-note audit searched Desktop, Personal, Git, tabs, attachments, snapshots and glass. [Current migration](2026-10-16-desktop-current-demo.md)/[Trace](2026-10-16-desktop-trace-migration.md) retain send/tool/scroll semantics while this updates visual source/Personal entry. [Personal demo](../feature/2026-10-17-demo-personal-main-tab.md), [connection settings](../feature/2026-10-17-demo-personal-connection-settings.md), [tab ordering](../feature/2026-10-17-demo-tab-reorder.md), [dynamic widths](../feature/2026-10-17-demo-responsive-tab-width.md), [Git graph](../feature/2026-10-17-demo-git-graph.md) and [commit details](../feature/2026-10-17-demo-git-commit-details.md) retain sample acceptance, not production data. [MyGo shell](2026-10-17-desktop-mygo-experiment.md) owns host choice/isolation.

## Alternatives considered

- Copy demo App directly: fastest visual match, but overwrites real state/unresolved sends. Copy presentation and retain production controllers.
- Execute Git in Desktop main: one less protocol operation, but bypasses backend registered roots/checks. Runtime owns read-only access.
- Identify Personal by label/first roleSessionIds entry: no new field, but names/order do not prove identity. Snapshot explicitly names main.
- Support shared object stores initially: broader repository support, but protection would need every external object-root identity. Initially reject; later operation-scoped checks own changed support.

## Consequences

Desktop matches demo layout/interaction, gains actual Personal single-session behavior and displays real commits. Upgrade requires matching backend protocol. Bounded reads can reject large/unusual repositories with safe retry UI. Actual SSH, model and native-experience coverage belongs to original evidence, not simulated passes.

[Drag source](../bug-fix/2026-10-17-desktop-tab-drag-source.md), [snapshot reads](../feature/2026-10-17-desktop-read-snapshot.md) and [creation settings](../feature/2026-10-17-session-creation-settings.md) own later lifecycle/default changes. [Typography/selection](../feature/2026-10-17-desktop-chrome-typography.md) and [hover eligibility](../bug-fix/2026-10-17-desktop-tab-hover.md) own later local presentation; other migration contracts remain.
