# Agent Note: Preserve original-service identity during personal settings maintenance

Status: implemented

[Tailscale HTTPS/WSS](../architecture/2026-10-24-personal-tailscale-https.md) replaces SSH transport and desktop-owned maintenance phases. [Settings publication](../architecture/2026-10-25-personal-settings-versions.md) replaces stop/save/start for ordinary saves with online or offline locked publication. This note retains original-service verification, revision/unknown-effect rules, and the interpretation/recovery of old maintenance receipts; the SSH details are historical, not a current connection option.

## Problem

[Desktop settings](../../proposed/feature/2026-10-21-desktop-settings-management.md) must manage the new durable profile. [Personal settings](2026-10-21-personal-settings.md) already had authenticated reads/offline locked saves, but old chat used another token/protocol and could not prove safe stop/restart. SSH shell environment is not service environment, and HTTP stop does not stop systemd supervision.

## Decision

### Original separate management connection

Electron/MyGo reused DesktopHost through the request bridge, storing management in personal-settings.json separately from old chat's personal.json so failure did not affect Code. The wizard selected SSH alias/canonical profile, one of two supported install locations, and lifecycle. Detection first used maintenance's refuse-missing-profile inspection, then settings reads, to avoid generic initialization accidentally creating the wrong directory. Check version/product/canonical identity; reject absence/old protocol/changed identity rather than fabricate old-chat snapshots.

Detection kept the first structured candidate error only if every candidate failed; any success returned the successful candidates. SSH loss/profile refusal/protocol failure must not become an empty "not installed" list, raw stderr echo, or automatic retry.

Coalesce a same-controller, same-profile full `read()` so page switching and connection verification share one query. Each page still rejects late generation responses. Release the shared promise on success/failure and check closed state first. This does not queue/replay writes, loosen mutual exclusion, or merge model tests/tool discovery/different operations.

Machine configuration/maintenance JSON used fixed settings/maintenance subcommands through stdin/stdout, never interpolated parameters into remote shell. Fixed OpenSSH arguments and single-quote escaping, 128 KiB stdin/256 KiB stdout, bounded timeout, and cross-chunk UTF-8 decoding bounded that path. Online settings read authenticated `/settings` through a forwarded Unix socket, rereading control.token each time into Node memory only. Structured errors retained outcome class without secrets. Configuration change/exit canceled that request and reclaimed its own SSH process; stale generations could not continue maintenance. These SSH mechanics are retired under the superseding transport.

### Original-service proof

Maintenance accepts only inspect/stop/start and cli/systemd/development, no arbitrary commands/units. Unknown CLI environment and managed dev instances are read-only, pointing to supported system-service deployment. Systemd management is limited to system-level ruukoto-backend.service. Read effective properties and verify same account, fixed Node/bin, `serve --directory` profile, actual MainPID, and `/proc` identity. Explicit directory wins over environment, avoiding unverifiable EnvironmentFile overrides; never read that file to prove credentials. Check/use sudo -n only for exact `/usr/bin/systemctl start/stop ruukoto-backend.service`. This does not relax the unrelated service-helper prohibition on managing its own backend.

Supported units require SendSIGKILL=no, TimeoutStopFailureMode=terminate, KillMode=control-group, SIGTERM, and no extra stop scripts. Disabling final SIGKILL alone leaves the abort-timeout SIGABRT branch, so refuse it too. systemctl omits empty ExecStop/ExecStopPost arrays; only those omissions mean empty. Nonempty scripts fail and all other required properties must explicitly match. Leave other services untouched; GUI installs no sudoers or units.

A stop timeout reclaims the requesting client only, retaining backend/lock and refusing save. After apparent success, verify original process exit, inactive/MainPID=0, and available profile lock. A failed unit after unsuccessful start may still be explicitly recovered if original process exited, MainPID=0, and lock is free; failed does not inherently mean occupied. Starting/stopping/held-lock states remain refusals.

### Save and recovery

Originally Host accepted one explicit stop/save/start only with an online backend, supported lifecycle, no pending blockers, and usable actual model credentials; new model references were preflighted by the real backend. Connection/maintenance preflight reads one configuration digest but checks all pending items, so a valid large MCP list cannot exceed the response budget before stopping. Offline single-item save rechecks profile identity/revision/blockers inside the same lock, then starts the original service and reads actual revision. Saving configuration and testing model/MCP connectivity are separate. A failed restart preserves the saved fact; recovery only starts the original service, never resends save or requires eliminating blockers that only that service can handle. Ordinary current saves follow settings publication instead.

The old desktop private journal recorded profile/operation/original revision/request digest/phase before each write, never full drafts/tokens/service environment. Reopening the same connection resumes verification; a pending operation prevents replacing its connection. Lost responses in stop/save/start query original profile revision/service/lock only, without replay/force-kill. A save receipt proves saved; a save attempt without receipt remains unresolved, and an internal error cannot prove nonwrite. Only explicit prewrite refusal means not saved. Managed-skill revision conflict before any change retained comparison draft and explicit original-service recovery and was not classified as lost response. The owner compared current settings with the original draft before explicitly ending maintenance; failed journal clearing prevented another write. Remote-owned maintenance now supersedes new local phase journals while preserving old receipt interpretation.

Related [settings shell](2026-10-21-desktop-settings-shell.md), [local management](../architecture/2026-10-17-personal-local-management.md), and [desktop architecture](../../proposed/architecture/2026-10-15-desktop-client.md) retain navigation/configuration-lock/local interaction/legacy-chat rationale. The original audit fully absorbed or archived none of them.

## Alternatives considered

- Reuse old chat's controller: fewer objects, but different protocol/token source cannot prove the new profile's identity. The original implementation separated them; later unified transport does so through a new PA protocol.
- HTTP stop then save: no service privilege, but systemd may restart and acquire the lock. Stop the original supervisor when maintenance requires stopping.
- Copy SSH shell environment/read EnvironmentFile: can launch a program, but does not establish the original service environment and broadens secret reads. Unknown CLI stays read-only; restart only the original service.
- Save full local drafts and retry automatically: convenient recovery, but endpoints may contain secrets and the original backend lacked save idempotency keys. Keep digest/association and verify rather than resend.
- Block navigation during reads: avoids duplicate calls but lets queries trap navigation. Coalesce identical reads and retain write exclusion instead.

## Consequences

The original separate connection preserved profile locks, revision comparison, pending occupancy, and actual credential environment without affecting Code/old chat. It required administrator-provisioned exact privileges/units; unknown CLI remained read-only. Current transport/publication removes obsolete connection and stop-on-save behavior without weakening old-operation recovery.

Historical automation used fake SSH, real HTTP sockets, temporary profiles, and controlled systemctl clients for refusal/disconnect cases. That did not prove production service maintenance. Real Linux, both shells, and subjective experience required separate acceptance; historical desktop-settings task records now serve as offline provenance, not current SSH setup instructions.
