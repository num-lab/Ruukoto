# Agent Note: Activate one identity-bound fresh profile

Status: implemented

## Problem

[Issue #58](https://github.com/num-lab/Ruukoto/issues/58) reuses `ruukoto` after retiring Personal. That product string previously identified a different runtime and database. Checking it after database initialization can already mutate old state. Independent directory overrides, configuration-first startup, concurrent starters and interrupted installation require one shared identity before any client or writer can act.

## Decision

Core resolves one canonical raw selection for data, agent configuration, persistent control and pending requests. Directory flags override the corresponding `RUUKOTO_*_DIR`; omitted roles are siblings of the canonical raw data directory. Equivalent explicit defaults and safe aliases select the same tuple. Children receive the complete raw tuple; in-process consumers receive resolved `ProfilePaths`. Supplying a resolved role path as an ordinary override is an error with the original selection as guidance.

The fixed generation is `dirname(data)/single-v1` for a raw data basename of `data`, otherwise `data + ".ruukoto-single-v1"`. Data, managed workspaces, work copies and logs belong to this generation. An independent raw role override receives its own fresh sibling namespace qualified by the full raw-data SHA-256 and role. One preparation record binds the complete tuple; changing one slot after preparation rejects instead of mixing instances. Existing ancestors, generation and installed roles retain physical identity checks.

The [atomic ownership primitive](../bug-fix/2026-11-10-atomic-lock-publication.md) serializes preparation. A durable exclusive record reserves the instance ID before role initialization. Installation consumes its saved effective tuple and rejects changes to canonical default equivalence. Each role's staging inode is recorded before installation. Directory creation and record publication use verified parent descriptors; exclusive publication preserves the staged inode and refuses existing targets. Recovery reuses only recorded staging/final identities; unreferenced staging debris remains untouched. Immediately before `profile.json` publication, bootstrap revalidates the preparation, complete role set and endpoint, then publishes against the recorded generation-root identity. Storage activation needs no model, key, backend or network, so offline configuration bootstraps exactly the same profile before taking its configuration lock. The database uses the reserved ID rather than allocating another one.

Only preparation creates a staged database with its reserved identity. Current reopening requires an existing file through SQLite's `file:` URI `mode=rw`, not an existence check followed by a create-capable open. Node 24.15 enables `SQLITE_OPEN_URI` at its [native open boundary](https://github.com/nodejs/node/blob/v24.15.0/src/node_sqlite.cc#L916-L929); SQLite defines [mode=rw](https://www.sqlite.org/uri.html) as read-write without creation. Thus deletion between profile verification and reopening cannot replace the activated database with blank state under the same identity. Required directory, role-record, database and token access failures retain their cause in a terminal `ProfileError`. Direct database diagnostics retain their codes; profile validation wraps corrupt storage as a terminal failure rather than reconnecting indefinitely.

Bootstrap crash coverage kills a separate process with `SIGKILL` at preparation publication, every role's staging/installation checkpoint, and both activation boundaries. Recovery must consume the stale bootstrap owner, preserve the preparation and instance IDs, and leave unreferenced staging debris untouched. Exception-only interruption does not prove this contract because it executes lock-release cleanup.

Persistent control storage does not determine the socket filename. Core derives a bounded address under canonical system `/tmp/ruukoto-<uid>/<address>/control.sock`; macOS resolves `/tmp` to `/private/tmp`. Its private owned directories and full binding digest prevent truncated-address collisions from selecting another instance. Platform byte limits are checked after preparation and before role initialization or activation; rejection preserves the reserved identity. Losing the temporary endpoint permits only endpoint reconstruction from a validated activation, not data reset or another instance ID. Every client, readiness probe and server uses the resolved socket field.

The live runtime owner supervises endpoint loss without restarting storage or changing identity. Recovery verifies the original runtime lock inode and owner bytes and the current activation before recreating the private binding. Listeners bind short private staging names and exclusively publish their socket inode at the sole resolver-owned address: Node/libuv removes its bound pathname on close, so binding the public name could remove a replacement owner's socket. Listener retirement preserves accepted connections; shutdown cancels supervision and removes only the verified public inode. On-demand startup waits for authenticated readiness from a live owner rather than spawning or signaling another process.

The predecessor guard recognizes only pinned archived shared schema/product and durable manifest/resource formats. It holds compatible exclusion while inspecting coherent private SQLite/WAL copies and checks persisted occupancy and stop evidence independently of backend liveness. It never starts predecessor recovery, signals processes, imports configuration or replays work. Unknown formats, live/unverifiable ownership, incomplete format conversion and unresolved managed execution reject. Committed sessions, credentials and workspace/work-copy source remain in place. Temporary inspection copies are deleted after inspection; they are not retained backups.

The new schema and control versions advance to 59 and 50. Layout, product, protocol and instance bindings are checked before current writers and clients proceed. Identity rejection is terminal; online configuration cannot turn it into an offline write. Old pending journals and drafts remain outside the new request namespaces.

Client journals are children of the pending role: `tui` for the terminal and `desktop` for native clients. Neither scans the role root, which contains its binding metadata. This prevents a fresh profile marker from appearing as a corrupt pending request.

This implements the profile portion of the [single-product decision](2026-11-10-single-product.md). The source archive preserves old operating instructions and history; no runnable PA restoration or existing-installation continuity is promised.

## Alternatives considered

- Rename only the product string and retain old directories: least code, but old shared PA already used that identity and initialization can mutate its database before rejection.
- Offer a rolling profile selector or migrate old instances: supports continuity, but the approved cutover is a fixed fresh generation with no import, credentials or history-continuity obligation.
- Place the socket under persistent control storage: natural locality, but independent qualified overrides exceed Unix-domain address capacity under ordinary home paths.
- Infer stopping from an exited backend: convenient automatic fresh start, but native scopes, browsers, backgrounds and unverified workers can outlive it. Persisted resource stop evidence remains the admission gate.

## Consequences

All stateful entries use the same bootstrap and all role paths travel together. A corrupt binding is a visible error rather than an automatic reset. Owners may need to resolve predecessor execution separately before a blank start; the remaining product does not carry PA recovery code. Cross-filesystem role installation is recoverable but not atomic; the activation marker is the visibility point. The bounded legacy recognizers and immutable format fixtures remain as admission code, not an old runtime or migration implementation.
