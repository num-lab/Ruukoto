# Agent Note: Resume Coding questions and consume answers in one transaction

Status: implemented

[In-task questions](2026-10-30-coding-owner-question-wait.md) replaces immediate pending results, answer-created continuation tasks and continuation from old question cards after restart. That decision owns the replacement execution contract; this note preserves the original decision and its retained trusted provenance, unique-answer and answers-not-approvals constraints.

[Coding schedules](2026-10-25-code-scheduled.md) supersedes the original scheduled-source exclusion: trusted schedule roots/continuations preserve coding-schedule provenance and that turn's pinned model/authority; canceled/closed/missing reverse bindings refuse continuation. Ordinary owner input retains coding-owner provenance. [Question types](2026-10-21-owner-question-choice-types.md) supersedes initial single-choice/nonempty-answer/UI-top-action/query-budget/version choices. Other provenance, transaction, recovery, and message-position rules remain here.

## Problem

Plain-text questions cannot reliably persist choices, answer provenance, or cross-client consumption. Blocking tools prolong tasks/directory occupancy; consuming first and asynchronously submitting later can strand an answered question without continuation.

## Decision

`ask_user` is available to genuine ordinary Code owner-input tasks, including Plan, with eligibility verified from task/session/host operation. The initial form supported 1-3 questions (up to 2000 characters), each with 2-5 distinct nonempty choices (up to 200 characters), always allowing free text (up to 4096). Later question-type rules govern current forms. SubAgents, workflows, GitHub, and internal summaries gain no eligibility; the schedule exception is explicit above. [Personal questions](2026-10-21-personal-owner-questions.md) uses its own durable integration rather than these tables.

`owner_questions` records complete questions, originating task/tool operation, actual input, and authority snapshot. At most one pending batch per session. Same host operation returns its original result; another creation cannot overwrite pending. Creation immediately returns pending. Driver uses that durable fact to narrow this task's assembly/pre-send tool set/execution checks to host-status queries, allowing explanatory output and turn completion. Other owner tasks retain their tools. Add neither a Task state nor waiting occupancy.

The trusted answer entry builds the next input from questions/options/actual answers. Its private host binding cannot be specified through wire, chat, or model parameters. `Runtime.submit` checks original-key duplication before execution preflight. The admission transaction creates the unique Task, consumes the question, records answers/actual answering provenance/authority, stores `owner_question_receipts`, and emits state events together. Failure rolls back all; respond/broadcast only after commit. Ordinary owner continuation uses the model/mode/grants at actual answer time, never an old approval; scheduled continuations use their explicitly pinned policy.

State is pending to answered/canceled/stale; terminal states/versions cannot be overwritten. Explicit task cancellation invalidates pending questions in the same transaction. Natural completion, new chat, archive, disconnect, and restart preserve them. Independent card cancellation stores only terminal state/receipt. Synchronous transactions arbitrate answer/cancel; identical original-key replay returns the receipt, mismatched parameters fail.

### Clients and history

TUI `/questions` and Desktop guide each choice/free-text response and final batch review. Programs manage question IDs/versions/stable keys. Answer uses SubmissionGuard; cancellation uses the shared guard. Persist original parameters/data-instance identity before sending. On lost response, query the original receipt; verify its full parameter digest even when committed. Retain mismatched-parameter conflicts. Only proven nonadmission permits same-key retry. A normal Task with the same key is not proof of answer consumption: require the dedicated receipt.

The original owner-supplied card reference led to a question header, numbered choice rows, free-text row, and bottom navigation using Button/ToggleGroup/Collapsible. Store full selected text; show only handwritten text in the free-input row. Folding preserves drafts; cancel on a folded card expands for confirmation first. The reference did not authorize skipped questions, option subtitles, or recommendation fields. Current type/interaction changes belong to the superseding note.

An answered Desktop card replaces its user message in place by same-session `continuationTaskId`, preserving the message container/time. No duplicate at stream end and no replacement for ordinary chat, Personal, or child sessions. Original text stays in history/model input; do not infer answer identity from text prefixes. Questions/history may arrive in either order: retain the original message until its record arrives, then replace. Pending/canceled/stale cards have no continuation and stay independent. Build one task-association map per render, not a history reorder per message.

Queries prioritize pending and page without truncating questions/answers. Initial limits were 20 records/128 KiB, with snapshot previews fitting both a global budget and the complete frame; the question-type decision owns current budgets. Both clients supplement snapshots/selected sessions with the recent page, rejecting late pages that regress events. Oversize catch-up uses the existing no-cursor snapshot. Question projections only advance. Raw answers/normalized input persist in question/Task; SDK history/prompt snapshots follow existing recording, with no SQLite/JSONL atomicity claim.

Schema 47/protocol 34 were introduction versions, not current compatibility promises. Strict versioning requires matching code; instance import with questions/receipts refuses rather than dropping continuation bindings. SDK tool declarations with no required fields emit an empty required array: the actual provider interpreted an omitted value as null and rejected the entire request. Fix shared assembly, not one tool; keep all parameters optional and verify the actual prompt snapshot.

[The shared proposal](../../proposed/feature/2026-10-21-persistent-owner-questions.md) retains cross-product intent. [Workflow answers](2026-10-13-workflow-owner-input-and-delivery.md) supplies idempotency/provenance principles, not run/step reuse. [Progressive interaction](../process/2026-10-14-progressive-human-interaction.md) guides clients; [wait/report ownership](../architecture/2026-10-14-agent-wait-and-report-ownership.md) retains natural completion/new-input semantics without lending its waiting state.

## Alternatives considered

- Block inside the tool: simple same-turn return, but holds execution/directory resources. Use durable nonblocking continuation.
- Reuse approval/workflow questions: existing controls/transactions, but they mean operation authorization or workflow steps, not ordinary session input. Reuse UI parts, not identity/storage.
- Consume then submit asynchronously: less submit code change, but failure breaks the continuation link. Bind the unique Task in the consuming transaction.
- Treat normal chat as an answer: no special card, but cannot distinguish conversation/choice/actual consumption provenance. Only trusted question entries consume.

## Consequences

Two business tables, two client entries, and a subsequent model call buy cross-client single consumption and recoverable receipts. The one-pending-batch limit remains; initial single-choice limits have been superseded. Incompatible versions require matching clients/data policy; no question-record migration was added. Historical `.scratch/agent-tool-completion/issues/02-coding-owner-questions.md` held storage/SDK/original-key/transaction-failure/import checks and separate real-model/client evidence. It is now offline provenance, not proof that every external acceptance requirement has been verified by mocks.
