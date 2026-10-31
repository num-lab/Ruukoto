# Agent Note: Personal session background processes share directory claims

Status: implemented

[Operation-specific checks](../bug-fix/2026-10-24-operation-specific-checks.md) removes protection scans from full-access background setup/supervision. Provenance, cwd identity, stop, and claim rules remain.

## Problem

Personal's two-minute run_command belongs to child work and stops its original unit on completion, so it cannot host a service across messages. Checking command records only when background start begins misses prepared-but-undispatched commands and file writes awaiting approval. Older code unaware of new claims could bypass occupancy.

## Decision

Main-owner full-access input gains process_start/status/output/stop, pinned to original command.json directory/Linux machine identity and reusing shared BackgroundExecution one-time claim, independent worker, and original-scope stop. Children, scheduled tasks, and summaries get no session backgrounds. Two-minute run_command retains foreground/work ownership. Platforms without equivalent Personal configuration/execution reject rather than inherit Coding's macOS support.

One durable acceptance commit saves source, independent background Task, directory claim, and immutable entry. Before actual launch, persist a one-time fingerprint claim. Duplicate original tools query records only; cold recovery stops original identities, never replays. Processes belong to main conversation, so creating-round completion/cancellation does not cascade stop. Original-entry/authority invalidation, directory change, log budget, or app shutdown registers stop. Main command exit, managed-unit stop, and business effects are separate facts; unknown stop retains the claim.

An independent session document owns directory claims covering background starting, ordinary-command prepare/start, and file-write approval consumption. Each entry's transaction checks parent/child paths and dev/ino aliases both ways. Claims bind original operations and immutable acquire/release entries. Commands release only under original stop/effect proof; file writes use actual write/close observation. Unknown facts or unexpected terminal Tasks cannot clear claims. Recovery checks document/entry/Task/provenance/claim backlinks before external identities. extensions.personal=2 and separate claims protect file writes even without command configuration; old code rejects exactly, and new code never fabricates claims/authority for legacy unresolved work.

A unified main-tool policy for the starting and observation rounds exposes only same-session status/logs/trusted stop/questions and browser still eligible under the same original full-access entry. Pending questions further intersect that set. Prepare, presend evidence, and invocation all verify phase. Ordinary workers, directory tools, MCP, and delegation require stopping background first. Scheduled config explicitly excludes every process_*; source authority/claims still govern ordinary commands and writes.

Private logs verify dev/ino, length, and SHA. stdout/stderr total <=16MiB; reads page 32KiB original bytes/base64. Data callbacks count/trim immediately; fixed buffers and at most one pending commit batch bound queues. Exceeding budget registers stop once. Short writes retain real bytes then stop. DB commit failure freezes later queues, stops known units, closes Harness, and reports background_persistence_failed; stderr never substitutes for durable recovery facts. Files/durable commits are not atomic; inconsistent reopening retains claims/evidence.

Local authenticated controls/original IM menus list, read raw logs, stop one, or explicitly end backgrounds. Private-platform menus validate account/owner/config generation/delivered menu; local authority can manage old entries. End requests persist stable key, source-acceptance watermark, and original targets. IM barriers cover only the original entry, local barriers all entries. Backend source resolution uses original acceptance entries, including question answers, preventing earlier accepted but not-yet-dispatched starts. Reusing a key does not capture later starts. Client exit/archive does not end processes; backend shutdown/reopen only stops original execution. Offline config rejects effective shared claims.

[Background proposal](../../proposed/feature/2026-10-14-bash-background-lifecycle.md), [Coding backgrounds](2026-10-21-coding-background-processes.md), [durable commands](../architecture/2026-10-17-personal-durable-commands.md), [full-access commands](../architecture/2026-10-17-personal-full-access-commands.md), [file tools](../architecture/2026-10-17-personal-tools-access-artifacts.md), and [schedules](../architecture/2026-10-18-personal-durable-scheduled-work.md) keep primitive/business/provenance ownership.

## Alternatives considered

Scanning commands only at background start is smaller but misses later dispatch from prepared commands/approved writes. Reusing legacy Store/ApprovalGate/manager imports retired Personal runtime; share stateless execution/stop only. Owning backgrounds by original tool/work wrongly stops services when that round ends. Backfilling old claims reduces migration friction but cannot prove original unresolved write/effect ownership; reject old business formats and preserve originals for matching code.

## Consequences

Services survive owner messages while retaining stop-before-modify and original-reference stop. Unknown facts can occupy directories indefinitely; the new business format requires an independent new profile. Full-access escaped processes/external services need separate effect verification. Historical scope/evidence is in `.scratch/agent-tool-completion/issues/04-personal-adapters.md` offline; platform stubs do not replace real Linux/model/IM acceptance.
