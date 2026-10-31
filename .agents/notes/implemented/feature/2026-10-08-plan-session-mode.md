# Agent Note: Plan is a persistent session choice with fixed auto-review policy

Status: implemented

Original identifier: ADR 0025.

## Problem

A one-shot /plan input returns the next ordinary message to execution, preventing sustained investigation/planning. Inferring mode from historical text or resume chains disagrees with trusted session choice and actual tools/instructions/approval. Ordinary development sessions need a persistent owner-controlled Plan selection.

## Decision

Plan persists until the owner changes it and replaces the one-shot /plan command. Session default and task execution policy are distinct: Plan combines a fixed tool allowlist, planning instructions, and auto-review, reusing [access modes](2026-09-19-explicit-access-modes.md) and [review policy](2026-09-22-auto-review-mode.md), not a fourth access strategy.

Pin each new task at submission. Defaults affect later tasks only; resuming an interrupted task creates a new task using current default or explicit selection, never text/resume-chain inference. A running task cannot enter/exit Plan or change its policy. To execute, interrupt, manually switch, then continue. Keep historical text unchanged and do not backfill planning state during general schema migration. Retaining bash for research means instructions, not comprehensive read-only enforcement, constrain writes.

## Persistence and entries

SessionDefaultMode includes Plan; tasks pin planMode=true/accessMode=auto-review. Schema v32 introduced tasks.plan_mode and rebuilt the session-mode CHECK while preserving old fields/tasks/indexes/foreign keys; old tasks default non-Plan. Protocol v16 snapshots/task.queued exposed the fixed choice. TUI/CLI/API/configuration use backend truth and session-version conditional saves; those numbers identify introduction, not current schema/protocol.

Explicit one-off selection wins over default. Request-v2 digests bind original parameters, with null for no explicit choice, so retries do not drift when defaults change. Old digests validate original three access modes; explicit Plan is not equivalent to old auto-review.

Only ordinary development sessions support Plan; host rejects main, SubAgent, archive, and IM entries. TUI /mode, Shift+Tab, status bar, and cross-session settings include it; switching ordinary sessions saves the source selection to the target. TUI /plan is unknown; CLI/API /plan text is ordinary input. Completing a plan or saying "start implementing" does not switch automatically.

Assembly, pre-send, invocation, and profile read the same pinned fields. Exclude edit/write, memory writes, non-read MCP, and unlisted tools; retain bash, request_file_access, http_request, todo_write, and skill. External file/HTTP tools can still request writes or POST under normal approval, so tool filtering/prompting is not a read-only security boundary. SubAgent manager also rejects explicit modification or continued writeTarget under the parent field; PLAN_TOOL_NAMES does not expose subagent_delegate. Plan approval is not approval of every concrete operation in it.

## Alternatives considered

- **One-shot /plan:** no session state/CAS/broadcast and easy next-message execution; originally chosen in offline `.scratch/personal-agent/issues/26-plan-mode.md`. The owner later required persistence until manual switch in issue `31-plan-mode-selection.md`, so remove text markers/resume compatibility while keeping originals.
- **Inherit Plan from interrupted source:** prevents accidental changes on resume, but overrides the owner's current choice. Confirmed semantics create a new task from submitted/current choice without inherited approvals.
- **Read-only mounts as a hard guarantee:** could constrain retained bash, but the original local/full-access paths ran natively and mounts only covered the then-server container backend, not both products uniformly. The chosen research tools plus explicit limitation remain; current auto-review restriction alone does not make all approved operations read-only.

## Consequences

Planning persists across tasks with one pinned source for environment/tools/instructions. It costs distinct default/task fields and disallows in-task transition; continuing old /plan work requires current selection. Bash and approved external requests can write, so Plan is not another security policy. [Current-account full access](2026-10-12-full-access-current-account.md) owns later account/environment/authorization changes without altering this choice.

## Verification

Historical issue 31 recorded passing typecheck/diff checks; 1008 tests with 1007 passed, zero failed, one gated real-model skip. Related cases covered two persistent Plan turns, defaults/overrides, resume, rejected task switches, schema rollback/recovery, request idempotency, TUI/CLI/configuration, and tools. Former visual-docs test/67 passed 4/4; seven diagram pages/95 slices were inspected without layout issues. Those removed diagrams are historical evidence, not current verification entry points. No separate real-model or Linux container acceptance ran; this migration reruns no runtime tests.
