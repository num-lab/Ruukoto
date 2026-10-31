# Agent Note: Personal delegations seal explicitly and pin one final report

Status: implemented

Main-conversation admission and send claims use the [short IM platform mutex](2026-10-25-personal-im-updates.md) to select original configuration/fixed handles, not a QQ API captured at startup.

## Problem

[Analysis delegations](2026-10-17-personal-analysis-delegations.md) retain cross-turn members, but idle members do not prove main finished arranging the work. Without summarization/original-entry delivery, the owner must ask about each member. Using the latest main answer can cross-wire reports. Main has only one active turn, so waiting inside a provider on unknown effects would block unrelated chat.

## Decision

Main calls report to finish arranging analysis explicitly. The host transactionally registers one report Task and immutable admission evidence. Registration checks original owner input, active original entry and no cancellation, but permits sealing while members run or effects await verification. The background report Task waits for effect readiness; registration does not reject first. The report reference is also the sealing fact, and shared delegate/append entries reject new members/instructions. Native Task waiting joins every member. Failed results after verified normal stopping still enter the summary honestly; unverified stopping prevents reporting. Cancellation preserves member/report facts, does not close identities and does not abort all of main.

The report Task waits for service effects and stopping across the group's original instructions/additions, then admits fixed text plus a custom entry to main under a stable key. It is reference input with query-only eligibility, never owner mutation authority. The answer comes from that Submission.answer. Report body and send intent commit together. Telegram pins the first owner entry/original message. Pending claim rechecks cancellation/generation; after sending begins, the original attempt records sent/failed/effect_unknown without automatically resending unknown outcomes. The complete report is pageable.

The original delegation goal is a one-line JSON string in the summary reference. Explanation that this is already registered/sealed and the host owns one delivery follows the quotation, so a goal's request to arrange reporting is not the turn's final action. The body delivers verified business results only; it does not make re-registration, reauthorization or send status a new to-do. Quoting adds no authority; read-only gates independently verify eligibility. Saved/sent bodies remain unchanged after template updates and are neither regenerated nor resent.

For ordinary main generation, the unique active Submission's persisted entry kind identifies owner input versus host summary reference. Only when the actual input's last user message matches the original owner-entry user message object-for-object does the host bracket that current owner content at the same position after skill expansion. Image arrays gain leading/trailing text while preserving original parts. Original entries/receipts remain unchanged; existing normalized-input/payload evidence records the projection. Historical references do not change later owner-input identity or force every later input to create new work. Nonmatching synthetic user messages retain source facts without impersonating owner text. This annotation applies only to main requests with the host-installed personal system section. Native compaction uses its own summary prompt and cannot gain owner identity merely because main still has an active owner input. Child/scheduled requests receive no main annotation. Host authorization remains independent.

Model progress/delegations results expose member facts, active/stopped counts, cancellation and pauses, not report-delivery status or whole-report phase. During summary generation, report_result only directs the model to query members/results. Ordinary owner turns may query saved reports/delivery status. A report is generated before sending: its current waiting/running status is not a final business fact. Host, CLI and IM menus retain complete actual state.

Both provider-recording boundaries verify the active report's native Submission, input body/entry, cancellation, entry and group-wide unknown effects. Unknown effects first persist a pause entry for this model attempt, then reject before the actual request so main releases the turn for other chat. The report Task watches service documents for effect/stopping verification. Only an unanswered attempt with persisted pause evidence increments the durable attempt number and creates a new read-only summary input. Ordinary model failure terminates queryably. Each attempt recovers under its fixed key; all share one outgoing identity. Unknown effects discovered again before sending keep the same Task waiting without claiming a send.

A new extension prevents old code recovering the new profile. Recovery verifies the sealing tool's original owner input, exact delegation, admission entry, Task, every report input/pause entry, answer and send relationships, without guessed sources or ignored missing references.

## Related decisions

The original audit searched durable, delegation, summary, final reports and unknown effects. [Migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md), [analysis delegation](2026-10-17-personal-analysis-delegations.md), [model work](2026-10-17-personal-model-work.md), [Telegram](2026-10-17-personal-telegram-entry.md) and [service operations](2026-10-17-personal-service-operations.md) retain their primitives. [Shared IM final reports](../feature/2026-10-02-im-approval-and-final-report.md) remains for Coding/old Personal: it rejected model-declared completion to avoid missing tools, with old work delegation owning the full lifecycle. Durable explicit host sealing closes every admission entry and joins all admitted members. This choice initially covered empty-tool analysis, not independent host services or unimplemented tools; later capability notes explicitly establish their work ownership. No note was wholly absorbed or obsolete.

## Alternatives considered

- Report when original input is answered/all members idle: no new action, but cuts off cross-turn arrangement. Seal explicitly, then join all members.
- Notify for every result: each result is clear, but lacks main's whole-delegation summary and is not final delivery.
- Require all effects verified before report registration: reuses mutation preflight, but even a normally running command's started reservation is unresolved and would prevent sealing during execution. Separate registration from summary eligibility without weakening source pauses or treating recovering started as normal execution.
- Wait inside provider on unknown effects: reuses model input, but blocks main. Let the report Task wait; only durable pause evidence permits another safe model attempt, retaining one send identity.
- Unconditionally retry unanswered report Submissions with new keys: restores progress, but ordinary model failures can cause unbounded cost. Only explicit unknown-effect pauses permit a new attempt.
- Ask the summary prompt to ignore delivery status: minimal text, but real models included their own waiting/running tool state. Remove transient facts from model member queries, without predicting delivery or rewriting answers.
- Put phase guidance first and append the raw owner goal last: direct quotation, but real models made reporting a new to-do. Separate goal reference/current action and end with current report guidance. This ambiguity is not proven to be the sole cause of misreporting.
- Add only an end marker to future references: does not resolve old committed failed references mistaken for later owner input. Preserve history and state the current persisted source, without rewriting/redelivering messages.
- State current source/last-user position only in system text: same-context model checks still queried old work and complete continuation still misidentified new input as old reference. Bracketing current text changed behavior toward new delegation. This is limited model evidence, not proof of actual backend completion/original-entry delivery or provider-side message merging.
- Call main.abort on cancellation: stops reports, but cancels unrelated chat. Retract only that report's queued input; preserve in-flight results without later sending.

## Verification

Join all members/admitted instructions without turning failures into success. Transaction order arbitrates seal/admission races. Summaries do not use the latest unrelated answer. Cancellation, generation change and unverified stopping produce no later sends; already-started sends retain actual effects and unknown outcomes never resend. Unknown pauses recover across restart, with zero requests until both effect/stopping verification complete. A pause after admission repeats only safe summarization and retains one final send. Bad recovery relationships reject before model requests. CLI/Telegram can inspect reports/bounded results.

## Consequences

Delegation summaries automatically return to the original entry while main remains available. The cost is sealing admissions and recovery validation of safe model attempts. Platform sending and durable commits are not atomic; lost outcomes need human verification. Safe summary recovery may cost extra model calls. Explicit sealing depends on main arranging report; unsealed delegations remain queryable without unsolicited final reporting. Real-model habits and owner interaction need independent acceptance. Original checks/gaps are offline at `.scratch/personal-pi-durable/issues/14-delegation-reports.md`.
