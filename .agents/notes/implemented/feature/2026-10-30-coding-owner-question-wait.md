# Agent Note: Wait for Coding answers within the original task

Status: implemented

## Problem

`ask_user` previously persisted questions, immediately returned pending and told the model to finish its turn; answering created a new queued Task. The owner requires the original task to wait for answers without putting them in the user queue. Merely changing answers into wakeups leaves permanent tool restrictions, premature old-batch execution and orphaned answerable cards after interruption.

Itemized owner confirmation belongs to [the input-lifecycle issue](https://github.com/num-lab/Ruukoto/issues/30). This reverses the original nonblocking-continuation decision; [user queue controls](2026-10-30-coding-user-queue.md) and [report delivery](2026-10-30-coding-report-delivery-boundary.md) own pause and internal-input timing.

## Decision

### Waiting and trusted answers

`ask_user` still transactionally registers persistent questions against the actual Task, host tool operation and original parameters, allowing at most one pending batch per conversation. It then waits through an async host tool and real AbortSignal instead of immediately instructing the model to end the turn. Reuse question states, versions, request digests and receipts. Do not disguise a question as a `RuntimeAgentWait` task/workflow target or add a generic waiting framework or terminal Task state.

A trusted answer atomically saves answers, original provenance, answer receipt and event only while the original question and Task can receive it. Release the waiter only after commit. Create no Task, change no user queue, and do not adopt new default model/mode/granted paths selected in the answer UI. The original Task's explicit mode switches and per-operation permission rechecks still apply; business answers do not approve tools. Register the waiter and reread state to avoid missed commits; an already-aborted signal exits immediately.

Persist answer acceptance order in the same transaction using the answer event sequence and original question identity, not inferred Task creation. Historical recall follows [the user-queue decision](2026-10-30-coding-user-queue.md): the latest structured answer, including Skip, remains unsupported. Turning answers into tool results must not permit skipping them and recalling an earlier input.

`ask_user` writes actual answers as its original tool result. `answered` proves durable acceptance, not model consumption. Question registration, accepted answers, actual tool result and next-request input each have original records; do not introduce another question-execution ledger. Verification of a committed host operation cannot equate question registration with answer delivery.

### Execution barrier before the next request

One assistant response can include both `ask_user` and a write tool. After answer submission or question cancellation, unexecuted business tools in the old batch must still not execute. Return known-not-executed with the actual reason until answers/cancellation and applicable guidance enter the next model request, then restore subsequent tool eligibility. Neither let the old batch race ahead nor retain the old rule permanently disabling tools once a Task has asked a question. The same Task can resume work and ask again.

### Ending the wait

| Event | Original question and Task |
| --- | --- |
| Submit answers, including existing Skip | Save the real answer; original tool returns and Task continues in the next request |
| Explicitly cancel question | Question becomes canceled; original tool returns cancellation and Task continues without a fabricated empty answer |
| Durably accept explicit guidance | Cancel the then-pending question in the same transaction before releasing its wait; next request includes cancellation and guidance, retaining guidance's approval barrier |
| Ordinary message or internal report arrives | Queue the message or retain the report as pending; neither releases answer waiting |
| Close window, disconnect or reconnect client | Only the UI connection changes; backend keeps waiting |
| Pause, cancellation or another cause makes the original Task terminal | Unanswered questions become stale, tool wait ends and answers can no longer wake the Task |
| Backend restart | Retain Coding's interrupted recovery; invalidate old pending questions without restoring a Promise or rerunning the Task |

Cancellation, answers, guidance and stopping arbitrate through synchronous transactions. An answer committed first retains its content/receipt; subsequent stopping cannot mark it unanswered or claim the model read it. Stop intent takes effect before a released waiter could issue a new model request. Abort releases the tool Promise and follows normal finalization so SDK.abort never waits on an unending question.

Do not add an automatic answer timeout or infer answers from ordinary text. Initially retain the execution resource phase and occupancy held before waiting, without automatically yielding/reacquiring directories. Other execution in the same directory may wait; different directories and existing independent work continue under current scheduling. If long answer waits later require same-directory concurrency, separately adopt the existing verified-stop/reference-snapshot/yield-reacquire protocol instead of simply deleting occupancy.

### Receipts and clients

`owner_question_answer` no longer carries model, mode or path parameters for creating a Task. It returns an answer receipt linked to the question and original Task, not a new Task as consumption proof. Reuse original request keys and instance isolation; persist before sending. After a lost response, query the dedicated receipt only: identical key/parameters verify, changed parameters conflict. Old-format pending answers retain their original instance and records; never silently convert them into new-format answers or ordinary submissions.

Questions retain original `taskId` and `hostOpId`; new answers do not write a fake `continuationTaskId`. Clients distinguish batches by question ID and locate cards through the original host operation and actual ask_user history entry, never replacing a user message solely by Task ID. Cover repeated questions in one Task, preserve original requirements/guidance, and handle event-first/history-first/cold recovery. Existing historical continuation relationships remain unchanged.

Desktop, TUI and Code Scheduled show waiting-for-answer from actual pending questions rather than continuous model generation. Question types, Skip, one-batch limits and entry eligibility remain. Scheduled also waits in its original Task, with fixed run provenance, model and permissions. SubAgents, workflow steps and internal summaries gain no question eligibility; Personal durable is unchanged.

## Related decision audit

[Coding persistent questions](2026-10-21-coding-owner-questions.md) is partially superseded: remove immediate return, new answer tasks, answer-time new configuration and old-card continuation after restart, while retaining trusted provenance, persistent questions, single batches, unique answers and non-approval semantics. [Question types](2026-10-21-owner-question-choice-types.md) keeps its types/interactions but changes in-task placement; [Coding Scheduled](2026-10-25-code-scheduled.md) retains provenance/fixed configuration and changes waiting-state derivation. All three retain their original decisions and link to the superseding contract.

The Coding part of the [shared-question proposal](../../proposed/feature/2026-10-21-persistent-owner-questions.md) already has separate implemented decisions, which remain the specific baseline here. Its Personal part and [Personal questions](2026-10-21-personal-owner-questions.md) are unaffected; do not delete the entire note or mark it rejected. [Wait/report ownership](../architecture/2026-10-14-agent-wait-and-report-ownership.md) still owns task/workflow waits; this decision does not expand its target types.

## Alternatives considered

- Keep persistent questions and new answer tasks but hide answers from the queue: smaller UI/storage changes with restart continuation, but the original Task still ends, contrary to the owner's requirement.
- Introduce generic persistent pause/resume: permits original-Task recovery across backend restart, but reintroduces the old-task recovery being removed and broadens execution/unknown-effect recovery. Instead invalidate question cards after interruption.
- Restore all tools immediately after saving an answer: simply clears pending state, but lets old assistant batches execute before the model reads the answer. Keep the barrier through the next request.

## Verification

Owner-question tool, Runtime and client regressions verify original-Task waiting, repeated question batches, answer receipts, old-batch execution barriers, answer/guidance/stop races, restart invalidation and recall barriers. Real-model requests verify original tool results and subsequent input. The owner confirmed real Desktop/TUI product acceptance on 2026-10-31; evidence and scope are recorded in [Issue #30](https://github.com/num-lab/Ruukoto/issues/30).

## Consequences

Tasks and possible directory occupancy persist until the owner handles questions; explicit guidance or stopping still exits. Old cards cannot be answered after backend restart, an explicitly confirmed reduction in behavior, while questions, answers and history remain preserved. Question storage and JSONL are not atomic: stopping or disk failure after acceptance retains the real receipt and reports incomplete delivery without replaying business operations.
