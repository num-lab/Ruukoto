# Agent Note: Owner workspace browsing does not use Agent protected roots

Status: implemented

[Read-check reuse](../bug-fix/2026-10-24-read-check-overhead.md) later permits ordinary hardlinks in owner preview, retaining symlink handling and read-consistency checks. [Operation-specific checks](../bug-fix/2026-10-24-operation-specific-checks.md) further removes whole-tree Git metadata restrictions and workspace-registration protection retained by the original change.

## Problem

Desktop Files, preview, and Git queries reused restricted-Agent protected-directory scans. Every read traversed backend data, credentials, control directories, and service source. Reading a 25.9KB HTML file took about 1.7 seconds, over 99.9% in protection checks; synchronous scanning also blocked other control requests. The owner explicitly removed that restriction for these three browsing operations.

## Decision

`listWorkspaceFiles`, `readWorkspaceFile`, and `readWorkspaceGit` are authenticated owner read-only queries. They neither accept nor compute Agent protected roots and do not reject results because registered scope overlaps protected directories. Remove their unused protection helper instead of passing empty roots. Agent tools and restricted execution retain their own protection rules; workspace registration's later rules belong to the superseding operation-specific note.

Browsing still uses a registered root and normalized relative paths, retaining root/ancestor identity, link handling, before/after validation, file versions, and paging budgets. Git keeps fixed read-only commands, revision cursors, bounded output, and the metadata checks still required by the later operation-scoped decision. No arbitrary path, command, or permission option is introduced. Request/response fields and persistence/protocol formats are unchanged.

This replaces browsing protected-root restrictions in [file wiring](../architecture/2026-10-16-desktop-current-demo.md), [Git wiring](../architecture/2026-10-17-desktop-demo-v4.md), and [history paging](2026-10-17-desktop-git-history-pages.md). [Protection-cost optimization](../bug-fix/2026-10-17-directory-protection-cost.md) no longer applies to owner browsing, but its physical-alias, directory-race, and negative-cache rationale still informs Agent checks. Native execution, SubAgent, Personal durable, snapshots, and Demo retain separate entry points.

## Alternatives considered

Caching or asynchronously scanning protected trees could reduce waiting/blocking but would still restrict owner browsing and add invalidation/worker machinery. Passing an empty roots array is shorter but leaves the wrong authority in the interface and a helper that could be reconnected. Removing path/link/all Git validation too exceeds this protected-root decision and changes consistency guarantees; later removals have their own decisions.

## Consequences

Owner-query cost no longer grows with unrelated protected trees. Owners can browse backend material within registered scope without making that output a model input or tool authorization. The original change retained registration protection and whole-tree Git scanning; later operation-specific checks supersede both. This note makes no constant-time guarantee for every repository.

Control regressions read directory/file/Git successfully when protected roots contain the registered root and forbid traversing unrelated protected trees. Existing path, identity, paging, and Agent protection tests remain. Historical pre-fix failure and same-file timing evidence is in the offline copy of `.scratch/desktop-file-tree/issues/02-owner-browsing-access.md`.
