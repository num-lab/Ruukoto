# Agent Note: Replace repeated service decisions with narrowly scoped standing permissions

Status: implemented

Original source: ADR 0019, phase-boundary supplement dated 2026-10-03, issue 10 delivery.

This records the original shared Personal runtime and its retained ledger rules. [The personal entry retirement](../simplification/2026-10-18-personal-product-entry.md) removed that runtime's service-tool assembly. Current durable Personal service grants follow [personal service operations](../architecture/2026-10-17-personal-service-operations.md), not the historical commands in this note. [Current-account full access](2026-10-12-full-access-current-account.md) also supersedes the original claim that every mode requires these approvals.

## Problem

The fixed service helper originally required a fresh owner decision for every privileged operation, even repeated restarts of the same allowlisted service. [The product decision](../architecture/2026-10-02-two-agent-products.md) required revocable authorization for a specific target and action without granting arbitrary root access or reusing a one-shot approval across tasks.

## Decision

The first standing permission covered only `restart` of one local allowlisted service, requested by the old Personal main through its original IM entry. Its immutable scope bound main session and original data identity, stable channel/account/chat/actor, NotifyTarget configuration generation, machine identity, canonical unit, action, policy revision, and unit revision. It excluded task/tool-operation IDs and transient request state. A shared main session did not let another platform, TUI, schedule, GitHub event, or child message inherit it. The root allowlist remained the capability ceiling; the [service helper](../architecture/2026-10-03-service-management-helper.md) still performed the operation.

Protected core storage held `standing_permissions`, not application data, memory, instructions, skills, `grantedPaths`, or root policy files. Scope changes required revoke-and-create. Stable entry/main/machine/target/action allowed at most one unrevoked grant; policy/configuration revisions determined eligibility at use, and the originating approval was unique. Revocation or invalidation incremented the row version and retained a reason; repeated revocation at the same version was idempotent, and old generations never revived. Neither old one-shot approvals nor full access implicitly created grants.

Only the original IM entry could create one from a pending service-restart approval. Historical `/approve-standing <fullApprovalId> <permissionVersion>` approved that operation and saved its existing immutable scope; it accepted no new target/action. The host checked active main/task, inbound ownership, permission version, trusted actor/target, and deployment revision. Grant, decision, linkage, audit, terminal control-event state, and receipt committed together before wakeup. Consumption reread the grant so revocation could invalidate this first use too. Ordinary `/approve` stayed one-shot.

Historical `/service-grants`, `/service-grant`, and `/revoke-service-grant` reused [IM control-message](2026-10-02-im-approval-and-final-report.md) whole-text parsing, trusted identity, source idempotency, no model/ordinary task, and fixed outbox. Natural language, quotations, forwards, models, and child messages could not create or widen grants. The current trusted stable entry could inspect/revoke old generations without making them executable. An authenticated control plane and `ruukoto service-grant` managed leftovers after entry disablement; neither provided an arbitrary-scope creation API. A lost management response required reading the original record before another write, not automatically changing the key.

### Per-operation use and races

`service_manage` first checked the real target and revision through the helper. The host, never the model, selected a candidate grant. A synchronous transaction rebuilt and checked its exact scope/version, activity/cancellation, main, fixed IM provenance, and deployment policy; it then created a separate approved record for the new task/host-operation/permission version and used common one-shot consumption. The standing grant itself was not consumed. A task stayed running: no fictitious waiting state, approval notification, newly approved-by-owner event, or auto-review call. Decision provenance was `standing_permission`.

An invalid candidate before consumption returned to manual approval. Originally all modes required manual approval without a valid grant; the later full-access decision changes that mode policy, not the one-shot ledger semantics. This feature did not widen destructive application-data, notification, or MCP-write permissions.

Revocation committed first invalidated unconsumed uses; consumption committed first meant execution had begun, so revocation affected future uses and could not cancel a job already accepted by PID 1. Policy/unit changes, IM rebinding, disable/re-enable, owner/account changes, or credential-generation changes incremented and invalidated grants. Temporary disconnection was not rebinding; normal restart retained valid grants but invalidated old unconsumed approvals. Revoking a grant did not invalidate an unrelated independent one-shot approval.

After consumption, only a trusted pre-request refusal or definite command result established a known outcome. Protocol mismatch, wrong ID, capture/persistence failure, or another untrusted result meant effect unknown. `ToolOpLedger.markEffectUnknown` atomically invalidated every active grant for the same main/machine/unit/action across entries, incrementing versions and retaining reason and operation ID. Exceptions, stopping, recovery, and result-write failure used the same rule. A new operation ID or another entry could not enable automatic retry; the owner had to verify and explicitly authorize again, while the unknown record remained. Outbox uncertainty was separate and did not revoke service grants. For `systemd-run`, only ENOENT/EACCES/ENOTDIR at startup proved no dispatch; other startup failures or signals were potentially dispatched, not guessed from exit codes.

## Alternatives considered

The original specifications, issue, and ticket draft recorded no independent alternatives. Do not manufacture retrospective tradeoffs; any broader actions or targets need a new decision. Offline provenance: `.scratch/agent-direction/issues/10-standing-permissions.md` and the original `smoke-10-standing-permissions.mts`.

## Consequences

Exact-scope repeated operations avoided repeated human decisions while retaining per-use versions, independent approvals, and audit. Every use still had to reconstruct scope and verify target/entry revisions; uncertainty required owner verification and renewed authorization. Grants were neither cross-entry, editable, wildcard, nor automatically renewed.

Historical implementation evidence records core v22-to-v23 and control protocol v10: old approvals retained provenance with no grant link, no grants were synthesized, and old history stayed readable. Test/79 passed 23/23 with real Runtime/SQLite and platform/helper fixtures; required joint tests, typecheck, and test/67 passed. The full suite had 861 passes and one gated real-model skip among 862 cases.

Original Linux smoke-10 used real helper/sudoers/systemd, a controlled service, isolated backend, and CLI with simulated model/messaging. After an initial fix, two reruns and a final-code run each passed 14/14. Evidence covered exactly one execution for the current and next task with distinct task/operation/approval IDs sharing one grant; v1-to-v2 revocation and redelivery idempotency; zero execution after invalidation; real in-flight `systemd-run` killing followed by effect unknown and all-entry invalidation; and execution-account boundary refusal. Real QQ/Telegram, platform throttling, and redelivery fault injection were not tested. This is historical evidence, not acceptance of the durable replacement.
