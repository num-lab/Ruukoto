# Agent Note: Reduce tests by current products and unique regression value

Status: implemented

[Node 24 and CI budget](2026-10-24-node24-ci-budget.md) supersedes the historical Node matrix/job deadline below. Platform protection, real coverage and historical results remain.

## Problem

Application tests consumed about 98% of the latest local full check; the remote four-cell matrix exceeded 45 minutes and Linux had roughly 25 minutes without new output. Many cheap assertions were not the main cost. Retired Personal Runtime acceptance and repeated backend/worker/Git-copy/PTY setup increased maintenance. The owner requested maximal useful reduction; original implementation scope is offline at `.scratch/ci/issues/02-reduce-test-suite.md`.

## Decision

Current product contracts and unique regression value determine retention. Retired normal-runtime entries leave acceptance; supported old-data reading, import and no-replay remain. One narrow test owns one behavior at one boundary, with a few real combinations for necessary cross-layer wiring. Similar titles do not justify combining different permission, storage, transport, execution or recovery conditions.

First diagnose Linux silence/existing failures and establish comparable baselines, then delete clearly retired/duplicate tests, then reduce repeated preparation in necessary integrations. Pure classification, drafts, pages, revisions and transactions use the narrowest existing interface. OS isolation, stopping, real crashes and no effect replay keep actual boundaries. Shared fixtures reuse stable preparation only; mutable negative-case state stays independent. Full-file wall time includes setup/cleanup.

Coding joint acceptance shrinks from six inputs to four: three initially fill capacity, one fails, and the queued fourth succeeds. Each of three successes has independent verification/actual integration. Retain queued replacement, frozen results, source protection, failed-dependency skip, one partial-failure report and stopping checks. Old Personal workflow joint examples retire with production entry; current durable tests own Personal behavior.

The original comparison kept macOS/Linux by Node 22.19/24.15, 45-minute jobs, file concurrency two and macOS exclusive lists. This isolated reduction gains; after necessity review, remaining slow retained sets would justify a separate scheduling decision, not disguised deadline increases/skips/retries/platform removal. The later Node24/budget decision explicitly supersedes matrix/deadline requirements rather than rewriting this historical baseline.

New regressions first locate the existing behavior owner: add missing assertions there or a unique narrow counterexample. A new full chain must explain why existing combinations cannot prove its wiring. This supplements impact-selected checks, not the duty to cover each changed behavior.

## Preparation and compatibility

Command-recovery corruption uses three real baselines: restricted, full access and unverified stopping. After clean SQLite close, immutable copies are restored to the original profile path for each independent cold-start/tamper/rejection case. Actual workspace realpath/inode, machine and command references do not change. Ten corruptions separately prove zero additional model/execution calls. Only original command preparation is shared, not reduced to static-field checks.

SSH message tables call existing classification directly; real processes still prove exit code, error bytes and locale. Deadlines/backoff use controlled Node clocks, while ignoring TERM and actual reaping remains an OS case. Before advancing clocks, verify actual forwarding PID listening, control connection online or reconnect timer registered. First connection, timeout recovery and forwarding restart share phase synchronization to avoid advancing ahead of real I/O.

Model-settings drafts, request order and late responses use existing in-memory DesktopBridge replies; real backends still prove no directory change, omitted names/credentials, secret placeholders, rollback and actual events. MCP renderer pagination uses two pages, with denied credentials/late replies at the same interface; small backend cases prove actual sources, empty workspaces, revisions and ownership. New chat keeps all four-mode by four-entry frontend argument combinations. Each of two control entries checks every mode in one actual backend for persistence, zero tasks and idempotency. Archive/unarchive runs sequentially in one fixture. Pure migration rollback/fallback uses real SQLite/directories; other controls, permissions, sources and byte checks retain integration coverage. Duplicate integrate checks join the real success path while retaining read-only rejection, empty zero-event and old-role delegation refusal.

The retired Personal `CodeState` history and Inspector examples leave desktop acceptance. Current `PersonalState` history/profile isolation and rejection of old Personal IPC remain in the native/interface and desktop-main tests; Code Inspector coverage remains. Service tool catalogs belong to the enable/disable tests in `personal-services`, Git row geometry to `desktop-git-windowing`, and MyGo request forwarding to one actual preload case retaining the Personal target and nested settings parameters. Independent service-operation permission cases keep their execution and single-consumption checks without repeating the unrelated full catalog.

