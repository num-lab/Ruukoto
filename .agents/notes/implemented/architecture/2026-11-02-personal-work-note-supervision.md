# Agent Note: Supervise accepted Personal work notes in the same SubAgent

Status: implemented

## Problem

[Personal work notes](2026-10-17-personal-work-notes.md) delivered each accepted follow-up as a separate round: the task submitted one input with `whenBusy: "reject"`, aborted the child, settled resources, then read the next note. That sequence could not steer an accepted note into an active run, replayed recovery through rounds that already answered, and left notes admitted between the last answer and resource release without a durable outcome. Admission also conflated durable acceptance with execution readiness: a paused source rejected notes that should be recorded and wait, making append-time rejection an unreliable signal about what was actually accepted.

## Decision

Partly superseded by [request-bound work amendments](2026-11-04-personal-work-amendments.md): WorkTask version 3 retains this supervisor, records requirements actually present in each model request, supersedes older unstarted ordinary operations on append, and explicitly links safe terminal continuation. Version-2 terminal supervision records still verify under the rules below; live older work requires original-program handling before activation.

The original `PersonalWorkTask` (version 2) is the single supervisor for the whole work. It submits the original input with `whenBusy: "reject"` and every accepted note with `whenBusy: "steer"` to the original child conversation in admission order under the stable native keys (`personal-work:${taskId}` and `personal-work:${taskId}:note:${requestId}`), records each submission ID only after submission succeeds, and supervises every tracked submission until it settles. The conversation's own inbox/boundary machinery delivers queued notes into the active run or the next run, so one SubAgent identity keeps answering across multiple runs instead of being aborted and released after the first answer.

Resource collection happens once per work end, on completion, cancellation or failure, followed by one final transaction that rechecks cancellation, work ownership and occupation, and whether notes were admitted during finalization; those notes resume the same task and identity. Queued inputs left behind by a failed or aborted run are honest failure truth: the work reports them unanswered and never replays them under new keys; accepted notes that were never submitted remain recorded as `not_submitted`.

Admission is separated from execution readiness. `appendPersonalWork` keeps the identity, duplicate-key, source, entry and delegation checks, accepts durably even while a source effect is unverified, and returns `{ accepted: true }` or `{ accepted: false; outcome }` for terminal or already-deciding (`completing`) work instead of `work_inactive`. The existing model-request gate still decides whether a child request may execute: unverified service effects, paused delegations and inactive original entries stop the request, not the note record. Status and result APIs report each accepted note by its stable request ID with its submission status or `not_submitted`, so callers can distinguish admitted, queued, answered and unexecuted notes.

`verifyPersonalWorkNotes` is version-aware: version-1 records keep the sequential chain where a note may not cross an unfinished previous submission; version-2 records allow overlapping inputs and shared answers but require monotonic native submission IDs with no gaps, and a completed task's final result must reference the last submission. Reopening gates task version by lifecycle state rather than blanket rejection: a live task whose recorded version differs blocks the profile as `task_version`, a terminal record verifies under its recorded version's rules, and a record newer than the program is never accepted.

## Alternatives considered

- Sequential per-round processing (superseded by this decision): aborting and collecting after every answer was the mechanism that broke steer delivery and orphaned finalization-window notes; keeping one supervisor preserves the same admission contract without reintroducing per-round abort.
- Replaying queued or undelivered notes under new request keys after failure or reopening (rejected): a sent request without conclusive response is never retried as if unsent; stable keys make recovery reconnect the same submission instead.
- A second queue or dispatcher beside the conversation inbox (rejected): the durable conversation already orders and delivers queued steered inputs at boundaries; a parallel scheduler would duplicate that authority without new guarantees.
- Rejecting notes while a source effect is unverified (rejected): admission is the durable record the owner authorized; execution readiness is a separate gate that already blocks the model request, and conflating the two made accepted state unreportable.

## Consequences

Work that was running under version 1 blocks reopening on this code (`task_version`) and must finish under the old program first. Notes admitted while a source effect is unverified stay durable but execute only after the existing gate clears; the result API exposes that state instead of hiding it. A work that ends unsuccessfully reports each accepted note's real outcome rather than a single round answer, and the finalization transaction remains the only place that can admit notes after the last tracked submission settles.
