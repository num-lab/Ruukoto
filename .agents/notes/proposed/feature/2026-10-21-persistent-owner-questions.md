# Agent Note: Register structured questions and continue from trusted answers

Status: proposed

This is the historical shared proposal, not an unimplemented product claim. [Personal answers](../../implemented/feature/2026-10-21-personal-owner-questions.md) supersedes its Personal implementation and initial question-type limit. [Coding questions](../../implemented/feature/2026-10-21-coding-owner-questions.md) implements Coding. The shared rationale below remains; each implementation note owns its actual capability and acceptance.

## Problem

Ordinary chat has no durable question/options, answer receipt, or unique continuation, allowing mismatch across reconnects, clients, and Personal IM rounds. Personal main shares one input queue; waiting for an answer inside a tool occupies the execution path needed to receive it.

## Proposal

ask_user registers questions, immediately returns pending, and ends the current round. Owners answer through a dedicated card/original menu, then continue. Add no Task state and do not block Personal main. One unanswered batch exists per session. The original Personal single-choice/free-text scope is superseded by its implementation; [choice types](../../implemented/feature/2026-10-21-owner-question-choice-types.md) owns multiple choice, recommendation, descriptions, and skipping. Original shared field/budget/scope provenance is the archived `.scratch/agent-tool-completion/spec.md` structured-question section.

Questions clarify business intent, never approve tools. Only actual owner main sessions can ask, including Plan. Children report upward; workflows keep their original ask mechanism. Durable records/model evidence contain registered questions, full actual answers, origin, and authority. Prompts or frontend memory are not answer proof.

Coding consumes questions and creates answer/next Task/events in its existing enqueue transaction. Personal commits answer admission and one continuation Task together, then reconnects to the original Submission with a stable key. Both reuse protocol meaning but keep their own stores/provenance checks. Lost replies after confirmation recover from original receipts, avoiding answered-with-no-continuation gaps.

Ordinary new messages remain chat: neither the word yes nor the existence of a question implies an answer. Only trusted question entry points consume it. Personal binds original platform/account/owner/generation. Continuation uses authority at actual answer time, not a one-time approval at creation. Cancellation, stale entries, and competing clients arbitrate in the consume transaction.

[Workflow answers/delivery](../../implemented/feature/2026-10-13-workflow-owner-input-and-delivery.md) retains run/step identity while sharing version/idempotency/provenance principles. [Waiting/reporting](../../implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md) retains resource release/new input and report authority. [Progressive interaction](../../implemented/process/2026-10-14-progressive-human-interaction.md) governs clients; [Personal entry](../../implemented/architecture/2026-10-17-personal-telegram-entry.md) and [local management](../../implemented/architecture/2026-10-17-personal-local-management.md) own provenance/recovery.

## Alternatives considered

Plain questions display everywhere with minimal work but lack stable references/options/receipts. A waiting tool Promise directly returns to the model but can deadlock Personal main and hold directories longer. ApprovalGate already has pending UI/consumption, but answers cannot grant execution and chat lifecycle must not redefine approval. Workflow tables already have versions/answer transactions but use run/step identity; inventing workflows for chat creates false ownership. Share pure validation/UI, not those records.

## Acceptance criteria

- Narrow regressions cover duplicate creation, one pending batch, competing answers, answer/cancel races, lost replies, and restart continuation. Transaction failure never leaves an answered batch without its unique next Task.
- Personal main still accepts ordinary chat while waiting. Only original delivered-host-menu replies answer; forged/cross-platform/new-generation origins cannot consume.
- Questions, actual answers, and original provenance are reconstructable. Answers consume no tool approval; changed mode affects only new continuation.
- TUI, Desktop, Personal CLI, and IM require real-entry experience acceptance. Original plan provenance is archived `.scratch/agent-tool-completion/issues/02-coding-owner-questions.md`; implementation notes hold current results.

## Risks

Cross-client pending state and unique-continuation arbitration add complexity. Returning pending adds a model round but avoids main-session mutual waiting. Ordinary chat is not auto-associated with an answer, and multiple simultaneous batches are unsupported unless observed need justifies revisiting the limit. Never guess an answer to unblock work.
