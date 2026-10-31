# Agent Note: Restricted script workflows with independently owned execution

Status: implemented

[The personal product entry](../simplification/2026-10-18-personal-product-entry.md) supersedes the original two-product scope: new personal does not use this workflow language/library/IM commands; Coding continues, while old personal branches/evidence are retained history. [Configurable SubAgent roles](../architecture/2026-10-14-configurable-subagent-roles.md) separates role, source capability, and execution target. [Wait/report ownership](../architecture/2026-10-14-agent-wait-and-report-ownership.md) adds interruptible waits and continued parent turns without changing background-run/source/final-target ownership.

## Problem

Batch work needs independent validation of each result and a summary with explicit coverage. Skills provide instructions, work lists track steps, and SubAgents execute, but none alone gives a program durable step relationships and intermediate results.

## Decision

Use model-generated restricted JavaScript for sequence, concurrency, branches, and terminating loops. Host runs the script; Agent steps perform concrete tools. Programs consume intermediate results while the main conversation remains available, then report once. Runs have independent execution records and traceable authorization; they cannot pretend an ended initiating task remains active.

Short-lived host-operation tasks derived from the run own workers, tool ledgers, and directory occupancy for copy preparation/extraction/integration without model sessions. This gives executeWorkCopy real active ownership while preserving ordinary Driver tasks. Cancellation/unverified stop belongs to actual execution, never relaxed parent-active checks.

Steps use only source-authorized product capabilities and may narrow them. Code, web research, and personal-business tools followed the original product abilities, not new privileges or inherited one-use approvals. The owner can explicitly start a workflow; a model can choose one within an authorized task and host limits. External material cannot grant startup authority.

Originally this was shared by both products to avoid divergent orchestration; batch process/independent-validate/summarize was the first scenario, not the only use. The later personal split intentionally supersedes that scope. Original requirements/plan are historical offline `.scratch/agent-workflow/spec.md`, `implementation-plan.md`, and issues `01-workflow-design.md`; confirmed interaction changes are in offline `experience-spec.md`, not live task entry points.

### Recovery follows verifiable execution

Independent branches may continue; steps depending on failed results do not actually run. Reuse completed results and resume unstarted eligible steps. Retry only provably safe repeatable execution, finitely; unknown writes pause for verification. Recover from pinned script/parameters, stable step identities, input digests, and call/result-delivery order, never the currently edited definition. Missing/inconsistent records reject reconstruction rather than guess.

This preserves completed batch work without replaying unknown effects. Invalid result format can follow a real write; it does not mean nothing happened. Step completion, operation effect, and run delivery are distinct facts.

### Host-owned limits and waiting

All runs from one source session share three SubAgent slots and queue when full. Default run budget is 100 Agent attempts and one hour excluding human wait. Only the owner adjusts attempts/time, not script/model; three slots are fixed (clarified in 2026-10-13 joint acceptance). Safe retries consume attempts. Separate queues cannot bypass source concurrency; exceeding limits pauses with results retained. These limits are not exact monetary caps; show per-call usage/in-flight work, and never treat interruption as safe write retry.

Named versioned definitions and parameterized runs are first-release capabilities. Pin definition/parameters per run; edits create versions and referenced versions/history remain. Use files/existing controls, not a visual editor/distribution platform.

Human decisions are durable business steps bound to run/step/trusted entry, while main/other work continues. Answers are not tool approval. Cancellation/invalid entry prevents answers restarting execution. Split independent runs could avoid wait state but lose unified ownership/recovery; retain the wait instead.

[QuickJS/WASM isolation](../architecture/2026-10-13-workflow-script-isolation.md) passed the four-quadrant fake-Agent experiment; [runtime/store](../architecture/2026-10-13-workflow-runtime-and-store.md) passed fake-Agent coordinator checks. Real step wiring, answer delivery, and definition entry exist, but separate offline checks do not establish joint real-product acceptance.

### Verification and integration

Modify independent copies, then freeze full patch/digest/baseline for independent-context review. Checks needing writes use another validation copy/temp area, not reviewed bytes. Bind verification to result version. Under copy/target occupancy, recheck unchanged versions and integrate only the frozen verified patch, then verify combined results. Any further modification/continuation requires new validation; same work ID does not prove same bytes.

Reuse conflict preflight/result retention, without atomic rollback across copies. Earlier integrated changes do not disappear because later work fails. Commit/push/publish still need explicit task authorization.

