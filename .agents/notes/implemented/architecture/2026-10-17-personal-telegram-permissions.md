# Agent Note: Original Telegram receipts and host choices own service permissions

Status: implemented

[Personal IM updates](2026-10-25-personal-im-updates.md) owns online entry changes and short pre-send locking. Old generations do not regain authorization; permissions/approvals still verify original sources here.

## Problem

The [text entry](2026-10-17-personal-telegram-entry.md) only records messages, and [service work](2026-10-17-personal-service-operations.md) only has trusted host approval APIs. Turning chat text into decisions lets models or expired entries authorize operations. Reconstructing old input with current default mode expands its delegation.

## Decision

Ordinary Telegram input saves mode/version in the receipt transaction. Service requests reference original Submission/receipt and recheck the original binding before execution. Mode changes affect new receipts only. Old receipts without permission snapshots still support chat but cannot create new service work. Legacy Telegram-source service work becomes invalid before consumption; consumed work retains unknown-effect verification/occupancy. Existing explicit authorization from trusted local APIs remains separate. The host parses complete approval commands at receipt, outside model input/queueing.

The host stores choice relationships using Telegram message IDs from confirmed sends. The owner first queries `/审批`, `/服务状态` or `/授权`, then replies to that host message with a listed action. Each operation remains bound to original bot, owner and configuration generation. Forwarding grants no decision eligibility; quoted content is not parsed. Control-receipt deduplication, decision, authorization and fixed acknowledgement intent commit together. Native Task sending/verify retains lost outcomes without replay.

Accepted control receipts save structured decisions and created-authorization references; grants verify the reverse reference. An unaccepted receipt with identical text cannot substitute. Once historical unknown effects/stopping are verified, that old operation does not revoke later new grants again.

Standing scope follows [bounded service authorization](../feature/2026-10-03-standing-permissions.md), created only from the original pending approval. Neither full_access nor models get a free-form grant API. Original operation/control-message source is retained; every consumption rechecks binding, deployment revision and grant version. Revocation committed first returns unconsumed candidates to manual approval; consumption committed first does not undo the external operation. Unknown service effects invalidate every entry's grants for the same machine/unit, while the service Task retains unknown occupancy. Independent one-use approval does not depend on another grant.

The migration preserves unconsumed approvals through restart and rechecks before execution; the shared foundation's restart-invalidation rule is not transplanted. Main registers the empty personal-telegram-permissions extension marker in the same commit as permission records, so old code rejects an unrecognized profile. Missing/version-mismatched new grant/permission records or service references reject recovery rather than guessing from latest configuration.

## Related decisions

The original audit searched durable, Telegram, original-IM approval, standing authorization and unknown effects. Migration, text entry, service work, [shared approvals](../feature/2026-10-02-im-approval-and-final-report.md) and bounded service authorization retain their separate decisions. This changes Personal durable only; old Runtime/core consumers keep their rules. No note was wholly absorbed or obsolete.

## Alternatives considered

- Text commands with full approval IDs/versions: simple implementation, but makes the owner manage internal identifiers. Use replies to original host messages.
- Ask main to interpret controls: flexible language, but cannot guarantee source, idempotent decisions and zero-model approval. Parse only complete listed actions.
- Add model service writes/configuration wizards together: faster end-to-end flow, but requires model-work ownership and unknown pauses. This slice first completes a verifiable permission loop using trusted-host requests; later service/configuration notes own their additions.

## Verification

Original zero-model controls, entry/generation/snapshot checks, redelivery, recovery, standing grants, revocation races and unknown-effect counterexamples are recorded offline at `.scratch/personal-pi-durable/issues/08-telegram-service-approval.md`.

## Consequences

Reply relationships depend on trusted platform message identity. Unknown sends have no verified menu message ID, requiring a new explicit query. Query/decision acknowledgements can themselves have unknown send results: inspect original records rather than infer non-decision from a missing receipt. Service configuration/model-write implementation and real-platform/complete-product acceptance remain separately owned; this permission slice alone proves none of them.
