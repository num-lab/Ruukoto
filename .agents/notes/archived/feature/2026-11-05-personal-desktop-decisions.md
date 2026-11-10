# Agent Note: Personal desktop choices retain canonical records and original request identity

Status: implemented
Archived: 2026-11-10

## Problem

The desktop file loop supplies ordinary approval cards, but optional capabilities and work questions need the same timeline and response-loss guarantees. A question answer cannot become an arbitrary composer message, and a lost recovery response cannot authorize another choice on a new key. Recovery images also need the same complete-image checks as the existing computer settings page.

## Decision

The existing state projection carries family-tagged operation cards and work-question summaries. Original admission and display occurrences order them among completed conversation messages; backend records own source eligibility, terminal state and allowed actions. Renderer detail reads, pending reads, revisions and reconnect checks use family plus operation, with admission checks before adopting a result or choice. A service operation and its inspection can share a TaskId without sharing those records or clearing another family's pending decision. Safe original parameters remain separately paged. Optional fields preserve the older ordinary-tool and query/modal branches. This extends [the file-loop projection](2026-11-04-personal-desktop-file-loop.md); work continuation and effect recovery stay with their owning backend records.

The native host journals an unresolved typed action request before POST in the existing profile-bound pending file. It retains the original family, operation, admission, displayed occurrence, action and request ID, plus the exact answer or observation when applicable. Receipt inspection checks the complete original request before clearing the host journal. The renderer keeps the original choice locked until a fresh canonical read verifies its card or question, including records outside the newest page. A terminal receipt or journal update starts this read after any older detail request, so missed events cannot leave stale controls eligible. Missing, admitted or unverified receipts and failed canonical reads leave the card locked through reconnect and application restart; a definite pre-admission rejection or proven non-send clears only that request. No business approval or recovery state is copied into this journal, and reopening never resends an action. Pending requests also prevent address or profile switching from hiding the original choice.

Question drafts use question identity and version within the current profile. Two questions retain separate navigation, free text and selection state. A single-question single choice submits directly; multi-select waits for Done; a multiple-question batch ends with review. Every submission carries the exact original card and question version. The composer continues ordinary owner coordination. Canonical canceled or stale cards cannot submit old drafts, and an unresolved answer locks only its own question.

Operation cards show checks, immutable owner claims, stopping and observation acceptance as separate facts. Current observations are identified separately from original receipts. A whole-sandbox stop has its own confirmation that identifies loss of memory and unsaved application state; exact execution cleanup uses its separate action. Computer observation acceptance requires all current images to be complete, hash verified and successfully displayed. The timeline and settings page share bounded image decoding and hash verification; a later observation invalidates old images and their load callbacks. Timeline image reads first obtain the bound profile's current MCP revision and carry it through every image page. Settings and image responses must match the paired profile's ID and directory values; JSON property order does not define profile identity. The existing settings parser verifies that revision without changing the original operation, observation or execution authority.

## Alternatives considered

- Keep optional approvals and questions in query-only dialogs: reuses the prior UI but cannot establish proactive card arrival or concurrent work-question presentation. Extend the existing timeline projection instead.
- Keep action uncertainty only in renderer memory: saves a small host record but permits fresh requests after application restart. Journal the original intent without duplicating business state.
- Treat selection as ordinary chat: uses the composer path but loses exact question, source and continuation identity. Submit the verified card response through the fixed action interface.
- Duplicate image validation for timeline recovery: avoids touching settings but gives the same completeness requirement two implementations. Share the existing read-and-verify mechanism.

## Consequences

The host retains exact unanswered action content until a receipt establishes its state. A missing receipt can leave that choice locked for further inspection; it is never evidence of nonacceptance. Bounded pages require explicit reads, and reconnect inspects cached originals outside the first page. Pure UI and host regressions cover draft isolation, direct versus reviewed submission, lost responses, application restart, source-field rejection, stale actions, typed stream validation and complete image display. Real native interaction and recovery across the configured execution families remain separate acceptance evidence in [Issue #42](https://github.com/num-lab/Ruukoto/issues/42).
