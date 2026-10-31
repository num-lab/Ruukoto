# Agent Note: Desktop message copy and task-boundary branching

Status: implemented

## Problem

Agent messages lacked actions. The owner requested copy/branch below messages only after their task completed. Existing `branch_session` branched only from the latest safe session tail, contradicting an earlier message's current-task action.

## Decision

Completed-task assistant messages copy their current body; existing long-body history recovery remains authoritative, with no renderer truncation guesses.

Branch sends the message taskId through optional control `task_id`. This introduced protocol 43, requiring old backends to reject rather than ignore it and silently branch from the session tail. Runtime verifies source-session ownership (including ancestor `branchSource.taskIds` in repeated branches) and completed status. Core `snapshotSessionHistory(throughTaskId)` copies through that task's TASK_END_MARKER inclusive; absent markers are `entry_not_found`. The source stays read-only and fingerprints cover the copied prefix.

CodeState.branch uses a random request_id; branch `createRequestId` supports snapshot/session.created verification like session creation. Lost responses resend once with the same key. Success opens the branch. Explicit failure/confirmed nonpublication clears pending; incomplete preparation retains the key for click-to-retry. Instance changes never resend into a new instance.

Desktop/TUI branch history reads task events for source task IDs referenced by the current page, projecting thinking/tools without copying task ledgers. Desktop also uses get_task for those source IDs because list_tasks returns only current-session tasks; otherwise ancestor messages lack completion status.

Render actions only for assistant, completed TaskView and nonstreaming entries. Ordinary main sessions have copy/branch; child sessions have copy only. Scheduled/role sessions cannot branch because they are not ordinary development sessions.

## Verification

`test/102-branch-session.test.ts` checks completed-task boundaries, excluding later tasks, rejection of incomplete/missing-marker/foreign tasks, and repeated branches inheriting only pre-boundary results/artifacts. `test/history-recovery.test.ts` checks page-scoped source status/thinking/tool recovery. `test/desktop-message-actions.test.ts` covers visibility, child/scheduled restrictions, task_id forwarding, lost responses, snapshot verification, original-key retry and branch-page trace. Existing safe-tail/control/static checks remain scoped regressions.

## Alternatives considered

- Latest-tail branching is smallest but includes later tasks than the chosen message.
- Client entry IDs/JSONL paths let callers forge boundaries and cross-instance paths; accept task IDs and verify ownership/markers in the host.
- Creating a session then pasting history loses references, compaction/source constraints and idempotent snapshot recovery.

## Consequences

Completed messages gain lightweight actions and branches can end at any completed old task. Matching client/backend protocol is required. Task branches reference a task-end marker rather than the last message. History, artifacts and work lists use existing snapshot copying; tasks, approvals and execution permissions are not transferred.
