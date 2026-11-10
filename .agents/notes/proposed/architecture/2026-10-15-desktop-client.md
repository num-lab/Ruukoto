# Agent Note: Desktop as another backend client

Status: proposed

This remains the combined desktop acceptance proposal, not a claim that Desktop is unimplemented. [Single product](../../implemented/architecture/2026-11-10-single-product.md) retires the Personal target, remote transport and pairing scope without claiming those old acceptance items passed. Retained work is tracked in [desktop #14](https://github.com/num-lab/Ruukoto/issues/14), [settings #13](https://github.com/num-lab/Ruukoto/issues/13) and [MyGo browser #17](https://github.com/num-lab/Ruukoto/issues/17).

## Problem

The owner wants a native window alongside the TUI without duplicating runtime, protocol or conversation-history logic. Frequent protocol changes and browser-unsafe TUI internals originally made a separate client expensive. A native renderer also introduces a privileged IPC boundary for untrusted model/repository content.

## Proposal

Retain Electron and MyGo as clients of the same local backend. Node DesktopHost owns connections, tokens, process startup and original-key request recovery; React rendering receives allowlisted operations and projected facts, not arbitrary filesystem/process access. Browser-safe view/history components are shared with TUI; every asynchronous result checks its original generation before installing state.

### Profile and startup ownership

Select the canonical raw data/agent/control/pending tuple, then bootstrap through core before stateful operation. In-process callers receive activated `ProfilePaths`; spawned children receive the complete raw tuple, never qualified paths passed back as ordinary flags. Profile discovery, tokens, socket, pending journals and draft keys use resolver fields. Layout/instance/protocol mismatches are terminal, including before any offline write.

Ordinary desktop starts only the backend at its recorded checkout using the selected Node executable. Authenticated readiness checks the expected instance; a connectable socket alone is not readiness or permission to spawn another backend. The detached backend survives desktop exit. Managed development only connects to its launcher-owned backend and never starts another after reload failure. Invalid checkout/Node paths require actionable repair/rebuild guidance.

### Host and renderer security

Electron uses sandbox/contextIsolation with nodeIntegration off, constrained navigation and a single allowlisted preload. Production CSP and signature/resource checks remain required; development nonces and document overrides are restricted to managed development. Native pickers and file mediation expose scoped owner actions, never arbitrary renderer paths. MyGo accepts calls only from the exact top-level application document and retains private request/response/browser_event transport to Node for its native browser; removing PA credentials does not remove that transport or weaken startup checks.

Renderer content is not trusted authority. Sanitized HTML and direct Markdown images follow their explicit successor decisions, including local-file/network exposure; neither is a reason to enable page-script execution. Third-party rendering remains behind CSP and the host bridge.

### History, creation and lost responses

Snapshots reset request generations synchronously, including same-connection resynchronization. Task events begin at zero, long bodies advance by UTF-8 bytes, and bounded history recovery rejects gaps. Main and SubAgent conversations use the same projection, but clients retain their own display ordering and scroll/trace behavior. Tool diffs require the original completed result with `isError: false`; write parameters or partial output alone are not success evidence.

Creation and submission retain original request key, parameters and activated instance in private native journals. A response from another instance proves nothing about the original. Query original outcomes; resend only under existing same-key/known-nonacceptance rules, never automatically with a new key. When returning a recoverable draft, retain its durable copy until the renderer acknowledges receipt; tolerant empty listing is not deletion proof. Strict read/remove failures keep recovery unresolved.

Approvals bind the original request, task, permission version and fully read immutable parameters. Lost decision responses inspect original state; stale or failed verification cannot revive a card or approve a new operation. Model/default settings use conditional versions and reread after lost responses instead of replaying writes. Client exit leaves tasks and owner questions running; backend restart follows runtime interruption rules.

Notification baselines track observed work per instance and derive badges from current pending sets rather than counters. Initial snapshots and historical replay stay silent; observations made while foreground do not notify again after backgrounding. Bounded catch-up may omit unseen tasks outside snapshot/replay coverage. Notification navigation remains bound to its original instance.

### Packaging and shared ownership

Application/workspace manifests own dependencies; do not duplicate the control implementation or add a second lockfile for Desktop. Explicit Electron/MyGo builds retain their signature and native-asset requirements. [Workspace packages](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md), [history recovery](../../implemented/architecture/2026-10-23-shared-history-recovery.md), [MyGo](../../implemented/architecture/2026-10-17-desktop-mygo-experiment.md) and [development launcher](../../implemented/process/2026-10-09-dev-launchers.md) own detailed contracts. [Desktop module](../../../../docs/modules/desktop.md) owns current operation.

## Alternatives considered

- Tauri or native SwiftUI: native rendering can reduce package size, but requires a Node sidecar or another control/projection implementation. MyGo evaluates a native shell while preserving the shared host.
- Bundle the backend through Electron RunAsNode: convenient installation, but changes the Node/native-asset boundary and conflicts with current production startup protections.
- Separate Desktop projection: avoids initial TUI extraction, but duplicates replay, deduplication and body assembly. Share browser-safe facts, not one fixed rendering pipeline.
- Protocol ranges: tolerate version skew, but add compatibility obligations to a coordinated single-owner deployment. Keep strict versions and explicit recovery.
- Treat tolerant-list emptiness as verified acceptance: reduces state, but can hide read failure or lose the only durable input. Keep malformed files visible and original request records until their receipts establish acceptance; fresh journals no longer support missing-model transfer into new drafts.
- Retain remote PA transport or a hidden target: preserves retired access, but conflicts with the owner’s single-product decision; historical rationale remains in sealed PA records and the source archive.

## Acceptance criteria

Retain TUI regressions, browser/no-Node checks, host operation allowlists, original-key recovery and strict identity failures. Exercise actual TUI/Electron/MyGo against isolated activated profiles, including conversation creation, queue/questions/reconnect, settings, scheduling, terminal and browser. Prove development process ownership and native application/browser-state separation; use a disposable macOS account if separate native state cannot be established safely.

Signature, injection and production-development-override negatives remain separate from managed smoke checks. SSR and mock bridges do not establish native focus, IME, themes, navigation or resource stopping. Missing required model/Linux/native prerequisites remain acceptance gaps, not passes. Retiring Personal does not close its old acceptance as successful.

## Risks

Recorded checkout and Node paths require rebuilding after changes. Electron’s bundled Node and the external backend Node have separate dependency requirements. Strict profile/protocol identity makes stale clients fail deliberately. Third-party renderer content can exploit any overbroad bridge; host mediation, CSP, signatures and original-operation checks remain necessary together. Shared projection changes still need TUI regression evidence.
