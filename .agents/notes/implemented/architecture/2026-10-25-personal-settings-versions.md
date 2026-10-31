# Agent Note: Record configuration saving separately from object activation

Status: implemented

## Problem

Ordinary configuration formerly stopped the backend to obtain its lock, saved, then restarted. Runtime objects captured startup configuration while recovery treated current files as old-operation identity. Removing stop checks alone would create another writer, saves that never activate, or old requests retargeted to new configuration. File replacement and SQLite commit are not atomic.

## Decision

The existing profile writer admits settings: online through Harness; offline under the same profile lock using public SDK createSession, without a Harness or automatic startup. Declarative configuration does not depend on old model credentials/systemd/unrelated work. Actual execution remains subject to each tool module's authority/environment checks.

V2 writes pin operation key, profile identity, expected file revision, and discriminated operation; v1 reads remain compatible but new v1 writes fail. An operation family appends phase facts; a configuration-version family stores immutable candidates and complete predecessor chains; current indexes hold references only. Receipts distinguish not saved, saved, waiting, activation failed, active, unresolved, and superseded without exposing candidate bodies/secret references. Identical content reuses an existing version, not a new execution identity.

Order is durable intent, atomic single-file replace plus fsync, saved fact, object publication, activation receipt. An intent whose replacement never happened verifies as not saved under its original key without rewriting. If the file equals the candidate or a complete later-save chain proves it, recover only idempotent publication. Unknown file state blocks that file; proven saved state narrows blocking to the object. Record MCP file revision separately from per-service selection: saving B must not publish A's pending candidate. Publication waiting holds no global save mutex; withdrawal/publication of the same object serialize.

Configuration and memory objects are not atomic either. A DB selection pointer alone cannot prove publication; use module idempotent publish or verify the actual object. Old keys/superseded candidates cannot reselect old versions. Shared Storage failure still closes the instance, not merely an object. Shutdown waits for in-flight configuration commits. Client disconnect does not cancel accepted operations; never change keys and resave or replay old model/tool/IM/service actions.

Reads return file revisions, actual per-scope active versions, and original-operation receipts. Active-scope and receipt collections each page by stable index in groups of 32 with next offset; desktop gathers all pages before deciding writability. Later saves do not erase old unresolved operations. Full-file MCP publication covers existing explicit scopes including deleted services. External deletion/modification/corruption of a previously active file pauses only new admission for that file and reports fileIssues, without rewriting historical active receipts or inventing user operations. Restoring original bytes triggers reverification.

### Startup and format transition

Cold control startup first read-only verifies durable format and the full version chain. When current files differ from the last saved facts, bootstrap corresponding modules from original durable selections, then let settings recovery pause those targets. Do not overwrite bad files or select external edits as new configuration. Without a valid selected model, only a proven saved model version can bootstrap, still with new requests paused. Old profiles lacking initialization proof/complete history remain refused; dev-profile enabled-IM refusal still precedes recovery.

PERSONAL_FORMAT.configuration marks support. Migration first durably publishes a profile.json marker that old code rejects, then atomically commits baseline configuration/format/rootless-initialization proof, then completes the marker. Rootless initialization permits Harness.root to create the root normally; a legacy missing root without proof still fails. Marker/digests only establish original format uncommitted or the same migration committed. Never rewrite old entries.

Remote v2 maintenance admission stores only profile/key/digest association. The profile owns actual saved/active receipts. Electron/MyGo share Host with per-object unresolved associations; pages support offline saving, original-change verification, and withdrawal of a proven-saved candidate. Old maintenance.json phases/query/explicit recovery keep their original meaning; new writes never enter old stop/save/start.

[Operation-scoped configuration](../../proposed/architecture/2026-10-25-operation-scoped-configuration.md) links the related partial overlaps. This narrows ordinary-save stop requirements in [settings](../feature/2026-10-21-personal-settings.md), [SSH maintenance](../feature/2026-10-21-personal-settings-ssh.md), [pages](../feature/2026-10-21-desktop-personal-pages.md), [HTTPS](2026-10-24-personal-tailscale-https.md), [local management](2026-10-17-personal-local-management.md), [MCP](2026-10-17-personal-durable-mcp.md), and the historical [managed-skills](../feature/2026-10-21-managed-skills.md) path. Keep their independent identity/authentication/credential-reference/unknown-effect rules and explicit service management. [Request configuration](2026-10-25-personal-request-configuration.md), [execution versions](2026-10-25-personal-execution-configuration-versions.md), and [IM updates](2026-10-25-personal-im-updates.md) own their selections/migrations/platform switches. No old note was fully absorbed/archived.

## Alternatives considered

- Remove stop/idle checks only: smallest diff, but old closures stay stale and current files can contaminate historical identity.
- Restart automatically after save: reuses startup assembly, but interrupts unrelated work and depends on the old environment, contrary to the goal.
- Make another file ledger/remote receipt authoritative for activation: easy display, but creates competing authorities. Use durable families in the profile.
- Block all services by whole file: simple recovery, but unnecessarily blocks unrelated services after a save is proven. Use whole-file blocking only while the file outcome is unknown.

## Consequences

Ordinary saves no longer require global downtime, but real historical configuration versions/phase facts must remain. Startup restores original selections and verifies pending publication before new business; normal code upgrades may still restart once. Owners can withdraw a waiting proven-saved candidate while retaining the save fact and supersession link; unknown outcomes must be verified first.

Former `.scratch/configuration-updates/issues/01-remove-global-restrictions.md` held separate behavior/engineering/external acceptance evidence and is now offline provenance. Implemented status records the delivered mechanism, not completion of subjective or real-environment product acceptance.
