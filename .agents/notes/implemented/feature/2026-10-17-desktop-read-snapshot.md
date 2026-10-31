# Agent Note: Preview captured Read versions outside the workspace

Status: implemented

[Complete chunked transfer](2026-10-18-complete-reasoning-and-preview.md) partly supersedes the original 256 KiB display limit; capture provenance and authorization remain.

## Problem

Read can legitimately access files outside the workspace, but Desktop mapped previews only through registered roots, leaving `/tmp` reads without a preview.

## Decision

Use the unique artifact of a successful canonical read as its captured preview; the existing Read execution captures only one `file_read` stream. Verify artifactId, taskId, sessionId, status and size rather than parsing human names. Code alone exposes the existing `read_artifact`, originally up to 256 KiB with partial/truncation visible. Paths supply only titles/language selection, never new filesystem-read arguments. Missing or ambiguous historical records explicitly cannot preview.

This supplements the read/lifecycle behavior in [Desktop migration](../architecture/2026-10-17-desktop-demo-v4.md) without replacing its other decisions. Historical requirements/checks remain in the offline desktop interaction-fixes work item.

## Alternatives considered

An arbitrary absolute-path read would show the current version, but adds system-path permission and fails when the source is deleted. Existing artifacts preserve the captured version and ownership under backend protection. A new structured artifact kind is more general, but the unique Read-stream contract suffices without a schema change.

## Consequences

Snapshots remain readable after source deletion. Regressions cover forged ownership, stale responses, partial capture and size. Zero-byte Read currently has no artifact and reports missing content. This previews a captured version, not current file contents.
