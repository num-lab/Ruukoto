# Agent Note: Desktop browser access to local documents

Status: implemented

MyGo uses a native page under the later [inspector browser decision](2026-10-29-mygo-agent-browser.md); capability roots and the owner entry remain. [Local-preview responsibility](../simplification/2026-10-25-browser-path-names.md) supersedes path-name blacklists, not the other guarantees below.

## Problem

The owner requested opening local `file://` documents. Allowing the URL alone cannot make an HTTP/mygo iframe read local files. Enabling native file access or relaxing webSecurity would also broaden remote-page permissions.

## Decision

Shared DesktopHost handles `desktop_browser_open`/release before backend connectivity and PA allowlisting, so local preview works offline. Reuse generic requests and top-level IPC identity; add no Go/preload RPC, control protocol or backend arbitrary-path read. Each document gets a temporary HTTP origin bound only to 127.0.0.1 and a 256-bit random path token. The iframe uses that address while the bar/history retains the original file URL. Concurrent documents have distinct origins; reused ports after closure still require the new token.

The capability root is the selected document's real parent. Relative styles/images/scripts/data in that directory/descendants can load. There is no directory listing; reject escapes, links and application userData. Name-based metadata restrictions were subsequently removed by the linked responsibility decision. Regular reads verify directory chains, open handles and pre/post identity. Entry HTML is the opening snapshot; resources load on request, and address-bar refresh recaptures it. Limits are 8 MiB/file, 32 MiB and 256 requests/capability, eight capabilities and sixteen concurrent resource reads. Exhaustion fails explicitly and can be refreshed. Ordinary local HTML retains CDN/network access.

The iframe retains `allow-scripts allow-forms`, never `allow-same-origin`. Module/fetch requests use `ACAO:null` only on valid-token routes, no credentialed CORS; ordinary remote Origins fail. A null origin does not authenticate a particular frame. The token authorizes the directory: opened local scripts and externally loaded scripts can use/transfer it. This is not exfiltration-resistant execution of hostile local JavaScript. Responses have no referrer/cache, use nosniff and the same sandbox CSP. Do not log tokens or relax device/download/popup/Node/IPC isolation.

Controlled navigation, refresh, back/forward, tab close and unmount revoke old capabilities; late opens are released immediately. Host.close waits for creation/reads and cleans listeners. Opaque-frame internal navigation cannot be observed reliably, so immediate revocation/history tracking for every internal navigation is not promised. Disconnected release cannot be confirmed; host exit provides final cleanup. Plain Web Demo only models URLs/display and explains that file display needs the desktop host, never arbitrary local reads.

This supplements [inspector preview](2026-10-16-demo-inspector-tools.md), [Desktop migration](../architecture/2026-10-16-desktop-current-demo.md), [MyGo host](../architecture/2026-10-17-desktop-mygo-experiment.md) and [desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md) while retaining their read/IPC/isolation rules. Historical browser-activity handoff remains offline.

## Alternatives considered

Adding file to the parser/CSP is smallest but still may fail iframe loading in either engine and lacks a resource root. Native WebViews can read directories, but at this stage MyGo React could not embed Content WebViews without geometry/overlay management. Separate custom protocols avoid ports but add adapters, shared-origin and CORS differences. Shared Node loopback service keeps one capability implementation across hosts.

## Consequences

Local HTML can render relative resources without host write/execute APIs. Out-of-root resources and application data do not load; unsupported formats or exhausted budgets fail visibly. HTTP read tests do not prove WKWebView/Chromium display: module/fetch browser checks and native-host acceptance remain separate evidence.
