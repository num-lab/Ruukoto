# Agent Note: Store work delegations, SubAgent identities, and execution tasks separately

Status: implemented

Original identifier: ADR 0020.

[Configurable SubAgent roles](2026-10-14-configurable-subagent-roles.md) separates roles, source capabilities, and execution targets. [Durable source capabilities](2026-10-15-subagent-source-capabilities.md) owns current source, permission, and project-context rules. These later decisions supersede the original fixed-confirm analysis policy, not the separation of work, identity, and execution recorded here.

## Problem

[The two-product decision](2026-10-02-two-agent-products.md) requires one level of SubAgents in both products: identities and context survive individual tasks, and a work delegation can span several conversation turns and executions. The old fixed coding role shared one session across all child tasks, conflated identity with execution, and offered no delegation tools to ordinary development sessions.

## Decision

Store the three concepts independently. `work_delegations` records the work, parent user session, initiating task, first delegation key, and parameter digest. `sub_agents` records a dynamic identity, parent session, independent session, host-generated working directory, current-work pointer, and running/idle/verification state. `tasks` records each execution, with nullable `work_id`, `sub_agent_id`, `read_scope`, and `result_delivered_at`. A terminal task does not close its work or its SubAgent.

Dynamic identities do not enter legacy role columns. `AgentRoleId`, `agent_roles`, and `tasks.agent_id` retain their main/coding/chat values and CHECK constraints for old records. The host resolves a SubAgent through its session binding with `getSubAgentBySession`; it must not fall through to ordinary dev-session tool eligibility.

Idempotency has two levels: `(parent user session, key)` identifies the initial work; `(child session, sdelegate:<workId>:<key>)` identifies a task within it. The work digest excludes the immediate parent task ID and model selection, allowing the same logical delegation to be checked across turns and returned from its first record. Reusing a key with different parameters is an explicit conflict.

Preparation runs outside the transaction: model and restricted-execution preflight, directory creation, path/data checks, and snapshot persistence. One synchronous transaction commits work, identity, session, queued task, and audit events; only then may the child session be kicked. Two independently committing registration APIs would leave partial objects. Files and SQLite are not atomic together: failure cleanup removes only newly created directories with no committed references.

`SubAgentManager` owns online state and current-work/current-task pointers; Store supplies SQL primitives, with offline import settlement as the exception. Continue, reuse, collaboration, message registration, and flushing share private eligibility checks. Closed identities, another parent session, fixed host reviews, canceled work, and mismatched current work are rejected or recorded as undelivered; busy/full-capacity messages remain pending. The manager reads the trusted parent task's fixed `planMode`, never a caller-supplied value. It rejects explicit modification and continuation of work with an existing `writeTarget`. This defense does not grant plan-mode models delegation: `PLAN_TOOL_NAMES` excludes `subagent_delegate`. Centralizing the writer adds no schema, protocol, or event names.

New ordinary delegation uses the generic path only. Both `coding_delegate` analysis forwarding and its old draft path were removed. `coding_result` remains a narrow read-only entry for legacy coding results and this session's SubAgent results. Historical role values remain readable; new role-bound tasks use main or a SubAgent binding, and ordinary dev tasks retain user-session identity. Host GitHub reviews are registered by the orchestrator, not as ordinary main delegation, and cannot be reused, joined, or addressed through work messages.

## Original analysis policy and later scope

The first generic implementation pinned analysis to `read` and `read_artifact`, plus `subagent_message` where collaboration was allowed, and fixed child tasks to confirm. Assembly, pre-send checks, and tool calls used the same eligibility decision. Host-pinned read paths and directory identity were rechecked when files opened; read-only mounts alone were not read authorization. SourceResolver produced bounded main-data snapshots within existing permission, saved their references, and reverified them before each model request. It did not copy complete parent history or automatically inject parent instructions, personal memory, or skills. `read_artifact` was limited to the task's own output, excluding other tasks' artifacts and prompt snapshots. Neither unaccepted group data nor accepted group summaries could become delegation material. Analysis could not upgrade itself into write work.

That original no-inheritance/fixed-confirm policy is historical. Current role/source authorization follows [source capabilities](2026-10-15-subagent-source-capabilities.md) and [current-account full access](../feature/2026-10-12-full-access-current-account.md); write targets follow [worktrees](2026-10-04-subagent-worktrees.md). A task never derives authority from message text. [Scheduled tasks](../feature/2026-10-12-generic-scheduled-tasks.md) owns independent scheduled execution, provenance, and whole-run cancellation. [Workflow execution](2026-10-13-workflow-runtime-and-store.md) gives its coordinator separate authorization, pointers, results, and recovery; ordinary delegation remains governed here.

[Continue/reuse/close](../feature/2026-10-04-subagent-reuse-close.md), [whole-work cancellation](../feature/2026-10-04-cancel-work.md), [work messages](../feature/2026-10-05-subagent-messaging.md), and [restart recovery](2026-10-05-subagent-restart-recovery.md) are separately replaceable decisions. [Context compaction](2026-09-26-lossy-context-compaction.md) keeps `subagentResults` and `subagentMessages` in host reference blocks, separate from conversation history. Early plan-mode checks followed `resumesTaskId`; [plan session mode](../feature/2026-10-08-plan-session-mode.md) replaced that inference with a trusted submission field.

## Alternatives considered

- Reuse the fixed coding-role session: this preserves existing scheduling and role columns, but forces every child to share context and cannot represent several persistent SubAgents under one user session.
- Rely on read-only container mounts: this prevents writes to mounted material and reuses the launcher, but worker read operations can still read outside the authorized data set, including other container paths. Enforce a host-pinned `readScope` at file access instead.

These alternatives were recorded in the retired local issue `.scratch/agent-direction/issues/11-subagent-delegation.md`; that path is offline provenance, not a current task entry.

## Consequences

Work, identity, and execution can be inspected and recovered independently, while the parent handles new messages during child execution. Registration, delivery, pointers, and directory identity must remain consistent across tables. Filesystem preparation requires reference-aware cleanup, not replay of analysis to repair partial state. Dynamic SDK objects are released after execution exits and its result commits; release never deletes identity, history, or artifacts.

Historical issue-11 evidence records test/80 at 11/11, passing typecheck, and 872 passes, zero failures, one skip in 873 full-suite tests. The original `smoke-11-subagent-delegation.mts` passed 9/9 on macOS Docker Desktop and Linux Docker via `ssh tx`; Runtime, SQLite, JSONL, files, and containers were real, while models and messaging were simulated. Real QQ/Telegram and non-default-UID ACL behavior were not tested; permission preflight and worker refusal had separate coverage. These results describe the original implementation, not acceptance of later role and native-execution changes.
