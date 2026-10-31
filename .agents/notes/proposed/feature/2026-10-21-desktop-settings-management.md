# Agent Note: Desktop settings reuse product configuration owners and explicit personal management

Status: proposed

This remains the overall settings/combined-acceptance proposal, not a claim that nothing is implemented or that all product acceptance passed. [Settings shell](../../implemented/feature/2026-10-21-desktop-settings-shell.md), [Code models](../../implemented/feature/2026-10-21-code-model-settings.md), [Code MCP](../../implemented/feature/2026-10-21-code-mcp-settings.md), [Code skills](../../implemented/feature/2026-10-21-desktop-code-skills.md), [Personal machine settings](../../implemented/feature/2026-10-21-personal-settings.md), [SSH maintenance](../../implemented/feature/2026-10-21-personal-settings-ssh.md), and [Personal pages](../../implemented/feature/2026-10-21-desktop-personal-pages.md) own delivered components and their evidence.

Current supersessions: [direct Personal save](../../implemented/simplification/2026-10-28-desktop-personal-direct-save.md) removes generic confirmation/edit-time revision prerequisites; [HOME discovery](../../implemented/simplification/2026-10-28-home-skills-discovery.md) makes both skill pages read-only at fixed directories; [Tailscale HTTPS/WebSocket](../../implemented/architecture/2026-10-24-personal-tailscale-https.md) replaces the old Personal connection for chat/settings; [save/effect versions](../../implemented/architecture/2026-10-25-personal-settings-versions.md) replaces blanket stopped-only ordinary configuration saves. [Operation-scoped configuration](../architecture/2026-10-25-operation-scoped-configuration.md) retains proposed adjustments beyond its already-delivered successors; it is not wholesale implementation evidence.

## Problem

Desktop originally exposed appearance, old Personal connection, and archives; the session model menu could not manage providers, skills, or external tools. On 2026-10-21 the owner requested a complete plan for both Code and Personal. Code already had much of the control API, but new personal durable had different protocol/configuration lifecycle. Copying forms alone could display the wrong backend or scope as configured.

## Proposal

Keep the categorized settings dialog with explicit product choice in Models, Skills, and MCP, preserving actual product differences rather than inventing a uniform full-feature configuration platform. Code uses its Runtime/model/MCP versions/discovery/approval; personal adapts independently to durable. Original shared requirements are historical offline `.scratch/desktop-settings/spec.md`, not a maintained task entry.

### Configuration ownership

The owner-confirmed 2026-10-24 [instance MCP decision](../../implemented/simplification/2026-10-24-code-instance-mcp.md) removes Code workspace/legacy-project selection/filtering/compatibility. Manage without a workspace; credentials are MCP-purpose/operation/endpoint-bound from first write. Storage/protocol/CLI/TUI/desktop must agree. Use new Code profiles, preserving old records rather than merging/broadening old services. Old chats cannot continue in-place on the new version. This revision reopened prior MCP engineering acceptance; old approval/evidence does not cover new instance scope, Cua unresolved work, or complete shutdown.

Model credential metadata represents configuration locations. Replace/remove only the owner-selected storage entry/directory field, not every possible source. Configured does not mean authentication failed or succeeded. Directory/environment sources may still apply after deleting a store item; fully resolving authentication during listing may run commands or refresh OAuth. List provable redacted locations without evaluating dynamic secrets; unknown source/validity stays unverified until explicit connection test. Desktop/TUI online/offline share semantics without a new global resolver.

### Historical managed-skills choice and its replacement

The original accepted proposal copied imports to a host-private fixed managed root while external trees/references stayed read-only. A minimal manifest held identity/content revision/enabled state; published package bytes never changed. Enable/disable/logical removal changed the manifest, not paths referenced by old snapshots. Ended agent_wait snapshots can be consumed by future tasks, so idle tasks do not prove paths deletable; future selection filters new availability and records it while originals remain. No physical collection, marketplace, source updater, or editor was planned.

That design required Personal's lock-owned top-level layout/permission checks to recognize a directory in both ordinary-private and locked-permission classifications, then validate fixed internals while locked. Merely adding a name to a file whitelist could reject the directory or apply file permissions. Manifest/temp/staging stayed inside managed root; safe uncommitted objects could reopen without entering catalog, and old profiles without the optional root kept format/history. New managed checks did not claim all old files had equivalent validation.

[Managed skills](../../implemented/feature/2026-10-21-managed-skills.md) delivered that historical design. HOME discovery now supersedes import/enable/remove and source configuration in both products; current overall acceptance must validate fixed-directory read-only discovery and preserved old evidence, not require removed management controls. The stable-reference rationale remains useful for retained historical content.

### Personal save and lifecycle boundaries

