# Agent Note: Publish Personal reports against the accepted requirements

Status: implemented

[Complete Telegram delivery](2026-11-06-personal-telegram-delivery.md) extends original-entry sending with per-part coverage checks, independent text/file outcomes and canonical receipt reconciliation. Immutable failure entries keep delivery state at their original entry boundary even when a started part later confirms. Publication, covered-work authority and successor rules remain here.

## Problem

[Explicit delegation reports](2026-10-17-personal-delegation-reports.md) use report registration to seal further work. That prevents ordinary cross-turn amendments, while publishing the main conversation's raw answer can expose a stale summary before its source and coverage are checked. A fast child can also finish while main still arranges another member, and an owner amendment can be accepted before its native conversation input is placed.

## Decision

Accepted grouped work and notes register host report intent in their admission transaction. The trigger is the actual analysis or note admission, with the original owner source and model call retained; registration does not forge a model report call or close additions. The existing explicit report action joins an already registered intent. Independent host work keeps its existing individual lifecycle.

Version-2 report tasks wait independently of main. Before creating an attempt, they require the contributing main inputs to settle, all accepted work and notes to be accounted for, and original effects and stopping to permit reporting. Accepted but unplaced owner inputs delay the check until main classifies them. A status query changes no covered requirements, while a successful append or delegation changes the coverage. Wait subscriptions are installed before condition reads so a settlement cannot be lost between the read and the wait.

Each attempt records immutable coverage of original instruction sources, member admissions, accepted notes, terminal answers and authoritative operation facts. Its stable main submission carries that coverage as a host reference with query eligibility. Actual request evidence records the report task, attempt, submission, source entry and coverage identity. Recovery also binds each native report response to its request, so losing request data or the product identity cannot disguise a draft as compaction. An owner message quoting a report's exact text remains ordinary chat. Both request-recording boundaries and publication recheck the accepted requirements. A changed attempt is retained with an explicit supersession or pause reason; only safe summarization can start another attempt. Ordinary model failure remains unanswered and queryable. Callback faults retain the original task outcome; queries do not retry them, and a later accepted-work admission records that failure before registering a successor.

An immutable `ruukoto.report-publication` entry references the validated raw answer and coverage. It contains no duplicate model message. Normal desktop timeline and WebSocket projections expose that publication as the final answer and suppress its internal inputs, tool traffic, partial stream and raw answer. History still exposes drafts for inspection. Reading a publication resolves the original complete answer through the existing history API, including Unicode-safe pagination. A timeline cut before the publication cannot reveal the draft as a completed result.

Draft projection follows native task ancestry and validates request provenance only for the matching root generation. Child generations cannot own a main report, and unrelated requests do not need repeated backward and forward history validation for every displayed message. Startup still verifies all saved request and response references. The targeted projection preserves that validation for the original report while keeping native attachment within its existing handshake deadline.

Publication and external sending are distinct. Before an unsent claim, the host checks the original destination and current requirements again. An accepted successor preserves earlier published entries and report records; a send that already began retains its original task, content, destination and sent/failed/unknown outcome. Unknown sends never receive an automatic retry under a new identity. Later requirements after safe completion use the explicitly linked continuation from [work amendments](2026-11-04-personal-work-amendments.md), retaining the original delegation's authority.

Terminal version-1 reports retain their original model-report, source, pause, answer and send verifiers. Active older reports require completion with their original program before activation. Versioned admissions, attempts, publications and reciprocal links reject missing, contradictory or orphaned records rather than guessing their source.

This partially supersedes [explicit delegation reports](2026-10-17-personal-delegation-reports.md) for registration, sealing, attempt coverage and desktop publication, and [analysis delegations](2026-10-17-personal-analysis-delegations.md) for the report lock. Original entry binding, owner-input framing, query-only report authority, effect/stopping ownership, cancellation and unknown-send recovery remain. The ordinary-operation invalidation policy belongs to the work-amendment decision.

## Alternatives considered

- Keep explicit sealing: establishes a clear final membership set, but makes normal amendments fail after registration. Wait for settled arrangement and validate a versioned coverage instead.
- Expose the raw main answer and hide it later if stale: reuses existing message display, but the owner can already observe a false final result. Publish only after validation and retain raw history for inspection.
- Copy the answer into a synthetic assistant entry: fits message projection, but duplicates model history and loses the distinction between generation and publication. Keep a data-only publication reference and resolve the existing answer.
- Match drafts by report text or the latest live input: small, but hides ordinary quoted owner messages or loses historical generation identity after reconnect. Persist the actual report reference in model-request evidence.
- Invalidate whenever any owner input is accepted: prevents premature publication, but repeats unchanged summaries after progress questions. Delay until classification and compare the accepted work.
- Replace a published report when new requirements arrive: presents only current work, but rewrites committed history and can abandon an unknown send. Retain published reports and register a successor.

## Consequences

An amendment during summary generation can cost another model request, and settled arrangement is a correctness condition rather than a generation-latency promise. Retained drafts, coverage and publication entries increase inspectable evidence without adding a parallel work scheduler or decision database. The backend contract belongs to [Issue #39](https://github.com/num-lab/Ruukoto/issues/39); real desktop card and renderer consumption belongs to [Issue #40](https://github.com/num-lab/Ruukoto/issues/40). Linux crash ordering, real-model routing and real IM delivery are separate acceptance evidence, recorded in the Issue rather than inferred from mock tests.
