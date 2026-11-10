# Agent Note: Discover Code composer actions and retain manual compaction identity

Status: implemented

[Single-product cutover](../architecture/2026-11-10-single-product.md) retires the Personal-specific portions of this decision. The software-work behavior, source/operation identity and host-security constraints remain; historical evidence is not cutover acceptance.

## Problem

[Issue #49](https://github.com/num-lab/Ruukoto/issues/49) makes common Code actions and explicit skills available from Desktop input. A command menu must distinguish application actions from task input and preserve drafts, attachments and original write identity across navigation and lost responses. Manual compaction already has a backend lifecycle; Desktop needs its discovery, recovery and result display.

## Decision

Use a fixed Code command list and exact token routing in the existing conversation and New chat composers. The searchable menu completes input through pointer, Enter or Tab; ordinary submission executes it. Escape dismisses without changing input. Preserve IME composition and Shift+Enter, and pass unknown slash-leading input through unchanged. The menu offers applicable actions; an explicitly submitted unavailable or invalid registered command retains its draft and explains the next action. Keep the selected conversation and its composer mounted during disconnection so unsent input and local help remain available under the existing offline write gates. Personal and TUI routing remain separate.

Normalize the `/skill name` invocation prefix to the existing explicit `/skill:name` input, preserving the argument suffix and attachments. Read the paged backend skill catalog for discovery and retain backend validation, source recording, model selection and queueing. Application commands call existing selectors, settings and actions without a task or owner-history message. New chat model/mode selection edits the local draft without allocating a session. [Managed workspaces](2026-11-07-managed-coding-workspaces.md) owns first-send creation; [Desktop New chat](2026-10-20-desktop-new-chat.md) owns its draft canvas.

Named composer branches use the existing [branch snapshot](2026-10-11-branch-session-snapshot.md) operation at the current persisted history point. [Message actions](2026-10-28-desktop-message-actions.md) retain their completed-task boundary. Both paths share original-key recovery and the backend's eligibility and source rules.

The native host journals the original compaction request key, complete parameters and data-instance identity before sending. Reconnect, application reopening and response loss query that key; unresolved outcomes retain it, and another instance cannot inherit or replay it. A verified absent request requires an explicit retry under its original key. This also prevents failed journal cleanup from replaying a previously rejected command during reconnect. Switching conversations, disconnecting or closing the client never sends cancellation; Stop calls the existing interruption operation explicitly.

[Manual compaction](2026-10-11-manual-context-compaction.md) continues to own admission, configured-summary-model fallback, exclusive session occupancy, history preservation and one terminal result. Desktop displays the original running, success, no-op, failure, canceled or interrupted record and its available before/after estimates. Unsent input stays visible during occupancy. Compaction estimates describe that operation; the Context indicator retains the most recent actual model request until a later request exists.

## Alternatives considered

- Import the TUI command executor: it already routes commands, but brings terminal and Node facilities into browser rendering. Keep the small Desktop command list beside its UI actions.
- Submit application commands as ordinary tasks: this reuses message submission but adds false owner-history input and cannot open local selectors without allocating a session.
- Keep compaction identity only in renderer memory: this is smaller but loses the original operation after application closure and can create duplicate summary calls after a lost response.

## Consequences

The menu adds discoverability without a command extension framework or another skill execution path. New commands need an explicit list/routing change. Native compaction journaling adds recovery state, while the existing backend remains the authority for execution, admission and results. Summary quality and cost retain the existing compaction limits.
