# Agent Note: Desktop Personal Message Bubbles

Status: implemented

[The desktop file loop](2026-11-04-personal-desktop-file-loop.md) partially supersedes this note's completed-owner-message timing and existing approval-control placement. Assistant completion, house bubbles, reduced motion, composer sizing and target behavior remain governed here.

[Desktop visual alignment](2026-11-07-desktop-visual-alignment.md) replaces mount-triggered bubble animation with one animation per visible live send or completed arrival. History, reconnect snapshots and reopening the page remain still.

## Problem

Personal mixed unbubbled Agent text, streaming fragments, reasoning and tool traces with bubbled owner messages. Repeated timestamps would add noise, while the shared composer exposed a permission selector and a two-line minimum inconsistent with the approved Personal layout.

## Decision

Personal renders only completed timeline user and Assistant messages. Consecutive visible messages from the same role form one group with a timestamp above its first bubble; tool results and empty Assistant entries do not create bubbles or break a group. Both roles use muted bubbles with compact grouped corners, and newly mounted bubbles use a 260ms pop transition unless reduced motion is requested. Streaming state continues to update internally for protocol consistency but is not rendered as message content or execution traces.

The Personal composer starts at 24px and uses the shared bounded resizing helper with that explicit minimum; Coding retains its 48px default. Its mode selector is absent. The attachment button remains disabled with an unavailable description because `DesktopHost` rejects Personal attachment selection and no Personal upload/submission contract exists. Enabling it requires that product capability, not only a renderer change.

Opening Personal remains a target switch without adding a conversation tab. Coding timelines, traces, composer controls and tabs are unchanged. The PA-specific rule supplements the [Desktop demo decision](../architecture/2026-10-15-desktop-shadcn-demo.md).

## Alternatives considered

Keeping live fragments and traces would preserve execution visibility, but the owner selected complete, quiet messages for Personal. Reusing the shared composer minimum and mode controls would reduce branching but would not match the approved Personal interface. Enabling the attachment button without a real upload path would misrepresent a successful action.

## Consequences

Agent output appears only when its completed timeline entry arrives, so users do not see partial text or tool activity in the conversation. Approval, question and background-work controls retain their existing state and recovery paths. Hidden tool results remain in history and protocol state rather than being deleted. Grouping across hidden tool results can combine separate execution rounds into one visual run, with the first visible message supplying the timestamp.

The disabled attachment control makes the current product limitation visible but does not provide file selection. Real attachment support still needs host, remote protocol, persistence and recovery work. Targeted renderer tests cover grouping, completed-only display, trace omission and the two composer minima; native Electron/MyGo appearance and motion remain real-host acceptance concerns.
