# Agent Note: Coding schedules pin configuration and run in independent development sessions

Status: implemented

[User queue controls](../../proposed/feature/2026-10-30-coding-user-queue.md) proposes removing the continuation exception; [in-task questions](../../proposed/feature/2026-10-30-coding-owner-question-wait.md) proposes answering through the original waiting task. Neither is implemented; fixed provenance/configuration and Scheduled ordinary-submission restrictions remain.

## Problem

The owner requests Code Scheduled with title, repeat/time, Instructions, workspace, permission, model, and effort. The old desktop placeholder and personal scheduler's main identity/model/tools cannot supply selected-workspace Coding execution. The confirmed first release uses once/daily/selected weekdays, directly executes in the chosen workspace, and uses new profiles after the schema change. Original progress/acceptance is historical offline `.scratch/code-scheduled/issues/01-code-scheduled.md`.

## Decision

### Configuration and UI

Scheduled is a separate Code page with existing list/form/run-record components; switching pages preserves chat tabs. List title/rule/next time/workspace/latest run status. Support create/edit/pause/resume/cancel; cancellation preserves plans/history, not physical deletion.

- Title is required, nonempty, may duplicate, and names the run session.
- Repeat is once/daily/weekly; weekly allows multiple days and weekdays maps Monday-Friday. Time is local HH:mm; once also has a date and must be future at save.
- Instructions are required and self-contained; no automatic other-session/previous-run context.
- Workspace is an existing registered root, verified at save/trigger and used directly.
- Permission is AccessMode confirm/auto-review/full_access, default confirm with explicit full-access choice. Plan is a work style, not a permission option; scheduled tasks set planMode=false.
- Model/effort uses ModelSelection (provider/modelId/thinkingLevel), existing model menu/effort control. Defaults may prefill but save resolves an explicit available model/level. Later defaults do not change it. Switching model uses existing level-retain/fallback logic and displays actual choice; unavailable trigger-time selection fails without substitution.

Pin creation machine IANA timezone and display it; later machine-zone changes do not change plans and no zone picker is added. Reuse Temporal `channels/scheduler/time.ts` with compatible DST (gap forward, earlier fold).

### Durable execution ownership

Add Code-specific plan/run/write receipts in core, using Store transactions/events and a runtime coordinator. Existing queue/Driver executes tasks; reuse time calculations, not personal scheduler/state/durable wiring. Plan stores configuration/normalized rule/workspace identity/version/enabled/next due. Each admitted run pins immutable configuration, scheduled instant, delay/coalesced range, and session/root-task backlinks. Runs own scheduling/whole-result facts; Task remains execution authority. Edits never rewrite accepted snapshots.

Dedupe by plan/config version/scheduled instant and uniquely constrain one unclosed run per plan. Run/session/root task/task ownership/next due/events commit together before queue start/broadcast. Model/directory preparation may happen outside, but transaction rechecks version/enabled/preparation. JSONL stays on existing execution paths and is not atomic with SQLite.

Each run uses a new ordinary dev session/Coding tools with host-verified coding-schedule provenance, propagated through descendants, workflows/reports, question continuations, and background processes. Renderer/model/ordinary submit cannot set it. A named source resolver verifies plan authorization/run snapshot/current task backlink, never source-string-only approval. Do not impersonate coding-owner or personal scheduled identity. Browser and other tool gates recognize verified schedule sources rather than misclassify them as IM.

Busy workspace stays queued under existing occupancy wakeups and displays waiting-for-workspace, not a new execution state. SubAgent/workflow/questions/background keep ordinary Coding capabilities with source checks/persistence/recovery/report consumers wired together. Answer continuation registers original run ownership in its admission transaction; canceled-source late answers create no task. Missing/unverifiable source stops with a queryable reason.

Unclosed-run sessions are host-managed: control rejects ordinary submit, session mode/model edits, and task mode switches, with UI disabled accordingly. Approval, question answers, and existing safe continuation remain, pinned to run model/permission with client overrides rejected; new input is recorded under the run. After closure, new manual chat is ordinary Coding, never reopens or rewrites old run results. Historical task ownership still identifies run content.

Creation pins model/permission, not one-use approvals or other tasks' path grants. Recheck workspace/current tool configuration each time; permission edits affect future runs only. Tool approval/account limits/occupancy/stop verification remain, with no unattended auto-approval. Do not copy workspace/tool settings into a second plan configuration; actual model input remains recorded.

### Lifecycle, recovery, and reporting

Backend scheduling continues when desktop closes/disconnects; reconnect queries stored results. Sleep/backend downtime has no wake/on-time guarantee: without unfinished work, catch up at most the latest occurrence and record missed range. Existing runs waiting on approval/answer/directory/children coalesce misses without another run/backlog.

After restart, accepted-but-unstarted work keeps run/task keys but follows Code's paused-queue owner-resume protection. Started work retains interrupted/unknown facts, never redo; unresolved activity/effects block new runs. Unavailable model or missing/replaced workspace records the unstarted reason and pauses future triggers until owner repair/resume, with no model/directory substitution.

