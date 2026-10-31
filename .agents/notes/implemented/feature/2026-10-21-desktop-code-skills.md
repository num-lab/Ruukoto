# Agent Note: Bind Code Skill imports to host directory selection

Status: implemented

[Unified HOME discovery](../simplification/2026-10-28-home-skills-discovery.md) supersedes import/state management; Desktop retains read-only listing, pagination and diagnostics. [Markdown images](../simplification/2026-10-25-desktop-markdown-images.md) and [HTML rendering](../simplification/2026-10-25-desktop-markdown-html.md) replace the original image placeholders/HTML skipping; link rules remain.

## Problem

The managed backend could preview/import absolute paths for its control owner, but a renderer string is not proof of owner directory selection. Electron/MyGo own different pickers, and connections/instances may change or responses disappear between preview and confirmation.

## Decision

The original DesktopHost flow retained selected Code connection, instance, host ticket and backend preview. Electron opened its system picker in a host callback; MyGo obtained a Node ticket, selected through Go and returned the path to that host. Check original connection before selection, after path/preview and before submission; cancellation never calls the backend. Only dedicated `pickSkillFolder(target, instanceId)` and `desktop_skill_import` were exposed. Submission accepted a selection reference; the host supplied path/content revision/skill identity/original inventory revision. Raw backend import operations were excluded from the desktop allowlist; Personal's allowlist stayed unchanged.

One selection issued one import. CodeSkillsState retained original import/enable/remove identity. Lost responses or invalidation while pending required verification, not resend/navigation. After the same instance recovered, read original `skill_get` identity/inventory; failed reads remained pending. Explicit current-state observation allowed another owner action. Import failure, reselection or connection change invalidated the old preview but retained comparison data; importing again required explicit selection. Conflict retained list/selection/preview until manual refresh; reads never copied or rewrote the original import request.

Listings remain bounded/paged, with name filtering only over loaded items. Mid-page inventory changes retain the old list and require reload. Stable-identity detail reads bounded bodies; refreshing page one does not remove management access to selected later-page items. The original Markdown renderer skipped HTML and represented images as text, later superseded as linked above. Only HTTP(S) links open the system browser. Original managed enable/remove used backend manifests and explained new-task selection, old-task recovery and retained bytes; externally maintained sources were read-only. HOME discovery now removes these management operations.

## Related decisions

This implemented the original Code Skills slice of the [settings proposal](../../proposed/feature/2026-10-21-desktop-settings-management.md). [Settings container](2026-10-21-desktop-settings-shell.md), [managed backend](2026-10-21-managed-skills.md) and [shared MyGo host](../architecture/2026-10-17-desktop-mygo-experiment.md) retain navigation, storage safety and host ownership in their applicable scope.

## Alternatives considered

- Returning picker paths to the renderer for direct import reuses pickFolder but cannot establish selection/connection provenance consistently across shells.
- Re-preview/import after lost response generates another identity and can duplicate imports. Verify the original first.
- Refreshing the original preview's revision automatically reduces steps but loses the owner's content/inventory association. Preserve it and require reselection.

## Consequences

The historical flow managed Code Skills without sessions or a general filesystem API, but connection changes/cancel/rejection required a new selection and logical removal never reclaimed bytes. Current read-only discovery retains historical references, not the retired controls.

Isolated Runtime/Control/DesktopHost tests covered import/cancel/read-only sources/conflict/identity verification/pagination/stale replies; SSR covered Markdown/consequence text. Picker callbacks/MyGo transport were mocked, so real picker, restart, keyboard/themes/narrow layout and diagnostics still required product evidence.
