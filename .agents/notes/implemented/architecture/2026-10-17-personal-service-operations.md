# Agent Note: Prevent service-write replay through durable consumption facts

Status: implemented

## Problem

Personal durable can inspect services, but restart spans SQLite/systemd and may crash at any point after approval consumption. Native unsafe-tool recovery returns an error and lets the model continue, including retry with a new key. Old approval/operation ledgers import legacy Runtime authority, contrary to [Personal migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md).

## Decision

Trusted host API creates independent background service work from owner input already admitted to main. Mode is pinned at creation, default auto-review. confirm/auto-review need human approval unless valid standing authority exists; full_access needs no individual approval, following [full access](../feature/2026-10-12-full-access-current-account.md). The original slice exposes no model service-write tool. One-time approval affects only the original operation. [Telegram authority](2026-10-17-personal-telegram-permissions.md) supplies original-entry/standing grants, not arbitrary local grant scopes.

Consumption, started fact, and recovery checkpoint share one commit. Only the current invocation after that commit calls helper. Recovery seeing started without a result verifies/stops, never restarts. Trusted result and raw evidence commit together; storage failure closes Harness and reopening keeps unknown. Native Task owns execution state; document holds approval, provenance, effects, and stop evidence only.

[Recovery menus](2026-10-17-personal-service-recovery-controls.md) expose one-time effect verification plus independent stop recheck to local/original Telegram entries. Unknown work retains target occupancy. Same-owner-input service operations serialize, and another source cannot bypass the same occupied target; other targets/main chat continue. Owner may record took-effect/did-not-take-effect with evidence, but completion also needs matching machine/operation/command-unit stop proof. Cancel cannot turn unknown into not-executed. Stop collects only the fixed command unit, not jobs already accepted by PID 1. [Fixed helper](2026-10-03-service-management-helper.md) retains transport, argv, revisions, and one-time claims.

Unit-not-found alone cannot prove stop: restart helper may already have checked the stop marker but not dispatched. Claims therefore retain protected Linux PID/starttime/process-group/boot identity. stop-op verifies launcher/group exit before the command unit. Cross-connection D-Bus requests can still arrive late, so later not-found is evidence only with a durable original --wait success receipt, receipt of actually observed command unit, cross-boot evidence, or stop-first claim. Receipts bind original operation/launcher. Active, unknown, or old claims remain unverified. Personal requires explicit launcher-exit proof; old helpers lacking it cannot release targets.

[Inspection](2026-10-17-personal-service-inspect.md), [background work](2026-10-17-personal-background-work.md), helper, and authority notes retain their separate roles. [Child service operations](2026-10-17-personal-subagent-service-operations.md) later adds controlled restart under WorkTask authority/cancellation/unknown effects, without replacing independent host-operation rules.

## Alternatives considered

Child restart tools offer an immediate consumer but also require child provenance/authority, model suspension, and work completion. An independently verified host API comes first. Legacy ApprovalGate/ToolOpLedger is mature but reimports Store/Task authority; reuse stateless helper transport only. Unsafe-tool recovery avoids replaying the same call but cannot prevent a model changing parameters/key; unknown effects must suspend their work explicitly.

## Verification

Historical `.scratch/personal-pi-durable/issues/06-service-operations.md` covers kill between real effect completion and result commit with zero duplicate calls, one-time consumption, revision/provenance checks, retained unverified occupancy, and storage-failure recovery.

## Consequences

SQLite/systemd are not atomic: started-but-undispatched work may conservatively pause. Trusted host API initiates this slice, Telegram queries/approves/manages standing authority, and [CLI configuration](2026-10-17-personal-service-configuration.md) enables it. Complete A5/A6/A11 acceptance remains separate; later wiring cannot derive authority from configurable request parameters. Per-request documents retain facts and native Task cursors page lists. Conflict checks scan native records; an active-reference index should follow demonstrated historical scale. Stop may require observing the unit or a new boot. Human effect evidence never substitutes for stop. The benefit is no replay after consumption/crash; conservative pauses are the cost.