Child results go to the coordinator; one verifiable final delivery enters source session/original owner entry. Scheduled sources report through the entire schedule run. This avoids per-step parent wakes/duplicate external reports but requires separate terminal/summary/notification idempotency and failure facts.

## Related decisions

The original audit found partial overlap, not a wholesale replacement: [two products](../architecture/2026-10-02-two-agent-products.md), [shared packages](../architecture/2026-10-11-in-repo-workspace-packages.md), and [delegation](../architecture/2026-10-03-work-delegation-subagent-task.md) retain deployment/dependency/ordinary-delegation rules. Independent workflows need their own identity instead of assuming an active ordinary parent.

[Full access](2026-10-12-full-access-current-account.md) and [generic scheduling](2026-10-12-generic-scheduled-tasks.md) own trusted-source authorization/independent execution/fixed delivery; scripts cannot choose owner identity. [Recovery](../architecture/2026-10-05-subagent-restart-recovery.md), [unverified stop](../bug-fix/2026-10-11-preserve-unverified-worker-stop.md), and [integration](2026-10-05-integrate-worktree-results.md) constrain no-replay and retention. MCP/IM/service/sandbox/message/copy/context notes retain capability-specific rules; "available within source authorization" never means copying credentials or host identity.

[Step capabilities](../architecture/2026-10-13-workflow-step-capabilities.md), [answer/final delivery](2026-10-13-workflow-owner-input-and-delivery.md), and [definition controls](2026-10-13-workflow-library-and-controls.md) own their details. The original audit found no competing proposal at that time; unrelated UI/docs/branch/import/group/GitHub-retirement decisions were not absorbed.

## Alternatives considered

- **Coding only:** fewer entries and focused worktree/TUI acceptance, but the original owner choice included personal multi-step work. The later personal split supersedes, rather than rewrites, that decision.
- **Personal only:** focused IM/background work, but batch coding/validation was also required and the original runtime was shared.
- **Fixed configuration workflows:** simpler static checking, but branches/loops/per-item processing would keep expanding a custom language. Restrict general JavaScript capabilities instead.
- **Occupy the current task/session:** reuses parent lifetime/result logic, but blocks later interaction during long batches. Pay for independent authorization ownership.
- **Only existing file/command SubAgent tools:** smaller implementation, but web/business steps must keep returning to main. Allow source-authorized capabilities.
- **Owner-only starts:** predictable resources, but makes owners decide orchestration suitability every time. Let the model choose within existing authority/limits.
- **Stop all on any step failure:** simpler, but wastes independent branches. Stop dependent/unsafe work only.
- **Temporary scripts only:** no versioned library, but recurring work regenerates scripts. Retain named parameterized definitions.
- **Separate runs for human confirmation:** no durable question state, but the user must manually preserve inputs/identity/progress. Bind waiting inside one run.
- **Deliver copies/reports only:** less target-writing scope, but leaves manual batch integration/validation. Reuse authorized controlled integration with conflict evidence.
- **Copy Claude Code startup-order cache invalidation/stall reruns:** an established reference, but could repeat completed later work or writes. Stable steps plus effect checks reject inconsistent replay.
- **Validate by work ID alone:** convenient existing reference, but the same work can change. Freeze patch/baseline and recheck bytes.

## Verification

Original acceptance required A1-A12/fault scenarios and separate offline orchestration, real worker, real model, and applicable IM evidence for each product. Isolation candidates required four-quadrant experiments and independent design/implementation review; normal script return alone never proves coverage/effects. Historical joint evidence is offline `.scratch/agent-workflow/acceptance-evidence/README.md`. Implemented means capability delivered, not joint acceptance passed; this migration neither reruns checks nor promotes missing real-platform/model evidence to success.

## Consequences

Host wiring owns background execution, step permission, and result consumption; generated scripts are not trusted host code. Changing QuickJS/WASM requires new isolation/abort validation and may reopen selection. Hidden JavaScript data dependencies cannot be completely inferred: scripts need explicit dependencies and replay needs full control records/deterministic inputs. Limit pauses may interrupt effects requiring verification; human waits may last indefinitely and need visible state/next action.

Initial batch code modification requires Git (owner-confirmed Q12) for maintained independent copies/controlled integration. Non-Git analysis and other tools remain possible; future non-Git batch writes need a separate copy/writeback design, never parallel in-place fallback. Original two-product acceptance must not be claimed from Coding-only evidence, and the current personal product is explicitly outside this workflow language.
