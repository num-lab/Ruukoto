# Agent Note: Deliver Coding internal reports in the next model request

Status: implemented

## Problem

Trusted host provenance already classified internal reports as non-owner input, but fallback summaries shared FIFO with user messages. The owner requires reports not to occupy the user queue and active tasks not to wait until termination to receive them. Hiding the panel, prioritizing fallbacks or calling steer alone cannot jointly establish timely delivery, reverified provenance and unique reporting.

Owner confirmation and implementation tracking belong to [the input-lifecycle issue](https://github.com/num-lab/Ruukoto/issues/30). [User queue controls](2026-10-30-coding-user-queue.md) owns manual pause; [in-task questions](2026-10-30-coding-owner-question-wait.md) owns answer waiting.

## Decision

Handle only existing trusted `internal_report`: workflow final delivery, existing wait-related supplemental reports and parked aliases. Do not give ordinary unwaited SubAgent results/messages new automatic wakeup behavior or infer report identity from text/request-key prefixes.

### Admission to an active task

If a report arrives during model request N, do not cancel the request or started tools. After all of N's tool batches settle, admit it at the next safe boundary into request N+1 of the same Task. Reuse Driver `finishTurn`, `prepareNextTurnWithContext` and `prepareRequest`, without another model loop or second Driver for the conversation.

`finishTurn` only reserves reports requiring continuation. After acceptance verification of response N finishes, next-turn preparation fixes the report batch and persists actual input/provenance markers; `prepareRequest` verifies persistence and binds it to this request. Only a valid N+1 response permits consumption. Reports arriving during preparation before the cutoff join the batch; later arrivals wait for the next boundary. Never write new input during N's `finishTurn` and let a late N `turn_end` misclassify it as model-consumed.

An otherwise continuable natural ending with pending reports starts the next turn. Errors, aborted/explicit stops and SDK noncontinuable endings retain precedence. Reports arriving after task closure, failing admission or lacking reporting rights retain their original fallback; timely delivery does not authorize restarting the old Task. Manual pause blocks further requests in current execution and independent fallback dispatch.

### Reporting rights and provenance

Reuse `agent_reports` claims, parking, consumption, final proof and original fallback Task/request keys. Do not route through `task_guidance` or cancel a fallback as `converted_to_guidance`. Only an unstarted queued fallback can transfer reporting rights; a running/completed fallback cannot. Shared canonical fallbacks are claimed as their original complete group.

Active non-wait tasks may also receive reports. Group reports from different original tasks in the same conversation by provenance, then verify, claim and finalize each group. Replace the restriction requiring every report received by a Task to share one original source. Do not merge authority or silently defer valid different-source reports until termination. For summaries represented only by `workflow.delivery`, register the report through the real run, terminal version and provenance while retaining the original fallback identity.

The receiving Task keeps its identity, model and permissions, does not replace `workflow.delivery.taskId`, and inherits no source's higher authority. Reports are sourced work material, not owner guidance with approval-invalidation or wait-release authority. Reverify every group's dependencies for each request, final report and applicable external send. Invalid sources converge from their original undelivered facts; corrupt or unverifiable associations explicitly block affected input without guessing or leaking text.

Receiving a report does not transfer ownership of its original work. Stop/recall closures for the receiving Task follow original derivation and trusted work ownership, not claim/consumption links to another source's work. Cancellation of a report's own source still blocks delivery under existing eligibility rules.

### History, model input and display

Use verified public SDK input hooks to admit text, persisting host report keys, original provenance, fixed text and actual message references in the same JSONL. Reuse `ruukoto_agent_report_context` rather than adding a global message ledger. Dynamic admission extends existing `agentReportInput`, input proof and recovery reads. An in-memory claim is insufficient; a fallback's summarize-only instruction must not constrain the entire active Task.

Claiming, history admission, valid model acceptance and final `reported` are separate. A claim, prepared send or custom marker alone cannot prove model acceptance; verification must associate actual effective messages with this response. Unconsumed reports and failed receiving tasks recover through existing fixed fallbacks without new keys or copies. Final report completion still requires the original group's complete input and successful-result proof, not every API return marking it `reported`.

Derive input purpose from verified report references to individual history entries; never hide the receiving Task's original user input. Live events, history-first delivery, snapshots, pages, input history and cold recovery use one classification so internal input never flashes as a user bubble or queue count. Effective history, recall omissions, context selection/compaction, branch provenance and consumption verification use actual contributions; retaining a custom marker after omitting its text cannot prove delivery. Existing independent branches/side chats stay unchanged and do not copy active reporting rights.

### Idle and waiting conversations

With no active task, run the existing tool-free summary. Runnable internal reports precede user-queue work; reports retain their existing stable order. Candidate selection and the recheck immediately before execution use the same rule. Parked or not-yet-ready groups do not block the user queue head; no priority configuration is added.

During `ask_user` waiting, persist reports as pending without waking the task. Once an answer, question cancellation or explicit guidance ends the wait, admit pending reports in the next request together. Only explicit resumption clears manual pause; report/restart recovery cannot incidentally release user dispatch or unverified occupancy.

## Related decision audit

[Wait/report ownership](../architecture/2026-10-14-agent-wait-and-report-ownership.md) and [workflow final delivery](2026-10-13-workflow-owner-input-and-delivery.md) partially change from waiting-parent claims/independent FIFO to model-boundary admission, retaining groups, provenance, parking, consumption and unique final proof. [Internal-report display](2026-10-14-internal-report-visibility.md) extends to user queues and dynamic report entries without changing trusted classification or reconstructible text. Existing notes retain their original decisions and link to the superseding contract.

[Queue guidance](2026-10-28-coding-message-control.md) contributes only SDK boundaries, not owner identity or approval effects. [Complete history](../architecture/2026-09-19-preserve-session-history.md) still requires reconstructible actual input. Personal report, IM and outbox decisions keep their scope; no note is completely absorbed or proposed for deletion.

## Alternatives considered

- Prioritize fallbacks after the current Task ends: smallest change and one Driver, but the owner explicitly requires N+1 admission, not queue priority alone.
- Send reports through ordinary guidance: reuses persistence/SDK batches, but imports owner identity, fallback cancellation, approval invalidation and wait release. Reuse only the boundary, preserving separate report ownership.
- Start a parallel tool-free summary: avoids waiting, but concurrently writes the same history and violates single execution/report claims. Do not use it here.

## Verification

SDK and Runtime report regressions verify N-to-N+1 delivery, late cutoffs, independent sources, parked fallbacks and actual input/response consumption proof. Combined branch/compaction tests and real-model request/JSONL evidence verify reconstructible report input. The owner confirmed product acceptance on 2026-10-31; evidence and scope are recorded in [Issue #30](https://github.com/num-lab/Ruukoto/issues/30).

## Consequences

Reports can add a turn to an active task and precede queued owner input when idle. Continuous reports can delay user tasks; the design does not add a fairness scheduler. Dynamic input and multi-source claims broaden provenance/recovery changes; omitted consumers risk duplicate reports or unreconstructible input. Answer waits and long tool batches still delay reports as an explicitly confirmed safety boundary, without preemption.
