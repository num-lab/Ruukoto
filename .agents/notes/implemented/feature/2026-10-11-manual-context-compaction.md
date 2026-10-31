# Agent Note: Publish manual rolling summaries as session operations

Status: implemented

## Problem

The owner needs to reduce coding context proactively and direct summary focus. Automatic compaction runs only after watermarks/benefit thresholds and may merely prune tool results; forcing its planner cannot promise a new summary or apply that guidance. Normal summarization was task-bound (`taskId`/`callIndex`), while control requests timed out at 60 seconds and summary calls could wait 180 seconds. A fake owner message or long blocking request would introduce unrelated tasks, false provenance, or unverified outcomes.

## Decision

Reuse rolling summaries/checkpoints with a separate durable session operation for admission/execution/cancel/result. Product capabilities declare availability; Runtime verifies ordinary dev identity and owns session occupancy; agent summarizes; core only reads history and stores operation/checkpoint transactions; authenticated control/TUI exposes it. Never invoke pi compaction that rewrites JSONL.

Manual planning summarizes everything before the last complete assistant batch, retaining the original tail in whole groups. Ignore automatic watermark, benefit, and cooldown thresholds. Do not add a permanent original-request/checklist index: summary carries requirements/decisions/unfinished work and full history stays readable. Automatic planning keeps its existing required-item rules.

Input is the previous summary plus newly covered original history, fixed summary rules, and this request's prompt, all included in budget. When coverage cannot advance, a prompt may rewrite the prior summary; without one, do not call again. This is not resummarization from all history: new focus cannot recover facts already omitted.

### Durable operation and one terminal result

Persist a dedicated request and acknowledge quickly. Same key/parameters reuses it; different parameters conflict. Once source history, expected old checkpoint, and model are fixed, Runtime executes exclusively in the session. New task/queue starts use the same occupancy check; the running summary provider participates in configuration-change checks. No workspace execution lock is needed for this read-only operation.

Successful publication checks not canceled plus matching history/old checkpoint, then commits new checkpoint, successful request, and event in one SQLite transaction. Cancellation winning first prevents publication; success winning first cannot be reported undone. Failure/cancel/interruption preserves the old active checkpoint. Unlike automatic compaction, manual failure never falls back to publishing tool-result pruning alone.

TUI disconnection does not stop work. Queries/events and durable command association allow verification. Backend shutdown aborts and waits before DB close; abnormal restart marks leftovers interrupted without automatically calling the summary model again. Provenance distinguishes manual request from task, with no fictional main-model call index. Branch/import retain generation provenance, not operation receipts or cross-session cancel authority.

Result shows coverage, estimates, and model. The owner kept `/context` as the most recent actual call view, without a current-checkpoint panel. Old selection records retain their original checkpoint association; the next actual model call creates a new selection record.

[Automatic compaction](../architecture/2026-09-26-lossy-context-compaction.md) owns its planner and shared checkpoint rules. [History preservation](../architecture/2026-09-19-preserve-session-history.md), [backend lifecycle](../architecture/2026-09-19-detach-terminal-from-task-runtime.md), and [branching](2026-10-11-branch-session-snapshot.md) remain unchanged prerequisites. Related identity/data/message decisions only need adaptation to the new provenance/receipt fields, not reinterpretation. The original audit found no same-topic proposed/rejected note to remove or archive.

## Alternatives considered

- Force automatic planning: greatest reuse of thresholds/fallbacks, but short histories or prune-only plans may never summarize, ignoring the prompt. Manual planning needs distinct rules.
- Retain a whole recent turn verbatim: protects latest requirements/execution from loss, but makes one long tool-heavy task uncompressible. The owner chose the last complete batch, moving earlier requirements/state into the summary.
- Resummarize all history whenever prompted: can recover lost focus, but grows cost/input indefinitely; the current summarizer rejects over-budget input and would require chunking. Revisit when actual long-history refocusing is required.
- Publish pruning when summary fails: at least reduces some context, but violates the promised focused summary and makes failure ambiguous. Keep the old checkpoint unchanged.
- Use an ordinary task or one long control request: reuses status/cancel or avoids lookup code, but pollutes history/task provenance or fails under disconnect/default timeout. Use a small dedicated operation rather than generalizing tasks.
- Add a current checkpoint to `/context`: visible before the next call, but the owner chose command-result feedback and existing query semantics instead.

## Consequences

Manual summary costs a model call and a prefix-cache invalidation; bypassing benefit thresholds does not guarantee smaller estimates. Statistics cover completed-history view plus summary under one configuration, excluding the next task's references/tools/new input and actual main-model usage. Rolling summaries are lossy; completed requests/old checklists are not retained verbatim forever, and a new prompt cannot recover omitted facts without history lookup.

The operation adds persistence/reconnect/shutdown responsibility in exchange for one verifiable outcome without fake tasks or duplicate model calls. Historically schema 34 added nullable task provenance, `manual_request_id`, and `compaction_requests`; protocol 18 added admission/query/cancel. Current storage follows [direct format replacement](2026-10-12-full-access-current-account.md): no old-schema upgrade/backfill. Historical migration tests are not a current migration promise. Branch/import retain committed points/provenance, not receipts or cancellation permission. `compaction-v2` explicitly preserves unfinished work.

Over-budget input fails without chunking. Corrupt complete lines, partial tail records, invalid headers, or changed source fail clearly; an invalid old point is invalidated rather than revived. Register session/provider occupancy before admission commit/broadcast so synchronous cancellation/configuration listeners participate. If post-commit broadcast throws, inspect the durable receipt rather than leaving an in-flight operation with no executor.

Historical tests: `test/61-manual-context-compaction.test.ts` covers complete-history planning/rolling range/full input budget/typed errors; `test/103-manual-compaction-store.test.ts` covered then-supported migration, idempotency, unique terminal result, and rollback; `test/104-manual-compaction.test.ts` covers low-watermark summary, unchanged JSONL, later context, occupancy/config races, failures/cancel/disconnect, pinned model/fallback, and real Code-backend SIGKILL without re-call. Control/TUI tests cover draft/original-key recovery/navigation/polling; `test/15-tui-pty.test.ts` used a real terminal and Code entry for guidance/progress/success/persistent result after exit. Models were offline substitutes: summary quality/cost remain unverified. Original confirmations in `.scratch/manual-compaction/spec.md` and its issue 01 are now offline provenance, not maintained workflow entries.
