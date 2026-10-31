# Agent Note: A single Ruukoto main-session entry in Demo

Status: implemented

## Problem

Demo switched a global Code/Personal target through settings. Personal showed only a connection placeholder and disabled the inspector. The owner requested a Ruukoto entry above workspaces and one main conversation in the shared top tabs.

## Decision

Both top tab groups reveal the active tab when it or available width changes, so a newly opened main session cannot remain offscreen. The workspace list stays visible. Ruukoto opens one independently identified main session; repeat clicks focus its existing tab. Closing removes only the tab, and reopening preserves history/draft for the current Demo lifetime. Mock submissions, model choice, attachments, and inspector tabs are session-keyed, separate from workspace sessions. No extra Personal sessions are created.

The inspector retains expansion and resizing. Personal offers browser and SubAgent, not diffs, Files, or Code defaults. File/diff entry points check current session identity as well as hiding buttons. Personal starts with an empty conversation, sharing transcript and composer without invented chat content or Code-specific tool demonstrations.

Remove the runtime-target setting and unreachable SSH placeholder. Real connections and the production Personal UI are outside this Demo decision; later migration needs its own authorization. [Personal connection settings](2026-10-17-demo-personal-connection-settings.md) adds a separate settings entry without restoring target switching.

[The Desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md) retains real-connection boundaries. [Transcript](2026-10-16-demo-ai-elements.md), [inspector](2026-10-16-demo-inspector-tools.md), and [tab layout](2026-10-16-demo-header-model-menu.md) keep their visual/Code behavior. Frozen drafts are unchanged.

## Alternatives considered

Renaming the global target selection is smaller but cannot show Personal and workspace tabs together. Treating Personal as a workspace reuses lookup but incorrectly includes filtering, session creation, and file-path mapping. One distinct main identity shares rendering/update paths only. Wiring a real Personal backend now provides a full experience but exceeds the GUI-design scope; verify Demo first.

## Consequences

Ruukoto sits above workspaces and settings loses target switching. Repeated open/close/reopen uses the same main identity, preserves draft/mock history, and prevents delayed sends from leaking into Code. Personal's inspector contains only allowed entries; Code files/diffs remain. Render/submission regressions and browser checks cover identity deduplication, reopening, delayed cross-tab sends, settings, inspector, original Code previews, themes, narrow layouts, and keyboard use. Historical evidence is in the offline copy of `.scratch/desktop-shadcn/issues/12-personal-main-tab.md`.

Models, connections, and replies remain mocked, not Personal-backend acceptance. Refresh resets memory state. The empty main conversation demonstrates only requested interaction; content layout needs inspection after input.
