---
name: error-handling
description: "Use when designing or reviewing failure paths, including throws, catches, retries, background work and diagnostics in packages or apps. Define failure identity, recovery/reporting ownership and what remains safe."
---

# Error Handling

Define what failed, who owns recovery, and what remains safe before choosing a catch or retry.

## Typed Failures

Cross-layer errors use a type with a `code`. Discriminate with `instanceof` and `.code`, not message parsing: code is machine identity; message is human text. Existing SQLite unique-constraint fallbacks are exceptional SDK-boundary handling, not a pattern for new application interfaces.

Use literal code unions when callers enumerate cases and a string code for transparent forwarding/reporting. Keep stacks, credentials, private paths and request bodies out of owner-visible error text; retain internal diagnostics at the appropriate layer.

## Recovery Ownership

Explain intentionally swallowed errors; leave no empty catch. Keep `try` limited to the failing operation. Catching an exception stops propagation, not changes already made. Only the state owner can decide that continuing is safe; otherwise stop dependent work, invalidate unusable state or propagate the failure. Logging alone is not recovery.

Retries must be safely repeatable, cancellable and owned. Finite operations need a retry budget; continuous supervision needs a lifecycle owner and observable degradation.

## Visible, Actionable Results

A final failure report gives the affected operation, a readable explanation and a safe next step. Claim success, rollback or safe retry only when guaranteed. If state is unknown or untrusted, expose that fact, its effect and the containment action; persisted invalid state needs durable visibility, not just a log.

Test the resulting state and user-visible outcome rather than merely checking that an exception was caught. Runtime diagnostics use `process.stderr.write` with `[ruukoto:*]`; `console.log` is limited to `packages/tui/src/cli.ts`, `tui/index.ts` and `config-tui/index.ts`.

## Tool Effects

Effect classification is a verifiable result:

- Approval not consumed: known not executed.
- Read-only operation interrupted: no write effect.
- Other effects cannot be verified: `effect_unknown`; do not replay.

Ownership and lifecycle details are in [tools and approvals](../../../docs/modules/agent-tools.md) and [runtime](../../../docs/modules/runtime.md).
