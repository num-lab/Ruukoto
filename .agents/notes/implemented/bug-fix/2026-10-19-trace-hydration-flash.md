# Agent Note: Do not flash collapsed traces open during history recovery

Status: implemented

[Completed-trace collapse](../feature/2026-10-18-completed-trace.md) retains its conditions/animation. This note makes those conditions true before a recovered history page first becomes visible.

## Problem

Previously collapsed execution records briefly opened then collapsed after cold app restart, while reopening an already loaded tab worked. History rendered before three completion facts were ready:

- Bounded snapshots include only recently completed tasks. Older task state arrives through list_tasks; without it, conversationSections cannot mark completed and mounts an open trace before animating it closed.
- Events recover in pages of 100. If task.output_entry arrives later, interim repaint sees a streaming/intermediate last entry and still cannot mark completed.
- Reading truncated bodies used shared pendingEntries, making historyReady false even for known entries and reopening their traces until completion.

All three intermediate states occurred after history became visible; warm reopening avoided recovery entirely.

## Decision

Recover task states for the history window before installing the history page, then restore events. HistoryRecovery.readTasks owns list_tasks paging/upsertTask and returns relevant tasks, or null on a generation change to abandon recovery. installHistoryPage follows state installation. If current-generation state loading fails, still install the history page before throwing, retaining visible-history/readError degradation. HistoryRecovery.restoreTask restores events/tool details for the returned task set.

Coalesce recovery repaint into one update. loadHistory wraps the whole process in settle counting; mark() only sets dirty while nested, and outer completion calls changed() once. The first visible page therefore has the final task/event/body projection. CodeState's internal updates use mark(); external collaborators such as approval, writes, and inspector still call changed directly.

HistoryRecovery.loadEntry does not add an entry already present in the history page to shared pendingEntries. It only completes known text; entry identity and whether it is the final body are already known. Truly missing entries, including live task.output_entry and outputs beyond truncated pages, still register and keep traces open until final body is established.

[Shared history recovery](../architecture/2026-10-23-shared-history-recovery.md) owns common reads/missing-body facts. State-first ordering, coalesced repaint, and collapse rules remain here.

## Alternatives considered

Deferring installation until all reads complete lengthens a blank first screen; the chosen order installs after state loading and preserves error degradation, while repaint batching hides successful intermediate projections. State-first alone is insufficient because event pages and missing-body reads still expose open traces. Teaching historyReady to distinguish every missing kind is more indirect and misses live paths; classify at loadEntry. Hiding traces on the first frame or disabling animation hides the symptom, not recovery state. Unbounded snapshots violate the established limit and slow every reconnect.

## Consequences

Cold-open traces are collapsed on first visibility. Collapse animation belongs only to real completion or user action. Messages appear later because recovery waits for task/event/body facts, with no intermediate progress UI. State-load failure still exposes history and reports error. Live missing output entries continue preventing automatic collapse until their body settles. `test/desktop-trace-hydration.test.ts` and two desktop-tool-activity cases protect final-only projection, initially completed traces, and known-entry body completion not changing historyReady.
