# Agent Note: Durable tasks connect owner input and fixed replies across two IM platforms

Status: implemented

[Online IM updates](2026-10-25-personal-im-updates.md) supersedes stopped-only pairing and startup-fixed API objects. Source identity, pinned authority, and unknown-send rules remain. Pairing below describes the identity protocol; ordinary configuration no longer requires stopping the backend.

## Problem

[The Personal migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) had a local conversation and host service API but no proof of the owner's real platform identity. The old Telegram adapter depended on core Store, Runtime, and SchedulerStore, so reuse would restore the old authority. A provenance API alone would not provide usable owner chat.

## Decision

Use platform HTTP and native durable tasks to connect Telegram private text to the single main conversation, not the old adapter. The initial wizard paired under a stopped profile lock; current online pairing follows the linked update decision. Credentials stay in environment, with only variable name and SHA-256 fingerprint in configuration. `getMe` verifies the bot, and a random private pairing message lets the operator select the owner. Pairing or disablement creates a new generation; credential change requires re-pairing. Users do not enter raw owner IDs, request keys, or watermarks.

After explicit owner selection, discard the dedicated bot's old backlog and observe a pairing batch. Complete one successful `getUpdates(last + 1)` within 60 seconds of receiving that batch before saving the binding. That acknowledgement discards the selected batch and earlier messages; updates returned by it remain unacknowledged for the backend. Platform acknowledgement and file save are not atomic: save failure must disclose that the boundary may already be acknowledged and require pairing again.

