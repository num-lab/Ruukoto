# Agent Note: Non-message typography and selection styling

Status: implemented

## Problem

The owner requested a 2px increase for all text outside the message stream, brighter translucent dark-mode selection in the left sidebar and tabs, removal of the line between the inspector and top tabs, and colored rather than grayscale Git branches.

## Decision

Append the `approved-demo-v4-polish.css` delta to Demo and Desktop with source assertions, without changing frozen reference, theme, or primitive files. Existing non-message px font sizes increase by exactly two; body text changes from 13.5 to 15.5px. Four used Tailwind text tokens increase by two, while main/child conversations restore original tokens and their 14px baseline. Message code, tools, and approvals retain their sizes. The change includes input, portal menus, settings, Git, Files, and file preview; iframe sites and native system menus own their typography. Source preview uses 14px text with a shared 23.8px line height for code and line numbers.

Token expansion should affect explicit px text only. Primitives using bare Tailwind tokens would otherwise increase twice (`text-sm` from a 12px baseline directly to 16px). Dropdown slots; buttons, inputs, Select triggers, and Item text in dialogs/settings; and empty-state buttons are therefore pinned to the 14px secondary tier by an anchored style.css append block. Model-settings' own 12px labels remain later overrides.

Dark selection uses 14%-opaque white only on left-sidebar `active-pill` and active items in both tab groups. Hover does not override selection. Remove only `inspector-header`'s bottom border; retain the 28px vertical separator between top tab groups and internal toolbar lines. Git has six independent colored lane tokens in each theme, shared by lines, nodes, and left ref icons. Text stays neutral; lane colors cycle beyond six.

This replaces non-message sizes and neutral lanes in the [Desktop migration](../architecture/2026-10-17-desktop-demo-v4.md), [graph sample](2026-10-17-demo-git-graph.md), and [commit details](2026-10-17-demo-git-commit-details.md). Graph structure, compact rows, ref-icon-only coloring, and the single glass base remain.

## Alternatives considered

Increasing the HTML root font is shortest but changes rem spacing and message components, not just text by two pixels. Changing body alone misses explicit px and portal primitive sizes. A global accent changes menus, code, and cards too; local selection tokens avoid that.

## Consequences

Chrome text is more readable while main/child message sizes remain stable. Narrow areas truncate titles or collapse to icons sooner; control and tab-width constraints remain. Frozen drafts are not overwritten. Historical font mapping, computed-style checks, and screenshots are in the offline copy of `.scratch/desktop-shadcn/issues/21-polish-history.md`.
