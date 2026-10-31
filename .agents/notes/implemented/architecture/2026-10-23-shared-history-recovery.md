# Agent Note: TUI and Desktop share session-history recovery

Status: implemented

## Problem

TUI app.ts and Desktop code-state.ts separately implemented history-window task queries, task details/event pages, missing-text reads, generations and in-flight deduplication. Rule changes required two implementations. Desktop's independent first-display trace-flash fix demonstrates that display timing cannot simply be unified.

Desktop also had a reproduced stale-generation failure: after a history page returns but list_tasks still waits, a new-instance snapshot is installed. If the old query then fails, loadHistory's fallback catch installs the old history page. Outer run discards the old error but cannot undo installed data. A probe observed empty new-instance sessionViews repopulated with old sessions/text while readError remained empty.

## Decision

HistoryRecovery in `packages/view/src/history-recovery.ts` centralizes task-window queries, task detail/event recovery, text pagination, recovery generations, cursors and in-flight reads. It consumes injected read-only request capabilities without opening connections/files. ViewState/EventFlow remain input installers, not active requesters. The module uses Coding's shared control protocol, not production Personal durable.

Existing adapters are TUI ControlConnection and Desktop bridge requests. The shared module consumes named list_tasks/get_task/read_task_events/read_history_entry types without client error classes, Node, Electron or full UI objects. Adapters classify entry_not_found by named error type/code, never message parsing. Other failures remain for their owning client's presentation.

## Shared reads and client presentation

The module resets recovery generation, finds/installs window-task state, restores one task, fills one entry and reports pending missing text. Callers compose existing Promise.all for concurrent task recovery rather than a forwarding-only batch API. Task/text loops, cursors, generation guards and deduplication have one implementation.

Clients retain one-shot read_history, page installation and display stages. TUI installs/displays history first, then queries tasks using every loaded entry. Desktop queries task status for this page first, installs history, then restores task events/truncated entries in the loaded window. Desktop keeps settle-coalesced redraw, inspector refresh and notifications. TUI keeps scroll anchors, input-history seeding, checklist refresh and terminal notifications. Clients compose shared capabilities without implementing task/text pagination again.

Two actual text policies remain: TUI uses 48-KiB pages and completes only assistant entries; Desktop uses 64-KiB pages and completes every role. They are page-size/completion predicates, not client-name branches or a generic configuration framework. The same completion predicate identifies complete entries and determines further paging, avoiding duplicated checks at call sites.

Missing-text pending facts belong to the shared read generation. Desktop historyReady reads them for trace control: completing entries already in the history page does not prevent collapse, but off-page missing entries remain unready until successfully installed. Failure/entry_not_found is not success; generation reset drops old facts. Desktop keeps trace presentation/animation; TUI does not use readiness queries.

## Failures and generations

Every new snapshot synchronously resets shared recovery generation/cursors. Existing client generations still own history pages, scrolling, commands, tabs and other independent requests. Every asynchronous success, failure fallback and finally cleanup must verify its original generation; stale requests cannot write new projections, clear new requests or change new pending facts.

A history recovery pins generation before page reading and carries it through task-window query, client page installation, task events and text reads. Generations can change between stages; later entries cannot capture the latest generation to continue old work. Only independent live-entry/task refreshes begin at current generation. Desktop read owns error presentation/inspector cleanup; run deduplicates history pages/summaries only. Shared recovery owns task/text in-flight requests. Old read/settle finally blocks cannot seed inspectors, read diffs or redraw new generations. New snapshots synchronously clear quiet/dirty so old recovery windows cannot suppress fresh rendering.

Desktop fallback installs an already-read history page and reports list_tasks failure only in the current generation. Old successes/failures install nothing, revive no old sessions and alter no new errors. This preserves availability fallback while adding its missing guard.

Task detail seq applies only to details, not event-read starting position. First task-event reads begin at zero; pages for one task are serial, different tasks may run concurrently. Text advances by UTF-8 bytes from offset zero, with contiguous pages and stable total size. Complete entries install only after integrity checks; malformed responses raise named history_discontinuous. TUI keeps valid response scope and adopts Desktop's existing integrity requirements rather than weakening shared validation.

Not-yet-persisted entries may be retried later. Other entry errors are reported through existing client behavior and recovery proceeds to subsequent missing entries; one entry failure must not silently terminate the whole chain. Task status/detail/event failures remain owned by each calling context, preserving TUI classified notices and Desktop readError.

There is one projection-change notification and one entry-read-failure channel. Event-page installation can progressively refresh TUI, while Desktop coalesces through settle. Notifications are not per-stage installation hooks or fragmented refresh/inspector/error callbacks.

## Related decisions

- [Workspace packages](2026-10-11-in-repo-workspace-packages.md): extends view with separate read orchestration, retaining pure projections, browser constraints, connection ownership and TUI command persistence. ViewState still does not network itself.
- [Trace hydration flash](../bug-fix/2026-10-19-trace-hydration-flash.md): retains state-before-history, window redraw coalescing and missing-text readiness; only shared read facts move.
- [Complete reasoning/file preview](../feature/2026-10-18-complete-reasoning-and-preview.md) and [internal reports](../feature/2026-10-14-internal-report-visibility.md): retain UTF-8 bytes, integrity and internal-input filtering without new protocol/history facts.
- [Desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md): keeps shared projections without restoring old Personal Runtime or changing product scope. No other proposed/rejected note covered this extraction.

## Alternatives considered

- Put reads in ViewState: shortest calls, but violates pure projections/browser verification and mixes connections/lifecycle into state. Use a separate module.
- Put orchestration in control: close to protocol, but projection installation would require reverse view dependency or many tiny write callbacks. View already consumes control types, preserving dependency direction.
- Share a fixed first-screen pipeline: less client composition, but changes TUI progressive display or breaks Desktop trace hydration. Keep both real display orders.
- Extract stateless pagination only: shorter files, but generations/cursors/deduplication remain duplicated and stale-failure risk scattered. Move shared state with recovery ownership.

## Verification

`test/history-recovery.test.ts` covers both text policies, UTF-8 pages, same-task/entry deduplication, zero-start event cursors, cross-stage generation changes, stale success/failure/cleanup, pending readiness and malformed-page rejection. `test/37-view-browser.test.ts` executes Chinese/emoji multipage recovery in a VM without Node globals. TUI/Desktop integration regressions retain display timing, scrolling, command history, child-session/tab recovery.

`test/41-desktop-stream.test.ts` covers stale list_tasks failures within/across instances: no old text/session/error revival, no stale-finally inspector/redraw, and current-generation failures still display history plus error. Another case verifies later entries install after one corrupt entry while that entry stays unready. Removing the fallback generation guard reproduces old-text overwrite/session revival. Original commands/acceptance are offline at `.scratch/history-recovery/issues/01-share-recovery.md`; deterministic tests do not establish real Electron/MyGo or real-model behavior.

## Consequences

Clients share task-window/detail/event/text rules while composing their own read/display stages. No control protocol, JSONL, schema, message ordering or visual-style change is introduced. A separate recovery object/generation must be maintained; clients still guard their own history pages/display cleanup, so shared reset alone is insufficient.

Moving loops but keeping duplicate state increases comprehension cost; moving first-screen order, scrolling/redraw into shared policy expands the interface. The boundary is shared recovery facts with short explicit client composition. View gains orchestration but no connection creation or arbitrary reads/automatic retries. TUI handles discontinuous/changing-total responses more strictly as failure-path integrity, without changing normal text scope/page size.
