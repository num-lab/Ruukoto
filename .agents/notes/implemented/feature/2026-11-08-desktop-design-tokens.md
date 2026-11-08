# Agent Note: One token system for Desktop styles

Status: implemented

## Problem

Desktop styles grew as an append-only stack. Production had to keep `reference.css` and `theme.css` byte-identical to the frozen demo and to contain three frozen CSS blocks verbatim, so every later change became an override appended to `style.css`. Settings carried a private `--st-*` palette, status colors were hex literals, and the [chrome typography](2026-10-17-desktop-chrome-typography.md) change inflated Tailwind text tokens by 2px and then pinned primitives back to 14px. The result mixed three gray hues, made selection weaker than hover in light mode, rendered chrome text larger than conversation text, and left about nineteen font sizes and nineteen radii. A selector's effective style could only be found by recomposing several layers.

## Decision

`theme.css` is the only place that defines tokens: light values in `:root`, dark values in `html.dark`, the shadcn compatibility names derived from them, and the type, motion and layering scales. `reference.css` is removed. `style.css`, `settings.css` and `search.css` consume only shared tokens, and each selector is defined once with its final values.

The palette is neutral with zero chroma. Color is reserved for status (`--success`, `--warning`, `--danger`), diff lines, Git lanes, syntax highlighting and terminal ANSI. Surfaces are `--bg-window`, `--bg-canvas`, `--bg-inspector`, `--bg-surface` and `--bg-elevated`; interaction uses translucent `--fill-hover`, `--fill-selected` and `--fill-pressed`, layered over opaque surfaces so hover never reads darker than rest and selection is always stronger than hover. Text has three levels (`--text-1/2/3`).

Font sizes come from a fixed scale of 12, 13, 14, 15, 17 and 22px. Conversation Markdown, bubbles and composers use 15px as the largest reading text; chrome uses 14px, tabs and secondary text 13px, captions 12px. Tailwind's own text tokens are no longer modified. Radii are emitted from Tailwind `@theme` (4, 6, 8, 12, 16, 20px) so primitives and app CSS share one scale. Durations, easings and z-indexes are tokens. Global element resets live in `@layer base`, so Tailwind utilities on shared primitives win without `revert-layer` escapes and keyboard focus shows one indicator.

The window background stays translucent over native vibrancy; CSS `backdrop-filter` is not applied to it because it cannot sample the native layer. Shared shadcn primitives, `sidebar-resizer.tsx`, `lib/utils.ts`, `source-highlighting.ts` and `connection-loading.tsx` remain byte-identical to the frozen demo. Production stylesheets are no longer compared with the frozen demo, which stays unchanged under `test/fixtures/desktop-baselines/` and `verification/desktop-demo/`.

This partially supersedes the byte-traceable theme and style-prefix requirement in the [shadcn demo migration](../architecture/2026-10-15-desktop-shadcn-demo.md) and [current demo migration](../architecture/2026-10-16-desktop-current-demo.md), and the non-message font sizes, primitive pinning and selection colors in [chrome typography](2026-10-17-desktop-chrome-typography.md). Colored Git lanes from that note remain.

## Alternatives considered

Keeping the frozen prefix preserves byte-level provenance for every rule, but each new requirement must then be written as an override and reviewed against all earlier layers, which is how the inconsistencies accumulated. Keeping the +2px chrome sizes and only removing half-pixel steps would preserve the earlier readability request exactly, but conversation text would stay smaller than chrome; the owner chose the scale with 15px reading text. Splitting tokens into per-component files would localize edits, but one import order is easier to verify while the palette is still small.

## Consequences

Visual review reads one declaration per selector, and mechanical audits can reject literal font sizes, radii, durations, easings and colors outside `theme.css`. Chrome text is 0.5 to 1.5px smaller than before and conversation text 1px larger. The frozen demo no longer predicts production appearance; it remains a fixture for its own regression check and for primitive provenance. Native-host appearance (vibrancy material, IME, real window chrome) still needs manual review on macOS.
