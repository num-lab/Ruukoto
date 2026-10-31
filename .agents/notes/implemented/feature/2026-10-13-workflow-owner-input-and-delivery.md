# Agent Note: Workflow business answers and one final delivery for the whole run

Status: implemented

[Next-request report delivery](2026-10-30-coding-report-delivery-boundary.md) supersedes internal-summary FIFO and adds delivery to active tasks. That decision owns the changed report-delivery contract; workflow business questions, original provenance, unique reporting and unknown-send rules remain.

[Wait/report ownership](../architecture/2026-10-14-agent-wait-and-report-ownership.md) now lets an active waiting parent claim results and continue, with the independent tool-free summary as fallback. It supersedes unconditional separate summaries here, not unique reporting, trusted bindings, source checks, or no resend after uncertainty. [Internal report visibility](2026-10-14-internal-report-visibility.md) owns trusted hiding of host prompts.

## Problem

Workflows must let main chat continue, preserve human questions across restart, never treat business answers as tool approval, and report the whole work once. [Execution foundations](../architecture/2026-10-13-workflow-runtime-and-store.md) already had questions/steps but no trusted product answer or final delivery. [Ordinary parent delivery](2026-10-02-im-approval-and-final-report.md) could not identify whole-run dev summaries, and [schedule settlement](2026-10-12-generic-scheduled-tasks.md) looking only at task trees could close a waiting workflow prematurely. Original requirements are offline provenance in retired `.scratch/agent-workflow/spec.md`.

## Decision

Business answers bind run ID, step key, question version, question-creation `runVersion`, complete source snapshot, and stable request key. Other branch progress/script cleanup must not expire a pending answer: `runVersion` identifies question creation, not every run mutation. The run must still be running/waiting; first consumption rechecks current source and question material dependencies. Cancellation/answer race in one synchronous transaction. Pause, stale entry, revoked material, already answered question, or wrong generation refuses new consumption. `workflow_controls` shares one per-run key space for controls and answers: same key/parameters returns its receipt, changed parameters conflict, and reading an old receipt after cancellation never resumes execution.

`ask` may specify at most 20 distinct string choices and bounded basic JSON Schema. Question, constraints, source, answer, step completion, request receipt, and optional IM receipt commit atomically or all roll back. Control accepts IDs/generations/versions/key/JSON answer, not caller-supplied authorization source. Question/answer text is paged by UTF-8 bytes.

`ImWorkflows` parses only complete original `/workflow-question` and `/workflow-answer` strings from adapters, verifying original platform, current owner, account/chat, entry generation, and external-ID prefix. `im_workflow` input ends directly, never entering main's queue/model. Answer receipts use the original `inbound_event` slot. Initial question notifications have independent `workflow_question` provenance and run/step/question-version keys; before send, recheck still-pending status, source, and materials. Failed/unknown sends retain the question; throttling delays the same operation. ApprovalGate still owns tool approval and rechecks workflow eligibility/IM binding at consumption. A business answer never changes approval.

Stop active-time accounting only when the whole script is idle, no result awaits delivery or executable work remains, and all active agents are purely waiting for human questions/approvals. Auto-review in progress still counts. Another unresolved tool on the same task also counts unless it belongs to a pending approval. Approval/answer events immediately reevaluate; one `awaiting_confirmation` column cannot prove whole-run human waiting.

### Original final-summary path

The first terminal transition fixes `terminalVersion`. After stop settlement, save the complete coverage list and bounded result preview, then register one summary under `workflow-final:<run>:<terminalVersion>`. Run/task binding is written in the enqueue transaction; a user-controlled request-key prefix proves no trusted identity. Dev/main/scheduled summaries share original-session FIFO, have no tools, and cannot start workflows. Every model request rechecks run/all-step materials. Dev terminal results enter orchestrator registration with cold-start completion; only backend-restart queues containing summaries alone may auto-resume, not manually paused queues or queues mixed with ordinary input.

