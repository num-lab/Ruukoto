# Agent Note: In-app desktop Spotlight search and verified history navigation

Status: implemented

[Open search results in ordinary sessions](../simplification/2026-10-21-desktop-search-session-navigation.md) supersedes the independent read-only history-window, message-highlight, and disabled-composer choices below. Other search contracts remain. Original confirmed scope/thresholds/acceptance are historical offline `.scratch/desktop-search/issues/01-spotlight-search.md`.

## Problem

With many workspaces/sessions, the owner needs a name or phrase to find archived/old conversations and reach the original message. Sidebar name filtering requires already knowing the session and paging its history. The confirmed scope is application-local Cmd+K search across Code workspace sessions and chat text, not a global OS launcher.

## Decision

Search ordinary development sessions in the current Code instance, including archived ones, displayed by workspace organization. The backend's optional ordinary-chat scope on session summaries determines eligibility and returns complete name candidates for immediate client matching; existing snapshots lack schedule identity bindings and cannot filter eligibility alone. Text search reuses authenticated owner `search_history` and JSONL position indexes, without another body database or model call. Preserve default full-text extraction for legacy CLI/TUI/Agent consumers and fix cross-session continuation in the shared scanner.

GUI matches user text and displayable Agent bodies, not tool arguments/results, thinking, or internal report inputs with different visibility/authorization; those tasks' visible Agent summaries remain searchable. Literal matching supports Chinese and ASCII English case folding. Indexes remain rebuildable location metadata; JSONL stays authoritative for Code.

Text result identity is sessionId + entryId, not a streaming projection key. Read continuous context around it; expanded execution records can reveal hidden hits and multiple streamed segments still resolve the real entry. The successor now installs/opens ordinary-session history rather than a separate permanent read-only search window.

### Performance before interface claims

Reuse existing cross-project lookup, stable entry IDs, original snippets, and continuation rather than duplicate storage/recovery/protocol. But synchronous index preparation/body scanning is not fast merely because GUI debounces.

Index full lines in 256 KiB scans with short progress transactions. GUI search batches index preparation, metadata, and body reads under byte/entry/time budgets and yields the event loop. Permit only one page in flight; stale queries stop continuation. If budget expires before the first entry, return a progress page that can advance through unfinished indexing instead of interpreting empty matches as completion. Synthetic cold/warm queries and concurrent control-plane probes supported the location-index choice. A single huge synchronous JSON parse can still exceed response budgets; threshold failure reopens architecture/review, not a spinner-based success claim. Original numeric thresholds stay in the offline task evidence rather than diverging here.

### Search interface

Owner feedback removes permanent instructions, per-source coverage labels, and a re-search button in favor of results. Text hits show session name, archive badge, snippet, relative time; workspace names appear only in name results. Use theme-gray dialog and a separator between result types. Keep full snippets; only overwide ones use first mark plus actual container pixel width to center via scrollLeft, recalculated by ResizeObserver. Short messages start at the beginning. Clip snippets rather than ellipsis (which can suppress horizontally shifted text); titles retain ellipsis. Character-count trimming loses context with proportional fonts; backend summaries/name highlighting stay unchanged.

Scrollbar width stays fixed to prevent reflow; it is transparent when idle and hides 700ms after scrolling. Near-bottom sentinel reuses pagination instead of a load button. Observer requests once per cycle and rebuilds for actual scroller/result generation/count/loading, disabling when closed/offline/IME-composing/error/complete. Existing controller owns cursors and empty-page continuation. Coverage still determines zero-hit and screen-reader state; failures/offline remain visible despite omitted per-source detail.

Search icon stays left of the topbar sidebar toggle even when collapsed. Cmd+K toggles except during IME composition or key repeat. Center with independent translate while Dialog animates vertical movement; a static transform can be merged by production CSS optimization and start the animation without horizontal centering.

### Original history-window rationale

