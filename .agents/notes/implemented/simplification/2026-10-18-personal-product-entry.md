# Agent Note: One durable assembly for Personal production entry points

Status: implemented

## Problem

New Personal capabilities were app-owned, but bin, root start, dev and deployment still launched the old shared CLI. Two assemblies maintained old runtime state/unused tools and risked using old data or real IM accidentally. Historical approved scope remains in the offline Personal durable migration/product-entry work item.

## Decision

Production entry points call the existing Personal CLI, defaulting to `~/.ruukoto-durable/`; isolated verification uses explicit new directories. Development data remains separated by checkout-realpath hash. Development backend uses platform source watching; configuration menus reuse the CLI without watching. Exit stops only owned background processes. Development rejects profiles with real IM enabled rather than temporarily disabling old sends. Old directories/unknown versions fail existing profile validation.

Delete capabilities, scheduler/service-tool assembly and the importer used only by old Personal runtime, not moving them into fixtures. Shared tests retain only needed thin capability declarations. Service helper, Coding importer, schemas and history readers remain. Shared main/scheduled prompts remove retired-tool guidance while retaining final-report rules. Personal app no longer directly depends on the old Pi SDK, shared CLI or Runtime; state-free shared tools/transports/business libraries remain reusable.

Builds still deliver the complete workspace and root worker assets. The app tarball contains source/dependency declarations, not a standalone installable distribution. Isolated installation must actually execute the unpacked app and built workers with their package-declared SDK versions. The original migration separately tested Personal Pi 1.3.0 and Coding 0.85.1; later dependency upgrades do not turn those historical versions into current requirements. Production service takeover is not part of entry replacement.

## Related decisions

[Test reduction](../testing/2026-10-24-test-suite-reduction.md) uses this retirement to classify old runtime tests without removing shared-library/old-data guarantees. [Migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md), [foundation](../architecture/2026-10-17-personal-durable-foundation.md), [local management](../architecture/2026-10-17-personal-local-management.md), [two products](../architecture/2026-10-02-two-agent-products.md), [workspaces](../architecture/2026-10-11-in-repo-workspace-packages.md) and [launchers](../process/2026-10-09-dev-launchers.md) retain their updated scopes. [Old Personal import](../architecture/2026-10-05-personal-instance-import.md) and [kept dev sessions](../feature/2026-10-05-ruukoto-keeps-dev-sessions.md) retain historical rationale/data, not retired runtime entries.

## Alternatives considered

- Remove entries but keep old tools/tests: smaller diff, but still maintains assembly without production callers. Remove tests only proving retired behavior too.
- Reuse the old shared dev launcher: watching/process code exists but imports old protocols/directories/CLI. Platform watching plus explicit ownership suffices.
- Make the app tarball standalone: attractive installation, but requires reorganizing shared packages/native supervisors/workers beyond the complete-workspace delivery goal.

## Verification

Historical narrow production/dev, real PTY, unpacked-install worker/entry, SDK-resolution and Coding-upgrade checks passed. Full checks failed in existing macOS supervisor cases and a shared-workflow rerun; narrow success is not complete regression acceptance. Exact failures/diagnosis/review remain in the original work record.

## Consequences

Retiring old Personal clients/commands is an approved product change; upgrades use a new profile and preserve old data. Old deployment instructions cannot load retired runtime records. Platform watcher TTY/signal/reload behavior needs real verification. The original test/36 failure attribution remained pending; authorization to implement in isolation did not authorize production cutover or waive final acceptance.
