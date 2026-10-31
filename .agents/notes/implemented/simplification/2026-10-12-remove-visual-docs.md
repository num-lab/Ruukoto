# Agent Note: Remove unmaintained visual documentation

Status: implemented

## Problem

[Reader separation](../process/2026-10-09-split-agent-and-human-docs.md) stopped maintaining old diagrams but retained pages. Snapshot banners coexisted with old maintenance instructions, so search still presented them as work to synchronize. On 2026-10-12 the owner explicitly requested removing the directory after the development-workflow change, superseding in-place snapshots.

## Decision

Remove eleven docs/visual HTML pages plus style.css/visual.js, README navigation and dedicated ESLint browser globals. Current explanations remain in modules, usage and acceptance docs. Redirect meaningful inbound links and delete redundant diagram references.

Mark the original separation decision partly superseded without rewriting its decision/alternatives. Historical work/verification records retain their facts. The old diagram-derived synchronization task required revalidation rather than remaining executable; potential documentation defects were not thereby fixed. The cleanup used light verification, but its decision reversal still received this note.

In the cleaned history, the last pre-deletion tree is `fa008043a6d5526ce15763609a5b11b4c4f1eece`; `git show fa008043:docs/visual/index.html` retrieves it. The original pre-rewrite reference was `bcab62c08eb9bc4ef7ba85842d790f2b0b11ff8a`, retained only as historical provenance. Prior workflow review fingerprints still refer to reviewed content, not replacement cleanup hashes.

## Alternatives considered

- Retain frozen pages: convenient offline history, but contradicts the requested removal and retains duplicate search/navigation material.
- Move them into another archive directory: directly browsable, but Git already preserves history and another tree retains noise/maintenance.

## Consequences

Current navigation/search no longer includes old diagrams. Historical browsing now needs Git extraction and old external bookmarks no longer address working-tree pages. Product code/interfaces do not change. Historical paths/test names refer to their original verification date.

## Verification

Original check:docs, verify-notes and diff checks passed. A Markdown-parser scan of 273 documents, including historical work items, found no relative links into the removed directory and confirmed its absence. Historical prose paths were not blindly replaced as current entry points.
