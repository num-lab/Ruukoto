# Agent Note: Reuse verification within the current read snapshot

Status: implemented

## Problem

Owner file preview rejected multiple hardlinks even though reading changes no name's content. Skill management rescanned packages/catalogs within one query; Personal requests loaded the full catalog during reference preparation, input recording, and payload sending. Explicit native mounts scanned the same protected trees individually even though dependency checks already had batching. These costs/rejections performed no additional operation.

## Decision

Owners may preview ordinary hardlinked files inside registered roots. File/ancestor identity, symlink handling, before/after changes, and page revision checks remain. Changing the object through another name invalidates the current read or old cursor too. Agent writes and native-execution hardlink restrictions are unchanged.

Within one synchronous skill-layout verification, retain each traversed package's content revision and reuse it for manifest comparison. List/detail duplicate-name diagnostics reuse loaded entries instead of rereading enabled skills. Source order, winner selection, limits, private permissions, ordinary-file checks, and stable reads remain. No cross-call allow cache is kept. SDK still scans/parses while host reads/pins raw text, because SDK does not expose it; no second scanner is maintained.

Personal request prepare loads the complete skill catalog once and persists that snapshot. Normalized-input and payload boundaries still validate the durable snapshot, configuration, and directory identity. A bounded stable read of the current managed manifest confirms that selected skills remain enabled with matching identity/path/content revision, without rereading package bodies. External text edits and new skills affect the next prepare; this request uses saved content. Managed disable/remove, configuration change, or corrupt manifest still blocks send. Loading, management, and profile reopening continue full package integrity checks. Reference text is read/recorded at invocation under existing rules; old snapshots and explicit expansion are not rewritten.

Native execution batches normalized workspace, granted paths, and read-only roots into one explicit-mount protection check. Runtime dependencies remain separately checked per protected root with existing read-only code-asset exceptions. The batch implementation still verifies candidate/ancestor identities, aliases, and changes. `assertNativeFileLinks` on granted trees stays separate; there is no cross-launch cache.

This replaces hardlink rejection in [owner browsing](../feature/2026-10-24-owner-workspace-browsing.md)/[Desktop file wiring](../architecture/2026-10-16-desktop-current-demo.md), and repeated external-body reads in [Personal references](../architecture/2026-10-18-personal-memory-skills-history.md). [Managed skills](../feature/2026-10-21-managed-skills.md) retains state/layout/old-reference rules. [Native batching](2026-10-18-batch-native-protection-checks.md) extends to explicit mounts without changing dependency exceptions. Write/sandbox protections elsewhere are not relaxed.

## Alternatives considered

Cross-request caches save more reads but cannot reliably detect external content, mount, and managed-state changes. Rechecking bodies before every send finds disk edits, but invalidates an already pinned/recorded request unnecessarily; refresh on next prepare while checking current disable/config immediately. Rewriting SDK scanning saves a raw-body read but assumes ownership of nesting, links, frontmatter, and diagnostic compatibility. Removing native checks or checking only path text misses physical aliases/protected ancestors; reuse existing identity-aware batching.

## Consequences

Preview supports ordinary hardlinks without a broader path entry. Each Personal prepare refreshes skills once and remains reconstructable from saved records. Management and native mounts avoid duplicate scans within one operation, but package, granted-tree, and dependency validation still cost work; no constant latency is promised. Wire/persistence formats are unchanged. Historical verification/platform results are in the offline copy of `.scratch/owner-operation-scope/issues/02-remove-remaining-read-overhead.md`.
