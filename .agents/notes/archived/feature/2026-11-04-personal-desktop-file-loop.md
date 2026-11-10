# Agent Note: Personal desktop file work uses canonical decisions and durable owner display

Status: implemented
Archived: 2026-11-10

[Personal send feedback](../simplification/2026-11-07-personal-send-feedback.md) supersedes routine presence/admission wording and establishes the immediate local presentation before the host returns a request key.

## Problem

Personal's main conversation can delegate waiting operations and accept amendments, but its desktop previously discovered child decisions through periodic queries and opened them outside the conversation. Native input text appeared only after history placement; queued inputs and lost responses could leave the owner without a visible message. A reconnect or application restart must preserve the original message and decision while work, stopping and publication advance independently.

## Decision

Desktop derives ordinary-tool cards, work progress and report publication from the existing durable records. Card occurrences come from original operation admission and immutable redisplay intents; every occurrence shares the same canonical operation. Supersession retains the old request and approval with its changed-requirements and known-not-executed observation. The renderer uses the house Item, Button and message components, interleaves decisions by occurrence, and renders Assistant prose only after completion and report validation. Personal has no OS notification or Dock badge contribution.

### Owner message admission

An accepted native input commits a versioned, data-only `ruukoto.owner-input-display` entry with its request, submission, body and receive time inside the main admission transaction. It contributes no model messages and leaves native history placement unchanged. Request, submission and history indices associate that display with the original user entry. Projection verifies reciprocal identities and body authority before suppressing the associated raw history row; a contradictory or missing referenced record fails explicitly. Historical cuts before the display still retain their native row.

Only native local-owner text receives this display record. Custom report, question, schedule and IM entries keep their original provenance. Same-key admission returns the existing submission; identical bodies with different keys remain distinct. Queued withdrawal preserves body and anchor as an unanswered input. Existing committed history is not rewritten or retrofitted. The sending desktop keeps a request-keyed local body at a fixed provisional occurrence and replaces its association once the canonical display arrives, under either receipt/stream order. Provisional bubbles require the canonical projection advertised by the current snapshot; older backends use their history-only fallback because their raw user entries have no request key. Each snapshot renews this capability, including reconnect to an older backend. Admission uncertainty is shown only while checking; accepted queued input shows waiting, while placed or completed receipts do not claim uncertain admission. Identical bodies are never used as message identity.

### Observation and exact decisions

Public commit notifications wake a coalesced canonical projection through the existing authenticated stream. List pages and operation-update batches contain at most eight items; owner-status batches contain at most four. Summaries bound targets and work descriptions, while original message and operation bodies remain paged. Each client serializes native events and canonical updates on one queue. A combined snapshot that exceeds the frame budget drops hidden generation/tool previews before displacing durable messages or decisions, retaining run/inbox facts. Commit sequence revisions protect canonical state within a backend run, and subscription sequence numbers detect transport gaps. Reconnection gets a fresh snapshot and inspects cached or unresolved originals outside the first page in bounded batches. No second event history or business state machine is added.

Operation detail pages contain immutable safe parameters and the full prepared execution target, bound to original admission. Mutable decision facts are returned separately, so a decision or unrelated revision cannot corrupt concatenated detail pages. Credential references stay out of this detail. Approval requires complete, parseable original content and matching target/admission; an empty file replacement explicitly says the content will be cleared.

The desktop host saves only the original decision kind, operation and approve/reject choice in its existing profile-bound pending journal before sending. A lost response leaves the card visible and locked, including after application restart. Canonical inspection resolves that original record; a still-pending or failed inspection never permits another POST. Proven non-send or explicit rejection can release the local marker. Connection switching respects pending decisions, and late responses from another generation or profile cannot remove a new profile's marker. Legacy modal decisions reuse their complete canonical summaries and retain the same inspection rule; this does not add optional-family execution freshness.

### Progress and model instructions

Work progress distinguishes accepted instructions, instructions present in actual recorded model-request payloads, answered native inputs and inputs accounted for by termination. An answered input is not proof of business completion. Work state, cancellation request, verified stopping, report publication and delivery remain separate facts. Whole-assignment cancellation uses the existing delegation identity; the composer remains available while external work, decisions or reporting wait.

