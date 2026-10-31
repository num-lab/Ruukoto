# Agent Note: Migrate the current Demo into Desktop

Status: implemented

[Direct Markdown images](../simplification/2026-10-25-desktop-markdown-images.md) owns embedded-image loading; preview-file reads still use the backend. [Directory paging](../feature/2026-10-24-directory-pages-lazy-git.md) removes the 200-total directory limit. [Read-check reuse](../bug-fix/2026-10-24-read-check-overhead.md) permits ordinary hardlinks. [Owner browsing](../feature/2026-10-24-owner-workspace-browsing.md) removes browsing protected-root scans. [Complete chunked transfer](../feature/2026-10-18-complete-reasoning-and-preview.md) removes the preview-total limit. Registered roots, paths, read consistency, and original access scope remain.

## Problem

The owner requested production migration of the current Demo after several annotation rounds. The [earlier frozen migration](2026-10-15-desktop-shadcn-demo.md) lacked AI Elements, Context, Effort, and inspector browser/files. Overwriting renderer would lose real state; copying fixtures would invent it.

## Decision

Keep submission idempotency/recovery, approval, single-diff, and history semantics. Update presentation to Demo and add minimal read-only wiring. The original migration freezes v2 without changing old snapshots, copies new theme/primitives directly, and appends native-window adaptation separately. Historical approval is in `.scratch/desktop-shadcn/issues/05-current-demo-migration.md` in the offline archive; frozen sources are retained under `test/fixtures/desktop-baselines`.

Context uses existing selection records/window snapshots; Effort uses real model levels; thinking uses recorded text/time. Missing data stays unknown. The original browser uses isolated iframe with existing native-collision/tab interaction, not model browser tools. Files come only from registered workspaces through bounded read-only control queries, checking root identity, relative paths, and stable reads. Later owner-browsing rules supersede this migration's original protected-root check.

## Alternatives considered

Copying the whole Demo App preserves appearance fastest but replaces real models/directories/submission with static data. Copy only presentation primitives/styles. Electron WebContentsView offers a fuller browser but adds native coordinates, popup occlusion, and permissions; the original migration keeps approved iframe limits. Renderer-local reads remove a control layer but grant arbitrary local access; root/path authority remains in backend.

## Consequences

[Trace migration](2026-10-16-desktop-trace-migration.md) later changes thinking/tool details, preserving other boundaries and historical evidence. Original engineering/isolated-Electron acceptance is in the archived migration issue. Both frozen generations remain; theme/primitives trace byte-for-byte to v2. Empty thinking/tool message bodies are filtered before rendering to avoid empty spacing, while attachment-only messages remain. Independent-review fixes for disconnect forwarding, in-flight Context refresh, and empty outer spacing have narrow regressions.

The original iframe has no bridge, Node, device, or top-navigation authority; sites may forbid embedding, and address-bar history does not include internal page history. Original reads returned 200 directory entries and 256KiB previews with explicit truncation/unsupported feedback; the later decisions above replace total limits. Node before/after path checks are not an atomic openat sandbox. Context capacity comes from recorded snapshots or stays unknown. Protocol 28 introduced the migration and rejects incompatible clients.

Earlier approval, attachments, paging, and recovery rationale remains. This migration explicitly supersedes Demo-only/static-content scope in [inspector experiments](../feature/2026-10-16-demo-inspector-tools.md), without rewriting old evidence or silently dropping backend capabilities absent from the Demo. [Directory-protection cost](../bug-fix/2026-10-17-directory-protection-cost.md) records the original batched-check/race rationale; later browsing removals apply as stated above. [Desktop v4](2026-10-17-desktop-demo-v4.md) owns Personal, reordering, Git graph, and glass migration. [File-tree refresh](../bug-fix/2026-10-17-desktop-file-tree-refresh.md) owns later refresh lifecycle.