Appending one ancient entry to the latest 300-entry SessionView could immediately trim it or falsely draw a continuous conversation across a missing gap. Paging backward from latest takes time proportional to distance and old reads reparsed all JSONL. `read_history` around/after supports direct continuous windows and both directions without whole-task event replay. Reuse EventFlow display while real-time updates remain coherent. The original separate-window/return-latest behavior is superseded by ordinary-session navigation; continuous context and verified identity still matter.

### Archive, product, and data boundaries

Archive affects sidebar presence, not search. Explicitly opening a hit never changes archivedAt; an archived tab may appear until archived again under existing close rules. Retain archive indicators. [Archive semantics](2026-10-20-desktop-session-archive.md) remain unchanged otherwise.

Use existing [session attribution](../../../../packages/control/src/session-attribution.ts) for name/text grouping. Do not restrict owner-global search to the currently viewed workspace or confuse organization with source-data identity. Desktop does not speak new personal durable history. Search may open from Code or the Personal page, but results clearly cover Code workspaces only, not "all chats" across products.

## Failure and privacy

Unscanned or not-yet-flushed history returns continuation/loading/accessible status, never whole-library zero hits. Corrupt complete records, missing registered sources, and read denial become coded per-session source issues while other readable sessions continue. Keep results/internal coverage; show request/offline errors, never modify originals or claim full coverage at scan end.

Missing target, discontinuous fragments, or changed source-file identity prevents installing a new window and preserves the old location; never silently jump to latest or stitch different files. Changed query/snapshot/data-instance generations reject late responses and stop old reads. Offline/unsupported protocol gives reconnect/update guidance, never local disk scanning or retargeting.

Desktop reads only through authenticated control, never SQLite/JSONL/arbitrary paths. Index progress and derived entries share short transactions; history is read-only, not atomically committed with SQLite. Query cache is memory-only and clears on instance change; no sensitive search log is added.

## Alternatives considered

- **Name filter in a dialog only:** smallest, but misses the confirmed chat-content requirement.
- **Download all history to renderer:** local subsequent search, but startup/memory/data transfer grow and need live synchronization. Transfer hits and necessary context only.
- **Start with SQLite FTS/vector search:** avoids repeated scans or adds semantic retrieval, but adds derived bodies, Chinese matching choices, freshness/rebuild machinery beyond keyword requirements. Measure existing scanning first; failing latency must trigger a new index/isolation design, not reduced standards.
- **Append read_history_entry to latest:** almost no new UI, but trims old hits and hides gaps. Read contiguous context; successor chooses ordinary-session navigation without abandoning that requirement.
- **OS global shortcut/command palette:** broader launcher capability, but owner chose in-app search shared by Electron/MyGo.

## Related decisions

[History preservation](../architecture/2026-09-19-preserve-session-history.md), [archive](2026-10-20-desktop-session-archive.md), [desktop layering](../../proposed/architecture/2026-10-15-desktop-client.md), and [personal information ownership](../architecture/2026-10-18-personal-memory-skills-history.md) remain constraints, not absorbed decisions. Tool previews/completed traces/compaction keep their own behavior. The original active-note audit found no competing search proposal and changed no sealed archives.

## Consequences

History growth/huge messages may outgrow scan budgets, including indexing cost; validate before claiming Spotlight responsiveness. Shared around/after API changes must preserve TUI/Inspector consumers. Test ancient hits, task boundaries, live append, and full-body restoration without replaying entire tasks into the window.

Only complete persisted records match; unflushed streaming fragments need later search. A query is not a fixed-time snapshot and need not include all concurrent additions, but stable corpora must have neither omissions nor duplicates. Restoring multiple huge neighboring bodies costs transport/renderer memory. An 8 MiB synthetic record had heartbeat checks; larger records still need evidence and may require read isolation or derived full-text indexing.

## Verification

Historical offline `.scratch/desktop-search/evidence/implementation.md` records targeted tests, independent implementation review, synthetic real-control performance, and renderer scenarios. Real dual-shell focus, IME, and subjective experience remain owner acceptance; synthetic data does not prove daily-profile performance. This migration reruns no runtime/UI checks and does not restore the superseded read-only window.