Runtime never persistently reuses a numeric offset or excludes messages by ID ordering. Each batch has at most 16 updates, budgeting text/references within a 1 MiB bounded receipt. Only after all are committed may the next request acknowledge last ID + 1 within 60 seconds of receipt; empty batches, failure, or expiry clear the short-lived acknowledgement, and restart sends no offset. Telegram may randomize update IDs after a week idle, so a permanent monotonic watermark can lose messages. Sources: [getUpdates](https://core.telegram.org/bots/api#getupdates) acknowledgement/negative-offset semantics and [Update](https://core.telegram.org/bots/api#update) ID behavior.

Each owner message atomically saves fixed bot/owner/generation, original body, stable message key, and background task; watermarks are diagnostic only. The task admits to main with that key, recovering the same Submission across the commit window, and reads only that `Submission.answer`. Full answers stay in durable; platform text is bounded by Unicode characters. [Inbound snapshots and host controls](2026-10-17-personal-telegram-permissions.md) own service authority derived from this provenance.

### Sending and shutdown

After fixing body and original target, the task commits `sending` and a verify checkpoint before exactly one request. Lost result commit, timeout, disconnection, 5xx, or malformed response remains effect unknown; recovery records uncertainty and never resends. Only a verified explicit 429 rejection allows durable delay of the same send; other explicit 4xx refusals are failures. Configuration changes cancel old not-yet-admitted input and pending replies, not history already admitted to main or unknown facts from sends already started.

The backend exclusively owns Harness, polling, and local management. Normal stop drains polling before Harness close; fault shutdown drains polling/interface before unlock. Backend stop does not call `main.abort`, and client disconnect is not cancellation. The CLI shows the latest 16 receive/send states and connection diagnostics, with no resend button for unknown sends.

### QQ transport under the same rules

QQ reuses receipt/task/menu/report logic and shared `OneBotClient` transport, not QqAdapter or old Store. Existing document/task kind names and the `telegram` provenance field remain to preserve old admission evidence; `platform: "qq"` distinguishes QQ, with omission meaning Telegram only. QQ identities are never encoded as Telegram identities. Entry, menu, approval, grant, append, and verification checks each compare platform, account, owner, and generation. Defaults are platform-specific; QQ generation change restores auto-review and increments permission version. Shared main history carries no cross-platform authority. A QQ extension marker makes old programs reject semantics they cannot understand.

Pairing verifies the online login account and uses a random friend-private phrase to select a different owner account, pinning service address and token fingerprint. Accept only `message/private/friend`, verify `self_id` against the live connection, and refuse temporary group conversations, self-messages, or missing identity. Preserve signed message IDs; deduplicate by `qq:account:owner:message`, not numeric watermark. Fresh pairing proof stores platform time and stable message identity. Redelivery of the pairing message, messages at the platform boundary, and messages in the same second do not execute; local-clock inference must not turn backlog or the pairing phrase into main input. Rebinding never moves/deletes committed history.

[OneBot forward WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md) has no inbound acknowledgement or disconnected backlog fetch. Only durable commit means locally accepted. Startup/disconnection/reconnection and receive gaps are persisted and shown; automatic recovery of disconnected messages is not promised. A bounded queue admits sequentially; persistence/conflict failure stops the entry. Normal stop drains admission and connection records before release.

Before sending begins, an offline original QQ account delays the same task for reconnection. Once a request is sent, response loss is unknown. [NapCat action handling](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/OneBotAction.ts) can return `failed/1200` after execution; shared transport therefore cannot treat that as definite failure. Only known invalid-parameter/unknown-action rejection codes establish unsent status. Do not parse wording to guess throttling: without a verifiable structured OneBot/NapCat retry contract, retain uncertainty. Telegram's explicit 429 rule is separate. `echo` correlates responses, not idempotency.

QQ image/text uses shared media, persisting platform file identity while URLs remain transient download credentials. Missing URLs use `get_image`. Download only from the explicit QQ HTTPS image-CDN list, including `multimedia.nt.qq.com.cn`, with no local platform paths, connection token, or redirects. Image and original QQ receipt/task/submission are bidirectionally verified. Rejected media does not let the text alone reach the model; captions are not control messages.

## Alternatives considered

- Add only a host provenance API: easier to isolate permissions, but neither proves real identity nor enables chat. Deliver a text vertical slice first.
- Reuse the Telegram adapter: already supports media, credentials, and notifications, but restores old core/scheduler state. Keep old callers separate and use platform fetch plus durable facts.
- Persist a monotonic offset: straightforward polling, unsafe after idle ID randomization. Use short-lived one-shot acknowledgement and permanent message-key deduplication.
- Add service approvals/grants at the same time: a quicker business loop, but adds provenance, choices, approval, and unknown-effect interaction before input/output can be independently verified.
- Copy a second QQ control state machine: clear platform names, but duplicates approval/recovery and risks drifting identity checks. Separate transport/configuration and share execution/control.

## Consequences

Local, QQ, and Telegram owners use one main history with stable source facts across redelivery/restart and no automatic duplicate reply after uncertainty. Every inbound message costs provenance, send facts, and a background task; conservative error classification may require owner platform inspection. [Delegation reports](2026-10-17-personal-delegation-reports.md) owns asynchronous final replies, [media](2026-10-18-personal-browser-media.md) owns images, and each tool owns its own write authority. Process-crash checks do not establish platform/SQLite atomicity or power-loss durability of the newest commit.

The original audit found partial overlaps with [local management](2026-10-17-personal-local-management.md), [foundations](2026-10-17-personal-durable-foundation.md), [service operations](2026-10-17-personal-service-operations.md), [old IM controls](../feature/2026-10-02-im-approval-and-final-report.md), [standing permissions](../feature/2026-10-03-standing-permissions.md), and [old QQ shared-main entry](../feature/2026-09-24-qq-private-shared-main.md); it did not absorb their independent decisions.

Historical validation/review and real-platform gaps were recorded in retired `.scratch/personal-pi-durable/issues/07-telegram-entry.md` and `31-qq-owner-entry.md` (offline provenance). This note does not turn those gaps into passes. [Persistent questions](../../proposed/feature/2026-10-21-persistent-owner-questions.md) preserves the broader proposal; the [implemented questions](../feature/2026-10-21-personal-owner-questions.md) uses fresh trusted answer admission and fixed-key continuation rather than disguising answers as the old IM message.
