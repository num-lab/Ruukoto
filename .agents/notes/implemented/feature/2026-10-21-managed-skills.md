# Agent Note: Keep managed skill bytes fixed and change availability through a manifest

Status: implemented

[Fixed HOME discovery](../simplification/2026-10-28-home-skills-discovery.md) supersedes active discovery/management: both products now use fixed directories; old managed bytes and historical references remain in place. This note preserves the rationale and original package guarantees, not a live import/enable/remove API. [Settings publication](../architecture/2026-10-25-personal-settings-versions.md) and [request configuration](../architecture/2026-10-25-personal-request-configuration.md) superseded personal online publication/request snapshots before that retirement. [Read-check reuse](../bug-fix/2026-10-24-read-check-overhead.md) owns same-read reuse and manifest-level personal pre-send verification; full packages remain verified at load/manage/reopen where applicable.

## Problem

External skill trees may contain links and belong to other tools; the host cannot write disable markers or delete them. A task pins its instruction body but still reads references at original paths. Even an ended agent_wait can supply context to later tasks, so an idle task does not prove old directories can be moved or reclaimed.

## Decision

The original managed store separates immutable content from manifest availability. Shared `managed-skills.ts` owns files/manifests only; Code supplies its agentDir, Personal its locked profile and external skills subdirectory. Do not share product tasks/locks/request evidence. External `loadSkillLibrary(string)` remains distinct. The original explicit source list selected winners in external-path order before loading manifest-selected managed packages. New snapshots included host identity/source/read-only/full-content revision, while model catalog/body hashes kept original fields so old snapshots still verified.

Managed layout permits only state.json, state.json.tmp, packages, and .staging. Package paths are permanently `packages/<UUID>/<original-directory-name>`. Manifest v1 records identity/name/full content revision (including references and empty directories) and enabled/disabled/removed state; revision is SHA-256 of the entire manifest. Unknown versions/broken references fail. Preview assigns the commit identity for later lookup; lost response must not produce a new identity/resend.

Source scans try at most three times, discarding unstable reads and fully rechecking path chains, identities, and content each time. Unrelated child changes under a shared temporary ancestor may cause a reread, not relaxed link checks or final preview-hash comparison. Accept regular files only; reject links in source root/ancestors/package, hardlinks, and special objects. Check path chain and directory/file identity before/after reads; parent replacement invalidates the read. Limits: 512 files, 8 MiB, 128 subdirectories, depth 32; body retains its 64 KiB rule.

Copy under the original directory name into private staging, verify full contents/original parse, then recheck preview revision/current source/name conflicts. Publish the fixed package path before conditionally atomically committing the manifest, the sole visibility point. Original mutations ran synchronously in the owning backend's serial section: Code instance lock and Personal offline profile lock; later personal publication rules superseded the offline-only requirement.

Root/managed/package directories must be current-owner regular 0700 directories; files current-owner regular 0600 with nlink=1. Safe partial temporary manifests/staging/orphan packages may survive reopening. Never parse temp state as current or automatically promote/clean orphans. Packages and staging each allow at most 256 identities; check actual sets before importing so failure remnants cannot make the next layout unreopenable.

Enable/disable/remove changes only manifest state, never bytes/path. Explicit-invocation-only is separate frontmatter metadata; disabled entries are unavailable even explicitly. New tasks using old references verify managed layout and filter the original selection by current state, recording a new selection/prompt without rescanning external trees or rewriting old waits. Resource reacquisition in the same task keeps its starting selection. Original-task recovery, already-recorded body, and references use original pins. Pre-resource validation failure follows normal Driver failure with error code, not false occupancy. Mutation receipts derive from verified content and committed manifest; a failed readback after commit cannot imply nothing saved.

The original audit partially implemented [settings management](../../proposed/feature/2026-10-21-desktop-settings-management.md) while leaving GUI/profile/maintenance assembly to its owners. [Personal data ownership](../architecture/2026-10-18-personal-memory-skills-history.md) and [wait/report ownership](../architecture/2026-10-14-agent-wait-and-report-ownership.md) retain history/locks/lifecycle/request evidence. Compaction/workflow/source/import decisions were not superseded. No note required full absorption/archival.

## Alternatives considered

- Move directories for enable/disable: simple layout, but historical references and ended snapshots need stable paths. Change availability, not content location.
- Mutate external sources: saves disk/copying, but violates external ownership and old-version evidence. Private copies leave sources read-only.
- Automatically clean orphan packages after failed manifest commit: reduces residue, but lacks committed install identity and adds destructive recovery. Keep safe remnants without making them visible installations.

## Consequences

The design allowed Code availability changes while older task references survived. Logical removal and failure residue consume disk indefinitely; real capacity limits reject new imports. Physical GC requires a separate proof that no old references remain and was not delivered. Unstable source ancestors require a new preview once stable.

Historical management paged 1-100 entries, bounded diagnostics to 100 entries/1024 characters with explicit truncation, and returned bounded bodies by stable identity without arbitrary reference reads/deletion. Code list_skills returned the current effective library; [Personal settings](2026-10-21-personal-settings.md) owned layout classification/lock calling and each actual personal request recorded a new selection. These describe the retired manager, not the new fixed-HOME read-only entry.

Historical `test/managed-skills.test.ts` covered safe imports/staging/orphans/version/permissions/conflicts/external winners/pins; test/66 covered Runtime/control, and `test/managed-skills-reference.test.ts` covered new tasks from ended references and recovery. Former `.scratch/desktop-settings/issues/04-managed-skills.md` held executed commands, independent review, and evidence gaps offline. Tool descriptions/system prompts gained no text: the change was in recorded skill selection. Current checks must follow the HOME-discovery decision, not assume the retired management API remains available.
