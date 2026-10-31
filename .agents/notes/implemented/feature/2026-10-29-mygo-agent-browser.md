# Agent Note: Let the Coding Agent and owner hand over the same MyGo browser page

Status: implemented

## Problem

Coding browser tools operated Runtime's Chrome while MyGo's right panel showed an isolated iframe. The Agent could not inspect or control the page the owner saw. The owner needs local frontend acceptance in that desktop page with explicit takeover/return.

## Decision

### Native page and host isolation

MyGo `WindowOptions.Content` contains the frontend WebView. `apps/desktop/mygo/browser.Manager` separately pools a browser WebView per main session. Trusted frontend geometry is clipped to window bounds. A native input-covering `ui.Box` intercepts pointer/keyboard input while the Agent owns the page. Browser pages install no preload/TrustedOrigins; OnWillNavigate refuses out-of-policy protocols. `EmitPage(frontend.Page())` targets frontend events rather than broadcasting to web pages. Trusted calls verify exact frontend Page identity and `mygo://localhost/`; foreign WebViews cannot invoke Browser.*.

### Binding and tool eligibility

Control v47 added reverse `push:"request"` plus desktop_browser_register/event/chunk. Commands go only to the registered socket, and responses are accepted only from the connection that received the request. Submit/continue/owner_question_answer through that connection writes task_browser_bindings in the same task transaction; server derives provenance from socket and idempotent replay cannot swap it.

The desktop_browser family requires a matching binding, ordinary dev identity, full access, and no Plan/SubAgent/background source. Driver installs it mutually exclusively with old browser tools. TUI/Electron/Personal retain Chrome behavior.

Status/open/navigate/back/forward/reload/snapshot/screenshot/click/fill/select/check/uncheck/press/scroll/wait/close serialize by connectionId/session. Go eval executes fixed host scripts. Eval results, screenshots, and snapshots over 24k characters enter ArtifactStore; transfers use at most 256 KiB chunks/8 MiB total with SHA-256 assembly verification. Snapshot references bind task/page generation; navigation or gate-generation change makes them stale_ref. Unknown/disconnected outcomes are effect-unknown, not silently retried. Disconnect unregisters, marks pages gone, and releases in-flight waiters.

### Takeover and return

Owner Take Over closes the Agent gate, increments generation, and emits a targeted gate event; backend calls wait at awaitGate. While the Agent holds the page, owner address navigation/back/forward/reload are refused, but Take Over/Close stay available. Driver checks the gate at finishTurn, prepareNextTurnWithContext, prepareRequest, and handleToolCall. During owner possession it emits task.browser_wait and waits while the task remains running; cancel/disconnect/page disappearance releases the wait immediately.

Return to Agent is the only return entry. Host eval captures a DOM observation, recording unavailable on failure. `appendMarker("ruukoto_browser_observation")` persists it in session JSONL; assembly projects a browserObservation reference and tracks delivery by observationId. Until delivered, checkBeforeSend/prepareRequest rejects stale-context sends. mustRejudge forces one continuation, exactly once per return.

### Frontend integration

`renderer/native-browser-panel.tsx` renders only the .native-browser-host geometry placeholder. ResizeObserver/MutationObserver/scroll/resize report rect and state(session, shown, covered). Hidden pages continue running, with gate behavior respecting covering. browser_event projects NativeBrowserState for the code-browser tab; ordinary browser/file-preview tabs keep iframe rendering. Window.ruukoto types live in shared/bridge.ts for both root and desktop typechecks.

[MyGo shell](../architecture/2026-10-17-desktop-mygo-experiment.md) retains transport/build/Electron comparison while adding Content/native-page hosting. [Original browser](2026-10-14-agent-browser.md) retains TUI/Personal Chrome lifecycle/pause rules. [Local browser](2026-10-17-desktop-local-browser.md), [present](2026-10-25-code-present.md), and [preview access](2026-10-25-present-preview-access.md) retain capability roots, release, and owner entry rules.

## Alternatives considered

- Keep iframe and execute targeted scripts: MyGo has no child-frame execution and a hidden iframe has no independent screenshot, so it cannot meet the requirement.
- Add a narrow Darwin WKWebView adapter to the old Page window: requires separately owned layout/navigation/permissions/capture; probes showed Content already sufficient.
- Show Chrome screenshots or another window: does not control the same right-panel page and is not an automatic fallback.
- Generalize Chrome/WKWebView behind the same browser manager/name: process/pause rules differ; mutually exclusive tool assembly keeps those responsibilities explicit.

## Consequences

Each session page consumes WebView memory until explicitly closed, not when the sidebar hides. Shared WebKit login storage means one page's login/logout affects others. Takeover cannot undo external actions sent before the gate closed. Real-model and visual acceptance (A1, A3 visual, A5 end-to-end) require individual evidence rather than offline substitutes.

Historical native probes P01-P17 and production-host probes H01-H08 passed on macOS 27.0.1 arm64/mygo v0.5.5: geometry, hidden execution, fresh captures, shared cookies, synthetic React form events, Emit broadcast isolation, HTTPS-page engine refusal, cross-launch persistence, host gate/generation/identity/targeted events. desktop-browser-control.test.ts (4 cases) and desktop-browser-manager.test.ts (7) covered registration/response, disconnect unbinding, chunks, provenance/eligibility exclusion, one-time consumption, serialization, generation expiry, and observation projection. Full `npm run desktop:mygo:build` passed then. Former `.scratch/mygo-agent-browser/` spec/issue/probe/host-probe records are offline historical provenance, not fresh or complete visual/model acceptance.
