# Agent Note: Private QQ and Telegram share main while replies stay on their original platform

Status: implemented

Original identifier: ADR 0012.

## Problem

Adding owner QQ friend-private messages after Telegram should reuse main identity/history without group-session mixing or turning QQ identity into control-plane authentication. Entry filtering alone cannot isolate group data already available to main. Original scope is historical offline `.scratch/daily-agent/issues/06-qq-private.md`.

## Decision

- Reuse the NapCat OneBot v11 forward WebSocket, registering durable `qq_private` inbound events, not group sessions/outbox. Initially friend text/reply IDs only; [image staging](../architecture/2026-10-07-inbound-image-staging.md) later adds images. Temporary group-private messages, unsupported formats, strangers, self echoes, wrong self_id/sender create no task. Require a token, verify account with get_login_info, and online state with get_status/heartbeat; offline entries admit no new tasks.
- Deduplicate by login account/owner/message ID and persist reply_target at reception. Recovery/dispatch/task start/reply registration/send all recheck original platform/account/owner/actor/config version. QQ connection generation includes configVersion; reference changes and same-name credential modification/deletion advance monotonically. A -> B -> A does not revive old connections/messages/approvals. [IM approval/final reporting](2026-10-02-im-approval-and-final-report.md) owns complete credential/generation rules.
- Ordinary replies use public `notification_ops` with qq_private source, task-specific body, and original platform/account/owner/version. Reconfiguration invalidates, never redirects. New notifications/schedules requested by QQ-source tasks bind their original QQ target and still require approval; other legacy tasks use the Telegram default, not broadcast. Unknown does not resend; explicit rate refusal retries the same operation. Scheduled/ordinary child wakes do not auto-reply except the [IM work final-report rule](2026-10-02-im-approval-and-final-report.md).
- Original inbound tasks use confirm, never a mode selected in QQ text. Text cannot grant full access or general control authority. Host-parsed bound-private approval commands can decide only a specific original-entry request and one execution; sharing main does not transfer approval authority between platforms. Later mode and personal durable semantics belong to their successors.
- Startup `RUUKOTO_DISABLE_QQ` (fixed for legacy development instances and Coding) does not connect. It invalidates original inbound events with `inbound.skipped` and cancels queued tasks with `qq_private_unavailable`; otherwise registered/queued QQ work would block Telegram/TUI on the shared main queue. Startup-disabled configuration cannot prove the pinned target valid. A present adapter temporarily offline/unconfirmed instead waits; transient loss does not cancel delegation.

## Group-data and shared-history limits

Main and the retired coding role cannot directly read original qq_group projects or derived group-sourced records, even with cross-project grants. Old coding delegation is not a bypass. Generic SubAgents inherit no bypass after [group retirement](../simplification/2026-10-02-retire-core-group-chat.md). History/artifacts/memory lists and versions, automatic memory injection, delegated data, notification sources, and old schedule details use the same source checks.

Owner control-plane and ordinary development-project grants retain their existing scope. Restrictions do not delete content already copied into main/coding history or application data, nor identify unmarked paraphrases. QQ and Telegram intentionally share history; platform-to-platform confidentiality would require changing that session decision, not extra entry filtering.

The old missing/disabled QQ adapter returned wait while Telegram dropped. It indefinitely blocked registered/queued work and later TUI/Telegram tasks. Historical offline `.scratch/architecture/issues/10-im-owner-entries.md` changed inbound/task behavior to invalidate/cancel while preserving wait for temporary offline state.

## Alternatives considered

**Keep waiting when QQ is startup-disabled:** preserves old registered/queued work like transient disconnect, but explicit disabled startup cannot establish the old target and blocks other entries. Distinguish disabled from offline. The original shared-session interview/spec recorded no other alternatives; none are invented here.

## Consequences

Either platform can continue one conversation; replies/approvals/final reports remain tied to their original entry and do not leak to rebound targets. Reusing NapCat/public outbox avoids another reply state machine; per-channel claims prevent offline Telegram backlog from blocking QQ.

There is no platform-private history boundary. Group restrictions cover verifiable provenance, not already copied/unmarked content. Startup-disabled public outbox operations intentionally remain pending with `sender_unavailable`, whereas configuration disable cancels old-target pending sends. Thus startup/config-disable equivalence applies to inbound/tasks only, not outbox; unifying send behavior would require a separate decision.

[The personal product entry](../simplification/2026-10-18-personal-product-entry.md) replaces legacy assembly/entry wiring; this note's shared-runtime commands and QQ path are not a claim that new personal supports all old entries. [Current-account full access](2026-10-12-full-access-current-account.md) owns later mode rules.

## Verification

Historical QQ delivery: macOS mock model/OneBot, passing typecheck/diff check; 418 tests, 417 passed, zero failed, one gated model skip. `test/40-qq-private.test.ts`, `test/41-qq-private-scope.test.ts`, and transport tests cover main sharing, dedupe, credentials/identity, original targets, heartbeat/offline, failure/missing receipt, config invalidation, restart, group scope, v14-to-v15 migration, and QQ progress behind 51 offline Telegram sends.

Architecture issue 10 added `test/89-im-entries.test.ts` for fake-entry reconcile, bounded replies/reports, target invalidation, credential references, Telegram default/QQ exception; real adapters/loopback prove startup disable neither connects nor polls. Test/40's disabled-on-restart queue regression times out with the old wait gate and completes later TUI work with the fix. The historical full report states 906 total/904 passed and an existing test/08 DNS failure; it does not establish an all-green suite.

Initial work did not test real NapCat/QQ or Linux deployment. Later macOS/Linux backend approval/report smoke is separate and still not real-platform evidence. This migration reruns no runtime tests.
