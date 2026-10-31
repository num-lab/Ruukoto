# Agent Note: Let pi durable own Personal Agent runtime state

Status: proposed

The owner confirmed product choices in Q1-Q18 and the full proposal in Q19; independent plan review had no unresolved blocker. Many slices and the formal entry are now implemented, but this proposal remains the overall acceptance record, not a declaration that migration/production handoff is complete. Original requirements/handoff are offline provenance in retired `.scratch/personal-pi-durable/spec.md`, `issues/01-migration-plan.md`, and `remaining-work.md`. The reassessment at `f2e05fc` ordered real-flow checks first, isolated formal artifacts after capability completion, then combined acceptance and production handoff, without narrowing scope or recovery requirements.

## Problem

Both products used Pi SDKs while Ruukoto owned execution, queues, recovery, context compaction, and workflows. The owner chose durable for Personal to reduce future maintenance of a self-built execution foundation, while preserving Coding behavior/data/runtime dependencies.

Migrating Personal alone cannot remove shared runtime/agent/core/control/view/tui still used by Coding. The benefit is Personal no longer depending on or extending them and retiring unwanted coding/compatibility functions, not a guaranteed net reduction in repository line count.

## Proposal

`@earendil-works/pi-durable` owns Conversation, Submission, Task, model loop, tool tasks, queue, recovery, and compaction. The host stores Personal business facts and external-operation evidence, not a mirror of durable execution in old Task tables or another state machine. Coding keeps its runtime foundation. Share only independently useful transport, credential, validation, native isolation, and operation-protocol implementations with real callers.

Start Personal with an empty profile and leave old data frozen in place. Do not import history, memories, application data, schedules, approvals, or in-flight execution, and do not build old-format compatibility. Retain IM, guided CLI, scheduling, long-term memory, application data, skills/MCP, server management, and reusable one-level SubAgents. Retire development sessions, worktree integration, coding verification, old workflow language/library, automatic GitHub reviews, and the old client protocol from Personal.

Keep three access modes, default auto-review, and inspectable/revocable standing grants. Safe operations recover automatically; uncertain writes pause their work, and unverified stop retains occupancy. Durable recovery is neither remote-effect verification nor OS stop proof; host tools/work controls enforce those requirements.

### Upstream baseline and responsibilities

The proposal pinned released Pi 1.3.0 at tag commit `71023aec1546d6d677a65669c5665c0927ce0dd0`. Personal declares durable/pi-ai/chord and directly imported companions in its app. Initially Coding was to remain on 0.85.1; [MCP simplification](../../implemented/simplification/2026-10-26-mcp-host-responsibilities.md) later moved Coding to Pi 1.3.0 without moving it to durable. The historical dual-version requirement is no longer a current dependency fact; actual installation/build resolution and independent runtime ownership still require checks.

