# Agent Note: Keep settings target selection independent and preserve submitted forms

Status: implemented

[Direct PA save](../simplification/2026-10-28-desktop-personal-direct-save.md) supersedes PA page save/unresolved navigation; whole-dialog protection remains for Code and PA connection settings. [Settings demo design](2026-10-28-desktop-settings-demo-design.md) replaces old Code/PA tabs and shadcn field layout. [Instance MCP](../simplification/2026-10-24-code-instance-mcp.md) removes workspace/source/candidate selection. Form protection, tickets, and original-instance/request ownership remain here; retired UI decisions are identified below.

## Problem

Settings were inline in App with appearance, old PA connection, and archives only. Management needs a target even without an open session. Original project-scoped MCP additionally distinguished displayed workspace from configuration source. Letting pages close themselves or save to the current chat target risks crossing drafts and late responses between targets.

## Decision

Extract SettingsDialog with existing Dialog/Tabs/Field/form components rather than a router/window system/general form framework. Its initial six categories were appearance, models, Skills, MCP, PA remote connection, and archived sessions. It enlarged the dialog, kept internal scrolling in two regions, and added CSS overrides after the frozen design instead of rewriting that baseline. Current visual/category composition follows the demo-design note.

SettingsState owns open/category/independent selections for the three management groups. Initialize from the chat target on opening, then keep settings selection independent. The original target control showed only Code/PA with a nonvisual accessible name, not redundant titles/descriptions/scope labels. Original MCP defaults came from a normal Code session's workspace/source or the first workspace when no session existed; switching workspace reset source, and changing actual Code instance cleared source selection in every category. These project-scoped choices are retired under instance MCP, not requirements to reintroduce them.

Original pages received category/scope/settings/two CodeState values via component parameters. MCP candidates were backend-provided with instance/workspace ownership, with candidate names preferred; missing/wrong-instance/wrong-workspace/absent-selected-source candidates yielded sourceId null and prevented save. Chat lists were not an authoritative candidate source. Those candidate APIs are now removed. Unwired pages originally showed explicit read-only status; old chat connection was never the new personal management connection. Later backend/page decisions own delivered operations.

### Form and request ownership

The container holds only SettingsForm dirty/phase/save/discard/invalidate. Each page owns loaded values/revision/draft/field errors and original target/instance/workspace/source/parameters as applicable. Each API receives its actual revision semantics; do not normalize model revision, MCP version, and personal configuration into a fictional common protocol. Preserve current values and draft on conflicts for comparison, not draft replacement before retry.

Category/target/workspace/source/close/sidebar-collapse navigation follows the shared guard where still applicable. Dirty forms offer save-and-continue/discard/keep-editing; perform the stored navigation only after explicit save success. Saving/unknown prevents leaving, discarding, or duplicate submit. The confirmation stores a UI continuation, not another backend operation scheduler.

Ticket/accepts identifies asynchronous reads from the current generation. Navigation/close/disconnect/every snapshot invalidates old tickets and calls page invalidate. Discard stale reads; if a submitted operation is invalidated, retain its original association as unknown. Only explicit navigation changes page key; snapshot/instance changes must not unmount the component holding an unresolved submission. Recovery reads original configuration and never resends to the newly selected target.

PersonalConnectionState is a concrete local-host example. Connection configuration is local, readable/writable while remote offline, and not invalidated by remote PA status. Drafts obey the guard. not_sent/rejected remain editable; unknown/disconnected/IPC error retains the original submission and prohibits repeat save. Verification only reads host configuration: matching values confirm current saved state; mismatch displays current configuration alongside retained submitted draft; read failure stays unresolved. Report local saving separately from remote connection success. The original connection API lacked conditional revision; do not invent such protection. New management pages use their real versions.

This implements the container portion of [settings planning](../../proposed/feature/2026-10-21-desktop-settings-management.md); model/Skills/MCP/PA maintenance owners provide actual operations. [Shadcn design](../architecture/2026-10-15-desktop-shadcn-demo.md), [archives](2026-10-20-desktop-session-archive.md), and [sidebar toggle](../bug-fix/2026-10-17-desktop-sidebar-toggle.md) retain visual/archive/focus decisions. The original audit fully absorbed no proposal.

## Alternatives considered

- Add state to inline App pages: small initially, but close/sidebar shortcuts still bypass pages and duplicate target/request logic. Extract the minimum container/form interface.
- Build a generic form request scheduler: uniform calls, but products have different versions/credentials/maintenance/recovery, and prebuilt abstraction hides those differences. Pages own requests.
- Recreate every form on target/instance change: clears old inputs easily, but loses in-flight/lost-response identity. Invalidate read tickets and retain the submitting component until verification or explicit safe navigation.
- Infer every MCP source from current chat: avoids querying, but aggregated workspaces/current snapshots did not contain all original projects. The historical solution used bounded backend candidates; current instance MCP removes that problem rather than reviving inference.

## Consequences

Settings opens independently of sessions and protects original form/request identity. The original shell supplied component/scope/form interfaces while only appearance/old PA connection/archive performed real actions; that is a historical delivery boundary, not a claim current management pages remain placeholders. Containers do not replace backend revision/authority checks, and pages must honor invalidation/ownership.

Narrow tests covered no-session defaults, then-supported workspace/source behavior, unsaved navigation, stale-response rejection, PA failure categories, read-only verification, and SSR accessible names. SSR/synthetic browser bridges establish renderer structure/interaction only. Real Electron/MyGo focus/light-dark/service integration needs product acceptance; this shell note cannot certify the entire settings feature.
