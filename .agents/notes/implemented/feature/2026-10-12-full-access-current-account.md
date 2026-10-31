# Agent Note: Full access uses the launching account without operation approval

Status: implemented

This note owns full-access semantics and the real authority sources propagated into derived work. [Configurable SubAgent roles](../architecture/2026-10-14-configurable-subagent-roles.md) separates role, source capability and execution target; roles may narrow inherited authority. Original implementation/evidence remain in the offline `.scratch/full-access/issues/01-full-access-current-account.md` and `.scratch/full-access/execution-summary.md`.

[Generic schedules](2026-10-12-generic-scheduled-tasks.md) replaced news/fixed-notification scheduling with independent task execution. This note owns saved creation authority and approval bypass, not compatibility for retired actions. Current Personal uses [durable](../simplification/2026-10-18-personal-product-entry.md); shared Store/IM ledger details below describe the original composition, while the current durable implementation preserves the account and authority principles through its own records.

## Problem

An owner choosing full access wants the Agent to use the files, network and tools already available to the account running the application. The original native/container setup instead required dedicated execution identities and protected launch/stop scripts; deployment separated owner, backend and worker accounts, adding account, ACL and entry-point configuration. Full access still waited for approval on application data, notifications, services, structured files and HTTP, while delegation/private messages reverted to confirmation. One mode therefore meant different things on different paths.

The three-account design genuinely protected backend data, model credentials and owner tokens. This decision intentionally drops that isolation promise for full access, using the launching account's existing rights to reduce configuration and operational cost.

## Decision

### Account and permissions

- Both products execute `full_access` as the OS account launching their backend. Full-access startup needs no dedicated backend/execution identity or privileged launcher and applies no container, Seatbelt, bubblewrap or other task sandbox to files/network.
- Backend/client separation, control-token authentication, bound IM-owner checks, task ownership and input validation remain. Full access grants neither root nor another account's rights and does not let unauthenticated entries choose a mode.
- A same-account full-access process can read or change accessible backend data, credentials and owner tokens, potentially using them to call control APIs. Entry authentication and data-API checks are not isolation against that process. Do not disguise a path blacklist as another full-access sandbox.
- Confirmation, auto-review and Plan keep restricted execution. Missing required isolation fails explicitly rather than falling back to full access. Conversation defaults, identity-specific tools and role capability limits remain; full access does not itself add main/SubAgent tools.

### No per-operation approval

All already-exposed tools bypass operation approval under full access: coding, structured file/HTTP operations, MCP writes, destructive application-data changes, tools in generic schedule runs, one-off sends and service operations. No human approval wait or automatic review occurs, and full access is not recorded as a manual approval or standing permission. The model may ask for missing information, but permission text/tool guidance must not demand renewed authorization for an operation already covered by full access.

Bypass removes only the authorization wait. Before execution, still verify task activity, permission version, target, configuration revision, product capability and credential binding. Preserve parameter snapshots, idempotent claiming, state/event transactions, effect-unknown classification and non-replay. MCP allowlists, service target lists and data-API ownership constrain those interfaces; unrestricted commands can still reach same-account resources through other paths.

Service management may retain fixed protected helpers and OS authorization under the actual launching account. These are prerequisites for enabling service management, not for entering full access. Insufficient OS rights fail without application approval, password prompts or automatic sudo grants.

### Environment inheritance

Full access inherits the backend's starting user environment, including PATH, HOME, proxies, SSH agent and tool credentials, removing only Ruukoto internal-control variables. Do not reuse the old developer filter retaining only PATH/HOME/LANG/LC_ALL/TMPDIR. Host-fixed Git environment needed for work-copy operations keeps its original purpose. Add no user environment editor, and never write environment values into diagnostics or operation records.

### Authority sources and propagation