- [Package declaration](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/package.json) and [release](https://github.com/earendil-works/pi/releases/tag/v1.3.0): the framework is experimental; use released APIs, not unshipped main features such as the then-main `compaction.modelOverrides`.
- [Effect sandwich](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#52-effect-sandwich): persist intent, perform effect, then persist result. This cannot make arbitrary external effects exactly once. Request IDs deduplicate conversation submissions; an unsafe interrupted tool returning error does not itself prevent the model issuing another call.
- [Background SubAgent example](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/test/examples/23-subagent-background.ts): reuse conversations/background execution, adding work provenance, permissions, and cancellation rather than another agent loop.
- [SQLite implementation](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/storage/sqlite/node.ts): use SQLite for long-lived instances and a host-owned single-process lock. WAL/NORMAL process-crash recovery is not a guarantee against losing the newest commits on power failure.
- [Generation implementation](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/generation.ts): `beforeRequest` can rewrite input and ordinary hook errors may be reported then execution continued. Durable alone proves neither reconstructible requests nor fail-closed sending. Prefer persistent entries/documents/sections; additional rewrites need evidence at an actual send-blocking boundary.

These are source/specification findings, not integration results. Upstream supplies execution/storage/extension mechanisms; IM, authorization, business schedules, memory, and service management remain product responsibilities.

### Maintenance and data ownership

Implement in existing `apps/ruukoto`, replacing shared CLI/Runtime assembly without copying seven packages for symmetry. Export required low-level implementations through existing package exports. Extract minimally only where old business-state coupling prevents reuse, with Coding caller regressions.

Durable storage is authoritative for new Personal history/context, with no dual-writing old Pi JSONL. Coding/old archives keep their original format and immutability. Artifacts, credentials, and separate business databases retain their own write boundaries; never claim a cross-storage transaction with durable commit.

Persistent SubAgent identity is separate from each work execution: the index points to a durable Conversation, while each delegation uses durable Task/Submission recovery/results. One SubAgent serves one work at a time and cannot be reused before cancellation settlement. Canceling work never closes identity, deletes history, or affects another work.

## Implemented slices and remaining acceptance

[Profile/request foundations](../../implemented/architecture/2026-10-17-personal-durable-foundation.md), [read-only service inspection](../../implemented/architecture/2026-10-17-personal-service-inspect.md), [background work](../../implemented/architecture/2026-10-17-personal-background-work.md), and [model work tools](../../implemented/architecture/2026-10-17-personal-model-work.md) establish isolated APIs, persistent child sessions, delegation/query/cancel/close. [Service operations](../../implemented/architecture/2026-10-17-personal-service-operations.md), [IM entry](../../implemented/architecture/2026-10-17-personal-telegram-entry.md), [source permissions](../../implemented/architecture/2026-10-17-personal-telegram-permissions.md), and [child service operations](../../implemented/architecture/2026-10-17-personal-subagent-service-operations.md) add fixed source, one-shot approval, grants, and effect/stop verification.

[Linux identity](../../implemented/architecture/2026-10-17-native-linux-execution-identity.md), [command worker](../../implemented/architecture/2026-10-17-personal-command-worker.md), [restricted commands](../../implemented/architecture/2026-10-17-personal-durable-commands.md), and [full-access commands](../../implemented/architecture/2026-10-17-personal-full-access-commands.md) supply cross-process stop, self-contained artifacts/dependencies, original-work authority, pause, and local verification. [The formal entry/artifacts](../../implemented/simplification/2026-10-18-personal-product-entry.md) now use this assembly in a new profile. Entry replacement alone did not resolve combined acceptance, exact attribution of original Coding failures, or production handoff; retain those gaps until independently evidenced.

## Existing-note audit

The original search covered durable, Personal, products, main, recovery, authorization, and model inputs; at that time no rejected directory or same-topic proposal existed. It found no fully absorbed/deletable note.

| Existing decision | Relationship |
| --- | --- |
| [Two products](../../implemented/architecture/2026-10-02-two-agent-products.md), [workspace packages](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md) | Personal leaves shared runtime/protocol; independent products and Coding foundations remain. Entry implementation determines the actual dependency graph. |
| [History/context](../../implemented/architecture/2026-09-19-preserve-session-history.md) | Preserve immutable history/reconstructible input while changing new Personal's authority store; retain Coding/archive JSONL rules. |
| [SubAgent recovery](../../implemented/architecture/2026-10-05-subagent-restart-recovery.md) | Personal safe work becomes automatically recoverable; Coding's rules remain. |
| [Development sessions](../../implemented/feature/2026-10-05-ruukoto-keeps-dev-sessions.md), [workflows](../../implemented/feature/2026-10-12-agent-workflows.md) | Personal retires these entries/language; Coding retains them. |
| [Desktop proposal](2026-10-15-desktop-client.md) | Personal does not implement the old desktop control protocol; later native Personal pages/remote connection are separate product integration, not old-protocol compatibility. |
| Delegation/reuse/cancel/source/roles, IM approval/reports, standing grants, modes/auto-review/full access, helper/native isolation, schedules/MCP/application data | Preserve business/security requirements while rebuilding records over durable; old implementations are not assumed directly reusable. |
| Import/workspace organization/branching/manual compaction/worktree integration/coding verification/GitHub review/workflow interaction and yielding | Not implementation sources for new Personal; retain Coding, old archives, and their evidence without absorbing these mechanisms. |
| Browser/export/background proposal/other desktop detail | Independent requirements are neither added nor deleted by migration; applicability is checked in the capability implementation notes. |

## Alternatives considered

- Wrap durable inside old Runtime: retains clients/querying, but coordinates two task/recovery/history authorities and defeats reduced Personal foundation maintenance.
- Migrate both products: may delete more long-term code, but changes Coding behavior/data outside approved scope.
- Preserve full compatibility/import: smoother continuity, but requires old protocol/history/execution migration maintenance. The owner chose a new instance and archived originals.
- Delete persistent SubAgents or use one mode: less host code, but violates explicit reusable-identity, three-mode, and standing-grant requirements. Reassemble those rules over durable primitives.
- First run a keep-or-reject framework trial: useful before a choice, but adoption is already owner-decided. Verification establishes correctness/release readiness rather than reopening selection.

## Acceptance criteria

The original specification matrix requires Personal functionality, fault recovery, permissions, and Coding nonregression together. The Personal runtime must not assemble old Runtime/Driver/Task Store/control protocol. Upstream tests do not replace host crash-window tests. Missing real-model/IM/platform/product evidence remains pending, not passed by successful isolated APIs or formal entry startup.

Production cutover follows acceptance of every retained capability: disable old service auto-restart, verify old connections/units stopped, freeze profiles and record handoff, configure the new instance, and reject automatic execution of old backlog. Rollback changes code only; even the old version uses a new empty profile with fresh configuration. Never resume the archived original, because database inbound/notifications/schedules can recover independently of platform offsets.

## Risks

Experimental APIs can change; pinning controls upgrade timing, not cost. Both runtime architectures remain even after Pi version convergence. Reducing maintenance requires using upstream mechanisms rather than rebuilding the old foundation around them.

Three modes, grants, reusable children, and reliable sending still require host business code. Cutover blockers include unknown effects treated as retryable failure, cancellation/reuse races, old entries continuing after transfer, and unrecorded model-input rewrites. Neither a successful build nor the amount of deleted code proves those requirements.
