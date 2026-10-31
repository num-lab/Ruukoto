# Agent Note: Run Personal commands in a self-contained one-shot worker

Status: implemented

## Problem

[Persistent Linux execution identity](2026-10-17-native-linux-execution-identity.md) accepts prepared input, but shared-worker preparation needs the old Pi SDK and exposes all node_modules. Reusing it would bring the old SDK/coding loop into [Personal durable migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md). In-memory cancellation from the old Host also cannot replace cross-process stop evidence.

## Decision

Native preparation accepts explicit host-declared runtime dependencies. An empty list supports a self-contained bundle; omission preserves Coding defaults. Explicit dependencies retain realpath, protected-root, and minimal-visible-root validation.

The Personal command worker uses only Node built-ins. It collects one bounded UTF-8 JSON payload until stdin EOF, rejecting blank/NUL commands and invalid directory identity. After checking payload realpath and current cwd dev/ino, it starts fixed Bash in the inherited cwd without reopening a path. Host waits for native launch and connects output/exit consumers before writing stdin, preventing a fast command from ending before scope identity is observed. Output is forwarded as original bytes, without old tool protocol, model view, or operation-recovery state. Worker does not classify command reads/writes, grant permission, or prove effects. After command exit, host still verifies scope through the durable reference; PID, exit code, and stderr cannot prove reuse is safe.

[Single-command host execution](2026-10-17-personal-command-execution.md) consumes the bundle and records output/runtime-return evidence without adding it to Personal tools. Before submission, durable callers persist the operation and original execution reference and recheck original authority each time. Cancellation, recovery, and temporary cleanup require original stop evidence.

[Shared workers](2026-09-20-tool-worker-per-task-container.md) and [native sandbox](2026-10-10-native-execution-sandbox.md) retain Coding assembly/platform isolation. Linux execution identity retains stop authority; this note adds input preparation.

## Alternatives considered

The old Pi worker already has data flow/results but imports the old SDK, four-tool loop, and unrelated coding assembly. A new ready/init/abort protocol supports persistence, but each operation already has its own execution identity; one-shot stdin/raw output suffice. Guessing arbitrary workers' dependencies minimizes callers but can select another product's dependencies and widen visibility. Explicit declaration removes the old Pi installation requirement.

## Verification

Narrow tests cover execution without node_modules, original bytes on both streams and large output, zero launch for malformed input/changed cwd identity, protected explicit roots, and old omitted-dependency defaults. Historical Linux/independent-review evidence is in the offline copy of `.scratch/personal-pi-durable/issues/23-command-worker.md`.

## Consequences

The worker avoids old SDK/tool loops. Command signals map to shell-style `128 + signal` exit codes; actual platform termination of the worker still appears as a process signal. Worker exit proves neither descendant exit nor command effects. Stdin submission and OS execution are not atomic. Durable authority, receipts, unknown-state suspension, occupancy, and full access require separate wiring; this note does not authorize model commands by itself.
