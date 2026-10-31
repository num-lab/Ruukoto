# Agent Note: Hide internal report inputs using trusted ownership

Status: implemented

[Next-request report delivery](../../proposed/feature/2026-10-30-coding-report-delivery-boundary.md) proposes classifying individual reports inside active tasks and excluding internal fallbacks from the user queue. It is not implemented and must not hide the receiving task's ordinary owner input.

## Problem

Host final reports entered Task.input/sdk.prompt as user messages and appeared as owner input in chat, up-arrow history and pinned requirements. Hiding only task details leaked earlier history pages/single-entry reads. Body/request-key heuristics could hide genuine matching user input.

## Decision

Runtime derives `TaskView.inputPurpose` (`user` or `internal_report`) from durable delivery/task bindings, without another stored identity column. Workflow delivery binding supplies the original classification; current report-fallback bindings use the same trusted rule. Handshake, details, pages, request verification and submit/continue/mode responses share it. Bodyless task events do not classify purpose.

Core associates original taskId during the same JSONL parse using ruukoto_task_start/end. Runtime verifies ownership in the current session or durable branchSource.taskIds before classifying first pages, pagination and single-entry reads. The next start marker may replace an interrupted missing end; invalid IDs or mismatched end markers are history_corrupt.

EventFlow filters internal_report before creating user-display entries. Input-history seeding/pinned requirements use that visible projection; assistant summaries, task status and raw diagnostics remain. Unmarked old messages display normally. Missing tasks, cross-session associations or known internal entries without markers carry taskAssociationError; TUI explains reconstruction and retains ordinary body text. Explicitly invalid associations remain independent history rows; later task/events cannot merge/hide them. Reads neither invent events nor rewrite JSONL.

This introduced protocol 23, not a schema change. Model input, context grouping, compaction, search and diagnostic bodies retain their original paths. Display classification never grants execution/data access.

## Related decisions

[Wait/report ownership](../architecture/2026-10-14-agent-wait-and-report-ownership.md) owns waiting, claims and unique report delivery separately. [Trusted workflow answers/delivery](2026-10-13-workflow-owner-input-and-delivery.md) supplies durable summary identity/source checks. [Full history](../architecture/2026-09-19-preserve-session-history.md) and [branch snapshots](2026-10-11-branch-session-snapshot.md) retain original markers and verified ancestry.

## Alternatives considered

- Matching titles/key prefixes is smallest but cannot distinguish identical owner-authored input.
- Hiding task details alone leaks history-first arrivals into chat/up-arrow history.
- SDK display:false custom messages support hiding but expand storage/history/search/context support beyond this change.
- A stored purpose column is direct but duplicates the existing durable binding and adds consistency work.

## Consequences

Chat no longer treats internal reports as owner requirements while model/diagnostic provenance stays available. Reads pay ownership checks and clients/backends must match. Unverifiable input is not guessed hidden; unmarked old messages without task references stay ordinary.

`test/11-history-read.test.ts` covers associations/marker failures; tests 13/14 cover live/reread-first/reconnect/pagination/input/pins; test 115 uses real Driver and local model service for full requests, identical user text, repeated branches and unchanged JSONL. Real model/IM/owner experience remain joint external acceptance, not claimed here.