| Trigger | Authority for the new task |
| --- | --- |
| Owner submits or continues ordinary work | This submission's explicit choice, otherwise the conversation default |
| Bound QQ/Telegram owner private message | Main's default when the task is created |
| Main delegates, continues work or reuses a SubAgent | The actual initiating task's effective access mode, subject to role narrowing |
| Work-scoped collaboration/result triggers main synthesis | The triggering task's saved authority, not the receiver's current default |
| A schedule fires | The access mode saved when the schedule was created |
| GitHub or other external event | The entry's explicit existing constraints, never an inherited default full-access grant |

The host persists and propagates provenance. Message bodies, model arguments and SubAgent identity cannot upgrade it. Delayed/recovered deliveries keep the original trigger's authority regardless of receiver idleness, mode changes or Agent reuse.

In the original shared IM path, if task acceptance committed before its event/media association, the authoritative task is found by the original conversation and `evt:<event ID>` key, matching source event and Agent. Complete only the association, preserving its mode/model. Never reactivate a terminal task; a changed target generation cancels an unfinished original task. Source verification precedes waiting for media association. Resubmission would recompute authority from a newer default and produce a digest conflict, so neither resubmission nor a legacy-digest adapter repairs this window. Current durable IM admission has separate immutable entry/association checks; it must not fabricate shared-runtime tasks to reuse this mechanism.

One work assignment may span owner turns. Newly dispatched work uses the current initiating task's authority; the SubAgent does not permanently retain its first full-access grant. Existing running/queued tasks keep their own saved modes, not the first or most recent mode attached to the work as a whole. Individual approvals and narrowly scoped standing permissions do not propagate with the access mode.

Temporary host execution serving a task, such as work-copy creation or integration, also uses the real initiator's effective authority rather than a fixed confirmation mode that would require a sandbox even for full-access work. Work-copy ownership, read/write tool roles, source verification and preservation of results still apply. A full-access work copy is not OS filesystem isolation. Later [workflow host-task rules](../architecture/2026-10-15-current-workspace-snapshots.md) supply independent no-model task ownership where applicable without changing provenance.

### Mode changes and stopping

- A conversation default affects future tasks only, not existing tasks or schedules. A new turn continuing old work supplies authority for its new dispatches; already-running/queued tasks retain saved authority.
- An explicit task-mode switch affects only its named task at a tool boundary, not other tasks, SubAgents or schedules. To tighten an entire assignment immediately, stop the work before redelegating with the new mode. Changing the default does not revoke in-flight execution.
- Full access starts without extra process-management configuration. Stop known owned execution; residual processes or unverifiable stopping retain directory occupancy and evidence and are reported honestly. Main-PID exit does not prove the execution has stopped.
- Deliberately detached processes, independently elevated processes and external services are not guaranteed to stop with the task. Preserve stop-result propagation, cancellation and uncertainty handling. Platform supervision requires implementation and real acceptance; unsandboxed cleanup is not an adversarial escape-prevention guarantee.

### Direct replacement

During rapid iteration, remove obsolete identity requirements/configuration, dedicated execution launchers/start-stop scripts, deployment steps and compatibility branches. No old configuration aliases, protocol adapters, task/schedule field backfills or transitional dual paths are provided; in particular, do not invent confirmation authority for old schedules.

Keep helpers, policies and OS authorization still needed for service management, adapted to the current account. Removing worker-account scripts does not remove service capability. This decision authorizes no deletion of actual machine accounts, data clearing or ownership changes. Storage still follows monotonically increasing `SCHEMA_VERSION` and rejects databases newer than the code.

## Implementation ownership

The original implementation reached the following layers. Current Personal has its own durable consumers rather than reassembling the former shared product.

