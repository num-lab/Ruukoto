# Agent Note: A fixed QuickJS/WASM orchestration entry point

Status: implemented

## Problem

[Workflows](../feature/2026-10-12-agent-workflows.md) execute model-generated JavaScript without exposing Node, credentials, files, or network capabilities. Synchronous WASM, asynchronous host calls, hostile scripts, and whole-process cleanup require experiments rather than upstream compatibility claims alone.

## Decision

packages/agent/src/script-worker uses quickjs-emscripten-core with @jitl/quickjs-wasmfile-release-sync 0.32.0, declared only by agent and pinned by root lockfile. The fixed worker bundles interpreter JS and loads copied WASM beside it, targeting Node 22.19. Script text/JSON parameters travel only through dedicated stdio, never as Node entry code or argv.

QuickJS scripts call the host only through four Promise-primitive categories. Environment contains fixed LANG only, not source mode, workspace, credentials, or Runtime. Callbacks own authority, durable state, and real steps; this entry implements no coordinator/product tools. Remove module loading, clock, randomness, and unmanaged timers. Captured JSON primitives convert inputs/results, retaining __proto__; script mutation of global JSON/Promise cannot change host conversion.

Reuse [unverified-stop retention](../bug-fix/2026-10-11-preserve-unverified-worker-stop.md): create a unique-UUID starting placeholder before launch, then retain LaunchedUnit identity. Cancellation handles late launch returns; the stop Promise caches false and error cause. No external-process spawning is exposed, so existing group TERM/KILL/stop verification suffices without changing tool launchers. Full-access provenance never expands interpreter capability; actual steps follow [source authority](../feature/2026-10-12-full-access-current-account.md).

### Interruption and cleanup

QuickJS interrupt handles pure computation. Yield after each 64 microtasks and check interpreter time. A separate parent accumulates wall time from start/reply send to matching idle, default ten seconds, excluding host waiting; startup separately allows ten seconds. Long built-ins/conversions may not interrupt promptly, so parent must terminate the whole unit. [Host dispatch](../bug-fix/2026-10-22-workflow-host-idle-dispatch.md) records call first and dispatches that batch only after latest idle stops timing, preventing pipe framing from charging synchronous host work to the script budget.

Infinite Promise chains can hit upstream assertions during runtime disposal after interrupt, and executePendingJobs may still report success. Exceptional paths send bounded failure then exit, reclaiming all WASM rather than trusting dispose. Normal paths free deferred/results/context/runtime, then require channel drain, normal exit, and process-group verification after the completion frame. Abnormal exit preserves any result received but is not success. Cancellation neither registers nor advances late calls; callback owners stop real steps.

### Limits

Script 128KiB; frame 1MiB; queued writes 4MiB; pending host requests 32; progress 256 updates/256KiB; QuickJS heap 32MiB and stack 256KiB; WASM linear memory 64MiB; Node V8 old space 64MiB. These limit different resources, not total process RSS. Entry validates stable-key grammar/primitive kind; coordinator owns key idempotency, dependencies, data, and business schema.

Existing workflow, native sandbox, tool-worker, and stop notes retain their runtime/authority roles. This decision isolates script execution only.

## Alternatives considered

node:vm is not a security boundary; Worker resource limits do not bound all external memory. Asyncify makes synchronous host bridges possible, but Promise orchestration works with experimentally verified release-sync without another build. ToolWorkerHost/Bash reuse execution machinery but expose different protocol/capabilities and full-access environment. Interrupt/dispose alone handles ordinary computation but not long built-ins or failing infinite-Promise cleanup; independent parent termination is necessary.

## Consequences

Synchronous WASM needs no platform-native interpreter extension, and both products can share the entry. Every execution pays process/WASM startup for complete exit-based reclamation and no cross-run residue. No OS RSS quota exists. Adding that guarantee or child-process capability requires a new platform/cleanup design, not extrapolation from these experiments. Historical four-case fake-Agent, bundle, intentional-failure, and raw-result evidence is in the offline `.scratch/agent-workflow/isolation-evidence/README.md`; it proves this entry, not durable workflows, real steps, models, or IM acceptance.
