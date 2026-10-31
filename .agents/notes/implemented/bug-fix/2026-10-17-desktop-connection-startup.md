# Agent Note: Warm the desktop environment and probe backend readiness cheaply

Status: implemented

## Problem

Login-shell environment loading started only after the frontend subscribed, preventing overlap with window loading. After authentication, `ensureBackend` fetched a complete snapshot through `connect`, then the real connection fetched it again. Existing backends with substantial history paid this cost twice.

## Decision

DesktopHost starts the existing environment load when constructed and reuses one result per application process. Configuration, Node and tokens still come from the login shell or managed launcher. Clear a failed cached load only when a connection consumes the failure, allowing explicit reconnection to retry. Warmup does not produce an unhandled rejection; the first connection sees the original error. Shutdown sends SIGKILL to the directly owned reader child and waits for `close`, so a shell ignoring SIGTERM cannot delay exit. Late results never establish connections after shutdown.

The development launcher first tests socket connectivity and refuses to take over an existing instance, including a stopping or unauthenticatable one. Readiness for its own new backend requires authenticated ping: only `pong=true` with `stopping=false` succeeds. The real connection still performs the full handshake and installs the snapshot. Explicit rejection or a still-connectable socket does not launch another backend. Stopping backends have a distinct error, malformed responses fail safely, and token precedence, strict versions, probe deadlines, concurrent-instance locks and shutdown ownership remain unchanged.

This supplements the [desktop client](../../proposed/architecture/2026-10-15-desktop-client.md) and [MyGo host](../architecture/2026-10-17-desktop-mygo-experiment.md) without changing their environment sources or host responsibilities. It partly supersedes readiness handshakes in [detached runtime](../architecture/2026-09-19-detach-terminal-from-task-runtime.md), not its locking/lifecycle rules. [Product ownership](../architecture/2026-10-02-two-agent-products.md) and [managed launcher environments](../process/2026-10-09-dev-launchers.md) remain intact.

## Alternatives considered

- Persistent caching or a noninteractive shell could reduce more latency but changes credential/configuration sources. Start the existing read earlier instead.
- Reusing the probe as the real connection saves socket/authentication work but changes `ensureBackend` ownership and multiple callers. Existing ping removes the duplicate snapshot without that coupling.
- Backend cold-start and snapshot SQL optimization may help further but are separate performance work.

## Verification

Controlled environment loaders check pre-subscription warmup, one load, visible/retryable failure and shutdown cancellation without late adoption. Real control-plane and wire stubs check that probes never call `connect`, real connections obtain one snapshot, and stopping/version/authentication/interruption cases preserve startup rules. Historical MyGo measurements are in the offline `desktop-connection` work item and distinguish window, fixture and environment costs.

## Consequences

Fast window loading overlaps only part of shell startup; it cannot eliminate all waiting. Lightweight readiness does not prove snapshot success, and the real connection still reports snapshot errors. Background processes started by user login scripts remain those scripts' responsibility; the host cancels only its directly owned reader.
