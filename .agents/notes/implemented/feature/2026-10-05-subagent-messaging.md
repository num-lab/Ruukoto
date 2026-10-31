# Agent Note: SubAgent messages and collaboration within one work

Status: implemented

Original source: ADR 0020, work messaging and collaboration supplement.

## Problem

Several SubAgents on one [work delegation](../architecture/2026-10-03-work-delegation-subagent-task.md) need attributable messages, and main needs to add instructions. Identities are reusable and busy/model-preflight states delay delivery. After reuse, old collaborators and late messages must lose eligibility, and messages must not grant tools or data.

## Decision

1. A delegation carrying both work_id and sub_agent_id joins an existing idle SubAgent to an existing read-only work with one execution task. The work row retains its initial assignee; task.sub_agent_id identifies participants. Reuse/continue/join share [reuse/close](2026-10-04-subagent-reuse-close.md) eligibility, race arbitration, and union-of-sources checks. Join idempotency is scoped to target Agent session, so different collaborators can use the same key independently. Modification work remains single-writer; fixed single-Agent host review cannot accept joins.
2. Derive sender from the initiating task, never model parameters: a parent-session task is main and must name a recipient; a participant's task can send only for its own work. Other sessions/work and host reviewers reject. Recipient must be unclosed and have active_work_id equal to this work. Reuse elsewhere removes old-message eligibility; no implicit recreation of closed Agents. Canceled work cannot deliver.
3. `subagent_messages` was introduced in schema v29 without backfill. Dedupe by work/sender/key before execution preflight: same key/parameters returns the original even after cancellation/close; differing parameters conflict. After async preparation, the synchronous registration transaction deduplicates again, runs the returned preflight check, and rechecks current eligibility/model selection. Store source sender/task and delivered/undelivered facts. New SubAgent or main-wake messages preflight model/restricted execution outside the transaction; model_config_busy or changed selection creates zero rows/tasks/events. Pure dev-parent injection creates no execution and needs no execution preflight. `ParentDelivery.messageRecorded` uses only the manager-verified selection.
4. Delivery never broadens authority. The original SubAgent delivery creates one confirm task for that work, key `smsg:<message ID>`, reusing its most recent work-task readScope and pinned tools plus subagent_message. Parent delivery is a dev reference block (same collection/marking transaction as result injection) or a main wake with agentId=main, confirm, and no deadline. Text is capped at 4096. Later [full-access source propagation](2026-10-12-full-access-current-account.md) and [scheduled work](2026-10-12-generic-scheduled-tasks.md) supersede derived-task modes/ownership where specified, not message identity/idempotency.
5. Busy recipient or exhausted parent-session active-task quota (three, same delegation count) leaves pending. Flush asynchronously after SubAgent terminal result registration, startup recovery, whole-work cancellation, resume-queue verification, and model-config application. Close synchronously clears only that Agent's pending messages. Flush checks eligibility first; busy/quota-full stays pending without preflight. Once eligible, any preflight failure retains the saved message and emits a diagnostic. RuntimeModels awaits an injected flush callback in finally, applying current configuration after both success and rollback. Lost eligibility (`moved_work`, `closed:<time>`) or canceled work records a reason and `subagent_message.dropped`.
6. New delegation may register during async flush. The delivery transaction must recheck work, eligibility, and model selection, arbitrating with the original smsg key and one-write marker. Never assume a terminal synchronous continuation beats new work, and add no lock. Only manager `flushPendingMessages` creates message deliveries; parent-delivery sweep repairs result wakes only. [Runtime model ownership](../architecture/2026-10-23-runtime-models.md) distinguishes its configuration latch from complete-operation cleanup.
7. `subagent_message` is in the subagent category and assembled by the same factory for dev/main/eligible child sessions, never host reviewers. Assembly/pre-send/invocation agree. The tool ledger reconciles work/sender/key. Main reads `subagent_result(part=messages)`; owner control reads work_get.messages (introduced in protocol v15). Cross-instance import folds messages into their work ledger, not a separate import category.

## Alternatives considered

No alternatives were recorded in this pre-format ADR supplement. The translation preserves that absence rather than inventing a competing design.

## Consequences

Existing idle Agents can collaborate on read-only work with traceable senders. Separate message/execution persistence costs repeated eligibility/model checks after async waits; no ordering assumption or extra lock substitutes for the transaction. Join does not also create a new collaborator in one step. Modification stays single-writer; host review stays fixed. Product-specific personal durable messaging must use its successor wiring, not be inferred from legacy shared-runtime tools.

## Verification

Historical offline `.scratch/agent-direction/issues/13-subagent-messaging.md`: test/86 8/8, typecheck, and diagram checks 4/4 passed. Full suite: 897 total, 893 passed, one skipped, three verified environment failures (DNS, worktree directory naming, loaded-suite PTY timing). Smoke-13 passed 6/6 each on macOS and tx with real Runtime/CLI/SQLite/JSONL/Docker worker but mock model/platform.

Moved-work/closed pending combinations were seeded final states proving guards, not naturally reachable timing. Host-review messaging exclusion was a manager assertion, not a complete review scenario. No real QQ/Telegram was tested. This migration reruns no runtime tests.
