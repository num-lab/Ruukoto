# Product Composition

## Responsibilities and Boundaries

`apps/ruukoto` owns the sole executable, application assembly and development entry. It assembles [runtime](runtime.md), [control](control.md), [agent tools](agent-tools.md) and [TUI](tui.md); Electron and MyGo are clients, not alternate products. Core owns profile selection/bootstrap, not application-specific path defaults.

## Public Interfaces

| Entry | Purpose |
| --- | --- |
| `ruukoto [path]` / `npm start -- [path]` | Workspace conversation or selector; backend on demand |
| `ruukoto server` | Foreground backend |
| `ruukoto config --offline` | Activate fresh storage and configure models without a ready backend |
| `ruukoto stop` | Explicit backend stop |
| `npm run dev` | Checkout-isolated backend and TUI, owned by the launcher |

## Data and State

Product identity is the literal `ruukoto` within activated layout `ruukoto-single-v1`. The [core profile](core.md) binds the complete raw selection, resolved roles and reserved instance ID. Daily and development instances share that algorithm but select different raw tuples. Old product names, alternate compositions and import commands are not aliases.

## Main Flows

CLI parses directory flags before stateful dispatch, selects the canonical raw tuple and bootstraps designated stateful entries. Configuration can proceed before model readiness. Runtime and in-process clients receive `ProfilePaths`; child server/config/TUI/desktop processes receive the complete raw tuple through standard environment variables or flags. Backend readiness verifies the activated instance and protocol rather than treating any connectable socket as reusable.

Root build produces retained native supervisors, tool/background workers and workflow script/WASM, plus the application’s complete-workspace package. Electron/MyGo packaging remains explicit. A source tarball is not a standalone installation without its declared workspace dependencies and built assets.

## Invariants and Failure Handling

- Restricted production execution requires native isolation; tests may explicitly select local execution.
- Ordinary client exit leaves backend work running. Development owns only its run’s backend/UI and stops them on exit.
- Profile/version/ownership errors are terminal; no old settings import or offline fallback bypasses them.
- Old sessions and actual workspace/work-copy source remain untouched; no old work or pending request is replayed into fresh state.

## Design Rationale

- [Single product](../../.agents/notes/implemented/architecture/2026-11-10-single-product.md): retirement and fresh identity.
- [Workspace packages](../../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md): dependency direction and distribution.
- [Development launcher](../../.agents/notes/implemented/process/2026-10-09-dev-launchers.md): isolated state and process ownership.
