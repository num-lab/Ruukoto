# Agent Note: Add transitions to handwritten controls

Status: implemented

## Problem

Desktop's shadcn primitives already provide color/general transitions and popup motion. Handwritten CSS instead switched workspace arrows, clickable-row hover, hidden buttons, and toast appearance instantly. The frozen prefix defined transitions only for established features such as sidebar width, filtering, and tab ordering, leaving custom buttons without a shared source.

## Decision

One anchored block in production's appended CSS supplies three actions rather than scattering rules:

- Workspace rows, session items, Personal rows, Git commit summaries, inspector new-tab entries, and attachment removal use 120ms transitions for background-color, color, and opacity.
- Workspace-add and tab-close controls, revealed by hover or focus, gain opacity transitions without changing their hit area or geometry.
- Toast uses a 180ms `toast-in`, fading in from 6px below, matching the existing `connection-fade-out` ending duration.

Workspace arrows declared a transform transition, but Tailwind v4's `rotate-90` writes the independent rotate property. Override transition-property with rotate on the same selector, preserving the frozen 150ms duration/easing. File-tree arrows had no transition, so add rotate 150ms there too.

Existing global `prefers-reduced-motion` disables animations and transitions, including these rules, with no extra media query. Changes are confined to the production append section in `apps/desktop/src/renderer/style.css`; the frozen prefix and mutable Demo remain untouched.

## Alternatives considered

Editing the frozen prefix or Demo would break the assertions that production starts with frozen source and Demo equals frozen source plus deltas. A tail delta needs no refreezing. Tailwind classes on custom controls would spread the same rules through JSX files; one CSS selector group is smaller and leaves interaction/accessibility attributes alone. Transitioning all properties risks accidental layout animation. A toast component or Presence adds dependency/focus machinery for one fixed message; a keyframe suffices.

## Consequences

Hover, visibility, toast appearance, and arrow rotation gain short transitions. Handwritten selectors remain coupled to class names, so new equivalent controls need inclusion. Existing collapse, filter, tab-drag, and popup owners remain responsible for their motion. Reduced motion, themes, and narrow layouts are unchanged. This presentation-only change does not alter what is output or when, and originally required no new behavioral test.
