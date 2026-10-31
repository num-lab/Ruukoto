# Agent Note: Switch Personal IM platforms independently and pin send handles

Status: implemented

## Problem

QQ API, Telegram configuration, and polling lived in a startup closure. Removing only the stopped-backend requirement would leave questions, replies, delegation reports, and scheduled reports using stale connections. Asynchronous gaps between provenance check/main acceptance and send claim allowed rebinding races. CLI-only pairing proved the shell environment, not backend credentials or transfer of an already started send.

## Decision

personalTelegram owns current configuration, a short mutex, polling stop signal, and send handle separately for each platform. Provenance verification, main.submit, and submissionId persistence share one platform critical section; model requests and answer waits stay outside. Each new acceptance checks the running entry is neither paused nor switching, not just durable configuration that may lag. Committed-operation recovery/results keep original records. Main replies, question continuations, delegation reports, and scheduled execution all use this entry. Rebinding stops only that platform's old input; committing a new generation invalidates old unsent replies/approvals without waiting for the main model or changing the other platform.

Send claim and handle selection share the short section; sending persists configurationVersion in the same transaction. Network work uses the pinned handle outside the lock. Later configuration does not retarget or reauthenticate it. Stopping QQ input retains an old socket while claimed sends remain, closing after the last finishes. Whole-backend stop waits for all sends. Unknown outcomes stay original and are not resent after switching. Saving identical configuration updates selection version without reconnecting or reviving a retired generation.

Pairing runs in the original backend through a fixed settings action. Clients generate a stable pairing key; equal key/parameters return original facts without confirming Telegram watermarks twice, and unequal parameters reject. Backend validates its credentials/account using a random phrase observed in a real private/friend message. Session-scoped ruukoto.im-pairing stores request, credential reference/digest, account, candidate, and phase facts, never token. Telegram takeover/confirmation records intent before observed result; a lost reply does not imply external rollback. Expiry/cancel resumes original input. Confirmed candidates keep their platform paused until conditional save, abandonment, or deadline.

Confirmed configuration carries pairingId. Backend consumes proof against platform, complete configuration, and original settings-operation version. The same operation may recover, but a new operation cannot reuse old proof to revive an old generation. Disable never reads stale tokens. Missing IM credentials take only that entry offline, not chat, management, or other configuration. Offline save does not pair; an unverified new binding cannot masquerade as verified after startup.

This implements the IM slice of [operation-scoped configuration](../../proposed/architecture/2026-10-25-operation-scoped-configuration.md). [Dual-platform entry](2026-10-17-personal-telegram-entry.md) loses stopped-only pairing/startup-closure restrictions while retaining provenance, short-lived offsets, unknown sends, and QQ input-gap limitations. [Entry authority](2026-10-17-personal-telegram-permissions.md), [questions](../feature/2026-10-21-personal-owner-questions.md), [reports](2026-10-17-personal-delegation-reports.md), and [schedules](2026-10-18-personal-durable-scheduled-work.md) retain business recovery/authority.

## Alternatives considered

Restart-on-save reuses old assembly but interrupts unrelated models and the other platform. Holding mutexes during model/network waits simplifies timing but lets one slow answer block rebinding. Closing QQ immediately interrupts issued requests and loses original replies. CLI pairing keeps the wizard but cannot authorize backend credentials; retain interaction while moving verification to the backend.

## Consequences

Both platforms can update independently while old requests, questions, reports, scheduled notifications, and started sends remain explainable. Costs are short-lived pairing facts and old QQ sockets until sends finish. Telegram takeover changes an external watermark; later failure cannot guarantee restoration of platform-acknowledged backlog.

Offline regressions use real local sockets, a separately credentialed backend with a tokenless CLI, acceptance-commit windows, in-flight-model rebinding, claimed TG/QQ sends, paused/stopping input with questions/schedules, proof-reuse rejection, and killed-old-send recovery. Real Telegram/QQ account acceptance was explicitly not run for the original task; substitutes are not platform passes.