The shared desktop HTTPS exchange sends an empty JSON object for a POST with no action body, matching the remote entry's JSON contract for work and delegation cancellation. Canonical card inspection cannot clear a different action's failure message; the action that succeeds owns clearing its notice.

Visible member labels, progress and inspection actions share one delegation item with its whole-assignment cancellation. The original owner text remains in its message; it is only a fallback identifier for a delegation whose members are outside the loaded page. Independently paged members remain visible when their delegation is outside the loaded page. Presence prioritizes main processing, pending decisions and active work before report preparation; a registered report waiting for active members does not claim to be preparing the result. Unverified delegation stopping remains visible even without its member page.

Main passes exact owner target, literal replacement content and restrictions to delegated work without adding verification effects or permission. Model-visible guidance belongs at the `background_work.content` parameter, and actual request captures establish what each model received. This is a model instruction, not semantic host validation of arbitrary owner prose.

The existing main prompt owns concise, natural-language progress, redisplay and report answers, including the text-only coordination boundary. It translates query fields and states into an owner-facing conclusion rather than copying internal identifiers from tool JSON or historical replies. Internal identifiers, field names, tool names and versions appear only when the owner asks for technical evidence; exact decision facts remain on the canonical card. A successful operation receipt supports reporting that fact without an unsolicited extra-verification disclaimer. Real-model interaction verifies expression separately from request-schema assertions.

An observed, stopped `write_file` with `file_returned` confirms the complete requested UTF-8 content was written and synchronized. Its tool result tells the model to report that completed write rather than inheriting generic external-operation guidance to check the business result. Unknown effects, failed writes and other operation kinds keep their original interpretation. This receipt describes the completed execution, not a later filesystem observation.

This partially supersedes owner-message timing and out-of-conversation controls in [Personal message bubbles](2026-11-01-desktop-personal-message-bubbles.md), and periodic ordinary-work discovery and Personal notification facts in [Personal HTTPS/WSS](../architecture/2026-10-24-personal-tailscale-https.md). Their house presentation, completed Assistant messages, authentication, original-source authority and history guarantees remain. [Work amendments](../architecture/2026-11-04-personal-work-amendments.md) and [report publication](../architecture/2026-11-04-personal-report-publication.md) retain business authority; this note owns their desktop projection.

## Alternatives considered

- Keep periodic discovery and modal ordinary approvals: reuses the old renderer but cannot establish card arrival before final prose or retain timeline occurrence order. Public commit notifications and existing records supply those facts directly.
- Display an owner authority record before native admission: needs less persistence, but confuses a pre-submit intent with acceptance. Commit a data-only display with the actual submission instead.
- Append synthetic root tool or duplicate user messages: uses native history rendering, but invents model-visible execution or double-counts the owner's input. Keep presentation data separate and verify its native association.
- Page the full mutable operation record: reuses an existing route, but exposes unnecessary configuration and can concatenate different decision states. Page immutable safe parameters and the actual prepared target.
- Keep unknown decisions only in renderer memory: simpler until the application closes, then it loses the original lock. A small association in the existing host journal preserves uncertainty without copying backend approval state.

## Consequences

Native display entries and indices add retained presentation data and admission/projection validation. Bounded projections require explicit history/detail paging, and reconnect inspection preserves a locked card when its record cannot be verified. Older same-protocol backends retain their query/modal fallback; the new owner-display guarantee starts with newly accepted native inputs. Optional families still require their M2 execution integration before a fully configured profile claims amendment freshness.

The M1 profile keeps all ordinary tools and omits optional execution families. The maintained server/stream regression covers file amendment, redisplay, concurrent single consumption, publication, cancellation and held HTTP; renderer and host regressions cover body association, pagination, delayed reads, lost decisions and application restart. Linux, real model and both native-host interaction are separate evidence in [Issue #40](https://github.com/num-lab/Ruukoto/issues/40). Final-file preview/download and broader desktop cutover remain later milestones.
