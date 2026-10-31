# Agent Note: Page presentation is independent of browser automation

Status: implemented

MyGo URL presentation now uses its native right-hand page, as described in the [browser decision](2026-10-29-mygo-agent-browser.md). Four-mode availability and zero approval requests remain this note's decisions.

## Problem

`present` reused browser-automation eligibility for page presentation, preventing ordinary and Plan modes from opening sidebar previews. The owner explicitly requested removal of this restriction. Presentation registers a Desktop display target; it does not give the Agent tools to read DOM, click, or fill forms.

## Decision

Remove `presentUrlAllowed` and the URL branch's approval request. `confirm`, `auto-review`, `full_access`, and Plan can register a page preview directly. The URL branch explicitly verifies that the current task exists, belongs to the same session, is running, is not canceled, and has an unaborted signal. Existing tool-availability checks, credential-free HTTP(S) validation, successful tool results, and isolated iframe handling remain. No configuration or new approval mechanism is added. File preview retains its read boundary; browser automation retains its own rules.

This partially supersedes the URL permission requirement in the [original preview decision](2026-10-25-code-present.md), not its file capture, source session, historical reopening, or format limits. [Browser automation](2026-10-14-agent-browser.md) and [local document browsing](2026-10-17-desktop-local-browser.md) keep their separate entry points.

## Alternatives considered

Reusing browser eligibility keeps one threshold but incorrectly couples display with automation and contradicts the owner's request. Per-URL approval permits individual confirmation but still adds permission steps to ordinary previews. Existing recorded tool calls provide the required trace instead.

## Verification

Real Runtime tests cover success in all four modes, no approvals, and durable preview results; the old implementation must fail in confirm mode. Dangerous-address and file-scope regressions remain passing, and the actual model-visible definition no longer requires full access. Desktop's existing success-event wiring is unchanged.

## Consequences

Desktop still loads pages, which may run isolated scripts and issue network requests. Removing the mode restriction does not promise network inactivity or successful loading. Site embedding restrictions and file-format limits remain. Local fixtures do not establish real-model or native-window experience.
