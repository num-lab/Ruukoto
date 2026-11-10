# Agent Note: Discover skills from the backend account HOME

Status: implemented

[Single product](../architecture/2026-11-10-single-product.md) retires Personal configuration/maintenance recovery. [Skill-script execution](../feature/2026-10-29-skill-script-execution.md) owns execution addressing without changing fixed discovery or historical bytes.

## Problem

Instance directories, external-library configuration and private managed packages created several sources and management paths for owner-maintained files. Changing profiles changed discovery semantics and duplicated import/manifest/selector work.

## Decision

Production discovery reads only the backend account’s `$HOME/.agents/skills/`. Development and daily instances under one account share it; Desktop supplies no alternate directory. Explicit source parsing is an offline/test capability, not production configuration.

CLI/Desktop expose read-only listing, paging, name search and diagnostics. Retire import, library selection, enable/disable and delete operations. Names/descriptions enter the model catalog; `skill` loads bodies on demand and the owner can invoke `/skill:name arguments`. Explicit-call-only attributes, reference realpath checks and 64 KiB text bounds remain. Skills add neither tools nor authority.

Tasks pin catalog/body versions and reuse them within that task. A new task derived from an ended wait refreshes its selection. Old snapshots, loaded results and explicit expansions retain original hash/body without backfilled fields or history rewrites. Referenced files are read and recorded at actual use.

Old instance skills and managed packages stay in place but leave current discovery. A fresh profile does not import their configuration or replay old maintenance. [Managed skills](../feature/2026-10-21-managed-skills.md) preserves the retired design’s historical-reference rationale; current configuration and [Desktop Skills](../feature/2026-10-21-desktop-code-skills.md) expose only the fixed directory.

## Alternatives considered

Changing only the default while retaining imports/external libraries preserves multiple source paths contrary to filesystem maintenance. Automatically moving packages offers continuity but adds name-conflict, ownership and historical-reference obligations. Leave old files untouched and let the owner maintain the desired HOME library.

## Consequences

The product owns reads/request evidence; owners own skill files. Same-account instances share updates, so profile isolation does not isolate skills. Hosts do not synchronize automatically. Retained bytes consume disk and physical collection requires proof that no historical references need them. Tests use temporary HOME and retain task-pinning, read-only management and historical-snapshot checks; historical results are not current model/client acceptance.
