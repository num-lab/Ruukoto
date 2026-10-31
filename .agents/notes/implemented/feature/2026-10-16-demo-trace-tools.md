# Agent Note: Nested Trace for Demo tool-call details

Status: implemented

## Problem

The owner requested the supplied official Trace style, removing displayed thought bodies while retaining tool groups: Read paths open files, Edit/Write expand inline diffs, Bash shows full commands, and failures are red with inspectable errors. The [AI Elements experiment](2026-10-16-demo-ai-elements.md) instead sent tool rows to inspector diffs and added separate thinking fixtures. This decision partly supersedes those choices, not unrelated messages, approvals, scrolling or layout. Production Desktop/frozen copies do not update implicitly.

## Decision

The mutable demo initially removes its thought type/fixtures/rendering and shares ToolActivity between parent/child streams using official Trace. Separate SubAgents retain inspector entries. Tool summary groups contain nested Trace; calls with details use TraceCollapsible. Keys include session, stream, step and call index, with a separate stream key for detail scenarios. Reuse Radix Presence, 180 ms animation, `inert`/`aria-hidden` and reduced motion; add no scrolling/height controller.

Execution tails reuse the component with explicit thinking/working phases. Thinking shows only a spinner/status, not a thought body. Working starts open and shows completed or explicitly running tools with state-specific verbs. Failure overrides running. Running Edit/Write displays only that call's recorded diff, never old session differences or completed statistics. Tail keys use session/stream/execution so queued-input insertion cannot shift detail state.

The existing executing scenario shows Thinking; another explicit scenario shows Working without timers. Previews only filter approval cards and append the tail; they never mutate history or fabricate approval, and leaving restores original approvals. Both phases support stop/input queueing. Session changes clear scenario state, preventing tails/stop controls from leaking across sessions. Spinner/Trace respect reduced motion; Message Scroller retains scrolling ownership. The later execution-feedback and completed-trace decisions below supersede the applicable presentation details.

Read rows remain static; only paths link through existing `openFile` to independent previews. Missing files retain preview feedback. Failed Read shows its error directly, without an expand button. Edit/Write use their recorded diff or linked `diffFile`; absent records and empty files are explicit, never reconstructed from full files. Bash details show original `command`/`output`. Other actions retain names/raw notes instead of disguising Build/Bench target files as shell commands.

Only explicit `error` marks failure. TraceLine uses error status, CircleAlert and `Failed to` text; details use destructive CodeBlock. Closed groups retain failure count/red status. React escapes displayed text; commands never execute. Copy only required official radix-rhea CodeBlock, CodeBlockContent, CodeBlockLine and variants, normalize `cn`, and retain licensing. Omit unused headers/actions/copy/footer and highlighting hooks/dependencies. Native small/wrap/max-height styles avoid horizontal scrolling for code/results/errors/diffs.

Default conversations retain read-only fixtures. A separate settings scenario supplies Write, successful/failed Bash and failed Read, returning new steps without mutating Session/diffs. `reference-data.json`, frozen versions, production Desktop and backend stay unchanged by this demo decision.

## Alternatives considered

- Flattening every row matches the reference but originally contradicted explicit grouping. Use nested official rows/details at this stage.
- A collapsible/button Read row is uniform, but conflicts with a static row and independent path action. Keep the link and visible failure.
- Sending every tool to the inspector reuses diffs, but not requested inline details. Inspector body-diff entries remain separate.
- Installing the full CodeBlock/highlighter is easy to copy but brings unused dependencies/controls. Keep only required display primitives.

## Consequences

Per-call expansion adds one level while preserving official truncation, focus, semantic themes and independent scrolling. Full input/results must come from call records; memory fixtures prove neither real execution nor production wiring. Historical engineering/browser review and owner-acceptance scope remain in offline Trace/execution-summary work items.

[Continuous execution feedback and reasoning batches](../bug-fix/2026-10-17-desktop-execution-activity.md) supersedes the applicable phase presentation. [Flat tools and completed traces](2026-10-18-completed-trace.md) supersedes summary grouping/completion display. Call details, source identity, errors and pagination/recovery lifecycles remain.
