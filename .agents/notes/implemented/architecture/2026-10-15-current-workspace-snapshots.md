# Agent Note: Snapshot the current workspace and compute child deltas against it

Status: implemented

## Problem

[Configurable roles](2026-10-14-configurable-subagent-roles.md) requires review/modification against the current workspace while protecting its source. A HEAD worktree omits staged/unstaged changes, new files, and deletions; reapplying those original changes misidentifies them as child output. Source capture must not run old freeze's `add -N`, nor write source objects through a private index that still uses the source object database.

## Decision

A Git target is independent of role. Inside a worker holding source occupancy, pin HEAD, index state, source-directory identity, and shared-Git identity, then construct a tree from actual paths/raw bytes/types/executable bits. HEAD is provenance and an object-availability preflight, not the content baseline. Include tracked current contents and nonignored new files, not ignored dependencies. Disable partial-clone lazy fetch; missing required objects fail. Private Git initialization uses empty templates and SHA-1, inheriting neither promisor nor remote configuration. No clean/smudge, textconv, external diff, hooks, or fsmonitor runs, and source files/index/objects/refs/config remain unwritten. Two raw trees and before/after fingerprints must match or preparation refuses while preserving evidence. Save and verify the actual index and split-index shared index privately; enumerate only through that copy to avoid Git refreshing source shared-index timestamps.

Capture uses a fully separate bare Git database and temporary index. `hash-object --no-filters` stores raw blobs, with staged blobs retained for index provenance. Private objects must not use alternates, external Git pointers, symlinks, or multiple hardlinks. The host reads files directly to verify hashes, object types, and the complete tree closure, again before model requests/recovery. A versioned `WorkspaceSnapshot` binds source HEAD/Git pointers, directory dev/ino, and private-baseline digest; missing or mismatched durable evidence fails explicitly.

### Preparation ownership

Ordinary capture and work-copy registration each have an independent no-model host Task and tool ledger bound to the real parent task, work, operation, and source identity. The parent retains source occupancy; the host task temporarily holds copy occupancy, and parent stop settles its host units first. Registration adds only the dedicated branch and worktree metadata, uses `--no-checkout`, then materializes the captured tree without changing source worktree/index/HEAD/branches/hooks/config. The child model does not receive this preparation authority. Unverified stop retains both tasks' occupancy, known results, and files without replay. Host tasks stay outside ordinary model queues, fallback model selection, and ordinary continuation entries.

Freeze, independent verification, and ordinary integration use the same captured tree. Child output is only its subsequent delta; freeze and verification both pin snapshot digest. Verification copies use baseline raw bytes plus frozen changes, never later source edits. Before integration, verify the current copy still equals frozen bytes. Across every affected file, complete bytes/type/executable bit must then be all baseline or all child result: preflight/apply the former, idempotently return the latter, reject mixed or later-modified content. Even a later change in a different hunk of an affected file conflicts; unrelated files do not. Full-diff integration adds no cumulative merge state, so later changes may require new work.

### Source protection and failure

Protected targets require Git and actual commands use native sandboxing. Source, shared Git, private baseline, and additional materials are read-only; check outputs in the copy are writable. Structured file tools, grants, and approved host writes use the same protection against absolute paths, aliases, symlinks, and hardlinks. Native checks compare dev/ino and read/write level for all mounted files/directories; nlink=1 does not rule out file bind mounts. Host writes positively check target/ancestor inode against protected trees, refusing bind/hardlink aliases to protected children without following symlinks. The builtin reviewer is confirm even under a full-access parent. Custom full access remains account trust, not physical isolation.

No-target work keeps an independent directory and authorized material. Ordinary non-Git targets keep direct execution and serial `agent_wait`; protection requirements and workflow writes reject non-Git before effects.

Baseline corruption blocks only affected new execution, queues/messages, wait targets, result recovery, and delivery. Terminal result records carry a specific failure code; real task terminal state, committed work, old results, and files are not rewritten, and no source report is fabricated. Existing pending AgentReports become undelivered. Other tasks continue; unexpected errors remain reported. Scheduled settlement preserves parent final replies and unknown occupancy, while cancellation still stops registered tasks. Import validates current snapshots but neither moves private objects nor invents baselines. File preparation, source application, and SQLite registration are not a cross-filesystem transaction.

## Related decisions

This partially replaces [worktrees](2026-10-04-subagent-worktrees.md)' HEAD-only baseline and parent-owned temporary preparation, retaining fixed write targets, occupancy, no host Git execution, and preserved output. It replaces [ordinary integration](../feature/2026-10-05-integrate-worktree-results.md)'s `add -N` and patch-applicability-only test, retaining tools, event ledgers, and retrieval after cancel/close. [Workflow real steps](2026-10-13-workflow-step-capabilities.md) uses this baseline/delta while retaining freeze and independent verification eligibility. [Source capabilities](2026-10-15-subagent-source-capabilities.md) owns role authority/request evidence; [workflow interface](2026-10-15-workflow-role-interface.md) owns role wiring, verifier eligibility, and explicit interface upgrades. Package/backend decisions and sealed archives are not replaced.

## Alternatives considered

- Use HEAD worktrees: closest to existing code, but omits the actual content under review.
- Use a private index with source objects/alternates: copies less, but real experiments showed Git refreshing existing source loose-object timestamps. No-write capture cannot rely on observing no newly added objects.
- Checkout the captured tree: reuses Git filters, but can change CRLF/binary bytes or execute source smudge filters. Materialize raw bytes instead.
- Use only `apply --check`: tolerates concurrent edits in other hunks, but cannot prove affected output still uses its expected source. Verify entire files first.
- Put preparation entirely in the parent ledger: saves a task, but conflates zero-write capture, metadata registration, and child eligibility. Keep independent host ownership.

## Consequences

Review and modification share the actual baseline, so child integration does not reapply the parent's preexisting changes. Capture no-write and host registration can be verified separately, and protection reaches both commands and host writes. Costs include private-object copies, double reads/integrity checks, and indefinite retention of copies/baselines/failure evidence. Committed references are never automatically cleaned up.

Historical uncached host protection traversal on this repository's 62,985 files/6,370 directories measured about 278-280 ms. Later [batched read checks](../bug-fix/2026-10-24-read-check-overhead.md) reduce duplicate scans within an operation without a cross-launch authorization cache; the historical number is not a current latency guarantee. Non-SHA-1 Git, non-UTF-8 names, submodules/nested Git, unsupported nonregular files, and ancestor aliases fail explicitly rather than falling back to HEAD. External editors do not share host locks: capture stability/preflight proves only its observation, not cross-process atomicity or rollback across results.

On default case-insensitive APFS, Git may reject a nonempty case-only rename delta with EEXIST, preserving source/index/copy; case-sensitive Linux can apply it. No alternate source writer was added to hide that refusal. Preserve output and diagnostics.

An existing limitation remains outside this explicit-mount protection: a privileged external actor can bind a child of a global protected root into writable space when that root is not explicitly mounted read-only. Host file entries refuse the same object; source/shared Git/private baseline/additional materials are all explicit read-only roots here. The global counterexample requires separate native-protection work and is not counted as passed.

Mechanism, negative cases, dual-platform native tests, and final-object evidence were recorded in retired `.scratch/subagent-roles/evidence/03-implementation.md` (offline provenance). Real-model and combined-product acceptance remain separate.
