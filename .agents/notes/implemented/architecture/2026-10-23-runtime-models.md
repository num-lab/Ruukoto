# Agent Note: Give model configuration and model stacks one owner

Status: implemented

[Non-execution configuration checks](../simplification/2026-10-25-configuration-checks.md) narrows affected-provider comparisons: display names, unique-ID ordering, and genuinely new models do not wait for old tasks. Stack publication, references, rollback, and complete-operation shutdown remain governed here.

## Problem

Runtime mixed task orchestration with model configuration, scattering gates and stack state across the class and duplicating SDK/catalog/reviewer assembly between startup and rebuild. Gate tests accessed private implementation. Configuration changes required understanding unrelated tasks, IM, and workflows.

Shutdown did not wait for in-flight configuration operations, so it could close SQLite or release the configuration lock while SDK rebuilding later resumed and wrote an event. Gate release preceded message flushing and configuration events and could not prove the whole operation had ended. On 2026-10-23 the owner approved extraction and the shutdown-race fix together.

## Decision

`packages/runtime/src/models.ts` defines `RuntimeModels`, owned as `Runtime.models`. It owns current stack, configuration revision/reference validation, apply gates, file snapshots/rollback, safe diagnostics, and configuration events, reusing agent/model-config file operations. Scope is Coding and the retained shared Runtime, not durable Personal's independent model configuration.

Dependencies are Store, model-related startup configuration, and three injected host capabilities: count active compactions for selected providers, publish a new stack to live Drivers, and flush pending messages. It receives no entire Runtime and owns no queues, Driver collection, compaction operations, or SubAgentManager. Runtime retains the configuration lock and overall startup/shutdown order.

Control calls this module directly for listing/configuration views, catalog/credential saves and removal, provider removal, defaults, summary model, and connection tests. Runtime's nine forwarding management methods were removed. Protocol operation names, parameters, results, and codes remain unchanged, with ops deriving response types from the new module. Read-only `Runtime.defaultSelection` and snapshot `modelInfo()` read the same state, avoiding hundreds of unrelated test changes.

Startup and hot rebuild share stack construction but retain validation differences: hot rebuild additionally verifies every configured model was accepted by the SDK. Runtime still fills missing session defaults after successful startup. Publish the fully validated stack once; existing Drivers only mark their SDK stale and rebuild on the next task, without interrupting the current SDK.

The module owns asynchronous selection resolution and synchronous reverification. Callers reverify in the actual registration transaction, checking both provider gate and catalog identity, not only whether configuration is busy. Idempotency lookup precedes gates. Runtime owns internal retries: wait only for `model_config_busy`, then retry the original key.

### Shutdown tracks complete operations separately

Runtime's stop intent synchronously closes new management writes. It stops backend execution and aborts active tasks through the existing path, then waits for all accepted management operations before destroying Drivers, closing SQLite, or releasing the configuration lock. A configuration apply that already changed files completes rebuild or rollback, message flush, and event recording. No new flush starts during shutdown. A default/summary save still resolving the catalog rechecks closure immediately before writing and rejects a late write. Connection tests retain existing authentication resolution/cancellation without automatic resend.

Gate completion means selections may be reverified; complete-operation completion means no further host resource access. Track them separately: internal submissions waiting for an entire flush would deadlock with the flush waiting for those submissions.

[Code model settings](../feature/2026-10-21-code-model-settings.md) retains metadata reads without dynamic-auth evaluation, secret placeholders, advanced JSON fields, diagnostics, and default semantics. [SubAgent messaging](../feature/2026-10-05-subagent-messaging.md) retains gate-release-before-flush on success and rollback. [Auto-review](../feature/2026-09-22-auto-review-mode.md) rebuilds its reviewer with the stack without changing approval ownership. The original search found no existing extraction proposal to replace; Personal remains separate.

## Alternatives considered

- Extract only a stack builder: removes duplication, but leaves gates, rollback, management, and tests piercing Runtime internals.
- Move methods and pass the entire Runtime: few caller changes, but state/timing stay scattered and the new file hides little complexity.
- Merge online management into agent/model-config: more shared entry points, but moves task occupancy, message flushing, and event orchestration into agent. Reuse file operations only.
- Preserve old shutdown: keeps a mechanical extraction, but cannot give the module complete lifecycle ownership. Fix the race and verify the new behavior separately.

## Consequences

One module owns configuration state and stacks; control callers need not understand snapshot/rollback/publication ordering. Complete-operation tracking adds an in-memory Promise set and makes shutdown wait for apply cleanup; gate waiting remains narrower for original-key internal retry. Asynchronous default/summary resolution, complete hot-rebuild operations, and internal gate waits must not collapse into one state, or shutdown can write after close or deadlock. Files and SQLite configuration events remain non-atomic.

Tests preserve synchronous occupancy/catalog-identity checks, idempotency first, internal original-key waiting, success/rollback message flushing, control, compaction, media model pinning, and SubAgent messaging. Gate tests pause SDK rebuild through public save entry points, not private gates/apply. Interleaving cases cover rebuild/rollback/flush during stop, late default/summary refusal, and authentication waits; waiting for auth must not delay active-task stopping. Even after the gate opens, unfinished flushing retains Drivers/database/lock; its configuration event precedes `backend.stopped`. Removing complete-operation waiting made rebuild, rollback, and flush cases fail on premature database close; restoring it passed. Detailed commands/environment/results were in retired `.scratch/runtime-models/issues/01-extract-models.md` (offline provenance). Simulated providers are not real-model acceptance.

The extraction changed no configuration/storage format, user data, schema, protocol, or dependency, and file length was not an acceptance criterion. Two limitations remain explicit: `snapshotConfigFiles` currently maps even non-ENOENT read errors to null, so rollback can mistake an unreadable file for an absent one; normal rollback tests do not prove data preservation under read failure. Connection-test timing starts its 30 seconds after authentication resolution, and cancellation does not prove SDK completion. Complete-operation shutdown has no proven total bound and may wait for auth/request cleanup; this change added no timeout option or general cancellation framework.
