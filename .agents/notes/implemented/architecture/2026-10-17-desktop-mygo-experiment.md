# Agent Note: Evaluate MyGo as a Desktop shell

Status: implemented

[Single-product cutover](2026-11-10-single-product.md) supersedes this note’s Personal, dual-product and legacy-import scope. Retained software-work constraints below remain active; retired-product mechanisms and evidence are historical, not current commands, compatibility requirements or acceptance passes.

[MyGo browser](../feature/2026-10-29-mygo-agent-browser.md) owns native inspector pages, automation and explicit takeover. Private host frames remain separate from renderer events; their lifecycle no longer depends on retired PA credential initialization.

## Problem

The owner wanted to experience a lighter shell than Electron before deciding to keep it. React UI and the Node control client were separable. Rewriting control in Go expands the experiment; static Demo rendering cannot test real workflows.

## Decision

Retain Electron and MyGo as native clients. Go hosts the shared renderer in WKWebView and owns native window/system actions; Node DesktopHost owns local connection, submission recovery and notifications. Private stdin/stdout JSONL carries bounded raw JSON with stdout reserved for protocol and diagnostics on stderr. Request IDs are local to the sidecar lifetime.

Undelivered requests are not_sent. Sent requests whose response is lost remain unknown/disconnected and never automatically replay. Sidecar failure settles pending calls; reopening verifies original journaled submissions. EOF releases owned connections and stops the sidecar, while the ordinary backend remains independent.

Go methods accept only the exact current top-level mygo://localhost/ document; native IPC also rejects subframes. Do not broaden trusted origins. Retain strict production CSP and iframe sandbox; reject window.open, downloads, and page permissions. Main-document external links use a narrow system-browser method. Picker attachment paths travel only between Go/Node; renderer gains no path-upload method.

Signed build resources pin Node and sidecar identity rather than relying on Finder PATH. Backend/terminal environments are selected and cleaned separately. MyGo development and production use distinct native application state; signed development selects its complete raw profile and discards inherited owner-token values and token-file paths, so daily authentication cannot enter the isolated instance. Backend pending/draft identities come from activated `ProfilePaths`. Invalidated Node/repository paths require rebuilding. No second HMR system is added.

This supplements [Desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md) with an independent shell/comparison. The owner approved retaining/committing MyGo on 2026-10-17. [Current GUI](2026-10-16-desktop-current-demo.md) and [Trace migration](2026-10-16-desktop-trace-migration.md) retain presentation/backend semantics; native adaptation has separate verification. [Workspace packages](2026-10-11-in-repo-workspace-packages.md) retains Electron production constraints, while the Go module is outside production npm installation.

## Alternatives considered

A Go control rewrite could remove Node but duplicates protocol, SSH supervision, and submission recovery, preventing attribution of differences to the shell. Replacing Electron outright loses the comparison and rollback required for evaluation. A static MyGo demo shows WKWebView appearance quickly but cannot verify connections, attachments, approval, or exit.

## Verification

Historical evidence is in `.scratch/desktop-mygo/issues/01-mygo-experiment.md` offline. Logic/Go transport tests cover classification, EOF, and cleanup. A real isolated-backend .app installed snapshots, displayed sessions, and exercised system actions, iframe isolation, and exit. Production build, signing, static checks, and existing Desktop regressions passed; owner acceptance retained MyGo, with external gaps explicitly preserved.

## Consequences

WKWebView differs from Chromium in IME, scrolling, and CSS and requires real use. It still depends on external Node and the build-time repository, which size comparisons must disclose; lower total memory is not promised. Each shell keeps separate pending records, so unknown submissions should be verified in the original shell before switching. MyGo does not duplicate Electron subframe-navigation callbacks; isolation rests on CSP, sandbox, binding checks, and real probes together. [Startup optimization](../bug-fix/2026-10-17-desktop-connection-startup.md) owns preparation timing and lightweight readiness probes.
