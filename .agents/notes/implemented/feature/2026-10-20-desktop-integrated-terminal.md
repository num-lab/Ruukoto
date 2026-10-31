# Agent Note: Desktop integrated inspector terminals

Status: implemented

## Problem

Owners need local interactive terminals in multiple workspaces. They are not backend Agent tasks. Closing a terminal must end it; changing inspector tabs, sessions or Personal must not. Electron and MyGo share renderer and Node host.

## Decision

DesktopHost owns TerminalManager. Code-only terminal operations bypass the control plane and retain no persistent terminal history. Installed Code snapshots/project events register workspace roots. Open requests carry generated terminal references, expected data instance and workspace reference; the host rechecks real path/inode and starts the default shell there. After environment preparation or cleanup waits, recheck the generation so stale instances cannot launch terminals.

Electron uses standard external declarations and output.paths for exact terminal-vendor references, not a custom CommonJS resolveId hook. node-pty 1.1.0 uses N-API, sharing same-platform Node/Electron binaries. Both packages include runtime JS, licenses and platform pty.node; macOS includes executable spawn-helper. Electron unpacks native/helper files and MyGo preserves resource layout. Production checks allow only exact terminal vendor imports, still rejecting other workspace/dynamic external dependencies.

Limit eight terminals. Batch output every 16 ms, at most 64 KiB/frame; pause PTY at 64 KiB pending, send backlog with 16 ms intervals, then resume. MyGo awaits pipe-write completion. Output precedes exit. App's single subscription routes by terminal reference; output writes directly to xterm without React repaint. All Code terminals stay mounted; hiding stops layout/input only. Chinese input is written as UTF-8 bytes. xterm retains 5,000 scrollback lines, FitAddon resizes on visibility, and themes supply complete ANSI-16 palettes.

Use a concrete monospace stack matching `--font-mono`: OffscreenCanvas `ctx.font` cannot resolve CSS `var()` and otherwise silently measures proportional defaults/wrong line height. xterm injects runtime color/font/cursor styles, requiring desktop `style-src 'unsafe-inline'`; scripts retain nonce/source restrictions. Ctrl combinations pass to the shell. Serialize each terminal's input/resize requests, stopping later sends after failure to avoid MyGo async-binding reordering.

Close terminal/session, instance change, reload/crash and host exit trigger cleanup. Before signaling, use ps to verify shell/descendant process groups and reject overlap with the host. Send TERM, then KILL after 500 ms and check remaining executable members, retaining escalation even if the shell exits first. Failed stop preserves host records and visible retry-cleanup feedback; do not claim full cleanup. A late successful open after tab closure is cleaned again.

This supplements [MyGo host](../architecture/2026-10-17-desktop-mygo-experiment.md) and [local preview](2026-10-17-desktop-local-browser.md) without changing connection/browser isolation. [Detached task runtime](../architecture/2026-09-19-detach-terminal-from-task-runtime.md) continues to own backend tasks.

## Alternatives considered

- Running shell through backend tools reuses supervision but ties an owner's terminal to backend connectivity/Agent identity.
- Bundling node-pty into one JS file conflicts with relative native/helper loading; preserving runtime layout is smaller and testable.
- Killing only the shell misses foreground groups or signal-ignoring descendants after shell exit.
- Per-terminal host subscriptions repeat initialization and app output delivery; route the single subscription.
- Blocking inline styles is stricter, but breaks xterm colors and metrics. Nonces require modifying xterm injection/a separate style pipeline, far beyond the limited style-only relaxation.

## Consequences

Both shells share PTY behavior without tab-switch termination, at the cost of native/helper packaging and signing. Terminals run as the application account; cwd does not sandbox filesystem access. Deliberately detached/already-orphaned processes may escape cleanup, and process-table snapshots cannot prevent new external descendants. Reload/exit loses scrollback. Output is bounded/throttled, but Electron-to-xterm delivery has no consumption acknowledgement. Real-shell IME, selection, themes and hidden restoration require separate experience evidence, not offline tests.
