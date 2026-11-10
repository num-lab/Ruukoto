# Agent Note: Isolate development state and own its processes

Status: implemented

Original source: ADR 0017’s development-entry supplement. [Single product](../architecture/2026-11-10-single-product.md) supersedes the two-launcher composition, old profile paths and model-import entry. This note retains the managed-development ownership contract.

## Problem

Source watching and UI reload must not attach to, stop or write through a daily backend. A normal client’s detached backend lifetime also does not fit a development run whose launcher must clean up on exit.

## Decision

`npm run dev` starts the sole backend and TUI. `--config` opens that instance’s configuration; `--desktop` selects managed Electron and conflicts with configuration and positional workspace arguments. The launcher selects all four raw roles beneath `~/.ruukoto-dev/<checkout-identity>/` and core activates `single-v1`. Children receive that complete raw tuple; in-process consumers receive `ProfilePaths`. Model setup writes the new resolved agent directory without silently importing old settings or credentials.

`apps/ruukoto/src/dev.ts` uses `packages/tui/src/dev.ts` for watching, reload and process ownership. Clear inherited daily paths, owner tokens and execution overrides. Restricted execution requires native prerequisites; full access uses the starting account. The launcher rejects an existing external backend instead of attaching or stopping it.

The launcher owns this backend/frontend process group. TUI/config exit, Ctrl+C and terminal closure stop its managed processes. The development frontend never independently spawns a backend after reload failure. Managed Electron receives its development marker and a new resource nonce without login-shell discovery; electron-vite owns frontend rebuild/HMR, while the launcher restarts backend changes. Ordinary daily client exit remains detached under [terminal separation](../architecture/2026-09-19-detach-terminal-from-task-runtime.md).

Reload preserves conversation and draft identity; command/reload history, pending records and logs come from the core profile resolver. A failed or unknown first send retains its original request for explicit recovery rather than creating a new session or silently replaying it.

## Alternatives considered

- Reassign an existing profile: convenient history/configuration continuity, but bypasses ownership and fresh-instance identity. Leave old state untouched.
- Let the frontend start its own backend: reuses ordinary demand startup, but can create processes outside launcher ownership after reload failure. Managed frontends connect only.

## Consequences

Development and daily state stay separate, with one owner for reload and exit. Separate profiles need new configuration and native prerequisites; development is not an installation replacement. Tests for arguments, raw handoff, reload, first-send recovery and managed exit remain necessary; historical launcher checks do not establish acceptance of this cutover. Current commands belong in [development](../../../../docs/development.md).
