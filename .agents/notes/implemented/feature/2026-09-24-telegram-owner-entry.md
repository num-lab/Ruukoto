# Agent Note: Telegram owner entry, fixed replies, and same-operation rate-limit deferral

Status: implemented

Original identifier: ADR 0011.

## Problem

Telegram private chat provides main's first daily entry. External messages need durable conversation/replies without inheriting a full-access session default or giving the model arbitrary send targets. Telegram 429/retry_after can prove this attempt was not sent, requiring a narrow retry exception without replaying unknown effects. Original requirements are historical offline `.scratch/daily-agent/issues/04-telegram-owner.md`.

## Decision

- Trusted configuration fixes owner user_id + chat_id. Long polling accepts only matching private messages, initially text and later [images](../architecture/2026-10-07-inbound-image-staging.md). Wrong identity/groups/unsupported types record bounded rejection without tasks. Persist before dedupe/dispatch using `(source, external_id)` with `<botId>:<chatId>:<messageId>`; advance offset only after registration and process backlog. In the original shared orchestrator all external inbound sources, including scheduler, use confirm rather than main's full_access default. One approval affects one operation, not mode; later scheduled/full-access/personal rules are separately superseded.
- On a Telegram task's terminal result, register one public owner_reply in the same result/inbound-terminal transaction. Key is inbound event ID. Read the final answer from that task's history, never the latest session answer. Restart reconciliation creates the same idempotent record transactionally. Target is the original bot/chat/config generation, replying to the original message.
- Persist reply_target from captured polling configuration. Before registration/offset advancement, dispatch, task start, reply registration, and send, recheck source/actor/target/version. Binding/enablement/credential-reference changes advance generation monotonically; old polls/messages/approvals/replies never revive or redirect. Legacy replyTarget=null cannot prove original configuration and invalidates registered/queued work rather than inventing the current target. [IM approval/final reports](2026-10-02-im-approval-and-final-report.md) owns complete generation/approval rules.
- `RetryLaterError` means explicit platform refusal proving non-send: sending -> pending with not_before, then reclaim the same target/body/key. Cancellation while claimed makes canceled. Other clear refusal or failure before connection is failed; timeout after sending, 5xx, disconnect, or unparseable receipt is effect_unknown. Terminal operations never auto-resend. This is the [outbox](../architecture/2026-09-24-scheduler-outbox.md) rate-limit exception, not generic retries.
- Tokens use host-matching, narrowly scoped `telegram_bot` credential bindings; core stores only binding name/fixed owner. Bot API URLs contain the token, so redact errors before logs/ledger/status using the token captured for that request, including late errors after credential rotation.

## Automatic replies and invalid entry

Scheduled/ordinary child wakes do not auto-reply; IM-origin generic-work finalization is the explicit exception. Retired coding-draft wakes never send; [GitHub](2026-09-24-github-event-review.md) uses independent event-notification authority.

Startup `RUUKOTO_DISABLE_TELEGRAM` invalidates inbound and cancels queued tasks with `telegram_unavailable`. [QQ](2026-09-24-qq-private-shared-main.md) adopts the same inbound/task rule. Temporary offline state with unchanged generation waits. Poll health determines availability, so disconnected replies usually remain pending without calling the sender. Configuration disable/rebind cancels unsent replies and never redirects. Do not infer identical startup-disabled outbox behavior from inbound cancellation; the shared-entry note records that distinction.

Original settings were CLI/control-plane only. `--api-base` can use a controlled reverse proxy: HTTPS normally, HTTP only loopback, with unchanged token/target validation. Approvals can use host-parsed bound-private commands or existing owner-authenticated TUI/CLI. [The personal entry](../simplification/2026-10-18-personal-product-entry.md) and durable Telegram decisions own current client/menu wiring instead of these historical interfaces.

## Alternatives considered

- **Reply with the latest session answer:** simpler reuse, but main may already have answered a later message after task completion and before result commit. Recovery would send that answer to the earlier requester. Use task-specific history and test this crash window.
- **Make 429 terminal failed:** reuses the old no-terminal-retry rule, but explicit non-send plus retry_after justifies delaying the same record without replaying a possible effect. This owner-confirmed exception does not extend to uncertain transport errors.

## Consequences

Conversation continues in one main session with traceable original task/message/target. The original inbound confirm rule prevents inheriting a full-access default; narrow IM approval is not general control identity. Later [current-account full-access policy](2026-10-12-full-access-current-account.md) owns revised authorization propagation. Rate limits delay replies; unknown effects require owner verification and cannot guarantee remote exactly-once or delivery.

QQ/Telegram shared history is not separate data space. Deployments needing an API proxy must verify real connectivity; historical global fetch did not use HTTP_PROXY. Mock results do not prove actual platform compatibility. See [usage](../../../../docs/usage.md) for current configuration.

## Verification

Historical first delivery: macOS mock model/local Bot API, passing typecheck, 393 total tests with 392 passed and one default-disabled real-model test. `test/38-telegram-owner.test.ts` then had five cases covering shared main/original-message replies, dedupe, zero calls for wrong owner/groups/stickers, noninherited full access, token redaction, 400/502 no resend, same-operation 429 retry, reconnect, task-specific recovery, configuration/disable, single poll under overlapping starts/stops, and v13-to-v14 migration.

No real Telegram bot loop ran, and the owner explicitly excluded tx Linux acceptance in that delivery. Later Linux backend IM approval/report smoke is separate and still does not prove real Bot API behavior. This documentation migration reruns no runtime tests.
