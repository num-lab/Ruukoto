# Agent Note: Flat tool rows and collapsed completed execution records

Status: implemented

[Complete chunked transfer](2026-10-18-complete-reasoning-and-preview.md) adds internal streaming-reasoning follow and full file previews; the six-line viewport, partial-content facts and completion-collapse rules remain.

## Problem

Tool summary groups hid each call behind another expansion; long reasoning filled the conversation; a permanent captured-version notice displaced file content. The owner requested removing these distractions and collapsing trace before the final reply when execution completes.

## Decision

Desktop and mutable Demo render Thought and each tool in original order without a tool-summary collapsing layer. Keep Read links, per-call details, errors, arguments and result pagination. Successful actions use Brain/Bot/file/edit/new-file/terminal/search icons and checklist summaries; error, unknown-effect and running status icons take precedence. Actual batches still determine model/tool phase. Model phases keep Thinking; tool phases show calls directly without a Working heading or visible batch group. All existing reasoning displays have at most six visual lines with internal scrolling, retaining text, line breaks, selection and keyboard access.

One TraceCollapsible owns an execution record from the start. The closed summary shows `Worked for` with actual task start/end duration, or `Worked` if valid times are absent. Calls without results retain their running action rather than another waiting label. Automatically collapse pre-final records only when the task is completed and its last semantic entry is a confirmed `entryId`, nonstreaming, nonempty assistant. All body fragments of that final entry remain outside. Pending output rereads, unconfirmed final text, later tools/thinking, failed/canceled/interrupted tasks or pending approvals prevent automatic collapse. Store expansion only in frontend memory with manual reopening; backend events, JSONL and provider input do not change.

Split records into contiguous chronological segments; never regroup by taskId across queued user inputs or other tasks. Intermediate assistant progress collapses with its segment, while user messages/approvals remain outside. Keys combine task and preceding boundary; phase changes only alter `open`. Reuse 180 ms Radix Presence and reduced motion, adding no timer, height measurement or scroll controller.

Captured Read previews show files directly without a permanent captured-version notice. Partial capture/display truncation retains a compact notice; incomplete content never masquerades as complete. Read identity/scope remain unchanged.

This partly supersedes presentation in [reasoning batches](../bug-fix/2026-10-17-desktop-execution-activity.md), [Demo Trace](2026-10-16-demo-trace-tools.md) and [production Trace migration](../architecture/2026-10-16-desktop-trace-migration.md), retaining real phases, details, errors, recovery and sources. [Read snapshots](2026-10-17-desktop-read-snapshot.md) retain their independent capture contract. Frozen demo styles remain untouched; new styling lives in overrides.

## Alternatives considered

Tool summary groups compact history but add the expansion layer the owner removed. Creating a collapsible only after completion is smaller but cannot animate closing. Regrouping by taskId simplifies one collapse but moves queued input. Collapsing solely on `completed` avoids waiting for rereads but can mistake an intermediate reply for the final one; require confirmed final content.

## Consequences

Running/open historical calls are direct, reasoning stops growing the outer page, and each completed continuous segment retains one Trace entry. Unknown task ownership is not guessed. Pending rereads block that task's collapse; loading/failure of a new task does not reopen old tasks. Recovery recalculates from authoritative records. The original Driver exposed only an 8 KiB reasoning tail, subsequently extended by chunked transfer; never fabricate internal reasoning. Historical narrow regressions, browser lifecycle and native-experience gaps remain in the offline flat-completed-trace work item.