Originally online read/test used authenticated local HTTP, while writes used a stopped, lock-held bounded remote JSON machine entry carried by SSH. The owner explicitly selected stop-save-start under original CLI/systemd lifetime; pending work/unknown occupancy/lock failure blocked maintenance. The existing service helper cannot manage its own backend. Systemd mutation required administrator-granted exact authority and a unit without timeout force-kill; GUI installed no privilege. Unverifiable original environment meant read-only/unverified, never copied service secrets, automatic cancellation, or force killing. Each form wrote one configuration, not a multi-file transaction.

Those transport/ordinary-save interactions are superseded by Tailscale, save/effect versions, and direct save. Preserve original maintenance/identity/unknown-effect protections where still required; do not impose old stop/revision-confirmation UI on every current save. Direct save does not authorize bypassing backend receipts or concurrency checks. Real original-service restoration still needs evidence, not shell-credential assumptions.

This proposal adds settings, not unrequested Personal chat migration, permission/IM/workflow management. Later independently approved chat/connection changes are owned by their own decisions, not silently added here.

### Confirmation and remaining status

The owner explicitly approved this proposal/shared scope on 2026-10-21; independent design review had no technical blocker before implementation handoff. Components subsequently landed and newer choices superseded parts. Keep proposed until combined requirements and actual engineering/product evidence justify resolving the overall item; neither the original approval nor individual completed notes implies full combined acceptance.

## Related decisions

The original desktop/settings/model/MCP/skills/durable audit found partial overlaps, no complete absorption or obsolete proposal. [Desktop client](../architecture/2026-10-15-desktop-client.md) owns host/bridge/security/lost-response layering; [desktop design](../../implemented/architecture/2026-10-15-desktop-shadcn-demo.md) owns visual/category presentation. [MCP client](../../implemented/architecture/2026-09-23-mcp-client.md) / [write approvals](../../implemented/feature/2026-09-23-mcp-write-tools-approval.md) retain eligibility/approval while instance-MCP and later Pi decisions own configuration/protocol changes.

[Personal MCP](../../implemented/architecture/2026-10-17-personal-durable-mcp.md) owns generations/credentials/request/unknown facts with subsequent simplifications; per-service enablement must be separately verified. [Personal information](../../implemented/architecture/2026-10-18-personal-memory-skills-history.md), [foundation](../../implemented/architecture/2026-10-17-personal-durable-foundation.md), and [wait references](../../implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md) preserve original instance/layout/version/history/snapshot rules. [Progressive interaction](../../implemented/process/2026-10-14-progressive-human-interaction.md) keeps IDs/versions/request keys program-owned; people choose objects/configuration/impact, with direct-save successor removing redundant confirmation.

## Alternatives considered

- **Code only:** fastest because APIs exist, but owner requires both; staged Code delivery cannot close the whole request.
- **One backend configuration service with hot updates:** more shared forms/calls, but original personal lock/credential/durable evidence differs and forced unification adds migration/runtime risk. Keep product owners; later safe online saves do not require merging runtimes.
- **Desktop file edits or assembled SSH shell:** fewer APIs, but bypasses versions/locks/unresolved effects and broadens renderer file/command powers. Use fixed host-authorized product operations.
- **Move managed packages between enabled/disabled directories when idle:** no manifest, but ended reference snapshots can still be used later; idle is not no-reference, and conservative blocking would make maintenance indefinite. Fixed paths/minimal manifest were the original choice, later superseded by read-only HOME discovery rather than unsafe moving.
- **Resolve live authentication to list effective sources:** gives one resolution result, but credential commands/OAuth refresh cause read-side effects and SDK snapshots may be stale. Show known configuration positions; explicitly test actual usability.

## Acceptance criteria

Map the original shared R1-R9 to narrow tests and real-environment evidence, updated only for the named confirmed successors. Both products must expose correct model/MCP scope and current read-only skills discovery, with saved configuration verifiable after close/reopen. Code TUI/session menus must agree. Personal must prove current authenticated transport/save/effect behavior and, when maintenance is actually required, real Linux SSH/original-service lifecycle recovery. Removed managed-skill/stop-every-save UI is historical, not an unmet requirement to restore it.

Independent combined review must distinguish engineering checks from owner-visible dual-shell experience and real model/service/deployment acceptance. Missing prerequisites keep acceptance pending with recovery conditions; SSR, mock services, and component builds cannot substitute for real service evidence. Do not claim all requirements passed from the implemented child notes.

## Risks

Personal machine/maintenance management is larger than Code forms; validate isolated profiles before production. Necessary pending-work/unknown-effect checks may still block relevant changes; actual backend identity/environment, not an SSH shell, determines credentials and restoration. Original managed packages had count/size limits and retained bytes after logical removal; retained historical references still prohibit casual physical cleanup. Current fixed-directory skills do not revive removed import/delete UI. New cleanup, if needed, requires proof of no remaining references.

Versioned save/effect recovery, Tailscale transport, and direct-save UI require combined verification after supersession. Engineering and subjective product acceptance remain separate and unresolved where evidence is absent; this migration runs no runtime, dual-shell, real-model, or deployment tests.