Personal settings SSR shares one Vite server and loaded editor across the file; each scenario still creates its own mutable state. Output corruption cases prepare one actual published file, close SQLite, then restore the database at its original path before each independent source, permission, work or Telegram-origin mutation. The profile directory and artifact identities remain intact. Every real reopen must reject without another model request; sharing preparation does not replace the [final-output](../architecture/2026-11-05-personal-final-outputs.md) provenance checks.

Work-fact pagination keeps one completed combination of actual app-data, generic tool and MCP records, plus an independent MCP unknown-effect case. Real loopback HTTP reads provide the generic tool records; file-worker identity and stopping stay in dedicated file-I/O tests. The unknown case does not repeat unrelated app-data/tool execution. Both retain off-page blocker counts, complete MCP paging and reopen; the combined case retains independent text/fact offsets and each family's ordering. Restore broader combinations if projection starts depending on operation kind or another family's unresolved state.

Automatic review approve/reject/invalid/failure/length/error keeps actual tools/evidence. Narrow JSON parsing cannot replace Personal incomplete-stream/missing-evidence handling. Without an existing narrow entry, keep real tests rather than adding production APIs solely for reduction. Two corrupted-review-evidence cases independently clone one closed baseline and actually reject cold startup.

Legacy approval/reply/ledger/import/read-only data keeps compatibility tests. Old Personal workflow/Scheduler runtime, old TUI normal panels and unused Pi RPC exploration leave the current suite. Shared time/DST, AppDataStore/Query, OneBotClient, retained GitHub call chains and actual SSH boundaries remain. Historical files are located by original commit, preserving counts/logs.

## Fixture failures

The macOS trusted-launch marker create/write window is a product defect fixed separately by [atomic publication](../bug-fix/2026-10-24-native-marker-atomic-publish.md), retaining strict reads/timeouts/stopping. Linux diagnosis also found late TUI replies restarting animation/retaining the process after exit; [its cleanup fix](../bug-fix/2026-10-24-tui-exit-late-response.md) retains a counterexample/local guard rather than deleting coverage.

Zero-event control-receipt assertions compare around synchronous queries, with actual IPC checking results separately so concurrent final-report events are not read effects. Personal tool-approval tests use an independent actual client process and retain five seconds; backend synchronous file verification after response can delay an in-process client's read, not justify longer product deadlines.

SSH fixture scenario files use parent/child temporary files plus atomic replace; inspect only reads, avoiding partial JSON/old-snapshot overwrites. Release failure still enters close. Cua's four maximum-size images use the product's sixty-second call budget, removing only a fixture ten-second override; four 8-MiB images and 48-MiB aggregation rejection remain. Demo gains existing MCP event types. Desktop creation rejection uses nonexistent paths under current owner-registration permissions.

macOS native fixtures finish orphan PID writes in temporary files before atomic ready publication. Early post-fork failure first publishes release, joins fixture waiters/direct worker, then returns original failure code. Normal paths still verify stopped/orphan/reason before cleanup; cooperative exit is not production stopping proof.

Workflow PTY sends each action after observing the preceding action's actual screen, not absolute seconds from startup. Markers read new output only; the last step selects chat text present in incremental redraw rather than unchanged connection text. All 21 actions, wide/narrow sizes, segmented assertions and forty-second deadline remain. Other PTY cases retain original timing.

Mock-model SSE replies explicitly use Connection: close. Same-process synchronous setup can cross the default idle deadline: server destroys the connection before the client pool consumes close, and the next request gets ECONNRESET from the zero-retry SDK. These mocks do not test connection reuse. Closing after replies preserves complete streams, tool calls and later requests without longer timeouts/retries or changed production clients.

Tool availability assertions inspect actual function names rather than searching descriptions that may mention another tool. [Telegram effect choices](../architecture/2026-11-06-personal-telegram-delivery.md) save an immutable owner claim directly; old tests must not require a second evidence message. Original actor, receipt linkage and unresolved stopping remain checked. Tool-stop controls independently prove that stopping does not resolve an unknown effect; real recovery tests retain the combined release condition. Pending legacy file fixtures are rejected by the earlier output-capability cutover guard, while completed legacy files retain compatibility and pending targets/claims remain unchanged.

