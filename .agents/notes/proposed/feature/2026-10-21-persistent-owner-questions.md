# Agent Note: Register structured questions and consume trusted answers

Status: proposed

[Original-task questions](../../implemented/feature/2026-10-30-coding-owner-question-wait.md) owns current execution and supersedes the initial continuation design. [Single product](../../implemented/architecture/2026-11-10-single-product.md) retires Personal question/IM scope. This proposal retains shared rationale and combined interaction acceptance, not a claim that questions are unimplemented.

## Problem

Ordinary chat cannot reliably distinguish an answer to one question from a new requirement. Multiple pending questions and lost client responses need fixed identity, trusted submission and durable receipts without treating natural-language agreement as authorization.

## Proposal

Questions bind their original task and host operation, with bounded choice/free-text forms and per-question drafts. Trusted question entries submit answers or explicit cancellation under that identity; ordinary chat does not answer them. Concurrent clients, stale state and repeat requests arbitrate through original-key transactions.

Current `ask_user` waits within the same task and returns its actual answers or cancellation. It keeps original model, permission and execution authority. Ordinary messages queue; explicit guidance cancels the pending question and enters the next request. Reports wait behind unanswered questions. Client closure leaves questions waiting; task interruption or backend restart makes unanswered questions stale. Answers are not tool approvals and cannot broaden authority.

[Workflow questions](../../implemented/feature/2026-10-13-workflow-owner-input-and-delivery.md) retain independent run/step identity while sharing original-key and provenance rules. Client recovery queries original receipts and never interprets a lost response as a new question or automatically submits another answer.

## Alternatives considered

- Parse ordinary yes/no chat: convenient, but cannot distinguish a new requirement or another pending question and risks false authority.
- Start a replacement task for each answer: frees the original wait, but loses tool-call continuity and the original authority required by current behavior.
- Assume closing a question window cancels: removes waiting state, but makes navigation mutate work. Require an explicit cancellation action.

## Acceptance criteria

Verify one and multiple question batches, per-question drafts, same-task tool continuation, guidance, cancellation, concurrent clients, stale answers and original-key lost-response recovery. Preserve mixed-tool-batch effect fencing and original permissions. Actual TUI and both native hosts require interaction evidence; mock rendering does not certify it. The retired Personal portion is not planned, not accepted.

## Risks

A question intentionally retains task occupancy and can wait indefinitely for the owner. A stale client must not unlock an unresolved submitted answer without its receipt. Backend restart differs from client reconnect; presenting them as the same event would either lose waits or revive interrupted work.
