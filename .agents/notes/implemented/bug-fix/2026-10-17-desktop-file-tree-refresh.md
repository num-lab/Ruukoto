# Agent Note: Keep the active file tree current

Status: implemented

[Directory paging and lazy Git](../feature/2026-10-24-directory-pages-lazy-git.md) extends refresh to the loaded prefix and replaces it only after success. This note retains ownership of refresh triggers and cancellation.

## Problem

Directory caches had no invalidation trigger, so an open file tree stayed stale after files were added or removed in the workspace.

## Decision

The active Files panel refreshes the root and expanded directories every three seconds and on window focus. Reads are serialized and deduplicated. Refresh preserves the last successful tree and exposes retryable errors. Closing the panel or going offline stops refresh; unmounting cancels further directory scans. Removed entries invalidate the corresponding directory, expansion state, and file cache. Late replies are still rejected by instance generation and state-object identity.

This extends the [current Desktop demo](../architecture/2026-10-16-desktop-current-demo.md). Original requirements and evidence are in the offline copy of `.scratch/desktop-shadcn/issues/20-desktop-interaction-fixes.md`.

## Alternatives considered

A TTL alone needs fewer changes, but a visible panel would still have no new read to trigger refresh. Invalidating only on tool events misses external editors. A host watcher reacts faster, but adds cross-platform lifecycle and protocol work; bounded read-only enumeration is reused instead.

## Consequences

Regression coverage includes real temporary-disk changes, timer and focus triggers, hidden-component effects, disconnects, and late replies. External changes can take up to three seconds to appear, and read cost grows with the number of expanded directories.

[Loading feedback](../feature/2026-10-17-desktop-file-tree-loading.md) adds expansion intent and delayed opening without replacing cache invalidation or refresh behavior.
