# Agent Note: The host pins owner sources for Personal model work

Status: implemented

## Problem

[Long-lived children](2026-10-17-personal-background-work.md) have trusted host lifecycle APIs, but the model cannot delegate or query them. Tool execution APIs do not carry the original Submission. Model-supplied sources or the latest pi.user would hand ownership/authorization to the model; treating child results as new owner inputs would let them create more work.

## Decision

Main installs personal-model-work and background_work, supporting delegate/append/list/result/cancel/close. The model provides business instructions and object references only; the native tool TaskId determines the work key. Model/trusted-host entries share transactional registration, fingerprints, single-work occupancy and cancel/close, not duplicate queues or Task states. Children have no work-management capability. Their original empty external-tool configuration is extended only by the later capability decisions below.

The tool first gets a candidate request key from the active run's unique Submission. In the mutation transaction, native submissionByRequest verifies ID, placed status and pi.user entry, plus root pi.tool, generation owner, LiveDoc.run and the running tool slot. Candidate lookup is outside the transaction because public Tx exposes no SubmissionId lookup; the native records reread inside it are authoritative. Harness explicitly uses one-at-a-time. Artificially mixed inputs still reject mutation rather than selecting the latest. Non-owner input may list/result, not delegate/cancel/close.

New delegation records original permission mode/version. Telegram must match the original direct receipt, Submission and current fixed binding; current defaults cannot fabricate authorization. Both child provider evidence commits retain cancellation/occupancy checks and add original-entry validity plus unresolved same-source service operations. An inactive original binding blocks old-work requests only; recovery neither rewrites historical bindings nor rejects unrelated chats. Unknown service effects/stopping cannot be bypassed through a new child identity. These snapshots alone never authorize external tools.

Results read the completed Submission.answer for original personal-work:<taskId>, in 4096-character pages. Running, failed or canceled states are not successful results. The model list action returns 16 identities per page. Cancellation facts and the active owner source commit together. After joining the original Task, stopped additionally requires normal cleanup and released original occupancy. faulted/orphaned or retained occupancy returns stop_unverified and preserves evidence. Close likewise checks idle state in an owner-authorized transaction and preserves history.

Work/report text pages return offset and totalChars for the complete saved text. Offsets start at zero; nextOffset alone signals another page. No next page does not mean earlier content was read. partial separately identifies model-generation truncation. A real report misdescribed a valid offset=1 slice as a missing first character; keep arbitrary-offset queries and expose slice facts rather than restricting queries or rewriting model text.

First activation with pending inputs/tasks fails before pinning the new extension. Recovery verifies model keys, tool-call entries, work/native Task, permission snapshots and original Telegram receipts. Old code rejects profiles containing the missing extension. Old host-created work recovers from its own records without guessed permissions/tool ownership.

## Later child capabilities

[Child inspection](2026-10-17-personal-subagent-inspection.md) first replaces the empty-tool restriction for fixed read-only checks. [Child service work](2026-10-17-personal-subagent-service-operations.md) adds controlled restart under original WorkTask permissions, cancellation and unknown-effect cleanup. [Durable commands](2026-10-17-personal-durable-commands.md), [MCP](2026-10-17-personal-durable-mcp.md) and [tools/access/artifacts](2026-10-17-personal-tools-access-artifacts.md) own further configured capabilities. None grants child work management or turns persistent context into authority. Original lifecycle/source and helper stop-proof requirements remain.

## Related decisions

The original active-note audit searched durable, background work, SubAgents, source, permissions and cancellation. The migration proposal, background work, [Telegram permissions](2026-10-17-personal-telegram-permissions.md), [service operations](2026-10-17-personal-service-operations.md) and [foundation](2026-10-17-personal-durable-foundation.md) retain separate decisions. Shared delegation/recovery continues to serve Coding without state-machine changes. No note was wholly absorbed or marked for archive.

## Alternatives considered

- Let the model supply sourceRequestId/idempotency keys: simplest interface, but content can impersonate input and retries can create new work. The host pins native tool/Submission relationships.
- Use latest pi.user: avoids active-tool checks, but queued input or post-report history is not this turn's authority. Require one current owner input; ambiguity ends the turn with a report.
- Send every child result immediately: quicker notifications, but not proof that the entire delegation finished and main summarized it; cancellation/sending also need full ownership. Final delivery belongs to the later reporting slice.
- Add service writes and additional instructions in the same slice: more useful, but requires child unknown-operation pausing and input/finalization race handling. First reuse accepted empty-tool lifecycle, then establish real-tool permissions/stopping proof.
- Expose only zero-based offsets and nextOffset: minimal interface, but arbitrary slices cannot describe their relation to saved text. Return position/total length and distinguish pagination from generation truncation.

## Consequences

The model delegates analysis asynchronously while main remains responsive and queries original-work results. Identity/cancellation semantics remain, at the cost of additional tool-ownership/permission recovery checks. Old pending work must finish before enabling model delegation. [Independent host menus](2026-10-17-personal-work-controls.md) share queries/stopping proof without model control. [Additional instructions](2026-10-17-personal-work-notes.md) stay in the original lifecycle. [Delegation reports](2026-10-17-personal-delegation-reports.md) wake main and pin delivery after explicit sealing; [analysis delegations](2026-10-17-personal-analysis-delegations.md) own multi-turn membership and whole-analysis cancellation using that final-report mechanism.

Narrow checks cannot establish full migration or product experience. Original model-entry acceptance/uncovered scope is offline at `.scratch/personal-pi-durable/issues/10-model-background-work.md`.
