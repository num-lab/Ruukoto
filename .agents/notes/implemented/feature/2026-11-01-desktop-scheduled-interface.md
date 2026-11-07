# Agent Note: Desktop Scheduled Interface

Status: implemented

[Visual alignment](2026-11-07-desktop-visual-alignment.md) supersedes the four-step form with a single form and shared composer selectors. The schedule lifecycle, validation and recovery contracts remain.

## Problem

The original Desktop Scheduled page mixed title, rule, workspace, Instructions, actions and run records in one long view, and its list exposed a manual refresh. New and existing plans used one dense form, while the model and Effort choice stayed merged even though a saved plan pins them independently.

## Decision

Scheduled has three presentation states. The list contains borderless cards with title, clamped Instructions summary, repeat rule and a monochrome progress bar from the previous scheduled occurrence or creation time to `nextDueAt`. The page has no manual refresh; progress is recalculated on render and every minute, while schedule events continue to reload through the existing state flow.

Details separate overview and run records. Overview gives next trigger and progress first, then groups Instructions and execution settings; run records stay behind their own tab. Pause, resume, edit, cancel and unknown-effect recovery retain the existing `DesktopScheduled` operations and confirmation dialogs.

Creating or editing a plan is a four-step flow: task, time, execution and confirmation. Required workspace, permission, model and Effort fields appear only in the execution step; model and Effort are separate selectors with existing available-level fallback. The draft step lives in desktop state so reopening create/edit returns to step one. Header, steps, fields and actions share one centered 720px column on wide screens, with the back control outside that column. CSS uses foreground monochrome as the highlight, cards/buttons use background or shadow rather than borders, Active/Archived use the shared `Tabs` primitive so the selected state and keyboard semantics match other Desktop tabs; cancel uses the destructive color. Accepted saves return to details without a success notice. Backend scheduling, persistence, version conflicts, pending requests and run recovery are unchanged; see [Code scheduled](2026-10-25-code-scheduled.md).

## Alternatives considered

Keeping one long form would reuse every existing control, but the owner selected progressive presentation and less explanatory text. Fetching progress from a backend field or clock stream would duplicate facts already derivable from the immutable rule, creation time and authoritative `nextDueAt`. Bundling the channels scheduler helper into the renderer would supply the same arithmetic but would pull an unrelated package into the client bundle, so the small display-only calculation stays beside the desktop formatter and is covered by DST/weekly regressions.

## Consequences

Cards do not show workspace or latest-run status, so those details require opening the plan; this keeps scanning focused on the requested fields. Progress for a paused, canceled, completed or unavailable next trigger is absent instead of creating a misleading interval. One-time plans measure from plan creation because there is no prior occurrence. A manual reload no longer exists, but the existing snapshot/event updates and one-minute progress repaint keep the current page live.

The run/session navigation and all write receipts remain unchanged. Targeted tests cover progress boundaries, card rendering without refresh, detail layering and separate model/Effort controls; native Electron/MyGo visual acceptance remains separate.