Fixture timing follows the boundary under test. Workflow cancellation waits for the client's accepted response before Escape; mid-call MCP revocation waits for the next model request to offer the tool before disabling it. Native cleanup gives only the held revalidation its short deadline, leaving initial identity preparation on the production budget. Command corruption is applied after clean close so shutdown reconciliation cannot repair the intended invalid stopping record. Git fixtures disable automatic maintenance so strict object-tree scans do not race Git's own temporary lock deletion.

Telegram control fixtures reply to each completed receipt's `platformMessageId`, not the last message in a shared send log: proactive cards and other host replies may arrive between controls. The browser case inserts another real menu before stopping to retain that ordering counterexample. A crash fixture must retain its resource owner as well as its process: the authentication child references its auth object from the live timer and forces GC before announcing readiness, so SQLite cannot release the lock before the actual SIGKILL. Reopening still must preserve identity and invalidate the old pairing window.

File-worker close rejection requires actual OS blocking, not the wrapper's pre-read marker: termination before the read can legitimately succeed. Capacity, durable-Harness close and backend-stop tests share the existing Linux thread wait-channel/macOS stack observation. The four-worker case owns close rejection, retained capacity, canceled calls, actual exit and successful close retry; its duplicate single-worker case is removed. Durable and backend cases retain their distinct profile-lock, live control and reopen checks.

Cua product integration uses normal call deadlines. A fixture exits after recording a sent request to produce response loss; it does not make every ordinary response race a 300 ms budget. The transport cancellation/timeout case owns persistence-before-send deadline coverage, including zero late sends and no pollution of subsequent calls; its duplicate timeout-only case is removed. Product integration retains unknown-effect freezing, recovery, actual process stopping and no replay.

## Related decisions

- [Joint workflow acceptance](2026-10-13-workflow-joint-acceptance.md): replaces six-input scale/old Personal examples; retains explicit real-model opt-in, platform stopping and evidence levels without rewriting results.
- [Sole Personal durable entry](../simplification/2026-10-18-personal-product-entry.md): retains retired entries/shared libraries/old data; only tests losing product value are narrowed, with no new product retirement.
- [CI prerequisites/concurrency](2026-10-22-ci-prerequisites.md): retains prerequisites, failure propagation and exclusivity/concurrency; per-test necessity replaces blanket retention.
- [Impact-selected checks](../process/2026-10-10-pre-push-evidence-ladder.md): retains targeted evidence/final CI responsibility; this determines the retained suite.

[Generic scheduling](../feature/2026-10-12-generic-scheduled-tasks.md) and [backend/terminal separation](../architecture/2026-09-19-detach-terminal-from-task-runtime.md) only update retired runtime/RPC-exploration test locations. The original audit found no same-topic proposal or wholly absorbed note. Existing async-phase mechanisms remain.

## Alternatives considered

- Delete by percentage/line count: quick small suite/quotas, but historically nearly half the cases consumed only about 0.8% of time, and counts do not identify unique negatives.
- Increase concurrency/shard/shrink matrix only: quicker jobs, but leaves valueless coverage and real-worker contention. Keep separate from first reduction; reconsider from measurements if needed.
- Mock everything: fewer starts, but cannot prove native permissions/stopping/crash no-replay. Only pure logic/UI state moves to narrower layers.
- Keep everything on a periodic schedule: quicker daily feedback, but retired tests still cost maintenance and unique regressions appear later. Delete obsolete coverage; required cases stay in full checks.

## Verification

Every removal must trace to a retired entry or retained assertion, with module-by-module necessity review. Replacements retain failure conditions and safety/recovery negatives remain fault-detectable. Original acceptance required all four cells on the same candidate below 45 minutes and separate reporting against a thirty-minute optimization goal; that was a requirement, not evidence of a pass, and later matrix/budget rules supersede it. Old failures, timeouts and unverified environments cannot disappear from success summaries.

Implementation steps, first candidates, commands, stopping criteria and evidence remain in the offline original work item. Independent retention review is not implementation/performance/remote acceptance. Commands, checked content and results are recorded separately.

## Consequences

Retired wiring tests may contain unique shared-library/old-profile guarantees, requiring caller/assertion inspection. Moving down layers can lose wiring coverage, so real representative cases remain. Shared preparation must not pollute state or bypass persistent identity; independent recovery negatives cannot become sequential mutations of one profile.

Historical times differ from current HEAD/runners. Initial deletion counts do not promise thirty minutes. If the necessary suite stays slow, expose remaining costs and discuss execution strategy. Test reduction itself does not authorize new features or production-boundary changes.
