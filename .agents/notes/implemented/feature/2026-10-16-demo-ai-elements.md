# Agent Note: Use AI Elements for the demo conversation stream

Status: implemented

## Problem

The owner requested trying shadcn/ui AI Elements in the standalone demo before reviewing another GUI migration. Desktop already followed [the previous approved design](../architecture/2026-10-15-desktop-shadcn-demo.md); a new experiment must neither silently change production nor overwrite the frozen reference.

## Decision

At this stage, change only the standalone demo. Use [shadcn/ui AI Elements](https://ui.shadcn.com/docs/ai-elements) Radix composition: Message/Bubble for messages, Trace/Collapsible for tools and separate SubAgents, Item/Button for approvals. Source comes from the official radix-rhea registry, changing only `cn`, component imports, and Lucide placeholder icons while retaining MIT licensing. Current runnable source/provenance lives in [the demo](../../../../verification/desktop-demo/README.md); frozen baselines live separately under `test/fixtures/desktop-baselines/`.

Message Scroller pins `@shadcn/react` 0.3.1 without a model SDK. Main and SubAgent identities mount separate Providers, retaining existing step IDs. Open at the top and follow new content only while the reader remains at the bottom. Remove step-count-triggered forced scrolling rather than retaining two scroll controllers.

Workspace sections and thought/tool collapsibles use 180 ms height/opacity animation. Reuse Collapsible/Trigger/Content and preserve section structure, forced expansion during filtering, and stored-state toggling. Local demo CSS matches Radix `data-state` rather than changing official Trace's `data-open` classes. Radix Presence owns exit animation; content becomes inert/aria-hidden as closing starts, preventing focus entering exiting content. Respect reduced motion with no extra measurement or scrolling controller.

Approving/rejecting dismisses the approval without adding a tool-complete row. SubAgents keep separate entries opening the right pane, not inline nesting. Preserve file-diff navigation and adjacent added/removed counts. Activity summaries list only present categories in order: Read files, ran commands, edited files, wrote files, without counts/filenames; SubAgents are excluded. This slice added no feedback, retry, download, scroll-jump, hover explanations, model call, or backend connection. Keep three columns, typography, and existing interactions. Narrow panes prioritize SubAgent names, may truncate annotations, wrap long paths, and independently scroll approval commands.

Use official Neutral light/dark styling and component classes, removing old bubble, Trace, and approval-card overrides. A later request in this same design sequence unified all regions through `theme.css` and [Neutral semantic tokens](https://ui.shadcn.com/docs/theming). Tailwind reads those tokens; the source snapshot `reference.css` remains, while old background/text variables map to the shared theme in both `:root` and `html.dark`, preventing dark selectors restoring blue-gray. Remove duplicated stream colors/focus patches; portals share the theme. Dimensions, fonts, radii, and scrolling stay unchanged; desktop background uses muted, light shadow loses blue tint, and traffic lights/diff/status retain semantic colors.

## Superseded choices within the experiment

The original thought display reused official [Chain of Thought](https://ui.shadcn.com/docs/ai-elements/radix/chain-of-thought) Trace primitives without another wrapper/dependency. `durationSeconds` produced `Thought for [time]s`; continuous simulated text preserved paragraphs instead of checked summary items, collapsed by default with session/stream/step-specific state. Offline sample input assembled this data without changing `reference-data.json` or inferring real reasoning from messages. Tools used a wrench, separate SubAgents Sparkles; inline code was 13px regular weight, leaving command/tool-file sizes unchanged. [Tool-call details](2026-10-16-demo-trace-tools.md) later removed thought groups from the mutable demo and changed Read paths to file preview and other tools to inline expansion. Do not restore the removed reasoning UI from this historical choice.

The original composer ordered Context, model, Effort, send. Context was a read-only meter with visible percentage because hover explanations had been removed; Effort used an existing Select, Low/Medium/High with Medium default, disabled during verification and without menu displacement. Both new-session entries inherited Effort and reset context to zero. `usedTokens`/`maxTokens` were simulated session fields, not draft estimates or real model capacity. Narrow widths originally wrapped controls and right-aligned send. [Header/model menu](2026-10-16-demo-header-model-menu.md) supersedes separate Effort and extreme-width wrapping; [Context component](2026-10-16-demo-context-component.md) supersedes meter/percentage with the native ring/hover presentation. Simulation and session inheritance remain; real wiring requires actual usage/model configuration.

## Alternatives considered

- Install the older AI SDK Elements: ready-made files, but upstream had moved to shadcn/ui, so use the then-recommended source.
- Copy the entire official chat example: quick fidelity, but adds feedback/retry, model client, inline SubAgents, and approval-result rows beyond scope.
- Rename old divs behind AI Elements wrappers: few dependencies, but not an actual component replacement and retains custom folding/scroll logic.

## Consequences

This slice added seven official source components and one isolated scrolling dependency, without changing root dependencies, production Desktop, or frozen versions at that time. Later production adoption belongs to [current demo migration](../architecture/2026-10-16-desktop-current-demo.md), not an implied approval here. Accessible log, Radix folding, and official scrolling still need browser checks for upward reading, session changes, and hidden panes.

Historical component/engineering/browser evidence was recorded in retired `.scratch/desktop-shadcn/evidence/2026-10-16/ai-elements/verification.md` and `native-style-verification.md` (offline provenance). Appearance was left for owner review in this slice; neither those checks nor offline simulated content proves real Electron/model behavior.
