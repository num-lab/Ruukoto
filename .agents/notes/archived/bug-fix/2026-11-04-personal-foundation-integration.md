# Agent Note: Personal foundation integration fences failed instructions and preserves stopping evidence

Status: implemented
Archived: 2026-11-10

## Problem

The combined [M0 foundation](https://github.com/num-lab/Ruukoto/issues/35) joins [same-SubAgent supervision](../architecture/2026-11-02-personal-work-note-supervision.md), [bounded main coordination](../architecture/2026-11-03-personal-coordination-cutoff.md) and [file-job isolation](../architecture/2026-11-03-personal-file-io-jobs.md). A supervisor could submit a new note after its original child input became unanswered; an appended owner input could fail coordination while its old work still authorized that note's write before cancellation registration. Grant revocation reported an unstarted operation stopped while its revalidation was live, and the unresolved-job predicate ignored admission-before-start windows. Removing a note's projection could hide its immutable admission on reopen. Local answer extraction also accepted an empty final response after the fourth tool round.

## Decision

The original WorkTask remains the only note dispatcher. Before draining, it reads cancellation and native input failure on the Session line. When failure or cancellation is observed, it reconnects existing stable submission keys for accounting and leaves unsubmitted notes undispatched. Request recording and every tool origin independently reject work with an unanswered native input, reading the original and note keys even before their IDs have been written back into WorkFacts. This gate covers failure winning after a previously eligible dispatch check without starting another model request or business effect.

Every contributing owner source must remain active: the canonical source, a member's instruction source and each accepted input note. A persisted coordination cutoff fences these sources before cancellation registration finishes, even while the native source still says placed. Valid instruction admission during a running or unknown effect remains separate from request/effect readiness. The failed input never grants an execution exception; existing cancellation collects the exact admitted targets and preserves prior results and effects.

Cutoff copy distinguishes no new cancellation registrations from no prior effects. Completed targets retain their results, so even an empty cancellation set tells the owner to inspect original work/input state before choosing the next action, rather than recommending resubmission.

The accepted [cutoff coordinator](../architecture/2026-11-03-personal-coordination-cutoff.md) appends cancellation registrations and its `model: []` marker in one commit. Parked owner inputs advance through the coordinator-owned final boundary only after the registration barrier clears. No marker is queued. This mechanism supersedes #35's original fixed-key public-write plan while preserving its cancellation, deduplication and queue-progression outcomes.

An admitted file job is unresolved until its validated result, exact worker exit, verified original-host termination or never-started release. This includes preparation and execute reservations before starting. Revocation and supersession derive operation stopping from all its jobs; terminal known-not-executed operations retain original decisions and may gain later exact stop evidence without rewriting their observation. An active tool excludes only its own job from readiness, so reservation-before-consumption does not block itself.

Supervised notes require their immutable admission pointers in admission order. Open-time verification scans original note admissions back to their exact WorkRef and note, rejecting missing projections, duplicate/mismatched relationships or reordered pointers. Version-1 sequential history retains its existing compatibility branch; no committed history or format is rewritten. Local answer extraction requires actual text or persisted handoff facts and reports `answer_missing` for empty or whitespace-only text, without changing the native submission's already committed status.

## Alternatives considered

- Recheck failure only in the dispatcher: smaller, but failure can win after that check and before native admission. The independent request/tool gate prevents effects in that window while preserving native records.
- Qualify only the canonical work source: preserves the initial delegation but grants later failed notes continued authority. Exact contributing-source checks retain the existing source model.
- Treat unstarted operations as stopped: avoids a job lookup, but preparation and revalidation can still own live workers. Original lifecycle evidence is the stopping authority from admission onward.
- Rebuild missing note projections from history automatically: could conceal corruption or reinterpret committed records. Activation fails precisely and preserves the archive for inspection.

## Consequences

The new checks tighten existing behavior without another dispatcher, retry policy, authority exception, dependency or stored version. Reopen adds one reverse note-admission scan. Admitted but not yet started file jobs participate in source, work and settings blockers until verified release or completion; main queries and unrelated work remain available. An empty model answer remains inspectable as native history but callers receive an honest error.

Maintained regressions cover actual forbidden writes after child failure, failed appended-source cutoff before cancellation registration, immutable note corruption, revocation/supersession during both admission and FIFO-held revalidation, invalid-call round counting and empty final answers. Pre-read markers do not establish blocking, so the four-worker capacity fixture verifies original Linux thread IDs and wait channels or macOS synchronous-read stacks before termination. The opted-in model amendment check additionally audits four separate canonical queries, the actual no-tools final request and a mixed arrangement/query answer. External event captures retain actual request definitions and call/result facts while temporary profile credentials are removed. Its result is scenario evidence for the selected model, not a guarantee of routing for every provider. The existing coordination suite remains the mandatory Pi-upgrade gate, including atomic marker deduplication, parked input queues, cancellation barriers and strong-crash recovery.
