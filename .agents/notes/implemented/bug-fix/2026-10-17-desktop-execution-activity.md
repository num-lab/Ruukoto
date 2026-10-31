# Agent Note: Continuous execution feedback and reasoning/tool batches

Status: implemented

[Complete chunked transfer](../feature/2026-10-18-complete-reasoning-and-preview.md) supersedes tail snapshots and the 8KiB reasoning limit. This note still owns phase provenance.

## Problem

Driver ends thinking when the model begins tool arguments, before complete arguments create `tool_intent`. There is also no unfinished thinking between a tool result and the next model request. Showing Thinking only for unfinished thinking events left both phases blank. The owner also requested recorded reasoning at the top of historical tool groups and directly during Thinking.

## Decision

The live execution tail requires an online, running, uncanceled task, an unpaused queue, and no pending approval. A truly running tool displays Working; other phases display Thinking unless the latest same-task phase is nonempty assistant text streaming. Old `message.streaming` can remain true before JSONL restoration, so a global any-streaming check must not hide a new phase.

Before grouping, omit messages already invisible because they have neither text nor attachments, preventing empty assistant tool-call bodies from splitting reasoning from tools. Thinking starts a batch; later ordinary tools in the same task join it. New thinking, visible messages, task identity changes, or Agent delegation split batches. Empty thinking preserves a boundary without an empty Thought row. Historical/Working groups start with expandable original reasoning; nonempty reasoning without later tools remains standalone. Thinking shows only current content not already owned by a tool group, never the previous round. Cumulative events replace by thinkingId rather than concatenate snapshots. The original Driver recorded only an 8KiB tail; this UI neither invents reasoning nor claims complete internal reasoning. The later transfer decision owns complete recorded chunks.

This replaces reasoning suppression and unfinished-thinking-only status in [Trace migration](../architecture/2026-10-16-desktop-trace-migration.md) and [Demo tool Trace](../feature/2026-10-16-demo-trace-tools.md), retaining details, errors, identity, and recovery.

Git keeps vertical automatic paging, natural-width text/refs, and horizontal scrolling. Paging uses aria-busy rather than loading text. The end sentinel stays inside the same-width list so scrolling right cannot strand it left of the viewport and stop vertical paging. New tabs omit the SubAgent list but retain delegation entry points and open child tabs. Successfully loaded empty conversations remain blank; actual history loading still provides feedback.

## Alternatives considered

New Driver phase events could describe provider stages more precisely, but task/tool facts already suffice for continuous feedback without a protocol change. Checking only unfinished thinking retains the reproduced gaps; treating any old streaming text as the active phase hides new rounds. Separate reasoning rows preserve text but do not meet the requested first-row tool batching.

## Consequences

Feedback is continuous without changing original events/JSONL. Thinking means an active task lacking displayable text or a running tool, including argument generation; it does not claim the provider is internally reasoning at every instant. Static Demo content is not real-model acceptance. Driver replay, grouping, and SSR evidence is in the offline copy of `.scratch/desktop-shadcn/issues/24-browser-activity.md`.

[Flat tools and completed traces](../feature/2026-10-18-completed-trace.md) later replaces summary grouping and completed presentation, retaining invocation details, errors, provenance, and recovery.
