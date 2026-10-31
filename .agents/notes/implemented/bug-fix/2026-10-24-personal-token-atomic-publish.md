# Agent Note: Publish a complete Personal authentication token

Status: implemented

## Problem

Personal backend rotates `control.token` at each start. Direct `writeFileSync` creates or truncates the file before writing, so a cross-process reader can observe an empty value and receive `control_token_invalid`. Restart/signal integration reproduced this. Test cleanup also removed directories before stopping the backend; a cleanup failure could skip other cleanup and leave processes/listeners running.

## Decision

While holding the profile lock, first reject a malformed old token using `readPersonalToken`. Write the new value with mode 0600 to same-directory `control.token.tmp`, then rename it to `control.token`. Reuse the existing temporary-config-file pattern. The profile allowlist accepts an ordinary `control.token.tmp`; after acquiring the lock, startup tightens residual-file permissions and rewrites it. Authentication never reads the temporary file. Before first publication, `control_unavailable` remains possible; during rotation, readers see a complete old or new value.

Write or rename failure follows existing `control_start_failed` cleanup: release the lock, reject startup, and create no listener. Corrupt authentication files are not treated as retryable. Successful profile format and HTTP protocol remain unchanged. Rename provides complete publication to concurrent readers, not atomicity with SQLite or power-loss durability.

Entry-integration cleanup is coordinated only in that test file: stop owned child processes, close the model substitute, then remove temporary directories. Collect each failure while continuing remaining cleanup and finally throw AggregateError. Real signal, lock-release, and authentication assertions remain.

This supplements [local management](../architecture/2026-10-17-personal-local-management.md) without changing exclusive ownership, per-start rotation, malformed-token refusal, or private permissions. [Durable foundations](../architecture/2026-10-17-personal-durable-foundation.md) still reject old profile formats; only the ordinary temporary file needed for publication is added.

## Alternatives considered

Retrying `control_token_invalid` could hide a transient empty window but also hides genuine corruption. Waiting for the socket only in tests avoids early first reads but does not protect real readers during restart. A generic atomic-write library adds an abstraction/dependency despite an existing local tmp/rename pattern.

## Consequences

Successful publication still leaves only `control.token`. Interruption can leave an ordinary temporary file, safely rewritten by the next lock holder. A malformed old token still requires retaining and inspecting the profile; leftover tmp never authorizes automatic repair. Historical initial/rotation reads, failed writes, cleanup, and platform evidence are in the offline copy of `.scratch/ci/issues/04-publish-personal-token-atomically.md`.
