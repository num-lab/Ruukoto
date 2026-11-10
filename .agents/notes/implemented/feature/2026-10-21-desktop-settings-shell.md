# Agent Note: Preserve settings forms and original request ownership

Status: implemented

[Single product](../architecture/2026-11-10-single-product.md) supersedes product-target selection and PA connection forms. [Settings design](2026-10-28-desktop-settings-demo-design.md) and [visual alignment](2026-11-07-desktop-visual-alignment.md) own presentation; [instance MCP](../simplification/2026-10-24-code-instance-mcp.md) removes workspace/source selectors.

## Problem

Settings must work without an open conversation. Letting each page close itself or silently follow current chat selection risks crossing drafts and late responses between contexts. Recreating a form on every snapshot can discard the only record of an unresolved save.

## Decision

The shared SettingsDialog owns open/category and navigation guards, not a router or generic backend scheduler. Each page owns loaded values, revision, draft, field errors and its original activated instance/request parameters. Model revisions and MCP versions keep their actual semantics rather than a fictional common configuration protocol.

Dirty forms offer save-and-continue, discard or keep editing. Execute stored navigation only after explicit save success; saving or unknown outcomes prevent duplicate submission and unsafe discard. Preserve both current values and drafts on conflicts for comparison.

Read tickets bind the current generation. Navigation, close, disconnect and every snapshot invalidate stale reads and invoke page invalidation. An invalidated submitted write retains its original association as unknown; snapshot/instance changes must not unmount the component holding it. Recovery queries the original instance/request, never resends to a newly selected destination.

The container carries only the form dirty/phase/save/discard/invalidate interface. Pages retain request ownership and backend authorization/revision checks. The settings entry remains independent of a selected conversation and exposes only the sole product’s supported pages.

## Alternatives considered

- Inline App state: smallest initially, but close/sidebar shortcuts bypass pages and repeat form/request logic. Extract a small shared container.
- Generic form request scheduler: appears uniform, but obscures different model/MCP revision and recovery rules. Pages own requests.
- Recreate forms on instance change: clears inputs, but loses unresolved operation identity. Invalidate reads while preserving pending writes.
- Infer configuration scope from chat: avoids selection work, but makes configuration depend on unrelated display state. Instance MCP removes source selection rather than guessing it.

## Consequences

Settings opens independently of sessions and protects original form/request identity. Containers do not replace backend revision or authority checks. Tests cover navigation, stale reads, lost writes and no-session defaults; SSR/synthetic bridges establish only renderer behavior, while real Electron/MyGo focus, themes and service integration need separate acceptance.