| Location | Responsibility |
| --- | --- |
| `packages/agent/src/execution/`, workers and process management | Current-account launch, user environment, cwd, stop/unknown state and restricted-mode regression |
| `packages/agent/src/approval-gate.ts`, `tool-router.ts`, application data and tool families | Full-access approval bypass with pre-execution checks, operation ledger and transactional local effects |
| `packages/runtime/src/` and `packages/core/src/` | Persisted authority for delegation, messages, wakeups and temporary host execution; task-specific mode switching |
| Shared owner-IM orchestration and `packages/channels/src/scheduler/` | Original private-message defaults and saved schedule authority; generic schedules removed news/fixed sends |
| `apps/ruukoto/src/personal-command-work.ts`, `personal-tools.ts` and other durable adapters | Saved work/origin permission, immutable admissions and adapter-specific execution/recovery |
| Service tools and `deploy/systemd/` | Remove full-access three-account deployment requirements while preserving fixed-helper OS rights/target checks |
| Prompts, delegation text, tool descriptions, TUI and settings | Describe actual task authority, removing old approval exceptions, fixed-confirm children and dedicated-account claims |
| Domain/module/usage/deployment docs and targeted tests/fixtures | Explain actual modes, provenance, boundaries and verification |

This change originally introduced shared core schema `35` and control protocol `19`, not their current versions. New databases were created directly at that definition; mismatches, including import preview, failed without adding columns, matching legacy digests or backfilling authority. Old tasks therefore gained no inferred new permissions. Preserve old archives for compatible readers; subsequent versions retain their own migration/rejection rules.

## Relationship to earlier decisions

The original audit searched active lifecycle/class directories for full access, execution accounts and backend identity, following code anchors and module links through delegation, messaging, work copies and stop. It found partial overlaps rather than a duplicate proposal. Those original audit facts do not claim that today's proposed/rejected directories are empty.

This note supersedes only the following full-access rules; independent restricted-execution, capability, result-ownership and stop-verification decisions remain.

| Decision | Replaced or retained rule |
| --- | --- |
| [Explicit modes](2026-09-19-explicit-access-modes.md) | Replace three-account full-access isolation, approval exceptions and fixed-confirm host execution |
| [Tool worker](../architecture/2026-09-20-tool-worker-per-task-container.md), [native sandbox](../architecture/2026-10-10-native-execution-sandbox.md) | Replace full-access launcher/environment/stop promises; retain restricted execution |
| [Two products](../architecture/2026-10-02-two-agent-products.md), [development launchers](../process/2026-10-09-dev-launchers.md) | Remove dedicated identities and extra full-access startup requirements |
| [Application data](../architecture/2026-09-23-main-app-data-space.md) | Remove destructive-data approval in full access |
| [Scheduler/outbox](../architecture/2026-09-24-scheduler-outbox.md), [archived news](../../archived/feature/2026-09-25-scheduled-news.md), [retired group chat](../simplification/2026-10-02-retire-core-group-chat.md) | Generic-task sends bypass approval while retaining provenance; news/fixed-send retirement belongs to the scheduling decision |
| [Service helper](../architecture/2026-10-03-service-management-helper.md), [standing permissions](2026-10-03-standing-permissions.md) | Remove full-access service approval/dedicated caller checks; standing permissions remain distinct, never converted into full access |
| [Delegation](../architecture/2026-10-03-work-delegation-subagent-task.md), [work copies](../architecture/2026-10-04-subagent-worktrees.md), [integration](2026-10-05-integrate-worktree-results.md), [messages](2026-10-05-subagent-messaging.md) | Propagate initiating authority instead of fixed confirmation; retain work/result ownership |
| [Telegram](2026-09-24-telegram-owner-entry.md), [QQ private](2026-09-24-qq-private-shared-main.md) | Replace fixed confirmation with main's default at task creation |
| [Auto-review](2026-09-22-auto-review-mode.md) | Replace dedicated full-access launch wiring, not automatic-review policy or restricted boundaries |
| [Unverified worker stop](../bug-fix/2026-10-11-preserve-unverified-worker-stop.md) | Retain unknown-stop occupancy/evidence; do not promise recovery of escaped full-access processes |

