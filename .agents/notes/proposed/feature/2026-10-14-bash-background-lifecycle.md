# Agent Note: Give background executions a lifecycle independent of a bash call

Status: proposed

[Session backgrounds](../../implemented/feature/2026-10-21-coding-background-processes.md) owns delivered software-work behavior. [Single product](../../implemented/architecture/2026-11-10-single-product.md) retires the Personal portion of the original shared proposal. This record retains lifecycle constraints and external-acceptance limits, not a requirement to restore retired adapters.

## Problem

A development server, watcher or test dependency must remain available to later browser/log/command calls and across ordinary messages. Reclaiming its process group when a foreground bash call returns cannot provide that lifetime; merely documenting the limit does not implement backgrounds.

## Proposal

Separate foreground command return from session-owned background stopping through explicit process start/status/output/stop. Persist the original task, operation, authority and execution reference before launch. Transfer occupancy only after the original temporary worker is verified stopped, without a gap permitting conflicting writes. Cancellation and handoff arbitrate through the recorded owner; an unverifiable start/stop never releases occupancy.

Limit startup to eligible full-access owner conversations. Backgrounds retain independent directory claims; observation, questions and authorized browser use do not grant same-directory writes or delegation. Stop the original background before conflicting edits. `agent_wait` releases only temporary task execution, never background occupancy. Default-mode changes do not rewrite original authority.

Ordinary turn completion, TUI/desktop exit and archive do not stop session work. Explicit ending registers a barrier against late starts, verifies all owned units stopped and preserves history. Backend shutdown gathers its executions. Restart verifies/stops only the original execution, never relaunches its command. Linux uses original scope/invocation identity and macOS persistent supervisor identity/receipts; PID/PGID alone is not signaling authority. Status and exit code are not business-effect receipts.

## Alternatives considered

- Relax bash cleanup only: supports later calls in one task, but not the required across-message lifetime or explicit resource ownership.
- Permit arbitrary restricted-network backgrounds: useful previews, but exceeds the existing restricted command/network policy. Start from explicit full access.
- Treat a returned command or dead backend as stopped: simplifies cleanup, but does not exclude descendants, late launch or retained occupancy.

## Acceptance criteria

Exercise actual native process handoff, subsequent messages/browser/log reads, stop-before-edit and late-launch cancellation on macOS and isolated Linux. Verify restart never replays commands and unverified stopping retains occupancy. Model routing and real TUI/Electron/MyGo interaction require separate evidence; missing environments remain gaps. Personal retirement is not a passing result for its former acceptance.

## Risks

Background lifetime increases retained state and requires explicit owner ending. Detached full-access processes and external services exceed the tracked unit’s stopping promise. Cleanup can legitimately remain blocked until original identity/exit is verifiable; a timeout is not permission to release a directory claim.
