# Agent Note: Progressive workflow controls in a persistent sidebar

Status: implemented

## Problem

The old workflow window showed run IDs and longer commands, hid chat, and asked owners to copy question generations, revisions and request keys. It was difficult to identify runs or observe while chatting. Protocol tests did not prove this interaction usable.

## Decision

The owner-approved experience specification introduced a persistent list-to-detail-to-action sidebar, defaulting to active runs/recent results in the current session, with history and named-definition start entries. Wide layouts retain chat and focus switching; narrow layouts use a separate window. Client closure never cancels execution. Reuse list/input primitives, not a workflow editor.

Starts fix a name/brief description. Queries provide millisecond timestamps and instance-stable display sequence numbers. Models name temporary scripts; old unnamed records use an explicit fallback. Icons always have text, distinguishing partial failure, owner waiting, pause, cancellation and stop verification; final delivery status is separate. Internal IDs remain diagnostic detail, not ordinary input.

Before sending, persist stable request key, revision and business parameters. Unknown submissions are queried first; only confirmed nonacceptance allows same-key retry. Never gamble with a new key. Readable questions/options support recovery without deleting safety checks. Backend queries own run facts; clients retain navigation/unsettled operations only.

This supersedes text-window/user-entered-key choices in [definitions/controls](2026-10-13-workflow-library-and-controls.md), retaining named versions, authorization, paging, idempotency and unknown effects. [Trusted owner answers](2026-10-13-workflow-owner-input-and-delivery.md) retains source/question-generation checks. [Progressive interaction](../process/2026-10-14-progressive-human-interaction.md) owns the general rule. Original specification/handoffs remain in offline workflow experience records.

## Alternatives considered

- Aliases/autocomplete reuse text controls but still teach command language and hide chat.
- A graph editor provides authoring but exceeds managing runs/starting definitions; file/Agent editing already handles scripts.
- Simultaneous TUI/IM redesign improves consistency but needs distinct mechanisms; the owner approved TUI first.

## Consequences

Wide/narrow layouts share navigation. Names/times/descriptions and read-only sequence numbers distinguish same-name/same-millisecond runs; active work is not lost among recent results. Stop/effect-unknown/report states remain separate, with summaries over all executions, not only the latest hundred details. Selection outside the current page is queried and retained explicitly. Existing workflow_controls receipts resolve submissions; no extra state database/notifier is added. Confirmed acceptance consumes the original confirmation; stale revisions return to current details, avoiding duplicate actions.

Display/start/pending fields form a cross-package contract. Temporary scripts require short titles; named definitions keep selected names, not descriptions inferred from parameters. The original schema 41/protocol 25 transition strictly rejected old archives/clients. Imports in either direction still reject sources with workflow execution records; display fields do not bypass this. JSON inputs may remain complex, preserving original text and parse positions; durable question choices/constraints remain backend-validated.

Historical keyboard, long-list/log, resize, state/recovery and independent review records remain in offline sidebar/joint-acceptance tasks. Offline/PTY checks are not substitutes for owner readability/chat-coexistence acceptance.
