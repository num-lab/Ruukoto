# Agent Note: Full-access commands recover through persistent scopes and original work

Status: implemented

[Operation-specific checks](../bug-fix/2026-10-24-operation-specific-checks.md) removes unrelated protection checks from full-access execution. Command-directory identity, source and original stopping evidence remain verified.

## Problem

[Durable commands](2026-10-17-personal-durable-commands.md) initially supports only restricted modes and rejects full access. Shared local-launcher process groups live only in memory and cannot prove original stopping after backend SIGKILL. Restricted prepare would change approved account-environment, outside-directory and network semantics.

## Decision

Linux full-access commands launch the same self-contained worker directly inside a persistently tracked user scope, without bwrap, network filtering or restricted runtime dependencies. Non-tracked native entry still rejects full access. Coding's default launcher/restricted preparation is unchanged. Reuse [native persistent identity](2026-10-17-native-linux-execution-identity.md): exclusive claims, prelaunch stop markers, token, InvocationID, launcher, cgroup dev/ino and FD-based stopping. Missing original launch claims or mismatched request/launch fingerprints cannot become proof of old execution exit via a stop-first claim.

Personal prepare saves original cwd, worker, Node and temporary directory, with empty mounts/runtimeReadRoots/toolAliases and an empty env object. Actual spawn calls shared workerEnv to inherit the backend user's environment while stripping internal control variables. Environment values are not persisted as prepare input or request fingerprint. Initial cwd/dev/ino is not a full-access path restriction. Commands may access outside directories, network, same-account backend data and credentials without per-operation approval, within approved [current-account full access](../feature/2026-10-12-full-access-current-account.md).

Each child request's command-permission section displays original work mode from persisted work index/permissions. The section and actual model request retain evidence; long-lived context is not current authorization.

Host receipts, original streams, strict stopping, original-work owned Tasks, cleanup, source pausing and report recovery reuse the command implementation. Recovery verifies preparation according to original mode. Full-access empty arrays/environment and fixed Node/worker must match; this path cannot skip evidence checks. Unknown effects/unverified stopping still pause original work. Models cannot switch mode/member/service to bypass them. Human effects and OS stopping are verified separately; recovery does not regain execution authority.

Record fields, Task/document versions and existing mode enums remain unchanged. Old code scans all commands before resume and explicitly rejects original full_access work, including terminal records, rather than applying restricted recovery. The same data representation needs no extra profile version. Original isolated old-code rejection, real OS and offline regression evidence is retained at `.scratch/personal-pi-durable/issues/26-full-access-commands.md` in the offline archive.

## Related decisions

[Personal background processes](../feature/2026-10-21-personal-background-processes.md) reuses original-scope execution/stopping with independent conversation ownership and shared directory claims. This note still owns original-work command execution facts.

The original active-note audit searched full access, Personal commands, persistent stopping and environment. Current-account full access, native persistent identity, [command host](2026-10-17-personal-command-execution.md), [fixed command directory](2026-10-17-personal-command-configuration.md), durable commands and the migration proposal retain their separate decisions. This replaces only the lack of full-access command support, not restricted boundaries or old local-stop promises. MCP is separately governed by its later integration decisions; no note was wholly absorbed or invalidated.

## Alternatives considered

- Use local launcher directly: no platform split, but memory-only PGIDs cannot prove stopping after SIGKILL and would bring the old worker/SDK.
- Map full access to restricted prepare: reuses dependencies/protected-root checks, but clears user environment and restricts outside-directory/network access against approved semantics.
- Persist the entire user environment: reconstructable, but copies credentials into operation records and widens secret ownership. Recovery verifies old execution and never relaunches, so environment reconstruction is unnecessary.

## Consequences

All three modes share operation facts/recovery without new dependencies, configuration or a parallel state machine. Full access still requires Linux user systemd/cgroup v2 and original-group stopping, but not bwrap/AppArmor policy. Preserve original directory, machine, TMPDIR and evidence. A crash after intent commit but before external claims remains conservatively unknown and occupied.

Same-account full access can edit backend profiles/evidence; private permissions do not isolate it. Persistent stopping proves only the original execution unit and descendants still in it, not processes that deliberately escape, elevate separately or delegate to external services. Complete streams may contain environment values the command explicitly reads; this is not output redaction. [MCP transport](2026-10-17-mcp-transport-reuse.md) owns HTTP entry, and local scope exit proof cannot prove remote HTTP effects. Production entry, deployment, real-model/IM behavior, product experience and complete migration remain separate acceptance obligations.
