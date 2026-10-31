# Agent Note: Compose Demo Context from official primitives with a ring trigger

Status: implemented

## Problem

The owner requested shadcn/ui Context with the supplied gray progress ring and no percentage label. The earlier [AI Elements experiment](2026-10-16-demo-ai-elements.md) reduced Context to a read-only meter while removing hover descriptions. This request supersedes that Context choice, not the restriction on unrelated hover descriptions.

## Decision

Compose Hover Card and Progress using the official [Radix Context pattern](https://ui.shadcn.com/docs/ai-elements/radix/context). Copy radix-rhea sources, normalize the `cn` import and reuse `radix-ui`; add neither a dependency nor a Context wrapper. Upstream Progress omitted forwarding `value` to Root; add that line so accessible value/state matches the fill, leaving other source and the MIT license intact.

The trigger remains left of the model: a `type=button` icon button with a gray track and used arc, no number or rotation. Existing mock `usedTokens`/`maxTokens` drive the arc; zero opacity at zero avoids a round-cap dot. Hide SVG from screen readers while retaining the button's accessible name and always-present token description. The initial detail showed Context, used/total tokens and Progress, with no percentage, cost or actions. Use official pointer/focus behavior and retain the ring in narrow layouts without changing Effort, model, submission or mock data.

[Context details](2026-10-16-demo-context-details.md) subsequently replaces the no-percentage detail with percentages, segments and category totals. The numberless ring and Hover Card/Progress composition remain. [Header/model-menu changes](2026-10-16-demo-header-model-menu.md) do not change Context behavior.

## Alternatives considered

- Keeping the read-only meter and replacing its icon is smallest, but does not meet the explicit component request.
- The old AI SDK Elements Context has a ring, but adds model/usage dependencies and unwanted cost statistics. The current official composition suffices.

## Consequences

Only the mutable demo gains the two official primitives and SVG; production GUI, backend, frozen copies and conversation fixtures are unchanged by this decision. SSR checks cover 0/16/50/100% arc and accessible Progress values; browser checks cover detail, focus, themes and narrow layout. Component provenance remains in the maintained demo README; appearance requires owner acceptance.
