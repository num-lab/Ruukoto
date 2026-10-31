# Agent Note: Migrate Trace details and execution status into Desktop

Status: implemented

## Problem

The owner requested production migration of the latest Demo. New Trace details and Thinking/Working tails conflicted with prior direct-reasoning display and inspector-only tool clicks. Copying mock steps would hide real phases, truncated arguments, and missing history.

## Decision

The original migration freezes v3, retaining theme/base CSS/highlighter/primitives as traceable source and appending native-window adaptation. Historical approval is archived `.scratch/desktop-shadcn/issues/09-desktop-current-demo.md`. Enter sends with IME, attachment, and write-lock checks; Shift+Enter inserts newline. Tabs, filtering, workspaces, and Trace expansion follow Demo. Same-version highlight.js processes complete source; unknown languages use React plain text and no file content executes.

Originally, transcript hid reasoning bodies without changing events/JSONL. Thinking still split tool batches, also grouped by taskId. Only online, running, uncanceled, unpaused tasks without pending approvals had tails; unfinished thinking meant Thinking, and running tools in the current batch meant Working. [Continuous execution feedback](../bug-fix/2026-10-17-desktop-execution-activity.md) later replaces these display rules, and [completed traces](../feature/2026-10-18-completed-trace.md) replaces summary grouping/completed presentation. Original-call result/history association and task-pinned identity remain, with no duplicate completed rows.

The same-version official Message Scroller owns autoScroll, initial start, and native prepend anchoring together. Root only triggers history reads, never its own scrollTop. Loading/empty UI stays outside Content so it cannot consume initial positioning. Reading upward, lazy dimensions, and collapse animation follow the primitive.

Read paths resolve against source-session cwdReal and open only through existing registered-root read queries; out-of-scope paths explicitly cannot preview. Truncated paths/Bash commands use get_tool_op_params, validating paged bytes and operation/task/session identity before parsing. Asynchronous opens retain their initiating parent session. Results reuse read_tool_result paging/validation. Inline per-call caches remain separate from inspector selection; disconnect/snapshot evicts in-flight results. Errors are red, unknown effects are not success, missing diff differs from empty diff, and running calls never borrow old-file results.

Write reuses prewrite reading/generateUnifiedPatch in the original worker callback, saving patch/statistics in the tool result. Core's existing nullable patch handles Edit and Write; writeContent semantics remain. If the final JSON worker frame would exceed 4MiB because of patch, omit only display patch, retaining real success/statistics. Never reread a later file or truncate and claim completeness. Wire shape/parameters stay protocol v28; missing old fields display unrecorded diff. Same-worker modifications serialize by path, without claiming atomic comparison against external editors.

After each SDK toolResult message_end notification returns, the next tick emits output_entry from persisted JSONL. It waits neither for other tools in the batch nor guesses identity from tool_execution_end. managedTaskId rejects old-task callbacks, protecting the next task's reference-deduplication set/message queue. Original end fallback remains allowed after task end before a new task starts.

[Result paging](../feature/2026-10-16-tool-result-pagination.md) gains Write patch sources without changing byte/missing semantics. [Prior migration](2026-10-16-desktop-current-demo.md) retains reads, Context, approval, attachments, and recovery. [Trace Demo](../feature/2026-10-16-demo-trace-tools.md) and [input preview](../feature/2026-10-16-demo-input-preview.md) gain explicit production-state wiring while old snapshots/evidence stay. [Transcript rendering](../bug-fix/2026-10-17-desktop-transcript-rendering.md) owns later rendering-cost changes.

## Alternatives considered

Copying Demo App is fastest but installs mock execution/files in production. Rereading files for Write diff sees post-call state, not the historical prewrite version; persist the patch already available at execution. Sharing inspector selection for all details saves cache but makes expanded calls overwrite one another; share paging validation only. Keeping manual scroll-follow requires distinguishing wheel/keyboard/touch/scrollbar from lazy-dimension auto-scroll, already misclassified in real Electron. Use the primitive's complete follow/anchor behavior instead.

## Consequences

Historical engineering/isolated-Electron evidence lives in the migration issue. Missing real-model/SSH prerequisites are not passes. Highlighting adds a limited-grammar build dependency; full arguments/results load only on demand. Missing history, failed prewrite reads, and oversize patches cannot reconstruct diffs and are reported honestly. Deferred backend capabilities retain their original inventory. Later display changes do not replace invocation details, errors, provenance, paging, or recovery.
