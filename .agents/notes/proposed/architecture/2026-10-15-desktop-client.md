# Agent Note: Desktop as another backend client

Status: proposed

This remains the overall desktop proposal and combined-acceptance record, not a claim that the desktop is unimplemented. Code, shared projection, approvals and substantial Personal UI are delivered; current external acceptance is tracked in [desktop acceptance #14](https://github.com/num-lab/Ruukoto/issues/14), with [settings #13](https://github.com/num-lab/Ruukoto/issues/13), [MyGo browser #17](https://github.com/num-lab/Ruukoto/issues/17) and [Personal remote #19](https://github.com/num-lab/Ruukoto/issues/19) owning their specific gaps.

[Direct Markdown images](../../implemented/simplification/2026-10-25-desktop-markdown-images.md) supersedes image placeholders/source restrictions; [sanitized HTML](../../implemented/simplification/2026-10-25-desktop-markdown-html.md) supersedes the raw-HTML ban. Script and process isolation remain. [Personal Tailscale HTTPS/WSS](../../implemented/architecture/2026-10-24-personal-tailscale-https.md) replaces both Personal SSH paths and supplies current durable chat/settings. The earlier [durable migration](2026-10-17-personal-pi-durable.md) and [Personal entry](../../implemented/simplification/2026-10-18-personal-product-entry.md) retired the old shared Personal protocol; they do not mean today's Personal desktop UI is absent. [Settings management](../feature/2026-10-21-desktop-settings-management.md) owns the broader configuration proposal and its delivered successors.

## Problem

The original products offered TUI, CLI and IM only. The owner requested a macOS window for local Coding and server-hosted Personal, visually based on the [original HTML](../../../../test/fixtures/desktop-baselines/ui-demo.html). Later [approved shadcn demo migration](../../implemented/architecture/2026-10-15-desktop-shadcn-demo.md) owns component/interaction approval while retaining that visual origin.

Three initial constraints shaped the design. The backend listened only on a local Unix socket and remote use meant logging into the server to run TUI. Client/server protocol versions had to match exactly; `PROTOCOL_VERSION` rose from 1 to 25 between 2026-09-20 and 2026-10-14. TUI projection in `state.ts`/`event-flow.ts` used Node APIs and indirectly imported pi-tui through `workflows.ts`, so it could not simply run in a browser.

## Proposal

Desktop coexists with TUI and may connect to the same Coding backend concurrently. Backend facts are read/written through the control plane. Code also has explicit local owner actions: folder selection, selected-attachment snapshots and revealing files in Finder. [Attachments](../../implemented/architecture/2026-10-16-owner-attachments.md) owns source/upload rules. Missing backend capabilities receive specific operations usable by TUI as well, rather than a second desktop data store. Current Personal instead uses its own durable remote protocol, not fabricated shared Runtime facts.

Electron supplies the original shell. Its Node main process reuses `@ruukoto/control` connection, submission recovery and protocol types from the same TypeScript sources; protocol changes require rebuilding, not maintaining a second implementation. React 19 and Tailwind v4 supply rendering. The [MyGo experiment](../../implemented/architecture/2026-10-17-desktop-mygo-experiment.md) adds a comparable native WebView shell; retain both until the owner chooses.

### Processes, credentials and rendering

Connections, tokens and backend startup belong to Node/main, as did the original SSH children. The preload bridge exposes specific subscriptions, allowlisted operations, folder picking and Finder actions, not arbitrary Node access. Electron rendering uses sandbox and contextIsolation with nodeIntegration off. Packaged `file://` pages receive CSP through build-inserted HTML meta because there are no HTTP response headers; development uses response headers and a nonce. The original local-only CSP, image suppression and raw-HTML ban have been selectively replaced by the linked image/HTML/preview decisions. Scripts remain constrained, and HTML is filtered by the existing sanitizer rather than executed as page code.

Model/tool output may contain attacker-controlled web/repository content. A renderer injection could act as the owner through exposed approval operations; IPC allowlists and CSP reduce that authority surface but do not turn renderer code into a trusted source. Later Personal pairing and OS credential-storage protections belong to the HTTPS/WSS decision, not the original SSH-token policy.

Shared snapshot/event projection lives in browser-safe `packages/view`, reused by TUI and desktop. It imports no `node:*`, uses no Node globals, and takes workspace-package runtime imports only from browser-safe modules. Build for the browser and run `no-undef` against browser globals on the bundle: this also catches transitive free `Buffer` references. Extract incrementally as desktop needs each part, repoint TUI to it and retain TUI regression coverage.

### Strict versions and Code startup

Control protocol equality remains strict, without compatibility ranges. Mismatch shows both versions and which side needs updating. The server version comes from response-frame `v`, passed through structured `ControlClientError` fields rather than parsed messages. A new client cannot use control to stop an old backend that rejects the version before authentication. Desktop gives manual recovery steps and sends no process signal. Automatically stopping an incompatible backend needs separate proof that the target process is precisely the refusing instance; [Issue #15](https://github.com/num-lab/Ruukoto/issues/15) tracks that work.

Code starts only the backend from the desktop build's recorded repository. If no backend is running, resolve Node from the login-shell environment and launch that checkout's bin. `ensureBackend.spawnExecPath` selects the executable, defaulting to `process.execPath`; `spawnArgv` contains the bin/service arguments only. Putting Node in argv would treat its binary as a script rather than select an external runtime. Classify spawn errors by system code: `ENOENT` means missing Node, `EACCES` means nonexecutable Node, and other errors retain their code, with path/recovery guidance. Probe before reporting: if another backend is ready, reuse it immediately without waiting for exit grace or killing it.

Resolve paths and tokens against the login-shell environment; `ensureBackend.env` only affects the spawned child. The backend detaches and survives desktop exit. `defaultDataDir`, `defaultAgentDir` and `controlDirFor` in `packages/control/src/connect.ts` accept an optional explicit product, defaulting to `productFromEnv()` for existing CLI/TUI callers. Explicit product lookup avoids mutating global identity. `resolveClientConfig` retains its interface: cross-product callers supply complete data/control directories. `PendingRequestStore` already takes an explicit directory.

### Original Personal SSH design, now retired

The original proposal forwarded a local socket to the remote control socket with `ssh -N -L <local socket>:<remote control.sock> <host>`, using the owner's SSH config/keys/agent without interactive passwords. Before each control connection, a separate SSH command verified the remote socket and read its original token into main-process memory. A per-connection token supplier followed rotations without local token copies. Only same-account deployment was supported: SSH login and backend owner were the same account. Permission prechecks could not identify every historical different-account layout.

The forwarding supervisor and `ControlConnection` owned separate restart/reconnect loops. Online meant authentication plus installed snapshot, not merely a live SSH process. Handshake product identity, introduced in protocol v26, prevented a Code/Personal mix-up. Forwarding left the server on a local socket with SSH identity plus owner-token authentication, the same authority as remote TUI login; it did not introduce a public server listener. Version 26 is historical, not the current protocol.

The implementation retained these non-obvious lifecycle rules:

- Save only host alias and remote control directory. Validate inputs and shell-escape them: spawn argv does not preserve remote shell argument boundaries, and Unix-socket forwarding colons have their own grammar.
- Token reads clear configured forwards, have a 15-second total connection/read deadline and a 64 KiB output cap. Forwarding retains the user's other configured forwards, so their bind failure must be separately terminal rather than retried forever.
- Other forwarding exits, including 0, 255 and signals, trigger backoff restart; each connection's precheck classifies authentication/configuration errors. Keep a bounded stderr tail and fixed C locale.
- Both SSH commands disable connection multiplexing, post-authentication backgrounding and RemoteCommand. The owned child must be the actual listener. On close/configuration change, wait for that child to exit before reusing the socket; `StreamLocalBindUnlink` alone cannot prove old-listener exit.
- Shared `ControlConnection` checks generation at every asynchronous phase and validates handshake before installing a snapshot. Checking only after `sync` returns cannot prevent late snapshot installation. `expectedProduct` is optional for other callers, which retain their fixed tokens/behavior.

Early Personal bridging exposed only configure/reconnect/subscribe until UI requirements were confirmed; it did not preemptively clone Code's submission guard. This was an implementation checkpoint, not today's feature limit. Both SSH paths are now deleted under the HTTPS/WSS decision, whose pairing, credentials, generation and durable recovery rules replace these transport details.

### Packaging and scope

`apps/desktop` participates in workspaces. The initial plan put all dependencies in `devDependencies`, bundled runtime imports, and added a package-specific ESLint allowance for runtime references to dev dependencies, so server `npm ci --omit=dev` needed no Electron/UI stack. Current packaging declares `ws` as a production dependency while Electron, UI/build tools and workspace source imports remain development dependencies; do not claim all dependencies are still dev-only. The current package/lock files own that boundary.

Build with electron-vite, produce an electron-builder directory artifact and ad-hoc sign it. Initial native acceptance is macOS for the owner's use. CI sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and runs checks that do not launch Electron. The original four-job statement is superseded by the current Node 24.15.0 two-OS matrix; no job-count promise belongs to this architecture.

The owner originally confirmed 22 questions across four rounds plus the overall proposal. Original requirements and implementation steps remain offline at `.scratch/desktop-gui/spec.md` and its `issues/` directory, not a live tracker. Shared projection/package extraction is delivered under [workspace packaging](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md). Current Issues and successor decisions own effective requirements and remaining acceptance.

## Delivered behavior and recovery rules

The [approved shadcn migration](../../implemented/architecture/2026-10-15-desktop-shadcn-demo.md) owns appearance and interaction. Old expanded-parameter, extra diagnostic-card and fixed-right-sidebar requirements do not constrain the current UI. Code implements the main-process connection/token ownership, view-backed workspace/conversation trees, tabs and body/reasoning/tool streams, a single-file CommonJS preload and distinct dev/packaged CSP. Product identity arrived in v26; later attachments and features own subsequent versions. Allowlisted operations follow actual UI needs, while local recovery actions are not forwarded as backend operations. Current Personal chat/settings use durable remote facts, not these shared Code projection records.

### Conversation and tool projection

Conversation-recovery orchestration stays in the renderer while projection is shared with TUI. Every snapshot increments request generation, including same-connection resynchronization, invalidating old history/task/body reads. Read task events from zero instead of mistaking detail `seq` for an event cursor. Continue body reads using `TextEncoder` UTF-8 byte counts. Snapshot/history alone omit reasoning, tool identity and long bodies; copying TUI's `Buffer` usage would break browser execution.

The Code side panel reuses conversation recovery and the Conversation component for SubAgent history. Selected child conversations participate in new-snapshot reload and live body completion. Work reads use `work_list`/`work_get`; all SubAgents come from shared snapshots/events, not only the assignment's first child. Terminal task state does not imply idle work: fetch `idle`/`unverified` from the backend. Request generation and query sequence prevent old reads overwriting newer event-driven refreshes. Navigating a child notification also locates the parent and child panel.

Diffs are per tool call. `entryId` controls result readability, not whether execution succeeded or became unknown. Render patch/writeContent only for a done call whose `read_tool_result` explicitly returns `isError: false`. Missing fields are unavailable; an empty string is a valid empty file. Historical writeContent is reconstructed from call parameters and may exist after failure, so it is not success evidence; bounded parameter previews are no substitute. Result previews/pages are bounded to 64 KiB with remainder read under [result pagination](../../implemented/feature/2026-10-16-tool-result-pagination.md). The small diff view uses unified-patch line kinds without adding Accept/Reject, syntax highlighting or file reads.

The original image placeholder had a concrete security reason: a real Electron probe with a temporary owned PNG showed that absolute/relative image paths in `file://` pages could load local files even when react-markdown rejected explicit file schemes. Disabling raw HTML or relying on `default-src self` did not prevent that. The owner later accepted native image loading, including network requests/local-path semantics, and sanitized HTML. Preserve this rationale as the superseded choice, not as a current image prohibition or a claim that present CSP allows local resources only.

### Create, submit and recover without losing input

Workspace/conversation creation shares one pending record holding original key, parameters, target and instance ID. Reconcile an uncertain operation only under its original key; a later independent operation gets a new key. Verify online lost responses immediately; after disconnection/unsent requests, wait for a new snapshot. If absent, resend at most once. Unknown outcomes remain visible with guidance to inspect the tree. Snapshot generations invalidate reads, not unconfirmed owner creations. Absence in a different instance proves nothing about the original: neither resend nor adopt old responses until reconnecting to the original instance. A small renderer creation state machine preserves workspace-helper semantics without importing `node:fs`, inventing a protocol or building a generic request framework.

Submission/continuation use `SubmissionGuard` records in application data, separated by target and control-directory digest. Persist full original parameters/key/data instance; repeated clicks reuse pending state. Each installed `onSnapshot` triggers serialized reconciliation, as does an online lost response. A running reconciliation coalesces one following pass, rather than waiting for a second `online` event absent in same-connection sync. Guarded requests use controller redaction and recheck original connection/instance across awaits, preventing old input reaching a new database.

When missing models prove nonacceptance, keep the record for explicit owner recovery. Main delivers it read-only, renderer merges original input/continuation by request key, then acknowledgment strictly removes it. Failed cleanup retains send-disable state; duplicate acknowledgment is idempotent. The only durable input copy remains until the destination draft receives it: delete-before-IPC-delivery can lose it. `PendingRequestStore` adds strict read/remove with only ENOENT meaning absence; tolerant `list()` returning empty cannot prove deletion. Existing clear/list callers retain their behavior. Ordinary drafts remain in memory keyed by instance/conversation; a late known-unsent response restores only the original instance's draft, not the new instance currently on screen.

Models and conversation defaults use conditional version updates. Lost responses/conflicts read the actual setting rather than replay writes. Update only versioned response fields; queue resume/query uses snapshot/queue-event generation to reject rollback. An online lost interrupt/cancel response reads original task detail; disconnect waits for a same-instance snapshot. Resuming an old queue first confirms missing-model count and specific model, then passes explicit `model_selection`; changing the conversation model does not backfill old tasks. Browser-safe mode labels avoid runtime imports from Node-dependent core/types.

### Development and manual backend recovery

During development, navigation interception permits reloading the complete configured renderer-document URL: electron-vite preload watch reloads the page to install the new bridge. Blocking that would send it to a system browser without preload. Other same-origin paths still open externally; HMR does not authorize arbitrary navigation.

Package/launch facts belong to [workspace packaging](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md) and [development launchers](../../implemented/process/2026-10-09-dev-launchers.md). macOS recovery guidance builds `lsof` against the real control socket, shell-single-quoting its path. If no listener is returned, first verify the command succeeded; multiple matches or unverifiable identity stop manual steps. Desktop never signals the backend. After version rejection, only explicit reconnect tries again; ordinary mode reruns `ensureBackend`, managed mode connects only.

## Approval and notification recovery

For shared Code control facts, main and renderer each hold view state and use the same pending-approval selector: approval pending, task nonterminal and matching permission version. Ending a task or changing permissions may only stale the old record without a resolution event, so event-count decrement is not an authoritative badge. Terminal-state constants live in a Node-free core module to preserve browser projection. Current Personal derives its own approval/notification facts from durable; the old two-shared-view composition is historical.

`task.mode_switch_failed` currently comes only from the interrupted branch of Store.endTask, without a separate ordinary-interruption event. View directly interrupts a still-nonterminal task, sets end time, clears pending mode and preserves the failure reason; a late event never rewrites an existing terminal state. If the backend begins emitting this event for nonterminal failures, fetch `get_task` instead. Unverified stop never means safe stopping.

Approval responses bind target, instance, approval ID and displayed permission version and are never resent automatically. An online lost response queries original task approval state; disconnect waits for a same-instance snapshot. Failed/stale verification retains unknown outcome with refresh. A permission-version change invalidates old parameter details; load fresh details before another decision. Snapshot generation invalidates old detail/response/verification work so it cannot resurrect a card or cross instances.

Notification baselines retain seen approvals, terminal states and observed tasks per target/instance. Initial snapshots and replay up to their cutoff sequence are silent; buffered newer live events may notify before `online`. Foreground observations are marked seen and not replayed after backgrounding; cancellations only record terminal state. Derive badges from current pending sets, not increment counters. On a same-instance snapshot, fetch an observed task omitted from the snapshot with `get_task`, retrying failed reads on a later snapshot. The original Personal shared connection allowed that read during sync; it is not a current durable op claim.

Baselines are application-memory only and do not scan all history. A task created and completed offline, absent from replay and outside snapshot coverage, receives no catch-up notification. This bounded recovery covers observed work without another notification service. Notification clicks publish an instance-bound navigation intent through the target subscription; consume it only after successful location and retain distinct child/task selection for the panel. Old-instance notifications report that the original target changed rather than navigating another instance.

## Relationship to earlier decisions

The original audit searched active notes for remote/SSH/GUI/client/projection/workspace/version concerns, finding no same-topic proposal to replace and leaving archives untouched. Its partial overlaps remain:

| Decision | Relationship |
| --- | --- |
| [Detached backend](../../implemented/architecture/2026-09-19-detach-terminal-from-task-runtime.md) | Preserve backend ownership, local authenticated socket, sequence recovery, disconnect independence and probe/reuse. Original SSH forwarding still appeared as a local socket connection to the server. |
| [Two products](../../implemented/architecture/2026-10-02-two-agent-products.md) | Keep separate profiles/socket/locks; explicit product path resolution does not grant cross-product authority. |
| [Workspace packaging](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md) | Extend with view/desktop and `tui -> view`; maintain that package map at its owner. |
| [Development launchers](../../implemented/process/2026-10-09-dev-launchers.md) | Managed frontend only connects, without login-shell discovery or backend spawning; ordinary .app performs on-demand startup. |
| [Agent browser](../../implemented/feature/2026-10-14-agent-browser.md) | Its original SSH-forwarded local dashboard was a transport precedent. The original desktop browser deferral was later replaced by separate local-preview/MyGo-browser work, not by this connection proposal. |

## Alternatives considered

- **Tauri.** System WKWebView yields a smaller package, but Rust main needs a Node sidecar to reuse control or a second Rust client updated with each frequent protocol change.
- **Native SwiftUI.** It offers the most native presentation, but requires rewriting protocol/client/projection in Swift and cannot reuse the demo.
- **TCP/WebSocket with TLS/token, possibly restricted to Tailscale.** It removes local OpenSSH and simplifies reconnection, but originally introduced a new remote protocol/attack surface contrary to the then-current remote-use decision. SSH required no server change and reused SSH identity. The later Personal HTTPS/WSS decision explicitly reopens this tradeoff; Code does not gain a remote listener from it.
- **Cache the remote owner token in Keychain.** It saves one SSH round trip but adds a static local secret/caching code and manual rotation. Reading the original each time was simpler for the old design. Current paired Personal app credentials are a different, explicitly designed secret, not a cache of `control.token`.
- **Bundle the backend in .app with ELECTRON_RUN_AS_NODE.** A self-contained app avoids checkout/login-shell dependencies, but Electron's Node might not meet the then-required `>=22.19`/`node:sqlite`, and native sandbox outputs also need packaging. Current Node requirements have advanced and production credential protections explicitly disable RunAsNode.
- **Write desktop-only projection.** It avoids refactoring TUI first, but duplicates deduplication/replay/body assembly and invites divergence as protocol changes.
- **Project only in main and push view state to renderer.** It thins rendering but adds another state synchronization protocol without enough benefit.
- **Negotiate capabilities or protocol ranges.** It tolerates skew, but contradicts direct wire-format replacement and adds compatibility cost. A single owner can coordinate backend deployment and desktop rebuild.
- **Read arbitrary local files/Git directly for Code.** It would accelerate @File/diff features, but creates a separate path unavailable to remote Personal and bypasses backend/operation records. Explicit owner file selections and subsequent scoped local capabilities have their own decisions.
- **Keep desktop outside workspaces with its own lock.** Like foundation, it would isolate CI setup, but path aliases would bypass shared-package dependency enforcement.
- **Disconnect the inactive target or use two windows.** It simplifies UI state, but makes pending Personal approvals invisible while Code is selected.
- **Delete pending input before returning it over IPC.** It reduces main state but loses the only durable copy if delivery fails. Read-only delivery, draft merge and strict cleanup preserve it without persisting all ordinary drafts.
- **Use tolerant list() emptiness as deletion proof.** It reuses an API, but directory-read failure also returns empty and cannot justify reenabling send. Add strict read/remove without changing other callers.

## Acceptance criteria

Current requirements in the linked Issues and delivered decisions need criterion-specific evidence. Shared projection must pass existing TUI regressions and browser/no-Node checks; main must reject operations outside its allowlist; owner control tokens never enter renderer IPC or local token caches. Code mismatch displays both versions and does not retry; the .app starts an absent backend, coexists with TUI and leaves execution running after exit. CI checks must not download Electron. Real GUI behavior requires native/manual acceptance, with missing environments recorded as unverified.

Original SSH-process restart and remote-token-rotation checks remain historical evidence for the deleted transport, not acceptance of current Personal. Current acceptance instead covers its HTTPS/WSS pairing, secure credential storage, durable chat/settings, connection/recovery and native behavior under the successor decision. Local protected app-credential ciphertext is intentional there; it does not violate the original prohibition on copying a remote owner control token. No translation or passing unit suite closes external acceptance gaps.

## Risks

- Ordinary .app startup depends on its recorded checkout and login-shell Node. Moving the checkout or changing Node can break startup; show actionable errors and require repair/rebuild.
- Electron main runs its bundled Node, so control and transitive dependencies must support that version. Recheck when upgrading Electron; the external backend Node is a separate runtime.
- Strict protocol matching requires coordinated desktop/backend versions. The original Personal shared-protocol risk is replaced by its own remote version/binding rules, not a generic compatibility layer.
- The old SSH path required local OpenSSH and noninteractive authentication; password/2FA-only hosts were unsupported. This remains a reason for the successor transport, not a current SSH dependency.
- Shared projection extraction changes core TUI state logic; confidence depends on regression coverage, not browser compilation alone.
- Third-party Markdown/UI code renders untrusted content. Process isolation, allowlisted bridge and CSP remain essential; sanitized HTML and native images have their separately approved filtering, local-file and network-exposure tradeoffs. The former blanket raw-HTML prohibition is not a present security guarantee.

[Startup optimization](../../implemented/bug-fix/2026-10-17-desktop-connection-startup.md) owns environment-preparation timing and lightweight readiness; other independent decisions here remain.