Pause stops future triggers while current work continues; resume skips manually paused periods. Edit versions future configuration and recalculates next time without overlap or changing current snapshot. Cancel persists intent before blocking new/continuation work and stopping all run activity; keep history/results. A completed or explicitly failed once-plan ends. If paused once time is past, resume asks for a new date rather than secretly running immediately. Ordinary periodic failure permits a later new period, not automatic retry; unknown effects/unverified stop must first be resolved.

Unknown recovery is two-stage. First verify active/unreaped local execution stopped through existing stop/special recovery; plan resume cannot bypass occupancy. Then, if execution stopped but external effects remain unknown, show paused/unknown. The owner may explicitly retain this run's unknown result and allow future periods. Bind confirmation to current run/expected version, persist receipt, mark run interrupted while preserving original effect_unknown, and compute the next period strictly after confirmation. In the same closing transaction invalidate unanswered questions, mark noncontinuable result reports/terminal-workflow reports undelivered, and close the run. Do not claim effect verification, catch up the paused range, continue, or resend old operations. Once-plans only close and require date editing to run again.

Root-task completion is not whole-run completion. Before closure check descendants/workflows/questions/pending injections/required reports, active background processes, and unverified occupancy; idle SubAgent identities do not block. Long-lived background work keeps the run active until existing stop controls finish it. Do not add another summary protocol; link existing session/derived results.

List approval/answer waits and open the original session. Reuse desktop notification transport, but scheduled completion/failure comes from whole-run closure, not first Task completion. Approval retains existing notification flow. Desktop exit does not promise notification delivery; results remain queryable. No IM push is added.

### Writes, failure, and fresh-profile policy

Typed owner-authenticated control operations cover create/edit/pause/resume/cancel/list/detail/request lookup through the existing Code bridge, without another preload privilege. Stable request key + parameter digest and expected versions give same-request receipts, differing-parameter/version conflicts. Lost responses use original-key lookup, preserve drafts, and never replay on another instance. Upgrade protocol for new source/operations/events and reject old clients rather than ignore facts at the same version.

Trusted entry checks bounded fields, time rule, actual workspace, mode, model/level. Translate helper failures to coded types; callers never parse messages. Persistence failure rolls back and starts no task/false success. Corrupt source or uncertain effect remains visible, not merely logged.

The owner chose independent fresh profiles for development, acceptance, and activation. Monotonically advance schema and retain strict rejection of both older/newer Code databases. Leave original SQLite/JSONL/artifacts/credentials unmoved, unchanged, undeleted and readable with matching code. No additive migration, old settings/history/grant copying, or conversion is authorized. Initialize the new profile normally.

Offline import rejects sources containing Code plans/runs/receipts/scheduled provenance rather than dropping identity and importing as owner tasks or activating plans. Sources without them retain existing rules.

## Related decisions

This partly supersedes Coding's no-scheduling scope in [generic schedules](2026-10-12-generic-scheduled-tasks.md) and [two products](../architecture/2026-10-02-two-agent-products.md). [Personal durable scheduling](../architecture/2026-10-18-personal-durable-scheduled-work.md) supplies independent-source/whole-run precedent, not shared state. Reuse [new chat](2026-10-20-desktop-new-chat.md), [effort](2026-10-24-desktop-effort-slider.md), [questions](2026-10-21-coding-owner-questions.md), and [background processes](2026-10-21-coding-background-processes.md), extending source applicability without changing their controls/stop proof. Other personal entry/native/import/background, workspace packaging, and sidebar ownership are unchanged. No note is wholly absorbed.

## Alternatives considered

- **Enable/extend old scheduler tables:** reuses scanning/dedupe/cancel, but personal main/temp-directory/creation-authority/IM assumptions permeate it and risk executing old plans. A Code coordinator changes fewer contracts; share time and proven lifecycle rules only.
- **Desktop timer submits at due time:** little UI/code, but cannot own reliable admission/recovery across window exit/sleep/reconnect/lost response.
- **Reuse one chat every period:** convenient history, but old context and shared questions/queue blur run boundaries. Fresh sessions with a linking history page are clearer.
- **Create worktree every time:** isolates changes, but restricts non-Git work and adds integration/copy management. Owner chose direct workspace execution with occupancy.

## Verification

Required evidence maps saved/read-back fields to actual directory/instructions/permission/model/effort; time/zone/DST and default changes; admission/edit/cancel/restart races and original-key lookup; real scheduled provenance through SubAgents/workflows/questions/background; rejection of forged/canceled sources before model/tools; whole-run waits/stop proof; desktop result navigation and unaffected personal/ordinary chat.

Offline regressions cover durable admission, key lookup, pinning, answer/descendant ownership, cancel/restart/unknown recovery. Dual-shell builds, independent review, and real-environment acceptance are separate records in the offline task evidence; mocks/browser fixtures are not real-product acceptance. This migration reruns none and invents no acceptance result.

## Consequences

Direct execution can modify user files. Occupancy coordinates this instance only, not external editors/Git/processes; full access uses existing backend-account rights and cancel cannot undo effects. Source ownership spans many consumers, so missing wiring can reject valid tools, continue after cancel, or start the next period early; this is not just a form plus timer. Background work/questions/unknown effects may block indefinitely and need visible cause/action.

Sleep can miss the useful business window; fresh profiles require setup and old profiles need matching code. No hourly/monthly/cron, system wake, cloud scheduler, run-now, model-managed scheduling tools, or new sandbox is included.
