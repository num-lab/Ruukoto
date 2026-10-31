# Agent Note: Commands and services verify original configuration versions and switch after related execution ends

Status: implemented

## Problem

Command directories and service deployment paths were permanently bound to profiles, with recovery comparing all history to current fingerprints. Allowing path/helper changes directly would reinterpret old executions in a new environment. A new helper's not-found response especially cannot prove original execution ended.

## Decision

Commands/services use immutable configuration versions within one profile under [operation-scoped configuration](../../proposed/architecture/2026-10-25-operation-scoped-configuration.md). Current module selection stores a unique configuration version and file revision. Commands, background processes, service checks and writes record original selection at admission; requests/stopping verification always resolve that version. Unversioned legacy records use only the migration baseline without rewriting entries. personal-settings retains file saving, publication receipts and format migration.

Migration waits only for this capability's admitted Tasks, conversation background processes, pending stops and unknown effects. It neither cancels them nor waits for unrelated chat. Unverified effects/stopping reports that capability pending. New directories still verify realpath, dev/ino, machine and TMPDIR. Production service publication still verifies Linux, root path protection and policy machine identity; original helper operations verify actual protocol/deployment health. Changing service paths invalidates old standing grants, never extending them to the new deployment.

New model requests record command/service configuration versions. When an old response arrives after selection changed, new execution admission rejects it; admitted execution continues verification against the original version. Unverified settings-write intent pauses new admissions only for that target; queries/original recovery remain available. Schedule snapshots pin both versions. Changing back after substantive migration cannot revive old scope. Old plans use old snapshots only while current selection remains the original migration baseline.

First-enable candidates can be withdrawn to an explicitly disabled baseline. Internal withdrawal saves JSON null and a new version, while ordinary configuration save still rejects null. Publication first checks capability occupancy, then removes tools/extensions from main/child configuration, stops and disables the current object. Old registry definitions/receipts remain. Cold start recognizes null as disabled and does not restore capability from startup arguments. A missing-file baseline from host injection with execution history is not never-enabled: withdrawal rejects rather than dropping history.

Terminal commands are not stopped again and history inspection does not revisit old directories. Reading original output/stopping original processes still checks execution references/evidence, reporting only that item unavailable when missing. Old service-check evidence likewise does not depend on a new helper. Saving new files neither migrates nor rewrites/deletes entries, command evidence or background records.

Trusted hosts may inject configuration directly into openPersonalHarness without files. For a command missing-file baseline, after checking original module fingerprint, append the original configuration to the same chain with origin=host, content=null and revision=missing, without claiming a file existed. Capture the last-entry boundary; only earlier unversioned commands use that baseline, without rewritten entries. An offline profile with command fingerprints but no host baseline rejects saving before intent/file replacement; the original trusted host must verify configuration first. Once a target save exists, resolve its saved version rather than overriding history with new injected defaults.

Services capture host baselines the same way. File configuration still stores only three deployment paths; hostService separately retains original useSudo/timeout. Later file versions inherit this metadata, so withdrawal converted to a file can cold-start without injection. Old unversioned writes must belong to the captured existing-Task set; old inspections must precede the captured entry boundary. A read-only host baseline does not enable service writes. Missing host-service baselines also reject before saving. Withdrawing an unapplied command/service candidate may save the original host configuration as a new file version while leaving the missing baseline unchanged. Rechecking a verified-stopped service operation returns idempotently without touching old deployment.

## Related decisions

This partly supersedes permanent binding/current-dependent history in [fixed command directory](2026-10-17-personal-command-configuration.md) and [fixed service configuration](2026-10-17-personal-service-configuration.md), retaining permissions, protected roots, locks and execution identity. [Service inspection](2026-10-17-personal-durable-inspection.md), [command work](2026-10-17-personal-durable-commands.md) and [conversation background processes](../feature/2026-10-21-personal-background-processes.md) retain admission, dual facts, directory claims and external evidence. The overall proposal still owns other modules and is not completed by this slice. Model, MCP, IM and application-data notes keep their ownership; none is wholly absorbed or archived.

## Alternatives considered

- Keep permanent binding and create a new profile: simplest old recovery, but loses continuous same-profile history and cannot meet same-machine directory/deployment migration requirements.
- Run multiple command/service instances simultaneously: uninterrupted new admissions, but more environment/stop-handle management. First release switches at this capability's safe stopping boundary and retains history.
- Verify history only from prepared.spec: independent of current path, but rewritten execution records become self-authenticating without external configuration provenance. Verify immutable versions plus original admissions.
- Wait for global idle: reusable gate, but unrelated chat/search/capabilities block this target. Related operation occupancy is sufficient to protect execution identity.

## Consequences

One profile retains history across directory/helper deployments; vanished terminal environments no longer prevent starting new configuration. Referenced versions must remain permanently available; broken chains still reject. Active old operations cannot use configuration changes to bypass stopping/effect verification. Missing Linux, real helper deployment or sudoers prerequisites remains unverified; controlled substitutes do not prove production health. Original engineering/external evidence is offline at `.scratch/configuration-updates/issues/01-remove-global-restrictions.md`.
