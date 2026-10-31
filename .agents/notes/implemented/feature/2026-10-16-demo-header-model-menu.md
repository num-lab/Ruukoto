# Agent Note: Demo top tabs and model menu

Status: implemented

## Problem

The owner requested moving inspector tabs upward, reducing gaps between Thought/SubAgent/tool summaries, moving Effort into the model menu, and a Brain icon when width is limited. Inspector tabs occupied a whole row above content, while a separate Effort control squeezed the composer.

## Decision

This decision initially changes Demo only. The global header has conversation and inspector regions. Inspector tabs, close, and add share width variables/transitions with the inspector below; its toggle stays available. Collapsed tabs are aria-hidden/inert. Shortcut collapse returns focus from that region to the toggle. Per-session tabs, file/SubAgent navigation, a blank new-tab page after closing the last tab, and resizing remain.

[Later tab reordering](2026-10-17-demo-tab-reorder.md) owns equal widths and within-group order. Neither tab group reserves width for close buttons. Hover overlays an absolutely positioned close icon and fades only adjacent title text; keyboard focus on close does the same. The unclosable last session never fades. Selected tabs hide short dividers on both sides. When the inspector is expanded, a centered 28px vertical divider separates top regions; collapse hides it without changing widths or close/switch behavior.

Model and Effort use two named radio groups in the existing official DropdownMenu, without primitives/dependencies. Choices remain per-session; models lacking authentication are disabled. Verification disables the whole entry. The menu opens upward without translation animation. At composer content width <=480px, show only Brain while an accessible description retains model/Effort; the menu remains identical. Context, mode, and send keep their behavior.

Composer bottom controls always share one row. Ask for approval, Auto review, Full access, and Plan use question, shield, lightning, and list icons. At <=320px, mode shows only its icon and no chevron, while preserving accessible value/description. Still narrower layouts reduce spacing instead of wrapping. Only the attachment button gets a light round background and slightly bolder plus; file selection/disabled behavior remains. The three annotated Trace rows use 16px gaps; body and approval spacing stay unchanged.

This supersedes separate Effort Select and extreme-width wrapping in [message components](2026-10-16-demo-ai-elements.md), retaining mock data, session inheritance, and submission. [Context component](2026-10-16-demo-context-component.md) stays unchanged. [Inspector expansion](2026-10-16-demo-inspector-tools.md) reuses shared width/collapse and adds active-tab visibility.

## Alternatives considered

A Select inside the model menu reuses controls but adds nested popup focus/keyboard paths; two radio groups suffice. Window-width breakpoints ignore how sidebars change actual composer space, so use the existing container query. Shrinking every transcript gap also changes body/approvals; target Trace neighbors/activity internals only.

## Consequences

Header and inspector must clamp, resize, and collapse together rather than own independent widths. Narrow model entries depend on an icon, with choice details retained in menu/accessibility text. Historical acceptance is in the offline copy of `.scratch/desktop-shadcn/issues/03-ai-elements-demo.md`. This original in-memory iteration changed neither production Desktop/backend nor dependencies, original designs, or frozen drafts.
