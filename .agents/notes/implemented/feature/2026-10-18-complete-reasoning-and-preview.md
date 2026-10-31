# Agent Note: Transfer complete recorded reasoning and file previews in chunks

Status: implemented

## Problem

Thinking retained only its last 8KiB and its six-line scroll area did not follow new text. Workspace files larger than 256KiB were unsupported, and Read snapshots loaded only their first page. The owner requested removing both total limits and following the latest thinking line. Full-text frames exceed the 1MiB control limit; repeated cumulative thinking snapshots also make event storage quadratic.

## Decision

Protocol 32 changes new `task.thinking` events to UTF-8 byte-offset deltas of at most 8KiB. Driver retains complete exposed reasoning and sends only unsent text when throttling. Empty chunks still record start, timing origin, and end. Chunks do not split UTF-8 characters; an incomplete UTF-16 high surrogate waits for the next update. EventFlow fills holes/deduplicates by offset and takes phase metadata from the newest event. Legacy events without offsets still replace snapshots. Copying the last chunk to close an abnormal terminal state does not append it again. Text discarded by older versions cannot be restored; missing model content is never generated or guessed.

`read_workspace_file` takes registered root, relative path, offset, length, and version and returns base64 pages <=256KiB without a total file-size limit. Version hashes dev/ino/mode/size/mtime/ctime. Later pages require the first revision; changed revision, short reads, or changed path chain/descriptor fail the read. Path identity and relevant link/read-consistency checks remain; later [owner browsing](2026-10-24-owner-workspace-browsing.md) and [read-check reuse](../bug-fix/2026-10-24-read-check-overhead.md) remove protected-root scans and hardlink rejection. Renderer cannot choose arbitrary absolute paths. Old clients fail the protocol handshake rather than use a second legacy full-response endpoint.

Desktop loads every page of workspace files and Read artifacts, validating origin, offset, total, and revision/artifact state on each. Only complete assembly is decoded as UTF-8/images and displayed; any failed page prevents mixed or partial display. Close, disconnect, snapshot, or retry invalidates the old generation and stops further pages. Real partial Read state retains a compact warning; the artificial first-256KiB display-truncation warning is removed. Binary, SVG/PDF, and invalid images remain unsupported preview types.

Streaming reasoning in Desktop and mutable Demo retains a six-line internal scroll region. Text updates set only that region's scrollTop. Historical reasoning stays manually scrollable; Message Scroller owns the main transcript, with no scrollIntoView call.

This supersedes tail/cumulative-snapshot rules in [execution activity](../bug-fix/2026-10-17-desktop-execution-activity.md) while preserving phase provenance; it removes total-preview limits in [Read snapshots](2026-10-17-desktop-read-snapshot.md) and [Desktop migration](../architecture/2026-10-16-desktop-current-demo.md), retaining capture/authorization. [Completed traces](2026-10-18-completed-trace.md) keeps height/collapse behavior. Trace components, script budgets, and artifact-export authority remain independent.

## Alternatives considered

Removing truncation while sending full text is smaller but breaks frame/history-page budgets and duplicates storage. Increasing 256KiB/8KiB constants retains total truncation and cannot guarantee frame safety. Backfilling from history after thinking ends leaves streaming truncated, and ordinary history text does not contain reasoning anyway.

## Consequences

Complete recorded reasoning/files are recoverable through bounded frames without hiding authorization, true partial state, or cross-page changes. Client/backend must support protocol 32. Full content still assembles in memory, and highlighting, line numbers, and reasoning DOM cost grow with length. Chunked transport is not unbounded memory or file virtualization. It restores no previously discarded prefix and changes neither model context budgets nor existing tool-output truncation policy.
