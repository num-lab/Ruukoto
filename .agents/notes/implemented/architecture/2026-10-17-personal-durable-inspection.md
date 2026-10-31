# Agent Note: Durable service inspection persists ownership before verifying original execution

Status: implemented

## Problem

The [helper identity protocol](2026-10-17-service-inspection-identity.md) can verify fixed-check exit, but [Personal read-only tools](2026-10-17-personal-service-inspect.md) and [service-operation](2026-10-17-personal-service-operations.md) approval snapshots still used identity-less inspect. Replaying after backend SIGKILL could leave unattributable old checks. Unconsumed service approval does not prove the inspection process stopped.

## Decision

Both consumers use app-owned inspection with the original tool/service Task as stable key and a session-family document for the current attempt, not a new Task state machine. Machine, inspection ID, conversation, source Submission, Task and admission entry commit before start. The unverified index contains only still-occupied Tasks. Tool checks retain the original generation's complete input set and support multiple inputs/host-report queries; service checks bind original operation input. Machine parameters come from host policy and the helper independently verifies the local machine. Policy text is not stopping proof.

Results bind the original attempt/admission. Even normal return must save a trusted stopping response for the original ID. Existing result plus proof reuses that observation. Without a result, first verify old execution; only a later invocation may create a new observation. Each invocation dispatches at most one inspect-op. Async results compare original machine, inspection ID and admission entry before commit; late responses retain evidence without changing later attempts/occupancy.

Stopping observation uses an independent bounded call and commits through Harness, not a canceled tool invocation. Cancellation, faulted or another native terminal state does not clear the unverified index. Checks, restart, delegation and child requests for the same service target or source remain blocked; other targets/sources continue. Trusted host APIs list pending checks and recheck stopping. Before resume, startup verifies versions, latest admission, Task, original input, result and stop evidence, then performs one stopping observation per unresolved original ID. Canceled preparation still verifies the inspection; unconsumed approval is not stopping proof. Report pause references distinguish old service-operation keys from inspection Task/admission and observe their respective documents. Recovery checks inspection source against immutable admission, without requiring historical pauses to match the current attempt. Clearing occupancy can automatically wake reporting; pre-HTTP interception still safely repeats only model summarization.

Service configuration uses document version 2 and installs the new extension in main. Old/new code rejects service profiles it cannot interpret rather than guessing identity-less old checks. Retained legacy callers keep their protocol; production Personal uses this one, with entry replacement owned by [product entry](../simplification/2026-10-18-personal-product-entry.md). Unsupported protocol, response identity mismatch or unprovable exit preserves occupancy without fallback to inspect or implicit child-tool permission.

## Later child capabilities

[Child inspection ownership](2026-10-17-personal-subagent-inspection.md) replaces the original no-child-tools limit for fixed read-only checks. [Child service work](2026-10-17-personal-subagent-service-operations.md) subsequently adds controlled restart under original WorkTask permissions, cancellation and unknown-effect cleanup. [Durable commands](2026-10-17-personal-durable-commands.md) and [MCP](2026-10-17-personal-durable-mcp.md) own their independent capabilities. Original work lifecycle, source authorization and helper stopping requirements remain; an initial empty-tool slice is not a current blanket restriction.

## Related decisions

The original audit searched durable, service, inspect and stopping across active lifecycle directories. Migration, read-only inspection, service operations, helper exit and inspection identity retain product requirements, approval consumption and OS proof. This replaces identity-less automatic replay in Personal durable inspection wiring, not those primitives. No note was wholly absorbed or obsolete. Earlier notes retain their decisions with links; primitive acceptance does not establish complete migration acceptance.

## Alternatives considered

- Generate a new random ID on every replay: shortest caller code, but cannot prove old exit or block bypass through another Task.
- Add a custom background inspection Task: reusable native checkpoints, but both consumers already have stable Tasks. Another Task adds unnecessary cancellation/result ownership.
- Commit through original api.commit in finally: easy result cleanup, but the SDK rejects original-invocation commits after abort marks, closure or terminal state. It cannot own post-cancellation stop evidence.
- Store inspection in task scope: convenient automatic cleanup, but Task termination retires the document and loses mandatory unresolved occupancy.

## Consequences

Read-only checks have no write effects, but replay requires proof of original stopping. Admission/evidence/session records and recovery checks cost complexity. Stubborn processes, old helpers or damaged claims can conservatively block indefinitely; operations must restore the original deployment and verify. Trusted-host stopping queries add no force-release path. [Owner inspection controls](2026-10-17-personal-inspection-stop-controls.md) owns CLI/Telegram rechecks; broader operations and real-platform experience remain migration acceptance work.

Proof covers only the helper's fixed same-group show operation, not arbitrary commands, MCP or deliberately escaped descendants. This note grants neither complete child-tool permission nor whole-work external-execution ownership or product cutover. Original tests, independent review and environment gaps are offline at `.scratch/personal-pi-durable/issues/17-durable-inspection.md`.
