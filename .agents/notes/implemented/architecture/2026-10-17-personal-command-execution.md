# Agent Note: Host-owned completion evidence for a single Personal command

Status: implemented

## Problem

[The one-shot worker](2026-10-17-personal-command-worker.md) and [durable stop reference](2026-10-17-native-linux-execution-identity.md) needed a real consumer. After a crash, the original reference could not locate its temporary directory; command-written success text could not prove the host finished receiving output. Exposing durable commands directly would carry these gaps into authority and work completion.

## Decision

The Personal app provides host execution, receipt query, and stop APIs for one restricted Linux command. Trusted callers such as [durable command tools](2026-10-17-personal-durable-commands.md) first persist original work and execution reference. The adapter accepts prepared inputs and records a private request/temp-directory binding before launch, at most once per reference. The request fingerprint covers command, full LaunchSpec, and prepared input. A private claim binds path hash and dev/ino to the original reference; query/cleanup check reverse links, preventing shared temp directories and false rejection from inode reuse.

Connect output consumers before closing stdin. Raw stdout/stderr go to private files invisible to the worker. After complete capture and observed exit, publish the completion receipt atomically. Listen for cancellation/timeouts before launch; after launch returns or fails, still perform final stop verification against the original reference. A run with a separately registered stop publishes no completion receipt. Receipts prove only host-observed return, never business effects inferred from exit code or stderr.

Recovery validates/reads the original receipt and checks stop through the original execution reference. No receipt means unknown; corruption or incompatible version rejects use without reexecution. Stop needs no in-memory unit. Only verified exit permits temp cleanup by original dev/ino; a replaced directory is retained. Private files prove OS execution/output, not durable work, authority, or queue state.

[Full-access commands](2026-10-17-personal-full-access-commands.md) supersedes the original missing full-access wiring, retaining restricted execution, host evidence, and stop protocol. [Service operations](2026-10-17-personal-service-operations.md) use external-helper receipts not suitable for arbitrary commands. [Background Bash](../../proposed/feature/2026-10-14-bash-background-lifecycle.md) concerns long-lived shared terminals, not this one-shot adapter.

## Alternatives considered

Putting capture/recovery directly in durable tools removes an entry point but makes handle-free stop and output/receipt crash windows harder to verify independently. A worker JSON receipt is easy to add, but arbitrary commands can write stdout/stderr and cannot create trusted evidence through that channel. In-memory output suffices normally but loses results and original temp location on restart.

## Verification

Historical evidence in `.scratch/personal-pi-durable/issues/24-command-execution.md` covers cross-process receipt reads, non-replay without receipts, original-reference stop, and preserving replaced directories. Offline stubs and real Linux evidence remain distinct in the archive.

## Consequences

Recovery requires the same machine identity, private evidence directory, and original TMPDIR. Changed TMPDIR conservatively blocks query/cleanup until restored. A crash between prepare and directory binding can leave an undispatched temp directory; if durable integration requires eliminating it, shared prepare needs a predetermined directory rather than speculative unused configuration now. Original streams are not model-truncated, and receipts are cross-process verifiable. Output consumes host disk; write failure stops execution and retains unknown state. No disk quota or power-loss durability is promised. Full access and MCP need their own stop designs.
