# Agent Note: Keep separate development launchers and profiles for both products

Status: implemented

Original source: ADR 0017's development-entry supplement. [Personal product entry](../simplification/2026-10-18-personal-product-entry.md) replaces personal shared-Runtime assembly with durable CLI/Node watch. [Native execution](../architecture/2026-10-12-personal-native-sandbox.md) and [current-account full access](../feature/2026-10-12-full-access-current-account.md) supersede container/local defaults and dedicated execution accounts. Isolation, explicit imports, process ownership, and managed exit remain here.

## Problem

Both products need independent source watching/reload/UI development. The old npm dev database was already marked ruukoto, so switching it to Code was correctly refused by product ownership. Development must also separate daily-instance paths, credentials, locks, control channels, and real IM consumption.

## Decision

`npm run dev` starts personal development; `npm run dev -- --config` opens its configuration menu. `npm run code` starts Code and opens TUI, while `--config` opens its configuration center. Code-only `--desktop` uses Electron and conflicts with --config/positional workspace arguments. The development launcher does not accept --tui.

Code's app `src/dev.ts` uses `packages/tui/src/dev.ts` for watching, reload, and processes. Its watcher covers packages/*/src and apps/*/src and starts the correct app bin. The original shared launchers used distinct `~/.ruukoto-dev/<repo>-<hash>/` and `~/.ruukoto-code-dev/<repo>-<hash>/` profiles, each with its own data/configuration/credentials/lock/control. They never silently migrated old personal development history or changed its product ID; Code model configuration is copied only with explicit --import-models. [Retained personal dev sessions](../feature/2026-10-05-ruukoto-keeps-dev-sessions.md) records the old shared-assembly rationale, not the current durable product's session model.

Code development fixes product identity, strips inherited daily paths/owner-token variables/execution-backend overrides, and disables real QQ/Telegram. Restricted execution follows native product capabilities and fails rather than falling back. Full access uses the launching account, not a specially configured execution account. Old personal local and Code container defaults are historical.

The launcher owns its backend: leaving TUI/configuration, Ctrl+C, or terminal closure stops that development process. Electron receives RUUKOTO_DESKTOP_MANAGED=1 and a new nonce for each frontend start, without login-shell execution. Electron-vite handles desktop rebuild/HMR including bundled view/control/core sources; the launcher restarts only the backend. Electron/electron-vite have separately managed process groups reclaimed on exit. The dev frontend never spawns another backend after reload failure. Daily Code TUI disconnect still leaves its backend running under [terminal separation](../architecture/2026-09-19-detach-terminal-from-task-runtime.md); do not apply that rule to managed dev exit.

Current personal dev fixes a checkout-hashed durable profile and ignores inherited directories. Its thin launcher supervises Node watch running foreground serve; --config opens the same personal menu without watching source, owning this run's backend, so source changes require exit/reopen. Exit/watch restart stops the original backend first. Enabled QQ/Telegram is refused without altering configuration/records. It no longer connects old Runtime/control or uses the shared launcher's session/model-import path.

## Alternatives considered

- Reassign the existing dev profile to Code: preserves history/configuration conveniently, but its database is owned by ruukoto and product identity must not be bypassed. Keep old history and create an independent Code profile, with explicit model copying.
- Let the dev frontend spawn a backend like daily TUI: reuses demand startup, but reload failure could create processes outside launcher ownership. It only connects to the launcher-managed backend.

## Consequences

Both products can run in development simultaneously without reassigning existing history, and one manager owns reload/exit per entry. Separate profiles cost separate maintenance; history migration is not a launcher feature. Restricted work needs native prerequisites; full access retains its explicit launch-account risks. Dev exit stops its backend, unlike ordinary daily-client disconnection.

Original commit `c819db3adad75b8c0cf604b3fef3816334fa993f` changed shared/product/package entries plus test/32 and test/71. Test/32 covers arguments/profiles/reload/managed exit; test/71 covers environment cleaning and noninheritance of daily paths/tokens/execution configuration. Original ADR/task material recorded no separate executed command result for that commit, so these are inspectable coverage claims, not invented historical passes. Former `.scratch/agent-direction/issues/23-contract-legacy-roles.md` is offline provenance for product-switch constraints. Current operation belongs in [development documentation](../../../../docs/development.md).
