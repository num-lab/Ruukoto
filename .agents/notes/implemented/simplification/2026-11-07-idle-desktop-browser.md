# Agent Note: Idle desktop browser pages allow direct owner input

Status: implemented

## Problem

Opening MyGo's browser left its native input cover active after the Agent task finished. Idle browsing required a takeover even though no Agent was using the page, and the toolbar treated idle and explicitly taken-over pages as the same state.

## Decision

An actual browser command claims the current conversation's page for its task. Status reads and ordinary tasks do not claim pages. The claim spans browser calls and intervening model reasoning so snapshot references remain protected until the task completes, fails or stops. Task cleanup releases only its original connection, session and task claim after pending commands settle. Lost responses retain that cleanup obligation; the host rejects commands for released tasks and canceled main-thread callbacks. Control disconnection releases native input covers.

Idle pages accept owner navigation and page input directly. Only a live Agent claim enables the icon-only takeover control. Explicit takeover pauses the Agent; the same toolbar position offers an icon to return the page, preserving the recorded fresh observation before continuation. Ending a task during takeover returns the page to idle without requiring Return. This replaces the persistent-until-takeover input lock in [MyGo's browser decision](../feature/2026-10-29-mygo-agent-browser.md).

Host gate events distinguish idle release from explicit owner takeover and travel in order so a quick takeover/return retains its observation requirement. Every page event and status snapshot carries current ownership and the latest explicit return generation, consumed once even when a status response arrives before its events. Generations remain monotonic across page recreation, so late events cannot overwrite newer ownership. Responses merge ownership only if no newer event arrived during the request. Native enforcement and frontend controls use the same facts. The pipe reader captures transport identity before asynchronous dispatch, and disconnect invalidates work that has not reached the native page.

## Alternatives considered

Enabling controls from a general running-task flag is smaller but locks the browser for tasks that never use it and leaves the native cover out of sync. Releasing after every individual browser command allows input during the Agent's snapshot-to-action reasoning and invalidates its assumptions. A task claim beginning at actual browser use preserves that sequence while releasing idle pages automatically.

## Consequences

Pages and login state survive task completion. Takeover cannot undo web actions already sent. Cleanup failures retain the native gate and report a diagnostic; the owner's takeover control remains available. The host retains released task IDs for its lifetime to reject delayed commands, without adding persisted or model-selected control state.
