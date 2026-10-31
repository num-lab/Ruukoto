# Agent Note: Verify scope for the actual operation and access mode

Status: implemented

## Problem

After owner browsing stopped checking protected directories, review found three related overchecks: Git queries scanned all metadata and rejected normal clones/configuration references; Personal network/full-access operations failed on unrelated data directories and background supervision repeatedly scanned protected trees; workspace registration always scanned protection and rejected backend data or ancestors. The owner requested these three fixes first.

## Decision

Owner Git queries follow Git-readable links, hard-linked objects, alternates and configuration includes without enumerating all metadata. Fixed arguments/environment disable hooks, pagers, signing commands, fsmonitor, automatic maintenance and lazy fetch; logs use UTF-8. Pointer files use bounded, stable final-regular-file-handle reads. Git/common-directory identities and pre/post digests of HEAD, refs, remote, shallow and grafts remain. Symlink HEAD includes its link text in the revision. Object databases rely on Git's immutable OID semantics: relocating equivalent objects does not change history. Deliberately corrupted objects are not repaired.

Personal HTTP/Web Search verify source, configuration, permissions, credentials and unsettled effects, not unrelated directories. Full-access absolute file I/O checks only the actual target. File search still checks logical cwd, target directory, execution fingerprint and permissions, but full access skips protected-tree scans. Restricted file operations, data grants and configuration saves retain their checks.

Personal command acceptance, preparation, start intent and session-background supervision validate the mode fixed by the work. Full access retains Linux, directory identity, `machineId`, `TMPDIR`, source and stop facts, but no protection scan. Restricted commands retain native sandbox restrictions. Shared configuration validation in `readPersonalCommands`, `savePersonalCommands` and `personalCommandEnvironment` defaults to restricted; background-specific assembly validates its sole supported full-access mode. The 500 ms supervision interval and stop-on-invalidation behavior remain.

Workspace/session/branch creation and organization migration register valid real directories without Agent protection-root rejection. Registration grants no execution permission. Native execution checks scope immediately before launch. Runtime's restricted library-level local entry batches workspace, grants and readRoots before `launch(spec)`; full access uses the original launcher. Local execution still provides no OS isolation. Mode changes stop the old worker and reacquire the launcher for the task mode; prepared-branch restoration follows the same directory-identity rule.

## Related decisions

This partly supersedes Git metadata/registration restrictions in [owner browsing](../feature/2026-10-24-owner-workspace-browsing.md), whole-tree prechecks in [Git wiring](../architecture/2026-10-17-desktop-demo-v4.md) and [pagination](../feature/2026-10-17-desktop-git-history-pages.md), and registration rules in [access modes](../feature/2026-09-19-explicit-access-modes.md). It supplements [same-account full access](../feature/2026-10-12-full-access-current-account.md) and removes unconditional runtime protection scans from [Personal tools](../architecture/2026-10-17-personal-tools-access-artifacts.md), [command configuration](../architecture/2026-10-17-personal-command-configuration.md), [full-access commands](../architecture/2026-10-17-personal-full-access-commands.md) and [session backgrounds](../feature/2026-10-21-personal-background-processes.md). Native sandboxing, grants, unknown effects and stop evidence remain intact. Skills, preview links, directory pagination and UI prefetch are outside this change.

## Alternatives considered

- Caching or threading protection scans reduces waiting but retains incorrect dependencies/rejections and adds invalidation/lifecycle complexity. Delete inapplicable checks first.
- Basing registration on the default new-session mode is smaller, but the mode can change, and branching/migration is not execution. Verify registration and launch separately.
- Removing every directory check loses actual-target, source and restricted-execution guarantees. Remove only unrelated/inapplicable checks.
- Tracking all external Git reference files could invalidate cursors on every configuration change, but recreates whole-tree scanning. Digest the history facts Git actually interprets and fix output encoding.

## Consequences

Normal clones/shared repositories become browsable without cost proportional to unrelated metadata. Network/full-access operations no longer depend on unrelated data directories; registration needs no protection scan. Restricted execution may still reject a registered directory, requiring an appropriate task mode. Cold configuration validation, Git output/pagination budgets, the 200-entry directory limit and preview-link rules are unchanged.

Regressions distinguish pre-fix failure from fixed behavior and cover configuration without program execution, real tool mode switches, prepared-branch restoration, zero protection scans for Personal network/commands, and stop on directory invalidation. Historical targeted checks, independent review and Linux scope are in the offline `owner-operation-scope` work item.
