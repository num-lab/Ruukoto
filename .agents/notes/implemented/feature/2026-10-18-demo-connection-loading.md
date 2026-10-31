# Agent Note: Demo startup connection overlay

Status: implemented

[Desktop loading-state migration](2026-10-18-desktop-connection-loading.md) supersedes the original title/demo-only scope; initial evidence remains historical.

## Problem

The owner requested a full-screen overlay during backend connection, first approved in the mutable demo. Memory fixtures have no real readiness signal; waiting for one never finishes, while immediate production migration exceeds that stage's authorization.

## Decision

On first mount, Demo shows a full-screen shadcn Dialog with a centered spinner and the original connecting-backend label, using Neutral themes and a blurred background. A 2.2-second timer simulates readiness only, not a backend request or measured latency. Settings can replay it. Unmount clears the timer; show no percentage or staged progress.

Disable Escape, outside-click and close buttons. Underlying `inert` and global-shortcut isolation remain until the exit animation ends, then focus the composer. Reduced motion disables rotation/fade; reduced transparency or missing filter support uses solid color. Append mutable-demo styles only and retain existing source-difference checks; production/frozen versions do not change in this decision. [Environment warmup](../bug-fix/2026-10-17-desktop-connection-startup.md) owns actual readiness, while [AI Elements Demo](2026-10-16-demo-ai-elements.md) retains its memory-data boundary.

## Alternatives considered

- A custom overlay uses fewer components but repeats focus/modal behavior. Reuse Dialog.
- Implementing real connection/error/retry completes startup behavior but exceeds this demo-design step; wire real state during migration.

## Consequences

The background cannot be operated while loading, and closing does not recreate sessions/inspector state. Themes can be replayed. Historical engineering/browser evidence remains in the offline startup-loading work item. A mock timer proves no backend availability; production must use real connection state.
