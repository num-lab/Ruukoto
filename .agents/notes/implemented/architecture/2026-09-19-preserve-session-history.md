# Agent Note: Preserve complete session history and assemble model context separately

Status: implemented

Original identifier: ADR 0001.

Partly superseded by [the personal product entry](../simplification/2026-10-18-personal-product-entry.md): new personal history belongs to native durable SQLite records and is not dual-written to legacy JSONL. The non-destructive history principle remains; the JSONL and derived-index rules below apply to Coding and legacy archives. [Personal information ownership](2026-10-18-personal-memory-skills-history.md) owns personal history, memory, skills, and request references; [the original durable proposal](../../proposed/architecture/2026-10-17-personal-pi-durable.md) records the migration rationale, not an outstanding requirement to keep new personal history in JSONL.

## Problem

The owner builds a personal Agent to customize context assembly, compaction, and memory. Comparing new policies requires the original messages, and the Agent must be able to retrieve material omitted from a particular request. Replacing originals with lossy summaries or deleting them through a selector would make those experiments impossible. Conversely, a model window cannot contain all history indefinitely.

## Decision

- Persist complete history append-only and make it available to the Agent. For the shared Coding assembly, pi JSONL is the sole authoritative message history; SQLite history indexes are rebuildable derivatives. Host tools `history_search` and `history_read` retrieve originals.
- Manage model context separately. Assembly, selection, and compaction produce a request-specific view, never a rewrite of persistent history.
- The deterministic baseline in `packages/agent/src/context-selector.ts` retains system and project instructions, the current task requirements, and recent complete interactions within budget, reserving space for the answer and tool results. Older material remains available through indexed history lookup.
- Lossy processing applies only to model context. [Lossy context compaction](2026-09-26-lossy-context-compaction.md) supersedes the original refusal to use summaries: host-managed compaction points, tool-result placeholders, and rolling summaries do not alter history. The shared assembly disables automatic pi compaction and cancels every `session_before_compact` in `packages/agent/src/session-factory.ts`; this is not the personal durable compaction policy.
- Jev affects context selection only. `packages/agent/src/jev.ts`, called by `context-assembly.ts`, is an experiment against the baseline; invalid results, timeout, or unavailable service fall back to that baseline without changing originals.
- Long-term memory cleanup is a separate experiment with undo records, not part of context filtering.
- Deleting original history requires a separate retention decision. Neither the baseline, Jev, nor compaction owns deletion; no automatic original-history deletion mechanism is established here.

## Alternatives considered

- **Use pi automatic compaction.** It is the upstream default and avoids a custom selector and history tools. It does not satisfy the owner's need to retrieve and reassemble originals. Disabling automatic triggering alone does not stop manual compaction or branch summaries, hence the event veto as well. When mandatory context exceeds the budget, the task pauses with `context_budget_exceeded` rather than silently dropping material or falling back to pi compaction. Later lossy processing is restricted to host-managed request views.
- **Start with model-driven selection or vector retrieval.** Community Jev implementations filter old tool calls/results without changing disk history, and semantic retrieval could recover relevant messages. The initial requirement is recent complete interactions, not an embedding model or vector database. Preserving originals also does not prove the selected view retains all relevant information. Jev therefore remains a separately measured experiment with a deterministic control and fallback. Initial history search scans literal keywords in index-located originals, without an additional full-text engine.
- **Use Jev for both context and long-term memory cleanup.** This was an owner-suggested way to reduce concepts. A request view is temporary and can fall back; persistent derived memory requires provenance, undo, and retention rules; deleting originals is a third concern. Community evidence covered only view filtering. The confirmed boundary separates all three.

These alternatives were recorded in the historical offline `.scratch/personal-agent/spec.md` rounds 2-3, `research.md`, `foundation-findings.md`, and issues `05-context-and-memory.md` and `08-jev.md`. They are provenance, not maintained task entry points.

## Consequences

The same original history can support repeated policy comparisons, Jev enable/disable, and compaction experiments. Material omitted from context remains retrievable. This costs growing storage, maintained indexes and query tools, and per-request budget selection. Retrievability neither means every request sees everything nor guarantees the model will think to search the right place. Storage, privacy, or retention-driven deletion must be decided separately.

[Session branching](../feature/2026-10-11-branch-session-snapshot.md) reuses complete-history snapshots and bounded source reading. It removes orphan records from the model view by batch, without rewriting the source session.

## Verification

The regression map is `test/16-context-memory.test.ts` for whole-interaction selection, tool pairing, zero provider calls plus task interruption and queue pause when mandatory content exceeds budget, and index rebuilds that leave source files unchanged; `test/61-context-compaction.test.ts` for unchanged JSONL byte prefixes and retrieval of placeholder originals; and `test/52-jev.test.ts` / `test/55-jev-runtime.test.ts` for view-only selection, HTTP/timeout fallback to the same baseline, and no request when credentials are missing. Byte comparisons are necessary to prove non-destructive history, not merely successful task status. This documentation migration does not rerun those runtime tests.
