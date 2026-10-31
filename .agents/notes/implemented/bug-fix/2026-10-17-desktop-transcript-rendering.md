# Agent Note: Rendering cost of loaded messages

Status: implemented

## Problem

Each message reread the ordered flow to resolve inline file references: 50 messages caused 52 full sorts. Whole-transcript updates also reparsed old Markdown, while offscreen placeholders delayed layout of already loaded rows.

## Decision

Conversation reads the ordered list once per render and records preceding tool boundaries in one pass. Markdown is cached by final text and the file-reference signature, including tool key, entryId, name, and target. Clicks resolve the current tool; attachment and child-session input changes still update. Main and child message rows no longer use `content-visibility:auto` placeholders. The upstream scrolling and prepend anchoring remain.

This extends the [trace migration](../architecture/2026-10-16-desktop-trace-migration.md). Original requirements and evidence are in the offline copy of `.scratch/desktop-shadcn/issues/20-desktop-interaction-fixes.md`.

## Alternatives considered

A global event-projection cache could reduce all callers' work, but would expand shared invalidation state. Removing repeated scans at the rendering consumer is sufficient. Caching the entire message by object identity is shorter, but projections can mutate in place, so it would miss text or tool-identity changes.

## Consequences

SSR counters and component replay separately verify linear reads and cache invalidation; elapsed performance and actual painting are recorded separately. Laying out more rows increases the cost of very long histories. A virtual list with adequate prerendering should depend on measurements, not this migration.