Other independent decisions remain: [MCP transport](../architecture/2026-09-23-mcp-client.md), [MCP write effects](2026-09-23-mcp-write-tools-approval.md), [Plan constraints](2026-10-08-plan-session-mode.md), [detached backend](../architecture/2026-09-19-detach-terminal-from-task-runtime.md), [offline instance import](../architecture/2026-10-04-legacy-instance-import.md) and [retired GitHub publishing](../simplification/2026-09-23-retire-github-module.md). Ordinary MCP originally exposed no local stdio; later managed Cua does not turn full access into arbitrary MCP configuration. Current-format Coding import remains separate, with source read-only, preview rejection of unsupported schemas and no authorization backfill. Current Personal no longer assembles its old importer.

## Execution and stopping

Full access reuses the current-account launcher. Workers register Shell command groups, verify their exit before acknowledging shutdown, and hosts require both that acknowledgment and original worker-group exit. Missing acknowledgment, failed inspection or survivors remain unverified; main-PID exit does not substitute for descendant cleanup. In the original shared service path, unknown service effects invalidate same-target standing permissions using the real target in `tool_ops.authorization.scope`, including independently scheduled work under the same business owner, without fabricated approval rows. Current durable services record that provenance through their own operations.

[Coding backgrounds](2026-10-21-coding-background-processes.md) and [Personal backgrounds](2026-10-21-personal-background-processes.md) now distinguish command completion from managed execution stop. The broader [background lifecycle proposal](../../proposed/feature/2026-10-14-bash-background-lifecycle.md) does not mean Personal background support is absent. This note's authority propagation and deliberate-detachment limits remain.

## Alternatives considered

- **Keep dedicated workers but simplify configuration.** This preserves backend/token isolation and existing Linux cleanup evidence, but still needs another account, rights configuration and launch chain, contrary to using the owner's normal account capabilities.
- **Remove only the sandbox, keeping data/send/service approval exceptions.** This separately constrains destructive edits and external sends but leaves one full-access mode stopping for approval on some paths. Choose consistent bypass with execution validation instead.
- **Make every task follow the conversation's current mode dynamically.** This looks simpler and makes entries agree after a switch, but rewrites existing schedules, in-flight children and delayed-message authority. Save the triggering authority on each new task.
- **Reuse the local launcher without changing environment or stop.** This minimizes code, but filters proxies/SSH agent/tool credentials and mistakes process-group exit for cleanup of detached descendants. It is not a complete solution.
- **Provide a compatibility transition for old deployments/configuration/schedules.** This reduces upgrade cost, but the owner accepts direct replacement during rapid iteration instead of aliases, authority backfills and dual paths.

## Verification

Original macOS/Linux acceptance used isolated temporary profiles and dummy credentials to run real backends, SDK and workers for both then-current products. It checked launch UID, user environment, outside-workspace reads/writes, network and ordinary-descendant stopping; killing the worker left stop unverified. Restricted native file/network controls still denied out-of-scope access. Raw results/commands remain in the offline full-access execution summary.

Model, IM and service-tool regressions used substitutes; the original implementation Issue identifies their scope and targeted checks. They do not prove actual platform sends, real models or service deployment, and evidence for the old Personal composition does not independently validate current durable adapters.

## Consequences

Consistent full access reduces identity/deployment configuration and retains explicit saved authority through delegation, late delivery and schedules. Shared `tool_ops.authorization` distinguishes full access from approval; notification intent and local authority commit together. The original new formats replace their predecessors without manufacturing permissions for old tasks.

Accidental deletion, credential reads, sends and backend-state modification are within the launching account's accepted trust scope. Interface validation cannot stop unrestricted commands from bypassing those APIs. User environments may contain proxy/tool credentials; worker environments are not credential-free.

Stopping covers only owned, verifiable processes. Survivors may modify files or consume resources; unverifiable stop blocks later directory use. If full access must later isolate backend identity or reliably reclaim all escaping descendants, reconsider deployment isolation and platform capabilities rather than claiming stronger prompts/path filters solve it.

Lowering the conversation default does not revoke existing tasks or schedules. UI/docs distinguish default mode, actual task mode and saved schedule mode. Direct replacement does not promise old deployment/storage compatibility and authorizes no automatic data clearing or system-account deletion. Real QQ/Telegram delivery, models and production cutover require separate acceptance beyond targeted substitutes.
