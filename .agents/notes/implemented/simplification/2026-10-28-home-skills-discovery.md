# Agent Note: Discover both products' skills from the host HOME

Status: implemented

[Skill-script execution](../feature/2026-10-29-skill-script-execution.md) adds execution addressing/read-only resource visibility without changing fixed sources or historical bytes.

## Problem

Owners maintain skill files, yet instance directories, Personal external-library configuration, and private managed packages created several sources/management paths. Switching profiles/products changed visibility/update semantics, while managed state, import receipts, and Desktop selectors duplicated protocol work. The owner requested both products use host HOME discovery and retire imports in favor of filesystem maintenance.

## Decision

Production discovery reads only the backend account's `$HOME/.agents/skills/`, resolved by os.homedir(). Code/Personal share scanning, validation, read-only lists, and details. Development/production instances of one account share the directory; different hosts use their own runtime account HOME, never a Desktop-supplied path. Explicit source scanning remains only for offline parsing and legacy-evidence verification, not production configuration.

Retire import, library selection, enable/disable, and delete operations in both products. CLI/Desktop expose read-only listing, paging, name search, and diagnostics. Names/descriptions enter the model catalog; skill loads bodies on demand and owners retain `/skill:name arguments`. Explicit-call-only attributes, reference-file realpath, and 64KiB text limits remain. Skills add no tools or authority.

Coding pins catalog/bodies at task start and reuses original versions within the task; a new task derived from ended wait refreshes them. Personal prepare saves a skill snapshot per model request, using existing config/identity fields for fixed source/directory identity. Old snapshots, loaded results, and explicit expansions retain original hash/body without backfilled fields or history rewrites. Referenced files are still read/recorded at actual use.

Old skills.json, instance skills directories, and managed packages stay in place but leave current discovery. Personal retains validation for old targets, version chains, and maintenance receipts. Retired configuration does not contribute to current file diagnostics, suspension, or startup managed-tree scans. New write requests fail at protocol entry; accepted historical receipt action names remain separately recognized. Scheduled scope still binds skill source; a different old source stops explicitly and requires owner verification/cancel/recreate rather than silent rebinding.

After backend startup, legacy v1 skill-maintenance recovery finishes with skills_source_retired, clears maintenance linkage, and preserves original save result/revision without claiming old skills became active. Legacy v2 query verifies original save facts only, never republishes retired sources or changes effective selection.

This partially supersedes [managed skills](../feature/2026-10-21-managed-skills.md), [Personal skills/history](../architecture/2026-10-18-personal-memory-skills-history.md), [Code Skills UI](../feature/2026-10-21-desktop-code-skills.md), [Personal settings](../feature/2026-10-21-personal-settings.md), [Personal pages](../feature/2026-10-21-desktop-personal-pages.md), and [settings proposal](../../proposed/feature/2026-10-21-desktop-settings-management.md). They retain old references/receipts, other configuration, and combined acceptance. [Request configuration](../architecture/2026-10-25-personal-request-configuration.md), [settings versions](../architecture/2026-10-25-personal-settings-versions.md), [read-check reuse](../bug-fix/2026-10-24-read-check-overhead.md), and [waiting/reporting](../architecture/2026-10-14-agent-wait-and-report-ownership.md) retain request evidence, config history, and wait lifecycle.

## Alternatives considered

Changing only the default to HOME while keeping imports/external libraries preserves installation features but also multiple sources/product differences, contrary to directory-only maintenance. Automatically moving old packages gives continuity but needs additional name-conflict, host-ownership, and historical-reference decisions. Leave old files and let owners maintain the desired HOME skills.

## Consequences

Products own only skill reads/request evidence; owners own files. Same-account instances share updates, so profile isolation no longer isolates skills. Hosts do not synchronize automatically and old packages do not appear in the new catalog unless owners install them there. Retained bytes consume disk; physical collection requires proving historical references no longer need them.

Tests isolate actual skills with temporary HOME and cover fixed/retired sources, refresh/task pinning, read-only paging, rejected retired actions, and old snapshots/receipts. Shared runtime tests also isolate HOME to avoid developer skills changing unrelated catalogs/context budgets. Historical results and real-model/client gaps are in `.scratch/global-skills/issues/01-home-discovery.md` offline.
