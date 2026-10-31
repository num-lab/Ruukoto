# Agent Note: Accept Personal follow-up notes as rounds of the original work

Status: implemented

## Problem

[Background work](2026-10-17-personal-background-work.md) waited for its first Submission, then stopped the child session/released occupation. Direct steer/followUp could be aborted after that answer or leak into another work after identity reuse. [Migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) requires additions to belong only to current work with single-work occupation through cancellation/recovery.

## Decision

First save note body, stable host key and source in the original work document, without direct admission. Original WorkTask submits accepted notes sequentially after the current answer, deriving each request key from original work/note key. After each child execution is fully collected, the final transaction rechecks cancellation/note count. Continue the same work if new notes exist; otherwise release occupation with terminal state. Serialized note/final transactions need no second runtime state or closing flag. Final results point to the last accepted note's answer; native records retain history.

Acceptance rechecks occupation, active task, cancellation, original entry and same-source unknown service operations. Text cannot change original permissions. Model changes still require the current unique owner input. Telegram accepts only direct replies to the delivered original-work menu. CLI uses existing pending recovery with `pending-work-` filenames retaining original work/key; old CLI does not scan them and old lock holders reject unknown files. Lost responses verify only the original key. Extension markers make old code reject new records; separate `/work/notes` prevents an old backend from misrouting additions into main chat.

Recovery reconnects the last admitted round's original key, not replaying from the first answer and aborting pending additions. Before recovery verify note/source, tool action/arguments and native-submission associations. Any round failure stops later notes and cannot return an old successful answer.

[Model work](2026-10-17-personal-model-work.md), [host controls](2026-10-17-personal-work-controls.md), background work and migration retain their distinct decisions. Old shared workflow/Coding owner-input/final-delivery state is not imported into Personal.

### Child-tool acceptance evidence

[Fixed child inspections](2026-10-17-personal-subagent-inspection.md) need original immutable acceptance entries to reconstruct note provenance. New additions all write immutable acceptance. Old single-work history without it remains readable, but unresolved old work cannot simply enable child inspections. [Analysis delegations](2026-10-17-personal-analysis-delegations.md) includes grouped note sources in whole-work pause and verifies original notes through immutable entries; historical single-work notes retain this record's checks.

## Alternatives considered

- Direct steer is faster but a tool-less answer boundary may complete the original Submission before another round, and original-work cleanup aborts already accepted notes. Process explicitly between rounds.
- One background work per addition reuses Tasks but changes occupation/cancellation ownership and can mix long-session work.
- A persisted closing flag freezes acceptance early but adds recovery state. Non-admitting notes plus a final transactional list check suffice.

## Verification

Historical narrow tests cover same-key recovery, finalization races, cancellation and source isolation in the offline work-notes record. Model input retains added text and complete tool definitions.

## Consequences

Additions do not enter generation until the current answer ends; UI must explain timing. Long work grows one business document; retain the simple list until measured growth justifies change. Whole-work reports, external-tool permissions, real IM/models and product experience still require their own acceptance.
