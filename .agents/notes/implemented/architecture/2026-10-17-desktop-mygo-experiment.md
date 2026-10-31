# Agent Note: Evaluate MyGo as a Desktop shell

Status: implemented

[MyGo browser](../feature/2026-10-29-mygo-agent-browser.md) owns native inspector pages, Coding automation, and explicit takeover. [Tailscale HTTPS/WebSocket](2026-10-24-personal-tailscale-https.md) owns Personal connections and both shells' secret storage; shared Host/private-pipe ownership remains and credential frames never become UI events.

## Problem

The owner wanted to experience a lighter shell than Electron before deciding to keep it. React UI and the Node control client were separable. Rewriting control in Go expands the experiment; static Demo rendering cannot test real workflows.

## Decision

Retain Electron as a runnable comparison and add a MyGo v0.5.5 macOS Apple Silicon app with explicit launch/build commands. Go hosts the same renderer in WKWebView and owns native window/system actions. Shared DesktopHost retains connection, submission recovery, original Personal SSH, and notification rules. A Node sidecar runs existing TypeScript control code. Private stdin/stdout JSONL carries raw JSON bytes, with stdout protocol-only, diagnostics on stderr, <=16MiB frames, and request IDs increasing only within that sidecar process.

Undelivered requests are not_sent. Delivered requests that time out or lose their process without reply are unknown/disconnected and never automatically replayed. Sidecar failure settles every pending call and reports failed. Reopening lets original pending records verify submissions. Stdin EOF first releases connections/SSH; host waits boundedly then escalates termination. The normal Code backend remains independent.

Go methods accept only the exact current top-level mygo://localhost/ document; native IPC also rejects subframes. Do not broaden trusted origins. Retain strict production CSP and iframe sandbox; reject window.open, downloads, and page permissions. Main-document external links use a narrow system-browser method. Picker attachment paths travel only between Go/Node; renderer gains no path-upload method.

Build records the absolute current Node path rather than relying on Finder PATH. Existing Node logic loads login environment once. MyGo has separate userData to avoid pending-record contention with Electron while observing the same backend. Invalidated Node/repository paths require rebuilding. No updater, installer, Bun, or second HMR system is added.

This supplements [Desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md) with an independent shell/comparison. The owner approved retaining/committing MyGo on 2026-10-17. [Current GUI](2026-10-16-desktop-current-demo.md) and [Trace migration](2026-10-16-desktop-trace-migration.md) retain presentation/backend semantics; native adaptation has separate verification. [Workspace packages](2026-10-11-in-repo-workspace-packages.md) retains Electron production constraints, while the Go module is outside production npm installation.

## Alternatives considered

A Go control rewrite could remove Node but duplicates protocol, SSH supervision, and submission recovery, preventing attribution of differences to the shell. Replacing Electron outright loses the comparison and rollback required for evaluation. A static MyGo demo shows WKWebView appearance quickly but cannot verify connections, attachments, approval, or exit.

## Verification

Historical evidence is in `.scratch/desktop-mygo/issues/01-mygo-experiment.md` offline. Logic/Go transport tests cover classification, EOF, and cleanup. A real isolated-backend .app installed snapshots, displayed sessions, and exercised system actions, iframe isolation, and exit. Production build, signing, static checks, and existing Desktop regressions passed; owner acceptance retained MyGo, with external gaps explicitly preserved.

## Consequences

WKWebView differs from Chromium in IME, scrolling, and CSS and requires real use. It still depends on external Node and the build-time repository, which size comparisons must disclose; lower total memory is not promised. Each shell keeps separate pending records, so unknown submissions should be verified in the original shell before switching. MyGo does not duplicate Electron subframe-navigation callbacks; isolation rests on CSP, sandbox, binding checks, and real probes together. [Startup optimization](../bug-fix/2026-10-17-desktop-connection-startup.md) owns preparation timing and lightweight readiness probes.
