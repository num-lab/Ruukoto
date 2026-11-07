# Agent Note: Bind unassigned Coding chats to persistent managed workspaces

Status: implemented

## Problem

[Issue #47](https://github.com/num-lab/Ruukoto/issues/47) permits starting a Coding conversation without selecting a directory. Execution and data access still need an ordinary workspace identity. Creating at draft opening leaves abandoned workspaces; allocating by session would separate a branch from its source files. Directory installation and SQLite publication cannot commit atomically.

## Decision

A local New chat draft creates nothing until its first send. The host then reserves a workspace ID and creation settings in the existing metadata store, prepares its directory under the current profile's `workspace/<workspace-id>`, and publishes an ordinary registered workspace and session together. Managed status is explicit host metadata. Each independent chat gets a new workspace; branches retain the source workspace and existing history contract. Desktop and TUI group these conversations as No workspace while every operation resolves their real owning workspace.

The reservation fixes original request parameters separately from resolved defaults. A random staging directory's identity is persisted before exclusive fd-relative installation. Linux `renameat2(RENAME_NOREPLACE)` and macOS `renameatx_np(RENAME_EXCL)` preserve that inode and refuse existing targets. Python supplies these OS primitives without an additional package. Recovery uses the saved parent and staging identities: matching final files complete publication, matching staging files resume installation, and changed or missing recorded directories fail visibly. Unknown staging debris remains untouched. The schema stays compatible because receipts and managed markers use existing metadata; history, artifacts, grants and credentials retain their existing stores.

First-send client journals retain creation, upload and submission identities after partial success. Desktop snapshots selected attachment bytes privately before creating its journal and workspace. Reopening restores the original input for explicit submission; it does not send an abandoned draft. Upload or submission failure reuses the original workspace/session. Creation parameters stay fixed; after verified nonacceptance, explicit submission can use corrected text/model/mode shown in the composer. An unknown submission keeps its original parameters until verified. Managed workspaces begin without another workspace's instructions, grants or credentials and retain instance-wide settings. Close, restart and archive retain files. Folder reveal exposes the actual root; full access and owner terminals keep the starting account's rights.

TUI recovery validates both creation and submission identity before replay. Unreadable, corrupt or orphan records retain their files and prevent a new first send. Cleanup removes the resolved submission record before its creation anchor. The accepted task's input determines which text was consumed, so a lost response cannot discard an unsent correction or text entered during the request.

In both clients, navigation ends the draft's permission to submit; its durable journal remains available for explicit restoration.

The development-entry PTY case selects No workspace before waiting for its draft and quitting. The startup selector hides the online header, so transport readiness alone cannot release editor input. Abandonment checks both process/terminal cleanup and the absence of registered roots, ordinary conversations and tasks.

This supersedes only [Desktop New chat](2026-10-20-desktop-new-chat.md)'s requirement to select a workspace. Identity and permissions remain bound at creation. The existing [branch snapshot](2026-10-11-branch-session-snapshot.md) and [owner workspace browsing](2026-10-24-owner-workspace-browsing.md) contracts remain.

## Alternatives considered

- Reuse one workspace for all unassigned chats: simple grouping, but grants default cross-chat history and artifact access.
- Allocate a directory per session: simple first-send creation, but branches lose shared files and workspace identity.
- Adopt an existing target or use ordinary rename: less preparation code, but interrupted creation can overwrite or claim an unrelated directory. Save the staging inode and use exclusive installation.
- Add managed columns and a preparation table: direct relational queries, but this change needs no new schema and existing profiles must remain usable. Existing host metadata already supports durable receipts.

## Consequences

Every independently sent managed draft retains its workspace and files indefinitely. Python and the supported OS exclusive-rename primitive are required for preparation. A corrupt or replaced directory remains a visible recovery failure; automatic cleanup and rebinding are excluded. Managed roots provide normal scoped execution and data identity, not OS-account isolation.