Main's summary lacks ordinary `sourceEventId`. Its result transaction registers one `owner_reply` against the original IM event and `<event>#workflow-final:<run>:<terminalVersion>`. Host terminal status, coverage, script-stop three-state facts, verified counts for started execution, unstarted counts, and failures precede model prose so a long summary cannot displace them. Final facts replace stale start/progress status in the source conversation. Verified stop never resolves unknown write effects; retain those warnings.

`delivery.status=reported` means summary result and applicable outbox registration completed, not successful platform delivery; `notification_ops` owns sending. Invalid entry/material records an undelivered reason without retargeting. Failed/unknown operations never get a new key for automatic resend. Cancellation reports contain host cancel/stop facts and do not roll back external effects. Current parent-claim handoff follows the linked wait/report decision while retaining these provenance/outbox distinctions.

Scheduled sources wait for all workflows, actual execution, and whole-run summaries before original `schedule_run` reporting. Aggregate state uses workflow final records and non-workflow tasks; old attempts recovered by safe retry do not contaminate the conclusion. Steps no longer require ordinary wakes. Plan cancellation cascades to runs and records intent even without an executor, rereading each current run version so earlier cleanup cannot stale later snapshots. A step canceling its own plan commits intent then stops asynchronously so the tool can return. If source invalidation makes the next model request write interrupted first, preserve that committed task terminal state while recording run cancellation, `cancelRequested`, and real stop outcome.

The original change used schema 38/protocol 21; these are historical versions. Exact-version refusal retained old profiles for matching code, without migrating/backfilling run authority. [Workflow library/controls](2026-10-13-workflow-library-and-controls.md) owns named definitions and full CLI/TUI initiation/control; original delivery provenance was `.scratch/agent-workflow/issues/06-library-and-ui.md`.

## Alternatives considered

- Reuse approval decisions for answers: shorter waiter reuse, but business choices would acquire tool-approval semantics. Separate questions/receipts/notifications and reuse only outbox.
- Require current run version on every answer: simple optimistic locking, but parallel branches/script cleanup invalidate freshly displayed commands. Pin question generation and check live eligibility transactionally.
- Recognize summary identity by request prefix: simplest lookup, but owners can submit the same prefix. Use durable task binding and transactional source/fixed-body checks.
- Give final summaries all main tools: could fill missing work, but terminal reporting would grant new business/sending authority. Summarize fixed facts with one host-owned send path.
- Derive scheduled failure from every historical task: avoids workflow-aware settlement, but safely retried old failures poison aggregate status. Use complete workflow final records and keep attempts inspectable.

## Consequences

Human questions and tool approvals coexist without blocking ordinary chat. Final reporting can recover registration after restart without resending uncertain effects. Costs include fixed question/terminal generations, trusted summary bindings, and separate reported/sent facts. Full coverage is retained, but model/platform previews are bounded, so long reports require run queries. Unverified stop retains occupancy; cancellation intent does not prove execution exited.

[Workflow foundations](../architecture/2026-10-13-workflow-runtime-and-store.md), [real steps](../architecture/2026-10-13-workflow-step-capabilities.md), [ordinary IM replies](2026-10-02-im-approval-and-final-report.md), [scheduling](2026-10-12-generic-scheduled-tasks.md), and [outbox](../architecture/2026-09-24-scheduler-outbox.md) retain their independent ordinary-path rules. [The workflow decision](2026-10-12-agent-workflows.md) and [joint acceptance](../testing/2026-10-13-workflow-joint-acceptance.md) own wider composition. The original audit found partial overlap, no whole-note replacement.

Historical offline tests used real SQLite, control, Driver, MCP requests, and both adapters with local model/IM substitutes. Commands/review were held in retired `.scratch/agent-workflow/issues/05-owner-input-and-delivery.md` (offline provenance). They do not prove real models, real IM, or complete product experience. [Persistent questions](../../proposed/feature/2026-10-21-persistent-owner-questions.md) shares answer-idempotency/source principles; implemented ordinary [Coding](2026-10-21-coding-owner-questions.md) and [Personal](2026-10-21-personal-owner-questions.md) questions use separate identity rather than workflow run/step questions.
