# Agent Note: Update affected configuration objects while retaining original operation identity

Status: proposed

## Problem

Personal configuration originally coupled reads, saving, activation, and the whole backend lifecycle to a stopped lock-holding wizard. Read-only access could contend for the lock; request-refreshable skills still required restart; bad model environment blocked unrelated changes; command/service paths were permanently profile-bound. Code catalogs and Personal schedule scopes also treated display-name changes as execution changes.

On 2026-10-25 the owner approved removing these restrictions while preserving actual authority, the single writer, original operations, and history recovery. This note retains the overall proposal and audit, not a claim that every acceptance item is complete. R1-R8 runtime changes are implemented under [saving/activation](../../implemented/architecture/2026-10-25-personal-settings-versions.md), [request configuration](../../implemented/architecture/2026-10-25-personal-request-configuration.md), [IM updates](../../implemented/architecture/2026-10-25-personal-im-updates.md), [execution versions](../../implemented/architecture/2026-10-25-personal-execution-configuration-versions.md), and [non-execution checks](../../implemented/simplification/2026-10-25-configuration-checks.md). MyGo real-machine acceptance remained outstanding in the source record. Retired `.scratch/configuration-updates/spec.md` and `issues/01-remove-global-restrictions.md` are offline provenance for the original sequence and acceptance matrix.

## Proposal

The profile's current writer saves configuration: the lock-holding backend online, the same profile lock offline. Each module owns selection and activation; ordinary saves do not require service lifecycle changes. File replacement and SQLite commits record intent, saved state, and active state separately. After disconnection, query the original operation rather than saving again or resending business requests.

Compare content revisions, execution eligibility, and external-operation identity separately. Display names may change while old model requests, MCP calls, IM sends, commands, and service operations retain their original selection. Disable/revoke affects relevant not-yet-started execution, not effects already produced. Adding capability never widens old schedule or approval scopes.

Reuse existing modules, SDK updates, configuration entries, control authentication, and remote admission; add only missing versions/receipts, not a generic plugin registry, arbitrary configuration scripts, multiple backends, or another task state machine. The original proposal also named `ManagedSkillsStore` for reuse; [HOME skills discovery](../../implemented/simplification/2026-10-28-home-skills-discovery.md) subsequently retired that manager. Renderer displays backend save/activation outcomes, not a second authorization implementation.

Same-machine command/service migration switches only after the affected capability is quiescent. Old terminal history validates against original configuration; current configuration selects new operations only. Verification that still touches an old execution uses its original machine/path/helper. Relevant unresolved work blocks that target, not unrelated settings, and absence in a new environment never proves old execution ended. Cross-machine takeover and whole-profile migration are outside scope.

MCP display-only changes remain compatible only when immutable configuration history proves uninterrupted absence of substantive changes. Changing capability and changing it back cannot revive an old plan or approval. Code relaxes checks only for clearly non-executing fields and genuinely new models; unknown advanced fields retain conservative affected-provider checks.

## Existing-note audit

The 2026-10-25 audit searched personal/settings, stop requirements, immutable configuration, generations, model gates, and schedule scopes across active notes. These partial overlaps retain independent identity, authorization, credential, and recovery decisions:

| Existing decision | Originally proposed change |
| --- | --- |
| [Personal settings](../../implemented/feature/2026-10-21-personal-settings.md), [SSH maintenance](../../implemented/feature/2026-10-21-personal-settings-ssh.md), [Personal pages](../../implemented/feature/2026-10-21-desktop-personal-pages.md), [Tailscale](../../implemented/architecture/2026-10-24-personal-tailscale-https.md) | Remove ordinary stop/save/start and old-model/systemd/global-idle prerequisites; retain old maintenance receipts/authentication |
| [Local management](../../implemented/architecture/2026-10-17-personal-local-management.md), [memory/skills/history](../../implemented/architecture/2026-10-18-personal-memory-skills-history.md), [managed skills](../../implemented/feature/2026-10-21-managed-skills.md) | Change read/config lock entry and stopped-only skills management; retain each model request's selection evidence |
| [Personal MCP](../../implemented/architecture/2026-10-17-personal-durable-mcp.md), [schedules](../../implemented/architecture/2026-10-18-personal-durable-scheduled-work.md) | Replace whole-config generation blocking, bad-credential disablement blocking, and name-only plan invalidation; retain actual capability and original-operation checks |
| [Commands](../../implemented/architecture/2026-10-17-personal-command-configuration.md), [services](../../implemented/architecture/2026-10-17-personal-service-configuration.md) | Replace permanent immutability/history-against-current comparisons; retain old execution identity and related occupancy |
| [Tools/data](../../implemented/architecture/2026-10-17-personal-tools-access-artifacts.md), [Telegram](../../implemented/architecture/2026-10-17-personal-telegram-entry.md) | Replace startup-captured configuration/global stopping; retain targets, data, pairing generations, send facts |
| [RuntimeModels](../../implemented/architecture/2026-10-23-runtime-models.md), [Code model settings](../../implemented/feature/2026-10-21-code-model-settings.md) | Classify provider changes; retain publication, rollback, references, complete-operation shutdown |
| [Desktop settings proposal](../feature/2026-10-21-desktop-settings-management.md) | Narrow Personal stopped-save scope; retain other delivery and external-acceptance requirements |

Workflows, old scheduler/outbox/import/QQ/Telegram, SubAgents, application data, and permission notes keep their execution semantics; callers consuming new configuration need corresponding regressions. Existing owner-operation-scope checks only narrowed reads/verification, not configuration switching. The audit found no fully absorbed/archive candidate or obsolete proposal to delete. Actual supersession is recorded in the implementation notes, not inferred from this audit table.

## Alternatives considered

- Delete stop/idle checks only: immediate UI freedom and minimal diff, but stale closures, competing writers, and new configuration contaminating old recovery remain.
- Restart automatically after each save: reuses startup/maintenance, but interrupts unrelated work and still requires systemd and the old model environment.
- Introduce a generic configuration framework with arbitrary concurrent versions: unifies modules at the cost of wider APIs/migration/maintenance. Existing modules already own most operation identity.
- Deliver only skills/display names and keep directory/IM restrictions forever: accepted as a lower-risk first slice, not completion of the owner's approved migration/online-configuration goal.

## Acceptance criteria

The historical A1-A12 matrix requires same-PID online activation, offline saving without service startup, uninterrupted unrelated work, no retargeting of old requests/approvals/results, relevant unresolved operations still blocking unsafe switches, and original-key verification at save/activation failure windows. Schedule checks must run the real implementation, not a test-local deep comparison.

New-format migration retains old history and makes old programs refuse unknown semantics. New clients never silently fall back to stop/save/start on old backends. Old unresolved maintenance stays queryable/recoverable; deployment upgrade and each ordinary save have distinct acceptance. Independent plan and implementation reviews are separate. Substitutes do not prove real Electron/MyGo, Linux, model, or IM behavior; missing external evidence remains pending.

## Risks

Files, durable selections, and in-memory objects have no cross-storage transaction. Each failure window needs recoverable facts; saved-but-inactive candidates must not be reported active or automatically rolled back by replacing files. New request evidence/format markers must cover the whole recovery chain, not only settings entry.

Historical references increase, but retain only versions that actually existed and are needed for recovery; add no physical garbage collection. Command/service switching may wait for verification in the old environment; expose this as target-specific waiting, not global read-only state. Old model/provider/IM handles must not be released early, and disablement never proves external execution stopped.
