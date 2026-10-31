# Agent Note: Legacy workspace migration changes organization, not data or configuration identity

Status: implemented

Original identifier: ADR 0018.

## Problem

A workspace is an owner-selected development root represented by a Project; see [the two products](2026-10-02-two-agent-products.md). Legacy projects can contain sessions in different directories. `sessions.project_id` identifies history/artifacts/memory and selects project instructions, Web Search, MCP, Jev, and memory-candidate configuration. JSONL uses original `sessionFile` and `piSessionId`; grants have source/target project direction. Replacing projectId for display could narrow one old project's cross-directory access or broaden access when multiple old projects share a directory. `AccessScope.sourceRefAccessible` checks the source session's current project, so rewriting it could also disconnect revocation from the original records.

## Decision

Add nullable `sessions.workspace_project_id` for organization only; display membership is `workspace_project_id ?? project_id`. Keep original project/session/task/artifact/pi-session/memory/grant IDs and history paths. Organization must never select AccessScope, model-tool identity, or credential scope. Do not copy or merge old configuration: future tasks in a mapped legacy session still use its source project. New sessions under another Project identity gain no source data or credentials from the display mapping. Other-source access still uses existing trusted configuration and grant controls, not a second configuration store.

Migration never rewrites JSONL, moves artifacts, recreates sessions, restores approvals, or replays unfinished tasks. Original identifiers and bytes remain comparable, following [history preservation](2026-09-19-preserve-session-history.md) and [context compaction](2026-09-26-lossy-context-compaction.md).

Only a complete single-directory legacy project may claim its root under its original ID: no existing root; a nonempty set containing only ordinary dev sessions; one valid real directory exactly matching the target; no other project owning that root; and no session mapped elsewhere. Existing identity/configuration/access remain valid. Partial sets, common ancestors, multiple directories, or mixed projects use organization mapping only. `open_workspace` also rejects direct claims of mixed/multi-directory projects so it cannot bypass migration checks.

The owner first previews read-only and chooses explicitly. Preview reports eligible mappings and invalid/replaced/unverifiable directories, multiple old projects in one directory, mixed projects, nested roots, worktrees, and sessions outside an already claimed root. Invalid/replaced directories keep records; a new directory at the same path is not silently claimed. Missing, unflushed, and corrupt history are distinct. Role-bound, group, and dynamic SubAgent sessions are excluded. A mapped session's real directory must currently lie inside the target root; cross-root organization requires a later explicit decision.

Preview revision is a canonical hash of relevant metadata, including project `settingsVersion`; unrelated task output does not expire it. Apply first checks successful idempotency receipts: same key/request returns the original result; same key/different request conflicts. Then recheck revision and directory identity. Required Project creation, valid root claim, organization update, events, and receipt commit in one transaction or all roll back.

Revert after successful apply checks current fields and restores only explicit organization mappings. It preserves confirmed root identities, Projects, new tasks, configuration edits, and grant revocations, unlike rollback of a failed transaction. SQLite and filesystems have no shared transaction; execution continues to revalidate directory identity.

Workspace details derive linked legacy sources from mapped sessions and display each source ID, configuration, and version, without inventing precedence or authorization. Real cross-instance import/backup/cutover follows [legacy instance import](2026-10-04-legacy-instance-import.md); organization does not bypass product-profile isolation.

## Alternatives considered

- **Rewrite `project_id` to the workspace ID.** Existing project queries could also provide display grouping with one less field, but that field owns data/configuration/revocation direction. Rewriting would change old access, so keep source identity separately.
- **Reuse the old ID for every root claim.** This preserves configuration/access in the strict single-directory case and remains a shortcut there. Extending it to partial sets, common ancestors, or mixed projects changes the basis for project-root instructions. Other cases can only change presentation.

The original analysis is historical offline `.scratch/agent-direction/issues/07-legacy-workspace-data.md`.

## Consequences

The owner can organize workspaces without changing source identity, history bytes, grant IDs, or revocation. UI and configuration views must distinguish display membership from source identity and show legacy sources. Conservative root claims require repairing abnormal directories and previewing again. Revert deliberately preserves post-migration execution/root facts; it is not a reset of all subsequent state. [Core documentation](../../../../docs/modules/core.md) describes the maintained storage/identity model.

## Verification

Historical issue 07 recorded schema v21, preview, transactional apply/revert, TUI/configuration wiring, passing typecheck, batches 62/62 and 143/143, and test/67 3/3. `test/76-legacy-workspace-data.test.ts` is the regression reference for original scope/revocation/configuration/IDs, real JSONL/artifact bytes, rollback/revert, directory replacement without effects, and cross-process receipts.

The offline `.scratch/agent-direction/smoke-07-legacy-workspace-data.mts` used real bin/socket/SQLite/CLI/files/directory identities with MockModelServer: two macOS rounds 9/9 and one isolated tx Node 24 round 9/9, followed by remote-copy cleanup. The last two full historical runs were 796 total, 794 passed, one skipped, and one 60-second DNS timeout reproduced on clean HEAD. Existing test/33 load waits and test/74 wait-shape issues were separately recorded. This is neither all-green evidence nor acceptance of a real daily-profile cross-instance migration. No runtime tests are rerun here.
