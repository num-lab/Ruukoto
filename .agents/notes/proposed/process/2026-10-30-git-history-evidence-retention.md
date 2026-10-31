# Agent Note: Keep conclusions in work records and remove raw evidence from Git history

Status: proposed

Local cleanup was verified and delivered. On 2026-10-30 the owner finally requested only the local repository, taking GitHub recreation/platform archiving themselves. This task does not continue the online migration proposal; a local Git backup is not a complete GitHub-platform archive. [Development standards](../../implemented/process/2026-10-31-development-standards.md) later supersedes this proposal's tracked local-work-item policy with GitHub issues and removes .scratch from the current tree; the historical cleanup decision/evidence requirements below remain distinct.

## Problem

Full raw evidence in .scratch made compressed archives, screenshots, conversations and database snapshots dominate Git objects. Deleting current files leaves historical objects in ordinary clones. Evidence directories also contain reproduction scripts/frozen inputs needed by formal tests, so blanket deletion breaks acceptance.

## Proposal

The owner approved the original specification on 2026-10-30, retained offline at `.scratch/git-history-cleanup/spec.md`: keep work records, specs, conclusions and genuinely needed source/test/frozen inputs in Git, while raw archival artifacts live long-term in a restricted local external directory. Classify exact paths by actual use, rewrite only the public remote's two branches while preserving topology and old/new mapping, and neither publish nor delete local-only work. The later governance migration changes current work-record location, not permission to publish/rewrite remote history.

The old private-repository assumption no longer holds. External evidence is not automatically uploaded, no online evidence service is created, and reruns cannot recreate originals from a past run. Current documents/work records use a consistent archive explanation plus original paths. Old-commit links are not individually repaired; backups recover complete old states.

Backup is more than git bundle --all: include old objects, refs, reflogs, stash, worktree indexes and unfinished work. Ignored local files remain in place and are explicitly outside differential backup. Old workspaces remain; after migration, do not merge old history back. Verify restoration/isolated cleanup before separate owner confirmation of remote switching.

.gitignore blocks default admission, tested through actual Git staging, while retained already-tracked material may remain tracked. It cannot prevent git add -f. Exceptional required inputs need purpose review, not forced raw-evidence inclusion. This proposal adds neither a historical-subtree-OID admission service nor thousands of legacy allowlist entries.

## Related decisions

- [Documentation layers](../../implemented/process/2026-10-09-split-agent-and-human-docs.md): originally partly superseded co-tracking raw evidence/work items while retaining audience separation/traceability. Current tracker authority now follows the later development standards.
- [Raw evidence whitespace](../../implemented/testing/2026-10-15-raw-evidence-whitespace.md): raw output no longer defaults into Git, but original bytes must remain externally without trimming.
- [Frozen desktop migration](../../implemented/architecture/2026-10-16-desktop-current-demo.md): preserves required frozen source/baselines and product acceptance decisions.

Other evidence-linked feature decisions retain behavior and only adjust current evidence locations. Sealed archives stay read-only.

## Alternatives considered

- Untrack only: smallest risk/diff, but ordinary clones still download old objects.
- Reinitialize all history: fewest objects, but loses evolution contrary to approved boundaries.
- Ignore/delete whole evidence directories: simple, but removes actual test inputs/useful conclusions. Classify by purpose with necessary exceptions.
- LFS/online evidence service: easier large-file sharing, but adds service, access and migration costs while historical cleanup remains. Local archive/lightweight conclusions suffice.
- Repair every historical link: more complete old checkouts, but expands targeted cleanup into full-history maintenance. Current tips have clear archive destinations; backups retain originals.
- Allow legacy files by fixed subtree OID: can stop forced new paths, but depends on full historical objects/two branch baselines and cannot limit growth in old files. Use default ignores/regressions first; add independent admission checks only if forced mistakes persist.

## Acceptance criteria

Sample restoration verifies backups. History-tree contents outside cleanup scope remain unchanged. Both cleaned branch tips in clean checkouts have no new check regressions and clear current archive references. Ordinary raw-artifact staging negatives fail. Complete fresh-clone size decreases under comparable conditions. Clone gains and actual GitHub server-space release require separate acceptance and cannot substitute for one another.

## Risks

Rewriting changes affected/descendant hashes; old clones can reintroduce old objects. Remote switching needs explicit approval, latest remote-OID checks and atomic updates to both branches. If protection rejects it, stop rather than disable protection. Downloaded public copies cannot be recalled; this is not a credential-leak audit. Only the owner holds full local originals, not ordinary clones. Backups/old workspaces temporarily increase local disk usage.

The original investigation found 30 read-only PR refs, at least 13 retaining candidate paths. [GitHub guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) excludes nonsensitive data from support-assisted PR-ref cleanup; this is not merely waiting for GC/statistics. Two-branch rewriting therefore could not guarantee server-space release, returning the complete goal to the owner. Backups retain 21 original signatures; rewritten commits do not inherit them.
